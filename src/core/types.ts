/**
 * Core pipeline interfaces. Every automation is a wiring of these five
 * stages, chosen by name in config.yaml — swapping the wiring never
 * requires touching pipeline.ts.
 */

export interface TriggerEvent {
  /** Stable id used for dedup in the state store, e.g. a Jira issue key. */
  id: string;
  /** Free-form data the trigger captured (issue key, status, etc). */
  data: Record<string, unknown>;
}

export interface Trigger {
  /** Look for new events since the last poll. Must be idempotent-safe: the
   * pipeline dedupes by TriggerEvent.id via the state store, but a trigger
   * should still avoid returning the same event on every single poll. */
  poll(): Promise<TriggerEvent[]>;
}

export interface ContextCollector {
  /** Gather additional context for an event. Collectors run in the order
   * listed in config, each seeing the context merged by every collector
   * before it — so a later collector (e.g. one that fetches a GitLab MR)
   * can depend on data an earlier one found (e.g. the MR's URL). */
  collect(
    event: TriggerEvent,
    contextSoFar: Record<string, unknown>,
    /** Aborted when a human stops the review. Long operations (clones,
     * network calls) should pass it on so stopping is immediate rather
     * than "after this step finishes". */
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface TaskResult {
  /** Short human-readable title, e.g. shown as the Slack message header. */
  title: string;
  /** Full markdown body — the actual AI output, posted for approval and
   * later written by the Action if approved. */
  markdown: string;
  /** Task-specific extras an approval channel or action may want but that
   * aren't part of the review text itself — e.g. the GitLab project the
   * change belongs to, so the UI can offer repo-scoped notes. */
  meta?: Record<string, unknown>;
}

export interface AiTask {
  run(event: TriggerEvent, context: Record<string, unknown>, signal?: AbortSignal): Promise<TaskResult>;
}

export interface LlmProvider {
  /**
   * Whether this provider can give the model tools that change files on
   * disk. False (or absent) means it can only ever answer in text — which
   * is fine for a review and useless for a fix, so the fix path checks
   * this rather than running for minutes and producing an empty patch.
   */
  readonly canEditFiles?: boolean;

  generate(input: {
    system: string;
    prompt: string;
    /** Absolute path to a checked-out repo the model may read while
     * answering. Providers that can grant file access (e.g. the `claude`
     * CLI) expose read-only tools scoped to this directory; providers that
     * can't simply ignore it. */
    workdir?: string;
    /**
     * Let the model edit files under `workdir`.
     *
     * Only ever true for a throwaway fix workspace — see fixWorkspace.ts
     * for why a fix is never run in the repo cache. Providers that cannot
     * grant write tools must reject the call rather than quietly answer in
     * text, or the caller would take "no changes" for "nothing to fix".
     */
    write?: boolean;
    /** Additional read-only directories (e.g. other services' repos) the
     * model may read to verify cross-service claims. */
    extraDirs?: string[];
    /** Aborted when a human stops the review — the provider must kill the
     * work in flight, not just stop awaiting it. */
    signal?: AbortSignal;
    /** Called as the model works, so the step log can show what it is doing
     * during the minutes it spends reading code instead of going silent. */
    onProgress?: (message: string) => void;
  }): Promise<string>;
}

/** Opaque reference the approval channel uses to find this request again
 * (e.g. a Slack message channel+ts). Stored in the state store as-is. */
export type ApprovalRef = Record<string, unknown>;

export interface PendingApproval {
  id: string;
  event: TriggerEvent;
  taskResult: TaskResult;
  channelRef: ApprovalRef;
  createdAt: string;
}

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalResult {
  id: string;
  decision: ApprovalDecision;
  /** Why it was rejected — surfaced to the action so it can be recorded
   * where the team will actually see it. */
  reason?: string;
}

export interface ApprovalChannel {
  /** Post the task result for human approval. Returns a channel-specific
   * reference the pipeline persists alongside the pending approval. */
  requestApproval(event: TriggerEvent, taskResult: TaskResult): Promise<ApprovalRef>;
  /** Check all currently-pending approvals for a decision. Approvals with
   * no decision yet are simply absent from the returned array. */
  checkPending(pending: PendingApproval[]): Promise<ApprovalResult[]>;
}

export interface Action {
  /** Runs when a review is approved. */
  execute(event: TriggerEvent, taskResult: TaskResult): Promise<void>;
  /** Runs when a review is rejected. Optional: a rejection is a real
   * outcome for some actions (send it back to the developer) and a no-op
   * for others (don't post the comment). `reason` is what the reviewer
   * typed when rejecting. */
  executeRejected?(event: TriggerEvent, taskResult: TaskResult, reason: string): Promise<void>;
}
