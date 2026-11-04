import { describe, expect, test } from 'bun:test';
import * as core from '@abe/core';
import type { FactoryRunData } from '@abe/core';
import { DONE_ENVIRONMENT, ENDINGS, MERGED_IS_DONE, notReproduced } from './index';

type Run = Pick<FactoryRunData, 'state' | 'reason'>;

const runs: Run[] = [
  { state: 'needs-you', reason: core.NOT_REPRODUCED },
  { state: 'needs-you', reason: "I can't reproduce it on main" },
  { state: 'needs-you', reason: 'it does not reproduce' },
  { state: 'needs-you', reason: 'the bug could not be reproduced' },
  { state: 'needs-you', reason: 'which branch?' },
  { state: 'needs-you', reason: core.withoutBrowser('not reproduced: tests pass') },
  { state: 'needs-you', reason: core.withoutBrowser(core.NOT_REPRODUCED) },
  { state: 'needs-you', reason: null },
  { state: 'running', reason: core.NOT_REPRODUCED },
];

describe("ui's Factory words match core's, since ui reads only core's types", () => {
  test('constants', () => {
    expect(DONE_ENVIRONMENT).toBe(core.DONE_ENVIRONMENT);
    expect(MERGED_IS_DONE).toBe(core.MERGED_IS_DONE);
    expect(ENDINGS).toEqual(core.ENDINGS);
  });

  test.each(runs)('not reproduced: %o', (r) => {
    expect(notReproduced(r)).toBe(core.notReproduced(r));
  });
});
