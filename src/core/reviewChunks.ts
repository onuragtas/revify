import type { RepoChange } from '../adapters/context/gitlabBranchDiffContext.js';
import { splitFindings, SEVERITY_ORDER, type Finding } from './findings.js';

/**
 * Splitting a change into pieces small enough to be read properly.
 *
 * One model call over a fifty-file diff is not a thorough review; it is a
 * sample of one. The findings that came back differed between runs and
 * between machines, and both are the same symptom: attention thins out over
 * a hundred and thirty thousand characters, and each pass happens to look
 * closely at a different part. Asking for more findings does not help — the
 * cap was removed and the drip continued. What was missing was not
 * willingness but coverage.
 *
 * So a large change is read twice over: once whole, for the questions that
 * only make sense whole — does this solve the issue, does the flow hold,
 * do the repositories agree — and once per slice, for the line-level
 * defects that need somebody actually looking at the lines.
 */

/** Characters of diff a single pass is asked to read closely. Chosen from
 * the sizes real reviews produce: below this, one pass covers the change
 * and splitting only costs time. */
export const CHUNK_CHARS = 30_000;

/** Below this, a change is read in one pass exactly as before. Most are. */
export const DEEP_SCAN_MIN_CHARS = 25_000;

export interface ReviewChunk {
  /** Human label for the log and the prompt: which repository and which
   * part of it. */
  label: string;
  repoChanges: RepoChange[];
}

const diffLength = (changes: RepoChange[]): number =>
  changes.reduce((total, c) => total + c.diff.length, 0);

/** Whether reading this change in one pass can be called thorough. */
export function needsDeepScan(changes: RepoChange[]): boolean {
  return diffLength(changes) >= DEEP_SCAN_MIN_CHARS;
}

/**
 * Slices a change into readable pieces, along boundaries that mean
 * something.
 *
 * Repository first, because a repository is a coherent thing to read and
 * the reviewer is told which one it is looking at. Then whole files, never
 * halves: a hunk cut down the middle is worse than not read at all, since
 * the model will judge what is left as if it were the whole change.
 *
 * A single file larger than the budget still travels alone rather than
 * being split — the budget is a target, not a guarantee, and a file is the
 * smallest unit that can be judged.
 */
export function chunkChange(changes: RepoChange[]): ReviewChunk[] {
  const chunks: ReviewChunk[] = [];

  for (const change of changes) {
    const files = change.files.length ? change.files : [{ path: '(diff)', diff: change.diff }];
    let batch: typeof files = [];
    let size = 0;

    const flush = () => {
      if (!batch.length) return;
      const part = chunks.filter((c) => c.label.startsWith(change.projectPath)).length + 1;
      chunks.push({
        label: `${change.projectPath} · ${part}`,
        repoChanges: [
          {
            ...change,
            files: batch,
            diff: batch.map((f) => `--- ${f.path} ---\n${f.diff}`).join('\n\n'),
          },
        ],
      });
      batch = [];
      size = 0;
    };

    for (const file of files) {
      if (size && size + file.diff.length > CHUNK_CHARS) flush();
      batch.push(file);
      size += file.diff.length;
    }
    flush();
  }

  return chunks;
}

/**
 * One review out of several passes.
 *
 * The whole-change pass supplies the spine — what it said before the
 * findings, and the verdict, QA notes and deployment section after them.
 * The slice passes supply findings only. Merging is therefore an
 * append-and-dedupe rather than a negotiation between two documents.
 *
 * Duplicates are real: a defect visible in the slice is usually visible
 * whole too. Matched on severity and location, which is what a reader would
 * use — two entries for `blocking src/a.php:829` are the same finding
 * however differently they are worded.
 */
export function mergeReviews(spine: string, extra: string[]): string {
  const base = splitFindings(spine);
  const seen = new Set(base.findings.map(key));
  const added: Finding[] = [];

  for (const pass of extra) {
    for (const finding of splitFindings(pass).findings) {
      if (seen.has(key(finding))) continue;
      seen.add(key(finding));
      added.push(finding);
    }
  }

  const all = [...base.findings, ...added].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  const body = all.map((f) => `### ${f.heading}\n\n${f.body.trim()}`).join('\n\n');
  const tail = correctVerdict(base.tail, all);

  return [base.preamble, body, tail].filter((part) => part.trim()).join('\n\n');
}

/** `blocking` + `src/a.php:829 (epa_api)`, insensitive to spacing and case
 * — the two things a reader uses to tell one finding from another. */
function key(finding: Finding): string {
  return `${finding.severity}|${finding.location.toLowerCase().replace(/\s+/g, '')}`;
}

/**
 * Keeps the verdict honest about the merged set.
 *
 * The whole-change pass wrote its verdict knowing only its own findings. If
 * a slice then found something blocking, an `Approve` carried over from the
 * spine would say the change is fine while the review below it says it is
 * not — the worst possible disagreement, and one nobody would notice until
 * it had been approved.
 *
 * Rewritten mechanically rather than by asking the model again: the rule is
 * "a blocking finding blocks", and there is nothing to reason about.
 */
function correctVerdict(tail: string, findings: Finding[]): string {
  const blocking = findings.filter((f) => f.severity === 'blocking');
  if (!blocking.length) return tail;
  if (!/^\s*Verdict:\s*Approve\s*$/im.test(tail)) return tail;

  const named = blocking.map((f) => f.location).join(', ');
  return tail.replace(
    /^\s*Verdict:\s*Approve\s*$/im,
    `Verdict: Request changes — ${named}`,
  );
}
