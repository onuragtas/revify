import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createServer } from './server.js';
import { ReviewStore } from '../core/reviewStore.js';
import { StateStore } from '../core/stateStore.js';
import { NotesStore } from '../core/notesStore.js';
import { CodeFixTask } from '../adapters/tasks/codeFixTask.js';
import type { Wired } from '../core/registry.js';
import type { AppConfig } from '../config/loadConfig.js';
import type { LlmProvider } from '../core/types.js';

let dir: string;
let repo: string;
let reviewStore: ReviewStore;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

const REVIEW = [
  '### blocking — app.ts:1',
  '',
  'Oran sabit yazılmış.',
  '',
  '### minor — app.ts:3',
  '',
  'İsimlendirme geliştirilebilir.',
  '',
  'Verdict: Request changes',
].join('\n');

/** A provider with file tools, standing in for the `claude` CLI: it edits
 * the workspace it is given and reports what it did, which is the entire
 * contract the fix path depends on. */
function fixingProvider(edit: (workdir: string) => void): LlmProvider {
  return {
    canEditFiles: true,
    generate: async ({ workdir, write }) => {
      if (!write || !workdir) throw new Error('fix run must be granted write access to a workspace');
      edit(workdir);
      return '[fixed] blocking — app.ts:1 — oran yapılandırmadan okunuyor';
    },
  };
}

function makeConfig(): AppConfig {
  return {
    pollIntervalMs: 60000,
    approvalPollIntervalMs: 20000,
    stateFilePath: join(dir, 'state.json'),
    reviewsFilePath: join(dir, 'reviews.json'),
    review: {
      language: 'English',
      useRepoCheckout: false,
      repoCacheDir: join(dir, 'repos'),
      notesFilePath: join(dir, 'notes.json'),
    },
    autoPrepare: { enabled: false, pollIntervalMs: 120000 },
    reminders: { enabled: false, pollIntervalMs: 900000 },
    setup: { configured: true, missing: [], configMissing: false, queueReady: true },
    wiring: { trigger: 'x', contextCollectors: [], task: 'x', llm: 'x', approval: 'x', action: 'x' },
    jira: {
      baseUrl: 'https://jira.example.com',
      email: 'a@b.c',
      apiToken: 't',
      jql: 'x',
      applyChanges: false,
      approveStatus: 'Ready for Stage',
      rejectStatus: 'In Development',
    },
    gitlab: { baseUrl: 'https://gitlab.example.com', token: 't' },
    slack: {},
    anthropic: { model: 'claude-opus-5' },
  } as AppConfig;
}

function makeWired(llm: LlmProvider): Wired {
  return {
    trigger: { poll: async () => [] },
    contextCollectors: [],
    task: { run: async () => ({ title: '', markdown: '' }) },
    approval: { requestApproval: async () => ({}), checkPending: async () => [] },
    action: { execute: async () => {} },
    reviewStore,
    stateStore: new StateStore(join(dir, 'state.json')),
    notesStore: new NotesStore(join(dir, 'notes.json')),
    fixTask: new CodeFixTask(llm),
    fixWorkspaceRoot: join(dir, 'fix-work'),
    gitlabClient: { listProjects: async () => [] } as unknown as Wired['gitlabClient'],
    jiraClient: { searchIssues: async () => [] } as unknown as Wired['jiraClient'],
  };
}

/** A review of a directory on this machine, sitting at awaiting_approval —
 * exactly the state someone clicks "Düzelt…" from. */
