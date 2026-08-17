import type { ApprovalChannel, ApprovalRef, ApprovalResult, PendingApproval, TaskResult, TriggerEvent } from '../../core/types.js';

/**
 * Dev/testing stand-in for a real approval channel: prints the review to
 * stdout and auto-approves on the next tick. No human gate — use this only
 * until Slack (or another real approval channel) is wired up. Swapping back
 * is a one-line change in config.yaml (`wiring.approval: slackReaction`).
 */
export class ConsoleApprovalChannel implements ApprovalChannel {
  async requestApproval(event: TriggerEvent, taskResult: TaskResult): Promise<ApprovalRef> {
    console.log('\n=== AI Review (console approval — AUTO-APPROVED, no human gate) ===');
    console.log(`Issue: ${event.data.issueKey ?? event.id}`);
    console.log(taskResult.title);
    console.log('---');
    console.log(taskResult.markdown);
    console.log('=====================================================================\n');
    return {};
  }

  async checkPending(pending: PendingApproval[]): Promise<ApprovalResult[]> {
    return pending.map((p) => ({ id: p.id, decision: 'approved' }));
  }
}
