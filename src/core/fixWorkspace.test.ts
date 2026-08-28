import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFailure,
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

describe('extractFixPatch — nothing may be committed', () => {
  it('refuses to produce a patch if the workspace was committed to', async () => {
    /*
     * The fixer has no tool that can run git, so this cannot happen today.
     * It is checked because of what the failure would look like if it ever
     * could: a commit moves the change out of the working tree, `git diff`
     * comes back empty, and the run reports "hiçbir dosya değişmedi" for
     * work that changed a dozen files. A wrong answer nobody can see is
     * worse than a loud failure.
     */
    const baseline = await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    git(workspace, 'add', '-A');
    git(workspace, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'sneaky');

    await expect(extractFixPatch(workspace, baseline)).rejects.toThrow(/commit yapamaz/);
  });

  it('is happy when HEAD is exactly where it was left', async () => {
    const baseline = await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));

    const { stats } = await extractFixPatch(workspace, baseline);
    expect(stats.files).toBe(1);
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

describe('applyFixPatch — the patch may not leave the work tree', () => {
  it('refuses a patch that writes into .git', async () => {
    // git refuses this itself, but this is the one step that touches a real
    // working copy — a boundary worth owning rather than assuming.
    const evil =
      'diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\n' +
      '--- /dev/null\n+++ b/.git/hooks/pre-commit\n@@ -0,0 +1 @@\n+#!/bin/sh\n';
    await expect(applyFixPatch(source, evil)).rejects.toThrow(/dışına çıkıyor/);
  });

  it('refuses a patch that climbs out of the repository', async () => {
    const evil =
      'diff --git a/../outside.txt b/../outside.txt\n' +
      '--- /dev/null\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+escaped\n';
    await expect(applyFixPatch(source, evil)).rejects.toThrow(/dışına çıkıyor/);
  });

  it('refuses an absolute path', async () => {
    const evil =
      'diff --git a//etc/passwd b//etc/passwd\n' +
      '--- /dev/null\n+++ b//etc/passwd\n@@ -0,0 +1 @@\n+root\n';
    await expect(applyFixPatch(source, evil)).rejects.toThrow(/dışına çıkıyor/);
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


describe('applyFixPatch — when it does not fit', () => {
  it('names the directory and the files, not git\'s progress log', async () => {
    /*
     * `git apply --verbose` narrates on the same stream it diagnoses on:
     * "Checking patch X…" and "Falling back to direct application…" are
     * progress, `error:` lines are the answer. Reading the tail of stderr —
     * which is what a generic git error reader does — returned the progress
     * of whichever file came last and dropped the reason. The failure a
     * person actually saw was three lines of "Falling back to direct
     * application…" and nothing to act on.
     */
    /*
     * A repository that has never held the reviewed content — not one that
     * held it and moved on. That distinction is the whole case: when the
     * preimage blob exists, git merges three ways and reports conflicts,
     * which is handled elsewhere and leaves a usable result. When it does
     * not, git falls back to applying the hunks literally, the context does
     * not match, and nothing lands.
     */
    const other = join(root, 'elsewhere');
    execFileSync('mkdir', ['-p', other]);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 'test@example.invalid');
    git(other, 'config', 'user.name', 'Test');
    writeFileSync(join(other, 'app.ts'), 'tamamen başka bir dosya\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'unrelated');

    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    const failed = await applyFixPatch(other, patch, undefined, 'feature/BUY-2397').catch(
      (err: Error) => err.message,
    );

    expect(failed).toContain(other);
    expect(failed).toContain('app.ts');
    expect(failed).toContain('feature/BUY-2397');
    expect(failed).toContain('başka bir dal');
    // And the file is untouched: a failed apply leaves nothing behind.
    expect(readFileSync(join(other, 'app.ts'), 'utf-8')).toBe('tamamen başka bir dosya\n');
  });
});

describe('applyFixPatch — whitespace that drifted', () => {
  it('applies a patch git refuses over indentation alone', async () => {
    /*
     * A patch was refused, downloaded, applied by hand from an editor — and
     * it was right. `git apply` matches context exactly; editors do not.
     * The usual cause is indentation that moved between the reviewed
     * checkout and this one, and refusing over it sends someone to do by
     * hand exactly what this exists to do for them.
     */
    const other = join(root, 'reformatted');
    execFileSync('mkdir', ['-p', other]);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 'test@example.invalid');
    git(other, 'config', 'user.name', 'Test');
    // Same code, tabs instead of two spaces.
    writeFileSync(join(other, 'app.ts'), FILE.replace('{{rate}}', '1').replace(/^ {2}/gm, '\t'));
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'tabs');

    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    const result = await applyFixPatch(other, patch);

    expect(result.ignoredWhitespace).toBe(true);
    expect(readFileSync(join(other, 'app.ts'), 'utf-8')).toContain('rate = 2');
  });

  it('does not relax anything else to get a patch in', async () => {
    // Whitespace is the only thing waived. A hunk landing somewhere
    // plausible but wrong is worse than one that does not land.
    const other = join(root, 'unrelated');
    execFileSync('mkdir', ['-p', other]);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.email', 'test@example.invalid');
    git(other, 'config', 'user.name', 'Test');
    writeFileSync(join(other, 'app.ts'), 'bambaşka bir dosya\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'unrelated');

    await createFixWorkspace({ dir: source, includeWorkingTree: false }, workspace);
    writeFileSync(join(workspace, 'app.ts'), FILE.replace('{{rate}}', '2'));
    const { patch } = await extractFixPatch(workspace);

    await expect(applyFixPatch(other, patch)).rejects.toThrow(/uymadı/);
    expect(readFileSync(join(other, 'app.ts'), 'utf-8')).toBe('bambaşka bir dosya\n');
  });
});

describe('applyFailure', () => {
  const GIT_OUTPUT = [
    'Checking patch src/main/java/Payment.java...',
    'error: repository lacks the necessary blob to perform 3-way merge.',
    'Falling back to direct application...',
    'error: while searching for:',
    'public class Payment {',
    '',
    'error: patch failed: src/main/java/Payment.java:1',
    'error: src/main/java/Payment.java: patch does not apply',
    'Checking patch src/main/resources/db/migration_refund_bank_rules.sql...',
    'Falling back to direct application...',
  ].join('\n');

  it('does not call a missing blob a mismatch on its own', () => {
    /*
     * "repository lacks the necessary blob" is routine: the target's object
     * store has no copy of the preimage, which is the normal case when the
     * review was written against uncommitted work — that blob only ever
     * existed in the throwaway workspace. git says it, falls back, and
     * usually succeeds. Reading it as "you are on the wrong branch" tells
     * someone their directory is wrong when it is not.
     */
    const fallback = [
      'Checking patch a.ts...',
      'error: repository lacks the necessary blob to perform 3-way merge.',
      'Falling back to direct application...',
      'Applied patch a.ts cleanly.',
    ].join('\n');

    expect(applyFailure(fallback).contentDiffers).toBe(false);
  });

  it('reads the diagnosis rather than whatever line came last', () => {
    const failure = applyFailure(GIT_OUTPUT);

    expect(failure.detail).toContain('patch does not apply');
    expect(failure.detail).not.toContain('Checking patch');
    expect(failure.files).toEqual(['src/main/java/Payment.java']);
    expect(failure.contentDiffers).toBe(true);
  });

  it('does not call a routine 3-way fallback a mismatch', () => {
    // git falls back and still succeeds all the time; only the failure to
    // apply afterwards means the target is the wrong code.
    const chatter = 'Checking patch a.ts...\nFalling back to direct application...\nApplied patch a.ts cleanly.';
    expect(applyFailure(chatter).contentDiffers).toBe(false);
  });

  it('still says something when git said nothing it recognises', () => {
    expect(applyFailure('bir tuhaflık oldu').detail).toBe('bir tuhaflık oldu');
  });
});
