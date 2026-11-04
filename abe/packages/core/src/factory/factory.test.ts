import { describe, expect, test } from 'bun:test';
import {
  cardMoveOf,
  endsVerification,
  factoryRunText,
  BEFORE_FAILED,
  type MadeIssue,
  durationText,
  type Ending,
  type Move,
  newRun,
  NOT_CONVERGED,
  NOT_REPRODUCED,
  notReproduced,
  type Phase,
  regressionOf,
  reviewed,
  type Reviewed,
  runData,
  RunReference,
  type RunState,
  runState,
  type Stage,
  stageEventOf,
  step,
  stepContext,
  VERIFIED,
  type VerifyResult,
  withoutBrowser,
  Run,
} from './factory';
import { type PlaybookKept } from './playbook';
import {
  FEATURE_WORKFLOW,
  loadWorkflows,
  PLAYBOOK_GATE,
  type RunWorkflow,
  runWorkflowOf,
} from '../skills/workflow';
import { type BrowserData, browserRanSince } from '../browser/browser';
import { type RunPr, seenOf as prSeenOf } from './factory-pr';
import { type SessionState } from '../session/session';

const T = (min: number) => new Date(Date.UTC(2026, 9, 23, 20, min)).toISOString();

/** A Feature run on card 4, at its first step (create-specification). */
const fresh = (workflow: RunWorkflow = FEATURE_WORKFLOW): Run =>
  newRun({
    session: '4-ab12',
    card: 4,
    title: 'Sign in',
    repo: '/r',
    worktree: '/w',
    at: T(0),
    workflow,
  });

/** Bug: Feature with its spec swapped for a reproduce step that ends the run when it does not. */
const BUG_WORKFLOW: RunWorkflow = {
  ...FEATURE_WORKFLOW,
  id: 'bug',
  name: 'Bug',
  steps: [
    {
      name: 'reproduce',
      kind: 'reproduce',
      skill: 'reproduce',
      fresh: 'never',
      when: null,
      ends: { when: { check: 'bug.reproduced == 0' }, then: 'report' },
      reports: ['bug.reproduced'],
      doneWhen: null,
      into: null,
    },
    ...FEATURE_WORKFLOW.steps.slice(2),
  ],
};

/** Applies each move in turn at minute 1, 2, …; throws on a refusal. */
const after = (moves: readonly Move[], run = fresh()): Run =>
  moves.reduce((r, m, i) => {
    const s = step(r, m, T(i + 1));

    if (!s.ok) throw new Error(`${m.type}: ${s.code}`);

    return s.run;
  }, run);

const done = (stage: string): Move => ({ type: 'stage-done', stage, report: null });

const review = (
  findings: number,
  report: string | null = null,
  regression: readonly string[] = [],
): Move => ({ type: 'review', findings, report, regression });

const verify = (
  phase: Phase,
  result: VerifyResult,
  regression: readonly string[] = [],
  report = `/w/.scratch/4/verify/${phase}.md`,
  browserRan?: boolean,
): Move => ({
  type: 'verify',
  phase,
  result,
  report,
  regression,
  ...(browserRan === undefined ? {} : { browserRan }),
});

/** The playbook gate's answer. */
const gate = (answer: boolean, reason = answer ? 'a migration' : 'nothing by hand'): Move => ({
  type: 'judge',
  answer,
  reason,
});

/** A Feature run in `stage`, reached the normal way (the playbook gate said no). */
const inStage = (stage: Stage): Run => {
  const path: Move[] = [
    done('create-specification'),
    done('to-tickets'),
    done('build'),
    { type: 'checks', green: true },
    review(0, null, ['r']),
    verify('after', 'pass', ['r']),
    gate(false),
  ];
  let run = fresh();

  for (const [i, move] of path.entries()) {
    if (run.stage === stage) return run;
    const s = step(run, move, T(i + 1));

    if (s.ok) run = s.run;
  }
  if (run.stage !== stage) throw new Error(`reached ${run.stage}, not ${stage}`);

  return run;
};

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

const opened = (o: Partial<RunPr> = {}): Move => ({ type: 'pr-opened', pr: { ...PR, ...o } });
const merged: Move = {
  type: 'pr-seen',
  pr: {
    state: 'merged',
    base: 'main',
    mergeable: 'mergeable',
    checks: 'success',
    mergeCommit: 'm3rg3',
    autoMerge: false,
    mergeFailed: null,
    headSha: 'h3ad',
    noChecksReads: 0,
    branch: null,
    done: 'test',
  },
};
/** What a read of the run's pull request saw last. */
const seenOf = (run: Run) => {
  if (run.pr === null) throw new Error('no pull request');

  return prSeenOf(run.pr);
};
const deployed = (state: 'pending' | 'success' | 'failure'): Move => ({
  type: 'deployed',
  state,
  url: 'https://github.com/acme/demo/actions/runs/9',
});

/** A run carried to done: its pull request opened, merged and deployed to test. */
const doneRun = () => after([opened(), merged, deployed('success')], inStage('pr'));

/** A run in `stage` whose agent said it needs you. */
const asked = (stage: Stage) =>
  after([{ type: 'needs-you', reason: 'which plan?' }], inStage(stage));

describe('every allowed move', () => {
  test.each<[string, Run, Move, Stage]>([
    ['a Feature run starts at its spec', fresh(), { type: 'answered' }, 'spec'],
    ['spec done → to-tickets', inStage('spec'), done('create-specification'), 'step'],
    ['spec done by its kind → to-tickets', inStage('spec'), done('spec'), 'step'],
    ['to-tickets done → build', inStage('step'), done('to-tickets'), 'build'],
    ['build done → checks', inStage('build'), done('build'), 'checks'],
    ['checks green → review', inStage('checks'), { type: 'checks', green: true }, 'review'],
    ['checks red → build', inStage('checks'), { type: 'checks', green: false }, 'build'],
    [
      'checks ran nothing → review',
      inStage('checks'),
      { type: 'checks', green: false, none: true },
      'review',
    ],
    ['review clean → verify', inStage('review'), review(0), 'verify'],
    ['review findings → build', inStage('review'), review(2), 'build'],
    ['verify after pass → the gated playbook', inStage('verify'), verify('after', 'pass'), 'step'],
    ['verify after fail → build', inStage('verify'), verify('after', 'fail'), 'build'],
    ['pull request opened: stays in pr', inStage('pr'), opened(), 'pr'],
    ['merged: stays in pr', after([opened()], inStage('pr')), merged, 'pr'],
    [
      'merged, deploy failed: stays in pr',
      after([opened(), merged], inStage('pr')),
      deployed('failure'),
      'pr',
    ],
    [
      'merged, deployed to test → done',
      after([opened(), merged], inStage('pr')),
      deployed('success'),
      'done',
    ],
  ])('%s', (_, run, move, to) => {
    const s = step(run, move, T(30));

    expect(s.ok && s.run.stage).toBe(to);
  });

  test('a move ends the stage it leaves as a visit and starts the next at that time', () => {
    const s = step(inStage('build'), { type: 'stage-done', stage: 'build', report: '/r.md' }, T(9));

    expect(s.ok && [s.run.since, s.run.visits.at(-1)]).toEqual([
      T(9),
      { stage: 'build', startedAt: T(2), endedAt: T(9), report: '/r.md' },
    ]);
  });

  test('deployed to test ends the run done', () => {
    const pr = doneRun();

    expect([pr.outcome, pr.visits.at(-1)?.stage, pr.pr?.deploy?.state]).toEqual([
      'done',
      'pr',
      'success',
    ]);
  });
});

