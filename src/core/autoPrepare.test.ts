import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoPrepareWatcher } from './autoPrepare.js';
import { StateStore } from './stateStore.js';
import type { TriggerEvent } from './types.js';

let dir: string;
let state: StateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-prepare-'));
  state = new StateStore(join(dir, 'state.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function watcherOver(pages: string[][]) {
  const enqueued: string[] = [];
  let page = 0;
  const trigger = {
    poll: async (): Promise<TriggerEvent[]> => {
      const keys = pages[Math.min(page, pages.length - 1)];
      page++;
      return keys.map((id) => ({ id, data: { issueKey: id } }));
    },
  };
  const watcher = new AutoPrepareWatcher(
    { enabled: true, pollIntervalMs: 1000 },
    {
      trigger,
      state,
      enqueue: (event) => {
        enqueued.push(event.id);
        return enqueued.length - 1;
      },
      alreadyHandled: () => false,
      log: () => {},
    },
  );
  return { watcher, enqueued };
}

describe('AutoPrepareWatcher', () => {
  it('reviews nothing on the first poll — the existing queue is the baseline', async () => {
    const { watcher, enqueued } = watcherOver([['A', 'B', 'C']]);

    await watcher.tick();

    // Switching this on against a standing backlog must not fire off a
    // review for every issue already sitting in Code Review.
    expect(enqueued).toEqual([]);
    expect(state.hasAutoPrepareBaseline()).toBe(true);
  });

  it('reviews only what turns up after watching began', async () => {
    const { watcher, enqueued } = watcherOver([
      ['A', 'B'],
      ['A', 'B', 'C'],
    ]);

    await watcher.tick(); // baseline: A, B
    await watcher.tick(); // C is new

    expect(enqueued).toEqual(['C']);
  });

  it('does not queue the same issue twice on later polls', async () => {
    const { watcher, enqueued } = watcherOver([['A'], ['A', 'B'], ['A', 'B'], ['A', 'B']]);

    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();

    expect(enqueued).toEqual(['B']);
  });

  it('keeps its baseline across a restart', async () => {
    const { watcher } = watcherOver([['A', 'B']]);
    await watcher.tick();

    // A second store over the same file is what a restart looks like.
    const reopened = new StateStore(join(dir, 'state.json'));
    expect(reopened.hasAutoPrepareBaseline()).toBe(true);
    expect(reopened.unseenIssueKeys(['A', 'B'])).toEqual([]);
    expect(reopened.unseenIssueKeys(['A', 'B', 'C'])).toEqual(['C']);
  });

  it('leaves an issue alone when it already has a review', async () => {
    const enqueued: string[] = [];
    let page = 0;
    const pages = [['A'], ['A', 'B']];
    const watcher = new AutoPrepareWatcher(
      { enabled: true, pollIntervalMs: 1000 },
      {
        trigger: { poll: async () => (pages[page++] ?? pages[1]).map((id) => ({ id, data: {} })) },
        state,
        enqueue: (event) => {
          enqueued.push(event.id);
          return 0;
        },
        // Re-reviewing is a judgement call, so the watcher never makes it.
        alreadyHandled: (key) => key === 'B',
        log: () => {},
      },
    );

    await watcher.tick();
    await watcher.tick();

    expect(enqueued).toEqual([]);
  });

  it('marks an issue seen even when queueing it throws, so it cannot loop', async () => {
    let page = 0;
    const pages = [['A'], ['A', 'B'], ['A', 'B']];
    let attempts = 0;
    const watcher = new AutoPrepareWatcher(
      { enabled: true, pollIntervalMs: 1000 },
      {
        trigger: { poll: async () => (pages[page++] ?? pages[2]).map((id) => ({ id, data: {} })) },
        state,
        enqueue: () => {
          attempts++;
          throw new Error('queue exploded');
        },
        alreadyHandled: () => false,
        log: () => {},
      },
    );

    await watcher.tick();
    await watcher.tick();
    await watcher.tick();

    // One attempt, not one per poll forever.
    expect(attempts).toBe(1);
  });

  it('does not poll again while a poll is still running', async () => {
    let polls = 0;
    let release: () => void = () => {};
    const watcher = new AutoPrepareWatcher(
      { enabled: true, pollIntervalMs: 1 },
      {
        trigger: {
          poll: async () => {
            polls++;
            await new Promise<void>((r) => (release = r));
            return [];
          },
        },
        state,
        enqueue: () => 0,
        alreadyHandled: () => false,
        log: () => {},
      },
    );

    const first = watcher.tick();
    await watcher.tick();
    expect(polls).toBe(1);

    release();
    await first;
  });

  it('stays quiet when disabled', async () => {
    const { watcher, enqueued } = watcherOver([['A'], ['A', 'B']]);
    const off = new AutoPrepareWatcher({ enabled: false, pollIntervalMs: 1000 }, {
      trigger: { poll: async () => [] },
      state,
      enqueue: () => 0,
      alreadyHandled: () => false,
      log: () => {},
    });

    off.start();
    expect(state.hasAutoPrepareBaseline()).toBe(false);
    off.stop();
    void watcher;
    void enqueued;
  });
});

describe('StateStore — review log', () => {
  it('stamps each review with its place in the order', () => {
    expect(state.lastReviewAt()).toBeNull();
    expect(state.recordReview('2026-08-17T10:00:00.000Z')).toBe(1);
    expect(state.recordReview('2026-08-17T11:00:00.000Z')).toBe(2);
    expect(state.lastReviewAt()).toBe('2026-08-17T11:00:00.000Z');
  });

  it('lets a cleared issue be prepared again', () => {
    state.setAutoPrepareBaseline(['A'], '2026-08-17T10:00:00.000Z');
    state.markAutoPrepareSeen(['B']);
    expect(state.unseenIssueKeys(['A', 'B'])).toEqual([]);

    state.forgetAutoPrepareSeen('B');
    expect(state.unseenIssueKeys(['A', 'B'])).toEqual(['B']);
  });
});
