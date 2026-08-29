// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PendingView from './PendingView.vue';
import { state } from '../bridge';

const ITEMS = [
  { issueKey: 'BUY-1', summary: 'İade akışı', reviewedAt: '2026-08-27T10:00:00.000Z' },
  { issueKey: 'BUY-2', summary: 'Kupon', reviewedAt: '2026-08-26T10:00:00.000Z' },
  { issueKey: 'BUY-3', summary: 'Barkod', reviewedAt: '2026-08-25T10:00:00.000Z' },
];

/** Records every request, and answers /api/pending with `items`. */
function stub(options: { failOn?: string[] } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (options.failOn?.some((k) => String(url).includes(k))) {
      return { ok: false, json: async () => ({ error: 'silinemedi' }) };
    }
    return { ok: true, json: async () => ({ items: ITEMS }) };
  });
  return calls;
}

beforeEach(() => {
  vi.stubGlobal('confirm', () => true);
  state.issueKey = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
});

describe('PendingView selection', () => {
  it('offers no action until something is selected', async () => {
    const wrapper = mount(PendingView);
    await flushPromises();

    expect(wrapper.text()).not.toContain('işi temizle');
  });

  it('clears everything picked, in one confirmed act', async () => {
    /*
     * Clearing is destructive and usually plural: a row here is a review
     * waiting on a decision, and the reason to clear one is almost always
     * "these are stale, wipe them". Doing twenty one at a time is the
     * tedium this replaces.
     */
    const calls = stub();
    const wrapper = mount(PendingView);
    await flushPromises();

    const boxes = wrapper.findAll('tbody input[type="checkbox"]');
    await boxes[0].setValue(true);
    await boxes[2].setValue(true);
    expect(wrapper.text()).toContain('2 işi temizle');

    await wrapper.find('.btn-reject').trigger('click');
    await flushPromises();

    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toEqual(['/api/reviews/BUY-1', '/api/reviews/BUY-3']);
  });

  it('selects and deselects every row at once', async () => {
    stub();
    const wrapper = mount(PendingView);
    await flushPromises();

    await wrapper.find('thead input[type="checkbox"]').setValue(true);
    expect(wrapper.text()).toContain('3 işi temizle');

    await wrapper.find('thead input[type="checkbox"]').setValue(false);
    expect(wrapper.text()).not.toContain('işi temizle');
  });

  it('does not open a review when the checkbox is what was clicked', async () => {
    // The whole row opens the review; a destructive control inside it must
    // not ride along on that.
    stub();
    const wrapper = mount(PendingView);
    await flushPromises();

    await wrapper.findAll('tbody input[type="checkbox"]')[0].trigger('click');
    expect(state.issueKey).toBeNull();
  });

  it('asks before wiping anything, and does nothing when refused', async () => {
    vi.stubGlobal('confirm', () => false);
    const calls = stub();
    const wrapper = mount(PendingView);
    await flushPromises();

    await wrapper.findAll('tbody input[type="checkbox"]')[0].setValue(true);
    await wrapper.find('.btn-reject').trigger('click');
    await flushPromises();

    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('names the ones it could not clear rather than reporting success', async () => {
    // A failure halfway through leaves the rest cleared; saying which
    // survived is the difference between a report and a guess.
    stub({ failOn: ['BUY-2'] });
    const wrapper = mount(PendingView);
    await flushPromises();

    await wrapper.find('thead input[type="checkbox"]').setValue(true);
    await wrapper.find('.btn-reject').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Temizlenemedi: BUY-2');
  });
});