describe('every refused move', () => {
  test.each<[string, Run, Move, string]>([
    [
      'stage-done reproduce: verify --phase before',
      fresh(BUG_WORKFLOW),
      done('reproduce'),
      'reproduce-with-verify',
    ],
    ['stage-done checks: serve runs them', inStage('checks'), done('checks'), 'checks-by-serve'],
    [
      'stage-done review: review --findings',
      inStage('review'),
      done('review'),
      'review-with-review',
    ],
    ['stage-done verify: verify --phase', inStage('verify'), done('verify'), 'verify-with-verify'],
    ['review outside review', inStage('build'), review(0), 'not-this-stage'],
    ['verify outside verify', inStage('review'), verify('after', 'pass'), 'not-this-stage'],
    ['review on a done run', doneRun(), review(0), 'run-done'],
    ['a stage it is not in', inStage('review'), done('build'), 'not-this-stage'],
    ['the spec once past it', inStage('build'), done('spec'), 'not-this-stage'],
    ['stage-done pr: serve ends it', inStage('pr'), done('pr'), 'pr-by-serve'],
    ['stage-done done', doneRun(), done('done'), 'run-done'],
    ['a pull request outside pr', inStage('verify'), opened(), 'not-this-stage'],
    ['read with none open', inStage('pr'), merged, 'no-pr'],
    [
      'a deploy before the merge',
      after([opened()], inStage('pr')),
      deployed('success'),
      'not-merged',
    ],
    ['opened again once merged', after([opened(), merged], inStage('pr')), opened(), 'pr-merged'],
    [
      'cleared before done',
      inStage('pr'),
      { type: 'cleared', cleared: { at: T(9), worktree: 'removed', why: null } },
      'not-done',
    ],
    ['checks outside checks', inStage('build'), { type: 'checks', green: true }, 'not-this-stage'],
    ['anything once done', doneRun(), done('pr'), 'run-done'],
    ['needs you on a done run', doneRun(), { type: 'needs-you', reason: 'x' }, 'run-done'],
    // Needs you holds the agent's own moves until the person answers (#45).
    ['stage-done while it needs you', asked('build'), done('build'), 'needs-you'],
    ['a clean review while it needs you', asked('review'), review(0), 'needs-you'],
    ['findings while it needs you', asked('review'), review(2), 'needs-you'],
    ['verify while it needs you', asked('verify'), verify('after', 'pass'), 'needs-you'],
    ['a pull request while it needs you', asked('pr'), opened(), 'needs-you'],
  ])('%s', (_, run, move, code) => {
    const s = step(run, move, T(30));

    expect(s.ok ? 'moved' : s.code).toBe(code);
  });
});

describe('review rounds', () => {
  test.each<[string, number, number, Reviewed]>([
    ['none found: on, rounds back to 0', 0, 2, { to: 'next', round: 0 }],
    ['first round with findings → build', 3, 0, { to: 'build', round: 1 }],
    ['second round with findings → build', 1, 1, { to: 'build', round: 2 }],
    [
      'third round with findings → needs you',
      1,
      2,
      { to: 'stay', round: 3, needsYou: NOT_CONVERGED },
    ],
    ['findings after you answered: counting starts over', 1, 3, { to: 'build', round: 1 }],
    ['none found after you answered: on', 0, 3, { to: 'next', round: 0 }],
  ])('%s', (_, findings, round, want) => {
    expect(reviewed(findings, round)).toEqual(want);
  });

  /** Review with findings, then build and checks again: one round. */
  const round = (n: number): Move[] => [review(n), done('build'), { type: 'checks', green: true }];

  test('three rounds with findings: back to build twice, then Needs you in review', () => {
    const run = after([...round(2), ...round(1), review(1, '/r3.md')], inStage('review'));

    expect([run.stage, run.round, run.needsYou?.reason]).toEqual(['review', 3, NOT_CONVERGED]);
    expect(run.reviews.map((r) => [r.findings, r.round])).toEqual([
      [2, 1],
      [1, 2],
      [1, 3],
    ]);
    expect(run.visits.filter((v) => v.stage === 'review').map((v) => v.report)).toEqual([
      null,
      null,
    ]);
  });

  test('converging on the third round goes on to verify; the count is 0 again', () => {
    const run = after([...round(2), ...round(1), review(0)], inStage('review'));

    expect([run.stage, run.round, run.needsYou]).toEqual(['verify', 0, null]);
  });

  test('once you answer, findings go back to build and count from 1', () => {
    const stuck = after([...round(2), ...round(1), review(1)], inStage('review'));
    const still = step(stuck, review(4), T(20));
    const answered = after([{ type: 'answered' }, review(4)], stuck);

    expect(still.ok ? still.run.stage : still.code).toBe('needs-you');
    expect([answered.stage, answered.round, answered.needsYou]).toEqual(['build', 1, null]);
  });

  test("a finding round's report is its review visit's", () => {
    const run = after([review(2, '/w/.scratch/4/review/1.md')], inStage('review'));

    expect(run.visits.at(-1)).toMatchObject({
      stage: 'review',
      report: '/w/.scratch/4/review/1.md',
    });
  });
});

describe('verification levels', () => {
  test.each<[`${Phase} ${VerifyResult}`, string]>([
    ['before pass', 'after'],
    ['before fail', `stay: ${BEFORE_FAILED}`],
    ['before not-reproduced', `stay: ${NOT_REPRODUCED}`],
    ['after pass', 'next'],
    ['after fail', 'build'],
    ['after not-reproduced', 'before-only'],
  ])('VERIFIED[%s] → %s', (key, want) => {
    const v = VERIFIED[key];

    if (!v.ok) expect(v.code).toBe(want);
    else expect(v.to === 'stay' ? `stay: ${v.needsYou}` : v.to).toBe(want);
  });

  /** Each case: the moves in verify, then the stage reached or the refusal, and why it waits. */
  test.each<[string, Move[], string, string | null]>([
    ['After pass → the gated playbook', [verify('after', 'pass')], 'step', null],
    ['After fail → build', [verify('after', 'fail')], 'build', null],
    ['Before reproduced stays in verify for After', [verify('before', 'pass')], 'verify', null],
    ['then After pass → on', [verify('before', 'pass'), verify('after', 'pass')], 'step', null],
    [
      'Before not reproduced → needs you',
      [verify('before', 'not-reproduced')],
      'verify',
      NOT_REPRODUCED,
    ],
    ['Before could not run → needs you', [verify('before', 'fail')], 'verify', BEFORE_FAILED],
    ['not-reproduced at After', [verify('after', 'not-reproduced')], 'before-only', null],
  ])('verify picks its level: %s', (_, moves, want, reason) => {
    let run = inStage('verify');

    for (const [i, m] of moves.entries()) {
      const s = step(run, m, T(10 + i));

      if (!s.ok) {
        expect(s.code).toBe(want);

        return;
      }
      run = s.run;
    }
    expect([run.stage, run.needsYou?.reason ?? null]).toEqual([want, reason]);
  });

  test('the regression tests a clean review names, when After names none, ride the pull request', () => {
    const run = after([review(0, null, ['checkout.spec', 'cart.spec'])], inStage('review'));

    expect([run.stage, regressionOf(run)]).toEqual(['verify', ['checkout.spec', 'cart.spec']]);
  });

  test('the regression tests the after pass named are kept on the run', () => {
    const run = after(
      [review(0), verify('after', 'pass', ['checkout.spec', 'cart.spec'])],
      inStage('review'),
    );

    expect(regressionOf(run)).toEqual(['checkout.spec', 'cart.spec']);
    expect(runData(run, 'working').regression).toEqual(['checkout.spec', 'cart.spec']);
  });
});

