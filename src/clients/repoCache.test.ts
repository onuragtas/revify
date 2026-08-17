import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheDirName, readRemoteProjectPath } from './repoCache.js';

describe('cacheDirName', () => {
  it('flattens a nested project path into one safe directory name', () => {
    expect(cacheDirName('backend-team/EPA_API')).toBe('backend-team__EPA_API');
  });

  it('flattens deeply nested subgroups', () => {
    expect(cacheDirName('org/team/repo')).toBe('org__team__repo');
  });

  it('leaves an already-safe name untouched', () => {
    expect(cacheDirName('my-repo.v2')).toBe('my-repo.v2');
  });

  it('leaves no path separator that could escape the cache directory', () => {
    const name = cacheDirName('../../etc/passwd');

    expect(name).toBe('..__..__etc__passwd');
    expect(name).not.toContain('/');
  });

  it('rejects a path that would flatten to a directory-traversing name', () => {
    expect(() => cacheDirName('..')).toThrow(/Unsafe repository path/);
    expect(() => cacheDirName('.')).toThrow(/Unsafe repository path/);
    expect(() => cacheDirName('')).toThrow(/Unsafe repository path/);
  });

  it('maps a bare separator to an inert directory name', () => {
    expect(cacheDirName('/')).toBe('__');
  });
});


describe('readRemoteProjectPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-reviewer-repo-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (url: string) =>
    writeFileSync(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`, 'utf-8');

  it('recovers the project path from the origin remote', () => {
    writeConfig('https://gitlab.example.com/backend-team/EPA_API.git');
    expect(readRemoteProjectPath(dir)).toBe('backend-team/EPA_API');
  });

  it('handles nested subgroups and a missing .git suffix', () => {
    writeConfig('https://gitlab.example.com/org/team/repo');
    expect(readRemoteProjectPath(dir)).toBe('org/team/repo');
  });

  // The directory name flattens `/` to `__`, so it cannot be reversed —
  // the remote is the only reliable source of the real path.
  it('returns null when there is no git config to read', () => {
    expect(readRemoteProjectPath(dir)).toBeNull();
  });
});
