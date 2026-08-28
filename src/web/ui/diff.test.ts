import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, toUnifiedRows, type UnifiedRow } from './diff';

const DIFF = [
  'diff --git a/app.ts b/app.ts',
  '--- a/app.ts',
  '+++ b/app.ts',
  '@@ -10,4 +10,4 @@ function total() {',
  ' const a = 1;',
  '-const rate = 1;',
  '+const rate = 2;',
  ' return a * rate;',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('pairs a deletion with the insertion that replaced it', () => {
    // A unified diff lists every `-` then every `+`; split view needs them
    // side by side, which is the whole reason this pass exists.
    const rows = parseUnifiedDiff(DIFF);
    const mod = rows.find((r) => r.type === 'mod');

    expect(mod).toMatchObject({ oldText: 'const rate = 1;', newText: 'const rate = 2;' });
  });

  it('numbers lines from the hunk header, on both sides', () => {
    const rows = parseUnifiedDiff(DIFF);
    expect(rows.filter((r) => r.type === 'ctx')[0]).toMatchObject({ oldNo: 10, newNo: 10 });
    expect(rows.find((r) => r.type === 'mod')).toMatchObject({ oldNo: 11, newNo: 11 });
  });

  it('drops the file headers, which the file name already says', () => {
    const text = JSON.stringify(parseUnifiedDiff(DIFF));
    expect(text).not.toContain('diff --git');
    expect(text).not.toContain('+++ b/app.ts');
  });

  it('keeps the hunk header as its own row', () => {
    expect(parseUnifiedDiff(DIFF)[0]).toMatchObject({ type: 'hunk' });
    expect(parseUnifiedDiff(DIFF)[0].text).toContain('@@ -10,4 +10,4 @@');
  });

  it('reports an unpaired deletion and insertion as themselves', () => {
    const rows = parseUnifiedDiff('@@ -1,1 +1,2 @@\n-gitti\n+geldi\n+bir de bu\n');
    expect(rows.map((r) => r.type)).toEqual(['hunk', 'mod', 'add']);
  });

  it('ignores the no-newline marker, which is metadata not content', () => {
    const rows = parseUnifiedDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n');
    expect(rows.filter((r) => r.type !== 'hunk')).toHaveLength(1);
  });

  it('survives an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('toUnifiedRows', () => {
  it('splits a modification back into the two changes it really is', () => {
    // One row side by side, but two changes in truth — unified shows both so
    // you can read what actually replaced what.
    const rows = toUnifiedRows(parseUnifiedDiff(DIFF)).filter((r) => !('type' in r)) as UnifiedRow[];
    const changed = rows.filter((r) => r.cls !== 'ctx');

    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatchObject({ cls: 'del', mark: '−', newNo: null, text: 'const rate = 1;' });
    expect(changed[1]).toMatchObject({ cls: 'add', mark: '+', oldNo: null, text: 'const rate = 2;' });
  });

  it('passes a hunk header through untouched', () => {
    expect(toUnifiedRows(parseUnifiedDiff(DIFF))[0]).toMatchObject({ type: 'hunk' });
  });
});
