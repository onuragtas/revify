import { describe, it, expect } from 'vitest';
import {
  dropOutOfScopeFindings,
  dropForeignOnlyFiles,
  isForeignCommit,
  issueKeysIn,
  joinFileDiffs,
  projectPrefixOf,
  splitCommitsByOwnership,
} from './changeScope.js';

const commit = (sha: string, title: string) => ({ sha, title, author: 'a', date: '2026-01-01' });

describe('projectPrefixOf', () => {
  it('takes the project half of a key', () => {
    expect(projectPrefixOf('BUY-2443')).toBe('BUY');
    expect(projectPrefixOf(' buy-2443 ')).toBe('BUY');
  });

  it('is empty for anything that is not a key, so nothing gets dropped on a guess', () => {
    expect(projectPrefixOf('local-review')).toBe('');
    expect(projectPrefixOf('')).toBe('');
  });
});

describe('issueKeysIn', () => {
  it('finds sibling tickets regardless of case', () => {
    expect(issueKeysIn('buy-2100: fix payment', 'BUY')).toEqual(['BUY-2100']);
  });

  /*
   * The reason the prefix is part of the pattern at all. A bare
   * [A-Z]+-\d+ matches UTF-8, and a commit mentioning a character set
   * would have had its files dropped as another ticket's work.
   */
  it('does not mistake UTF-8 or SHA-256 for a ticket', () => {
    expect(issueKeysIn('fix UTF-8 encoding and SHA-256 hashing', 'BUY')).toEqual([]);
  });
});

describe('isForeignCommit', () => {
  it('is true only when the title names another ticket and not this one', () => {
    expect(isForeignCommit(commit('a1', 'BUY-2100: payment fix'), 'BUY-2443')).toBe(true);
  });

  it('keeps this ticket’s own commits', () => {
    expect(isForeignCommit(commit('a2', 'BUY-2443: add barcode status'), 'BUY-2443')).toBe(false);
  });

  /*
   * The conservative half, and the one that matters most: developers write
   * "fix null check" on their own work all day. Reading that as somebody
   * else's would empty out the review.
   */
  it('keeps a commit that names no ticket at all', () => {
    expect(isForeignCommit(commit('a3', 'fix null check'), 'BUY-2443')).toBe(false);
  });

  it('keeps a commit that names this ticket alongside another', () => {
    expect(isForeignCommit(commit('a4', 'BUY-2443 + BUY-2100: shared refactor'), 'BUY-2443')).toBe(false);
  });

  it('drops nothing when the issue key is not a key', () => {
    expect(isForeignCommit(commit('a5', 'BUY-2100: whatever'), 'local')).toBe(false);
  });
});

describe('splitCommitsByOwnership', () => {
  it('separates the branch into this ticket’s work and everyone else’s', () => {
    const { own, foreign } = splitCommitsByOwnership(
      [
        commit('a1', 'BUY-2443: add endpoint'),
        commit('a2', 'BUY-2100: unrelated payment work'),
        commit('a3', 'refactor helper'),
      ],
      'BUY-2443',
    );
    expect(own.map((c) => c.sha)).toEqual(['a1', 'a3']);
    expect(foreign.map((c) => c.sha)).toEqual(['a2']);
  });

  it('handles a branch with no commit list', () => {
    expect(splitCommitsByOwnership(undefined, 'BUY-1')).toEqual({ own: [], foreign: [] });
  });
});

describe('dropForeignOnlyFiles', () => {
  const files = [
    { path: 'src/Barcode.php', diff: 'd1' },
    { path: 'src/Payment.php', diff: 'd2' },
    { path: 'src/Shared.php', diff: 'd3' },
  ];

  it('drops what only the other ticket touched', () => {
    const { files: kept, dropped } = dropForeignOnlyFiles(
      files,
      new Set(['src/Barcode.php', 'src/Shared.php']),
      new Set(['src/Payment.php', 'src/Shared.php']),
    );
    expect(dropped).toEqual(['src/Payment.php']);
    expect(kept.map((f) => f.path)).toEqual(['src/Barcode.php', 'src/Shared.php']);
  });

  /*
   * A file both sides touched stays whole. Showing half of it would leave
   * the model judging a fragment as if it were the entire change.
   */
  it('keeps a file both tickets touched', () => {
    const { dropped } = dropForeignOnlyFiles(files, new Set(['src/Shared.php']), new Set(['src/Shared.php']));
    expect(dropped).toEqual([]);
  });

  it('drops nothing when there is nothing foreign', () => {
    const { files: kept, dropped } = dropForeignOnlyFiles(files, new Set(['src/Barcode.php']), new Set());
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(3);
  });
});

