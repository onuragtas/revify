import { EventEmitter } from 'node:events';
import { ZodError } from 'zod';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { writeFileAtomic } from '../core/atomicWrite.js';
import { SettingsStore, SETTINGS_DIR } from '../core/settingsStore.js';
import { backendUrl, defaultBackendUrl, isProductionBackend } from '../core/backendUrl.js';
import { BackendClient, BackendError } from '../clients/backendClient.js';
import { fileURLToPath } from 'node:url';
import { loadConfig, refreshSettingsOverrides, type AppConfig } from '../config/loadConfig.js';
import { buildPipeline, type Wired } from '../core/registry.js';
import { Pipeline } from '../core/pipeline.js';
import { isIssueKey, issueKeyFromBranch, normalizeIssueKey, toTriggerEvent, UnknownIssueError } from '../core/issueEvent.js';
import { NotARepositoryError, readLocalChange, type LocalChange } from '../core/localRepo.js';
import { ReviewQueue } from '../core/reviewQueue.js';
import { AutoPrepareWatcher } from '../core/autoPrepare.js';
import { ReminderWatcher } from '../core/reminderWatcher.js';
import type { DueReminder, ReminderItem } from '../core/reminders.js';
import { progressBus } from '../core/progressBus.js';
import { splitReview } from '../core/reviewParts.js';
import type { ReviewDetail } from '../core/apiTypes.js';
import { FIXABLE_SEVERITIES, parseFindings, splitFindings, worstSeverity } from '../core/findings.js';
import {
  applyFixPatch,
  createFixWorkspace,
  extractFixPatch,
  filesInPatch,
  removeFixWorkspace,
} from '../core/fixWorkspace.js';
import { cacheDirName } from '../clients/repoCache.js';
import { parseFixReport, type FixRepo } from '../adapters/tasks/codeFixTask.js';
import type { FixPatch, FixRecord, ReviewRecord } from '../core/reviewStore.js';
import type { TriggerEvent } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Jira descriptions are Atlassian Document Format; the UI wants text. */
function describeIssue(description: unknown): string {
  if (!description) return '';
  if (typeof description === 'string') return description;
  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string') chunks.push(obj.text);
    if (obj.type === 'paragraph') chunks.push('\n');
    if (Array.isArray(obj.content)) obj.content.forEach(walk);
  };
  walk(description);
  return chunks.join(' ').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Nothing here runs automatically. `GET /api/reviews` just polls Jira
 * read-only to list candidates; a review only starts when the UI calls
 * `POST /start` for a specific issue the user picked.
 */
/** Things worth interrupting someone about. The desktop shell turns these
 * into system notifications; the browser build simply ignores them. */
export interface ServerEvents {
  'review:ready': { issueKey: string; summary?: string };
  'review:failed': { issueKey: string; error: string };
  'review:auto-queued': { issueKey: string; summary?: string; position: number };
  /** A patch is waiting to be looked at — the fix run finished. */
  'fix:ready': { issueKey: string; files: number };
  'fix:failed': { issueKey: string; error: string };
  /** Something has been waiting long enough to say so again. Carries the
   * whole batch: one interruption for five waiting issues, not five. */
  'reminder:due': { items: DueReminder[]; title: string; body: string };
  /** About to restart into a new version, ten seconds from now. */
  'update:installing': { version: string };
}

export interface ServerOptions {
  /**
   * Where this server keeps the machine's settings.
   *
   * Injectable because the default is a real file in the real home
   * directory: a test that posts to `/api/settings` without this writes to
   * whoever is running it. That is not a hypothetical — it happened, and
   * the settings it overwrote were a live install's.
   */
  settingsStore?: SettingsStore;
}

