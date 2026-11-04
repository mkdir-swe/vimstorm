import { describe, expect, test } from 'bun:test';
import {
  ASK_DENY_REASON,
  askAnswer,
  askCards,
  readPick,
  askDeny,
  type Choice,
  dialogKeys,
  dialogNoAlways,
  dialogShown,
  grillMessage,
  permissionCard,
  permissionDecision,
  questionMessage,
  readChoices,
  roundToCount,
} from './ask';
import { answerWords, isAnswerMessage } from './steps';

const AT = '2026-10-25T03:00:00.000Z';

/** AskUserQuestion's input as the spike saw it (t113 report): `(Recommended)` first. */
const ONE = {
  questions: [
    {
      question: 'Which market table should the cart total read?',
      header: 'Market table',
      multiSelect: false,
      options: [
        { label: 'The existing market table (Recommended)', description: 'markets.ts has VAT' },
        { label: 'A per-market value', description: 'as the comments ask' },
        { label: 'Both' },
      ],
    },
  ],
};

const ROUND = {
  questions: [
    {
      question: 'Keep the widths static? The layout reads them once.',
      multiSelect: false,
      options: [{ label: 'Yes' }, { label: 'No, static widths (Recommended)' }],
    },
    {
      question: 'Which file holds the VAT table?',
      header: 'VAT',
      multiSelect: true,
      options: [{ label: 'vat.ts (Recommended)' }, { label: 'markets.ts' }],
    },
    {
      question: 'Ship behind a flag?',
      header: 'Flag',
      multiSelect: false,
      options: [{ label: 'Yes (Recommended)' }, { label: 'No' }],
    },
  ],
};

describe('askCards: AskUserQuestion input as cards', () => {
  test('one question is one question card, the recommended one first and marked', () => {
    const cards = askCards(ONE, { session: '2-a1b2', base: 'q-1a2b', at: AT });

    expect(cards).toEqual([
      {
        id: 'q-1a2b',
        session: '2-a1b2',
        kind: 'question',
        title: 'Which market table should the cart total read?',
        question: 'Which market table should the cart total read?',
        why: 'Market table',
        options: [
          {
            n: 1,
            label: 'The existing market table',
            note: 'markets.ts has VAT',
            recommended: true,
          },
          { n: 2, label: 'A per-market value', note: 'as the comments ask', recommended: false },
          { n: 3, label: 'Both', recommended: false },
        ],
        own: 'Type your own answer…',
        round: null,
        at: AT,
        expired: null,
      },
    ]);
  });

  test('several questions are a grill round: one card each, numbered of the round', () => {
    const cards = askCards(ROUND, { session: '2-a1b2', base: 'q-1a2b', at: AT });

    expect(cards?.map((c) => [c.id, c.kind, c.round])).toEqual([
      ['q-1a2b.1', 'grill', { id: 'q-1a2b', n: 1, of: 3 }],
      ['q-1a2b.2', 'grill', { id: 'q-1a2b', n: 2, of: 3 }],
      ['q-1a2b.3', 'grill', { id: 'q-1a2b', n: 3, of: 3 }],
    ]);
  });

  test('with no header the why is the second sentence and the title the first', () => {
    const [first] = askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [];

    expect(first?.title).toBe('Keep the widths static?');
    expect(first?.why).toBe('The layout reads them once.');
    expect(first?.question).toBe('Keep the widths static? The layout reads them once.');
  });

  test('the recommended option is put first wherever the agent listed it', () => {
    const [first] = askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [];

    expect(first?.options.map((o) => [o.n, o.label, o.recommended])).toEqual([
      [1, 'No, static widths', true],
      [2, 'Yes', false],
    ]);
  });

  test('a multiSelect question takes several options; the others one', () => {
    const cards = askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [];

    expect(cards.map((c) => c.multi)).toEqual([undefined, true, undefined]);
  });

  test('not AskUserQuestion input: no cards', () => {
    expect(askCards({ command: 'ls' }, { session: 's', base: 'q', at: AT })).toBe(null);
  });
});

