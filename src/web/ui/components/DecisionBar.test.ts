// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import DecisionBar from './DecisionBar.vue';
import { state, type DetailPayload } from '../bridge';
import { outcomeConfig } from '../appConfig';

function setDetail(over: Partial<DetailPayload> = {}): void {
  state.issueKey = 'BUY-1';
  state.detail = { status: 'awaiting_approval', review: { title: 't', markdown: '' }, ...over };
}

function stubServer(response: unknown = { ok: true }) {
  const sent: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, json: async () => response };
  });
  return sent;
}

beforeEach(() => {
  setDetail();
  outcomeConfig.loaded = true;
  outcomeConfig.applyChanges = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.issueKey = null;
  state.detail = null;
});

describe('DecisionBar', () => {
  it('offers the decision as soon as there is a review to decide on', () => {
    expect(mount(DecisionBar).text()).toContain('Onayla');
  });

  it('says nothing to decide before a review exists', async () => {
    setDetail({ review: null });
    await nextTick();
    expect(mount(DecisionBar).text()).toBe('');
  });

  it('asks for a reason before it rejects, rather than sending one blind', async () => {
    /*
     * The rejection reason is the only part of this a developer reads. As a
     * textarea sitting permanently above the buttons it was mostly ignored;
     * as the step between pressing Reddet and it happening, it is the thing
     * in front of you.
     */
    const sent = stubServer();
    const wrapper = mount(DecisionBar);

    expect(wrapper.find('textarea').exists()).toBe(false);
    await wrapper.findAll('.btn').find((b) => b.text() === 'Reddet')!.trigger('click');

    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(sent).toHaveLength(0);

    await wrapper.find('textarea').setValue('İade akışı hâlâ bozuk.');
    await wrapper.findAll('.btn').find((b) => b.text() === 'Reddet')!.trigger('click');
    await flushPromises();

    expect(sent[0].url).toContain('/reject');
    expect(sent[0].body).toMatchObject({ reason: 'İade akışı hâlâ bozuk.' });
  });

  it('lets go of a rejection that was started by mistake', async () => {
    const sent = stubServer();
    const wrapper = mount(DecisionBar);

    await wrapper.findAll('.btn').find((b) => b.text() === 'Reddet')!.trigger('click');
    await wrapper.findAll('.btn').find((b) => b.text() === 'Vazgeç')!.trigger('click');

    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.text()).toContain('Onayla');
    expect(sent).toHaveLength(0);
  });

  it('approves without an extra step, because there is nothing to explain', async () => {
    const sent = stubServer();
    const wrapper = mount(DecisionBar);

    await wrapper.findAll('.btn').find((b) => b.text() === 'Onayla')!.trigger('click');
    await flushPromises();

    expect(sent[0].url).toContain('/approve');
  });

  it('stays on the decision when the server could not carry it out', async () => {
    // Advancing the screen on a failed write would say the ticket moved when
    // it did not.
    stubServer({ error: 'Jira geçişi reddetti' });
    const wrapper = mount(DecisionBar);

    await wrapper.findAll('.btn').find((b) => b.text() === 'Onayla')!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Jira geçişi reddetti');
    expect(wrapper.text()).toContain('Onayla');
  });

  it('gives way to the outcome once it is decided', async () => {
    setDetail({ status: 'posted', rejectionReason: null });
    await nextTick();

    const text = mount(DecisionBar).text();
    // Leaving the buttons up would invite a second, contradictory write.
    expect(text).not.toContain('Onayla');
    expect(text).toContain('DRY RUN');
  });

  it('does not promise a Jira transition on a review with no Jira issue', async () => {
    /*
     * A local review has nowhere to post: no issue to comment on, no status
     * to move, nobody to reassign — see jiraReviewOutcomeAction. Naming a
     * transition here would not be a setting somebody could change; it
     * simply cannot happen.
     */
    outcomeConfig.applyChanges = true;
    outcomeConfig.approveStatus = 'Ready for Test';
    setDetail({ local: true });
    await nextTick();

    const wrapper = mount(DecisionBar);
    expect(wrapper.text()).not.toContain('Ready for Test');
    expect(wrapper.text()).toContain("Jira'ya yazılmaz");

    // And the confirm dialog it would otherwise raise says the same thing —
    // by not being raised at all.
    const confirmed = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmed);
    stubServer();
    await wrapper.findAll('.btn').find((b) => b.text() === 'Onayla')!.trigger('click');
    await flushPromises();
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('says the decision went nowhere but here, once a local one is made', async () => {
    setDetail({ status: 'posted', local: true });
    await nextTick();
    expect(mount(DecisionBar).text()).toContain("Jira'ya bir şey yazılmadı");
  });

  it('says what pressing them will actually do to Jira', async () => {
    outcomeConfig.applyChanges = true;
    outcomeConfig.approveStatus = 'Ready for Test';
    outcomeConfig.rejectStatus = 'In Development';
    await nextTick();

    const text = mount(DecisionBar).text();
    expect(text).toContain('Ready for Test');
    expect(text).toContain('In Development');
  });
});
