import type { Action, TaskResult, TriggerEvent } from '../../core/types.js';
import type { JiraClient } from '../../clients/jiraClient.js';
import { splitReview } from '../../core/reviewParts.js';
import { progressBus } from '../../core/progressBus.js';

export interface JiraOutcomeConfig {
  /** When false, every write is logged instead of sent. Jira changes are
   * visible to the whole team and hard to undo, so this stays off until
   * someone deliberately turns it on. */
  applyChanges: boolean;
  approveStatus: string;
  rejectStatus: string;
}

/**
 * Turns a review decision into the Jira changes the team expects:
 *
 * - **Approved** — post the review, move the issue on (Ready for Stage),
 *   and hand it back to whoever had it before the review.
 * - **Rejected** — post the review plus the reviewer's reason, send it
 *   back to In Development, and return it to the same person.
 *
 * The assignee is the one captured when the review started rather than
 * whoever holds the issue now: a review can sit for a while, and the point
 * is to return it to the developer whose work it is.
 */
export class JiraReviewOutcomeAction implements Action {
  constructor(
    private readonly jiraClient: JiraClient,
    private readonly config: JiraOutcomeConfig,
  ) {}

  async execute(event: TriggerEvent, taskResult: TaskResult): Promise<void> {
    const { body } = splitReview(taskResult.markdown);
    await this.applyOutcome(event, `${taskResult.title}\n\n${body}`, this.config.approveStatus);
  }

  async executeRejected(event: TriggerEvent, taskResult: TaskResult, reason: string): Promise<void> {
    const { body } = splitReview(taskResult.markdown);
    // With no reason, the findings below stand on their own — a
    // "(gerekçe belirtilmedi)" placeholder would just be noise on the issue.
    const note = reason.trim() ? `**Review reddedildi.**\n\n${reason.trim()}` : '**Review reddedildi.**';
    const comment = `${taskResult.title}\n\n${note}\n\n---\n\n${body}`;
    await this.applyOutcome(event, comment, this.config.rejectStatus);
  }

  /**
   * The developer the issue should go back to.
   *
   * Not the current assignee: this tool only ever meets an issue that is
   * already in review, and a team that hands tickets to a reviewer has
   * reassigned it by then. Sending it "back" to that person changes
   * nothing — which is exactly how this failed before: Jira recorded no
   * assignee change at all, because we asked for the one already set.
   *
   * The changelog knows who had it before the handover, so that is what we
   * ask. If it cannot tell (an issue created straight into review, or a
   * changelog we could not read), we leave the assignee alone rather than
   * moving the ticket to a guess.
   */
  private async findDeveloper(
    event: TriggerEvent,
    issueKey: string,
  ): Promise<{ accountId: string; displayName: string } | null> {
    // The status the issue was in when the pipeline picked it up — i.e. the
    // review status, whatever this workflow calls it.
    const reviewStatus = (event.data.status as string | undefined) ?? '';
    if (!reviewStatus) return null;

    try {
      const developer = await this.jiraClient.getPreReviewAssignee(issueKey, reviewStatus);
      if (developer) {
        progressBus.log(event.id, `developer before review: ${developer.displayName}`);
      } else {
        progressBus.log(event.id, `no pre-"${reviewStatus}" assignee in the changelog`);
      }
      return developer;
    } catch (err) {
      // A changelog we cannot read is not a reason to abandon the comment
      // and the transition, which are the parts that matter most.
      progressBus.log(event.id, `could not read changelog (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  }

  private async applyOutcome(event: TriggerEvent, comment: string, status: string): Promise<void> {
    const issueKey = event.data.issueKey as string | undefined;

    /*
     * A local review has nowhere to post.
     *
     * Reviewing a directory produces a report, not a workflow transition:
     * there is no issue to comment on, no status to move, nobody to
     * reassign. Approving one is a decision recorded here and nothing
     * more, which is the honest meaning of the button in that context.
     */
    if (!issueKey) {
      progressBus.log(event.id, `yerel review — karar kaydedildi, Jira'ya bir şey yazılmadı`);
      return;
    }

    const developer = await this.findDeveloper(event, issueKey);
    const assigneeAccountId = developer?.accountId ?? null;
    const assigneeName = developer?.displayName ?? '(unknown)';

    if (!this.config.applyChanges) {
      progressBus.log(
        event.id,
        `DRY RUN — would comment on ${issueKey}, set status "${status}", assign to ${assigneeName}`,
      );
      console.log(`[jira] DRY RUN comment for ${issueKey}:\n${comment}`);
      return;
    }

    // Comment first: if a later step fails, the review is still recorded on
    // the issue rather than lost.
    await this.jiraClient.addComment(issueKey, comment);
    progressBus.log(event.id, `commented on ${issueKey}`);

    await this.jiraClient.transitionTo(issueKey, status);
    progressBus.log(event.id, `status -> ${status}`);

    if (assigneeAccountId) {
      await this.jiraClient.assign(issueKey, assigneeAccountId);
      progressBus.log(event.id, `assigned to ${assigneeName}`);
    } else {
      progressBus.log(event.id, 'no pre-review assignee recorded, leaving assignee unchanged');
    }
  }
}
