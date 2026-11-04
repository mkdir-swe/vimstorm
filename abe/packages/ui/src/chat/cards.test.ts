/**
 * Chat's cards (#114 t114b): the keys on a question, a grill round, a permission, a run's Needs you
 * and the Override card, the stack, the pill, a teammate's read-only cards, and what each answer
 * runs. Cards come from core's own `askCards` / `permissionCard`, as serve keeps them.
 */
import { describe, expect, test } from 'bun:test';
import { endAsks } from '../board/card-actions';
import { factoryRun } from '@abe/testing';
import {
  type AskCard,
  askCards,
  type Event,
  type FactoryRunData,
  permissionCard,
  type SessionOverride,
} from '@abe/core';
import {
  cardNode,
  type CardFacts,
  type Cards,
  cardsClick,
  cardsEvent,
  cardsKey,
  cardsOpen,
  cardsRead,
  cardsReopen,
  cardsResult,
  cardsRun,
  cardsDraft,
  cardsText,
  foldedNodes,
  NO_CARDS,
  needsYouCard,
  openOverride,
  overrideLine,
  pillNode,
  waitingCount,
} from './cards';
import { Node } from '../runtime/components';
import { type Command } from '../runtime/runtime';

const AT = '2026-10-25T03:00:00.000Z';
const SESSION = 'abe-2-1';
const FACTS: CardFacts = { session: SESSION, card: 2 };

const MARKET = {
  question: 'Which market table should the cart total read?',
  header: "The story's comments mention a per-market setting",
  options: [
    { label: 'The existing market table (Recommended)', description: '' },
    { label: 'A new setting per market', description: '' },
    { label: 'Keep the current behaviour', description: '' },
  ],
};
const ROUND = {
  questions: [
    {
      question: 'Static column widths?',
      header: 'Columns',
      options: [
        { label: 'Yes, fixed widths', description: '' },
        { label: 'No, static widths (Recommended)', description: '' },
      ],
    },
    {
      question: 'Status bar per view?',
      header: 'Status bar',
      options: [
        { label: 'Yes, each view names its own place (Recommended)', description: '' },
        { label: 'One status bar for every view', description: '' },
      ],
    },
    {
      question: 'Local marker?',
      header: 'Marker',
      options: [
        { label: 'Nothing, only a box shows its cloud (Recommended)', description: '' },
        { label: 'A laptop glyph', description: '' },
      ],
    },
  ],
};

const asked = (input: unknown, base: string, at = AT): AskCard[] => {
  const cards = askCards(input, { session: SESSION, base, at });

  if (cards === null) throw new Error('not AskUserQuestion input');

  return cards;
};

const question = (base = 'q-1', q: typeof MARKET & { multiSelect?: boolean } = MARKET, at = AT) =>
  asked({ questions: [q] }, base, at);

const permission = (): AskCard =>
  permissionCard(
    { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
    {
      session: SESSION,
      id: 'p-1',
      at: AT,
      why: 'Reach: writes only in the worktree',
      where: 'local',
      worktree: '/wt',
    },
  );

/** Keys typed in order, each one's commands gathered. */
const keys = (c: Cards, typed: string, f: CardFacts = FACTS) => {
  let cards = c;
  const commands: Command[] = [];
  const handled: boolean[] = [];

  for (const key of typed.split(' ')) {
    const out = cardsKey(cards, key, f);

    cards = out.cards;
    commands.push(...out.commands);
    handled.push(out.handled);
  }

  return { cards, commands, handled };
};

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv] : []));

/** A grill question's pick kept by serve as it is made (#342). */
const pickArgv = (card: string, value: string) => [
  'session',
  'answer',
  SESSION,
  '--card',
  card,
  '--pick',
  value,
];

const node = (c: Cards, f: CardFacts = FACTS) => {
  const n = cardNode(c, f);

  if (n !== null) Node.parse(n);

  return n;
};

/** A round's nth card or line. */
const childOf = (c: Cards, i: number) => {
  const n = node(c);

  return n?.kind === 'GrillRound' ? n.children[i] : undefined;
};

const answered = (cards: string[], answer: string | null): Event => ({
  seq: 1,
  type: 'session.answered',
  at: AT,
  data: { id: SESSION, card: 2, cards, answer },
});

const askEvent = (cards: AskCard[]): Event => ({
  seq: 1,
  type: 'session.ask',
  at: AT,
  data: { id: SESSION, card: 2, cards },
});

