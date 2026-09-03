import type { Finding } from './findings.js';

/**
 * One reader over the whole finding list, after the passes are done.
 *
 * A deep scan's limits are per pass, and that is the whole of the volume
 * problem: "minor findings: three at most" is three *per slice*, so eleven
 * slices carry a budget of thirty-three, and blocking and major are
 * uncapped by design because a defect left out is one that ships. Measured
 * on real reviews: a single pass returns four or five findings, an
 * eleven-slice run returned fifty-seven — with the same file named six
 * times over, because no pass can see what another already wrote.
 *
 * Merging cannot fix that. It matches on severity and location, so the same
 * defect described twice at two line numbers survives twice, and a pass
 * that spent its own budget on trivia has already spent it.
 *
 * So the consolidation is a reader, not another reviewer: it sees every
 * finding at once, which is the one vantage point no pass has.
 *
 * It decides; it never writes. The model returns the indexes to drop and a
 * reason for each, and the code removes exactly those — the surviving
 * findings keep the words the pass that found them wrote. A consolidation
 * that regenerated the review would be free to reword a diagnosis, soften a
 * severity or invent a line number, and there would be no way to tell that
 * from a faithful merge.
 */

export interface ConsolidationDrop {
  index: number;
  reason: string;
}

/** The lightest possible contract: one line per drop. Parsing is
 * deliberately forgiving — a consolidation whose output does not parse must
 * cost the review nothing, so anything unrecognised is simply not a drop. */
const DROP_LINE = /^\s*(?:[-*]\s*)?DROP\s+(\d+)\s*(?:[—–:-]\s*(.*))?$/gim;

export function buildConsolidationPrompt(
  findings: Finding[],
  issue: { key: string; summary: string },
): string {
  const list = findings
    .map((f, i) => `[${i}] ${f.severity} — ${f.location}\n${f.body.trim()}`)
    .join('\n\n---\n\n');

  return (
    `Bir kod review'ı ${findings.length} bulgu üretti. Bulgular değişikliğin parçalara bölünmüş\n` +
    'hâlini okuyan birden fazla geçişten geliyor; hiçbir geçiş diğerinin ne yazdığını görmedi.\n' +
    'Senin işin bu listeyi bir bütün olarak okuyup **hangilerinin çıkarılacağına** karar vermek.\n\n' +
    `## İş: ${issue.key} — ${issue.summary}\n\n` +
    '## Çıkar\n\n' +
    '- **Tekrarlar.** Aynı defect iki geçiş tarafından farklı satır numarasıyla ya da farklı\n' +
    '  kelimelerle yazılmış olabilir. Birini tut, diğerini çıkar — tuttuğun, sorunu daha somut\n' +
    '  anlatan olsun.\n' +
    '- **Aynı kökün belirtileri.** Tek bir hata birkaç yerde görünüyorsa, kökü anlatan bulguyu\n' +
    '  tut, aynı şeyi tekrar eden türevleri çıkar.\n' +
    '- **Defect olmayanlar.** Gözlem, yeniden ifade, "şuna da bakılabilir" türü notlar, stil\n' +
    '  tercihleri. Somut bir bozulma tarif etmeyen bulgu çıkar.\n\n' +
    '## Asla çıkarma\n\n' +
    '- Ayrı ayrı gerçek olan defect\'leri. Sayı hedefi yok — geriye kırk bulgu kalıyorsa kırk\n' +
    '  bulgu kalır. Amaç listeyi kısaltmak değil, aynı şeyi iki kez söylememek.\n' +
    '- Gereksinim ve akış bulgularını ("issue şunu istiyor, uygulanmamış").\n' +
    '- Emin olmadıklarını. Tereddüt varsa bulgu kalır.\n\n' +
    '## Çıktı\n\n' +
    'Yalnızca çıkarılacaklar için birer satır yaz, başka hiçbir şey yazma:\n\n' +
    '```\n' +
    'DROP <index> — <tek cümle gerekçe>\n' +
    '```\n\n' +
    'Çıkarılacak bir şey yoksa hiçbir satır yazma.\n\n' +
    '## Bulgular\n\n' +
    list +
    '\n'
  );
}

/**
 * Reads the drop list back.
 *
 * Out-of-range and repeated indexes are ignored rather than treated as an
 * error: the cost of a malformed answer has to be a review that was not
 * consolidated, never a review that lost a finding to a parsing accident.
 */
export function parseConsolidation(answer: string, count: number): ConsolidationDrop[] {
  const drops = new Map<number, string>();
  for (const match of String(answer ?? '').matchAll(DROP_LINE)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    if (!drops.has(index)) drops.set(index, (match[2] ?? '').trim() || 'tekrar');
  }
  return [...drops].map(([index, reason]) => ({ index, reason })).sort((a, b) => a.index - b.index);
}

/**
 * The guard on the whole idea.
 *
 * A consolidation that wants to remove most of the review has misunderstood
 * its job — it was asked to remove repetition, and repetition is not most of
 * a review. Rather than trust it that far, the pass is discarded entirely:
 * an un-consolidated review is the thing we already ship, while a review
 * with two thirds of its findings gone is a quiet failure nobody can see
 * from the outside.
 */
export const MAX_DROP_SHARE = 0.5;

export function applyConsolidation(
  findings: Finding[],
  drops: ConsolidationDrop[],
): { kept: Finding[]; dropped: Array<{ finding: Finding; reason: string }> } {
  if (!drops.length || drops.length > findings.length * MAX_DROP_SHARE) {
    return { kept: findings, dropped: [] };
  }
  const byIndex = new Map(drops.map((d) => [d.index, d.reason]));
  const kept: Finding[] = [];
  const dropped: Array<{ finding: Finding; reason: string }> = [];
  findings.forEach((finding, index) => {
    const reason = byIndex.get(index);
    if (reason === undefined) kept.push(finding);
    else dropped.push({ finding, reason });
  });
  return { kept, dropped };
}
