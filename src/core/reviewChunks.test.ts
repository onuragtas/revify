import { describe, expect, it } from 'vitest';
import { chunkChange, mergeReviews, needsDeepScan, CHUNK_CHARS } from './reviewChunks.js';
import type { RepoChange } from '../adapters/context/gitlabBranchDiffContext.js';

const file = (path: string, size: number) => ({ path, diff: `--- ${path}\n${'x'.repeat(size)}` });

const change = (projectPath: string, files: Array<{ path: string; diff: string }>): RepoChange => ({
  projectPath,
  branchName: 'feature/BUY-1',
  baseBranch: 'master',
  diff: files.map((f) => `--- ${f.path} ---\n${f.diff}`).join('\n\n'),
  files,
  repoPath: null,
});

describe('needsDeepScan', () => {
  it('leaves a small change alone', () => {
    // Most reviews are small, and splitting one costs time and buys nothing.
    expect(needsDeepScan([change('team/api', [file('a.ts', 2_000)])])).toBe(false);
  });

  it('is true once one pass can no longer read it all closely', () => {
    expect(needsDeepScan([change('team/api', [file('a.ts', 40_000)])])).toBe(true);
  });

  it('counts the whole change, not the biggest repository in it', () => {
    // A change spread thin across four services is exactly as unreadable in
    // one pass as the same volume in one.
    const spread = ['a', 'b', 'c', 'd'].map((n) => change(`team/${n}`, [file(`${n}.ts`, 8_000)]));
    expect(needsDeepScan(spread)).toBe(true);
  });
});

describe('chunkChange', () => {
  it('splits on whole files, never through one', () => {
    /*
     * A hunk cut down the middle is worse than not read at all: the model
     * judges what is left as if it were the whole change, and reports the
     * missing half as a defect.
     */
    const chunks = chunkChange([
      change('team/api', [file('a.ts', 20_000), file('b.ts', 20_000), file('c.ts', 5_000)]),
    ]);

    const paths = chunks.map((c) => c.repoChanges[0].files.map((f) => f.path));
    expect(paths).toEqual([['a.ts'], ['b.ts', 'c.ts']]);
    expect(chunks.every((c) => c.repoChanges[0].diff.includes('---'))).toBe(true);
  });

  it('keeps repositories apart, because a repository is a thing to read', () => {
    const chunks = chunkChange([
      change('team/api', [file('a.ts', 1_000)]),
      change('team/web', [file('b.ts', 1_000)]),
    ]);

    expect(chunks.map((c) => c.label)).toEqual(['team/api · 1', 'team/web · 1']);
  });

  it('sends an oversized file on its own rather than cutting it', () => {
    // The budget is a target, not a guarantee: a file is the smallest unit
    // that can be judged.
    const chunks = chunkChange([change('team/api', [file('huge.ts', CHUNK_CHARS * 2)])]);
    expect(chunks).toHaveLength(1);
  });

  it('numbers the parts of one repository', () => {
    const chunks = chunkChange([
      change('team/api', [file('a.ts', 25_000), file('b.ts', 25_000)]),
    ]);
    expect(chunks.map((c) => c.label)).toEqual(['team/api · 1', 'team/api · 2']);
  });
});

describe('mergeReviews', () => {
  const spine = [
    'Değişiklik iade akışını ekliyor.',
    '',
    '### blocking — src/Payment.php:829',
    '',
    'refund() transaction dışında.',
    '',
    'Verdict: Request changes — ödeme akışı',
    '',
    '**QA için**',
    '',
    'Boş sepetle dene.',
  ].join('\n');

  it('keeps the whole-change pass as the spine and appends what the slices found', () => {
    const slice = ['### major — src/Bank.php:12', '', 'Null kontrolü yok.'].join('\n');

    const merged = mergeReviews(spine, [slice]);

    expect(merged).toContain('Değişiklik iade akışını ekliyor.');
    expect(merged).toContain('src/Payment.php:829');
    expect(merged).toContain('src/Bank.php:12');
    // The sections that only make sense whole come from the whole pass.
    expect(merged).toContain('Verdict: Request changes');
    expect(merged).toContain('QA için');
  });

  it('reports a finding once, however many passes saw it', () => {
    // A defect visible in a slice is usually visible whole too.
    const slice = ['### blocking — src/Payment.php:829', '', 'Aynı kusur, başka kelimelerle.'].join('\n');

    const merged = mergeReviews(spine, [slice]);
    expect(merged.match(/src\/Payment\.php:829/g)).toHaveLength(1);
    expect(merged).not.toContain('başka kelimelerle');
  });

  it('orders by severity, so the blocking ones are read first', () => {
    const slice = [
      '### minor — src/Log.php:4',
      '',
      'Mesaj yanıltıcı.',
      '',
      '### major — src/Bank.php:12',
      '',
      'Null kontrolü yok.',
    ].join('\n');

    const merged = mergeReviews(spine, [slice]);
    const order = [...merged.matchAll(/^### (blocking|major|minor)/gm)].map((m) => m[1]);
    expect(order).toEqual(['blocking', 'major', 'minor']);
  });

  it('will not approve a change a slice found blocking', () => {
    /*
     * The whole-change pass wrote its verdict knowing only its own
     * findings. Carried over unchanged, an `Approve` would say the change
     * is fine while the review below it says it is not — a disagreement
     * nobody would notice until it had been approved.
     */
    const approving = ['Değişiklik sağlam.', '', 'Verdict: Approve'].join('\n');
    const slice = ['### blocking — src/Payment.php:829', '', 'refund() transaction dışında.'].join('\n');

    const merged = mergeReviews(approving, [slice]);

    expect(merged).not.toMatch(/Verdict:\s*Approve\s*$/);
    expect(merged).toContain('Verdict: Request changes — src/Payment.php:829');
  });

  it('leaves a verdict alone when nothing blocking was added', () => {
    const approving = ['Sağlam.', '', 'Verdict: Approve'].join('\n');
    const slice = ['### minor — src/Log.php:4', '', 'Nit.'].join('\n');

    expect(mergeReviews(approving, [slice])).toContain('Verdict: Approve');
  });

  it('is the spine itself when no slice found anything', () => {
    expect(mergeReviews(spine, [])).toContain('Verdict: Request changes — ödeme akışı');
  });
});
