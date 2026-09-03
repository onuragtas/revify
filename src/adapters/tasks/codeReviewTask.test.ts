import { describe, expect, it } from 'vitest';
import { CodeReviewTask, buildPrompt, buildSystemPrompt, previousReview } from './codeReviewTask.js';
import { progressBus } from '../../core/progressBus.js';
import type { LlmProvider, TriggerEvent } from '../../core/types.js';

describe('buildSystemPrompt', () => {
  it('adds a language instruction for a non-English language', () => {
    const prompt = buildSystemPrompt('Turkish');
    expect(prompt).toContain('Write the entire review in Turkish');
    expect(prompt).toContain('do not translate them');
  });

  it('leaves the prompt unchanged for English', () => {
    expect(buildSystemPrompt('English')).toBe(buildSystemPrompt(''));
    expect(buildSystemPrompt('English')).not.toContain('Write the entire review in');
  });

  it('trims surrounding whitespace in the language name', () => {
    expect(buildSystemPrompt('  German  ')).toContain('Write the entire review in German');
  });
});

describe('buildPrompt', () => {
  const baseInput = {
    issueKey: 'PROJ-123',
    summary: 'Fix login bug',
    description: 'Users cannot log in with SSO.',
    repoChanges: [
      {
        projectPath: 'team/app',
        branchName: 'feature/PROJ-123-sso-fix',
        baseBranch: 'main',
        diff: '--- src/auth.ts ---\n+ fixed line',
        files: [{ path: 'src/auth.ts', diff: '+ fixed line' }],
        repoPath: null,
      },
    ],
  };

  /*
   * Everything that does not change between a deep scan's passes is emitted
   * before the one thing that does.
   *
   * The passes are separate CLI invocations, so the only way the ~30k
   * characters of instructions, issue text, comments and notes they share
   * are not paid for five times over is if they form a byte-identical
   * prefix — and a prefix ends at the first difference. With the diff in the
   * middle, as it was, everything after it was billed fresh on every pass.
   */
  it('puts the diff last, so everything a slice shares with the whole pass is a stable prefix', () => {
    /*
     * Measured on a review that carries everything, because the first
     * version of this test used the bare fixture and passed while
     * production ran at a 1% prefix.
     *
     * What a bare fixture cannot show: the sections a slice does *not*
     * get. With `Related issues` on line 4 of the template, the whole pass
     * had it and the slices did not, so the prefix they shared ended 884
     * characters in and the 30k of instructions behind it was billed fresh
     * on every pass. A fixture with no related issues and no previous
     * review drops nothing, so nothing diverges, so the test sees a
     * perfect prefix that production never had.
     */
    const loaded = {
      ...baseInput,
      hasRepoAccess: true,
      notes: ['Bu repoda `var` kullanımı bilinçlidir.'],
      clarifications: [{ question: 'Hangi uç nokta?', answer: '`/v2/login`.' }],
      relatedIssues: [{ key: 'PROJ-100', summary: 'Epic', description: 'Programme', relation: 'parent' }],
      previous: { findings: [{ severity: 'major', heading: 'major — a.ts:1', body: 'eski bulgu' }] },
      challenges: [{ finding: 'major — a.ts:1', objection: 'bu doğru değil' }],
    } as unknown as Parameters<typeof buildPrompt>[0];

    const whole = buildPrompt(loaded);
    const slice = buildPrompt({
      ...loaded,
      repoChanges: [{ ...baseInput.repoChanges[0], diff: '--- src/other.ts ---\n+ sliced' }],
      slice: { label: 'team/app · 1', of: 2 },
    });

    // Nothing but the trailing instructions follows the diff.
    expect(whole.indexOf('## Code change')).toBeGreaterThan(whole.indexOf('## How to report each finding'));
    expect(whole.indexOf('## Code change')).toBeGreaterThan(whole.indexOf('## Before it goes to production'));

    // The assertion that matters: how much the two passes actually share.
    // Every whole-pass-only section has to sit behind this point.
    let shared = 0;
    while (shared < whole.length && whole[shared] === slice[shared]) shared++;
    expect(shared).toBeGreaterThan(whole.indexOf('## How to report each finding'));
    expect(shared).toBeGreaterThan(0.6 * whole.length);
  });

  it('leaves whole-change sections out of a slice, but never the ones that stop a finding', () => {
    const input = {
      ...baseInput,
      notes: ['Bu repoda `var` kullanımı bilinçlidir.'],
      clarifications: [{ question: 'Hangi uç nokta?', answer: '`/v2/login`.' }],
      relatedIssues: [{ key: 'PROJ-100', summary: 'Epic', description: 'Programme of work', relation: 'parent' }],
      previous: { findings: [{ severity: 'major', heading: 'major — a.ts:1', body: 'eski bulgu' }] },
      challenges: [{ finding: 'major — a.ts:1', objection: 'bu doğru değil' }],
    } as unknown as Parameters<typeof buildPrompt>[0];

    const slice = buildPrompt({ ...input, slice: { label: 'team/app · 1', of: 2 } });
    const whole = buildPrompt(input);

    // Dropped: a slice cannot settle any of these, and the merge discards
    // whatever it says about them.
    expect(whole).toContain('## Related issues');
    expect(slice).not.toContain('## Related issues');
    expect(whole).toContain('## Your previous review');
    expect(slice).not.toContain('## Your previous review');
    expect(whole).toContain('## Disputed findings');
    expect(slice).not.toContain('## Disputed findings');

    // Kept: both exist to stop a finding being written, and a finding a
    // slice should never have written cannot be un-written by the merge.
    expect(slice).toContain('## Project notes');
    expect(slice).toContain('## Answers from the team');
  });

  /*
   * The pass should never have to find its own checkout.
   *
   * A two-repo change checks both out, but only the first is the working
   * directory; the second used to be mounted and never named. The model
   * went looking — globbing the home directory, listing the repo cache,
   * reading `.git/config` files to work out where it was — once per pass,
   * for a path this prompt was already holding.
   */
  it('names the on-disk path of every repository under review', () => {
    const prompt = buildPrompt({
      ...baseInput,
      hasRepoAccess: true,
      repoChanges: [
        { ...baseInput.repoChanges[0], repoPath: '/cache/team__app' },
        {
          ...baseInput.repoChanges[0],
          projectPath: 'team/other',
          repoPath: '/cache/team__other',
        },
      ],
    });

    expect(prompt).toContain('Checked out at `/cache/team__app`');
    expect(prompt).toContain('Checked out at `/cache/team__other`');
    // "the repository is in your working directory" is true of one repo and
    // a wrong turn for the second, so a multi-repo change is not told that.
    expect(prompt).not.toContain('The full repository is checked out at this branch in your working directory');
    expect(prompt).toContain('each one named');
  });

  it('still calls it the working directory when only one repo is checked out', () => {
    const prompt = buildPrompt({
      ...baseInput,
      hasRepoAccess: true,
      repoChanges: [{ ...baseInput.repoChanges[0], repoPath: '/cache/team__app' }],
    });

    expect(prompt).toContain('in your working directory');
    expect(prompt).toContain('Checked out at `/cache/team__app`');
  });

  it('says nothing about paths when there is no checkout to name', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).not.toContain('Checked out at');
  });

  it('interpolates issue and branch-diff fields into the template', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('PROJ-123');
    expect(prompt).toContain('Fix login bug');
    expect(prompt).toContain('Users cannot log in with SSO.');
    expect(prompt).toContain('feature/PROJ-123-sso-fix');
    expect(prompt).toContain('main');
    expect(prompt).toContain('src/auth.ts');
  });

  it('extracts plain text from an Atlassian Document Format description', () => {
    const prompt = buildPrompt({
      ...baseInput,
      description: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Nested ADF text.' }] },
        ],
      },
    });

    expect(prompt).toContain('Nested ADF text.');
  });

  it('falls back to placeholder text for missing description/diff', () => {
    const prompt = buildPrompt({
      ...baseInput,
      description: undefined,
      repoChanges: [
        { projectPath: 'team/app', branchName: 'feature/x', baseBranch: 'main', diff: '', files: [], repoPath: null },
      ],
    });

    expect(prompt).toContain('(no description)');
    expect(prompt).toContain('(empty diff)');
  });

  it('appends a trailing language instruction for a non-English language', () => {
    const prompt = buildPrompt({ ...baseInput, language: 'Turkish' });

    expect(prompt).toContain('Write your entire response in Turkish');
    // Must be at the very end — the model follows trailing user-turn
    // instructions most reliably.
    expect(prompt.trimEnd().endsWith('exactly as they appear above.')).toBe(true);
  });

  it('leaves no placeholder or instruction behind for English', () => {
    const english = buildPrompt({ ...baseInput, language: 'English' });
    const omitted = buildPrompt(baseInput);

    expect(english).toBe(omitted);
    expect(english).not.toContain('{{languageInstruction}}');
    expect(english).not.toContain('Write your entire response in');
  });

  it('tells the model to verify against the checkout when repo access is available', () => {
    const prompt = buildPrompt({ ...baseInput, hasRepoAccess: true });

    expect(prompt).toContain('read-only tools (Read, Glob, Grep)');
    expect(prompt).toContain('Verify your findings against the real code');
  });

  it('omits the repo instruction (and its placeholder) without repo access', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).not.toContain('{{repoInstruction}}');
    expect(prompt).not.toContain('read-only tools');
  });

  it('asks whether the change actually solves the issue, before code quality', () => {
    const prompt = buildPrompt(baseInput);

    for (const dimension of ['Requirement coverage', 'Right fix, right place', 'Business/flow logic', 'Scope']) {
      expect(prompt).toContain(dimension);
    }
    // Intent must be judged first — it's the question a reviewer is really
    // answering, and it's easy for a model to skip straight to code nits.
    expect(prompt.indexOf('does this change actually do the job')).toBeLessThan(
      prompt.indexOf('how is it built'),
    );
    // An unimplemented requirement has to be able to block, not just be noted.
    expect(prompt).toContain('leaves the issue unsolved');
  });

  it('carries the review standard: dimensions, severity scheme, and verdict format', () => {
    const prompt = buildPrompt(baseInput);

    // Dimensions the reviewer must work through.
    for (const dimension of [
      'Correctness',
      'Edge cases',
      'Error handling',
      'Security',
      'Data & backward compatibility',
      'Performance',
      'Observability',
      'Tests',
    ]) {
      expect(prompt).toContain(dimension);
    }

    // Exactly three severities, and an instruction not to invent others.
    expect(prompt).toContain('**blocking**');
    expect(prompt).toContain('**major**');
    expect(prompt).toContain('**minor**');
    expect(prompt).toContain('do not\ninvent your own');

    // Verdict lines the approval UI shows the reviewer.
    expect(prompt).toContain('Verdict: Approve');
    expect(prompt).toContain('Verdict: Request changes');
  });

  it('rules style nitpicking out of scope', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('Explicitly out of scope');
    expect(prompt).toContain('Do not report them.');
  });

  it('requires diff evidence and an impact line per finding', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('### <severity> — <file:line>');
    expect(prompt).toContain('**Etki:**');
    // A finding without a fix hands the reader the homework.
    expect(prompt).toContain('**Ne yapmalı:**');
    expect(prompt).toContain('the condition that triggers it');
  });

  it('asks for QA notes a tester can actually run', () => {
    /*
     * "2–5 items, each one line" was the same disease as the three-finding
     * cap: a limit written against padding that cut the substance instead.
     * A payment flow needs a dozen scenarios, and trimming to five to look
     * tidy is how a defect ships.
     */
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('QA için');
    expect(prompt).toContain('Önkoşullar');
    // Where a change actually bites, and where a thin note is worst.
    expect(prompt).toContain('negative cases');
    // Unverifiable expectations are not test steps.
    expect(prompt).toContain('Nasıl anlaşılır');
    expect(prompt).toContain('as many scenarios as the change deserves');
    // Still a tester's list, not a developer's: unit tests belong in a
    // finding, where somebody can act on them.
    expect(prompt).toContain('Do not suggest unit tests here');

    expect(prompt).not.toContain('2–5 items');
  });

  it('asks what has to happen around the code before it ships', () => {
    /*
     * The half nobody was writing: migrations, config keys, deploy order,
     * whether old and new can run side by side, whether a revert is clean.
     * None of it is in the diff, and none of it is knowable from reading
     * the code alone — which is exactly why it is discovered at the worst
     * possible moment.
     */
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('Prod öncesi');
    expect(prompt).toContain('Migrations and data');
    expect(prompt).toContain('Configuration');
    expect(prompt).toContain('Deploy order');
    expect(prompt).toContain('Backward compatibility during rollout');
    expect(prompt).toContain('Rollback');
    // A checklist invented to look thorough is worse than "nothing to do".
    expect(prompt).toContain('an invented checklist is not');
  });

  it('scopes a finding to the change, not to everything it read', () => {
    /*
     * The review is handed the whole checkout and the neighbouring services
     * and told to read all of it — so it can *judge the change*: what calls
     * this, what that really returns, whether a claim holds. Nothing said
     * that a finding had to be *about* the change, so defects it met along
     * the way came back as findings on a ticket that never touched them.
     */
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('What is under review');
    // "at the end of this prompt", not "above": the diff is emitted last so
    // everything before it is a byte-identical prefix across a deep scan's
    // passes, and can be served from cache instead of paid for each time.
    expect(prompt).toContain('The diff at the end of this prompt, and nothing else');
    expect(prompt).toContain('It was wrong before this branch and will be wrong');
    // The mounted services are for checking claims, never subjects.
    expect(prompt).toContain('never as subjects of this review');
    // A branch can carry a merge or another ticket's commits.
    expect(prompt).toContain('belong to other work');
    // The narrow exception, kept: the change depends on it.
    expect(prompt).toContain('Mevcut kod:');
    // The test a reviewer can apply themselves.
    expect(prompt).toContain('if this branch had never been written?');
  });

  it('names the commits a branch carries, and which were left out of the diff', () => {
    /*
     * A branch open for months carries work that was never the ticket's,
     * and the review used to report it against the developer who did not
     * write it. Those files are now taken out of the diff upstream; the
     * list is what makes the removal visible rather than mysterious.
     *
     * Note which commit is marked. `9ec6c195` names no ticket at all and is
     * *kept* — developers write "fix null check" on their own work all day,
     * and now that this decides what gets deleted from the diff, guessing
     * would silently gut the review. Only a commit that names a sibling
     * ticket is provably somebody else's.
     */
    const prompt = buildPrompt({
      ...baseInput,
      issueKey: 'BUY-1831',
      repoChanges: [
        {
          ...baseInput.repoChanges[0],
          commits: [
            {
              sha: '9ec6c195',
              title: 'Add shopping loan cancellation functionality',
              author: 'onuragtas',
              date: '2025-12-12T17:41:00+03:00',
            },
            { sha: 'b22e7f01', title: 'BUY-1799: payment retry', author: 'onuragtas', date: '2025-12-13T10:00:00+03:00' },
            { sha: 'a11d8c8d', title: 'BUY-1831', author: 'esmanur', date: '2026-01-11T23:41:04+03:00' },
          ],
        },
      ],
    });

    expect(prompt).toContain('`9ec6c195` 2025-12-12 · onuragtas · Add shopping loan cancellation');
    // Named a sibling ticket: excluded, and said so.
    expect(prompt).toContain("BUY-1799: payment retry  ← **başka task — diff dışı bırakıldı**");
    // Names no ticket, and this one names ours: both left alone.
    expect(prompt).not.toContain("Add shopping loan cancellation functionality  ← **başka task");
    expect(prompt).not.toContain("BUY-1831  ← **başka task");
    // And the instruction is now the opposite of what it used to be.
    expect(prompt).toContain('Do not report findings about them');
  });

  it('says nothing about strays when every commit is the ticket\'s', () => {
    const prompt = buildPrompt({
      ...baseInput,
      issueKey: 'PROJ-123',
      repoChanges: [
        {
          ...baseInput.repoChanges[0],
          commits: [
            { sha: 'aaa1111', title: 'PROJ-123 ilk', author: 'x', date: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    });

    expect(prompt).toContain('`aaa1111` 2026-01-01');
    expect(prompt).not.toContain("bu task'a ait değil");
    expect(prompt).not.toContain('Attribute it');
  });

  it('omits the commit list when nothing supplied one', () => {
    // The local path can have no base branch, and an older record has no
    // commits stored at all; neither is a reason to print an empty heading.
    expect(buildPrompt(baseInput)).not.toContain('taşıdığı commitler');
  });

  it('makes a finding show why it is in scope', () => {
    /*
     * A correct finding that reads as somebody else's problem.
     *
     * "These endpoints were deleted and EPA_API still calls them" cites the
     * *caller* — code the branch never touched — so the reader's first
     * reaction is "I did not write that", and they are right about the line
     * they were shown. What puts it in scope is the deletion in their own
     * diff, and that is what has to come first.
     */
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('When the defect is not on a line this change wrote');
    expect(prompt).toContain('reads as a complaint about somebody else');
  });

  it('bans preamble and padding without capping real findings', () => {
    /*
     * This asked for "Three findings at most" — and got it.
     *
     * The rule was written against padding, but it was phrased as a cap on
     * *count*, so it threw away blocking and major defects along with the
     * fourth nit. A reviewer then had to run the review again to see the
     * rest, which is the one thing a review must not require: it is read
     * once and acted on, and a defect left out is a defect that ships.
     *
     * The cap now applies where padding actually lives — minor findings.
     */
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('No preamble');
    expect(prompt).toContain('No repetition');
    expect(prompt).toContain('Report every blocking and every major finding');
    expect(prompt).toContain('no cap');
    expect(prompt).toContain('Minor findings: three at most');

    // The old rule, and the length target that pulled the same way.
    expect(prompt).not.toContain('Three findings at most');
    expect(prompt).not.toContain('under a minute');
  });

  it('does not trade completeness for brevity in the system prompt either', () => {
    // "Two real problems in ten lines beats eight observations in a hundred"
    // reads as a preference for fewer findings. The distinction that was
    // meant is defects versus padding, so it says that instead.
    const system = buildSystemPrompt('English');

    expect(system).toContain('Report every real defect you find');
    expect(system).toContain('a defect left out is one that ships');
    expect(system).toContain('no filler');
    expect(system).not.toContain('beats one that');
  });

  it('injects project notes and demands they be disclosed', () => {
    const prompt = buildPrompt({
      ...baseInput,
      notes: ['Do not flag missing tests here', '  ', 'Legacy naming is intentional'],
    });

    expect(prompt).toContain('## Project notes');
    // The rule is stated twice on purpose: once with the notes, and again
    // where findings are decided. Stated only in the context block, eighty
    // lines earlier, it lost to the instructions that came after it — the
    // note would be acknowledged in the disclosure and the finding
    // reported anyway.
    const notesRuleAt = prompt.indexOf('outrank everything else');
    const reminderAt = prompt.indexOf('Before writing any finding');
    const reportingAt = prompt.indexOf('How to report each finding');
    expect(notesRuleAt).toBeGreaterThan(-1);
    expect(reminderAt).toBeGreaterThan(notesRuleAt);
    expect(reminderAt).toBeLessThan(reportingAt);
    expect(prompt).toContain('- Do not flag missing tests here');
    expect(prompt).toContain('- Legacy naming is intentional');
    // Blank notes are dropped rather than rendered as empty bullets.
    expect(prompt).not.toContain('\n- \n');
    // Applying a note silently would look identical to missing the issue,
    // so disclosure is required — on a parseable marker, since the UI
    // lifts it out of the review body.
    expect(prompt).toContain('[note] <which note, and what you did not report because of it>');
  });

  it('asks for open questions in a language-independent [?] form', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('[?] <a direct question whose answer would settle it>');
    expect(prompt).toContain('the marker is parsed by the UI');
  });

  it('feeds answered questions back as established fact', () => {
    const prompt = buildPrompt({
      ...baseInput,
      clarifications: [
        { question: 'Hangi endpoint çağrılıyor?', answer: '/order/installment' },
        { question: 'boş cevap', answer: '  ' },
      ],
    });

    expect(prompt).toContain('## Answers from the team');
    expect(prompt).toContain('Hangi endpoint çağrılıyor?');
    expect(prompt).toContain('/order/installment');
    // Unanswered entries must not reach the model as blank facts.
    expect(prompt).not.toContain('boş cevap');
    // Otherwise the same question comes back every run and never closes.
    expect(prompt).toContain('Do not re-raise the same');
  });

  it('omits the answers section when there are no clarifications', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).not.toContain('{{clarificationsSection}}');
    expect(prompt).not.toContain('Answers from the team');
  });

  it('names related services and their paths so cross-service claims can be checked', () => {
    const prompt = buildPrompt({
      ...baseInput,
      contextRepos: [
        { projectPath: 'team/shipping-delivery', path: '/cache/team__shipping-delivery', branch: 'main' },
      ],
    });

    expect(prompt).toContain('## Other services available');
    expect(prompt).toContain('team/shipping-delivery');
    // The path is the point — knowing the service exists isn't enough.
    expect(prompt).toContain('/cache/team__shipping-delivery');
    // Otherwise it asks a [?] question it could have answered itself.
    expect(prompt).toContain('Raising a `[?]` about something that is answerable here is a failure');
  });

  it('requires a search pass across mounted repos before raising a question', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('Search before you ask');
    expect(prompt).toContain('A `[?]` is a last resort');
    // The question is only legitimate when the answer isn't in any code.
    expect(prompt).toContain('Only ask when that search genuinely comes up empty');
    expect(prompt).toContain('If the answer\n*is* in the code, state it as fact');
  });

  it('omits the related-services section when nothing is linked', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).not.toContain('{{contextReposSection}}');
    expect(prompt).not.toContain('Other services available');
  });

  it('omits the notes section entirely when there are no notes', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).not.toContain('{{notesSection}}');
    expect(prompt).not.toContain('{{notesReminder}}');

    expect(prompt).not.toContain('{{notesDisclosure}}');
    expect(prompt).not.toContain('## Project notes');
    expect(prompt).not.toContain('Applied notes');
  });
});

