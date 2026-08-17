import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AiTask, LlmProvider, TaskResult, TriggerEvent } from '../../core/types.js';
import type { JiraIssueDetail } from '../../clients/jiraClient.js';
import type { ContextRepo, RepoChange } from '../context/gitlabBranchDiffContext.js';
import type { NotesStore } from '../../core/notesStore.js';
import type { ReviewStore } from '../../core/reviewStore.js';
import { progressBus } from '../../core/progressBus.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, 'prompts/codeReview.md'), 'utf-8');

const BASE_SYSTEM_PROMPT =
  'You are a senior software engineer doing a code review. You are reviewing whether a change ' +
  'solves the problem it was written for — not only whether the code is well built. Read the ' +
  'issue as a specification and reason about the end-to-end flow the change sits in, not just ' +
  'the changed lines. Be direct and specific: every finding cites the file and line it lives at, ' +
  'and states the condition that triggers it. Write for a busy engineer deciding whether to ' +
  'merge: short, plain sentences, no preamble about your method or what you could access, no ' +
  'repetition, no filler. A review that names two real problems in ten lines beats one that ' +
  'lists eight observations in a hundred. Reviewing is not the same as finding fault — if the ' +
  'change is sound, say so in a sentence and approve it. Never name a person in the review: ' +
  'write about the code and about what was decided or requested, never about who decided or ' +
  'requested it, even when the issue or its comments name someone.';

/** The review language is configurable (config.yaml -> review.language) so
 * the output can match the team's working language. Written as a plain
 * language name ("Turkish", "English", …) that goes straight into the
 * system prompt — code identifiers, file paths, and diff snippets always
 * stay verbatim regardless of language. */
export function buildSystemPrompt(language: string): string {
  const trimmed = language.trim();
  if (!trimmed || trimmed.toLowerCase() === 'english') return BASE_SYSTEM_PROMPT;
  return (
    `${BASE_SYSTEM_PROMPT} Write the entire review in ${trimmed}. ` +
    'Keep code identifiers, file paths, and quoted diff snippets exactly as they appear in the source — do not translate them.'
  );
}

/** Kept for backwards compatibility / tests — the English default. */
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

/** Jira descriptions are Atlassian Document Format (a nested JSON tree).
 * Walk it for `text` nodes; if it's already a plain string, use it as-is. */
function extractPlainText(description: unknown): string {
  if (!description) return '(no description)';
  if (typeof description === 'string') return description;
  const chunks: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.text === 'string') chunks.push(obj.text);
    if (Array.isArray(obj.content)) obj.content.forEach(walk);
  };
  walk(description);
  return chunks.join(' ').trim() || '(no description)';
}

export interface CodeReviewPromptInput {
  issueKey: string;
  summary: string;
  description: unknown;
  /** One entry per repository the change touches — a single task can span
   * several services. */
  repoChanges: RepoChange[];
  language?: string;
  /** Set when the branch is checked out locally and the model has
   * read-only tools scoped to it. */
  hasRepoAccess?: boolean;
  /** Standing project instructions ("don't flag X here") the review must
   * honor — and disclose that it honored. */
  notes?: string[];
  /** Answers a human gave to `[?]` questions a previous run raised, so a
   * re-review can settle what it could not verify on its own. */
  clarifications?: Array<{ question: string; answer: string }>;
  /** Findings a human disputed, to be re-checked against the code. */
  challenges?: Array<{ finding: string; objection: string }>;
  /** Parent, subtasks and linked issues — background for understanding the
   * work, never additional requirements. See relatedSection in buildPrompt. */
  relatedIssues?: Array<{
    key: string;
    relation: string;
    issueType: string | null;
    status: string | null;
    summary: string;
    description: string;
  }>;
  /** The issue's Jira comments, oldest first — acceptance criteria and
   * previously requested changes live here as often as in the description. */
  comments?: Array<{ author: string; created: string; text: string }>;
  /** Free-text instructions for this revision, in the reviewer's words. */
  revisionRequest?: string;
  /** Other services checked out read-only alongside this one, so a claim
   * about what they return can be checked rather than assumed. */
  contextRepos?: ContextRepo[];
}

