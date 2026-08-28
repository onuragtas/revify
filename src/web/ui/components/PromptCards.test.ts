// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PromptCards from './PromptCards.vue';
import { state } from '../bridge';

/**
 * The first UI test this project has ever had.
 *
 * Worth saying why that matters: every bug found in this panel by hand —
 * a cache leaking between issues, an open card closing on the next poll —
 * was invisible to 275 passing tests, because the UI was one HTML file with
 * no seam to test through. This is the seam.
 */

const prompt = (over: Partial<{ kind: string; savedAt: string; size: number }> = {}) => ({
  kind: 'review',
  savedAt: '2026-08-27T10:11:12.000Z',
  size: 42_000,
  ...over,
});

/** `<details>` fires `toggle` itself when `open` changes — dispatching one
 * as well would run the handler twice and test the test. */
async function open(wrapper: ReturnType<typeof mount>, index: number): Promise<void> {
  (wrapper.findAll('details')[index].element as HTMLDetailsElement).open = true;
  await flushPromises();
}

async function close(wrapper: ReturnType<typeof mount>, index: number): Promise<void> {
  (wrapper.findAll('details')[index].element as HTMLDetailsElement).open = false;
  await flushPromises();
}

function setDetail(issueKey: string | null, prompts: ReturnType<typeof prompt>[]): void {
  state.issueKey = issueKey;
  state.detail = { prompts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setDetail(null, []);
});

/** Answers /prompt with a body per kind, and counts the calls. */
function stubServer(bodies: Record<string, string>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const kind = decodeURIComponent(new URL(url, 'http://x').searchParams.get('kind') ?? '');
    const body = bodies[kind];
    return {
      json: async () =>
        body === undefined ? { error: 'Bu çalışmanın prompt kaydı yok.' } : { kind, system: 'S', prompt: body, savedAt: '' },
    };
  });
  return calls;
}

describe('PromptCards', () => {
  it('lists one closed card per prompt, with its size and time', async () => {
    setDetail('BUY-1', [prompt(), prompt({ kind: 'fix:team/orders', size: 8000 })]);
    const wrapper = mount(PromptCards);
    await nextTick();

    const cards = wrapper.findAll('details');
    expect(cards).toHaveLength(2);
    // Closed by default: a prompt is tens of kilobytes and nobody needs it
    // most of the time.
    expect(cards.every((c) => !(c.element as HTMLDetailsElement).open)).toBe(true);
    expect(wrapper.text()).toContain('Review prompt');
    expect(wrapper.text()).toContain('Yama prompt — team/orders');
    expect(wrapper.text()).toContain('42 KB');
    expect(wrapper.text()).toContain('2026-08-27 10:11');
  });

  it('fetches the body on first open, and not again on the second', async () => {
    const calls = stubServer({ review: 'diffe bak' });
    setDetail('BUY-1', [prompt()]);
    const wrapper = mount(PromptCards);
    await nextTick();

    await open(wrapper, 0);
    expect(wrapper.find('pre').text()).toContain('diffe bak');
    expect(wrapper.find('pre').text()).toContain('SYSTEM');
    expect(calls).toHaveLength(1);

    await close(wrapper, 0);
    await open(wrapper, 0);
    expect(calls).toHaveLength(1);
    expect(wrapper.find('pre').text()).toContain('diffe bak');
  });

  it('keeps an opened card open when the poll delivers a new payload', async () => {
    // The old implementation rebuilt this list from a string on every change
    // and had to track open state by hand to survive it.
    stubServer({ review: 'gövde' });
    setDetail('BUY-1', [prompt()]);
    const wrapper = mount(PromptCards);
    await nextTick();

    await open(wrapper, 0);

    // A fix finishes and the poll now reports two prompts.
    setDetail('BUY-1', [prompt(), prompt({ kind: 'fix:team/orders' })]);
    await nextTick();

    expect((wrapper.findAll('details')[0].element as HTMLDetailsElement).open).toBe(true);
    expect(wrapper.findAll('details')[0].find('pre').text()).toContain('gövde');
  });

  it('does not show one issue\'s prompt under another issue\'s card', async () => {
    // The exact bug the hand-written version shipped with: the body cache was
    // keyed by kind alone, so switching issues kept the previous text.
    stubServer({ review: 'BUY-1 metni' });
    setDetail('BUY-1', [prompt()]);
    const wrapper = mount(PromptCards);
    await nextTick();

    await open(wrapper, 0);
    expect(wrapper.find('pre').text()).toContain('BUY-1 metni');

    stubServer({ review: 'BUY-2 metni' });
    setDetail('BUY-2', [prompt()]);
    await flushPromises();

    // Switching issues closes the cards, exactly as the old screen did.
    expect((wrapper.findAll('details')[0].element as HTMLDetailsElement).open).toBe(false);
    await open(wrapper, 0);
    expect(wrapper.find('pre').text()).toContain('BUY-2 metni');
    expect(wrapper.find('pre').text()).not.toContain('BUY-1 metni');
  });

  it('says why rather than staying blank when the prompt is gone', async () => {
    stubServer({});
    setDetail('BUY-1', [prompt()]);
    const wrapper = mount(PromptCards);
    await nextTick();

    await open(wrapper, 0);
    expect(wrapper.find('pre').text()).toContain('Okunamadı');
  });

  it('renders nothing at all before the first poll answers', () => {
    state.issueKey = null;
    state.detail = null;
    expect(mount(PromptCards).findAll('details')).toHaveLength(0);
  });
});
