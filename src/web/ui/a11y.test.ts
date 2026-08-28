import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A button whose whole body is a symbol has no accessible name.
 *
 * `title="Kapat"` is a tooltip — it appears on hover and is not reliably
 * announced. A screen reader reaching `✕` says "button", and there were
 * eleven of them: close, back, settings, backup, theme, dismiss. Checked
 * here rather than remembered, because the next icon button will be added
 * by someone who was not in this conversation.
 */
const DIR = 'src/web/ui/components';

const unnamed = readdirSync(DIR)
  .filter((f) => f.endsWith('.vue'))
  .flatMap((file) => {
    const source = readFileSync(join(DIR, file), 'utf8');
    return [...source.matchAll(/<button([\s\S]*?)>([\s\S]*?)<\/button>/g)]
      .filter((m) => {
        // An interpolated body renders real text; only a bare symbol is mute.
        if (/\{\{/.test(m[2])) return false;
        const body = m[2].replace(/<[^>]*>/g, '').trim();
        return body.length <= 2 && !/aria-label/.test(m[1]);
      })
      .map((m) => `${file}: ${m[2].trim()}`);
  });

describe('icon buttons', () => {
  it('all have a name a screen reader can say', () => {
    expect(unnamed).toEqual([]);
  });
});
