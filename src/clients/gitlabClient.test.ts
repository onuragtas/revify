import { describe, expect, it } from 'vitest';
import { parseProjectPathFromUrl } from './gitlabClient.js';

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
