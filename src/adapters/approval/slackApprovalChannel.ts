import { WebClient } from '@slack/web-api';
import type { ApprovalChannel, ApprovalRef, ApprovalResult, PendingApproval, TaskResult, TriggerEvent } from '../../core/types.js';

const APPROVE_EMOJI = 'white_check_mark';
const REJECT_EMOJI = 'x';

interface SlackChannelRef extends ApprovalRef {
  channel: string;
  ts: string;
}

/** Reaction-based approval: no public HTTP endpoint needed, unlike Slack's
 * interactive-button flow. The bot posts the review and pre-adds both
 * reactions as one-click options; a separate poll loop reads them back. */
export class SlackApprovalChannel implements ApprovalChannel {
  private readonly client: WebClient;

  constructor(
    token: string,
    private readonly channel: string,
  ) {
    this.client = new WebClient(token);
  }

  async requestApproval(_event: TriggerEvent, taskResult: TaskResult): Promise<ApprovalRef> {
    const posted = await this.client.chat.postMessage({
      channel: this.channel,
      text: `*${taskResult.title}*\n\n${taskResult.markdown}`,
    });
    if (!posted.ts || !posted.channel) {
      throw new Error('Slack chat.postMessage did not return a channel/ts');
    }

    await Promise.all([
      this.client.reactions.add({ channel: posted.channel, timestamp: posted.ts, name: APPROVE_EMOJI }),
      this.client.reactions.add({ channel: posted.channel, timestamp: posted.ts, name: REJECT_EMOJI }),
    ]);

    const ref: SlackChannelRef = { channel: posted.channel, ts: posted.ts };
    return ref;
  }

  async checkPending(pending: PendingApproval[]): Promise<ApprovalResult[]> {
    const results: ApprovalResult[] = [];
    for (const p of pending) {
      const { channel, ts } = p.channelRef as SlackChannelRef;
      const res = await this.client.reactions.get({ channel, timestamp: ts });
      const reactions = res.message?.reactions ?? [];
      // count > 1 means someone besides the bot itself reacted.
      const approved = reactions.some((r) => r.name === APPROVE_EMOJI && (r.count ?? 0) > 1);
      const rejected = reactions.some((r) => r.name === REJECT_EMOJI && (r.count ?? 0) > 1);
      if (approved) results.push({ id: p.id, decision: 'approved' });
      else if (rejected) results.push({ id: p.id, decision: 'rejected' });
    }
    return results;
  }
}
