import { EventEmitter } from 'node:events';

export interface ProgressEvent {
  issueId: string;
  message: string;
  ts: string;
}

const MAX_BUFFER_PER_ISSUE = 500;

/**
 * Fan-out for per-issue step logs. `Pipeline` calls `log()` for every
 * step; the web UI polls `getBuffered()` (via /api/reviews/:key/detail) to
 * show the full step history. Also console.logs, so the headless/automatic
 * mode still gets the same visibility it always had.
 */
class ProgressBus extends EventEmitter {
  private readonly buffers = new Map<string, ProgressEvent[]>();

  log(issueId: string, message: string): void {
    const event: ProgressEvent = { issueId, message, ts: new Date().toISOString() };
    console.log(`[${issueId}] ${message}`);

    const buf = this.buffers.get(issueId) ?? [];
    buf.push(event);
    if (buf.length > MAX_BUFFER_PER_ISSUE) buf.shift();
    this.buffers.set(issueId, buf);

    this.emit('progress', event);
  }

  getBuffered(issueId: string): ProgressEvent[] {
    return this.buffers.get(issueId) ?? [];
  }

  /** Clear a previous run's step history before starting a fresh one, so
   * old steps don't linger mixed in with the new run's. */
  clear(issueId: string): void {
    this.buffers.delete(issueId);
  }
}

export const progressBus = new ProgressBus();
