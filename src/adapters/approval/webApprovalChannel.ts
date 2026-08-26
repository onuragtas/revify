import type { ApprovalChannel, ApprovalRef, ApprovalResult, PendingApproval, TaskResult, TriggerEvent } from '../../core/types.js';
import type { ReviewRecord, ReviewStore } from '../../core/reviewStore.js';
import { progressBus } from '../../core/progressBus.js';

/**
 * Approval channel backed by the web UI: `requestApproval` just records the
 * review as "awaiting_approval" (the UI renders it and shows Approve/Reject
 * buttons); `checkPending` looks for a decision the UI's /approve or
 * /reject endpoint already wrote into the same ReviewStore.
 */
export class WebApprovalChannel implements ApprovalChannel {
  constructor(private readonly reviewStore: ReviewStore) {}

  async requestApproval(event: TriggerEvent, taskResult: TaskResult): Promise<ApprovalRef> {
    this.reviewStore.upsert(event.id, {
      status: 'awaiting_approval',
      review: { title: taskResult.title, markdown: taskResult.markdown },
      projectPaths: (taskResult.meta?.projectPaths as string[] | undefined) ?? [],
      repoChanges: (taskResult.meta?.repoChanges as ReviewRecord['repoChanges']) ?? null,
      // Travels with the review because a fix has to work from the same
      // reading of the ask that produced the findings.
      requirement: taskResult.meta?.requirement as ReviewRecord['requirement'],
    });
    progressBus.log(event.id, 'awaiting your approval in the UI');
    return {};
  }

  async checkPending(pending: PendingApproval[]): Promise<ApprovalResult[]> {
    const results: ApprovalResult[] = [];
    for (const p of pending) {
      const record = this.reviewStore.get(p.id);
      if (record?.status === 'approved') results.push({ id: p.id, decision: 'approved' });
      else if (record?.status === 'rejected')
        results.push({ id: p.id, decision: 'rejected', reason: record.rejectionReason ?? '' });
    }
    return results;
  }
}
