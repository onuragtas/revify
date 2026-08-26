import { spawn } from 'node:child_process';
import { claudeNotFoundMessage, resolveClaudeCli } from './resolveClaudeCli.js';
import type { LlmProvider } from '../../core/types.js';

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** How long a stopped review's process gets to exit on its own before it
 * is killed outright. */
const SIGKILL_GRACE_MS = 5000;

export interface CliRunResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI and resolves with its output, or rejects if it fails, times
 * out, or the caller aborts.
 *
 * Written on `spawn` rather than `execFile` for one reason: stopping a
 * review has to stop the *work*, not just stop waiting for it. `execFile`
 * with an AbortSignal rejects its promise immediately and signals only the
 * direct child — the CLI kept running afterwards, still holding the
 * checkout and still spending the subscription's usage with nobody left to
 * read the answer. Here the child is spawned as its own process group
 * (`detached`) so the signal reaches everything it started, and the promise
 * settles only once the process is actually gone.
 */
export function runCli(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; onLine?: (line: string) => void } = {},
): Promise<CliRunResult> {
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      // stdin closed rather than piped: the CLI otherwise waits several
      // seconds for input that is never coming.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const collect = (stream: NodeJS.ReadableStream, onChunk: (text: string) => void) => {
      stream.setEncoding('utf-8');
      stream.on('data', (chunk: string) => onChunk(chunk));
    };

    // stdout is newline-delimited JSON, and a chunk boundary lands wherever
    // the pipe decides — so lines are reassembled here rather than assumed
    // to arrive whole.
    let pending = '';
    collect(child.stdout, (c) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += c;
      if (!options.onLine) return;
      pending += c;
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.trim()) options.onLine(line);
      }
    });
    collect(child.stderr, (c) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += c;
    });

    /** Signals the whole process group. A negative pid means "the group",
     * which is what reaches anything the CLI spawned in turn. */
    const killGroup = (signalName: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signalName);
      } catch {
        // Already gone, or never got a group — fall back to the child.
        try {
          child.kill(signalName);
        } catch {
          /* nothing left to kill */
        }
      }
    };

    const stop = (reason: Error) => {
      if (settled) return;
      settled = true;
      killGroup('SIGTERM');
      // Escalate if it does not go quietly. Unref'd so a pending kill can
      // never hold the process open.
      killTimer = setTimeout(() => killGroup('SIGKILL'), SIGKILL_GRACE_MS);
      killTimer.unref?.();
      cleanup();
      reject(reason);
    };

    const timeoutTimer = setTimeout(
      () => stop(new Error(`claude timed out after ${RUN_TIMEOUT_MS / 1000}s`)),
      RUN_TIMEOUT_MS,
    );

    const onAbort = () => {
      const err = new Error('durduruldu');
      err.name = 'AbortError';
      stop(err);
    };

    function cleanup() {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // ENOENT here means the binary was not where we looked. The default
      // message — "spawn claude ENOENT" — names the symptom and hides the
      // cause, which in a packaged app is almost always PATH.
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(claudeNotFoundMessage())
          : err,
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`claude exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/** With a repo checked out, the reviewer gets exactly the read-only tools
 * it needs to verify a finding against the real code — nothing that can
 * modify the checkout, run commands, or reach the network. */
/*
 * Read, and read only.
 *
 * WebFetch is in here because a Jira description is full of links that
 * carry the actual requirement — an integration spec, a flow, an API
 * contract — and a reviewer that can see the link but not the page is
 * guessing. It fetches; it cannot write anywhere, run anything, or reach
 * the network any other way.
 *
 * The cost is stated plainly in the prompt rather than hidden here:
 * anyone who can edit a Jira issue can now put text in front of the
 * model. `codeReview.md` tells it that fetched pages are evidence, never
 * instructions.
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch'];

/**
 * The fixer's set: the read tools plus the two that change files.
 *
 * No Bash and no WebFetch, deliberately. A fix that can run commands can
 * commit, push, install and delete, and the one thing this feature
 * promises is that nothing leaves the working copy uncommitted. A fix that
 * can fetch pages is a fix taking instructions from whatever a page says.
 * Everything it needs — the findings, the diff — is already in the prompt,
 * and the repository it may edit is one throwaway clone.
 */
const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];

/** No news for this long and the run gets a "still going" line, so a long
 * silent stretch of reasoning cannot be mistaken for a dead process. */
const HEARTBEAT_MS = 15000;

/**
 * Turns one stream-json event into a line worth putting in the step log,
 * or null for the ones that say nothing to a human.
 *
 * The point is answering "is it alive, and what is it doing" — so tool
 * calls become `Read src/auth.ts`, and everything else (token counts,
 * partial text, bookkeeping) is dropped rather than turned into noise.
 */
export function describeCliEvent(event: any, workdir?: string): string | null {
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'system' && event.subtype === 'init') {
    return `model hazır: ${event.model ?? 'bilinmiyor'}`;
  }

  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use') continue;

    const input = block.input ?? {};
    const target =
      input.file_path ?? input.path ?? input.pattern ?? input.query ?? '';
    // Absolute paths are mostly cache-directory noise; what matters is
    // which file inside the repo it opened.
    const shown = workdir && typeof target === 'string' ? target.replace(workdir + '/', '') : target;
    const suffix = shown ? ` ${String(shown).slice(0, 90)}` : '';
    return `${block.name}${suffix}`;
  }

  if (event.type === 'result') {
    return event.is_error ? 'model hata döndürdü' : null;
  }
  return null;
}

/**
 * Shells out to the `claude` CLI in print mode (`-p`) instead of calling
 * the Anthropic API directly. Uses whatever the `claude` CLI itself is
 * logged in with — a Claude Code subscription's included usage — rather
 * than pay-per-token API credits. Requires the `claude` CLI installed and
 * logged in on this machine (`claude /login`, or already active from using
 * Claude Code).
 */
export class ClaudeCliProvider implements LlmProvider {
  /** The CLI has real file tools, which is what makes the fix path
   * possible at all. */
  readonly canEditFiles = true;

  constructor(private readonly model?: string) {}

  async generate({
    system,
    prompt,
    workdir,
    write = false,
    extraDirs = [],
    signal,
    onProgress,
  }: {
    system: string;
    prompt: string;
    workdir?: string;
    write?: boolean;
    extraDirs?: string[];
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  }): Promise<string> {
    if (write && !workdir) {
      throw new Error('Yazma modu bir çalışma dizini olmadan kullanılamaz.');
    }
    const args = [
      '-p',
      prompt,
      // stream-json rather than text: it reports each tool call as it
      // happens, which is the only way the step log can show what the model
      // is doing during the minutes it spends reading code. `--verbose` is
      // required alongside it.
      '--output-format',
      'stream-json',
      '--verbose',
      // Each review is a standalone request; without this, runs can pick up
      // earlier context and answer as an addendum to a previous review.
      '--no-session-persistence',
      // Drop the operator's own MCP servers (Gmail, Slack, …). They are
      // irrelevant to a code review and would otherwise be callable — the
      // reviewer only ever needs to read the checkout.
      '--strict-mcp-config',
      '--system-prompt',
      system,
    ];
    if (this.model) args.push('--model', this.model);

    // `--tools` is what actually restricts the available tool set;
    // `--allowed-tools` only pre-approves tools so they don't prompt (which
    // in -p mode would just fail). Both are needed: with `--allowed-tools`
    // alone, Bash/Write/Edit/Agent stay available to the reviewer.
    if (workdir) {
      const tools = write ? WRITE_TOOLS : READ_ONLY_TOOLS;
      args.push('--tools', tools.join(','), '--allowed-tools', ...tools);
      /*
       * `--add-dir` grants one level of access to every directory it names,
       * so in write mode **everything mounted here is editable**. That is a
       * contract on the caller, not something this provider can check: in
       * write mode it may only ever be handed throwaway workspaces.
       *
       * What it must never be handed is the repo cache. A review hard-resets
       * the repos it touches and leaves the others alone, so an edit left in
       * a cached repo is read as the current state of that service by every
       * later review — silently, and for as long as it sits there.
       */
      args.push('--add-dir', workdir, ...extraDirs);
    } else {
      args.push('--tools', '');
    }

    const started = Date.now();
    let lastNews = started;
    let answer: string | null = null;
    let toolCalls = 0;

    const heartbeat = onProgress
      ? setInterval(() => {
          if (Date.now() - lastNews < HEARTBEAT_MS) return;
          lastNews = Date.now();
          const secs = Math.round((Date.now() - started) / 1000);
          onProgress(`çalışıyor… ${secs} sn, ${toolCalls} araç çağrısı`);
        }, HEARTBEAT_MS)
      : undefined;
    heartbeat?.unref?.();

    try {
      const { stderr } = await runCli(resolveClaudeCli(), args, {
        // Run inside the checkout so relative paths the model uses resolve
        // against the repo rather than this project.
        cwd: workdir,
        signal,
        onLine: (line) => {
          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            return; // not every line is ours to understand
          }
          // The answer arrives in the final result event, not on stdout as
          // plain text — stream-json's output is events all the way down.
          if (event?.type === 'result' && typeof event.result === 'string') answer = event.result;

          // After a stop, the CLI's dying breath includes an error result.
          // Reporting it would blame the model for a shutdown we ordered.
          if (signal?.aborted) return;

          const message = describeCliEvent(event, workdir);
          if (!message || !onProgress) return;
          if (event?.message?.content?.some?.((b: any) => b?.type === 'tool_use')) toolCalls++;
          lastNews = Date.now();
          onProgress(message);
        },
      });
      if (stderr.trim()) {
        console.warn('[claudeCli] stderr:', stderr.trim());
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    if (answer === null) {
      throw new Error('claude produced no result event — the review came back empty');
    }
    onProgress?.(`model bitirdi · ${Math.round((Date.now() - started) / 1000)} sn, ${toolCalls} araç çağrısı`);
    return String(answer).trim();
  }
}
