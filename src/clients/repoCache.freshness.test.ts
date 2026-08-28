import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_FRESH_MS, RepoCache } from './repoCache.js';

/**
 * Context repositories go stale, and a stale one is worse than none.
 *
 * `codeReview.md` tells the model to grep these and *"treat what you find as
 * fact"*. Until this, a repo already sitting on its default branch was never
 * fetched again — so a checkout made in March answered questions in August,
 * and the review stated the answer plainly.
 */
let root: string;
let origin: string;
let cache: RepoCache;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

function metaFor(projectPath: string): Record<string, string> {
  const meta = JSON.parse(readFileSync(join(root, 'cache', '.cache-meta.json'), 'utf-8'));
  return meta[projectPath];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revify-fresh-'));
  // `remoteUrl` appends `.git`, so the fixture has to be named for it.
  origin = join(root, 'origin.git');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'config', 'user.email', 'test@example.invalid');
  git(origin, 'config', 'user.name', 'Test');
  writeFileSync(join(origin, 'app.ts'), 'export const rate = 1;\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'first');

  // A file:// remote is the only kind a shallow clone accepts locally.
  cache = new RepoCache(join(root, 'cache'), `file://${root}`, 'unused-token');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('ensureDefaultBranch', () => {
  it('records when it last spoke to the remote', async () => {
    await cache.ensureDefaultBranch('origin', 'main');
    expect(Date.parse(metaFor('origin').fetchedAt)).toBeGreaterThan(Date.now() - 10_000);
  });

  it('does not touch the network again inside the window', async () => {
    const dir = await cache.ensureDefaultBranch('origin', 'main');
    const before = metaFor('origin').fetchedAt;

    // Something new upstream that a second fetch would bring down.
    writeFileSync(join(origin, 'app.ts'), 'export const rate = 2;\n');
    git(origin, 'commit', '-aqm', 'second');

    await cache.ensureDefaultBranch('origin', 'main');
    expect(metaFor('origin').fetchedAt).toBe(before);
    expect(readFileSync(join(dir, 'app.ts'), 'utf-8')).toContain('rate = 1');
  });

  it('fetches once the window has passed, and picks up what moved', async () => {
    const dir = await cache.ensureDefaultBranch('origin', 'main');

    writeFileSync(join(origin, 'app.ts'), 'export const rate = 2;\n');
    git(origin, 'commit', '-aqm', 'second');

    // Rewind the record rather than the clock: the same thing an app left
    // open overnight sees.
    const metaPath = join(root, 'cache', '.cache-meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    meta.origin.fetchedAt = new Date(Date.now() - CONTEXT_FRESH_MS - 1000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta));

    const refreshed = new RepoCache(join(root, 'cache'), `file://${root}`, 'unused-token');
    await refreshed.ensureDefaultBranch('origin', 'main');

    expect(readFileSync(join(dir, 'app.ts'), 'utf-8')).toContain('rate = 2');
  });

  it('treats a checkout from before this was recorded as stale', async () => {
    await cache.ensureDefaultBranch('origin', 'main');
    const metaPath = join(root, 'cache', '.cache-meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    delete meta.origin.fetchedAt;
    writeFileSync(metaPath, JSON.stringify(meta));

    writeFileSync(join(origin, 'app.ts'), 'export const rate = 3;\n');
    git(origin, 'commit', '-aqm', 'third');

    const refreshed = new RepoCache(join(root, 'cache'), `file://${root}`, 'unused-token');
    const dir = await refreshed.ensureDefaultBranch('origin', 'main');
    expect(readFileSync(join(dir, 'app.ts'), 'utf-8')).toContain('rate = 3');
  });

  it('keeps what is on disk when the remote cannot be reached', async () => {
    // A context repo that could not be refreshed is still the code the last
    // review read; dropping it from the run would be the worse trade.
    const dir = await cache.ensureDefaultBranch('origin', 'main');
    rmSync(origin, { recursive: true, force: true });

    const metaPath = join(root, 'cache', '.cache-meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    delete meta.origin.fetchedAt;
    writeFileSync(metaPath, JSON.stringify(meta));

    const offline = new RepoCache(join(root, 'cache'), `file://${root}`, 'unused-token');
    await expect(offline.ensureDefaultBranch('origin', 'main')).resolves.toBe(dir);
  });
});
