import type { TriggerEvent } from './types.js';

export type QueueRunner = (event: TriggerEvent, signal: AbortSignal) => Promise<void>;

/** Called whenever an issue's place in line changes. `position` is 0 while
 * it is the one running, 1 for next up, and so on. */
export type QueueObserver = (issueKey: string, position: number) => void;

/**
 * Runs reviews strictly one at a time.
 *
 * This is not about pacing the machine — it is a correctness requirement.
 * Every review shares one repo cache, and preparing a review *mutates* it:
 * the repos a change touches are checked out at that change's branch, and
 * every other repo is forced back to its default branch. Two reviews at
 * once means the second one's checkouts move the ground under the first,
 * which would then be reading one branch's code while reporting on
 * another's. Serializing is what makes "the model read the real code" true.
 *
 * A second review can still be *requested* at any time; it just waits, and
 * the caller learns where in line it landed.
 */
export class ReviewQueue {
  private readonly waiting: TriggerEvent[] = [];
  private active: string | null = null;
  /** Aborts the run currently holding the slot. */
  private activeAbort: AbortController | null = null;

  constructor(
    private readonly run: QueueRunner,
    private readonly observe: QueueObserver = () => {},
  ) {}

  /** Adds an issue to the line and returns its position (0 = starting now).
   * Re-queueing something already in line refreshes its event without
   * moving it, so a double click doesn't cost it its place. */
  enqueue(event: TriggerEvent): number {
    if (this.active === event.id) return 0;

    const queued = this.waiting.findIndex((e) => e.id === event.id);
    if (queued >= 0) {
      this.waiting[queued] = event;
      return queued + 1;
    }

    this.waiting.push(event);
    // Computed before pumping, which may start this very item.
    const position = this.active ? this.waiting.length : 0;
    // Announced here rather than left to pump(): pump() returns immediately
    // while another review holds the slot, so nothing would ever tell this
    // one it is waiting, and it would sit looking untouched.
    if (position > 0) this.observe(event.id, position);
    void this.pump();
    return position;
  }

  /** 0 while running, 1+ while waiting, null when not in the queue. */
  positionOf(issueKey: string): number | null {
    if (this.active === issueKey) return 0;
    const index = this.waiting.findIndex((e) => e.id === issueKey);
    return index >= 0 ? index + 1 : null;
  }

  /**
   * Stops a review, whether it is waiting or already running.
   *
   * A waiting one just leaves the line. A running one is aborted through
   * its signal, which is passed all the way down to the `claude` process
   * and the git clones — without that, "stop" would only stop *waiting*
   * for work that carries on burning subscription usage and CPU.
   *
   * Returns true if there was something to stop.
   */
  cancel(issueKey: string): boolean {
    if (this.active === issueKey) {
      this.activeAbort?.abort();
      return true;
    }
    const index = this.waiting.findIndex((e) => e.id === issueKey);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    this.announce();
    return true;
  }

  /** Aborts the running review and empties the line. Used on shutdown:
   * the review process is detached, so without this it would outlive the
   * server that started it and keep working for nobody. */
  stopAll(): void {
    this.waiting.length = 0;
    this.activeAbort?.abort();
  }

  /** True while this issue is the one holding the slot. */
  isRunning(issueKey: string): boolean {
    return this.active === issueKey;
  }

  private async pump(): Promise<void> {
    if (this.active) return;

    const next = this.waiting.shift();
    if (!next) return;

    this.active = next.id;
    this.activeAbort = new AbortController();
    this.announce();
    try {
      await this.run(next, this.activeAbort.signal);
    } catch {
      // The runner records its own failures; the queue's only job here is
      // to keep going rather than stall the rest of the line.
    } finally {
      this.active = null;
      this.activeAbort = null;
      // The next review starts even if this one was stopped — a cancelled
      // run must not take the rest of the line down with it.
      void this.pump();
    }
  }

  private announce(): void {
    if (this.active) this.observe(this.active, 0);
    this.waiting.forEach((event, index) => this.observe(event.id, index + 1));
  }
}
