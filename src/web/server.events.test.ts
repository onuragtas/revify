import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createServer } from './server.js';
import { ReviewStore } from '../core/reviewStore.js';
import { StateStore } from '../core/stateStore.js';
import { NotesStore } from '../core/notesStore.js';
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
    setup: { configured: true, missing: [] },
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
    gitlabClient: { listProjects: async () => [] } as unknown as Wired['gitlabClient'],
    jiraClient: {} as Wired['jiraClient'],
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
