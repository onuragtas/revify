import { describe, expect, it } from 'vitest';
import { GitlabClient, parseProjectPathFromUrl } from './gitlabClient.js';
import { afterEach, vi } from 'vitest';

describe('parseProjectPathFromUrl', () => {
  it('extracts the project path from a plain repository URL', () => {
    expect(parseProjectPathFromUrl('https://gitlab.com/my-group/my-project')).toBe('my-group/my-project');
  });

  it('strips a trailing .git suffix', () => {
    expect(parseProjectPathFromUrl('https://gitlab.com/my-group/my-project.git')).toBe('my-group/my-project');
  });

  it('handles nested subgroups', () => {
    expect(parseProjectPathFromUrl('https://gitlab.example.com/org/team/repo')).toBe('org/team/repo');
  });

  it('strips a trailing slash', () => {
    expect(parseProjectPathFromUrl('https://gitlab.com/my-group/my-project/')).toBe('my-group/my-project');
  });
});

describe('compareBranches', () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new GitlabClient({ baseUrl: 'https://gitlab.example.com', token: 't' });

  function stub(body: unknown) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => body, text: async () => '' };
    });
    return urls;
  }

  it('returns the commits behind the diff, from the same response', async () => {
    /*
     * The commits ride along on the compare response, so knowing what a
     * branch carries costs no extra call. It matters because a long-lived
     * branch carries work that is not the ticket's, and the diff flattens
     * all of it into one blob.
     */
    const urls = stub({
      diffs: [{ new_path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' }],
      commits: [
        {
          id: '9ec6c195aa11',
          title: 'Add shopping loan cancellation',
          author_name: 'onuragtas',
          created_at: '2025-12-12T17:41:00.000+03:00',
        },
      ],
    });

    const compared = await client().compareBranches('team/api', 'master', 'feature/BUY-1');

    expect(urls).toHaveLength(1);
    expect(compared.commits).toEqual([
      {
        sha: '9ec6c195',
        title: 'Add shopping loan cancellation',
        author: 'onuragtas',
        date: '2025-12-12T17:41:00.000+03:00',
      },
    ]);
    expect(compared.files).toEqual([{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' }]);
  });

  it('is an empty list when the response carries none', async () => {
    // Not every GitLab version returns them, and a missing list must not
    // cost the diff.
    stub({ diffs: [{ new_path: 'a.ts', diff: 'x' }] });
    expect((await client().compareBranches('team/api', 'master', 'b')).commits).toEqual([]);
  });
});
