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
): Promise<string> {
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
      // The source repository's hooks come along with a local clone, and a
      // baseline commit is bookkeeping — it must not run somebody's linter,
      // let alone anything that reaches the network.
      '--no-verify',
      '-m',
      'revify: incelenen hâl',
    ],
    signal,
  );

  // Handed back so the caller can prove afterwards that nothing was
  // committed on top of it.
  return (await git(workspaceDir, ['rev-parse', 'HEAD'], signal)).trim();
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
  /**
   * The commit `createFixWorkspace` left HEAD at.
   *
   * Checked rather than assumed. The fixer has no way to run git — its tool
   * set contains nothing that executes — but if that ever stopped being
   * true, a commit would move the change out of the working tree and this
   * function would report an empty patch: "nothing to fix", silently, for a
   * run that changed a dozen files. A wrong answer nobody can see is worse
   * than a failure, so this is a hard stop.
   */
  baseline?: string,
  signal?: AbortSignal,
): Promise<{ patch: string; stats: PatchStats }> {
  if (baseline) {
    const head = (await git(workspaceDir, ['rev-parse', 'HEAD'], signal)).trim();
    if (head !== baseline) {
      throw new Error(
        'Çalışma kopyasında commit oluşturulmuş — düzeltme koşusu commit yapamaz. ' +
          `HEAD ${baseline.slice(0, 8)} olmalıydı, ${head.slice(0, 8)} bulundu; yama alınmadı.`,
      );
    }
  }
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
  /** Set when it only went in once whitespace was waived: the indentation
   * here differs from the reviewed checkout, so the result deserves a look
   * before it is committed. */
  ignoredWhitespace?: boolean;
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
/**
 * What actually went wrong, out of everything `git apply --verbose` says.
 *
 * The narration and the diagnosis share stderr: "Checking patch X…" and
 * "Falling back to direct application…" are progress, `error:` and `fatal:`
 * are the answer. Reading the tail — which is what a generic git error
 * reader does — hands back the progress of whichever file happened to be
 * last and drops the reason entirely. That is how an apply failure came
 * back as three lines of "Falling back to direct application…" and nothing
 * a person could act on.
 */
export function applyFailure(message: string): {
  files: string[];
  contentDiffers: boolean;
  detail: string;
} {
  const lines = message.split('\n').map((l) => l.trim());
  const errors = lines.filter((l) => /^(error|fatal):/.test(l));

  return {
    // `error: patch failed: src/a.sql:12` — the file the patch could not sit on.
    files: [
      ...new Set(
        errors
          .map((l) => l.match(/^error: patch failed: (.+):\d+$/)?.[1])
          .filter((f): f is string => Boolean(f)),
      ),
    ],
    /*
     * "The code here is not what the patch was written against."
     *
     * Only the failure to apply says that. It is tempting to read
     * "repository lacks the necessary blob" the same way, and wrong: that
     * line means the target's object store has no copy of the preimage,
     * which is the *normal* case when the review was written against
     * uncommitted work — the blob only ever existed in the throwaway
     * workspace. git says it, falls back, and usually succeeds. Claiming a
     * mismatch on that alone tells someone their directory is on the wrong
     * branch when it is not, which is worse than saying nothing.
     */
    contentDiffers: /patch does not apply|patch failed:/i.test(message),
    detail: (errors.length ? errors : lines.filter(Boolean).slice(-3)).join('\n'),
  };
}

export async function applyFixPatch(
  targetDir: string,
  patch: string,
  signal?: AbortSignal,
  /** The branch the review was written against, named in the failure so the
   * reader knows what to check out. */
  branchName?: string,
): Promise<ApplyResult> {
  const dir = resolve(targetDir.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(dir)) throw new Error(`${dir} bulunamadı.`);

  // git refuses these itself, but this is the one step that touches somebody
  // real working copy — a boundary worth owning rather than assuming, and
  // worth explaining when it trips.
  const escaping = filesInPatch(patch).filter(
    (file) => file.startsWith('/') || file === '.git' || file.startsWith('.git/') || file.split('/').includes('..'),
  );
  if (escaping.length) {
    throw new Error(
      `Yama çalışma alanının dışına çıkıyor (${escaping.slice(0, 3).join(', ')}) — uygulanmadı.`,
    );
  }

  let root: string;
  try {
    root = (await git(dir, ['rev-parse', '--show-toplevel'], signal)).trim();
  } catch {
    throw new Error(`${dir} bir git deposu değil — yama uygulanmadı.`);
  }

  const patchFile = join(root, '.git', `revify-fix-${Date.now()}.patch`);
  writeFileAtomic(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);

  /*
   * Four ways to put a patch in, weakest assumption last.
   *
   * `--3way` is the best outcome — it merges when the target has moved on
   * — but it reads the index, and refuses with "does not match index" the
   * moment a file it touches is modified and unstaged. That is not an edge
   * case here: a directory review deliberately includes uncommitted work,
   * so the very directory this patch was written for is normally in exactly
   * that state. Plain `git apply` never looks at the index and puts the
   * hunks straight into the working tree, which is what an editor's "apply
   * patch" does and why one kept succeeding by hand after this failed.
   *
   * Nothing here fuzzes. Every attempt still requires the context to match
   * — whitespace aside — because a hunk landing somewhere plausible but
   * wrong is worse than one that does not land.
   */
  const ATTEMPTS: Array<{ args: string[]; merged: boolean; ignoredWhitespace: boolean }> = [
    { args: ['--3way'], merged: false, ignoredWhitespace: false },
    { args: ['--3way', '--ignore-whitespace'], merged: true, ignoredWhitespace: true },
    { args: [], merged: false, ignoredWhitespace: false },
    { args: ['--ignore-whitespace'], merged: false, ignoredWhitespace: true },
  ];

  let first = '';
  try {
    for (const attempt of ATTEMPTS) {
      signal?.throwIfAborted();
      try {
        const { stdout, stderr } = await gitFull(
          root,
          ['apply', ...attempt.args, '--whitespace=nowarn', '--verbose', patchFile],
          signal,
        );
        return {
          root,
          files: filesInPatch(patch),
          // git narrates a fallback to three-way on stderr; the file list
          // comes from the patch itself either way.
          merged: attempt.merged || /fell back|3-way/i.test(`${stdout}\n${stderr}`),
          ...(attempt.ignoredWhitespace ? { ignoredWhitespace: true } : {}),
        };
      } catch (err) {
        const message = gitError(err);
        first ||= message;

        /*
         * A conflicted three-way apply exits non-zero *and* writes the
         * merge into the working copy. Reporting it as a plain failure
         * would send someone looking for changes already in their files,
         * and trying the next strategy on top would apply the patch twice.
         */
        if (/conflict/i.test(message)) {
          throw new Error(
            `Yama çakışmalarla uygulandı — çalışma kopyanda çakışma işaretleri var, çözüp öyle commitle:\n${message}`,
          );
        }
      }
    }

    /*
     * Every strategy refused, reported as the decision it asks for.
     *
     * "patch does not apply" is true and useless: the reader wants to know
     * *which* directory is wrong and what to do about it. The patch was
     * written against a specific branch's code, and if nothing could place
     * it, this directory is not on that code — checking it out is the fix,
     * and applying anyway would be wrong even if git could.
     *
     * The first attempt's diagnosis is the one reported: it describes the
     * patch as it stands, rather than as it would be with whitespace waived.
     */
    const failure = applyFailure(first);
    if (failure.contentDiffers) {
      throw new Error(
        `Yama bu dizine uymadı: ${root}\n` +
          (failure.files.length ? `Uymayan dosya(lar): ${failure.files.join(', ')}\n` : '') +
          "Buradaki kod, review'in yapıldığı koddan farklı — büyük ihtimalle başka bir dal ya da " +
          `commit üzerindesin${branchName ? ` (yama \`${branchName}\` için üretildi)` : ''}. ` +
          'Doğru dala geçip tekrar dene.\n' +
          failure.detail,
      );
    }
    throw new Error(`Yama uygulanamadı: ${failure.detail}`);
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
