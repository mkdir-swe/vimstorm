/**
 * The kept reads' rule (`queries.ts`) as a host plays it: each ask says what it is handed at once
 * and whether it is read, each answer whom it goes to.
 */
import { describe, expect, test } from 'bun:test';
import { answerQuery, askQuery, forgetQueries, noQueries, type Queries, queryKey } from './index';

/** `ask <key> <who>`, `ok <key> <value>`, `fail <key>`, `break`. */
type Step = readonly [string, ...string[]];

/** What the host saw, in words: `w1 held v1 · read`, `ok → w1 · joined w2 · again`. */
const play = (steps: readonly Step[], max?: number): string[] => {
  let q: Queries<string, string> = noQueries();
  const seen: string[] = [];

  for (const [op, key = '', arg = ''] of steps) {
    if (op === 'ask') {
      const asked = askQuery(q, key, arg, max);

      q = asked.queries;
      seen.push(
        [arg, asked.held === undefined ? '' : `held ${asked.held}`, asked.read ? 'read' : 'joined']
          .filter((w) => w !== '')
          .join(' '),
      );
    } else if (op === 'break') {
      q = forgetQueries(q);
    } else {
      const got = answerQuery(q, key, op === 'ok' ? arg : undefined);

      q = got.queries;
      seen.push(
        [
          `${op} → ${got.waiting.join(' ')}`,
          got.joined.length === 0 ? '' : `joined ${got.joined.join(' ')}`,
          got.again ? 'again' : '',
        ]
          .filter((w) => w !== '')
          .join(' · '),
      );
    }
  }

  return seen;
};

describe('a kept read, stale while it revalidates', () => {
  test.each<[string, Step[], string[]]>([
    ['first ask: nothing held, read', [['ask', 'a', 'w1']], ['w1 read']],
    [
      'asked again once answered: the answer at once, read anew',
      [
        ['ask', 'a', 'w1'],
        ['ok', 'a', 'v1'],
        ['ask', 'a', 'w2'],
      ],
      ['w1 read', 'ok → w1', 'w2 held v1 read'],
    ],
    [
      'asked while out: joins it, handed it as held, read once more for it',
      [
        ['ask', 'a', 'w1'],
        ['ask', 'a', 'w2'],
        ['ok', 'a', 'v1'],
        ['ok', 'a', 'v2'],
      ],
      ['w1 read', 'w2 joined', 'ok → w1 · joined w2 · again', 'ok → w2'],
    ],
    [
      'a failure: to those waiting, the held answer stays',
      [
        ['ask', 'a', 'w1'],
        ['ok', 'a', 'v1'],
        ['ask', 'a', 'w2'],
        ['fail', 'a'],
        ['ask', 'a', 'w3'],
      ],
      ['w1 read', 'ok → w1', 'w2 held v1 read', 'fail → w2', 'w3 held v1 read'],
    ],
    [
      'a failure with joiners: none handed it, they wait for the read again',
      [
        ['ask', 'a', 'w1'],
        ['ask', 'a', 'w2'],
        ['fail', 'a'],
      ],
      ['w1 read', 'w2 joined', 'fail → w1 · again'],
    ],
    [
      'two keys: each its own',
      [
        ['ask', 'a', 'w1'],
        ['ask', 'b', 'w2'],
        ['ok', 'b', 'v2'],
        ['ask', 'a', 'w3'],
      ],
      ['w1 read', 'w2 read', 'ok → w2', 'w3 joined'],
    ],
    [
      'a break: what was held forgotten',
      [['ask', 'a', 'w1'], ['ok', 'a', 'v1'], ['break'], ['ask', 'a', 'w2']],
      ['w1 read', 'ok → w1', 'w2 read'],
    ],
  ])('%s', (_, steps, seen) => {
    expect(play(steps)).toEqual(seen);
  });

  test('past the most kept, the least recently asked go; one out stays', () => {
    expect(
      play(
        [
          ['ask', 'a', 'w1'],
          ['ok', 'a', 'va'],
          ['ask', 'b', 'w2'],
          ['ok', 'b', 'vb'],
          ['ask', 'c', 'w3'],
          // a is the least recently asked and not out: let go
          ['ok', 'c', 'vc'],
          ['ask', 'b', 'w4'],
          ['ask', 'a', 'w5'],
        ],
        2,
      ),
    ).toEqual([
      'w1 read',
      'ok → w1',
      'w2 read',
      'ok → w2',
      'w3 read',
      'ok → w3',
      'w4 held vb read',
      'w5 read',
    ]);
  });

  test('a query is its argv in its folder', () => {
    expect(queryKey(['factory', 'record', '2'], '/wt/2')).not.toBe(
      queryKey(['factory', 'record', '2'], '/wt/7'),
    );
    expect(queryKey(['a', 'b'], undefined)).not.toBe(queryKey(['a b'], undefined));
  });
});
