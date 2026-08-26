import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import type { Requirement } from './requirement.js';

export type ReviewStatus =
  | 'idle'
  /** Requested, waiting for the repo cache to free up — see ReviewQueue. */
  | 'queued'
  | 'running'
  /** Stopped by a human mid-run — distinct from 'failed', which means the
   * pipeline broke, and from 'idle', which means nobody ever tried. */
  | 'cancelled'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'posted'
  | 'failed';

/** A finished review, kept so a re-run can be compared against what the
 * reviewer said last time. */
export interface ReviewHistoryEntry {
  title: string;
  markdown: string;
  /** Where the review ended up before it was superseded — approved,
   * rejected, posted, or still awaiting a decision. */
  outcome: ReviewStatus;
  archivedAt: string;
}

/** One repository's worth of fix: what the fixer changed, as a patch that
 * has not been applied anywhere yet. */
export interface FixPatch {
  projectPath: string;
  branchName: string;
  patch: string;
  stats: { files: number; insertions: number; deletions: number };
  /** Files the patch touches, for a list the UI can show without parsing
   * the diff again. */
  files: string[];
  /** Where a human last applied it, if they did. Kept so the UI can say
   * "already applied to ~/projects/api" rather than inviting a second,
   * conflicting apply. */
  appliedTo?: string;
  appliedAt?: string;
  /** True when git had to three-way merge it in — the working copy had
   * moved, and the result deserves reading before it is committed. */
  appliedWithMerge?: boolean;
  /** Set when this repository's run failed while others succeeded. */
  error?: string;
}

/**
 * A fix run: the review's findings turned into patches.
 *
 * Kept on the review record rather than in a store of its own because it is
 * meaningless without the review it came from — the findings it acted on
 * are that review's findings, and a re-review replaces both together.
 */
export interface FixRecord {
  status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
  /** The findings a human picked, by heading — what the fixer was asked to
   * do, kept verbatim so the report can be read against it. `instruction` is
   * the call they made on a finding that offered options. */
  findings: Array<{ severity: string; heading: string; instruction?: string }>;
  patches: FixPatch[];
  /** The fixer's own account, one line per finding: what it changed, and
   * what it refused to guess at. */
  report?: Array<{ outcome: 'fixed' | 'skipped'; text: string }>;
  requestedAt: string;
  finishedAt?: string;
  queuePosition?: number;
  error?: string;
}

export interface ReviewRecord {
  issueKey: string;
  summary?: string;
  /** GitLab project the reviewed branch belongs to — lets the UI offer
   * repo-scoped notes for this issue. */
  status: ReviewStatus;
  review?: { title: string; markdown: string };
  /** The diffs the review was written against, one per repository the
   * change touches — rendered side-by-side in the UI so you can read the
   * change next to the findings. */
  repoChanges?: Array<{
    projectPath: string;
    baseBranch: string;
    branchName: string;
    files: Array<{ path: string; diff: string }>;
  }> | null;
  /** Projects this change touches — used to scope repo-level notes. */
  projectPaths?: string[];
  /** What the issue asked for, as this review read it. Kept so a fix built
   * from these findings works from the same text — see core/requirement.ts. */
  requirement?: Requirement;
  /** Places ahead of this one in the queue. Only meaningful while status
   * is `queued`; the UI shows it so a wait doesn't look like a hang. */
  queuePosition?: number;
  /** When the review itself finished, and its place in the overall order
   * of reviews produced. Kept separate from `updatedAt`, which moves on
   * every edit — an answered question, a decision, a queue position. */
  reviewedAt?: string;
  reviewSeq?: number;
  /** Who started it: 'auto' means the watcher prepared it before anyone
   * asked. Worth showing — an unexpected review deserves an explanation. */
  trigger?: 'manual' | 'auto';
  error?: string;
  /** What the reviewer typed when rejecting — goes onto the Jira issue so
   * the developer knows why it came back. */
  rejectionReason?: string;
  /** Answers a human gave to `[?]` questions the reviewer raised. Kept
   * across re-runs — they are inputs to the next review, not output. */
  clarifications?: Array<{ question: string; answer: string; answeredAt: string }>;
  /** Findings a human pushed back on. Unlike a clarification, this is not
   * accepted as fact — the next run has to re-check the claim against the
   * code and either withdraw it or defend it with evidence. */
  challenges?: Array<{ finding: string; objection: string; raisedAt: string }>;
  /** Free-text instructions for the next run — "shorten this", "you missed
   * the caller in X", "expand the QA notes". Broader than a challenge,
   * which argues with one finding. Stays in effect until cleared, so the
   * reviewer can keep asking for the same thing across re-runs. */
  revisionRequest?: string;
  /** Previous reviews, newest first. Capped — the point is to compare
   * against the last run or two, not to keep an audit log forever. */
  history?: ReviewHistoryEntry[];
  /** The patch produced from this review's findings, if anyone asked for
   * one. Cleared when the review is re-run: a patch built against findings
   * that no longer exist is a patch nobody can check. */
  fix?: FixRecord;
  updatedAt: string;
}

const MAX_HISTORY = 10;

type ReviewPatch = Partial<Omit<ReviewRecord, 'issueKey' | 'updatedAt'>>;

/** Persisted, per-issue review state — what the web UI's list view and
 * detail panel read from. Separate from StateStore (which tracks the
 * background/automatic loop's dedup + pending-approval bookkeeping). */
export class ReviewStore {
  private records: Record<string, ReviewRecord>;

  constructor(private readonly filePath: string) {
    this.records = this.load();
  }

  private load(): Record<string, ReviewRecord> {
    if (!existsSync(this.filePath)) return {};
    const raw = readFileSync(this.filePath, 'utf-8');
    return raw.trim() ? (JSON.parse(raw) as Record<string, ReviewRecord>) : {};
  }

  private save(): void {
    writeFileAtomic(this.filePath, JSON.stringify(this.records, null, 2));
  }

  /**
   * Re-reads the file, discarding the in-memory copy.
   *
   * Needed after an import replaces the file underneath us. Every store
   * here keeps the whole file in memory and rewrites all of it on the next
   * change, so without this the first save after an import would quietly
   * put the old data back — the same failure that made two StateStore
   * instances delete each other's fields.
   */
  reload(): void {
    this.records = this.load();
  }

  get(issueKey: string): ReviewRecord | undefined {
    return this.records[issueKey];
  }

  list(): ReviewRecord[] {
    return Object.values(this.records);
  }

  upsert(issueKey: string, patch: ReviewPatch): void {
    const existing = this.records[issueKey];
    this.records[issueKey] = {
      ...existing,
      ...patch,
      issueKey,
      status: patch.status ?? existing?.status ?? 'idle',
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  /** Forgets everything about an issue — review, history, clarifications.
   * Used by the UI's clear button to start a task over. */
  reset(issueKey: string): void {
    delete this.records[issueKey];
    this.save();
  }

  /**
   * Moves the current review into history so a re-run starts clean without
   * throwing away what the reviewer said last time. No-op when there is
   * nothing to archive, so it's safe to call before every run.
   */
  archiveCurrentReview(issueKey: string): void {
    const existing = this.records[issueKey];
    if (!existing?.review) return;

    const entry: ReviewHistoryEntry = {
      title: existing.review.title,
      markdown: existing.review.markdown,
      outcome: existing.status,
      archivedAt: new Date().toISOString(),
    };
    // Newest first, so the UI can show the most recent previous run without
    // walking the array.
    const history = [entry, ...(existing.history ?? [])].slice(0, MAX_HISTORY);

    this.records[issueKey] = {
      ...existing,
      history,
      review: undefined,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }
}
