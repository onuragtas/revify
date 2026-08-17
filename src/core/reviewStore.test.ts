import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewStore } from './reviewStore.js';

describe('ReviewStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-reviewer-reviews-'));
    filePath = join(dir, 'nested', 'reviews.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a record across instances', () => {
    const store = new ReviewStore(filePath);
    store.upsert('PROJ-1', { status: 'awaiting_approval', review: { title: 't', markdown: 'body' } });

    const reloaded = new ReviewStore(filePath);
    expect(reloaded.get('PROJ-1')?.status).toBe('awaiting_approval');
    expect(reloaded.get('PROJ-1')?.review?.markdown).toBe('body');
  });

  it('keeps an existing status when a patch omits it', () => {
    const store = new ReviewStore(filePath);
    store.upsert('PROJ-1', { status: 'awaiting_approval' });
    store.upsert('PROJ-1', { summary: 'a summary' });

    expect(store.get('PROJ-1')?.status).toBe('awaiting_approval');
    expect(store.get('PROJ-1')?.summary).toBe('a summary');
  });

  it('reset forgets an issue entirely so a task can start over', () => {
    const store = new ReviewStore(filePath);
    store.upsert('PROJ-1', { status: 'posted', review: { title: 't', markdown: 'body' } });
    store.archiveCurrentReview('PROJ-1');
    store.upsert('PROJ-1', { clarifications: [{ question: 'q', answer: 'a', answeredAt: 'now' }] });

    store.reset('PROJ-1');

    expect(store.get('PROJ-1')).toBeUndefined();
    expect(new ReviewStore(filePath).get('PROJ-1')).toBeUndefined();
  });

  describe('archiveCurrentReview', () => {
    it('moves the current review into history and clears it', () => {
      const store = new ReviewStore(filePath);
      store.upsert('PROJ-1', {
        status: 'rejected',
        review: { title: 'first', markdown: 'first review' },
      });

      store.archiveCurrentReview('PROJ-1');

      const record = store.get('PROJ-1');
      expect(record?.review).toBeUndefined();
      expect(record?.history).toHaveLength(1);
      expect(record?.history?.[0].markdown).toBe('first review');
      // The outcome the review reached is what makes it meaningful later.
      expect(record?.history?.[0].outcome).toBe('rejected');
    });

    it('orders history newest first', () => {
      const store = new ReviewStore(filePath);

      store.upsert('PROJ-1', { status: 'posted', review: { title: 't', markdown: 'older' } });
      store.archiveCurrentReview('PROJ-1');
      store.upsert('PROJ-1', { status: 'posted', review: { title: 't', markdown: 'newer' } });
      store.archiveCurrentReview('PROJ-1');

      expect(store.get('PROJ-1')?.history?.map((h) => h.markdown)).toEqual(['newer', 'older']);
    });

    it('is a no-op when there is no review to archive', () => {
      const store = new ReviewStore(filePath);
      store.upsert('PROJ-1', { status: 'running' });

      store.archiveCurrentReview('PROJ-1');
      store.archiveCurrentReview('PROJ-NEVER-SEEN');

      expect(store.get('PROJ-1')?.history ?? []).toEqual([]);
      expect(store.get('PROJ-NEVER-SEEN')).toBeUndefined();
    });

    it('caps history so it cannot grow without bound', () => {
      const store = new ReviewStore(filePath);

      for (let i = 0; i < 15; i++) {
        store.upsert('PROJ-1', { status: 'posted', review: { title: 't', markdown: `run ${i}` } });
        store.archiveCurrentReview('PROJ-1');
      }

      const history = store.get('PROJ-1')?.history ?? [];
      expect(history).toHaveLength(10);
      // The most recent runs are the ones kept.
      expect(history[0].markdown).toBe('run 14');
      expect(history[9].markdown).toBe('run 5');
    });

    it('survives a reload', () => {
      const store = new ReviewStore(filePath);
      store.upsert('PROJ-1', { status: 'posted', review: { title: 't', markdown: 'archived' } });
      store.archiveCurrentReview('PROJ-1');

      expect(new ReviewStore(filePath).get('PROJ-1')?.history?.[0].markdown).toBe('archived');
    });
  });
});
