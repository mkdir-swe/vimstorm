/**
 * The Run page's demo, as boards R-Live to R-Narrow draw it. It is card 2, "The cart total ignores
 * quantity" on demo-shop, as `abe factory record 2` reads it. It has the run, its session's
 * transcript, the After report in the verify skill's form, the card's criteria and the spec issue.
 * The run is live in its second Build after a red Checks, or done: Build ×3, a review finding,
 * Verify 3 of 3, merged. Core's, serve's and the screen's tests and the contract trees all read it.
 */
import {
  type BuildLane,
  type ChecksKept,
  type CheckResult,
  type FactoryRunData,
  type MadeKept,
  type PlaybookKept,
  type RunCard,
  type RunBrief,
  Run,
  type FilePatch,
  type RunRecordData,
  type RunRecordInputs,
  runRecordOf,
  type RunSpec,
  type StepSummary,
  type TranscriptEntry,
  verifyHtmlOf,
} from '@abe/core';
import { FEATURE_FLOW } from '@abe/core/run-flow';
import { type Node, runScreen } from '@abe/ui';
import { type Drive, driveScreen, type Replies } from './screen-driver';
import { factoryRun } from './ui';

export const RUN_CARD = 2;
export const RUN_TITLE = 'The cart total ignores quantity';
export const RUN_SESSION = '2-a1b2';
export const RUN_WORKTREE = '/home/me/projects/demo-shop-wt/2-the-cart-total-ignores-quantity';
export const RUN_BRANCH = 'card/2-the-cart-total-ignores-quantity';

/** 09:00 on the demo's day, and `m` minutes after. */
export const RUN_T0 = Date.parse('2026-10-26T09:00:00.000Z');
export const runAt = (m: number) => new Date(RUN_T0 + m * 60_000).toISOString();

export const RUN_CRITERIA = [
  "- A line's total is its price × quantity",
  '- Changing a quantity updates the total at once',
  '- A line set to quantity 0 leaves the cart',
].join('\n');

export const RUN_SPEC: RunSpec = {
  ref: 'mkdir-swe/demo-shop#41',
  url: 'https://github.com/mkdir-swe/demo-shop/issues/41',
  title: "Cart total counts each line's quantity",
  body: [
    '## Why',
    '',
    'A cart with 3 mugs charges for one. The total sums prices and ignores quantity.',
    '',
    '## What',
    '',
    "- a line's total is price × quantity, rounded to two decimals per line",
    '- the cart total is the sum of the lines, in cents',
    '- a line at quantity 0 is removed',
    '',
    '## Acceptance criteria',
    '',
    "- A line's total is its price × quantity",
    '- Changing a quantity updates the total at once',
    '- A line set to quantity 0 leaves the cart',
    '',
    '## Out of scope',
    '',
    'Shipping and discounts (AB#7).',
  ].join('\n'),
};

/** The After report, in the verify skill's form: one step per criterion, its proof under it. */
export const RUN_VERIFY_REPORT = [
  '# Verify after: AB#2 The cart total ignores quantity',
  '',
  'Level: After · card/2-the-cart-total-ignores-quantity 2a23e58 · Risky: no',
  '',
  '1. API: ran .claude/skills/run-app/scripts/cart-total, asked for a cart of 3 mugs → total 86.97 · ▶ 0:03',
  '```',
  'GET /api/cart/c-17',
  '← 200 {"lines":[{"sku":"mug","qty":3,"total":74.97}],"total":86.97}',
  '```',
  '2. Browser: set the mug to 3 on /cart → the total reads 86.97 without a reload · verify/evidence/after-2.png · ▶ 0:19',
  '3. Browser: set the tote to 0, then read the cart from the API → the tote is gone · verify/evidence/after-3.png · ▶ 0:33',
  '',
  'Result: pass',
  'Recording: verify/evidence/after.webm · 0:42',
  '',
  '## Features',
  '',
  '- `cart` pass. Judged by: the total read 86.97 for 3 mugs, price × quantity + shipping. Evidence: verify/evidence/cart/before.png, verify/evidence/cart/after.png, verify/evidence/cart/drive.webm. Where: local · http://localhost:5173/cart · as buyer',
  '- `checkout` pass. Judged by: the summary shows shipping once. Evidence: verify/evidence/checkout/summary.png, verify/evidence/checkout/drive.webm. Where: local · http://localhost:5173/checkout · as buyer',
  '- `search` not driven. Why: the diff touches no search code.',
].join('\n');

/**
 * The After pass's HTML report from the verify kit, as the agent wrote it: a script and a handler
 * serve strips, the rest kept.
 */
export const RUN_VERIFY_HTML = [
  '<script>alert(1)</script>',
  '<section class="ab-verify-feature" data-feature="cart" data-verdict="pass" data-env="local">',
  '  <h4 class="ab-verify-head">Cart total follows quantity</h4>',
  '  <div class="ab-verify-pair">',
  '    <figure class="ab-verify-shot" data-url="http://localhost:5173/cart" data-account="buyer"><img src="verify/evidence/cart/before.png" alt="The cart on main" onerror="alert(2)"><figcaption>Before, on main: three mugs, the total counts one.</figcaption></figure>',
  '    <figure class="ab-verify-shot" data-url="http://localhost:5173/cart" data-account="buyer"><img src="verify/evidence/cart/after.png" alt="The cart on this branch"><figcaption>After, this branch: 86.97.</figcaption></figure>',
  '  </div>',
  '  <figure class="ab-verify-recording" data-url="http://localhost:5173/cart" data-account="buyer">',
  '    <video src="verify/evidence/cart/drive.webm" poster="verify/evidence/cart/after.png"></video>',
  '    <img src="verify/evidence/cart/drive.gif" alt="">',
  '    <figcaption>Playwright raises the quantity 1 → 3; the total follows.</figcaption>',
  '  </figure>',
  '  <div class="ab-verify-judged">Read the total from the page after each change: <code>86.97</code> equals price × quantity + shipping.</div>',
  '</section>',
  '<section class="ab-verify-feature" data-feature="checkout" data-verdict="pass" data-env="local">',
  '  <h4 class="ab-verify-head">Shipping added once</h4>',
  '  <figure class="ab-verify-shot" data-url="http://localhost:5173/checkout" data-account="buyer"><img src="verify/evidence/checkout/summary.png" alt="The order summary"></figure>',
  '  <figure class="ab-verify-recording" data-url="http://localhost:5173/checkout" data-account="buyer"><video src="verify/evidence/checkout/drive.webm"></video></figure>',
  '  <div class="ab-verify-judged">Checkout with two products: shipping shows once.</div>',
  '</section>',
  '<section class="ab-verify-feature" data-feature="search" data-verdict="not-driven">',
  '  <h4 class="ab-verify-head">Search</h4>',
  '  <p class="ab-verify-not-driven">The diff touches no search code.</p>',
  '</section>',
].join('\n');

