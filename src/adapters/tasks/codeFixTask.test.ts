import { describe, expect, it } from 'vitest';
import { CodeFixTask, buildFixPrompt, parseFixReport } from './codeFixTask.js';
import { parseFindings } from '../../core/findings.js';
import type { LlmProvider } from '../../core/types.js';

const FINDINGS = parseFindings(
  [
    '### blocking — src/order.ts:12',
    '',
    '`refund()` transaction dışında.',
    '',
    '### minor — src/log.ts:4',
    '',
    'Mesaj yanıltıcı.',
  ].join('\n'),
);

function promptFor(findings = FINDINGS) {
  return buildFixPrompt({
    issueKey: 'BUY-1',
    summary: 'İade akışı',
    repos: [
      {
        projectPath: 'team/orders',
        branchName: 'feature/refund',
        path: '/tmp/ws/orders',
        diff: '-  refund(order);\n+  tx.run(() => refund(order));',
      },
    ],
    findings,
  });
}

describe('buildFixPrompt', () => {
  it('carries each selected finding whole, not just its heading', () => {
    const prompt = promptFor([FINDINGS[0]]);
    expect(prompt).toContain('blocking — src/order.ts:12');
    expect(prompt).toContain('transaction dışında');
  });

  it('sends only what was selected', () => {
    // The human picked the findings; sending the rest would put unasked-for
    // edits in someone's working copy.
    const prompt = promptFor([FINDINGS[0]]);
    expect(prompt).not.toContain('Mesaj yanıltıcı');
  });

  it('names the repository, its branch and where it is on disk', () => {
    // A fixer that knows a service exists but not where to read it falls
    // back to assuming what it returns.
    expect(promptFor()).toContain('team/orders');
    expect(promptFor()).toContain('feature/refund');
    expect(promptFor()).toContain('/tmp/ws/orders');
  });

  it('includes the change under review, so the fix sees what it corrects', () => {
    expect(promptFor()).toContain('tx.run(() => refund(order))');
  });
});

describe('buildFixPrompt — the human\'s decision', () => {
  it('puts the instruction under the finding it settles, as a decision', () => {
    // The reviewer is told to give options rather than invent an answer when
    // the right fix turns on something it cannot see. Somebody then has to
    // choose, and this is the only channel that reaches the patch.
    const prompt = buildFixPrompt({
      issueKey: 'BUY-1',
      summary: '',
      repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws/orders', diff: '' }],
      findings: [{ ...FINDINGS[0], instruction: '1. seçenek yapılmalı — kuyruk sırası garanti değil.' }],
    });

    expect(prompt).toContain('1. seçenek yapılmalı');
    expect(prompt).toContain('Nasıl düzeltilecek');
    // It has to read as binding, or the fixer weighs it against its own
    // reading and picks the branch that looks better from inside the diff.
    expect(prompt).toContain('bunu bir insan söyledi, karardır');
    expect(prompt).toContain('Do not weigh it against your own reading');
    expect(prompt.indexOf('1. seçenek')).toBeGreaterThan(prompt.indexOf(FINDINGS[0].heading));
  });

  it('says nothing about instructions for a finding that has none', () => {
    expect(promptFor([FINDINGS[0]])).not.toContain('Nasıl düzeltilecek —');
  });

  it('keeps each decision with its own finding', () => {
    const prompt = buildFixPrompt({
      issueKey: 'BUY-1',
      summary: '',
      repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws/orders', diff: '' }],
      findings: [
        { ...FINDINGS[0], instruction: 'transaction içine al' },
        { ...FINDINGS[1] },
      ],
    });

    const first = prompt.indexOf(FINDINGS[0].heading);
    const second = prompt.indexOf(FINDINGS[1].heading);
    const decision = prompt.indexOf('transaction içine al');
    expect(decision).toBeGreaterThan(first);
    expect(decision).toBeLessThan(second);
  });
});

