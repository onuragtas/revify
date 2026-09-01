import type { ContextCollector, TriggerEvent } from '../../core/types.js';
import { GitlabClient, parseProjectPathFromUrl } from '../../clients/gitlabClient.js';
import type { RepoCache } from '../../clients/repoCache.js';
import { progressBus } from '../../core/progressBus.js';
import {
  dropForeignOnlyFiles,
  joinFileDiffs,
  splitCommitsByOwnership,
  type ScopeCommit,
} from '../../core/changeScope.js';
import { mountContextRepos, type ContextRepo } from './contextRepos.js';

/** One repository the change touches: its diff against that repo's own
 * default branch, plus the local checkout of the feature branch. */
export type { ContextRepo };

export interface RepoChange {
  projectPath: string;
  branchName: string;
  baseBranch: string;
  diff: string;
  files: Array<{ path: string; diff: string }>;
  /** The commits this branch carries that the base does not, oldest first.
   * A long-lived branch carries work that is not the ticket's; without
   * these the review cannot tell whose. */
  commits?: Array<{ sha: string; title: string; author: string; date: string }>;
  repoPath: string | null;
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
    // A local-directory review is not this collector's event. Without this
    // it returned an empty `repoChanges`, and whether that empty array
    // clobbered the real one came down to the order collectors happen to
    // be listed in — a config edit away from a silently diff-less review.
    if (event.data.repoPath) return {};

    const linkedBranches =
      (contextSoFar.linkedBranches as Array<{ name: string; repositoryUrl: string }> | undefined) ?? [];

    const repoChanges: RepoChange[] = [];
    const changedProjects = new Set<string>();
    /** project@branch, so the same branch listed twice is deduped while two
     * branches of one project are not. */
    const seen = new Set<string>();

    for (const branch of linkedBranches) {
      const projectPath = parseProjectPathFromUrl(branch.repositoryUrl);
      if (!projectPath) {
        progressBus.log(event.id, `could not parse project path from ${branch.repositoryUrl}, skipping`);
        continue;
      }
      // Jira can list the same branch under several repository entries.
      if (seen.has(`${projectPath}@${branch.name}`)) continue;
      seen.add(`${projectPath}@${branch.name}`);

      /*
       * A repository can appear twice, on two branches.
       *
       * This used to key on the project alone, so the second branch was
       * dropped and never reached the review at all — the change looked
       * smaller than it was. Each branch now gets its own entry, and the
       * second one its own checkout, because one directory cannot be on two
       * branches at once.
       */
      const separate = changedProjects.has(projectPath);

      try {
        const baseBranch = await this.gitlabClient.getDefaultBranch(projectPath);
        progressBus.log(event.id, `diffing ${baseBranch}...${branch.name} in ${projectPath}...`);
        const compared = await this.gitlabClient.compareBranches(projectPath, baseBranch, branch.name);
        progressBus.log(event.id, `${projectPath}: diff is ${compared.diff.length} chars`);

        let repoPath: string | null = null;
        if (this.repoCache) {
          try {
            repoPath = await this.repoCache.ensureCheckout(
              projectPath,
              branch.name,
              baseBranch,
              signal,
              { separate },
            );
            progressBus.log(event.id, `${projectPath} checked out at ${branch.name}`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            progressBus.log(event.id, `${projectPath} checkout failed (${message}), diff only`);
          }
        }

        // Everything another ticket put on this branch comes off before the
        // review ever sees it — see core/changeScope.ts.
        const scoped = await this.scopeToIssue(event, projectPath, compared);

        changedProjects.add(projectPath);
        repoChanges.push({
          projectPath,
          branchName: branch.name,
          baseBranch: compared.baseBranch,
          diff: scoped.diff,
          commits: compared.commits,
          files: scoped.files,
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
      contextRepos: await mountContextRepos(event, {
        repoCache: this.repoCache,
        gitlabClient: this.gitlabClient,
        exclude: changedProjects,
        signal,
      }),
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

  /**
   * Takes another ticket's files out of the diff.
   *
   * Costs one API call per commit, and only when the branch actually
   * carries a commit naming a sibling ticket — the common branch, whose
   * commits are all its own, pays nothing.
   *
   * Failure here is not fatal: a diff that could not be narrowed is the
   * diff we have always sent, so an unreachable endpoint costs precision
   * rather than the review.
   */
  private async scopeToIssue(
    event: TriggerEvent,
    projectPath: string,
    compared: { diff: string; files: Array<{ path: string; diff: string }>; commits: ScopeCommit[] },
  ): Promise<{ diff: string; files: Array<{ path: string; diff: string }> }> {
    const issueKey = (event.data.issueKey as string | undefined) ?? event.id;
    const { own, foreign } = splitCommitsByOwnership(compared.commits, issueKey);
    if (!foreign.length) return { diff: compared.diff, files: compared.files };

    try {
      const pathsOf = async (commits: ScopeCommit[]) => {
        const set = new Set<string>();
        for (const commit of commits) {
          for (const path of await this.gitlabClient.commitFiles(projectPath, commit.sha)) {
            set.add(path);
          }
        }
        return set;
      };

      const { files, dropped } = dropForeignOnlyFiles(
        compared.files,
        await pathsOf(own),
        await pathsOf(foreign),
      );
      if (!dropped.length) return { diff: compared.diff, files: compared.files };

      const diff = joinFileDiffs(files);
      progressBus.log(
        event.id,
        `${projectPath}: ${dropped.length} dosya başka task'ın commitine ait, diff dışı ` +
          `(${foreign.length} yabancı commit) — diff ${compared.diff.length} → ${diff.length} karakter`,
      );
      return { diff, files };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progressBus.log(event.id, `${projectPath}: commit dosyaları alınamadı (${message}), diff daraltılmadı`);
      return { diff: compared.diff, files: compared.files };
    }
  }
}
