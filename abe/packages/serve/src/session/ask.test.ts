/**
 * The ask channel (#114 S1) in a real `serve` in this test: the fake `claude` in a real `tmux`
 * runs its hooks through the real `abe hook`, with AskUserQuestion's input as the #113 spike saw
 * it. The hook prints serve's deny, the cards are asked, the turn's Stop leaves the session
 * waiting, and `abe session answer` types the answer into the session as its next prompt.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askDeny, type Reply, SessionAnswerData, SessionAsksData, SessionData } from '@abe/core';
import {
  card,
  claudeOutput,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  heldEvents,
  scenario,
  scriptClaude,
  type ServeScenario,
  until,
} from '@abe/testing';
import { z } from 'zod';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};
const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

const doc = <T extends z.ZodType>(schema: T, reply: Reply) =>
  z
    .union([
      z.object({ ok: z.literal(true), data: schema }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ])
    .parse(JSON.parse(reply.stdout));

const data = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const read = z
    .object({ ok: z.literal(true), data: z.unknown() })
    .safeParse(JSON.parse(reply.stdout));

  if (!read.success) throw new Error(reply.stdout);

  return schema.parse(read.data.data);
};

/** AskUserQuestion's input, as the spike saw Claude Code send it. */
const ONE = {
  questions: [
    {
      question: 'Which market table should the cart total read?',
      header: 'Market table',
      multiSelect: false,
      options: [
        { label: 'The existing market table (Recommended)', description: 'markets.ts has VAT' },
        { label: 'A per-market value', description: 'as the comments ask' },
      ],
    },
  ],
};
const ROUND = {
  questions: [
    {
      question: 'Static widths?',
      header: 'Widths',
      multiSelect: false,
      options: [{ label: 'Yes (Recommended)' }, { label: 'No' }],
    },
    {
      question: 'Where is VAT?',
      header: 'VAT',
      multiSelect: false,
      options: [{ label: 'vat.ts (Recommended)' }, { label: 'markets.ts' }],
    },
    {
      question: 'Behind a flag?',
      header: 'Flag',
      multiSelect: false,
      options: [{ label: 'No (Recommended)' }, { label: 'Yes' }],
    },
  ],
};
/** A grill's second round, asked after the first is answered. */
const ROUND_2 = {
  questions: [
    {
      question: 'Round to whole kronor?',
      header: 'Rounding',
      multiSelect: false,
      options: [{ label: 'Yes (Recommended)' }, { label: 'No' }],
    },
    {
      question: 'Show it on mobile?',
      header: 'Mobile',
      multiSelect: false,
      options: [{ label: 'Yes (Recommended)' }, { label: 'Later' }],
    },
  ],
};
const ANSWER =
  'Answer to "Which market table should the cart total read?": 1 The existing market table';
const GRILL = [
  '1. Answer to "Static widths?": 1 Yes',
  '2. Answer to "Where is VAT?": vat.ts, beside cart.ts',
  '3. Answer to "Behind a flag?": 1 No',
].join('\n');

