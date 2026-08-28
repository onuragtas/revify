// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import IssueList from './IssueList.vue';
import PendingView from './PendingView.vue';
import { state } from '../bridge';
import { views } from '../views';
import { localReviewTarget, modals } from '../uiState';

const ITEMS = [
  {
    issueKey: 'BUY-1',
    summary: 'İade akışı',
    assignee: 'Biri',
    jiraStatus: 'Code Review',
    updated: '2026-08-27T10:00:00.000Z',
    reviewStatus: 'awaiting_approval',
    trigger: 'auto' as const,
  },
  {
    issueKey: 'BUY-2',
    summary: 'Kupon',
    assignee: null,
    jiraStatus: 'Code Review',
    updated: '2026-08-26T10:00:00.000Z',
    reviewStatus: 'idle',
  },
];

function stub(byUrl: Record<string, unknown>, calls: Array<{ url: string; body: unknown }> = []) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    // Longest prefix wins: `/api/reviews/local` is not `/api/reviews`, and
    // matching on declaration order would answer it with the issue list.
    const key = Object.keys(byUrl)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return { ok: true, json: async () => (key ? byUrl[key] : {}) };
  });
  return calls;
}

beforeEach(() => {
  state.issueKey = null;
  modals.settings = false;
  modals.localReview = false;
  localReviewTarget.path = '';
  views.counts = {};
});
afterEach(() => vi.unstubAllGlobals());

describe('IssueList', () => {
  it('lists what the poll found, with its state and who has it', async () => {
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList);
    await flushPromises();

    const cards = wrapper.findAll('.issue-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain('BUY-1');
    expect(cards[0].text()).toContain('onay bekliyor');
    expect(cards[0].text()).toContain('oto');
    expect(cards[1].text()).toContain('atanmamış');
  });

  it('filters on key and on summary', async () => {
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList);
    await flushPromises();

    await wrapper.find('input').setValue('kupon');
    expect(wrapper.findAll('.issue-card')).toHaveLength(1);
    expect(wrapper.text()).toContain('1/2');
  });

  it('marks the open issue without reloading the list', async () => {
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList);
    await flushPromises();

    state.issueKey = 'BUY-2';
    await flushPromises();
    const selected = wrapper.findAll('.issue-card').filter((c) => c.classes().includes('selected'));
    expect(selected).toHaveLength(1);
    expect(selected[0].text()).toContain('BUY-2');
  });

  it('goes straight into an issue typed by key', async () => {
    // Typing a key is a request to look at it, not to be told it now
    // appears in a list somewhere.
    const calls = stub({ '/api/reviews': { items: ITEMS }, '/api/reviews/BUY-9': { ok: true } });
    const wrapper = mount(IssueList);
    await flushPromises();

    await wrapper.find('.byKey .input').setValue('buy-9');
    await wrapper.find('.byKey .btn').trigger('click');
    await flushPromises();

    expect(calls.some((c) => c.url === '/api/reviews/BUY-9/start')).toBe(true);
    expect(state.issueKey).toBe('BUY-9');
  });

  it('works out whether it was handed a key or a directory', async () => {
    /*
     * There were two boxes stacked above the list, "by key" and "by path",
     * which made the reader classify their own input before typing it. A
     * Jira key and a directory do not look alike, so one box decides — and
     * says which it decided, because a silent guess is worse than a question.
     */
    const calls = stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList);
    await flushPromises();

    await wrapper.find('.byKey .input').setValue('~/projects/api');
    expect(wrapper.find('#byKeyResult').text()).toContain('dizin');

    await wrapper.find('.byKey .btn').trigger('click');
    await flushPromises();

    // A directory opens the dialog rather than starting anything: the branch
    // may name a Jira ticket, and only a person can confirm which.
    expect(modals.localReview).toBe(true);
    expect(localReviewTarget.path).toBe('~/projects/api');
    expect(calls.some((c) => c.url.startsWith('/api/reviews/local'))).toBe(false);
  });

  it('says it read a bare word as a Jira key before acting on it', async () => {
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList);
    await flushPromises();

    await wrapper.find('.byKey .input').setValue('BUY-9');
    expect(wrapper.find('#byKeyResult').text()).toContain('anahtar');
  });

  it('opens the settings screen when a first run has nothing to list', async () => {
    // An error the reader cannot act on is worse than the one screen that
    // fixes it.
    stub({ '/api/reviews': { error: 'Önce kimlik bilgilerini gir', setupRequired: true } });
    mount(IssueList);
    await flushPromises();
    expect(modals.settings).toBe(true);
  });

  it('says the server is unreachable rather than showing an empty queue', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('bağlantı yok');
    });
    const wrapper = mount(IssueList);
    await flushPromises();
    expect(wrapper.text()).toContain('Sunucuya ulaşılamadı');
    // Not "no matching issues": that would read as a working, empty queue.
    expect(wrapper.text()).not.toContain('Eşleşen issue yok');
  });

  it('reports how much is waiting on you, from the cheap poll', async () => {
    stub({
      '/api/reviews': { items: ITEMS },
      '/api/review-states': { items: [{ issueKey: 'BUY-1', reviewStatus: 'awaiting_approval' }] },
    });
    const wrapper = mount(IssueList);
    await flushPromises();

    // The refresh runs on a timer; calling it directly is what the timer does.
    await (wrapper.vm as unknown as { $: { setupState: Record<string, () => Promise<void>> } }).$
      .setupState.refreshStates();
    await flushPromises();
    expect(views.counts.pending).toEqual({ count: 1, alert: true });
  });
});