describe('buildPrompt — disputed findings', () => {
  const base = { issueKey: 'BUY-1', summary: 'S', description: 'D', repoChanges: [] };

  it('tells the reviewer to re-check a disputed finding rather than accept the objection', () => {
    const prompt = buildPrompt({
      ...base,
      challenges: [{ finding: 'blocking — a.ts:10', objection: 'Bu alan zaten null olamaz.' }],
    });

    expect(prompt).toContain('blocking — a.ts:10');
    expect(prompt).toContain('Bu alan zaten null olamaz.');
    // The whole point: an objection is a prompt to verify, not a correction
    // to apply. A reviewer that folds on assertion is worse than none.
    expect(prompt).toContain('Do not simply accept the');
    expect(prompt).toContain('[withdrawn]');
  });

  it('still asks for verification when the objection has no stated reason', () => {
    const prompt = buildPrompt({ ...base, challenges: [{ finding: 'major — b.ts:3', objection: '' }] });
    expect(prompt).toContain('major — b.ts:3');
    expect(prompt).toContain('yine de doğrula');
  });

  it('says nothing about disputes when there are none', () => {
    expect(buildPrompt(base)).not.toContain('Disputed findings');
  });
});

describe('buildPrompt — issue discussion', () => {
  const base = { issueKey: 'BUY-1', summary: 'S', description: 'D', repoChanges: [] };

  it('carries the comments and frames them as spec, not chatter', () => {
    const prompt = buildPrompt({
      ...base,
      comments: [
        { author: 'Gökçe Koç', created: '2026-08-14T12:52:00.000+0000', text: 'Kabul kriteri: logo boşsa placeholder gösterilmeli.' },
        { author: 'Burak Kaya', created: '2026-08-15T09:00:00.000+0000', text: 'Null kontrolü eklenmeli.' },
      ],
    });

    expect(prompt).toContain('Yorum 1 — 2026-08-14');
    expect(prompt).toContain('Kabul kriteri: logo boşsa placeholder gösterilmeli.');
    // Names are withheld, not merely forbidden: a review that argues with a
    // named colleague lands on a public issue.
    expect(prompt).not.toContain('Gökçe Koç');
    expect(prompt).not.toContain('Burak Kaya');
    expect(prompt).toContain('**Name no one.**');
    // An unmet acceptance criterion has to block, or reading them is pointless.
    expect(prompt).toContain('that is a blocking finding');
    // And a past review is a claim to re-check, not a finding to echo.
    expect(prompt).toContain('A previous review is a claim, not a fact.');
  });

  it('truncates a pasted-log comment instead of flooding the prompt', () => {
    const prompt = buildPrompt({
      ...base,
      comments: [{ author: 'CI', created: '', text: 'x'.repeat(4000) }],
    });

    expect(prompt).toContain('[…kısaltıldı]');
    // The cap is on the comment, not the prompt — the template alone is
    // several KB, so asserting on total length would measure the wrong thing.
    expect(prompt).toContain('x'.repeat(1500));
    expect(prompt).not.toContain('x'.repeat(1600));
  });

  it('drops empty comments and says nothing when there are none', () => {
    expect(buildPrompt({ ...base, comments: [{ author: 'A', created: '', text: '   ' }] }))
      .not.toContain('Issue discussion');
    expect(buildPrompt(base)).not.toContain('Issue discussion');
  });
});

