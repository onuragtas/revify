import { describe, expect, it } from 'vitest';
import { GitlabBranchDiffContext } from './gitlabBranchDiffContext.js';
import type { GitlabClient } from '../../clients/gitlabClient.js';
import type { RepoCache } from '../../clients/repoCache.js';
import type { TriggerEvent } from '../../core/types.js';

/**
 * A change can span repositories, and it can span two branches of one.
 *
 * The second case used to disappear: the collector keyed on the project
 * alone, so a repository already seen was skipped and its other branch never
 * reached the review — the change simply looked smaller than it was.
 */
const event: TriggerEvent = { id: 'BUY-1', data: { issueKey: 'BUY-1', contextRepos: [] } };

function gitlab(): GitlabClient {
  return {
    getDefaultBranch: async () => 'main',
    compareBranches: async (projectPath: string, base: string, branch: string) => ({
      baseBranch: base,
      diff: `diff for ${projectPath}@${branch}`,
      files: [{ path: 'app.ts', diff: `@@ ${branch}` }],
    }),
    listProjects: async () => [],
  } as unknown as GitlabClient;
}

/** Records how each checkout was asked for. */
function cache() {
  const calls: Array<{ projectPath: string; branch: string; separate: boolean }> = [];
  const repoCache = {
    ensureCheckout: async (
      projectPath: string,
      branch: string,
      _base?: string,
      _signal?: AbortSignal,
      options: { separate?: boolean } = {},
    ) => {
      calls.push({ projectPath, branch, separate: Boolean(options.separate) });
      return options.separate ? `/cache/.branches/${projectPath}@${branch}` : `/cache/${projectPath}`;
    },
    listCached: () => [],
    ensureDefaultBranch: async (p: string) => `/cache/${p}`,
  } as unknown as RepoCache;
  return { repoCache, calls };
}

const linked = (name: string, project: string) => ({
  name,
  repositoryUrl: `https://gitlab.example.com/${project}`,
});

describe('GitlabBranchDiffContext', () => {
  it('keeps both branches when a change spans two of the same repository', async () => {
    const { repoCache, calls } = cache();
    const collected = await new GitlabBranchDiffContext(gitlab(), repoCache).collect(event, {
      linkedBranches: [linked('feature/a', 'team/api'), linked('feature/b', 'team/api')],
    });

    const changes = collected.repoChanges as Array<{ projectPath: string; branchName: string }>;
    expect(changes.map((c) => c.branchName)).toEqual(['feature/a', 'feature/b']);

    // One directory cannot be on two branches at once, so the second gets
    // its own — and only the second.
    expect(calls).toEqual([
      { projectPath: 'team/api', branch: 'feature/a', separate: false },
      { projectPath: 'team/api', branch: 'feature/b', separate: true },
    ]);
  });

  it('still drops the same branch listed twice', async () => {
    // Jira lists one branch under several repository entries; that is a
    // duplicate, not a second branch.
    const { repoCache, calls } = cache();
    const collected = await new GitlabBranchDiffContext(gitlab(), repoCache).collect(event, {
      linkedBranches: [linked('feature/a', 'team/api'), linked('feature/a', 'team/api')],
    });

    expect((collected.repoChanges as unknown[]).length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('gives each repository of a multi-repo change its own normal checkout', async () => {
    const { repoCache, calls } = cache();
    await new GitlabBranchDiffContext(gitlab(), repoCache).collect(event, {
      linkedBranches: [linked('feature/x', 'team/api'), linked('feature/x', 'team/web')],
    });

    expect(calls.every((c) => !c.separate)).toBe(true);
  });

  it('is not this collector\'s event when a directory is being reviewed', async () => {
    const { repoCache } = cache();
    const collected = await new GitlabBranchDiffContext(gitlab(), repoCache).collect(
      { id: 'local:x', data: { repoPath: '/tmp/x' } },
      { linkedBranches: [linked('feature/a', 'team/api')] },
    );
    expect(collected).toEqual({});
  });
});
