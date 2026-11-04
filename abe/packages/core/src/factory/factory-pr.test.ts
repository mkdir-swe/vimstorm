/** Rule tables for the pr stage and Done (#48): the body, the link line, a pull request's state. */
import { describe, expect, test } from 'bun:test';
import {
  branchKept,
  NO_CHECKS_READS,
  prData,
  prLine,
  MERGED_IS_DONE,
  prNext,
  noChecksAfter,
  mergesNow,
  prBodyProblems,
  prWaitReason,
  withClosesLine,
  newlyConflicting,
  seenMergeable,
  prConflictPrompt,
  type RunPr,
  withCardLine,
  azureNamesOnThisMachine,
  NO_CHECKS_VERIFIED,
  withNoChecksVerified,
  workKept,
  branchNameProblem,
  intoOf,
  withIntoLine,
} from './factory-pr';
import { loadWorkflows, runWorkflowOf } from '../skills/workflow';
import { newRun, step } from './factory';
import { NO_CHECKS } from './checks';

const notes = (n: number) => Array.from({ length: n }, (_, i) => `- note ${i + 1}`).join('\n');

const body = (o: { verified?: string[]; notes?: string | null; extra?: string } = {}) =>
  [
    'Sign in with email.',
    '',
    ...(o.verified ?? ['**Verified:** signed in on test with a new account (After).']),
    '',
    ...(o.notes === null ? [] : ['## Notes', '', o.notes ?? notes(2)]),
    o.extra ?? '',
  ].join('\n');

describe('the body abe factory pr takes', () => {
  test.each<[string, string, { risky: boolean; regressionTests?: string[] }, string[]]>([
    ['one verification line and two Notes bullets', body(), { risky: false }, []],
    ['five bullets is the most', body({ notes: notes(5) }), { risky: false }, []],
    ['an empty Notes section', body({ notes: '' }), { risky: false }, []],
    [
      'no verification line',
      body({ verified: [] }),
      { risky: false },
      ['no line starts with **Verified:**: the body needs exactly one verification line'],
    ],
    [
      'two verification lines',
      body({ verified: ['**Verified:** one', '**Verified:** two'] }),
      { risky: false },
      ['2 lines start with **Verified:**: exactly one is allowed'],
    ],
    ['no Notes', body({ notes: null }), { risky: false }, ['no ## Notes section']],
    [
      'six bullets',
      body({ notes: notes(6) }),
      { risky: false },
      ['## Notes has 6 bullets: at most 5'],
    ],
    [
      'bullets under a later heading are not Notes',
      body({ notes: notes(5), extra: '\n## Screens\n\n- one\n- two' }),
      { risky: false },
      [],
    ],
    [
      'a verification line inside a code block is not one',
      body({ extra: '\n```\n**Verified:** quoted\n## Notes\n```' }),
      { risky: false },
      [],
    ],
    [
      'nothing right at all',
      'Just a summary.',
      { risky: false },
      [
        'no line starts with **Verified:**: the body needs exactly one verification line',
        'no ## Notes section',
      ],
    ],
    [
      'risky work whose run names no regression tests: the word is not enough',
      body({ verified: ['**Verified:** After on test; regression: checkout.spec, login.spec'] }),
      { risky: true },
      ['risky work: the run names no regression tests, so the **Verified:** line cannot name them'],
    ],
    [
      'risky work without its regression tests',
      body(),
      { risky: true, regressionTests: ['checkout.spec'] },
      ['risky work: the **Verified:** line does not name its regression tests checkout.spec'],
    ],
    [
      'risky work: the run knows the names, the line names each',
      body({ verified: ['**Verified:** After; regression checkout.spec, login.spec'] }),
      { risky: true, regressionTests: ['checkout.spec', 'login.spec'] },
      [],
    ],
    [
      'risky work: a name left out',
      body({ verified: ['**Verified:** After; regression checkout.spec'] }),
      { risky: true, regressionTests: ['checkout.spec', 'login.spec'] },
      ['risky work: the **Verified:** line does not name its regression tests login.spec'],
    ],
  ])('%s', (_, text, o, problems) => {
    expect(prBodyProblems(text, { regressionTests: [], ...o })).toEqual(problems);
  });
});

