import { dirname, join } from 'node:path';
import type { AppConfig } from '../config/loadConfig.js';
import type { Action, AiTask, ApprovalChannel, ContextCollector, LlmProvider, Trigger } from './types.js';
import { JiraClient } from '../clients/jiraClient.js';
import { GitlabClient } from '../clients/gitlabClient.js';
import { RepoCache } from '../clients/repoCache.js';
import { JiraStatusPollTrigger } from '../adapters/triggers/jiraStatusPollTrigger.js';
import { JiraIssueContext } from '../adapters/context/jiraIssueContext.js';
import { GitlabBranchDiffContext } from '../adapters/context/gitlabBranchDiffContext.js';
import { AnthropicProvider } from '../adapters/llm/anthropicProvider.js';
import { ClaudeCliProvider } from '../adapters/llm/claudeCliProvider.js';
import { CodeReviewTask } from '../adapters/tasks/codeReviewTask.js';
import { SlackApprovalChannel } from '../adapters/approval/slackApprovalChannel.js';
import { ConsoleApprovalChannel } from '../adapters/approval/consoleApprovalChannel.js';
import { WebApprovalChannel } from '../adapters/approval/webApprovalChannel.js';
import { JiraCommentAction } from '../adapters/actions/jiraCommentAction.js';
import { JiraReviewOutcomeAction } from '../adapters/actions/jiraReviewOutcomeAction.js';
import { ReviewStore } from './reviewStore.js';
import { StateStore } from './stateStore.js';
import { NotesStore } from './notesStore.js';

export interface Wired {
  trigger: Trigger;
  contextCollectors: ContextCollector[];
  task: AiTask;
  approval: ApprovalChannel;
  action: Action;
  /** Persisted per-issue review state — read by the web UI's list/detail
   * views regardless of which approval adapter is wired. */
  reviewStore: ReviewStore;
  /**
   * The pipeline's own bookkeeping: dedup ids, pending approvals, and the
   * auto-prepare watermark.
   *
   * Built here and shared, deliberately. Each instance keeps the whole file
   * in memory and rewrites all of it on every change, so two instances over
   * one path silently delete each other's fields — which is how a pending
   * approval went missing and an approval then reported success while
   * writing nothing to Jira. One file, one owner.
   */
  stateStore: StateStore;
  /** Standing project notes the review honors — managed from the web UI. */
  notesStore: NotesStore;
  /** Exposed so the UI can list projects to clone and inspect the cache. */
  gitlabClient: GitlabClient;
  jiraClient: JiraClient;
  repoCache?: RepoCache;
}

/**
 * Resolves config.yaml's `wiring` block into concrete adapter instances.
 * To point this engine at a different automation: add one entry to the
 * relevant registry map below (and, if needed, one small adapter file),
 * then reference its name from config.yaml — nothing else changes.
 */
/** The file-backed stores. Handed back in on a rebuild: two instances over
 * one file overwrite each other's writes, which is exactly how an approval
 * once reported success while reaching nothing. */
export interface Stores {
  reviewStore: ReviewStore;
  stateStore: StateStore;
  notesStore: NotesStore;
}

export function buildPipeline(config: AppConfig, keep?: Stores): Wired {
  const jiraClient = new JiraClient(config.jira);
  const gitlabClient = new GitlabClient(config.gitlab);
  const reviewStore = keep?.reviewStore ?? new ReviewStore(config.reviewsFilePath);
  const stateStore = keep?.stateStore ?? new StateStore(config.stateFilePath);
  const notesStore = keep?.notesStore ?? new NotesStore(config.review.notesFilePath);

  const llmProviders: Record<string, () => LlmProvider> = {
    // Shells out to the `claude` CLI — uses your Claude Code subscription's
    // included usage, not pay-per-token API credits. Default.
    claudeCli: () => new ClaudeCliProvider(config.anthropic.model),
    // Calls the Anthropic API directly via SDK — needs a funded API key
    // (separate billing from any Claude.ai/Claude Code subscription).
    anthropic: () => new AnthropicProvider(config.anthropic.model, config.anthropic.apiKey),
  };
  const llm = resolve(llmProviders, config.wiring.llm, 'llm');

  const triggers: Record<string, () => Trigger> = {
    jiraStatusPoll: () => new JiraStatusPollTrigger(jiraClient, config.jira.jql),
  };
  const trigger = resolve(triggers, config.wiring.trigger, 'trigger');

  const repoCache = config.review.useRepoCheckout
    ? new RepoCache(config.review.repoCacheDir, config.gitlab.baseUrl, config.gitlab.token)
    : undefined;

  const contextCollectors: Record<string, () => ContextCollector> = {
    // Attachments land beside the repo cache, outside the project, for
    // the same reason clones do: they are other people's files, and an
    // editor with this project open should not index them.
    jiraIssueContext: () =>
      new JiraIssueContext(jiraClient, join(dirname(config.review.repoCacheDir), 'attachments')),
    gitlabBranchDiffContext: () => new GitlabBranchDiffContext(gitlabClient, repoCache),
  };
  const wiredContextCollectors = config.wiring.contextCollectors.map((name) =>
    resolve(contextCollectors, name, 'contextCollector'),
  );

  const tasks: Record<string, () => AiTask> = {
    codeReview: () => new CodeReviewTask(llm, config.review.language, notesStore, reviewStore),
  };
  const task = resolve(tasks, config.wiring.task, 'task');

  const approvals: Record<string, () => ApprovalChannel> = {
    // Web UI default — Approve/Reject buttons drive the decision.
    webApproval: () => new WebApprovalChannel(reviewStore),
    // No human gate at all — logs and auto-approves. Handy for quick tests.
    consoleApproval: () => new ConsoleApprovalChannel(),
    slackReaction: () => {
      if (!config.slack.token || !config.slack.channel) {
        throw new Error('slackReaction approval requires SLACK_BOT_TOKEN and SLACK_CHANNEL in .env');
      }
      return new SlackApprovalChannel(config.slack.token, config.slack.channel);
    },
  };
  const approval = resolve(approvals, config.wiring.approval, 'approval');

  const actions: Record<string, () => Action> = {
    // Comment + status transition + hand back to the developer. Default.
    jiraReviewOutcome: () =>
      new JiraReviewOutcomeAction(jiraClient, {
        applyChanges: config.jira.applyChanges,
        approveStatus: config.jira.approveStatus,
        rejectStatus: config.jira.rejectStatus,
      }),
    // Comment only, no workflow changes.
    jiraComment: () => new JiraCommentAction(jiraClient),
  };
  const action = resolve(actions, config.wiring.action, 'action');

  return {
    trigger,
    contextCollectors: wiredContextCollectors,
    task,
    approval,
    action,
    reviewStore,
    stateStore,
    notesStore,
    gitlabClient,
    jiraClient,
    repoCache,
  };
}

function resolve<T>(registry: Record<string, () => T>, name: string, kind: string): T {
  const factory = registry[name];
  if (!factory) {
    throw new Error(`Unknown ${kind} adapter "${name}". Available: ${Object.keys(registry).join(', ')}`);
  }
  return factory();
}