const W = (path: string) => `${RUN_WORKTREE}/${path}`;

const patch = (path: string, added: number, removed: number): FilePatch => ({
  path: W(path),
  created: false,
  added,
  removed,
  hunks: [
    {
      oldStart: 12,
      oldLines: removed + 1,
      newStart: 12,
      newLines: added + 1,
      lines: [
        ' export const cartTotal = (lines: Line[]) =>',
        ...Array.from({ length: removed }, (_, i) => `-  old line ${i + 1}`),
        ...Array.from({ length: added }, (_, i) => `+  new line ${i + 1}`),
      ],
    },
  ],
  cut: 0,
});

const user = (id: string, m: number, text: string): TranscriptEntry => ({
  kind: 'user',
  id,
  at: runAt(m),
  agent: null,
  text,
  context: null,
});
const said = (id: string, m: number, text: string): TranscriptEntry => ({
  kind: 'assistant-text',
  id,
  at: runAt(m),
  agent: null,
  text,
});
const ran = (
  id: string,
  m: number,
  command: string,
  ok: boolean,
  out: string,
): TranscriptEntry[] => [
  { kind: 'tool-use', id, at: runAt(m), agent: null, tool: 'Bash', input: { command } },
  { kind: 'tool-result', id, at: runAt(m + 0.2), agent: null, ok, text: out, cut: 0, patch: null },
];
const edited = (id: string, m: number, p: FilePatch): TranscriptEntry[] => [
  {
    kind: 'tool-use',
    id,
    at: runAt(m),
    agent: null,
    tool: 'Edit',
    input: { file_path: p.path, old_string: 'a', new_string: 'b' },
  },
  {
    kind: 'tool-result',
    id,
    at: runAt(m + 0.1),
    agent: null,
    ok: true,
    text: '',
    cut: 0,
    patch: p,
  },
];

/** A Skill call, by the session or a stage's subagent (`agent`). */
const skill = (
  id: string,
  m: number,
  name: string,
  agent: string | null = null,
): TranscriptEntry => ({
  kind: 'tool-use',
  id,
  at: runAt(m),
  agent,
  tool: 'Skill',
  input: { skill: name },
});

/** The session's transcript up to the second Build (live), then on to the merge (done). */
const LIVE_ENTRIES: TranscriptEntry[] = [
  user('u1', 2, 'Work on card AB#2: The cart total ignores quantity'),
  said(
    'a1',
    2.5,
    'A bug with steps to reproduce and three criteria; one module (api/src/cart.ts). Size S.',
  ),
  skill('k1', 3.1, 'create-specification'),
  said('a2', 3.2, 'Two questions before the spec.'),
  user(
    'u2',
    8,
    'Answer to "Round each line, or only the total?": Each line, two decimals, then sum.',
  ),
  user('u3', 8.5, 'Answer to "A line set to 0: keep it at 0 or drop it?": Drop it.'),
  skill('k2', 9.5, 'create-specification', 'spec-agent'),
  said('a3', 10, '3 acceptance criteria, the repro as a test, out of scope: shipping.'),
  skill('k3', 11.2, 'implement', 'build-agent'),
  skill('k4', 11.3, 'tdd', 'build-agent'),
  said('a4', 11.5, 'A failing test for the repro first, then the fix in cartTotal.'),
  ...edited('e1', 12, patch('api/src/cart.ts', 6, 2)),
  ...edited('e2', 13, patch('api/test/cart.test.ts', 24, 0)),
  ...ran('b1', 15, 'npm test -w api', true, 'Tests: 18 passed'),
  said('a5', 16, 'Line total = price × quantity; the API tests pass.'),
  ...ran(
    'c1',
    17.2,
    'npm run lint',
    false,
    "web/src/Cart.tsx:3 'formatPrice' is defined but never used\n1 error",
  ),
  ...ran('c2', 17.5, 'npm run typecheck', true, ''),
  said('a6', 17.8, "web/src/Cart.tsx:3 'formatPrice' is defined but never used (no-unused-vars)."),
  said('a7', 19, 'Fixing the lint error: removing the unused formatPrice import.'),
  ...edited('e3', 20, patch('web/src/Cart.tsx', 3, 4)),
];

const DONE_ENTRIES: TranscriptEntry[] = [
  ...LIVE_ENTRIES,
  said('a8', 21.2, 'Lint is clean; checks green.'),
  skill('k5', 22, 'code-review', 'review-agent'),
  said(
    'a9',
    23,
    'api/src/cart.ts:14 sums floats: 3 × 24.99 gives 74.97000000000001. Sum in cents.',
  ),
  ...edited('e4', 25, patch('api/src/cart.ts', 4, 3)),
  said('a10', 26, 'Summed in cents, a test for 3 × 24.99 added.'),
  skill('k6', 29.5, 'verify-demo-shop', 'verify-agent'),
  said(
    'a11',
    30,
    'Ran the app seeded, checked each criterion in the browser and the API. Recording 0:42.',
  ),
  skill('k7', 35, 'pr'),
  said('a12', 36, 'Pull request #57 open: the proof is in its body.'),
];

/** A Step summary written as the step ended: the fast model's, or serve's for Checks. */
const summed = (
  to: number,
  text: string,
  o: Partial<Pick<StepSummary, 'decisions' | 'evidence' | 'by'>> = {},
): StepSummary => ({
  text,
  decisions: o.decisions ?? [],
  evidence: o.evidence ?? [],
  by: o.by ?? 'model',
  at: runAt(to + 0.5),
});

const visit = (
  stage: FactoryRunData['stage'],
  from: number,
  to: number,
  summary?: (to: number) => StepSummary,
) => ({
  stage,
  startedAt: runAt(from),
  endedAt: runAt(to),
  durationMs: (to - from) * 60_000,
  report: null,
  ...(summary === undefined ? {} : { summary: summary(to) }),
});

