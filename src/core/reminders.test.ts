import { describe, expect, it } from 'vitest';
import { dueReminders, summarise, waitedText, type ReminderItem, type ReminderState } from './reminders.js';

const at = (iso: string) => new Date(iso);
const item = (over: Partial<ReminderItem> = {}): ReminderItem => ({
  kind: 'assignment',
  key: 'assignment:BUY-1',
  issueKey: 'BUY-1',
  since: '2026-08-17T09:00:00.000Z',
  ...over,
});

describe('dueReminders', () => {
  it('announces something the first time it is seen', () => {
    const { due, nextState } = dueReminders([item()], {}, at('2026-08-17T09:00:30.000Z'));

    expect(due).toHaveLength(1);
    expect(due[0].stage).toBe(0);
    expect(nextState['assignment:BUY-1'].stage).toBe(1);
  });

  it('stays quiet until an hour has passed since it last spoke', () => {
    const state: ReminderState = { 'assignment:BUY-1': { stage: 1, lastAt: '2026-08-17T09:00:00.000Z' } };

    const early = dueReminders([item()], state, at('2026-08-17T09:30:00.000Z'));
    expect(early.due).toEqual([]);
    expect(early.nextState['assignment:BUY-1'].stage).toBe(1);

    const late = dueReminders([item()], state, at('2026-08-17T10:05:00.000Z'));
    expect(late.due).toHaveLength(1);
    expect(late.nextState['assignment:BUY-1'].stage).toBe(2);
  });

  it('does not race through the stages for something already old', () => {
    // The bug this replaced: an approval three days old was past every
    // threshold at first sight, so each poll fired again and bumped a
    // stage — five notifications in the minutes after launch. Measuring
    // from the last thing said makes the first sighting the only one.
    const old = item({ key: 'approval:BUY-9', kind: 'approval', since: '2026-08-14T09:00:00.000Z' });

    const first = dueReminders([old], {}, at('2026-08-17T09:00:00.000Z'));
    expect(first.due).toHaveLength(1);

    // The next poll is fifteen minutes later, as it really is.
    const second = dueReminders([old], first.nextState, at('2026-08-17T09:15:00.000Z'));
    expect(second.due).toEqual([]);

    const third = dueReminders([old], second.nextState, at('2026-08-17T09:30:00.000Z'));
    expect(third.due).toEqual([]);
  });

  it('widens the gap instead of repeating hourly', () => {
    // Having spoken twice, it now waits four hours rather than one.
    const state: ReminderState = { 'x': { stage: 2, lastAt: '2026-08-17T10:00:00.000Z' } };
    const one = item({ key: 'x' });

    expect(dueReminders([one], state, at('2026-08-17T13:00:00.000Z')).due).toEqual([]);
    expect(dueReminders([one], state, at('2026-08-17T14:30:00.000Z')).due).toHaveLength(1);
  });

  it('settles at once a day and stays there', () => {
    const state: ReminderState = { 'x': { stage: 9, lastAt: '2026-08-17T09:00:00.000Z' } };
    const one = item({ key: 'x', since: '2026-08-10T09:00:00.000Z' });

    expect(dueReminders([one], state, at('2026-08-18T08:00:00.000Z')).due).toEqual([]);
    expect(dueReminders([one], state, at('2026-08-18T09:30:00.000Z')).due).toHaveLength(1);
  });

  it('forgets items that are gone', () => {
    const state: ReminderState = {
      'assignment:BUY-1': { stage: 3, lastAt: '2026-08-17T09:00:00.000Z' },
      'assignment:BUY-9': { stage: 2, lastAt: '2026-08-17T09:00:00.000Z' },
    };

    // BUY-9 was decided or reassigned. Its entry must go, or the file
    // grows forever and an issue that returns looks already-announced.
    const { nextState } = dueReminders([item()], state, at('2026-08-17T09:10:00.000Z'));
    expect(Object.keys(nextState)).toEqual(['assignment:BUY-1']);
  });
});

describe('summarise', () => {
  it('says nothing when nothing is due', () => {
    expect(summarise([])).toBeNull();
  });

  it('collapses a batch into one line naming the oldest', () => {
    // Five notifications for five issues is how someone ends up turning
    // notifications off.
    const due = [
      { ...item({ issueKey: 'BUY-1' }), stage: 0, waitedHours: 2 },
      { ...item({ issueKey: 'BUY-2', key: 'k2' }), stage: 0, waitedHours: 50 },
      { ...item({ issueKey: 'BUY-3', key: 'k3' }), stage: 0, waitedHours: 1 },
    ];

    const out = summarise(due)!;
    expect(out.title).toBe('3 iş seni bekliyor');
    expect(out.body).toContain('BUY-2');
    expect(out.body).toContain('2 gün');
  });

  it('puts a person ahead of a clock', () => {
    const due = [
      { ...item({ kind: 'approval', issueKey: 'BUY-7', key: 'a' }), stage: 1, waitedHours: 30 },
      {
        ...item({ kind: 'nudge', issueKey: 'BUY-9', key: 'n', from: 'Ada', message: 'Bugün lazım' }),
        stage: 0,
        waitedHours: 0.1,
      },
    ];

    const out = summarise(due)!;
    expect(out.title).toBe('Ada hatırlatıyor');
    expect(out.body).toContain('BUY-9');
    expect(out.body).toContain('Bugün lazım');
    expect(out.body).toContain('+1');
  });
});

describe('waitedText', () => {
  it('uses the coarsest unit that still says something', () => {
    expect(waitedText(0.25)).toBe('15 dk');
    expect(waitedText(3)).toBe('3 saat');
    expect(waitedText(79)).toBe('3 gün');
  });
});
