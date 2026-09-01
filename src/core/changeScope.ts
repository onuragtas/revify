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