/** Card 2's Run brief, written as Grill ended. */
export const RUN_BRIEF: RunBrief = {
  what: "Make the cart total count each line's quantity.",
  why: 'A cart with 3 mugs charges for one: the total sums prices and ignores quantity.',
  plan: 'Fix cartTotal(), where every total comes from, with the repro as a failing test first; then check each criterion on the local app.',
  doneWhen:
    "A line's total is price × quantity, a changed quantity updates the total at once, and a line at 0 leaves the cart.",
  source: {
    card: RUN_CARD,
    grill: null,
    answers: [
      {
        question: 'Round each line, or only the total?',
        answer: 'Each line, two decimals, then sum.',
      },
      { question: 'A line set to 0: keep it at 0 or drop it?', answer: 'Drop it.' },
    ],
  },
  at: runAt(9),
};

const LIVE_DONE_STAGES = [
  visit('spec', 2, 11, (to) =>
    summed(
      to,
      'Each line rounds to two decimals, then the lines sum; a line at 0 leaves the cart. Spec #41: three criteria and the repro as a test; shipping and discounts out.',
      {
        decisions: [
          {
            chose: 'Asked how lines round',
            over: 'guessing from the code',
            why: 'The card does not say how lines round or what a line at 0 does.',
          },
        ],
      },
    ),
  ),
  visit('build', 11, 17, (to) =>
    summed(to, 'cartTotal() multiplies price by quantity; the repro test went red, then green.', {
      decisions: [
        {
          chose: 'Fix cartTotal()',
          over: 'summing on the cart page',
          why: 'The API, the cart page and the order email all read it.',
        },
        {
          chose: 'Round each line, then sum',
          over: 'rounding only the total',
          why: 'The spec says two decimals per line.',
        },
      ],
    }),
  ),
];

/** Live: Checks' summary not written yet. */
const LIVE_STAGES = [...LIVE_DONE_STAGES, visit('checks', 17, 18)];

/** Card 2 live. Its second Build has run since 09:18, after Checks sent it back. */
export const RUN_LIVE: FactoryRunData = factoryRun(RUN_CARD, RUN_TITLE, 'build', 'running', {
  session: RUN_SESSION,
  worktree: RUN_WORKTREE,
  startedAt: runAt(2),
  since: runAt(18),
  brief: RUN_BRIEF,
  stages: LIVE_STAGES,
});

/** Feature's loops as a run carries them (its workflow's view). */
const FEATURE_LOOPS = [
  {
    id: 'checks-build',
    from: 'checks',
    to: 'build',
    when: 'checks.failed > 0',
    max: 10,
    carries: ['checks.output'],
  },
  {
    id: 'review-build',
    from: 'review',
    to: 'build',
    when: 'review.findings > 0',
    max: 2,
    carries: ['review.findings'],
  },
  {
    id: 'verify-build',
    from: 'verify',
    to: 'build',
    when: 'criteria.failed > 0',
    max: 10,
    carries: ['criterion', 'evidence'],
  },
];

const check = (
  name: string,
  run: string | null,
  status: CheckResult['status'],
  s: number,
  output: string,
): CheckResult => ({
  name,
  kind: run === null ? 'built-in' : 'command',
  run,
  status,
  exit: run === null ? null : Number(status === 'red'),
  durationMs: s * 1000,
  output,
});

/** A run of card 2's checks: lint red or green, the rest green, with the env's names. */
const checksAt = (
  m: number,
  lint: 'red' | 'green',
  tests: number,
  cause: ChecksKept['cause'] = 'checks',
): ChecksKept => ({
  at: runAt(m),
  cause,
  verdict: lint === 'red' ? 'red' : 'green',
  env: { name: 'dev', keys: ['CI', 'DATABASE_URL', 'HOME', 'PATH', 'TMPDIR', 'USER'] },
  file: '.scratch/2/checks.md',
  results: [
    check('types', 'npm run typecheck', 'green', 38, ''),
    check(
      'lint',
      'npm run lint',
      lint,
      12,
      lint === 'red'
        ? "web/src/Cart.tsx\n  3:10  error  'formatPrice' is defined but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)"
        : '',
    ),
    check('tests', 'npm test', 'green', 100, `Tests: ${tests} passed, ${tests} total`),
    check('no-deleted-tests', null, 'green', 0, 'no test file deleted\n'),
    check('no-new-suppressions', null, 'green', 0, 'no suppression added\n'),
  ],
});

/** Card 2's checks: the first run red on lint, then green twice; build 1 ran them itself. */
export const RUN_CHECKS: ChecksKept[] = [
  checksAt(16.5, 'red', 18, 'on-demand'),
  checksAt(18, 'red', 18),
  checksAt(21.5, 'green', 18),
  checksAt(28, 'green', 19),
];

const lane = (o: Partial<BuildLane> & { title: string }): BuildLane => ({
  ticket: null,
  ref: null,
  label: '',
  wave: 1,
  writer: 'abe:writer',
  worktree: null,
  commits: [],
  files: null,
  areas: [],
  tests: [],
  tookMs: null,
  merged: true,
  ...o,
});