describe('a question card', () => {
  const open = cardsRead(NO_CARDS, question());

  test('drawn as C-Question: title, why, the recommended row first and selected, o, the keys', () => {
    expect(node(open)).toEqual({
      kind: 'QuestionCard',
      id: 'card:q-1',
      props: {
        ask: 'question',
        title: 'Which market table should the cart total read?',
        why: "The story's comments mention a per-market setting",
        options: [
          { n: 1, label: 'The existing market table', recommended: true },
          { n: 2, label: 'A new setting per market' },
          { n: 3, label: 'Keep the current behaviour' },
        ],
        own: 'Type your own answer…',
        selected: 1,
        foot: '1–3 pick · ⏎ answer · o own words · Esc later',
      },
    });
    expect(cardsOpen(open)).toBe(true);
    expect(waitingCount(open)).toBe(1);
  });

  test("the question first, the rest folded under it (m unfolds); each option's description dim under its label", () => {
    const long = {
      question:
        'Should sign-in by email send a one-time magic link, or ask for a password the visitor sets on first sign-in? The story says "sign in with email" and the comments disagree.',
      header: 'Sign-in',
      options: [
        {
          label: 'Magic link (Recommended)',
          description: 'No password to store; the email service already sends mail.',
        },
        { label: 'Password set on first sign-in', description: 'Needs a reset flow first.' },
        { label: 'Both', description: '  ' },
      ],
    };
    const read = cardsRead(NO_CARDS, question('q-2', long));
    const n = node(read);

    expect(n?.kind === 'QuestionCard' ? [n.props.title, n.props.why, n.props.more] : null).toEqual([
      'Should sign-in by email send a one-time magic link, or ask for a password the visitor sets on first sign-in?',
      'Sign-in',
      'The story says "sign in with email" and the comments disagree.',
    ]);
    // m (or a click on its line) unfolds the context and folds it again; nothing else moves
    expect(node(keys(read, 'm').cards)).toMatchObject({ props: { moreOpen: true, selected: 1 } });
    expect(node(keys(read, 'm m').cards)).not.toHaveProperty('props.moreOpen');
    expect(cardsClick(read, 'card:q-2:more', FACTS)?.cards.more).toBe('q-2');
    // context first, the question last: the question is still the title, the context folded
    const late = node(
      cardsRead(
        NO_CARDS,
        question('q-3', {
          ...long,
          header: '',
          question:
            'The story says "sign in with email".\nThe comments disagree. Magic link or password?',
        }),
      ),
    );

    expect(late).toMatchObject({
      props: {
        title: 'Magic link or password?',
        more: 'The story says "sign in with email".\nThe comments disagree.',
      },
    });
    expect(late).not.toHaveProperty('props.why');
    expect(n?.kind === 'QuestionCard' ? n.props.options : null).toEqual([
      {
        n: 1,
        label: 'Magic link',
        note: 'No password to store; the email service already sends mail.',
        recommended: true,
      },
      { n: 2, label: 'Password set on first sign-in', note: 'Needs a reset flow first.' },
      { n: 3, label: 'Both' },
    ]);
  });

  test('a digit answers at once: session answer --option, the card folds to its line', () => {
    const out = keys(open, '1');

    expect(argvs(out.commands)).toEqual([
      ['session', 'answer', SESSION, '--card', 'q-1', '--option', '1'],
    ]);
    expect(node(out.cards)).toBeNull();
    expect(foldedNodes(out.cards)).toEqual([
      {
        at: AT,
        // its answer goes as the next prompt: the transcript's line takes over once it came
        question: 'Which market table should the cart total read?',
        node: {
          kind: 'CardLine',
          id: 'answered:q-1',
          props: { head: 'Answered', text: 'The existing market table', n: 1 },
        },
      },
    ]);
    // serve says so: the card is gone everywhere, its line stays
    const said = cardsEvent(
      out.cards,
      SESSION,
      answered(['q-1'], 'Answer to "…": 1 The existing market table'),
    );

    expect(said.open).toEqual([]);
    expect(said.folded).toMatchObject([{ pending: false, text: 'The existing market table' }]);
    expect(waitingCount(said)).toBe(0);
  });

  test('a digit past the options does nothing', () => {
    const out = keys(open, '7');

    expect(out.commands).toEqual([]);
    expect(out.handled).toEqual([true]);
    expect(node(out.cards)).not.toBeNull();
  });

  test('ö / l move the selection, ⏎ answers the selected row', () => {
    const out = keys(open, 'ö ö l ö <CR>');

    expect(argvs(out.commands)).toEqual([
      ['session', 'answer', SESSION, '--card', 'q-1', '--option', '3'],
    ]);
  });

  test('o types your own words; ⏎ sends them as --text; Esc goes back to the options', () => {
    const typing = keys(open, 'o u s e <Space> i t');

    expect(node(typing.cards)).toMatchObject({
      props: {
        typing: 'use it',
        selected: 'own',
        foot: '⏎ answer · Esc back to the options',
      },
    });
    // digits and l / ö are text while typing
    const more = keys(typing.cards, '<BS> <BS> 1 l');

    expect(more.cards.typing).toEqual({ card: 'q-1', text: 'use 1l' });
    expect(argvs(keys(more.cards, '<CR>').commands)).toEqual([
      ['session', 'answer', SESSION, '--card', 'q-1', '--text', 'use 1l'],
    ]);
    expect(keys(typing.cards, '<Esc>').cards.typing).toBeUndefined();
    expect(cardsOpen(keys(typing.cards, '<Esc>').cards)).toBe(true);
  });

  test('⏎ on the own row starts typing; empty own words send nothing', () => {
    const out = keys(open, 'ö ö ö <CR> <CR>');

    expect(out.cards.typing).toEqual({ card: 'q-1', text: '' });
    expect(out.commands).toEqual([]);
  });

  test('a paste goes into the own words', () => {
    const typing = keys(open, 'o').cards;

    expect(cardsText(typing, 'the market\ntable').typing?.text).toBe('the market table');
    expect(cardsText(open, 'nowhere')).toEqual(open);
  });

  test("the app's own field types them as numbered drafts (lines kept); an older one changes nothing", () => {
    const typing = keys(open, 'o').cards;
    const typed = cardsDraft(typing, 'the market\r\ntable', 2);

    expect(node(typed)).toMatchObject({ props: { typing: 'the market\ntable', seq: 2 } });
    expect(cardsDraft(typed, 'the', 1)).toEqual(typed);
    expect(cardsDraft(open, 'nowhere', 3)).toEqual(open);
    expect(keys(typed, '<CR>').commands.length).toBe(1);
  });

  test('your own words take the caret: ← ⌥← ⌘→ move it, typing, ⌫ and a paste at it (#314)', () => {
    const typing = keys(open, 'o u s e <Space> i t <M-Left> <Left>');

    expect(node(typing.cards)).toMatchObject({ props: { typing: 'use it', caret: 3 } });
    const more = keys(cardsText(keys(typing.cards, '<BS>').cards, 'd'), '<D-Right> <BS>');

    expect(more.cards.typing).toEqual({ card: 'q-1', text: 'usd i' });
    expect(node(more.cards)?.props).not.toHaveProperty('caret');
  });

  test('the Override reason takes the caret too (#314)', () => {
    const typed = keys(openOverride(NO_CARDS, 'db write test', FACTS), 'S d <Left> e e');

    expect(typed.cards.override).toMatchObject({ reason: 'Seed', caret: 3 });
  });

  test('clicks: an option row answers, the own row types', () => {
    expect(argvs(cardsClick(open, 'card:q-1:2', FACTS)?.commands ?? [])).toEqual([
      ['session', 'answer', SESSION, '--card', 'q-1', '--option', '2'],
    ]);
    expect(cardsClick(open, 'card:q-1:own', FACTS)?.cards.typing).toEqual({
      card: 'q-1',
      text: '',
    });
    expect(cardsClick(open, 'elsewhere', FACTS)).toBeUndefined();
  });

  test('a refused answer unfolds the card again and says why', () => {
    const sent = keys(open, '2').cards;
    const back = cardsResult(sent, {
      kind: 'result',
      id: 'cards:answer:q-1',
      command: 'session answer',
      reply: { ok: false, error: { code: 'tmux-failed', message: 'no server' } },
    });

    expect(back.cards.folded).toEqual([]);
    expect(node(back.cards)).toMatchObject({ id: 'card:q-1' });
    expect(back.commands).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'balloon', tone: 'error', text: 'no server (tmux-failed)' },
      },
    ]);
  });

  test('answered elsewhere: its line from the answer sent, or outside Chat', () => {
    const there = cardsEvent(
      open,
      SESSION,
      answered(['q-1'], 'Answer to "Which?": 2 A new setting per market'),
    );

    expect(foldedNodes(there)[0]?.node.props).toEqual({
      head: 'Answered',
      text: 'A new setting per market',
      n: 2,
    });
    const terminal = cardsEvent(open, SESSION, answered(['q-1'], null));

    expect(foldedNodes(terminal)[0]?.node.props).toEqual({ head: 'Answered outside Chat' });
    // another session's events change nothing
    expect(cardsEvent(open, 'abe-3-1', answered(['q-1'], null))).toEqual(open);
  });
});

