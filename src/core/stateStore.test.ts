import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from './stateStore.js';
import type { PendingApproval } from './types.js';

describe('StateStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-reviewer-state-'));
    filePath = join(dir, 'nested', 'state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when no file exists yet', () => {
    const store = new StateStore(filePath);
    expect(store.hasProcessed('PROJ-1')).toBe(false);
    expect(store.listPendingApprovals()).toEqual([]);
  });

  it('dedupes processed event ids, creating parent directories as needed', () => {
    const store = new StateStore(filePath);

    expect(store.hasProcessed('PROJ-1')).toBe(false);
    store.markProcessed('PROJ-1');
    expect(store.hasProcessed('PROJ-1')).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    // Marking again should be a no-op, not a duplicate entry.
    store.markProcessed('PROJ-1');

    // A fresh instance reading the same file sees the same state (persistence).
    const reloaded = new StateStore(filePath);
    expect(reloaded.hasProcessed('PROJ-1')).toBe(true);
  });

  it('adds and removes pending approvals', () => {
    const store = new StateStore(filePath);
    const pending: PendingApproval = {
      id: 'PROJ-2',
      event: { id: 'PROJ-2', data: {} },
      taskResult: { title: 't', markdown: 'm' },
      channelRef: { channel: 'C1', ts: '123.456' },
      createdAt: new Date(0).toISOString(),
    };

    store.addPendingApproval(pending);
    expect(store.listPendingApprovals()).toEqual([pending]);

    store.removePendingApproval('PROJ-2');
    expect(store.listPendingApprovals()).toEqual([]);
  });

  it('replaces an existing pending approval with the same id instead of duplicating it', () => {
    const store = new StateStore(filePath);
    const makePending = (markdown: string): PendingApproval => ({
      id: 'PROJ-3',
      event: { id: 'PROJ-3', data: {} },
      taskResult: { title: 't', markdown },
      channelRef: {},
      createdAt: new Date(0).toISOString(),
    });

    // Simulates re-running a review for the same issue before the first
    // pending approval was ever resolved.
    store.addPendingApproval(makePending('first run'));
    store.addPendingApproval(makePending('second run'));

    const pending = store.listPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].taskResult.markdown).toBe('second run');
  });
});

describe('StateStore — one file, one owner', () => {
  it('keeps every field when a single instance writes different areas', () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json');
    const store = new StateStore(filePath);

    store.setAutoPrepareBaseline(['A', 'B', 'C'], '2026-08-17T10:00:00.000Z');
    store.markProcessed('X-1');
    store.recordReview('2026-08-17T11:00:00.000Z');

    // Two instances over one path used to delete each other's fields:
    // each holds the whole file in memory and rewrites all of it, so the
    // last writer silently dropped whatever the other had added. That is
    // how a pending approval went missing and an approval then reported
    // success while writing nothing to Jira.
    const reloaded = new StateStore(filePath);
    expect(reloaded.unseenIssueKeys(['A', 'B', 'C', 'D'])).toEqual(['D']);
    expect(reloaded.hasProcessed('X-1')).toBe(true);
    expect(reloaded.lastReviewAt()).toBe('2026-08-17T11:00:00.000Z');
  });
});
