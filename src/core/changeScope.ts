/**
 * Narrowing a branch diff down to the work the ticket is actually about.
 *
 * A branch that was cut from another feature branch, or that has been open
 * long enough to collect somebody else's commit, carries changes the ticket
 * never asked for. `git diff base...branch` flattens all of it into one
 * blob, and everything downstream treats that blob as "the change": the
 * prompt shows it, and the deep scan slices it per file and reads each
 * slice *closely*. So a file that belongs to another ticket does not merely
 * appear — it gets its own pass whose entire purpose is to find defects in
 * it, and the developer gets handed findings about code they never wrote.
 *
 * Telling the model to ignore them does not hold; that is what the prompt
 * used to do. What holds is not sending them. A file the review never sees
 * cannot become a finding.
 *
 * The judgement is deliberately one-sided: a commit is excluded only when
 * it *proves* it belongs elsewhere. Dropping a file wrongly costs coverage
 * silently, which is worse than the problem being fixed, so anything
 * ambiguous stays in.
 */

import { splitFindings, type Finding } from './findings.js';

export interface ScopeCommit {
  sha: string;
  title: string;
  author: string;
  date: string;
}

/**
 * Issue keys in a title that share this issue's project prefix.
 *
 * Scoped to the prefix on purpose. A bare `[A-Z]+-\d+` also matches `UTF-8`
 * and `SHA-256`, and a commit titled "fix UTF-8 encoding" would then be
 * read as another ticket's work and have its files dropped — a silent hole
 * in the review, caused by a commit message mentioning a character set.
 */
export function issueKeysIn(title: string, projectPrefix: string): string[] {
  if (!projectPrefix) return [];
  const pattern = new RegExp(`\\b${projectPrefix}-\\d+\\b`, 'gi');
  return (title.match(pattern) ?? []).map((k) => k.toUpperCase());
}

/** `BUY-2443` -> `BUY`. */
export function projectPrefixOf(issueKey: string): string {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(issueKey.trim());
  return match ? match[1].toUpperCase() : '';
}

/**
 * Whether a commit provably belongs to a different ticket.
 *
 * True only when the title names sibling tickets and none of them is this
 * one. A commit that names no ticket at all is *not* foreign: developers
 * write "fix null check" on their own work constantly, and treating that as
 * somebody else's would empty out the review.
 */
export function isForeignCommit(commit: ScopeCommit, issueKey: string): boolean {
  const prefix = projectPrefixOf(issueKey);
  if (!prefix) return false;
  const named = issueKeysIn(commit.title, prefix);
  if (!named.length) return false;
  return !named.includes(issueKey.trim().toUpperCase());
}

export function splitCommitsByOwnership(
  commits: ScopeCommit[] | undefined,
  issueKey: string,
): { own: ScopeCommit[]; foreign: ScopeCommit[] } {
  const own: ScopeCommit[] = [];
  const foreign: ScopeCommit[] = [];
  for (const commit of commits ?? []) {
    (isForeignCommit(commit, issueKey) ? foreign : own).push(commit);
  }
  return { own, foreign };
}

/**
 * Drops the files only the foreign commits touched.
 *
 * A file both sides touched stays whole. Its hunks are entangled — the
 * ticket's work sits in the same file, often the same function — and a
 * half-shown file is worse than an honestly whole one: the model would
 * judge what is left as if it were the entire change.
 */
export function dropForeignOnlyFiles(
  files: Array<{ path: string; diff: string }>,
  ownPaths: Set<string>,
  foreignPaths: Set<string>,
): { files: Array<{ path: string; diff: string }>; dropped: string[] } {
  const dropped: string[] = [];
  const kept = files.filter((file) => {
    const foreignOnly = foreignPaths.has(file.path) && !ownPaths.has(file.path);
    if (foreignOnly) dropped.push(file.path);
    return !foreignOnly;
  });
  return { files: kept, dropped };
}

/** The one place the per-file diff blob is assembled, so the filtered diff
 * is byte-identical in shape to the unfiltered one every other part of the
 * system already parses. */