/** What card 2's builds made: two slices, then a round of fixes for lint, then for the review. */
export const RUN_MADE: MadeKept[] = [
  {
    step: 'build',
    at: runAt(17),
    made: {
      kind: 'build',
      lanes: [
        lane({
          label: 'slice 1',
          title: 'Line total is price × quantity',
          worktree: '2-s1',
          commits: [{ sha: '7b1c0de', subject: 'Cart: a line’s total is price × quantity' }],
          files: { count: 2, added: 30, removed: 2 },
          areas: ['api/src/cart'],
          tests: [
            { name: 'typecheck', ok: true, count: null },
            { name: 'api/test/cart.test.ts', ok: true, count: 4 },
          ],
          tookMs: 240_000,
        }),
        lane({
          label: 'slice 2',
          title: 'A line at 0 leaves the cart',
          worktree: '2-s2',
          commits: [{ sha: '8c2d1ef', subject: 'Cart: drop a line set to 0' }],
          files: { count: 1, added: 9, removed: 4 },
          areas: ['web/src/Cart'],
          tests: [
            { name: 'typecheck', ok: true, count: null },
            { name: 'web/test/cart.test.tsx', ok: true, count: 2 },
          ],
          tookMs: 180_000,
        }),
      ],
      milestones: [
        {
          n: 1,
          afterWave: 1,
          text: 'A cart totals each line’s quantity',
          tests: [{ name: 'full suite', ok: true, count: 18 }],
          looked: 'cart of 3 mugs reads 74.97',
        },
      ],
    },
  },
  {
    step: 'build',
    at: runAt(21),
    made: {
      kind: 'build',
      lanes: [
        lane({
          label: 'lint',
          title: 'Unused import in the cart page',
          commits: [{ sha: '9c4d1e2', subject: 'Cart page: drop the unused formatPrice' }],
          files: { count: 1, added: 0, removed: 1 },
          areas: ['web/src/Cart'],
          tests: [{ name: 'typecheck', ok: true, count: null }],
          tookMs: 120_000,
        }),
      ],
      milestones: [],
    },
  },
  {
    step: 'build',
    at: runAt(27),
    made: {
      kind: 'build',
      lanes: [
        lane({
          label: 'finding 1',
          title: 'Review round 1',
          worktree: '2-fix1',
          commits: [{ sha: 'f6b2d09', subject: 'Cart: sum in cents' }],
          files: { count: 2, added: 14, removed: 3 },
          areas: ['api/src/cart'],
          tests: [
            { name: 'typecheck', ok: true, count: null },
            { name: 'api/test/cart.test.ts', ok: true, count: 5 },
          ],
          tookMs: 180_000,
        }),
      ],
      milestones: [],
    },
  },
];

/** Card 2's commits since the merge base, oldest first. */
export const RUN_COMMITS = [
  { sha: '7b1c0de', subject: 'Cart: a line’s total is price × quantity' },
  { sha: '8c2d1ef', subject: 'Cart: drop a line set to 0' },
  { sha: '9c4d1e2', subject: 'Cart page: drop the unused formatPrice' },
  { sha: 'f6b2d09', subject: 'Cart: sum in cents' },
];

/** Card 2 as the board has it. */
export const RUN_CARD_DETAIL: RunCard = {
  type: 'Bug',
  state: 'Active',
  tags: [],
  text: 'A cart with 3 mugs charges for one. Add 3 mugs, open the cart: the total is 24.99, expected 74.97.',
  criteria: [
    "A line's total is its price × quantity",
    'Changing a quantity updates the total at once',
    'A line set to quantity 0 leaves the cart',
  ],
  url: 'https://dev.azure.com/demo-org/demo-shop/_workitems/edit/2',
};

/** The pull request's body as serve sent it. */
export const RUN_PR_BODY = [
  'Card: AB#2',
  '',
  '## Summary',
  '',
  "The cart total counts each line's quantity; a line at 0 leaves the cart.",
  '',
  '**Verified:** After: cart and checkout driven on the local app; 3 of 3 criteria seen.',
  '',
  '## Notes',
  '',
  '- Summed in cents: floats drift at three items.',
  '- Each line rounds to two decimals, then the lines sum.',
  '',
  'Closes #41',
].join('\n');

/** Card 2 done: three builds, a review finding, Verify 3 of 3, merged by you, deployed to test. */
export const RUN_DONE: FactoryRunData = factoryRun(RUN_CARD, RUN_TITLE, 'done', 'done', {
  session: RUN_SESSION,
  worktree: RUN_WORKTREE,
  startedAt: runAt(2),
  since: runAt(41),
  brief: RUN_BRIEF,
  stages: [
    ...LIVE_DONE_STAGES,
    visit('checks', 17, 18, (to) =>
      summed(to, 'Lint failed: web/src/Cart.tsx imports formatPrice and never uses it.', {
        by: 'serve',
        evidence: ['.scratch/2/checks/1.log'],
      }),
    ),
    visit('build', 18, 21, (to) => summed(to, 'Dropped the unused import.')),
    visit('checks', 21, 21.5, (to) =>
      summed(to, 'Lint, types and 18 tests pass.', {
        by: 'serve',
        evidence: ['.scratch/2/checks/2.log'],
      }),
    ),
    visit('review', 21.5, 24, (to) =>
      summed(to, 'One finding: 3 × 24.99 sums to 74.97000000000001 in floats.', {
        evidence: ['.scratch/2/review/1.md'],
      }),
    ),
    visit('build', 24, 27, (to) =>
      summed(to, 'Summed in cents; a test for 3 × 24.99 added.', {
        decisions: [
          {
            chose: 'Sum in cents',
            over: 'rounding the float total',
            why: 'Floats drift at three items; cents add exactly.',
          },
          {
            chose: 'One test per criterion',
            over: 'one end-to-end test',
            why: 'A failure names the criterion it breaks.',
          },
          {
            chose: 'Format on the page',
            over: 'formatting in cartTotal()',
            why: 'The API returns numbers; only the page formats them.',
          },
        ],
      }),
    ),
    visit('checks', 27, 28, (to) =>
      summed(to, 'Lint, types and 19 tests pass.', {
        by: 'serve',
        evidence: ['.scratch/2/checks/3.log'],
      }),
    ),
    visit('review', 28, 29, (to) => summed(to, 'No findings.')),
    visit('verify', 29, 34, (to) =>
      summed(to, '3 of 3 criteria pass on the local app; recording 0:42.', {
        evidence: [
          '.scratch/2/verify/1-after.md',
          'verify/evidence/after-2.png',
          'verify/evidence/after-3.png',
          'verify/evidence/after.webm',
        ],
      }),
    ),
    visit('pr', 34, 41, (to) => summed(to, 'Pull request #57 with the proof in its body.')),
  ],
  reviews: [
    {
      at: runAt(23.5),
      findings: 1,
      round: 1,
      report: '.scratch/2/review/1.md',
      regression: [],
      items: [
        {
          id: 'F1',
          axis: 'standards',
          file: 'api/src/cart.ts',
          line: 14,
          text: 'The total sums floats: 3 × 24.99 gives 74.97000000000001',
          fix: 'sum in cents, then divide once',
          severity: 'must',
        },
        {
          id: 'N1',
          axis: 'standards',
          file: 'web/src/Cart.tsx',
          line: 40,
          text: 'Possible Mysterious Name: `s` for the shipping line',
          fix: 'rename to `shipping` when next touched',
          severity: 'noted',
        },
      ],
      risk: { risky: true, why: 'money: the cart total' },
    },
    {
      at: runAt(28.5),
      findings: 0,
      round: 0,
      report: '.scratch/2/review/2.md',
      regression: ['api/test/cart.test.ts'],
      items: [],
      earlier: [{ id: 'F1', fixed: true }],
      risk: { risky: true, why: 'money: the cart total' },
    },
  ],
  checks: RUN_CHECKS,
  made: RUN_MADE,
  workflow: {
    id: 'feature',
    name: 'Feature',
    layer: 'built-in',
    steps: [...FEATURE_FLOW],
    loops: FEATURE_LOOPS,
  },
  verifications: [
    {
      at: runAt(33.5),
      phase: 'after',
      result: 'pass',
      report: `${RUN_WORKTREE}/.scratch/2/verify/1-after.md`,
      regression: [],
      html: `${RUN_WORKTREE}/.scratch/2/verify/1-after.html`,
    },
  ],
  pr: {
    repo: 'mkdir-swe/demo-shop',
    number: 57,
    url: 'https://github.com/mkdir-swe/demo-shop/pull/57',
    title: 'AB#2 Count each line’s quantity in the cart total',
    state: 'merged',
    merge: 'person',
    checks: 'success',
    mergeCommit: '9f1c2d3',
    deploy: 'success',
    branch: null,
    head: RUN_BRANCH,
    base: 'main',
    headSha: 'f6b2d09',
    mergeable: 'mergeable',
    mergeFailed: null,
    reviewers: [{ login: 'demo-reviewer', state: 'approved' }],
    body: RUN_PR_BODY,
    openedAt: runAt(35),
  },
});

