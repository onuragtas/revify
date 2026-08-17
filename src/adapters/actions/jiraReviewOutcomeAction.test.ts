import { describe, expect, it, vi } from 'vitest';
import { JiraReviewOutcomeAction } from './jiraReviewOutcomeAction.js';
import type { JiraClient } from '../../clients/jiraClient.js';

function makeJira() {
  return {
    addComment: vi.fn().mockResolvedValue(undefined),
    transitionTo: vi.fn().mockResolvedValue(undefined),
    assign: vi.fn().mockResolvedValue(undefined),
    getPreReviewAssignee: vi.fn().mockResolvedValue({ accountId: 'dev-1', displayName: 'Esma Nur COSKUN' }),
  } as unknown as JiraClient & {
    addComment: ReturnType<typeof vi.fn>;
    transitionTo: ReturnType<typeof vi.fn>;
    assign: ReturnType<typeof vi.fn>;
    getPreReviewAssignee: ReturnType<typeof vi.fn>;
  };
}

const config = {
  applyChanges: true,
  approveStatus: 'Ready for Stage',
  rejectStatus: 'In Development',
};

const event = {
  id: 'BUY-1',
  data: { issueKey: 'BUY-1', status: 'Code Review', assignee: 'Burak Kaya', assigneeAccountId: 'acc-123' },
};

const taskResult = {
  title: 'Code review: BUY-1',
  markdown: ['Özet.', '', '[?] Bir soru?', '[note] Bir not.', '', 'Verdict: Approve'].join('\n'),
};

describe('JiraReviewOutcomeAction', () => {
  it('on approve: comments, moves to the approve status, reassigns to the developer', async () => {
    const jira = makeJira();
    await new JiraReviewOutcomeAction(jira, config).execute(event, taskResult);

    expect(jira.transitionTo).toHaveBeenCalledWith('BUY-1', 'Ready for Stage');
    expect(jira.assign).toHaveBeenCalledWith('BUY-1', 'dev-1');

    // Internal bookkeeping must not reach the issue.
    const [, comment] = jira.addComment.mock.calls[0];
    expect(comment).not.toContain('[note]');
    expect(comment).not.toContain('[?]');
    expect(comment).toContain('Verdict: Approve');
  });

  it('on reject: leads with the reason, moves to the reject status, reassigns', async () => {
    const jira = makeJira();
    await new JiraReviewOutcomeAction(jira, config).executeRejected!(event, taskResult, 'Eksik test var.');

    const [, comment] = jira.addComment.mock.calls[0];
    expect(comment).toContain('Review reddedildi.');
    expect(comment).toContain('Eksik test var.');
    // The reason must come before the review body, since that's why it came back.
    expect(comment.indexOf('Eksik test var.')).toBeLessThan(comment.indexOf('Verdict: Approve'));

    expect(jira.transitionTo).toHaveBeenCalledWith('BUY-1', 'In Development');
    expect(jira.assign).toHaveBeenCalledWith('BUY-1', 'dev-1');
  });

  it('on reject with no reason: posts the review alone, without a placeholder', async () => {
    const jira = makeJira();
    await new JiraReviewOutcomeAction(jira, config).executeRejected!(event, taskResult, '');

    const [, comment] = jira.addComment.mock.calls[0];
    expect(comment).toContain('Review reddedildi.');
    expect(comment).not.toContain('gerekçe belirtilmedi');
    expect(comment).toContain('Verdict: Approve');
    expect(jira.transitionTo).toHaveBeenCalledWith('BUY-1', 'In Development');
  });

  it('writes nothing at all while applyChanges is off', async () => {
    const jira = makeJira();
    await new JiraReviewOutcomeAction(jira, { ...config, applyChanges: false }).execute(event, taskResult);

    expect(jira.addComment).not.toHaveBeenCalled();
    expect(jira.transitionTo).not.toHaveBeenCalled();
    expect(jira.assign).not.toHaveBeenCalled();
  });

  it('comments and transitions even when the changelog names no developer', async () => {
    const jira = makeJira();
    jira.getPreReviewAssignee.mockResolvedValueOnce(null);
    await new JiraReviewOutcomeAction(jira, config).execute(
      { id: 'BUY-2', data: { issueKey: 'BUY-2', status: 'Code Review' } },
      taskResult,
    );

    expect(jira.addComment).toHaveBeenCalled();
    expect(jira.transitionTo).toHaveBeenCalledWith('BUY-2', 'Ready for Stage');
    // Better to leave the assignee alone than to unassign the issue.
    expect(jira.assign).not.toHaveBeenCalled();
  });

  it('comments before transitioning, so a failed transition still records the review', async () => {
    const jira = makeJira();
    jira.transitionTo.mockRejectedValueOnce(new Error('no such transition'));

    await expect(new JiraReviewOutcomeAction(jira, config).execute(event, taskResult)).rejects.toThrow(
      /no such transition/,
    );
    expect(jira.addComment).toHaveBeenCalled();
  });
});

describe('JiraReviewOutcomeAction — who it goes back to', () => {
  it('asks the changelog for the developer instead of reusing the current assignee', async () => {
    const jira = makeJira();
    await new JiraReviewOutcomeAction(jira, config).execute(event, taskResult);

    // The event still carries "Burak Kaya" — the reviewer the issue was
    // handed to. Assigning to them is the no-op this bug was made of.
    expect(jira.getPreReviewAssignee).toHaveBeenCalledWith('BUY-1', 'Code Review');
    expect(jira.assign).toHaveBeenCalledWith('BUY-1', 'dev-1');
    expect(jira.assign).not.toHaveBeenCalledWith('BUY-1', 'acc-123');
  });

  it('still comments and transitions when the changelog cannot be read', async () => {
    const jira = makeJira();
    jira.getPreReviewAssignee.mockRejectedValueOnce(new Error('403 Forbidden'));

    await new JiraReviewOutcomeAction(jira, config).execute(event, taskResult);

    expect(jira.addComment).toHaveBeenCalled();
    expect(jira.transitionTo).toHaveBeenCalledWith('BUY-1', 'Ready for Stage');
    expect(jira.assign).not.toHaveBeenCalled();
  });
});
