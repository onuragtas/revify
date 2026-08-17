import type { Trigger, TriggerEvent } from '../../core/types.js';
import type { JiraClient } from '../../clients/jiraClient.js';

export class JiraStatusPollTrigger implements Trigger {
  constructor(
    private readonly jiraClient: JiraClient,
    private readonly jql: string,
  ) {}

  async poll(): Promise<TriggerEvent[]> {
    const issues = await this.jiraClient.searchIssues(this.jql);
    return issues.map((issue) => ({
      id: issue.key,
      data: {
        issueKey: issue.key,
        issueId: issue.id,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName ?? null,
        assigneeAccountId: issue.fields.assignee?.accountId ?? null,
        updated: issue.fields.updated ?? null,
      },
    }));
  }
}