describe('the Verified line of a run whose checks ran nothing (#159)', () => {
  const MARKED =
    '**Verified:** no checks configured: nothing was run. signed in on test with a new account (After).';

  test.each<[string, string, string]>([
    [
      'what the agent verified, after the words',
      '**Verified:** signed in on test (After).',
      '**Verified:** no checks configured: nothing was run. signed in on test (After).',
    ],
    ['an empty line', '**Verified:**', '**Verified:** no checks configured: nothing was run.'],
    [
      'said already: kept',
      '**Verified:** no checks configured: nothing was run. ran bun test by hand.',
      '**Verified:** no checks configured: nothing was run. ran bun test by hand.',
    ],
    [
      'said already without the full stop: kept',
      '**Verified:** no checks configured: nothing was run; bun test by hand.',
      '**Verified:** no checks configured: nothing was run; bun test by hand.',
    ],
  ])('%s', (_, line, want) => {
    expect(withNoChecksVerified(body({ verified: [line] }))).toBe(body({ verified: [want] }));
  });

  test("its words are the checks' own", () => {
    expect(NO_CHECKS_VERIFIED).toBe(`${NO_CHECKS}.`);
  });

  test('a Verified line in a code fence before it is not the one', () => {
    const fenced = ['```', '**Verified:** quoted', '```', body()].join('\n');
    const marked = withNoChecksVerified(fenced);

    expect(marked).toBe(
      ['```', '**Verified:** quoted', '```', body({ verified: [MARKED] })].join('\n'),
    );
    expect(prBodyProblems(marked, { risky: false, regressionTests: [] })).toEqual([]);
  });
});

describe("the card's link line", () => {
  test.each([
    ['added at the end', 'Body.\n', 'Body.\n\nCard: AB#4\n'],
    ['kept when the body names the card', 'Fixes AB#4.\n', 'Fixes AB#4.\n'],
    ['another card is not this one', 'See AB#41.\n', 'See AB#41.\n\nCard: AB#4\n'],
  ])('%s', (_, text, want) => {
    expect(withCardLine(text, 4)).toBe(want);
  });

  test.each([
    [
      'on this machine: its own name, no link to Azure',
      'Body.\n',
      "Body.\n\nCard: L-4 (on this machine's board)\n",
    ],
    ['kept when the body names it', 'Fixes L-4.\n', 'Fixes L-4.\n'],
  ])('%s', (_, text, want) => {
    expect(withCardLine(text, 4, { provider: 'local' })).toBe(want);
  });
});

describe("a board on this machine: no Azure card's name GitHub would link", () => {
  test.each([
    ['the title', 'AB#4 Count the items.', '', ['the title names AB#4']],
    ['the body', 'L-4 Count the items.', 'Fixes AB#4.', ['the body names AB#4']],
    ['its own name', 'L-4 Count the items.', 'Card: L-4', []],
  ])('%s', (_, title, body, want) => {
    expect(azureNamesOnThisMachine(title, body, 4).map((p) => p.split(':')[0])).toEqual(want);
  });
});

const PR: RunPr = {
  repo: 'acme/demo',
  number: 41,
  url: 'https://github.com/acme/demo/pull/41',
  head: 'card/4-sign-in',
  base: 'main',
  mergeable: 'mergeable',
  headSha: 'h3ad',
  autoMerge: false,
  state: 'open',
  checks: 'pending',
  mergeCommit: null,
  mergeFailed: null,
  deploy: null,
  noChecksReads: 0,
  branch: null,
  done: 'test',
};

describe('noChecksAfter: reads in a row of one head that found no checks', () => {
  test.each<[string, Partial<RunPr>, { checks: RunPr['checks']; headSha: string }, number]>([
    ['the first read with none', {}, { checks: 'none', headSha: 'h3ad' }, 1],
    ['again', { noChecksReads: 1 }, { checks: 'none', headSha: 'h3ad' }, 2],
    [
      'held at the limit',
      { noChecksReads: NO_CHECKS_READS },
      { checks: 'none', headSha: 'h3ad' },
      NO_CHECKS_READS,
    ],
    ['checks came', { noChecksReads: 2 }, { checks: 'pending', headSha: 'h3ad' }, 0],
    [
      'a new head starts over',
      { noChecksReads: NO_CHECKS_READS },
      { checks: 'none', headSha: 'n3w' },
      1,
    ],
  ])('%s', (_, pr, read, reads) => {
    expect(noChecksAfter({ ...PR, ...pr }, read)).toBe(reads);
  });
});

