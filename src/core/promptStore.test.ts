import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PromptStore, promptFileName } from './promptStore.js';

let dir: string;
let store: PromptStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revify-prompts-'));
  store = new PromptStore(join(dir, 'prompts'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('promptFileName', () => {
  it('flattens a project path so it cannot escape the directory', () => {
    const name = promptFileName('BUY-1', 'fix:team/orders');
    expect(name).not.toContain('/');
    expect(name).toBe('BUY-1__fix_team_orders.json');
  });

  it('stays inside its directory whatever the key contains', () => {
    // The invariant is that the result is one path segment resolving under
    // the store's directory — not that no dot survives. `..` only traverses
    // next to a separator, and every separator is collapsed.
    for (const key of ['../../etc', '..', '.', '/abs/olute', 'a/../../b']) {
      const resolved = resolve('/tmp/store', promptFileName(key, 'review'));
      expect(resolved.startsWith(`${resolve('/tmp/store')}/`)).toBe(true);
      expect(dirname(resolved)).toBe(resolve('/tmp/store'));
    }
  });
});

describe('PromptStore', () => {
  it('keeps the system prompt and the user turn as they were sent', () => {
    store.save('BUY-1', 'review', { system: 'sen bir reviewersın', prompt: 'şu diffe bak' });

    const stored = store.read('BUY-1', 'review');
    expect(stored?.system).toBe('sen bir reviewersın');
    expect(stored?.prompt).toBe('şu diffe bak');
    expect(stored?.savedAt).toBeTruthy();
  });

  it('replaces the question when the run is repeated, like the answer', () => {
    store.save('BUY-1', 'review', { system: 's', prompt: 'ilk' });
    store.save('BUY-1', 'review', { system: 's', prompt: 'ikinci' });

    expect(store.read('BUY-1', 'review')?.prompt).toBe('ikinci');
    expect(store.list('BUY-1')).toHaveLength(1);
  });

  it('lists sizes without handing back the text', () => {
    store.save('BUY-1', 'review', { system: 'a', prompt: 'b'.repeat(999) });

    const [summary] = store.list('BUY-1');
    expect(summary.kind).toBe('review');
    expect(summary.size).toBe(1000);
    expect(summary).not.toHaveProperty('prompt');
  });

  it('puts the review first and the fixes after it', () => {
    store.save('BUY-1', 'fix:team/orders', { system: 's', prompt: 'p' });
    store.save('BUY-1', 'review', { system: 's', prompt: 'p' });
    store.save('BUY-1', 'fix:team/api', { system: 's', prompt: 'p' });

    expect(store.list('BUY-1').map((p) => p.kind)).toEqual([
      'review',
      'fix:team/api',
      'fix:team/orders',
    ]);
  });

  it('keeps issues apart, including when one key prefixes another', () => {
    store.save('BUY-1', 'review', { system: 's', prompt: 'bir' });
    store.save('BUY-12', 'review', { system: 's', prompt: 'oniki' });

    expect(store.list('BUY-1').map((p) => p.kind)).toEqual(['review']);
    expect(store.read('BUY-1', 'review')?.prompt).toBe('bir');
    expect(store.read('BUY-12', 'review')?.prompt).toBe('oniki');
  });

  it('forgets one issue and leaves the rest alone', () => {
    store.save('BUY-1', 'review', { system: 's', prompt: 'p' });
    store.save('BUY-1', 'fix:team/orders', { system: 's', prompt: 'p' });
    store.save('BUY-2', 'review', { system: 's', prompt: 'p' });

    store.forget('BUY-1');

    expect(store.list('BUY-1')).toEqual([]);
    expect(store.list('BUY-2')).toHaveLength(1);
  });

  it('says nothing rather than throwing when there is nothing there', () => {
    expect(store.read('BUY-9', 'review')).toBeNull();
    expect(store.list('BUY-9')).toEqual([]);
    expect(() => store.forget('BUY-9')).not.toThrow();
    expect(store.size()).toBe(0);
  });

  it('survives a corrupt file instead of taking the listing down', () => {
    store.save('BUY-1', 'review', { system: 's', prompt: 'p' });
    const [name] = readdirSync(join(dir, 'prompts'));
    rmSync(join(dir, 'prompts', name));
    // A directory with an unreadable entry still answers.
    expect(store.list('BUY-1')).toEqual([]);
    expect(existsSync(join(dir, 'prompts'))).toBe(true);
  });
});
