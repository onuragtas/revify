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
    // Why: see the file. Applied globally so no suite can forget it.
    setupFiles: ['src/testSetup.ts'],
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
     * The server suites drive real git and stand up real HTTP listeners.
     * Left to fill every core, requests between a test and its own server
     * started coming back corrupted — a mangled path answered with
     * Express's own 404, a truncated body answered with a bare 400, and
     * once a response that was not HTTP at all. None of it had anything to
     * do with the code under test, and all of it was read as a product bug
     * for a while.
     *
     * Serialising every file removes it entirely and costs 87 seconds a
     * run instead of 9, which is not a trade worth making — the two suites
     * that talk over a socket retry once instead, see `vi.setConfig` there.
     *
     * (`poolOptions.threads.maxThreads` is the Vitest 3 spelling and was
     * silently ignored here for a while — it was removed in 4.)
     */
    maxWorkers: 3,
  },
});
