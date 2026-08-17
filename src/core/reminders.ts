/**
 * What is waiting on you, and when to say so again.
 *
 * Three different things pile up, and they arrive from three places: work
 * a colleague assigned you (the team API), reviews this machine finished
 * that need your decision (the local store), and issues sitting in the
 * review column that nobody has looked at yet (Jira). Only the first is
 * announced by anything today, and only if you happen to open the tab.
 *
 * The hard part is not finding them. It is saying so often enough to be
 * useful and rarely enough that people keep notifications on — an alert
 * every poll trains you to dismiss alerts, which costs more than it saves.
 * So each item is announced once when it appears, then on a widening
 * schedule: an hour later, four hours, then daily. Something that turned
 * up minutes ago is worth a nudge; something a week old is not worth
 * eleven of them.
 */

/**
 * Hours to wait *since the last thing said*, widening each time.
 *
 * Measured from the last announcement rather than from when the item
 * appeared, which is the difference between a schedule and a stampede: an
 * approval that has been waiting three days is, on first sight, already
 * past every threshold — and thresholds counted from its start date fired
 * once per poll until they caught up. Five minutes of that is five
 * notifications for one issue.
 *
 * Past the last entry it repeats daily. Something that has waited a week
 * is not more urgent than one that waited six days, but it should not go
 * silent either.
 */
const INTERVAL_HOURS = [1, 4, 24] as const;

export type ReminderKind = 'assignment' | 'approval' | 'stale' | 'nudge';

export interface ReminderItem {
  kind: ReminderKind;
  /** Stable across polls: it is what decides "have I mentioned this?". */
  key: string;
  issueKey: string;
  summary?: string;
  /** When the clock started — assigned at, reviewed at, first seen. */
  since: string;
  /** Shown instead of the generic line when a person asked directly. */
  message?: string;
  from?: string;
}

/** One entry per item this machine has announced. */
export interface ReminderState {
  [key: string]: { stage: number; lastAt: string };
}

export interface DueReminder extends ReminderItem {
  /** 0 the first time. Lets the caller word "waiting" differently from
   * "still waiting", without re-deriving it. */
  stage: number;
  waitedHours: number;
}

/**
 * Decides which items are due, and returns the state to persist.
 *
 * Pure on purpose: what to announce is exactly the logic worth testing,
 * and it is untestable once tangled with timers, notifications and HTTP.
 */
export function dueReminders(
  items: ReminderItem[],
  state: ReminderState,
  now: Date = new Date(),
): { due: DueReminder[]; nextState: ReminderState } {
  const nextState: ReminderState = {};
  const due: DueReminder[] = [];

  for (const item of items) {
    const since = Date.parse(item.since);
    const waitedHours = Number.isFinite(since) ? (now.getTime() - since) / 3_600_000 : 0;
    const previous = state[item.key];

    if (!previous) {
      // First sighting. Announced immediately: the whole point of a
      // notification is that you did not have to go looking.
      due.push({ ...item, stage: 0, waitedHours });
      nextState[item.key] = { stage: 1, lastAt: now.toISOString() };
      continue;
    }

    const sinceLast = (now.getTime() - Date.parse(previous.lastAt)) / 3_600_000;
    const interval = INTERVAL_HOURS[Math.min(previous.stage - 1, INTERVAL_HOURS.length - 1)];

    if (Number.isFinite(sinceLast) && sinceLast >= interval) {
      due.push({ ...item, stage: previous.stage, waitedHours });
      nextState[item.key] = { stage: previous.stage + 1, lastAt: now.toISOString() };
      continue;
    }

    nextState[item.key] = previous;
  }

  // Items absent from `items` are gone — done, decided, reassigned — and
  // their entries go with them. Keeping them would grow this file forever,
  // and would make an issue that comes back look like one already
  // announced.
  return { due, nextState };
}

/** How long something has been waiting, in the coarsest unit that still
 * says something. "3 gün" is the number that makes someone act; 79 saat is
 * a number they have to convert first. */
export function waitedText(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} dk`;
  if (hours < 48) return `${Math.round(hours)} saat`;
  return `${Math.round(hours / 24)} gün`;
}

/**
 * One line for a batch.
 *
 * Five separate notifications for five waiting issues is how a person ends
 * up turning them off. One line that says how many, naming the oldest, is
 * the same information and one interruption.
 */
export function summarise(due: DueReminder[]): { title: string; body: string } | null {
  if (!due.length) return null;

  const nudges = due.filter((d) => d.kind === 'nudge');
  // A person asking outranks a clock: it is said first and said plainly.
  if (nudges.length) {
    const first = nudges[0];
    const rest = due.length - 1;
    return {
      title: `${first.from ?? 'Takım arkadaşın'} hatırlatıyor`,
      body:
        `${first.issueKey}${first.summary ? ` — ${first.summary}` : ''}` +
        (first.message ? `\n"${first.message}"` : '') +
        (rest > 0 ? `\n(+${rest} bekleyen iş daha)` : ''),
    };
  }

  const label: Record<ReminderKind, string> = {
    assignment: 'sana atandı',
    approval: 'onayını bekliyor',
    stale: 'review bekliyor',
    nudge: 'hatırlatma',
  };

  const oldest = [...due].sort((a, b) => b.waitedHours - a.waitedHours)[0];
  if (due.length === 1) {
    return {
      title: `${oldest.issueKey} ${label[oldest.kind]}`,
      body:
        (oldest.summary ? `${oldest.summary}\n` : '') +
        `${waitedText(oldest.waitedHours)} bekliyor.`,
    };
  }

  return {
    title: `${due.length} iş seni bekliyor`,
    body: `En eskisi ${oldest.issueKey} — ${waitedText(oldest.waitedHours)} (${label[oldest.kind]}).`,
  };
}
