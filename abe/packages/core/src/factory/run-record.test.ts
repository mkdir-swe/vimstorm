/** Rule tables for the Run page's record (3.0 #21): the criteria, the verify report, the steps. */
import { describe, expect, test } from 'bun:test';
import {
  RUN_DONE,
  RUN_DONE_INPUTS,
  RUN_LIVE,
  RUN_LIVE_INPUTS,
  RUN_RECORD_DONE,
  RUN_RECORD_LIVE,
  RUN_VERIFY_HTML,
  RUN_VERIFY_REPORT,
  runAt,
} from '@abe/testing';
import {
  criteriaOf,
  type CriterionMark,
  type FactoryRunData,
  RunRecordData,
  runChangedOf,
  runRecordOf,
  runRecordText,
  runStepTitle,
  verifyHtmlOf,
  verifyReportOf,
  withProof,
  PROOF_LOCAL,
} from '../index';

describe('the acceptance criteria: one per line or item, the spec’s section first', () => {
  test.each([
    ['a markdown list', '- one\n- two\n', undefined, ['one', 'two']],
    ['task boxes and numbers', '1. one\n- [ ] two\n[x] three', undefined, ['one', 'two', 'three']],
    [
      'the board’s HTML',
      '<ul><li>one &amp; all</li><li>two</li></ul>',
      undefined,
      ['one & all', 'two'],
    ],
    ['plain lines, blanks left out', 'one\n\n  two  ', undefined, ['one', 'two']],
    [
      'the spec’s section over the card’s',
      '- card',
      '# T\n\n## Acceptance criteria\n\n- spec one\n- spec two\n\n## Out of scope\n\n- no',
      ['spec one', 'spec two'],
    ],
    ['a spec with no such section: the card’s', '- card', '## Why\n\nbecause', ['card']],
    ['none', '', null, []],
  ])('%s', (_, card, spec, want) => {
    expect(criteriaOf(card, spec)).toEqual(want);
  });
});

describe('the verify report read for its proof', () => {
  test('the demo: three steps, their how and seen, evidence, chapters, the recording', () => {
    const r = verifyReportOf(RUN_VERIFY_REPORT);

    expect(r.result).toBe('pass');
    expect(r.recording).toEqual({ path: 'verify/evidence/after.webm', length: '0:42' });
    expect(r.rows.map((x) => [x.n, x.how, x.seen, x.chapter, x.failed])).toEqual([
      [
        1,
        'API: ran .claude/skills/run-app/scripts/cart-total, asked for a cart of 3 mugs',
        'total 86.97',
        '0:03',
        false,
      ],
      [
        2,
        'Browser: set the mug to 3 on /cart',
        'the total reads 86.97 without a reload',
        '0:19',
        false,
      ],
      [
        3,
        'Browser: set the tote to 0, then read the cart from the API',
        'the tote is gone',
        '0:33',
        false,
      ],
    ]);
    expect(r.rows[0]?.evidence[0]?.kind).toBe('output');
    expect(r.rows[1]?.evidence).toEqual([
      { kind: 'screenshot', text: 'verify/evidence/after-2.png' },
    ]);
  });

  test.each([
    ['a step marked ✗', '1. ✓ a → b\n2. ✗ c → d\n\nResult: fail', [false, true]],
    [
      'the result naming the step',
      '1. a → b\n2. c → d\n\nResult: fail (step 2: the total was 36.99)',
      [false, true],
    ],
    ['a pass', '1. a → b\n2. c\n\nResult: pass', [false, false]],
  ])('%s', (_, text, failed) => {
    expect(verifyReportOf(text).rows.map((r) => r.failed)).toEqual(failed);
  });

  test('no steps: no rows, no result', () => {
    expect(verifyReportOf('# Verify after\n\nnothing')).toEqual({
      result: null,
      rows: [],
      recording: null,
    });
  });
});

