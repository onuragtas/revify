import { dueReminders, summarise, type DueReminder, type ReminderItem, type ReminderState } from './reminders.js';

/**
 * Gathers what is waiting on you and says so on a schedule.
 *
 * The backend cannot push: these apps run on people's own machines with no
 * address anyone could reach. So each one polls for what concerns its
 * user — the same shape as the team policy and the notes, and the reason
 * an assignment used to be invisible until you happened to open a tab.
 *
 * Four sources, deliberately kept apart because they mean different things:
 * a colleague asked you directly, a colleague assigned you work, a review
 * this machine produced needs your decision, or an issue has been sitting
 * in the review column untouched. `reminders.ts` decides *when* to speak;
 * this decides *what there is to speak about*.
 *
 * Every source is allowed to fail on its own. A backend that is down must
 * not stop you being reminded of the reviews sitting on this very machine.
 */

export interface ReminderSources {
  /** Work a team-mate handed you, still open. */
  assignments(): Promise<ReminderItem[]>;
  /** Reviews finished here and waiting on your Approve/Reject. */
  approvals(): ReminderItem[];
  /** In the review column, never reviewed by anyone. */
  stale(): Promise<ReminderItem[]>;
  /** "Bu işe bakar mısın" — a person, not a clock. */
  nudges(): Promise<ReminderItem[]>;
}

export interface ReminderWatcherDeps {
  sources: ReminderSources;
  read(): ReminderState;
  write(next: ReminderState): void;
  /** Called with the batch and its one-line summary. */
  announce(due: DueReminder[], summary: { title: string; body: string }): void;
  log?(message: string): void;
}

export interface ReminderOptions {
  enabled: boolean;
  pollIntervalMs: number;
}

export class ReminderWatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly options: ReminderOptions,
    private readonly deps: ReminderWatcherDeps,
  ) {}

  start(): void {
    if (!this.options.enabled || this.timer) return;
    // Not immediately: the first seconds after launch belong to showing a
    // window, and a notification that arrives before the app is on screen
    // has nowhere to take you.
    setTimeout(() => void this.tick(), 20_000).unref?.();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs one round now. Exposed so "check again" is a button and not a
   * wait — a person who just asked to be reminded should not have to
   * wonder whether the timer has come round yet. */
  async tick(): Promise<DueReminder[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const items = await this.collect();
      const { due, nextState } = dueReminders(items, this.deps.read());
      this.deps.write(nextState);

      const summary = summarise(due);
      if (summary) this.deps.announce(due, summary);
      return due;
    } catch (err) {
      this.deps.log?.(`hatırlatma turu başarısız: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      this.polling = false;
    }
  }

  /** Every source is awaited independently: one that throws costs its own
   * items, not the whole round. */
  private async collect(): Promise<ReminderItem[]> {
    const results = await Promise.allSettled([
      this.deps.sources.nudges(),
      this.deps.sources.assignments(),
      Promise.resolve(this.deps.sources.approvals()),
      this.deps.sources.stale(),
    ]);

    const items: ReminderItem[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') items.push(...result.value);
      else this.deps.log?.(`hatırlatma kaynağı okunamadı: ${result.reason}`);
    }
    return items;
  }
}
