import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, configOverrides } from './settingsStore.js';

let dir: string;
let store: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revify-settings-'));
  store = new SettingsStore(join(dir, 'settings.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('configOverrides — run timeouts', () => {
  it('carries what the settings screen saved into the pipeline config', () => {
    // The packaged app has no config.yaml to edit, so anything a person can
    // change has to arrive this way or it is unreachable to them.
    store.update({ idleTimeoutMs: 20 * 60 * 1000, runTimeoutMs: 90 * 60 * 1000 });

    expect(configOverrides(store)).toMatchObject({
      'review.idleTimeoutMs': 1200000,
      'review.runTimeoutMs': 5400000,
    });
  });

  it('says nothing when they were never set, so config.yaml keeps its own', () => {
    const overrides = configOverrides(store);
    expect(overrides).not.toHaveProperty('review.idleTimeoutMs');
    expect(overrides).not.toHaveProperty('review.runTimeoutMs');
  });

  it('survives a restart — a timeout raised today is still raised tomorrow', () => {
    store.update({ runTimeoutMs: 90 * 60 * 1000 });
    expect(configOverrides(new SettingsStore(join(dir, 'settings.json')))).toMatchObject({
      'review.runTimeoutMs': 5400000,
    });
  });

  it('leaves the other per-machine settings alone', () => {
    store.update({ useRepoCheckout: false, repoCacheDir: '/tmp/repos', idleTimeoutMs: 60000 });

    expect(configOverrides(store)).toMatchObject({
      'review.useRepoCheckout': false,
      'review.repoCacheDir': '/tmp/repos',
      'review.idleTimeoutMs': 60000,
    });
  });
});

describe('the fields the settings screen writes', () => {
  it('keeps a raised timeout across a restart, which is the whole point', () => {
    // The packaged app has no config.yaml, so this file is the only place a
    // timeout a person raised can survive.
    store.update({ idleTimeoutMs: 20 * 60 * 1000 });
    expect(new SettingsStore(join(dir, 'settings.json')).get('idleTimeoutMs')).toBe(1200000);
  });

  it('reports them to the UI in the clear, unlike a credential', () => {
    store.update({ runTimeoutMs: 5400000, jiraApiToken: 'gizli' });
    const redacted = store.redacted();

    expect(redacted.runTimeoutMs).toBe(5400000);
    // A number the form has to render vs. a secret a page bug could leak.
    expect(redacted.jiraApiToken).toBe(true);
  });
});
