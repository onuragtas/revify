import { describe, expect, it } from 'vitest';
import { parseFindings, splitFindings, worstSeverity } from './findings.js';

const REVIEW = `Kısa bir giriş cümlesi.

### blocking — src/order/OrderService.ts:88

\`refund()\` transaction dışında çağrılıyor.

\`\`\`diff
-  refund(order);
+  tx.run(() => refund(order));
\`\`\`

**Etki:** İade yazılırken hata olursa sipariş kapalı kalır.

### major — \`src/api/handler.ts:12\`

Null kontrolü eksik.

### minor — src/util/log.ts:4

Log mesajı yanıltıcı.

## Verdict

Verdict: Request changes — iade akışı bozuk.
`;

describe('parseFindings', () => {
  it('splits a review into one entry per finding', () => {
    const findings = parseFindings(REVIEW);
    expect(findings.map((f) => f.severity)).toEqual(['blocking', 'major', 'minor']);
    expect(findings[0].location).toBe('src/order/OrderService.ts:88');
    // Backticks around the location are the reviewer's formatting, not part
    // of the path — the fix path matches these against real file names.
    expect(findings[1].location).toBe('src/api/handler.ts:12');
  });

  it('keeps a finding whole, quoted diff and all', () => {
    const [first] = parseFindings(REVIEW);
    expect(first.body).toContain('tx.run(() => refund(order))');
    expect(first.body).toContain('**Etki:**');
  });

  it('does not swallow the verdict into the last finding', () => {
    const findings = parseFindings(REVIEW);
    expect(findings[2].body).not.toContain('Request changes');
  });

  it('ignores headings inside a fenced block', () => {
    // A change to a markdown file puts real headings in the quoted diff.
    // Cutting the finding there would hand the fixer half of it.
    const review = [
      '### blocking — README.md:3',
      '',
      'Başlık yanlış.',
      '',
      '```diff',
      '-### blocking',
      '+### Kurulum',
      '```',
      '',
      '**Etki:** Belge okunmaz.',
    ].join('\n');

    const findings = parseFindings(review);
    expect(findings).toHaveLength(1);
    expect(findings[0].body).toContain('**Etki:**');
  });

  it('gives each finding an id that identifies it within the review', () => {
    expect(parseFindings(REVIEW).map((f) => f.id)).toEqual(['f0', 'f1', 'f2']);
  });

  it('finds nothing in a review that reported nothing', () => {
    expect(parseFindings('Değişiklik sağlam.\n\nVerdict: Approve')).toEqual([]);
  });
});

describe('worstSeverity', () => {
  it('reports the heaviest finding, not the last one', () => {
    expect(worstSeverity(REVIEW)).toBe('blocking');
  });

  it('is empty when there are no findings', () => {
    expect(worstSeverity('Verdict: Approve')).toBe('');
  });
});

describe('splitFindings', () => {
  it('separates the context, the findings and the verdict', () => {
    const { preamble, findings, tail } = splitFindings(REVIEW);

    expect(preamble).toBe('Kısa bir giriş cümlesi.');
    expect(findings).toHaveLength(3);
    // The verdict belongs to the review, not to whichever finding happens to
    // come last — the UI shows findings as cards and would otherwise bury it.
    expect(tail).toContain('Verdict: Request changes');
    expect(tail).toContain('## Verdict');
  });

  it('still separates the verdict when the review found nothing', () => {
    // No findings, but the verdict is still the review's conclusion rather
    // than part of its opening sentence — and renders after the (empty) list
    // either way.
    const sections = splitFindings('Değişiklik sağlam.\n\nVerdict: Approve');
    expect(sections.findings).toEqual([]);
    expect(sections.preamble).toBe('Değişiklik sağlam.');
    expect(sections.tail).toBe('Verdict: Approve');
  });

  it('does not mistake a heading inside a quoted diff for the end of a finding', () => {
    const review = [
      'Giriş.',
      '',
      '### blocking — README.md:3',
      '',
      '```diff',
      '-## Kurulum',
      '+## Setup',
      '```',
      '',
      'Verdict: Request changes',
    ].join('\n');

    const { preamble, findings, tail } = splitFindings(review);
    expect(preamble).toBe('Giriş.');
    expect(findings).toHaveLength(1);
    expect(findings[0].body).toContain('+## Setup');
    expect(tail).toBe('Verdict: Request changes');
  });
});