describe('where an open pull request leaves the run', () => {
  test.each<[string, Partial<RunPr>, string | null]>([
    ['a person merges', {}, 'merge waits for a person'],
    ['auto merge, checks running', { autoMerge: true }, null],
    // GitHub lists a pull request's checks a few seconds after it opens: no Needs you yet.
    ['auto merge, no checks on the first read', { autoMerge: true, checks: 'none' }, null],
    [
      'auto merge, no checks two reads in a row',
      { autoMerge: true, checks: 'none', noChecksReads: NO_CHECKS_READS - 1 },
      null,
    ],
    [
      'auto merge, still no checks after NO_CHECKS_READS reads',
      { autoMerge: true, checks: 'none', noChecksReads: NO_CHECKS_READS },
      'auto merge waits for green checks: the pull request has none',
    ],
    ['a person merges, checks red', { checks: 'failure' }, "the pull request's checks failed"],
    [
      'auto merge, checks red',
      { autoMerge: true, checks: 'failure' },
      "the pull request's checks failed",
    ],
    [
      'auto merge refused by GitHub',
      { autoMerge: true, checks: 'success', mergeFailed: 'Base branch was modified' },
      'auto merge failed: Base branch was modified',
    ],
    ['closed unmerged', { state: 'closed' }, 'the pull request was closed without a merge'],
    // #199: GitHub runs no checks on it, so the conflict is named, not the missing checks.
    [
      'conflicting, no checks after NO_CHECKS_READS reads',
      { autoMerge: true, checks: 'none', noChecksReads: NO_CHECKS_READS, mergeable: 'conflicting' },
      'PR #41 conflicts with main: bring the branch up to date',
    ],
    [
      'conflicting, a person merges, checks red',
      { checks: 'failure', mergeable: 'conflicting' },
      'PR #41 conflicts with main: bring the branch up to date',
    ],
    ['mergeable not known yet', { mergeable: 'unknown' }, 'merge waits for a person'],
    [
      'conflicting, read before #199 (no base)',
      { base: '', mergeable: 'conflicting' },
      'PR #41 conflicts with its base: bring the branch up to date',
    ],
    ['merged, no deploy yet', { state: 'merged', mergeCommit: 'abc' }, null],
    [
      'merged, deploy pending',
      { state: 'merged', mergeCommit: 'abc', deploy: { state: 'pending', url: null } },
      null,
    ],
    [
      'merged, deploy failed',
      {
        state: 'merged',
        mergeCommit: 'abc',
        deploy: { state: 'failure', url: 'https://github.com/acme/demo/actions/runs/9' },
      },
      'the deploy to test failed: https://github.com/acme/demo/actions/runs/9',
    ],
  ])('%s', (_, change, reason) => {
    expect(prWaitReason({ ...PR, ...change })).toBe(reason);
  });

  test.each<[string, Partial<RunPr>, { mergeable: RunPr['mergeable']; headSha: string }, boolean]>([
    ['it was mergeable', {}, { mergeable: 'conflicting', headSha: 'h3ad' }, true],
    [
      'not known before',
      { mergeable: 'unknown' },
      { mergeable: 'conflicting', headSha: 'h3ad' },
      true,
    ],
    [
      'still the same head',
      { mergeable: 'conflicting' },
      { mergeable: 'conflicting', headSha: 'h3ad' },
      false,
    ],
    [
      'a new head conflicts again',
      { mergeable: 'conflicting' },
      { mergeable: 'conflicting', headSha: 'n3w' },
      true,
    ],
    [
      'mergeable again',
      { mergeable: 'conflicting' },
      { mergeable: 'mergeable', headSha: 'n3w' },
      false,
    ],
  ])('the session is told of a conflict (#199): %s', (_, was, read, told) => {
    expect(newlyConflicting({ ...PR, ...was }, read)).toBe(told);
  });

  // #199: GitHub says unknown while it works mergeability out again (the base moved).
  test.each<
    [string, Partial<RunPr>, { mergeable: RunPr['mergeable']; headSha: string }, RunPr['mergeable']]
  >([
    [
      'unknown at the same head keeps the conflict',
      { mergeable: 'conflicting' },
      { mergeable: 'unknown', headSha: 'h3ad' },
      'conflicting',
    ],
    [
      'unknown at the same head keeps mergeable',
      { mergeable: 'mergeable' },
      { mergeable: 'unknown', headSha: 'h3ad' },
      'mergeable',
    ],
    [
      'unknown at a new head is unknown',
      { mergeable: 'conflicting' },
      { mergeable: 'unknown', headSha: 'n3w' },
      'unknown',
    ],
    [
      'a known answer stands',
      { mergeable: 'conflicting' },
      { mergeable: 'mergeable', headSha: 'h3ad' },
      'mergeable',
    ],
  ])('mergeability as read (#199): %s', (_, was, read, seen) => {
    const pr = { ...PR, ...was };

    expect(seenMergeable(pr, read)).toBe(seen);
    // conflicting, unknown, conflicting at one head: told once
    expect(newlyConflicting(pr, { ...read, mergeable: seenMergeable(pr, read) })).toBe(false);
  });

  test('what the session is told: merge the base in, never a forced push, then factory pr', () => {
    expect(prConflictPrompt(PR, true)).toBe(
      "Your pull request #41 (https://github.com/acme/demo/pull/41) conflicts with main, so GitHub runs no checks on it and cannot merge it. origin is fetched: merge origin/main into your branch (git merge origin/main; not a rebase: the push is never forced), resolve the conflicts keeping both sides' intent, commit, run the checks, then run abe factory pr again with the same body file to push it.",
    );
    expect(prConflictPrompt(PR, false)).toContain(
      'Fetch origin and merge origin/main into your branch',
    );
  });

  test.each<[string, Partial<RunPr>, string | null]>([
    [
      'auto merge on, checks green',
      { autoMerge: true, checks: 'success' },
      'no checks configured, nothing was run: a person reviews and merges',
    ],
    ['a person merges', {}, 'no checks configured, nothing was run: a person reviews and merges'],
    ['checks red', { checks: 'failure' }, "the pull request's checks failed"],
    ['merged, deploying', { state: 'merged', mergeCommit: 'abc' }, null],
  ])('its checks ran nothing (#159), %s', (_, change, reason) => {
    expect(prWaitReason({ ...PR, ...change }, true)).toBe(reason);
  });

  test.each<
    [
      string,
      Partial<RunPr>,
      { draft: boolean; mergeable: 'mergeable' | 'conflicting' | 'unknown' },
      boolean,
    ]
  >([
    [
      'auto merge, green',
      { autoMerge: true, checks: 'success' },
      { draft: false, mergeable: 'mergeable' },
      true,
    ],
    [
      'green, mergeable not known yet',
      { autoMerge: true, checks: 'success' },
      { draft: false, mergeable: 'unknown' },
      true,
    ],
    ['a person merges', { checks: 'success' }, { draft: false, mergeable: 'mergeable' }, false],
    ['checks pending', { autoMerge: true }, { draft: false, mergeable: 'mergeable' }, false],
    [
      'no checks at all',
      { autoMerge: true, checks: 'none' },
      { draft: false, mergeable: 'mergeable' },
      false,
    ],
    [
      'a draft',
      { autoMerge: true, checks: 'success' },
      { draft: true, mergeable: 'mergeable' },
      false,
    ],
    [
      'a conflict',
      { autoMerge: true, checks: 'success' },
      { draft: false, mergeable: 'conflicting' },
      false,
    ],
  ])('serve merges: %s', (_, change, seen, merges) => {
    expect(mergesNow({ ...PR, ...change }, seen)).toBe(merges);
  });
});

