import { describe, expect, it } from 'vitest';
import { inlineNodes, markdownToAdf } from './adf.js';

describe('inlineNodes', () => {
  it('marks bold and inline code, keeping surrounding text', () => {
    expect(inlineNodes('**Etki:** `logo` alanı null.')).toEqual([
      { type: 'text', text: 'Etki:', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'logo', marks: [{ type: 'code' }] },
      { type: 'text', text: ' alanı null.' },
    ]);
  });

  it('leaves ** inside inline code literal', () => {
    expect(inlineNodes('`a ** b`')).toEqual([
      { type: 'text', text: 'a ** b', marks: [{ type: 'code' }] },
    ]);
  });

  it('never returns an empty content array (ADF rejects it)', () => {
    expect(inlineNodes('')).toEqual([{ type: 'text', text: ' ' }]);
  });
});

describe('markdownToAdf', () => {
  it('converts a heading to a heading node with its level', () => {
    const doc = markdownToAdf('### blocking — file.php:12');

    expect(doc.type).toBe('doc');
    expect(doc.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 3 },
      content: [{ type: 'text', text: 'blocking — file.php:12' }],
    });
  });

  it('converts a fenced block to a codeBlock and keeps its body verbatim', () => {
    const doc = markdownToAdf(['```php', '$a = 1;', '# not a heading', '```'].join('\n'));

    expect(doc.content).toEqual([
      {
        type: 'codeBlock',
        attrs: { language: 'php' },
        content: [{ type: 'text', text: '$a = 1;\n# not a heading' }],
      },
    ]);
  });

  it('groups consecutive bullets into one bulletList', () => {
    const doc = markdownToAdf(['- bir', '- iki', '', 'düz paragraf'].join('\n'));

    expect(doc.content[0].type).toBe('bulletList');
    expect(doc.content[0].content).toHaveLength(2);
    expect(doc.content[1].type).toBe('paragraph');
  });

  it('does not swallow the rest of the document on an unterminated fence', () => {
    const doc = markdownToAdf(['```php', '$a = 1;'].join('\n'));

    expect(doc.content).toHaveLength(1);
    expect(doc.content[0].type).toBe('codeBlock');
  });

  it('produces a valid non-empty doc for empty input', () => {
    const doc = markdownToAdf('');

    expect(doc.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }]);
  });

  it('keeps a realistic review structurally intact', () => {
    const doc = markdownToAdf(
      [
        'Özet cümlesi.',
        '',
        '### blocking — app/x.php:181',
        '',
        '```php',
        '$r = f();',
        '```',
        '',
        '**Etki:** bozuluyor.',
        '',
        '**QA için**',
        '- Ekranı aç',
        '- Alanı boşalt',
        '',
        'Verdict: Request changes',
      ].join('\n'),
    );

    expect(doc.content.map((n) => n.type)).toEqual([
      'paragraph',
      'heading',
      'codeBlock',
      'paragraph',
      'paragraph',
      'bulletList',
      'paragraph',
    ]);
  });
});
