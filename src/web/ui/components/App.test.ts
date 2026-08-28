// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { session } from '../session';
import { state } from '../bridge';
import { views } from '../views';
import { modals } from '../uiState';

/**
 * The application, end to end.
 *
 * Every other test here mounts one component with its inputs handed to it.
 * This one starts where a person does — an empty page and a server — and is
 * the only thing that would catch a shell that compiles, type-checks and
 * mounts nothing.
 */

const GATE_READY = { state: 'ready', user: { id: 'u1', name: 'Onur', email: 'o@x.com' }, apiUrl: 'https://api', production: true };

/** Answers every endpoint the shell touches on startup. Anything not listed
 * comes back empty, which is what an unconfigured install looks like. */
function server(overrides: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const routes: Record<string, unknown> = {
    '/api/gate': GATE_READY,
    '/api/backend/me': { configured: true, user: GATE_READY.user },
    '/api/outcome-config': { applyChanges: false, approveStatus: 'Ready', rejectStatus: 'Dev', jiraBaseUrl: 'https://jira' },
    '/api/auto-prepare': { enabled: true, since: '2026-08-01T00:00:00Z' },
    '/api/update': { supported: true, status: 'idle', current: '0.1.28' },
    '/api/reviews': {
      items: [
        {
          issueKey: 'BUY-1',
          summary: 'İade akışı',
          assignee: 'Biri',
          jiraStatus: 'Code Review',
          updated: '2026-08-27T10:00:00Z',
          reviewStatus: 'awaiting_approval',
        },
      ],
    },
    '/api/review-states': { items: [] },
    '/api/pending': { items: [] },
    '/api/decisions': { items: [], jiraBaseUrl: 'https://jira' },
    '/api/backend/assignments': { items: [] },
    ...overrides,
  };

  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(url);
    const key = Object.keys(routes)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return { ok: true, json: async () => routes[key] ?? {}, text: async () => '' };
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  return seen;
}

beforeEach(() => {
  location.hash = '';
  state.issueKey = null;
  state.detail = null;
  views.active = 'reviews';
  session.ready = false;
  session.signedIn = false;
  for (const name of Object.keys(modals)) modals[name as keyof typeof modals] = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('says it is checking rather than showing the app or a blank page', () => {
    server();
    const wrapper = mount(App);

    // Flashing the app and then replacing it with a sign-in form would be
    // worse than waiting — but so is drawing nothing, which is what this
    // used to do, and which reads as a crash. See AppBoot.test.ts.
    expect(wrapper.find('.app').exists()).toBe(false);
    expect(wrapper.text()).toContain('Oturum kontrol ediliyor…');
  });

  it('asks for a sign-in when there is no session', async () => {
    server({ '/api/gate': { state: 'needs-login', apiUrl: 'https://api' } });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('#gate').exists()).toBe(true);
    expect(wrapper.text()).toContain('Giriş yap');
    expect(wrapper.text()).toContain('Kaydol');
  });

  it('lets a stored session in when the backend is unreachable', async () => {
    // Reviews run on this machine against this machine's credentials, so
    // locking someone out because a server is down would trade real
    // availability for no real safety.
    server({ '/api/gate': { state: 'ready', user: null, offline: true, apiUrl: 'http://localhost:4322' } });
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('.app').exists()).toBe(true);
    expect(wrapper.text()).toContain('Sunucuya ulaşılamıyor');
    // Named, and named only here: without it there is no telling a dead team
    // server from a dev build pointing at a backend nobody is running.
    expect(wrapper.text()).toContain('http://localhost:4322');
  });

  it('comes up on the review list, with the queue and the mode chip', async () => {
    server();
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find('.layout').exists()).toBe(true);
    expect(wrapper.text()).toContain('BUY-1');
    expect(wrapper.text()).toContain('İade akışı');
    // The one chip that is not decoration.
    expect(wrapper.text()).toContain('DRY RUN');
    expect(wrapper.text()).toContain('OTO HAZIRLIK');
    expect(wrapper.text()).toContain('Soldan bir issue seç');
  });

  it('switches between the four screens', async () => {
    server();
    const wrapper = mount(App);
    await flushPromises();

    const tab = (label: string) =>
      wrapper.findAll('.viewTab').find((t) => t.text().startsWith(label))!;

    await tab('Kararlar').trigger('click');
    await flushPromises();
    expect(views.active).toBe('decisions');
    expect(wrapper.text()).toContain('Henüz karar verilmiş bir iş yok');

    await tab('Onay bekleyenler').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Onay bekleyen iş yok');

    await tab('İncelemeler').trigger('click');
    await flushPromises();
    expect(wrapper.find('.layout').isVisible()).toBe(true);
  });

  it('opens an issue from the list and shows its detail', async () => {
    server({
      '/api/reviews/BUY-1/detail': {
        status: 'awaiting_approval',
        review: { title: 't', markdown: '' },
        reviewPreamble: 'Kısa giriş.',
        reviewTail: '',
        findings: [
          { id: 'f0', severity: 'blocking', location: 'app.ts:1', heading: 'blocking — app.ts:1', body: 'Yanlış.' },
        ],
        steps: [],
        prompts: [],
        notes: [],
        history: [],
        fixTargets: {},
      },
      '/api/reviews/BUY-1/prepare': { summary: 'İade akışı', description: 'Açıklama', changedRepos: [] },
    });
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.find('.issue-card').trigger('click');
    await flushPromises();

    expect(state.issueKey).toBe('BUY-1');
    expect(wrapper.text()).toContain('Kısa giriş.');
    expect(wrapper.find('.findingCard').text()).toContain('blocking');
    // A settled review is a decision waiting to be made.
    expect(wrapper.text()).toContain('Onayla');
    expect(wrapper.text()).toContain('DRY RUN');
  });

  it('opens the modals from the top bar', async () => {
    server();
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.findAll('.topbar-right .btn').find((b) => b.text() === '⚙')!.trigger('click');
    await flushPromises();
    expect(modals.settings).toBe(true);
    expect(wrapper.text()).toContain('Ayarlar');
  });

  it('signs out back to the gate', async () => {
    server();
    const wrapper = mount(App);
    await flushPromises();

    // The team chip carries the signed-in name.
    const chip = wrapper.findAll('.topbar-right .btn').find((b) => b.text() === 'Onur')!;
    await chip.trigger('click');
    await flushPromises();

    await wrapper.findAll('.btn').find((b) => b.text() === 'Çıkış yap')!.trigger('click');
    await flushPromises();
    expect(session.signedIn).toBe(false);
    expect(wrapper.find('#gate').exists()).toBe(true);
  });
});
