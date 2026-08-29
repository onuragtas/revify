import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalRepoDiffContext } from './localRepoDiffContext.js';
import { GitlabBranchDiffContext } from './gitlabBranchDiffContext.js';
import type { GitlabClient } from '../../clients/gitlabClient.js';
import type { RepoChange } from './gitlabBranchDiffContext.js';

/**
 * Reviewing a directory, including when it is attached to a Jira issue.
 *
 * Attaching adds a key to the event; it does not change where the code is
 * read from. That is worth pinning down because the event then carries both
 * `repoPath` and `issueKey`, and every collector decides for itself whether
 * an event is its own — so the two halves have to agree without ever
 * talking: Jira supplies the requirement, this supplies the code, and the
 * GitLab collector stays out of it entirely.
 */

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();

const gitlab = () => ({ listProjects: async () => [] }) as unknown as GitlabClient;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-ctx-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'a.ts'), 'export const rate = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'first');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('LocalRepoDiffContext', () => {
  it('includes uncommitted work, on an issue-attached review as much as a bare one', async () => {
    /*
     * "Look at what I have here" is the question a directory review answers,
     * and the half that is not committed yet is the half most likely to be
     * wrong. Dropping it would produce a confident review of code the author
     * is not about to push — and attaching a Jira key must not quietly turn
     * this into a review of HEAD.
     */
    writeFileSync(join(dir, 'a.ts'), 'export const rate = 2;\n');
    writeFileSync(join(dir, 'brand-new.ts'), 'export const fresh = true;\n');

    const context = await new LocalRepoDiffContext(gitlab()).collect(
      { id: 'BUY-2397', data: { repoPath: dir, issueKey: 'BUY-2397' } },
      {},
    );

    const [change] = context.repoChanges as RepoChange[];
    expect(change.diff).toContain('rate = 2');
    // Untracked files need `--no-index` to appear at all; without it a
    // brand-new file is invisible to the review.
    expect(change.diff).toContain('brand-new.ts');
    expect(change.diff).toContain('fresh = true');
    // And the model reads the directory itself rather than a clone.
    // `realpathSync` because git resolves the temp dir's /private symlink on
    // macOS and the raw strings differ while the directory does not.
    expect(realpathSync(change.repoPath!)).toBe(realpathSync(dir));
  });

  it('marks which half is which, because they are not the same question', async () => {
    // "What does this branch add" and "what is in front of me right now"
    // ask different things of a reviewer — you can ask for a commit to be
    // amended, but not for an uncommitted line to be reverted.
    git('checkout', '-qb', 'feature/BUY-1');
    writeFileSync(join(dir, 'a.ts'), 'export const rate = 3;\n');
    git('commit', '-qam', 'committed change');
    writeFileSync(join(dir, 'a.ts'), 'export const rate = 4;\n');

    const context = await new LocalRepoDiffContext(gitlab()).collect(
      { id: 'local:x', data: { repoPath: dir } },
      {},
    );

    const [change] = context.repoChanges as RepoChange[];
    expect(change.diff).toContain('Committed on feature/BUY-1');
    expect(change.diff).toContain('Not committed yet');
  });

  it('is not this collector\'s event when there is no directory', async () => {
    const context = await new LocalRepoDiffContext(gitlab()).collect(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', issueId: '1' } },
      {},
    );
    expect(context).toEqual({});
  });
});

describe('GitlabBranchDiffContext, on a review that has both', () => {
  it('stays out of it, so the directory is the only source of code', async () => {
    /*
     * The event carries an issue key now, and this collector's whole job is
     * to check out the branch Jira links. Doing that here would review the
     * pushed branch instead of the working copy — the opposite of what was
     * asked, and it would silently win by being wired first.
     */
    const context = await new GitlabBranchDiffContext(gitlab()).collect(
      { id: 'BUY-2397', data: { repoPath: dir, issueKey: 'BUY-2397' } },
      { linkedBranches: [{ name: 'feature/BUY-2397', repositoryUrl: 'https://gitlab/team/api' }] },
    );

    expect(context).toEqual({});
  });
});

describe('what the branch carries', () => {
  it('lists the commits behind the diff, oldest first', async () => {
    /*
     * A branch open for months carries work that was never the ticket's —
     * a change made on another ticket, never merged to the base, still
     * sitting here. The diff flattens all of it into one blob, so without
     * this the review cannot tell whose commit it is reading.
     */
    git('checkout', '-qb', 'feature/BUY-1');
    writeFileSync(join(dir, 'a.ts'), 'export const rate = 2;\n');
    git('commit', '-qam', 'eski iş, başka bilet');
    writeFileSync(join(dir, 'a.ts'), 'export const rate = 3;\n');
    git('commit', '-qam', 'BUY-1 asıl iş');

    const context = await new LocalRepoDiffContext(gitlab()).collect(
      { id: 'BUY-1', data: { repoPath: dir, issueKey: 'BUY-1' } },
      {},
    );

    const [change] = context.repoChanges as RepoChange[];
    expect(change.commits?.map((c) => c.title)).toEqual(['eski iş, başka bilet', 'BUY-1 asıl iş']);
    expect(change.commits?.[0].author).toBe('Test');
    expect(change.commits?.[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('survives a commit subject containing the separator it splits on', async () => {
    // A pipe in a subject would split one commit into two if the format
    // used one; the record separator cannot occur in a subject line.
    git('checkout', '-qb', 'feature/BUY-2');
    writeFileSync(join(dir, 'a.ts'), 'export const rate = 2;\n');
    git('commit', '-qam', 'BUY-2 | ödeme | iade akışı');

    const context = await new LocalRepoDiffContext(gitlab()).collect(
      { id: 'BUY-2', data: { repoPath: dir } },
      {},
    );

    const [change] = context.repoChanges as RepoChange[];
    expect(change.commits).toHaveLength(1);
    expect(change.commits?.[0].title).toBe('BUY-2 | ödeme | iade akışı');
  });
});
