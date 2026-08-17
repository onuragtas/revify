import { describe, expect, it } from 'vitest';
import { gitFailureReason, GIT_TIMEOUT_MS } from './repoCache.js';

describe('gitFailureReason', () => {
  it('reports git\'s own diagnosis instead of the command that failed', () => {
    // Node puts the whole command line in `message`, which is what used to
    // reach the UI — the reason was cut off long before it got there.
    const err = {
      message:
        'Command failed: git clone --depth 1 --single-branch --branch master https://gitlab.example.com/team/big-repo.git /some/very/long/cache/path',
      stderr: "remote: Enumerating objects: 21398, done.\nfatal: Authentication failed for 'https://gitlab.example.com/team/big-repo.git/'",
    };

    const reason = gitFailureReason(err);
    expect(reason).toContain('Authentication failed');
    expect(reason).not.toContain('--single-branch');
  });

  it('names the timeout, which has no stderr to explain itself', () => {
    expect(gitFailureReason({ killed: true, stderr: '' })).toBe(`timed out after ${GIT_TIMEOUT_MS / 1000}s`);
  });

  it('skips progress frames, which are the last lines but say nothing', () => {
    const reason = gitFailureReason({
      stderr: 'fatal: Remote branch nope not found in upstream origin\nReceiving objects:  99% (100/101)',
    });
    expect(reason).toContain('Remote branch nope not found');
  });

  it('falls back to the message when git said nothing on stderr', () => {
    expect(gitFailureReason({ message: 'spawn git ENOENT' })).toBe('spawn git ENOENT');
  });
});
