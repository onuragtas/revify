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

/**
 * The issue a branch was cut for, if its name says so.
 *
 * `feature/BUY-2397-km-muayene` names a ticket; `main` and
 * `release/2024-01-15` do not. Reviewing a directory is the case that needs
 * this — nothing else says what the change is *for*, and a review that does
 * not know the requirement can only judge the code against itself.
 *
 * Deliberately a guess, and treated as one. What it unlocks is *reading*
 * Jira: the description, the discussion, the acceptance criteria. It never
 * decides where a decision gets written — that follows `issueKey`, which is
 * only ever set by a human naming the issue outright. A wrong guess here
 * costs one failed lookup; a wrong guess there would move somebody else's
 * ticket.
 *
 * Two characters minimum before the hyphen, because Jira project keys are
 * at least that and a single letter would make `v-2` an issue. A date
 * cannot match: a key has to start with a letter.
 */
export function issueKeyFromBranch(branch: string): string | null {
  const match = normalizeIssueKey(branch).match(/(?:^|[^A-Z0-9_])([A-Z][A-Z0-9_]+-\d+)(?![0-9])/);
  return match ? match[1] : null;
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
