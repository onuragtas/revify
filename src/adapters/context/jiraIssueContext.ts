import type { ContextCollector, TriggerEvent } from '../../core/types.js';
import type { JiraClient } from '../../clients/jiraClient.js';
import { progressBus } from '../../core/progressBus.js';
import { fetchAttachments, type AttachmentPlan } from '../../core/attachmentCache.js';
import { join } from 'node:path';

/** Fetches the full Jira issue and, from its "development panel" data, any
 * GitLab branch(es) linked to it. Downstream collectors (e.g.
 * gitlabBranchDiffContext) read `linkedBranches` from the merged context. */
export class JiraIssueContext implements ContextCollector {
  constructor(
    private readonly jiraClient: JiraClient,
    /** Where downloaded attachments land. Absent means "do not collect
     * them", which is what the headless and test paths want. */
    private readonly attachmentDir?: string,
  ) {}

  async collect(event: TriggerEvent): Promise<Record<string, unknown>> {
    const issueKey = event.data.issueKey as string | undefined;
    const issueId = event.data.issueId as string;
    // A review of a local directory has no issue behind it. Every
    // collector sees every event, so recognising one's own is the price of
    // a single wiring — and a single wiring is what keeps the two entry
    // points from drifting apart.
    if (!issueKey) return {};

    const [issue, linkedBranches, comments, related, attachments] = await Promise.all([
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
      // A spec or an integration PDF is often where the actual requirement
      // lives. Same rule as the rest: background, so a failure here costs
      // the attachments and not the review.
      this.attachmentDir
        ? this.jiraClient.getAttachments(issueKey).catch((err) => {
            progressBus.log(event.id, `could not list attachments (${err instanceof Error ? err.message : String(err)})`);
            return [];
          })
        : Promise.resolve([]),
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

    /*
     * Attachments from this issue and from the ones linked to it: a flow
     * described in the parent's PDF is as much a requirement as one in
     * this ticket's own.
     */
    let attachmentPlan: AttachmentPlan = { fetched: [], skipped: [] };
    if (this.attachmentDir && (attachments.length || related.length)) {
      const all = [...attachments];
      for (const neighbour of related) {
        try {
          all.push(...(await this.jiraClient.getAttachments(neighbour.key)));
        } catch {
          // A neighbour we cannot read is not worth reporting twice; the
          // relation itself was already logged above.
        }
      }

      attachmentPlan = await fetchAttachments(
        all,
        join(this.attachmentDir, issueKey),
        (url) => this.jiraClient.downloadAttachment(url),
        (message) => progressBus.log(event.id, message),
      );

      if (attachmentPlan.fetched.length) {
        progressBus.log(
          event.id,
          `read ${attachmentPlan.fetched.length} attachment(s): ${attachmentPlan.fetched.map((f) => f.filename).join(', ')}`,
        );
      }
      if (attachmentPlan.skipped.length) {
        progressBus.log(event.id, `skipped ${attachmentPlan.skipped.length} attachment(s)`);
      }
    }

    return {
      jiraIssue: issue,
      linkedBranches,
      jiraComments: comments,
      relatedIssues: related,
      attachments: attachmentPlan,
      attachmentDir: attachmentPlan.fetched.length ? join(this.attachmentDir!, issueKey) : undefined,
    };
  }
}