describe('the answer as the next prompt', () => {
  const [card] = askCards(ONE, { session: 's', base: 'q', at: AT }) ?? [];

  if (card === undefined) throw new Error('no card');

  test('an option: the question quoted, the number and the label', () => {
    expect(questionMessage(card, { option: 1 })).toEqual({
      ok: true,
      data: 'Answer to "Which market table should the cart total read?": 1 The existing market table',
    });
  });

  test('own words: the text as typed', () => {
    expect(questionMessage(card, { text: 'Read it from the story' })).toEqual({
      ok: true,
      data: 'Answer to "Which market table should the cart total read?": Read it from the story',
    });
  });

  test('an option the card does not have is refused, naming the ones it has', () => {
    const got = questionMessage(card, { option: 7 });

    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.message).toContain('1–3');
  });

  test('a grill round is one numbered message, in the round order', () => {
    const cards = askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [];

    expect(
      grillMessage(cards, [{ option: 1 }, { text: 'vat.ts, next to cart.ts' }, { option: 1 }]),
    ).toEqual({
      ok: true,
      data: [
        '1. Answer to "Keep the widths static? The layout reads them once.": 1 No, static widths',
        '2. Answer to "Which file holds the VAT table?": vat.ts, next to cart.ts',
        '3. Answer to "Ship behind a flag?": 1 Yes',
      ].join('\n'),
    });
  });

  test('what questionMessage and grillMessage write reads as an answer; your own prompts do not', () => {
    const cards = askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [];
    const one = questionMessage(card, { option: 1 });
    const own = questionMessage(card, { text: 'Read it from the story' });
    const round = grillMessage(cards, [{ option: 1 }, { text: 'vat.ts' }, { option: 1 }]);
    const several = questionMessage({ ...card, multi: true }, { options: [1, 3] });

    for (const m of [one, own, round, several]) expect(m.ok && isAnswerMessage(m.data)).toBe(true);
    expect([one, own, round, several].map((m) => (m.ok ? answerWords(m.data) : null))).toEqual([
      { text: 'The existing market table', n: 1 },
      { text: 'Read it from the story' },
      { text: '', questions: 3 },
      { text: 'The existing market table, Both' },
    ]);
    for (const m of ['go on', 'What is the "Answer to" line?', '2. Answer to "x": 1 y'])
      expect(isAnswerMessage(m)).toBe(false);
  });

  test.each<[string, Choice, { ok: boolean; said: string }]>([
    [
      'several options of a multiSelect question, in their order',
      { options: [2, 1] },
      { ok: true, said: 'Answer to "Which file holds the VAT table?": 1 vat.ts, 2 markets.ts' },
    ],
    [
      'one of them',
      { options: [2] },
      { ok: true, said: 'Answer to "Which file holds the VAT table?": 2 markets.ts' },
    ],
    ['none', { options: [] }, { ok: false, said: 'usage' }],
    ['one it does not have', { options: [1, 5] }, { ok: false, said: 'no-option' }],
  ])('a multiSelect answer: %s', (_, choice, want) => {
    const multi = (askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [])[1];

    if (multi === undefined) throw new Error('no card');
    const got = questionMessage(multi, choice);

    expect(got.ok ? { ok: true, said: got.data } : { ok: false, said: got.error.code }).toEqual(
      want,
    );
  });

  test('several options of a single-choice question are refused', () => {
    expect(questionMessage(card, { options: [1, 2] })).toMatchObject({
      ok: false,
      error: { code: 'one-option' },
    });
  });

  test('a grill round answered short is refused: every card at once', () => {
    const cards = askCards(ROUND, { session: 's', base: 'q', at: AT }) ?? [];
    const got = grillMessage(cards, [{ option: 1 }]);

    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('grill-answers');
  });
});