describe('the last After pass’s features and HTML report', () => {
  test('a verdict per mapped feature, as its verification kept them, else from its report', () => {
    const kept = {
      ...RUN_DONE,
      verifications: RUN_DONE.verifications.map((v) => ({
        ...v,
        features: [
          { feature: 'cart', verdict: 'fail' as const, judged: 'x', why: null, evidence: [] },
        ],
      })),
    };

    expect(
      RUN_RECORD_DONE.features.map((f) => [f.feature, f.verdict, f.judged ?? f.why, f.evidence]),
    ).toEqual([
      [
        'cart',
        'pass',
        'the total read 86.97 for 3 mugs, price × quantity + shipping',
        [
          'verify/evidence/cart/before.png',
          'verify/evidence/cart/after.png',
          'verify/evidence/cart/drive.webm',
        ],
      ],
      [
        'checkout',
        'pass',
        'the summary shows shipping once',
        ['verify/evidence/checkout/summary.png', 'verify/evidence/checkout/drive.webm'],
      ],
      ['search', 'not-driven', 'the diff touches no search code.', []],
    ]);
    expect(runRecordOf({ ...RUN_DONE_INPUTS, run: kept }).features).toEqual(
      kept.verifications[0]?.features ?? [],
    );
    expect(RUN_RECORD_LIVE.features).toEqual([]);
  });

  test('its HTML report as the kit’s parts, what was stripped said; none: null', () => {
    expect(RUN_RECORD_DONE.report?.features.map((f) => [f.feature, f.verdict])).toEqual([
      ['cart', 'pass'],
      ['checkout', 'pass'],
      ['search', 'not-driven'],
    ]);
    expect(RUN_RECORD_DONE.report?.stripped).toEqual(['<script>', 'onerror on <img>']);
    expect(RunRecordData.parse(RUN_RECORD_DONE).report).toEqual(RUN_RECORD_DONE.report);
    expect(RUN_RECORD_LIVE.report).toBeNull();
  });
});