describe('buildPrompt — revision requests', () => {
  const base = { issueKey: 'BUY-1', summary: 'S', description: 'D', repoChanges: [] };

  it('quotes the instruction and demands verification of factual claims', () => {
    const prompt = buildPrompt({ ...base, revisionRequest: '2. bulgu geçersiz.\nQA notlarını genişlet.' });

    expect(prompt).toContain('> 2. bulgu geçersiz.');
    expect(prompt).toContain('> QA notlarını genişlet.');
    expect(prompt).toContain('go read the code and confirm it before you act on it');
    // The review must read as a review, not as a reply to the reviewer.
    expect(prompt).toContain('not as a reply to feedback');
  });

  it('says nothing when no revision was asked for', () => {
    expect(buildPrompt({ ...base, revisionRequest: '   ' })).not.toContain('Revision requested');
  });
});

describe('buildPrompt — related issues', () => {
  const base = { issueKey: 'BUY-2455', summary: 'Barcode Listing', description: 'D', repoChanges: [] };

  it('offers the parent as background and forbids treating it as requirements', () => {
    const prompt = buildPrompt({
      ...base,
      relatedIssues: [
        {
          key: 'BUY-2424',
          relation: 'parent',
          issueType: 'Epic',
          status: 'Backlog',
          summary: 'Shipping & Delivery Rollout',
          description: 'Shipping & Delivery servislerinin partial rolloutu',
        },
      ],
    });

    expect(prompt).toContain('BUY-2424 — Shipping & Delivery Rollout');
    expect(prompt).toContain('(parent, Epic, Backlog)');
    /*
     * Two risks, and they run in opposite directions.
     *
     * An epic describes a programme many tickets share: read as a spec,
     * every small task would be "missing" most of it. And a sibling's work
     * can sit in the same repository: read as code under review, its
     * defects come back as findings on a ticket that never touched it.
     * Background means neither binding nor subject.
     */
    expect(prompt).toContain('Background is all they are');
    expect(prompt).toContain('missing from this\n  change');
    expect(prompt).toContain('Never report a finding about code that belongs to one of them');
    expect(prompt).toContain(
      'Only the description, comments and acceptance criteria of BUY-2455 itself\nbind',
    );
  });

  it('names a neighbour\'s in-flight branch, so an absence is a question and not a finding', () => {
    /*
     * The false blocking finding this exists to stop: a sibling ticket is
     * adding the endpoint right now, on a branch that is not merged, so the
     * reviewer reads the default branch, does not find it, and reports the
     * work as unimplemented.
     *
     * Named, never checked out. An unmerged branch cannot settle anything —
     * it may change and it may never land — but knowing it exists turns a
     * wrong finding into a question a human answers once.
     */
    const prompt = buildPrompt({
      ...base,
      relatedIssues: [
        {
          key: 'BUY-2401',
          relation: 'linked',
          issueType: 'Task',
          status: 'In Progress',
          summary: 'Ödeme ucu',
          description: 'Yeni uç eklenecek',
          branches: [
            { name: 'feature/BUY-2401', repositoryUrl: 'https://gitlab.example.com/team/payment-gateway' },
          ],
        },
      ],
    });

    expect(prompt).toContain('Üzerinde çalışılan dal(lar):');
    expect(prompt).toContain('`feature/BUY-2401` (team/payment-gateway)');
    expect(prompt).toContain('do not report it as unimplemented');
    expect(prompt).toContain('raise one `[?]`');
  });

  it('says nothing about branches for a neighbour that has none', () => {
    // Most neighbours are just background; the rule only appears when there
    // is actually work in flight to hedge against.
    const prompt = buildPrompt({
      ...base,
      relatedIssues: [
        {
          key: 'BUY-2424',
          relation: 'parent',
          issueType: 'Epic',
          status: 'Backlog',
          summary: 'Rollout',
          description: 'x',
        },
      ],
    });

    expect(prompt).not.toContain('Üzerinde çalışılan dal');
    expect(prompt).not.toContain('work in flight');
  });

  it('caps a long epic so background cannot outweigh the issue under review', () => {
    const prompt = buildPrompt({
      ...base,
      relatedIssues: [
        { key: 'HGS-1016', relation: 'parent', issueType: 'Epic', status: 'To Do', summary: 'S', description: 'y'.repeat(2000) },
      ],
    });

    expect(prompt).toContain('y'.repeat(700));
    expect(prompt).not.toContain('y'.repeat(800));
    expect(prompt).toContain('[…kısaltıldı]');
  });

  it('says nothing when the issue stands alone', () => {
    expect(buildPrompt(base)).not.toContain('Related issues');
    expect(buildPrompt({ ...base, relatedIssues: [] })).not.toContain('Related issues');
  });
});