const inputs = (run: FactoryRunData, o: Partial<RunRecordInputs> = {}): RunRecordInputs => ({
  run,
  entries: run.stage === 'done' ? DONE_ENTRIES : LIVE_ENTRIES,
  criteria: RUN_CRITERIA,
  verify: run.verifications.length === 0 ? null : RUN_VERIFY_REPORT,
  html: run.verifications.length === 0 ? null : verifyHtmlOf(RUN_VERIFY_HTML),
  spec: RUN_SPEC,
  source: 'live',
  at: runAt(run.stage === 'done' ? 50 : 21),
  type: 'Bug',
  branch: RUN_BRANCH,
  where: 'Local sandbox',
  cardDetail: RUN_CARD_DETAIL,
  commits: run.stage === 'done' ? RUN_COMMITS : RUN_COMMITS.slice(0, 2),
  ...o,
});

export const RUN_LIVE_INPUTS = inputs(RUN_LIVE);
export const RUN_DONE_INPUTS = inputs(RUN_DONE, { source: 'record', where: null });
export const RUN_ENTRIES = { live: LIVE_ENTRIES, done: DONE_ENTRIES };

/** `abe factory record 2`'s answers: live, and the done run read back from the store. */
export const RUN_RECORD_LIVE: RunRecordData = runRecordOf(RUN_LIVE_INPUTS);
export const RUN_RECORD_DONE: RunRecordData = runRecordOf(RUN_DONE_INPUTS);

/** The done run whose playbook step wrote a Playbook: a secret on test for Abe, prod's deploy yours. */
export const RUN_PLAYBOOK: PlaybookKept = {
  path: `.abe/playbooks/${RUN_CARD}.md`,
  title: 'Cart totals',
  doneWhen: 'a cart of 3 mugs charges for 3 on prod',
  steps: [
    {
      n: 1,
      title: 'Backfill line totals on test',
      by: 'abe',
      where: 'test',
      runnable: true,
      theirs: null,
    },
    {
      n: 2,
      title: 'Backfill line totals on prod',
      by: 'you',
      where: 'prod',
      runnable: true,
      theirs: 'prod is not enabled for agents in this repo',
    },
    {
      n: 3,
      title: 'Check a real cart',
      by: 'you',
      where: 'the shop',
      runnable: false,
      theirs: null,
    },
  ],
};
export const RUN_RECORD_PLAYBOOK: RunRecordData = {
  ...RUN_RECORD_DONE,
  run: { ...RUN_RECORD_DONE.run, playbook: RUN_PLAYBOOK },
};

/** The run at its PR, ready for review: the PR open, nothing merged, read where it runs. */
export const RUN_RECORD_READY: RunRecordData = ((): RunRecordData => {
  const run = RUN_RECORD_DONE.run;
  const pr =
    run.pr === null ? null : { ...run.pr, state: 'open' as const, mergeCommit: null, deploy: null };

  return {
    ...RUN_RECORD_DONE,
    source: 'live',
    run: { ...run, stage: 'pr', state: 'running', outcome: null, since: runAt(34), pr },
    steps: RUN_RECORD_DONE.steps.filter((x) => x.kind !== 'merge'),
  };
})();

/**
 * The run waiting on you in its pr step: the push refused in the sandbox, one answer offered. Its
 * playbook step was skipped by its gate on the way.
 */
export const RUN_NEEDS_YOU: FactoryRunData = {
  ...RUN_DONE,
  stage: 'pr',
  state: 'needs-you',
  outcome: null,
  since: runAt(34),
  needsYouSince: runAt(36),
  reason:
    "The branch can't be pushed from the sandbox: GitHub refuses its SSH key. Push it from your machine, then I open the pull request.",
  options: ['Pushed, go on'],
  pr: null,
  step: 'pr',
  stages: RUN_DONE.stages.filter((v) => v.stage !== 'pr'),
  judgements: [
    {
      step: 'playbook',
      loop: null,
      kind: 'gate',
      question: 'Does the diff need manual steps after merge?',
      sees: ['diff'],
      at: runAt(34),
      answer: false,
      reason: 'The diff changes cartTotal() and its tests; nothing to run by hand.',
    },
  ],
};
export const RUN_RECORD_NEEDS_YOU: RunRecordData = runRecordOf(
  inputs(RUN_NEEDS_YOU, {
    entries: DONE_ENTRIES.filter((e) => Date.parse(e.at) < Date.parse(runAt(35.5))),
    at: runAt(37),
  }),
);

