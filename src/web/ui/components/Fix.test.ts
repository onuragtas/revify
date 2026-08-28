// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import FixButton from './FixButton.vue';
import FixModal from './FixModal.vue';
import FixPanel from './FixPanel.vue';
import { state, type DetailPayload, type FindingView } from '../bridge';
import { fixUi } from '../fixState';

const FINDINGS: FindingView[] = [
  { id: 'f0', severity: 'blocking', location: 'app.ts:1', heading: 'blocking — app.ts:1', body: 'Oran sabit.' },
  { id: 'f1', severity: 'major', location: 'api.ts:7', heading: 'major — api.ts:7', body: 'Null kontrolü yok.' },
  { id: 'f2', severity: 'minor', location: 'log.ts:4', heading: 'minor — log.ts:4', body: 'Mesaj yanıltıcı.' },
];

function setDetail(over: Partial<DetailPayload> = {}): void {
  state.issueKey = 'BUY-1';
  state.detail = {
    review: { title: 't', markdown: '' },
    findings: FINDINGS,
    fixAvailable: true,
    fix: null,
    ...over,
  };
}

beforeEach(() => {
  fixUi.modalOpen = false;
  setDetail();
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
  state.detail = null;
});

/**
 * Records what was sent, so the test can assert on the request rather than
 * on a mock's shape.
 *
 * `/detail` is answered separately. Starting a fix restarts the detail poll,
 * and answering that with the fix response wrote `findings: 1` into
 * `state.detail` — a shape the server cannot produce, which then threw out
 * of a computed. A stub that answers every URL the same way tests a server
 * that does not exist.
 */
function stubServer(response: unknown = { ok: true }) {
  const sent: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = url.endsWith('/detail') ? { ...state.detail } : response;
    return { ok: true, json: async () => body, text: async () => 'diff --git a/x b/x\n' };
  });
  vi.stubGlobal('revifyHost', undefined);
  return sent;
}

describe('FixButton', () => {
  it('offers itself only when there is something it could fix', async () => {
    setDetail({ findings: [FINDINGS[2]] });
    expect(mount(FixButton).find('button').exists()).toBe(false);

    setDetail();
    await nextTick();
    expect(mount(FixButton).find('button').exists()).toBe(true);
  });

  it('is disabled with a reason rather than hidden when it cannot run', () => {
    // A button that vanishes teaches nothing, and the reason is worth reading.
    setDetail({ fixAvailable: false });
    const button = mount(FixButton).find('button');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.attributes('title')).toContain('dosya düzenleyemiyor');
  });

  it('is disabled while a fix is already running', () => {
    setDetail({ fix: { status: 'running', findings: [], patches: [], requestedAt: '' } });
    expect(mount(FixButton).find('button').attributes('disabled')).toBeDefined();
  });
});

describe('FixModal', () => {
  it('checks blocking and major, leaving nits alone', async () => {
    const wrapper = mount(FixModal);
    fixUi.modalOpen = true;
    await nextTick();

    const boxes = wrapper.findAll('input[type="checkbox"]');
    expect(boxes.map((b) => (b.element as HTMLInputElement).checked)).toEqual([true, true, false]);
  });

  it('leaves a disputed finding unchecked, and shows the objection', async () => {
    // An objection only takes effect on the next review; until then the tool
    // offering to satisfy the finding anyway would be arguing with its user.
    setDetail({ challenges: [{ finding: 'blocking — app.ts:1', objection: 'Bence yanlış.', raisedAt: '' }] });
    const wrapper = mount(FixModal);
    fixUi.modalOpen = true;
    await nextTick();

    const boxes = wrapper.findAll('input[type="checkbox"]');
    expect((boxes[0].element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.text()).toContain('Bence yanlış.');
    expect(wrapper.text()).toContain('itiraz ettin');
  });

  it('prefills the instruction from an objection, and sends it', async () => {
    // People write "1. seçenek yapılmalı" in the objection box; losing it is
    // how a human's decision silently fails to reach the code.
    setDetail({ challenges: [{ finding: 'major — api.ts:7', objection: '1. seçenek yapılmalı.', raisedAt: '' }] });
    const sent = stubServer({ position: 0, findings: 1 });
    const wrapper = mount(FixModal);
    fixUi.modalOpen = true;
    await nextTick();

    // Disputed, so unchecked — the human ticks it deliberately.
    await wrapper.findAll('input[type="checkbox"]')[1].setValue(true);
    await wrapper.find('.modal-foot .btn-primary').trigger('click');
    await flushPromises();

    expect(sent[0].body).toMatchObject({ instructions: { f1: '1. seçenek yapılmalı.' } });
  });

  it('does not send an instruction for a finding nobody selected', async () => {
    const sent = stubServer({ position: 0, findings: 1 });
    const wrapper = mount(FixModal);
    fixUi.modalOpen = true;
    await nextTick();

    await wrapper.findAll('textarea')[2].setValue('bunu da şöyle yap');
    await wrapper.find('.modal-foot .btn-primary').trigger('click');
    await flushPromises();

    expect(sent[0].body).toMatchObject({ findings: ['f0', 'f1'] });
    expect((sent[0].body as { instructions: Record<string, string> }).instructions).toEqual({});
  });

  it('keeps the modal open and says why when the server refuses', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({ error: 'zaten çalışıyor' }) }));
    const wrapper = mount(FixModal);
    fixUi.modalOpen = true;
    await nextTick();

    await wrapper.find('.modal-foot .btn-primary').trigger('click');
    await flushPromises();

    expect(fixUi.modalOpen).toBe(true);
    expect(wrapper.text()).toContain('zaten çalışıyor');
  });
});