describe('buildSystemPrompt — no names', () => {
  it('forbids naming a person in every language setting', () => {
    for (const language of ['English', 'Turkish']) {
      expect(buildSystemPrompt(language)).toContain('Never name a person in the review');
    }
  });
});

describe('CodeReviewTask — what travels with the review', () => {
  const llm: LlmProvider = { canEditFiles: false, generate: async () => 'Verdict: Approve' };
  const event: TriggerEvent = { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 'İade' } };

  it('records the ask it read, so a later fix works from the same text', async () => {
    // Without this the fix path would have to re-read Jira, and a finding
    // built on one reading of the ask would be fixed against another.
    const result = await new CodeReviewTask(llm).run(event, {
      jiraIssue: {
        fields: {
          description: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'İade kaydı açılmalı.' }] }],
          },
        },
      },
      jiraComments: [
        { author: 'Gökçe Koç', created: '2026-08-14T12:00:00.000+0000', text: 'Kabul kriteri: brüt tutar.' },
      ],
      repoChanges: [
        {
          projectPath: 'team/orders',
          branchName: 'b',
          baseBranch: 'main',
          diff: 'd',
          files: [],
          repoPath: '/tmp/x',
        },
      ],
    } as unknown as Record<string, unknown>);

    expect(result.meta?.requirement).toEqual({
      description: 'İade kaydı açılmalı.',
      comments: [{ created: '2026-08-14T12:00:00.000+0000', text: 'Kabul kriteri: brüt tutar.' }],
    });
    // The name never enters the record, so nothing downstream can leak it.
    expect(JSON.stringify(result.meta?.requirement)).not.toContain('Gökçe');
  });

  it('keeps the prompt it sent, before the call rather than after', async () => {
    // A run that fails or is stopped is exactly the one somebody wants to
    // read the prompt of, so it is written before the model is asked.
    const saved: Array<{ issueKey: string; kind: string; system: string; prompt: string }> = [];
    const exploding: LlmProvider = {
      canEditFiles: false,
      generate: async () => {
        throw new Error('model patladı');
      },
    };
    const promptStore = {
      save: (issueKey: string, kind: string, input: { system: string; prompt: string }) =>
        saved.push({ issueKey, kind, ...input }),
    } as unknown as ConstructorParameters<typeof CodeReviewTask>[4];

    await expect(
      new CodeReviewTask(exploding, 'English', undefined, undefined, promptStore).run(event, {
        repoChanges: [
          { projectPath: 'p', branchName: 'b', baseBranch: 'm', diff: 'd', files: [], repoPath: '/tmp/x' },
        ],
      } as unknown as Record<string, unknown>),
    ).rejects.toThrow('model patladı');

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ issueKey: 'BUY-1', kind: 'review' });
    expect(saved[0].system).toContain('senior software engineer');
    expect(saved[0].prompt).toContain('BUY-1');
  });

  it('records an empty ask rather than nothing when the issue has none', async () => {
    const result = await new CodeReviewTask(llm).run(event, {
      repoChanges: [
        { projectPath: 'p', branchName: 'b', baseBranch: 'm', diff: 'd', files: [], repoPath: '/tmp/x' },
      ],
    } as unknown as Record<string, unknown>);

    expect(result.meta?.requirement).toEqual({ description: '', comments: [] });
  });
});


