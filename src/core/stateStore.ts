import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import type { PendingApproval } from './types.js';

interface StateFile {
  /** Event ids the trigger loop has already turned into a pending approval
   * or a completed action — prevents re-triggering on every poll. */
  processedEventIds: string[];
  pendingApprovals: PendingApproval[];
  /** Issue keys the auto-prepare watcher has already seen in the review
   * queue. Anything absent from this list is, by definition, new. */
  autoPrepareSeen: string[];
  /** Set the first time the watcher runs. Its presence is what tells the
   * watcher that `autoPrepareSeen` is a real baseline and not just an
   * empty file — without it, a fresh install would treat the entire
   * existing backlog as "new" and review all of it at once. */
  autoPrepareSince: string | null;
  /** When the most recent review finished, and how many have run. The
   * count doubles as the ordering the reviews were produced in. */
  lastReviewAt: string | null;
  reviewCount: number;
}

const EMPTY_STATE: StateFile = {
  processedEventIds: [],
  pendingApprovals: [],
  autoPrepareSeen: [],
  autoPrepareSince: null,
  lastReviewAt: null,
  reviewCount: 0,
};

export class StateStore {
  private state: StateFile;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  private load(): StateFile {
    if (!existsSync(this.filePath)) return structuredClone(EMPTY_STATE);
    const raw = readFileSync(this.filePath, 'utf-8');
    if (!raw.trim()) return structuredClone(EMPTY_STATE);
    return { ...structuredClone(EMPTY_STATE), ...JSON.parse(raw) };
  }

  private save(): void {
    writeFileAtomic(this.filePath, JSON.stringify(this.state, null, 2));
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
    this.state = this.load();
  }

  hasProcessed(eventId: string): boolean {
    return this.state.processedEventIds.includes(eventId);
  }

  markProcessed(eventId: string): void {
    if (!this.hasProcessed(eventId)) {
      this.state.processedEventIds.push(eventId);
      this.save();
    }
  }

  /** Undoes markProcessed, so a cleared issue can be picked up again. */
  forgetProcessed(eventId: string): void {
    this.state.processedEventIds = this.state.processedEventIds.filter((id) => id !== eventId);
    this.save();
  }

  /** Replaces any existing pending approval with the same id rather than
   * appending — otherwise re-running a review (e.g. re-clicking "İncele"
   * in the UI before the old one was resolved) would leave two entries
   * for the same issue, and approving would run the Action twice. */
  addPendingApproval(pending: PendingApproval): void {
    this.state.pendingApprovals = this.state.pendingApprovals.filter((p) => p.id !== pending.id);
    this.state.pendingApprovals.push(pending);
    this.save();
  }

  listPendingApprovals(): PendingApproval[] {
    return this.state.pendingApprovals;
  }

  removePendingApproval(id: string): void {
    this.state.pendingApprovals = this.state.pendingApprovals.filter((p) => p.id !== id);
    this.save();
  }

  /* ------------------------- auto-prepare state ------------------------ */

  /** True once a baseline has been recorded. Until then the watcher must
   * not treat anything as new. */
  hasAutoPrepareBaseline(): boolean {
    return this.state.autoPrepareSince !== null;
  }

  autoPrepareSince(): string | null {
    return this.state.autoPrepareSince;
  }

  /** Records the issues that were already in review when watching began.
   * These are the ones explicitly not to touch. */
  setAutoPrepareBaseline(issueKeys: string[], at: string): void {
    this.state.autoPrepareSeen = [...new Set(issueKeys)];
    this.state.autoPrepareSince = at;
    this.save();
  }

  /** Which of these have never been seen before. Read-only — call
   * `markAutoPrepareSeen` once they have actually been handled, so a crash
   * between the two doesn't lose them. */
  unseenIssueKeys(issueKeys: string[]): string[] {
    const seen = new Set(this.state.autoPrepareSeen);
    return issueKeys.filter((k) => !seen.has(k));
  }

  markAutoPrepareSeen(issueKeys: string[]): void {
    if (!issueKeys.length) return;
    this.state.autoPrepareSeen = [...new Set([...this.state.autoPrepareSeen, ...issueKeys])];
    this.save();
  }

  /** Lets a cleared issue be picked up by the watcher again. */
  forgetAutoPrepareSeen(issueKey: string): void {
    this.state.autoPrepareSeen = this.state.autoPrepareSeen.filter((k) => k !== issueKey);
    this.save();
  }

  /* ---------------------------- review log ----------------------------- */

  lastReviewAt(): string | null {
    return this.state.lastReviewAt;
  }

  /** Stamps a completed review and returns its position in the sequence,
   * so the order reviews were produced in survives a restart. */
  recordReview(at: string): number {
    this.state.lastReviewAt = at;
    this.state.reviewCount += 1;
    this.save();
    return this.state.reviewCount;
  }
}
