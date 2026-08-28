import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFileAtomic } from '../core/atomicWrite.js';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

/** Generous, because a first clone of a large monorepo is a legitimate
 * multi-minute operation — this exists to stop a wedged git, not to cap
 * honest work. */
export const GIT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Why a git command failed, in a form worth logging.
 *
 * Node puts the entire command line into `err.message`, so the real reason
 * lands hundreds of characters in and gets cut by any truncation on the way
 * to the UI — which is how a clone failure can reach the reviewer saying
 * nothing but the command that failed. git's own diagnosis is on stderr,
 * and the last non-progress line of it is the part that says what happened
 * ("Repository not found", "Authentication failed", ...).
 */
export function gitFailureReason(err: unknown): string {
  const e = err as { name?: string; killed?: boolean; stderr?: string; message?: string };
  if (e?.name === 'AbortError') return 'durduruldu';
  if (e?.killed) return `timed out after ${GIT_TIMEOUT_MS / 1000}s`;

  const lines = String(e?.stderr ?? '')
    // Progress output is carriage-return animated; each frame is noise.
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(remote:\s*)?(Counting|Compressing|Receiving|Resolving|Updating|Cloning|Enumerating)\b/.test(l));

  return lines[lines.length - 1] ?? e?.message ?? String(err);
}

/** Turns `backend-team/EPA_API` into a flat, filesystem-safe directory
 * name. Path separators are collapsed so the result can never traverse out
 * of the cache root, and a result of `.`/`..` (which would still escape
 * when joined) is rejected. */
export function cacheDirName(projectPath: string): string {
  const flattened = projectPath.replace(/[^a-zA-Z0-9._-]+/g, '__');
  if (flattened === '.' || flattened === '..' || flattened === '') {
    throw new Error(`Unsafe repository path for cache directory: ${JSON.stringify(projectPath)}`);
  }
  return flattened;
}

/** Recovers `group/project` from a checkout's origin remote. Reading the
 * config file directly keeps adoption synchronous — no git subprocess. */
export function readRemoteProjectPath(repoDir: string): string | null {
  const configPath = join(repoDir, '.git', 'config');
  if (!existsSync(configPath)) return null;
  const match = readFileSync(configPath, 'utf-8').match(/url\s*=\s*(\S+)/);
  if (!match) return null;
  const url = match[1].replace(/\.git$/, '');
  const path = url.match(/^https?:\/\/[^/]+\/(.+?)\/?$/);
  return path ? path[1] : null;
}

function readCurrentBranch(repoDir: string): string | null {
  const headPath = join(repoDir, '.git', 'HEAD');
  if (!existsSync(headPath)) return null;
  const head = readFileSync(headPath, 'utf-8').trim();
  const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
  return ref ? ref[1] : null;
}

export interface CachedRepo {
  projectPath: string;
  dir: string;
  defaultBranch: string;
  /** Branch currently checked out in the working tree. */
  currentBranch: string;
  /** When this checkout last talked to the remote. Absent for a clone made
   * before this was recorded, which is read as "long ago". */
  fetchedAt?: string;
}

/**
 * How long a context repo may go without asking the remote.
 *
 * These are not decoration. The review prompt tells the model to grep them
 * and *"treat what you find as fact"* — so a checkout left at whatever it
 * was cloned as puts weeks-old code in front of a reviewer that will state
 * it plainly. Before this, a repo already on its default branch was never
 * fetched again at all.
 *
 * A window rather than a fetch per review: twenty cached repos would
 * otherwise mean twenty network round trips before every run, and code that
 * moved in the last quarter of an hour is not what makes a review wrong.
 */
export const CONTEXT_FRESH_MS = 15 * 60 * 1000;

const META_FILE = '.cache-meta.json';

/** Where a second branch of an already-checked-out project lives. Leading
 * dot so it is skipped by the adoption scan and by anything globbing the
 * cache for repositories. */
const BRANCH_DIR = '.branches';

/**
 * Keeps local, read-only checkouts of GitLab repos so the reviewing model
 * can read the surrounding code — and the code of the other services this
 * one talks to — instead of guessing from a diff.
 *
 * Which branch a repo sits on matters for correctness: a repo that the
 * change touches must be on that change's branch, while every other repo
 * must be back on its default branch. Otherwise a repo left on a previous
 * task's feature branch would be read as if that unmerged work were
 * already the current state of the service.
 */
