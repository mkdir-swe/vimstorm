/**
 * A run's record after each finished step's pass: the pass (`stepSummarizer`) over a
 * step's report and transcript with the fast model faked, kept on the run (`withStepSummary`), and
 * read where the run page reads it: `abe factory status --json` (`runData`, through its JSON) and
 * `abe factory record` (`runRecordOf`). One row per rule: the brief after Grill citing the card
 * and its answers, decisions with chose / over / why, no filler, Evidence, checks without the
 * model, a model that fails, secrets out of what is sent and kept, a step that left nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  FactoryRunData,
  type KnownSecret,
  Run,
  runData,
  type RunBrief,
  runRecordOf,
  type Stage,
  type StepSummary,
  type TranscriptEntry,
  withStepSummary,
} from '@abe/core';
import { stepSummarizer } from './step-summary';

const T0 = Date.parse('2026-10-26T09:00:00.000Z');
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();
const WT = '/wt/2-cart';
const REVIEW = `${WT}/.scratch/2/review/1.md`;
const SECRET = 'sk-live-0123456789abcdefXYZ';

const said = (m: number, text: string, agent: string | null = null): TranscriptEntry => ({
  kind: 'assistant-text',
  id: `a${m}`,
  at: at(m),
  agent,
  text,
});
/** A stage run in a subagent and the short report it returned, as the main transcript has them. */
const subagent = (m: number, report: string): TranscriptEntry[] => [
  {
    kind: 'tool-use',
    id: `t${m}`,
    at: at(m),
    agent: null,
    tool: 'Agent',
    input: { description: 'Build the fix', prompt: 'build' },
  },
  {
    kind: 'tool-result',
    id: `t${m}`,
    at: at(m + 1),
    agent: null,
    ok: true,
    text: report,
    cut: 0,
    patch: null,
  },
];

const runOf = (stage: Stage, next: Stage, report: string | null, more: object = {}): Run =>
  Run.parse({
    v: 1,
    session: '2-a1b2',
    card: 2,
    title: 'The cart total ignores quantity',
    repo: '/repo',
    worktree: WT,
    startedAt: at(0),
    stage: next,
    since: at(10),
    visits: [{ stage, startedAt: at(0), endedAt: at(10), report }],
    needsYou: null,
    outcome: null,
    ...more,
  });

const json = (o: object) => JSON.stringify(o);

type Row = {
  run: Run;
  files?: Readonly<Record<string, string>>;
  entries?: TranscriptEntry[];
  /** The model's answer; null: it fails. */
  answer: string | null;
  known?: KnownSecret[];
  asked: boolean;
  summary: Partial<StepSummary> | null;
  brief: RunBrief['source'] | null;
  /** In the prompt sent, and never in it. */
  sent?: { has?: string[]; lacks?: string[] };
};

