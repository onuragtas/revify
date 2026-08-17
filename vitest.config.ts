import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this project's own tests. `data/repos` holds shallow clones of
    // other teams' repositories, which bring their own test suites — without
    // this, vitest collects hundreds of foreign test files that were never
    // meant to run here.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'data/**'],
  },
});