describe('where a run stands', () => {
  test.each<[string, Run, SessionState | undefined, RunState, string | null]>([
    ['working session', inStage('build'), 'working', 'running', null],
    ['session waits on you', inStage('build'), 'waiting', 'needs-you', 'waiting on you in Chat'],
    ['session ended first', inStage('build'), 'ended', 'needs-you', 'its session ended'],
    [
      'a prototype’s session waits: its own look says on what',
      { ...inStage('build'), prototype: true },
      'waiting',
      'running',
      null,
    ],
    [
      'the agent said needs you',
      after([{ type: 'needs-you', reason: 'which plan?' }], inStage('build')),
      'working',
      'needs-you',
      'which plan?',
    ],
    ['done', doneRun(), 'ended', 'done', null],
    [
      'pull request open, a person merges: needs you, whatever the session',
      after([opened()], inStage('pr')),
      'working',
      'needs-you',
      'merge waits for a person',
    ],
    [
      'pull request open, auto merge: running while its session waits',
      after([opened({ autoMerge: true })], inStage('pr')),
      'waiting',
      'running',
      null,
    ],
    [
      'merged, deploying: running after its session ended',
      after([opened(), merged, deployed('pending')], inStage('pr')),
      'ended',
      'running',
      null,
    ],
    [
      'merged, deploy failed: needs you with the link',
      after([opened(), merged, deployed('failure')], inStage('pr')),
      'ended',
      'needs-you',
      'the deploy to test failed: https://github.com/acme/demo/actions/runs/9',
    ],
    [
      // #159: even with auto merge on, a run whose checks ran nothing waits on a person
      'pull request open, its checks ran nothing: a person reviews and merges',
      { ...after([opened({ autoMerge: true })], inStage('pr')), noChecks: true },
      'waiting',
      'needs-you',
      'no checks configured, nothing was run: a person reviews and merges',
    ],
  ])('%s', (_, run, session, state, reason) => {
    expect(runState(run, session)).toEqual({ state, reason });
  });

  test.each<[string, Run, Move, string | null]>([
    ['the person answers: cleared', asked('build'), { type: 'answered' }, null],
    ['checks passing: kept', asked('checks'), { type: 'checks', green: true }, 'which plan?'],
    ['checks failing: kept', asked('checks'), { type: 'checks', green: false }, 'which plan?'],
  ])('needs you: %s', (_, run, move, reason) => {
    const s = step(run, move, T(30));

    expect(s.ok && (s.run.needsYou?.reason ?? null)).toBe(reason);
  });

  test('needs you with options (#213): kept in order, in status, gone once answered', () => {
    const move: Move = {
      type: 'needs-you',
      reason: 'keep the old commits or start fresh?',
      options: ['Keep the old commits', 'Start fresh'],
    };
    const s = step(inStage('build'), move, T(30));

    expect(s.ok && runData(s.run, 'waiting').options).toEqual([
      'Keep the old commits',
      'Start fresh',
    ]);
    // its event carries them too: a screen holding the run shows these, not an earlier wait's
    expect(
      s.ok && stageEventOf(inStage('build'), 'working', s.run, 'waiting', 'needs-you')?.options,
    ).toEqual(['Keep the old commits', 'Start fresh']);
    const answered = s.ok ? step(s.run, { type: 'answered' }, T(31)) : s;

    expect(answered.ok && runData(answered.run, 'working').options).toEqual([]);
    // none offered: none, and the stored run stays as before
    const plain = step(inStage('build'), { type: 'needs-you', reason: 'x', options: [] }, T(30));

    expect(plain.ok && plain.run.needsYou).toEqual({ reason: 'x', since: T(30) });
  });

  test("status data: each finished stage's duration", () => {
    const run = after([done('create-specification'), done('to-tickets'), done('build')]);

    expect(runData(run, 'working').stages.map((s) => [s.stage, s.durationMs])).toEqual([
      ['spec', 60_000],
      ['step', 60_000],
      ['build', 60_000],
    ]);
  });
});

describe('checks that ran nothing (#159)', () => {
  const none: Move = { type: 'checks', green: false, none: true };

  test('none on to review marked noChecks; green clears it; red keeps it, back to build', () => {
    const marked = after([none], inStage('checks'));

    expect([marked.stage, marked.noChecks, marked.needsYou]).toEqual(['review', true, null]);
    const red = after([review(1), done('build'), { type: 'checks', green: false }], marked);

    expect([red.stage, red.noChecks]).toEqual(['build', true]);
    const green = after([review(1), done('build'), { type: 'checks', green: true }], marked);

    expect([green.stage, green.noChecks]).toEqual(['review', false]);
  });

  test('its status says so to the person and to the agent', () => {
    const run = { ...inStage('review'), noChecks: true };

    expect(runData(run, 'working').noChecks).toBe(true);
    expect(factoryRunText(runData(run, 'working'))).toContain(
      "  checks    no checks configured: nothing runs after build (give tests, types and lint a command in the repo's abe.yaml)",
    );
    expect(factoryRunText(runData(inStage('review'), 'working'))).not.toContain('no checks');
  });
});

describe("a run's spec issues (#200)", () => {
  const made = (number: number, o: Partial<MadeIssue> = {}): Move => ({
    type: 'issue-made',
    issue: { repo: 'acme/demo', number, labels: [], parent: null, ...o },
  });

  test('a spec-labelled one and its sub-issues are kept, once', () => {
    const specced = after(
      [made(4, { labels: ['spec'] }), made(5, { parent: 4 }), made(5, { parent: 4 })],
      inStage('spec'),
    );

    expect(specced.specIssues).toEqual(['acme/demo#4', 'acme/demo#5']);
    const built = after([made(6, { parent: 4 }), made(7, { labels: ['Spec'] })], {
      ...inStage('build'),
      specIssues: specced.specIssues,
    });

    expect(built.specIssues).toEqual(['acme/demo#4', 'acme/demo#5', 'acme/demo#6', 'acme/demo#7']);
  });

  test('an issue it opens in Spec or while building (a bug it found) is not its spec: it stays open', () => {
    expect(after([made(8), made(9, { parent: 3 })], inStage('build')).specIssues).toEqual([]);
    expect(after([made(10)], inStage('spec')).specIssues).toEqual([]);
  });
});