describe('a multiSelect question: Space or a digit ticks, ⏎ sends what is ticked', () => {
  const open = cardsRead(NO_CARDS, question('q-m', { ...MARKET, multiSelect: true }));
  const sent = (...options: number[]) => [
    'session',
    'answer',
    SESSION,
    '--card',
    'q-m',
    ...options.flatMap((n) => ['--option', String(n)]),
  ];

  test('drawn with a box per option, the ticked ones ticked, its own keys', () => {
    expect(node(keys(open, '<Space>').cards)).toMatchObject({
      props: {
        multi: true,
        options: [
          { n: 1, ticked: true },
          { n: 2, ticked: false },
          { n: 3, ticked: false },
        ],
        foot: 'Space or 1–3 tick · ⏎ send · o own words · Esc later',
      },
    });
  });

  test.each<[string, string, string[], string]>([
    [
      'Space on two rows',
      '<Space> ö <Space> <CR>',
      sent(1, 2),
      'The existing market table, A new setting per market',
    ],
    [
      'digits, in the card’s order',
      '3 1 <CR>',
      sent(1, 3),
      'The existing market table, Keep the current behaviour',
    ],
    ['a second tick takes it off', '1 3 1 <CR>', sent(3), 'Keep the current behaviour'],
    ['none ticked: the selected row alone', 'ö <CR>', sent(2), 'A new setting per market'],
  ])('%s', (_, typed, argv, line) => {
    const out = keys(open, typed);

    expect(argvs(out.commands)).toEqual([argv]);
    expect(foldedNodes(out.cards).map((x) => x.node.props.text)).toEqual([line]);
  });

  test('a click on a row ticks it; nothing is sent until ⏎', () => {
    const clicked = cardsClick(open, 'card:q-m:2', FACTS);

    expect(clicked?.commands).toEqual([]);
    expect(argvs(keys(clicked?.cards ?? open, '<CR>').commands)).toEqual([sent(2)]);
  });

  test('in a grill round: ⏎ picks the ticked ones, kept by serve, sent with the round', () => {
    const multi = {
      questions: ROUND.questions.map((q, i) => (i === 1 ? { ...q, multiSelect: true } : q)),
    };
    const out = keys(cardsRead(NO_CARDS, asked(multi, 'q-8')), 'y 1 2 <CR> y <CR>');

    expect(argvs(out.commands)).toEqual([
      pickArgv('q-8.1', '1:1'),
      pickArgv('q-8.2', '2:[1,2]'),
      pickArgv('q-8.3', '3:1'),
      ['session', 'answer', SESSION, '--card', 'q-8', '--answers', '[1,[1,2],1]'],
    ]);
  });
});

describe('Esc leaves it for later: the pill above the composer', () => {
  const open = cardsRead(NO_CARDS, question());

  test('the card folds into the pill; ⏎ / its click opens the same card again', () => {
    const later = keys(open, '<Esc>').cards;

    expect(node(later)).toBeNull();
    expect(cardsOpen(later)).toBe(false);
    // ◆ still waits: the session is Needs you
    expect(waitingCount(later)).toBe(1);
    expect(pillNode(later)).toEqual({
      kind: 'DeferredPill',
      id: 'cards:pill',
      props: { count: 1, text: 'Which market table should the cart total read?' },
    });
    // no card up: the keys are the screen's
    expect(keys(later, '1').handled).toEqual([false]);
    expect(node(cardsReopen(later))).toMatchObject({ id: 'card:q-1' });
    expect(node(cardsClick(later, 'cards:pill', FACTS)?.cards ?? later)).toMatchObject({
      id: 'card:q-1',
    });
  });
});