describe('CodeReviewTask — a review with no Jira issue behind it', () => {
  const captured: { prompt?: string } = {};
  const llm: LlmProvider = {
    canEditFiles: false,
    generate: async ({ prompt }) => {
      captured.prompt = prompt;
      return 'Verdict: Approve';
    },
  };

  /** Started from a directory: there is no issue key, and `event.id` is the
   * key the record is stored under. */
  const localEvent: TriggerEvent = {
    id: 'local:team/api@feature/x',
    data: { repoPath: '/home/me/projects/api', summary: 'team/api · feature/x' },
  };

  const change = {
    projectPath: 'team/api',
    branchName: 'feature/x',
    baseBranch: 'main',
    diff: 'd',
    files: [],
    repoPath: '/home/me/projects/api',
  };

  it('calls the run by its id rather than by the word "undefined"', async () => {
    /*
     * `event.data.issueKey` is undefined for a local review, and it was read
     * unconditionally. The word travelled into the prompt — the model was
     * told "the description of undefined binds" — and into the title.
     */
    const result = await new CodeReviewTask(llm).run(localEvent, {
      repoChanges: [change],
    } as unknown as Record<string, unknown>);

    expect(captured.prompt).not.toContain('undefined');
    expect(captured.prompt).toContain('local:team/api@feature/x');
    expect(result.title).not.toContain('undefined');
  });

  it('looks up the answers and disputes under the key the record uses', async () => {
    // Three reviewStore lookups keyed on `undefined` meant a dispute or a
    // "Review'i düzelt" instruction typed against a local review reached
    // the next run as nothing at all.
    const asked: string[] = [];
    const reviewStore = {
      get: (key: string) => {
        asked.push(key);
        return { revisionRequest: 'kısa tut' };
      },
    };

    await new CodeReviewTask(llm, 'English', undefined, reviewStore as never).run(localEvent, {
      repoChanges: [change],
    } as unknown as Record<string, unknown>);

    expect(asked).not.toContain(undefined);
    expect(new Set(asked)).toEqual(new Set(['local:team/api@feature/x']));
    expect(captured.prompt).toContain('kısa tut');
  });

  it('does not blame a Jira branch when it was handed a directory', async () => {
    /*
     * With `localRepoDiffContext` missing from the wiring nothing collected
     * the directory, and the run reported "No linked GitLab branch was found
     * for undefined via the Jira development panel" — about an issue that
     * never existed. The reader has to be told what actually happened.
     */
    const result = await new CodeReviewTask(llm).run(localEvent, {
      repoChanges: [],
    } as unknown as Record<string, unknown>);

    expect(result.markdown).not.toContain('Jira development panel');
    expect(result.markdown).toContain('/home/me/projects/api');
    expect(result.markdown).toContain('localRepoDiffContext');
  });

  it('still explains a Jira issue whose branch was never linked', async () => {
    const result = await new CodeReviewTask(llm).run(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 'İade' } },
      { repoChanges: [] } as unknown as Record<string, unknown>,
    );

    expect(result.markdown).toContain('Jira development panel');
    expect(result.markdown).toContain('BUY-1');
  });
});


