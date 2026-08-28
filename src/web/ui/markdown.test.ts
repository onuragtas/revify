import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('escapes before it builds, so model output cannot become markup', () => {
    // The review is model output about someone's code, and a diff can quote
    // anything at all. This is the one place that has to hold.
    const html = renderMarkdown('<img src=x onerror="alert(1)"> ve `<b>kod</b>`');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<code class="mdInline">&lt;b&gt;kod&lt;/b&gt;</code>');
  });

  it('escapes inside a fenced block too', () => {
    expect(renderMarkdown('```\n<script>x</script>\n```')).not.toContain('<script>');
  });

  it('turns a finding heading into a severity pill and a location', () => {
    const html = renderMarkdown('### blocking — src/a.ts:42');
    expect(html).toContain('<span class="sev sev-blocking">blocking</span>');
    expect(html).toContain('<span class="sev-loc">src/a.ts:42</span>');
  });

  it('leaves an ordinary heading ordinary', () => {
    expect(renderMarkdown('## Verdict')).toContain('>Verdict<');
    expect(renderMarkdown('## Verdict')).not.toContain('class="sev');
  });

  it('colours a quoted diff the way the diff viewer does', () => {
    const html = renderMarkdown('```diff\n-eski\n+yeni\n mevcut\n```');
    expect(html).toContain('<span class="dDel">-eski</span>');
    expect(html).toContain('<span class="dAdd">+yeni</span>');
    expect(html).toContain(' mevcut');
  });

  it('does not put a fenced block inside a paragraph', () => {
    // <pre> inside <p> is invalid, and the browser's auto-close breaks the
    // surrounding layout.
    expect(renderMarkdown('metin\n\n```\nkod\n```')).not.toMatch(/<p[^>]*>\s*<pre/);
  });

  it('opens and closes a list exactly once', () => {
    const html = renderMarkdown('- bir\n- iki\n\nsonra');
    expect(html.match(/<ul/g)).toHaveLength(1);
    expect(html.match(/<\/ul>/g)).toHaveLength(1);
    expect(html).toContain('<li>bir</li>');
  });

  it('renders nothing for nothing', () => {
    expect(renderMarkdown(null).trim()).toBe('');
    expect(renderMarkdown(undefined).trim()).toBe('');
  });
});

describe('escapeHtml', () => {
  it('covers the four characters that matter in an attribute or a body', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
