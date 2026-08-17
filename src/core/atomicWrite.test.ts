import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'atomic-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp file behind', () => {
    const target = join(dir, 'nested', 'state.json');
    writeFileAtomic(target, '{"a":1}');

    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
  });

  it('replaces existing content in one step', () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  it('leaves the previous file intact when the write fails', () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, 'the only copy');

    // A directory in place of the temp file is the simplest reproducible
    // write failure; the point is that the original survives it.
    // Exactly the temp path the writer will use, occupied by a directory.
    mkdirSync(`${target}.${process.pid}.tmp`);

    expect(() => writeFileAtomic(target, 'replacement')).toThrow();
    // Truncate-then-write would have destroyed this.
    expect(readFileSync(target, 'utf-8')).toBe('the only copy');
  });
});
