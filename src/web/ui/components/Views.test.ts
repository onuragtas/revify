// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AssignedView from './AssignedView.vue';
import DecisionsView from './DecisionsView.vue';
import { state } from '../bridge';
import { views } from '../views';

const DECISIONS = {
  jiraBaseUrl: 'https://jira.example.com',
  items: [
    {
      issueKey: 'BUY-1',
      summary: 'İade akışı',
      decision: 'rejected',
      decidedAt: '2026-08-27T10:00:00.000Z',
      rejectionReason: 'transaction eksik',
      jiraStatus: 'In Development',
      assignee: 'Biri',
      severity: 'blocking',
      decidedByName: null,
      local: true,
    },
    {
      issueKey: 'BUY-2',
      summary: null,
      decision: 'approved',
      decidedAt: '2026-08-26T10:00:00.000Z',
      rejectionReason: null,
      jiraStatus: null,
      assignee: null,
      severity: '',
      decidedByName: 'Bir Meslektaş',
      local: false,
    },
  ],
};

function stub(payload: unknown) {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => payload }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
});

describe('DecisionsView', () => {
  it('shows the decision next to where the ticket stands now', async () => {
    stub(DECISIONS);
    const wrapper = mount(DecisionsView);
    await flushPromises();

    const first = wrapper.findAll('tbody tr')[0];
    expect(first.text()).toContain('BUY-1');
    expect(first.text()).toContain('reddedildi');
    // The decision and the ticket's current state are different facts;
    // seeing them side by side is the point of this view.
    expect(first.text()).toContain('In Development');
    expect(first.text()).toContain('transaction eksik');
  });

  it('names whose call it was, but not your own', async () => {
    stub(DECISIONS);
    const wrapper = mount(DecisionsView);
    await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    expect(rows[0].text()).toContain('sen');
    expect(rows[1].text()).toContain('Bir Meslektaş');
  });

  it('distinguishes "could not read Jira" from "nothing to read"', async () => {
    stub(DECISIONS);
    const wrapper = mount(DecisionsView);
    await flushPromises();

    const rows = wrapper.findAll('tbody tr');
    // A local decision with no status means Jira was unreachable; a team
    // one was simply never looked up.
    expect(rows[1].text()).toContain('—');
    expect(wrapper.text()).not.toContain('okunamadı');
  });

  it('links each issue to Jira', async () => {
    stub(DECISIONS);
    const wrapper = mount(DecisionsView);
    await flushPromises();
    expect(wrapper.find('a.jiraLink').attributes('href')).toBe('https://jira.example.com/browse/BUY-1');
  });

  it('says so rather than showing an empty table', async () => {
    stub({ items: [], jiraBaseUrl: '' });
    const wrapper = mount(DecisionsView);
    await flushPromises();
    expect(wrapper.text()).toContain('Henüz karar verilmiş bir iş yok');
  });

  it('reports the count to the tab bar', async () => {
    stub(DECISIONS);
    mount(DecisionsView);
    await flushPromises();
    expect(views.counts.decisions).toEqual({ count: 2, alert: false });
  });

  it('says why when it cannot load', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('bağlantı yok');
    });
    const wrapper = mount(DecisionsView);
    await flushPromises();
    expect(wrapper.text()).toContain('Yüklenemedi');
  });
});

const ASSIGNMENTS = {
  items: [
    {
      issueKey: 'BUY-9',
      summary: 'Kupon',
      note: 'ödeme ekranına bak',
      assignedByName: 'Biri',
      assignedAt: new Date(Date.now() - 90 * 60000).toISOString(),
      teamId: 't1',
    },
  ],
};

describe('AssignedView', () => {
  it('shows what was handed to you, and how long ago', async () => {
    stub(ASSIGNMENTS);
    const wrapper = mount(AssignedView);
    await flushPromises();

    expect(wrapper.text()).toContain('BUY-9');
    expect(wrapper.text()).toContain('ödeme ekranına bak');
    expect(wrapper.text()).toContain('1 saat önce');
  });

  it('marks a waiting assignment as urgent, not merely counted', async () => {
    stub(ASSIGNMENTS);
    mount(AssignedView);
    await flushPromises();
    expect(views.counts.assigned).toEqual({ count: 1, alert: true });
  });

  it('opens the issue in the review list when its key is clicked', async () => {
    stub(ASSIGNMENTS);
    const wrapper = mount(AssignedView);
    await flushPromises();

    await wrapper.find('.issue-key').trigger('click');
    expect(state.issueKey).toBe('BUY-9');
  });

  it('is empty rather than broken when there is no backend to ask', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('sunucu yok');
    });

    const wrapper = mount(AssignedView);
    await flushPromises();
    expect(wrapper.text()).toContain('Sana atanmış iş yok');
    expect(views.counts.assigned).toEqual({ count: 0, alert: false });
  });
});
