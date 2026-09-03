import { describe, expect, it } from 'vitest';
import { describeCliEvent, describeUsage, assertCannotExecute, WRITE_TOOLS, READ_ONLY_TOOLS, runCli } from './claudeCliProvider.js';

describe('describeUsage', () => {
  /* Nothing recorded what a review cost, so "the reviews are burning the
   * limit" could only be argued from wall-clock time. */
  it('reports what the call cost, cache reads broken out', () => {
    const line = describeUsage({
      type: 'result',
      usage: {
        input_tokens: 23_400,
        output_tokens: 4_100,
        cache_read_input_tokens: 118_000,
        cache_creation_input_tokens: 9_000,
      },
      total_cost_usd: 1.2345,
    });
    expect(line).toBe('kullanım: girdi 23.4k · çıktı 4.1k · önbellek okuma 118.0k · önbellek yazma 9.0k · $1.234');
  });

  it('leaves out cache figures a call did not have, and says nothing without usage', () => {
    expect(describeUsage({ type: 'result', usage: { input_tokens: 900, output_tokens: 12 } }))
      .toBe('kullanım: girdi 900 · çıktı 12');
    expect(describeUsage({ type: 'result' })).toBeNull();
  });
});

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

describe('runCli — stuck and slow are different things', () => {
  /** A fake CLI that prints a line every `every` ms, `count` times, and then
   * exits — a run that is working and then finishes. */
  const chatter = (count: number, every: number) => [
    '-e',
    `let n=0;const t=setInterval(()=>{if(n++>=${count}){clearInterval(t);return;}` +
      `process.stdout.write(JSON.stringify({type:'x',n})+'\\n');},${every});`,
  ];

  /** A fake CLI that starts and then says nothing, ever — a wedged run. */
  const silent = () => ['-e', 'setInterval(()=>{},1000)'];

  it('kills a process that has gone quiet', async () => {
    // Silent from the start: nothing to say, and nobody waiting for it.
    await expect(
      runCli(process.execPath, silent(), { idleTimeoutMs: 150, maxRunMs: 60000 }),
    ).rejects.toThrow(/hiçbir şey yazmadı/);
  });

  it('lets a talkative run continue well past the idle window', async () => {
    // Forty lines, 20ms apart: about 800ms of work under a 500ms idle
    // window. A timer measuring total duration would have killed this at
    // 500ms; one measuring silence must not.
    //
    // The margins are deliberately lopsided — a 20ms gap against a 500ms
    // window survives a machine running the whole suite in parallel, which
    // a tighter pair did not.
    const { stdout } = await runCli(process.execPath, chatter(40, 20), {
      idleTimeoutMs: 500,
      maxRunMs: 60000,
      onLine: () => {},
    });
    expect(stdout.split('\n').filter(Boolean)).toHaveLength(40);
  });

  it('still stops a run that chatters forever', async () => {
    // The failure silence cannot catch: a model looping over tool calls,
    // narrating the whole way.
    await expect(
      runCli(process.execPath, chatter(10000, 5), { idleTimeoutMs: 60000, maxRunMs: 200 }),
    ).rejects.toThrow(/dakikayı aştı/);
  });

  it('says how long it waited, so the number can be raised knowingly', async () => {
    await expect(
      runCli(process.execPath, silent(), { idleTimeoutMs: 120, maxRunMs: 60000 }),
    ).rejects.toThrow(/takıldı sayıldı/);
  });
});
