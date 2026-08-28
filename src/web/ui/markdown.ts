/**
 * The review's own markdown, rendered the way this app has always rendered
 * it.
 *
 * Ported rather than replaced by a library, for two reasons. It escapes
 * first and builds the HTML itself, so what reaches `v-html` is never
 * attacker-shaped — a markdown library would need a sanitiser beside it to
 * make the same promise. And it does one thing no general renderer does:
 * turns a finding's `### blocking — src/a.ts:42` heading into a coloured
 * pill, which is what lets a reader see how bad a review is before reading
 * a word of it.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `+`/`-` lines in a quoted diff, coloured like the diff viewer. Input is
 * already escaped by the caller. */
function colourDiffLines(escaped: string): string {
  return escaped
    .split('\n')
    .map((line) => {
      if (line.startsWith('+')) return `<span class="dAdd">${line}</span>`;
      if (line.startsWith('-')) return `<span class="dDel">${line}</span>`;
      return line;
    })
    .join('\n');
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code class="mdInline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** Findings are `### <severity> — <file:line>`. Anything else stays an
 * ordinary heading. */
function headingBody(text: string): string {
  const match = text.match(/^(blocking|major|minor)\b\s*[—–-]?\s*(.*)$/i);
  if (!match) return inline(text);
  const severity = match[1].toLowerCase();
  return (
    `<span class="sev sev-${severity}">${severity}</span>` +
    (match[2] ? `<span class="sev-loc">${inline(match[2])}</span>` : '')
  );
}

export function renderMarkdown(md: string | null | undefined): string {
  // Pull fenced blocks out first so their contents aren't treated as
  // markdown (a diff body is full of `-`, `+`, `*` and `#`).
  const blocks: string[] = [];
  let text = String(md ?? '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    const body = escapeHtml(code.replace(/\n$/, ''));
    blocks.push(
      `<pre class="mdCode${lang ? ` lang-${escapeHtml(lang)}` : ''}"><code>` +
        (lang === 'diff' ? colourDiffLines(body) : body) +
        '</code></pre>',
    );
    return `%%BLOCK${blocks.length - 1}%%`;
  });

  text = escapeHtml(text);

  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);

    // A fenced block stands on its own — wrapping <pre> in <p> is invalid
    // HTML and the browser's auto-close breaks the surrounding layout.
    if (/^%%BLOCK\d+%%$/.test(line.trim())) {
      closeList();
      out.push(line.trim());
    } else if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level} class="mdH">${headingBody(heading[2])}</h${level}>`);
    } else if (bullet) {
      if (!inList) {
        out.push('<ul class="mdList">');
        inList = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
    } else if (line.trim() === '') {
      closeList();
      out.push('');
    } else {
      closeList();
      out.push(`<p class="mdP">${inline(line)}</p>`);
    }
  }
  closeList();

  return out.join('\n').replace(/%%BLOCK(\d+)%%/g, (_m, i: string) => blocks[Number(i)]);
}
