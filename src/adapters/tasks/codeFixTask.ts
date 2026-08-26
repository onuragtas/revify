import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LlmProvider } from '../../core/types.js';
import type { Finding } from '../../core/findings.js';
import { isEmptyRequirement, renderComments, type Requirement } from '../../core/requirement.js';
import type { PromptStore } from '../../core/promptStore.js';

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

/**
 * A finding chosen for fixing, plus what the human said about how.
 *
 * The reviewer is instructed to give options rather than invent an answer
 * when the right fix turns on something it cannot see ("kuyruk sırası
 * garanti ediliyorsa X; edilmiyorsa Y"). That leaves a decision outstanding,
 * and the person picking findings to fix is exactly the person who can make
 * it — so this is where they make it. Without it the fixer picks an option
 * on its own and the human's call never reaches the code.
 */
export interface SelectedFinding extends Finding {
  /** Free text: which option, or how. Empty when they had nothing to add. */
  instruction?: string;
}

/** One repository of the change, open for editing. */
export interface FixRepo {
  projectPath: string;
  branchName: string;
  /** Absolute path of the throwaway workspace. Named in the prompt because
   * a fixer that knows a service exists but not where to read it falls back
   * to assuming what it returns. */
  path: string;
  /** The reviewed diff for this repository, so the fixer sees the change it
   * is correcting rather than only the finding's quoted lines. */
  diff: string;
}

export interface FixPromptInput {
  issueKey: string;
  summary: string;
  /**
   * Every repository the change spans, all at once.
   *
   * One run rather than one per repository, because a finding can span them:
   * a route on one side and the call to it on the other cannot be written by
   * two agents that cannot see each other's work. It also removes the need
   * to guess which repository a finding belongs to — the fixer has them all
   * and reads the paths for itself.
   *
   * Only repositories the change already touches. A service it never touched
   * is on its default branch, so a patch made there would be against `master`
   * while the change lives on a feature branch — and adding code to a service
   * nobody touched is a scope decision for a human, not an inference.
   */
  repos: FixRepo[];
  findings: SelectedFinding[];
  language?: string;
  /**
   * What the issue asked for, as the review read it.
   *
   * Needed because the review's own definition of `blocking` includes "the
   * issue is not solved" — a requirement that was never implemented. A
   * fixer given only the finding is being asked to complete something
   * without being told what it was supposed to do.
   */
  requirement?: Requirement | null;
  /** Standing team decisions about this codebase. A review honours them by
   * not reporting; a fix honours them by writing code that obeys them. */
  notes?: string[];
  /** Facts a human established that the review could not verify on its own.
   * Often the very thing that decides between two possible fixes. */
  clarifications?: Array<{ question: string; answer: string }>;
}

