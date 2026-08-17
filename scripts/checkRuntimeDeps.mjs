/**
 * Every package the built code imports must be a runtime dependency.
 *
 * electron-builder packages `dependencies` and nothing else. A package
 * listed under `devDependencies` is present on the machine that builds the
 * installer and absent from the installer, so the code compiles, the tests
 * pass, the release is published — and the app dies on its first line with
 * ERR_MODULE_NOT_FOUND, in front of whoever downloaded it. That is exactly
 * how `electron-updater` shipped broken.
 *
 * Nothing in a normal build catches this: the failure only exists inside
 * the packaged app, and only for the modules that happen to be misfiled.
 * So this reads what dist/ actually imports and checks each one against
 * what will be packaged.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const runtime = new Set(Object.keys(pkg.dependencies ?? {}));

// Electron itself is supplied by the runtime, never bundled — it is a
// devDependency on purpose.
const provided = new Set(['electron', ...builtinModules]);

function* jsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (path.endsWith('.js')) yield path;
  }
}

/** `import x from 'y'`, `import('y')` and `require('y')` alike — a dynamic
 * import fails just as hard as a static one when the package is absent. */
const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

const missing = new Map();
for (const file of jsFiles('dist')) {
  const source = readFileSync(file, 'utf-8');
  for (const [, spec] of source.matchAll(SPECIFIER)) {
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    // '@scope/name/sub' and 'name/sub' both resolve to their package.
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (provided.has(name) || runtime.has(name)) continue;
    if (!missing.has(name)) missing.set(name, file);
  }
}

if (missing.size) {
  console.error('These packages are imported by the build but will not be packaged:\n');
  for (const [name, file] of missing) {
    const where = pkg.devDependencies?.[name] ? 'listed under devDependencies' : 'not in package.json at all';
    console.error(`  ${name} — ${where}\n    first seen in ${file}`);
  }
  console.error('\nMove them to "dependencies", or the installed app will fail to start.');
  process.exit(1);
}

console.log(`Runtime imports check: ${runtime.size} dependencies, nothing missing.`);