const READY = {
  status: 'ready' as const,
  requestedAt: '2026-08-27T10:00:00.000Z',
  findings: [{ severity: 'blocking', heading: 'blocking — app.ts:1', instruction: '1. seçenek' }],
  report: [{ outcome: 'fixed' as const, text: 'blocking — app.ts:1 — düzeltildi' }],
  patches: [
    {
      projectPath: 'team/orders',
      branchName: 'feature/rate',
      size: 400,
      stats: { files: 2, insertions: 5, deletions: 1 },
      files: ['app.ts', 'routes.php'],
    },
  ],
};

describe('FixPanel', () => {
  it('says how to get a patch when there is none', () => {
    expect(mount(FixPanel).text()).toContain('Henüz yama yok');
  });

  it('shows the findings asked for, the decision made, and what came back', () => {
    setDetail({ fix: READY });
    const text = mount(FixPanel).text();

    expect(text).toContain('blocking — app.ts:1');
    expect(text).toContain('Talimatın:');
    expect(text).toContain('1. seçenek');
    expect(text).toContain('DÜZELTİLDİ');
    expect(text).toContain('team/orders');
    expect(text).toContain('app.ts');
    expect(text).toContain('+5');
  });

  it('offers Durdur while it runs and Temizle once it is done', async () => {
    setDetail({ fix: { ...READY, status: 'running' } });
    expect(mount(FixPanel).text()).toContain('Durdur');

    setDetail({ fix: READY });
    await nextTick();
    expect(mount(FixPanel).text()).toContain('Temizle');
  });

  it('opens the apply form on the directory this project last landed in', () => {
    setDetail({ fix: READY, fixTargets: { 'team/orders': '/Users/me/projects/orders' } });
    expect(mount(FixPanel).find('input.input').attributes('value')).toBe('/Users/me/projects/orders');
  });

  it('refuses to apply without a directory instead of guessing one', async () => {
    setDetail({ fix: READY });
    const wrapper = mount(FixPanel);
    await wrapper.find('.applyRow .btn-primary').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Önce yamanın uygulanacağı dizini yaz');
  });

  it('reports where the patch landed, and that it is not committed', async () => {
    // The apply is followed by a poll, so the detail endpoint has to keep
    // answering with a patch — otherwise the panel is empty by the time the
    // assertion runs, which is correct behaviour and a useless test.
    vi.stubGlobal('fetch', async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('/fix/apply')
          ? { root: '/Users/me/projects/orders', files: ['app.ts', 'routes.php'], merged: false }
          : { status: 'awaiting_approval', fix: READY, fixTargets: {} },
      text: async () => '',
    }));
    setDetail({ fix: READY, fixTargets: { 'team/orders': '/Users/me/projects/orders' } });
    const wrapper = mount(FixPanel);

    await wrapper.find('.applyRow .btn-primary').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('2 dosya /Users/me/projects/orders içinde değişti');
    expect(wrapper.text()).toContain('commitlenmedi');
  });

  it('fetches a patch body once, and drops it when the issue changes', async () => {
    const sent = stubServer();
    setDetail({ fix: READY });
    const wrapper = mount(FixPanel);

    await wrapper.findAll('.applyRow .btn')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('pre').text()).toContain('diff --git');
    expect(sent).toHaveLength(1);

    // The exact bug the hand-written version shipped: the cache was keyed by
    // project alone, so the previous issue's patch stayed on screen.
    state.issueKey = 'BUY-2';
    await nextTick();
    expect(wrapper.find('pre').exists()).toBe(false);
  });
});
