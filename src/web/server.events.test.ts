import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createServer } from './server.js';
import { ReviewStore } from '../core/reviewStore.js';
import { StateStore } from '../core/stateStore.js';
import { NotesStore } from '../core/notesStore.js';
import { SettingsStore } from '../core/settingsStore.js';
import { PromptStore } from '../core/promptStore.js';
import { CodeFixTask } from '../adapters/tasks/codeFixTask.js';
import type { Wired } from '../core/registry.js';
import type { AppConfig } from '../config/loadConfig.js';
import type { TaskResult, TriggerEvent } from '../core/types.js';

let dir: string;

function makeConfig(): AppConfig {
  return {
    pollIntervalMs: 60000,
    approvalPollIntervalMs: 20000,
    stateFilePath: join(dir, 'state.json'),
    reviewsFilePath: join(dir, 'reviews.json'),
    review: {
      language: 'English',
      useRepoCheckout: false,
      repoCacheDir: join(dir, 'repos'),
      notesFilePath: join(dir, 'notes.json'),
    },
    autoPrepare: { enabled: false, pollIntervalMs: 120000 },
    reminders: { enabled: false, pollIntervalMs: 900000 },
    setup: { configured: true, missing: [], configMissing: false, queueReady: true },
    wiring: {
      trigger: 'x',
      contextCollectors: [],
      task: 'x',
      llm: 'x',
      approval: 'x',
      action: 'x',
    },
    jira: {
      baseUrl: 'https://jira.example.com',
      email: 'a@b.c',
      apiToken: 't',
      jql: 'x',
      applyChanges: false,
      approveStatus: 'Ready for Stage',
      rejectStatus: 'In Development',
    },
    gitlab: { baseUrl: 'https://gitlab.example.com', token: 't' },
    slack: {},
    anthropic: { model: 'claude-opus-5' },
  };
}

/** A pipeline that produces a review without touching Jira, GitLab or a
 * model — enough to exercise the path a notification depends on. */
function makeWired(options: { fail?: boolean } = {}): Wired {
  const reviewStore = new ReviewStore(join(dir, 'reviews.json'));
  const event: TriggerEvent = {
    id: 'BUY-1',
    data: { issueKey: 'BUY-1', issueId: '1', summary: 'Barcode listing', status: 'Code Review' },
  };
  const taskResult: TaskResult = { title: 'Code review: BUY-1', markdown: 'Looks fine.\n\nVerdict: Approve' };

  return {
    trigger: { poll: async () => [event] },
    contextCollectors: [],
    task: {
      run: async () => {
        if (options.fail) throw new Error('model exploded');
        return taskResult;
      },
    },
    approval: {
      requestApproval: async (e, result) => {
        reviewStore.upsert(e.id, {
          status: 'awaiting_approval',
          review: { title: result.title, markdown: result.markdown },
        });
        return {};
      },
      checkPending: async () => [],
    },
    action: { execute: async () => {} },
    reviewStore,
    stateStore: new StateStore(join(dir, 'state.json')),
    notesStore: new NotesStore(join(dir, 'notes.json')),
    promptStore: new PromptStore(join(dir, 'prompts')),
    // Wired but never runnable: this fixture has no model and no checkout,
    // so the fix path can only ever report that it is unavailable.
    fixTask: new CodeFixTask({ canEditFiles: false, generate: async () => '' }),
    fixWorkspaceRoot: join(dir, 'fix-work'),
    gitlabClient: { listProjects: async () => [] } as unknown as Wired['gitlabClient'],
    jiraClient: {
      // Only what reviewing by key needs: BUY-9 exists, nothing else does.
      getIssue: async (key: string) => {
        if (key !== 'BUY-9') throw new Error('Jira API 404 Not Found');
        return {
          key,
          id: '9009',
          fields: { summary: 'Typed by hand', status: { name: 'In Progress' }, updated: '2026-08-17T09:00:00.000Z' },
        };
      },
      // The one-line answer the confirm dialog asks for. Same fixture rule:
      // BUY-9 exists, nothing else does.
      getIssueMeta: async (key: string) => {
        if (key !== 'BUY-9') throw new Error('Jira API 404 Not Found');
        return { key, summary: 'Typed by hand', status: 'In Progress' };
      },
      searchIssues: async () => [],
    } as unknown as Wired['jiraClient'],
  };
}

