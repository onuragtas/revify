/**
 * A unified diff, read as rows a table can show.
 *
 * Split view needs deletions and insertions paired up side by side, which a
 * unified diff does not give you: it lists every `-` then every `+`. So the
 * pending runs are collected and zipped — a `-` with a `+` beside it is one
 * modified line, a `-` alone is a deletion, a `+` alone is an insertion.
 */

export interface DiffRow {
  type: 'hunk' | 'ctx' | 'add' | 'del' | 'mod';
  text?: string;
  oldNo?: number | null;
  oldText?: string | null;
  newNo?: number | null;
  newText?: string | null;
}

export function parseUnifiedDiff(diffText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let pendingDel: Array<{ no: number; text: string }> = [];
  let pendingAdd: Array<{ no: number; text: string }> = [];

  function flushPending(): void {
    const pairs = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < pairs; i++) {
      const del = pendingDel[i];
      const add = pendingAdd[i];
      rows.push({
        type: del && add ? 'mod' : del ? 'del' : 'add',
        oldNo: del ? del.no : null,
        oldText: del ? del.text : null,
        newNo: add ? add.no : null,
        newText: add ? add.text : null,
      });
    }
    pendingDel = [];
    pendingAdd = [];
  }

  /*
   * One trailing newline is a terminator, not a line.
   *
   * Git ends its output with `\n`, so a plain split leaves an empty string
   * at the end — which this reads as a blank context line and draws as a
   * ghost row under every file. Empty input becomes no rows at all rather
   * than one blank one.
   */
  const text = String(diffText ?? '').replace(/\n$/, '');
  for (const line of text ? text.split('\n') : []) {
    if (line.startsWith('@@')) {
      flushPending();
      // @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldNo = parseInt(match[1], 10);
        newNo = parseInt(match[2], 10);
      }
      rows.push({ type: 'hunk', text: line });
      continue;
    }
    // Skip file headers; the file path is already the <summary>.
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff --git')) continue;

    if (line.startsWith('-')) {
      pendingDel.push({ no: oldNo++, text: line.slice(1) });
    } else if (line.startsWith('+')) {
      pendingAdd.push({ no: newNo++, text: line.slice(1) });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — metadata, not content.
      continue;
    } else {
      flushPending();
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({ type: 'ctx', oldNo: oldNo++, oldText: text, newNo: newNo++, newText: text });
    }
  }
  flushPending();
  return rows;
}

/** One unified row per change. A modification is one row in split view but
 * two changes in truth, so unified shows both — you can read what actually
 * replaced what. */
export interface UnifiedRow {
  cls: string;
  mark: string;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export function toUnifiedRows(rows: DiffRow[]): Array<DiffRow | UnifiedRow> {
  const out: Array<DiffRow | UnifiedRow> = [];
  for (const r of rows) {
    if (r.type === 'hunk') {
      out.push(r);
    } else if (r.type === 'mod') {
      out.push({ cls: 'del', mark: '−', oldNo: r.oldNo ?? null, newNo: null, text: r.oldText ?? '' });
      out.push({ cls: 'add', mark: '+', oldNo: null, newNo: r.newNo ?? null, text: r.newText ?? '' });
    } else if (r.type === 'del') {
      out.push({ cls: 'del', mark: '−', oldNo: r.oldNo ?? null, newNo: null, text: r.oldText ?? '' });
    } else if (r.type === 'add') {
      out.push({ cls: 'add', mark: '+', oldNo: null, newNo: r.newNo ?? null, text: r.newText ?? '' });
    } else {
      out.push({ cls: 'ctx', mark: '', oldNo: r.oldNo ?? null, newNo: r.newNo ?? null, text: r.oldText ?? '' });
    }
  }
  return out;
}

export function isHunk(row: DiffRow | UnifiedRow): row is DiffRow {
  return (row as DiffRow).type === 'hunk';
}
