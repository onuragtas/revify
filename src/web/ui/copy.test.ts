import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Copy that points somewhere must point somewhere that exists.
 *
 * The fix panel said "ilerleme **Adımlar** sekmesinde" for a while after the
 * tabs went from seven to four and Adımlar became part of Süreç. Nothing
 * caught it: a renamed tab is a string in one file and a sentence in
 * another, and only a person reading the screen connects them.
 *
 * So the sentences are checked against the tabs. This is deliberately
 * narrow — it does not try to validate prose, only the one thing that goes
 * stale every time the layout changes: a name followed by the word "sekme".
 */

const DIR = join(process.cwd(), 'src/web/ui/components');

/** The tab labels the app actually renders, read from where they are
 * declared rather than repeated here — a second list would be the one that
 * goes stale. */
function tabLabels(): string[] {
  const sources = ['DetailPane.vue', 'TopBar.vue'].map((f) => readFileSync(join(DIR, f), 'utf-8'));
  return sources.flatMap((s) => {
    const block = s.slice(s.indexOf('const TABS'), s.indexOf('] as const'));
    return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  });
}

/** Every "<X> sekmesi/sekmesinde/sekmesine" in a template, X extracted. */
function tabMentions(file: string): string[] {
  const source = readFileSync(join(DIR, file), 'utf-8');
  const template = source.slice(source.indexOf('<template>'));
  return [...template.matchAll(/([A-Za-zÇĞİÖŞÜçğıöşü]+)<\/b>\s*sekme|([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+sekme/g)].map(
    (m) => m[1] ?? m[2],
  );
}

describe('user-facing copy', () => {
  it('never sends the reader to a tab that does not exist', () => {
    const labels = tabLabels();
    const wrong: string[] = [];

    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.vue'))) {
      for (const mention of tabMentions(file)) {
        if (!labels.includes(mention)) wrong.push(`${file}: "${mention} sekmesi"`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('reads the real tab list, so the check cannot pass vacuously', () => {
    // If the extraction broke, every mention would be "wrong" — or, worse,
    // an empty label list would make nothing wrong at all.
    expect(tabLabels()).toEqual(expect.arrayContaining(['Review', 'Süreç', 'Yama', 'İncelemeler']));
  });
});