/**
 * Never the real settings file.
 *
 * `createServer`'s default is `~/.revify/settings.json` — the running
 * developer's own. A test that saves a setting, or applies a fix patch
 * (which remembers where it landed), writes into a live install without
 * anything saying so. It happened; hence this.
 */
const isolated = () => ({ settingsStore: new SettingsStore(join(dir, 'settings.json')) });

/**
 * A server that is guaranteed to be shut down.
 *
 * Eight tests here created one and never stopped it, so its pollers stayed
 * alive for the rest of the file — two of them with a task that never
 * finishes on its own still attached. Under load that is a suite which
 * hangs somewhere unrelated, forty seconds later, in whichever test happens
 * to be running. Registering here means the next test cannot forget.
 */
const running: Array<{ shutdown: () => void }> = [];

function boot(...args: Parameters<typeof createServer>): ReturnType<typeof createServer> {
  const server = createServer(...args);
  running.push(server);
  return server;
}

/**
 * Waits for the pipeline to get somewhere, on a machine that is busy.
 *
 * `vi.waitFor` gives up after one second by default, which `testTimeout`
 * does not cover — a separate budget with a much shorter fuse. These tests
 * drive real git and a real queue while the rest of the suite runs beside
 * them, so a second is a coin flip: green on an idle laptop, red in CI, and
 * a flaky test teaches people to re-run rather than to read.
 */
const SETTLE_MS = 20_000;
const settles = (assertion: () => void) => vi.waitFor(assertion, { timeout: SETTLE_MS, interval: 25 });

beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'srv-'))));
afterEach(() => {
  // Before the directory goes: a running server writes to it.
  while (running.length) running.pop()!.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('server notification events', () => {
  it('announces a review only once it is actually waiting on a human', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());
    const ready = vi.fn();
    server.events.on('review:ready', ready);

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });

    await settles(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(ready.mock.calls[0][0]).toMatchObject({ issueKey: 'BUY-1', summary: 'Barcode listing' });
    // The badge counts the same thing the notification announced.
    expect(server.pendingCount()).toBe(1);
  });

  it('announces a failure instead of a ready review when the run breaks', async () => {
    const server = boot(makeConfig(), makeWired({ fail: true }), isolated());
    const ready = vi.fn();
    const failed = vi.fn();
    server.events.on('review:ready', ready);
    server.events.on('review:failed', failed);

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });

    await settles(() => expect(failed).toHaveBeenCalledTimes(1));
    expect(failed.mock.calls[0][0].error).toContain('model exploded');
    // Interrupting someone for a review that does not exist is worse than
    // staying quiet.
    expect(ready).not.toHaveBeenCalled();
    expect(server.pendingCount()).toBe(0);
  });

  it('treats a stop as an instruction, not a failure', async () => {
    // A task that never finishes on its own, so the stop lands mid-run —
    // which is the only case where this distinction matters.
    const wired = makeWired();
    wired.task = {
      run: (_e, _c, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('durduruldu');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };

    const server = boot(makeConfig(), wired, isolated());
    const ready = vi.fn();
    const failed = vi.fn();
    server.events.on('review:ready', ready);
    server.events.on('review:failed', failed);

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });
    await settles(() => expect(wired.reviewStore.get('BUY-1')?.status).toBe('running'));

    await request(server).post('/api/reviews/BUY-1/stop').send();
    await settles(() => expect(wired.reviewStore.get('BUY-1')?.status).toBe('cancelled'));

    // Neither a finished review nor a fault — nothing to interrupt anyone about.
    expect(ready).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(server.pendingCount()).toBe(0);
  });
});

