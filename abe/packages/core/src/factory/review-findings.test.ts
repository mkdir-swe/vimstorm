import { describe, expect, test } from 'bun:test';
import {
  findingRounds,
  findingsFileOf,
  type ReviewFinding,
  type ReviewKept,
} from './review-findings';

const at = (m: number) =>
  new Date(Date.parse('2026-10-26T17:00:00.000Z') + m * 60_000).toISOString();

const f = (id: string, o: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id,
  axis: 'standards',
  file: 'auth/token.ts',
  line: 58,
  text: `finding ${id}`,
  fix: 'fix it',
  severity: 'must',
  ...o,
});

const review = (m: number, items: ReviewFinding[], o: Partial<ReviewKept> = {}): ReviewKept => ({
  at: at(m),
  findings: items.filter((x) => x.severity === 'must').length,
  report: null,
  regression: [],
  items,
  ...o,
});

/** Build visits: the first at 0, the second at 50 (between the reviews at 47 and 58). */
const BUILDS = [{ startedAt: at(0) }, { startedAt: at(50) }];

describe('findingRounds: each finding tracked per build round', () => {
  const rows: {
    name: string;
    reviews: ReviewKept[];
    /** Per round: `<id> <state> <fixedIn>`, then ` | ` the round before's as found again. */
    want: string[];
  }[] = [
    {
      name: 'one round: its must findings open, a noted one stateless',
      reviews: [review(47, [f('F1'), f('N1', { severity: 'noted' })])],
      want: ['F1 open - N1 null -'],
    },
    {
      name: 'the next round does not find it again: fixed in the build between',
      reviews: [review(47, [f('F1'), f('F2')]), review(58, [])],
      want: ['F1 fixed 2 F2 fixed 2', ' | F1 fixed 2 F2 fixed 2'],
    },
    {
      name: 'found again (same file and words, a new id): still open',
      reviews: [review(47, [f('F1')]), review(58, [f('F9', { text: 'finding F1' })])],
      want: ['F1 open -', 'F9 open - | F1 open -'],
    },
    {
      name: 'the later round says so by id: its word wins over matching',
      reviews: [
        review(47, [f('F1'), f('F2')]),
        review(58, [], { earlier: [{ id: 'F1', fixed: false }] }),
      ],
      want: ['F1 open - F2 fixed 2', ' | F1 open - F2 fixed 2'],
    },
    {
      name: 'a noted finding found again does not keep a must one open',
      reviews: [
        review(47, [f('F1')]),
        review(58, [f('F1', { severity: 'noted' })], { findings: 0 }),
      ],
      want: ['F1 fixed 2', 'F1 null - | F1 fixed 2'],
    },
    {
      name: 'no build between the rounds: fixed, by no build',
      reviews: [review(47, [f('F1')]), review(48, [])],
      want: ['F1 fixed -', ' | F1 fixed -'],
    },
    {
      name: 'must findings first, then noted',
      reviews: [review(47, [f('N1', { severity: 'noted' }), f('F1')])],
      want: ['F1 open - N1 null -'],
    },
  ];
  const words = (list: readonly { id: string; state: string | null; fixedIn: number | null }[]) =>
    list.map((x) => `${x.id} ${x.state ?? 'null'} ${x.fixedIn ?? '-'}`).join(' ');

  for (const row of rows)
    test(row.name, () => {
      const rounds = findingRounds(row.reviews, BUILDS);

      expect(
        rounds.map(
          (r) => `${words(r.items)}${r.checked.length === 0 ? '' : ` | ${words(r.checked)}`}`,
        ),
      ).toEqual(row.want);
    });
});

describe('findingsFileOf: the file the skill writes', () => {
  const good = JSON.stringify({
    findings: [
      {
        id: 'F1',
        axis: 'spec',
        file: 'web/sent.tsx',
        line: 12,
        text: 'A countdown',
        fix: 'drop it',
      },
      {
        id: 'N1',
        axis: 'standards',
        file: 'cart/merge.ts',
        text: 'Possible Duplicated Code',
        severity: 'noted',
      },
    ],
    risk: { risky: true, why: 'authentication' },
  });
  const rows: { name: string; text: string; findings?: number; want: string }[] = [
    { name: 'held, the count matching', text: good, findings: 1, want: 'ok 2 risky' },
    {
      name: 'the count differs',
      text: good,
      findings: 2,
      want: 'no: --findings 2, but the file has 1 must finding',
    },
    { name: 'not JSON', text: '- [a:1] x → y', want: 'no: not JSON' },
    {
      name: 'an id twice',
      text: JSON.stringify({
        findings: [
          { id: 'F1', axis: 'spec', file: 'a', text: 'x' },
          { id: 'F1', axis: 'spec', file: 'b', text: 'y' },
        ],
      }),
      want: 'no: finding F1 is listed twice',
    },
    {
      name: 'an axis it does not know',
      text: JSON.stringify({ findings: [{ id: 'F1', axis: 'style', file: 'a', text: 'x' }] }),
      want: 'no: findings.0.axis',
    },
  ];

  for (const row of rows)
    test(row.name, () => {
      const read = findingsFileOf(row.text, row.findings);
      const said = read.ok
        ? `ok ${read.file.findings.length} ${read.file.risk?.risky === true ? 'risky' : 'not risky'}`
        : `no: ${read.problem}`;

      expect(said.startsWith(row.want)).toBe(true);
    });
});
