import { describe, expect, it, vi } from 'vitest';
import { JiraIssueContext } from './jiraIssueContext.js';
import type { JiraClient } from '../../clients/jiraClient.js';
import type { TriggerEvent } from '../../core/types.js';

function client(over: Partial<Record<keyof JiraClient, unknown>> = {}) {
  return {
    getIssue: async () => ({ key: 'BUY-9', fields: {} }),
    getLinkedBranches: vi.fn(async () => []),
    getComments: async () => [],
    getRelatedIssues: async () => [],
    getAttachments: async () => [],
    ...over,
  } as unknown as JiraClient;
}

describe('JiraIssueContext', () => {
  it('does not ask the development panel about an issue it has no id for', async () => {
    /*
     * A local review attached to a ticket by hand has a key — a human
     * confirmed one — but never came from a Jira search, so it has no
     * internal id. This used to interpolate `undefined` into the dev-status
     * URL; Jira answered 400 "An invalid ID was provided", the collector
     * threw, and the whole run failed before the model was ever called.
     */
    const jira = client();
    const event: TriggerEvent = {
      id: 'BUY-9',
      data: { issueKey: 'BUY-9', repoPath: '/home/me/api', summary: 'x' },
    };

    const context = await new JiraIssueContext(jira).collect(event);

    expect(jira.getLinkedBranches).not.toHaveBeenCalled();
    expect(context.linkedBranches).toEqual([]);
    // And the issue itself still travels — that is the point of attaching.
    expect(context.jiraIssue).toBeDefined();
  });

  it('asks it when the event came from Jira and has one', async () => {
    const jira = client();
    await new JiraIssueContext(jira).collect({
      id: 'BUY-9',
      data: { issueKey: 'BUY-9', issueId: '9009' },
    });

    expect(jira.getLinkedBranches).toHaveBeenCalledWith('9009');
  });

  it('is not this collector\'s event when there is no key at all', async () => {
    const jira = client();
    const context = await new JiraIssueContext(jira).collect({
      id: 'local:team/api@main',
      data: { repoPath: '/home/me/api' },
    });

    expect(context).toEqual({});
    expect(jira.getLinkedBranches).not.toHaveBeenCalled();
  });
});
