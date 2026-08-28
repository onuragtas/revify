import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every button that talks to the server must be able to say it was refused.
 *
 * This is the bug this app kept having, in seven places at once: an action
 * posts, the server answers 400 or 409 or never answers at all, and the
 * handler drops it — `.catch(() => {})`, or a `try` with a `finally` and no
 * `catch`. What a person sees is a button that does nothing. Nothing on
 * screen, nothing in the panel, only a line in a devtools console they were
 * never going to open. "Yeniden incele işini yapmıyor gibi" is what that
 * looks like from the outside, and it took a screenshot of the network tab
 * to find.
 *
 * The rule is mechanical because the failure was: a click handler that
 * reaches the server has to have a `catch`, and may not throw the answer
 * away. Background polls are exempt — those are covered by the connection
 * banner, and a failed refresh must not put an error on screen by itself.
 */

const DIR = join(process.cwd(), 'src/web/ui/components');

/** Handlers that a person triggers, and the body of each. */
function clickHandlers(source: string): Array<{ name: string; body: string }> {
  const template = source.slice(source.indexOf('<template>'));
  const names = new Set(
    [...template.matchAll(/@click(?:\.\w+)?="([A-Za-z_$][\w$]*)\s*\(?/g)].map((m) => m[1]),
  );

  return [...names]
    .map((name) => {
      // From the declaration to the first `}` in the first column: these are
      // top-level functions in a `<script setup>` block.
      const start = source.search(new RegExp(`(async )?function ${name}\\b`));
      if (start < 0) return null;
      const end = source.indexOf('\n}', start);
      return { name, body: source.slice(start, end < 0 ? undefined : end) };
    })
    .filter((h): h is { name: string; body: string } => h !== null);
}

const REACHES_SERVER = /fetch\(|await (?:save|start|stop|clear|add|delete|apply|close|read|inspect)[A-Z]/;

describe('actions a person takes', () => {
  it('never throw the server\'s answer away', () => {
    const swallowed: string[] = [];

    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.vue'))) {
      const source = readFileSync(join(DIR, file), 'utf-8');
      for (const { name, body } of clickHandlers(source)) {
        if (!REACHES_SERVER.test(body)) continue;
        if (/\.catch\(\(\) => \{\}\)/.test(body)) swallowed.push(`${file}: ${name} — .catch(() => {})`);
        else if (!/catch/.test(body)) swallowed.push(`${file}: ${name} — no catch`);
      }
    }

    expect(swallowed).toEqual([]);
  });

  it('finds the handlers it is supposed to be checking', () => {
    // A parser that quietly matches nothing would pass this suite forever.
    const detail = readFileSync(join(DIR, 'DetailPane.vue'), 'utf-8');
    const names = clickHandlers(detail).map((h) => h.name);

    expect(names).toEqual(expect.arrayContaining(['start', 'stop', 'clear']));
    expect(clickHandlers(detail).find((h) => h.name === 'stop')!.body).toMatch(REACHES_SERVER);
  });
});
