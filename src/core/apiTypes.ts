/**
 * The shapes the web API actually sends, written once.
 *
 * This file has **no imports and no runtime code** — deliberately. It is
 * read by the Express handlers on one side and by the browser bundle on the
 * other, and a browser cannot follow an import that leads to `node:fs`.
 * Type-only, it is erased at build time and costs the bundle nothing.
 *
 * Why it exists at all: the UI used to declare these shapes a second time,
 * by hand. Two copies with nothing binding them means a field renamed on the
 * server compiles cleanly on both sides and the screen silently goes blank —
 * the failure nobody notices until someone asks why a panel is empty. With
 * one declaration, that rename is a compile error.
 *
 * These are *view* types, not storage types. `FixPatchView` carries the size
 * of a patch and not the patch, because `/detail` is polled once a second
 * and a patch is measured in kilobytes.
 */

export type Severity = 'blocking' | 'major' | 'minor';

export type ReviewStatusName =
  | 'idle'
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'failed';

export type FixStatusName = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';

/** One finding, parsed out of the review's markdown server-side so the UI
 * and the fix path read the same list. */
export interface FindingView {
  id: string;
  severity: Severity;
  /** `src/a.ts:42`, or a flow when the reviewer had no single line. */
  location: string;
  heading: string;
  /** The finding itself: what is wrong, the quoted lines, the impact and the
   * fix. Sent so the UI can show findings as cards rather than as one wall
   * of markdown — the split is computed once, on the server, so nothing has
   * to re-implement where a finding ends. */
  body: string;
}

export interface PatchStatsView {
  files: number;
  insertions: number;
  deletions: number;
}

export interface FixPatchView {
  projectPath: string;
  branchName: string;
  /** Characters in the patch. The text has its own endpoint. */
  size: number;
  stats: PatchStatsView;
  files: string[];
  appliedTo?: string;
  appliedAt?: string;
  appliedWithMerge?: boolean;
  appliedIgnoringWhitespace?: boolean;
  error?: string;
}

export interface FixView {
  status: FixStatusName;
  findings: Array<{ severity: string; heading: string; instruction?: string }>;
  patches: FixPatchView[];
  report?: Array<{ outcome: 'fixed' | 'skipped'; text: string }>;
  requestedAt: string;
  finishedAt?: string;
  queuePosition?: number;
  error?: string;
}

export interface PromptSummaryView {
  kind: string;
  savedAt: string;
  size: number;
}

export interface RepoChangeView {
  projectPath: string;
  baseBranch: string;
  branchName: string;
  files: Array<{ path: string; diff: string }>;
}

export interface HistoryEntryView {
  title: string;
  markdown: string;
  outcome: ReviewStatusName;
  archivedAt: string;
}

export interface NoteView {
  id: string;
  scope: 'global' | 'repo';
  projectPath: string | null;
  text: string;
  createdAt: string;
}

export interface StepView {
  ts: string;
  message: string;
  /** First line of a run — where the elapsed clock restarts. One issue's
   * log can hold a review and a later fix. */
  startsRun?: boolean;
}

/** `GET /api/reviews/:issueKey/detail` — polled once a second while an issue
 * is open, and therefore the one payload whose size is a design constraint. */
export interface ReviewDetail {
  status: ReviewStatusName;
  queuePosition: number | null;
  summary: string | null;
  projectPaths: string[];
  review: { title: string; markdown: string } | null;
  /** The review minus its findings: what the reviewer wrote before the first
   * one, and the verdict and QA notes after the last. */
  reviewPreamble: string;
  reviewTail: string;
  reviewedAt: string | null;
  reviewSeq: number | null;
  trigger: 'manual' | 'auto';
  /** `[?]` lines: what the reviewer could not verify on its own. */
  openQuestions: string[];
  /** `[note]` lines: which standing notes were applied, and what they
   * suppressed. */
  appliedNotes: string[];
  repoChanges: RepoChangeView[] | null;
  history: HistoryEntryView[];
  findings: FindingView[];
  fix: FixView | null;
  /** False when this machine's provider has no file tools, or the review was
   * produced without a checkout. */
  fixAvailable: boolean;
  /**
   * True when this review came from a directory rather than a Jira issue.
   *
   * The decision means something different then: there is no issue to
   * comment on, no status to move and nobody to reassign, so approving is a
   * record kept here and nothing more. The buttons have to say so — naming a
   * Jira transition that provably cannot happen is worse than saying nothing.
   */
  local: boolean;
  /** Where each project was last applied on this machine. */
  fixTargets: Record<string, string>;
  clarifications: Array<{ question: string; answer: string; answeredAt: string }>;
  rejectionReason: string | null;
  revisionRequest: string;
  challenges: Array<{ finding: string; objection: string; raisedAt: string }>;
  /** `[withdrawn]` lines: findings a human disputed that the reviewer then
   * re-checked and dropped. */
  withdrawn: string[];
  error: string | null;
  steps: StepView[];
  prompts: PromptSummaryView[];
  notes: NoteView[];
}
