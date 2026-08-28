// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DetailPane from './DetailPane.vue';
import { state, type DetailPayload } from '../bridge';
import { meta, tabs } from '../detail';

const DETAIL: DetailPayload = {
  status: 'awaiting_approval',
  review: { title: 't', markdown: '' },
  reviewPreamble: '',
  reviewTail: '',
  findings: [],
  steps: [{ ts: '2026-08-28T10:00:00Z', message: 'started' }],
  prompts: [],
  notes: [],
  history: [],
  fixTargets: {},
  repoChanges: null,
};

beforeEach(() => {
  location.hash = '';
  state.issueKey = 'BUY-1';
  state.detail = null;
  meta.value = null;
  tabs.active = 'review';
  tabs.pinned = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal('fetch', () => new Promise(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
  state.detail = null;
});

describe('DetailPane while the first payload is in flight', () => {
  it('claims nothing about data it has not received', async () => {
    /*
     * Every panel has an empty state, and each one is a statement of fact:
     * "no review", "nothing to show", "no description". Rendered before the
     * poll answers they are all wrong — you open an issue that has a review
     * and are told it has none.
     */
    const wrapper = mount(DetailPane);
    await flushPromises();

    expect(wrapper.text()).toContain('okunuyor…');
    expect(wrapper.text()).not.toContain('henüz review yok');
    expect(wrapper.text()).not.toContain('Gösterilecek değişiklik yok');
    expect(wrapper.text()).not.toContain('açıklama yok');
  });

  it('shows the panels once it arrives', async () => {
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    // The panel-wide note is gone; the Jira description keeps its own,
    // because that is a second request and still in flight.
    expect(wrapper.text()).not.toContain('BUY-1 okunuyor…');
    expect(wrapper.findAll('[role="tabpanel"]').length).toBe(4);
    expect(wrapper.text()).toContain('AI Review');
  });

  it('groups the old seven tabs into four without dropping a panel', async () => {
    /*
     * The tabs went 7 → 4 because everything carried the same weight and
     * nothing could be found. Grouping is only allowed to move a panel, not
     * to lose one — so this asserts the four panels *and* that the sections
     * which stopped being tabs are still rendered, under the tab they moved
     * to.
     */
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    expect(wrapper.findAll('[role="tab"]').map((t) => t.text().trim())).toEqual([
      'Review',
      'Değişiklik',
      'Yama',
      'Süreç',
    ]);

    // Doğrulama and Notlar are sections of Review now: disputing a finding
    // should not happen on a screen where the finding is invisible.
    const review = wrapper.findAll('[role="tabpanel"]')[0];
    expect(review.text()).toContain('AI Review');
    expect(review.text()).toContain('Review notları');

    // Adımlar, the prompts and Geçmiş are all "how did this review happen".
    const process = wrapper.findAll('[role="tabpanel"]')[3];
    expect(process.find('#steps').exists()).toBe(true);
    expect(process.find('#promptCards').exists()).toBe(true);
    expect(process.text()).toContain('önceki inceleme yok');
  });

  it('keeps the decision out of the scrolling review', async () => {
    /*
     * Onayla/Reddet used to be a card at the bottom of the review, so a long
     * review hid the only thing this tool exists for behind a scroll. It
     * lives in the panel's footer now — a sibling of the scroller, not a
     * child of it.
     */
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    expect(wrapper.find('.decisionBar').exists()).toBe(true);
    expect(wrapper.find('.detail-scroll .decisionBar').exists()).toBe(false);
    expect(wrapper.find('.decisionBar').text()).toContain('Onayla');
  });

  it('shows one action and puts the rest behind a menu', async () => {
    /*
     * Sixteen elements shared the header row. The reader should see the next
     * move — start the review — and find the occasional ones (Ata, Bağlam,
     * Temizle) only when they go looking.
     */
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    const actions = wrapper.find('.detail-head-actions');
    expect(actions.text()).toContain('Yeniden incele');
    expect(actions.text()).not.toContain('Bağlam…');

    await wrapper.find('.actionMenu > .btn').trigger('click');
    expect(wrapper.find('.actionMenu-list').text()).toContain('Bağlam…');
    expect(wrapper.find('.actionMenu-list').text()).toContain('Temizle');
  });

  it('moves the Jira chips into the card that describes the issue', async () => {
    // Seven chips under the header competed with the review for attention,
    // while saying nothing the reader needs mid-decision.
    meta.value = { summary: 's', description: 'd', issueType: 'Bug', assignee: 'x' };
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    expect(wrapper.find('.detail-head .meta-chips').exists()).toBe(false);
    expect(wrapper.find('.issue-desc-card .meta-chips').text()).toContain('Bug');
  });

  it('says the Jira read failed rather than reporting no description', async () => {
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    // Before the second request answers, the description is unknown — not
    // absent.
    expect(wrapper.find('.issue-desc-card').text()).toContain('Jira\'dan okunuyor…');
  });
});

describe('starting a review', () => {
  it('says why the server refused, instead of a button that does nothing', async () => {
    /*
     * This was `.catch(() => {})` with the response discarded, so every way
     * /start can decline vanished. On a local review it declined every
     * time — the id is not a Jira key — and "Yeniden incele" simply did
     * nothing, with only a 400 in the devtools console to show for it.
     */
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/start')) {
        return { ok: false, status: 400, json: async () => ({ error: 'bir issue anahtarına benzemiyor' }) };
      }
      return new Promise(() => {});
    });

    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    await wrapper.find('.detail-head-actions .btn-primary').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('bir issue anahtarına benzemiyor');
  });

  it('does not blame the server for a refusal it never explained', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/start')) return { ok: false, status: 500, json: async () => ({}) };
      return new Promise(() => {});
    });

    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    await wrapper.find('.detail-head-actions .btn-primary').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('HTTP 500');
  });
});

describe('DetailPane accessibility', () => {
  it('names the buttons that are only a symbol', async () => {
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    // `title` is a tooltip, not an accessible name.
    const back = wrapper.findAll('button').find((b) => b.text().trim() === '←')!;
    expect(back.attributes('aria-label')).toBe('Listeye dön');
  });

  it('says the tabs are tabs, and which one is showing', async () => {
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    expect(wrapper.find('.tabs').attributes('role')).toBe('tablist');
    const selected = wrapper.findAll('[role="tab"]').filter((t) => t.attributes('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].text()).toContain('Review');
  });

  it('announces the step log as it grows', async () => {
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    const log = wrapper.find('#steps');
    expect(log.attributes('aria-live')).toBe('polite');
    expect(log.attributes('role')).toBe('log');
  });
});