/** The done run as serve kept it (`run.json`), as the store holds it. */
export const RUN_STORED: Run = Run.parse({
  v: 1,
  session: RUN_SESSION,
  card: RUN_CARD,
  title: RUN_TITLE,
  repo: '/home/me/projects/demo-shop',
  worktree: RUN_WORKTREE,
  startedAt: RUN_DONE.startedAt,
  stage: 'done',
  since: RUN_DONE.since,
  visits: RUN_DONE.stages.map((v) => ({
    stage: v.stage,
    startedAt: v.startedAt,
    endedAt: v.endedAt,
    report: v.report,
  })),
  needsYou: null,
  outcome: 'done',
  pr: {
    repo: 'mkdir-swe/demo-shop',
    number: 57,
    url: 'https://github.com/mkdir-swe/demo-shop/pull/57',
    head: RUN_BRANCH,
    autoMerge: false,
    state: 'merged',
    checks: 'success',
    mergeCommit: '9f1c2d3',
    mergeFailed: null,
    deploy: { state: 'success', url: null },
  },
  reviews: RUN_DONE.reviews,
  verifications: RUN_DONE.verifications,
  specIssues: ['mkdir-swe/demo-shop#41'],
});

/** A transcript entry as Claude Code's JSONL holds it. Only your words and the agent's are kept. */
const jsonlOf = (e: TranscriptEntry): unknown[] => {
  if (e.kind === 'user')
    return [
      {
        type: 'user',
        uuid: e.id,
        promptId: e.id,
        timestamp: e.at,
        message: { role: 'user', content: e.text },
      },
    ];
  if (e.kind === 'assistant-text')
    return [
      {
        type: 'assistant',
        uuid: e.id,
        timestamp: e.at,
        message: { role: 'assistant', content: [{ type: 'text', text: e.text }] },
      },
    ];

  return [];
};

/** The done session's transcript as Claude Code's JSONL would hold its words (the store's copy). */
export const RUN_STORED_TRANSCRIPT = DONE_ENTRIES.flatMap(jsonlOf)
  .map((l) => JSON.stringify(l))
  .join('\n');

// ── Every kind of step: tickets, a bug not reproduced, an investigation ──────────────────────

const flowStep = (
  name: string,
  kind: FactoryRunData['stage'],
  skill: string | null,
  o: { fresh?: 'never' | 'always' | 'loop'; gated?: boolean; ends?: boolean } = {},
) => ({
  name,
  kind,
  skill,
  fresh: o.fresh ?? 'never',
  gated: o.gated ?? false,
  ends: o.ends ?? false,
});

/** Card 4's spec: the sign-in by email link, its stories, decisions and criteria. */
export const SIGN_IN_SPEC: RunSpec = {
  ref: 'mkdir-swe/demo-shop#40',
  url: 'https://github.com/mkdir-swe/demo-shop/issues/40',
  title: 'As a visitor I can sign in with email',
  body: [
    'Card: AB#4',
    '',
    '## Problem Statement',
    '',
    'A returning visitor has no way back to the cart they left, and the shop keeps no passwords.',
    '',
    '## Solution',
    '',
    'A visitor types their email and gets a link. Opening it signs them in on that browser.',
    '',
    '## User Stories',
    '',
    '1. As a visitor, I want to sign in with just my email, so that I need no password.',
    '2. As a returning visitor, I want my guest cart kept when I sign in, so that I do not start over.',
    '3. As a visitor who opened an old link, I want to be told it expired, so that I am not stuck.',
    '',
    '## Implementation Decisions',
    '',
    '1. Found in ADR-003 No passwords: accounts carry no password; sign-in is by token only.',
    '2. The card leaves the guest cart open; we merge it on sign-in, quantities summed.',
    '3. Decided with the product owner: links expire after 15 minutes.',
    '4. Decided with the product owner: a link is single-use.',
    '',
    '## Acceptance criteria',
    '',
    '- A visitor enters their email and is told to check their inbox.',
    '- Opening the link signs the visitor in.',
    '- A used or old link shows an expired page.',
    '- The guest cart is kept after sign-in.',
    '',
    '## Out of Scope',
    '',
    '- Password reset.',
  ].join('\n'),
};

const SIGN_IN_WT = '/home/me/projects/demo-shop-wt/4-sign-in-email';

/** Card 4's tickets, as to-tickets wrote them: 4 tickets in 3 waves, 2 milestones. */
export const SIGN_IN_TICKETS: MadeKept = {
  step: 'to-tickets',
  at: runAt(8),
  made: {
    kind: 'tickets',
    where: 'issue',
    parent: 'demo-shop#40',
    tickets: [
      {
        id: 'T1',
        ref: '#41',
        url: null,
        title: 'Sign-in tokens: issue, store, expire',
        what: 'A token is made for an email, stored with its expiry, and marked used when opened.',
        area: ['auth/token', 'db/migrations'],
        criteria: ['A token is refused after 15 minutes', 'A token is refused after one use'],
        blockedBy: [],
        wave: 1,
        milestone: 1,
        big: false,
        from: ['decision-3', 'decision-4', 'story-1'],
      },
      {
        id: 'T2',
        ref: '#42',
        url: null,
        title: 'Ask for a link: the sign-in page and the email',
        what: 'A visitor types an email on the sign-in page and lands on “Check your email”.',
        area: ['web/sign-in', 'mail/templates'],
        criteria: ['The form leads to the confirmation page', 'The email carries the link'],
        blockedBy: ['T1'],
        wave: 2,
        milestone: 1,
        big: false,
        from: ['story-1', 'criterion-1'],
      },
      {
        id: 'T3',
        ref: '#43',
        url: null,
        title: 'Open a link: the session and the way back',
        what: 'Opening a valid link starts a session on that browser.',
        area: ['auth/session'],
        criteria: ['A valid link starts a session'],
        blockedBy: ['T1'],
        wave: 2,
        milestone: 1,
        big: false,
        from: ['story-1', 'criterion-2'],
      },
      {
        id: 'T4',
        ref: '#44',
        url: null,
        title: 'Keep the guest cart on sign-in',
        what: 'The lines a visitor put in the cart as a guest are there after sign-in.',
        area: ['cart/merge'],
        criteria: ['Guest lines are kept', 'Quantities are summed on a clash'],
        blockedBy: ['T3'],
        wave: 3,
        milestone: 2,
        big: false,
        from: ['story-2', 'decision-2', 'criterion-4'],
      },
    ],
    milestones: [
      { n: 1, text: 'A visitor asks for a link, opens it and lands signed in.' },
      { n: 2, text: 'Every ticket: the guest cart survives sign-in.' },
    ],
  },
};

