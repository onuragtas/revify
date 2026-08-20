import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomicWrite.js';

const run = promisify(execFile);

/** A local clone of a shallow repo is quick, but "quick" on a monorepo is
 * still tens of seconds — this is here to stop a wedged git, not to cap
 * honest work. */
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Enough for any patch a review's findings produce; a diff past this is a
 * refactor nobody asked for, and truncating it would be worse than failing. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Untracked files are carried into the workspace one by one. The cap is a
 * guard against a working copy full of build output, not a real limit on
 * how much uncommitted work a person may have. */
const MAX_UNTRACKED = 200;

async function gitFull(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (await gitFull(cwd, args, signal)).stdout;
}

/** git's own diagnosis, not node's echo of the command line. */
export function gitError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const stderr = String(e?.stderr ?? '').trim();
  if (stderr) return stderr.split('\n').slice(-3).join('\n');
  const stdout = String(e?.stdout ?? '').trim();
  if (stdout) return stdout.split('\n').slice(-3).join('\n');
  return e?.message ?? String(err);
}

export interface PatchStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface FixWorkspaceSource {
  /** The checkout the fix starts from — a repo-cache clone at the reviewed
   * branch, or the reviewer's own working copy. */
  dir: string;
  /**
   * Carry uncommitted work into the workspace.
   *
   * True for a directory review, where the uncommitted half *is* what was
   * reviewed: a fix built on HEAD alone would be a fix for code the author
   * has already moved past, and the patch would collide with their own
   * edits when applied.
   */
  includeWorkingTree: boolean;
}

/**
 * A throwaway checkout for the fixer to edit.
 *
 * The fix never runs in the repo cache. Every review hard-resets the repos
 * it touches (`checkout -f -B`) and puts every other repo back on its
 * default branch, so an edit left in the cache is destroyed by the next
 * review — silently, after the model spent minutes on it. Nor does it run
 * in the reviewer's own working copy by default: that mixes generated
 * edits into whatever they had in flight, with no way to tell the two
 * apart and no artifact to keep.
 *
 * So: clone, edit, extract a patch, delete. The patch is the deliverable,
 * and applying it is a separate decision made against a chosen directory.
 *
 * The workspace is left at a baseline commit containing exactly the state
 * that was reviewed — which is what makes `git diff` afterwards mean "the
 * fix", and nothing else.
 */
export async function createFixWorkspace(
  source: FixWorkspaceSource,
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<void> {
  const from = resolve(source.dir);
  if (!existsSync(join(from, '.git'))) {
    throw new Error(`${from} bir git deposu değil — düzeltme için çalışma kopyası oluşturulamadı.`);
  }

  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(dirname(workspaceDir), { recursive: true });

  // Local clone: git hardlinks the object store instead of copying it, so
  // this costs almost nothing even for a large repo. `--no-tags` keeps a
  // busy repo's tag list out of it.
  await git(dirname(workspaceDir), ['clone', '--local', '--no-tags', from, workspaceDir], signal);

  if (source.includeWorkingTree) await carryWorkingTree(from, workspaceDir, signal);

  // The baseline. Everything the fixer does afterwards is the difference
  // from this commit — including files it creates, which is why `add -A`
  // runs before it rather than only after.
  await git(workspaceDir, ['add', '-A'], signal);
  await git(
    workspaceDir,
    [
      '-c',
      'user.email=revify@local',
      '-c',
      'user.name=Revify',
      'commit',
      '--allow-empty',
      '--no-verify',
      '-m',
      'revify: incelenen hâl',
    ],
    signal,
  );
}

/**
 * Reproduces the source's uncommitted state in the workspace.
 *
 * Tracked changes travel as a patch; untracked files are copied, because
 * git has never seen them and there is nothing to diff against. Both are
 * needed — a review of a directory reads staged, unstaged and brand-new
 * files alike, so a fix that starts from only one of them starts from code
 * that was never reviewed.
 */
async function carryWorkingTree(from: string, workspaceDir: string, signal?: AbortSignal): Promise<void> {
  const tracked = await git(from, ['diff', 'HEAD', '--binary'], signal);
  if (tracked.trim()) {
    const patchFile = join(workspaceDir, '.git', 'revify-working.patch');
    writeFileAtomic(patchFile, tracked);
    try {
      await git(workspaceDir, ['apply', '--whitespace=nowarn', patchFile], signal);
    } catch (err) {
      throw new Error(`Commitlenmemiş değişiklikler çalışma kopyasına taşınamadı: ${gitError(err)}`);
    } finally {
      rmSync(patchFile, { force: true });
    }
  }

  const untracked = (await git(from, ['ls-files', '--others', '--exclude-standard'], signal))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED);

  for (const file of untracked) {
    const target = join(workspaceDir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(from, file), target);
  }
}

