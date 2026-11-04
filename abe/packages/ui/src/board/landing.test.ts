/** The landing rule as a table: the oldest waiting run first, else the last selection. */
import { describe, expect, test } from 'bun:test';
import type { FactoryRunData, SessionData } from '@abe/core';
import { factoryRun, minutes, session } from '@abe/testing';
import { clockSince, type Landing, landing, waitingRuns } from './index';

const run = (
  card: number,
  state: FactoryRunData['state'],
  since: number,
  stage: FactoryRunData['stage'] = 'build',
) =>
  factoryRun(card, `Card ${card}`, stage, state, {
    since: minutes(since),
  });

const sess = (card: number, state: SessionData['state'], since: number): SessionData => ({
  ...session(`s${card}`, state, card),
  since: minutes(since),
});

describe('where ⌘⌥A from the Editor lands', () => {
  test.each<[string, FactoryRunData[], SessionData[], Landing]>([
    ['nothing runs: the last selection', [], [], { to: 'last' }],
    [
      'only running and done runs: the last selection',
      [run(4, 'running', 1), run(5, 'done', 2, 'done')],
      [sess(4, 'working', 1), sess(5, 'ended', 2)],
      { to: 'last' },
    ],
    [
      'one waiting: that one',
      [run(4, 'running', 1), run(5, 'needs-you', 2)],
      [sess(4, 'working', 1), sess(5, 'waiting', 3)],
      { to: 'run', card: 5, session: 's5' },
    ],
    [
      'two waiting: the one that asked first, by its session',
      [run(4, 'needs-you', 1), run(5, 'needs-you', 2)],
      [sess(4, 'waiting', 9), sess(5, 'waiting', 3)],
      { to: 'run', card: 5, session: 's5' },
    ],
    [
      'a run that needs you with a working session (a red check) counts from its stage',
      [run(4, 'needs-you', 2), run(5, 'needs-you', 1)],
      [sess(4, 'waiting', 4), sess(5, 'working', 6)],
      { to: 'run', card: 5, session: 's5' },
    ],
    [
      'a tie: the lower card',
      [run(7, 'needs-you', 2), run(6, 'needs-you', 2)],
      [sess(7, 'working', 0), sess(6, 'working', 0)],
      { to: 'run', card: 6, session: 's6' },
    ],
    [
      'Failed (its session ended) and Queued do not wait for you',
      [run(4, 'needs-you', 1), run(5, 'queued', 0)],
      [sess(4, 'ended', 1), sess(5, 'queued', 0)],
      { to: 'last' },
    ],
    [
      'Idle (a quiet session, the run not yet needing you) does not either',
      [run(4, 'running', 1)],
      [sess(4, 'waiting', 1)],
      { to: 'last' },
    ],
    [
      'a run whose session is not read yet still counts',
      [run(4, 'needs-you', 1)],
      [],
      { to: 'run', card: 4, session: 's4' },
    ],
  ])('%s', (_, runs, sessions, expected) => {
    expect(landing(runs, sessions)).toEqual(expected);
  });
});

describe('the waiting runs', () => {
  test('oldest first, each with its card, title and since', () => {
    expect(
      waitingRuns(
        [run(4, 'needs-you', 1), run(5, 'needs-you', 2), run(6, 'running', 0)],
        [sess(4, 'waiting', 8), sess(5, 'waiting', 3), sess(6, 'working', 0)],
      ),
    ).toEqual([
      { card: 5, title: 'Card 5', session: 's5', since: minutes(3) },
      { card: 4, title: 'Card 4', session: 's4', since: minutes(8) },
    ]);
  });

  test.each<[string, SessionData['state'] | undefined, number]>([
    ['a waiting session: its own since', 'waiting', 5],
    ['a working one: the stage’s', 'working', 1],
    ['none read: the stage’s', undefined, 1],
  ])('waiting since, %s', (_, state, at) => {
    const s = state === undefined ? undefined : { state, since: minutes(5) };

    expect(
      clockSince(factoryRun(4, 'Card 4', 'build', 'needs-you', { since: minutes(1) }), s),
    ).toBe(minutes(at));
  });
});
