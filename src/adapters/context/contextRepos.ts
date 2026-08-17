import type { GitlabClient } from '../../clients/gitlabClient.js';
import type { RepoCache } from '../../clients/repoCache.js';
import { progressBus } from '../../core/progressBus.js';

export interface ContextRepo {
  projectPath: string;
  path: string;
  branch: string;
}

/**
 * Every repository already on disk, on its default branch.
 *
 * The cache is the reviewer's standing set of services worth having
 * around. A selection only decides what gets *cloned* now; once a repo is
 * there it stays available to every later review without being re-picked.
 *
 * Default branch, never a feature branch: context has to be the merged
 * state, or the model reads a previous task's unmerged work as if it were
 * live. The repositories the change itself touches are excluded — the
 * caller has already checked those out at the branch under review.
 *
 * Shared by both entry points. It was written for Jira-linked branches and
 * reviewing a local directory needs exactly the same thing; a second copy
 * would be the one that stops matching.
 */
export async function mountContextRepos(
  event: { id: string; data: Record<string, unknown> },
  options: {
    repoCache?: RepoCache;
    gitlabClient: GitlabClient;
    /** Repos already checked out at the branch under review. */
    exclude: Set<string>;
    signal?: AbortSignal;
  },
): Promise<ContextRepo[]> {
  const { repoCache, gitlabClient, exclude, signal } = options;
  if (!repoCache) return [];

  // Clone anything newly selected that is not cached yet.
  const selected = (event.data.contextRepos as string[] | undefined) ?? [];
  const cachedPaths = new Set(repoCache.listCached().map((r) => r.projectPath));
  for (const projectPath of selected) {
    if (cachedPaths.has(projectPath) || exclude.has(projectPath)) continue;
    try {
      const defaultBranch = await gitlabClient.getDefaultBranch(projectPath);
      progressBus.log(event.id, `cloning ${projectPath}@${defaultBranch}...`);
      await repoCache.ensureCheckout(projectPath, defaultBranch, defaultBranch, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progressBus.log(event.id, `could not clone ${projectPath} (${message}), skipping`);
    }
  }

  const result: ContextRepo[] = [];
  for (const cached of repoCache.listCached()) {
    if (exclude.has(cached.projectPath)) continue;
    try {
      // Adopted checkouts do not know their default branch yet.
      const defaultBranch = cached.defaultBranch || (await gitlabClient.getDefaultBranch(cached.projectPath));
      const path = await repoCache.ensureDefaultBranch(cached.projectPath, defaultBranch, signal);
      result.push({ projectPath: cached.projectPath, path, branch: defaultBranch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progressBus.log(event.id, `context repo ${cached.projectPath} unavailable (${message})`);
    }
  }

  if (result.length) {
    progressBus.log(event.id, `${result.length} context repo(s) available at default branch`);
  }
  return result;
}
