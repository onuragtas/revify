// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The built bundle, loaded the way a browser loads it.
 *
 * This is the only check that covers what vite actually emitted rather than
 * what the sources mean — and it has to be honest about *where* that runs.
 *
 * It was not, once. The bundle referenced `process.env.NODE_ENV` 221 times
 * (Vue's dev-warning branches, left alone by vite's library mode), and this
 * test passed anyway because vitest runs under node, where `process` exists.
 * In Chromium it does not: the first line that touched it threw, the module
 * died before mounting, and the window was black. So `process` is removed
 * here before the import — the environment the file actually ships into.
 */
/** `process` is a Node global the browser tsconfig knows nothing about,
 * which is the whole point of removing it below. */
const globals = globalThis as unknown as Record<string, unknown>;
const realProcess = globals.process;

afterEach(() => {
  Object.defineProperty(globals, 'process', { value: realProcess, configurable: true, writable: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the built bundle', () => {
  it('mounts into #app in a browser, where there is no `process`', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ state: 'needs-login' }),
      text: async () => '',
    }));
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    // A browser has no `process`, and neither may this.
    Object.defineProperty(globals, 'process', { value: undefined, configurable: true, writable: true });

    await import(/* @vite-ignore */ '../public/assets/ui.js' as string);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.querySelector('#app')!.innerHTML.length).toBeGreaterThan(0);
  });
});
