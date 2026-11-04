/**
 * Chat's cards in the `chat` screen (#114 t114b): the pinned session's open cards read and
 * followed, drawn after the last turn; the keys to the card first (Esc too); the pill above the
 * composer and ⏎ on it; the answered line among the turns; a run's Needs you; `:override`; the
 * header's ✎ row; a teammate's read-only.
 */
import { describe, expect, test } from 'bun:test';
import {
  type AskCard,
  askCards,
  NO_START,
  permissionCard,
  type Event,
  type SessionData,
  type TranscriptEntry,
} from '@abe/core';
import { factoryRun, runsAnswer, session, sessionsAnswer, theirsAnswers } from '@abe/testing';
import { type Node } from '../runtime/components';
import { type PinnedState, pinnedScreen } from './pinned';
import { type Command, type Input, step } from '../runtime/runtime';
import { withLive } from '../live';

/** Chat with its live facts, as the bridge feeds them. */
const CHAT = withLive(pinnedScreen);

const SIZE = { width: 420, height: 800 };
const W = '/wt/s4';
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, s)).toISOString();

const ENTRIES: TranscriptEntry[] = [
  { kind: 'user', id: 'u1', at: at(0), agent: null, text: 'fix the cart', context: null },
  { kind: 'assistant-text', id: 'a1', at: at(1), agent: null, text: 'Which table?' },
];

const SESSION: SessionData = { ...session('s4', 'waiting', 4), worktree: W };
const RUN = factoryRun(4, 'The cart total ignores quantity', 'build', 'needs-you', {
  session: 's4',
  worktree: W,
});

const MARKET = {
  questions: [
    {
      question: 'Which market table should the cart total read?',
      header: "The story's comments mention a per-market setting",
      options: [
        { label: 'The existing market table (Recommended)', description: '' },
        { label: 'A new setting per market', description: '' },
      ],
    },
  ],
};

const CARDS: AskCard[] = askCards(MARKET, { session: 's4', base: 'q-1', at: at(2) }) ?? [];

const NPM: AskCard = permissionCard(
  { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
  { session: 's4', id: 'p-1', at: at(2), why: 'Reach', where: 'hub', worktree: W },
);

const asks = (cards: AskCard[], id = 's4'): Input => ({
  kind: 'result',
  id: 'cards:asks',
  command: 'session asks',
  reply: { ok: true, data: { id, cards } },
});

const transcript: Input = {
  kind: 'result',
  id: 'transcript',
  command: 'session transcript',
  reply: { ok: true, data: { session: 's4', from: 1, entries: ENTRIES } },
};

const event = (e: Event): Input => ({ kind: 'event', event: e });

const drive = (params: Record<string, string> = { root: W }, s: SessionData = SESSION) => {
  let held = step(CHAT, CHAT.init, { kind: 'open', params, size: SIZE });
  let commands: Command[] = held.commands;
  const d = {
    get state(): PinnedState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return commands;
    },
    get tree(): Node {
      return held.tree;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(CHAT, held.state, input);
        commands = held.commands;
      }

      return d;
    },
    keys(...keys: string[]) {
      return d.send(...keys.map((key): Input => ({ kind: 'key', key })));
    },
    text: () => JSON.stringify(held.tree),
  };

  d.send(sessionsAnswer([s]), runsAnswer([RUN]), transcript);

  return d;
};

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

/** Every node of the tree, depth first. */
const nodes = (n: Node): Node[] => [
  n,
  ...('children' in n && n.children !== undefined ? n.children.flatMap(nodes) : []),
];

const kinds = (d: { tree: Node }) => nodes(d.tree).map((n) => n.kind);