test.each<
  [
    string,
    { uncommitted: number; unpushed: number; head: string },
    string | undefined,
    string | null,
  ]
>([
  ['clean', { uncommitted: 0, unpushed: 0, head: 'a' }, undefined, null],
  ['changes', { uncommitted: 2, unpushed: 0, head: 'a' }, undefined, '2 uncommitted'],
  [
    'a commit on no remote',
    { uncommitted: 0, unpushed: 1, head: 'a' },
    undefined,
    '1 unpushed commit',
  ],
  [
    'both',
    { uncommitted: 1, unpushed: 3, head: 'a' },
    undefined,
    '1 uncommitted, 3 unpushed commits',
  ],
  [
    'squash-merged, its branch gone on GitHub',
    { uncommitted: 0, unpushed: 3, head: 'h3ad' },
    'h3ad',
    null,
  ],
  [
    'a commit after the merged head',
    { uncommitted: 0, unpushed: 4, head: 'n3w' },
    'h3ad',
    '4 unpushed commits',
  ],
  [
    'squash-merged with changes left',
    { uncommitted: 1, unpushed: 3, head: 'h3ad' },
    'h3ad',
    '1 uncommitted',
  ],
])('a worktree when its card clears, %s', (_, work, merged, why) => {
  expect(workKept(work, merged)).toBe(why);
});

