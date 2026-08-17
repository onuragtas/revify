import type { AiTask, TaskResult, TriggerEvent } from '../../core/types.js';

/**
 * Alternative `AiTask` implementation showing the architecture's "pluggable"
 * point in practice: this implements the exact same interface as
 * CodeReviewTask, so swapping `wiring.task: codeReview` -> `wiring.task:
 * mcpCodeReview` in config.yaml (plus registering it in registry.ts) is the
 * whole migration — no other file changes.
 *
 * Instead of the REST-based ContextCollectors, this variant would run a
 * Claude Agent SDK agent (`@anthropic-ai/claude-agent-sdk`) with an
 * Atlassian MCP server (Jira) and a GitLab MCP server attached as tools,
 * letting Claude decide which tool to call and when to gather the issue +
 * MR context itself, rather than context being collected upfront.
 *
 * Left unimplemented on purpose:
 *   - The Atlassian MCP connector needs to be authorized by the user first
 *     (not done as of writing this file).
 *   - The exact Claude Agent SDK call shape (`query()` + `mcpServers`
 *     options) isn't reproduced here to avoid guessing at an API surface
 *     this project hasn't verified against the SDK's own docs — see
 *     https://code.claude.com/docs/en/agent-sdk before implementing this.
 */
export class McpCodeReviewTask implements AiTask {
  async run(_event: TriggerEvent, _context: Record<string, unknown>): Promise<TaskResult> {
    throw new Error(
      'McpCodeReviewTask is a reference stub. Implement it against the Claude Agent SDK ' +
        '(https://code.claude.com/docs/en/agent-sdk) once the Atlassian MCP connector is authorized.',
    );
  }
}