describe('update install', () => {
  it('is refused while a review is running', async () => {
    // A task that never finishes on its own, so the review is genuinely
    // mid-flight when the install is attempted.
    const wired = makeWired();
    wired.task = {
      run: (_e, _c, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('durduruldu')));
        }),
    };

    const server = boot(makeConfig(), wired, isolated());
    let installed = false;
    server.setUpdateState({ supported: true, status: 'ready' }, () => {
      installed = true;
    });

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });
    await settles(() => expect(wired.reviewStore.get('BUY-1')?.status).toBe('running'));

    const res = await request(server).post('/api/update/install').send();

    // Restarting here kills the `claude` process and loses work that cannot
    // be resumed. The update can wait; the review cannot.
    expect(res.status).toBe(409);
    expect(res.body.busy).toEqual(['BUY-1']);
    expect(installed).toBe(false);

    await request(server).post('/api/reviews/BUY-1/stop').send();
    // Shut down like every other test here. A server left running keeps its
    // pollers alive for the rest of the file — with a task that never
    // finishes on its own attached to it.
    server.shutdown();
  });

  it('installs once nothing is in flight', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());
    let installed = false;
    server.setUpdateState({ supported: true, status: 'ready' }, () => {
      installed = true;
    });

    const res = await request(server).post('/api/update/install').send();
    expect(res.status).toBe(200);
    // Deferred so the page is told before the process goes.
    await settles(() => expect(installed).toBe(true));
  });

  it('says so plainly when the build has no updater', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());

    const state = await request(server).get('/api/update');
    expect(state.body).toEqual({ supported: false });

    const res = await request(server).post('/api/update/install').send();
    expect(res.status).toBe(409);
  });
});

describe('automatic update install', () => {
  it('installs itself once nothing is running, and waits while something is', async () => {
    vi.useFakeTimers();
    try {
      const wired = makeWired();
      const app = boot(makeConfig(), wired, isolated());

      let installed = false;
      app.setUpdateState({ status: 'ready', version: '1.2.3' }, () => {
        installed = true;
      });

      // A review is running: a restart here kills the model process and
      // loses work that cannot be resumed.
      wired.reviewStore.upsert('BUY-1', { status: 'running' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(installed).toBe(false);

      // Once it finishes, the update applies without anyone clicking —
      // which is the point: nobody clicks, and the banner becomes
      // furniture.
      wired.reviewStore.upsert('BUY-1', { status: 'posted' });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(installed).toBe(true);

      app.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reviewing by issue key', () => {
  it('starts an issue the query never returned', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());
    const ready = vi.fn();
    server.events.on('review:ready', ready);

    // No list refresh first: the point is that an issue outside the team's
    // JQL used to answer "refresh the list first", which was impossible
    // advice for something the query does not match.
    const res = await request(server).post('/api/reviews/BUY-9/start').send({ contextRepos: [] });
    expect(res.status).toBe(200);

    await settles(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(ready.mock.calls[0][0]).toMatchObject({ issueKey: 'BUY-9', summary: 'Typed by hand' });

    server.shutdown();
  });

  it('accepts a key however it was typed', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());
    const res = await request(server).post('/api/reviews/buy-9/start').send({ contextRepos: [] });
    expect(res.status).toBe(200);
    server.shutdown();
  });

  it('answers a typo with a sentence, not a Jira error', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());

    const typo = await request(server).post('/api/reviews/not-a-key!/start').send({});
    expect(typo.status).toBe(400);
    expect(typo.body.error).toContain('BUY-2455');

    // Jira returns 404 both for "no such issue" and "not yours to see",
    // so the message has to cover both or it sends someone hunting for a
    // typo that isn't there.
    const missing = await request(server).post('/api/reviews/BUY-404/start').send({});
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain('erişimin olmayabilir');

    server.shutdown();
  });

  it('lists the team\'s query and nothing else', async () => {
    /*
     * This used to append every local record the query did not match, so a
     * hand-typed review would not vanish on the next refresh. The cost was
     * a list that accumulated everything the machine had ever touched —
     * reviews of local directories, tickets that left the query weeks ago,
     * rows nobody could explain.
     *
     * The two screens that answer those questions do it on purpose: Onay
     * bekleyenler reads the store, Kararlar reads the decisions. This one
     * answers "what is the team working on".
     */
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());
    await request(server).post('/api/reviews/BUY-9/start').send({ contextRepos: [] });
    wired.reviewStore.upsert('local:work@main', { status: 'failed', summary: 'work · main' });

    const list = await request(server).get('/api/reviews');
    const keys = list.body.items.map((i: { issueKey: string }) => i.issueKey);

    // BUY-1 is what the query returns; the other two are this machine's.
    expect(keys).toEqual(['BUY-1']);

    server.shutdown();
  });

  it('merges what this machine knows into the rows the query returned', async () => {
    // Jira says which issues are in review; the local store says how far
    // each one has got. A row with neither half is not worth showing.
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());
    wired.reviewStore.upsert('BUY-1', { status: 'awaiting_approval', reviewedAt: '2026-08-28T10:00:00Z' });

    const list = await request(server).get('/api/reviews');

    expect(list.body.items[0]).toMatchObject({
      issueKey: 'BUY-1',
      summary: 'Barcode listing',
      reviewStatus: 'awaiting_approval',
      reviewedAt: '2026-08-28T10:00:00Z',
    });

    server.shutdown();
  });
});

