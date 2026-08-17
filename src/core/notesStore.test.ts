import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotesStore } from './notesStore.js';

describe('NotesStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-reviewer-notes-'));
    filePath = join(dir, 'nested', 'reviewNotes.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty and persists added notes across instances', () => {
    const store = new NotesStore(filePath);
    expect(store.list()).toEqual([]);

    store.add({ scope: 'global', text: 'Ignore missing tests' });

    const reloaded = new NotesStore(filePath);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0].text).toBe('Ignore missing tests');
  });

  it('applies global notes to every repo, and repo notes only to their own', () => {
    const store = new NotesStore(filePath);
    store.add({ scope: 'global', text: 'global rule' });
    store.add({ scope: 'repo', projectPath: 'team/alpha', text: 'alpha rule' });
    store.add({ scope: 'repo', projectPath: 'team/beta', text: 'beta rule' });

    const alpha = store.listApplicable('team/alpha').map((n) => n.text);
    expect(alpha).toEqual(['global rule', 'alpha rule']);

    const beta = store.listApplicable('team/beta').map((n) => n.text);
    expect(beta).toEqual(['global rule', 'beta rule']);
  });

  it('falls back to global-only when the repo is unknown', () => {
    const store = new NotesStore(filePath);
    store.add({ scope: 'global', text: 'global rule' });
    store.add({ scope: 'repo', projectPath: 'team/alpha', text: 'alpha rule' });

    expect(store.listApplicable(null).map((n) => n.text)).toEqual(['global rule']);
  });

  it('rejects an empty note and a repo note with no project', () => {
    const store = new NotesStore(filePath);

    expect(() => store.add({ scope: 'global', text: '   ' })).toThrow(/cannot be empty/);
    expect(() => store.add({ scope: 'repo', text: 'x' })).toThrow(/needs a projectPath/);
  });

  it('removes a note by id', () => {
    const store = new NotesStore(filePath);
    const note = store.add({ scope: 'global', text: 'temporary' });

    store.remove(note.id);

    expect(store.list()).toEqual([]);
    expect(new NotesStore(filePath).list()).toEqual([]);
  });
});