/** Card 4 live in its first build, after its spec and its tickets. */
export const SIGN_IN_RUN: FactoryRunData = factoryRun(4, SIGN_IN_SPEC.title, 'build', 'running', {
  session: '4-c3d4',
  worktree: SIGN_IN_WT,
  startedAt: runAt(0),
  since: runAt(10),
  step: 'build',
  stages: [
    {
      ...visit('spec', 0, 6),
      report: '.scratch/4/spec.md',
      summary: summed(6, 'Settled 4 decisions and wrote the spec as issue #40.'),
    },
    {
      ...visit('step', 6, 8),
      step: 'to-tickets',
      report: '.scratch/4/tickets.md',
      summary: summed(8, 'Cut spec #40 into 4 tickets in 3 waves, with 2 milestones.'),
    },
  ],
  made: [SIGN_IN_TICKETS],
  workflow: {
    id: 'feature',
    name: 'Feature',
    layer: 'built-in',
    steps: [...FEATURE_FLOW],
    loops: FEATURE_LOOPS,
  },
});

export const SIGN_IN_RECORD: RunRecordData = runRecordOf({
  run: SIGN_IN_RUN,
  entries: [],
  criteria: '',
  verify: null,
  spec: SIGN_IN_SPEC,
  source: 'live',
  at: runAt(12),
  type: 'User Story',
  branch: 'card/4-sign-in-email',
  where: 'Local sandbox',
  cardDetail: {
    type: 'User Story',
    state: 'Active',
    tags: [],
    text: 'Returning visitors have no way back to their cart. Let a visitor sign in with a link we send to their email.',
    criteria: ['I can type my email and get a link', 'Opening the link signs me in'],
    url: 'https://dev.azure.com/demo-org/demo-shop/_workitems/edit/4',
  },
  commits: [],
});

const RESET_WT = '/home/me/projects/demo-shop-wt/8-password-reset-blank';

/** Card 8's Before on the merge base, in the reproduce skill's form: not reproduced. */
export const RESET_BEFORE = [
  '# Before: AB#8 Password reset link opens a blank page',
  '',
  'Merge base a9f3c21 · the shop through the pack’s Playwright',
  '',
  '1. Browser: ask for a reset, open the link from the stub outbox → the reset form renders · verify/evidence/password-reset/before-1.png · ▶ 0:03',
  '2. Browser: the same with a Safari user agent → the form renders · verify/evidence/password-reset/before-2.png',
  '3. Browser: a link older than an hour → the expired page, not blank · verify/evidence/password-reset/before-3.png',
  '',
  'Result: not reproduced',
  'Recording: verify/evidence/password-reset/before.webm · 0:21',
  '',
  '## What would help',
  '',
  '- The browser and its version.',
  '- Whether the link was opened from the mail app’s preview pane.',
].join('\n');

/** Card 8: a Bug run whose bug did not reproduce, its report. */
export const RESET_RUN: FactoryRunData = factoryRun(
  8,
  'Password reset link opens a blank page',
  'done',
  'done',
  {
    session: '8-e5f6',
    worktree: RESET_WT,
    startedAt: runAt(0),
    since: runAt(6),
    outcome: 'reported',
    stages: [
      {
        ...visit('reproduce', 0, 6),
        report: '.scratch/8/verify-before.md',
        summary: summed(
          6,
          'Did not reproduce on the merge base: the reset page rendered the form in every try. Wrote the report for the card; the run ends here.',
        ),
      },
    ],
    verifications: [
      {
        at: runAt(5.5),
        phase: 'before',
        result: 'not-reproduced',
        report: `${RESET_WT}/.scratch/8/verify/1-before.md`,
        regression: [],
      },
    ],
    reported: {
      step: 'reproduce',
      report: '.scratch/8/verify-before.md',
      at: runAt(6),
      done: false,
      spike: null,
    },
    workflow: {
      id: 'bug',
      name: 'Bug',
      layer: 'built-in',
      steps: [
        flowStep('reproduce', 'reproduce', 'reproduce', { ends: true }),
        flowStep('build', 'build', 'implement', { fresh: 'loop' }),
        flowStep('checks', 'checks', null),
        flowStep('review', 'review', 'code-review', { fresh: 'always' }),
        flowStep('verify', 'verify', 'verify', { fresh: 'always' }),
        flowStep('playbook', 'step', 'playbook', { gated: true }),
        flowStep('pr', 'pr', 'pr', { fresh: 'always' }),
      ],
      loops: FEATURE_LOOPS,
    },
  },
);

export const RESET_RECORD: RunRecordData = runRecordOf({
  run: RESET_RUN,
  entries: [],
  criteria: '',
  verify: null,
  spec: null,
  source: 'live',
  at: runAt(8),
  type: 'Bug',
  branch: 'card/8-password-reset-blank',
  where: 'Local sandbox',
  cardDetail: {
    type: 'Bug',
    state: 'Active',
    tags: [],
    text: '1. Ask for a password reset on /sign-in/forgot.\n2. Open the link from the email.\nExpected: the reset form. Actual: a blank page.',
    criteria: [],
    url: 'https://dev.azure.com/demo-org/demo-shop/_workitems/edit/8',
  },
  before: { text: RESET_BEFORE, html: null },
  reported: RESET_BEFORE,
});

/** Card 9's report: the answer, cited findings, options, the spike. */
export const CART_REPORT = [
  '# Why is the cart total slow on the first visit?',
  '',
  '**Answer:** The first view calls the carrier’s rate API with no cache and no timeout; later views read the rate from the session. A one-day cache per country and weight band removes the wait.',
  '',
  '## Findings',
  '',
  '- The first view computes shipping by calling the carrier’s rate API (cart/shipping.ts:31).',
  '- The call has no timeout and no cache; p95 1.8 s (logs/web, 412 calls).',
  '',
  '## Options',
  '',
  '1. Cache the rate per country and band for a day. Recommended: small, half a day.',
  '2. Compute shipping at add-to-cart time. Medium: two days; the same call.',
  '',
  '## Spike',
  '',
  'card/9 showed 2.1 s → 140 ms on the first view. Evidence, never merged.',
].join('\n');

