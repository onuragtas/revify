import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every component the app can actually show.
 *
 * `FixModal.vue` existed, compiled, type-checked and had eight tests of its
 * own — and no parent rendered it. Pressing "Düzelt…" set the flag it
 * watches and nothing appeared, because nothing was mounted to appear.
 * Every one of those tests mounted the component directly, which is exactly
 * the blind spot: a component with tests but no mount point is invisible to
 * a suite that only ever mounts it on purpose.
 *
 * So this walks the import graph from `App.vue` and insists every component
 * is on it. Being reachable is not proof that a component works — but being
 * unreachable is proof that it cannot.
 */

const DIR = join(process.cwd(), 'src/web/ui/components');

/** Components mounted by the runtime rather than by a parent. */
const ROOTS = ['App.vue'];

function importsOf(file: string): string[] {
  const source = readFileSync(join(DIR, file), 'utf-8');
  return [...source.matchAll(/from\s+'\.\/([A-Za-z0-9_]+\.vue)'/g)].map((m) => m[1]);
}

function reachable(): Set<string> {
  const seen = new Set<string>(ROOTS);
  const queue = [...ROOTS];
  while (queue.length) {
    for (const next of importsOf(queue.pop()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('the component graph', () => {
  it('can reach every component from App', () => {
    const all = readdirSync(DIR).filter((f) => f.endsWith('.vue'));
    const orphans = all.filter((f) => !reachable().has(f));

    expect(orphans).toEqual([]);
  });

  it('would have caught the modal nobody rendered', () => {
    // The check is only worth having if it fails on the thing it exists for.
    const seen = reachable();
    expect(seen.has('FixModal.vue')).toBe(true);
    expect(importsOf('Overlays.vue')).toContain('FixModal.vue');
  });
});
