'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Re-seals the macOS bundle after electron-builder has filled it.
 *
 * Without this the app arrives broken, and macOS words it in the least
 * helpful way it has: *"Revify is damaged and can't be opened."* Nothing is
 * damaged. What happens is:
 *
 *   1. The Electron binary ships with an ad-hoc, linker-generated signature
 *      that covers the binary as Electron built it.
 *   2. electron-builder copies our application into the bundle. The bundle
 *      no longer matches the signature — `codesign --verify` says "code has
 *      no resources but signature indicates they must be present".
 *   3. Downloading sets com.apple.quarantine.
 *
 * On Apple Silicon every executable must carry a valid signature, so an
 * invalid one plus quarantine is refused outright, and the refusal is
 * reported as damage. The same package on Intel would only warn.
 *
 * Signing ad-hoc (`--sign -`) makes the seal match the bundle again. It
 * does not make the app *trusted* — there is no Developer ID here, so
 * Gatekeeper still asks — but "unidentified developer", which right-click →
 * Open answers, is a question the user can act on. "Damaged" is not.
 *
 * This runs *before* electron-builder's own signing step, so a real
 * Developer ID signature applied afterwards simply replaces this seal —
 * the ad-hoc one can never strip trust that was paid for. The identity
 * check below only avoids doing work twice.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // Set by electron-builder when it did the signing itself.
  if (context.packager.platformSpecificBuildOptions.identity) {
    console.log('[afterPack] signed with a Developer ID — leaving it alone');
    return;
  }

  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;

  // --deep is deprecated for distribution signing, and rightly so: it signs
  // nested code with the outer options. For an ad-hoc seal, where there are
  // no options worth inheriting, it is the one call that reaches every
  // framework and helper Electron nests.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });

  // Verify rather than assume. A signature that silently failed to apply
  // reproduces the exact bug this hook exists to prevent, and the next
  // person to find out would be someone downloading a release.
  execFileSync('codesign', ['--verify', '--strict', app], { stdio: 'inherit' });
  console.log('[afterPack] ad-hoc signed and verified');
};