/**
 * Starts a local review and insists the server agreed.
 *
 * The status used to be ignored, so a refusal — nothing to review, not a
 * repository — left `issueKey` undefined and the next line waited twenty
 * seconds for a record that was never going to exist. The failure then
 * named the wait instead of the reason, which is the diagnosis thrown away.
 */
async function startLocal(
  server: ReturnType<typeof boot>,
  body: Record<string, unknown>,
): Promise<{ issueKey: string; local: boolean }> {
  const res = await request(server).post('/api/reviews/local').send(body);
  expect(res.status, `yerel review reddedildi: ${String(res.text).slice(0, 200)}`).toBe(200);
  return res.body;
}

/** A real repository with one uncommitted change — the shape a local review
 * is actually asked about. Real git, because every question this path asks
 * is a git question and a mock would only ever agree with the code. */
function makeRepo(): string {
  const root = join(dir, 'work');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });

  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'a.txt'), 'ilk\n');
  git('add', '.');
  git('commit', '-qm', 'ilk');
  writeFileSync(join(root, 'a.txt'), 'ilk\ndeğişti\n');
  return root;
}

describe('reviewing a local directory', () => {
  it('can be run a second time, from the directory it came from', async () => {
    /*
     * "Yeniden incele" answered 400 and the UI said nothing.
     *
     * A local review's id is `local:<project>@<branch>` — a name, not a
     * path — so /start normalized it (uppercase, which matches nothing),
     * failed `isIssueKey`, and refused. The record now remembers the
     * directory, which is the only thing the id cannot carry.
     */
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const first = await startLocal(server, { path: root });
    const id: string = first.issueKey;
    expect(id).toContain('local:');
    await settles(() => expect(wired.reviewStore.get(id)?.review).toBeDefined());

    // The very request the button makes, on the very id the server handed
    // back — including the '/' and ':' that survive a round trip.
    const again = await request(server).post(`/api/reviews/${encodeURIComponent(id)}/start`).send({ contextRepos: [] });
    expect(again.status).toBe(200);

    // A re-run archives what the last one said rather than dropping it.
    await settles(() => expect(wired.reviewStore.get(id)?.history?.length).toBe(1));
    server.shutdown();
  });

  it('says why it will not re-run, instead of refusing in silence', async () => {
    // A directory that has gone clean since the review has nothing to
    // review; the reader has to be told that, not shown a dead button.
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const first = await startLocal(server, { path: root });
    const id: string = first.issueKey;

    execFileSync('git', ['checkout', '--', '.'], { cwd: root });
    const again = await request(server).post(`/api/reviews/${encodeURIComponent(id)}/start`).send({});

    expect(again.status).toBe(409);
    expect(again.body.error).toContain('incelenecek değişiklik yok');
    server.shutdown();
  });

  it('describes a local review from the record rather than asking Jira', async () => {
    // Jira has no such issue, so /prepare answered 404 and the UI showed
    // "Jira detayları yüklenemedi" on a screen with no Jira behind it.
    const root = makeRepo();
    const server = boot(makeConfig(), makeWired(), isolated());

    const first = await startLocal(server, { path: root });
    const meta = await request(server).get(`/api/reviews/${encodeURIComponent(first.issueKey)}/prepare`);

    expect(meta.status).toBe(200);
    expect(meta.body.description).toContain(root);
    expect(meta.body.issueType).toBe('Yerel dizin');
    server.shutdown();
  });

  it('offers the branch\'s ticket for confirmation without acting on it', async () => {
    /*
     * A branch named `feature/BUY-9-...` almost certainly belongs to that
     * ticket — and "almost certainly" is not a licence to comment on it and
     * move its status. Inspecting says what it found; nothing is queued and
     * nothing is written until a human answers.
     */
    const root = makeRepo();
    execFileSync('git', ['checkout', '-qb', 'feature/BUY-9-km-muayene'], { cwd: root });
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const res = await request(server).post('/api/reviews/local/inspect').send({ path: root });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      branch: 'feature/BUY-9-km-muayene',
      suggestedIssueKey: 'BUY-9',
      files: 1,
    });
    // Read-only: no record, no queue entry.
    expect(wired.reviewStore.list()).toEqual([]);
    server.shutdown();
  });

  it('finds no ticket in a branch that names none', async () => {
    const root = makeRepo();
    const server = boot(makeConfig(), makeWired(), isolated());

    const res = await request(server).post('/api/reviews/local/inspect').send({ path: root });
    expect(res.body.suggestedIssueKey).toBeNull();
    server.shutdown();
  });

  it('answers whether a typed key is a real issue, so a typo is caught in the dialog', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());

    const found = await request(server).get('/api/issues/buy-9/summary');
    expect(found.body).toMatchObject({ key: 'BUY-9', summary: 'Typed by hand' });

    // Jira answers 404 both for "no such issue" and "not yours to see".
    const missing = await request(server).get('/api/issues/BUY-404/summary');
    expect(missing.body.error).toContain('BUY-404');

    const typo = await request(server).get('/api/issues/not-a-key/summary');
    expect(typo.status).toBe(400);
    server.shutdown();
  });

  it('attaches the review to the issue a human confirmed, and only then', async () => {
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const attached = await startLocal(server, { path: root, issueKey: 'BUY-9' });
    // The id becomes the issue's — this is a review of BUY-9 now, and the
    // decision will reach Jira like any other.
    expect(attached.issueKey).toBe('BUY-9');
    expect(attached.local).toBe(false);

    const plain = await startLocal(server, { path: root });
    expect(plain.issueKey).toContain('local:');
    expect(plain.local).toBe(true);
    server.shutdown();
  });

  it('re-runs a review recorded before the directory was stored separately', async () => {
    /*
     * The store already knew where these came from.
     *
     * `localPath` was added later, so every local review written before it
     * had `undefined` there — and re-running one answered 400 with "bir
     * issue anahtarına benzemiyor", about an id that was never an issue
     * key. But the collector had recorded the directory on the change
     * itself all along, which is what the fix path has always cloned from.
     * Reading that makes the existing records work rather than stranding
     * them.
     */
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const first = await startLocal(server, { path: root });
    const id: string = first.issueKey;
    await settles(() => expect(wired.reviewStore.get(id)?.review).toBeDefined());

    // Exactly the shape found in a real store: no `localPath`, and the
    // directory on the change where the collector put it.
    wired.reviewStore.upsert(id, {
      localPath: undefined,
      repoChanges: [
        { projectPath: 'team/api', baseBranch: 'origin/main', branchName: 'main', files: [], repoPath: root },
      ],
    });
    expect(wired.reviewStore.get(id)?.localPath).toBeUndefined();

    const again = await request(server).post(`/api/reviews/${encodeURIComponent(id)}/start`).send({});
    expect(again.status).toBe(200);
    await settles(() => expect(wired.reviewStore.get(id)?.history?.length).toBe(1));

    // And it is a local review as far as the decision is concerned, so the
    // buttons do not promise a Jira write.
    const detail = await request(server).get(`/api/reviews/${encodeURIComponent(id)}/detail`);
    expect(detail.body.local).toBe(true);
    server.shutdown();
  });

  it('describes such a review from the directory it recorded', async () => {
    // /prepare answered 404 for these — Jira advice about a review that has
    // no Jira issue.
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const first = await startLocal(server, { path: root });
    const id: string = first.issueKey;
    await settles(() => expect(wired.reviewStore.get(id)?.review).toBeDefined());
    wired.reviewStore.upsert(id, {
      localPath: undefined,
      repoChanges: [
        { projectPath: 'team/api', baseBranch: 'origin/main', branchName: 'main', files: [], repoPath: root },
      ],
    });

    const meta = await request(server).get(`/api/reviews/${encodeURIComponent(id)}/prepare`);
    expect(meta.status).toBe(200);
    expect(meta.body.description).toContain(root);
    server.shutdown();
  });

  it('reads the directory again, so a re-review sees what is there now', async () => {
    /*
     * Not a snapshot of the moment somebody first pointed at it: the whole
     * reason to press "yeniden incele" is that the code has changed since,
     * usually because it was just fixed. Uncommitted work counts too — that
     * is the half most likely to be wrong.
     */
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const first = await startLocal(server, { path: root });
    const id: string = first.issueKey;
    await settles(() => expect(wired.reviewStore.get(id)?.review).toBeDefined());

    // Something new in the working copy, never committed.
    writeFileSync(join(root, 'b.txt'), 'sonradan\n');

    const again = await request(server).post(`/api/reviews/${encodeURIComponent(id)}/start`).send({});
    expect(again.status).toBe(200);
    await settles(() => expect(wired.reviewStore.get(id)?.history?.length).toBe(1));
    server.shutdown();
  });

  it('will not file a review of one branch under a record about another', async () => {
    /*
     * The id is built from project and branch. Following the checkout
     * silently would file a review of `feature/B` under a record whose id,
     * summary and history all say `main` — and start it under an id nobody
     * is watching, so the screen polls the old one and shows nothing
     * happening. That is the third time a button has looked broken for
     * exactly this reason.
     */
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    const first = await startLocal(server, { path: root });
    const id: string = first.issueKey;
    await settles(() => expect(wired.reviewStore.get(id)?.review).toBeDefined());

    execFileSync('git', ['checkout', '-qb', 'feature/başka'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'yine değişti\n');

    const again = await request(server).post(`/api/reviews/${encodeURIComponent(id)}/start`).send({});

    expect(again.status).toBe(409);
    expect(again.body.error).toContain('feature/başka');
    expect(again.body.error).toContain('main');
    // And nothing was filed anywhere else.
    expect(wired.reviewStore.list().map((r) => r.issueKey)).toEqual([id]);
    server.shutdown();
  });

  it('keeps an attached review attached when it is run again', async () => {
    /*
     * A confirmed review of BUY-9 is a review of BUY-9, even though the
     * record still remembers the directory so a re-run can re-read it.
     * Rebuilding it without the key would silently demote it back to
     * `local:...` — new id, and a decision that no longer reaches Jira.
     */
    const root = makeRepo();
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    await startLocal(server, { path: root, issueKey: 'BUY-9' });
    await settles(() => expect(wired.reviewStore.get('BUY-9')?.review).toBeDefined());

    const again = await request(server).post('/api/reviews/BUY-9/start').send({ contextRepos: [] });
    expect(again.status).toBe(200);
    await settles(() => expect(wired.reviewStore.get('BUY-9')?.history?.length).toBe(1));

    // And it is still not a local-only review: the decision goes to Jira.
    const detail = await request(server).get('/api/reviews/BUY-9/detail');
    expect(detail.body.local).toBe(false);
    expect(wired.reviewStore.get('local:')).toBeUndefined();
    server.shutdown();
  });

  it('describes an attached review from Jira, not from the directory', async () => {
    // It has a `localPath` — it was started from one — but it also has a
    // ticket, and the ticket is what the reader needs to see.
    const root = makeRepo();
    const server = boot(makeConfig(), makeWired(), isolated());

    await startLocal(server, { path: root, issueKey: 'BUY-9' });
    await request(server).get('/api/reviews');
    const meta = await request(server).get('/api/reviews/BUY-9/prepare');

    expect(meta.body.issueType).not.toBe('Yerel dizin');
    server.shutdown();
  });

  it('refuses a path that is not a repository, and one with nothing to review', async () => {
    const server = boot(makeConfig(), makeWired(), isolated());

    // Posted directly rather than through `startLocal`: the refusal is the
    // thing under test, so asserting a 200 first would be nonsense.
    const notRepo = await request(server).post('/api/reviews/local').send({ path: dir });
    expect(notRepo.status).toBe(400);
    expect(notRepo.body.error).toContain('git deposu değil');

    const empty = await request(server).post('/api/reviews/local').send({ path: '' });
    expect(empty.status).toBe(400);

    server.shutdown();
  });
});