describe('the pull request’s proof rows: the Verify rows, once', () => {
  const report = verifyReportOf(RUN_VERIFY_REPORT);

  test('added after the body', () => {
    const body = withProof('**Verified:** after.\n\n## Notes\n\n- one\n', report);

    expect(body).toContain(
      '## Proof\n\n- ✓ 1. API: ran .claude/skills/run-app/scripts/cart-total, asked for a cart of 3 mugs → total 86.97 · ▶ 0:03\n',
    );
    // the evidence is git-ignored: named, never a link a GitHub reader can't open, and said so
    expect(body).toContain(
      '- ✓ 2. Browser: set the mug to 3 on /cart → the total reads 86.97 without a reload · `after-2.png` · ▶ 0:19',
    );
    expect(body).not.toContain('verify/evidence/');
    expect(body).toEndWith(`\n\n${PROOF_LOCAL}\n`);
    expect(withProof(body, report)).toBe(body);
  });

  test('no rows: the body as it is', () => {
    expect(withProof('x', verifyReportOf(''))).toBe('x');
  });

  test('where each feature was driven, from the HTML report, under the rows', () => {
    const body = withProof('**Verified:** after.\n', report, verifyHtmlOf(RUN_VERIFY_HTML));

    expect(body).toContain(
      [
        'Driven at:',
        '',
        '- `cart` · local · as `buyer` · `http://localhost:5173/cart`',
        '- `checkout` · local · as `buyer` · `http://localhost:5173/checkout`',
        '',
        PROOF_LOCAL,
      ].join('\n'),
    );
    // an older report names none: no Driven at
    expect(
      withProof(
        'x',
        report,
        verifyHtmlOf(RUN_VERIFY_HTML.replace(/ data-(?:url|account|env)="[^"]*"/g, '')),
      ),
    ).not.toContain('Driven at');
  });
});

describe('the steps: one per stage visit, the person’s beside them', () => {
  const titles = (d: RunRecordData) => {
    const loops = (s: RunRecordData['steps'][number]) =>
      d.steps.filter((x) => x.stage === s.stage && x.kind === 'stage').length;

    return d.steps.map(
      (s) =>
        `${s.mark} ${runStepTitle(s, loops(s))}${s.decision ? ' ◆' : ''}${s.live ? ' live' : ''}: ${s.headline}`,
    );
  };

  test('live in Build #2 after a red Checks', () => {
    expect(RunRecordData.parse(RUN_RECORD_LIVE)).toEqual(RUN_RECORD_LIVE);
    expect(titles(RUN_RECORD_LIVE)).toEqual([
      'ok Spec ◆: 2 questions answered · Spec written: mkdir-swe/demo-shop#41',
      'ok Build #1 ◆: 2 files changed',
      'failed Checks: Checks failed: back to Build',
      'running Build #2 live: Building',
    ]);
  });

  test('done: the loops counted, a review finding, Verify 3 of 3, the merge', () => {
    expect(titles(RUN_RECORD_DONE)).toEqual([
      'ok Spec ◆: 2 questions answered · Spec written: mkdir-swe/demo-shop#41',
      'ok Build #1 ◆: 2 files changed',
      'failed Checks #1: Checks failed: back to Build',
      'ok Build #2: 1 file changed',
      'ok Checks #2: Checks passed',
      'failed Review #1 ◆: 1 finding: back to Build',
      'ok Build #3 ◆: 1 file changed',
      'ok Checks #3: Checks passed',
      'ok Review #2: No findings',
      'ok Verify: 3 of 3 criteria pass',
      'ok PR: Pull request #57 merged',
      'ok Merge ◆: Merged',
    ]);
    expect(
      RUN_RECORD_DONE.steps.flatMap((s) =>
        s.skills.length === 0 && !s.subagent
          ? []
          : [`${s.id}${s.subagent ? ' subagent' : ''}: ${s.skills.join(' ')}`],
      ),
    ).toEqual([
      'spec:1 subagent: create-specification',
      'build:1 subagent: implement tdd',
      'review:1 subagent: code-review',
      'verify:1 subagent: verify-demo-shop',
      'pr:1: pr',
    ]);
    // a step's summary not written yet (live Checks) is told apart from one written
    expect(RUN_RECORD_LIVE.steps.map((s) => s.summarised)).toEqual([true, true, false, false]);
    expect(RUN_RECORD_DONE.source).toBe('record');
    expect(RUN_RECORD_DONE.recording).toEqual({
      path: 'verify/evidence/after.webm',
      length: '0:42',
    });
  });

  test('a step’s files (relative, each once), commands with results, answers, its Chat point', () => {
    const build = RUN_RECORD_LIVE.steps.find((s) => s.id === 'build:1');
    const checks = RUN_RECORD_LIVE.steps.find((s) => s.id === 'checks:1');
    const grill = RUN_RECORD_LIVE.steps.find((s) => s.id === 'spec:1');

    expect(build?.files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ['api/src/cart.ts', 6, 2],
      ['api/test/cart.test.ts', 24, 0],
    ]);
    expect(build?.commands).toEqual([{ command: 'npm test', ok: true, result: '18 passed' }]);
    expect(build?.chat).toBe('a4');
    expect(checks?.commands.map((c) => [c.command, c.ok])).toEqual([
      ['npm run lint', false],
      ['npm run typecheck', true],
    ]);
    expect(grill?.answers.map((a) => [a.question, a.answer])).toEqual([
      ['Round each line, or only the total?', 'Each line, two decimals, then sum.'],
      ['A line set to 0: keep it at 0 or drop it?', 'Drop it.'],
    ]);
  });

  const ran = (o: Partial<FactoryRunData>) =>
    runRecordOf({ ...RUN_LIVE_INPUTS, run: { ...RUN_LIVE, ...o } });

  test.each([
    [
      'waiting on you: a Needs you step, live',
      { state: 'needs-you' as const, reason: 'which account?', needsYouSince: runAt(20) },
      'needs-you',
      'which account?',
    ],
    [
      'ended by a person',
      {
        stage: 'done' as const,
        state: 'done' as const,
        outcome: 'abandoned' as const,
        ended: {
          as: 'abandoned' as const,
          reason: 'not needed',
          at: runAt(20),
          from: 'build' as const,
        },
      },
      'ended',
      'Abandoned: not needed',
    ],
  ])('%s', (_, o, id, headline) => {
    const step = ran(o).steps.find((s) => s.id === id);

    expect(step).toMatchObject({ decision: true, headline });
  });

  test('no transcript (it could not be read): the steps still, with nothing in them', () => {
    const d = runRecordOf({ ...RUN_DONE_INPUTS, entries: [] });

    expect(d.steps).toHaveLength(RUN_RECORD_DONE.steps.length);
    expect(d.steps.every((s) => s.files.length === 0 && s.chat === null)).toBe(true);
  });
});

