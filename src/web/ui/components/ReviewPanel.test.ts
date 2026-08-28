// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ReviewPanel from './ReviewPanel.vue';
import { state, type DetailPayload, type FindingView } from '../bridge';

const finding = (over: Partial<FindingView>): FindingView => ({
  id: 'f0',
  severity: 'blocking',
  location: 'src/a.ts:42',
  heading: 'blocking — src/a.ts:42',
  body: 'Bir şey yanlış.',
  ...over,
});

function setDetail(over: Partial<DetailPayload> = {}): void {
  state.issueKey = 'BUY-1';
  state.detail = {
    review: { title: 't', markdown: 'tam metin' },
    reviewPreamble: '',
    reviewTail: '',
    findings: [],
    ...over,
  };
}

beforeEach(() => setDetail());
afterEach(() => {
  state.issueKey = null;
  state.detail = null;
});

describe('ReviewPanel', () => {
  it('says how to get one when there is no review', () => {
    state.detail = null;
    expect(mount(ReviewPanel).text()).toContain('henüz review yok');
  });

  it('gives each finding its own card, worst first', async () => {
    // A blocking finding decides the outcome and three minors under it do
    // not, so triage order is severity order — not the order they were
    // written in.
    setDetail({
      findings: [
        finding({ id: 'f0', severity: 'minor', location: 'log.ts:4', heading: 'minor — log.ts:4' }),
        finding({ id: 'f1', severity: 'blocking', location: 'a.ts:1', heading: 'blocking — a.ts:1' }),
        finding({ id: 'f2', severity: 'major', location: 'b.ts:2', heading: 'major — b.ts:2' }),
      ],
    });
    await nextTick();

    const cards = mount(ReviewPanel).findAll('.findingCard');
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.find('.sev').text())).toEqual(['blocking', 'major', 'minor']);
  });

  it('counts the findings by severity, so the shape is visible before reading', async () => {
    setDetail({
      findings: [
        finding({ id: 'f0', severity: 'blocking' }),
        finding({ id: 'f1', severity: 'minor' }),
        finding({ id: 'f2', severity: 'minor' }),
      ],
    });
    await nextTick();

    const head = mount(ReviewPanel).find('.reviewHead').text();
    expect(head).toContain('1 blocking');
    expect(head).toContain('2 minor');
  });

  it('says so plainly when a review reported nothing', () => {
    expect(mount(ReviewPanel).find('.reviewHead').text()).toContain('bulgu yok');
  });

  it('keeps the prose around the findings, above and below', async () => {
    setDetail({
      reviewPreamble: 'Giriş cümlesi.',
      reviewTail: 'Verdict: Request changes',
      findings: [finding({})],
    });
    await nextTick();

    const wrapper = mount(ReviewPanel);
    expect(wrapper.text()).toContain('Giriş cümlesi.');
    // The verdict is about the change as a whole, so it sits after the cards
    // rather than inside the last one.
    expect(wrapper.text()).toContain('Verdict: Request changes');
    expect(wrapper.find('.findingCard').text()).not.toContain('Verdict');
  });

  it('renders a finding body as markdown, escaped', async () => {
    setDetail({ findings: [finding({ body: '`kod` ve <img src=x onerror=1>' })] });
    await nextTick();

    const html = mount(ReviewPanel).find('.findingCard .mdBody').html();
    expect(html).toContain('<code class="mdInline">kod</code>');
    expect(html).not.toContain('<img');
  });

  it('opens every card while a review is short', async () => {
    setDetail({ findings: [finding({ id: 'f0' }), finding({ id: 'f1' })] });
    await nextTick();

    const wrapper = mount(ReviewPanel);
    expect(wrapper.findAll('.findingCard.collapsed')).toHaveLength(0);
  });

  it('collapses them once there are enough to scan', async () => {
    // Six findings open at once is six screens of quoted diff; the headings
    // are what a reader wants first.
    setDetail({ findings: Array.from({ length: 6 }, (_, i) => finding({ id: `f${i}` })) });
    await nextTick();

    const wrapper = mount(ReviewPanel);
    expect(wrapper.findAll('.findingCard.collapsed')).toHaveLength(6);

    await wrapper.find('.findingHead').trigger('click');
    expect(wrapper.findAll('.findingCard.collapsed')).toHaveLength(5);
  });
});
