import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AiTask, LlmProvider, TaskResult, TriggerEvent } from '../../core/types.js';
import type { JiraIssueDetail } from '../../clients/jiraClient.js';
import type { ContextRepo, RepoChange } from '../context/gitlabBranchDiffContext.js';
import type { NotesStore } from '../../core/notesStore.js';
import type { ReviewHistoryEntry, ReviewStore } from '../../core/reviewStore.js';
import { splitFindings } from '../../core/findings.js';
import { chunkChange, mergeReviews, needsDeepScan, type ReviewChunk } from '../../core/reviewChunks.js';
import { splitCommitsByOwnership } from '../../core/changeScope.js';
import type { PromptStore } from '../../core/promptStore.js';
import { progressBus } from '../../core/progressBus.js';
import { parseProjectPathFromUrl } from '../../clients/gitlabClient.js';
import {
  extractPlainText,
  renderComments,
  toRequirement,
  type Requirement,
} from '../../core/requirement.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, 'prompts/codeReview.md'), 'utf-8');

const BASE_SYSTEM_PROMPT =
  'You are a senior software engineer doing a code review. You are reviewing whether a change ' +
  'solves the problem it was written for — not only whether the code is well built. Read the ' +
  'issue as a specification and reason about the end-to-end flow the change sits in, not just ' +
  'the changed lines. Be direct and specific: every finding cites the file and line it lives at, ' +
  'and states the condition that triggers it. Write for a busy engineer deciding whether to ' +
  'merge: short, plain sentences, no preamble about your method or what you could access, no ' +
  'repetition, no filler. Report every real defect you find: a review is not more useful for ' +
  'being shorter, and a defect left out is one that ships. What stays out is padding — ' +
  'observations that are not defects, restatements, and notes about things that are fine. ' +
  'Review the change you were given and not the code around it: a defect ' +
  'that was already there, on code this change neither touches nor depends on, ' +
  'is not this review\'s subject. ' +
  'Reviewing is not the same as finding fault — if the ' +
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
    /**
     * Branches Jira links to *that* issue, when it has work in flight.
     *
     * Named, never checked out. An unmerged branch is not the truth about
     * production, so it cannot settle anything — but knowing it exists is
     * what stops a review reporting "this endpoint does not exist" about
     * something a sibling ticket is adding right now.
     */
    branches?: Array<{ name: string; repositoryUrl: string }>;
  }>;
  /** The issue's Jira comments, oldest first — acceptance criteria and
   * previously requested changes live here as often as in the description. */
  comments?: Array<{ author: string; created: string; text: string }>;
  /** Free-text instructions for this revision, in the reviewer's words. */
  revisionRequest?: string;
  /**
   * This pass is reading one slice of a larger change.
   *
   * Set only on the slice passes of a deep scan. It narrows what the pass
   * is asked for — line-level defects in these files — and tells it that
   * the questions which need the whole change are being answered elsewhere,
   * so it neither repeats them nor writes a verdict against a fraction of
   * the diff.
   */
  slice?: { label: string; of: number };
  /**
   * The last review of this change, and what was done about it.
   *
   * Without this a re-review starts from nothing: it reads code somebody
   * has just fixed, has no idea which findings prompted the change, and
   * reports whatever it sees as if for the first time. To the person
   * waiting, that is a review that never converges — fix, re-review, new
   * findings, again. The point of passing it is to make the second pass
   * *answer* the first rather than repeat it.
   */
  previous?: {
    findings: Array<{ severity: string; heading: string; body: string }>;
    /** What a fix run claimed to change since. */
    fixReport?: Array<{ outcome: 'fixed' | 'skipped'; text: string }>;
  };
  /** Other services checked out read-only alongside this one, so a claim
   * about what they return can be checked rather than assumed. */
  contextRepos?: ContextRepo[];
  /** Files pulled down from Jira, and the ones deliberately left behind. */
  attachments?: {
    fetched: Array<{ filename: string; path: string; size: number }>;
    skipped: Array<{ filename: string; reason: string }>;
  };
}


