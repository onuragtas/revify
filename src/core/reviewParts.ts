export interface ReviewParts {
  /** The review itself — what a reader (and Jira) should see. */
  body: string;
  /** `[?]` lines: things the reviewer could not verify, phrased as
   * questions a human can answer. */
  openQuestions: string[];
  /** `[note]` lines: which standing project notes were applied and what
   * they suppressed. Internal bookkeeping — it says what the reviewer
   * *didn't* report, which is meaningless to anyone outside the team. */
  appliedNotes: string[];
  /** `[withdrawn]` lines: findings a human disputed that the reviewer then
   * re-checked and dropped. Internal like the notes above — Jira should see
   * the corrected review, not a record of what a draft once claimed. */
  withdrawn: string[];
}

const QUESTION = /^\s*\[\?\]\s*(.+?)\s*$/;
const NOTE = /^\s*\[note\]\s*(.+?)\s*$/i;
const WITHDRAWN = /^\s*\[withdrawn\]\s*(.+?)\s*$/i;

/**
 * Splits a raw review into the part meant for readers and the parts meant
 * for the tooling. Both markers are plain ASCII on purpose: the review can
 * be written in any language, so anything language-specific would stop
 * parsing the moment `review.language` changes.
 *
 * Doing this server-side keeps one implementation — the web UI and the
 * Jira action would otherwise each need their own parser and could drift.
 */
export function splitReview(markdown: string): ReviewParts {
  const openQuestions: string[] = [];
  const appliedNotes: string[] = [];
  const withdrawn: string[] = [];
  const bodyLines: string[] = [];

  for (const line of String(markdown ?? '').split('\n')) {
    const question = line.match(QUESTION);
    if (question) {
      openQuestions.push(question[1]);
      continue;
    }
    const note = line.match(NOTE);
    if (note) {
      appliedNotes.push(note[1]);
      continue;
    }
    const dropped = line.match(WITHDRAWN);
    if (dropped) {
      withdrawn.push(dropped[1]);
      continue;
    }
    bodyLines.push(line);
  }

  return {
    // Extracted lines leave blank gaps behind; collapse runs of 3+ newlines
    // so the body doesn't end up with holes where the markers were.
    body: bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    openQuestions: [...new Set(openQuestions)],
    appliedNotes: [...new Set(appliedNotes)],
    withdrawn: [...new Set(withdrawn)],
  };
}
