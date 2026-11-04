/** Rule tables for triage: which items, the verdicts' shape, what each verdict may write. */
import { describe, expect, test } from 'bun:test';
import { type CardData } from '../board/board';
import {
  alreadyAsked,
  answersOf,
  askedCards,
  itemsToTriage,
  mayWrite,
  triageLaunchText,
  needsInfoComment,
  readTriage,
  runningCards,
  type Source,
  specIssuesOf,
  TRIAGE_SKILL,
  triageCounts,
  type TriagedItem,
  triagePrompt,
  type Verdict,
  VERDICTS,
  WRITES,
  type Write,
} from './triage';
import { type OpenIssue } from '../board/tracking';

const card = (id: number, title = `Card ${id}`): CardData => ({
  id,
  title,
  state: 'New',
  type: 'User Story',
  tags: [],
  assignee: null,
  description: `Description of ${id}.`,
  acceptanceCriteria: '',
  url: `https://dev.azure.com/o/P/_workitems/edit/${id}`,
  points: null,
  createdBy: null,
});

const issue = (number: number): OpenIssue => ({
  repo: 'o/shop',
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}.`,
  url: `https://github.com/o/shop/issues/${number}`,
  labels: ['bug'],
});

describe('itemsToTriage: every card not running, then the open issues', () => {
  test('a running card is skipped, with why', () => {
    const { items, skipped } = itemsToTriage({
      cards: [card(4), card(5), card(6)],
      issues: [issue(12)],
      running: new Set([5]),
    });

    expect(items.map((i) => [i.id, i.source])).toEqual([
      ['AB#4', 'azure'],
      ['AB#6', 'azure'],
      ['o/shop#12', 'github'],
    ]);
    expect(skipped).toEqual([{ id: 'AB#5', source: 'azure', title: 'Card 5', why: 'running' }]);
  });

  test("a Factory run's spec issue and slices are its card's work, never offered (#200)", () => {
    const held = specIssuesOf([
      { specIssues: ['O/Shop#4', 'o/shop#5'], done: false, merged: false },
      { specIssues: ['o/shop#7'], done: true, merged: true },
      // done without a merge: its spec is open work again
      { specIssues: ['o/shop#8'], done: true, merged: false },
      { specIssues: [], done: false, merged: false },
    ]);
    const { items, skipped } = itemsToTriage({
      cards: [],
      issues: [issue(4), issue(5), issue(6), issue(7), issue(8)],
      running: new Set(),
      specIssues: held,
    });

    expect(items.map((i) => i.id)).toEqual(['o/shop#6', 'o/shop#8']);
    expect(skipped).toEqual([]);
  });

  test("board.notTag: an issue carrying it as a label is not offered, the label's case aside", () => {
    const { items } = itemsToTriage({
      cards: [card(4)],
      issues: [issue(12), { ...issue(13), labels: ['bug', 'Blocked'] }, issue(14)],
      running: new Set(),
      notTag: 'blocked',
    });

    expect(items.map((i) => i.id)).toEqual(['AB#4', 'o/shop#12', 'o/shop#14']);
  });

  test('an issue reads as an item: its labels as tags, its body as the description', () => {
    expect(itemsToTriage({ cards: [], issues: [issue(3)], running: new Set() }).items).toEqual([
      {
        id: 'o/shop#3',
        source: 'github',
        title: 'Issue 3',
        url: 'https://github.com/o/shop/issues/3',
        kind: 'Issue',
        state: 'open',
        tags: ['bug'],
        assignee: null,
        description: 'Body of 3.',
        acceptanceCriteria: '',
      },
    ]);
  });
});

