import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // Component tests import `.vue` files; the server tests do not care.
  plugins: [vue()],
  test: {
    // Only this project's own tests. `data/repos` holds shallow clones of
    // other teams' repositories, which bring their own test suites — without
    // this, vitest collects hundreds of foreign test files that were never
    // meant to run here.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'data/**'],
    /*
     * Long enough for the tests that shell out to git.
     *
     * The fix and local-review suites init real repositories, clone them,
     * and apply real patches — deliberately, because every question they
     * ask is a git question and a mock would only ever agree with the code.
     * That work is a few seconds per file on its own and more under
     * parallel load, so the 5s default turned two of them into coin flips
     * that failed on a busy machine and passed on a quiet one. A flaky test
     * teaches people to re-run rather than to read.
     *
     * Higher than the waits inside those suites, so a test that runs out of
     * patience reports what it was waiting for instead of being killed
     * mid-sentence with no diagnosis.
     *
     * The cost is that a genuinely hung test takes this long to say so.
     */
    testTimeout: 40_000,
    /*
     * A ceiling on workers, because these suites are not CPU-bound.
     *
     * The server tests drive real git and stand up an ephemeral HTTP server
     * per request. Left to fill every core, the machine ends up with dozens
     * of git processes and sockets in flight, and requests started failing
     * in a way that has nothing to do with the code under test: an
     * occasional 404 for a route that is unconditionally registered — the
     * request never reached the app it was addressed to. Roughly one full
     * run in nine.
     *
     * Four workers keeps the suite parallel where it pays (the component
     * tests) without the contention. The wall-clock cost is small; a suite
     * that fails one run in nine costs far more, because the failure is
     * never where the bug is.
     */
    poolOptions: { threads: { maxThreads: 4 } },
  },
});