describe('buildFixPrompt — the ask', () => {
  it('carries what the issue wanted, so an unmet requirement can be met', () => {
    // The review calls an unimplemented requirement `blocking`. A fixer that
    // is only told "the requirement is not met" has not been told what it was.
    const prompt = buildFixPrompt({
      issueKey: 'BUY-1',
      summary: 'İade',
      repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws/orders', diff: '' }],
      findings: FINDINGS,
      requirement: {
        description: 'İptal edilen siparişte iade kaydı açılmalı.',
        comments: [{ created: '2026-08-14T10:00:00.000+0000', text: 'Kabul kriteri: iade tutarı brüt olmalı.' }],
      },
    });

    expect(prompt).toContain('İptal edilen siparişte iade kaydı açılmalı.');
    expect(prompt).toContain('Yorum 1 — 2026-08-14');
    expect(prompt).toContain('Kabul kriteri: iade tutarı brüt olmalı.');
  });

  it('fences the ask off, or the fixer implements the whole ticket', () => {
    const prompt = promptFor();
    expect(prompt).not.toContain('What the issue asked for');

    const withAsk = buildFixPrompt({
      issueKey: 'BUY-1',
      summary: '',
      repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws/orders', diff: '' }],
      findings: FINDINGS,
      requirement: { description: 'Uzun bir ticket açıklaması.', comments: [] },
    });
    expect(withAsk).toContain('not a list of work');
    expect(withAsk).toContain('Implement nothing from it that no selected finding names');
  });

  it('passes the team\'s answers on as fact', () => {
    const prompt = buildFixPrompt({
      issueKey: 'BUY-1',
      summary: '',
      repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws/orders', diff: '' }],
      findings: FINDINGS,
      clarifications: [{ question: 'Kuyruk sırası garanti mi?', answer: 'Hayır, garanti değil.' }],
    });

    expect(prompt).toContain('Kuyruk sırası garanti mi?');
    expect(prompt).toContain('Hayır, garanti değil.');
    expect(prompt).toContain('established fact');
  });

  it('makes project notes binding on the code, not just on the reporting', () => {
    const prompt = buildFixPrompt({
      issueKey: 'BUY-1',
      summary: '',
      repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws/orders', diff: '' }],
      findings: FINDINGS,
      notes: ['Bu repoda log için yalnızca AppLogger kullanılır.'],
    });

    expect(prompt).toContain('yalnızca AppLogger');
    expect(prompt).toContain('Your change must');
    // A fix that solves the finding by breaking a settled decision is not a fix.
    expect(prompt).toContain('skip the finding and say which note stands in the way');
  });

  it('says a service outside the change is not readable, so it skips instead of guessing', () => {
    // Only the repositories the change touches are mounted. A service it
    // never touched is on its default branch, and a patch made there would
    // be against master while the change lives on a feature branch.
    expect(promptFor()).toContain('A service outside the list is not here.');
  });

  it('leaves the sections out entirely when there is nothing to say', () => {
    const prompt = promptFor();
    expect(prompt).not.toContain('Answers from the team');
    expect(prompt).not.toContain('Project notes');
  });
});

describe('CodeFixTask', () => {
  it('asks for write access to the workspace and nowhere else', async () => {
    let seen: Record<string, unknown> = {};
    const llm: LlmProvider = {
      canEditFiles: true,
      generate: async (input) => {
        seen = input as unknown as Record<string, unknown>;
        return '[fixed] blocking — düzeltildi';
      },
    };

    await new CodeFixTask(llm, 'Turkish').run({
      issueKey: 'BUY-1',
      summary: '',
      repos: [{ projectPath: 'team/orders', branchName: 'feature/refund', path: '/tmp/ws', diff: '' }],
      findings: FINDINGS,
    });

    expect(seen.write).toBe(true);
    expect(seen.workdir).toBe('/tmp/ws');
    expect(seen.extraDirs).toEqual([]);
    expect(String(seen.system)).toContain('Turkish');
  });

  it('refuses a provider that cannot edit files instead of answering in prose', async () => {
    // Running anyway would spend minutes and produce an empty patch, which
    // reads as "nothing to fix".
    const llm: LlmProvider = { canEditFiles: false, generate: async () => 'işte önerim' };
    const task = new CodeFixTask(llm);

    expect(task.available).toBe(false);
    await expect(
      task.run({
        issueKey: 'BUY-1',
        summary: '',
        repos: [{ projectPath: 'team/orders', branchName: 'b', path: '/tmp/ws', diff: '' }],
        findings: FINDINGS,
      }),
    ).rejects.toThrow(/claudeCli/);
  });
});

