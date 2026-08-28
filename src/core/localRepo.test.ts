import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotARepositoryError, projectPathFromRemote, readLocalChange, splitByFile } from './localRepo.js';

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revify-repo-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'first');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readLocalChange', () => {
  it('reports what the branch added, not what the base added meanwhile', async () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 2;\n');
    git('commit', '-aqm', 'change on the branch');

    // A commit on main after the branch started. A two-dot diff would
    // report this teammate's work as part of the change under review.
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'other.ts'), 'export const b = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'someone else');
    git('checkout', '-q', 'feature');

    const change = await readLocalChange(dir);
    expect(change.branch).toBe('feature');
    expect(change.baseBranch).toBe('main');
    expect(change.committedDiff).toContain('export const a = 2');
    expect(change.committedDiff).not.toContain('other.ts');
  });

  it('includes work that is not committed yet', async () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 3;\n');

    // The uncommitted half is the half most likely to be wrong; a review
    // that silently skipped it would be confident about code the author is
    // not about to push.
    const change = await readLocalChange(dir);
    expect(change.workingDiff).toContain('export const a = 3');
  });

  it('sees a file git has never been told about', async () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'brand-new.ts'), 'export const c = 1;\n');

    const change = await readLocalChange(dir);
    expect(change.workingDiff).toContain('brand-new.ts');
    expect(change.workingDiff).toContain('export const c = 1');
  });

  it('works from a subdirectory of the repository', async () => {
    const sub = join(dir, 'src');
    execFileSync('mkdir', ['-p', sub]);
    writeFileSync(join(sub, 'deep.ts'), 'export const d = 1;\n');

    const change = await readLocalChange(sub);
    expect(change.path).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir }).toString().trim());
  });

  it('refuses a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'revify-plain-'));
    await expect(readLocalChange(plain)).rejects.toBeInstanceOf(NotARepositoryError);
    await expect(readLocalChange(join(plain, 'nope'))).rejects.toBeInstanceOf(NotARepositoryError);
    rmSync(plain, { recursive: true, force: true });
  });

  it('names the project the way the Jira path would', async () => {
    git('remote', 'add', 'origin', 'git@gitlab.example.com:backend-team/EPA.git');
    const change = await readLocalChange(dir);

    // Same identity as a Jira-started review, so a repo-scoped note
    // applies however the review began.
    expect(change.projectPath).toBe('backend-team/EPA');
  });

  it('falls back to the directory name without a remote', async () => {
    const change = await readLocalChange(dir);
    expect(change.projectPath).toBe(dir.split('/').pop());
  });
});

describe('projectPathFromRemote', () => {
  it('reads both URL shapes', () => {
    expect(projectPathFromRemote('git@gitlab.example.com:team/repo.git')).toBe('team/repo');
    expect(projectPathFromRemote('https://gitlab.example.com/team/sub/repo.git')).toBe('team/sub/repo');
    expect(projectPathFromRemote('not a url')).toBeNull();
  });
});

describe('splitByFile', () => {
  it('cuts a combined diff at its file headers', () => {
    const diff = [
      'diff --git a/one.ts b/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.ts b/two.ts',
      '@@ -1 +1 @@',
      '-c',
      '+d',
    ].join('\n');

    expect(splitByFile(diff).map((f) => f.path)).toEqual(['one.ts', 'two.ts']);
    expect(splitByFile(diff)[0].diff).toContain('+b');
  });
});

describe('readLocalChange — the base branch', () => {
  /**
   * Nobody fetches before asking for a review.
   *
   * Left alone, `origin/main` is whatever was last pulled — so a branch cut
   * from a week-old base is diffed against that week-old commit, and every
   * change a colleague merged since is reported as part of this one. That is
   * not a slow review; it is a wrong one.
   */
  let origin: string;

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), 'revify-origin-'));
    execFileSync('git', ['init', '-q', '-b', 'main', '--bare', origin], { stdio: 'pipe' });
    git('remote', 'add', 'origin', origin);
    git('push', '-q', 'origin', 'main');
  });
  afterEach(() => rmSync(origin, { recursive: true, force: true }));

  it('brings the base branch up to date before measuring against it', async () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 2;\n');
    git('commit', '-aqm', 'my change');

    // Someone else moves main and pushes. This clone knows nothing of it
    // until something fetches — and nobody fetches before asking for a
    // review.
    const other = mkdtempSync(join(tmpdir(), 'revify-other-'));
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: other, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: other, stdio: 'pipe' });
    writeFileSync(join(other, 'theirs.ts'), 'export const theirs = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: other, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'their change'], { cwd: other, stdio: 'pipe' });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other, stdio: 'pipe' });
    const upstream = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: other, stdio: 'pipe' })
      .toString()
      .trim();
    rmSync(other, { recursive: true, force: true });

    const before = git('rev-parse', 'origin/main').trim();
    expect(before).not.toBe(upstream);

    await readLocalChange(dir);

    // The base a review is measured against is now the base that exists.
    expect(git('rev-parse', 'origin/main').trim()).toBe(upstream);
  });

  it('still reviews when the remote cannot be reached', async () => {
    // Refusing to review because a remote is unreachable would be worse than
    // reviewing against a slightly old base.
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'app.ts'), 'export const a = 9;\n');
    git('commit', '-aqm', 'change');
    rmSync(origin, { recursive: true, force: true });

    const change = await readLocalChange(dir);
    expect(change.committedDiff).toContain('export const a = 9');
  });
});
