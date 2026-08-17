import { describe, expect, it } from 'vitest';
import { describeCliEvent } from './claudeCliProvider.js';

describe('describeCliEvent', () => {
  const workdir = '/cache/backend-team__EPA_API';

  it('reports a file read with a path relative to the checkout', () => {
    const line = describeCliEvent(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${workdir}/src/auth.ts` } }] },
      },
      workdir,
    );
    // The absolute cache path is noise; which file it opened is the news.
    expect(line).toBe('Read src/auth.ts');
  });

  it('reports a grep by its pattern', () => {
    expect(
      describeCliEvent({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'ShoppingLoanService' } }] },
      }),
    ).toBe('Grep ShoppingLoanService');
  });

  it('names the model once, at startup', () => {
    expect(describeCliEvent({ type: 'system', subtype: 'init', model: 'claude-opus-5' })).toBe(
      'model hazır: claude-opus-5',
    );
  });

  it('stays quiet for events that say nothing to a human', () => {
    expect(describeCliEvent({ type: 'system', subtype: 'thinking_tokens' })).toBeNull();
    expect(describeCliEvent({ type: 'assistant', message: { content: [{ type: 'thinking' }] } })).toBeNull();
    expect(describeCliEvent({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBeNull();
    expect(describeCliEvent({ type: 'rate_limit_event' })).toBeNull();
    expect(describeCliEvent(null)).toBeNull();
  });

  it('is silent on success but speaks up on a failed result', () => {
    expect(describeCliEvent({ type: 'result', subtype: 'success', is_error: false })).toBeNull();
    expect(describeCliEvent({ type: 'result', is_error: true })).toBe('model hata döndürdü');
  });

  it('truncates a pathological tool input instead of flooding the log', () => {
    const line = describeCliEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x'.repeat(500) } }] },
    });
    expect(line!.length).toBeLessThan(110);
  });
});
