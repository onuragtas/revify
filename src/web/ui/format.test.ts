import { describe, expect, it } from 'vitest';
import { elapsedText, sinceText } from './format.js';

describe('elapsedText', () => {
  it('counts from the start of the run, as mm:ss', () => {
    expect(elapsedText('2026-08-28T10:00:00Z', '2026-08-28T10:00:00Z')).toBe('00:00');
    expect(elapsedText('2026-08-28T10:00:00Z', '2026-08-28T10:00:07Z')).toBe('00:07');
    expect(elapsedText('2026-08-28T10:00:00Z', '2026-08-28T10:02:13Z')).toBe('02:13');
  });

  it('does not wrap minutes at sixty', () => {
    // `+72:05` is longer than `+12:05` at a glance; `1:12:05` invites a
    // second look, and this is read while watching a log scroll.
    expect(elapsedText('2026-08-28T10:00:00Z', '2026-08-28T11:12:05Z')).toBe('72:05');
  });

  it('says nothing rather than something wrong', () => {
    // A clock that runs backwards, or a timestamp that is not one. Better an
    // absent number than a negative one presented as a duration.
    expect(elapsedText('2026-08-28T10:00:05Z', '2026-08-28T10:00:00Z')).toBe('');
    expect(elapsedText('değil', '2026-08-28T10:00:00Z')).toBe('');
  });
});

describe('sinceText', () => {
  it('says how long something has been waiting', () => {
    const now = Date.parse('2026-08-28T12:00:00Z');
    expect(sinceText('2026-08-28T11:58:00Z', now)).toContain('2');
    expect(sinceText('2026-08-27T12:00:00Z', now)).toBeTruthy();
  });
});