test.each([
  [0, '0s'],
  [59_999, '59s'],
  [125_000, '2m 5s'],
  [3_725_000, '1h 2m'],
])('durationText(%d) = %s', (ms, text) => {
  expect(durationText(ms)).toBe(text);
});

test.each([
  ['before', 'pass', false],
  ['before', 'fail', true],
  ['before', 'not-reproduced', true],
  ['after', 'pass', true],
  ['after', 'fail', true],
  ['after', 'not-reproduced', false],
] as const)('endsVerification %s %s → %p (the browser stops)', (phase, result, ends) => {
  expect(endsVerification(phase, result)).toBe(ends);
});

describe('cardMoveOf: where a run moves its card on the board', () => {
  const pr = after([opened(), merged, deployed('success')], inStage('pr'));
  const reported = after([verify('before', 'not-reproduced')], fresh(BUG_WORKFLOW));
  const rows: [string, Run, Run, 'active' | 'done' | null][] = [
    ['spec → build: it starts building', inStage('spec'), inStage('build'), 'active'],
    ['checks red → build: building already', inStage('checks'), inStage('build'), null],
    ['review → build: building already', inStage('review'), inStage('build'), null],
    ['pr → done: Done', inStage('pr'), pr, 'done'],
    [
      'a bug that did not reproduce: its report, the card stays',
      fresh(BUG_WORKFLOW),
      reported,
      null,
    ],
    ['done and still done', pr, pr, null],
  ];

  test.each(rows)('%s', (_, was, next, column) => {
    expect(cardMoveOf(was, next)).toBe(column);
  });
});

test("factoryRunText: the card's board move, or why it was not written", () => {
  const at = T(9);
  const text = (error: string | null) =>
    factoryRunText(
      runData(
        after([{ type: 'card-moved', board: { column: 'active', state: 'Active', at, error } }]),
        'working',
      ),
    );

  expect(text(null)).toContain('\n  board     Active\n');
  expect(text('TF401320: rule')).toContain('\n  board     not moved to Active: TF401320: rule\n');
});

describe("a run reference's prototype: one shape, told apart by kind", () => {
  const ref = (prototype: unknown) =>
    RunReference.safeParse({ spec: 'example/shop#88', prototype, dir: '.scratch/4/prototype' });

  test('a Make card version in the org store', () => {
    expect(ref({ kind: 'store', url: 'prototype://shop/4/v3' })).toMatchObject({
      success: true,
      data: { prototype: { kind: 'store', url: 'prototype://shop/4/v3' } },
    });
  });

  test('a developer prototype by its branch and commit', () => {
    expect(ref({ kind: 'code', branch: 'proto/4-show-vat', sha: 'c0ffee0' })).toMatchObject({
      success: true,
      data: { prototype: { kind: 'code', branch: 'proto/4-show-vat', sha: 'c0ffee0' } },
    });
  });

  test("a run written before the kinds: its prototype:// link is the store's", () => {
    expect(ref('prototype://shop/4/v3')).toMatchObject({
      success: true,
      data: { prototype: { kind: 'store', url: 'prototype://shop/4/v3' } },
    });
  });

  test.each([
    ['a bare branch@sha', 'proto/4-show-vat@c0ffee0'],
    ['another scheme', 'https://example.com/4/v3'],
    ['another kind', { kind: 'url', url: 'https://example.com/4/v3' }],
    ['a store url that is no version', { kind: 'store', url: 'prototype://shop/4' }],
    ['a code sha that is not seven hex', { kind: 'code', branch: 'proto/4', sha: 'c0ffee0123' }],
  ])('%s is refused', (_, prototype) => {
    expect(ref(prototype).success).toBe(false);
  });
});

describe('a person ends a run (#184)', () => {
  const failedDeploy = () => after([opened(), merged, deployed('failure')], inStage('pr'));
  const end = (as: Ending, reason = 'the deploy job needs AWS, done by hand'): Move => ({
    type: 'end',
    as,
    reason,
  });

  test.each<[string, Run, Ending, NonNullable<Run['outcome']>]>([
    ['a failed deploy, accepted as done', failedDeploy(), 'done', 'done'],
    ['a bug that does not reproduce, in build', asked('build'), 'not-reproduced', 'not-reproduced'],
    ['work given up, in review', inStage('review'), 'abandoned', 'abandoned'],
    ['a run whose session ended, in its spec', fresh(), 'abandoned', 'abandoned'],
  ])('%s: done, its Needs you cleared, how and why kept', (_, run, as, outcome) => {
    const s = step(run, end(as, 'why'), T(40));

    expect(
      s.ok && [s.run.stage, s.run.outcome, s.run.needsYou, s.run.ended, s.run.visits.at(-1)?.stage],
    ).toEqual([
      'done',
      outcome,
      null,
      { as, reason: 'why', at: T(40), from: run.stage },
      run.stage,
    ]);
    expect(s.ok && runState(s.run, 'ended')).toEqual({ state: 'done', reason: null });
  });

  test.each<[string, Run, Move, string]>([
    ['a done run', doneRun(), end('done'), 'run-done'],
    [
      'a run ended with its report',
      after([verify('before', 'not-reproduced')], fresh(BUG_WORKFLOW)),
      end('abandoned'),
      'run-done',
    ],
    ['no reason', failedDeploy(), end('done', '  '), 'reason-required'],
    [
      'a prototype',
      { ...inStage('build'), prototype: true },
      end('abandoned'),
      'prototype-never-ships',
    ],
    [
      'finishing a step of a run a person ended (a resumed session)',
      after([end('abandoned', 'dropped')], inStage('build')),
      done('build'),
      'run-done',
    ],
  ])('refused: %s', (_, run, move, code) => {
    const s = step(run, move, T(40));

    expect(s.ok ? 'moved' : s.code).toBe(code);
  });

  test.each<[string, Ending, 'done' | 'new']>([
    ['done: the Done column', 'done', 'done'],
    ['not reproduced: the Done column, nothing to fix', 'not-reproduced', 'done'],
    ['abandoned: back to New, for someone to pick up', 'abandoned', 'new'],
  ])('its card: %s', (_, as, column) => {
    const was = inStage('build');
    const s = step(was, end(as), T(40));

    expect(s.ok && cardMoveOf(was, s.run)).toBe(column);
  });

  test('status says how it ended and why', () => {
    const s = step(failedDeploy(), end('done', 'deployed by hand'), T(40));

    expect(s.ok && factoryRunText(runData(s.run, 'ended'))).toContain(
      '\n  ended     done by a person in pr: deployed by hand\n',
    );
  });
});

