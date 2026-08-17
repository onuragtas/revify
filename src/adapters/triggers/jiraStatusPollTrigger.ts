import type { Trigger, TriggerEvent } from '../../core/types.js';
import type { JiraClient } from '../../clients/jiraClient.js';
import { toTriggerEvent } from '../../core/issueEvent.js';

export class JiraStatusPollTrigger implements Trigger {
  constructor(
    private readonly jiraClient: JiraClient,
    private readonly jql: string,
  ) {}

  async poll(): Promise<TriggerEvent[]> {
    // An empty JQL means no queue has been configured. Asking Jira an
    // empty question earns a "your query is too broad" every interval and
    // says nothing about the real problem.
    if (!this.jql.trim()) return [];

    const issues = await this.jiraClient.searchIssues(this.jql);
    // Shared with the review-by-key path — see toTriggerEvent.
    return issues.map(toTriggerEvent);
  }
}