describe('the stack', () => {
  const three = cardsRead(NO_CARDS, [
    ...question('q-1'),
    ...question('q-2', { ...MARKET, question: 'Round once on the total, or per line?' }),
    ...question('q-3', { ...MARKET, question: 'Which currency?' }),
  ]);

  test('the oldest shows with 1 of 3 and the edges of the two under it; answering shows the next, 2 of 3', () => {
    expect(node(three)).toMatchObject({
      id: 'card:q-1',
      props: { stack: { n: 1, of: 3 }, under: 2 },
    });
    const next = keys(three, '1').cards;

    expect(node(next)).toMatchObject({
      id: 'card:q-2',
      props: { title: 'Round once on the total, or per line?', stack: { n: 2, of: 3 }, under: 1 },
    });
    const last = keys(next, '1').cards;

    expect(node(last)).toMatchObject({ id: 'card:q-3', props: { stack: { n: 3, of: 3 } } });
    expect(waitingCount(last)).toBe(1);
  });

  test('a card asked later joins the stack (session.ask)', () => {
    const one = cardsRead(NO_CARDS, question('q-1'));
    const two = cardsEvent(one, SESSION, askEvent(question('q-2')));

    expect(node(two)).toMatchObject({ id: 'card:q-1', props: { stack: { n: 1, of: 2 } } });
  });

  test('once none are open the count starts again', () => {
    const one = cardsRead(NO_CARDS, question('q-1'));
    const done = cardsEvent(keys(one, '1').cards, SESSION, answered(['q-1'], 'x'));

    expect(done.stacked).toBe(0);
    expect(node(cardsRead(done, question('q-9')))).not.toHaveProperty('props.stack');
  });
});

describe('a grill round: one card per question, one send', () => {
  const round = cardsRead(NO_CARDS, asked(ROUND, 'q-7'));

  test('drawn as C-Grill: the round header, one question at a time with its place, 1 of 3', () => {
    expect(node(round)).toEqual({
      kind: 'GrillRound',
      id: 'round:q-7',
      props: {
        round: 1,
        questions: 3,
        answered: 0,
        dots: ['now', 'todo', 'todo'],
        foot: 'y recommended · 1–9 pick · o own words · ⏎ send all · Tab next',
      },
      children: [
        {
          kind: 'QuestionCard',
          id: 'card:q-7.1',
          props: {
            ask: 'grill',
            title: 'Static column widths?',
            why: 'Columns',
            options: [
              { n: 1, label: 'No, static widths', recommended: true },
              { n: 2, label: 'Yes, fixed widths' },
            ],
            own: 'Type your own answer…',
            selected: 1,
            stack: { n: 1, of: 3 },
          },
        },
      ],
    });
    // picked: the next one in its place, 2 of 3
    expect(childOf(keys(round, 'y').cards, 0)).toMatchObject({
      id: 'card:q-7.2',
      props: { title: 'Status bar per view?', stack: { n: 2, of: 3 } },
    });
  });

  test('a question with no recommendation: no y on it (#286)', () => {
    const open = {
      questions: [
        ROUND.questions[0],
        {
          question: 'Keep the old password form behind a flag?',
          header: 'Flag',
          options: [
            { label: 'No', description: '' },
            { label: 'Yes', description: '' },
          ],
        },
      ],
    };
    const r = keys(cardsRead(NO_CARDS, asked(open, 'q-8')), '<Tab>').cards;

    expect(childOf(r, 0)).toMatchObject({
      id: 'card:q-8.2',
      props: { title: 'Keep the old password form behind a flag?', stack: { n: 2, of: 2 } },
    });
    expect(node(r)).toMatchObject({
      props: { foot: '1–9 pick · o own words · ⏎ send all · Tab next' },
    });
  });

  test('every question answered: ⏎ send all leads the key line (#286)', () => {
    expect(node(keys(round, '1 2').cards)).toMatchObject({
      props: { foot: 'y recommended · 1–9 pick · o own words · ⏎ send all · Tab next' },
    });
    expect(node(keys(round, '1 2 1').cards)).toMatchObject({
      props: { answered: 3, foot: '⏎ send all · Tab back to a question' },
    });
  });

  test('y y y ⏎: one message numbered 1–3 with the recommended answers', () => {
    const agreed = keys(round, 'y y y');

    // each pick kept by serve as it is made; nothing typed into the session yet
    expect(argvs(agreed.commands)).toEqual([
      pickArgv('q-7.1', '1:1'),
      pickArgv('q-7.2', '2:1'),
      pickArgv('q-7.3', '3:1'),
    ]);
    expect(node(agreed.cards)).toMatchObject({
      props: { answered: 3, dots: ['done', 'done', 'done'] },
      children: [
        { kind: 'CardLine', props: { head: 'Q1', text: 'No, static widths', n: 1, boxed: true } },
        { kind: 'CardLine', props: { head: 'Q2' } },
        { kind: 'CardLine', props: { head: 'Q3' } },
      ],
    });
    const sent = keys(agreed.cards, '<CR>');

    expect(argvs(sent.commands)).toEqual([
      ['session', 'answer', SESSION, '--card', 'q-7', '--answers', '[1,1,1]'],
    ]);
    expect(node(sent.cards)).toBeNull();
    expect(foldedNodes(sent.cards).map((x) => x.node.props)).toEqual([
      { head: 'Answered', text: 'Round 1 · 3 questions' },
    ]);
  });

  test('a digit picks (no send) and moves on; ⏎ on the last sends all', () => {
    const out = keys(round, '2 1 <CR>');

    expect(argvs(out.commands)).toEqual([
      pickArgv('q-7.1', '1:2'),
      pickArgv('q-7.2', '2:1'),
      pickArgv('q-7.3', '3:1'),
      ['session', 'answer', SESSION, '--card', 'q-7', '--answers', '[2,1,1]'],
    ]);
  });

  test('⇧Tab back to an answered one: its line selected, ⏎ opens it again, a new pick', () => {
    const two = keys(round, 'y y').cards;
    const back = keys(two, '<S-Tab> <S-Tab>').cards;

    expect(node(back)).toMatchObject({ props: { dots: ['now', 'done', 'todo'], answered: 2 } });
    expect(childOf(back, 0)).toMatchObject({
      kind: 'CardLine',
      props: { head: 'Q1', selected: true },
    });
    // on the line, a digit picks nothing
    expect(keys(back, '2').cards.picks).toEqual(back.picks);
    const opened = keys(back, '<CR>').cards;

    expect(childOf(opened, 0)).toMatchObject({
      kind: 'QuestionCard',
      id: 'card:q-7.1',
      props: { selected: 1 },
    });
    // picked anew, on to the one not answered yet
    const repicked = keys(opened, '2').cards;

    expect(repicked.picks['q-7.1']).toEqual({ option: 2 });
    expect(node(repicked)).toMatchObject({ props: { dots: ['done', 'done', 'now'] } });
    expect(argvs(keys(repicked, 'y <CR>').commands)).toEqual([
      pickArgv('q-7.3', '3:1'),
      ['session', 'answer', SESSION, '--card', 'q-7', '--answers', '[2,1,1]'],
    ]);
  });

  test('Tab moves to the next card; o own words, ⏎ takes them and moves on; ⏎ on the last sends', () => {
    const out = keys(round, '<Tab> o n o p e <CR> y');

    expect(argvs(out.commands)).toEqual([pickArgv('q-7.2', '2:"nope"'), pickArgv('q-7.3', '3:1')]);
    expect(out.cards.picks).toEqual({ 'q-7.2': { text: 'nope' }, 'q-7.3': { option: 1 } });
    // back round to Q1, the one left: ⏎ picks its selected row and the round goes
    expect(node(out.cards)).toMatchObject({
      props: { dots: ['now', 'done', 'done'], answered: 2 },
    });
    expect(argvs(keys(out.cards, '<CR>').commands)).toEqual([
      pickArgv('q-7.1', '1:1'),
      ['session', 'answer', SESSION, '--card', 'q-7', '--answers', '[1,"nope",1]'],
    ]);
  });

  test('picks serve kept show again (#342: a restart, another client); one made here wins', () => {
    const kept = [{ option: 2 }, { text: 'per view' }] as const;
    const cards = asked(ROUND, 'q-7').map((c, i) => {
      const picked = kept[i];

      return picked === undefined ? c : { ...c, picked };
    });
    const read = cardsRead(NO_CARDS, cards);

    expect(read.picks).toEqual({ 'q-7.1': { option: 2 }, 'q-7.2': { text: 'per view' } });
    expect(node(read)).toMatchObject({ props: { answered: 2, dots: ['done', 'done', 'now'] } });
    // ⏎ on the last one sends the whole round, the kept picks in it
    expect(argvs(keys(read, '<CR>').commands)).toEqual([
      pickArgv('q-7.3', '3:1'),
      ['session', 'answer', SESSION, '--card', 'q-7', '--answers', '[2,"per view",1]'],
    ]);
    // a pick made here and not heard back yet is not undone by an older read
    const mine = keys(cardsRead(NO_CARDS, asked(ROUND, 'q-7')), '1').cards;

    expect(cardsRead(mine, cards).picks['q-7.1']).toEqual({ option: 1 });
  });

  test('a pick refused once its card is gone is dropped quietly; on an open card it says why', () => {
    const refusal = (id: string) => ({
      kind: 'result' as const,
      id: `cards:pick:${id}`,
      command: 'session answer' as const,
      reply: { ok: false as const, error: { code: 'no-card', message: 'no open card' } },
    });

    expect(cardsResult(round, refusal('q-9.1')).commands).toEqual([]);
    expect(cardsResult(round, refusal('q-7.1')).commands).toEqual([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'error', text: 'no open card (no-card)' } },
    ]);
  });

  test('Esc leaves the whole round for later', () => {
    const later = keys(round, 'y <Esc>').cards;

    expect(node(later)).toBeNull();
    expect(pillNode(later)?.props).toEqual({ count: 1, text: 'Round 1 · 3 questions' });
    expect(node(cardsReopen(later))).toMatchObject({
      props: { answered: 1, dots: ['done', 'now', 'todo'] },
    });
  });

  test('rounds are numbered as Chat met them', () => {
    const first = cardsEvent(
      keys(round, 'y y y <CR>').cards,
      SESSION,
      answered(['q-7.1', 'q-7.2', 'q-7.3'], 'x'),
    );
    const second = cardsEvent(first, SESSION, askEvent(asked(ROUND, 'q-8')));

    expect(node(second)).toMatchObject({ props: { round: 2 } });
  });
});

