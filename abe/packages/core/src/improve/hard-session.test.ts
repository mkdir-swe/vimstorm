/** Rule tables for the hard-session rule: which runs were hard, and why (ticket #87). */
import { describe, expect, test } from 'bun:test';
import { checksFailures, type HardFacts, hardReasons } from './hard-session';
import { newRun, runData, type Run } from '../factory/factory';

const calm: HardFacts = { reviewRounds: 1, checksFailed: 0, overrides: [], deployFailed: false };

describe('hardReasons', () => {
  test.each<[string, Partial<HardFacts>, string[]]>([
    ['a calm run', {}, []],
    ['two review rounds', { reviewRounds: 2 }, []],
    ['three review rounds', { reviewRounds: 3 }, ['3 review rounds']],
    ['four review rounds', { reviewRounds: 4 }, ['4 review rounds']],
    ['checks failing once', { checksFailed: 1 }, []],
    ['checks failing twice', { checksFailed: 2 }, ['checks failed 2 times']],
    ['an Override', { overrides: ['autoMerge'] }, ['an Override (autoMerge)']],
    ['a failed deploy', { deployFailed: true }, ['a failed deploy']],
    [
      'everything at once, in the rule order',
      { reviewRounds: 3, checksFailed: 3, overrides: ['reach', 'checks'], deployFailed: true },
      [
        '3 review rounds',
        'checks failed 3 times',
        'an Override (reach, checks)',
        'a failed deploy',
      ],
    ],
  ])('%s', (_, facts, reasons) => {
    expect(hardReasons({ ...calm, ...facts })).toEqual(reasons);
  });
});

describe('checksFailures', () => {
  test.each<[string, string[], string, number]>([
    ['no checks yet', ['decide', 'build'], 'checks', 0],
    ['checks green, on to review', ['build', 'checks'], 'review', 0],
    ['checks red, back in build now', ['build', 'checks'], 'build', 1],
    ['red, then green', ['build', 'checks', 'build', 'checks'], 'review', 1],
    ['red twice', ['build', 'checks', 'build', 'checks', 'build'], 'checks', 2],
  ])('%s', (_, stages, now, n) => {
    expect(
      checksFailures(
        stages.map((stage) => ({ stage })),
        now,
      ),
    ).toBe(n);
  });
});

describe('a run’s data says whether it was hard', () => {
  const at = '2026-10-20T09:00:00.000Z';
  const run = (o: Partial<Run> = {}): Run => ({
    ...newRun({ session: '7-a1b2', card: 7, title: 'Cart', repo: '/r', worktree: '/w', at }),
    ...o,
  });
  const review = (round: number) => ({ at, findings: 1, round, report: null, regression: [] });
  const visit = (stage: Run['stage']) => ({ stage, startedAt: at, endedAt: at, report: null });

  test('a fresh run is not', () => {
    expect(runData(run(), 'working').hard).toEqual([]);
  });

  test('its reviews, red checks, Overrides at launch and deploy', () => {
    const hard = run({
      stage: 'pr',
      reviews: [review(1), review(2), review(0)],
      visits: [visit('build'), visit('checks'), visit('build'), visit('checks'), visit('build')],
      overrides: ['autoMerge'],
      pr: {
        repo: 'o/shop',
        number: 3,
        url: 'https://github.com/o/shop/pull/3',
        head: 'card/7-cart',
        base: 'main',
        mergeable: 'mergeable',
        headSha: 'abc',
        autoMerge: false,
        state: 'merged',
        checks: 'success',
        mergeCommit: 'def',
        mergeFailed: null,
        deploy: { state: 'failure', url: null },
        noChecksReads: 0,
        branch: null,
        done: 'test',
      },
    });

    expect(runData(hard, 'ended').hard).toEqual([
      '3 review rounds',
      'checks failed 2 times',
      'an Override (autoMerge)',
      'a failed deploy',
    ]);
  });
});
