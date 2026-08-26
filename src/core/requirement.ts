/**
 * What the issue actually asked for, in the form the reviewer read it.
 *
 * Kept on the review record rather than fetched again when it is needed,
 * for one reason that outranks the rest: a fix exists to make a *finding*
 * true, and the finding came out of one particular reading of the
 * requirement. Handing the fixer a newer text than the finding was built on
 * introduces a second interpretation — the finding argues one thing while
 * the fixer reads another. If the ticket has genuinely moved, the honest
 * answer is to review it again, not to slip fresher prose past a stale
 * finding.
 *
 * Two side effects worth having: the fix path needs no Jira call (so it
 * cannot half-fail when a token expires), and the formatting rules below
 * live in one place instead of once per prompt.
 */

export interface RequirementComment {
  /** ISO timestamp; only the date is ever shown. */
  created: string;
  text: string;
}

export interface Requirement {
  /** The description as plain text — Jira's is a nested ADF document. */
  description: string;
  /**
   * The issue's comments, oldest first.
   *
   * Authors are deliberately absent. A review that says "X asked for this"
   * reads as an argument with a colleague rather than an assessment of the
   * code, and it lands on a public issue. Dropping the names here makes
   * that impossible rather than merely forbidden — and a fix built on this
   * text inherits the same guarantee.
   */
  comments: RequirementComment[];
}

/** Long enough for any real specification; a description past this is a
 * pasted log, and carrying it would push the actual ask out of view. */
export const MAX_DESCRIPTION = 8000;
/** Long comments are usually a pasted stack trace or an old review — the
 * ask at the top is what carries the meaning. */
export const MAX_COMMENT = 1500;

const TRUNCATED = '\n[…kısaltıldı]';

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}${TRUNCATED}` : text;
}

/** Jira descriptions are Atlassian Document Format (a nested JSON tree).
 * Walk it for `text` nodes; if it's already a plain string, use it as-is.
 * Empty rather than a placeholder — the caller decides what "nothing" reads
 * like in its own prompt. */
export function extractPlainText(description: unknown): string {
  if (!description) return '';
  if (typeof description === 'string') return description.trim();
  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string') chunks.push(obj.text);
    if (Array.isArray(obj.content)) obj.content.forEach(walk);
  };
  walk(description);
  return chunks.join(' ').trim();
}

/** Builds the record that travels from the review to the fix. Capped here
 * so the store cannot grow without bound on a ticket with a hundred
 * comments. */
export function toRequirement(
  description: unknown,
  comments?: Array<{ created?: string; text?: string }>,
): Requirement {
  return {
    description: cap(extractPlainText(description), MAX_DESCRIPTION),
    comments: (comments ?? [])
      .filter((c) => (c.text ?? '').trim())
      .map((c) => ({ created: String(c.created ?? ''), text: cap(String(c.text).trim(), MAX_COMMENT) })),
  };
}

/** The comment bodies as both prompts render them. The instructions *about*
 * them are not shared: what a reviewer should do with a comment and what a
 * fixer should do with one are different things. */
export function renderComments(comments: RequirementComment[]): string {
  return comments
    .map((c, i) => {
      const when = c.created ? c.created.slice(0, 10) : '';
      return `### Yorum ${i + 1}${when ? ` — ${when}` : ''}\n\n${cap(c.text, MAX_COMMENT)}\n`;
    })
    .join('\n');
}

/** True when there is nothing worth putting in a prompt. */
export function isEmptyRequirement(requirement?: Requirement | null): boolean {
  return !requirement || (!requirement.description.trim() && requirement.comments.length === 0);
}
