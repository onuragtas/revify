import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What vite emitted, checked as bytes.
 *
 * The bundle is loaded straight by a `<script type="module">` — there is no
 * downstream bundler to substitute anything. Vue's ESM build branches on
 * `process.env.NODE_ENV`, and vite's *library* mode leaves that expression
 * alone; a browser has no `process`, so the first line that touches it
 * throws and the window stays empty.
 *
 * That shipped once. It passed every test at the time, because vitest runs
 * under node — where `process` exists. This one reads the file instead.
 */
describe('the browser bundle', () => {
  const path = 'src/web/public/assets/ui.js';

  it('exists — the build must actually produce it', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('mentions no Node global a browser does not have', () => {
    const bundle = readFileSync(path, 'utf8');
    expect(bundle).not.toContain('process.env');
  });
});
