import type { ContextCollector, TriggerEvent } from '../../core/types.js';
import { GitlabClient, parseProjectPathFromUrl } from '../../clients/gitlabClient.js';
import type { RepoCache } from '../../clients/repoCache.js';
import { progressBus } from '../../core/progressBus.js';

/** One repository the change touches: its diff against that repo's own
 * default branch, plus the local checkout of the feature branch. */
export interface RepoChange {
  projectPath: string;
  branchName: string;
  baseBranch: string;
  diff: string;
  files: Array<{ path: string; diff: string }>;
  repoPath: string | null;
}

export interface ContextRepo {
  projectPath: string;
  path: string;
  branch: string;
}

/**
 * Diffs every branch Jira links to the issue — a change can span several
 * services, and reviewing only the first one silently hides the rest.
 *
 * Branch selection is deliberate: a repo the change *touches* is checked
 * out at that change's branch, while every repo included only as context
 * is put on its default branch. Context must be the merged state, or the
 * model reads a previous task's unmerged work as if it were live.
 *
 * Context repos come from `event.data.contextRepos` — the projects the
 * reviewer picked before starting the run.
 */
export class GitlabBranchDiffContext implements ContextCollector {
  constructor(
    private readonly gitlabClient: GitlabClient,
    private readonly repoCache?: RepoCache,
  ) {}

  async collect(
    event: TriggerEvent,
    contextSoFar: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const linkedBranches =
      (contextSoFar.linkedBranches as Array<{ name: string; repositoryUrl: string }> | undefined) ?? [];

    const repoChanges: RepoChange[] = [];
    const changedProjects = new Set<string>();

    for (const branch of linkedBranches) {
      const projectPath = parseProjectPathFromUrl(branch.repositoryUrl);
      if (!projectPath) {
        progressBus.log(event.id, `could not parse project path from ${branch.repositoryUrl}, skipping`);
        continue;
      }
      // Jira can list the same branch under several repository entries.
      if (changedProjects.has(projectPath)) continue;

      try {
        const baseBranch = await this.gitlabClient.getDefaultBranch(projectPath);
        progressBus.log(event.id, `diffing ${baseBranch}...${branch.name} in ${projectPath}...`);
        const compared = await this.gitlabClient.compareBranches(projectPath, baseBranch, branch.name);
        progressBus.log(event.id, `${projectPath}: diff is ${compared.diff.length} chars`);

        let repoPath: string | null = null;
        if (this.repoCache) {
          try {
            repoPath = await this.repoCache.ensureCheckout(projectPath, branch.name, baseBranch);
            progressBus.log(event.id, `${projectPath} checked out at ${branch.name}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            progressBus.log(event.id, `${projectPath} checkout failed (${message}), diff only`);
          }
        }

        changedProjects.add(projectPath);
        repoChanges.push({
          projectPath,
          branchName: branch.name,
          baseBranch: compared.baseBranch,
          diff: compared.diff,
          files: compared.files,
          repoPath,
        });
      } catch (err) {
        // One unreachable repo must not sink a multi-repo review.
        const message = err instanceof Error ? err.message : String(err);
        progressBus.log(event.id, `${projectPath}: could not diff (${message}), skipping`);
      }
    }

    if (repoChanges.length === 0) {
      progressBus.log(event.id, 'no linked branch to diff');
    } else if (repoChanges.length > 1) {
      progressBus.log(event.id, `change spans ${repoChanges.length} repos`);
    }

    return {
      repoChanges,
      contextRepos: await this.checkoutContextRepos(event, changedProjects, signal),
    };
  }

  /**
   * Everything in the repo cache becomes context — the cache *is* the set
   * of services the reviewer has decided are worth having around. The
   * selection passed in only decides what gets *cloned* now; once a repo
   * is on disk it stays available to every later review without being
   * re-picked.
   *
   * All of them are put on their default branch, except the ones this
   * change touches (already checked out at their branch by the caller).
   */
  private async checkoutContextRepos(
    event: TriggerEvent,
    changedProjects: Set<string>,
    signal?: AbortSignal,
  ): Promise<ContextRepo[]> {
    if (!this.repoCache) return [];

    // Clone anything newly selected that isn't cached yet.
    const selected = (event.data.contextRepos as string[] | undefined) ?? [];
    const cachedPaths = new Set(this.repoCache.listCached().map((r) => r.projectPath));
    for (const projectPath of selected) {
      if (cachedPaths.has(projectPath) || changedProjects.has(projectPath)) continue;
      try {
        const defaultBranch = await this.gitlabClient.getDefaultBranch(projectPath);
        progressBus.log(event.id, `cloning ${projectPath}@${defaultBranch}...`);
        await this.repoCache.ensureCheckout(projectPath, defaultBranch, defaultBranch, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progressBus.log(event.id, `could not clone ${projectPath} (${message}), skipping`);
      }
    }

    const result: ContextRepo[] = [];
    for (const cached of this.repoCache.listCached()) {
      if (changedProjects.has(cached.projectPath)) continue;
      try {
        // Adopted checkouts don't know their default branch yet.
        const defaultBranch = cached.defaultBranch || (await this.gitlabClient.getDefaultBranch(cached.projectPath));
        const path = await this.repoCache.ensureDefaultBranch(cached.projectPath, defaultBranch, signal);
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
}