export class RepoCache {
  private meta: Record<string, CachedRepo>;

  constructor(
    private readonly cacheRoot: string,
    private readonly gitlabBaseUrl: string,
    private readonly token: string,
  ) {
    this.meta = this.loadMeta();
    this.adoptExistingCheckouts();
  }

  /**
   * Picks up clones that exist on disk but aren't in the metadata — repos
   * cloned before this bookkeeping existed, or left behind after the
   * metadata file was deleted. Without this they'd be invisible as context
   * despite already costing the disk space.
   *
   * The real project path is recovered from `.git/config` rather than by
   * un-flattening the directory name, which is lossy (`a__b` could have
   * been `a/b` or `a__b`).
   */
  private adoptExistingCheckouts(): void {
    if (!existsSync(this.cacheRoot)) return;

    let adopted = false;
    for (const entry of readdirSync(this.cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(join(this.cacheRoot, entry.name));
      if (!existsSync(join(dir, '.git'))) continue;

      const projectPath = readRemoteProjectPath(dir);
      if (!projectPath || this.meta[projectPath]) continue;

      this.meta[projectPath] = {
        projectPath,
        dir,
        // Unknown until GitLab is asked; callers resolve it when needed.
        defaultBranch: '',
        currentBranch: readCurrentBranch(dir) ?? '',
      };
      adopted = true;
    }
    if (adopted) this.saveMeta();
  }

  private get metaPath(): string {
    return join(this.cacheRoot, META_FILE);
  }

  private loadMeta(): Record<string, CachedRepo> {
    if (!existsSync(this.metaPath)) return {};
    const raw = readFileSync(this.metaPath, 'utf-8');
    return raw.trim() ? (JSON.parse(raw) as Record<string, CachedRepo>) : {};
  }

  private saveMeta(): void {
    writeFileAtomic(this.metaPath, JSON.stringify(this.meta, null, 2));
  }

  /** Git credentials are passed via GIT_CONFIG_* env vars rather than
   * baked into the remote URL or the argv — a token in the remote URL
   * would be persisted into `.git/config`, and one in argv is visible to
   * `ps` for every process on the machine. */
  private gitEnv(): NodeJS.ProcessEnv {
    const basic = Buffer.from(`oauth2:${this.token}`).toString('base64');
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
  }

  private async git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        env: this.gitEnv(),
        maxBuffer: 20 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        // A clone of a large repo is minutes long; stopping a review has to
        // end it rather than leave it running against a dead request.
        signal,
      });
      return stdout.trim();
    } catch (err) {
      // Node's own message is the whole command line, which pushes the
      // actual reason past every log truncation. Report the reason instead.
      throw new Error(`git ${args[0]} failed: ${gitFailureReason(err)}`);
    }
  }

  private remoteUrl(projectPath: string): string {
    return `${this.gitlabBaseUrl.replace(/\/$/, '')}/${projectPath}.git`;
  }

  private dirFor(projectPath: string): string {
    return resolve(join(this.cacheRoot, cacheDirName(projectPath)));
  }

  /**
   * A second branch of a repository the change already touches.
   *
   * One directory per project is right almost always — it is the same code,
   * and one checkout is what makes a repo usable as context. But a change
   * can link two branches of the *same* repository, and one directory cannot
   * be on two branches at once. Rather than silently drop the second (which
   * is what happened: it vanished from the review entirely), it gets a
   * checkout of its own.
   *
   * Under `.branches/` so `adoptExistingCheckouts` never mistakes one for a
   * cached repo: it scans the root for directories containing `.git`, and
   * this one does not.
   */
  private branchDirFor(projectPath: string, branch: string): string {
    return resolve(
      join(this.cacheRoot, BRANCH_DIR, `${cacheDirName(projectPath)}@${cacheDirName(branch)}`),
    );
  }

  /** Repos already on disk from earlier reviews. These are what the model
   * can consult for cross-service questions without paying a clone. */
  listCached(): CachedRepo[] {
    return Object.values(this.meta).filter((r) => existsSync(join(r.dir, '.git')));
  }

  /**
   * Ensures a local checkout of `projectPath` exists at `branch` and
   * returns its absolute path. Safe to call repeatedly — an existing clone
   * is fetched and hard-reset rather than re-cloned.
   */
  async ensureCheckout(
    projectPath: string,
    branch: string,
    defaultBranch?: string,
    signal?: AbortSignal,
    /** Give this branch a checkout of its own rather than moving the
     * project's. Used when one change spans two branches of one repository. */
    options: { separate?: boolean } = {},
  ): Promise<string> {
    mkdirSync(this.cacheRoot, { recursive: true });
    const repoDir = options.separate ? this.branchDirFor(projectPath, branch) : this.dirFor(projectPath);

    if (!existsSync(join(repoDir, '.git'))) {
      try {
        await this.git(
          ['clone', '--depth', '1', '--single-branch', '--branch', branch, this.remoteUrl(projectPath), repoDir],
          this.cacheRoot,
          signal,
        );
      } catch (err) {
        // git usually cleans up after itself, but not when it's killed
        // mid-clone. A half-written directory still has a `.git`, so the
        // next run would take the fetch path and treat the broken checkout
        // as a real one. Better to lose the partial work than to review
        // against it.
        rmSync(repoDir, { recursive: true, force: true });
        throw err;
      }
    } else {
      // Explicit refspec so this works even though the original clone was
      // --single-branch (whose default refspec covers only that branch).
      await this.git(['fetch', '--depth', '1', 'origin', branch], repoDir, signal);
      await this.git(['checkout', '-f', '-B', branch, 'FETCH_HEAD'], repoDir, signal);
    }

    // A separate branch checkout is an artefact of one change, not a cached
    // repository: recording it would put it in `listCached()` and mount it as
    // context on its feature branch, which is precisely what context must
    // never be.
    if (!options.separate) {
      const previous = this.meta[projectPath];
      this.meta[projectPath] = {
        projectPath,
        dir: repoDir,
        defaultBranch: defaultBranch ?? previous?.defaultBranch ?? branch,
        currentBranch: branch,
        fetchedAt: new Date().toISOString(),
      };
      this.saveMeta();
    }
    return repoDir;
  }

  /**
   * Puts a repo back on its default branch. Used for repos that the change
   * under review does *not* touch: they are context, and context must be
   * the merged state, not whatever branch a previous review left behind.
   *
   * Skips the network entirely when the repo is already there, so having
   * many cached repos doesn't cost a fetch each on every review.
   */
  async ensureDefaultBranch(
    projectPath: string,
    defaultBranch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = this.meta[projectPath];
    const onDisk = cached && existsSync(join(cached.dir, '.git'));

    if (onDisk && cached.currentBranch === defaultBranch && this.isFresh(cached)) {
      // An adopted checkout arrives with an unknown default branch, and
      // this early return used to skip persisting the one the caller just
      // resolved — so every later review paid another API call to learn the
      // same thing. Record it once.
      if (!cached.defaultBranch) {
        this.meta[projectPath] = { ...cached, defaultBranch };
        this.saveMeta();
      }
      return cached.dir;
    }

    /*
     * Stale, or on the wrong branch, or gone. Either way the answer is the
     * same: fetch and reset.
     *
     * A failure here must not sink the review. A context repo that could not
     * be refreshed is still better than none — it is the same code the last
     * review read — so an unreachable remote falls back to what is on disk
     * rather than dropping the repo from the run.
     */
    try {
      return await this.ensureCheckout(projectPath, defaultBranch, defaultBranch, signal);
    } catch (err) {
      if (!onDisk) throw err;
      console.warn(
        `[repo] ${projectPath} tazelenemedi (${err instanceof Error ? err.message : String(err)}) — diskteki hâliyle kullanılıyor`,
      );
      return cached.dir;
    }
  }

  /** Within the window, and therefore worth trusting without asking. */
  private isFresh(cached: CachedRepo): boolean {
    const at = Date.parse(cached.fetchedAt ?? '');
    return Number.isFinite(at) && Date.now() - at < CONTEXT_FRESH_MS;
  }

  /** Removes a repo's checkout from disk. */
  forget(projectPath: string): void {
    const cached = this.meta[projectPath];
    if (cached) rmSync(cached.dir, { recursive: true, force: true });
    delete this.meta[projectPath];
    this.saveMeta();
  }
}