describe('what the pull request carries: the worktree against its merge base', () => {
  const file = (path: string, lines: readonly string[]) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,3 @@',
    ...lines,
  ];

  test.each([
    ['nothing', [], { files: 0, added: 0, removed: 0 }],
    [
      'each file once, its lines; a line reading `++` or `--` still a line',
      [
        ...file('web/src/ProductList.tsx', ['-<h2>Products</h2>', '+<h2>{n}</h2>', '+++x']),
        ...file('eslint.config.js', ['-  ignores: [],', '+  ignores: [".claude/skills/**"],']),
      ],
      { files: 2, added: 3, removed: 2 },
    ],
    [
      'the run’s .scratch/ evidence left out; a binary file with no lines',
      [
        ...file('.scratch/1/drive.cjs', ['+a', '+b']),
        ...file('web/.scratch/x.md', ['+a']),
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
      ],
      { files: 1, added: 0, removed: 0 },
    ],
  ])('%s', (_, lines, want) => {
    expect(runChangedOf(lines.join('\n'))).toEqual(want);
    expect(runRecordOf({ ...RUN_DONE_INPUTS, changed: want }).changed).toEqual(want);
  });

  test('a new file the worktree recipe linked or copied in is left out; one it changed counts', () => {
    const added = (path: string, mode = '100644') => [
      `diff --git a/${path} b/${path}`,
      `new file mode ${mode}`,
      '--- /dev/null',
      `+++ b/${path}`,
      '@@ -0,0 +1 @@',
      '+X=1',
    ];
    const patch = [
      ...added('api/.env.local'),
      ...added('fixtures/seed/a.json', '120000'),
      ...added('api/src/live.ts'),
      ...file('api/.env.example', ['+Y=2']),
    ].join('\n');

    expect(runChangedOf(patch, ['api/.env.local', 'fixtures/seed/', 'api/.env.example'])).toEqual({
      files: 2,
      added: 2,
      removed: 0,
    });
  });
});

describe('a criterion’s mark from the last After verification', () => {
  const marks = (run: FactoryRunData, verify: string | null): CriterionMark[] =>
    runRecordOf({ ...RUN_DONE_INPUTS, run, verify }).criteria.map((c) => c.mark);
  const after = (result: 'pass' | 'fail') => ({
    at: runAt(33),
    phase: 'after' as const,
    result,
    report: 'r',
    regression: [],
  });

  test.each<[string, FactoryRunData, string | null, CriterionMark[]]>([
    ['none yet', RUN_LIVE, null, ['todo', 'todo', 'todo']],
    [
      'being verified now',
      { ...RUN_LIVE, stage: 'verify', since: runAt(29) },
      null,
      ['checking', 'checking', 'checking'],
    ],
    ['passed', RUN_DONE, RUN_VERIFY_REPORT, ['pass', 'pass', 'pass']],
    ['passed, the report unreadable', RUN_DONE, null, ['pass', 'pass', 'pass']],
    [
      'failed at step 2',
      { ...RUN_DONE, verifications: [after('fail')] },
      '1. a → b\n2. c → d\n3. e → f\n\nResult: fail (step 2)',
      ['pass', 'fail', 'pass'],
    ],
    [
      'failed, the report unreadable',
      { ...RUN_DONE, verifications: [after('fail')] },
      null,
      ['todo', 'todo', 'todo'],
    ],
  ])('%s', (_, run, verify, want) => {
    expect(marks(run, verify)).toEqual(want);
  });
});

test('the text form', () => {
  expect(runRecordText(RUN_RECORD_LIVE).split('\n').slice(0, 2)).toEqual([
    'Run · #2 The cart total ignores quantity',
    '  ✓ Spec       2 questions answered · Spec written: mkdir-swe/demo-shop#41 ◆',
  ]);
  const workflow = { id: 'quick-fix', name: 'Quick fix', layer: 'repo' as const, steps: [] };

  // the workflow it runs, by name and source
  expect(
    runRecordText({ ...RUN_RECORD_LIVE, run: { ...RUN_RECORD_LIVE.run, workflow } }).split('\n')[0],
  ).toBe('Run · #2 The cart total ignores quantity · Quick fix (repo)');
});