describe('runningCards: sessions not ended, Factory runs not done', () => {
  const sessions = [
    { id: '4-aa', card: 4, state: 'working' },
    { id: '5-bb', card: 5, state: 'ended' },
    { id: '6-cc', card: 6, state: 'ended' },
    { id: '7-dd', card: 7, state: 'waiting' },
  ];
  const runs = [
    { session: '5-bb', card: 5, done: false },
    { session: '6-cc', card: 6, done: true },
    { session: '4-aa', card: 4, done: false },
  ];

  test('a card is running while its session is, or its run is not done', () => {
    expect([...runningCards({ sessions, runs })].sort()).toEqual([4, 5, 7]);
  });
});

describe('triagePrompt: every item, then the answer’s shape', () => {
  const items = itemsToTriage({
    cards: [{ ...card(4), tags: ['auth'], acceptanceCriteria: 'It says so.' }],
    issues: [issue(12)],
    running: new Set(),
  }).items;
  const prompt = triagePrompt(items);

  test('each item under its id, with its text', () => {
    expect(prompt).toContain('## AB#4\n');
    expect(prompt).toContain('- tags: auth');
    expect(prompt).toContain('### Acceptance criteria\n\nIt says so.');
    expect(prompt).toContain('## o/shop#12\n');
    expect(prompt).toContain('Body of 12.');
  });

  test('asks for one JSON document naming the four verdicts', () => {
    expect(prompt).toContain('exactly one JSON document');
    for (const v of VERDICTS) expect(prompt).toContain(v);
  });

  test('a huge description is cut', () => {
    const [first] = items;

    if (first === undefined) throw new Error('no item');
    const huge = triagePrompt([{ ...first, description: 'x'.repeat(10_000) }]);

    expect(huge).toContain('…(cut)');
    expect(huge.length).toBeLessThan(6000);
  });

  test('the prompt is the one-shot file, every verdict named', () => {
    expect(TRIAGE_SKILL.startsWith('# Triage\n')).toBe(true);
    for (const v of VERDICTS) expect(TRIAGE_SKILL).toContain(`\`${v}\``);
  });
});

describe('readTriage: one verdict per item, or unreadable', () => {
  const items = itemsToTriage({
    cards: [card(4), card(5)],
    issues: [issue(12)],
    running: new Set(),
  }).items;
  const answer = (verdicts: unknown[]) => JSON.stringify({ verdicts });
  const good = [
    { id: 'o/shop#12', verdict: 'too-big', reason: 'three features' },
    { id: 'AB#4', verdict: 'ready', reason: 'clear criteria', question: 'ignored' },
    { id: 'AB#5', verdict: 'needs-info', reason: 'no expected result', question: 'What then?' },
  ];

  test('in the items’ order; a question only on needs-info', () => {
    const read = readTriage(answer(good), items);

    expect(read).toEqual({
      ok: true,
      items: [
        {
          id: 'AB#4',
          source: 'azure',
          title: 'Card 4',
          url: 'https://dev.azure.com/o/P/_workitems/edit/4',
          verdict: 'ready',
          reason: 'clear criteria',
          question: null,
        },
        {
          id: 'AB#5',
          source: 'azure',
          title: 'Card 5',
          url: 'https://dev.azure.com/o/P/_workitems/edit/5',
          verdict: 'needs-info',
          reason: 'no expected result',
          question: 'What then?',
        },
        {
          id: 'o/shop#12',
          source: 'github',
          title: 'Issue 12',
          url: 'https://github.com/o/shop/issues/12',
          verdict: 'too-big',
          reason: 'three features',
          question: null,
        },
      ],
    });
  });

  test.each([
    ['no JSON', 'I would say they are all fine.', 'no JSON'],
    [
      'an unknown verdict',
      answer([...good.slice(0, 2), { ...good[2], verdict: 'maybe' }]),
      'verdict',
    ],
    ['an empty reason', answer([...good.slice(0, 2), { ...good[2], reason: ' ' }]), 'reason'],
    [
      'needs-info without its question',
      answer([...good.slice(0, 2), { id: 'AB#5', verdict: 'needs-info', reason: 'r' }]),
      'asks its question',
    ],
    ['a missing item', answer(good.slice(0, 2)), 'no verdict for AB#5'],
    ['an item twice', answer([...good, good[1]]), 'more than one verdict for AB#4'],
    [
      'an item not asked about',
      answer([...good, { id: 'AB#9', verdict: 'ready', reason: 'r' }]),
      'not asked about: AB#9',
    ],
  ])('%s', (_, text, why) => {
    const read = readTriage(text, items);

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toContain(why);
  });
});