test.each<
  [
    string,
    { uncommitted: number; unpushed: number; head: string } | null | undefined,
    string | null,
  ]
>([
  [
    'the worktree at the head it merges: deleted',
    { uncommitted: 0, unpushed: 0, head: 'h3ad' },
    null,
  ],
  ['the worktree gone: deleted', null, null],
  [
    'a commit after the head it merges: kept',
    { uncommitted: 0, unpushed: 1, head: 'n3w' },
    'the worktree holds work: 1 unpushed commit',
  ],
  [
    'changes nobody committed: kept',
    { uncommitted: 2, unpushed: 0, head: 'h3ad' },
    'the worktree holds work: 2 uncommitted',
  ],
  ['git could not say: kept', undefined, 'git could not read the worktree'],
])("the card's branch on origin after serve's squash merge, %s", (_, work, why) => {
  expect(branchKept(work, 'h3ad')).toBe(why);
});

test("prLine: what became of the card's branch on origin", () => {
  const pr: RunPr = { ...PR, autoMerge: true, state: 'merged', mergeCommit: 'm3rg3' };

  expect(prLine(prData(pr))).toBe('https://github.com/acme/demo/pull/41 · merged');
  expect(prLine(prData({ ...pr, branch: { deleted: true, why: null } }))).toBe(
    'https://github.com/acme/demo/pull/41 · merged · branch deleted',
  );
  expect(
    prLine(
      prData({ ...pr, branch: { deleted: false, why: 'the worktree holds work: 1 uncommitted' } }),
    ),
  ).toBe(
    'https://github.com/acme/demo/pull/41 · merged · branch kept: the worktree holds work: 1 uncommitted',
  );
});

describe("withClosesLine: the pull request closes the run's spec issue and slices (#200)", () => {
  test.each<[string, string, string[], string]>([
    ['none held', 'Body.\n', [], 'Body.\n'],
    [
      'in its own repo, a keyword before each',
      'Body.\n',
      ['acme/demo#4', 'acme/demo#5', 'acme/demo#6'],
      'Body.\n\nCloses #4, closes #5, closes #6\n',
    ],
    ['another repo by its name', 'Body.\n', ['acme/api#9'], 'Body.\n\nCloses acme/api#9\n'],
    [
      'those the body closes already are left out',
      'Fixes #4.\nresolves: Acme/Demo#5\n',
      ['acme/demo#4', 'acme/demo#5', 'acme/demo#6'],
      'Fixes #4.\nresolves: Acme/Demo#5\n\nCloses #6\n',
    ],
    ['all closed already', 'Closes #4\n', ['acme/demo#4'], 'Closes #4\n'],
    ['a mention is no close', 'See #4.\n', ['acme/demo#4'], 'See #4.\n\nCloses #4\n'],
  ])('%s', (_, body, issues, want) => {
    expect(withClosesLine(body, issues, 'acme/demo')).toBe(want);
  });
});

