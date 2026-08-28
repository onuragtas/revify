// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LocalReviewModal from './LocalReviewModal.vue';
import { state } from '../bridge';
import { localReviewTarget, modals } from '../uiState';

const INSPECTION = {
  path: '/home/me/projects/hgs-api',
  projectPath: 'buy-journey-team/hgs-api',
  branch: 'feature/BUY-2397-km-muayene',
  baseBranch: 'origin/master',
  files: 12,
  suggestedIssueKey: 'BUY-2397',
};

const BUY_2397 = { key: 'BUY-2397', summary: 'KM muayene bedeli', status: 'Code Review' };

/** Records every request and answers by URL, longest prefix first. */
function stub(byUrl: Record<string, unknown>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(byUrl)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return { ok: true, json: async () => (key ? byUrl[key] : {}) };
  });
  return calls;
}

beforeEach(() => {
  localReviewTarget.path = '/home/me/projects/hgs-api';
  modals.localReview = true;
  state.issueKey = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
});

describe('LocalReviewModal', () => {
  it('shows what is in the directory before anything runs', async () => {
    const calls = stub({
      '/api/reviews/local/inspect': INSPECTION,
      '/api/issues/BUY-2397/summary': BUY_2397,
    });
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    expect(wrapper.text()).toContain('buy-journey-team/hgs-api');
    expect(wrapper.text()).toContain('feature/BUY-2397-km-muayene');
    expect(wrapper.text()).toContain('12');
    // Inspecting and asking about the ticket are both read-only; nothing
    // has been queued.
    expect(calls.some((c) => c.url === '/api/reviews/local')).toBe(false);
  });

  it("offers the branch's ticket with its summary, since nobody can confirm a bare key", async () => {
    stub({ '/api/reviews/local/inspect': INSPECTION, '/api/issues/BUY-2397/summary': BUY_2397 });
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    expect(wrapper.text()).toContain('BUY-2397');
    expect(wrapper.text()).toContain('KM muayene bedeli');
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).toContain('geliştiriciye atar');
  });

  it('attaches the review when the guess is confirmed', async () => {
    const calls = stub({
      '/api/reviews/local/inspect': INSPECTION,
      '/api/issues/BUY-2397/summary': BUY_2397,
      '/api/reviews/local': { issueKey: 'BUY-2397' },
    });
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    await wrapper.find('.modal-foot .btn-primary').trigger('click');
    await flushPromises();

    const start = calls.find((c) => c.url === '/api/reviews/local')!;
    expect(start.body).toMatchObject({ path: INSPECTION.path, issueKey: 'BUY-2397' });
    expect(state.issueKey).toBe('BUY-2397');
    expect(modals.localReview).toBe(false);
  });

  it('stays local when the guess is declined', async () => {
    /*
     * Declining is not a lesser version of confirming: it means no comment,
     * no transition, no reassignment. The request has to carry no key at
     * all, and the dialog has to have said so before it was pressed.
     */
    const calls = stub({
      '/api/reviews/local/inspect': INSPECTION,
      '/api/issues/BUY-2397/summary': BUY_2397,
      '/api/reviews/local': { issueKey: 'local:buy-journey-team/hgs-api@feature/BUY-2397-km-muayene' },
    });
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    await wrapper.find('input[type="checkbox"]').setValue(false);
    expect(wrapper.text()).toContain("Jira'ya bir şey yazılmaz");

    await wrapper.find('.modal-foot .btn-primary').trigger('click');
    await flushPromises();

    expect(calls.find((c) => c.url === '/api/reviews/local')!.body).toMatchObject({ issueKey: '' });
  });

  it('checks a key somebody typed, and will not attach to one Jira denies', async () => {
    // A typo caught here costs a dialog; caught after the run it costs a
    // review written against the wrong ticket.
    stub({
      '/api/reviews/local/inspect': INSPECTION,
      '/api/issues/BUY-2397/summary': BUY_2397,
      '/api/issues/BUY-9999/summary': { error: 'BUY-9999 Jira\'da bulunamadı (ya da erişimin yok).' },
      '/api/issues/EPA-12/summary': { key: 'EPA-12', summary: 'Banka önbelleği' },
    });
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    await wrapper.find('.localAttach .input').setValue('BUY-9999');
    await flushPromises();
    expect(wrapper.text()).toContain('bulunamadı');
    expect((wrapper.find('.modal-foot .btn-primary').element as HTMLButtonElement).disabled).toBe(true);

    await wrapper.find('.localAttach .input').setValue('EPA-12');
    await flushPromises();
    expect(wrapper.text()).toContain('Banka önbelleği');
    expect((wrapper.find('.modal-foot .btn-primary').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not tick the box for a guess Jira could not confirm', async () => {
    // Offline is not the same as "no such issue", and neither is a licence
    // to attach — so the guess is offered unticked rather than assumed.
    stub({
      '/api/reviews/local/inspect': INSPECTION,
      '/api/issues/BUY-2397/summary': { key: 'BUY-2397', error: "Jira'ya sorulamadı: fetch failed" },
    });
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain("Jira'ya bir şey yazılmaz");
  });

  it('says why it cannot go on when the directory is not reviewable', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      json: async () => ({ error: 'taban dalıyla aynı ve çalışma alanı temiz — incelenecek değişiklik yok' }),
    }));
    const wrapper = mount(LocalReviewModal);
    await flushPromises();

    expect(wrapper.text()).toContain('incelenecek değişiklik yok');
    expect(wrapper.find('.meta-chips').exists()).toBe(false);
  });
});