/**
 * What the fixer changed, as a patch that applies to the reviewed state.
 *
 * `add -A` first so new and deleted files are in it: a fix that adds a file
 * and reports success while the patch silently omits it is the worst
 * possible outcome here.
 */
export async function extractFixPatch(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<{ patch: string; stats: PatchStats }> {
  await git(workspaceDir, ['add', '-A'], signal);
  const patch = await git(workspaceDir, ['diff', '--cached', '--binary'], signal);
  const numstat = await git(workspaceDir, ['diff', '--cached', '--numstat'], signal);
  return { patch, stats: parseNumstat(numstat) };
}

export function parseNumstat(numstat: string): PatchStats {
  const stats: PatchStats = { files: 0, insertions: 0, deletions: 0 };
  for (const line of numstat.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) continue;
    stats.files++;
    // A binary file reports '-' for both counts.
    if (match[1] !== '-') stats.insertions += Number(match[1]);
    if (match[2] !== '-') stats.deletions += Number(match[2]);
  }
  return stats;
}

export interface ApplyResult {
  /** The repository root the patch actually went into — the directory a
   * person named may be any subdirectory of it, and telling them where it
   * landed is the difference between "applied" and "applied somewhere". */
  root: string;
  /** Files the patch touched, as git reported them. */
  files: string[];
  /** Set when the patch went in but git had to merge it — the working copy
   * has moved since the review, and the result is worth reading before it
   * is committed. */
  merged: boolean;
}

/**
 * Applies a fix patch to a working copy and leaves it there, uncommitted.
 *
 * `--3way` rather than a plain apply: the patch was built against the
 * reviewed state, and by the time anyone applies it the target has usually
 * moved — a new commit, an edit in the same file. A three-way merge lands
 * the change anyway wherever git can work out how, and produces ordinary
 * conflict markers where it cannot, which a developer can resolve. A plain
 * `git apply` would simply refuse and say "does not apply", which is true
 * and useless.
 *
 * Nothing is committed and nothing is pushed. The whole point is that a
 * person reads the change before it becomes theirs.
 */
export async function applyFixPatch(
  targetDir: string,
  patch: string,
  signal?: AbortSignal,
): Promise<ApplyResult> {
  const dir = resolve(targetDir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(dir)) throw new Error(`${dir} bulunamadı.`);

  let root: string;
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'], signal)).trim();
  } catch {
    throw new Error(`${dir} bir git deposu değil — yama uygulanmadı.`);
  }

  const patchFile = join(root, '.git', `revify-fix-${Date.now()}.patch`);
  writeFileAtomic(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);
  try {
    // git apply says nothing on a clean apply and reports its reasoning on
    // stderr, so the file list comes from the patch itself and the "did it
    // have to merge" answer from what git narrated.
    const { stdout, stderr } = await gitFull(
      root,
      ['apply', '--3way', '--whitespace=nowarn', '--verbose', patchFile],
      signal,
    );
    return { root, files: filesInPatch(patch), merged: /fell back|3-way/i.test(`${stdout}\n${stderr}`) };
  } catch (err) {
    const message = gitError(err);
    // A conflicted 3-way apply exits non-zero *and* writes the merge into
    // the working copy — reporting it as a plain failure would send someone
    // looking for changes that are, in fact, already in their files.
    if (/conflict/i.test(message)) {
      throw new Error(
        `Yama çakışmalarla uygulandı — çalışma kopyanda çakışma işaretleri var, çözüp öyle commitle:\n${message}`,
      );
    }
    throw new Error(`Yama uygulanamadı: ${message}`);
  } finally {
    rmSync(patchFile, { force: true });
  }
}

/** The `b/` side of every `diff --git` header — what the patch will touch. */
export function filesInPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/(?:\S+) b\/(\S+)/);
    if (match) files.add(match[1]);
  }
  return [...files];
}

/** Removes a workspace once its patch has been taken out of it. */
export function removeFixWorkspace(workspaceDir: string): void {
  rmSync(workspaceDir, { recursive: true, force: true });
}