describe('factory status words (#187)', () => {
  test('one finding is a finding', () => {
    const text = factoryRunText(runData(after([review(1)], inStage('review')), 'working'));

    expect(text).toContain('\n  reviewed  1 finding, round 1 of 3\n');
  });

  test('verified: Before says whether the bug showed, After pass or fail (#320)', () => {
    const v = (phase: 'before' | 'after', result: 'pass' | 'fail' | 'not-reproduced') => ({
      at: T(10),
      phase,
      result,
      report: '',
      regression: [],
    });
    const said = (...vs: ReturnType<typeof v>[]) =>
      factoryRunText(runData({ ...inStage('pr'), verifications: vs }, 'working'));

    expect(said(v('before', 'pass'), v('after', 'pass'))).toContain(
      '\n  verified  before: bug reproduced · after: pass\n',
    );
    expect(said(v('before', 'not-reproduced'))).toContain('\n  verified  before: not reproduced\n');
    expect(said(v('before', 'fail'))).toContain('\n  verified  before: could not run\n');
    expect(said(v('after', 'fail'))).toContain('\n  verified  after: fail\n');
  });

  test('needs you since it started needing you, not since its stage began', () => {
    // In build since minute 2; the agent asked at minute 30.
    const run = inStage('build');
    const s = step(run, { type: 'needs-you', reason: 'which plan?' }, T(30));

    expect(s.ok && factoryRunText(runData(s.run, 'waiting'))).toStartWith(
      `AB#4  build  needs you since ${T(30)}  4-ab12\n`,
    );
    expect(s.ok && runData(s.run, 'waiting').needsYouSince).toBe(T(30));
  });

  test('a pull request a person merges reads ready for review, as the Board says it', () => {
    const text = factoryRunText(
      runData(after([opened({ checks: 'success' })], inStage('pr')), 'waiting'),
    );

    expect(text).toContain('  pr  ready for review since ');
    expect(text).toContain('\n  ready for review: merge waits for a person\n');
    expect(text).not.toContain('needs you');
  });

  test('a wait its pull request shows: since that wait began, kept while it stands', () => {
    const run = after([opened(), merged], inStage('pr'));
    const failed = step(run, deployed('failure'), T(40));

    if (!failed.ok) throw new Error(failed.code);
    expect(runData(failed.run, 'working')).toMatchObject({
      state: 'needs-you',
      needsYouSince: T(40),
    });
    // Read again at minute 50 with nothing new: still since minute 40.
    const again = step(failed.run, deployed('failure'), T(50));

    expect(again.ok && runData(again.run, 'working').needsYouSince).toBe(T(40));
    // Running again (a re-run deploying), no wait to date.
    const pending = step(failed.run, deployed('pending'), T(55));

    expect(pending.ok && runData(pending.run, 'working')).toMatchObject({
      state: 'running',
      needsYouSince: null,
    });
  });
});

describe('Done at the merge (#184: a repo with no deploy to wait for)', () => {
  test('a pull request found merged as abe factory pr opens it: done at once', () => {
    const run = after(
      [opened({ done: 'merged', state: 'merged', mergeCommit: 'm3rg3' })],
      inStage('pr'),
    );

    expect([run.stage, run.outcome]).toEqual(['done', 'done']);
  });

  test('merged, its Done setting merged: done at once, no deploy read', () => {
    const run = after(
      [
        opened({ done: 'merged' }),
        {
          type: 'pr-seen',
          pr: { ...seenOf(after([opened(), merged], inStage('pr'))), done: 'merged' },
        },
      ],
      inStage('pr'),
    );

    expect([run.stage, run.outcome, run.pr?.deploy]).toEqual(['done', 'done', null]);
  });

  test('merged and waiting on a deploy, the setting turned to merged: done', () => {
    const waiting = after([opened(), merged, deployed('pending')], inStage('pr'));
    const s = step(waiting, { type: 'pr-seen', pr: { ...seenOf(waiting), done: 'merged' } }, T(40));

    expect(s.ok && [s.run.stage, s.run.outcome]).toEqual(['done', 'done']);
  });
});

describe("a stuck run's status names the person's way out (#184)", () => {
  const next = (run: Run, session: SessionState = 'ended') =>
    factoryRunText(runData(run, session))
      .split('\n')
      .find((l) => l.startsWith('  next '));

  test.each<[string, Run, SessionState, string | undefined]>([
    [
      'a failed deploy: re-run it, or end it',
      after([opened(), merged, deployed('failure')], inStage('pr')),
      'ended',
      '  next      re-run the deploy and Done follows, or end the run: abe factory end 4 --as done|abandoned --reason <why>',
    ],
    [
      'merged, no deploy yet: maybe none comes',
      after([opened(), merged, deployed('pending')], inStage('pr')),
      'ended',
      '  next      waits for the deploy to test; none coming? set factory.done to merged for this repo, or abe factory end 4 --as done --reason <why>',
    ],
    [
      'a bug that did not reproduce on the merge base',
      after([verify('before', 'not-reproduced')], inStage('verify')),
      'waiting',
      '  next      answer in Chat to go on, or end the run: abe factory end 4 --as not-reproduced --reason <why>',
    ],
    [
      'the agent says it does not reproduce, in build',
      after([{ type: 'needs-you', reason: 'Not reproduced on main (939433b)' }], inStage('build')),
      'waiting',
      '  next      answer in Chat to go on, or end the run: abe factory end 4 --as not-reproduced --reason <why>',
    ],
    [
      'said with a typographic apostrophe',
      after([{ type: 'needs-you', reason: 'I can’t reproduce it on main' }], inStage('build')),
      'waiting',
      '  next      answer in Chat to go on, or end the run: abe factory end 4 --as not-reproduced --reason <why>',
    ],
    [
      'its session ended',
      inStage('build'),
      'ended',
      '  next      reopen it (Reopen), or end the run: abe factory end 4 --as done|not-reproduced|abandoned --reason <why>',
    ],
    [
      'its pull request closed unmerged',
      after(
        [
          opened(),
          { type: 'pr-seen', pr: { ...seenOf(after([opened()], inStage('pr'))), state: 'closed' } },
        ],
        inStage('pr'),
      ),
      'ended',
      '  next      reopen the pull request, or end the run: abe factory end 4 --as abandoned|done --reason <why>',
    ],
    ['a question in Chat: answered there, no line', asked('build'), 'waiting', undefined],
    ['running: no line', inStage('build'), 'working', undefined],
    ['done: no line', doneRun(), 'ended', undefined],
  ])('%s', (_, run, session, line) => {
    expect(next(run, session)).toBe(line);
  });

  test.each<[string, Run, string]>([
    [
      "pr's end is serve's; a deploy that never comes is the person's",
      inStage('pr'),
      "hand the body to abe factory pr: the run is done once its pull request is merged and deployed to test; a deploy that fails or never comes is the person's to re-run, or to end the run (abe factory end)",
    ],
    [
      "Done at the merge (factory.done: merged): the merge is the run's end",
      after([opened({ done: 'merged' })], inStage('pr')),
      "hand the body to abe factory pr: the run is done once its pull request is merged; a merge that never comes is the person's, or theirs to end the run (abe factory end)",
    ],
    [
      'not reproduced outside reproduce and verify: say so, the person ends it',
      inStage('build'),
      "not-reproduced outside reproduce and verify: say so with abe factory needs-you --reason 'not reproduced: <what you saw>'; the person ends the run (abe factory end <card> --as not-reproduced)",
    ],
  ])('the agent is told: %s', (_, run, message) => {
    const move: Move = run.stage === 'pr' ? done('pr') : verify('before', 'not-reproduced');
    const s = step(run, move, T(40));

    expect(s.ok ? 'moved' : s.message).toBe(message);
  });
});

