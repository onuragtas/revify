import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every rule in the stylesheet still has something to style.
 *
 * The design lives in one `<style>` block that the components read; nothing
 * ties the two together, so a component can quietly stop using a hook and
 * the rule it depended on becomes a lie. That is not a tidiness problem — it
 * is how a *visual* regression hides. The migration produced several: the
 * back button lost the rule that hides it on a wide window, the narrow
 * layout lost the class that gives the detail pane the screen, and the
 * dispute list lost the block that renders a finding in full.
 *
 * None of those were visible to a test that counts controls. An orphaned
 * rule is.
 */
const page = readFileSync('src/web/public/index.html', 'utf8');
const css = readFileSync('src/web/public/app.css', 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')
        ? [readFileSync(join(dir, entry.name), 'utf8')]
        : [],
  );
}

const markup = [...sources('src/web/ui'), page].join('\n');

/** `badge-${status}`, `sev-${severity}` — a class assembled at runtime never
 * appears whole in the source, so its family is judged by its prefix. */
const composedPrefixes = [...markup.matchAll(/`?([a-zA-Z][\w-]*-)\$\{/g)].map((m) => m[1]);
const isUsed = (name: string) =>
  new RegExp(`\\b${name}\\b`).test(markup) || composedPrefixes.some((p) => name.startsWith(p));

describe('the stylesheet', () => {
  it('has no rule for an id nothing renders', () => {
    const ids = new Set(
      [...css.matchAll(/#([a-zA-Z][\w-]*)/g)]
        .map((m) => m[1])
        // `#a5b4fc` is a colour, not a selector.
        .filter((id) => !/^[0-9a-fA-F]{3,8}$/.test(id)),
    );
    expect([...ids].filter((id) => !isUsed(id))).toEqual([]);
  });

  it('has no rule for a class nothing renders', () => {
    const classes = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    expect([...classes].filter((name) => !isUsed(name))).toEqual([]);
  });
});

describe('the page', () => {
  it('carries no inline script and no inline style', () => {
    // Both are what `script-src 'self'` and `style-src 'self'` forbid. The
    // policy is only worth having if the page can live under it.
    expect(page).not.toContain('<style>');
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(page).not.toMatch(/\sstyle="/);
  });

  it('links the stylesheet the components are written against', () => {
    expect(page).toContain('app.css');
  });
});
