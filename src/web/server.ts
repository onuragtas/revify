import { EventEmitter } from 'node:events';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../core/atomicWrite.js';
import { SettingsStore, SETTINGS_DIR } from '../core/settingsStore.js';
import { backendUrl, isProductionBackend } from '../core/backendUrl.js';
import { BackendClient, BackendError } from '../clients/backendClient.js';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config/loadConfig.js';
import type { Wired } from '../core/registry.js';
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

export function createServer(config: AppConfig, wired: Wired) {
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

  const pipeline = new Pipeline(config, wired);
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
      res.status(409).json({
        error: `Önce kimlik bilgilerini gir (⚙ Ayarlar): ${config.setup.missing.join(', ')}`,
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

    res.json({
      jiraBaseUrl: config.jira.baseUrl.replace(/\/$/, ''),
      items: decided.map((r) => {
        const current = live.get(r.issueKey);
        return {
          issueKey: r.issueKey,
          summary: current?.summary ?? r.summary ?? null,
          decision: r.status,
          decidedAt: r.updatedAt,
          rejectionReason: r.rejectionReason || null,
          jiraStatus: current?.status ?? null,
          assignee: current?.assignee ?? null,
        };
      }),
    });
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
    });
  });

  app.post('/api/settings', (req, res) => {
    const textFields = [
      'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
      'gitlabBaseUrl', 'gitlabToken',
      'anthropicApiKey', 'anthropicModel', 'repoCacheDir',
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

    // Credentials are read once, when the clients are constructed. Saying
    // so is better than appearing to work until the next Jira call fails.
    // Credentials and config are read once, when the app starts. Saying so
    // is better than appearing to work until the next Jira call fails.
    res.json({
      ok: true,
      settings: settings.redacted(),
      restartRequired: Object.keys(patch).length > 0,
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
    const apiUrl = backendUrl();

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
    const apiUrl = backendUrl();
    try {
      res.json({ configured: true, user: await backend.me(), apiUrl });
    } catch (err) {
      // A configured-but-unreachable API is a normal state to render, not
      // an error that should blank the page.
      res.json({ configured: true, user: null, apiUrl, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/backend/login', backendRoute(async (req) =>
    ({ user: await backend.login(String(req.body?.email ?? ''), String(req.body?.password ?? '')) })));

  app.post('/api/backend/register', backendRoute(async (req) =>
    ({ user: await backend.register(
      String(req.body?.email ?? ''), String(req.body?.name ?? ''), String(req.body?.password ?? '')) })));

  app.post('/api/backend/logout', backendRoute(async () => {
    await backend.logout();
    return { ok: true };
  }));

  app.get('/api/backend/teams', backendRoute(async () => ({ items: await backend.teams() })));

  app.post('/api/backend/teams', backendRoute(async (req) =>
    ({ team: await backend.createTeam(String(req.body?.name ?? '')) })));

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
    return { settings: saved, restartRequired: true };
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

  /** Notes come from the team when there is one: "don't flag missing tests
   * in this repo" is accumulated team knowledge, and knowledge that lives
   * on one laptop is re-learned by everyone else. Falls back to the local
   * store when no backend is configured, and when it cannot be reached —
   * a review should not lose its rules because a server is down. */
  app.get('/api/notes', async (_req, res) => {
    const teamId = settings.get('teamId');
    if (backend.configured && teamId) {
      try {
        const items = await backend.teamNotes(teamId);
        res.json({ items, source: 'team' });
        return;
      } catch (err) {
        res.json({
          items: wired.notesStore.list(),
          source: 'local',
          warning: `Takım notları alınamadı, yereldekiler gösteriliyor: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    res.json({ items: wired.notesStore.list(), source: 'local' });
  });

  app.post('/api/notes', (req, res) => {
    const { scope, projectPath, text } = req.body ?? {};
    if (scope !== 'global' && scope !== 'repo') {
      res.status(400).json({ error: 'scope must be "global" or "repo"' });
      return;
    }
    try {
      res.json({ note: wired.notesStore.add({ scope, projectPath, text: String(text ?? '') }) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/notes/:id', (req, res) => {
    wired.notesStore.remove(req.params.id);
    res.json({ ok: true });
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
    return { status: 200, body: { ok: true } };
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
  const autoPrepare = new AutoPrepareWatcher(config.autoPrepare, {
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

  app.get('/api/auto-prepare', (_req, res) => {
    res.json({
      enabled: config.autoPrepare.enabled,
      since: state.autoPrepareSince(),
      lastReviewAt: state.lastReviewAt(),
    });
  });

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

  return Object.assign(app, { autoPrepare, shutdown, events, pendingCount });
}
