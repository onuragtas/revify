import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';

/**
 * The exact text each run was given, kept so a reader can check it.
 *
 * A review is an argument, and the only way to judge a strange one is to see
 * what the model was actually told — which note was in force, whether the
 * diff arrived whole, whether a comment made it in. Reconstructing that from
 * the code is guesswork; this makes it a file.
 *
 * On disk rather than in `reviews.json` for one reason: a prompt carries the
 * whole diff again, plus the issue and its comments. Folding it into the
 * record would roughly double a file that is read and rewritten in full on
 * every status change — a queue position moving would rewrite megabytes.
 * Here each prompt is written once and read only when somebody opens it.
 */

/** Which run a prompt belongs to: `review`, or `fix:<group>/<project>`. */
export type PromptKind = string;

export interface StoredPrompt {
  kind: PromptKind;
  /** The system prompt and the user turn, as sent. */
  system: string;
  prompt: string;
  savedAt: string;
}

export interface PromptSummary {
  kind: PromptKind;
  savedAt: string;
  /** Characters, so the UI can say how big it is before fetching it. */
  size: number;
}

/** Flattens one segment so it cannot traverse out of the directory: path
 * separators and dots are collapsed rather than escaped. */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '_');
}

/** `BUY-1` + `fix:team/orders` -> a flat, filesystem-safe basename. */
export function promptFileName(issueKey: string, kind: PromptKind): string {
  return `${safeSegment(issueKey)}__${safeSegment(kind)}.json`;
}

export class PromptStore {
  constructor(private readonly dir: string) {}

  /** Overwrites the previous prompt of the same kind: a re-run replaces the
   * question, exactly as it replaces the answer. */
  save(issueKey: string, kind: PromptKind, input: { system: string; prompt: string }): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const stored: StoredPrompt = {
        kind,
        system: input.system,
        prompt: input.prompt,
        savedAt: new Date().toISOString(),
      };
      writeFileAtomic(join(this.dir, promptFileName(issueKey, kind)), JSON.stringify(stored));
    } catch (err) {
      // Bookkeeping must never take a review down with it. A missing prompt
      // costs somebody a look at what was asked; a failed review costs the
      // work itself.
      console.warn(`[prompt] ${issueKey}/${kind} kaydedilemedi: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  read(issueKey: string, kind: PromptKind): StoredPrompt | null {
    const path = join(this.dir, promptFileName(issueKey, kind));
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as StoredPrompt;
    } catch {
      return null;
    }
  }

  /** Every file belonging to one issue. */
  private prefixFor(issueKey: string): string {
    return `${safeSegment(issueKey)}__`;
  }

  /** What exists for this issue, and how big each one is. */
  list(issueKey: string): PromptSummary[] {
    if (!existsSync(this.dir)) return [];
    const prefix = this.prefixFor(issueKey);
    const summaries: PromptSummary[] = [];

    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf-8')) as StoredPrompt;
        summaries.push({
          kind: parsed.kind,
          savedAt: parsed.savedAt,
          size: (parsed.system?.length ?? 0) + (parsed.prompt?.length ?? 0),
        });
      } catch {
        // A half-written or hand-edited file is not worth failing over.
      }
    }
    // Review first, then the fixes — the order they happened in.
    return summaries.sort((a, b) => (a.kind === 'review' ? -1 : b.kind === 'review' ? 1 : a.kind.localeCompare(b.kind)));
  }

  /** Drops everything for an issue. Called when a task is cleared, so
   * "clear" does not leave the last prompt behind for the next one. */
  forget(issueKey: string): void {
    if (!existsSync(this.dir)) return;
    const prefix = this.prefixFor(issueKey);
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(prefix)) rmSync(join(this.dir, name), { force: true });
    }
  }

  /** Bytes on disk, for anyone wondering where the space went. */
  size(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).reduce((total, name) => {
      try {
        return total + statSync(join(this.dir, name)).size;
      } catch {
        return total;
      }
    }, 0);
  }
}