test('triageCounts: each verdict’s count and the running skipped', () => {
  expect(
    triageCounts(
      [
        { verdict: 'ready' },
        { verdict: 'ready' },
        { verdict: 'needs-info' },
        { verdict: 'too-big' },
      ],
      2,
    ),
  ).toEqual({ ready: 2, needsInfo: 1, tooBig: 1, notForAgent: 0, skipped: 2 });
});

describe('WRITES: what each verdict may write', () => {
  test.each([
    ['ready', 'azure', 'launch'],
    ['ready', 'github', null],
    ['needs-info', 'azure', 'ask'],
    ['needs-info', 'github', null],
    ['too-big', 'azure', null],
    ['too-big', 'github', null],
    ['not-for-agent', 'azure', null],
    ['not-for-agent', 'github', null],
  ] satisfies [Verdict, Source, Write][])('%s on %s: %s', (verdict, source, write) => {
    expect(WRITES[verdict][source]).toBe(write);
  });

  const triaged = (id: string, source: Source, verdict: Verdict): TriagedItem => ({
    id,
    source,
    title: id,
    url: '',
    verdict,
    reason: `why ${id}`,
    question: verdict === 'needs-info' ? 'What then?' : null,
  });
  const last = [
    triaged('AB#4', 'azure', 'ready'),
    triaged('AB#5', 'azure', 'needs-info'),
    triaged('AB#6', 'azure', 'too-big'),
    triaged('o/shop#12', 'github', 'ready'),
    triaged('o/shop#13', 'github', 'needs-info'),
  ];

  test.each([
    ['4', 'launch', { ok: true, card: 4 }],
    ['AB#4', 'launch', { ok: true, card: 4 }],
    ['#5', 'ask', { ok: true, card: 5 }],
    ['AB#5', 'launch', { ok: false, error: { code: 'not-ready' } }],
    ['AB#4', 'ask', { ok: false, error: { code: 'not-needs-info' } }],
    [
      'AB#6',
      'launch',
      { ok: false, error: { code: 'not-ready', message: 'AB#6 is too big: why AB#6' } },
    ],
    ['AB#9', 'launch', { ok: false, error: { code: 'not-triaged' } }],
    [
      'o/shop#12',
      'launch',
      {
        ok: false,
        error: {
          code: 'not-a-card',
          message: 'o/shop#12 is a GitHub issue: triage launches runs on cards only',
        },
      },
    ],
    [
      'O/Shop#13',
      'ask',
      {
        ok: false,
        error: {
          code: 'not-a-card',
          message: 'o/shop#13 is a GitHub issue: triage asks for info on cards only',
        },
      },
    ],
    // a card the triage skipped as running says so (#187)
    [
      '7',
      'launch',
      {
        ok: false,
        error: {
          code: 'running',
          message: 'AB#7 was skipped by the last triage: it runs already (abe factory status 7)',
        },
      },
    ],
  ] as const)('%s, %s → %j', (text, want, answer) => {
    const skipped = [{ id: 'AB#7', source: 'azure', title: 'x', why: 'running' }] as const;

    expect(mayWrite(last, text, want, skipped)).toMatchObject(answer);
  });

  test('a launch on this Mac names no boxes (#187); in your environment it does', () => {
    const items = [
      { id: 'AB#4', result: 'started', session: '4-a1b2', code: null, message: 'started 4-a1b2' },
    ] as const;
    const launched = (local: boolean) =>
      triageLaunchText({ limit: 3, inUse: 1, local, items: [...items] });

    expect(launched(true)).toBe('AB#4  started  4-a1b2\n');
    expect(launched(false)).toBe(
      'AB#4  started  4-a1b2\nboxes: 1 of 3 in use before this launch\n',
    );
  });
});

