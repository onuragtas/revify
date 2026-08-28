import { describe, expect, it } from 'vitest';
import { issueKeyFromBranch } from './issueEvent.js';

describe('issueKeyFromBranch', () => {
  it('reads the ticket a branch was cut for, however it was named', () => {
    expect(issueKeyFromBranch('feature/BUY-2397')).toBe('BUY-2397');
    expect(issueKeyFromBranch('feature/BUY-2397-km-muayene-bedeli')).toBe('BUY-2397');
    expect(issueKeyFromBranch('BUY-2397')).toBe('BUY-2397');
    expect(issueKeyFromBranch('bugfix/buy-2397_hotfix')).toBe('BUY-2397');
    expect(issueKeyFromBranch('onur/EPA-12/refactor')).toBe('EPA-12');
  });

  it('finds nothing in a branch that names no ticket', () => {
    expect(issueKeyFromBranch('main')).toBeNull();
    expect(issueKeyFromBranch('develop')).toBeNull();
    expect(issueKeyFromBranch('feature/add-caching')).toBeNull();
  });

  it('does not read a date as an issue', () => {
    // A key has to start with a letter, so `2024-01-15` cannot be one —
    // and a release branch is exactly where this would otherwise misfire.
    expect(issueKeyFromBranch('release/2024-01-15')).toBeNull();
    expect(issueKeyFromBranch('release/v2024-01')).toBe('V2024-01');
  });

  it('needs a project key long enough to be one', () => {
    // Jira project keys are two characters or more; without the floor,
    // `v-2` and `x-1` would both look like tickets.
    expect(issueKeyFromBranch('v-2')).toBeNull();
    expect(issueKeyFromBranch('hotfix/x-1')).toBeNull();
  });

  it('takes the first key when a name carries two', () => {
    expect(issueKeyFromBranch('feature/BUY-1-and-EPA-2')).toBe('BUY-1');
  });
});