describe('parseFixReport', () => {
  it('reads the two outcomes and drops the prose around them', () => {
    const report = [
      'Şunları yaptım:',
      '[fixed] blocking — src/order.ts:12 — refund transaction içine alındı',
      '[skipped] major — src/api.ts:7 — hangi statünün döneceği ürün kararı',
      'Umarım yardımcı olur.',
    ].join('\n');

    expect(parseFixReport(report)).toEqual([
      { outcome: 'fixed', text: 'blocking — src/order.ts:12 — refund transaction içine alındı' },
      { outcome: 'skipped', text: 'major — src/api.ts:7 — hangi statünün döneceği ürün kararı' },
    ]);
  });

  it('is empty rather than wrong when the model ignored the format', () => {
    expect(parseFixReport('Her şeyi düzelttim.')).toEqual([]);
  });
});

describe('buildFixPrompt — a change that spans repositories', () => {
  const repos = [
    { projectPath: 'team/hgs-api', branchName: 'feature/x', path: '/tmp/ws/hgs', diff: 'a' },
    { projectPath: 'team/EPA_API', branchName: 'feature/x', path: '/tmp/ws/epa', diff: 'b' },
  ];

  it('opens every repository of the change at once', () => {
    const prompt = buildFixPrompt({ issueKey: 'BUY-1', summary: '', repos, findings: FINDINGS });

    expect(prompt).toContain('spans 2 repositories');
    expect(prompt).toContain('/tmp/ws/hgs');
    expect(prompt).toContain('/tmp/ws/epa');
  });

  it('labels each diff, so a hunk is never read against the wrong service', () => {
    const prompt = buildFixPrompt({ issueKey: 'BUY-1', summary: '', repos, findings: FINDINGS });
    expect(prompt).toContain('### team/hgs-api');
    expect(prompt).toContain('### team/EPA_API');
  });

  it('tells it to finish both halves rather than skip the finding', () => {
    // The failure this replaces: an endpoint missing on one side made the
    // whole finding unfixable, because only one repo was ever on disk.
    const prompt = buildFixPrompt({ issueKey: 'BUY-1', summary: '', repos, findings: FINDINGS });
    expect(prompt).toContain('yours\nto finish, not to skip');
    expect(prompt).toContain('A finding may span repositories, and you can finish it.');
    expect(prompt).toContain('Keep the two halves consistent.');
  });

  it('still says a service outside the list is not readable', () => {
    const prompt = buildFixPrompt({ issueKey: 'BUY-1', summary: '', repos, findings: FINDINGS });
    expect(prompt).toContain('A service outside the list is not here.');
  });

  it('mounts the rest beside the first and makes them all writable', async () => {
    let seen: Record<string, unknown> = {};
    const llm: LlmProvider = {
      canEditFiles: true,
      generate: async (input) => {
        seen = input as unknown as Record<string, unknown>;
        return '[fixed] blocking — düzeltildi';
      },
    };

    await new CodeFixTask(llm).run({ issueKey: 'BUY-1', summary: '', repos, findings: FINDINGS });

    expect(seen.workdir).toBe('/tmp/ws/hgs');
    expect(seen.extraDirs).toEqual(['/tmp/ws/epa']);
    expect(seen.write).toBe(true);
  });

  it('refuses a run with no repository rather than editing nothing', async () => {
    const llm: LlmProvider = { canEditFiles: true, generate: async () => '' };
    await expect(
      new CodeFixTask(llm).run({ issueKey: 'BUY-1', summary: '', repos: [], findings: FINDINGS }),
    ).rejects.toThrow(/repo yok/);
  });
});
