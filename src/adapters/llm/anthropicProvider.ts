import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from '../../core/types.js';

export class AnthropicProvider implements LlmProvider {
  /** Plain messages, no tools: this provider can describe a fix but never
   * make one. The fix path checks this and says so instead of running. */
  readonly canEditFiles = false;

  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey?: string,
  ) {
    // No apiKey -> SDK falls back to ANTHROPIC_API_KEY / an `ant auth login` profile.
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async generate({ system, prompt }: { system: string; prompt: string }): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    return textBlock?.text ?? '';
  }
}
