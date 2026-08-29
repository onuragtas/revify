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

describe('the step log', () => {
  it('says how long the run had been going at each line, not just the clock', async () => {
    // The wall clock says when; this says how long it has been going, which
    // is the question someone asks when a run looks stuck.
    const wrapper = mount(DetailPane);
    state.detail = {
      ...DETAIL,
      steps: [
        { ts: '2026-08-28T10:00:00Z', message: 'started', startsRun: true },
        { ts: '2026-08-28T10:00:07Z', message: 'klonlanıyor' },
        { ts: '2026-08-28T10:02:13Z', message: 'model çağrıldı' },
      ],
    };
    await flushPromises();

    const log = wrapper.find('#steps').text();
    expect(log).toContain('[10:00:00 +00:00] started');
    expect(log).toContain('[10:00:07 +00:07] klonlanıyor');
    expect(log).toContain('[10:02:13 +02:13] model çağrıldı');
  });

  it('restarts the clock for a fix, which is its own run in the same log', async () => {
    /*
     * An issue accumulates a review's steps and then a fix's. Measured from
     * the top of the log, a fix started an hour after the review would claim
     * to have been running for an hour.
     */
    const wrapper = mount(DetailPane);
    state.detail = {
      ...DETAIL,
      steps: [
        { ts: '2026-08-28T10:00:00Z', message: 'started', startsRun: true },
        { ts: '2026-08-28T10:04:00Z', message: 'review hazır' },
        { ts: '2026-08-28T11:00:00Z', message: 'fix: başladı', startsRun: true },
        { ts: '2026-08-28T11:00:31Z', message: 'fix: Read Payment.java' },
      ],
    };
    await flushPromises();

    const log = wrapper.find('#steps').text();
    expect(log).toContain('[11:00:31 +00:31] fix: Read Payment.java');
    expect(log).not.toContain('+60:31');
  });
});

describe('how deeply to scan', () => {
  it('offers the choice before the run, with the size that makes it a choice', async () => {
    /*
     * Per run rather than a stored setting: the person pressing the button
     * knows whether this is a fifty-file change they want gone over
     * properly or a two-line one they want an answer to now. The size
     * beside it is what makes the decision possible — "bölerek" means
     * nothing on three files and everything on fifty.
     */
    const wrapper = mount(DetailPane);
    state.detail = {
      ...DETAIL,
      repoChanges: [
        {
          projectPath: 'team/api',
          baseBranch: 'master',
          branchName: 'feature/BUY-1',
          files: [{ path: 'a.ts', diff: 'x'.repeat(40_000) }],
        },
      ],
    } as never;
    await flushPromises();

    expect(wrapper.find('.scanPick').text()).toContain('tek geçiş');
    expect(wrapper.text()).toContain('1 dosya · 40k');
    expect(wrapper.text()).toContain('tek geçiş bu boyutta eksik tarar');
  });

  it('sends the chosen depth with the run', async () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const wrapper = mount(DetailPane);
    state.detail = DETAIL;
    await flushPromises();

    await wrapper.find('.scanPick').trigger('click');
    expect(wrapper.find('.scanPick').text()).toContain('bölerek');

    await wrapper.find('.detail-head-actions .btn-primary').trigger('click');
    await flushPromises();

    expect(sent.find((s) => s.url.endsWith('/start'))!.body).toMatchObject({ scanMode: 'deep' });
  });

  it('is out of the way while a run is going', async () => {
    // Nothing to configure about a run that has already started.
    const wrapper = mount(DetailPane);
    state.detail = { ...DETAIL, status: 'running' } as never;
    await flushPromises();

    expect(wrapper.find('.scanPick').exists()).toBe(false);
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
