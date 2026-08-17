import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Writes a file so a crash can never leave a half-written one behind.
 *
 * These stores rewrite the whole file on every change — 167KB of reviews
 * for a handful of issues, and growing. A plain `writeFileSync` truncates
 * first, so a process that dies mid-write leaves a truncated JSON file:
 * every review, every answer and every note gone, unrecoverably, because
 * the only copy was the one being overwritten.
 *
 * Writing to a sibling temp file and renaming avoids that. `rename` within
 * a directory is atomic on POSIX and on Windows via ReplaceFile, so a
 * reader sees either the old file or the new one — never a partial one.
 */
export function writeFileAtomic(filePath: string, contents: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  // Same directory, because rename is only atomic within a filesystem.
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
}
