import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Replaces this application with a downloaded copy, on macOS.
 *
 * Squirrel — the mechanism electron-updater uses to install on a Mac —
 * refuses to install anything whose code signature does not satisfy the
 * running app's *designated requirement*. For an ad-hoc signed build that
 * requirement is measured, not guessed:
 *
 *     $ codesign -d -r- Revify.app
 *     designated => cdhash H"7c01a68d2ab0..."
 *
 * A hash of that exact binary. Every new build has a different one, so
 * Squirrel can never accept an update to an ad-hoc app — not sometimes,
 * never. That is why installing was disabled here and a download page
 * offered instead.
 *
 * So the swap is done directly. electron-updater still does the parts it
 * is good at — noticing the release, downloading the archive, checking its
 * sha512 — and this replaces the bundle with what it downloaded.
 *
 * Two properties worth naming:
 *
 *   - The archive arrives through our own process, so it carries no
 *     `com.apple.quarantine`. An app replaced this way opens without the
 *     Gatekeeper prompt a downloaded one triggers.
 *   - The old bundle is moved aside before the new one lands, and moved
 *     back if anything fails. A half-replaced application is worse than an
 *     old one, and this is the only moment where that could happen.
 */
export async function replaceAppBundle(archivePath: string, bundlePath: string): Promise<void> {
  if (!existsSync(archivePath)) throw new Error(`indirilen dosya bulunamadı: ${archivePath}`);
  if (!bundlePath.endsWith('.app')) throw new Error(`beklenmeyen uygulama yolu: ${bundlePath}`);

  const staging = mkdtempSync(join(tmpdir(), 'revify-update-'));
  const backup = `${bundlePath}.old`;

  try {
    // ditto rather than unzip: it is what Apple's own tooling uses, and it
    // preserves the symlinks, resource forks and extended attributes an
    // .app bundle depends on. A plain unzip produces something that looks
    // right and will not launch.
    await run('ditto', ['-x', '-k', archivePath, staging]);

    const unpacked = join(staging, basename(bundlePath));
    if (!existsSync(join(unpacked, 'Contents', 'MacOS'))) {
      throw new Error('indirilen arşivde beklenen uygulama yok');
    }

    // Writability is checked by attempting the move, not by inspecting
    // permissions: an app in /Applications installed by another user is
    // exactly the case where a permissions check says yes and the move
    // says no.
    rmSync(backup, { recursive: true, force: true });
    await run('mv', [bundlePath, backup]);

    try {
      await run('ditto', [unpacked, bundlePath]);
    } catch (err) {
      // Put it back. Failing to update is recoverable; leaving no
      // application behind is not.
      await run('mv', [backup, bundlePath]).catch(() => {});
      throw err;
    }

    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The .app this process is running from, or null when it is not running
 * from a bundle at all — a dev run, or an AppImage. */
export function currentBundlePath(execPath: string): string | null {
  // …/Revify.app/Contents/MacOS/Revify → …/Revify.app
  const macOsDir = dirname(execPath);
  const contents = dirname(macOsDir);
  const bundle = dirname(contents);
  return basename(macOsDir) === 'MacOS' && bundle.endsWith('.app') ? bundle : null;
}
