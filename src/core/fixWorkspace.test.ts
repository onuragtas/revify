import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFixPatch,
  createFixWorkspace,
  extractFixPatch,
  filesInPatch,
  parseNumstat,
  removeFixWorkspace,
} from './fixWorkspace.js';

let root: string;
let source: string;
let workspace: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

const FILE = [
  'export const rate = {{rate}};',
  '',
  'export function total(items: number[]): number {',
  '  return items.reduce((sum, n) => sum + n, 0) * rate;',
  '}',
  '',
  'export function label(): string {',
  "  return 'total';",
  '}',
  '',
].join('\n');

function makeRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  // Several lines, so a change at the top and a change at the bottom are
  // genuinely far apart — a one-line file makes every edit a conflict and
  // would test git's context window rather than this module.
  writeFileSync(join(dir, 'app.ts'), FILE.replace('{{rate}}', '1'));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'revify-fix-'));
  source = join(root, 'source');
  workspace = join(root, 'work', 'ws');
  execFileSync('mkdir', ['-p', source]);
  makeRepo(source);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('createFixWorkspace', () => {
  it('is a copy, so editing it never touches what it came from', async () => {
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);

    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    expect(readFileSync(join(source, 'app.ts'), 'utf-8')).toBe(FILE.replace('{{rate}}', '1'));
  });

  it('carries uncommitted work in, because that is what was reviewed', async () => {
    // A directory review reads staged, unstaged and brand-new files alike.
    // A fix that started from HEAD would be a fix for code the author has
    // already moved past.
    writeFileSync(join(source, 'app.ts'), FILE.replace('{{rate}}', '5'));
    writeFileSync(join(source, 'new.ts'), 'export const fresh = true;\n');

    await createFixWorkspace({ dir: source, includeWorkingTree: true }, workspace);

    expect(readFileSync(join(workspace, 'app.ts'), 'utf-8')).toBe(FILE.replace('{{rate}}', '5'));
    expect(readFileSync(join(workspace, 'new.ts'), 'utf-8')).toBe('export const fresh = true;\n');
  });

  it('starts clean, so a later diff means the fix and nothing else', async () => {
    writeFileSync(join(source, 'app.ts'), FILE.replace('{{rate}}', '5'));
    await createFixWorkspace({ dir: source, includeWorkingTree: true }, workspace);

    const { patch, stats } = await extractFixPatch(workspace);
    expect(patch).toBe('');
    expect(stats.files).toBe(0);
  });

  it('refuses a directory that is not a repository', async () => {
    await expect(
      createFixWorkspace({ dir: root, includeWorkingTree: false }, workspace),
    ).rejects.toThrow(/git deposu değil/);
  });
});

describe('extractFixPatch', () => {
  it('reports what the fixer changed', async () => {
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));

    const { patch, stats } = await extractFixPatch(workspace);
    expect(patch).toContain('-export const rate = 1;');
    expect(patch).toContain('+export const rate = 2;');
    expect(stats).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });

  it('includes a file the fixer created', async () => {
    // Without `add -A` a new file is invisible to `git diff`, and the fix
    // would report success while the patch silently omitted half of it.
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'guard.ts'), 'export const guard = () => true;\n');

    const { patch } = await extractFixPatch(workspace);
    expect(filesInPatch(patch)).toEqual(['guard.ts']);
  });
});

describe('applyFixPatch', () => {
  it('lands the change in a working copy and leaves it uncommitted', async () => {
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    const result = await applyFixPatch(source, patch);

    expect(result.files).toEqual(['app.ts']);
    expect(readFileSync(join(source, 'app.ts'), 'utf-8')).toBe(FILE.replace('{{rate}}', '2'));
    // Uncommitted is the whole point: a person reads it before it is theirs.
    expect(git(source, 'status', '--porcelain')).toContain('app.ts');
    expect(git(source, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('applies to a different checkout of the same code', async () => {
    // The patch is built in a throwaway clone and applied wherever the
    // person keeps their own copy — a different directory every time.
    const other = join(root, 'other');
    git(root, 'clone', '-q', source, other);

    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    await applyFixPatch(other, patch);
    expect(readFileSync(join(other, 'app.ts'), 'utf-8')).toBe(FILE.replace('{{rate}}', '2'));
  });

  it('still applies when the target has moved on elsewhere in the file', async () => {
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    // Someone kept working while the fix ran. A plain `git apply` refuses
    // here; a three-way merge is what makes the patch still usable.
    writeFileSync(join(source, 'app.ts'), FILE.replace('{{rate}}', '1') + '\nexport const extra = true;\n');
    git(source, 'commit', '-aqm', 'meanwhile');

    await applyFixPatch(source, patch);
    const applied = readFileSync(join(source, 'app.ts'), 'utf-8');
    expect(applied).toContain('export const rate = 2;');
    expect(applied).toContain('export const extra = true;');
  });

  it('says so rather than half-applying when it cannot be resolved', async () => {
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    // The same line changed to something else in the target.
    writeFileSync(join(source, 'app.ts'), FILE.replace('{{rate}}', '99'));
    git(source, 'commit', '-aqm', 'conflicting');

    await expect(applyFixPatch(source, patch)).rejects.toThrow(/çakışma|uygulanamadı/i);
  });

  it('refuses a target that is not a repository', async () => {
    await expect(applyFixPatch(root, 'diff --git a/x b/x\n')).rejects.toThrow(/git deposu değil/);
  });
});

describe('removeFixWorkspace', () => {
  it('leaves nothing behind — the patch was the deliverable', async () => {
    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    removeFixWorkspace(workspace);
    expect(existsSync(workspace)).toBe(false);
  });
});

describe('parseNumstat', () => {
  it('counts a binary file without counting its lines', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n')).toEqual({
      files: 2,
      insertions: 3,
      deletions: 1,
    });
  });
});
