import type { ContextCollector, TriggerEvent } from '../../core/types.js';
import type { JiraClient } from '../../clients/jiraClient.js';
import { progressBus } from '../../core/progressBus.js';

/** Fetches the full Jira issue and, from its "development panel" data, any
 * GitLab branch(es) linked to it. Downstream collectors (e.g.
 * gitlabBranchDiffContext) read `linkedBranches` from the merged context. */
export class JiraIssueContext implements ContextCollector {
  constructor(private readonly jiraClient: JiraClient) {}

  async collect(event: TriggerEvent): Promise<Record<string, unknown>> {
    const issueKey = event.data.issueKey as string;
    const issueId = event.data.issueId as string;

    const [issue, linkedBranches, comments, related] = await Promise.all([
      this.jiraClient.getIssue(issueKey),
      this.jiraClient.getLinkedBranches(issueId),
      // The discussion is context, not a requirement: a ticket with no
      // comments must still review fine, so a failure here is logged and
      // the run continues without them.
      this.jiraClient.getComments(issueKey).catch((err) => {
        progressBus.log(event.id, `could not read comments (${err instanceof Error ? err.message : String(err)})`);
        return [];
      }),
      // Same deal: neighbours are background, so a ticket with none — or a
      // link we cannot read — must not stop the review.
      this.jiraClient.getRelatedIssues(issueKey).catch((err) => {
        progressBus.log(event.id, `could not read related issues (${err instanceof Error ? err.message : String(err)})`);
        return [];
      }),
    ]);

    if (comments.length) {
      progressBus.log(event.id, `read ${comments.length} Jira comment(s)`);
    }
    if (related.length) {
      progressBus.log(event.id, `related issues: ${related.map((r) => `${r.key} (${r.relation})`).join(', ')}`);
    }

    if (linkedBranches.length === 0) {
      progressBus.log(event.id, 'no linked GitLab branch found in dev-status');
    } else {
      progressBus.log(event.id, `found ${linkedBranches.length} linked branch(es): ${linkedBranches.map((b) => b.name).join(', ')}`);
    }

    return {
      jiraIssue: issue,
      linkedBranches,
      jiraComments: comments,
      relatedIssues: related,
    };
  }
}
