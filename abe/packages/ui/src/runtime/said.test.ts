/** What a run says, in words (#204): local times, sentences. */
import { describe, expect, test } from 'bun:test';
import { localTime, localTimes, sentence, stopSessionConfirm } from './said';

const hm = (iso: string) => {
  const d = new Date(iso);

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('times in local time', () => {
  test('today: the hour and minute; another day: the date too', () => {
    const iso = '2026-10-24T11:33:08.330Z';

    expect(localTime(iso, iso)).toBe(hm(iso));
    expect(localTime(iso, '2026-11-02T11:33:08.330Z')).toBe(
      `${new Date(iso).getDate()} Oct ${hm(iso)}`,
    );
    // no clock yet: the date said, never a guess at today
    expect(localTime(iso)).toBe(`${new Date(iso).getDate()} Oct ${hm(iso)}`);
  });

  test('every ISO time in a line, the rest as it was', () => {
    const iso = '2026-10-24T11:18:39.866Z';

    expect(localTimes(`30-d616  AB#30  ended since ${iso}  card/30-x`, iso)).toBe(
      `30-d616  AB#30  ended since ${hm(iso)}  card/30-x`,
    );
    expect(localTimes('no time here, AB#30')).toBe('no time here, AB#30');
  });
});

test("a CLI's line as a sentence", () => {
  expect(sentence('commented on AB#30')).toBe('Commented on AB#30');
  expect(sentence('')).toBe('');
  // a name keeps its case (#217): a box, a branch, a file
  expect(sentence('demo-shop-3 kept up until abe box sleep')).toBe(
    'demo-shop-3 kept up until abe box sleep',
  );
  expect(sentence('abe-2.2-i217 pushed')).toBe('abe-2.2-i217 pushed');
  expect(sentence('src/a.ts saved')).toBe('src/a.ts saved');
  expect(sentence('done: 3 cards')).toBe('Done: 3 cards');
  expect(sentence('done.')).toBe('Done.');
});

describe('Stop…’s question (#204, #246)', () => {
  test('a running session: its Claude Code stops, its worktree and branch stay', () => {
    expect(stopSessionConfirm(4, { state: 'working', branch: 'card/4-x' })).toEqual({
      question: "Stop #4's session?",
      details: ['Its Claude Code stops; its worktree and its branch stay: card/4-x'],
      yes: 'Stop',
    });
  });

  test('a Queued one: it leaves the queue, nothing ran (no Claude Code, worktree or branch)', () => {
    expect(stopSessionConfirm(4, { state: 'queued', branch: 'card/4-x' })).toEqual({
      question: "Stop #4's session?",
      details: ['It is Queued: it leaves the queue, and no box is made for it. Nothing ran yet.'],
      yes: 'Stop',
    });
  });
});