describe('joinFileDiffs', () => {
  /** The filtered diff has to parse exactly like the unfiltered one — the
   * deep scan splits on this same shape. */
  it('rebuilds the blob in the shape everything downstream expects', () => {
    expect(joinFileDiffs([{ path: 'a.ts', diff: '+1' }, { path: 'b.ts', diff: '+2' }])).toBe(
      '--- a.ts ---\n+1\n\n--- b.ts ---\n+2',
    );
  });
});

describe('dropOutOfScopeFindings', () => {
  const changed = ['src/Services/HttpClientService.php', 'src/Controller/SerialBarcodeController.php'];
  const review = (...findings: string[]) =>
    ['Değişiklik seri barkod akışını güncelliyor.', ...findings, 'Verdict: Request changes — bir şey'].join('\n\n');

  it('keeps a finding on a file the change touched', () => {
    const { markdown, dropped } = dropOutOfScopeFindings(
      review('### blocking — src/Services/HttpClientService.php:42\n\nYanlış karşılaştırma.'),
      changed,
    );
    expect(dropped).toHaveLength(0);
    expect(markdown).toContain('HttpClientService.php:42');
  });

  /*
   * The case the whole filter exists to allow: the defect is somewhere the
   * branch never edited, and the branch is what broke it. The prompt asks
   * such a finding to open by naming the line in the diff that puts it in
   * scope, so that citation is what proves the connection.
   */
  it('keeps a finding elsewhere when it names what in the change causes it', () => {
    const { dropped } = dropOutOfScopeFindings(
      review(
        '### blocking — src/Legacy/OrderJob.php:88\n\n' +
          'Bu dal `SerialBarcodeController.php` içindeki uç noktayı siliyor, bu iş onu hâlâ çağırıyor.',
      ),
      changed,
    );
    expect(dropped).toHaveLength(0);
  });

  it('drops a finding elsewhere that never connects itself to the change', () => {
    const { markdown, dropped } = dropOutOfScopeFindings(
      review('### major — src/Legacy/OrderJob.php:88\n\nBu döngü N+1 sorgu yapıyor.'),
      changed,
    );
    expect(dropped).toHaveLength(1);
    expect(markdown).not.toContain('N+1 sorgu');
    // Never silently: what was removed is disclosed in the review itself.
    expect(markdown).toContain('[note] kapsam dışı olduğu için çıkarıldı');
    expect(markdown).toContain('OrderJob.php:88');
  });

  /*
   * The most valuable finding a review produces — "the issue is not
   * implemented" — cites a flow, not a file, because the prompt tells it to.
   * A filter that read "no file cited" as "out of scope" would delete
   * exactly those.
   */
  it('never drops a requirement or flow finding, which cites no file at all', () => {
    const { dropped } = dropOutOfScopeFindings(
      review('### blocking — PDF indirme akışı\n\nIssue PDF indirmeyi istiyor, hiçbir yerde uygulanmamış.'),
      changed,
    );
    expect(dropped).toHaveLength(0);
  });

  it('leaves the verdict alone even when it drops the finding behind it', () => {
    const { markdown } = dropOutOfScopeFindings(
      review('### blocking — src/Legacy/OrderJob.php:88\n\nİlgisiz bir hata.'),
      changed,
    );
    // Rewriting this to Approve would be the tool approving a change on a
    // heuristic. The note says what happened; a human decides.
    expect(markdown).toContain('Verdict: Request changes');
  });

  it('does nothing when the change has no file list to check against', () => {
    const text = review('### major — whatever.php:1\n\nBir şey.');
    expect(dropOutOfScopeFindings(text, [])).toEqual({ markdown: text, dropped: [] });
  });
});