describe('the Done setting (#184): a deploy to another environment, or the merge itself', () => {
  const failed = {
    state: 'merged' as const,
    mergeCommit: 'abc',
    deploy: { state: 'failure' as const, url: 'https://github.com/acme/demo/actions/runs/9' },
  };

  test('a deploy to staging that failed names staging', () => {
    expect(prWaitReason({ ...PR, ...failed, done: 'staging' })).toBe(
      'the deploy to staging failed: https://github.com/acme/demo/actions/runs/9',
    );
    expect(prLine(prData({ ...PR, ...failed, done: 'staging' }))).toBe(
      'https://github.com/acme/demo/pull/41 · merged · deploy to staging failure',
    );
  });

  test('a run Done at the merge waits on no deploy', () => {
    expect(prNext({ ...PR, state: 'merged', mergeCommit: 'abc', done: MERGED_IS_DONE })).toBe(
      'done',
    );
    expect(prNext({ ...PR, state: 'merged', mergeCommit: 'abc' })).toBe('deploy');
  });
});

describe("a pull request into a teammate's branch (a pr step's into:)", () => {
  test.each(['feature/sign-in', 'fix-41', 'a/b.c', 'release/2.0'])('%p is a branch name', (b) => {
    expect(branchNameProblem(b)).toBeUndefined();
  });

  test.each([
    '',
    '@',
    '-delete',
    '--force',
    'a..b',
    'a b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    'a@{1}',
    'a//b',
    '/a',
    'a/',
    'a.',
    '.a',
    'a/.b',
    'a.lock',
    'a/b.lock/c',
    'a\tb',
  ])('%p is refused', (b) => {
    expect(branchNameProblem(b)).toContain('is no branch name');
  });

  test('the body opens with the fixes onto their branch and their pull request, once', () => {
    const once = withIntoLine('Fix the null check.\n', 'feature/sign-in', 41);

    expect(once).toBe('Fixes onto `feature/sign-in` (#41).\n\nFix the null check.\n');
    expect(withIntoLine(once, 'feature/sign-in', 41)).toBe(once);
    expect(withIntoLine('Fix.', 'feature/sign-in', null)).toBe(
      'Fixes onto `feature/sign-in`.\n\nFix.',
    );
  });

  test('the branch is the fact the audit reported; none before it, none without into:', () => {
    const workflow = (into: string | undefined) => {
      const loaded = loadWorkflows({
        sources: [
          {
            layer: 'repo',
            file: '/c/abe/workflows/review-pr.yaml',
            id: 'review-pr',
            read: {
              doc: {
                name: 'Review PR',
                steps: [
                  { audit: { skill: 'review-pr', reports: ['audit.findings', 'audit.head'] } },
                  { build: { skill: 'implement', when: { check: 'audit.findings > 0' } } },
                  'checks',
                  { pr: { skill: 'pr', fresh: true, ...(into === undefined ? {} : { into }) } },
                ],
              },
            },
          },
        ],
        skills: [{ name: 'review-pr', layer: 'repo' }],
      }).workflows[0];

      if (!loaded?.ok) throw new Error(JSON.stringify(loaded?.problems ?? 'none'));

      return newRun({
        session: 's',
        card: 4,
        title: 'Review #41',
        repo: '/r',
        worktree: '/w',
        at: '2026-10-30T10:00:00.000Z',
        workflow: runWorkflowOf(loaded),
      });
    };
    const audited = (into: string | undefined) => {
      const s = step(
        workflow(into),
        {
          type: 'stage-done',
          stage: 'audit',
          report: null,
          facts: { 'audit.findings': 1, 'audit.head': 'feature/sign-in' },
        },
        '2026-10-30T10:01:00.000Z',
      );

      if (!s.ok) throw new Error(s.code);

      return s.run;
    };

    expect(intoOf(workflow('audit.head'))).toEqual({ fact: 'audit.head', branch: null });
    expect(intoOf(audited('audit.head'))).toEqual({
      fact: 'audit.head',
      branch: 'feature/sign-in',
    });
    expect([audited('audit.head').stage, intoOf(audited(undefined))]).toEqual(['build', null]);
  });
});
