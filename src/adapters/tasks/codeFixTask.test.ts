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
    projectPath: 'team/orders',
    branchName: 'feature/refund',
    diff: '-  refund(order);\n+  tx.run(() => refund(order));',
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

  it('names the repository and branch the workspace is at', () => {
    expect(promptFor()).toContain('team/orders');
    expect(promptFor()).toContain('feature/refund');
  });

  it('includes the change under review, so the fix sees what it corrects', () => {
    expect(promptFor()).toContain('tx.run(() => refund(order))');
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
      projectPath: 'team/orders',
      branchName: 'feature/refund',
      diff: '',
      findings: FINDINGS,
      workdir: '/tmp/ws',
    });

    expect(seen.write).toBe(true);
    expect(seen.workdir).toBe('/tmp/ws');
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
        projectPath: 'team/orders',
        branchName: 'b',
        diff: '',
        findings: FINDINGS,
        workdir: '/tmp/ws',
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
