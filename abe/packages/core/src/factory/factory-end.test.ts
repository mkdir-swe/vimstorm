/** A person's end of a Factory run (#184): what the card and the pull request are told, and the answer. */
import { describe, expect, test } from 'bun:test';
import { factoryEndText, runEndComment } from './factory-end';
import { type Verification } from './factory';

const before = (result: Verification['result']): Verification => ({
  at: '2026-10-24T10:00:00.000Z',
  phase: 'before',
  result,
  report: '/w/.scratch/105/verify/1-before.md',
  regression: [],
});

describe("runEndComment: the card's and the pull request's record of the end", () => {
  test('done after a failed deploy: how, why, by whom and where', () => {
    expect(
      runEndComment({
        card: 102,
        session: '102-d772',
        ended: {
          as: 'done',
          reason: 'deployed by hand',
          at: '2026-10-24T11:00:00.000Z',
          from: 'pr',
        },
        needsYou: 'the deploy to test failed: https://github.com/o/r/actions/runs/9',
        verifications: [],
        report: null,
      }),
    ).toBe(
      [
        '**Factory run ended: done.** deployed by hand',
        '',
        'Ended by a person in pr (session 102-d772, `abe factory end`). It waited on: the deploy to test failed: https://github.com/o/r/actions/runs/9',
      ].join('\n'),
    );
  });

  test("not reproduced: the evidence the run holds, Before's report quoted", () => {
    const text = runEndComment({
      card: 105,
      session: '105-5dbb',
      ended: {
        as: 'not-reproduced',
        reason: 'not on main 939433b',
        at: '2026-10-24T11:00:00.000Z',
        from: 'verify',
      },
      needsYou: 'the bug did not reproduce on the merge base',
      verifications: [before('not-reproduced')],
      report: '# Before\n\nThe cart total was right on 939433b.\n',
    });

    expect(text).toStartWith('**Factory run ended: not reproduced.** not on main 939433b\n');
    expect(text).toEndWith(
      '\n\n**Evidence:** Before on the merge base did not reproduce it (.scratch/105/verify/1-before.md):\n\n> # Before\n>\n> The cart total was right on 939433b.',
    );
  });

  test('a long report is cut, saying so', () => {
    const text = runEndComment({
      card: 105,
      session: '105-5dbb',
      ended: { as: 'not-reproduced', reason: 'r', at: '2026-10-24T11:00:00.000Z', from: 'verify' },
      needsYou: null,
      verifications: [before('not-reproduced')],
      report: 'x'.repeat(10_000),
    });

    expect(text.length).toBeLessThan(5_000);
    expect(text).toContain('> …(cut at 3,000 characters)');
  });
});

test('factoryEndText: the run, its card, its pull request, its session', () => {
  expect(
    factoryEndText({
      card: 102,
      as: 'done',
      reason: 'deployed by hand',
      comment: 'commented on AB#102',
      pr: 'commented on https://github.com/acme/demo/pull/63',
      session: '102-d772 stopped',
    }),
  ).toBe(
    [
      'AB#102 ended: done · deployed by hand',
      '  card      commented on AB#102',
      '  pr        commented on https://github.com/acme/demo/pull/63',
      '  session   102-d772 stopped',
      '',
    ].join('\n'),
  );
});