export function joinFileDiffs(files: Array<{ path: string; diff: string }>): string {
  return files.map((f) => `--- ${f.path} ---\n${f.diff}`).join('\n\n');
}

/*
 * The same narrowing, one level up: the findings themselves.
 *
 * Filtering the diff stops a review being *given* another ticket's code. It
 * does not stop a review reporting the code it read on the way — and with a
 * deep scan that is the larger problem, because the per-pass limits are
 * per-pass. "Minor findings: three at most" is three per slice, so eleven
 * slices carry a budget of thirty-three, and blocking and major have no
 * limit at all by design. Measured across real reviews: a single pass
 * returns four or five findings, an eleven-slice run returned fifty-seven.
 *
 * The rule the prompt already states is that a finding must be caused by
 * the change — either it is on a line the diff wrote, or the diff broke
 * something elsewhere. This enforces that instead of asking for it: a
 * finding that points at a file outside the diff has to name something
 * inside the diff somewhere in its body, which is exactly what the prompt
 * requires it to open with. One that names nothing is a finding about code
 * the branch never touched.
 *
 * Requirement and flow findings are protected, and deliberately: the prompt
 * tells the reviewer to put a flow — not a file — where `file:line` goes
 * when the defect is "the issue is not implemented". Those name no file at
 * all, they are the most valuable findings a review produces, and a filter
 * that reads "no file cited" as "out of scope" would delete exactly them.
 */

/** A path-ish token: `src/a.php`, `Payment.java`, `config/app.yaml:12`. */
const NAMES_A_FILE = /[A-Za-z0-9_@./+-]*[A-Za-z0-9_]\.[A-Za-z0-9]{1,10}\b/;

/**
 * Every way the change can be referred to: the full path as the diff lists
 * it, and the bare file name, which is how a finding usually cites it.
 */
function changedNames(changedPaths: string[]): Set<string> {
  const names = new Set<string>();
  for (const path of changedPaths) {
    const lower = path.toLowerCase().trim();
    if (!lower) continue;
    names.add(lower);
    const base = lower.split('/').pop();
    if (base) names.add(base);
  }
  return names;
}

export interface ScopedReview {
  markdown: string;
  dropped: Finding[];
}

/**
 * Removes findings that point outside the change and never say what in the
 * change causes them.
 *
 * The verdict is left exactly as written. Dropping a finding the verdict
 * rests on and then rewriting that verdict to `Approve` would be this tool
 * silently approving a change on the strength of a heuristic — the one
 * mistake here that costs more than the noise it is cleaning up. Instead
 * every removal is disclosed under the verdict as a `[note]` line, so a
 * filter that took something it should not have is visible in the review
 * itself rather than only in a log nobody reads.
 */
export function dropOutOfScopeFindings(markdown: string, changedPaths: string[]): ScopedReview {
  const names = changedNames(changedPaths);
  if (!names.size) return { markdown, dropped: [] };

  const { preamble, findings, tail } = splitFindings(markdown);
  const mentionsChange = (text: string) => {
    const lower = text.toLowerCase();
    for (const name of names) if (lower.includes(name)) return true;
    return false;
  };

  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const finding of findings) {
    // No file in the heading: a flow or requirement finding. Never dropped.
    const inScope =
      !NAMES_A_FILE.test(finding.location) ||
      mentionsChange(finding.location) ||
      mentionsChange(finding.body);
    (inScope ? kept : dropped).push(finding);
  }
  if (!dropped.length) return { markdown, dropped: [] };

  const body = kept.map((f) => `### ${f.heading}\n\n${f.body.trim()}`).join('\n\n');
  const disclosure = dropped
    .map((f) => `[note] kapsam dışı olduğu için çıkarıldı: ${f.heading} — değişen hiçbir dosyayı göstermiyor`)
    .join('\n');

  return {
    markdown: [preamble, body, tail, disclosure].filter((part) => part.trim()).join('\n\n'),
    dropped,
  };
}
