/**
 * The review, read as a list of findings rather than as prose.
 *
 * The reviewer writes each finding under a heading of the form
 * `### <severity> — <file:line>` (codeReview.md fixes that shape). Parsing
 * it back out is what lets a human pick the ones worth fixing and hand
 * exactly those to the fixer — the alternative is passing the whole review
 * and hoping the model picks the same subset the reviewer meant.
 *
 * Server-side, and shared: the UI's checkbox list, the "worst severity"
 * column and the fix prompt all read the same parse. Three parsers of the
 * same text would be three chances to disagree about what a finding is.
 */

export type Severity = 'blocking' | 'major' | 'minor';

/** Severities in the order a human cares about them. */
export const SEVERITY_ORDER: Severity[] = ['blocking', 'major', 'minor'];

/** The ones a fix run offers by default — a minor is a nit, and a patch
 * nobody asked for is noise in someone's working copy. */
export const FIXABLE_SEVERITIES: Severity[] = ['blocking', 'major'];

export interface Finding {
  /** Positional and stable only within one review text. A fix request
   * carries these ids and is resolved against the same review immediately,
   * so they never have to survive a re-review. */
  id: string;
  severity: Severity;
  /** Whatever followed the severity in the heading — `src/a.ts:42` when the
   * reviewer had a line to point at, a flow or a file name when it didn't. */
  location: string;
  /** The heading as written, minus the `#`s. What the UI lists and what the
   * fix report refers back to. */
  heading: string;
  /** Everything under the heading, up to the next one. */
  body: string;
}

const HEADING = /^(#{2,6})\s*(?:\*\*)?(blocking|major|minor)(?:\*\*)?\b\s*[—–-]?\s*(.*)$/i;

/**
 * What ends a finding without starting another.
 *
 * A section heading, the QA notes, or the verdict line — all of which belong
 * to the review as a whole. The verdict matters most: `codeReview.md` asks
 * for it as a bare `Verdict: …` line, so without this rule it lands inside
 * whichever finding happened to be written last, and travels to the fixer as
 * if it were part of that finding.
 */
const SECTION_END = /^\s*(?:#{1,6}\s|\*\*"?QA|Verdict:)/i;

/**
 * Splits a review into its findings.
 *
 * Fenced blocks are tracked because a finding's quoted diff can contain
 * anything at all — including a line that looks like a markdown heading
 * when the changed file is itself markdown. Without the fence check, one
 * such line would cut a finding in half.
 */
export function parseFindings(markdown: string): Finding[] {
  return splitFindings(markdown).findings;
}

/** A review read as its three parts. */
export interface ReviewSections {
  /** Whatever the reviewer wrote before the first finding — usually a
   * sentence of context. */
  preamble: string;
  findings: Finding[];
  /** Everything after the last finding: the verdict, the QA notes. It
   * belongs to the review as a whole, not to the finding it happens to
   * follow. */
  tail: string;
}

/**
 * Splits a review into its findings *and* the prose around them.
 *
 * The UI shows findings as cards — severity, file and actions of their own —
 * so it needs to know which text is a finding and which is not. Computing
 * that here rather than in the browser keeps one scanner: a second
 * implementation would disagree about where a finding ends the first time a
 * reviewer wrote a heading inside a quoted diff.
 */
export function splitFindings(markdown: string): ReviewSections {
  const findings: Finding[] = [];
  const preamble: string[] = [];
  const tail: string[] = [];
  const lines = String(markdown ?? '').split('\n');

  let current: { severity: Severity; location: string; heading: string; lines: string[] } | null = null;
  let inFence = false;
  /** True once the first finding heading has been seen — what separates the
   * preamble from the verdict. */
  let started = false;

  const flush = () => {
    if (!current) return;
    findings.push({
      id: `f${findings.length}`,
      severity: current.severity,
      location: current.location,
      heading: current.heading,
      body: current.lines.join('\n').trim(),
    });
    current = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;

    if (!inFence) {
      const match = line.match(HEADING);
      if (match) {
        flush();
        started = true;
        const severity = match[2].toLowerCase() as Severity;
        const location = match[3].trim().replace(/^`|`$/g, '');
        current = {
          severity,
          location,
          heading: line.replace(/^#+\s*/, '').trim(),
          lines: [],
        };
        continue;
      }
      // A heading, the QA notes or the verdict end the finding before them
      // — and then belong to the tail, not to the finding they closed.
      if (SECTION_END.test(line)) {
        flush();
        started = true;
      }
    }

    if (current) current.lines.push(line);
    // Outside a finding: before the first one it is context, after the last
    // one it is the verdict.
    else if (started) tail.push(line);
    else preamble.push(line);
  }
  flush();

  return {
    preamble: preamble.join('\n').trim(),
    findings,
    tail: tail.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/** The highest severity present, or '' when the review reported none. */
export function worstSeverity(markdown: string): Severity | '' {
  const present = new Set(parseFindings(markdown).map((f) => f.severity));
  return SEVERITY_ORDER.find((level) => present.has(level)) ?? '';
}