/** Card 9: an Investigate run, its report, its spike pushed. */
export const CART_SLOW_RUN: FactoryRunData = factoryRun(
  9,
  'Why is the cart total slow on the first visit?',
  'done',
  'done',
  {
    session: '9-a7b8',
    worktree: '/home/me/projects/demo-shop-wt/9-cart-slow',
    startedAt: runAt(0),
    since: runAt(17),
    outcome: 'reported',
    stages: [
      {
        ...visit('step', 0, 17),
        step: 'investigate',
        report: '.scratch/9/report.md',
        summary: summed(
          17,
          'Answered with 2 cited findings and 2 costed options; a spike showed a cache cuts the first view from 2.1 s to 140 ms.',
        ),
      },
    ],
    reported: {
      step: 'investigate',
      report: '.scratch/9/report.md',
      at: runAt(17),
      done: true,
      spike: {
        branch: 'card/9-cart-slow',
        commits: [
          { sha: '3e9f0a1', subject: 'spike: cache carrier rates per band' },
          { sha: '5d2b7c4', subject: 'spike: time the first view with and without' },
        ],
        pushed: true,
      },
    },
    workflow: {
      id: 'investigate',
      name: 'Investigate',
      layer: 'built-in',
      steps: [flowStep('investigate', 'step', 'investigate', { ends: true })],
      loops: [],
    },
  },
);

export const CART_SLOW_RECORD: RunRecordData = runRecordOf({
  run: CART_SLOW_RUN,
  entries: [],
  criteria: '',
  verify: null,
  spec: null,
  source: 'live',
  at: runAt(20),
  type: 'Task',
  branch: 'card/9-cart-slow',
  where: 'Local sandbox',
  cardDetail: {
    type: 'Task',
    state: 'Done',
    tags: ['investigate'],
    text: 'The first cart view takes about 2 s; later views 100 ms. Why, and what would it take to fix?',
    criteria: [],
    url: 'https://dev.azure.com/demo-org/demo-shop/_workitems/edit/9',
  },
  reported: CART_REPORT,
});

// ── The screen, driven ─────────────────────────────────────────────────────────────────────

export const RUN_SIZE = { width: 1400, height: 860 };

export type RunDrive = Drive<Node>;

/** `abe factory record` answered with `record`, or refused with it. */
export const recordReplies =
  (record: RunRecordData | { code: string; message: string } = RUN_RECORD_LIVE): Replies =>
  ({ id, argv }) => {
    if (argv[0] !== 'factory' || argv[1] !== 'record') return undefined;

    return 'card' in record
      ? { kind: 'result', id, command: 'factory record', reply: { ok: true, data: record } }
      : { kind: 'result', id, command: 'factory record', reply: { ok: false, error: record } };
  };

/** The `run` screen opened on card 2 in its worktree at `size`, with the clock at `now`. */
export const driveRun = (
  o: {
    size?: { width: number; height: number };
    now?: string;
    params?: Record<string, string>;
  } = {},
): RunDrive =>
  driveScreen(runScreen, {
    params: o.params ?? { card: String(RUN_CARD), root: RUN_WORKTREE },
    size: o.size ?? RUN_SIZE,
    now: o.now ?? runAt(21),
    replies: recordReplies(),
  });

/** The contract's Run trees (`packages/ui/contract/trees/run-*.json`). */
export const runTrees = (): Record<string, Node> => {
  const done = () => driveRun({ now: runAt(50) }).answer(recordReplies(RUN_RECORD_DONE));

  return {
    // live: the second Build running, the keys on it, the steps not reached dim below
    'run-live': driveRun().answer().tree,
    // before `factory record` answers
    'run-reading': driveRun().tree,
    // no run of yours on the card
    'run-none': driveRun().answer(
      recordReplies({ code: 'no-run', message: 'AB#2 has no Factory run of yours' }),
    ).tree,
    // done, from the store: the keys on the merge
    'run-done': done().tree,
    // a criterion's proof ↓: the last Verify, its report unfolded
    'run-verify': done().click('run:proof:1').tree,
    // ⌃S: the spec beside the focus pane
    'run-spec': done().keys('<C-s>').tree,
    // Linked ▾ up. Command mode draws its popup over it in `linked.json`.
    'run-linked': driveRun().answer().click('run:linked').tree,
    // a 960 px main area: the steps' column narrower
    'run-narrow': driveRun({ size: { width: 960, height: 760 } }).answer().tree,
    // the done run's Playbook: its action on the playbook step
    'run-playbook': driveRun({ now: runAt(50) }).answer(recordReplies(RUN_RECORD_PLAYBOOK)).tree,
    // a file's diff open on the first Build, its details unfolded (⏎)
    'run-diff': driveRun().answer().keys('l', 'l').click('run:file:build:1:0').keys('<CR>').tree,
    // the PR open: Review changes and Open PR on the pr step
    'run-ready': driveRun({ now: runAt(36) }).answer(recordReplies(RUN_RECORD_READY)).tree,
    // the third Build: sent back from review, round 3 of 3, its three decisions
    'run-round': done().click('run:step:build:3').tree,
    // waiting on you in pr: its question and answer; the playbook skipped by its gate
    'run-needs-you': driveRun({ now: runAt(38) }).answer(recordReplies(RUN_RECORD_NEEDS_YOU)).tree,
    // `l` past the first step: the keys on `#2`, ⏎ opens the card
    'run-card': driveRun().answer().keys('g', 'g', 'l').tree,
    // the first Build: one lane per writer, the milestone, the checks it ran itself
    'run-build': done().click('run:step:build:1').tree,
    // the first Checks: lint red, sent back to build with its output
    'run-checks': done().click('run:step:checks:1').tree,
    // the first Review: its finding fixed in build #3, a noted one, the risk
    'run-review': done().click('run:step:review:1').tree,
    // card 4's to-tickets: the tickets by wave, T1 open with its spec lines
    'run-tickets': driveRun({ params: { card: '4', root: SIGN_IN_WT } })
      .answer(recordReplies(SIGN_IN_RECORD))
      .click('run:step:step:1')
      .click('run:ticket:step:1:T1').tree,
    // card 8's reproduce: not reproduced, Before's steps and shots
    'run-reproduce': driveRun({ params: { card: '8', root: RESET_WT } })
      .answer(recordReplies(RESET_RECORD))
      .click('run:step:reproduce:1').tree,
    // card 8's report: the run ended
    'run-report': driveRun({ params: { card: '8', root: RESET_WT } }).answer(
      recordReplies(RESET_RECORD),
    ).tree,
    // card 9's investigate: the report and the spike's commits
    'run-investigate': driveRun({
      params: { card: '9', root: '/home/me/projects/demo-shop-wt/9-cart-slow' },
    })
      .answer(recordReplies(CART_SLOW_RECORD))
      .click('run:step:step:1').tree,
  };
};