describe('readChoices: the CLI flags as choices', () => {
  test('--option, --text, repeated --option and --answers JSON', () => {
    expect(readChoices({ option: [2] })).toEqual({ ok: true, data: [{ option: 2 }] });
    expect(readChoices({ option: [], text: 'mine' })).toEqual({
      ok: true,
      data: [{ text: 'mine' }],
    });
    expect(readChoices({ option: [1, 2, 1] })).toEqual({
      ok: true,
      data: [{ option: 1 }, { option: 2 }, { option: 1 }],
    });
    expect(readChoices({ option: [], answers: '[1,"own words",3]' })).toEqual({
      ok: true,
      data: [{ option: 1 }, { text: 'own words' }, { option: 3 }],
    });
    // a multiSelect question's options in a round: a list of their numbers
    expect(readChoices({ option: [], answers: '[1,[1,2],3]' })).toEqual({
      ok: true,
      data: [{ option: 1 }, { options: [1, 2] }, { option: 3 }],
    });
  });

  test('none, both, or bad JSON is a usage refusal', () => {
    for (const bad of [
      { option: [] },
      { option: [1], text: 'x' },
      { option: [], answers: '{' },
      { option: [], answers: '[true]' },
    ]) {
      const got = readChoices(bad);

      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.error.code).toBe('usage');
    }
  });
});

describe('the hook answers', () => {
  test("AskUserQuestion's PreToolUse is denied with the reason that ends the turn", () => {
    expect(askDeny('Which market table should the cart total read?')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Asked in Abe's Chat: Which market table should the cart total read? ${ASK_DENY_REASON}`,
      },
    });
  });

  test('a permission card: Allow once recommended when the command stays in the sandbox', () => {
    const card = permissionCard(
      { tool_name: 'Bash', tool_input: { command: 'npm run seed -- --target test' } },
      {
        session: '2-a1b2',
        id: 'p-1a2b',
        at: AT,
        why: 'Reach: Test DB write, overridden for this session: seed the shop',
        where: 'local',
        worktree: '/w',
      },
    );

    expect(card).toMatchObject({
      id: 'p-1a2b',
      kind: 'permission',
      title: 'Allow Bash: npm run seed -- --target test?',
      why: 'Reach: Test DB write, overridden for this session: seed the shop',
      where: "Local sandbox · the command runs in Claude Code's sandbox",
      options: [
        { n: 1, label: 'Allow once', recommended: true },
        { n: 2, label: 'Allow for this session', recommended: false },
        { n: 3, label: 'Deny', recommended: false },
      ],
      own: 'Tell it what to do instead…',
    });
  });

  test('a command outside the sandbox gets no recommended row', () => {
    const card = permissionCard(
      {
        tool_name: 'Bash',
        tool_input: { command: 'psql x', dangerouslyDisableSandbox: true },
      },
      { session: 's', id: 'p', at: AT, why: 'w', where: 'local', worktree: '/w' },
    );

    expect(card.options.some((o) => o.recommended)).toBe(false);
    expect(card.where).toBe('This machine · the command runs outside the sandbox');
  });

  test('in the Abe chat: no sandbox, said so, no recommended row', () => {
    const card = permissionCard(
      { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
      { session: 's', id: 'p', at: AT, why: 'w', where: 'hub', worktree: '/w' },
    );

    expect(card.options.some((o) => o.recommended)).toBe(false);
    expect(card.where).toBe('Local · no sandbox · the command runs on this machine as you');
  });

  test("a permission answered: Claude Code's PermissionRequest decision", () => {
    expect(permissionDecision({ option: 1 })).toEqual({
      answer: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      },
      session: false,
      words: 'Allow once',
    });
    expect(permissionDecision({ option: 2 }).session).toBe(true);
    expect(permissionDecision({ option: 3 }).answer.hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: "Denied in Abe's Chat.",
    });
    expect(
      permissionDecision({ text: 'Use the read DB' }).answer.hookSpecificOutput.decision,
    ).toEqual({ behavior: 'deny', message: 'Use the read DB' });
  });

  test('askAnswer: one card answers by its kind', () => {
    const [card] = askCards(ONE, { session: 's', base: 'q', at: AT }) ?? [];

    if (card === undefined) throw new Error('no card');
    expect(askAnswer([card], [{ option: 2 }])).toEqual({
      ok: true,
      data: 'Answer to "Which market table should the cart total read?": 2 A per-market value',
    });
    // a multiSelect question alone: each --option one of its answers
    const multi = { ...card, multi: true };

    expect(askAnswer([multi], [{ option: 3 }, { option: 1 }])).toEqual({
      ok: true,
      data: 'Answer to "Which market table should the cart total read?": 1 The existing market table, 3 Both',
    });
  });
});