const ROWS: [string, Row][] = [
  [
    "a finished step's decisions: chose, over what, why; its subagent's report is read",
    {
      run: runOf('build', 'checks', null),
      entries: subagent(3, 'Fixed cartTotal(); rounding at the total.'),
      answer: json({
        summary: 'One fix in cartTotal(), tests first.',
        decisions: [
          {
            chose: 'Fix cartTotal()',
            over: 'summing on the cart page',
            why: 'The API, the page and the email all read it.',
          },
          {
            chose: 'Round once, at the total',
            over: 'over rounding each line',
            why: 'Per-line rounding drifted a cent.',
          },
        ],
      }),
      asked: true,
      summary: {
        text: 'One fix in cartTotal(), tests first.',
        decisions: [
          {
            chose: 'Fix cartTotal()',
            over: 'summing on the cart page',
            why: 'The API, the page and the email all read it.',
          },
          {
            chose: 'Round once, at the total',
            over: 'rounding each line',
            why: 'Per-line rounding drifted a cent.',
          },
        ],
      },
      brief: null,
      sent: { has: ['Subagent report: Fixed cartTotal(); rounding at the total.'] },
    },
  ],
  [
    'a step with no real choice records no decisions: filler dropped',
    {
      run: runOf('spec', 'build', null),
      entries: [said(4, 'Spec written as o/shop#41.')],
      answer: json({
        summary: 'Wrote the spec as o/shop#41.',
        decisions: [
          { chose: 'Write the spec', over: 'nothing', why: 'It was asked for.' },
          { chose: 'Open the issue', over: 'Open the issue', why: 'Needed.' },
          { chose: 'Use the template', over: 'free text', why: '' },
        ],
      }),
      asked: true,
      summary: { text: 'Wrote the spec as o/shop#41.', decisions: [] },
      brief: null,
    },
  ],
  [
    'Evidence: its reports and the paths it named, never a path made up',
    {
      run: runOf('review', 'verify', null, {
        reviews: [{ at: at(9), findings: 0, round: 0, report: REVIEW, regression: [] }],
      }),
      files: { [REVIEW]: 'No findings. Checked against shots/cart-3.png.' },
      answer: json({
        summary: 'Review found nothing.',
        decisions: [],
        evidence: ['shots/cart-3.png', 'shots/made-up.png'],
      }),
      asked: true,
      summary: { evidence: ['.scratch/2/review/1.md', 'shots/cart-3.png'] },
      brief: null,
    },
  ],
  [
    'checks are summarised from their result, never by the model',
    {
      run: runOf('checks', 'build', null),
      answer: json({ summary: 'never asked' }),
      asked: false,
      summary: {
        text: 'Checks failed: back to Build with what they said.',
        decisions: [],
        evidence: ['.scratch/2/checks.md'],
        by: 'serve',
      },
      brief: null,
    },
  ],
  [
    "the model fails: the step's own words, no decisions, no brief",
    {
      run: runOf('spec', 'build', null),
      entries: [said(1, 'Bug, needs a grill on shipping.\n\nAsking first.')],
      answer: null,
      asked: true,
      summary: { text: 'Bug, needs a grill on shipping.', decisions: [], by: 'words' },
      brief: null,
    },
  ],
  [
    "the model fails on verify: its report's words, not its browser profile line",
    {
      run: runOf('verify', 'pr', `${WT}/.scratch/2/verify/after.md`),
      files: {
        [`${WT}/.scratch/2/verify/after.md`]:
          '# Verify\n\nBrowser profile: default\n\nAll 3 criteria pass.',
      },
      answer: null,
      asked: true,
      summary: { text: 'All 3 criteria pass.', by: 'words' },
      brief: null,
    },
  ],
  [
    'secret values never in what is sent or kept',
    {
      run: runOf('build', 'checks', null),
      entries: [
        said(2, `Set STRIPE_KEY=${SECRET} and ghp_abcdefghijklmnopqrstuvwxyz0123456789 ran.`),
      ],
      known: [{ kind: 'DEV_STRIPE_KEY', value: SECRET }],
      answer: json({
        summary: `Used ${SECRET} to place an order.`,
        decisions: [{ chose: `the key ${SECRET}`, over: 'a mock', why: `${SECRET} reaches dev.` }],
      }),
      asked: true,
      summary: {
        text: 'Used [redacted:DEV_STRIPE_KEY] to place an order.',
        decisions: [
          {
            chose: 'the key [redacted:DEV_STRIPE_KEY]',
            over: 'a mock',
            why: '[redacted:DEV_STRIPE_KEY] reaches dev.',
          },
        ],
      },
      brief: null,
      sent: { lacks: [SECRET, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'] },
    },
  ],
  [
    'a step that left nothing has no summary',
    {
      run: runOf('pr', 'done', null),
      answer: json({ summary: 'never asked' }),
      asked: false,
      summary: null,
      brief: null,
    },
  ],
];

describe('a run record after its steps’ pass', () => {
  test.each(ROWS)('%s', async (_, row) => {
    const prompts: string[] = [];
    const pass = stepSummarizer({
      entries: () => Promise.resolve(row.entries ?? []),
      file: (_run, path) => Promise.resolve(row.files?.[path] ?? null),
      card: () => Promise.resolve({ description: 'Totals are wrong.', criteria: '- Total counts' }),
      known: () => Promise.resolve(row.known ?? []),
      ask: (_run, prompt) => {
        prompts.push(prompt);

        return Promise.resolve(
          row.answer === null
            ? { ok: false, why: 'no answer in time' }
            : { ok: true, text: row.answer },
        );
      },
      now: () => at(11),
    });
    const visit = row.run.visits[0];

    if (visit === undefined) throw new Error('a row runs one step');
    const got = await pass(row.run, visit);
    const run = got === null ? row.run : withStepSummary(row.run, visit, got);
    // what `abe factory status --json` prints, read back as its contract says
    const status = FactoryRunData.parse(JSON.parse(JSON.stringify(runData(run, undefined))));
    const record = runRecordOf({
      run: status,
      entries: row.entries ?? [],
      criteria: '',
      verify: null,
      spec: null,
      source: 'live',
      at: at(12),
    });
    const step = record.steps.find((s) => s.id === `${visit.stage}:1`);
    const summary = status.stages[0]?.summary ?? null;

    expect(prompts.length > 0).toBe(row.asked);
    if (row.summary === null) expect(summary).toBeNull();
    else expect(summary).toMatchObject(row.summary);
    expect(status.brief?.source ?? null).toEqual(row.brief);
    if (row.brief !== null) expect(status.brief).toMatchObject({ at: at(10) });
    expect(step?.decisions).toEqual(summary?.decisions ?? []);
    expect(step?.evidence).toEqual(summary?.evidence ?? []);
    if (summary !== null) expect(step?.summary).toBe(summary.text);
    if ((summary?.decisions.length ?? 0) > 0) expect(step?.decision).toBe(true);
    for (const has of row.sent?.has ?? []) expect(prompts.join('\n')).toContain(has);
    for (const lacks of row.sent?.lacks ?? []) {
      expect(prompts.join('\n')).not.toContain(lacks);
      expect(JSON.stringify(status)).not.toContain(lacks);
    }
  });
});