describe('the pinned session’s cards', () => {
  test('read on pinning (session asks); the card drawn after the last turn, inside the transcript', () => {
    const d = drive();

    d.send(asks(CARDS));
    const transcriptNode = nodes(d.tree).find((n) => n.kind === 'Transcript');
    const last =
      transcriptNode !== undefined && 'children' in transcriptNode
        ? transcriptNode.children.at(-1)
        : undefined;

    expect(last).toMatchObject({ kind: 'QuestionCard', id: 'card:q-1' });
  });

  test('AC1: 1 answers at once with session answer; the card folds to its line among the turns', () => {
    const d = drive().send(asks(CARDS)).keys('1');

    expect(argvs(d.commands)).toEqual(['session answer s4 --card q-1 --option 1']);
    expect(kinds(d)).not.toContain('QuestionCard');
    expect(d.text()).toContain('"head":"Answered","text":"The existing market table","n":1');
    // the field has the keys: `/` is typed there, not find
    expect(d.state.composer.active).toBe(true);
    // serve says so: still one line
    d.send(
      event({
        seq: 2,
        at: at(3),
        type: 'session.answered',
        data: {
          id: 's4',
          card: 4,
          cards: ['q-1'],
          answer: 'Answer to "…": 1 The existing market table',
        },
      }),
    );
    expect(kinds(d).filter((k) => k === 'CardLine')).toHaveLength(1);
  });

  test('keys go to the card before the transcript; Esc leaves it for later, not to the code', () => {
    const d = drive().send(asks(CARDS));

    d.keys('ö');
    expect(d.state.rendered?.folds.cursor).toBeUndefined();
    d.keys('<Esc>');
    expect(d.commands).toEqual([]);
    expect(kinds(d)).not.toContain('QuestionCard');
    expect(kinds(d)).toContain('DeferredPill');
    // nothing open now: Esc hands the keys back
    d.keys('<Esc>');
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'unhandled', slot: 'chat', key: '<Esc>' } },
    ]);
  });

  test('AC3: the pill sits in the column’s foot; ⏎ (no cursor in the transcript) opens the same card', () => {
    const d = drive().send(asks(CARDS)).keys('<Esc>');
    const column = nodes(d.tree).find((n) => n.kind === 'Stack');
    const foot = column !== undefined && 'children' in column ? column.children.slice(2) : [];

    expect(JSON.stringify(foot)).toContain('"kind":"DeferredPill"');
    // its row gives it the column's room, no more: a long question is cut inside it (#276)
    expect(JSON.stringify(foot)).toContain('"sizes":[{"flex":1}]');
    d.keys('<CR>');
    expect(kinds(d)).toContain('QuestionCard');
    expect(kinds(d)).not.toContain('DeferredPill');
  });

  test('a card asked later arrives by session.ask; serve.started reads them again', () => {
    // the first read answered (none open), then the card asked
    const d = drive().send(
      asks([]),
      event({ seq: 1, at: at(2), type: 'session.ask', data: { id: 's4', card: 4, cards: CARDS } }),
    );

    expect(kinds(d)).toContain('QuestionCard');
    d.send(
      event({
        seq: 1,
        at: at(4),
        type: 'serve.started',
        data: { version: '2', pid: 1, socket: '/s' },
      }),
    );
    expect(argvs(d.commands)).toContain('session asks s4');
  });

  test("the status bar's ◆ needs you shows the cards left for later again", () => {
    const d = drive().send(asks(CARDS)).keys('<Esc>');

    d.send({ kind: 'choice', menu: 'cards', row: 'reopen' });
    expect(kinds(d)).toContain('QuestionCard');
  });

  test("a run's Needs you of its own reason is a card; its Open workspace row jumps to the workspace", () => {
    const run = { ...RUN, reason: 'No stock source: the product API has no stock field' };
    const d = drive().send(runsAnswer([run]));

    expect(d.text()).toContain('"ask":"needs-you"');
    d.keys('w');
    expect(d.commands).toEqual([{ kind: 'jump', to: 'workspace', story: 4 }]);
    d.keys('1');
    expect(argvs(d.commands)).toEqual(['session send s4 continue']);
  });

  test("a no-start's Needs you shows on its ended session: 1 Retry launches the card again", () => {
    const run = { ...RUN, reason: NO_START };
    const d = drive({ root: W }, { ...SESSION, state: 'ended' }).send(runsAnswer([run]));

    expect(d.text()).toContain('"ask":"needs-you"');
    expect(d.text()).toContain('"label":"Retry"');
    expect(d.text()).not.toContain('Done, continue');
    d.keys('1');
    expect(argvs(d.commands)).toEqual([`factory run 4 --repo ${run.repo}`]);
  });

  test('Stop… with a question open (#317): the card read-only at once, ⏎ the ended line’s Reopen, never an answer', () => {
    const stopped = event({
      seq: 5,
      at: at(5),
      type: 'session.state',
      data: { id: 's4', card: 4, state: 'ended', since: at(5), cause: 'stop' },
    });
    const d = drive().send(asks(CARDS), stopped);
    const card = nodes(d.tree).find((n) => n.kind === 'QuestionCard');

    expect(card?.props).toMatchObject({ expired: 'Its session ended: no answer reaches it' });
    expect(card?.props).not.toHaveProperty('selected');
    expect(card?.props).not.toHaveProperty('foot');
    // no answer goes: the key is the Reopen field's text (#343), its first prompt if sent
    d.keys('1');
    expect(argvs(d.commands)).toEqual([]);
    d.keys('<BS>', '<CR>');
    expect(argvs(d.commands)).toEqual(['session reopen s4']);
  });

  test('Stop… then serve clears the asks (#317, as i258 decided): the card stays read-only', () => {
    const stopped = event({
      seq: 5,
      at: at(5),
      type: 'session.state',
      data: { id: 's4', card: 4, state: 'ended', since: at(5), cause: 'stop' },
    });
    // the agent's last hook after its end: serve drops the asks, each answered outside Chat
    const cleared = event({
      seq: 6,
      at: at(6),
      type: 'session.answered',
      data: { id: 's4', card: 4, cards: CARDS.map((c) => c.id), answer: null },
    });
    const card = (d: { tree: Node }) => nodes(d.tree).find((n) => n.kind === 'QuestionCard');
    const d = drive().send(asks(CARDS), stopped, cleared);

    expect(card(d)?.props).toMatchObject({ expired: 'Its session ended: no answer reaches it' });
    expect(d.text()).not.toContain('Answered outside Chat');
    // a read again (serve started anew) answers no asks for an ended session: the card stays
    d.send(
      event({
        seq: 7,
        at: at(7),
        type: 'serve.started',
        data: { pid: 1, version: 'x', socket: '/s' },
      }),
    );
    expect(argvs(d.commands)).toContain('session asks s4');
    d.send(asks([]));
    expect(card(d)?.props).toMatchObject({ expired: 'Its session ended: no answer reaches it' });
    d.keys('1');
    expect(argvs(d.commands)).toEqual([]);
  });

  test('a stopped session resumed: its asks read again, the read-only card gone (#317)', () => {
    const state = (seq: number, s: 'ended' | 'working') =>
      event({
        seq,
        at: at(seq),
        type: 'session.state',
        data: {
          id: 's4',
          card: 4,
          state: s,
          since: at(seq),
          cause: s === 'ended' ? 'stop' : 'hook',
        },
      });
    const d = drive().send(asks(CARDS), state(5, 'ended'), state(6, 'working'));

    expect(argvs(d.commands)).toEqual(['session asks s4']);
    d.send(asks([]));
    expect(kinds(d)).not.toContain('QuestionCard');
  });

  test('resumed while serve was away (#317): the sessions read says live, the asks read again; the old card takes no key meanwhile', () => {
    const stopped = event({
      seq: 5,
      at: at(5),
      type: 'session.state',
      data: { id: 's4', card: 4, state: 'ended', since: at(5), cause: 'stop' },
    });
    const d = drive().send(asks(CARDS), stopped);

    d.send(sessionsAnswer([{ ...SESSION, state: 'waiting' }]));
    expect(argvs(d.commands)).toContain('session asks s4');
    d.keys('1');
    expect(argvs(d.commands)).toEqual([]);
    d.send(asks([]));
    expect(kinds(d)).not.toContain('QuestionCard');
  });

  test('Stop… on a run’s own Needs you (#317): its card turns to the Retry form at once', () => {
    const run = { ...RUN, reason: 'No stock source: the product API has no stock field' };
    const d = drive().send(runsAnswer([run]));

    expect(d.text()).toContain('Done, continue');
    d.send(
      event({
        seq: 5,
        at: at(5),
        type: 'session.state',
        data: { id: 's4', card: 4, state: 'ended', since: at(5), cause: 'stop' },
      }),
    );
    expect(d.text()).not.toContain('Done, continue');
    expect(d.text()).toContain('"label":"Retry"');
  });

  test('board R-Question: an open card keeps the composer under it; Esc puts the pill above it', () => {
    const foot = (d: ReturnType<typeof drive>) => {
      const ids: string[] = [];
      const walk = (n: Node) => {
        if (n.id !== undefined) ids.push(n.id);
        if ('children' in n) (n.children ?? []).forEach(walk);
      };

      walk(d.tree);

      return ids;
    };
    const d = drive().send(asks(CARDS));
    const open = foot(d);

    expect(open).toContain('composer:composer');
    expect(open.indexOf('card:q-1')).toBeLessThan(open.indexOf('composer:composer'));
    const later = foot(d.keys('<Esc>'));

    expect(later.indexOf('cards:pill')).toBeGreaterThan(-1);
    expect(later.indexOf('cards:pill')).toBeLessThan(later.indexOf('composer:composer'));
  });

  test(':override opens the Override card on the session; ⏎ with a reason records it', () => {
    const d = drive().send({ kind: 'choice', menu: 'override', row: 'db write test' });

    expect(d.text()).toContain('"title":"Override · Test DB write"');
    d.keys('<CR>');
    expect(d.text()).toContain('"missing":true');
    d.send({ kind: 'text', text: 'Seed the shop' }).keys('<CR>');
    expect(argvs(d.commands)).toEqual([
      'session override s4 --what db write test --reason Seed the shop',
    ]);
  });

  test('the header’s ✎ row from the session’s Overrides; session.override reads the sessions again', () => {
    const override = {
      what: 'db write test',
      words: 'Test DB write',
      area: {
        kind: 'reach' as const,
        service: 'db' as const,
        access: 'write' as const,
        environment: 'test',
      },
      reason: 'Seed the shop for the Before check',
      at: at(5),
    };
    const over: SessionData = { ...SESSION, overrides: [override] };
    const d = drive({ root: W }, over);

    expect(d.text()).toContain(
      '"override":"Test DB write · overridden by you: Seed the shop for the Before check"',
    );
    d.send(
      event({
        seq: 3,
        at: at(6),
        type: 'session.override',
        data: { id: 's4', card: 4, override },
      }),
    );
    expect(argvs(d.commands)).toContain('session show s4');
  });

  test("your session on a teammate's card (#306): its cards answerable, its Override yours", () => {
    const d = drive().send(...theirsAnswers(4, 'Ada Example'), asks(CARDS));

    expect(d.text()).not.toContain('waiting on');
    expect(d.text()).not.toContain('Ada Example');
    d.keys('1');
    expect(argvs(d.commands).length).toBeGreaterThan(0);
    d.send({ kind: 'choice', menu: 'override', row: 'db write test' });
    expect(d.text()).toContain('OverrideCard');
  });

  test('a card asked while session asks is out: its answer is stale, read again', () => {
    const d = drive({ root: W });

    d.send(
      event({ seq: 1, at: at(2), type: 'session.ask', data: { id: 's4', card: 4, cards: CARDS } }),
    );
    // the first read's answer (from before the ask) would drop it: read again instead
    d.send(asks([]));
    expect(argvs(d.commands)).toEqual(['session asks s4']);
    expect(kinds(d)).toContain('QuestionCard');
    d.send(asks(CARDS));
    expect(kinds(d)).toContain('QuestionCard');
  });

  test('a paste with nothing typed is not the card’s', () => {
    const d = drive().send(asks(CARDS));
    const before = d.state.cards;

    d.send({ kind: 'text', text: 'hello' });
    expect(d.state.cards).toBe(before);
  });

  test(':override with no session here says so', () => {
    const d = drive({ root: '/elsewhere' });

    d.send({ kind: 'choice', menu: 'override', row: 'db write test' });
    expect(d.commands).toMatchObject([
      { kind: 'shell', effect: { kind: 'balloon', tone: 'warning' } },
    ]);
  });

  test('its own words being typed: the screen is typing (`:` is a character)', () => {
    const d = drive().send(asks(CARDS)).keys('o');

    expect(pinnedScreen.typing?.(d.state)).toBe(true);
    d.keys(':');
    expect(d.state.cards?.cards.typing?.text).toBe(':');
  });

  test('its own words begun while the field had the keys: ⏎ answers the card, the draft kept', () => {
    const d = drive()
      .send({ kind: 'focus', focused: true }, { kind: 'draft', text: 'hm', seq: 1 }, asks(CARDS))
      .send({ kind: 'click', id: `card:${CARDS[0]?.id ?? ''}:own` })
      .send({ kind: 'draft', text: 'the old table', seq: 1 })
      .keys('<CR>');

    expect(argvs(d.commands)).toEqual(['session answer s4 --card q-1 --text the old table']);
    expect(d.state.composer.drafts.s4?.text).toBe('hm');
  });

  test('a question over an empty, idle field takes the keys: its digit answers it (N2)', () => {
    const d = drive()
      .send({ kind: 'focus', focused: true }, asks([]))
      .send(
        event({
          seq: 1,
          at: at(2),
          type: 'session.ask',
          data: { id: 's4', card: 4, cards: CARDS },
        }),
      );

    expect(d.state.composer.active).toBe(false);
    d.send({ kind: 'key', key: '1', at: at(5) });
    expect(argvs(d.commands)).toEqual(['session answer s4 --card q-1 --option 1']);
  });

  test('a move lands the keys in the field: an open card waits for Tab, read before or after', () => {
    // the card read once the keys are in the field (its first showing): it waits, `q` typed there
    const after = drive().send({ kind: 'focus', focused: true }, asks(CARDS)).keys('q', '1');

    expect(argvs(after.commands)).toEqual([]);
    expect(after.state.composer.drafts.s4?.text).toBe('q1');
    expect(after.text()).toContain('Tab to answer');
    // the card already there as the keys come back: the field has them too
    const before = drive()
      .send(asks(CARDS))
      .send({ kind: 'focus', focused: false }, { kind: 'focus', focused: true })
      .keys('z');

    expect(before.state.composer.drafts.s4?.text).toBe('z');
    before.keys('<Tab>', '1');
    expect(argvs(before.commands)).toEqual(['session answer s4 --card q-1 --option 1']);
  });

  test('a question that comes with words in the field waits for Tab; the words stay (N2)', () => {
    const d = drive()
      .send({ kind: 'focus', focused: true }, asks([]))
      .send({ kind: 'draft', text: 'Reply with', seq: 1, at: at(0) })
      .send(
        event({
          seq: 1,
          at: at(4),
          type: 'session.ask',
          data: { id: 's4', card: 4, cards: CARDS },
        }),
      )
      .keys(' ', '1');

    expect(argvs(d.commands)).toEqual([]);
    expect(d.state.composer.drafts.s4?.text).toBe('Reply with 1');
    expect(d.text()).toContain('Tab to answer');
    d.keys('<Tab>', '2');
    expect(argvs(d.commands)).toEqual(['session answer s4 --card q-1 --option 2']);
  });

  test('a permission waits whenever the field has the keys, empty and idle too (N2): Tab goes to it', () => {
    const d = drive()
      .send({ kind: 'focus', focused: true }, { kind: 'draft', text: '', seq: 1 })
      .send(asks([]))
      .send(
        event({
          seq: 1,
          at: at(2),
          type: 'session.ask',
          data: { id: 's4', card: 4, cards: [NPM] },
        }),
      )
      .keys('w', 'o', 'r', 'd', '1');

    expect(argvs(d.commands)).toEqual([]);
    expect(d.state.cards?.cards.typing).toBeUndefined();
    expect(d.state.composer.drafts.s4?.text).toBe('word1');
    expect(d.state.composer.active).toBe(true);
    expect(d.text()).toContain('Tab to answer');
    d.keys('<Tab>');
    expect(d.state.composer.active).toBe(false);
    d.keys('3');
    expect(argvs(d.commands)).toEqual(['session answer s4 --card p-1 --option 3']);
  });

  test('a card that comes a moment after a key in the field waits too', () => {
    const d = drive()
      .send(asks([]))
      .send({ kind: 'key', key: 'h', at: at(1) }, { kind: 'key', key: '<Esc>', at: at(2) })
      .send(
        event({
          seq: 1,
          at: at(2),
          type: 'session.ask',
          data: { id: 's4', card: 4, cards: [NPM] },
        }),
      );

    expect(d.state.composer.active).toBe(false);
    d.send({ kind: 'key', key: '1', at: at(4) });
    expect(argvs(d.commands)).toEqual([]);
    expect(d.state.composer.drafts.s4?.text).toBe('h1');
  });

  test('an idle Chat: the permission takes the keys, but no allow sooner than 400 ms', () => {
    const d = drive()
      .send(asks([]))
      .send(
        event({
          seq: 1,
          at: at(2),
          type: 'session.ask',
          data: { id: 's4', card: 4, cards: [NPM] },
        }),
      )
      .send({ kind: 'key', key: '1', at: new Date(Date.parse(at(2)) + 150).toISOString() });

    expect(argvs(d.commands)).toEqual([]);
    expect(d.state.cards?.cards.open).toHaveLength(1);
    d.send({ kind: 'key', key: '1', at: new Date(Date.parse(at(2)) + 450).toISOString() });
    expect(argvs(d.commands)).toEqual(['session answer s4 --card p-1 --option 1']);
  });

  test('the ✎ row goes once the session ended', () => {
    const override = {
      what: 'db read test',
      words: 'Test DB read',
      area: {
        kind: 'reach' as const,
        service: 'db' as const,
        access: 'read' as const,
        environment: 'test',
      },
      reason: 'docs',
      at: at(5),
    };
    const d = drive({ root: W }, { ...SESSION, state: 'ended', overrides: [override] });

    expect(d.text()).not.toContain('"override":');
  });
});
