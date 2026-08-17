import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';
import { randomUUID } from 'node:crypto';

/** A note is scoped either to one repository or to every review. */
export type NoteScope = 'global' | 'repo';

export interface ReviewNote {
  id: string;
  scope: NoteScope;
  /** GitLab project path (e.g. `backend-team/EPA_API`) for repo-scoped
   * notes; null for global ones. */
  projectPath: string | null;
  text: string;
  createdAt: string;
}

interface NotesFile {
  notes: ReviewNote[];
}

/**
 * Standing instructions the reviewer must honor — typically "don't flag X
 * in this project". They persist across runs, so a correction you make
 * once keeps applying: this is the project's learning curve.
 *
 * Notes are applied, but never silently: the prompt requires the review to
 * list which notes it applied, so a suppressed finding is always visible
 * as a deliberate choice rather than an omission.
 */
export class NotesStore {
  private data: NotesFile;

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  private load(): NotesFile {
    if (!existsSync(this.filePath)) return { notes: [] };
    const raw = readFileSync(this.filePath, 'utf-8');
    if (!raw.trim()) return { notes: [] };
    return { notes: [], ...(JSON.parse(raw) as Partial<NotesFile>) } as NotesFile;
  }

  private save(): void {
    writeFileAtomic(this.filePath, JSON.stringify(this.data, null, 2));
  }

  /** All notes, newest last — for the management UI. */
  /**
   * Re-reads the file, discarding the in-memory copy.
   *
   * Needed after an import replaces the file underneath us. Every store
   * here keeps the whole file in memory and rewrites all of it on the next
   * change, so without this the first save after an import would quietly
   * put the old data back — the same failure that made two StateStore
   * instances delete each other's fields.
   */
  reload(): void {
    this.data = this.load();
  }

  list(): ReviewNote[] {
    return this.data.notes;
  }

  /** Notes that apply to a review of `projectPath`: every global note plus
   * that repo's own. A null/unknown project still gets the global ones. */
  listApplicable(projectPath: string | null): ReviewNote[] {
    return this.data.notes.filter(
      (n) => n.scope === 'global' || (projectPath !== null && n.projectPath === projectPath),
    );
  }

  add(input: { scope: NoteScope; projectPath?: string | null; text: string }): ReviewNote {
    const text = input.text.trim();
    if (!text) throw new Error('Note text cannot be empty');
    if (input.scope === 'repo' && !input.projectPath) {
      throw new Error('A repo-scoped note needs a projectPath');
    }

    const note: ReviewNote = {
      id: randomUUID(),
      scope: input.scope,
      projectPath: input.scope === 'repo' ? (input.projectPath as string) : null,
      text,
      createdAt: new Date().toISOString(),
    };
    this.data.notes.push(note);
    this.save();
    return note;
  }

  remove(id: string): void {
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.save();
  }
}
