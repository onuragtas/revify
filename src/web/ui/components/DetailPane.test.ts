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
    expect(wrapper.findAll('[role="tabpanel"]').length).toBe(7);
    expect(wrapper.text()).toContain('AI Review');
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
