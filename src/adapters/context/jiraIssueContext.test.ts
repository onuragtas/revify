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

const neighbour = {
  key: 'BUY-2401',
  id: '2401',
  relation: 'linked',
  issueType: 'Task',
  status: 'In Progress',
  summary: 'Ödeme ucu',
  description: 'x',
};

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

describe('a neighbour with work in flight', () => {
  it('names the branch, so an absence becomes a question rather than a finding', async () => {
    /*
     * The false blocking finding this exists to stop: a sibling ticket is
     * adding the endpoint right now, on a branch that is not merged, so the
     * reviewer reads the default branch, does not find it, and reports the
     * work as unimplemented.
     */
    const jira = client({
      getRelatedIssues: async () => [neighbour],
      getLinkedBranches: vi.fn(async (id: string) =>
        id === '2401'
          ? [{ name: 'feature/BUY-2401', repositoryUrl: 'https://gitlab/team/payment-gateway' }]
          : [],
      ),
    });

    const context = await new JiraIssueContext(jira).collect({
      id: 'BUY-9',
      data: { issueKey: 'BUY-9', issueId: '9009' },
    });

    const [related] = context.relatedIssues as Array<{ key: string; branches?: unknown[] }>;
    expect(related.key).toBe('BUY-2401');
    expect(related.branches).toEqual([
      { name: 'feature/BUY-2401', repositoryUrl: 'https://gitlab/team/payment-gateway' },
    ]);
  });

  it('costs the review nothing when a neighbour\'s dev panel cannot be read', async () => {
    // Background is background: a ticket with no branch, or one whose panel
    // is unreadable, must not stop a review.
    const jira = client({
      getRelatedIssues: async () => [neighbour],
      getLinkedBranches: vi.fn(async (id: string) => {
        if (id === '2401') throw new Error('Jira API 403');
        return [];
      }),
    });

    const context = await new JiraIssueContext(jira).collect({
      id: 'BUY-9',
      data: { issueKey: 'BUY-9', issueId: '9009' },
    });

    const [related] = context.relatedIssues as Array<{ key: string; branches?: unknown[] }>;
    expect(related.key).toBe('BUY-2401');
    expect(related.branches).toBeUndefined();
  });
});
