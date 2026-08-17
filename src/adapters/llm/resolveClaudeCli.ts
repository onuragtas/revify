import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finds the `claude` binary.
 *
 * Spawning it by bare name works in a terminal and fails in the installed
 * app: a GUI process on macOS inherits launchd's PATH — roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin` — not the one your shell builds from
 * .zshrc. The CLI lives in none of those, so every review in the packaged
 * app died with `spawn claude ENOENT`, a message that names the symptom
 * and hides the cause.
 *
 * Resolved once and remembered: this shells out in the worst case, and a
 * review is not the moment to pay for that repeatedly.
 */
let cached: string | null = null;

/** Where it actually installs, most specific first. */
function candidates(): string[] {
  const home = homedir();
  return [
    process.env.REVIFY_CLAUDE_PATH,
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.bun/bin/claude'),
    join(home, '.volta/bin/claude'),
  ].filter((p): p is string => Boolean(p));
}

/**
 * Asks the user's login shell where it is.
 *
 * The last resort, because it runs their startup files — but it is also
 * the only answer that is right for a version manager, a custom prefix, or
 * anything else this list cannot guess.
 */
function askLoginShell(): string | null {
  const shell = process.env.SHELL;
  if (!shell) return null;
  try {
    const found = execFileSync(shell, ['-lic', 'command -v claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .pop()
      ?.trim();
    return found && existsSync(found) ? found : null;
  } catch {
    return null;
  }
}

export function resolveClaudeCli(): string {
  if (cached) return cached;

  for (const path of candidates()) {
    if (existsSync(path)) return (cached = path);
  }

  const fromShell = askLoginShell();
  if (fromShell) return (cached = fromShell);

  // Bare name as the last word: on a machine where PATH is already right
  // this works, and if it does not, the error names every place we looked
  // instead of leaving someone to guess what ENOENT meant.
  return (cached = 'claude');
}

/** What to say when spawning fails. The paths matter: "not found" without
 * them tells someone nothing they can act on. */
export function claudeNotFoundMessage(): string {
  return (
    'claude komutu bulunamadı. Bakılan yerler: ' +
    candidates().join(', ') +
    ". Kuruluysa REVIFY_CLAUDE_PATH ile tam yolunu verebilirsin."
  );
}
