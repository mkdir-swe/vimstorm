/**
 * A Done run's clearing (#48; on a box ADR 0022): the worktree, or on a box the card's whole box
 * workspace, removed only when it holds nothing past the merged head and, on a box, its pull
 * request is merged.
 */
import { describe, expect, test } from 'bun:test';
import { type Clearing, Run } from '@abe/core';
import { clearFate } from './factory-pr';

const run = (pr: 'merged' | 'open' | null) =>
  Run.parse({
    v: 1,
    session: '101-ab12',
    card: 101,
    title: 'Cart total',
    repo: 'mkdir-swe/demo-shop',
    worktree: '/workspace/repo',
    startedAt: '2026-10-25T10:00:00.000Z',
    stage: 'done',
    since: '2026-10-25T10:00:00.000Z',
    decision: null,
    visits: [],
    needsYou: null,
    outcome: pr === null ? 'abandoned' : 'done',
    pr:
      pr === null
        ? null
        : {
            repo: 'mkdir-swe/demo-shop',
            number: 7,
            url: 'https://github.com/mkdir-swe/demo-shop/pull/7',
            head: 'card/101-cart-total',
            headSha: 'abc',
            autoMerge: true,
            state: pr,
            checks: 'success',
            mergeCommit: pr === 'merged' ? 'def' : null,
            mergeFailed: null,
            deploy: null,
          },
  });

const clean = { uncommitted: 0, unpushed: 0, head: 'abc' };

describe('what clearing a Done run does with its work', () => {
  test.each<[string, Run, typeof clean | null, boolean, 'remove' | Partial<Omit<Clearing, 'at'>>]>([
    ['on this machine, a clean worktree: removed', run('merged'), clean, false, 'remove'],
    [
      'on this machine, an abandoned run: removed (nothing in it)',
      run(null),
      clean,
      false,
      'remove',
    ],
    ['on a box, merged and pushed: its box workspace goes', run('merged'), clean, true, 'remove'],
    [
      'on a box, a squash-merged head no remote holds counts as pushed',
      run('merged'),
      { uncommitted: 0, unpushed: 1, head: 'abc' },
      true,
      'remove',
    ],
    [
      'on a box, its pull request not merged: kept, and why',
      run('open'),
      clean,
      true,
      {
        worktree: 'kept',
        why: 'its pull request is not merged: its box workspace stays until Remove workspace…',
      },
    ],
    ['on a box, abandoned (no pull request): kept', run(null), clean, true, { worktree: 'kept' }],
    [
      'unpushed work: kept, whatever its pull request',
      run('merged'),
      { uncommitted: 0, unpushed: 2, head: 'xyz' },
      true,
      { worktree: 'kept', why: '2 unpushed commits' },
    ],
    ['gone already', run('merged'), null, true, { worktree: 'gone', why: null }],
  ])('%s', (_, r, work, onBox, fate) => {
    const got = clearFate(r, work, onBox);

    if (fate === 'remove') expect(got).toBe('remove');
    else expect(got).toMatchObject(fate);
  });
});
