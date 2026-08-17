import type { JiraIssueSummary } from '../clients/jiraClient.js';
import type { TriggerEvent } from './types.js';

/**
 * One issue, as the pipeline sees it.
 *
 * The trigger turns a JQL result into events, and reviewing by key turns a
 * single issue into the same thing. The mapping lives here so there is one
 * of it: two copies drift, and the copy that drifts is the one nobody runs
 * — a field added for the queue and missing from the manual path is a bug
 * that only appears when someone types a key.
 */
export function toTriggerEvent(issue: JiraIssueSummary): TriggerEvent {
  return {
    id: issue.key,
    data: {
      issueKey: issue.key,
      issueId: issue.id,
      summary: issue.fields.summary,
      status: issue.fields.status?.name ?? null,
      assignee: issue.fields.assignee?.displayName ?? null,
      assigneeAccountId: issue.fields.assignee?.accountId ?? null,
      updated: issue.fields.updated ?? null,
    },
  };
}

/** `buy-2455` and ` BUY-2455 ` are the same issue as far as anyone typing
 * is concerned. Jira disagrees, so this settles it before the request. */
export function normalizeIssueKey(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Jira's own shape: a project key, a hyphen, a number. Checked here so a
 * typo produces a sentence rather than a 404 from an API call that never
 * had a chance. */
export function isIssueKey(raw: string): boolean {
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(normalizeIssueKey(raw));
}

export class UnknownIssueError extends Error {
  constructor(readonly issueKey: string) {
    // Jira answers 404 both for an issue that does not exist and for one
    // you cannot see. Saying only "not found" sends someone looking for a
    // typo when the real answer is a permission they do not have.
    super(`${issueKey} bulunamadı — anahtar yanlış olabilir ya da bu issue'ya erişimin olmayabilir.`);
    this.name = 'UnknownIssueError';
  }
}
