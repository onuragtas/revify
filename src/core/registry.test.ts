import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPipeline } from './registry.js';
import type { AppConfig } from '../config/loadConfig.js';

/**
 * The warning no test in this repository could otherwise give.
 *
 * Context collectors are wired by name, so a config that predates one just
 * does not mention it — and a feature stops existing without a word.
 * `localRepoDiffContext` was missing from a config written before it was
 * added, so "review this directory" ran to completion and reported that no
 * GitLab branch was linked to the Jira issue.
 *
 * The file this happens in is gitignored (it holds credentials), so the one
 * that goes stale lives on somebody's own machine and CI never sees it. The
 * only place the omission can be reported is where the config is read.
 */

let dir: string;

function makeConfig(collectors: string[]): AppConfig {
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
    wiring: {
      trigger: 'jiraStatusPoll',
      contextCollectors: collectors,
      task: 'codeReview',
      llm: 'claudeCli',
      approval: 'webApproval',
      action: 'jiraReviewOutcome',
    },
    jira: {
      baseUrl: 'https://jira.example.com',
      email: 'a@b.c',
      apiToken: 't',
      jql: 'x',
      applyChanges: false,
      approveStatus: 'Ready',
      rejectStatus: 'Dev',
    },
    gitlab: { baseUrl: 'https://gitlab.example.com', token: 't' },
    slack: {},
    anthropic: { model: 'claude-opus-5' },
  } as AppConfig;
}

beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'reg-'))));
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('buildPipeline', () => {
  it('says which collectors the config left out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    buildPipeline(makeConfig(['jiraIssueContext', 'gitlabBranchDiffContext']));

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('localRepoDiffContext');
    // Named, because the reader has to know which file to open.
    expect(warn.mock.calls[0][0]).toContain('config/config.yaml');
  });

  it('stays quiet when everything is wired', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    buildPipeline(
      makeConfig(['jiraIssueContext', 'gitlabBranchDiffContext', 'localRepoDiffContext']),
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
