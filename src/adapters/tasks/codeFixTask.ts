import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LlmProvider } from '../../core/types.js';
import type { Finding } from '../../core/findings.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, 'prompts/codeFix.md'), 'utf-8');

const BASE_SYSTEM_PROMPT =
  'You are a senior software engineer applying the findings of a code review to the code ' +
  'itself. You are not reviewing anything: the judgement has been made and a human has ' +
  'already chosen which findings to act on. Your job is to make each of those true, in the ' +
  'smallest correct change, in the style of the code around it. Read before you edit — the ' +
  'file the finding names, the callers of what you are changing, the tests that cover it. ' +
  'Change nothing you were not asked to change: an unrequested improvement in the same patch ' +
  'makes the requested one unreviewable. When a fix would require a decision you have not ' +
  'been given, or rests on something you cannot verify from this repository, make no change ' +
  'and say what would settle it — an unfixed finding is visible to everyone, a wrong fix is ' +
  'not. Never weaken a check, delete a test, or widen an exception handler to make a symptom ' +
  'go away.';

export function buildFixSystemPrompt(language: string): string {
  const trimmed = language.trim();
  if (!trimmed || trimmed.toLowerCase() === 'english') return BASE_SYSTEM_PROMPT;
  return (
    `${BASE_SYSTEM_PROMPT} Write your report in ${trimmed}. Code, identifiers, file paths and ` +
    'anything you write into a file stay in the language of the codebase — the report is what ' +
    'is translated, never the code.'
  );
}

export interface FixPromptInput {
  issueKey: string;
  summary: string;
  projectPath: string;
  branchName: string;
  /** The reviewed diff for this repository, so the fixer sees the change it
   * is correcting rather than only the finding's quoted lines. */
  diff: string;
  findings: Finding[];
  language?: string;
}

/** Pure, so the prompt can be asserted in a test without an LLM call. */
export function buildFixPrompt(input: FixPromptInput): string {
  const language = (input.language ?? 'English').trim();
  const languageInstruction =
    !language || language.toLowerCase() === 'english'
      ? ''
      : `\nWrite your report in ${language}. Keep file paths and code identifiers exactly as they are.`;

  const findingsSection = input.findings
    .map(
      (f) =>
        `### ${f.heading}\n\n` +
        `_(${f.severity}${f.location ? ` — ${f.location}` : ''})_\n\n` +
        `${f.body || '(gövde yok)'}\n`,
    )
    .join('\n');

  return TEMPLATE.replace('{{issueKey}}', input.issueKey)
    .replace('{{summary}}', input.summary || '(özet yok)')
    .replace(/\{\{projectPath\}\}/g, input.projectPath)
    .replace(/\{\{branchName\}\}/g, input.branchName)
    .replace('{{findingsSection}}', findingsSection)
    .replace('{{diff}}', input.diff.trim() || '(diff yok)')
    .replace('{{languageInstruction}}', languageInstruction);
}

export interface FixRun extends FixPromptInput {
  /** The throwaway workspace the fixer may edit — never the repo cache and
   * never the reviewer's own checkout. See core/fixWorkspace.ts. */
  workdir: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/**
 * Turns selected findings into edits on disk.
 *
 * Deliberately not an `AiTask`: the pipeline's tasks answer with text that
 * a human then decides about, while this one's whole output is what it
 * leaves in a directory. The text it returns is a report *about* those
 * edits — which findings it acted on, and which it refused to guess at.
 */
export class CodeFixTask {
  constructor(
    private readonly llm: LlmProvider,
    private readonly language: string = 'English',
  ) {}

  /** False when the wired provider has no file tools — the UI asks first so
   * nobody watches a run that could never have changed anything. */
  get available(): boolean {
    return this.llm.canEditFiles === true;
  }

  async run(run: FixRun): Promise<string> {
    if (!this.available) {
      throw new Error(
        'Bu LLM sağlayıcısı dosya düzenleyemez. Düzeltme için `claudeCli` sağlayıcısı gerekiyor ' +
          '(config.yaml → wiring.llm).',
      );
    }

    return this.llm.generate({
      system: buildFixSystemPrompt(this.language),
      prompt: buildFixPrompt({ ...run, language: this.language }),
      workdir: run.workdir,
      write: true,
      signal: run.signal,
      onProgress: run.onProgress,
    });
  }
}

/** One line of the fixer's report: what it did with one finding. */
export interface FixReportLine {
  outcome: 'fixed' | 'skipped';
  text: string;
}

/**
 * Reads the report back into rows the UI can show next to the patch.
 *
 * Anything that isn't one of the two markers is dropped rather than shown:
 * the markers are the contract, and prose that slipped in around them says
 * nothing a reader of the patch doesn't already have.
 */
export function parseFixReport(report: string): FixReportLine[] {
  const lines: FixReportLine[] = [];
  for (const line of String(report ?? '').split('\n')) {
    const match = line.match(/^\s*\[(fixed|skipped)\]\s*(.+?)\s*$/i);
    if (!match) continue;
    lines.push({ outcome: match[1].toLowerCase() as 'fixed' | 'skipped', text: match[2] });
  }
  return lines;
}
