// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import HistoryPanel from './HistoryPanel.vue';
import NotesPanel from './NotesPanel.vue';
import VerifyPanel from './VerifyPanel.vue';
import { host, state, type DetailPayload } from '../bridge';
import { tabs } from '../detail';

function setDetail(over: Partial<DetailPayload> = {}): void {
  state.issueKey = 'BUY-1';
  state.detail = {
    review: { title: 't', markdown: '' },
    findings: [],
    openQuestions: [],
    clarifications: [],
    challenges: [],
    withdrawn: [],
    revisionRequest: '',
    notes: [],
    appliedNotes: [],
    history: [],
    projectPaths: [],
    ...over,
  };
}

/** Records every request. Tab badges are read from the real state rather
 * than from a spy — that is the thing the component actually changes. */
function stubServer() {
  const sent: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  return { sent };
}

beforeEach(() => setDetail());
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
  state.detail = null;
});

describe('VerifyPanel', () => {
  it('keeps showing an answer the review has stopped asking about', async () => {
    // Otherwise the answer silently disappears and nobody can tell whether
    // it was ever given.
    setDetail({
      openQuestions: ['Yeni soru?'],
      clarifications: [{ question: 'Eski soru?', answer: 'Hayır.', answeredAt: '' }],
    });
    await nextTick();

    const text = mount(VerifyPanel).text();
    expect(text).toContain('Yeni soru?');
    expect(text).toContain('Eski soru?');
  });

  it('does not overwrite what is being typed when a poll arrives', async () => {
    // The detail panel re-polls every second; a mid-sentence reset would
    // make the box unusable.
    stubServer();
    setDetail({ revisionRequest: 'sunucudaki hâli' });
    const wrapper = mount(VerifyPanel);
    await nextTick();

    const box = wrapper.find('textarea');
    await box.trigger('focus');
    await box.setValue('yazmakta olduğum şey');

    setDetail({ revisionRequest: 'sunucudaki hâli' });
    await nextTick();
    expect((box.element as HTMLTextAreaElement).value).toBe('yazmakta olduğum şey');
  });

  it('saves all three channels together, whichever button was pressed', async () => {
    // The reviewer sees one screen, so saving only the section whose button
    // they pressed would silently drop whatever else they had typed.
    const { sent } = stubServer();
    setDetail({
      openQuestions: ['Soru?'],
      findings: [
        { id: 'f0', severity: 'blocking', location: 'a.ts:1', heading: 'blocking — a.ts:1', body: '' },
      ],
    });
    const wrapper = mount(VerifyPanel);
    await nextTick();

    await wrapper.find('textarea').setValue('talimat');
    await wrapper.find('.card-actions .btn').trigger('click');
    await flushPromises();

    // All three, in order — then the poll that picks up what was saved.
    expect(sent.map((s) => s.url.split('/').pop()).slice(0, 3)).toEqual([
      'revision',
      'clarifications',
      'challenges',
    ]);
    expect(sent[0].body).toMatchObject({ text: 'talimat' });
  });

  it('counts what is open, and calls unanswered questions urgent', async () => {
    stubServer();
    setDetail({
      openQuestions: ['Soru?'],
      revisionRequest: 'talimat',
      challenges: [{ finding: 'blocking — a.ts:1', objection: 'yanlış', raisedAt: '' }],
    });
    mount(VerifyPanel);
    await nextTick();

    // One question + one dispute + one instruction, and an unanswered
    // question is what makes the tab urgent rather than merely counted.
    expect(tabs.counts.verify).toEqual({ count: 3, alert: true });
  });

  it('says the save failed instead of looking exactly like success', async () => {
    /*
     * There was a `try/finally` with no `catch` and nowhere to put an error:
     * a refused save rejected out of the click handler, the editing flags
     * reset, and the panel looked the same as it does when it works. What
     * the person had just written was still on screen and not on disk.
     */
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({ error: 'disk dolu' }) }));
    setDetail({ revisionRequest: '' });
    const wrapper = mount(VerifyPanel);
    await nextTick();

    await wrapper.find('textarea').setValue('talimat');
    await wrapper.find('.card-actions .btn').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('disk dolu');
  });

  it('does not re-review against instructions that failed to save', async () => {
    // The review would silently ignore them, and nothing would say why.
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/revision')) return { ok: false, json: async () => ({ error: 'olmadı' }) };
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const started = vi.spyOn(host, 'startReview');
    setDetail();
    const wrapper = mount(VerifyPanel);
    await nextTick();

    await wrapper.find('textarea').setValue('talimat');
    await wrapper.findAll('.card-actions .btn')[1].trigger('click');
    await flushPromises();

    expect(started).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('olmadı');
    started.mockRestore();
  });

  it('says why the re-review was refused, rather than nothing at all', async () => {
    /*
     * Starting a review was written twice — here and in the detail header —
     * and only the header's copy learned to read the server's answer. This
     * one swallowed every refusal, so the button did nothing and said
     * nothing. There is one implementation now.
     */
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/start')) {
        return { ok: false, status: 400, json: async () => ({ error: 'bir issue anahtarına benzemiyor' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    setDetail();
    const wrapper = mount(VerifyPanel);
    await nextTick();

    await wrapper.find('textarea').setValue('talimat');
    await wrapper.findAll('.card-actions .btn')[1].trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('bir issue anahtarına benzemiyor');
  });

  it('shows the finding in full, not just its heading', async () => {
    // Judging an objection from a `file:line` heading alone would mean going
    // back to the review for every one of them.
    setDetail({
      findings: [
        {
          id: 'f0',
          severity: 'blocking',
          location: 'a.ts:1',
          heading: 'blocking — a.ts:1',
          body: '`refund()` transaction dışında çağrılıyor.',
        },
      ],
    });
    await nextTick();

    const wrapper = mount(VerifyPanel);
    expect(wrapper.find('.findingBody').exists()).toBe(true);
    expect(wrapper.find('.findingBody').text()).toContain('transaction dışında');
  });

  it("shows the reviewer's reply beside the objection that asked for it", async () => {
    /*
     * Beside the objection rather than in the review body, because that is
     * where the person who asked will look — and because a question is most
     * worth answering exactly when the finding was withdrawn, which is the
     * case where an answer buried in the review would have disappeared with
     * it.
     */
    setDetail({
      challenges: [
        {
          finding: 'blocking — a.ts:1',
          objection: 'Bu alan controller\'da zaten valide ediliyor değil mi?',
          raisedAt: '',
          answer: 'Ediliyor ama yalnızca POST yolunda; bu akış PaymentJob üzerinden geliyor.',
        },
      ],
    });
    await nextTick();

    const wrapper = mount(VerifyPanel);
    expect(wrapper.find('.answerNote').exists()).toBe(true);
    expect(wrapper.find('.answerNote').text()).toContain('yalnızca POST yolunda');
  });

  it('shows no reply box for an objection that drew none', async () => {
    setDetail({
      challenges: [{ finding: 'blocking — a.ts:1', objection: 'yanlış', raisedAt: '' }],
    });
    await nextTick();
    expect(mount(VerifyPanel).find('.answerNote').exists()).toBe(false);
  });

  it('offers a dispute box for a finding the review has since dropped', async () => {
    setDetail({ challenges: [{ finding: 'blocking — gitti.ts:1', objection: 'yanlıştı', raisedAt: '' }] });
    await nextTick();
    expect(mount(VerifyPanel).text()).toContain('blocking — gitti.ts:1');
  });
});

describe('NotesPanel', () => {
  it('offers a repo scope only once the issue has a repo', async () => {
    setDetail();
    await nextTick();
    expect(mount(NotesPanel).findAll('option')).toHaveLength(1);

    setDetail({ projectPaths: ['team/orders'] });
    await nextTick();
    const options = mount(NotesPanel).findAll('option');
    expect(options).toHaveLength(2);
    expect(options[0].text()).toContain('team/orders');
  });

  it('scopes a note to the repo by default, rather than to every project', async () => {
    // The screen this replaces built its options as [this repo, all
    // projects] and a select takes its first one, so a note typed without
    // touching the dropdown applied to one project. Defaulting the other way
    // would quietly widen every note somebody wrote in a hurry.
    const { sent } = stubServer();
    setDetail({ projectPaths: ['team/orders'] });
    const wrapper = mount(NotesPanel);
    await nextTick();

    await wrapper.find('input.input').setValue('Test eksikliğini yazma');
    await wrapper.find('.note-add .btn').trigger('click');
    await flushPromises();

    expect(sent[0].body).toMatchObject({
      scope: 'repo',
      projectPath: 'team/orders',
      text: 'Test eksikliğini yazma',
    });
  });

  it('says what a note suppressed, since a silent one looks like a miss', async () => {
    setDetail({ appliedNotes: ['test eksikliği notu — 2 bulgu yazılmadı'] });
    await nextTick();
    expect(mount(NotesPanel).text()).toContain('2 bulgu yazılmadı');
  });

  it('counts the notes on the tab', async () => {
    stubServer();
    setDetail({
      notes: [
        { id: 'n1', scope: 'global', projectPath: null, text: 'a', createdAt: '' },
        { id: 'n2', scope: 'repo', projectPath: 'team/orders', text: 'b', createdAt: '' },
      ],
    });
    mount(NotesPanel);
    await nextTick();
    expect(tabs.counts.notes).toEqual({ count: 2, alert: false });
  });
});

describe('HistoryPanel', () => {
  it('says so when there is nothing to compare against', () => {
    expect(mount(HistoryPanel).text()).toContain('önceki inceleme yok');
  });

  it('opens the most recent one, which is the one being compared against', async () => {
    stubServer();
    setDetail({
      history: [
        { title: 'a', markdown: '# yeni', outcome: 'rejected', archivedAt: '2026-08-27T10:00:00Z' },
        { title: 'b', markdown: '# eski', outcome: 'posted', archivedAt: '2026-08-20T10:00:00Z' },
      ],
    });
    const wrapper = mount(HistoryPanel);
    await nextTick();

    const cards = wrapper.findAll('details');
    expect((cards[0].element as HTMLDetailsElement).open).toBe(true);
    expect((cards[1].element as HTMLDetailsElement).open).toBe(false);
    expect(cards[0].text()).toContain('reddedildi');
    expect(tabs.counts.history).toEqual({ count: 2, alert: false });
  });
});