/**
 * The commits behind a diff, and which of them are this ticket's.
 *
 * A branch that has been open for months carries work that was never the
 * ticket's: a change made on another ticket, never merged to the base, still
 * sitting on this branch. The diff flattens all of it into one blob, so the
 * review reads a stranger's commit from nine months ago as this developer's
 * doing and reports it against the wrong person — who then, correctly,
 * dismisses the finding.
 *
 * The membership test is `core/changeScope.ts`, the same one that already
 * took those commits' files out of the diff. This list is what makes that
 * removal visible: the reader sees which commits were set aside, and the
 * model is told plainly that they are not its subject — rather than being
 * left to wonder why a commit it can see produced no hunks it can read.
 */
function commitList(
  commits: Array<{ sha: string; title: string; author: string; date: string }> | undefined,
  issueKey: string,
): string {
  if (!commits?.length) return '';

  const { foreign } = splitCommitsByOwnership(commits, issueKey);
  const isForeign = (c: { sha: string }) => foreign.some((f) => f.sha === c.sha);

  return (
    `**Bu dalın \`${issueKey}\` için taşıdığı commitler** (eskiden yeniye):\n\n` +
    commits
      .map(
        (c) =>
          `- \`${c.sha}\` ${c.date.slice(0, 10)} · ${c.author} · ${c.title}` +
          (isForeign(c) ? '  ← **başka task — diff dışı bırakıldı**' : ''),
      )
      .join('\n') +
    '\n\n' +
    (foreign.length
      ? 'The marked commits name a different ticket, so **the files only they touched have\n' +
        'already been removed from the diff above.** They are listed only so you know why\n' +
        'the diff does not account for every commit on the branch.\n\n' +
        '**Do not report findings about them.** They are not this developer\'s work and not\n' +
        'this review\'s subject; a finding about one gets dismissed by the person who reads\n' +
        'it, and buries the findings that are about the work under review. If one of them\n' +
        'touched a file this ticket also changed, that file is still shown whole — judge the\n' +
        'hunks this ticket is responsible for, and leave the rest alone.\n\n'
      : '')
  );
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
            commitList(c.commits, input.issueKey) +
            '```diff\n' +
            (c.diff || '(empty diff)') +
            '\n```\n',
        )
        .join('\n')
    : '## Code change\n\n(no diff available)\n';

  // Other services' code, checked out read-only. Naming the paths matters:
  // without them the model knows the service exists but not where to look,
  // and falls back to assuming what it returns.
  /*
   * Attachments, named and located.
   *
   * The unreadable ones are listed too. A review that cannot see
   * `flow.docx` should say so rather than reason as though the issue had
   * no specification — and the reader is the one who can convert it.
   */
  const attachments = input.attachments ?? { fetched: [], skipped: [] };
  const attachmentsSection =
    attachments.fetched.length || attachments.skipped.length
      ? '\n## Attachments\n\n' +
        (attachments.fetched.length
          ? 'Downloaded from this issue and the ones linked to it. Read the ones that look\n' +
            'like a specification, a flow or an interface contract — they often carry the\n' +
            'requirement the description only summarises.\n\n' +
            attachments.fetched.map((f) => `- \`${f.filename}\` → ${f.path}`).join('\n') + '\n'
          : '') +
        (attachments.skipped.length
          ? '\nPresent on the issue but not readable here. If one of them clearly holds the\n' +
            'answer to something you cannot otherwise settle, say which, and say what it\n' +
            'would settle:\n\n' +
            attachments.skipped.map((f) => `- \`${f.filename}\` — ${f.reason}`).join('\n') + '\n'
          : '')
      : '';

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
      '**If an objection asks something, answer it.** People write "is that field not already\n' +
      'validated in the controller?" as often as they write "this is wrong", and a question\n' +
      'that goes unanswered is why the same objection comes back next round. Put the answer\n' +
      'under the verdict on its own line, opening with the finding\'s heading exactly as it\n' +
      'appears above — that is what pairs the answer with the question:\n\n' +
      '```\n' +
      '[answer] blocking — src/Payment.php:829 — Evet, `validate()` çağrılıyor ama yalnızca\n' +
      'POST yolunda; bu akış `PaymentJob` üzerinden geliyor ve orada çağrılmıyor.\n' +
      '```\n\n' +
      'Answer it whether or not the finding survives. A question is most worth answering\n' +
      'precisely when you withdraw the finding — that is the case where the answer would\n' +
      'otherwise disappear with it. Answer from the code, with file and line, or say plainly\n' +
      'that you could not check.\n\n' +
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
      '**Background is all they are, and this is the part that matters.** A parent epic\n' +
      'describes a programme of work that many tickets share; the change under review owes\n' +
      'it nothing beyond its own ticket. They bind nothing and they are the subject of\n' +
      'nothing:\n\n' +
      '- Never report a finding because something described here is missing from this\n' +
      '  change. That is someone else\'s ticket, not a defect.\n' +
      '- Never report a finding about code that belongs to one of them. A sibling\n' +
      '  ticket\'s work can sit in the same repository, and reading it here to understand\n' +
      '  the whole does not put it under review — see "What is under review" above.\n\n' +
      `Only the description, comments and acceptance criteria of ${input.issueKey} itself\n` +
      'bind, and only the change under review is being judged.\n\n' +
      related
        .map((r) => {
          // Hard cap: background that outweighs the issue under review would
          // pull the whole review off target.
          const text = r.description.length > 700 ? `${r.description.slice(0, 700)}\n[…kısaltıldı]` : r.description;
          const kind = [r.relation, r.issueType, r.status].filter(Boolean).join(', ');
          const branches = (r.branches ?? [])
            .map((b) => `\`${b.name}\` (${parseProjectPathFromUrl(b.repositoryUrl) ?? b.repositoryUrl})`)
            .join(', ');
          return (
            `### ${r.key} — ${r.summary}\n_(${kind})_\n\n` +
            (branches ? `**Üzerinde çalışılan dal(lar):** ${branches}\n\n` : '') +
            `${text || '(açıklama yok)'}\n`
          );
        })
        .join('\n') +
      (related.some((r) => r.branches?.length)
        ? '\n**Some of these have work in flight.** A branch listed above exists and is not\n' +
          'merged; you cannot read it and it settles nothing — it may change, and it may never\n' +
          'land. But it changes what you do with an absence: when this change depends on\n' +
          'something that is missing, and a neighbour\'s in-flight branch looks like the thing\n' +
          'adding it, do not report it as unimplemented. Say which ticket appears to be adding\n' +
          'it and raise one `[?]` asking whether it is in place. A blocking finding about work\n' +
          'somebody is doing right now costs the reader more than the question does.\n'
        : '') +
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
      // Bodies rendered by the shared formatter — it is the same text the
      // fix run is given, and it is where the truncation and the deliberate
      // absence of author names live.
      renderComments(comments.map((c) => ({ created: c.created, text: c.text }))) +
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

  /*
   * What the last pass said, and what happened since.
   *
   * Ordered before the new findings on purpose: the first duty of a
   * re-review is to settle the open ones. Being explicit that "the code
   * near it changed" is not evidence matters — a fix run reports what it
   * *intended*, and a review that takes that at face value launders a claim
   * into a fact.
   */
  const previous = input.previous;
  const previousSection =
    previous && previous.findings.length
      ? '\n## Your previous review of this change\n\n' +
        'This change has been reviewed before and worked on since. These are the findings\n' +
        'that review reported:\n\n' +
        previous.findings
          .map((f, i) => `${i + 1}. **${f.heading}**\n\n${f.body.trim()}\n`)
          .join('\n') +
        (previous.fixReport?.length
          ? '\nA fix run then reported doing this — its own account, not a verified fact:\n\n' +
            previous.fixReport.map((r) => `- ${r.outcome === 'fixed' ? 'düzeltildi' : 'atlandı'}: ${r.text}`).join('\n') +
            '\n'
          : '') +
        '\nSettle every one of them first, against the code as it is now:\n\n' +
        '- **Resolved** — do not report it again. List it under the verdict as\n' +
        '  `[resolved] <heading> — <what changed>`, one line each.\n' +
        '- **Still open** — report it as a finding again, saying what is still missing.\n' +
        '  A finding that survives a fix attempt is more important than a new one, not less.\n' +
        '- **Partly done** — report what remains, and say which part landed.\n\n' +
        'Check the condition that made it a finding, not the neighbourhood. Code changing\n' +
        'near a finding is not evidence that the finding is gone, and neither is a fix run\n' +
        'saying it fixed it — that is a claim to verify, and a wrong one is the most\n' +
        'expensive kind here: it closes a real defect on paper while it ships.\n\n' +
        'Then report anything genuinely new. If the change is now sound, say so and approve\n' +
        '— re-reviews are supposed to end.\n'
      : '';

  /*
   * What a slice pass is, and what it is not.
   *
   * Placed at the end of the prompt, where a trailing instruction carries
   * most weight, because it has to override several sections above it that
   * ask for exactly the things a slice must not produce: a verdict, QA
   * notes, a deployment checklist, a judgement about whether the issue is
   * solved. Those are answered once, by the pass that saw the whole change.
   */
  const sliceInstruction = input.slice
    ? `\n\n---\n\n## Bu geçiş: ${input.slice.label}\n\n` +
      `Bu, değişikliğin ${input.slice.of} parçaya bölünmüş hâlinin bir parçası. Yukarıdaki\n` +
      'kod yalnızca bu parça — bütünü başka bir geçiş okuyor.\n\n' +
      '**Yalnızca bulgu yaz.** Şunları yazma, çünkü bütünü gören geçiş zaten yazıyor ve\n' +
      'ikisi birleştirilecek:\n\n' +
      '- giriş cümlesi ya da özet yok\n' +
      '- `Verdict:` satırı yok — bir parçaya bakarak değişikliğin tamamı hakkında karar\n' +
      '  verilemez\n' +
      '- QA için / Prod öncesi bölümleri yok\n' +
      '- gereksinim karşılama, uçtan uca akış, repolar arası tutarlılık yok\n\n' +
      'Buna karşılık bu satırlara **yakından bak**: bir bütünü tarayan geçişin gözden\n' +
      'kaçırdığı şey tam olarak burada bulunur — kullanılmayan dönüş değeri, yanlış\n' +
      'karşılaştırma, yutulan hata, eksik null kontrolü, sınır durumu. Bulduğun her\n' +
      'blocking ve major bulguyu yaz; sayı sınırı yok.\n' +
      'Bulgu biçimi yukarıdaki ile aynı: `### <severity> — <file:line>`.\n'
    : '';

  return TEMPLATE.replace('{{issueKey}}', input.issueKey)
    .replace('{{summary}}', input.summary)
    .replace('{{description}}', extractPlainText(input.description) || '(no description)')
    .replace('{{codeChangeSection}}', codeChangeSection)
    .replace('{{repoInstruction}}', repoInstruction)
    .replace('{{contextReposSection}}', contextReposSection)
    .replace('{{attachmentsSection}}', attachmentsSection)
    .replace('{{clarificationsSection}}', clarificationsSection)
    .replace('{{challengesSection}}', challengesSection)
    .replace('{{relatedSection}}', relatedSection)
    .replace('{{commentsSection}}', commentsSection)
    .replace('{{previousSection}}', previousSection)
    .replace('{{revisionSection}}', revisionSection)
    .replace('{{notesSection}}', notesSection)
    .replace('{{notesReminder}}', notesReminder)
    .replace('{{notesDisclosure}}', notesDisclosure)
    .replace('{{languageInstruction}}', languageInstruction) + sliceInstruction;
}

