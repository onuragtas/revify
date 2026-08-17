import type { AppConfig } from '../config/loadConfig.js';
import type { Wired } from './registry.js';
import type { StateStore } from './stateStore.js';
import { progressBus } from './progressBus.js';
import type { ApprovalDecision, PendingApproval, TriggerEvent } from './types.js';

/** What actually happened to one decision. `applied` false means the
 * outcome did *not* reach its destination — the caller must not report
 * success. */
export interface ApprovalOutcome {
  id: string;
  decision: ApprovalDecision;
  applied: boolean;
  error?: string;
}

/**
 * Runs the pipeline in two ways:
 *  - `start()`: the original headless/automatic mode — two setInterval
 *    loops (trigger poll + approval poll), no human in the loop except
 *    whatever ApprovalChannel is wired.
 *  - `runOne()` / `resolveApprovals()`: on-demand, single-issue calls the
 *    web UI drives directly — nothing runs unless something calls these.
 * Both paths share the same `processEvent`/`approvalTick` logic.
 */
export class Pipeline {
  /** Shared, not owned — see Wired.stateStore for why that matters. */
  private readonly stateStore: StateStore;

  constructor(
    private readonly config: AppConfig,
    private readonly wired: Wired,
  ) {
    this.stateStore = wired.stateStore;
  }

  start(): void {
    void this.triggerTick();
    setInterval(() => void this.triggerTick(), this.config.pollIntervalMs);

    void this.approvalTick();
    setInterval(() => void this.approvalTick(), this.config.approvalPollIntervalMs);
  }

  /** Run the full context -> AI task -> approval-request pipeline for one
   * event on demand (e.g. a user-selected issue in the web UI). Bypasses
   * the automatic loop's "already processed" dedup check on purpose —
   * a manual re-review should always run. Errors propagate to the caller. */
  async runOne(event: TriggerEvent, signal?: AbortSignal): Promise<void> {
    await this.processEvent(event, signal);
  }

  /** Drops an issue from the dedup list and any pending approval, so a
   * cleared task behaves exactly like one that was never run. */
  forget(issueId: string): void {
    this.stateStore.removePendingApproval(issueId);
    this.stateStore.forgetProcessed(issueId);
  }

  /**
   * Resolve any approvals that already have a decision, and report what was
   * actually done.
   *
   * Callers need the outcome, not a void: the UI used to assume that
   * returning meant the decision had been applied, so an issue with no
   * pending entry produced a cheerful "posted to Jira" while nothing was
   * written at all. Now silence is distinguishable from success.
   */
  async resolveApprovals(): Promise<ApprovalOutcome[]> {
    return this.approvalTick();
  }

  private async triggerTick(): Promise<void> {
    console.log('[trigger] polling...');
    let events;
    try {
      events = await this.wired.trigger.poll();
    } catch (err) {
      console.error('[trigger] poll failed:', err);
      return;
    }

    console.log(`[trigger] poll found ${events.length} issue(s) matching JQL`);

    for (const event of events) {
      if (this.stateStore.hasProcessed(event.id)) {
        console.log(`[trigger] ${event.id} already processed, skipping`);
        continue;
      }
      try {
        await this.processEvent(event);
      } catch (err) {
        console.error(`[trigger] failed to process ${event.id}:`, err);
      }
    }
  }

  private async processEvent(event: TriggerEvent, signal?: AbortSignal): Promise<void> {
    progressBus.log(event.id, `processing (${event.data.summary ?? 'no summary'})`);

    // Checked between every step as well as inside them: a collector that
    // ignores the signal still can't advance the pipeline past this point.
    signal?.throwIfAborted();

    let context: Record<string, unknown> = {};
    for (const collector of this.wired.contextCollectors) {
      signal?.throwIfAborted();
      const name = collector.constructor.name;
      progressBus.log(event.id, `${name} running...`);
      const partial = await collector.collect(event, context, signal);
      progressBus.log(event.id, `${name} collected: ${Object.keys(partial).join(', ') || '(nothing)'}`);
      context = { ...context, ...partial };
    }

    signal?.throwIfAborted();
    progressBus.log(event.id, 'running AI review...');
    const taskResult = await this.wired.task.run(event, context, signal);
    progressBus.log(event.id, `review generated (${taskResult.markdown.length} chars)`);

    // A review that was stopped must not reach the approval queue — that
    // would put a half-finished answer in front of a human as if it were done.
    signal?.throwIfAborted();
    progressBus.log(event.id, 'requesting approval...');
    const channelRef = await this.wired.approval.requestApproval(event, taskResult);

    const pending: PendingApproval = {
      id: event.id,
      event,
      taskResult,
      channelRef,
      createdAt: new Date().toISOString(),
    };
    this.stateStore.addPendingApproval(pending);
    this.stateStore.markProcessed(event.id);
    progressBus.log(event.id, 'queued for approval');
  }

  private async approvalTick(): Promise<ApprovalOutcome[]> {
    const pending = this.stateStore.listPendingApprovals();
    if (pending.length === 0) return [];

    console.log(`[approval] checking ${pending.length} pending approval(s)...`);
    let results;
    try {
      results = await this.wired.approval.checkPending(pending);
    } catch (err) {
      console.error('[approval] check failed:', err);
      return [];
    }

    if (results.length === 0) {
      console.log('[approval] no decisions yet');
      return [];
    }

    const outcomes: ApprovalOutcome[] = [];
    for (const result of results) {
      const item = pending.find((p) => p.id === result.id);
      if (!item) continue;

      // What the human saw is what gets posted. The pending entry carries a
      // snapshot from when the review finished; if the record has moved on
      // since, that snapshot is not the text anyone approved.
      const current = this.wired.reviewStore.get(item.id)?.review;
      const taskResult = current
        ? { ...item.taskResult, title: current.title, markdown: current.markdown }
        : item.taskResult;

      try {
        if (result.decision === 'approved') {
          progressBus.log(item.id, 'approved -> applying outcome...');
          await this.wired.action.execute(item.event, taskResult);
        } else if (this.wired.action.executeRejected) {
          progressBus.log(item.id, 'rejected -> applying outcome...');
          await this.wired.action.executeRejected(item.event, taskResult, result.reason ?? '');
        } else {
          progressBus.log(item.id, 'rejected -> action has no rejection path, skipped');
          outcomes.push({ id: item.id, decision: result.decision, applied: false, error: 'action has no rejection path' });
          continue;
        }
        progressBus.log(item.id, 'done');
        outcomes.push({ id: item.id, decision: result.decision, applied: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[approval] action failed for ${item.id}:`, err);
        progressBus.log(item.id, `outcome FAILED: ${message}`);
        // Left pending on purpose so it can be retried rather than lost.
        outcomes.push({ id: item.id, decision: result.decision, applied: false, error: message });
        continue;
      }
      this.stateStore.removePendingApproval(item.id);
    }
    return outcomes;
  }

  /**
   * Drops pending approvals whose review record no longer backs them.
   *
   * These accumulate whenever a review is cleared, cancelled, or lost to a
   * restart, and each one is a loaded gun: the entry still carries the old
   * review text, so a later decision would post a review nobody is looking
   * at. Called at startup.
   */
  pruneOrphanedApprovals(): string[] {
    const dropped: string[] = [];
    for (const pending of [...this.stateStore.listPendingApprovals()]) {
      const record = this.wired.reviewStore.get(pending.id);
      if (record?.status === 'awaiting_approval' && record.review) continue;
      this.stateStore.removePendingApproval(pending.id);
      dropped.push(pending.id);
    }
    return dropped;
  }
}
