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
 * `REVIFY_API_URL` overrides both. That is an operator's escape hatch — for
 * a staging box, or someone self-hosting the whole thing — not a setting
 * the app surfaces. Nothing in the UI reads or writes it.
 */
const PRODUCTION_URL = 'https://revify.resoft.org';
const DEVELOPMENT_URL = 'http://localhost:4322';

export function backendUrl(): string {
  const override = process.env.REVIFY_API_URL?.trim();
  if (override) return override.replace(/\/$/, '');

  // REVIFY_ENV is set by the build; NODE_ENV is honoured too so a plain
  // `NODE_ENV=production node dist/...` behaves the way anyone would expect.
  const env = (process.env.REVIFY_ENV ?? process.env.NODE_ENV ?? '').toLowerCase();
  return env === 'production' ? PRODUCTION_URL : DEVELOPMENT_URL;
}

/** True when this build talks to the deployed service. Shown in the UI so
 * nobody has to guess which one they are signed in to. */
export function isProductionBackend(): boolean {
  return backendUrl() === PRODUCTION_URL;
}
