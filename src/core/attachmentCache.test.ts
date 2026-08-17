import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fetchAttachments } from './attachmentCache.js';
import type { JiraAttachment } from '../clients/jiraClient.js';

const file = (over: Partial<JiraAttachment> = {}): JiraAttachment => ({
  id: '1',
  filename: 'spec.pdf',
  mimeType: 'application/pdf',
  size: 1024,
  contentUrl: 'https://jira.example/attachment/1',
  created: '2026-08-17T09:00:00.000Z',
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'revify-att-')), 'BUY-1');
});

const download = async () => Buffer.from('pdf bytes');

describe('fetchAttachments', () => {
  it('downloads what the model can read', async () => {
    const plan = await fetchAttachments([file()], dir, download);

    expect(plan.fetched).toHaveLength(1);
    expect(readFileSync(plan.fetched[0].path, 'utf-8')).toBe('pdf bytes');
  });

  it('names what it skipped, rather than dropping it silently', async () => {
    const plan = await fetchAttachments(
      [
        file({ id: '1', filename: 'flow.docx' }),
        file({ id: '2', filename: 'dump.pdf', size: 40 * 1024 * 1024 }),
      ],
      dir,
      download,
    );

    // A review that cannot see flow.docx should say so, not reason as
    // though the issue had no specification at all.
    expect(plan.fetched).toEqual([]);
    expect(plan.skipped.map((s) => s.filename)).toEqual(['flow.docx', 'dump.pdf']);
    expect(plan.skipped[0].reason).toContain('okunamayan');
    expect(plan.skipped[1].reason).toContain('büyük');
  });

  it('stops at ten files', async () => {
    const many = Array.from({ length: 14 }, (_, i) => file({ id: String(i), filename: `shot-${i}.png` }));
    const plan = await fetchAttachments(many, dir, download);

    expect(plan.fetched).toHaveLength(10);
    expect(plan.skipped).toHaveLength(4);
  });

  it('cannot be made to write outside its directory', async () => {
    // Jira filenames come from people, and people paste anything.
    const plan = await fetchAttachments(
      [file({ filename: '../../escaped.pdf' }), file({ id: '2', filename: '.hidden.png' })],
      dir,
      download,
    );

    expect(plan.fetched).toHaveLength(2);
    for (const f of plan.fetched) expect(f.path.startsWith(dir)).toBe(true);
    expect(readdirSync(dir).every((n) => !n.includes('/'))).toBe(true);
  });

  it('clears what a previous run left behind', async () => {
    await fetchAttachments([file({ filename: 'old.pdf' })], dir, download);
    expect(existsSync(join(dir, 'old.pdf'))).toBe(true);

    // The attachment was removed from the issue. Left on disk it would be
    // read as though it were still part of the specification.
    await fetchAttachments([file({ filename: 'new.pdf' })], dir, download);
    expect(existsSync(join(dir, 'old.pdf'))).toBe(false);
    expect(existsSync(join(dir, 'new.pdf'))).toBe(true);
  });

  it('lets one failed download cost only itself', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('403 Forbidden');
      return Buffer.from('ok');
    };

    const plan = await fetchAttachments(
      [file({ id: '1', filename: 'a.pdf' }), file({ id: '2', filename: 'b.pdf' })],
      dir,
      flaky,
    );

    expect(plan.skipped[0].reason).toContain('403');
    expect(plan.fetched.map((f) => f.filename)).toEqual(['b.pdf']);
  });
});