export function createServer(initialConfig: AppConfig, initialWired: Wired, options: ServerOptions = {}) {
  /*
   * Rebindable on purpose.
   *
   * Saving a credential used to mean restarting the app: the clients were
   * built once from the config read at startup, so the new value sat on
   * disk doing nothing until the next launch. These are `let` so that
   * reload() can swap in a freshly built set, and every reference below —
   * there are eighty-odd — reads the current one at call time rather than
   * a copy captured when the server was created.
   */
  let config = initialConfig;
  let wired = initialWired;

  const app = express();

  /*
   * A content policy the page can actually live under.
   *
   * Worth stating what makes it possible: until the UI moved to Vue this
   * page *was* a 2000-line inline `<script>`, so `script-src` would have
   * needed `'unsafe-inline'` — which is the one directive that makes the
   * rest close to pointless. There is no inline script left, so scripts are
   * restricted to this origin and nothing else can run.
   *
   * Styles are external too. The tokens moved from an inline `<style>` block
   * into `app.css`, and the dozen `style="…"` attributes the components
   * carried became classes — an inline style attribute needs
   * `'unsafe-inline'` exactly as an inline script does, and one directive
   * left open for convenience is how a policy stops meaning anything.
   *
   * Everything the app talks to is this server: the team backend is reached
   * *through* it, never from the page, so `connect-src 'self'` holds.
   */
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });
  // Backups run to megabytes — well past express's 100kb default, which
  // would reject an import with a bare 413.
  app.use(express.json({ limit: '64mb' }));
  app.use(express.static(join(here, 'public')));

  // Emitted rather than pushed at a notifier: the server has no business
  // knowing whether anything is listening, and the browser build has no
  // notifier at all.
  const events = new EventEmitter();
  const emit = <K extends keyof ServerEvents>(name: K, payload: ServerEvents[K]) => events.emit(name, payload);

  let pipeline = new Pipeline(config, wired);
  // The one instance, shared with the pipeline — see Wired.stateStore.
  const state = wired.stateStore;

  const settings = options.settingsStore ?? new SettingsStore();
  const backend = new BackendClient(settings);

  // Reviews run strictly one at a time — see ReviewQueue for why that is a
  // correctness requirement and not just throttling.
  const queue = new ReviewQueue(
    async (event, signal, kind) => {
      // A fix is not a review and must not touch the review's status — the
      // record is still sitting at awaiting_approval with a human's
      // decision pending on it.
      if (kind === 'fix') {
        await runFix(event, signal);
        return;
      }
      progressBus.startRun(event.id, 'started');
      try {
        // Before the review, not when someone opens the notes screen: an
        // auto-prepared review runs with nobody watching, and it must
        // still honour what the team decided this morning.
        await syncTeamNotes();
        await pipeline.runOne(event, signal);
        // Stamped only on success: a run that was stopped or blew up did
        // not produce a review, so it must not move the log.
        const at = new Date().toISOString();
        wired.reviewStore.upsert(event.id, { reviewedAt: at, reviewSeq: state.recordReview(at) });

        // Only when it genuinely landed in front of a human. A run that
        // ended any other way has nothing to announce.
        if (wired.reviewStore.get(event.id)?.status === 'awaiting_approval') {
          emit('review:ready', {
            issueKey: event.id,
            summary: typeof event.data.summary === 'string' ? event.data.summary : undefined,
          });
        }
      } catch (err) {
        // A stop is an instruction that was carried out, not a fault. It
        // reaches here as an error because that is how an abort unwinds —
        // recording it as "failed" would blame the tool for obeying.
        if (signal.aborted) {
          // The half-finished run may have registered an approval; it must
          // not outlive the review it belonged to.
          pipeline.forget(event.id);
          wired.reviewStore.upsert(event.id, { status: 'cancelled', queuePosition: undefined });
          progressBus.log(event.id, 'durduruldu');
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        wired.reviewStore.upsert(event.id, { status: 'failed', error: message });
        progressBus.log(event.id, `FAILED: ${message}`);
        emit('review:failed', { issueKey: event.id, error: message });
      }
    },
    (issueKey, position, kind) => {
      if (kind === 'fix') {
        patchFix(issueKey, {
          status: position === 0 ? 'running' : 'queued',
          queuePosition: position === 0 ? undefined : position,
        });
        progressBus.log(
          issueKey,
          position === 0 ? 'fix: başlıyor' : `fix: sırada — ${position} iş önde`,
        );
        return;
      }
      if (position === 0) {
        wired.reviewStore.upsert(issueKey, { status: 'running', queuePosition: undefined });
        return;
      }
      wired.reviewStore.upsert(issueKey, { status: 'queued', queuePosition: position });
      progressBus.log(issueKey, `queued — ${position} review(s) ahead`);
    },
  );


  /* ------------------------------- fixes -------------------------------
   *
   * A review says what is wrong; a fix run turns the findings a human
   * picked into a patch. It never edits the repo cache and never touches
   * anyone's working copy on its own — see core/fixWorkspace.ts for why.
   * Applying the patch is a separate, explicit request against a directory
   * the person names.
   */

  /** Merges into the fix record and leaves the review around it alone. The
   * review is usually sitting at `awaiting_approval` with a decision
   * pending; a fix must not move it. */
  function patchFix(issueKey: string, patch: Partial<FixRecord>): void {
    const current = wired.reviewStore.get(issueKey)?.fix;
    if (!current) return;
    wired.reviewStore.upsert(issueKey, { fix: { ...current, ...patch } });
  }

  /**
   * Where a checkout lives decides how the fix starts from it.
   *
   * A repo-cache clone is re-fetched first (another review may have left it
   * on a different branch entirely) and holds nothing uncommitted. A
   * directory someone reviewed by path is their own working copy, and the
   * uncommitted half of it is exactly what the review read — so it has to
   * travel into the workspace or the fix starts from code nobody reviewed.
   */
  function isRepoCacheCheckout(repoPath: string): boolean {
    const root = resolve(config.review.repoCacheDir);
    const dir = resolve(repoPath);
    return dir === root || dir.startsWith(root + sep);
  }

  /** The directory a repository's fix workspace is cloned from, made
   * current first. */
  async function fixSourceFor(
    change: NonNullable<ReviewRecord['repoChanges']>[number],
    issueKey: string,
    signal: AbortSignal,
  ): Promise<{ dir: string; includeWorkingTree: boolean }> {
    const reviewed = change.repoPath ?? null;

    if (reviewed && !isRepoCacheCheckout(reviewed)) {
      if (!existsSync(reviewed)) {
        throw new Error(`${reviewed} artık yok — bu dizinin yamasını üretemem.`);
      }
      return { dir: reviewed, includeWorkingTree: true };
    }

    if (!wired.repoCache) {
      throw new Error('Repo checkout kapalı (Ayarlar → "Repoyu klonla"), düzeltme için kod gerekiyor.');
    }
    progressBus.log(issueKey, `fix: ${change.projectPath}@${change.branchName} güncelleniyor…`);
    const dir = await wired.repoCache.ensureCheckout(
      change.projectPath,
      change.branchName,
      change.baseBranch,
      signal,
    );
    return { dir, includeWorkingTree: false };
  }

  /**
   * One fix run for the whole change.
   *
   * Every repository the change spans gets a throwaway workspace, and all of
   * them are open to the same run. A finding can span services — a route on
   * one side and the call to it on the other — and two agents that cannot
   * see each other's work cannot write both halves. It also means nothing
   * has to guess which repository a finding belongs to: the fixer has them
   * all and reads the paths itself.
   *
   * A repository whose workspace cannot be prepared is recorded against
   * itself and the run continues without it. One unreachable service must
   * not cost the patch for the ones that were ready.
   */
  async function runFix(event: TriggerEvent, signal: AbortSignal): Promise<void> {
    const issueKey = event.id;
    // A fix is its own run in a log that already holds the review's. Marked
    // so the elapsed clock restarts here rather than counting from whenever
    // the review began.
    progressBus.startRun(issueKey, 'fix: başladı');
    const record = wired.reviewStore.get(issueKey);
    const wanted = new Set((event.data.fixFindingIds as string[] | undefined) ?? []);

    // Cleared or re-reviewed while this waited in line: there is nothing
    // left to fix, and nowhere to report it either.
    if (!record?.fix) {
      progressBus.log(issueKey, 'fix: review değişti, iptal edildi');
      return;
    }
    if (!record.review) {
      patchFix(issueKey, {
        status: 'failed',
        error: 'Review kaydı yok — düzeltilecek bulgu kalmamış.',
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    const instructions = (event.data.fixInstructions as Record<string, string> | undefined) ?? {};
    const findings = parseFindings(record.review.markdown)
      .filter((f) => wanted.has(f.id))
      .map((f) => ({ ...f, instruction: instructions[f.id] || undefined }));
    const changes = record.repoChanges ?? [];
    const patches: FixPatch[] = [];
    const workspaces: string[] = [];
    /** What HEAD was left at, so nothing can have committed over it. */
    const baselines = new Map<string, string>();

    try {
      if (!findings.length) throw new Error("Seçilen bulgular bu review'da bulunamadı.");
      if (!changes.length) throw new Error("Bu review'a bağlı bir repo yok.");

      // Every repository of the change, prepared before the model is asked
      // anything — it is told where each one is, and a half-prepared set
      // would have it reading a path that is not there yet.
      const repos: FixRepo[] = [];
      for (const change of changes) {
        signal.throwIfAborted();
        const workspace = join(
          wired.fixWorkspaceRoot,
          `${issueKey.replace(/[^a-zA-Z0-9._-]+/g, '_')}__${cacheDirName(change.projectPath)}`,
        );
        try {
          const source = await fixSourceFor(change, issueKey, signal);
          progressBus.log(issueKey, `fix: ${change.projectPath} çalışma kopyası hazırlanıyor…`);
          const baseline = await createFixWorkspace(source, workspace, signal);
          workspaces.push(workspace);
          baselines.set(workspace, baseline);
          repos.push({
            projectPath: change.projectPath,
            branchName: change.branchName,
            path: workspace,
            // The diff as it was reviewed, reassembled from the per-file
            // chunks the record keeps.
            diff: change.files.map((f) => f.diff).join('\n\n'),
          });
        } catch (err) {
          if (signal.aborted) throw err;
          const message = err instanceof Error ? err.message : String(err);
          progressBus.log(issueKey, `fix: ${change.projectPath} hazırlanamadı: ${message}`);
          patches.push({
            projectPath: change.projectPath,
            branchName: change.branchName,
            patch: '',
            stats: { files: 0, insertions: 0, deletions: 0 },
            files: [],
            error: message,
          });
        }
      }

      if (!repos.length) {
        throw new Error(patches.find((p) => p.error)?.error ?? 'Hiçbir repo hazırlanamadı.');
      }

      signal.throwIfAborted();
      progressBus.log(
        issueKey,
        `fix: ${findings.length} bulgu, ${repos.length} repo açık — model çalışıyor…`,
      );

      const answer = await wired.fixTask.run({
        issueKey,
        summary: record.summary ?? '',
        repos,
        findings,
        // The same reading of the ask that produced the findings — not a
        // fresh one. See core/requirement.ts.
        requirement: record.requirement,
        // Every touched project's notes apply, exactly as they do to a
        // multi-repo review.
        notes: [
          ...new Set(
            repos.flatMap((r) => wired.notesStore.listApplicable(r.projectPath).map((n) => n.text)),
          ),
        ],
        clarifications: record.clarifications,
        signal,
        onProgress: (message) => progressBus.log(issueKey, `fix: ${message}`),
      });

      signal.throwIfAborted();
      for (const repo of repos) {
        const { patch, stats } = await extractFixPatch(repo.path, baselines.get(repo.path), signal);
        if (!patch.trim()) {
          progressBus.log(issueKey, `fix: ${repo.projectPath} — hiçbir dosya değişmedi`);
          continue;
        }
        patches.push({
          projectPath: repo.projectPath,
          branchName: repo.branchName,
          patch,
          stats,
          files: filesInPatch(patch),
        });
        progressBus.log(
          issueKey,
          `fix: ${repo.projectPath} — ${stats.files} dosya, +${stats.insertions}/-${stats.deletions}`,
        );
      }

      patchFix(issueKey, {
        status: 'ready',
        patches,
        report: parseFixReport(answer),
        queuePosition: undefined,
        error: undefined,
        finishedAt: new Date().toISOString(),
      });
      const changed = patches.reduce((total, p) => total + p.stats.files, 0);
      progressBus.log(issueKey, changed ? `fix: yama hazır (${changed} dosya)` : 'fix: yama boş');
      emit('fix:ready', { issueKey, files: changed });
    } catch (err) {
      if (signal.aborted) {
        patchFix(issueKey, { status: 'cancelled', queuePosition: undefined, finishedAt: new Date().toISOString() });
        progressBus.log(issueKey, 'fix: durduruldu');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      patchFix(issueKey, {
        status: 'failed',
        patches,
        queuePosition: undefined,
        error: message,
        finishedAt: new Date().toISOString(),
      });
      progressBus.log(issueKey, `fix: BAŞARISIZ: ${message}`);
      emit('fix:failed', { issueKey, error: message });
    } finally {
      // Scratch space; its only lasting output is the patch already taken
      // out of it.
      for (const workspace of workspaces) removeFixWorkspace(workspace);
    }
  }

  // Pending approvals whose review is gone would post stale text if a
  // decision ever reached them. Cleared before anything can.
  for (const id of pipeline.pruneOrphanedApprovals()) {
    console.log(`[startup] dropped orphaned pending approval for ${id}`);
  }

  // The queue lives in memory, so a restart leaves every 'running' and
  // 'queued' record pointing at work that no longer exists. Left alone they
  // read as "still going" forever and the stop button offers to cancel a
  // process that died with the last process.
  for (const record of wired.reviewStore.list()) {
    if (record.status === 'running' || record.status === 'queued') {
      wired.reviewStore.upsert(record.issueKey, { status: 'cancelled', queuePosition: undefined });
      progressBus.log(record.issueKey, 'sunucu yeniden başladı — bu çalışma kayboldu');
      console.log(`[startup] ${record.issueKey} was ${record.status} before restart, marked cancelled`);
    }
  }

  // Cache of the last poll() result, so /start can look up the full
  // TriggerEvent (issueId, summary, status) by key without re-searching.
  let lastPolled: TriggerEvent[] = [];

  app.get('/api/reviews', async (_req, res) => {
    // Short-circuit rather than letting the Jira client fail: "fetch failed
    // for https://" tells a new user nothing, and this is the first screen
    // they see.
    if (!config.setup.configured) {
      res.status(409).json({
        error: `Önce kimlik bilgilerini gir (⚙ Ayarlar): ${config.setup.missing.join(', ')}`,
        setupRequired: true,
      });
      return;
    }

    // No query, no queue — but the app still works: a key typed into the
    // box reviews fine without one. So this is an empty list with an
    // explanation, not a refusal.
    if (!config.setup.queueReady) {
      res.json({
        items: [],
        queueReady: false,
        hint: 'Takım politikası (JQL) yok, o yüzden liste boş. Issue anahtarı yazarak review başlatabilirsin.',
      });
      return;
    }
    try {
      lastPolled = await wired.trigger.poll();
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const row = (event: TriggerEvent, manual: boolean) => {
      const record = wired.reviewStore.get(event.id);
      return {
        issueKey: event.id,
        summary: event.data.summary ?? record?.summary ?? null,
        jiraStatus: event.data.status ?? null,
        assignee: event.data.assignee ?? null,
        updated: event.data.updated ?? null,
        reviewStatus: record?.status ?? 'idle',
        queuePosition: record?.queuePosition ?? null,
        trigger: record?.trigger ?? 'manual',
        reviewedAt: record?.reviewedAt ?? null,
        review: record?.review ?? null,
        error: record?.error ?? null,
        manual,
      };
    };

    const items = lastPolled.map((event) => row(event, false));

    /*
     * Issues reviewed by key, which the query does not match.
     *
     * Without this they vanish the moment the list refreshes: you type a
     * key, the review starts, and the row it is running in disappears
     * because Jira's answer to a different question does not mention it.
     */
    const inQueue = new Set(lastPolled.map((e) => e.id));
    const manual = wired.reviewStore
      .list()
      .filter((r) => !inQueue.has(r.issueKey))
      .filter((r) => r.status && r.status !== 'idle')
      .sort((a, b) => (b.reviewedAt ?? b.updatedAt).localeCompare(a.reviewedAt ?? a.updatedAt))
      .slice(0, 30)
      .map((r) =>
        row({ id: r.issueKey, data: { summary: r.summary ?? null } }, true),
      );

    res.json({ items: [...items, ...manual], queueReady: true });
  });

  /**
   * Just the review states, straight from the local store.
   *
   * Deliberately separate from `GET /api/reviews`, which hits Jira on every
   * call: the two change at completely different rates. The set of issues
   * in review moves on a human timescale, while a review goes
   * queued → running → awaiting_approval in seconds. Serving the fast half
   * from local state lets the list stay live without polling Jira for it.
   */
  app.get('/api/review-states', (_req, res) => {
    res.json({
      items: wired.reviewStore.list().map((r) => ({
        issueKey: r.issueKey,
        reviewStatus: r.status,
        queuePosition: r.queuePosition ?? null,
      })),
    });
  });

  // Polling-based detail endpoint — the reliable source of truth for the
  // UI's step panel. (An SSE /stream endpoint was tried first but proved
  // fragile in practice; plain polling always shows the full picture.)
  app.get('/api/reviews/:issueKey/detail', async (req, res) => {
    const { issueKey } = req.params;
    // Opening an issue should show the team's current rules, not whatever
    // this machine cached the last time a review ran. Throttled, because
    // this endpoint is polled once a second while an issue is open.
    await syncTeamNotes({ maxAgeMs: NOTES_MAX_AGE_MS });
    const record = wired.reviewStore.get(issueKey);
    const projectPaths = record?.projectPaths ?? [];
    // The review is split server-side so the UI and the Jira action share
    // one parser: readers see the body, the team sees the bookkeeping.
    const parts = record?.review ? splitReview(record.review.markdown) : null;
    // One scanner, server-side: the UI shows findings as cards and needs to
    // know which text is a finding and which is the verdict around them.
    const sections = splitFindings(parts?.body ?? '');

    // Typed, so a field renamed here is a compile error rather than a panel
    // that quietly goes blank in a UI declaring the same shape by hand.
    const payload: ReviewDetail = {
      status: record?.status ?? 'idle',
      queuePosition: record?.queuePosition ?? null,
      summary: record?.summary ?? null,
      projectPaths,
      review: record?.review && parts ? { title: record.review.title, markdown: parts.body } : null,
      reviewedAt: record?.reviewedAt ?? null,
      reviewSeq: record?.reviewSeq ?? null,
      trigger: record?.trigger ?? 'manual',
      openQuestions: parts?.openQuestions ?? [],
      appliedNotes: parts?.appliedNotes ?? [],
      repoChanges: record?.repoChanges ?? null,
      history: record?.history ?? [],
      // The review read as a list, so the fix screen can offer the findings
      // as checkboxes rather than asking a human to retype them.
      findings: record?.review ? sections.findings : [],
      reviewPreamble: record?.review ? sections.preamble : '',
      reviewTail: record?.review ? sections.tail : '',
      /*
       * The fix, minus the patches themselves.
       *
       * This endpoint is polled once a second while an issue is open and a
       * patch is measured in kilobytes — sending it with every poll would
       * be the same bytes over and over for a panel that only needs to know
       * how big it is. The text has its own endpoint.
       */
      fix: record?.fix
        ? {
            ...record.fix,
            patches: record.fix.patches.map(({ patch, ...rest }) => ({ ...rest, size: patch.length })),
          }
        : null,
      /** False when this machine's LLM provider has no file tools — the UI
       * says why instead of offering a button that cannot work. */
      fixAvailable: wired.fixTask.available && Boolean(record?.repoChanges?.length),
      // Started from a directory *and* attached to nothing: the decision is
      // recorded here and written nowhere. See
      // jiraReviewOutcomeAction.applyOutcome.
      local: isLocalOnly(record),
      /** Where each project was last applied on this machine, so the apply
       * form opens filled in. */
      fixTargets: settings.get('fixTargets') ?? {},
      clarifications: record?.clarifications ?? [],
      rejectionReason: record?.rejectionReason ?? null,
      revisionRequest: record?.revisionRequest ?? '',
      challenges: record?.challenges ?? [],
      withdrawn: parts?.withdrawn ?? [],
      error: record?.error ?? null,
      steps: progressBus.getBuffered(issueKey),
      /*
       * Which prompts exist, and how big — never the text.
       *
       * This endpoint is polled once a second and a prompt carries the whole
       * diff again. The UI shows a closed card per entry and fetches the
       * text only when somebody opens it.
       */
      prompts: wired.promptStore.list(issueKey),
      // The notes that were (or would be) in force for this issue, so the
      // UI can show what the reviewer was told to ignore.
      notes: [
        ...new Map(
          (projectPaths.length ? projectPaths : [null]).flatMap((p) =>
            wired.notesStore.listApplicable(p).map((n) => [n.id, n] as const),
          ),
        ).values(),
      ],
    };
    res.json(payload);
  });

  /**
   * The exact text a run was given.
   *
   * Its own endpoint rather than part of /detail: this is opened
   * deliberately, once, by someone checking why a review said what it said —
   * and it is far too big to ride along with a poll.
   */
  app.get('/api/reviews/:issueKey/prompt', (req, res) => {
    const kind = String(req.query.kind ?? 'review');
    const stored = wired.promptStore.read(req.params.issueKey, kind);
    if (!stored) {
      res.status(404).json({ error: 'Bu çalışmanın prompt kaydı yok.' });
      return;
    }
    res.json(stored);
  });

  /** Answers to the `[?]` questions the reviewer raised. Stored per issue
   * and fed into the next run, so the open question actually gets closed. */
  app.post('/api/reviews/:issueKey/clarifications', (req, res) => {
    const incoming = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (!incoming) {
      res.status(400).json({ error: 'answers must be an array of { question, answer }' });
      return;
    }

    const existing = wired.reviewStore.get(req.params.issueKey)?.clarifications ?? [];
    const byQuestion = new Map(existing.map((c) => [c.question, c]));
    for (const item of incoming) {
      const question = String(item?.question ?? '').trim();
      const answer = String(item?.answer ?? '').trim();
      if (!question) continue;
      if (!answer) {
        // An emptied answer means "I don't know after all" — drop it rather
        // than feeding a blank back into the next review.
        byQuestion.delete(question);
        continue;
      }
      byQuestion.set(question, { question, answer, answeredAt: new Date().toISOString() });
    }

    wired.reviewStore.upsert(req.params.issueKey, { clarifications: [...byQuestion.values()] });
    res.json({ ok: true, clarifications: [...byQuestion.values()] });
  });

  /** Pushback on a finding: "you said X, and I don't think that's right."
   * Stored per issue and fed into the next run as something to re-check
   * against the code — not as a correction to accept. */
  app.post('/api/reviews/:issueKey/challenges', (req, res) => {
    const incoming = Array.isArray(req.body?.challenges) ? req.body.challenges : null;
    if (!incoming) {
      res.status(400).json({ error: 'challenges must be an array of { finding, objection }' });
      return;
    }

    const existing = wired.reviewStore.get(req.params.issueKey)?.challenges ?? [];
    const byFinding = new Map(existing.map((c) => [c.finding, c]));
    for (const item of incoming) {
      const finding = String(item?.finding ?? '').trim();
      if (!finding) continue;
      const objection = String(item?.objection ?? '').trim();
      // A cleared objection means the dispute was dropped — stop asking the
      // next review to re-litigate a finding nobody is contesting anymore.
      if (!objection) {
        byFinding.delete(finding);
        continue;
      }
      byFinding.set(finding, { finding, objection, raisedAt: new Date().toISOString() });
    }

    wired.reviewStore.upsert(req.params.issueKey, { challenges: [...byFinding.values()] });
    res.json({ ok: true, challenges: [...byFinding.values()] });
  });

  /** Free-text instructions for the next run. Stays until cleared, so the
   * same ask survives a re-run that didn't fully land. */
  app.post('/api/reviews/:issueKey/revision', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    wired.reviewStore.upsert(req.params.issueKey, { revisionRequest: text || undefined });
    res.json({ ok: true, revisionRequest: text });
  });

  /**
   * Everything already decided, with where the issue stands in Jira *now*.
   *
   * The decision this tool records and the ticket's actual fate are two
   * different things: an approved issue can sit in Ready for Stage for a
   * week, and a rejected one can come back fixed. Showing only what we
   * decided would be a log of our own opinions. The current status and
   * assignee come from Jira at request time, which is what makes this a
   * follow-up view rather than an archive.
   */
  app.get('/api/decisions', async (_req, res) => {
    const decided = wired.reviewStore
      .list()
      .filter((r) => r.status === 'approved' || r.status === 'posted' || r.status === 'rejected')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    // One JQL call for all of them rather than one request each.
    let live = new Map<string, { status: string | null; assignee: string | null; summary: string }>();
    if (decided.length) {
      try {
        const issues = await wired.jiraClient.searchIssues(
          `key in (${decided.map((r) => r.issueKey).join(',')})`,
        );
        live = new Map(
          issues.map((i) => [
            i.key,
            {
              status: i.fields.status?.name ?? null,
              assignee: i.fields.assignee?.displayName ?? null,
              summary: i.fields.summary,
            },
          ]),
        );
      } catch (err) {
        // Degrade to the local record: knowing what we decided is still
        // worth showing when Jira is unreachable.
        console.error('[decisions] could not read current Jira state:', err);
      }
    }

    const items = decided.map((r) => {
      const current = live.get(r.issueKey);
      return {
        issueKey: r.issueKey,
        summary: current?.summary ?? r.summary ?? null,
        // 'posted' is an approval that reached Jira; the list is about the
        // call, not about which step of ours it stopped at.
        decision: r.status === 'posted' ? 'approved' : r.status,
        decidedAt: r.updatedAt,
        rejectionReason: r.rejectionReason || null,
        jiraStatus: current?.status ?? null,
        assignee: current?.assignee ?? null,
        severity: (r.review ? worstSeverity(r.review.markdown) : '') as string,
        decidedByName: null as string | null,
        local: true,
      };
    });

    /*
     * The team's decisions, for issues this machine never reviewed.
     *
     * Local records win where both exist: they carry the live Jira state
     * and the reviewer's own reason. What the server adds is the half a
     * reviewer could not see before — what everyone else decided, so
     * nobody re-reviews an issue a colleague sent back an hour ago.
     *
     * Failure is silent by design: the local list is the one this person
     * needs, and losing it because a server is down would be a worse
     * trade than showing it alone.
     */
    const teamId = settings.get('teamId');
    if (backend.configured && teamId) {
      try {
        const known = new Set(items.map((i) => i.issueKey));
        for (const d of await backend.decisions(teamId)) {
          if (known.has(d.issueKey)) continue;
          items.push({
            issueKey: d.issueKey,
            summary: d.summary ?? null,
            decision: d.decision,
            decidedAt: d.decidedAt ?? '',
            rejectionReason: d.note || null,
            jiraStatus: null,
            assignee: null,
            severity: d.severity ?? '',
            decidedByName: d.decidedByName ?? null,
            local: false,
          });
        }
        items.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
      } catch (err) {
        console.warn(`[decisions] takım kararları okunamadı: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    res.json({ jiraBaseUrl: config.jira.baseUrl.replace(/\/$/, ''), items });
  });

  /** Reviews finished and waiting on a human. Its own view because it is
   * the actual work queue — what the reviewer has to get through. */
  app.get('/api/pending', (_req, res) => {
    res.json({
      items: wired.reviewStore
        .list()
        .filter((r) => r.status === 'awaiting_approval')
        // Oldest first: the one that has been waiting longest is the one
        // holding up a developer.
        .sort((a, b) => (a.reviewedAt ?? a.updatedAt).localeCompare(b.reviewedAt ?? b.updatedAt))
        .map((r) => ({
          issueKey: r.issueKey,
          summary: r.summary ?? null,
          reviewedAt: r.reviewedAt ?? r.updatedAt,
          reviewSeq: r.reviewSeq ?? null,
          trigger: r.trigger ?? 'manual',
          openQuestions: r.review ? splitReview(r.review.markdown).openQuestions.length : 0,
          projectPaths: r.projectPaths ?? [],
        })),
    });
  });

  /* --------------------------- backup / restore ------------------------ */

  const BUNDLE_KIND = 'auto-reviewer-backup';
  const BUNDLE_VERSION = 1;

  /**
   * Everything this tool has produced, in one file.
   *
   * Deliberately excludes `.env`: credentials are not this tool's to hand
   * out, and a backup file tends to travel further than the machine it was
   * made on. Everything else is here, `config.yaml` included, so a restore
   * on a new machine needs nothing but the credentials.
   *
   * The contents are internal Jira text and diffs. Treat the file the way
   * you would treat the issues themselves.
   */
  app.get('/api/export', (_req, res) => {
    const readJson = (path: string): unknown => {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        return null;
      }
    };

    const bundle = {
      kind: BUNDLE_KIND,
      version: BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      reviews: readJson(config.reviewsFilePath),
      notes: readJson(config.review.notesFilePath),
      state: readJson(config.stateFilePath),
      // Raw YAML rather than parsed: comments are most of this file's value.
      configYaml: (() => {
        try {
          return readFileSync('config/config.yaml', 'utf-8');
        } catch {
          return null;
        }
      })(),
    };

    const stamp = bundle.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="auto-reviewer-${stamp}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  });

  /**
   * Replaces the local data with a bundle.
   *
   * Three things have to be true before anything is written, and each one
   * has bitten this codebase already:
   *
   * - **Nothing may be in flight.** A running review writes to these files
   *   as it goes; swapping them underneath it would interleave two states.
   * - **The previous data is saved first.** This overwrites months of
   *   reviews and hand-written notes, and "I imported the wrong file" must
   *   be recoverable.
   * - **The stores must re-read.** They hold the whole file in memory and
   *   rewrite it on the next change, so an import that only touches disk
   *   gets silently undone.
   */
  app.post('/api/import', (req, res) => {
    const bundle = req.body;
    if (!bundle || bundle.kind !== BUNDLE_KIND) {
      res.status(400).json({ error: 'Bu dosya bir auto-reviewer yedeği değil.' });
      return;
    }
    if (bundle.version !== BUNDLE_VERSION) {
      res.status(400).json({ error: `Desteklenmeyen yedek sürümü: ${bundle.version}` });
      return;
    }
    if (!bundle.reviews || typeof bundle.reviews !== 'object') {
      res.status(400).json({ error: 'Yedek bozuk: reviews bölümü yok.' });
      return;
    }

    const busy = wired.reviewStore
      .list()
      .filter((r) => r.status === 'running' || r.status === 'queued')
      .map((r) => r.issueKey);
    if (busy.length) {
      res.status(409).json({
        error: `Önce çalışan review'ları durdurun: ${busy.join(', ')}`,
      });
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backups: string[] = [];
    try {
      for (const path of [config.reviewsFilePath, config.review.notesFilePath, config.stateFilePath]) {
        if (!existsSync(path)) continue;
        const copy = `${path}.before-import-${stamp}`;
        writeFileAtomic(copy, readFileSync(path, 'utf-8'));
        backups.push(copy);
      }

      writeFileAtomic(config.reviewsFilePath, JSON.stringify(bundle.reviews, null, 2));
      if (bundle.notes) writeFileAtomic(config.review.notesFilePath, JSON.stringify(bundle.notes, null, 2));
      if (bundle.state) writeFileAtomic(config.stateFilePath, JSON.stringify(bundle.state, null, 2));
    } catch (err) {
      res.status(500).json({ error: `Yazılamadı: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // Now the in-memory copies, or the next save would undo all of it.
    wired.reviewStore.reload();
    wired.notesStore.reload();
    wired.stateStore.reload();

    // Anything mid-flight in the imported data belongs to a process that no
    // longer exists — same reconciliation the server does at startup.
    for (const record of wired.reviewStore.list()) {
      if (record.status === 'running' || record.status === 'queued') {
        wired.reviewStore.upsert(record.issueKey, { status: 'cancelled', queuePosition: undefined });
      }
    }
    for (const id of pipeline.pruneOrphanedApprovals()) {
      console.log(`[import] dropped orphaned pending approval for ${id}`);
    }

    console.log(`[import] restored ${Object.keys(bundle.reviews).length} review(s); backups: ${backups.join(', ')}`);
    res.json({
      ok: true,
      reviews: Object.keys(bundle.reviews).length,
      // `configYaml` is reported, never written: overwriting the file that
      // says whether this writes to Jira is not something to do behind a
      // file picker.
      configIncluded: Boolean(bundle.configYaml),
      backups,
    });
  });

  /* ------------------------------ settings ----------------------------- */

  /** Credentials come back as booleans, never as values: a field the page
   * cannot read is a field a page bug cannot leak. */
  app.get('/api/settings', (_req, res) => {
    res.json({
      settings: settings.redacted(),
      settingsPath: SETTINGS_DIR,
      setup: config.setup,
      // What the field falls back to when left empty.
      defaultApiUrl: defaultBackendUrl(),
    });
  });

  app.post('/api/settings', async (req, res) => {
    const textFields = [
      'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
      'gitlabBaseUrl', 'gitlabToken',
      'anthropicApiKey', 'anthropicModel', 'repoCacheDir', 'apiUrl',
    ] as const;
    const boolFields = ['applyChanges', 'autoPrepareEnabled', 'useRepoCheckout'] as const;
    const numberFields = ['autoPreparePollMs', 'idleTimeoutMs', 'runTimeoutMs'] as const;

    const patch: Record<string, unknown> = {};
    for (const key of textFields) {
      // Absent means "leave alone"; an empty string means "clear". Without
      // that distinction, a form that hides secrets would erase them on
      // every save.
      if (typeof req.body?.[key] === 'string') patch[key] = String(req.body[key]).trim();
    }
    for (const key of boolFields) {
      if (typeof req.body?.[key] === 'boolean') patch[key] = req.body[key];
    }
    for (const key of numberFields) {
      const value = Number(req.body?.[key]);
      if (Number.isFinite(value) && value > 0) patch[key] = value;
    }

    try {
      settings.update(patch);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const applied = await reload();

    res.json({
      ok: true,
      settings: settings.redacted(),
      applied: applied.ok,
      // Only when the rebuild itself failed — the values are saved either
      // way, so this is "not in force yet", not "not saved".
      applyError: applied.ok ? undefined : applied.error,
    });
  });

  /* ------------------------------- backend ----------------------------- */

  /** One place to turn a BackendError into a response, so every team route
   * fails the same way instead of each inventing its own shape. */
  const backendRoute =
    (handler: (req: express.Request) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      if (!backend.configured) {
        res.status(409).json({ error: 'Sunucu adresi ayarlanmamış.', notConfigured: true });
        return;
      }
      try {
        res.json(await handler(req));
      } catch (err) {
        if (err instanceof BackendError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    };

  /**
   * What the app should show before it shows anything else.
   *
   * Three states, in order: no server address yet, a server but no session,
   * and in. The fourth — a stored session and an unreachable server — lets
   * you in with a warning rather than locking you out: reviews run on this
   * machine against this machine's credentials, so a server outage stopping
   * local work would be an availability problem invented for no gain.
   */
  app.get('/api/gate', async (_req, res) => {
    // Two states, not three: the backend address ships with the build, so
    // "which server?" is no longer a question anyone has to answer.
    const hasSession = Boolean(settings.get('apiSessionToken'));
    const apiUrl = backendUrl(settings.get('apiUrl'));

    try {
      const user = await backend.me();
      res.json({
        state: user ? 'ready' : 'needs-login',
        user,
        apiUrl,
        production: isProductionBackend(),
        setup: config.setup,
      });
    } catch (err) {
      // A stored session gets you in when the backend cannot be reached.
      // Reviews run on this machine against this machine's credentials, so
      // locking someone out because a server is down would trade real
      // availability for no real safety.
      res.json({
        state: hasSession ? 'ready' : 'needs-login',
        user: null,
        apiUrl,
        production: isProductionBackend(),
        offline: true,
        error: err instanceof Error ? err.message : String(err),
        setup: config.setup,
      });
    }
  });

  app.get('/api/backend/me', async (_req, res) => {
    const apiUrl = backendUrl(settings.get('apiUrl'));
    try {
      res.json({ configured: true, user: await backend.me(), apiUrl });
    } catch (err) {
      // A configured-but-unreachable API is a normal state to render, not
      // an error that should blank the page.
      res.json({ configured: true, user: null, apiUrl, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Mirrors the team's policy locally, and writes the config file if this
   * machine has none.
   *
   * This is what makes a bare clone work: no config file, open the app,
   * sign in, and the JQL, workflow statuses and review language arrive from
   * the team you belong to. Nobody copies an example file and edits YAML to
   * find out what their team already decided.
   *
   * The file is written only when it is absent, and only once there is
   * something real to put in it — writing a placeholder at startup would
   * produce a config that looks configured while pointing at project
   * "PROJ". The team's values still override the file afterwards, so
   * editing it locally changes the defaults, not the policy.
   *
   * Never throws: a failure here means the sign-in still worked and the app
   * runs on what it last knew.
   */
  async function fillConfigFromTeam(): Promise<{ teamId?: string; wroteConfig: boolean }> {
    try {
      const teams = await backend.teams();
      const stored = settings.get('teamId');
      // The stored team when it is still one of yours, otherwise the only
      // one — guessing between several would silently pick someone's queue.
      const team = teams.find((t) => t.id === stored) ?? (teams.length === 1 ? teams[0] : undefined);
      if (!team) return { wroteConfig: false };

      const data = (await backend.teamSettings(team.id)) as { settings?: Record<string, string> };
      const s = data.settings ?? {};
      settings.update({
        teamId: team.id,
        teamJql: s.jql ?? '',
        teamApproveStatus: s.approveStatus ?? '',
        teamRejectStatus: s.rejectStatus ?? '',
        teamLanguage: s.language ?? '',
      });
      // Only once the team has a query worth writing. A team with no
      // policy yet would otherwise leave a file carrying the example's
      // `project = "PROJ"` — and because the file then exists, that
      // placeholder is read as a real query: a queue that reports itself
      // configured and stays empty forever, which is the state this whole
      // change exists to prevent.
      const wroteConfig = Boolean(s.jql?.trim()) && writeConfigFile(s);
      return { teamId: team.id, wroteConfig };
    } catch (err) {
      console.warn(`[setup] team policy could not be fetched: ${err instanceof Error ? err.message : String(err)}`);
      return { wroteConfig: false };
    }
  }

  /** Writes config/config.yaml from the example, with the team's policy
   * substituted in. Returns false when a config already exists (never
   * overwrites yours) or the directory is not writable — a packaged app can
   * sit in a read-only place, which is why a missing file is survivable in
   * the first place. */
  function writeConfigFile(policy: Record<string, string>): boolean {
    const target = 'config/config.yaml';
    const example = 'config/config.example.yaml';
    if (existsSync(target) || !existsSync(example)) return false;
    try {
      let text = readFileSync(example, 'utf-8');
      const replacements: Array<[RegExp, string | undefined]> = [
        [/^(\s*jql:\s*).*$/m, policy.jql && `$1'${policy.jql.replace(/'/g, "''")}'`],
        [/^(\s*approveStatus:\s*).*$/m, policy.approveStatus && `$1${policy.approveStatus}`],
        [/^(\s*rejectStatus:\s*).*$/m, policy.rejectStatus && `$1${policy.rejectStatus}`],
        [/^(\s*language:\s*).*$/m, policy.language && `$1${policy.language}`],
      ];
      for (const [pattern, value] of replacements) if (value) text = text.replace(pattern, value);
      writeFileAtomic(target, text);
      console.log(`[setup] ${target} written from the team's policy`);
      return true;
    } catch (err) {
      console.warn(`[setup] ${target} could not be written: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  app.post('/api/backend/login', backendRoute(async (req) => {
    const user = await backend.login(String(req.body?.email ?? ''), String(req.body?.password ?? ''));
    // After the session exists, not before: fetching a team's policy needs
    // the session it authorises.
    const filled = await fillConfigFromTeam();
    // The policy that just arrived decides which issues are yours — it has
    // to be in force now, not after a restart nobody asked for.
    if (filled.teamId) await reload();
    return { user, ...filled, applied: config.setup.configured };
  }));

  app.post('/api/backend/register', backendRoute(async (req) => {
    const user = await backend.register(
      String(req.body?.email ?? ''), String(req.body?.name ?? ''), String(req.body?.password ?? ''));
    // A new account has no team yet, so there is usually nothing to pull —
    // it runs anyway for the case where someone was invited before signing up.
    const filled = await fillConfigFromTeam();
    // The policy that just arrived decides which issues are yours — it has
    // to be in force now, not after a restart nobody asked for.
    if (filled.teamId) await reload();
    return { user, ...filled, applied: config.setup.configured };
  }));

  app.post('/api/backend/logout', backendRoute(async () => {
    await backend.logout();
    return { ok: true };
  }));

  app.get('/api/backend/teams', backendRoute(async () => ({ items: await backend.teams() })));

  app.post('/api/backend/teams', backendRoute(async (req) => {
    const team = await backend.createTeam(String(req.body?.name ?? ''));
    // The first team is the moment a fresh account gains a policy to follow.
    settings.update({ teamId: (team as { id?: string })?.id ?? '' });
    const filled = await fillConfigFromTeam();
    if (filled.teamId) await reload();
    return { team, ...filled, applied: config.setup.configured };
  }));

  app.get('/api/backend/teams/:teamId/members', backendRoute(async (req) =>
    ({ items: await backend.members(req.params.teamId) })));

  app.get('/api/backend/users', backendRoute(async (req) =>
    ({ items: await backend.searchUsers(String(req.query.q ?? '')) })));

  app.post('/api/backend/teams/:teamId/members', backendRoute(async (req) =>
    ({ member: await backend.addMember(req.params.teamId, String(req.body?.userId ?? '')) })));

  app.get('/api/backend/assignments', backendRoute(async () => ({ items: await backend.myAssignments() })));

  /** What the team has handed out, so whoever assigned something can see
   * it is still sitting there — and say so. */
  app.get('/api/backend/teams/:teamId/assignments', backendRoute(async (req) =>
    ({ items: await backend.teamAssignments(req.params.teamId) })));

  /** Reads the team's policy and mirrors it locally, so the next start uses
   * it even if the backend is unreachable then. */
  app.get('/api/backend/teams/:teamId/settings', backendRoute(async (req) => {
    const data = await backend.teamSettings(req.params.teamId);
    const s = data.settings as Record<string, string>;
    settings.update({
      teamId: req.params.teamId,
      teamJql: s.jql ?? '',
      teamApproveStatus: s.approveStatus ?? '',
      teamRejectStatus: s.rejectStatus ?? '',
      teamLanguage: s.language ?? '',
    });
    return data;
  }));

  app.put('/api/backend/teams/:teamId/settings', backendRoute(async (req) => {
    const saved = await backend.saveTeamSettings(req.params.teamId, {
      jql: String(req.body?.jql ?? ''),
      approveStatus: String(req.body?.approveStatus ?? ''),
      rejectStatus: String(req.body?.rejectStatus ?? ''),
      language: String(req.body?.language ?? ''),
    }) as Record<string, string>;
    settings.update({
      teamId: req.params.teamId,
      teamJql: saved.jql ?? '',
      teamApproveStatus: saved.approveStatus ?? '',
      teamRejectStatus: saved.rejectStatus ?? '',
      teamLanguage: saved.language ?? '',
    });
    // Saved team-wide, mirrored locally, and in force here immediately.
    const applied = await reload();
    return { settings: saved, applied: applied.ok };
  }));

  app.post('/api/backend/teams/:teamId/assign', backendRoute(async (req) => {
    const issueKey = String(req.body?.issueKey ?? '');
    // The summary travels so the assignee sees what the issue is without
    // having to look it up — but never the review text, which is theirs to
    // produce, not ours to hand over.
    await backend.assign(req.params.teamId, {
      issueKey,
      assigneeId: String(req.body?.assigneeId ?? ''),
      note: String(req.body?.note ?? ''),
      summary: wired.reviewStore.get(issueKey)?.summary ?? String(req.body?.summary ?? ''),
    });
    return { ok: true };
  }));

  app.post('/api/backend/teams/:teamId/assignments/:issueKey/close', backendRoute(async (req) => {
    await backend.closeAssignment(req.params.teamId, req.params.issueKey);
    return { ok: true };
  }));

  app.get('/api/outcome-config', (_req, res) => {
    res.json({
      // Loaded once at startup, so this is the cheapest place to hand the
      // UI the base URL it needs to link an issue back to Jira.
      jiraBaseUrl: config.jira.baseUrl.replace(/\/$/, ''),
      applyChanges: config.jira.applyChanges,
      approveStatus: config.jira.approveStatus,
      rejectStatus: config.jira.rejectStatus,
    });
  });

  /**
   * Mirrors the team's notes into the local store.
   *
   * The store is what a review actually reads, so without this the team's
   * notes were decorative: shown in the list, never applied. A colleague's
   * "the retry here is deliberate" appeared on screen while every review
   * went on flagging it.
   *
   * Returns whether the team was reachable, so a caller can say which set
   * it is showing rather than passing off a stale copy as current.
   */
  /** When the notes last came down. Lets a page open fresh without a
   * polling loop turning that into a request per second. */
  let notesSyncedAt = 0;
  const NOTES_MAX_AGE_MS = 60_000;

  async function syncTeamNotes(options: { maxAgeMs?: number } = {}): Promise<boolean> {
    const teamId = settings.get('teamId');
    if (!backend.configured || !teamId) return false;

    // A screen that opens should show what the team decided, not what this
    // machine last happened to cache — but the issue detail is polled once
    // a second while it is open, and syncing on each of those would be a
    // request per second per reader. Freshness where it matters, silence
    // where it does not.
    const maxAge = options.maxAgeMs;
    if (maxAge !== undefined && Date.now() - notesSyncedAt < maxAge) return true;

    try {
      let items = (await backend.teamNotes(teamId)) as Array<Record<string, unknown>>;

      /*
       * An empty team is not an instruction to forget.
       *
       * Notes used to live only on this machine. When they moved to the
       * team, nothing carried the existing ones up — so the first sync
       * after joining a team replaced a full local file with an empty
       * server list, and a year of accumulated rules vanished silently.
       * That is not a hypothetical: it happened here.
       *
       * So an empty team with a non-empty local store means "not migrated
       * yet", and the migration runs.
       */
      const local = wired.notesStore.list();
      if (!items.length && local.length) {
        console.log(`[notes] ${local.length} yerel not takıma taşınıyor`);
        for (const note of local) {
          try {
            await backend.addTeamNote(teamId, {
              scope: note.scope,
              projectPath: note.projectPath ?? undefined,
              text: note.text,
            });
          } catch (err) {
            // A note that cannot be uploaded stays local rather than
            // being dropped: the store is not replaced below unless the
            // team has something to replace it with.
            console.warn(`[notes] taşınamadı: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }
        items = (await backend.teamNotes(teamId)) as Array<Record<string, unknown>>;
        if (!items.length) return false;
      }

      wired.notesStore.replaceAll(
        items.map((n) => ({
          id: String(n.id ?? ''),
          scope: n.scope === 'repo' ? ('repo' as const) : ('global' as const),
          projectPath: n.projectPath ? String(n.projectPath) : null,
          text: String(n.text ?? ''),
          createdAt: String(n.createdAt ?? ''),
        })),
      );
      notesSyncedAt = Date.now();
      return true;
    } catch (err) {
      console.warn(`[notes] takım notları alınamadı: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Notes come from the team when there is one: "don't flag missing tests
   * in this repo" is accumulated team knowledge, and knowledge that lives
   * on one laptop is re-learned by everyone else. The local store is the
   * offline copy — shown, and used by reviews, when the server cannot be
   * reached. */
  app.get('/api/notes', async (_req, res) => {
    const fromTeam = await syncTeamNotes();
    res.json({ items: wired.notesStore.list(), source: fromTeam ? 'team' : 'local' });
  });

  app.post('/api/notes', async (req, res) => {
    const { scope, projectPath, text } = req.body ?? {};
    if (scope !== 'global' && scope !== 'repo') {
      res.status(400).json({ error: 'scope must be "global" or "repo"' });
      return;
    }

    const teamId = settings.get('teamId');
    try {
      // To the team when there is one. Writing locally while reading from
      // the team was the actual bug: you added a note and it vanished,
      // because the list you were looking at came from somewhere else.
      if (backend.configured && teamId) {
        await backend.addTeamNote(teamId, {
          scope,
          projectPath: projectPath ? String(projectPath) : undefined,
          text: String(text ?? ''),
        });
        await syncTeamNotes();
        res.json({ ok: true, source: 'team', items: wired.notesStore.list() });
        return;
      }
      res.json({ note: wired.notesStore.add({ scope, projectPath, text: String(text ?? '') }), source: 'local' });
    } catch (err) {
      if (err instanceof BackendError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/notes/:id', async (req, res) => {
    const teamId = settings.get('teamId');
    try {
      if (backend.configured && teamId) {
        // Owner-only on the server. The refusal travels as-is rather than
        // being reported as a local success, which is what deleting a
        // team note used to do: `{ok:true}`, nothing removed.
        await backend.deleteTeamNote(teamId, req.params.id);
        await syncTeamNotes();
        res.json({ ok: true, source: 'team' });
        return;
      }
      wired.notesStore.remove(req.params.id);
      res.json({ ok: true, source: 'local' });
    } catch (err) {
      if (err instanceof BackendError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Projects this GitLab token can read, flagged with whether they are
   * already cloned. Cached in memory — 125 projects is several paginated
   * calls, and the list barely changes during a session. */
  let projectCache: Array<{ projectPath: string; name: string }> | null = null;
  app.get('/api/projects', async (req, res) => {
    try {
      if (!projectCache || req.query.refresh === '1') {
        projectCache = (await wired.gitlabClient.listProjects()).map((p) => ({
          projectPath: p.projectPath,
          name: p.name,
        }));
      }
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const cached = new Set((wired.repoCache?.listCached() ?? []).map((r) => r.projectPath));
    res.json({
      items: projectCache.map((p) => ({ ...p, cloned: cached.has(p.projectPath) })),
    });
  });

  /** What the reviewer sees before starting a run: the task as Jira states
   * it, and which repos the change touches. Read-only — nothing runs. */
  app.get('/api/reviews/:issueKey/prepare', async (req, res) => {
    /*
     * A local review has no Jira issue, and asking Jira about it answered
     * 404 — which the UI showed as "Jira detayları yüklenemedi" on a screen
     * where there was never anything to load. Everything true about it is
     * already on the record, and none of it costs a git call.
     */
    const record = wired.reviewStore.get(req.params.issueKey);
    if (isLocalOnly(record)) {
      res.json({
        issueKey: record!.issueKey,
        summary: record!.summary,
        description:
          `Yerel dizin incelemesi — bağlı bir Jira issue'su yok.\n\nDizin: ${localSourceOf(record)}`,
        issueType: 'Yerel dizin',
        changedRepos: [],
      });
      return;
    }

    const event = lastPolled.find((e) => e.id === req.params.issueKey);
    if (!event) {
      res.status(404).json({ error: 'Unknown issue — refresh the list first.' });
      return;
    }

    try {
      // Same rule as the collector: the development panel is queried by
      // internal id, and an issue attached to a local review by hand has
      // none. Sending "undefined" got a 400 back that blamed Jira.
      const [meta, branches] = await Promise.all([
        wired.jiraClient.getIssueMeta(req.params.issueKey),
        event.data.issueId
          ? wired.jiraClient.getLinkedBranches(String(event.data.issueId))
          : Promise.resolve([]),
      ]);
      res.json({
        issueKey: meta.key,
        summary: meta.summary,
        description: describeIssue(meta.description),
        status: meta.status,
        assignee: meta.assignee,
        reporter: meta.reporter,
        issueType: meta.issueType,
        priority: meta.priority,
        sprint: meta.sprint,
        updated: meta.updated,
        changedRepos: branches.map((b) => ({ branch: b.name, repositoryUrl: b.repositoryUrl })),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Wipes a task's review state so it can be run from scratch. The repo
   * cache is deliberately untouched — it is shared across tasks and
   * expensive to rebuild. */
  app.delete('/api/reviews/:issueKey', (req, res) => {
    const { issueKey } = req.params;
    // Drop it from the line too, or clearing a queued task would leave it
    // to start later against state the user thought they had wiped. Both
    // kinds: a fix left in the line would run against a review that is gone.
    queue.cancel(issueKey);
    queue.cancel(issueKey, 'fix');
    progressBus.clear(issueKey);
    wired.promptStore.forget(issueKey);
    wired.reviewStore.reset(issueKey);
    pipeline.forget(issueKey);
    // Otherwise a cleared issue would stay on the watcher's seen list and
    // could never be prepared again — "clear" has to mean clear.
    state.forgetAutoPrepareSeen(issueKey);
    res.json({ ok: true });
  });

  /**
   * Reviews a directory on this machine.
   *
   * The queue answers "what did the team ask for". This answers "look at
   * what I have here" — work with no ticket yet, a ticket that links no
   * branch, or a second pair of eyes before pushing.
   *
   * An optional Jira key attaches the result to an issue, and then
   * Approve and Reject behave exactly as they always have. Without one it
   * is a report: the decision is recorded here and nothing is written to
   * Jira, because there is nothing to write it to.
   */
  /**
   * Everything a local review needs, from a directory.
   *
   * Shared by the two ways one gets started: typing a path, and pressing
   * "Yeniden incele" on a local review that already exists. Re-running used
   * to be impossible — `/start` only knew how to build an event out of a
   * Jira issue, so it answered 400 for an id that is not an issue key —
   * and a re-run that silently does nothing is the worst kind of button.
   *
   * Reading the directory again on every run is the point: the working copy
   * has moved since the last review, which is usually *why* someone is
   * asking for another one.
   */
  type LocalStart =
    | { ok: true; event: TriggerEvent; id: string; summary: string; change: LocalChange }
    | { ok: false; status: number; error: string };

  async function buildLocalStart(
    path: string,
    { issueKey = '', contextRepos = [] as string[] } = {},
  ): Promise<LocalStart> {
    if (!path) return { ok: false, status: 400, error: 'Bir dizin yolu gerekli.' };

    let change: LocalChange;
    try {
      change = await readLocalChange(path);
    } catch (err) {
      return {
        ok: false,
        status: err instanceof NotARepositoryError ? 400 : 500,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!change.committedDiff.trim() && !change.workingDiff.trim()) {
      // Reviewing nothing produces a confident review of nothing, which is
      // worse than saying there is nothing to review.
      return {
        ok: false,
        status: 409,
        error: `${change.projectPath} (${change.branch}) taban dalıyla aynı ve çalışma alanı temiz — incelenecek değişiklik yok.`,
      };
    }

    if (issueKey && !isIssueKey(issueKey)) {
      return { ok: false, status: 400, error: `"${issueKey}" bir issue anahtarına benzemiyor (örn. BUY-2455).` };
    }

    // Readable, and stable for the same directory and branch: re-running
    // replaces the previous review rather than piling up rows.
    const id = issueKey || `local:${change.projectPath}@${change.branch}`;
    const summary = `${change.projectPath} · ${change.branch}`;

    return {
      ok: true,
      id,
      summary,
      change,
      event: {
        id,
        data: {
          repoPath: change.path,
          contextRepos,
          summary,
          ...(issueKey ? { issueKey } : {}),
        },
      },
    };
  }

  /**
   * What is in a directory, before anything is run.
   *
   * Read-only, and deliberately a separate step. A branch called
   * `feature/BUY-2397` almost certainly belongs to that ticket, but "almost
   * certainly" is not a licence to comment on it and move its status — so
   * the guess is shown to a human, with the ticket's summary next to it so
   * they can see whether it is the right one, and they confirm, correct or
   * decline. Only then does a review start.
   *
   * Doing it here rather than after the run is what makes it free: attaching
   * afterwards would mean re-running the review under a new id.
   */
  /**
   * A review that came from a directory *and* has no Jira issue behind it.
   *
   * The two are not the same. Confirming the branch's ticket makes the id
   * the issue key and the decision a Jira write — while the record still
   * remembers the directory, because re-running has to read it again. Asking
   * only "does it have a localPath" would call that attached review local,
   * and then the decision bar would promise not to touch a ticket it is
   * about to comment on.
   */
  /**
   * Where a local review was read from, if it was one.
   *
   * Two sources, and the order matters. `localPath` is *declared*: written
   * when somebody starts a review from a directory, so it is there even
   * before the first run produces anything. `repoChanges[].repoPath` is
   * *observed*: the collector records the directory it actually read, which
   * means every review written before `localPath` existed already carries
   * the answer — including the ones sitting in people's stores right now.
   * Reading both is what makes those re-runnable instead of stranded.
   *
   * A repo-cache path is not a local review: the Jira path checks branches
   * out there, and treating one as somebody's working copy would run a fix
   * against a directory the next review hard-resets.
   */
  function localSourceOf(record?: ReviewRecord): string | undefined {
    if (record?.localPath) return record.localPath;
    const observed = record?.repoChanges?.find(
      (c) => c.repoPath && !isRepoCacheCheckout(c.repoPath),
    );
    return observed?.repoPath ?? undefined;
  }

  const isLocalOnly = (record?: ReviewRecord): boolean =>
    Boolean(localSourceOf(record)) && !isIssueKey(record!.issueKey);

  app.post('/api/reviews/local/inspect', async (req, res) => {
    const started = await buildLocalStart(String(req.body?.path ?? '').trim());
    if (!started.ok) {
      res.status(started.status).json({ error: started.error });
      return;
    }

    const { change } = started;
    const suggested = issueKeyFromBranch(change.branch);

    res.json({
      path: change.path,
      projectPath: change.projectPath,
      branch: change.branch,
      baseBranch: change.baseBranch || null,
      files: change.files.length,
      // Only the guess. Whether Jira knows it is a separate question with
      // its own endpoint, asked the same way for a suggested key and a typed
      // one — two paths to the same answer is how they end up disagreeing.
      suggestedIssueKey: suggested,
    });
  });

  /** Jira's one-line answer to "is this the ticket you meant?" */
  async function describeIssueKey(
    issueKey: string,
  ): Promise<{ key: string; summary?: string; status?: string; error?: string }> {
    try {
      const meta = await wired.jiraClient.getIssueMeta(issueKey);
      return { key: meta.key, summary: meta.summary, status: meta.status };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        key: issueKey,
        error: message.includes('404')
          ? `${issueKey} Jira'da bulunamadı (ya da erişimin yok).`
          : `Jira'ya sorulamadı: ${message}`,
      };
    }
  }

  /** Confirms a key a human typed, so a typo is caught in the dialog rather
   * than after a review has run against the wrong ticket. */
  app.get('/api/issues/:issueKey/summary', async (req, res) => {
    const issueKey = normalizeIssueKey(req.params.issueKey);
    if (!isIssueKey(issueKey)) {
      res.status(400).json({ error: `"${req.params.issueKey}" bir issue anahtarına benzemiyor (örn. BUY-2455).` });
      return;
    }
    res.json(await describeIssueKey(issueKey));
  });

  app.post('/api/reviews/local', async (req, res) => {
    const started = await buildLocalStart(String(req.body?.path ?? '').trim(), {
      issueKey: String(req.body?.issueKey ?? '').trim().toUpperCase(),
      contextRepos: Array.isArray(req.body?.contextRepos) ? req.body.contextRepos.map(String) : [],
    });
    if (!started.ok) {
      res.status(started.status).json({ error: started.error });
      return;
    }

    const { event, id, summary, change } = started;
    lastPolled = [...lastPolled.filter((e) => e.id !== id), event];

    wired.reviewStore.archiveCurrentReview(id);
    progressBus.clear(id);
    wired.reviewStore.upsert(id, {
      summary,
      review: undefined,
      error: undefined,
      trigger: 'manual',
      rejectionReason: undefined,
      fix: undefined,
      projectPaths: [change.projectPath],
      // The one thing the id cannot carry: where on this machine it came
      // from. Without it the review can never be run a second time.
      localPath: change.path,
    });

    const position = queue.enqueue(event);
    res.json({ ok: true, issueKey: id, summary, position, local: !event.data.issueKey });
  });

  /**
   * Clears the way for a run that is about to replace an existing one.
   *
   * The previous review is archived rather than dropped — a re-review is
   * usually a response to something, and losing what was said last time
   * makes it impossible to see what changed. The rejection reason and the
   * patch go, though: both belong to findings that are about to stop
   * existing, and applying a stale patch would undo work just done.
   */
  function restartRecord(event: TriggerEvent, extra: Partial<ReviewRecord> = {}): void {
    wired.reviewStore.archiveCurrentReview(event.id);
    progressBus.clear(event.id);
    wired.reviewStore.upsert(event.id, {
      summary: typeof event.data.summary === 'string' ? event.data.summary : undefined,
      review: undefined,
      error: undefined,
      trigger: 'manual',
      rejectionReason: undefined,
      fix: undefined,
      ...extra,
    });

    // Any fix still in the line belonged to the review being replaced. Its
    // findings are about to stop existing, so let it go rather than spend
    // minutes producing a patch against them.
    queue.cancel(event.id, 'fix');
  }

  app.post('/api/reviews/:issueKey/start', async (req, res) => {
    /*
     * From the queue if it is there, from Jira if it is not.
     *
     * Events only ever came from the last JQL poll, so anything outside
     * the team's query answered "refresh the list first" — which was
     * impossible advice for an issue the query does not match. Typing a
     * key is a deliberate act; it does not need a queue to permit it.
     *
     * No status check on purpose. The queue exists to find work; naming
     * an issue *is* the finding. Approve and Reject are still clicks, so
     * nothing reaches Jira on this path either.
     */
    // Repos the reviewer picked as worth having on disk. Cloning happens
    // inside the run so its progress shows up in the step log.
    const contextRepos = Array.isArray(req.body?.contextRepos)
      ? req.body.contextRepos.map(String)
      : [];

    /*
     * A local review is re-run from its directory, not from Jira.
     *
     * Its id is `local:<project>@<branch>` — a name, not a path — so this
     * route used to normalize it (uppercasing it out of any possible match),
     * fail `isIssueKey`, and answer 400. The button did nothing, and said
     * nothing about why. The record remembers where it came from; read the
     * directory again and build the same event typing the path would.
     */
    const localPath = localSourceOf(wired.reviewStore.get(req.params.issueKey));
    if (localPath) {
      // An attached one keeps its issue: re-running must not quietly demote
      // a review of BUY-2397 back into `local:...` and take its decision
      // path away with it.
      const attached = isIssueKey(req.params.issueKey) ? normalizeIssueKey(req.params.issueKey) : '';
      const started = await buildLocalStart(localPath, { issueKey: attached, contextRepos });
      if (!started.ok) {
        res.status(started.status).json({ error: started.error });
        return;
      }
      lastPolled = [...lastPolled.filter((e) => e.id !== started.id), started.event];
      // Recorded on the way through, so a review that predates the field
      // stops relying on the collector's copy from here on.
      restartRecord(started.event, { projectPaths: [started.change.projectPath], localPath });
      res.json({ ok: true, position: queue.enqueue(started.event) });
      return;
    }

    const issueKey = normalizeIssueKey(req.params.issueKey);
    let event = lastPolled.find((e) => e.id === issueKey);

    if (!event) {
      if (!isIssueKey(issueKey)) {
        res.status(400).json({ error: `"${req.params.issueKey}" bir issue anahtarına benzemiyor (örn. BUY-2455).` });
        return;
      }
      try {
        event = toTriggerEvent(await wired.jiraClient.getIssue(issueKey));
        // Kept for this session so the detail view, the diff and the
        // approval path find it exactly as they would a polled one.
        lastPolled = [...lastPolled.filter((e) => e.id !== issueKey), event];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const missing = message.includes('404');
        res.status(missing ? 404 : 502).json({
          error: missing ? new UnknownIssueError(issueKey).message : `Jira'dan okunamadı: ${message}`,
        });
        return;
      }
    }

    event.data.contextRepos = contextRepos;
    restartRecord(event);
    res.json({ ok: true, position: queue.enqueue(event) });
  });

  /** Stops a review that is running or waiting. The record keeps whatever
   * it had before — a stop discards work in flight, not history. */
  app.post('/api/reviews/:issueKey/stop', (req, res) => {
    const { issueKey } = req.params;
    const stopped = queue.cancel(issueKey);
    if (!stopped) {
      res.status(409).json({ error: 'Bu iş çalışmıyor ya da kuyrukta değil.' });
      return;
    }
    // A running review sets its own status when the abort unwinds; a
    // waiting one never starts, so nothing else would ever mark it.
    if (wired.reviewStore.get(issueKey)?.status === 'queued') {
      wired.reviewStore.upsert(issueKey, { status: 'cancelled', queuePosition: undefined });
      progressBus.log(issueKey, 'kuyruktan çıkarıldı');
    }
    res.json({ ok: true });
  });


  /**
   * Turns the findings a human picked into a patch.
   *
   * Nothing is decided here and nothing is written to anyone's code: the
   * run produces a patch and stops. Applying it is a separate call against
   * a directory the person names, and even then it is left uncommitted.
   *
   * Defaults to every blocking and major finding — a minor is a nit, and a
   * patch nobody asked for is noise in someone's working copy.
   */
  app.post('/api/reviews/:issueKey/fix', (req, res) => {
    const { issueKey } = req.params;
    const record = wired.reviewStore.get(issueKey);

    if (!record?.review) {
      res.status(409).json({ error: 'Önce bir review gerekiyor — düzeltilecek bulgu yok.' });
      return;
    }
    if (!wired.fixTask.available) {
      res.status(409).json({
        error:
          'Bu makinedeki LLM sağlayıcısı dosya düzenleyemiyor. Düzeltme için `claude` CLI sağlayıcısı gerekiyor (config.yaml → wiring.llm: claudeCli).',
      });
      return;
    }
    if (!record.repoChanges?.length) {
      res.status(409).json({
        error: 'Bu review yerel bir checkout olmadan üretilmiş — üzerinde değişiklik yapılacak kod yok.',
      });
      return;
    }
    if (queue.positionOf(issueKey, 'fix') !== null) {
      res.status(409).json({ error: 'Bu iş için bir düzeltme zaten çalışıyor.' });
      return;
    }

    const all = parseFindings(record.review.markdown);
    const asked: string[] = Array.isArray(req.body?.findings) ? req.body.findings.map(String) : [];

    /*
     * A disputed finding is not fixed by default.
     *
     * An objection is a human saying "this finding is wrong". It only takes
     * effect on the next review — until then the finding is still sitting in
     * the review text, and offering to write code that satisfies it would be
     * the tool contradicting the person using it. Naming it explicitly still
     * works: the modal shows the objection and lets them choose anyway.
     *
     * Matched on the heading, which is what the dispute is keyed by.
     */
    const disputed = new Set(
      (record.challenges ?? []).filter((c) => c.objection.trim()).map((c) => c.finding),
    );
    const selected = asked.length
      ? all.filter((f) => asked.includes(f.id))
      : all.filter((f) => FIXABLE_SEVERITIES.includes(f.severity) && !disputed.has(f.heading));

    if (!selected.length) {
      res.status(400).json({ error: 'Düzeltilecek bulgu seçilmedi.' });
      return;
    }

    // Per-finding decisions, keyed by the same ids as the selection. A
    // finding that offered options is settled here or not at all — see
    // SelectedFinding in codeFixTask.
    const body = req.body?.instructions;
    const instructions: Record<string, string> =
      body && typeof body === 'object' && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body).map(([id, text]) => [id, String(text ?? '').trim()]))
        : {};

    wired.reviewStore.upsert(issueKey, {
      fix: {
        status: 'queued',
        findings: selected.map((f) => ({
          severity: f.severity,
          heading: f.heading,
          instruction: instructions[f.id] || undefined,
        })),
        patches: [],
        requestedAt: new Date().toISOString(),
      },
    });

    const position = queue.enqueue(
      {
        id: issueKey,
        data: {
          summary: record.summary,
          fixFindingIds: selected.map((f) => f.id),
          fixInstructions: instructions,
        },
      },
      'fix',
    );
    res.json({ ok: true, position, findings: selected.length });
  });

  /** Stops a fix that is running or waiting. The review it belongs to is
   * untouched — it was never part of this. */
  app.post('/api/reviews/:issueKey/fix/stop', (req, res) => {
    const { issueKey } = req.params;
    if (!queue.cancel(issueKey, 'fix')) {
      res.status(409).json({ error: 'Çalışan bir düzeltme yok.' });
      return;
    }
    // A running one marks itself when the abort unwinds; a waiting one
    // never starts, so nothing else would ever mark it.
    if (wired.reviewStore.get(issueKey)?.fix?.status === 'queued') {
      patchFix(issueKey, { status: 'cancelled', queuePosition: undefined });
    }
    res.json({ ok: true });
  });

  /** Throws the patch away. Used before asking for a different one, and by
   * the UI when a patch has served its purpose. */
  app.delete('/api/reviews/:issueKey/fix', (req, res) => {
    const { issueKey } = req.params;
    queue.cancel(issueKey, 'fix');
    wired.reviewStore.upsert(issueKey, { fix: undefined });
    res.json({ ok: true });
  });

  /** The patch text itself. Kept out of /detail because that endpoint is
   * polled once a second and a patch is measured in kilobytes. */
  app.get('/api/reviews/:issueKey/fix/patch', (req, res) => {
    const { issueKey } = req.params;
    const projectPath = String(req.query.projectPath ?? '');
    const entry = wired.reviewStore
      .get(issueKey)
      ?.fix?.patches.find((p) => !projectPath || p.projectPath === projectPath);

    if (!entry?.patch) {
      res.status(404).json({ error: 'Bu proje için yama yok.' });
      return;
    }
    if (req.query.download) {
      const name = `${issueKey}-${entry.projectPath.replace(/[^a-zA-Z0-9._-]+/g, '_')}.patch`;
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    res.type('text/plain; charset=utf-8').send(entry.patch);
  });

  /**
   * Applies a patch to a working copy on this machine and leaves it there,
   * uncommitted.
   *
   * The directory is named by the person, never guessed. The repo cache is
   * not a candidate however tempting: an apply there looks like it worked
   * and is erased by the next review that touches the repo.
   */
  app.post('/api/reviews/:issueKey/fix/apply', async (req, res) => {
    const { issueKey } = req.params;
    const fix = wired.reviewStore.get(issueKey)?.fix;
    const projectPath = String(req.body?.projectPath ?? '');
    const target = String(req.body?.path ?? '').trim();

    if (!fix || fix.status !== 'ready') {
      res.status(409).json({ error: 'Uygulanacak hazır bir yama yok.' });
      return;
    }
    if (!target) {
      res.status(400).json({ error: 'Yamanın uygulanacağı dizini seç.' });
      return;
    }
    const entry = fix.patches.find((p) => p.projectPath === projectPath);
    if (!entry?.patch.trim()) {
      res.status(404).json({ error: `${projectPath} için yama yok.` });
      return;
    }

    try {
      const result = await applyFixPatch(target, entry.patch, undefined, entry.branchName);
      const at = new Date().toISOString();
      patchFix(issueKey, {
        patches: fix.patches.map((p) =>
          p.projectPath === projectPath
            ? {
                ...p,
                appliedTo: result.root,
                appliedAt: at,
                appliedWithMerge: result.merged,
                appliedIgnoringWhitespace: result.ignoredWhitespace,
              }
            : p,
        ),
      });
      // Remembered so the next patch for this repo doesn't ask again.
      settings.update({ fixTargets: { ...(settings.get('fixTargets') ?? {}), [projectPath]: result.root } });
      res.json({ ok: true, root: result.root, files: result.files, merged: result.merged });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Applies a decision and reports whether it actually landed.
   *
   * The status is only advanced on a confirmed outcome. Before, the handler
   * assumed that returning meant success — so an issue whose pending entry
   * had gone missing was marked "posted to Jira" while nothing was written.
   * A decision this tool cannot carry out has to say so.
   */
  async function decide(
    issueKey: string,
    decision: 'approved' | 'rejected',
    patch: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const before = wired.reviewStore.get(issueKey);
    if (!before?.review || before.status !== 'awaiting_approval') {
      return {
        status: 409,
        body: { error: 'Bu iş onay beklemiyor — yeniden inceleyip tekrar deneyin.' },
      };
    }

    wired.reviewStore.upsert(issueKey, { status: decision, ...patch });
    const outcomes = await pipeline.resolveApprovals();
    const outcome = outcomes.find((o) => o.id === issueKey);

    if (!outcome) {
      // Nothing carried it out. Put the record back so the reviewer can act
      // again rather than being left with a decision that went nowhere.
      wired.reviewStore.upsert(issueKey, { status: 'awaiting_approval' });
      progressBus.log(issueKey, 'karar uygulanamadı: bekleyen onay kaydı bulunamadı');
      return {
        status: 500,
        body: { error: 'Karar uygulanamadı: bekleyen onay kaydı yok. Yeniden inceleyip tekrar deneyin.' },
      };
    }
    if (!outcome.applied) {
      wired.reviewStore.upsert(issueKey, { status: 'awaiting_approval', error: outcome.error });
      return { status: 502, body: { error: `Jira'ya yazılamadı: ${outcome.error ?? 'bilinmeyen hata'}` } };
    }

    // Approve ends at 'posted'; a rejection is already its own end state.
    if (decision === 'approved') wired.reviewStore.upsert(issueKey, { status: 'posted' });

    void publishDecision(issueKey, decision, String(patch.rejectionReason ?? ''));
    return { status: 200, body: { ok: true } };
  }

  /**
   * Tells the team where a review landed.
   *
   * Called only after Jira has actually been written to — publishing an
   * intention would leave teammates reading outcomes that never happened.
   *
   * Deliberately not awaited and never able to fail the request: the
   * decision is already in Jira, and refusing to report success because a
   * bookkeeping call timed out would leave the reviewer clicking a button
   * that had, in fact, worked.
   *
   * The review text does not travel. What was written about someone's code
   * is for whoever asked for it; the team needs the call, not the critique.
   */
  async function publishDecision(issueKey: string, decision: 'approved' | 'rejected', note: string): Promise<void> {
    const teamId = settings.get('teamId');
    if (!backend.configured || !teamId) return;

    const record = wired.reviewStore.get(issueKey);
    try {
      await backend.recordDecision(teamId, {
        issueKey,
        decision,
        severity: worstSeverity(record?.review?.markdown ?? ''),
        summary: record?.summary ?? '',
        note,
      });
    } catch (err) {
      // Worth a line in the log and nothing more: the local record is
      // still right, and the next decision publishes independently.
      console.warn(`[decisions] ${issueKey} sunucuya yazılamadı: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  app.post('/api/reviews/:issueKey/approve', async (req, res) => {
    const { status, body } = await decide(req.params.issueKey, 'approved', {});
    res.status(status).json(body);
  });

  app.post('/api/reviews/:issueKey/reject', async (req, res) => {
    // Optional: the review itself ships with the rejection, so the findings
    // already explain why it came back. A reason is extra context from the
    // reviewer, not a substitute for one.
    const reason = String(req.body?.reason ?? '').trim();
    const { status, body } = await decide(req.params.issueKey, 'rejected', { rejectionReason: reason });
    res.status(status).json(body);
  });

  /**
   * Reviews new arrivals before anyone asks. Started by the entry point so
   * a test can build the server without a background poller running.
   */
  /** Built through a factory because reload() replaces it: the watcher
   * holds the poll interval and the trigger it was created with, and
   * both change when the settings do. */
  function makeAutoPrepare(): AutoPrepareWatcher {
    return new AutoPrepareWatcher(config.autoPrepare, {
      trigger: wired.trigger,
      state,
      enqueue: (event) => {
        wired.reviewStore.upsert(event.id, {
          summary: typeof event.data.summary === 'string' ? event.data.summary : undefined,
          trigger: 'auto',
        });
        // Auto runs clone nothing new: whatever is already in the cache is
        // mounted as context anyway, and a surprise multi-GB clone is not
        // something to start on a poll nobody asked for.
        event.data.contextRepos = [];
        const position = queue.enqueue(event);
        emit('review:auto-queued', {
          issueKey: event.id,
          summary: typeof event.data.summary === 'string' ? event.data.summary : undefined,
          position,
        });
        return position;
      },
      // A finished or in-flight review is never redone on a poll; re-reviewing
      // is a judgement call, so it stays a button.
      alreadyHandled: (issueKey) => {
        const status = wired.reviewStore.get(issueKey)?.status;
        return status !== undefined && status !== 'idle' && status !== 'cancelled';
      },
      log: (message) => console.log(`[auto-prepare] ${message}`),
    });
  }

  let autoPrepare = makeAutoPrepare();

  /* ------------------------------ reminders ---------------------------- */

  /**
   * What is waiting on this person, from every direction at once.
   *
   * Assembled here rather than in the watcher because only the server has
   * all four: the backend client, the local review store and Jira. The
   * watcher owns the schedule; these own the facts.
   */
  const reminderSources = {
    /** Work a team-mate handed you, still open. */
    async assignments(): Promise<ReminderItem[]> {
      if (!backend.configured || !settings.get('apiSessionToken')) return [];
      const items = (await backend.myAssignments()) as Array<Record<string, unknown>>;
      return items
        .filter((a) => a.status !== 'closed')
        .map((a) => ({
          kind: 'assignment' as const,
          key: `assignment:${String(a.issueKey)}`,
          issueKey: String(a.issueKey),
          summary: a.summary ? String(a.summary) : undefined,
          since: String(a.assignedAt ?? new Date().toISOString()),
          from: a.assignedByName ? String(a.assignedByName) : undefined,
        }));
    },

    /** Reviews finished on this machine, waiting on a decision that only
     * this person can make. Announced once when ready, then by the clock —
     * a review nobody decides is a developer nobody unblocks. */
    approvals(): ReminderItem[] {
      return wired.reviewStore
        .list()
        .filter((r) => r.status === 'awaiting_approval')
        .map((r) => ({
          kind: 'approval' as const,
          key: `approval:${r.issueKey}`,
          issueKey: r.issueKey,
          summary: r.summary ?? undefined,
          since: r.reviewedAt ?? r.updatedAt,
        }));
    },

    /** Sitting in the review column with no review at all. Costs one JQL
     * call, which is why it rides the reminder interval rather than a
     * timer of its own. */
    async stale(): Promise<ReminderItem[]> {
      if (!config.setup.configured) return [];
      const events = await wired.trigger.poll();
      return events
        .filter((e) => {
          const status = wired.reviewStore.get(e.id)?.status;
          return status === undefined || status === 'idle' || status === 'cancelled';
        })
        .map((e) => ({
          kind: 'stale' as const,
          key: `stale:${e.id}`,
          issueKey: e.id,
          summary: typeof e.data.summary === 'string' ? e.data.summary : undefined,
          // When it last moved in Jira, which is the closest thing to
          // "how long has this been sitting here" without a changelog
          // call per issue.
          since: typeof e.data.updated === 'string' ? e.data.updated : new Date().toISOString(),
        }));
    },

    /** A person asking, which is why these are announced once each and
     * never folded into the clock's schedule. */
    async nudges(): Promise<ReminderItem[]> {
      if (!backend.configured || !settings.get('apiSessionToken')) return [];
      const items = await backend.nudges(state.nudgesSeenUntil());
      if (!items.length) return [];

      // The mark moves to the newest one seen, so the next poll asks only
      // for what came after.
      const newest = items.map((n) => n.createdAt).sort().pop();
      if (newest) state.setNudgesSeenUntil(newest);

      return items.map((n) => ({
        kind: 'nudge' as const,
        key: `nudge:${n.id}`,
        issueKey: n.issueKey,
        since: n.createdAt,
        message: n.message || undefined,
        from: n.fromName || undefined,
      }));
    },
  };

  function makeReminders(): ReminderWatcher {
    return new ReminderWatcher(
    { enabled: true, pollIntervalMs: config.reminders.pollIntervalMs },
    {
      sources: reminderSources,
      read: () => state.reminderState(),
      write: (next) => state.setReminderState(next),
      announce: (due, summary) => {
        emit('reminder:due', { items: due, title: summary.title, body: summary.body });
        console.log(`[reminders] ${summary.title} — ${due.length} iş`);
      },
      log: (message) => console.log(`[reminders] ${message}`),
      },
    );
  }

  let reminders = makeReminders();

  /** What is waiting, without waiting for the timer. Also what the
   * "hatırlat" button calls, so asking to be reminded reminds you now. */
  app.post('/api/reminders/check', async (_req, res) => {
    const due = await reminders.tick();
    res.json({ items: due, count: due.length });
  });

  /** Who has already asked about this issue, and when. Shown next to the
   * button so a second click is a decision rather than a guess. */
  app.get('/api/reminders/nudges/:issueKey', backendRoute(async (req) => {
    const teamId = settings.get('teamId');
    if (!teamId) return { items: [] };
    return { items: await backend.nudgesForIssue(teamId, req.params.issueKey) };
  }));

  /** Asks a team-mate to look at something. */
  app.post('/api/reminders/nudge', backendRoute(async (req) => {
    const teamId = settings.get('teamId');
    if (!teamId) throw new BackendError('Önce bir takıma katılmalısın.', 409);
    await backend.nudge(
      teamId,
      String(req.body?.issueKey ?? ''),
      String(req.body?.toUserId ?? ''),
      String(req.body?.message ?? ''),
    );
    return { ok: true };
  }));

  app.get('/api/auto-prepare', (_req, res) => {
    res.json({
      enabled: config.autoPrepare.enabled,
      since: state.autoPrepareSince(),
      lastReviewAt: state.lastReviewAt(),
    });
  });

  /**
   * Rebuilds everything the settings feed, without restarting the process.
   *
   * A saved credential used to sit on disk until the next launch, because
   * the Jira and GitLab clients were constructed once from the config read
   * at startup. This re-reads the settings, re-resolves the config and
   * builds a fresh set of adapters.
   *
   * The file-backed stores are carried over rather than rebuilt: two
   * instances writing one file overwrite each other, which is how an
   * approval once reported success while reaching Jira not at all.
   *
   * A review that is already running keeps the clients it started with —
   * it holds its own references, and swapping them underneath a request
   * in flight would be a stranger failure than any restart.
   */
  async function reload(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      // This server's own store, not whatever lives in the home directory —
      // see refreshSettingsOverrides.
      await refreshSettingsOverrides(settings);
      const next = loadConfig();
      const nextWired = buildPipeline(next, {
        reviewStore: wired.reviewStore,
        stateStore: wired.stateStore,
        notesStore: wired.notesStore,
      });

      autoPrepare.stop();
      reminders.stop();
      config = next;
      wired = nextWired;
      pipeline = new Pipeline(config, wired);
      autoPrepare = makeAutoPrepare();
      if (config.autoPrepare.enabled && config.setup.configured) autoPrepare.start();
      reminders = makeReminders();
      if (config.reminders.enabled) reminders.start();

      console.log('[settings] applied without restart');
      return { ok: true };
    } catch (err) {
      // The old wiring is still in place and still works: a config that
      // fails to build is a reason to keep running on what was there, not
      // to leave the app with no clients at all.
      //
      // A ZodError's message is a JSON dump of its issues. Shown raw it
      // told the reader to fix "path: [JIRA_EMAIL]"; named plainly it
      // tells them which field they got wrong.
      const error =
        err instanceof ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
          : err instanceof Error
            ? err.message
            : String(err);
      console.error(`[settings] could not apply: ${error}`);
      return { ok: false, error };
    }
  }

  /** Stops everything this server started. The HTTP listener is the
   * caller's to close — it owns it. */
  function shutdown(): void {
    autoPrepare.stop();
    reminders.stop();
    if (autoInstallTimer) clearInterval(autoInstallTimer);
    queue.stopAll();
  }

  /** How many reviews are sitting on a human right now — the number the
   * desktop shell puts on the tray and the dock. */
  function pendingCount(): number {
    return wired.reviewStore.list().filter((r) => r.status === 'awaiting_approval').length;
  }

  /* ------------------------------ updates ------------------------------ */

  /**
   * What the desktop shell knows about updates, and how the page asks for
   * one to be applied.
   *
   * The state lives in the Electron main process; this is only the window
   * the page sees through. In the browser build nothing ever sets it, so
   * `supported` stays false and the UI shows nothing — the same page has to
   * work in both.
   */
  let updateState: Record<string, unknown> = { supported: false };
  let installUpdate: (() => void) | null = null;

  let checkForUpdate: (() => Promise<Record<string, unknown>>) | null = null;
  let autoInstallTimer: NodeJS.Timeout | null = null;

  app.get('/api/update', (_req, res) => {
    res.json(updateState);
  });

  /**
   * "Check now."
   *
   * The automatic check runs hourly and on focus, which is enough — but a
   * person who has just heard a version is out should not have to wait
   * for a timer or restart the app to find out. Answering "you are up to
   * date" is as useful as finding an update: it ends the question.
   */
  app.post('/api/update/check', async (_req, res) => {
    if (!checkForUpdate) {
      res.status(409).json({ error: 'Bu çalışma biçiminde güncelleme kontrolü yok (geliştirme sürümü).' });
      return;
    }
    try {
      res.json(await checkForUpdate());
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Reviews that a restart would destroy. The `claude` process dies with
   * the app and its work cannot be resumed, so this is the one thing that
   * outranks an update. */
  function busyReviews(): string[] {
    return wired.reviewStore
      .list()
      .filter((r) => r.status === 'running' || r.status === 'queued')
      .map((r) => r.issueKey);
  }

  /**
   * Installs by itself once it is safe to.
   *
   * The update downloads on its own and then used to wait for a click.
   * Nobody clicks: the banner becomes furniture, and a version that fixes
   * something sits there unapplied for weeks. So it installs — but only
   * with nothing running, and after a pause long enough to say what is
   * about to happen.
   *
   * The refusal is not a formality. Restarting mid-review kills the model
   * process and loses work that cannot be resumed, which is worse than
   * running an old version for another ten minutes.
   */
  function scheduleAutoInstall(): void {
    if (!installUpdate || autoInstallTimer) return;

    autoInstallTimer = setInterval(() => {
      if (updateState.status !== 'ready' || !installUpdate) return;
      const busy = busyReviews();
      if (busy.length) return;

      clearInterval(autoInstallTimer!);
      autoInstallTimer = null;
      emit('update:installing', { version: String(updateState.version ?? '') });
      // A moment for the notification to land and for anyone at the
      // keyboard to see why the window is about to disappear.
      setTimeout(() => installUpdate?.(), 10_000);
    }, 30_000);
    autoInstallTimer.unref?.();
  }

  app.post('/api/update/install', (_req, res) => {
    if (!installUpdate) {
      res.status(409).json({ error: 'Bu sürümde otomatik güncelleme yok.' });
      return;
    }

    const busy = busyReviews();
    if (busy.length) {
      res.status(409).json({
        error: `Önce çalışan review'lar bitmeli ya da durdurulmalı: ${busy.join(', ')}`,
        busy,
      });
      return;
    }

    res.json({ ok: true });
    // After the response, so the page is told before the process goes.
    setTimeout(() => installUpdate?.(), 250);
  });

  return Object.assign(app, {
    // A getter: reload() replaces the watcher, and a caller holding the
    // original would be starting one that is no longer wired to anything.
    get autoPrepare() {
      return autoPrepare;
    },
    get reminders() {
      return reminders;
    },
    reload,
    shutdown,
    events,
    pendingCount,
    /** Called by the desktop shell as the updater reports progress. */
    /** Supplied by the desktop shell: the web-only mode has no updater,
     * and a button that does nothing is worse than no button. */
    setUpdateChecker(check: () => Promise<Record<string, unknown>>) {
      checkForUpdate = check;
    },
    setUpdateState(state: Record<string, unknown>, install?: () => void) {
      updateState = state;
      if (install) installUpdate = install;
      // Downloaded and nothing running: from here it applies itself.
      if (state.status === 'ready') scheduleAutoInstall();
    },
  });
}
