import type { StateStore } from './stateStore.js';
import type { Trigger, TriggerEvent } from './types.js';

export interface AutoPrepareOptions {
  /** Off means the tool only ever reviews what a human asked it to. */
  enabled: boolean;
  pollIntervalMs: number;
}

export interface AutoPrepareDeps {
  trigger: Trigger;
  state: StateStore;
  /** Puts an issue in line. Returns its position, purely for logging. */
  enqueue: (event: TriggerEvent) => number;
  /** Whether this issue already has a review worth keeping — a re-review
   * is a human's call, never the watcher's. */
  alreadyHandled: (issueKey: string) => boolean;
  log: (message: string) => void;
}

/**
 * Reviews arrive before anyone asks for them.
 *
 * The rule is deliberately narrow: **only issues that turn up after
 * watching begins**. The first poll records whatever is already in review
 * as the baseline and reviews none of it — otherwise switching this on
 * against a long-standing queue would fire off dozens of reviews at once,
 * which is the opposite of helpful.
 *
 * "New" means an issue key never seen before, not one whose `updated`
 * field moved. Jira bumps `updated` for any edit at all — a comment, a
 * label, a sprint change — so a timestamp comparison would re-review old
 * work every time somebody touched a ticket.
 *
 * Nothing here decides anything. A prepared review waits at
 * `awaiting_approval` exactly like one a human started; approving and
 * rejecting stay entirely manual.
 */
export class AutoPrepareWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly options: AutoPrepareOptions,
    private readonly deps: AutoPrepareDeps,
  ) {}

  start(): void {
    if (!this.options.enabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs);
    // Never keep the process alive on its own account.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for an immediate check after a manual refresh. */
  async tick(): Promise<void> {
    // A slow poll must not overlap with the next tick and enqueue twice.
    if (this.polling) return;
    this.polling = true;
    try {
      await this.check();
    } catch (err) {
      this.deps.log(`auto-prepare poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private async check(): Promise<void> {
    const events = await this.deps.trigger.poll();
    const keys = events.map((e) => e.id);

    if (!this.deps.state.hasAutoPrepareBaseline()) {
      const at = new Date().toISOString();
      this.deps.state.setAutoPrepareBaseline(keys, at);
      this.deps.log(
        `auto-prepare watching from ${at} — ${keys.length} issue(s) already in review, left alone`,
      );
      return;
    }

    const unseen = this.deps.state.unseenIssueKeys(keys);
    if (unseen.length === 0) return;

    // Marked before enqueuing, so a failure to review doesn't turn into a
    // retry loop that re-queues the same issue every poll. A review that
    // needs another go is a human's call, via "Yeniden incele".
    this.deps.state.markAutoPrepareSeen(unseen);

    // Oldest first: `events` comes back in the trigger's own order (the JQL
    // sorts by `updated ASC`), so queueing in that order means the issue
    // that has been waiting longest is reviewed first.
    for (const key of unseen) {
      if (this.deps.alreadyHandled(key)) {
        this.deps.log(`auto-prepare: ${key} already has a review, skipping`);
        continue;
      }
      const event = events.find((e) => e.id === key);
      if (!event) continue;

      const position = this.deps.enqueue(event);
      this.deps.log(
        position === 0
          ? `auto-prepare: ${key} is new — reviewing now`
          : `auto-prepare: ${key} is new — queued, ${position} ahead`,
      );
    }
  }
}
