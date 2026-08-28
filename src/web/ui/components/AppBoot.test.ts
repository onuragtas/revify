// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import { session } from '../session';

/**
 * The black screen, reproduced.
 *
 * `/api/gate` waits on a call to the team backend, and that call had no
 * timeout. On a build pointing at a backend nobody is running — which is
 * every run from source — the request could sit there, and the app rendered
 * *nothing at all* while it did. On a dark theme that is a black window with
 * no way to tell it from a crash.
 */
beforeEach(() => {
  session.ready = false;
  session.signedIn = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => vi.unstubAllGlobals());

describe('startup', () => {
  it('says what it is doing while the gate is still answering', async () => {
    // A request that never settles: exactly the case that produced the black
    // screen.
    vi.stubGlobal('fetch', () => new Promise(() => {}));

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('Oturum kontrol ediliyor…');
    expect(wrapper.find('.stateNote-spinner').exists()).toBe(true);
    // And the brand, so the window is recognisably the app rather than a
    // blank rectangle.
    expect(wrapper.text()).toContain('Revify');
  });

  it('falls through to the sign-in screen when the gate cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('bağlantı yok');
    });

    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('Uygulama sunucusuna ulaşılamadı');
    expect(wrapper.text()).toContain('Giriş yap');
  });

  it('never renders an empty document, whatever the server does', async () => {
    for (const fetchImpl of [
      () => new Promise(() => {}),
      async () => {
        throw new Error('yok');
      },
      async () => ({ ok: true, json: async () => ({}) }),
    ]) {
      session.ready = false;
      session.signedIn = false;
      vi.stubGlobal('fetch', fetchImpl);

      const wrapper = mount(App);
      await flushPromises();
      expect(wrapper.text().trim().length).toBeGreaterThan(0);
    }
  });
});