describe('buildPrompt — a review that has to answer the last one', () => {
  const base = {
    issueKey: 'BUY-1',
    summary: 'İade akışı',
    description: 'x',
    repoChanges: [
      {
        projectPath: 'team/app',
        branchName: 'feature/BUY-1',
        baseBranch: 'main',
        diff: 'd',
        files: [],
        repoPath: null,
      },
    ],
  };

  const previous = {
    findings: [
      {
        severity: 'blocking',
        heading: 'blocking — src/Payment.php:829',
        body: '`refund()` transaction dışında çağrılıyor.',
      },
      { severity: 'major', heading: 'major — src/Bank.php:12', body: 'Null kontrolü yok.' },
    ],
  };

  it('carries the previous findings so the second pass settles them', () => {
    /*
     * Without this a re-review starts from nothing: it reads code somebody
     * has just fixed, has no idea which findings prompted the change, and
     * reports whatever it sees as if for the first time. To the person
     * waiting that is a review that never converges — fix, re-review, new
     * findings, again.
     */
    const prompt = buildPrompt({ ...base, previous });

    expect(prompt).toContain('previous review');
    expect(prompt).toContain('blocking — src/Payment.php:829');
    expect(prompt).toContain('transaction dışında');
    expect(prompt).toContain('[resolved]');
    // A survivor of a fix attempt matters more than a new finding, not less.
    expect(prompt).toContain('Still open');
  });

  it('passes on the fix run\'s account as a claim, not as a fact', () => {
    // A fix reports what it *intended*. A review that takes that at face
    // value launders a claim into a fact and closes a live defect on paper.
    const prompt = buildPrompt({
      ...base,
      previous: {
        ...previous,
        fixReport: [
          { outcome: 'fixed' as const, text: 'refund() transaction içine alındı' },
          { outcome: 'skipped' as const, text: 'Bank.php: hangi alanın null olabileceği belirsiz' },
        ],
      },
    });

    expect(prompt).toContain('refund() transaction içine alındı');
    expect(prompt).toContain('atlandı: Bank.php');
    expect(prompt).toContain('its own account, not a verified fact');
    expect(prompt).toContain('not the neighbourhood');
  });

  it('says nothing about a previous review when there was not one', () => {
    const prompt = buildPrompt(base);
    expect(prompt).not.toContain('previous review');
    expect(prompt).not.toContain('[resolved]');
  });
});

