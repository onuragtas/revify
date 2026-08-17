import { describe, expect, it } from 'vitest';
import { buildPrompt, buildSystemPrompt } from './codeReviewTask.js';

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
    expect(prompt).toContain('the condition that triggers it');
  });

  it('asks for QA test notes aimed at a tester, not unit tests', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('QA için');
    expect(prompt).toContain('2–5 items');
    expect(prompt).toContain('Do not suggest unit tests here');
    // The risky paths are the point — a happy-path-only list is useless.
    expect(prompt).toContain('Lead with the risky paths');
  });

  it('constrains output length and bans preamble/filler', () => {
    const prompt = buildPrompt(baseInput);

    expect(prompt).toContain('No preamble');
    expect(prompt).toContain('Three findings at most');
    expect(prompt).toContain('No repetition');
    expect(prompt).toContain('under a minute');
  });

  it('injects project notes and demands they be disclosed', () => {
    const prompt = buildPrompt({
      ...baseInput,
      notes: ['Do not flag missing tests here', '  ', 'Legacy naming is intentional'],
    });

    expect(prompt).toContain('## Project notes');
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
    // The whole risk: an epic describes a programme many tickets share. If it
    // read as a spec, every small task would be "missing" most of it.
    expect(prompt).toContain('They are not requirements');
    expect(prompt).toContain('Only\nthe description, comments and acceptance criteria of BUY-2455 itself bind.');
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
