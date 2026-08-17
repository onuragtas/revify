import { describe, expect, it, vi, afterEach } from 'vitest';
import { JiraClient } from './jiraClient.js';

function clientWith(entries: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ values: entries, isLast: true, total: entries.length }),
    }),
  );
  return new JiraClient({ baseUrl: 'https://jira.example.com', email: 'a@b.c', apiToken: 't' });
}

afterEach(() => vi.unstubAllGlobals());

describe('getPreReviewAssignee', () => {
  it('returns the developer, not the reviewer the ticket was handed to', async () => {
    // BUY-2473 as it actually happened: the developer moved it to Code
    // Review, then five seconds later reassigned it to the reviewer.
    const jira = clientWith([
      {
        created: '2026-08-13T07:56:14.000+0000',
        items: [{ field: 'assignee', from: 'gokce', fromString: 'Gökçe Koç', to: 'esma', toString: 'Esma Nur COŞKUN' }],
      },
      {
        created: '2026-08-13T13:25:36.000+0000',
        items: [{ field: 'status', fromString: 'In Development', toString: 'Code Review' }],
      },
      {
        created: '2026-08-13T13:25:41.000+0000',
        items: [{ field: 'assignee', from: 'esma', fromString: 'Esma Nur COŞKUN', to: 'burak', toString: 'Burak Kaya' }],
      },
    ]);

    const developer = await jira.getPreReviewAssignee('BUY-2473', 'Code Review');
    expect(developer).toEqual({ accountId: 'esma', displayName: 'Esma Nur COŞKUN' });
  });

  it('handles the other order — reassign first, then move the status', async () => {
    const jira = clientWith([
      {
        created: '2026-08-13T07:56:14.000+0000',
        items: [{ field: 'assignee', from: null, to: 'esma', toString: 'Esma Nur COŞKUN' }],
      },
      {
        created: '2026-08-13T13:25:30.000+0000',
        items: [{ field: 'assignee', from: 'esma', fromString: 'Esma Nur COŞKUN', to: 'burak', toString: 'Burak Kaya' }],
      },
      {
        created: '2026-08-13T13:25:36.000+0000',
        items: [{ field: 'status', toString: 'Code Review' }],
      },
    ]);

    expect(await jira.getPreReviewAssignee('X-1', 'Code Review')).toEqual({
      accountId: 'esma',
      displayName: 'Esma Nur COŞKUN',
    });
  });

  it('uses the most recent trip through review, not the first', async () => {
    const jira = clientWith([
      { created: '2026-08-01T10:00:00.000+0000', items: [{ field: 'assignee', to: 'ali', toString: 'Ali' }] },
      { created: '2026-08-01T11:00:00.000+0000', items: [{ field: 'status', toString: 'Code Review' }] },
      { created: '2026-08-02T10:00:00.000+0000', items: [{ field: 'assignee', to: 'veli', toString: 'Veli' }] },
      { created: '2026-08-02T11:00:00.000+0000', items: [{ field: 'status', toString: 'Code Review' }] },
    ]);

    expect(await jira.getPreReviewAssignee('X-2', 'Code Review')).toEqual({ accountId: 'veli', displayName: 'Veli' });
  });

  it('matches the review status case-insensitively', async () => {
    const jira = clientWith([
      { created: '2026-08-01T10:00:00.000+0000', items: [{ field: 'assignee', to: 'ali', toString: 'Ali' }] },
      { created: '2026-08-01T11:00:00.000+0000', items: [{ field: 'status', toString: 'CODE REVIEW' }] },
    ]);

    expect(await jira.getPreReviewAssignee('X-3', 'code review')).toEqual({ accountId: 'ali', displayName: 'Ali' });
  });

  it('returns null rather than guessing when the issue never entered review', async () => {
    const jira = clientWith([
      { created: '2026-08-01T10:00:00.000+0000', items: [{ field: 'assignee', to: 'ali', toString: 'Ali' }] },
    ]);

    expect(await jira.getPreReviewAssignee('X-4', 'Code Review')).toBeNull();
  });

  it('returns null when the handover took it from nobody', async () => {
    const jira = clientWith([
      { created: '2026-08-01T11:00:00.000+0000', items: [{ field: 'status', toString: 'Code Review' }] },
      {
        created: '2026-08-01T11:00:05.000+0000',
        items: [{ field: 'assignee', from: null, to: 'burak', toString: 'Burak Kaya' }],
      },
    ]);

    expect(await jira.getPreReviewAssignee('X-5', 'Code Review')).toBeNull();
  });
});
