import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

/**
 * The Vue half of the UI, built into the page that already exists.
 *
 * The migration is a strangler, not a rewrite: `index.html` keeps serving
 * every screen it serves today, and Vue takes one container at a time. That
 * is the only way to satisfy the rule this migration was given — no feature
 * may quietly disappear — because at every step the app is the whole app.
 *
 * Output lands in `src/web/public/assets/` rather than `dist/`: Express
 * serves `src/web/public` in development and `dist/web/public` in a build,
 * and one output path keeps those from disagreeing. The directory is
 * generated and git-ignored.
 */
export default defineConfig({
  plugins: [vue()],
  /*
   * A browser has no `process`.
   *
   * Vue's ESM build branches on `process.env.NODE_ENV` for its development
   * warnings, and library mode — unlike an app build — leaves that
   * expression alone, on the assumption that a downstream bundler will
   * substitute it. Nothing downstream does here: the file is loaded straight
   * by a <script type="module">, so the first line that touches `process`
   * throws `ReferenceError` and the whole bundle dies before it can mount.
   * The window stays empty, which on a dark theme is a black screen.
   *
   * Substituting it here also strips Vue's dev-only branches, which is most
   * of the bundle's weight.
   */
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve(__dirname, 'src/web/public/assets'),
    emptyOutDir: true,
    // A fixed name, because a plain <script> tag in a hand-written HTML file
    // cannot follow a content hash.
    lib: {
      entry: resolve(__dirname, 'src/web/ui/main.ts'),
      formats: ['es'],
      fileName: () => 'ui.js',
    },
    // The page is served from the app's own origin and loaded by Electron;
    // there is no CDN and nothing to split across.
    cssCodeSplit: false,
    sourcemap: true,
  },
});
