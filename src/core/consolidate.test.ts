import { describe, it, expect } from 'vitest';
import {
  applyConsolidation,
  buildConsolidationPrompt,
  parseConsolidation,
  MAX_DROP_SHARE,
} from './consolidate.js';
import type { Finding } from './findings.js';

const finding = (n: number, severity: Finding['severity'] = 'major'): Finding => ({
  id: `f${n}`,
  severity,
  location: `src/a.php:${n}`,
  heading: `${severity} — src/a.php:${n}`,
  body: `Bulgu ${n}.`,
});

describe('buildConsolidationPrompt', () => {
  it('numbers the findings, because the answer refers to them by index', () => {
    const prompt = buildConsolidationPrompt([finding(1), finding(2)], { key: 'BUY-1', summary: 'X' });
    expect(prompt).toContain('[0] major — src/a.php:1');
    expect(prompt).toContain('[1] major — src/a.php:2');
    expect(prompt).toContain('BUY-1 — X');
    // The instruction that keeps it from becoming a second reviewer.
    expect(prompt).toContain('Sayı hedefi yok');
  });
});

describe('parseConsolidation', () => {
  it('reads the drop lines and their reasons', () => {
    const drops = parseConsolidation('DROP 2 — 0 ile aynı defect\nDROP 5 — defect değil, gözlem', 6);
    expect(drops).toEqual([
      { index: 2, reason: '0 ile aynı defect' },
      { index: 5, reason: 'defect değil, gözlem' },
    ]);
  });

  it('accepts the shapes a model actually writes', () => {
    expect(parseConsolidation('- DROP 1: tekrar\n* drop 3', 4)).toEqual([
      { index: 1, reason: 'tekrar' },
      { index: 3, reason: 'tekrar' },
    ]);
  });

  /*
   * A malformed answer has to cost the review nothing. The failure being
   * guarded against is not a bad parse — it is a finding disappearing
   * because of one.
   */
  it('ignores anything that is not a drop line, and any index out of range', () => {
    expect(parseConsolidation('Bence hepsi kalmalı.', 3)).toEqual([]);
    expect(parseConsolidation('DROP 9 — yok böyle bir bulgu\nDROP -1 — hayır', 3)).toEqual([]);
  });

  it('counts a repeated index once', () => {
    expect(parseConsolidation('DROP 1 — a\nDROP 1 — b', 3)).toEqual([{ index: 1, reason: 'a' }]);
  });
});

describe('applyConsolidation', () => {
  const findings = [finding(1), finding(2), finding(3), finding(4)];

  it('removes exactly what was named and keeps the rest verbatim', () => {
    const { kept, dropped } = applyConsolidation(findings, [{ index: 1, reason: 'tekrar' }]);
    expect(kept.map((f) => f.id)).toEqual(['f1', 'f3', 'f4']);
    expect(dropped).toEqual([{ finding: findings[1], reason: 'tekrar' }]);
  });

  /*
   * A consolidation that wants to delete most of the review has
   * misunderstood the job. Discarding the pass leaves the review we already
   * shipped; trusting it leaves a review missing two thirds of its findings
   * with nothing on the outside to show for it.
   */
  it('refuses a consolidation that wants to remove too much', () => {
    const drops = findings.map((_, index) => ({ index, reason: 'gereksiz' }));
    const { kept, dropped } = applyConsolidation(findings, drops);
    expect(kept).toHaveLength(4);
    expect(dropped).toHaveLength(0);
    expect(MAX_DROP_SHARE).toBeLessThan(1);
  });

  it('does nothing when nothing was dropped', () => {
    expect(applyConsolidation(findings, [])).toEqual({ kept: findings, dropped: [] });
  });
});