/** Pure so it's testable without an LLM call.
 * The language instruction is repeated here, at the very end of the user
 * turn, in addition to the system prompt: the rest of this template is
 * English, and in practice the model follows the trailing user-turn
 * instructions over a system-prompt language directive without it. */
export function buildPrompt(input: CodeReviewPromptInput): string {
  const language = (input.language ?? 'English').trim();
  const languageInstruction =
    !language || language.toLowerCase() === 'english'
      ? ''
      : `\nWrite your entire response in ${language}, including the final recommendation. ` +
        'Keep code identifiers, file paths, and quoted diff snippets exactly as they appear above.';

  const repoInstruction = input.hasRepoAccess
    ? '\nThe full repository is checked out at this branch in your working directory, and you have\n' +
      'read-only tools (Read, Glob, Grep). Open the files the diff touches and read the surrounding\n' +
      'code before judging a hunk — check how the changed symbols are declared and used elsewhere,\n' +
      'and search for other call sites. Verify your findings against the real code rather than\n' +
      'assuming from the diff; do not report a finding as uncertain when you can simply go check it.\n'
    : '';

  // The change itself. A task can span services, so each repo gets its own
  // labelled diff — a flattened blob would hide which service a hunk is in.
  const repoChanges = input.repoChanges ?? [];
  const codeChangeSection = repoChanges.length
    ? (repoChanges.length > 1
        ? `## Code change (${repoChanges.length} repositories)\n\n` +
          'This task changes more than one service. Review them together: a change in one repo\n' +
          'can only be judged against how the others call it.\n\n'
        : '## Code change\n\n') +
      repoChanges
        .map(
          (c) =>
            `### ${c.projectPath} — \`${c.branchName}\` vs \`${c.baseBranch}\`\n\n` +
            '```diff\n' +
            (c.diff || '(empty diff)') +
            '\n```\n',
        )
        .join('\n')
    : '## Code change\n\n(no diff available)\n';

  // Other services' code, checked out read-only. Naming the paths matters:
  // without them the model knows the service exists but not where to look,
  // and falls back to assuming what it returns.
  const contextRepos = input.contextRepos ?? [];
  const contextReposSection = contextRepos.length
    ? '\n## Other services available (read-only, default branch)\n\n' +
      'These repos are checked out on their default branch — released code, not anyone\'s\n' +
      'work in progress. They are here so cross-service questions can be *answered* rather\n' +
      'than asked: when a finding depends on what one of them does — the shape it returns,\n' +
      'whether a field can be absent, what an endpoint accepts — grep these repos and read\n' +
      'the code that builds that response. Treat what you find as fact and say it plainly.\n' +
      'Raising a `[?]` about something that is answerable here is a failure of the review,\n' +
      'not a caveat.\n\n' +
      contextRepos.map((r) => `- \`${r.projectPath}\` (${r.branch}) → ${r.path}`).join('\n') +
      '\n'
    : '';

  // Answers to questions an earlier run raised. These are facts the
  // reviewer could not establish from the code, so they must be trusted
  // rather than re-questioned — otherwise the loop never closes.
  const clarifications = (input.clarifications ?? []).filter((c) => c.question.trim() && c.answer.trim());
  const clarificationsSection = clarifications.length
    ? '\n## Answers from the team\n\n' +
      'A previous review raised these questions and a human answered them. Treat each answer as\n' +
      'established fact about this codebase. Do not re-raise the same `[?]` question, and revise\n' +
      'any finding that the answer settles — including dropping it, or raising its severity if the\n' +
      'answer confirms the problem.\n\n' +
      clarifications.map((c) => `- **S:** ${c.question.trim()}\n  **C:** ${c.answer.trim()}`).join('\n') +
      '\n'
    : '';

  // Findings a human disputed. Deliberately *not* treated the way answers
  // above are: an answer supplies a fact the reviewer had no way to check,
  // while an objection is a claim about code that is right there to be
  // read. Accepting it on assertion would turn the reviewer into a
  // rubber stamp — the useful behavior is to go look, then commit either way.
  const challenges = (input.challenges ?? []).filter((c) => c.finding.trim());
  const challengesSection = challenges.length
    ? '\n## Disputed findings from your previous review\n\n' +
      'A human reviewer read these findings and pushed back. **Do not simply accept the\n' +
      'objection, and do not simply repeat the finding.** For each one, go read the actual\n' +
      'code involved and settle it:\n\n' +
      '- If the code shows the objection is right, **drop the finding** and note under the\n' +
      '  verdict what you withdrew and why, on a line starting `[withdrawn]`.\n' +
      '- If the code shows the finding still stands, **keep it** and add the concrete\n' +
      '  evidence — file, line, and what the code actually does — that answers the objection.\n' +
      '- Never settle this by reasoning alone. If you cannot find the code to check, say so\n' +
      '  in the finding rather than guessing which side is right.\n\n' +
      challenges
        .map((c) => `- **Bulgu:** ${c.finding.trim()}\n  **İtiraz:** ${c.objection.trim() || '(gerekçe yok — yine de doğrula)'}`)
        .join('\n') +
      '\n'
    : '';

  // The ticket's neighbours. A task is usually written for someone who
  // already knows the programme it belongs to, and the parent is where that
  // lives — along with the conventions the team settled on elsewhere.
  const related = (input.relatedIssues ?? []).filter((r) => r.summary.trim() || r.description.trim());
  const relatedSection = related.length
    ? '\n## Related issues (background only)\n\n' +
      'Use these when the issue above does not, on its own, make clear what the work *is*:\n' +
      'what the wider change is for, what a term means, which convention the team already\n' +
      'settled on. That is what they are for.\n\n' +
      '**They are not requirements, and this is the part that matters.** A parent epic\n' +
      'describes a programme of work that many tickets share; the change under review owes\n' +
      'it nothing beyond its own ticket. Never report a finding because something described\n' +
      'here is missing from this change — that is someone else\'s ticket, not a defect. Only\n' +
      `the description, comments and acceptance criteria of ${input.issueKey} itself bind.\n\n` +
      related
        .map((r) => {
          // Hard cap: background that outweighs the issue under review would
          // pull the whole review off target.
          const text = r.description.length > 700 ? `${r.description.slice(0, 700)}\n[…kısaltıldı]` : r.description;
          const kind = [r.relation, r.issueType, r.status].filter(Boolean).join(', ');
          return `### ${r.key} — ${r.summary}\n_(${kind})_\n\n${text || '(açıklama yok)'}\n`;
        })
        .join('\n') +
      '\n'
    : '';

  // The ticket's discussion. Teams put acceptance criteria and change
  // requests here that never reach the description, and past review
  // comments are the record of what was already asked for.
  const comments = (input.comments ?? []).filter((c) => c.text.trim());
  const commentsSection = comments.length
    ? '\n## Issue discussion (Jira comments, oldest first)\n\n' +
      'Read these as part of the specification, not as background chatter:\n\n' +
      '- **Acceptance criteria** stated here bind exactly like the description does. If a\n' +
      '  criterion is not met by this change, that is a blocking finding.\n' +
      '- **Changes requested earlier** — by a reviewer, a tester, or a previous run of this\n' +
      '  review — are the first thing to check. For each one, look at the code as it stands\n' +
      '  now and decide: was it actually done? If it was, say nothing about it. If it was\n' +
      '  not, that is a blocking finding, and say which comment asked for it.\n' +
      '- **A previous review is a claim, not a fact.** Do not repeat one of its findings\n' +
      '  because it is written there. Re-check it against the current code — the whole point\n' +
      '  of re-reviewing is that the code may have moved since. A finding that has since\n' +
      '  been fixed must not be reported again.\n' +
      '- Comments can be stale, contradict each other, or be superseded by a later one. When\n' +
      '  two conflict, the later one wins; if it genuinely matters and you cannot tell, ask\n' +
      '  with a `[?]` line.\n' +
      '- **Name no one.** Refer to what was decided or asked, never to who decided or asked\n' +
      '  it: "yorumda istenen", "ekibin kararı", "14.08 tarihli yorum" — never a person\'s\n' +
      '  name, even if the description or a comment contains one. The review is about the\n' +
      '  code, and it is posted where the whole team reads it.\n\n' +
      comments
        .map((c, i) => {
          // Long comments are usually a pasted log or an old review; the
          // ask at the top is what carries the meaning.
          const text = c.text.length > 1500 ? `${c.text.slice(0, 1500)}\n[…kısaltıldı]` : c.text;
          const when = c.created ? c.created.slice(0, 10) : '';
          // Authors are deliberately not passed through. A review that says
          // "X asked for this" reads as an argument with a colleague rather
          // than an assessment of the code, and it lands on a public issue.
          // Withholding the names makes that impossible rather than merely
          // forbidden.
          return `### Yorum ${i + 1}${when ? ` — ${when}` : ''}\n\n${text}\n`;
        })
        .join('\n') +
      '\n'
    : '';

  // What the human asked for in this revision, in their own words. Kept
  // separate from the project notes below: a note is a standing rule for
  // every review of this repo, this is one instruction for this review.
  const revision = (input.revisionRequest ?? '').trim();
  const revisionSection = revision
    ? '\n## Revision requested by the reviewer\n\n' +
      'A human read your previous review and asked for this. It is an instruction, not a\n' +
      'suggestion — carry it out. Two kinds, and they are handled differently:\n\n' +
      '- **About the writing** (too long, wrong emphasis, missing QA detail, drop a finding\n' +
      '  as irrelevant): just do it.\n' +
      '- **A claim about the code** ("you missed the caller in X", "that field is never\n' +
      '  null"): go read the code and confirm it before you act on it. If the code says\n' +
      '  otherwise, keep your finding and explain why, citing file and line. Complying with\n' +
      '  an instruction you did not check is worse than not being asked.\n\n' +
      'If following it means dropping a finding, record that on a `[withdrawn]` line under\n' +
      'the verdict. Do not describe the instruction itself in the review — the review must\n' +
      'read as a review, not as a reply to feedback.\n\n' +
      revision
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n') +
      '\n'
    : '';

  // Standing team decisions about what does *not* count as a problem here.
  // Applied silently would be indistinguishable from the reviewer simply
  // missing something, so the disclosure below is part of the contract.
  const notes = (input.notes ?? []).map((n) => n.trim()).filter(Boolean);
  const notesSection = notes.length
    ? '\n## Project notes (standing decisions from the team)\n\n' +
      'These are deliberate calls about this codebase, already argued and settled. They\n' +
      'outrank everything else in this prompt — including the issue\'s own description and\n' +
      'its acceptance criteria. If a note covers something, it is not reported, however the\n' +
      'issue words it and however strongly the sections below call for it.\n\n' +
      'Two things a note cannot rule out: data loss and a security hole. Report those and\n' +
      'say plainly that they overlap a note. Nothing else qualifies — not "the acceptance\n' +
      'criteria mention it", not "it seems important", not "worth flagging anyway".\n\n' +
      notes.map((n) => `- ${n}`).join('\n') +
      '\n'
    : '';
  /*
   * The same rule again, where findings are decided.
   *
   * The notes sit with the context, some eighty lines before the section
   * that lists what to report — and a constraint stated once, early, loses
   * to instructions repeated later and closer to the decision. In practice
   * a note would be acknowledged in the disclosure and the finding
   * reported anyway.
   */
  const notesReminder = notes.length
    ? '\n**Before writing any finding, check it against the project notes above.** A finding\n' +
      'a note rules out is not written — not softened, not moved to QA notes, not mentioned\n' +
      'in passing. The issue description does not override a note; the notes were written\n' +
      'by people who had already read issues like this one.\n'
    : '';

  const notesDisclosure = notes.length
    ? '\nAfter the verdict, disclose the notes you applied — one line each, in exactly this form:\n\n' +
      '```\n[note] <which note, and what you did not report because of it>\n```\n\n' +
      'The `[note]` marker is parsed out of the review, so keep it literal and put nothing else\n' +
      'on those lines — no heading above them, no surrounding prose. If a note never came up,\n' +
      'say so on its own `[note]` line rather than inventing a suppressed finding.\n'
    : '';

  return TEMPLATE.replace('{{issueKey}}', input.issueKey)
    .replace('{{summary}}', input.summary)
    .replace('{{description}}', extractPlainText(input.description))
    .replace('{{codeChangeSection}}', codeChangeSection)
    .replace('{{repoInstruction}}', repoInstruction)
    .replace('{{contextReposSection}}', contextReposSection)
    .replace('{{clarificationsSection}}', clarificationsSection)
    .replace('{{challengesSection}}', challengesSection)
    .replace('{{relatedSection}}', relatedSection)
    .replace('{{commentsSection}}', commentsSection)
    .replace('{{revisionSection}}', revisionSection)
    .replace('{{notesSection}}', notesSection)
    .replace('{{notesReminder}}', notesReminder)
    .replace('{{notesDisclosure}}', notesDisclosure)
    .replace('{{languageInstruction}}', languageInstruction);
}