/**
 * The last review's findings, ready to be answered.
 *
 * Read from history rather than from the live record because re-reviewing
 * archives the review before the new run starts — by the time this is
 * asked, `record.review` is already the previous one's replacement slot,
 * empty. The findings are re-parsed rather than stored a second time: one
 * parser, and it is the same one the UI and the fix path read with.
 */
export function previousReview(
  record?: { history?: ReviewHistoryEntry[] },
): CodeReviewPromptInput['previous'] {
  const last = record?.history?.[0];
  if (!last) return undefined;

  const findings = splitFindings(last.markdown).findings.map((f) => ({
    severity: f.severity,
    heading: f.heading,
    body: f.body,
  }));
  if (!findings.length) return undefined;

  return { findings, fixReport: last.fixReport };
}

/**
 * One retry for a model call that failed outright — a dropped connection,
 * an overloaded API, a CLI that exited nonzero for no reason the next
 * attempt will repeat. Not for a stop: `signal.aborted` means the run was
 * told to end, and retrying it would spawn a second process nobody asked
 * for, so an `AbortError` is rethrown untouched.
 *
 * A single retry, not a loop — a review call costs real minutes and real
 * usage, and a failure that survives one retry is telling you something a
 * third attempt is unlikely to fix.
 */
async function withRetry<T>(run: () => Promise<T>, onRetry: (err: Error) => void): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    onRetry(err instanceof Error ? err : new Error(String(err)));
    return run();
  }
}

