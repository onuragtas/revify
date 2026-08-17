/**
 * Minimal Markdown → Atlassian Document Format converter.
 *
 * Jira's REST API takes comment bodies as ADF, a structured JSON document
 * — it does not parse Markdown. Posting the review text as a single text
 * node would render the `###`, `**` and fence characters literally, and
 * collapse every line break, so the whole review arrives as one wall of
 * text. This converts the subset the review prompt actually produces.
 */

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string }>;
  attrs?: Record<string, unknown>;
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/** Splits a line into text nodes, applying `code` and `strong` marks.
 * Inline code is matched first so `**` inside a code span stays literal. */
export function inlineNodes(line: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Alternates: `code` | **strong**
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: line.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      nodes.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    } else {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < line.length) {
    nodes.push({ type: 'text', text: line.slice(lastIndex) });
  }

  // ADF rejects an empty paragraph content array, and a text node with an
  // empty string, so callers get a single space instead of nothing.
  return nodes.length ? nodes : [{ type: 'text', text: ' ' }];
}

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = String(markdown ?? '').split('\n');
  const content: AdfNode[] = [];

  let i = 0;
  let listItems: AdfNode[] | null = null;

  const closeList = (): void => {
    if (listItems && listItems.length) {
      content.push({ type: 'bulletList', content: listItems });
    }
    listItems = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — consume until the closing fence (or EOF, so an
    // unterminated fence doesn't swallow the rest silently).
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      closeList();
      const language = fence[1] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // step past the closing fence
      content.push({
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        content: [{ type: 'text', text: body.join('\n') || ' ' }],
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      content.push({
        type: 'heading',
        attrs: { level: Math.min(heading[1].length, 6) },
        content: inlineNodes(heading[2]),
      });
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!listItems) listItems = [];
      listItems.push({
        type: 'listItem',
        content: [{ type: 'paragraph', content: inlineNodes(bullet[1]) }],
      });
      i++;
      continue;
    }

    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }

    closeList();
    content.push({ type: 'paragraph', content: inlineNodes(line) });
    i++;
  }
  closeList();

  // An empty doc is rejected by Jira.
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: ' ' }] });
  }

  return { type: 'doc', version: 1, content };
}

/**
 * The other direction: an ADF document as plain text.
 *
 * Jira returns descriptions and comments as a nested node tree, and every
 * consumer here (the prompt, the UI, the logs) wants text. Block-level
 * nodes emit a newline so paragraphs and list items don't run together
 * into one unreadable line, which is what a naive `text`-only walk gives.
 */
export function adfToText(node: unknown): string {
  const BLOCK = new Set([
    'paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'rule', 'tableRow',
  ]);
  const out: string[] = [];

  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;

    if (typeof obj.text === 'string') out.push(obj.text);
    // Mentions and emoji carry their label in attrs, not in a text node.
    if (obj.type === 'mention') out.push(String((obj.attrs as any)?.text ?? ''));
    if (Array.isArray(obj.content)) obj.content.forEach(walk);
    if (typeof obj.type === 'string' && BLOCK.has(obj.type)) out.push('\n');
  };

  walk(node);
  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
