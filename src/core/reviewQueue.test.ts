import { describe, expect, it, vi } from 'vitest';
import { ReviewQueue } from './reviewQueue.js';
import type { TriggerEvent } from './types.js';

const ev = (id: string): TriggerEvent => ({ id, data: {} });

/** A runner whose completion the test controls. */
function deferredRunner() {
  const started: string[] = [];
  const finish: Record<string, () => void> = {};
  const signals: Record<string, AbortSignal> = {};
  const run = (event: TriggerEvent, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      started.push(event.id);
      signals[event.id] = signal;
      finish[event.id] = resolve;
      // Real runners unwind on abort; the queue must cope with that.
      signal.addEventListener('abort', () => reject(new Error('durduruldu')));
    });
  return { run, started, finish, signals };
}

describe('ReviewQueue', () => {
  it('runs one review at a time and starts the next when it finishes', async () => {
    const { run, started, finish } = deferredRunner();
    const queue = new ReviewQueue(run);

    expect(queue.enqueue(ev('A'))).toBe(0);
    expect(queue.enqueue(ev('B'))).toBe(1);
    expect(queue.enqueue(ev('C'))).toBe(2);

    // The whole point: B and C must not touch the repo cache while A holds it.
    expect(started).toEqual(['A']);

    finish.A();
    await vi.waitFor(() => expect(started).toEqual(['A', 'B']));

    finish.B();
    await vi.waitFor(() => expect(started).toEqual(['A', 'B', 'C']));
  });

  it('keeps the line moving when a review fails', async () => {
    const started: string[] = [];
    const queue = new ReviewQueue(async (event) => {
      started.push(event.id);
      if (event.id === 'A') throw new Error('review blew up');
    });

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));

    await vi.waitFor(() => expect(started).toEqual(['A', 'B']));
  });

  it('does not let a re-request lose its place in line', () => {
    const { run } = deferredRunner();
    const queue = new ReviewQueue(run);

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));
    queue.enqueue(ev('C'));

    expect(queue.enqueue(ev('B'))).toBe(1);
    expect(queue.positionOf('C')).toBe(2);
  });

  it('reports the running review as position 0, not as queued', () => {
    const { run } = deferredRunner();
    const queue = new ReviewQueue(run);

    queue.enqueue(ev('A'));
    expect(queue.positionOf('A')).toBe(0);
    expect(queue.enqueue(ev('A'))).toBe(0);
    expect(queue.positionOf('nobody')).toBeNull();
  });

  it('cancels a waiting review and closes the gap behind it', () => {
    const { run } = deferredRunner();
    const queue = new ReviewQueue(run);

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));
    queue.enqueue(ev('C'));

    expect(queue.cancel('B')).toBe(true);
    expect(queue.positionOf('C')).toBe(1);
    // Cancelling the running one is a different path — it aborts rather
    // than leaves the line. Covered in "ReviewQueue — stopping" below.
    expect(queue.cancel('A')).toBe(true);
  });

  it('tells a review it is waiting the moment it is queued', () => {
    const { run } = deferredRunner();
    const seen: Array<[string, number]> = [];
    const queue = new ReviewQueue(run, (key, position) => seen.push([key, position]));

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));

    // Without this the UI has nothing to show: B's record would still say
    // whatever it said before, which reads as "nothing happened".
    expect(seen).toContainEqual(['B', 1]);
  });

  it('tells the observer each issue its new position', async () => {
    const { run, finish } = deferredRunner();
    const seen: Array<[string, number]> = [];
    const queue = new ReviewQueue(run, (key, position) => seen.push([key, position]));

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));
    expect(seen).toContainEqual(['A', 0]);

    finish.A();
    // B is told it is running now, rather than being left showing "queued".
    await vi.waitFor(() => expect(seen).toContainEqual(['B', 0]));
  });
});

describe('ReviewQueue — stopping', () => {
  it('aborts the running review through its signal', async () => {
    const { run, signals } = deferredRunner();
    const queue = new ReviewQueue(run);

    queue.enqueue(ev('A'));
    expect(signals.A.aborted).toBe(false);

    expect(queue.cancel('A')).toBe(true);
    // Without a live signal reaching the runner, "stop" would only stop
    // waiting — the claude process and clones would carry on.
    expect(signals.A.aborted).toBe(true);
  });

  it('starts the next review after one is stopped', async () => {
    const { run, started } = deferredRunner();
    const queue = new ReviewQueue(run);

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));
    queue.cancel('A');

    // A cancelled run must not take the rest of the line down with it.
    await vi.waitFor(() => expect(started).toEqual(['A', 'B']));
  });

  it('reports whether an issue is the one currently running', () => {
    const { run } = deferredRunner();
    const queue = new ReviewQueue(run);

    queue.enqueue(ev('A'));
    queue.enqueue(ev('B'));

    expect(queue.isRunning('A')).toBe(true);
    expect(queue.isRunning('B')).toBe(false);
  });

  it('returns false when there is nothing to stop', () => {
    const { run } = deferredRunner();
    const queue = new ReviewQueue(run);
    queue.enqueue(ev('A'));

    expect(queue.cancel('never-queued')).toBe(false);
  });
});