function seedReview(): void {
  reviewStore.upsert('BUY-1', {
    summary: 'orders · feature/rate',
    status: 'awaiting_approval',
    review: { title: 'Code review: BUY-1', markdown: REVIEW },
    projectPaths: ['team/orders'],
    // What the review read, kept on the record so the fix works from the
    // same text the findings came out of.
    requirement: {
      description: 'İptal edilen siparişte iade kaydı açılmalı.',
      comments: [{ created: '2026-08-14T10:00:00.000+0000', text: 'Kabul kriteri: tutar brüt olmalı.' }],
    },
    clarifications: [
      { question: 'Kuyruk sırası garanti mi?', answer: 'Hayır.', answeredAt: '2026-08-15T09:00:00.000Z' },
    ],
    repoChanges: [
      {
        projectPath: 'team/orders',
        baseBranch: 'main',
        branchName: 'feature/rate',
        files: [{ path: 'app.ts', diff: '@@\n-export const rate = 0;\n+export const rate = 1;\n' }],
        repoPath: repo,
      } as never,
    ],
  });
}

/** The fix runs on the queue, so the response returns before it finishes. */
async function waitForFix(status: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (reviewStore.get('BUY-1')?.fix?.status === status) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fix never reached ${status}: ${JSON.stringify(reviewStore.get('BUY-1')?.fix)}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'revify-srv-fix-'));
  repo = join(dir, 'orders');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feature/rate');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'app.ts'), 'export const rate = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');

  reviewStore = new ReviewStore(join(dir, 'reviews.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fix', () => {
  it('produces a patch without touching the reviewed working copy', async () => {
    const app = createServer(
      makeConfig(),
      makeWired(fixingProvider((workdir) => writeFileSync(join(workdir, 'app.ts'), 'export const rate = config.rate;\n'))),
    );
    seedReview();

    const started = await request(app).post('/api/reviews/BUY-1/fix').send({});
    expect(started.status).toBe(200);
    await waitForFix('ready');

    const fix = reviewStore.get('BUY-1')!.fix!;
    expect(fix.patches).toHaveLength(1);
    expect(fix.patches[0].patch).toContain('+export const rate = config.rate;');
    expect(fix.patches[0].files).toEqual(['app.ts']);
    // The point of the whole design: the run changed nothing on disk.
    expect(readFileSync(join(repo, 'app.ts'), 'utf-8')).toBe('export const rate = 1;\n');
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
  });

  it('defaults to the blocking and major findings, leaving nits alone', async () => {
    let seen = '';
    const app = createServer(
      makeConfig(),
      makeWired({
        canEditFiles: true,
        generate: async ({ prompt, workdir }) => {
          seen = prompt;
          writeFileSync(join(workdir!, 'app.ts'), 'export const rate = 2;\n');
          return '[fixed] blocking — app.ts:1 — düzeltildi';
        },
      }),
    );
    seedReview();

    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('ready');

    expect(seen).toContain('Oran sabit yazılmış');
    expect(seen).not.toContain('İsimlendirme geliştirilebilir');
    expect(reviewStore.get('BUY-1')!.fix!.findings).toEqual([
      { severity: 'blocking', heading: 'blocking — app.ts:1' },
    ]);
  });

  it('gives the fixer the review\'s own reading of the ask, not a fresh one', async () => {
    let seen = '';
    const app = createServer(
      makeConfig(),
      makeWired({
        canEditFiles: true,
        generate: async ({ prompt, workdir }) => {
          seen = prompt;
          writeFileSync(join(workdir!, 'app.ts'), 'export const rate = 2;\n');
          return '[fixed] blocking — app.ts:1 — düzeltildi';
        },
      }),
    );
    seedReview();

    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('ready');

    // The requirement a "not implemented" finding refers to…
    expect(seen).toContain('İptal edilen siparişte iade kaydı açılmalı.');
    expect(seen).toContain('Kabul kriteri: tutar brüt olmalı.');
    // …the facts a human established while reading the review…
    expect(seen).toContain('Kuyruk sırası garanti mi?');
    // …and the fence that stops it implementing the rest of the ticket.
    expect(seen).toContain('not a list of work');
  });

  it('binds the team\'s standing notes on the code the fixer writes', async () => {
    let seen = '';
    const wired = makeWired({
      canEditFiles: true,
      generate: async ({ prompt, workdir }) => {
        seen = prompt;
        writeFileSync(join(workdir!, 'app.ts'), 'export const rate = 2;\n');
        return '[fixed] blocking — app.ts:1 — düzeltildi';
      },
    });
    wired.notesStore.add({ scope: 'repo', projectPath: 'team/orders', text: 'Log için yalnızca AppLogger.' });
    const app = createServer(makeConfig(), wired);
    seedReview();

    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('ready');

    expect(seen).toContain('Log için yalnızca AppLogger.');
  });

  it('keeps the patch out of the polled detail payload but serves it on its own', async () => {
    const app = createServer(
      makeConfig(),
      makeWired(fixingProvider((workdir) => writeFileSync(join(workdir, 'app.ts'), 'export const rate = 2;\n'))),
    );
    seedReview();
    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('ready');

    const detail = await request(app).get('/api/reviews/BUY-1/detail');
    expect(detail.body.fix.patches[0].patch).toBeUndefined();
    expect(detail.body.fix.patches[0].size).toBeGreaterThan(0);
    expect(detail.body.findings.map((f: { severity: string }) => f.severity)).toEqual(['blocking', 'minor']);

    const patch = await request(app).get('/api/reviews/BUY-1/fix/patch?projectPath=team/orders');
    expect(patch.text).toContain('+export const rate = 2;');
  });

  it('applies a patch to a directory the caller names, uncommitted', async () => {
    const app = createServer(
      makeConfig(),
      makeWired(fixingProvider((workdir) => writeFileSync(join(workdir, 'app.ts'), 'export const rate = 2;\n'))),
    );
    seedReview();
    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('ready');

    const applied = await request(app)
      .post('/api/reviews/BUY-1/fix/apply')
      .send({ projectPath: 'team/orders', path: repo });

    expect(applied.status).toBe(200);
    expect(readFileSync(join(repo, 'app.ts'), 'utf-8')).toBe('export const rate = 2;\n');
    expect(git(repo, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(reviewStore.get('BUY-1')!.fix!.patches[0].appliedAt).toBeTruthy();
  });

  it('refuses when the provider cannot edit files, instead of running for nothing', async () => {
    const app = createServer(
      makeConfig(),
      makeWired({ canEditFiles: false, generate: async () => 'bir şey yapamam' }),
    );
    seedReview();

    const res = await request(app).post('/api/reviews/BUY-1/fix').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('claude');
    expect(reviewStore.get('BUY-1')!.fix).toBeUndefined();
  });

  it('refuses when there is no review to take findings from', async () => {
    const app = createServer(makeConfig(), makeWired(fixingProvider(() => {})));
    const res = await request(app).post('/api/reviews/BUY-9/fix').send({});
    expect(res.status).toBe(409);
  });

  it('records a failure against the repository rather than losing the run', async () => {
    const app = createServer(
      makeConfig(),
      makeWired({
        canEditFiles: true,
        generate: async () => {
          throw new Error('model patladı');
        },
      }),
    );
    seedReview();

    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('failed');
    expect(reviewStore.get('BUY-1')!.fix!.error).toContain('model patladı');
    // The review it belongs to is untouched — a fix is not a decision.
    expect(reviewStore.get('BUY-1')!.status).toBe('awaiting_approval');
  });

  it('throws the patch away when the review is run again', async () => {
    const app = createServer(
      makeConfig(),
      makeWired(fixingProvider((workdir) => writeFileSync(join(workdir, 'app.ts'), 'export const rate = 2;\n'))),
    );
    seedReview();
    await request(app).post('/api/reviews/BUY-1/fix').send({});
    await waitForFix('ready');

    // A patch built from findings that no longer exist would undo work that
    // was just done, so re-reviewing has to drop it.
    await request(app).delete('/api/reviews/BUY-1/fix');
    expect(reviewStore.get('BUY-1')!.fix).toBeUndefined();
  });
});
