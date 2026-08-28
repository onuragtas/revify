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
  },
});
