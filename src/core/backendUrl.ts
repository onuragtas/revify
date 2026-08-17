/**
 * Where the Revify backend lives.
 *
 * Baked in rather than asked for. The address is a property of the build,
 * not a preference: a reviewer has no way to know it, no reason to care,
 * and every chance to mistype it. Asking made the first screen a
 * configuration form for something that has exactly one right answer.
 *
 * Two builds, two answers:
 *   - production  → the deployed service
 *   - anything else (dev, test) → a backend on this machine
 *
 * REVIFY_ENV is read here, when this is called — not substituted into the
 * code at compile time. Setting it while building does nothing; the
 * desktop entry point sets it for a packaged app, which is what makes a
 * release point at the deployed service.
 *
 * Two ways to override, in order: the address saved in settings (what the
 * settings screen writes), then `REVIFY_API_URL` for an operator who wants
 * to point a build somewhere without opening it.
 *
 * The build's value is the default, not a lock: a staging box, a colleague
 * running their own backend, or a moved server should not need a new build.
 */
const PRODUCTION_URL = 'https://revify.resoft.org';
const DEVELOPMENT_URL = 'http://localhost:4322';

export function backendUrl(override?: string): string {
  const chosen = override?.trim() || process.env.REVIFY_API_URL?.trim();
  if (chosen) return chosen.replace(/\/$/, '');

  // Set by the desktop entry point when the app is packaged; NODE_ENV is
  // honoured too so a plain `NODE_ENV=production node dist/...` behaves the
  // way anyone would expect.
  const env = (process.env.REVIFY_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();
  return env === 'production' ? PRODUCTION_URL : DEVELOPMENT_URL;
}

/** The address this build was made with, ignoring any override. Shown as
 * the settings field's placeholder so "leave it empty" has a visible
 * meaning. */
export function defaultBackendUrl(): string {
  const env = (process.env.REVIFY_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();
  return env === 'production' ? PRODUCTION_URL : DEVELOPMENT_URL;
}

/** True when this build talks to the deployed service. */
export function isProductionBackend(): boolean {
  return backendUrl() === PRODUCTION_URL;
}