describe('a grill pick kept before its round is sent (#342: session answer --pick)', () => {
  test.each([
    ['2:3', { n: 2, choice: { option: 3 } }],
    ['1:"cart only"', { n: 1, choice: { text: 'cart only' } }],
    ['1:"3"', { n: 1, choice: { text: '3' } }],
    ['2:[1,2]', { n: 2, choice: { options: [1, 2] } }],
  ])('%s', (text, want) => {
    expect(readPick(text)).toEqual({ ok: true, data: want });
  });

  test.each(['3', '0:1', 'x:1', '1:', '1:cart', '1:""', '1:0', '1:[]', '1:[0]'])(
    '%s is refused',
    (text) => {
      expect(readPick(text)).toMatchObject({ ok: false, error: { code: 'usage' } });
    },
  );
});

describe("roundToCount: a box session.ask counts the Mac's Grill rounds once per round", () => {
  const card = (
    id: string,
    kind: 'question' | 'permission',
    round?: string,
    expired: string | null = null,
  ) => ({
    id,
    kind,
    expired,
    ...(round === undefined ? {} : { round: { id: round } }),
  });

  test.each<[string, string[], Parameters<typeof card>[], string | undefined]>([
    ["a round's first cards", [], [['a1', 'question', 'r1']], 'r1'],
    ['a pick re-sending its round', ['r1'], [['a1', 'question', 'r1']], undefined],
    ['the next round', ['r1'], [['b1', 'question', 'r2']], 'r2'],
    ['a lone question counts by its own id', [], [['q7', 'question']], 'q7'],
    ['a permission held', [], [['p1', 'permission']], undefined],
    ['a question asked again as expired', [], [['a1', 'question', 'r1', 'expired']], undefined],
    ['no cards', [], [], undefined],
  ])('%s', (_, seen, cards, want) => {
    expect(
      roundToCount(
        new Set(seen),
        cards.map((c) => card(...c)),
      ),
    ).toBe(want);
  });
});

describe("dialogKeys: a dialog's card answered with Claude Code's own dialog's keys", () => {
  const AUTO = [
    ' Bash command',
    '   npm ci',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
  const ASKING = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for npm commands in",
    '      /home/me/projects/demo-shop',
    '   3. No, and tell Claude what to do differently (esc)',
    ' Esc to cancel',
  ].join('\n');

  test('Allow once: to Yes, then Enter; Deny and own words: Esc', () => {
    expect(dialogKeys(AUTO, { option: 1 })).toEqual(['Enter']);
    expect(dialogKeys(AUTO, { option: 3 })).toEqual(['Escape']);
    expect(dialogKeys(AUTO, { text: 'use npm install' })).toEqual(['Escape']);
  });

  test('Allow for this session: its "don\'t ask again" row; none (Yes / No): refused, never Yes (N3)', () => {
    expect(dialogKeys(ASKING, { option: 2 })).toEqual(['Down', 'Enter']);
    expect(dialogNoAlways(ASKING, { option: 2 })).toBe(false);
    expect(dialogKeys(AUTO, { option: 2 })).toBeUndefined();
    expect(dialogNoAlways(AUTO, { option: 2 })).toBe(true);
    expect(dialogNoAlways(AUTO, { option: 1 })).toBe(false);
    expect(dialogNoAlways('> \n  ? for shortcuts', { option: 2 })).toBe(false);
    expect(
      dialogKeys(ASKING.replace('❯ 1.', '  1.').replace('   3.', ' ❯ 3.'), { option: 1 }),
    ).toEqual(['Up', 'Up', 'Enter']);
  });

  test('no dialog on the screen: nothing to press', () => {
    expect(dialogKeys('> \n  ? for shortcuts', { option: 1 })).toBeUndefined();
  });

  test('a dialog on the screen is shown; Claude Code at its prompt shows none', () => {
    expect(dialogShown(AUTO)).toBe(true);
    expect(dialogShown(ASKING)).toBe(true);
    expect(dialogShown('  ⎿  User rejected Bash\n> \n  ? for shortcuts')).toBe(false);
  });
});
