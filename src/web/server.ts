import { EventEmitter } from 'node:events';
import { ZodError } from 'zod';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../core/atomicWrite.js';
import { SettingsStore, SETTINGS_DIR } from '../core/settingsStore.js';
import { backendUrl, defaultBackendUrl, isProductionBackend } from '../core/backendUrl.js';
import { BackendClient, BackendError } from '../clients/backendClient.js';
import { fileURLToPath } from 'node:url';
import { loadConfig, refreshSettingsOverrides, type AppConfig } from '../config/loadConfig.js';
import { buildPipeline, type Wired } from '../core/registry.js';
import { Pipeline } from '../core/pipeline.js';
import { ReviewQueue } from '../core/reviewQueue.js';
import { AutoPrepareWatcher } from '../core/autoPrepare.js';
import { progressBus } from '../core/progressBus.js';
import { splitReview } from '../core/reviewParts.js';
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
}

export function createServer(initialConfig: AppConfig, initialWired: Wired) {
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

  const settings = new SettingsStore();
  const backend = new BackendClient(settings);

  // Reviews run strictly one at a time — see ReviewQueue for why that is a
  // correctness requirement and not just throttling.
  const queue = new ReviewQueue(
    async (event, signal) => {
      progressBus.log(event.id, 'started');
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
    (issueKey, position) => {
      if (position === 0) {
        wired.reviewStore.upsert(issueKey, { status: 'running', queuePosition: undefined });
        return;
      }
      wired.reviewStore.upsert(issueKey, { status: 'queued', queuePosition: position });
      progressBus.log(issueKey, `queued — ${position} review(s) ahead`);
    },
  );

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
      // Two different problems wear the same 409, so the message names the
      // one you actually have: credentials are typed in, a policy is
      // inherited from a team. Telling someone to enter credentials they
      // already entered sends them looking in the wrong place.
      const onlyPolicy = config.setup.missing.every((m) => m.includes('JQL'));
      res.status(409).json({
        error: onlyPolicy
          ? 'Hangi issue\'ların inceleneceğini takım politikası belirler ve henüz bir takımın yok. ⚙ Ayarlar → Takım politikası\'ndan bir takım oluştur.'
          : `Önce kimlik bilgilerini gir (⚙ Ayarlar): ${config.setup.missing.join(', ')}`,
        setupRequired: true,
      });
      return;
    }
    try {
      lastPolled = await wired.trigger.poll();
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const items = lastPolled.map((event) => {
      const record = wired.reviewStore.get(event.id);
      return {
        issueKey: event.id,
        summary: event.data.summary ?? null,
        jiraStatus: event.data.status ?? null,
        assignee: event.data.assignee ?? null,
        updated: event.data.updated ?? null,
        reviewStatus: record?.status ?? 'idle',
        queuePosition: record?.queuePosition ?? null,
        trigger: record?.trigger ?? 'manual',
        reviewedAt: record?.reviewedAt ?? null,
        review: record?.review ?? null,
        error: record?.error ?? null,
      };
    });
    res.json({ items });
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
  app.get('/api/reviews/:issueKey/detail', (req, res) => {
    const { issueKey } = req.params;
    const record = wired.reviewStore.get(issueKey);
    const projectPaths = record?.projectPaths ?? [];
    // The review is split server-side so the UI and the Jira action share
    // one parser: readers see the body, the team sees the bookkeeping.
    const parts = record?.review ? splitReview(record.review.markdown) : null;
    res.json({
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
      clarifications: record?.clarifications ?? [],
      rejectionReason: record?.rejectionReason ?? null,
      revisionRequest: record?.revisionRequest ?? '',
      challenges: record?.challenges ?? [],
      withdrawn: parts?.withdrawn ?? [],
      error: record?.error ?? null,
      steps: progressBus.getBuffered(issueKey),
      // The notes that were (or would be) in force for this issue, so the
      // UI can show what the reviewer was told to ignore.
      notes: [
        ...new Map(
          (projectPaths.length ? projectPaths : [null]).flatMap((p) =>
            wired.notesStore.listApplicable(p).map((n) => [n.id, n] as const),
          ),
        ).values(),
      ],
    });
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
        severity: r.review ? worstSeverity(r.review.markdown) : '',
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
    const numberFields = ['autoPreparePollMs'] as const;

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
  async function syncTeamNotes(): Promise<boolean> {
    const teamId = settings.get('teamId');
    if (!backend.configured || !teamId) return false;
    try {
      const items = (await backend.teamNotes(teamId)) as Array<Record<string, unknown>>;
      wired.notesStore.replaceAll(
        items.map((n) => ({
          id: String(n.id ?? ''),
          scope: n.scope === 'repo' ? ('repo' as const) : ('global' as const),
          projectPath: n.projectPath ? String(n.projectPath) : null,
          text: String(n.text ?? ''),
          createdAt: String(n.createdAt ?? ''),
        })),
      );
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
    const event = lastPolled.find((e) => e.id === req.params.issueKey);
    if (!event) {
      res.status(404).json({ error: 'Unknown issue — refresh the list first.' });
      return;
    }

    try {
      const [meta, branches] = await Promise.all([
        wired.jiraClient.getIssueMeta(req.params.issueKey),
        wired.jiraClient.getLinkedBranches(String(event.data.issueId)),
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
    // to start later against state the user thought they had wiped.
    queue.cancel(issueKey);
    progressBus.clear(issueKey);
    wired.reviewStore.reset(issueKey);
    pipeline.forget(issueKey);
    // Otherwise a cleared issue would stay on the watcher's seen list and
    // could never be prepared again — "clear" has to mean clear.
    state.forgetAutoPrepareSeen(issueKey);
    res.json({ ok: true });
  });

  app.post('/api/reviews/:issueKey/start', (req, res) => {
    const event = lastPolled.find((e) => e.id === req.params.issueKey);
    if (!event) {
      res.status(404).json({ error: 'Unknown issue — refresh the list first.' });
      return;
    }

    // Repos the reviewer picked as worth having on disk. Cloning happens
    // inside the run so its progress shows up in the step log.
    const contextRepos = Array.isArray(req.body?.contextRepos)
      ? req.body.contextRepos.map(String)
      : [];
    event.data.contextRepos = contextRepos;

    // Keep the previous run's review so it can be compared against the new
    // one — a re-review is usually a response to something, and losing
    // what was said last time makes it impossible to see what changed.
    wired.reviewStore.archiveCurrentReview(event.id);
    progressBus.clear(event.id);
    wired.reviewStore.upsert(event.id, {
      summary: typeof event.data.summary === 'string' ? event.data.summary : undefined,
      review: undefined,
      error: undefined,
      trigger: 'manual',
      // Belongs to the decision that just got superseded — keeping it would
      // attach the old rejection's reason to a brand new review.
      rejectionReason: undefined,
    });

    // The queue sets the status — running if it starts now, queued
    // otherwise — and starts the run itself. The caller polls /detail.
    const position = queue.enqueue(event);
    res.json({ ok: true, position });
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
   * The heaviest finding in a review.
   *
   * Severity is not stored as a field — it lives in the finding headings
   * (`### blocking — file:line`), which is how the UI colours them. The
   * team list wants one label per issue, and the honest one is the worst:
   * an issue with a blocking finding is not "minor" because two minors
   * came after it.
   */
  function worstSeverity(markdown: string): string {
    const order = ['blocking', 'major', 'minor'];
    const found = new Set(
      [...markdown.matchAll(/^#{1,6}\s*(blocking|major|minor)\b/gim)].map((m) => m[1].toLowerCase()),
    );
    return order.find((level) => found.has(level)) ?? '';
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
      await refreshSettingsOverrides();
      const next = loadConfig();
      const nextWired = buildPipeline(next, {
        reviewStore: wired.reviewStore,
        stateStore: wired.stateStore,
        notesStore: wired.notesStore,
      });

      autoPrepare.stop();
      config = next;
      wired = nextWired;
      pipeline = new Pipeline(config, wired);
      autoPrepare = makeAutoPrepare();
      if (config.autoPrepare.enabled && config.setup.configured) autoPrepare.start();

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

  app.get('/api/update', (_req, res) => {
    res.json(updateState);
  });

  app.post('/api/update/install', (_req, res) => {
    if (!installUpdate) {
      res.status(409).json({ error: 'Bu sürümde otomatik güncelleme yok.' });
      return;
    }

    // Restarting mid-review kills the `claude` process and loses the work
    // it has already done. The update can wait; the review cannot be
    // resumed.
    const busy = wired.reviewStore
      .list()
      .filter((r) => r.status === 'running' || r.status === 'queued')
      .map((r) => r.issueKey);
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
    reload,
    shutdown,
    events,
    pendingCount,
    /** Called by the desktop shell as the updater reports progress. */
    setUpdateState(state: Record<string, unknown>, install?: () => void) {
      updateState = state;
      if (install) installUpdate = install;
    },
  });
}