describe('the ask channel', () => {
  let root: string;
  let repo: string;
  let claude: FakeClaude;
  let s: ServeScenario;

  const launch = async (id: number) =>
    data(
      SessionData,
      await s.request('session', 'launch', '--card', String(id), '--repo', repo, '--json'),
    );
  const show = async (id: string) =>
    data(SessionData, await s.request('session', 'show', id, '--json'));
  const asks = async (id: string) =>
    data(SessionAsksData, await s.request('session', 'asks', id, '--json')).cards;
  const senv = () => ({
    ...GIT_ENV,
    PATH: claude.path,
    ABE_CONFIG_DIR: join(root, 'mine'),
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-ask-'));
    repo = join(root, 'demo');
    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(root, 'init', '-q', '-b', 'main', repo);
    mkdirSync(join(repo, '.abe'));
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.abe/settings.local.yaml\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(BOARD)}\nenvironments: {}\n`);
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    claude = fakeClaude();
    s = await scenario({
      board: fakeBoard([2, 3, 4, 5].map((id) => card(id, `Cart total ${id}`))),
      sessions: { env: senv() },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "AskUserQuestion is denied, asked as a card, and the answer is the session's next prompt",
    { timeout: 30_000 },
    async () => {
      scriptClaude(
        s.state.dir,
        [{ hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: ONE } }],
        { [ANSWER]: [{ say: 'Going on with the market table.' }] },
      );
      const session = await launch(2);
      // The hook printed serve's deny for Claude Code: the turn ends.
      const hooked = await until('the PreToolUse hook', () =>
        z
          .array(z.object({ event: z.string(), stdout: z.string() }))
          .parse(claudeOutput(session.worktree).hooks)
          .find((h) => h.event === 'PreToolUse'),
      );

      expect(JSON.parse(hooked.stdout)).toEqual(
        askDeny('Which market table should the cart total read?'),
      );
      // No Notification comes: the turn's Stop leaves it waiting on you.
      await until('waiting', async () =>
        (await show(session.id)).state === 'waiting' ? true : undefined,
      );
      const [asked, ...more] = await asks(session.id);

      expect(more).toEqual([]);
      expect(asked).toMatchObject({
        kind: 'question',
        title: 'Which market table should the cart total read?',
        why: 'Market table',
        options: [
          { n: 1, label: 'The existing market table', recommended: true },
          { n: 2, label: 'A per-market value', recommended: false },
        ],
      });
      if (asked === undefined) throw new Error('no card');
      // An agent never answers its own cards: session answer is a person's.
      const fromAgent = await s.requestAs(
        session.id,
        session.worktree,
        'session',
        'answer',
        session.id,
        '--card',
        asked.id,
        '--option',
        '1',
        '--json',
      );

      expect(fromAgent.exit).not.toBe(0);
      const answered = data(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          asked.id,
          '--option',
          '1',
          '--json',
        ),
      );

      expect(answered).toEqual({ id: session.id, cards: [asked.id], sent: ANSWER });
      await until('typed', () =>
        claudeOutput(session.worktree).typed.includes(ANSWER) ? true : undefined,
      );
      expect(await asks(session.id)).toEqual([]);
      const events = await heldEvents(s.state.socket);

      expect(events.filter((e) => e.type === 'session.ask').map((e) => e.data)).toEqual([
        { id: session.id, card: 2, cards: [asked] },
      ]);
      expect(events.filter((e) => e.type === 'session.answered').map((e) => e.data)).toEqual([
        { id: session.id, card: 2, cards: [asked.id], answer: ANSWER },
      ]);
      // Answered once: it is gone.
      const again = doc(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          asked.id,
          '--option',
          '1',
          '--json',
        ),
      );

      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe('no-card');
      await s.request('session', 'stop', session.id, '--json');
    },
  );

  test(
    'a message queued while it asked waits for the card: the answer, then the queue, one prompt',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [
        { hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: ONE } },
        { sleep: 1500 },
      ]);
      const session = await launch(4);
      const [asked] = await until('the card', async () => {
        const open = await asks(session.id);

        return open.length > 0 ? open : undefined;
      });

      if (asked === undefined) throw new Error('no card');
      // still working: your message is queued
      const sent = await s.request(
        'session',
        'send',
        session.id,
        'also handle a zero quantity',
        '--json',
      );

      expect(JSON.parse(sent.stdout)).toMatchObject({ ok: true, data: { queued: 1 } });
      await until('waiting', async () =>
        (await show(session.id)).state === 'waiting' ? true : undefined,
      );
      // the deny's Stop typed nothing: the queue waits for the card
      expect((await show(session.id)).queue).toEqual([
        { n: 1, text: 'also handle a zero quantity' },
      ]);
      const answered = data(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          asked.id,
          '--option',
          '1',
          '--json',
        ),
      );

      expect(answered.sent).toBe(ANSWER);
      const typed = await until('typed', () => {
        const t = claudeOutput(session.worktree).typed;

        return t.length > 0 ? t : undefined;
      });

      expect(typed).toEqual([`${ANSWER}\n\nalso handle a zero quantity`]);
      expect((await show(session.id)).queue).toEqual([]);
      await s.request('session', 'stop', session.id, '--json');
    },
  );

  test(
    'a grill round: one card per question, all answered as one numbered message',
    { timeout: 30_000 },
    async () => {
      scriptClaude(
        s.state.dir,
        [{ hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: ROUND } }],
        { [GRILL]: [{ say: 'All three taken.' }] },
      );
      const session = await launch(3);

      await until('waiting', async () =>
        (await show(session.id)).state === 'waiting' ? true : undefined,
      );
      const cards = await asks(session.id);

      expect(cards.map((c) => [c.kind, c.round?.n, c.round?.of])).toEqual([
        ['grill', 1, 3],
        ['grill', 2, 3],
        ['grill', 3, 3],
      ]);
      const round = cards[0]?.round?.id ?? '';
      const short = doc(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          round,
          '--option',
          '1',
          '--json',
        ),
      );

      expect(short.ok).toBe(false);
      if (!short.ok) expect(short.error.code).toBe('grill-answers');
      const answered = data(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          cards[1]?.id ?? '',
          '--answers',
          '[1, "vat.ts, beside cart.ts", 1]',
          '--json',
        ),
      );

      expect(answered.sent).toBe(GRILL);
      // A paste: the three lines are one message to the session.
      await until('typed', () =>
        claudeOutput(session.worktree).typed.includes(GRILL) ? true : undefined,
      );
      expect(await asks(session.id)).toEqual([]);
      await s.request('session', 'stop', session.id, '--json');
    },
  );
  test(
    'a question answered in Terminal mode goes from Chat once the prompt is typed there',
    {
      timeout: 30_000,
    },
    async () => {
      scriptClaude(s.state.dir, [
        { hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: ONE } },
      ]);
      const session = await launch(4);

      await until('waiting', async () =>
        (await show(session.id)).state === 'waiting' ? true : undefined,
      );
      const [asked] = await asks(session.id);

      // Typed into its claude another way than a card (Terminal mode is the same tmux).
      await s.request('session', 'send', session.id, 'the', 'existing', 'one', '--json');
      await until('cleared', async () =>
        (await asks(session.id)).length === 0 ? true : undefined,
      );
      const answered = (await heldEvents(s.state.socket)).filter(
        (e) => e.type === 'session.answered',
      );

      expect(answered.at(-1)?.data).toEqual({
        id: session.id,
        card: 4,
        cards: [asked?.id],
        answer: null,
      });
      await s.request('session', 'stop', session.id, '--json');
    },
  );

  test(
    'picks in a round are kept by serve (#342): half a round picked survives a serve started again, then the rest sends it',
    { timeout: 30_000 },
    async () => {
      scriptClaude(
        s.state.dir,
        [{ hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: ROUND } }],
        // the agent's next round once the first is answered
        {
          [GRILL]: [
            { hook: 'PreToolUse', payload: { tool_name: 'AskUserQuestion', tool_input: ROUND_2 } },
          ],
        },
      );
      const session = await launch(5);

      await until('waiting', async () =>
        (await show(session.id)).state === 'waiting' ? true : undefined,
      );
      const round = (await asks(session.id))[0]?.round?.id ?? '';
      const pick = (value: string) =>
        s.request('session', 'answer', session.id, '--card', round, '--pick', value, '--json');

      expect(data(SessionAnswerData, await pick('1:1'))).toMatchObject({
        sent: '',
        picked: `${round}.1`,
      });
      expect(data(SessionAnswerData, await pick('2:"vat.ts, beside cart.ts"')).picked).toBe(
        `${round}.2`,
      );
      // nothing typed: the round goes once every question has its answer
      expect(claudeOutput(session.worktree).typed).toEqual([]);
      // a pick is no answer: an option it does not have, or a pick with another answer, is refused
      expect(doc(SessionAnswerData, await pick('3:9'))).toMatchObject({
        ok: false,
        error: { code: 'no-option' },
      });
      expect(doc(SessionAnswerData, await pick('3:'))).toMatchObject({
        ok: false,
        error: { code: 'usage' },
      });
      const events = await heldEvents(s.state.socket);

      expect(
        events
          .filter((e) => e.type === 'session.ask')
          .flatMap(
            (e) =>
              z
                .object({
                  cards: z.array(z.object({ id: z.string(), picked: z.unknown().optional() })),
                })
                .parse(e.data).cards,
          )
          .filter((c) => c.picked !== undefined)
          .map((c) => [c.id, c.picked]),
      ).toEqual([
        [`${round}.1`, { option: 1 }],
        [`${round}.2`, { text: 'vat.ts, beside cart.ts' }],
      ]);
      // serve stops and starts again on the same state: the picks are still on the cards
      await s.serve.stop();
      s = await scenario({
        state: s.state,
        board: fakeBoard([2, 3, 4, 5].map((id) => card(id, `Cart total ${id}`))),
        sessions: { env: senv() },
      });
      expect((await asks(session.id)).map((c) => c.picked ?? null)).toEqual([
        { option: 1 },
        { text: 'vat.ts, beside cart.ts' },
        null,
      ]);
      const answered = data(
        SessionAnswerData,
        await s.request(
          'session',
          'answer',
          session.id,
          '--card',
          round,
          '--answers',
          '[1, "vat.ts, beside cart.ts", 1]',
          '--json',
        ),
      );

      expect(answered.sent).toBe(GRILL);
      await until('typed', () =>
        claudeOutput(session.worktree).typed.includes(GRILL) ? true : undefined,
      );
      // round 2 comes as the next AskUserQuestion: its own round id, two cards
      const second = await until('round 2', async () => {
        const open = await asks(session.id);

        return open.length === 2 ? open : undefined;
      });

      expect(second.map((c) => [c.kind, c.round?.n, c.round?.of, c.round?.id === round])).toEqual([
        ['grill', 1, 2, false],
        ['grill', 2, 2, false],
      ]);
      // the session counts its rounds: the Board says Grill round 2 (#342)
      expect((await show(session.id)).rounds).toBe(2);
      await s.request('session', 'stop', session.id, '--json');
    },
  );
});
