import type { ContextCollector, TriggerEvent } from '../../core/types.js';
import type { RepoCache } from '../../clients/repoCache.js';
import { progressBus } from '../../core/progressBus.js';
import { readLocalChange } from '../../core/localRepo.js';
import type { RepoChange } from './gitlabBranchDiffContext.js';
import { mountContextRepos } from './contextRepos.js';
import type { GitlabClient } from '../../clients/gitlabClient.js';

/**
 * Reviews a directory on this machine.
 *
 * It produces exactly what `gitlabBranchDiffContext` produces — a
 * `RepoChange` and a list of context repos — which is why the task, the
 * prompt and the whole reporting side need no idea this exists. That was
 * the point of splitting collectors from the task in the first place, and
 * this is the first time it has been cashed in.
 *
 * Two diffs travel, not one. The committed half answers "what does this
 * branch add"; the uncommitted half answers "what is in front of me right
 * now". Merging them into a single blob would lose the distinction the
 * reviewer needs — you can ask for a commit to be amended, but you cannot
 * ask for an uncommitted line to be reverted in a code review.
 */
export class LocalRepoDiffContext implements ContextCollector {
  constructor(
    private readonly gitlabClient: GitlabClient,
    private readonly repoCache?: RepoCache,
  ) {}

  async collect(
    event: TriggerEvent,
    _contextSoFar: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const repoPath = event.data.repoPath as string | undefined;
    // Not this collector's event. Every collector runs on every event, so
    // each one has to recognise its own — the alternative is a second
    // wiring per entry point, and two wirings drift.
    if (!repoPath) return {};

    const change = await readLocalChange(repoPath);
    progressBus.log(
      event.id,
      `${change.projectPath}: ${change.branch}` +
        (change.baseBranch ? ` vs ${change.baseBranch}` : ' (taban dal bulunamadı)'),
    );

    const parts: string[] = [];
    if (change.committedDiff.trim()) {
      parts.push(`# Committed on ${change.branch} (vs ${change.baseBranch})\n\n${change.committedDiff}`);
    }
    if (change.workingDiff.trim()) {
      parts.push(`# Not committed yet\n\n${change.workingDiff}`);
    }

    if (!parts.length) {
      progressBus.log(event.id, 'değişiklik yok — taban dalla aynı ve çalışma alanı temiz');
    } else {
      progressBus.log(
        event.id,
        `diff ${change.committedDiff.length + change.workingDiff.length} karakter, ` +
          `${change.files.length} dosya`,
      );
    }

    const repoChange: RepoChange = {
      projectPath: change.projectPath,
      branchName: change.branch,
      baseBranch: change.baseBranch || '(bilinmiyor)',
      diff: parts.join('\n\n'),
      files: change.files,
      // The reviewer reads the directory itself: it is already the branch,
      // already has the uncommitted work, and nothing needs cloning.
      repoPath: change.path,
      commits: change.commits,
    };

    return {
      repoChanges: [repoChange],
      // The same set the Jira path mounts, minus the repo being reviewed:
      // "related project" has to mean one thing however the review began.
      contextRepos: await mountContextRepos(event, {
        repoCache: this.repoCache,
        gitlabClient: this.gitlabClient,
        exclude: new Set([change.projectPath]),
        signal: _signal,
      }),
      localReview: { path: change.path, projectPath: change.projectPath, branch: change.branch },
    };
  }

}
