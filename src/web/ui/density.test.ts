// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DetailPane from './components/DetailPane.vue';
import TopBar from './components/TopBar.vue';
import { state, type DetailPayload } from './bridge';
import { meta, tabs } from './detail';
import { session } from './session';

/**
 * How much is on screen before you have read a word.
 *
 * This is not a style rule; it is the defect the redesign was for. The
 * detail header carried sixteen elements in one row, with seven Jira chips
 * under it and seven tabs under that — every control at the same weight, so
 * finding the one you wanted meant reading all of them. "Her şey her yerde",
 * as it was put.
 *
 * Counting what actually renders, rather than what the file contains, is the
 * whole point: an action behind `⋯` is not on screen. The numbers below are
 * ceilings with room in them — they exist to catch a row quietly growing
 * back, not to freeze the design.
 */

const DETAIL: DetailPayload = {
  status: 'awaiting_approval',
  review: { title: 't', markdown: '' },
  reviewPreamble: '',
  reviewTail: '',
  findings: [],
  steps: [],
  prompts: [],
  notes: [],
  history: [],
  fixTargets: {},
  repoChanges: null,
};

/** Every control a reader can see and press right now. */
function visibleControls(html: string): number {
  return (html.match(/<button|<input|<select|<textarea/g) ?? []).length;
}

beforeEach(() => {
  location.hash = '';
  state.issueKey = 'BUY-1';
  state.detail = null;
  meta.value = { summary: 'İade akışı', issueType: 'Bug', status: 'Code Review', assignee: 'Biri' };
  tabs.active = 'review';
  tabs.pinned = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal('fetch', () => new Promise(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
  state.detail = null;
  meta.value = null;
});

describe('how crowded the screen is at rest', () => {
  it('keeps the detail header to one action, its depth, and a menu', async () => {
    /*
     * Was: 7 buttons — İncele, Ata…, Düzelt…, Durdur, Bağlam…, Temizle, ←.
     *
     * Four now: back, how deep to scan, the action, and the overflow. The
     * depth is deliberately one control rather than a pair of options — it
     * configures the press rather than being one, and a two-element switch
     * here would be the first of the sixteen coming back. The ceiling has
     * room for exactly this and nothing more.
     */
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    const head = wrapper.find('.detail-title-row').html();
    expect(visibleControls(head)).toBeLessThanOrEqual(4);
    expect(wrapper.find('.actionMenu-list').exists()).toBe(false);
  });

  it('keeps the Jira chips out of the header', async () => {
    // Was: 7 chips on their own row between the title and the tabs.
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    expect(wrapper.find('.detail-head .meta-chip').exists()).toBe(false);
  });

  it('keeps the tab row short enough to read at a glance', async () => {
    // Was: 7 tabs — Review, Adımlar, Değişiklik, Yama, Doğrulama, Notlar,
    // Geçmiş. Four, grouped by what the reader is doing.
    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    expect(wrapper.findAll('[role="tab"]').length).toBeLessThanOrEqual(4);
  });

  it('keeps the top bar corner to a handful of controls', async () => {
    // Was: 6 — Giriş yap, ⚙, ⤓, ◐, ↻ Yenile, plus chips. Three unlabelled
    // glyphs were three guesses; they are one menu with words in it.
    session.configured = true;
    const wrapper = mount(TopBar);
    await flushPromises();

    expect(visibleControls(wrapper.find('.topbar-right').html())).toBeLessThanOrEqual(3);
  });
});