export class CodeReviewTask implements AiTask {
  constructor(
    private readonly llm: LlmProvider,
    private readonly language: string = 'English',
    private readonly notesStore?: NotesStore,
    private readonly reviewStore?: ReviewStore,
  ) {}

  async run(
    event: TriggerEvent,
    context: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const issueKey = event.data.issueKey as string;
    const summary = event.data.summary as string;
    const jiraIssue = context.jiraIssue as JiraIssueDetail | undefined;
    const repoChanges = (context.repoChanges as RepoChange[] | undefined) ?? [];
    const contextRepos = (context.contextRepos as ContextRepo[] | undefined) ?? [];

    // Notes are scoped per repo; with a multi-repo change every touched
    // project's notes apply.
    const noteTexts = [
      ...new Set(
        repoChanges.flatMap((c) => this.notesStore?.listApplicable(c.projectPath).map((n) => n.text) ?? []),
      ),
    ];
    const projectPaths = repoChanges.map((c) => c.projectPath);

    if (repoChanges.length === 0) {
      return {
        title: `Code review: ${issueKey} — ${summary}`,
        markdown: `No linked GitLab branch was found for **${issueKey}** via the Jira development panel. Skipping AI review.`,
        meta: { projectPaths, repoChanges: [] },
      };
    }

    const prompt = buildPrompt({
      issueKey,
      summary,
      description: jiraIssue?.fields.description,
      repoChanges,
      language: this.language,
      hasRepoAccess: repoChanges.some((c) => c.repoPath),
      notes: noteTexts.length ? noteTexts : this.notesStore?.listApplicable(null).map((n) => n.text),
      clarifications: this.reviewStore?.get(issueKey)?.clarifications,
      challenges: this.reviewStore?.get(issueKey)?.challenges,
      revisionRequest: this.reviewStore?.get(issueKey)?.revisionRequest,
      comments: context.jiraComments as CodeReviewPromptInput['comments'],
      relatedIssues: context.relatedIssues as CodeReviewPromptInput['relatedIssues'],
      contextRepos,
    });

    // The first changed repo is the working directory; everything else the
    // model may read is mounted alongside it.
    const changedPaths = repoChanges.map((c) => c.repoPath).filter((p): p is string => Boolean(p));
    const markdown = await this.llm.generate({
      system: buildSystemPrompt(this.language),
      prompt,
      workdir: changedPaths[0],
      extraDirs: [...changedPaths.slice(1), ...contextRepos.map((r) => r.path)],
      signal,
      onProgress: (message) => progressBus.log(event.id, message),
    });

    return {
      title: `Code review: ${issueKey} — ${summary}`,
      markdown,
      meta: { projectPaths, repoChanges },
    };
  }
}
