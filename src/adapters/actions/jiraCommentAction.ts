import type { Action, TaskResult, TriggerEvent } from '../../core/types.js';
import type { JiraClient } from '../../clients/jiraClient.js';
import { splitReview } from '../../core/reviewParts.js';

export class JiraCommentAction implements Action {
  constructor(private readonly jiraClient: JiraClient) {}

  async execute(event: TriggerEvent, taskResult: TaskResult): Promise<void> {
    const issueKey = event.data.issueKey as string;
    // Applied-note bookkeeping and open questions stay internal — they
    // describe what the reviewer withheld, which is noise on the issue.
    const { body } = splitReview(taskResult.markdown);
    const commentBody = `${taskResult.title}\n\n${body}`;

    // DRY RUN: actual Jira write disabled for now. Uncomment to post for real.
    // await this.jiraClient.addComment(issueKey, commentBody);
    console.log(`[jiraCommentAction] DRY RUN — would post comment to ${issueKey}:\n${commentBody}`);
  }
}