describe('the needs-info comment, written once', () => {
  const comment = needsInfoComment({ reason: 'no expected result', question: 'What then?' });

  test('the disclaimer first, then why and the question', () => {
    expect(comment.split('\n')[0]).toBe('> *This was generated by AI during triage.*');
    expect(comment).toContain('**Needs info:** no expected result');
    expect(comment).toContain('- What then?');
  });

  const on = (text: string) => [{ id: 1, text, by: 'Alex', at: '2026-10-23T00:00:00Z' }];

  test.each([
    ['the comment as written', on(comment), true],
    [
      'as Azure gives it back (escaped, other spacing)',
      on('> *This was generated by AI during triage.*\n\n## Triage notes\n\n\\- What   then?'),
      true,
    ],
    ['another question', on(needsInfoComment({ reason: 'r', question: 'Who?' })), false],
    ['the question, not by triage', on('What then?'), false],
    ['no comments', [], false],
  ])('%s: asked already %s', (_, comments, asked) => {
    expect(alreadyAsked(comments, 'What then?')).toBe(asked);
  });
});

describe('an answered card: its comments since triage asked reach the next triage (#77)', () => {
  const asked = (id: number, text: string, by = 'Abe') => ({
    id,
    text,
    by,
    at: '2026-10-20T10:00:00Z',
  });
  const question = needsInfoComment({
    reason: 'no width named',
    question: 'At which screen width should the button move?',
  });
  const comments = [
    asked(1, 'An older note about the logo.', 'Sam Sample'),
    asked(2, question),
    asked(3, 'Below 600 px.', 'Robin Person'),
  ];

  test('answersOf: from triage’s own question on; none when triage never asked', () => {
    expect(answersOf(comments).map((c) => c.id)).toEqual([2, 3]);
    expect(answersOf([asked(1, 'Just a note.')])).toEqual([]);
  });

  test.each<[string, CardData, readonly TriagedItem[] | undefined, boolean]>([
    ['tagged needs-info', { ...card(8), tags: ['Needs-Info'] }, undefined, true],
    [
      'the last triage’s needs-info, its tag since removed',
      card(8),
      [
        {
          id: 'AB#8',
          source: 'azure',
          title: 'Card 8',
          url: '',
          verdict: 'needs-info',
          reason: 'r',
          question: 'q',
        },
      ],
      true,
    ],
    [
      'the last triage’s ready one',
      card(8),
      [
        {
          id: 'AB#8',
          source: 'azure',
          title: 'Card 8',
          url: '',
          verdict: 'ready',
          reason: 'r',
          question: null,
        },
      ],
      false,
    ],
    ['never asked', card(8), undefined, false],
  ])('askedCards: %s → read its comments: %p', (_, c, last, read) => {
    expect(askedCards([c], last)).toEqual(read ? [8] : []);
  });

  test('the prompt shows the thread under its card; a card with none shows no such part', () => {
    const { items } = itemsToTriage({
      cards: [card(8), card(9)],
      issues: [],
      running: new Set(),
      threads: new Map([[8, answersOf(comments)]]),
    });
    const prompt = triagePrompt(items);
    const of8 = prompt.slice(prompt.indexOf('## AB#8'), prompt.indexOf('## AB#9'));

    expect(of8).toContain('### Since triage asked');
    expect(of8).toContain('Robin Person, 2026-10-20: Below 600 px.');
    expect(of8).not.toContain('An older note');
    expect(prompt.slice(prompt.indexOf('## AB#9'))).not.toContain('### Since triage asked');
  });

  test('the skill reads an answer there, and a card still tagged needs-info as waiting on it', () => {
    expect(TRIAGE_SKILL).toContain('Since triage asked');
    expect(TRIAGE_SKILL).toContain('still tagged `needs-info`');
  });
});