describe('a permission card (an Override live)', () => {
  const open = cardsRead(NO_CARDS, [permission()]);

  test('drawn as C-Permission: the command mono, Reach and where, Allow once recommended', () => {
    expect(node(open)).toEqual({
      kind: 'QuestionCard',
      id: 'card:p-1',
      props: {
        ask: 'permission',
        title: 'Allow Bash: npm ci?',
        mono: 'npm ci',
        why: 'Reach: writes only in the worktree',
        where: "Local sandbox · the command runs in Claude Code's sandbox",
        options: [
          { n: 1, label: 'Allow once', recommended: true },
          { n: 2, label: 'Allow for this session' },
          { n: 3, label: 'Deny' },
        ],
        own: 'Tell it what to do instead…',
        selected: 1,
        foot: '1–3 pick · ⏎ answer · o own words · Esc later',
      },
    });
  });

  test('1 allows once through session answer', () => {
    expect(argvs(keys(open, '1').commands)).toEqual([
      ['session', 'answer', SESSION, '--card', 'p-1', '--option', '1'],
    ]);
  });

  test('past its hold: the card says where to answer, only Esc does anything', () => {
    const expired = cardsRead(NO_CARDS, [
      { ...permission(), expired: 'Answer in Terminal mode · ⌘4' },
    ]);

    expect(node(expired)).toMatchObject({ props: { expired: 'Answer in Terminal mode · ⌘4' } });
    expect(node(expired)).not.toHaveProperty('props.foot');
    expect(node(expired)).not.toHaveProperty('props.selected');
    expect(keys(expired, '1 <CR> o').commands).toEqual([]);
    expect(node(keys(expired, '<Esc>').cards)).toBeNull();
  });
});

const RUN: FactoryRunData = factoryRun(1, 'Show stock on a product card', 'spec', 'needs-you', {
  session: SESSION,
  reason: 'No stock source: the product API has no stock field, and the story names none',
});

