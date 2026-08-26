import { describe, expect, it } from 'vitest';
import { describeCliEvent, assertCannotExecute, WRITE_TOOLS, READ_ONLY_TOOLS } from './claudeCliProvider.js';

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

describe('the fixer cannot commit or push', () => {
  it('hands out no tool that can run a command', () => {
    // This is the whole guarantee. A fix changes files and leaves them
    // uncommitted so a human reads them first; one command tool — `git
    // commit`, `git push`, a hook, an install script — voids that, and no
    // amount of prompt text takes it back.
    expect(() => assertCannotExecute(WRITE_TOOLS)).not.toThrow();
    expect(WRITE_TOOLS).not.toContain('Bash');
    expect(READ_ONLY_TOOLS).not.toContain('Bash');
  });

  it('refuses to launch at all if one is ever added', () => {
    // A careless edit to the tool list has to fail loudly rather than
    // quietly hand a model a shell in somebody's checkout.
    for (const tool of ['Bash', 'Task', 'Agent', 'SlashCommand']) {
      expect(() => assertCannotExecute([...WRITE_TOOLS, tool])).toThrow(/commit ve push/);
    }
  });

  it('names what it objected to, so the fix is obvious', () => {
    expect(() => assertCannotExecute(['Read', 'Bash'])).toThrow(/Bash/);
  });
});