describe('the factory.stage event a step sends (#228)', () => {
  test('a pull request opened for a person to merge: its summary rides the event', () => {
    const was = inStage('pr');
    const next = after([opened({ checks: 'success' })], was);

    expect(stageEventOf(was, 'waiting', next, 'waiting', 'pr')).toMatchObject({
      card: next.card,
      session: next.session,
      stage: 'pr',
      from: null,
      state: 'needs-you',
      reason: 'merge waits for a person',
      cause: 'pr',
      pr: { number: 41, state: 'open', merge: 'person', checks: 'success' },
    });
  });

  test('no pull request yet: pr null; nothing moved: no event', () => {
    const was = inStage('review');
    const next: Run = { ...was, stage: 'pr', since: T(9) };

    expect(stageEventOf(was, 'working', next, 'working', 'stage-done')).toMatchObject({
      stage: 'pr',
      from: 'review',
      pr: null,
    });
    expect(stageEventOf(next, 'working', next, 'working', 'hook')).toBeNull();
  });

  test('ended as Abandoned: how and the stage it was given up in ride the event (#230)', () => {
    const was = inStage('pr');
    const s = step(was, { type: 'end', as: 'abandoned', reason: 'not needed' }, T(40));

    if (!s.ok) throw new Error(s.message);
    expect(stageEventOf(was, 'waiting', s.run, 'ended', 'end')).toMatchObject({
      stage: 'done',
      from: 'pr',
      outcome: 'abandoned',
      ended: { as: 'abandoned', reason: 'not needed', from: 'pr' },
    });
    // a move no person ended: null
    expect(stageEventOf(inStage('review'), 'working', was, 'working', 'stage-done')?.ended).toBe(
      null,
    );
  });
});

describe('a not-reproduced with the browser never run is no verdict (#319)', () => {
  const said = 'not reproduced: every price goes through formatPrice, tests pass';
  const before = (result: VerifyResult, browserRan: boolean): Move => ({
    type: 'verify',
    phase: 'before',
    result,
    report: '/w/.scratch/4/verify/before.md',
    regression: [],
    browserRan,
  });

  test.each<[string, string, boolean | undefined, string, boolean]>([
    ['the browser never ran', said, false, withoutBrowser(said), false],
    ['the browser ran', said, true, said, true],
    ['nothing known of a browser (none in this session)', said, undefined, said, true],
    ['another Needs you, the browser never ran', 'which branch?', false, 'which branch?', false],
  ])(
    "Needs you in build, %s: the reason, and whether it is the bug's verdict",
    (_, reason, ran, want, verdict) => {
      const run = after(
        [{ type: 'needs-you', reason, ...(ran === undefined ? {} : { browserRan: ran }) }],
        inStage('build'),
      );
      const r = { state: 'needs-you' as const, reason: run.needsYou?.reason ?? null };

      expect([r.reason, notReproduced(r)]).toEqual([want, verdict]);
    },
  );

  test('the inconclusive reason names abe browser start', () => {
    expect(withoutBrowser(said)).toContain('abe browser start');
  });

  test.each<[string, boolean, string, boolean]>([
    ['never ran', false, withoutBrowser(NOT_REPRODUCED), false],
    ['ran', true, NOT_REPRODUCED, true],
  ])('Before not reproduced, the browser %s', (_, ran, want, verdict) => {
    const run = after([before('not-reproduced', ran)], inStage('verify'));
    const r = { state: 'needs-you' as const, reason: run.needsYou?.reason ?? null };

    expect([r.reason, notReproduced(r)]).toEqual([want, verdict]);
  });

  test("Before's other results keep their words, the browser or not", () => {
    const run = after([before('fail', false)], inStage('verify'));

    expect(run.needsYou?.reason).toBe(BEFORE_FAILED);
  });
});

describe('browserRanSince: whether the session browser ran during a run (#319)', () => {
  const b = (o: Partial<BrowserData>): BrowserData => ({
    state: 'stopped',
    endpoint: null,
    webSocket: null,
    browser: null,
    pid: null,
    pages: 0,
    clients: 0,
    port: 9222,
    profile: '/p',
    mcpConfig: '/m',
    startedAt: null,
    lastActivityAt: null,
    idleStopAt: null,
    stopped: null,
    browserProfile: null,
    signIns: null,
    ...o,
  });

  test.each<[string, BrowserData, string, boolean | undefined]>([
    ['running', b({ state: 'running', startedAt: T(0) }), T(0), true],
    ['never started', b({}), T(0), false],
    ['stopped during the run', b({ stopped: { at: T(7), reason: 'idle' } }), T(0), true],
    ['stopped before the run', b({ stopped: { at: T(1), reason: 'verified' } }), T(0), false],
    ['none seen by a serve started after the run: unknown', b({}), T(6), undefined],
    ['running, seen by a serve started after the run', b({ state: 'running' }), T(6), true],
  ])('%s', (_, data, watched, want) => {
    expect(browserRanSince(data, T(5), watched)).toBe(want);
  });
});