describe("a Factory run's Needs you", () => {
  const live = { state: 'waiting' as const };
  const open = cardsRun(NO_CARDS, RUN, live);

  test('drawn as C-NeedsYou: the reason, the stage it waits in, Done continue · Open workspace · End', () => {
    expect(node(open)).toEqual({
      kind: 'QuestionCard',
      id: 'card:needs-you:abe-2-1',
      props: {
        ask: 'needs-you',
        title: 'No stock source: the product API has no stock field, and the story names none',
        why: 'The run waits in Spec until you answer',
        options: [
          { n: 1, label: 'Done, continue', recommended: true },
          { n: 2, letter: 'w', label: 'Open workspace' },
          { n: 3, letter: 'e', label: 'End the run…' },
        ],
        own: 'Tell it something…',
        selected: 1,
        foot: '1 pick · ⏎ answer · o own words · Esc later',
      },
    });
  });

  test('at verify it names Verify, its own step, not the rail stage it lights (Review)', () => {
    expect(needsYouCard({ ...RUN, stage: 'verify' }, live)?.why).toBe(
      'The run waits in Verify until you answer',
    );
  });

  test('a prototype: e stops its session, as before #184 (it is never ended as a run)', () => {
    const proto = needsYouCard({ ...RUN, prototype: true }, live);

    expect(proto?.options.at(-1)).toEqual({
      n: 3,
      label: 'Stop the run',
      recommended: false,
      letter: 'e',
    });
    expect(proto?.ends).toBeUndefined();
  });

  test("only for the run's own reason, never its session's", () => {
    expect(needsYouCard({ ...RUN, reason: 'waiting on you in Chat' }, live)).toBeUndefined();
    expect(needsYouCard({ ...RUN, reason: 'its session ended' }, live)).toBeUndefined();
    expect(needsYouCard({ ...RUN, state: 'running', reason: null }, live)).toBeUndefined();
    // a pull request waiting on its merge or its checks is not a word to the session
    const pr = factoryRun(1, 'x', 'pr', 'needs-you', {
      session: SESSION,
      reason: 'merge waits for a person',
      pr: {
        repo: 'mkdir-swe/demo-shop',
        number: 7,
        url: 'https://github.com/mkdir-swe/demo-shop/pull/7',
        state: 'open',
        merge: 'person',
        checks: 'success',
        mergeCommit: null,
        deploy: null,
        branch: null,
      },
    });

    expect(needsYouCard(pr, live)).toBeUndefined();
    // merged, its deploy failed (#361): it waits on you, no continue; End the run… leads
    const failed = {
      ...pr,
      reason: 'the deploy to test failed: no link',
      pr:
        pr.pr === null
          ? null
          : {
              ...pr.pr,
              state: 'merged' as const,
              deploy: 'failure' as const,
            },
    };

    expect(needsYouCard(failed, live)).toMatchObject({
      title: 'the deploy to test failed: no link',
      why: 'Merged; its deploy failed. Re-run the deploy and Done follows, or end the run',
      options: [
        { n: 2, label: 'Open workspace' },
        { n: 3, label: 'End the run…', recommended: true },
      ],
      own: 'Tell it something…',
      ends: 1,
    });
    expect(needsYouCard(failed, { state: 'ended' })?.own).toBeNull();
  });

  test('1 sends continue as the next prompt; the run going on settles its line', () => {
    const out = keys(open, '1');

    expect(argvs(out.commands)).toEqual([['session', 'send', SESSION, 'continue']]);
    expect(node(out.cards)).toBeNull();
    const on = cardsRun(out.cards, { ...RUN, state: 'running', reason: null }, live);

    expect(on.needsYou).toBeUndefined();
    expect(foldedNodes(on).map((x) => x.node.props)).toEqual([
      { head: 'Answered', text: 'Done, continue', n: 1 },
    ]);
    expect(on.folded[0]?.pending).toBe(false);
  });

  test("w jumps to the run's workspace (#106); the card stays; 2 is no answer of the agent's", () => {
    const needs: CardFacts = { ...FACTS, card: 1 };

    expect(keys(open, 'w', needs).commands).toEqual([{ kind: 'jump', to: 'workspace', story: 1 }]);
    expect(argvs(keys(open, 'ö <CR>', needs).commands)).toEqual([]);
    expect(node(keys(open, 'w', needs).cards)).not.toBeNull();
    expect(keys(open, '2', needs).commands).toEqual([]);
  });

  test('e asks how and why, then ends the run (#184): stopping only its session left it waiting', () => {
    expect(keys(open, '3').commands).toEqual([]);
    expect(keys(open, 'e').commands).toEqual([
      { kind: 'ask', argv: ['factory', 'end', '1'], summary: "End #1's run", ask: endAsks(RUN) },
    ]);
    expect(endAsks(RUN).map((a) => a.name)).toEqual(['as', 'reason']);
    // nothing folds before it is asked
    expect(node(keys(open, 'e').cards)).not.toBeNull();
  });

  test('e on a bug that does not reproduce starts the pick on Not reproduced, else on Abandoned, never Done (#320)', () => {
    const asked = (run: FactoryRunData) => {
      const [c] = keys(cardsRun(NO_CARDS, run, live), 'e').commands;

      return c?.kind === 'ask' ? c.ask[0]?.preselect : undefined;
    };

    expect(asked(RUN)).toBe('abandoned');
    expect(asked({ ...RUN, reason: 'not reproduced: the code formats every price with EUR' })).toBe(
      'not-reproduced',
    );
  });

  test('own words go as the next prompt', () => {
    expect(argvs(keys(open, 'o u s e <Space> m o c k <CR>').commands)).toEqual([
      ['session', 'send', SESSION, 'use mock'],
    ]);
  });
});

