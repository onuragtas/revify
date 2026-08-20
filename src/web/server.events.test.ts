import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createServer } from './server.js';
import { ReviewStore } from '../core/reviewStore.js';
import { StateStore } from '../core/stateStore.js';
import { NotesStore } from '../core/notesStore.js';
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

beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'srv-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('server notification events', () => {
  it('announces a review only once it is actually waiting on a human', async () => {
    const server = createServer(makeConfig(), makeWired());
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
    const server = createServer(makeConfig(), makeWired({ fail: true }));
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

    const server = createServer(makeConfig(), wired);
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

    const server = createServer(makeConfig(), wired);
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
    const server = createServer(makeConfig(), makeWired());
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
    const server = createServer(makeConfig(), makeWired());

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
      const app = createServer(makeConfig(), wired);

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
    const server = createServer(makeConfig(), makeWired());
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
    const server = createServer(makeConfig(), makeWired());
    const res = await request(server).post('/api/reviews/buy-9/start').send({ contextRepos: [] });
    expect(res.status).toBe(200);
    server.shutdown();
  });

  it('answers a typo with a sentence, not a Jira error', async () => {
    const server = createServer(makeConfig(), makeWired());

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
    const server = createServer(makeConfig(), wired);
    await request(server).post('/api/reviews/BUY-9/start').send({ contextRepos: [] });

    // The queue answers a different question and will never mention BUY-9.
    const list = await request(server).get('/api/reviews');
    const row = list.body.items.find((i: { issueKey: string }) => i.issueKey === 'BUY-9');
    expect(row).toBeDefined();
    expect(row.manual).toBe(true);

    server.shutdown();
  });
});

describe('reviewing a local directory', () => {
  it('refuses a path that is not a repository, and one with nothing to review', async () => {
    const server = createServer(makeConfig(), makeWired());

    const notRepo = await request(server).post('/api/reviews/local').send({ path: dir });
    expect(notRepo.status).toBe(400);
    expect(notRepo.body.error).toContain('git deposu değil');

    const empty = await request(server).post('/api/reviews/local').send({ path: '' });
    expect(empty.status).toBe(400);

    server.shutdown();
  });
});