describe("a run's workflow (#15): its steps and loops, not fixed stages", () => {
  /** A workflow file of your Layer, loaded, as a run carries it; `poke` is your skill. */
  const wf = (doc: unknown) => {
    const loaded = loadWorkflows({
      sources: [{ layer: 'yours', file: '/c/workflows/w.yaml', id: 'w', read: { doc } }],
      skills: [{ name: 'poke', layer: 'yours' }],
    }).workflows[0];

    if (!loaded?.ok) throw new Error(JSON.stringify(loaded?.problems ?? 'none'));

    return runWorkflowOf(loaded);
  };
  const run = (workflow: RunWorkflow) =>
    newRun({ session: 's', card: 4, title: 'T', repo: '/r', worktree: '/w', at: T(0), workflow });
  const plain = (o: Record<string, unknown> = {}, loops: unknown[] = [], more: unknown[] = []) =>
    wf({
      name: 'Quick fix',
      steps: [{ poke: { reports: ['seen'], ...o } }, 'implement', 'checks', ...more, 'pr'],
      loops,
    });
  const at = (r: Run) => [r.stage, r.step];

  test('a run written before workflows carries the built-in Feature', () => {
    const old: Record<string, unknown> = { ...fresh() };

    delete old.workflow;
    expect(Run.parse(old).workflow).toEqual(FEATURE_WORKFLOW);
  });

  test('a run written before 3.3, in decide, reads as a plain step; its question as reported', () => {
    const read = Run.parse({
      ...fresh(),
      stage: 'decide',
      outcome: 'question',
      visits: [{ stage: 'grill', startedAt: T(0), endedAt: T(1), report: null }],
    });

    expect([read.stage, read.outcome, read.visits[0]?.stage]).toEqual(['step', 'reported', 'step']);
  });

  test.each<[string, RunWorkflow, Move[], (string | null)[]]>([
    ['a run starts at its first step', plain(), [], ['step', 'poke']],
    [
      'a plain step done by its name: on to the next',
      plain(),
      [done('poke')],
      ['build', 'implement'],
    ],
    [
      'implement is build: done as build',
      plain(),
      [done('poke'), done('build')],
      ['checks', 'checks'],
    ],
  ])('%s', (_, workflow, moves, where) => {
    expect(at(after(moves, run(workflow)))).toEqual(where);
  });

  test.each<[string, Run, Move, string]>([
    ['a step not in the workflow', run(plain()), done('spec'), 'not-this-stage'],
    [
      'a fact the step does not report',
      run(plain()),
      { type: 'stage-done', stage: 'poke', report: null, facts: { other: 1 } },
      'unknown-fact',
    ],
    [
      'done_when not holding',
      run(plain({ done_when: { check: 'seen > 0' } })),
      done('poke'),
      'not-done',
    ],
    [
      'no judge waiting',
      run(plain()),
      { type: 'judge', answer: true, reason: 'r' },
      'nothing-to-judge',
    ],
  ])('refused: %s', (_, r, move, code) => {
    const s = step(r, move, T(9));

    expect(s.ok ? 'moved' : s.code).toBe(code);
  });

  test('done_when holding over the facts it reported: on', () => {
    const r = after(
      [{ type: 'stage-done', stage: 'poke', report: null, facts: { seen: 2 } }],
      run(plain({ done_when: { check: 'seen > 0' } })),
    );

    expect([at(r), r.facts]).toEqual([['build', 'implement'], { seen: 2 }]);
  });

  test('a judge loop waits on the step agent; its answers are decisions; past max Needs you', () => {
    const judged = plain({}, [
      { from: 'poke', to: 'poke', when: { judge: 'Is it still unclear?', sees: ['seen'] }, max: 1 },
    ]);
    const asked = after([done('poke')], run(judged));

    expect([at(asked), asked.judging?.question]).toEqual([
      ['step', 'poke'],
      'Is it still unclear?',
    ]);
    expect(step(asked, done('poke'), T(5)).ok).toBe(false);
    const yes = after([{ type: 'judge', answer: true, reason: 'no repro yet' }], asked);

    expect([at(yes), yes.looped, yes.judging]).toEqual([['step', 'poke'], { '1': 1 }, null]);
    const again = after([done('poke'), { type: 'judge', answer: true, reason: 'still' }], yes);

    expect([again.needsYou?.reason, again.judgements.map((j) => j.answer)]).toEqual([
      'poke did not converge: back to poke 1 times',
      [true, true],
    ]);
    const no = after([{ type: 'judge', answer: false, reason: 'clear now' }], asked);

    expect([at(no), no.judgements.at(-1)?.reason]).toEqual([['build', 'implement'], 'clear now']);
  });

  test('a check loop past its max stops at Needs you, back at the step it goes to (checks)', () => {
    const tight = plain({}, [
      {
        from: 'checks',
        to: 'implement',
        when: { check: 'checks.failed > 0' },
        carries: ['checks.output'],
        max: 1,
      },
    ]);
    const red: Move = { type: 'checks', green: false };
    const r = after([done('poke'), done('build'), red, done('build'), red], run(tight));

    expect([at(r), r.needsYou?.reason, r.carried?.items]).toEqual([
      ['build', 'implement'],
      'checks did not converge: back to implement 1 times',
      ['checks.output'],
    ]);
  });

  describe('gates (when:): a step runs only when its gate holds', () => {
    const gated = (when: unknown) => run(plain({}, [], [{ note: { skill: 'poke', when } }]));
    const toGate = [done('poke'), done('build'), { type: 'checks', green: true } as const];

    test('a judge gate waits for its one yes/no call, seeing only what it names', () => {
      const r = after(toGate, gated({ judge: 'Does it need a note?', sees: ['diff'] }));

      expect([at(r), r.judging]).toEqual([
        ['step', 'note'],
        {
          step: 'note',
          loop: null,
          kind: 'gate',
          question: 'Does it need a note?',
          sees: ['diff'],
          since: T(3),
        },
      ]);
      expect(step(r, done('note'), T(9))).toMatchObject({ ok: false, code: 'judge-first' });
    });

    test.each<[string, boolean, (string | null)[]]>([
      ['yes runs the step', true, ['step', 'note']],
      ['no skips it, on to the next', false, ['pr', 'pr']],
    ])('%s; the answer and its reason are a decision', (_, answer, where) => {
      const r = after(
        [...toGate, { type: 'judge', answer, reason: 'why' }],
        gated({ judge: 'Does it need a note?', sees: ['diff'] }),
      );

      expect([at(r), r.judgements.at(-1)]).toEqual([
        where,
        {
          step: 'note',
          loop: null,
          kind: 'gate',
          question: 'Does it need a note?',
          sees: ['diff'],
          at: T(4),
          answer,
          reason: 'why',
        },
      ]);
      // a skipped step was never worked, a gated one not yet: no visit of it
      expect(r.visits.some((v) => v.step === 'note')).toBe(false);
    });

    test.each<[string, string, (string | null)[]]>([
      ['a check gate holding runs it at once', 'seen > 0', ['step', 'note']],
      ['a check gate not holding skips it at once', 'seen > 5', ['pr', 'pr']],
    ])('%s, kept as a decision', (_, check, where) => {
      const r = after(
        [
          { type: 'stage-done', stage: 'poke', report: null, facts: { seen: 1 } },
          done('build'),
          { type: 'checks', green: true },
        ],
        gated({ check }),
      );

      expect([at(r), r.judging, r.judgements.at(-1)?.answer]).toEqual([
        where,
        null,
        where[0] === 'step',
      ]);
    });

    test("Feature's playbook: gated on the diff; yes writes it, its Playbook kept", () => {
      const reached = after([verify('after', 'pass')], inStage('verify'));
      const kept: PlaybookKept = {
        path: '.abe/playbooks/4.md',
        title: 'Sign in',
        doneWhen: 'signed in on prod',
        steps: [],
      };
      const yes = after([gate(true)], reached);
      const s = step(
        yes,
        { type: 'stage-done', stage: 'playbook', report: null, playbook: kept },
        T(40),
      );

      expect([reached.judging?.question, reached.judging?.sees]).toEqual([PLAYBOOK_GATE, ['diff']]);
      expect(s.ok && [s.run.stage, s.run.playbook]).toEqual(['pr', kept]);
    });
  });

  describe('ends: a step that ends the run with its report', () => {
    test("Bug: a bug that did not reproduce ends the run, reported, with reproduce's report", () => {
      const r = after(
        [verify('before', 'not-reproduced', [], undefined, true)],
        fresh(BUG_WORKFLOW),
      );

      expect([r.stage, r.outcome, r.reported, r.facts, r.needsYou]).toEqual([
        'done',
        'reported',
        {
          step: 'reproduce',
          report: '/w/.scratch/4/verify/before.md',
          at: T(1),
          done: false,
          spike: null,
        },
        { 'bug.reproduced': 0 },
        null,
      ]);
      expect(runData(r, 'ended').reported?.step).toBe('reproduce');
    });

    test.each<[string, Move, string, string | null]>([
      ['reproduced: on to build', verify('before', 'pass'), 'build', null],
      ['could not run: Needs you', verify('before', 'fail'), 'reproduce', BEFORE_FAILED],
      [
        'not reproduced with the browser never run: inconclusive, Needs you, no end',
        verify('before', 'not-reproduced', [], undefined, false),
        'reproduce',
        withoutBrowser(NOT_REPRODUCED),
      ],
      ['After in reproduce', verify('after', 'pass'), 'before-only-here', null],
    ])('Bug: %s', (_, move, want, reason) => {
      const s = step(fresh(BUG_WORKFLOW), move, T(1));

      expect(s.ok ? [s.run.stage, s.run.needsYou?.reason ?? null] : [s.code, null]).toEqual([
        want,
        reason,
      ]);
    });

    test('an ends with no condition: the step done ends the run with the report it named', () => {
      const r = after(
        [{ type: 'stage-done', stage: 'poke', report: '/s/1-poke.md' }],
        run(plain({ ends: { then: 'report' } })),
      );

      expect([r.outcome, r.reported?.report, r.visits.map((v) => v.step)]).toEqual([
        'reported',
        '/s/1-poke.md',
        ['poke'],
      ]);
      // an investigation answered: its card to Done
      expect(cardMoveOf(run(plain({ ends: { then: 'report' } })), r)).toBe('done');
    });

    test('an ends judge: yes ends with the report kept while it waited; no goes on', () => {
      const asked = after(
        [{ type: 'stage-done', stage: 'poke', report: '/s/1-poke.md' }],
        run(plain({ ends: { judge: 'Is it answered?', sees: ['card'], then: 'report' } })),
      );
      const yes = after([{ type: 'judge', answer: true, reason: 'cited' }], asked);
      const no = after([{ type: 'judge', answer: false, reason: 'needs code' }], asked);

      expect(asked.judging?.kind).toBe('ends');
      expect([yes.outcome, yes.reported?.report]).toEqual(['reported', '/s/1-poke.md']);
      expect([no.outcome, at(no)]).toEqual([null, ['build', 'implement']]);
    });
  });

  describe("fresh: what a step's subagent is given", () => {
    test.each<[string, Run, ReturnType<typeof stepContext>]>([
      [
        'the spec: not fresh, the card',
        fresh(),
        {
          step: 'create-specification',
          skill: 'create-specification',
          fresh: false,
          gets: ['card', 'earlier'],
          carried: null,
        },
      ],
      [
        'build first time (fresh on loop): not fresh',
        inStage('build'),
        {
          step: 'build',
          skill: 'implement',
          fresh: false,
          gets: ['card', 'spec', 'earlier'],
          carried: null,
        },
      ],
      [
        'review (fresh always): the card, the spec and the diff only',
        inStage('review'),
        {
          step: 'review',
          skill: 'code-review',
          fresh: true,
          gets: ['card', 'spec', 'diff'],
          carried: null,
        },
      ],
      ['done: none', doneRun(), null],
    ])('%s', (_, r, want) => {
      expect(stepContext(r)).toEqual(want);
    });

    test('build on a loop back: fresh, with only the findings carried; spent once it moves on', () => {
      const back = after([review(2, '/w/.scratch/4/review/1.md')], inStage('review'));
      const ctx = stepContext(back);
      const on = after([done('build')], back);

      expect(ctx).toEqual({
        step: 'build',
        skill: 'implement',
        fresh: true,
        gets: ['card', 'spec', 'diff', 'findings'],
        carried: {
          loop: '2',
          from: 'review',
          to: 'build',
          items: ['review.findings'],
          facts: { 'review.findings': 2 },
          at: T(1),
        },
      });
      expect([on.carried, stepContext(on)?.gets]).toEqual([
        null,
        ['card', 'spec', 'diff', 'earlier'],
      ]);
    });
  });

  describe('a loop back runs its step, gate or not: its carried items are its work', () => {
    /** The repo's Review PR: build gated on the audit's findings, a clean audit ends at verify. */
    const reviewPr = (): RunWorkflow => {
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
                  { audit: { skill: 'review-pr', reports: ['audit.findings'] } },
                  {
                    build: {
                      skill: 'implement',
                      fresh: 'loop',
                      when: { check: 'audit.findings > 0' },
                    },
                  },
                  'checks',
                  {
                    verify: {
                      skill: 'verify',
                      fresh: true,
                      ends: { check: 'audit.findings == 0', then: 'report' },
                    },
                  },
                  { review: { skill: 'code-review', fresh: true } },
                  { pr: { skill: 'pr', fresh: true } },
                ],
                loops: [
                  {
                    from: 'checks',
                    to: 'build',
                    when: { check: 'checks.failed > 0' },
                    carries: ['checks.output'],
                    max: 10,
                  },
                  {
                    from: 'verify',
                    to: 'build',
                    when: { check: 'criteria.failed > 0' },
                    carries: ['criterion', 'evidence'],
                    max: 10,
                  },
                ],
              },
            },
          },
        ],
        skills: [{ name: 'review-pr', layer: 'repo' }],
      }).workflows[0];

      if (!loaded?.ok) throw new Error(JSON.stringify(loaded?.problems ?? 'none'));

      return runWorkflowOf(loaded);
    };
    const audited = (findings: number): Move => ({
      type: 'stage-done',
      stage: 'audit',
      report: null,
      facts: { 'audit.findings': findings },
    });
    const red: Move = { type: 'checks', green: false };
    const green: Move = { type: 'checks', green: true };

    test('a clean audit skips build on its first pass; green and verified, its report ends it', () => {
      const r = after([audited(0)], run(reviewPr()));
      const ended = after([green, verify('after', 'pass')], r);

      expect([at(r), r.judgements.at(-1)?.reason]).toEqual([
        ['checks', 'checks'],
        'audit.findings > 0 does not hold: skipped',
      ]);
      expect([ended.outcome, ended.reported?.step]).toEqual(['reported', 'verify']);
    });

    test('a clean audit whose checks fail: build runs on the loop back, fresh, the output carried', () => {
      const r = after([audited(0), red], run(reviewPr()));

      expect([at(r), r.needsYou, r.looped, r.carried?.items, stepContext(r)?.fresh]).toEqual([
        ['build', 'build'],
        null,
        { '1': 1 },
        ['checks.output'],
        true,
      ]);
      expect(stepContext(r)?.gets).toContain('findings');
      // build done: on to checks as ever, green on to verify
      expect(at(after([done('build'), green], r))).toEqual(['verify', 'verify']);
    });

    test('a clean audit whose verify fails: build runs on the loop back with the criterion carried', () => {
      const r = after([audited(0), green, verify('after', 'fail')], run(reviewPr()));

      expect([at(r), r.needsYou, r.carried?.items]).toEqual([
        ['build', 'build'],
        null,
        ['criterion', 'evidence'],
      ]);
    });

    test('a gate skips its step only on its first pass: never a round with nothing built', () => {
      // each red check goes back to build, which runs; past max: Needs you, as ever
      const reds = Array.from({ length: 10 }, () => [red, done('build')]).flat();
      const r = after([audited(0), ...reds, red], run(reviewPr()));

      expect(r.visits.filter((v) => v.stage === 'build')).toHaveLength(10);
      expect(r.needsYou?.reason).toBe('checks did not converge: back to build 10 times');
    });
  });
});
