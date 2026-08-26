import { describe, expect, it } from 'vitest';
import {
  extractPlainText,
  isEmptyRequirement,
  MAX_COMMENT,
  MAX_DESCRIPTION,
  renderComments,
  toRequirement,
} from './requirement.js';

describe('extractPlainText', () => {
  it('flattens an Atlassian document into readable text', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Sipariş iptalinde' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'iade yazılmalı.' }] },
      ],
    };
    expect(extractPlainText(adf)).toBe('Sipariş iptalinde iade yazılmalı.');
  });

  it('passes a plain string through', () => {
    expect(extractPlainText('düz metin')).toBe('düz metin');
  });

  it('is empty rather than a placeholder, so each prompt words it its own way', () => {
    expect(extractPlainText(null)).toBe('');
    expect(extractPlainText({ type: 'doc', content: [] })).toBe('');
  });
});

describe('toRequirement', () => {
  it('keeps the comments and drops who wrote them', () => {
    // The absence of names is a guarantee, not a rule to be followed: the
    // fix inherits it from the review because the text never carries them.
    const requirement = toRequirement('D', [
      { created: '2026-08-14T12:52:00.000+0000', text: 'Kabul kriteri: placeholder gösterilmeli.' },
    ]);

    expect(requirement.comments).toEqual([
      { created: '2026-08-14T12:52:00.000+0000', text: 'Kabul kriteri: placeholder gösterilmeli.' },
    ]);
    expect(JSON.stringify(requirement)).not.toContain('author');
  });

  it('drops empty comments', () => {
    expect(toRequirement('D', [{ text: '   ' }, { text: 'gerçek' }]).comments).toHaveLength(1);
  });

  it('caps what it stores, so a pasted log cannot grow the record forever', () => {
    const requirement = toRequirement('x'.repeat(MAX_DESCRIPTION + 500), [
      { text: 'y'.repeat(MAX_COMMENT + 500) },
    ]);

    expect(requirement.description).toContain('[…kısaltıldı]');
    expect(requirement.description.length).toBeLessThan(MAX_DESCRIPTION + 30);
    expect(requirement.comments[0].text).toContain('[…kısaltıldı]');
  });

  it('survives an issue with nothing on it', () => {
    expect(toRequirement(undefined)).toEqual({ description: '', comments: [] });
  });
});

describe('renderComments', () => {
  it('numbers them and shows the date only', () => {
    const rendered = renderComments([
      { created: '2026-08-14T12:52:00.000+0000', text: 'ilk' },
      { created: '', text: 'ikinci' },
    ]);

    expect(rendered).toContain('### Yorum 1 — 2026-08-14');
    expect(rendered).not.toContain('12:52');
    expect(rendered).toContain('### Yorum 2\n');
  });
});

describe('isEmptyRequirement', () => {
  it('is true for nothing worth putting in a prompt', () => {
    expect(isEmptyRequirement(null)).toBe(true);
    expect(isEmptyRequirement({ description: '  ', comments: [] })).toBe(true);
    expect(isEmptyRequirement({ description: '', comments: [{ created: '', text: 'x' }] })).toBe(false);
  });
});