describe('PendingView', () => {
  it('shows how long each has been waiting', async () => {
    stub({
      '/api/pending': {
        items: [
          {
            issueKey: 'BUY-1',
            summary: 'İade',
            reviewedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
            reviewSeq: 4,
            openQuestions: 2,
          },
        ],
      },
    });
    const wrapper = mount(PendingView);
    await flushPromises();

    expect(wrapper.text()).toContain('BUY-1');
    expect(wrapper.text()).toContain('3 saat');
    expect(wrapper.text()).toContain('#4');
    expect(wrapper.text()).toContain('2');
  });

  it('opens the review when a row is clicked', async () => {
    stub({ '/api/pending': { items: [{ issueKey: 'BUY-1', summary: null, reviewedAt: '' }] } });
    const wrapper = mount(PendingView);
    await flushPromises();

    await wrapper.find('tr.clickable').trigger('click');
    expect(state.issueKey).toBe('BUY-1');
  });

  it('says so when nothing is waiting', async () => {
    stub({ '/api/pending': { items: [] } });
    const wrapper = mount(PendingView);
    await flushPromises();
    expect(wrapper.text()).toContain('Onay bekleyen iş yok');
  });
});

describe('IssueList — before the first answer', () => {
  it('does not send anyone to fix a JQL that was never wrong', async () => {
    // "Eşleşen issue yok — JQL'i kontrol et" is the first thing a person
    // sees when the app opens. Before the poll answers it is simply false,
    // and it sends them to edit a config file that was right all along.
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    const wrapper = mount(IssueList);
    await flushPromises();

    expect(wrapper.text()).toContain("issue'lar okunuyor…");
    expect(wrapper.text()).not.toContain('Eşleşen issue yok');
    expect(wrapper.text()).not.toContain('JQL');
  });

  it('stops saying it once the answer arrives', async () => {
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList);
    await flushPromises();

    expect(wrapper.text()).not.toContain("issue'lar okunuyor…");
    expect(wrapper.findAll('.issue-card')).toHaveLength(2);
  });

  it('reports an empty queue as empty, not as a failure', async () => {
    stub({ '/api/reviews': { items: [] } });
    const wrapper = mount(IssueList);
    await flushPromises();

    expect(wrapper.text()).toContain('Eşleşen issue yok');
    expect(wrapper.text()).toContain('JQL');
  });
});

describe('IssueList — keyboard', () => {
  /** A real key event on the document, which is where the handler listens. */
  const press = (key: string, target?: Element) =>
    (target ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );

  it('walks the list with j and k, and opens with Enter', async () => {
    // Reaching for the mouse between every issue is what makes a queue feel
    // long; this is the loop the tool exists for.
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList, { attachTo: document.body });
    await flushPromises();

    press('j');
    await nextTick();
    expect(wrapper.findAll('.issue-card')[0].classes()).toContain('cursor');

    press('j');
    await nextTick();
    expect(wrapper.findAll('.issue-card')[1].classes()).toContain('cursor');

    press('k');
    await nextTick();
    expect(wrapper.findAll('.issue-card')[0].classes()).toContain('cursor');

    press('Enter');
    await flushPromises();
    expect(state.issueKey).toBe('BUY-1');
    wrapper.unmount();
  });

  it('leaves the keys alone while someone is typing', async () => {
    // "j" belongs in a rejection reason as much as anywhere else.
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList, { attachTo: document.body });
    await flushPromises();

    press('j', wrapper.find('input').element);
    await nextTick();
    expect(wrapper.findAll('.issue-card').some((c) => c.classes().includes('cursor'))).toBe(false);
    wrapper.unmount();
  });

  it('drops the cursor when the list under it changes', async () => {
    // A filtered list is a different list; a cursor pointing into the old one
    // would land on whatever happens to sit at that index now.
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList, { attachTo: document.body });
    await flushPromises();

    press('j');
    await nextTick();
    await wrapper.find('input').setValue('kupon');
    await nextTick();
    expect(wrapper.findAll('.issue-card').some((c) => c.classes().includes('cursor'))).toBe(false);
    wrapper.unmount();
  });

  it('sends / to the filter box', async () => {
    stub({ '/api/reviews': { items: ITEMS } });
    const wrapper = mount(IssueList, { attachTo: document.body });
    await flushPromises();

    press('/');
    await nextTick();
    expect(document.activeElement).toBe(wrapper.find('input').element);
    wrapper.unmount();
  });
});