/** Pure, so the prompt can be asserted in a test without an LLM call. */
export function buildFixPrompt(input: FixPromptInput): string {
  const language = (input.language ?? 'English').trim();
  const languageInstruction =
    !language || language.toLowerCase() === 'english'
      ? ''
      : `\nWrite your report in ${language}. Keep file paths and code identifiers exactly as they are.`;

  /*
   * The ask, and a hard fence around it.
   *
   * Handing a fixer the whole ticket invites it to implement the whole
   * ticket. The text is here so a finding of the form "this requirement is
   * not met" can be acted on at all — everything else in it belongs to
   * whoever is doing the ticket, not to this patch.
   */
  const requirement = input.requirement;
  const requirementSection = isEmptyRequirement(requirement)
    ? ''
    : '\n## What the issue asked for\n\n' +
      '**This is background for the findings above, not a list of work.** It is here so a\n' +
      'finding that says a requirement is unmet can be fixed by someone who knows what the\n' +
      'requirement was. Implement nothing from it that no selected finding names — an\n' +
      'unimplemented requirement nobody flagged is somebody else\'s ticket, and putting it in\n' +
      'this patch makes the patch unreviewable. If reading this convinces you a finding is\n' +
      'wrong, do not fix it: say so in your report and leave the code alone.\n\n' +
      (requirement!.description.trim()
        ? `### Açıklama\n\n${requirement!.description.trim()}\n`
        : '') +
      (requirement!.comments.length
        ? '\n### Issue discussion (oldest first)\n\n' +
          'Acceptance criteria and previously requested changes live here as often as in the\n' +
          'description. Later comments win over earlier ones.\n\n' +
          renderComments(requirement!.comments)
        : '');

  // Facts, not opinions: a human answered a question the review could not
  // settle from the code. Re-litigating one would reopen a loop that was
  // closed on purpose.
  const clarifications = (input.clarifications ?? []).filter((c) => c.question.trim() && c.answer.trim());
  const clarificationsSection = clarifications.length
    ? '\n## Answers from the team\n\n' +
      'A human answered these while the review was being read. Treat each answer as\n' +
      'established fact about this codebase and let it decide the shape of your fix. Do not\n' +
      'work around one, and do not go looking for evidence against it.\n\n' +
      clarifications.map((c) => `- **S:** ${c.question.trim()}\n  **C:** ${c.answer.trim()}`).join('\n') +
      '\n'
    : '';

  /*
   * Standing decisions, stated where the code gets written.
   *
   * These read to a reviewer as "do not report this". To a fixer they mean
   * something stronger: the code you write has to obey them. A fix that
   * solves the finding by doing the thing a note forbids has traded one
   * problem for one the team has already argued about.
   */
  const notes = (input.notes ?? []).map((n) => n.trim()).filter(Boolean);
  const notesSection = notes.length
    ? '\n## Project notes (standing decisions from the team)\n\n' +
      'Deliberate calls about this codebase, already argued and settled. Your change must\n' +
      'obey them — they outrank your own judgement about what the code ought to look like.\n' +
      'If the only fix you can see for a finding would break one of these, do not write it:\n' +
      'skip the finding and say which note stands in the way.\n\n' +
      notes.map((n) => `- ${n}`).join('\n') +
      '\n'
    : '';

  /*
   * The human's call, immediately under the finding it settles.
   *
   * Stated as a decision, not a hint. A finding that offers two options has
   * an open question in it, and an instruction here is the answer — a fixer
   * that weighs it against its own reading has thrown away the one piece of
   * information it could not have worked out for itself.
   */
  const repos = input.repos;
  const reposSection =
    repos.length === 1
      ? `You are working in **${repos[0].projectPath}** at branch \`${repos[0].branchName}\`:\n\n` +
        `- \`${repos[0].projectPath}\` (${repos[0].branchName}) → ${repos[0].path}\n`
      : `This change spans ${repos.length} repositories, and all of them are open:\n\n` +
        repos.map((r) => `- \`${r.projectPath}\` (${r.branchName}) → ${r.path}`).join('\n') +
        '\n\nA finding that needs both sides — an endpoint here and its caller there — is yours\n' +
        'to finish, not to skip.\n';

  const diffSection =
    repos.length === 1
      ? '```diff\n' + (repos[0].diff.trim() || '(diff yok)') + '\n```\n'
      : repos
          .map(
            (r) =>
              `### ${r.projectPath} — \`${r.branchName}\`\n\n` +
              '```diff\n' +
              (r.diff.trim() || '(diff yok)') +
              '\n```\n',
          )
          .join('\n');

  const findingsSection = input.findings
    .map((f) => {
      const instruction = (f.instruction ?? '').trim();
      return (
        `### ${f.heading}\n\n` +
        `_(${f.severity}${f.location ? ` — ${f.location}` : ''})_\n\n` +
        `${f.body || '(gövde yok)'}\n` +
        (instruction
          ? `\n**Nasıl düzeltilecek — bunu bir insan söyledi, karardır:**\n\n> ${instruction.split('\n').join('\n> ')}\n\n` +
            'This settles the finding above. Where it names an option, take that option; where\n' +
            'it names an approach, take that approach. Do not weigh it against your own reading\n' +
            'and do not pick the other branch because it looks better from here — the person who\n' +
            'wrote it knows something about this system that is not in the diff. If it turns out\n' +
            'to be impossible, change nothing and say why in your report.\n'
          : '')
      );
    })
    .join('\n');

  return TEMPLATE.replace('{{issueKey}}', input.issueKey)
    .replace('{{summary}}', input.summary || '(özet yok)')
    .replace('{{reposSection}}', reposSection)
    .replace('{{diffSection}}', diffSection)
    .replace('{{findingsSection}}', findingsSection)
    .replace('{{requirementSection}}', requirementSection)
    .replace('{{clarificationsSection}}', clarificationsSection)
    .replace('{{notesSection}}', notesSection)
    .replace('{{languageInstruction}}', languageInstruction);
}

export interface FixRun extends FixPromptInput {
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
    /** Same reason as the review's: a patch nobody expected is read against
     * what the fixer was actually told. */
    private readonly promptStore?: PromptStore,
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
    if (!run.repos.length) throw new Error('Düzeltilecek repo yok.');

    const system = buildFixSystemPrompt(this.language);
    const prompt = buildFixPrompt({ ...run, language: this.language });
    this.promptStore?.save(run.issueKey, 'fix', { system, prompt });

    return this.llm.generate({
      system,
      prompt,
      // The first workspace is the working directory; the rest are mounted
      // beside it. All of them are writable — see the write-mode note in
      // ClaudeCliProvider for why that is safe here and nowhere else.
      workdir: run.repos[0].path,
      extraDirs: run.repos.slice(1).map((r) => r.path),
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