describe('an objection that asked something', () => {
  it('pairs the reviewer\'s reply with the objection that drew it', async () => {
    /*
     * The pairing rule is a fact about the review format — an `[answer]`
     * line opens with the finding's heading — so it lives here rather than
     * in the browser, where a second implementation of it would be the one
     * that drifts.
     */
    const wired = makeWired();
    const server = boot(makeConfig(), wired, isolated());

    wired.reviewStore.upsert('BUY-1', {
      status: 'awaiting_approval',
      review: {
        title: 't',
        markdown: [
          'Verdict: Approve',
          '',
          '[answer] blocking — src/Payment.php:829 — Ediliyor ama yalnızca POST yolunda.',
          '[answer] major — src/Bank.php:12 — Kontrol edemedim, dosya checkout dışında.',
        ].join('\n'),
      },
      challenges: [
        { finding: 'blocking — src/Payment.php:829', objection: 'Valide ediliyor değil mi?', raisedAt: '' },
        { finding: 'minor — src/Log.php:4', objection: 'bence yanlış', raisedAt: '' },
      ],
    });

    const detail = await request(server).get('/api/reviews/BUY-1/detail');
    const [first, second] = detail.body.challenges;

    expect(first.answer).toBe('Ediliyor ama yalnızca POST yolunda.');
    // An objection nobody answered keeps no answer field at all.
    expect(second.answer).toBeUndefined();
    // The marker never reaches anything a reader sees, here or in Jira:
    // the question was ours, and the answer is shown beside it instead.
    expect(detail.body.review.markdown).not.toContain('[answer]');
    expect(detail.body.reviewTail).not.toContain('[answer]');
  });
});

describe('content security policy', () => {
  it('forbids everything by default, and allows only this origin', async () => {
    const app = boot(makeConfig(), makeWired(), isolated());
    const res = await request(app).get('/api/reviews');
    const policy = res.headers['content-security-policy'];

    expect(policy).toContain("default-src 'none'");
    // The page talks to this server and nothing else — the team backend is
    // reached through it, never from the browser.
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('allows nothing inline — not script, and not style either', async () => {
    // Until the UI moved to Vue this page *was* a 2000-line inline script,
    // and `script-src 'unsafe-inline'` would have made the rest close to
    // pointless. Nothing inline is left, so nothing inline may run.
    const app = boot(makeConfig(), makeWired(), isolated());
    const policy = (await request(app).get('/')).headers['content-security-policy'];

    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    // One directive left open for convenience is how a policy stops meaning
    // anything.
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('covers the page itself, not only the API', async () => {
    const app = boot(makeConfig(), makeWired(), isolated());
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });
});