describe("a Factory run's Needs you that asks a question (#303)", () => {
  const live = { state: 'waiting' as const };
  const asks = {
    ...RUN,
    reason:
      'Should an out-of-stock product stay in the list (greyed out, Add to cart disabled) or be hidden from the list?',
  };
  const open = cardsRun(NO_CARDS, asks, live);

  test('no Done, continue to recommend: your answer leads, selected, then Open workspace and End', () => {
    expect(node(open)).toEqual({
      kind: 'QuestionCard',
      id: 'card:needs-you:abe-2-1',
      props: {
        ask: 'needs-you',
        title: asks.reason,
        why: 'The run waits in Spec until you answer',
        options: [
          { n: 2, letter: 'w', label: 'Open workspace' },
          { n: 3, letter: 'e', label: 'End the run…' },
        ],
        own: 'Answer it…',
        selected: 'own',
        foot: '⏎ answer · o own words · Esc later',
      },
    });
  });

  test('a question mark only when it ends a sentence of the first line, never in setup output', () => {
    const first = (reason: string) => needsYouCard({ ...RUN, reason }, live)?.options[0]?.label;

    expect(first('not reproduced: can you tell me where the shopper saw 14.50?')).toBe(
      'Open workspace',
    );
    expect(first('Stay or hide? Both fit the story')).toBe('Open workspace');
    expect(first('No stock field: see https://api.example.test/products?id=4')).toBe(
      'Done, continue',
    );
    expect(
      first("the repo's setup `npm ci` failed (exit 1) in the new worktree:\nOk to proceed? (y)"),
    ).toBe('Done, continue');
    expect(first('Needs AWS access\nwhy? the bucket is private')).toBe('Done, continue');
  });

  test('⏎ types your answer, sent as the next prompt; no digit sends anything', () => {
    expect(argvs(keys(open, '<CR> s t a y <CR>').commands)).toEqual([
      ['session', 'send', SESSION, 'stay'],
    ]);
    expect(keys(open, '1').commands).toEqual([]);
    expect(keys(open, '3').commands).toEqual([]);
    expect(keys(open, 'e').commands).toMatchObject([
      { kind: 'ask', argv: ['factory', 'end', '1'] },
    ]);
    // a prototype stops its run as e, as on every Needs you of one
    expect(needsYouCard({ ...asks, prototype: true }, live)?.options.at(-1)).toEqual({
      n: 3,
      label: 'Stop the run',
      recommended: false,
      letter: 'e',
    });
    // your answer's row is drawn last, as on every card: up walks to End, then Open workspace
    expect(keys(open, 'l l <CR>', { ...FACTS, card: 1 }).commands).toEqual([
      { kind: 'jump', to: 'workspace', story: 1 },
    ]);
  });
});

describe("a Factory run's Needs you with the agent's options (#213 B3)", () => {
  const live = { state: 'waiting' as const };
  const offers = {
    ...RUN,
    reason: 'The branch has old commits from the last try: keep them or start fresh?',
    options: ['Keep the old commits', 'Start fresh'],
  };
  const open = cardsRun(NO_CARDS, offers, live);

  test('its options are 1 and 2 as it numbered them, then Open workspace w and End the run… e; own words stay', () => {
    expect(node(open)).toEqual({
      kind: 'QuestionCard',
      id: 'card:needs-you:abe-2-1',
      props: {
        ask: 'needs-you',
        title: offers.reason,
        why: 'The run waits in Spec until you answer',
        options: [
          { n: 1, label: 'Keep the old commits' },
          { n: 2, label: 'Start fresh' },
          { n: 3, letter: 'w', label: 'Open workspace' },
          { n: 4, letter: 'e', label: 'End the run…' },
        ],
        own: 'Answer it…',
        selected: 1,
        foot: '1–2 pick · ⏎ answer · o own words · Esc later',
      },
    });
  });

  test('1 or 2 sends that answer as the next prompt; w jumps to the workspace; e ends the run; 3 and 4 nothing', () => {
    expect(argvs(keys(open, '2').commands)).toEqual([['session', 'send', SESSION, 'Start fresh']]);
    expect(argvs(keys(open, '<CR>').commands)).toEqual([
      ['session', 'send', SESSION, 'Keep the old commits'],
    ]);
    expect(keys(open, 'w', { ...FACTS, card: 1 }).commands).toEqual([
      { kind: 'jump', to: 'workspace', story: 1 },
    ]);
    expect(keys(open, '3').commands).toEqual([]);
    expect(keys(open, '4').commands).toEqual([]);
    expect(keys(open, 'e').commands).toMatchObject([
      { kind: 'ask', argv: ['factory', 'end', '1'] },
    ]);
    expect(argvs(keys(open, 'o m e r g e <Space> t h e m <CR>').commands)).toEqual([
      ['session', 'send', SESSION, 'merge them'],
    ]);
    // a prototype's last is Stop the run
    expect(needsYouCard({ ...offers, prototype: true }, live)?.options.at(-1)).toEqual({
      n: 4,
      label: 'Stop the run',
      recommended: false,
      letter: 'e',
    });
  });

  test('its session ended: Retry as always, the options gone (nothing to send them to)', () => {
    expect(needsYouCard(offers, { state: 'ended' })?.options.map((o) => o.label)).toEqual([
      'Retry',
      'Open workspace',
      'End the run…',
    ]);
  });
});

describe("a Factory run's Needs you on an ended session (a no-start, #114 Behaviour 5)", () => {
  const ended = { state: 'ended' as const };
  const noStart = { ...RUN, reason: 'its claude did not start: no SessionStart hook within 30 s' };
  const open = cardsRun(NO_CARDS, noStart, ended);

  test('still a card: Retry (recommended) · Open workspace · End the run…, no own words', () => {
    expect(node(open)).toEqual({
      kind: 'QuestionCard',
      id: 'card:needs-you:abe-2-1',
      props: {
        ask: 'needs-you',
        title: 'its claude did not start: no SessionStart hook within 30 s',
        why: 'The session ended; the run waits in Spec until you answer',
        options: [
          { n: 1, label: 'Retry', recommended: true },
          { n: 2, letter: 'w', label: 'Open workspace' },
          { n: 3, letter: 'e', label: 'End the run…' },
        ],
        selected: 1,
        foot: '1 pick · ⏎ answer · Esc later',
      },
    });
  });

  test("1 launches the card again, as ⌘⏎'s Retry; o and ö to the own row do nothing", () => {
    expect(argvs(keys(open, '1').commands)).toEqual([
      ['factory', 'run', '1', '--repo', 'mkdir-swe/demo-shop'],
    ]);
    const o = keys(open, 'o');

    expect(o.cards.typing).toBeUndefined();
    expect(argvs(keys(open, 'ö ö <CR>', { ...FACTS, card: 1 }).commands)).toEqual([]);
    // e ends it (#184): the session stopped, the run still waits on you
    expect(keys(open, 'e').commands).toMatchObject([
      { kind: 'ask', argv: ['factory', 'end', '1'] },
    ]);
    expect(cardsClick(open, 'card:needs-you:abe-2-1:own', FACTS)).toBeUndefined();
    // its session's own word for ending stays the session's: no card
    expect(needsYouCard({ ...RUN, reason: 'its session ended' }, ended)).toBeUndefined();
  });
});