/** How many of the whole-pass-plus-slices calls may run at once.
 *
 * They read the same checkout with read-only tools and never see each
 * other's output, so nothing about the work itself requires a queue of
 * one. What does is the account behind `claude`: every call is a request
 * against its own concurrency limit, not this process's, and firing all of
 * them at once trades a slow success for a pile of rate-limit failures.
 * Low and fixed rather than tuned per run — the failure mode on the other
 * side of "too high" is worse than the win on the other side of "too low". */
const REVIEW_CONCURRENCY = 3;

/**
 * Runs `jobs` with at most `concurrency` in flight, in submission order.
 *
 * A worker pool rather than chunked batches of `concurrency` at a time:
 * batching would let the slowest job in a batch hold up starting the next
 * batch's jobs even while other slots sit idle. Here a slot picks up the
 * next job the moment it frees up.
 *
 * Stops handing out new jobs after the first failure — already-running
 * jobs finish (there is no way to cancel a CLI subprocess mid-call without
 * the caller's own abort signal), but a fatal failure does not go on to
 * start work nobody will read the result of.
 */
async function runWithConcurrency<T>(concurrency: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  let firstError: unknown;
  const worker = async () => {
    for (;;) {
      if (firstError !== undefined) return;
      const index = next++;
      if (index >= jobs.length) return;
      try {
        results[index] = await jobs[index]();
      } catch (err) {
        if (firstError === undefined) firstError = err;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}

export class CodeReviewTask implements AiTask {
  constructor(
    private readonly llm: LlmProvider,
    private readonly language: string = 'English',
    private readonly notesStore?: NotesStore,
    private readonly reviewStore?: ReviewStore,
    /** Keeps the exact text this run was given, so a reader can check the
     * review against what the model was actually told. */
    private readonly promptStore?: PromptStore,
  ) {}

  async run(
    event: TriggerEvent,
    context: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    /*
     * What to call this run, whether or not Jira named it.
     *
     * A local review has no `issueKey` — it was started from a directory —
     * and this read `event.data.issueKey` unconditionally. `undefined` then
     * travelled everywhere: into the prompt ("the description of undefined
     * binds"), into the review's title, into `promptStore.save`, and into
     * the three `reviewStore.get` calls below, which is why a dispute or a
     * "Review'i düzelt" instruction on a local review was silently ignored.
     *
     * `event.id` is the key the record is stored under and is always there;
     * when Jira did name the issue the two are the same string.
     */
    const issueKey = (event.data.issueKey as string | undefined) ?? event.id;
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
      /*
       * Nothing to review, said in terms of what was actually asked.
       *
       * A run started from a directory has no Jira development panel and
       * never had a linked branch, so blaming one sends the reader to look
       * at a Jira issue that does not exist. It happened: `localRepoDiffContext`
       * was missing from the wiring, so the collector never ran, and every
       * local review came back reporting a GitLab branch it was never about.
       */
      const local = typeof event.data.repoPath === 'string';
      return {
        title: `Code review: ${issueKey} — ${summary}`,
        markdown: local
          ? `\`${event.data.repoPath}\` için incelenecek bir değişiklik toplanamadı. ` +
            'Dizin taban dalıyla aynı ve çalışma alanı temiz olabilir; ' +
            "ya da `wiring.contextCollectors` listesinde `localRepoDiffContext` yok — " +
            'o zaman yerel dizin hiç okunmaz.'
          : `No linked GitLab branch was found for **${issueKey}** via the Jira development panel. Skipping AI review.`,
        meta: { projectPaths, repoChanges: [], requirement: toRequirement(jiraIssue?.fields.description) },
      };
    }

    /*
     * How thoroughly to read, decided per run by whoever started it.
     *
     * Not a setting: the person pressing the button knows whether this is a
     * fifty-file change they want gone over properly or a two-line one they
     * want an answer to now, and the honest place for that choice is in
     * front of them at the moment they make it. `auto` is the default — one
     * pass for a change one pass can cover, and slices for the ones it
     * cannot.
     */
    const mode = (event.data.scanMode as string | undefined) ?? 'auto';
    const deep = mode === 'deep' || (mode !== 'single' && needsDeepScan(repoChanges));

    /*
     * Said out loud, including when it decided to do the cheap thing.
     *
     * `auto` cannot be decided when the button is pressed — nobody knows
     * how big the change is until the collectors have fetched it — so the
     * choice happens here, and the only way anyone can see what it chose is
     * if it says. Logging only the deep path would leave "it read this in
     * one pass" indistinguishable from "it never considered anything else".
     */
    const diffChars = repoChanges.reduce((n, c) => n + c.diff.length, 0);
    progressBus.log(
      event.id,
      `tarama: ${deep ? 'bölerek' : 'tek geçiş'} · ${repoChanges.length} repo · ` +
        `${Math.round(diffChars / 1000)}k karakter · ${mode === 'auto' ? 'otomatik seçildi' : `${mode} istendi`}`,
    );

    const promptInput: CodeReviewPromptInput = {
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
      previous: previousReview(this.reviewStore?.get(issueKey)),
      comments: context.jiraComments as CodeReviewPromptInput['comments'],
      relatedIssues: context.relatedIssues as CodeReviewPromptInput['relatedIssues'],
      contextRepos,
      attachments: context.attachments as CodeReviewPromptInput['attachments'],
    };
    const prompt = buildPrompt(promptInput);

    // Written before the call, not after: a run that fails or is stopped is
    // exactly the one somebody wants to read the prompt of.
    const system = buildSystemPrompt(this.language);
    this.promptStore?.save(issueKey, 'review', { system, prompt });

    // The first changed repo is the working directory; everything else the
    // model may read is mounted alongside it.
    const changedPaths = repoChanges.map((c) => c.repoPath).filter((p): p is string => Boolean(p));
    const mounts = {
      workdir: changedPaths[0],
      extraDirs: [
        ...changedPaths.slice(1),
        ...contextRepos.map((r) => r.path),
        // Where the Jira files landed. Without this the paths in the
        // prompt name files the model is not permitted to open.
        ...(context.attachmentDir ? [context.attachmentDir as string] : []),
      ],
    };

    /*
     * A second reading, slice by slice, run alongside the whole-pass rather
     * than after it.
     *
     * One pass over a fifty-file diff is a sample, not a review: the
     * findings differed between runs and between machines, which is the
     * same symptom twice. The whole-change pass answers the questions that
     * only make sense whole; the slices answer the ones that need somebody
     * actually looking at the lines. Neither reads the other's output —
     * mergeReviews() below takes the whole pass as a spine and the slices
     * as additions — so there is nothing that requires them to run one
     * after another; only REVIEW_CONCURRENCY's bound on the account's own
     * request limit does.
     */
    const chunks = deep ? chunkChange(repoChanges) : [];
    const extra: string[] = new Array(chunks.length);
    let whole = '';

    const wholeJob = async () => {
      whole = await withRetry(
        () =>
          this.llm.generate({
            system,
            prompt,
            ...mounts,
            signal,
            onProgress: (message) => progressBus.log(event.id, `[tek geçiş] ${message}`),
          }),
        (err) => progressBus.log(event.id, `tek geçiş hata verdi, tekrar deneniyor: ${err.message}`),
      );
    };

    const sliceJob = (index: number, chunk: ReviewChunk) => async () => {
      signal?.throwIfAborted();
      progressBus.log(event.id, `derin tarama ${index + 1}/${chunks.length}: ${chunk.label}`);
      const slicePrompt = buildPrompt({
        ...promptInput,
        repoChanges: chunk.repoChanges,
        slice: { label: chunk.label, of: chunks.length },
      });
      this.promptStore?.save(issueKey, `review-slice-${index + 1}`, { system, prompt: slicePrompt });
      // A slice is supplementary coverage, not the review itself —
      // mergeReviews() already treats `extra` as best-effort additions to
      // the whole-pass spine. So a slice that still fails after a retry is
      // skipped rather than thrown: losing that slice's extra findings is
      // a fair trade against discarding the whole review over one flaky
      // call.
      try {
        extra[index] = await withRetry(
          () =>
            this.llm.generate({
              system,
              prompt: slicePrompt,
              ...mounts,
              signal,
              onProgress: (message) =>
                progressBus.log(event.id, `[dilim ${index + 1}/${chunks.length}] ${message}`),
            }),
          (err) =>
            progressBus.log(
              event.id,
              `derin tarama ${index + 1}/${chunks.length} hata verdi, tekrar deneniyor: ${err.message}`,
            ),
        );
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        const message = err instanceof Error ? err.message : String(err);
        progressBus.log(event.id, `derin tarama ${index + 1}/${chunks.length} atlandı: ${message}`);
      }
    };

    await runWithConcurrency(REVIEW_CONCURRENCY, [
      wholeJob,
      ...chunks.map((chunk, index) => sliceJob(index, chunk)),
    ]);

    const markdown = chunks.length ? mergeReviews(whole, extra.filter((e): e is string => e !== undefined)) : whole;
    if (chunks.length) {
      const before = splitFindings(whole).findings.length;
      const after = splitFindings(markdown).findings.length;
      progressBus.log(event.id, `derin tarama: ${before} bulgu → ${after} (${chunks.length} parça)`);
    }

    return {
      title: `Code review: ${issueKey} — ${summary}`,
      markdown,
      meta: {
        projectPaths,
        repoChanges,
        // Kept with the review so a later fix works from the same reading of
        // the ask that produced the findings — see core/requirement.ts.
        requirement: toRequirement(
          jiraIssue?.fields.description,
          context.jiraComments as CodeReviewPromptInput['comments'],
        ) satisfies Requirement,
      },
    };
  }
}
