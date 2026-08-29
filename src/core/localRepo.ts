import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A working copy on this machine, described the way the reviewer needs it.
 *
 * The Jira path finds its code through a linked GitLab branch. This one is
 * handed a directory instead — "review what is in here" — which is the
 * shape of the question when the work has no ticket yet, or the ticket
 * links nothing, or you simply want a second pair of eyes before pushing.
 *
 * Everything below is a plain git question. It is here rather than in the
 * collector so it can be tested against real repositories instead of a
 * mock that agrees with whatever the code does.
 */

export interface LocalChange {
  /** Absolute, resolved. */
  path: string;
  /** `group/name` from the remote when there is one, else the directory. */
  projectPath: string;
  branch: string;
  baseBranch: string;
  /** Commits on this branch that the base does not have. */
  committedDiff: string;
  /** Everything not committed yet — staged and unstaged, plus new files. */
  workingDiff: string;
  /** Commits this branch carries that the base does not, oldest first. A
   * long-lived branch carries work that is not the ticket's, and the diff
   * flattens all of it into one blob. */
  commits: Array<{ sha: string; title: string; author: string; date: string }>;
  files: Array<{ path: string; diff: string }>;
}

export class NotARepositoryError extends Error {
  constructor(readonly path: string) {
    super(`${path} bir git deposu değil.`);
    this.name = 'NotARepositoryError';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  // maxBuffer: a diff across a large branch runs past node's 1 MB default,
  // and the failure mode is a truncated review that looks complete.
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch (err) {
    /*
     * A non-zero exit is not always a failure.
     *
     * `git diff --no-index` exits 1 precisely *because* it found a
     * difference — which is the case we are asking about. Treating that as
     * an error made every brand-new file invisible to the review: the
     * command worked, produced the diff, and the diff was thrown away.
     */
    const output = (err as { stdout?: string }).stdout;
    return typeof output === 'string' && output.length > 0 ? output : null;
  }
}

/** `git@host:group/name.git` and `https://host/group/name.git` both become
 * `group/name` — the same identity the Jira path uses, so notes scoped to a
 * project apply however the review was started. */
export function projectPathFromRemote(remote: string): string | null {
  const cleaned = remote.trim().replace(/\.git$/, '');
  const match = cleaned.match(/^(?:git@[^:]+:|https?:\/\/[^/]+\/)(.+)$/);
  return match ? match[1] : null;
}

/**
 * Which branch this one is measured against.
 *
 * `origin/HEAD` is the honest answer when the remote publishes it. Plenty
 * of clones never set it, so the fallbacks are the two names that cover
 * almost everything, checked for existence rather than assumed — a base
 * branch that does not exist produces a diff of the entire history, which
 * reads as "this change rewrites the world".
 */
export async function detectBaseBranch(path: string, branch: string): Promise<string> {
  const head = await tryGit(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head?.trim()) return head.trim();

  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (candidate === branch) continue;
    const exists = await tryGit(path, ['rev-parse', '--verify', '--quiet', candidate]);
    if (exists?.trim()) return candidate;
  }
  return '';
}

/**
 * Brings `origin/*` up to date, best effort.
 *
 * The base branch is a remote-tracking ref, and nobody fetches before asking
 * for a review. Left alone it is whatever was last pulled — so a branch cut
 * from a week-old `main` is diffed against that week-old commit, and every
 * change a colleague merged since is reported as part of this one. That is
 * not a slow review; it is a wrong one.
 *
 * A fetch touches no branch and no file: it moves remote-tracking refs and
 * nothing else, so it cannot disturb work in progress. It is also allowed to
 * fail — offline, no remote, no credentials — and when it does the review
 * runs against what is on disk, which is exactly what it did before.
 */
const FETCH_TIMEOUT_MS = 30_000;

async function refreshRemoteRefs(root: string): Promise<void> {
  try {
    await run('git', ['fetch', '--quiet', '--prune', 'origin'], {
      cwd: root,
      timeout: FETCH_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch {
    // Reviewing against a stale base is worse than reviewing; refusing to
    // review because a remote is unreachable would be worse than both.
  }
}

export async function readLocalChange(rawPath: string): Promise<LocalChange> {
  const path = resolve(rawPath.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  if (!existsSync(path)) throw new NotARepositoryError(path);

  const top = await tryGit(path, ['rev-parse', '--show-toplevel']);
  if (!top?.trim()) throw new NotARepositoryError(path);
  const root = top.trim();

  await refreshRemoteRefs(root);

  const branch = (await tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || 'HEAD';
  const baseBranch = await detectBaseBranch(root, branch);

  const remote = (await tryGit(root, ['remote', 'get-url', 'origin']))?.trim() ?? '';
  const projectPath = (remote && projectPathFromRemote(remote)) || basename(root);

  // Three dots: what this branch added, not what the base added meanwhile.
  // Two dots would report a teammate's merged work as part of this change.
  const committedDiff = baseBranch ? ((await tryGit(root, ['diff', `${baseBranch}...HEAD`])) ?? '') : '';

  /*
   * Uncommitted work counts.
   *
   * Reviewing a directory usually means "look at what I have right now",
   * and the half that is not committed yet is the half most likely to be
   * wrong. Dropping it silently would produce a confident review of code
   * the author is not actually about to push.
   *
   * `--no-index` against /dev/null is how a file git has never seen gets
   * into a diff at all; without it a brand-new file is invisible.
   */
  const tracked = (await tryGit(root, ['diff', 'HEAD'])) ?? '';
  const untrackedList = ((await tryGit(root, ['ls-files', '--others', '--exclude-standard'])) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const untracked: string[] = [];
  for (const file of untrackedList.slice(0, 50)) {
    const diff = await tryGit(root, ['diff', '--no-index', '--', '/dev/null', file]);
    if (diff) untracked.push(diff);
  }
  const workingDiff = [tracked, ...untracked].filter(Boolean).join('\n');

  /*
   * What the branch carries, oldest first.
   *
   * Same three-dot range as the diff, so the list and the diff describe
   * exactly the same set of changes. A record separator that cannot occur
   * in a subject line keeps a commit whose title contains a pipe from
   * splitting into two.
   */
  const log = baseBranch
    ? ((await tryGit(root, ['log', '--reverse', '--format=%h%x1f%an%x1f%aI%x1f%s', `${baseBranch}...HEAD`])) ?? '')
    : '';
  const commits = log
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter((parts) => parts.length === 4)
    .map(([sha, author, date, title]) => ({ sha, author, date, title }));

  return {
    path: root,
    projectPath,
    branch,
    baseBranch,
    committedDiff,
    workingDiff,
    commits,
    files: splitByFile(`${committedDiff}\n${workingDiff}`),
  };
}

/** Splits a unified diff into per-file chunks, which is what the UI's file
 * list and the prompt's per-file sections are built from. */
export function splitByFile(diff: string): Array<{ path: string; diff: string }> {
  const files: Array<{ path: string; diff: string }> = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (header) {
      if (current) files.push({ path: current.path, diff: current.lines.join('\n') });
      current = { path: header[2], lines: [line] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) files.push({ path: current.path, diff: current.lines.join('\n') });
  return files;
}