describe("a teammate's session: read-only", () => {
  const theirs: CardFacts = { ...FACTS, whose: 'Ada Example' };
  const open = cardsRead(NO_CARDS, question());

  test('waiting on them in place of the keys; no row selected; no key taken', () => {
    expect(node(open, theirs)).toMatchObject({ props: { whose: 'waiting on Ada Example' } });
    expect(node(open, theirs)).not.toHaveProperty('props.foot');
    expect(node(open, theirs)).not.toHaveProperty('props.selected');
    const out = keys(open, '1 <CR> o <Esc>', theirs);

    expect([out.commands, out.handled]).toEqual([[], [false, false, false, false]]);
    expect(cardsClick(open, 'card:q-1:1', theirs)).toBeUndefined();
  });

  test('a round too', () => {
    const round = cardsRead(NO_CARDS, asked(ROUND, 'q-7'));

    expect(node(round, theirs)).toMatchObject({ props: { whose: 'waiting on Ada Example' } });
    expect(node(round, theirs)).toMatchObject({ props: { dots: ['todo', 'todo', 'todo'] } });
  });
});

describe('/override: the Override card', () => {
  const card = openOverride(NO_CARDS, 'db write test', FACTS);

  test('drawn as C-Override: the area in words, the reason field, Reach, Until', () => {
    expect(node(card)).toEqual({
      kind: 'OverrideCard',
      id: 'override',
      props: {
        title: 'Override · Test DB write',
        line: 'Reach lowered for this session only · tracked on #2 and the PR',
        reason: '',
        facts: [
          { label: 'Reach', text: 'Test DB · read → write' },
          { label: 'Until', text: 'this session ends' },
        ],
        foot: '⏎ override · Esc cancel',
      },
    });
    expect(cardsOpen(card)).toBe(true);
  });

  test('⏎ with an empty reason does nothing but mark the field', () => {
    const out = keys(card, '<Space> <CR>');

    expect(out.commands).toEqual([]);
    expect(node(out.cards)).toMatchObject({ props: { missing: true } });
  });

  test('with a reason: session override --what --reason; done, the card goes', () => {
    const typed = keys(card, 'S e e d');
    const sent = keys(cardsText(typed.cards, ' the shop'), '<CR>');

    expect(argvs(sent.commands)).toEqual([
      ['session', 'override', SESSION, '--what', 'db write test', '--reason', 'Seed the shop'],
    ]);
    expect(node(sent.cards)).toMatchObject({ props: { sending: true } });
    // keys wait while it is sent
    expect(keys(sent.cards, '<Esc>').cards.override).toBeDefined();
    const done = cardsResult(sent.cards, {
      kind: 'result',
      id: 'cards:override',
      command: 'session override',
      reply: {
        ok: true,
        data: {
          id: SESSION,
          override: {
            what: 'db write test',
            words: 'Test DB write',
            area: { kind: 'reach', service: 'db', access: 'write', environment: 'test' },
            reason: 'Seed the shop',
            at: AT,
          },
          story: 'not commented: Abe leaves card comments to you',
          pr: 'noted at factory pr',
        },
      },
    });

    expect(done.cards.override).toBeUndefined();
  });

  test("refused by serve: the card stays with serve's words", () => {
    const sent = keys(card, 'x <CR>').cards;
    const refused = cardsResult(sent, {
      kind: 'result',
      id: 'cards:override',
      command: 'session override',
      reply: {
        ok: false,
        error: { code: 'writes-only-on-box', message: 'Test DB write is a write: Move to cloud' },
      },
    });

    expect(node(refused.cards)).toMatchObject({
      props: { error: 'Test DB write is a write: Move to cloud', reason: 'x' },
    });
    expect(node(refused.cards)).not.toHaveProperty('props.sending');
  });

  test('Esc cancels; network <host> (retired: the network is open, ADR 0029) and an unknown area are no area', () => {
    expect(keys(card, '<Esc>').cards.override).toBeUndefined();
    const network = node(openOverride(NO_CARDS, 'network api.example.com', { session: SESSION }));

    expect(network?.kind === 'OverrideCard' ? network.props.error : '').toStartWith('not an area');
    const root = node(openOverride(NO_CARDS, 'root', FACTS));

    expect(root?.kind === 'OverrideCard' ? root.props.title : '').toBe('Override · root');
    expect(root?.kind === 'OverrideCard' ? root.props.error : '').toStartWith('not an area');
  });

  test('it takes the keys before a question card', () => {
    const both = openOverride(cardsRead(NO_CARDS, question()), 'db write test', FACTS);

    expect(keys(both, '1').cards.override?.reason).toBe('1');
  });
});

describe("the header's ✎ row", () => {
  const o = (words: string, reason: string): SessionOverride => ({
    what: words.toLowerCase(),
    words,
    area: { kind: 'reach', service: 'db', access: 'write', environment: 'test' },
    reason,
    at: AT,
  });

  test('the newest Override in words, by you or the teammate, +N for more', () => {
    expect(overrideLine([])).toBeUndefined();
    expect(overrideLine([o('Test DB write', 'Seed the shop for the Before check')])).toBe(
      'Test DB write · overridden by you: Seed the shop for the Before check',
    );
    expect(
      overrideLine([o('Test DB read', 'docs'), o('Test DB write', 'seed')], 'Ada Example'),
    ).toBe('Test DB write · overridden by Ada Example: seed · +1');
  });
});