describe('previousReview', () => {
  const REVIEW = [
    'Giriş.',
    '',
    '### blocking — src/Payment.php:829',
    '',
    '`refund()` transaction dışında.',
    '',
    'Verdict: Request changes',
  ].join('\n');

  it('reads the last run out of history, where re-reviewing puts it', () => {
    // The live `review` is already gone by the time the new run asks:
    // starting one archives the old review first.
    const previous = previousReview({
      history: [
        {
          title: 't',
          markdown: REVIEW,
          outcome: 'awaiting_approval' as const,
          archivedAt: '',
          fixReport: [{ outcome: 'fixed' as const, text: 'yapıldı' }],
        },
      ],
    });

    expect(previous?.findings.map((f) => f.heading)).toEqual(['blocking — src/Payment.php:829']);
    expect(previous?.fixReport).toEqual([{ outcome: 'fixed', text: 'yapıldı' }]);
  });

  it('is absent when there is no history, or nothing was found last time', () => {
    expect(previousReview({})).toBeUndefined();
    expect(
      previousReview({
        history: [{ title: 't', markdown: 'Verdict: Approve', outcome: 'posted' as const, archivedAt: '' }],
      }),
    ).toBeUndefined();
  });
});


describe('CodeReviewTask — reading a large change in slices', () => {
  const change = (path: string, files: Array<{ path: string; diff: string }>) => ({
    projectPath: path,
    branchName: 'feature/BUY-1',
    baseBranch: 'master',
    diff: files.map((f) => `--- ${f.path} ---\n${f.diff}`).join('\n\n'),
    files,
    repoPath: null,
  });

  const big = [
    change('team/api', [
      { path: 'a.ts', diff: 'a'.repeat(28_000) },
      { path: 'b.ts', diff: 'b'.repeat(28_000) },
    ]),
  ];

  /** Answers the whole-change pass one way and every slice another, so the
   * merge is visible in the result. */
  function llmFor(whole: string, slices: string[]): { llm: LlmProvider; prompts: string[] } {
    const prompts: string[] = [];
    let n = 0;
    return {
      prompts,
      llm: {
        canEditFiles: false,
        generate: async ({ prompt }) => {
          prompts.push(prompt);
          return n++ === 0 ? whole : (slices[n - 2] ?? '');
        },
      },
    };
  }

  it('reads a big change whole and then slice by slice, and merges', async () => {
    /*
     * One pass over a fifty-file diff is a sample, not a review — the
     * findings differed between runs and between machines, which is the
     * same symptom twice. The whole pass answers what only makes sense
     * whole; the slices find what needs somebody looking at the lines.
     */
    const { llm, prompts } = llmFor(
      'Giriş.\n\n### blocking — a.ts:1\n\nBir.\n\nVerdict: Request changes — a',
      ['### major — b.ts:9\n\nİki.'],
    );

    const result = await new CodeReviewTask(llm).run(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 's', scanMode: 'deep' } },
      { repoChanges: big } as unknown as Record<string, unknown>,
    );

    // Three passes: the whole change, then one per slice.
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('Bu geçiş: team/api · 1');
    expect(prompts[1]).toContain('Yalnızca bulgu yaz');
    // Both findings survive, and the spine's own sections come through.
    expect(result.markdown).toContain('a.ts:1');
    expect(result.markdown).toContain('b.ts:9');
    expect(result.markdown).toContain('Verdict: Request changes');
  });

  it('says which way it went, including when it chose the cheap one', async () => {
    /*
     * `auto` cannot be decided when the button is pressed — nobody knows
     * how big the change is until the collectors have fetched it — so the
     * choice happens mid-run. Logging only the deep path would leave "it
     * read this in one pass" indistinguishable from "it never considered
     * anything else".
     */
    const lines: string[] = [];
    const listen = (e: { message: string }) => lines.push(e.message);
    progressBus.on('progress', listen);
    const { llm } = llmFor('Verdict: Approve', []);

    await new CodeReviewTask(llm).run(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 's' } },
      {
        repoChanges: [change('team/api', [{ path: 'a.ts', diff: 'x'.repeat(500) }])],
      } as unknown as Record<string, unknown>,
    );

    progressBus.off('progress', listen);
    expect(lines.some((l) => l.startsWith('tarama: tek geçiş') && l.includes('otomatik seçildi'))).toBe(true);
  });

  it('reads a small change in one pass, as before', async () => {
    // Splitting a three-file change costs time and buys nothing.
    const { llm, prompts } = llmFor('Sağlam.\n\nVerdict: Approve', []);

    await new CodeReviewTask(llm).run(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 's' } },
      {
        repoChanges: [change('team/api', [{ path: 'a.ts', diff: 'x'.repeat(500) }])],
      } as unknown as Record<string, unknown>,
    );

    expect(prompts).toHaveLength(1);
  });

  it('honours a request for one pass even on a change that would be split', async () => {
    // The choice is the reader's: sometimes an answer now beats a thorough
    // one later.
    const { llm, prompts } = llmFor('Verdict: Approve', []);

    await new CodeReviewTask(llm).run(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 's', scanMode: 'single' } },
      { repoChanges: big } as unknown as Record<string, unknown>,
    );

    expect(prompts).toHaveLength(1);
  });

  it('splits a large change without being asked, when nobody chose', async () => {
    // `auto` is the default, and a change one pass cannot cover is exactly
    // the case where the default should not be the fast one.
    const { llm, prompts } = llmFor('Verdict: Approve', ['', '']);

    await new CodeReviewTask(llm).run(
      { id: 'BUY-1', data: { issueKey: 'BUY-1', summary: 's' } },
      { repoChanges: big } as unknown as Record<string, unknown>,
    );

    expect(prompts.length).toBeGreaterThan(1);
  });
});
