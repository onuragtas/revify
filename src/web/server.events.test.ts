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

beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'srv-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('server notification events', () => {
  it('announces a review only once it is actually waiting on a human', async () => {
    const server = createServer(makeConfig(), makeWired(), isolated());
    const ready = vi.fn();
    server.events.on('review:ready', ready);

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });

    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(ready.mock.calls[0][0]).toMatchObject({ issueKey: 'BUY-1', summary: 'Barcode listing' });
    // The badge counts the same thing the notification announced.
    expect(server.pendingCount()).toBe(1);
  });

  it('announces a failure instead of a ready review when the run breaks', async () => {
    const server = createServer(makeConfig(), makeWired({ fail: true }), isolated());
    const ready = vi.fn();
    const failed = vi.fn();
    server.events.on('review:ready', ready);
    server.events.on('review:failed', failed);

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });

    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
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

    const server = createServer(makeConfig(), wired, isolated());
    const ready = vi.fn();
    const failed = vi.fn();
    server.events.on('review:ready', ready);
    server.events.on('review:failed', failed);

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });
    await vi.waitFor(() => expect(wired.reviewStore.get('BUY-1')?.status).toBe('running'));

    await request(server).post('/api/reviews/BUY-1/stop').send();
    await vi.waitFor(() => expect(wired.reviewStore.get('BUY-1')?.status).toBe('cancelled'));

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

    const server = createServer(makeConfig(), wired, isolated());
    let installed = false;
    server.setUpdateState({ supported: true, status: 'ready' }, () => {
      installed = true;
    });

    await request(server).get('/api/reviews');
    await request(server).post('/api/reviews/BUY-1/start').send({ contextRepos: [] });
    await vi.waitFor(() => expect(wired.reviewStore.get('BUY-1')?.status).toBe('running'));

    const res = await request(server).post('/api/update/install').send();

    // Restarting here kills the `claude` process and loses work that cannot
    // be resumed. The update can wait; the review cannot.
    expect(res.status).toBe(409);
    expect(res.body.busy).toEqual(['BUY-1']);
    expect(installed).toBe(false);

    await request(server).post('/api/reviews/BUY-1/stop').send();
  });

  it('installs once nothing is in flight', async () => {
    const server = createServer(makeConfig(), makeWired(), isolated());
    let installed = false;
    server.setUpdateState({ supported: true, status: 'ready' }, () => {
      installed = true;
    });

    const res = await request(server).post('/api/update/install').send();
    expect(res.status).toBe(200);
    // Deferred so the page is told before the process goes.
    await vi.waitFor(() => expect(installed).toBe(true));
  });

  it('says so plainly when the build has no updater', async () => {
    const server = createServer(makeConfig(), makeWired(), isolated());

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
      const app = createServer(makeConfig(), wired, isolated());

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
    const server = createServer(makeConfig(), makeWired(), isolated());
    const ready = vi.fn();
    server.events.on('review:ready', ready);

    // No list refresh first: the point is that an issue outside the team's
    // JQL used to answer "refresh the list first", which was impossible
    // advice for something the query does not match.
    const res = await request(server).post('/api/reviews/BUY-9/start').send({ contextRepos: [] });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    expect(ready.mock.calls[0][0]).toMatchObject({ issueKey: 'BUY-9', summary: 'Typed by hand' });

    server.shutdown();
  });

  it('accepts a key however it was typed', async () => {
    const server = createServer(makeConfig(), makeWired(), isolated());
    const res = await request(server).post('/api/reviews/buy-9/start').send({ contextRepos: [] });
    expect(res.status).toBe(200);
    server.shutdown();
  });

  it('answers a typo with a sentence, not a Jira error', async () => {
    const server = createServer(makeConfig(), makeWired(), isolated());

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

  it('keeps a hand-typed issue in the list instead of losing it on refresh', async () => {
    const wired = makeWired();
    const server = createServer(makeConfig(), wired, isolated());
    await request(server).post('/api/reviews/BUY-9/start').send({ contextRepos: [] });

    // The queue answers a different question and will never mention BUY-9.
    const list = await request(server).get('/api/reviews');
    const row = list.body.items.find((i: { issueKey: string }) => i.issueKey === 'BUY-9');
    expect(row).toBeDefined();
    expect(row.manual).toBe(true);

    server.shutdown();
  });
});

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
    const server = createServer(makeConfig(), wired, isolated());

    const first = await request(server).post('/api/reviews/local').send({ path: root });
    expect(first.status).toBe(200);
    const id: string = first.body.issueKey;
    expect(id).toContain('local:');
    await vi.waitFor(() => expect(wired.reviewStore.get(id)?.review).toBeDefined());

    // The very request the button makes, on the very id the server handed
    // back — including the '/' and ':' that survive a round trip.
    const again = await request(server).post(`/api/reviews/${encodeURIComponent(id)}/start`).send({ contextRepos: [] });
    expect(again.status).toBe(200);

    // A re-run archives what the last one said rather than dropping it.
    await vi.waitFor(() => expect(wired.reviewStore.get(id)?.history?.length).toBe(1));
    server.shutdown();
  });

  it('says why it will not re-run, instead of refusing in silence', async () => {
    // A directory that has gone clean since the review has nothing to
    // review; the reader has to be told that, not shown a dead button.
    const root = makeRepo();
    const wired = makeWired();
    const server = createServer(makeConfig(), wired, isolated());

    const first = await request(server).post('/api/reviews/local').send({ path: root });
    const id: string = first.body.issueKey;

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
    const server = createServer(makeConfig(), makeWired(), isolated());

    const first = await request(server).post('/api/reviews/local').send({ path: root });
    const meta = await request(server).get(`/api/reviews/${encodeURIComponent(first.body.issueKey)}/prepare`);

    expect(meta.status).toBe(200);
    expect(meta.body.description).toContain(root);
    expect(meta.body.issueType).toBe('Yerel dizin');
    server.shutdown();
  });

  it('refuses a path that is not a repository, and one with nothing to review', async () => {
    const server = createServer(makeConfig(), makeWired(), isolated());

    const notRepo = await request(server).post('/api/reviews/local').send({ path: dir });
    expect(notRepo.status).toBe(400);
    expect(notRepo.body.error).toContain('git deposu değil');

    const empty = await request(server).post('/api/reviews/local').send({ path: '' });
    expect(empty.status).toBe(400);

    server.shutdown();
  });
});


describe('content security policy', () => {
  it('forbids everything by default, and allows only this origin', async () => {
    const app = createServer(makeConfig(), makeWired(), isolated());
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
    const app = createServer(makeConfig(), makeWired(), isolated());
    const policy = (await request(app).get('/')).headers['content-security-policy'];

    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    // One directive left open for convenience is how a policy stops meaning
    // anything.
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('covers the page itself, not only the API', async () => {
    const app = createServer(makeConfig(), makeWired(), isolated());
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });
});
