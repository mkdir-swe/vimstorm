/**
 * The `chat` screen (#119) as the bridge drives it in the Chat slot: pinned by the shown folder,
 * by the shown box, by its params; the rendered Chat read for the pinned session; the W-NoSession
 * look and its launch; the session's events; `focus` and `caret`.
 */
import { describe, expect, test } from 'bun:test';
import type {
  CardData,
  Event,
  InstallView,
  PrototypeData,
  SessionData,
  SettingsChangedData,
} from '@abe/core';
import {
  boxesAnswer,
  cardShowAnswer,
  cardsAnswer,
  DEMO_HERE,
  eventInput,
  factoryRun,
  AT,
  listCard,
  prototype,
  prototypeListAnswer,
  prototypeSession,
  runsAnswer,
  session,
  sessionsAnswer,
  X_BOXES,
} from '@abe/testing';
import { type Node } from '../runtime/components';
import { cardOfBranch, KEPT_CHATS, pinOf, pinnedScreen, type PinnedState, whoseOf } from './pinned';
import { HUB_TAB } from './rendered';
import { type Terminal } from './terminal';
import { type Command, type Input, step } from '../runtime/runtime';
import { withLive } from '../live';

/** Chat with its live facts, as the bridge feeds them. */
const CHAT = withLive(pinnedScreen);

const SIZE = { width: 420, height: 800 };

const SESSIONS = [
  { ...session('s4', 'working', 4), worktree: '/p/shop-wt/4-cart-total' },
  { ...session('s5', 'waiting', 5), worktree: '/box/repo', box: 'shop-5' },
  {
    ...session('s3', 'ended', 4),
    worktree: '/p/shop-wt/4-cart-total',
    startedAt: '2026-09-01T09:00:00.000Z',
  },
];
const RUNS = [
  factoryRun(4, 'Cart total includes shipping', 'build', 'running', {
    session: 's4',
    worktree: '/p/shop-wt/4-cart-total',
  }),
  factoryRun(5, 'Saved carts survive sign-out', 'verify', 'needs-you', { session: 's5' }),
];

const drive = (params: Record<string, string>) => {
  let held = step(CHAT, CHAT.init, { kind: 'open', params, size: SIZE });
  let commands: Command[] = held.commands;
  const d = {
    get tree(): Node {
      return held.tree;
    },
    get state(): PinnedState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return commands;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(CHAT, held.state, input);
        commands = held.commands;
      }

      return d;
    },
    read(sessions = SESSIONS, runs = RUNS) {
      return d.send(sessionsAnswer(sessions), runsAnswer(runs));
    },
    text: () => JSON.stringify(held.tree),
  };

  return d;
};

/** `card show` as the chat screen reads it (`card:<n>`). */
const chatCard = (card: CardData): Input => ({
  ...cardShowAnswer(card, []),
  id: `card:${card.id}`,
});

/** `card list --mine --closed` as the chat screen reads it. */
const mineAnswer = (cards: CardData[]): Input => cardsAnswer(cards, true);

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

/** The Launch box on `card`: its ⏎, where it runs as picked (none: where it would launch). */
const boxEnter = (card: number, runs = ''): Input => ({
  kind: 'choice',
  menu: `launchbox:${card}`,
  row: 'launch',
  values: ['', '', runs, ''],
});

/** The node `id` in a tree. */
const find = (n: Node, id: string): Node | undefined => {
  if (n.id === id) return n;
  if (!('children' in n)) return undefined;

  return (n.children ?? []).map((c) => find(c, id)).find((x) => x !== undefined);
};

/** The session whose transcript Chat holds (and read on pinning it). */
const pinned = (d: { state: PinnedState }) => d.state.rendered?.session;

describe('the chat screen', () => {
  test('reads the sessions and the runs on open, saying it asks meanwhile', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' });

    expect(argvs(d.commands)).toEqual([
      'session list',
      'factory status',
      // your cards (done ones too): whose the story is
      'card list --mine --closed',
    ]);
    expect(d.text()).toContain('Asking abe serve');
  });

  test("whose comes from the story while no session of yours is on it: its assignee's (#113 AC10, #306)", () => {
    // your session on a card someone else holds (a CLI launch, a Retry): yours, nothing read for it
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read();

    d.send(mineAnswer([]));
    expect(argvs(d.commands)).toEqual([]);
    d.send(chatCard(listCard(4, 'Cart total includes shipping', 'Active', 'Ada Example')));
    expect(whoseOf(d.state)).toBeUndefined();
    expect(d.text()).not.toContain("'s session");
    // no session of yours on their card: theirs, named
    const theirs = drive({ card: '4' }).read([], []);

    // Mine not read yet: yours until it says otherwise
    expect(whoseOf(theirs.state)).toBeUndefined();
    theirs.send(
      mineAnswer([]),
      chatCard(listCard(4, 'Cart total includes shipping', 'Active', 'Ada Example')),
    );
    expect(whoseOf(theirs.state)).toBe('Ada Example');
    expect(theirs.text()).toContain("Ada Example's story");
    // no one's card is nobody's to wait on: yours to look at
    const nobody = drive({ card: '4' })
      .read([], [])
      .send(mineAnswer([]), chatCard(listCard(4, 'Cart total includes shipping', 'New', null)));

    expect(whoseOf(nobody.state)).toBeUndefined();
    // your closed card, Mine read with its done cards (#239): yours, never read-only
    const done = listCard(4, 'Cart total includes shipping', 'Closed', 'Ada Example');
    const closed = drive({ card: '4' })
      .read([], [])
      .send(mineAnswer([done]), chatCard(done));

    expect(whoseOf(closed.state)).toBeUndefined();
  });

  test('the header says its stage is being read until the runs are in (#315)', () => {
    const header = (d: ReturnType<typeof drive>) => /"rail":\{[^}]*\}/.exec(d.text())?.[0] ?? '';
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).send(sessionsAnswer(SESSIONS));

    expect(header(d)).toContain('"stage":"Reading…"');
    d.send(runsAnswer(RUNS));
    expect(header(d)).toContain('"stage":"Build"');
    // a runs read that failed: the session's own look, not `Reading…` for good
    const failed = drive({ root: '/p/shop-wt/4-cart-total' }).send(sessionsAnswer(SESSIONS), {
      kind: 'result',
      id: 'runs',
      command: 'factory status',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'abe serve is not up' } },
    });

    expect(header(failed)).not.toContain('Reading…');
  });

  test('⏎ and ⌘⏎ wait for the run (#315): no Resume where a Retry is, no launch where a run is', () => {
    const ended = [{ ...session('s4', 'ended', 4), worktree: '/p/shop-wt/4-cart-total' }];
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).send(sessionsAnswer(ended));
    const status = (c: Command[]) =>
      c.flatMap((x) => (x.kind === 'shell' && x.effect.kind === 'status' ? [x.effect.text] : []));

    d.send({ kind: 'key', key: '<D-CR>' });
    expect(d.commands.some((c) => c.kind === 'menu')).toBe(false);
    expect(status(d.commands)).toEqual(["Reading #4's run and session…"]);
    const card = drive({ card: '9' }).send(sessionsAnswer([]), mineAnswer([]));

    card.send({ kind: 'key', key: '<CR>' });
    expect(argvs(card.commands)).toEqual([]);
  });

  describe('an early ⌘⏎ is held until the run is read (#315, as the Board’s)', () => {
    const ended = [{ ...session('s4', 'ended', 4), worktree: '/p/shop-wt/4-cart-total' }];
    const status = (c: Command[]) =>
      c.flatMap((x) => (x.kind === 'shell' && x.effect.kind === 'status' ? [x.effect.text] : []));
    const menus = (c: Command[]) => c.filter((x) => x.kind === 'menu');
    const early = () =>
      drive({ root: '/p/shop-wt/4-cart-total' })
        .send(sessionsAnswer(ended))
        .send({ kind: 'key', key: '<D-CR>' });

    test('it opens once the runs answer, the status line cleared', () => {
      const d = early();

      expect(menus(d.commands)).toEqual([]);
      expect(status(d.commands)).toEqual(["Reading #4's run and session…"]);
      d.send(runsAnswer([]));
      expect(menus(d.commands)).toHaveLength(1);
      expect(status(d.commands)).toEqual(['']);
    });

    test('pressed again meanwhile: still one menu once they land', () => {
      const d = early().send({ kind: 'key', key: '<D-CR>' });

      expect(status(d.commands)).toEqual(["Reading #4's run and session…"]);
      d.send(runsAnswer([]));
      expect(menus(d.commands)).toHaveLength(1);
    });

    test('a runs read that failed: it opens on what is known', () => {
      const d = early().send({
        kind: 'result',
        id: 'runs',
        command: 'factory status',
        reply: { ok: false, error: { code: 'serve-unreachable', message: 'abe serve is not up' } },
      });

      expect(menus(d.commands)).toHaveLength(1);
    });

    test.each<[string, Input]>([
      ['Esc', { kind: 'key', key: '<Esc>' }],
      ['another key', { kind: 'key', key: 'ö' }],
      ['a click', { kind: 'click', id: 'nothing' }],
      ['the keyboard gone', { kind: 'focus', focused: false }],
    ])('%s meanwhile drops it: no menu later, the status line cleared', (_, input) => {
      const d = early().send(input);

      expect(status(d.commands)).toEqual(['']);
      d.send(runsAnswer([]));
      expect(menus(d.commands)).toEqual([]);
      expect(status(d.commands)).toEqual([]);
    });

    test('Chat moved to another card meanwhile: not opened on it', () => {
      const d = early().send({ kind: 'open', params: { card: '9' }, size: SIZE });

      expect(status(d.commands)).toEqual(['']);
      d.send(runsAnswer([]));
      expect(menus(d.commands)).toEqual([]);
    });

    test('another project shown meanwhile: not opened on its runs', () => {
      const d = early().send({ kind: 'root', root: '/p/other' });

      expect(status(d.commands)).toEqual(['']);
      d.send(sessionsAnswer(ended), runsAnswer([]));
      expect(menus(d.commands)).toEqual([]);
    });

    test('the runs in before the sessions: held until both are, never the launch rows on a live session', () => {
      const live = [{ ...session('s4', 'working', 4), worktree: '/p/shop-wt/4-cart-total' }];
      const d = drive({ card: '4' }).send({ kind: 'key', key: '<D-CR>' });

      expect(status(d.commands)).toEqual(["Reading #4's run and session…"]);
      d.send(runsAnswer([]));
      expect(menus(d.commands)).toEqual([]);
      d.send(sessionsAnswer(live));
      const menu = menus(d.commands)[0];
      const rows = menu?.kind === 'menu' ? menu.rows.map((r) => r.id) : [];

      expect(rows).toContain('stop');
      expect(rows).not.toContain('launch-local-sandbox');
    });

    test('a sessions read that failed: the held press gives way, the status line cleared', () => {
      const d = drive({ card: '4' }).send({ kind: 'key', key: '<D-CR>' }, runsAnswer([]));

      d.send({
        kind: 'result',
        id: 'sessions',
        command: 'session list',
        reply: { ok: false, error: { code: 'serve-unreachable', message: 'abe serve is not up' } },
      });
      expect(menus(d.commands)).toEqual([]);
      expect(status(d.commands)).toEqual(['']);
    });
  });

  test('your session is yours on a card the Board says is a teammate’s (#306)', () => {
    const d = drive({ card: '4', whose: 'Sam Sample' }).read();

    expect(whoseOf(d.state)).toBeUndefined();
    expect(d.text()).not.toContain('Sam Sample');
    // with no session of yours there, the Board's word holds
    expect(whoseOf(drive({ card: '4', whose: 'Sam Sample' }).read([], []).state)).toBe(
      'Sam Sample',
    );
  });

  test('a card made after Mine was read, assigned to you: yours, a teammate’s by name (#259)', () => {
    const yours = listCard(1, 'Show stock on a product card', 'New', 'Ada Example');
    const chat = (who: string) =>
      drive({ card: '6' })
        .read()
        .send(mineAnswer([yours]), chatCard(listCard(6, 'Wishlist', 'New', who)));

    // no session yet: the launch offered, nobody's name
    expect(chat('Ada Example').text()).not.toContain("'s story");
    expect(chat('Ada Example').text()).not.toContain("'s session");
    expect(chat('Ada Example').text()).toContain('Launch agent');
    expect(chat('Kim Developer').text()).toContain("Kim Developer's story");
  });

  test('a card assigned to you meanwhile is yours: Mine and the card read again (#231)', () => {
    const assign = (exit: 0 | 1 = 0, seq = 9) =>
      eventInput({ type: 'command.ran', seq, data: { noun: 'card', verb: 'assign', exit } });
    const card = (assignee: string | null) =>
      chatCard(listCard(4, 'Cart total includes shipping', 'Active', assignee));
    /** The Mine read the last step asked, answered with these cards. */
    const mineOf = (d: { commands: Command[] }, cards: CardData[]): Input => {
      const read = d.commands.find((c) => c.kind === 'run' && c.argv.includes('--mine'));

      return { ...cardsAnswer(cards, true), id: read?.kind === 'run' ? read.id : 'none' };
    };
    // the Factory view's card, no session of yours on it yet (#306), no one's when Chat read Mine
    const d = drive({ card: '4' }).read([], []);
    const before = mineAnswer([]);

    d.send(before, card(null));
    expect(whoseOf(d.state)).toBeUndefined();
    // Assign › Me
    d.send(assign());
    expect(argvs(d.commands)).toEqual(['card list --mine --closed', 'card show 4']);
    const after = mineOf(d, [
      listCard(4, 'Cart total includes shipping', 'Active', 'Kim Developer'),
    ]);

    // the card answers first: still yours while Mine is read again, never the assignee's
    d.send(card('Kim Developer'));
    expect(whoseOf(d.state)).toBeUndefined();
    d.send(after);
    expect(whoseOf(d.state)).toBeUndefined();
    expect(d.text()).not.toContain("'s story");
    // (a Mine read out at the assignment answering after it: live drops it, `live/facts.test.ts`)
    // the card on someone else and not in Mine (assigned elsewhere): theirs, named
    d.send(assign(0, 10));
    d.send(mineOf(d, []), card('Lee Park'));
    expect(whoseOf(d.state)).toBe('Lee Park');
    expect(d.text()).toContain("Lee Park's story");
    // a refused assign, or another verb: nothing read
    d.send(assign(1, 11));
    expect(argvs(d.commands)).toEqual([]);
    d.send(eventInput({ type: 'command.ran', data: { noun: 'card', verb: 'comment', exit: 0 } }));
    expect(argvs(d.commands)).toEqual([]);
    // no story pinned (the main checkout): only Mine read again
    const main = drive({ root: '/p/shop' }).read([], []).send(mineAnswer([]));

    main.send(assign());
    expect(argvs(main.commands)).toEqual(['card list --mine --closed']);
  });

  test('follows board.changed (#236): the story’s title and whose from the card as serve read it', () => {
    const changed = (
      cards: { card: CardData; mine: boolean }[],
      gone: number[] = [],
      team = 'Sandbox',
    ): Input =>
      eventInput({
        type: 'board.changed',
        data: {
          board: { organization: 'https://dev.azure.com/demo-org', project: 'Sandbox', team },
          cards,
          gone,
        },
      });
    const four = listCard(4, 'Cart total includes shipping', 'Active', 'Ada Example');
    // the Factory view's card, no session of yours on it, yours (in your Mine)
    const d = drive({ card: '4' })
      .read([], [])
      .send(mineAnswer([four]), chatCard(four));

    expect(d.text()).toContain('Cart total includes shipping');
    expect(whoseOf(d.state)).toBeUndefined();
    // a teammate renames it on Azure DevOps: the header says so, nothing read
    d.send(changed([{ card: { ...four, title: 'Cart total with tax' }, mine: true }]));
    expect(argvs(d.commands)).toEqual([]);
    expect(d.text()).toContain('Cart total with tax');
    // another board's #4: not this one
    d.send(changed([{ card: { ...four, title: 'Another board' }, mine: false }], [], 'Other'));
    expect(d.text()).not.toContain('Another board');
    expect(whoseOf(d.state)).toBeUndefined();
    // taken by Lee Park: off your Mine, theirs, read-only
    const lee = { name: 'Lee Park', email: 'lee@example.test' };

    d.send(
      changed([{ card: { ...four, title: 'Cart total with tax', assignee: lee }, mine: false }]),
    );
    expect(whoseOf(d.state)).toBe('Lee Park');
    expect(d.text()).toContain("Lee Park's story");
    // given back to you
    d.send(changed([{ card: { ...four, title: 'Cart total with tax' }, mine: true }]));
    expect(whoseOf(d.state)).toBeUndefined();
  });

  test('in the Factory view the Board names the card (title param): board.changed renames it, a later name holds (#236)', () => {
    const four = listCard(4, 'Cart total includes shipping', 'Active', 'Ada Example');
    const d = drive({ card: '4', title: 'Cart total includes shipping' })
      .read([], [])
      .send(mineAnswer([four]));

    d.send(
      eventInput({
        type: 'board.changed',
        data: {
          board: {
            organization: 'https://dev.azure.com/demo-org',
            project: 'Sandbox',
            team: 'Sandbox',
          },
          cards: [{ card: { ...four, title: 'Cart total with tax' }, mine: true }],
          gone: [],
        },
      }),
    );
    expect(d.text()).toContain('Cart total with tax');
    // the Board's next name for it is the one shown
    d.send({ kind: 'open', params: { card: '4', title: 'Cart total, tax and fees' }, size: SIZE });
    expect(d.text()).toContain('Cart total, tax and fees');
  });

  test('pins the live session whose worktree is the shown folder, and reads its transcript', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total/' }).send(sessionsAnswer(SESSIONS));

    expect(pinned(d)).toBe('s4');
    // its open cards (#114) and its transcript
    expect(argvs(d.commands)).toEqual(['session asks s4', 'session transcript s4']);
    d.send(runsAnswer(RUNS));
    expect(d.text()).toContain('"story":{"id":"#4","title":"Cart total includes shipping"}');
    // the shell's column has the toggle, ⋮ and ×: none in its header
    expect(d.text()).not.toContain('chat:hide');
    expect(d.text()).not.toContain('"modes"');
    expect(d.text()).not.toContain('"kind":"Terminal"');
  });

  test('pins by the shown box on a cloud workspace', () => {
    const d = drive({ root: '/p/shop' })
      .read()
      .send({ kind: 'root', root: '/p/shop', box: 'shop-5' });

    expect(pinned(d)).toBe('s5');
  });

  test('the session and card params pin it instead', () => {
    expect(pinned(drive({ root: '/p/shop', session: 's5' }).read())).toBe('s5');
    expect(pinned(drive({ root: '/p/shop', card: '4' }).read())).toBe('s4');
  });

  test('no session: the card from the branch, Launch agent ⏎ opens the Launch box; its ⏎ launches it once', () => {
    const d = drive({ root: '/p/shop-wt/1-show-stock', branch: 'card/1-show-stock-on-a-card' });

    expect(argvs(d.read().commands)).toEqual(['card show 1']);
    expect(d.text()).toContain('No session on #1 yet');
    expect(d.text()).toContain('"label":"Launch agent"');
    expect(d.text()).toContain('"label":"more"');
    d.send({ kind: 'key', key: '<CR>' });
    expect(d.commands).toMatchObject([
      { kind: 'launch', id: 'launchbox:1', card: 1, target: 'local-sandbox' },
    ]);
    expect(argvs(d.commands)).toEqual([]);
    d.send(boxEnter(1));
    expect(argvs(d.commands)).toEqual([
      'factory run 1 --repo /p/shop-wt/1-show-stock --target local-sandbox',
    ]);
    expect(d.text()).toContain('Launching…');
    d.send({ kind: 'key', key: '<CR>' });
    expect(d.commands).toEqual([]);
    // the box's ⏎ again while it launches: nothing more
    d.send(boxEnter(1));
    expect(argvs(d.commands)).toEqual([]);
    // the launch's answer pins its session, wherever its worktree is
    const run = factoryRun(1, 'Show stock on a product card', 'spec', 'running', {
      session: 's1',
    });

    d.send({
      kind: 'result',
      id: 'launch:1',
      command: 'factory run',
      reply: { ok: true, data: run },
    });
    d.read([...SESSIONS, session('s1', 'working', 1)], [...RUNS, run]);
    expect(pinned(d)).toBe('s1');
  });

  test('no session: ⇧⏎ opens the Launch box on the card; its ⏎ launches with the note (#347)', () => {
    const d = drive({ root: '/p/shop-wt/1-show-stock', branch: 'card/1-show-stock-on-a-card' });

    d.read();
    d.send(chatCard(listCard(1, 'Show stock on a product card', 'New', null)));
    d.send({ kind: 'key', key: '<S-CR>' });
    expect(d.commands).toEqual([
      {
        kind: 'launch',
        id: 'launchbox:1',
        card: 1,
        title: 'Show stock on a product card',
        where: 'Local sandbox',
        target: 'local-sandbox',
      },
    ]);
    // the box's ⏎ comes back as its choice
    d.send({
      kind: 'choice',
      menu: 'launchbox:1',
      row: 'launch',
      values: ['use the stock helper'],
    });
    expect(argvs(d.commands)).toEqual([
      // no one's card: launched first, assigned to you once it is (Assign to me and launch)
      'factory run 1 --repo /p/shop-wt/1-show-stock --target local-sandbox --note=use the stock helper',
    ]);
    d.send({
      kind: 'result',
      id: 'launch:1',
      command: 'factory run',
      reply: { ok: true, data: factoryRun(1, 'Show stock on a product card', 'spec', 'running') },
    });
    expect(argvs(d.commands)).toContain('card assign 1 me');
    // a workflow picked, a box picked: each its flag
    const w = drive({ root: '/p/shop-wt/1-show-stock', branch: 'card/1-show-stock-on-a-card' });

    w.read();
    w.send(chatCard(listCard(1, 'Show stock on a product card', 'New', null)));
    w.send({
      kind: 'choice',
      menu: 'launchbox:1',
      row: 'launch',
      values: ['', 'quick-fix', 'cloud', ''],
    });
    expect(argvs(w.commands)).toEqual([
      'factory run 1 --repo /p/shop-wt/1-show-stock --target cloud --workflow quick-fix',
    ]);
    // refused (an expired aws login): nothing written to the board, so not assigned
    w.send({
      kind: 'result',
      id: 'launch:1',
      command: 'factory run',
      reply: {
        ok: false,
        error: { code: 'aws-login-expired', message: 'the aws login of dev is expired' },
      },
    });
    expect(argvs(w.commands)).toEqual([]);
    // its Launching… cleared, why in a balloon: as on the Board and the Card page
    expect(w.commands).toMatchObject([
      { kind: 'shell', effect: { kind: 'status', text: '' } },
      { kind: 'shell', effect: { kind: 'balloon' } },
    ]);
    // Chat on another card meanwhile: the box's launch is not this card's
    const e = drive({ root: '/p/shop', card: '4' }).read([], []);

    e.send({ kind: 'choice', menu: 'launchbox:1', row: 'launch', values: ['the note'] });
    expect(argvs(e.commands)).toEqual([]);
    // it says so, and the box comes back with the note
    expect(e.commands).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'status', text: '#1 not launched: Chat is on another card now' },
      },
      {
        kind: 'launch',
        id: 'launchbox:1',
        card: 1,
        title: '',
        where: 'where serve.target says',
        draft: { note: 'the note' },
      },
    ]);
    // a prototype's card: its box reads what goes along as reference
    const p = drive({ root: '/p/shop-wt/1-show-stock', branch: 'card/1-show-stock-on-a-card' });

    p.read();
    p.send(
      chatCard(listCard(1, 'Show stock on a product card', 'New', null, { tags: ['prototype'] })),
    );
    p.send({ kind: 'key', key: '<S-CR>' });
    expect(p.commands).toMatchObject([{ kind: 'launch', card: 1, prototype: true }]);
  });

  /** The first node of `kind` in the tree, depth first. */
  const nodeOf = (n: Node, kind: string): Node | undefined => {
    if (n.kind === kind) return n;
    for (const c of ('children' in n ? n.children : undefined) ?? []) {
      const found = nodeOf(c, kind);

      if (found !== undefined) return found;
    }

    return undefined;
  };

  test("no session: the 2.1 header, the card's title as written and its rail New · no session (#291)", () => {
    const d = drive({ root: '/p/shop', card: '4' }).read([], []);

    d.send(chatCard(listCard(4, 'As a visitor I can sign in with email', 'New', null)));
    const header = nodeOf(d.tree, 'ChatHeader');

    expect(header?.kind === 'ChatHeader' ? header.props : undefined).toMatchObject({
      story: { id: '#4', title: 'As a visitor I can sign in with email' },
      hint: '⌘⏎',
      rail: {
        segments: ['todo', 'todo', 'todo', 'todo', 'todo'],
        stage: 'New',
        state: 'idle',
        word: 'no session',
      },
    });
    expect(header?.kind === 'ChatHeader' ? Object.keys(header.props) : []).not.toContain('scope');
    // a teammate's card: the same header, whose in place of where it would launch
    const theirs = drive({ root: '/p/shop', card: '8' }).read([], []);

    theirs.send(
      mineAnswer([]),
      chatCard(listCard(8, 'Sign-in button overlaps the logo', 'Active', 'Sam Smith')),
    );
    const their = nodeOf(theirs.tree, 'ChatHeader');

    expect(their?.kind === 'ChatHeader' ? their.props : undefined).toMatchObject({
      story: { id: '#8', title: 'Sign-in button overlaps the logo' },
      env: "Sam Smith's session",
    });
  });

  test("no session: Abe's head, the title, Launch agent ⏎ as the primary button and ⌘⏎ more under it (#292)", () => {
    const d = drive({ root: '/p/shop', card: '4' }).read([], []);
    const body = nodeOf(d.tree, 'Empty');

    expect(body?.kind === 'Empty' ? body.props : undefined).toEqual({
      title: 'No session on #4 yet',
      line: '',
      head: true,
      actions: [
        { id: 'chat:launch', label: 'Launch agent', keys: '⏎', primary: true },
        { id: 'chat:more', label: 'more', keys: '⌘⏎' },
      ],
    });
    expect(nodeOf(d.tree, 'KeyHint')).toBeUndefined();
  });

  test("no one's card: Assign to me and launch, as the story dialog's primary; ⏎ the Launch box, its ⏎ launches, then assigns", () => {
    const d = drive({ root: '/p/shop', card: '4' })
      .read([], [])
      .send(mineAnswer([]), chatCard(listCard(4, 'Cart total includes shipping', 'New', null)));

    expect(d.text()).toContain('"label":"Assign to me and launch"');
    d.send({ kind: 'key', key: '<CR>' });
    expect(d.commands).toMatchObject([{ kind: 'launch', id: 'launchbox:4', card: 4 }]);
    expect(argvs(d.commands)).toEqual([]);
    d.send(boxEnter(4));
    expect(argvs(d.commands)).toEqual(['factory run 4 --repo /p/shop']);
  });

  test("no one's card the Board named: read once Mine says it is not yours, then Assign to me and launch", () => {
    const d = drive({ root: '/p/shop', card: '4', title: 'Cart total includes shipping' }).read(
      [],
      [],
    );

    expect(argvs(d.commands)).not.toContain('card show 4');
    d.send(mineAnswer([]));
    expect(argvs(d.commands)).toContain('card show 4');
    d.send(chatCard(listCard(4, 'Cart total includes shipping', 'New', null)));
    expect(d.text()).toContain('"label":"Assign to me and launch"');
  });

  test('⌘⏎ with no session is the launch menu; its Local sandbox row opens the Launch box there, its ⏎ launches there', () => {
    const d = drive({ root: '/p/x', branch: 'card/1' }).read();

    d.send({ kind: 'key', key: '<D-CR>' });
    expect(d.commands[0]).toMatchObject({ kind: 'menu', id: 'chat:more' });
    d.send({ kind: 'choice', menu: 'chat:more', row: 'launch-local-sandbox' });
    expect(d.commands).toMatchObject([
      { kind: 'launch', id: 'launchbox:1', draft: { note: '', runs: 'local-sandbox' } },
    ]);
    expect(argvs(d.commands)).toEqual([]);
    d.send(boxEnter(1, 'local-sandbox'));
    expect(argvs(d.commands)).toEqual(['factory run 1 --repo /p/x --target local-sandbox']);
  });

  test('⌘⏎ with no session has the story’s jumps too: Open card, Linked ⌃L (#346)', () => {
    const d = drive({ root: '/p/x', branch: 'card/1' }).read();

    d.send({ kind: 'key', key: '<D-CR>' });
    const menu = d.commands[0];

    expect(menu?.kind === 'menu' ? menu.rows.map((r) => [r.id, r.key]) : []).toEqual([
      ['launch-local-sandbox', undefined],
      ['launch-cloud', undefined],
      ['launch-box', '⏎'],
      ['story', undefined],
      ['linked', '⌃L'],
    ]);
    d.send({ kind: 'choice', menu: 'chat:more', row: 'linked' });
    expect(d.commands).toEqual([{ kind: 'jump', to: 'linked', story: 1 }]);
    expect(argvs(d.commands)).toEqual([]);
  });

  test('launched on a warm box, its session not listed yet: its steps with their times, as a cold launch lists them (#229)', () => {
    const T0 = '2026-10-01T09:00:00.000Z';
    const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();
    const d = drive({ root: '/p/x', branch: 'card/1' }).read();

    d.send(
      { kind: 'tick', at: at(0) },
      { kind: 'key', key: '<D-CR>' },
      { kind: 'choice', menu: 'chat:more', row: 'launch-cloud' },
    );
    expect(d.commands).toMatchObject([
      { kind: 'launch', id: 'launchbox:1', draft: { note: '', runs: 'cloud' } },
    ]);
    d.send(boxEnter(1, 'cloud'));
    expect(argvs(d.commands)).toEqual(['factory run 1 --repo /p/x --target cloud']);
    expect(d.text()).toContain('Chat attaches once its Claude Code runs.');
    const launch = {
      step: 'claude-starting' as const,
      since: at(6),
      startedAt: at(0),
      box: 'shop-1',
      how: 'use' as const,
      detail: null,
      told: true,
      done: [{ step: 'workspace' as const, ms: 6000 }],
    };

    d.send(eventInput({ type: 'session.step', data: { id: 's1', card: 1, launch } }, at(6)), {
      kind: 'tick',
      at: at(8),
    });
    const rows = d.text();

    expect(rows).toContain('"text":"✓ Workspace","note":"0:06"');
    expect(rows).toContain('"note":"0:02"');
    expect(rows).not.toContain('Chat attaches once its Claude Code runs.');
    // its clock ticks by the second
    expect(pinnedScreen.seconds?.(d.state)).toBe(true);
    // the launch refused: none of its steps stay, no clock
    d.send({
      kind: 'result',
      id: 'launch:1',
      command: 'factory run',
      reply: { ok: false, error: { code: 'launch-failed', message: 'no box' } },
    });
    expect(d.text()).not.toContain('✓ Workspace');
    expect(pinnedScreen.seconds?.(d.state)).toBe(false);
    // a step of a session not launched from here (nor chosen) is not this card's launch
    const other = drive({ root: '/p/x', branch: 'card/1' })
      .read()
      .send(
        { kind: 'tick', at: at(0) },
        eventInput({ type: 'session.step', data: { id: 's9', card: 1, launch } }, at(6)),
      );

    expect(other.text()).not.toContain('✓ Workspace');
  });

  test('a launch on the card asked elsewhere (the Board, the Card page, the CLI): Launching… until its session is listed; refused, no session again and why', () => {
    const d = drive({ root: '/p/shop', card: '1' }).read();
    const started = eventInput({ type: 'launch.started', data: { card: 1, repo: '/p/shop' } });
    const ended = (session: string | null) =>
      eventInput({
        type: 'launch.ended',
        data: {
          card: 1,
          repo: '/p/shop',
          session,
          refused:
            session === null
              ? { code: 'aws-auth', message: 'the aws login of dev is expired' }
              : null,
        },
      });

    expect(d.text()).toContain('No session on #1 yet');
    // another card's launch is not this one's
    d.send(eventInput({ type: 'launch.started', data: { card: 2, repo: '/p/shop' } }));
    expect(d.text()).toContain('No session on #1 yet');
    d.send(started);
    expect(d.text()).toContain('"word":"Launching…"');
    expect(d.text()).toContain('Chat attaches once its Claude Code runs.');
    expect(d.text()).not.toContain('Launch agent');
    // ⏎ while it launches elsewhere launches nothing more
    d.send({ kind: 'key', key: '<CR>' });
    expect(d.commands).toEqual([]);
    // refused: no session, Launch agent offered again, and why
    d.send(ended(null));
    expect(d.text()).toContain('No session on #1 yet');
    expect(d.text()).toContain('"label":"Launch agent"');
    expect(d.text()).toContain('Launch refused: the aws login of dev is expired (aws-auth)');
    // asked again, launched: Launching… until its session is listed, then Chat on it
    d.send(started);
    expect(d.text()).not.toContain('Launch refused');
    d.send(ended('s1'));
    expect(argvs(d.commands)).toEqual(['session show s1']);
    expect(d.text()).toContain('"word":"Launching…"');
    d.read([...SESSIONS, session('s1', 'working', 1)]);
    expect(pinned(d)).toBe('s1');
    expect(d.state.launchesHeard?.[1]).toBeUndefined();
  });

  /** The `serve.target` read the last input asked for, by its id; none: undefined. */
  const targetAsked = (commands: readonly Command[]): string | undefined =>
    commands.flatMap((c) =>
      c.kind === 'run' && c.argv.join(' ') === 'settings get serve.target' ? [c.id] : [],
    )[0];
  const target = (value: string, id: string | undefined): Input => ({
    kind: 'result',
    id: id ?? 'none asked',
    command: 'settings get',
    reply: {
      ok: true,
      data: { key: 'serve.target', value, layer: 'individual', lowered: null, problems: [] },
    },
  });
  const env = (d: { tree: Node }) =>
    /"kind":"ChatHeader"[^}]*?"env":"([^"]*)"/.exec(JSON.stringify(d.tree))?.[1];
  const changed = (keys: SettingsChangedData['keys']): Input => ({
    kind: 'event',
    event: {
      seq: 3,
      at: '2026-09-01T10:00:00.000Z',
      type: 'settings.changed',
      data: { keys, repo: null },
    },
  });

  test("the header names where ⏎ launches a card's new session: serve.target, read (#208)", () => {
    // the Factory view's card with no session: its launch goes where serve.target says
    const d = drive({ root: '/p/shop', card: '7' });
    const first = targetAsked(d.commands);

    expect(first).toBeDefined();
    d.read();
    // not read yet: no place named, never a guess
    expect(env(d)).toBeUndefined();
    expect(env(d.send(target('local', first)))).toBe('Local sandbox');
    // another setting changed: nothing read; serve.target changed: read again
    expect(d.send(changed(['autoMerge'])).commands).toEqual([]);
    expect(argvs(d.send(changed(['serve.target'])).commands)).toEqual([
      'settings get serve.target',
    ]);
    // local mode or the board moved: launches may now stay here, so read again too
    for (const key of ['localMode', 'board'] as const)
      expect(argvs(d.send(changed([key])).commands)).toEqual(['settings get serve.target']);
    const again = targetAsked(d.commands);

    // the header keeps the old place meanwhile
    expect(env(d)).toBe('Local sandbox');
    expect(env(d.send(target('cloud', again)))).toBe('Cloud');
    // another project shown: its own serve.target; the one asked before answers too late
    d.send(changed(['serve.target']));
    const shop = targetAsked(d.commands);

    d.send({ kind: 'root', root: '/p/other' });
    const other = targetAsked(d.commands);

    expect(other).toBeDefined();
    expect(env(d.send(target('local', shop)))).toBeUndefined();
    expect(env(d.send(target('cloud', other)))).toBe('Cloud');
    // the Editor's local workspace: always the Local sandbox, nothing read
    const editor = drive({
      root: '/p/shop-wt/1-show-stock',
      branch: 'card/1-show-stock-on-a-card',
    });

    expect(argvs(editor.commands)).not.toContain('settings get serve.target');
    expect(env(editor.read())).toBe('Local sandbox');
  });

  test('serve.target set twice quickly: the newest read names the place, a late older answer never (#223)', () => {
    const d = drive({ root: '/p/shop', card: '7' });
    const asked = targetAsked(d.commands);

    d.read().send(target('cloud', asked));
    // `abe settings set serve.target local`, then `cloud` again at once: two reads out
    d.send(changed(['serve.target']));
    const toLocal = targetAsked(d.commands);

    d.send(changed(['serve.target']));
    const toCloud = targetAsked(d.commands);

    expect(toCloud).not.toBe(toLocal);
    // the newer read answers first, the older one (from before the second set) late
    d.send(target('cloud', toCloud)).send(target('local', toLocal));
    expect(env(d)).toBe('Cloud');
  });

  test('serve.target changed while Chat named no card is read again on the next card (#223)', () => {
    // a card shown, serve.target local
    const d = drive({ root: '/p/shop', card: '101' });
    const asked = targetAsked(d.commands);

    d.read().send(target('local', asked));
    expect(env(d)).toBe('Local sandbox');
    // Chat on the folder alone (no card: the Local sandbox, nothing read); serve.target goes to cloud
    d.send({ kind: 'open', params: { root: '/p/shop' }, size: SIZE });
    expect(argvs(d.send(changed(['serve.target'])).commands)).toEqual([]);
    // the card again: serve.target read anew, never the old place
    d.send({ kind: 'open', params: { root: '/p/shop', card: '101' }, size: SIZE });
    const anew = targetAsked(d.commands);

    expect(anew).toBeDefined();
    expect(env(d.send(target('cloud', anew)))).toBe('Cloud');
  });

  test('a chosen session not listed yet asks, never says there is no story', () => {
    expect(drive({ root: '/p/shop', session: 's9' }).read().text()).toContain('Asking abe serve');
  });

  test('⌘⏎ on a live session is its actions: Stop… asked first, End run…, the jumps', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read();

    d.send({ kind: 'key', key: '<D-CR>' });
    expect(d.commands[0]).toMatchObject({ kind: 'menu', id: 'chat:session', title: '#4' });
    const rows = d.commands[0]?.kind === 'menu' ? d.commands[0].rows : [];

    expect(rows.map((r) => r.text)).toEqual([
      'Stop…',
      'End run…',
      'Open workspace',
      'Open card',
      'Linked',
    ]);
    expect(rows[0]?.does).toEqual({
      kind: 'run',
      argv: ['session', 'stop', 's4'],
      risky: true,
      confirm: {
        question: "Stop #4's session?",
        details: ['Its Claude Code stops; its worktree and its branch stay: card/4-x'],
        yes: 'Stop',
      },
      done: "Stopped #4's session",
    });
    // its Factory run ended with why (#184)
    expect(rows[1]?.does).toMatchObject({ kind: 'run', argv: ['factory', 'end', '4'] });
    // the jumps along its story (#106): the workspace's and the card's have no key (⌃W ⌃I gone)
    expect(rows.slice(2).map((r) => r.key)).toEqual([undefined, undefined, '⌃L']);
    expect(rows.slice(2).map((r) => r.does)).toEqual(
      (['workspace', 'story', 'linked'] as const).map((to) => ({
        kind: 'do',
        commands: [{ kind: 'jump', to, story: 4 }],
      })),
    );
  });

  test('the main checkout (no story) launches no card; a box’s points to the Factory view', () => {
    const d = drive({ root: '/p/shop', branch: 'main' }).read();

    expect(d.text()).toContain('Start the Abe chat');
    d.send({ kind: 'key', key: '<D-CR>' });
    expect(d.commands).toEqual([]);
    const box = drive({ root: '/p/shop', box: 'demo-shop-1', branch: 'main' }).read([], []);

    expect(box.text()).toContain('⌘⌥A Abe view to pick one');
    box.send({ kind: 'key', key: '<CR>' });
    expect(box.commands).toEqual([]);
  });

  test('an ended session with no run of its own: ⏎ reopens that same session, on its box too (#343)', () => {
    const ended = {
      ...session('103-f444', 'ended', 103),
      box: 'demo-shop-103',
      worktree: '/workspace/repo',
      reason:
        'its box demo-shop-103 stopped · abe session reopen 103-f444 wakes it and goes on: the same workspace and conversation',
    };
    const d = drive({ root: '/p/shop', card: '103' }).read([ended], []);

    // why it ended, before the way on (#316); the field stays live (#343)
    expect(d.text()).toContain('"label":"Session ended 09:01: its box demo-shop-103 stopped"');
    expect(d.text()).toContain('"note":"· ⏎ Reopen · ⌘⏎ more"');
    expect(d.text()).toContain('"placeholder":"Type a message…"');
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual(['session reopen 103-f444']);
    // once: a second ⏎ while it reopens asks nothing more
    d.send({ kind: 'key', key: '<CR>' });
    expect(d.commands).toEqual([]);
    // ⌘⏎'s Reopen the same
    const menu = drive({ root: '/p/shop', card: '103' })
      .read([ended], [])
      .send({ kind: 'key', key: '<D-CR>' })
      .commands.find((c) => c.kind === 'menu');
    const reopen = menu?.kind === 'menu' ? menu.rows.find((r) => r.id === 'reopen') : undefined;

    expect(reopen?.reason).toBeUndefined();
    expect(reopen).toMatchObject({
      key: '⏎',
      does: { kind: 'run', argv: ['session', 'reopen', '103-f444'] },
    });
    // a local one the same, never a new session
    const local = { ...session('s9', 'ended', 9), worktree: '/p/shop-wt/9-x' };
    const here = drive({ root: '/p/shop', card: '9' }).read([local], []);

    here.send({ kind: 'key', key: '<CR>' });
    expect(argvs(here.commands)).toEqual(['session reopen s9']);
    // what you type in its field is the first prompt it reopens with
    here.send({ kind: 'text', text: 'why this helper?' });
    here.send({ kind: 'key', key: '<CR>' });
    expect(argvs(here.commands)).toEqual(['session reopen s9 --message why this helper?']);
    // ⏎ again while that is asked: nothing more (never a bare reopen after it)
    here.send({ kind: 'key', key: '<CR>' });
    expect(argvs(here.commands)).toEqual([]);
    // a prototype's session on the card (#83) reopens nothing from here
    const proto = { ...ended, kind: 'prototype' as const };
    const p = drive({ root: '/p/shop', card: '103' }).read([proto], []);

    p.send({ kind: 'key', key: '<CR>' });
    expect(argvs(p.commands)).toEqual([]);
  });

  test('the Factory view’s card launches where serve.target says; a chosen session holds until the card changes', () => {
    const d = drive({ root: '/p/shop', card: '1' }).read();

    d.send({ kind: 'key', key: '<CR>' }, boxEnter(1));
    expect(argvs(d.commands)).toEqual(['factory run 1 --repo /p/shop']);
    const chosen = drive({ root: '/p/shop', card: '4', session: 's3' }).read();

    expect(pinned(chosen)).toBe('s3');
    expect(chosen.state.session).toBe('s3');
    chosen.send({ kind: 'open', params: { root: '/p/shop', card: '4' }, size: SIZE });
    expect(chosen.state.session).toBe('s3');
    chosen.send({ kind: 'open', params: { root: '/p/shop', card: '5' }, size: SIZE });
    expect(pinned(chosen)).toBe('s5');
  });

  test('a chosen session that ended gives way to the new session a Retry starts on its story (#227)', () => {
    const old = { ...session('o1', 'ended', 7), stopped: true };
    const run = (id: string) => factoryRun(7, 'Show stock', 'build', 'running', { session: id });
    const d = drive({ root: '/p/shop', card: '7', session: 'o1' }).read([old], [run('o1')]);

    expect(pinned(d)).toBe('o1');
    // Retry from anywhere (the Board, Sessions, the CLI): a new session on the card, read
    const fresh = { ...session('n1', 'starting', 7), startedAt: '2026-10-01T09:20:00.000Z' };

    d.send(sessionsAnswer([fresh, old]));
    expect(d.state.session).toBe('n1');
    expect(pinned(d)).toBe('n1');
    // the slot's open params name it, so a reconnect keeps it
    expect(d.commands).toContainEqual({
      kind: 'open',
      screen: 'chat',
      params: { card: '7', session: 'n1' },
      slot: 'chat',
      ifOpen: true,
    });
    d.send(runsAnswer([run('n1')]));
    // ⌘⏎ acts on the new one
    d.send({ kind: 'key', key: '<D-CR>' });
    expect(JSON.stringify(d.commands)).toContain('n1');
    expect(JSON.stringify(d.commands)).not.toContain('o1');
  });

  test('an ended session picked while a newer one is known stays, and a live chosen one never gives way (#227)', () => {
    const old = { ...session('o1', 'ended', 7), stopped: true };
    const newer = { ...session('n1', 'waiting', 7), startedAt: '2026-10-01T09:20:00.000Z' };
    const picked = drive({ root: '/p/shop', card: '7', session: 'o1' }).read([old, newer], []);

    expect(pinned(picked)).toBe('o1');
    picked.read([old, newer], []);
    expect(pinned(picked)).toBe('o1');
    const live = drive({ root: '/p/shop', card: '7', session: 'n1' }).read([newer], []);
    const other = { ...session('n2', 'starting', 7), startedAt: '2026-10-01T09:30:00.000Z' };

    live.read([other, newer], []);
    expect(pinned(live)).toBe('n1');
    // picked from a list Chat had not read: the read that first lists it lists the newer too
    const unread = drive({ root: '/p/shop', card: '7' }).read([], []);

    unread.send({
      kind: 'open',
      params: { root: '/p/shop', card: '7', session: 'o1' },
      size: SIZE,
    });
    unread.read([newer, old], []);
    expect(pinned(unread)).toBe('o1');
  });

  test('its session ending keeps the transcript; the header says Ended, or Stopped (#205)', () => {
    const ended = (cause: string): Event => ({
      seq: 9,
      at: '2026-10-01T09:30:00.000Z',
      type: 'session.state',
      data: { id: 's4', card: 4, state: 'ended', since: '2026-10-01T09:30:00.000Z', cause },
    });
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read();

    d.send({ kind: 'event', event: ended('gone') });
    expect(pinned(d)).toBe('s4');
    // nothing read again; only the Editor's Claude Code tab told it has nothing to attach (#340)
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'chat-session', session: null } },
    ]);
    expect(d.text()).toContain('"word":"Ended"');
    const stopped = drive({ root: '/p/shop-wt/4-cart-total' }).read();

    stopped.send({ kind: 'event', event: ended('stop') });
    expect(stopped.text()).toContain('"glyph":"○","word":"Stopped"');
  });

  test('its box stopped under a working run: Box asleep, the ended line says why, ⏎ Reopen goes on there (#316, #343)', () => {
    const box = 'demo-6';
    const working = { ...session('s6', 'working', 6), box };
    const run = factoryRun(6, 'Saved carts survive sign-out', 'pr', 'running', { session: 's6' });
    const d = drive({ card: '6' }).read([working], [run]);

    d.send({
      kind: 'event',
      event: {
        seq: 9,
        at: '2026-10-01T09:30:00.000Z',
        type: 'session.state',
        data: {
          id: 's6',
          card: 6,
          state: 'ended',
          since: '2026-10-01T09:30:00.000Z',
          cause: 'box-stopped',
          reason: `its box ${box} stopped · abe session reopen 6-a1b2 wakes it`,
        },
      },
    });
    d.send({
      kind: 'event',
      event: {
        seq: 10,
        at: '2026-10-01T09:30:01.000Z',
        type: 'factory.stage',
        data: {
          card: 6,
          session: 's6',
          stage: 'pr',
          from: null,
          state: 'needs-you',
          reason: 'its session ended',
          since: '2026-10-01T09:30:01.000Z',
          cause: 'session',
          outcome: null,
          pr: null,
        },
      },
    });
    expect(d.text()).toContain('"glyph":"◆","word":"Box asleep"');
    expect(d.text()).not.toContain('Failed');
    expect(d.text()).toContain(`"label":"Session ended 09:30: its box ${box} stopped"`);
    // ⏎ reopens it there, its box woken (#343)
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual(['session reopen s6']);
  });

  test('Stop… on a Queued run: Stopped at once as on its card; never placed, so no Reopen, Retry run in ⌘⏎ (#258, #343)', () => {
    const queued = { ...session('s5', 'queued', 5), box: 'demo-5' };
    const run = factoryRun(5, 'Saved carts survive sign-out', 'spec', 'queued', {
      session: 's5',
    });
    const d = drive({ card: '5' }).read([queued], [run]);

    expect(d.text()).toContain('"word":"Queued"');
    d.send({
      kind: 'event',
      event: {
        seq: 9,
        at: '2026-10-01T09:30:00.000Z',
        type: 'session.state',
        data: {
          id: 's5',
          card: 5,
          state: 'ended',
          since: '2026-10-01T09:30:00.000Z',
          cause: 'stop',
        },
      },
    });
    // its run's own move has not come yet
    expect(d.text()).toContain('"glyph":"○","word":"Stopped"');
    expect(d.text()).toContain('"line":"Session stopped 09:30"');
    // it never got a box (#246): no workspace to go back into, ⏎ reopens nothing
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual([]);
    d.send({ kind: 'key', key: '<D-CR>' });
    const menu = d.commands.find((c) => c.kind === 'menu');
    const rows = menu?.kind === 'menu' ? menu.rows : [];

    expect(rows.map((r) => r.id)).not.toContain('reopen');
    expect(rows.find((r) => r.id === 'retry')).toMatchObject({
      text: 'Retry run',
      does: { kind: 'run', argv: ['factory', 'run', '5', '--repo', 'mkdir-swe/demo-shop'] },
    });
  });

  test('a plain session you stopped (#332): Stopped in the header, ⏎ Reopen goes back into it (#343)', () => {
    const stopped = { ...session('5-a1b2', 'ended', 5), stopped: true };
    const d = drive({ root: '/p/shop', card: '5' }).read([stopped], []);

    expect(d.text()).toContain('"word":"Stopped"');
    expect(d.text()).toContain('"label":"Session stopped 09:01"');
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual(['session reopen 5-a1b2']);
    // its claude never started (no transcript, #355): no Reopen offered, ⏎ says why and the way on
    const never = drive({ root: '/p/shop', card: '5' }).read(
      [{ ...stopped, transcriptPath: null }],
      [],
    );

    expect(never.text()).not.toContain('⏎ Reopen');
    never.send({ kind: 'key', key: '<CR>' });
    expect(never.commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'status',
          text: 'its claude never started a conversation: Launch new agent… starts fresh',
        },
      },
    ]);
  });

  test("a cleared Factory run's session (stopped to clear it) reads Ended, as the card's No session (#332)", () => {
    const cleared = { ...session('5-a1b2', 'ended', 5), stopped: true, factory: true as const };
    const d = drive({ root: '/p/shop', card: '5' }).read([cleared], []);

    expect(d.text()).toContain('"word":"Ended"');
    expect(d.text()).not.toContain('Stopped');
    expect(d.text()).toContain('"label":"Session ended 09:01"');
    expect(d.text()).toContain('⏎ Reopen');
  });

  test('a done run and a newer plain session on its card: Chat pins what the card shows (#335)', () => {
    const run = factoryRun(5, 'Saved carts survive sign-out', 'done', 'done', {
      session: 's5',
      outcome: 'not-reproduced',
    });
    const ran = { ...session('s5', 'ended', 5), stopped: true, factory: true as const };
    const later = (state: SessionData['state']) => ({
      ...session('5-new', state, 5),
      startedAt: '2026-10-01T09:30:00.000Z',
    });
    const chat = (newer: SessionData) =>
      drive({ root: '/p/shop', card: '5' }).read([ran, newer], [run]);

    expect(pinOf(chat(later('working')).state)).toMatchObject({ session: { id: '5-new' } });
    expect(pinOf(chat(later('working')).state).run).toBeUndefined();
    // ended on its own: the run again, as its card reads it
    const ended = chat(later('ended'));

    expect(pinOf(ended.state)).toMatchObject({ run: { session: 's5' }, session: { id: 's5' } });
    expect(ended.text()).toContain('"word":"Not reproduced"');
  });

  test('a Done run’s session: ⏎ reopens it as a plain conversation, no Retry run (#296, #343)', () => {
    const ended = { ...session('s5', 'ended', 5), stopped: true };
    const run = factoryRun(5, 'Saved carts survive sign-out', 'done', 'done', { session: 's5' });
    const d = drive({ card: '5' }).read([ended], [run]);

    expect(d.text()).toContain('"label":"Session stopped 09:01"');
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual(['session reopen s5']);
    d.send({ kind: 'key', key: '<D-CR>' });
    const menu = d.commands.find((c) => c.kind === 'menu');
    const ids = menu?.kind === 'menu' ? menu.rows.map((r) => r.id) : [];

    expect(ids).toContain('reopen');
    expect(ids).not.toContain('retry');
  });

  test('a launch answered after another workspace is shown pins nothing there', () => {
    const d = drive({ root: '/p/shop-wt/1-show-stock', branch: 'card/1-show-stock-on-a-card' });

    d.read().send({ kind: 'key', key: '<CR>' }, boxEnter(1));
    expect(d.state.actions.launching).toEqual([1]);
    d.send({ kind: 'root', root: '/p/shop-wt/4-cart-total' });
    // (the launch is still out, its answer no longer this workspace's)
    expect(d.state.launchFrom).toBeUndefined();
    expect(pinned(d)).toBe('s4');
    const run = factoryRun(1, 'Show stock on a product card', 'spec', 'running', {
      session: 's1',
    });

    d.send({
      kind: 'result',
      id: 'launch:1',
      command: 'factory run',
      reply: { ok: true, data: run },
    });
    expect(d.state.launched).toBeUndefined();
    d.read([...SESSIONS, session('s1', 'working', 1)], [...RUNS, run]);
    expect(pinned(d)).toBe('s4');
  });

  test('another folder shown pins again', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read();

    d.send({ kind: 'root', root: '/box/x', box: 'shop-5' });
    expect(pinned(d)).toBe('s5');
    // a box's workspace launches where serve.target says (#208)
    // its sessions and runs read again there: the lists name that folder's repo (#256)
    expect(argvs(d.commands)).toEqual([
      'session list',
      'factory status',
      // and your cards: that folder's board
      'card list --mine --closed',
      'settings get serve.target',
      'session asks s5',
      'session transcript s5',
      // its box as listed, for the header's cloud
      'box list',
    ]);
  });

  test("the header's cloud is its box's as listed: running on after its session ended, not asleep", () => {
    const ended = { ...session('s5', 'ended', 5), worktree: '/box/repo', box: 'shop-5' };
    const d = drive({ root: '/box/x', box: 'shop-5' }).read([ended], []);
    const cloud = () => /"box":\{"name":"shop-5","state":"(\w+)"\}/.exec(d.text())?.[1];

    // not listed yet: the ended session says asleep
    expect(cloud()).toBe('asleep');
    d.send(boxesAnswer([X_BOXES.box('shop-5')]));
    expect(cloud()).toBe('running');
    d.send(
      eventInput({ type: 'box.state', data: { box: 'shop-5', state: 'stopped', cause: 'idle' } }),
    );
    expect(cloud()).toBe('asleep');
  });

  test('back on a workspace, its session’s Chat is as it was left, read again (#105 S2)', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read();

    // a `g` waiting for its second is the s4 Chat's own state
    d.send({ kind: 'key', key: 'g' });
    expect(d.state.rendered).toMatchObject({ session: 's4', g: true });
    d.send({ kind: 'root', root: '/box/x', box: 'shop-5' });
    expect(d.state.rendered).toMatchObject({ session: 's5', g: false });
    d.send({ kind: 'root', root: '/p/shop-wt/4-cart-total' });
    expect(d.state.rendered).toMatchObject({ session: 's4', g: true });
    expect(argvs(d.commands)).toEqual([
      'session list',
      'factory status',
      // (the box of the pin before, read again in this folder before it is let go)
      'box list',
      'card list --mine --closed',
      'session asks s4',
      'session transcript s4',
    ]);
  });

  test('Chats viewed all day: the ones not shown keep their place up to a bound, the oldest let go', () => {
    const many = Array.from({ length: KEPT_CHATS + 4 }, (_, i) =>
      session(`m${i}`, 'working', 40 + i),
    );
    const d = drive({ root: '/p/shop' }).send(sessionsAnswer(many), runsAnswer([]));

    for (const x of many) d.send({ kind: 'open', params: { session: x.id }, size: SIZE });
    const kept = Object.keys(d.state.kept ?? {});

    expect(kept.length).toBe(KEPT_CHATS);
    // the newest viewed kept, the first ones let go
    expect(kept).toContain(`m${many.length - 2}`);
    expect(kept).not.toContain('m0');
  });

  test('the restore param pins the last quit’s session once; one gone since gives way', () => {
    const root = '/p/shop-wt/4-cart-total';
    const d = drive({ root, restore: 's5' }).read();

    expect(pinned(d)).toBe('s5');
    // another session picked: an open naming the same restore keeps it
    d.send({ kind: 'open', params: { root, session: 's3' }, size: SIZE });
    d.send({ kind: 'open', params: { root, restore: 's5' }, size: SIZE });
    expect(pinned(d)).toBe('s3');
    const gone = drive({ root, restore: 's9' }).read();

    expect(gone.state.session).toBeUndefined();
    expect(pinned(gone)).toBe('s4');
  });

  test('an open naming a session not read yet reads the sessions and runs again', () => {
    const d = drive({ card: '4' }).read();

    d.send({ kind: 'open', params: { card: '4', session: 's9' }, size: SIZE });
    // serve.target asked once still (#208): not read yet
    expect(argvs(d.commands)).toEqual([
      'settings get serve.target',
      'session list',
      'factory status',
    ]);
    // launched from the Board: launching until it is listed
    expect(d.text()).toContain('"word":"Launching…"');
  });

  test('keeps the slot’s focus and the Editor’s caret', () => {
    const d = drive({ root: '/p/shop' }).send(
      { kind: 'focus', focused: true },
      { kind: 'caret', file: 'src/cart.ts', line: 15, selection: { from: 12, to: 18 } },
    );

    expect(d.state.focused).toBe(true);
    expect(d.state.caret).toEqual({
      file: 'src/cart.ts',
      line: 15,
      selection: { from: 12, to: 18 },
    });
  });

  test('no file open in the Editor (`no-caret`): the caret is gone', () => {
    const d = drive({ root: '/p/shop' }).send(
      { kind: 'caret', file: 'src/cart.ts', line: 15 },
      { kind: 'no-caret' },
    );

    expect(d.state.caret).toBeUndefined();
  });

  test('Esc with nothing of its own open: unhandled, so the column gives the keys back', () => {
    const d = drive({ root: '/p/shop' }).read().send({ kind: 'key', key: '<Esc>' });

    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'unhandled', slot: 'chat', key: '<Esc>' } },
    ]);
  });

  test('a Board move: the header names the card it moved to in the same frame as the body (#309)', () => {
    const header = (d: { tree: Node }) => JSON.stringify(find(d.tree, 'chat-header')?.props);
    const d = drive({ card: '4', title: 'Cart total includes shipping' }).read([], []);

    expect(header(d)).toContain('"story":{"id":"#4","title":"Cart total includes shipping"}');
    // the Board's next card, its title with it: no `card show` waited on for the header
    d.send({
      kind: 'open',
      params: { card: '8', title: 'Sign-in button overlaps the logo on narrow screens' },
      size: SIZE,
    });
    expect(d.text()).toContain('No session on #8 yet');
    expect(header(d)).toContain(
      '"story":{"id":"#8","title":"Sign-in button overlaps the logo on narrow screens"}',
    );
    // the Board named it: no `card show` per card the ring passes
    expect(argvs(d.commands)).not.toContain('card show 8');
    // the card left's `card show`, answering late, names neither the header nor whose
    d.send(chatCard(listCard(4, 'Cart total includes shipping', 'Active', 'Lee Park')));
    expect(header(d)).toContain(
      '"story":{"id":"#8","title":"Sign-in button overlaps the logo on narrow screens"}',
    );
    expect(d.state.title?.card).not.toBe(4);
    // Board ⏎ opens it again without the title: the Board's kept
    d.send({ kind: 'open', params: { card: '8' }, size: SIZE });
    expect(header(d)).toContain(
      '"story":{"id":"#8","title":"Sign-in button overlaps the logo on narrow screens"}',
    );
  });

  test('the Board’s ring on an empty column: header and body go empty together, nothing acted on (#309)', () => {
    const header = (d: { tree: Node }) => JSON.stringify(find(d.tree, 'chat-header')?.props);
    const d = drive({ card: '4', title: 'Cart total includes shipping' }).read([], []);

    d.send({ kind: 'open', params: { card: 'none' }, size: SIZE });
    expect(d.text()).not.toContain('#4');
    expect(header(d)).toBe('{"title":"Chat"}');
    expect(d.text()).toContain('No card selected');
    expect(pinOf(d.state)).toEqual({});
    // ⏎ launches nothing; no card read for it
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual([]);
    // the workspace's session is not taken in its place
    const ws = drive({ root: '/p/shop-wt/4-cart-total', card: 'none' }).read();

    expect(pinOf(ws.state)).toEqual({});
    expect(ws.text()).toContain('No card selected');
    // the ring on a card again: on it
    d.send({ kind: 'open', params: { card: '8', title: 'Sign-in button' }, size: SIZE });
    expect(header(d)).toContain('"story":{"id":"#8","title":"Sign-in button"}');
  });
});

describe('the chat screen in Terminal mode (the Factory view’s column, #155)', () => {
  /** The Terminal nodes in the tree. */
  const terminals = (tree: Node): Terminal['props'][] => {
    const out: Terminal['props'][] = [];
    const walk = (n: Node) => {
      if (n.kind === 'Terminal') out.push(n.props);
      if ('children' in n && Array.isArray(n.children)) n.children.forEach(walk);
    };

    walk(tree);

    return out;
  };
  const open = (params: Record<string, string>): Input => ({ kind: 'open', params, size: SIZE });

  test('`mode: terminal` attaches the local session under its header; back to Chat, the transcript', () => {
    const d = drive({ card: '4', mode: 'terminal' }).read();

    expect(terminals(d.tree)).toEqual([
      { key: 'attach:s4:0', argv: ['abe', 'session', 'attach', 's4'], focused: false },
    ]);
    // the header still says whose session it is
    expect(d.text()).toContain('"story":{"id":"#4","title":"Cart total includes shipping"}');
    d.send({ kind: 'focus', focused: true });
    expect(terminals(d.tree)[0]?.focused).toBe(true);
    // Chat again: the same session's transcript, no terminal, the keys in its field
    d.send(open({ card: '4' }));
    expect(terminals(d.tree)).toEqual([]);
    expect(pinned(d)).toBe('s4');
    expect(d.state.composer.active).toBe(true);
  });

  test('a cloud session attaches on its box', () => {
    const d = drive({ card: '5', mode: 'terminal' }).read();

    expect(terminals(d.tree).map((t) => t.argv)).toEqual([
      ['abe', 'box', 'attach', 'shop-5', '--session', 's5'],
    ]);
  });

  test('an attach that exited stays drawn; going in again attaches anew', () => {
    const d = drive({ card: '4', mode: 'terminal' }).read();

    d.send({ kind: 'exit', key: 'attach:s4:0', code: 0 });
    expect(terminals(d.tree).map((t) => t.key)).toEqual(['attach:s4:0']);
    d.send(open({ card: '4' }), open({ card: '4', mode: 'terminal' }));
    expect(terminals(d.tree).map((t) => t.key)).toEqual(['attach:s4:1']);
    // not exited: the same terminal when it comes back
    d.send(open({ card: '4' }), open({ card: '4', mode: 'terminal' }));
    expect(terminals(d.tree).map((t) => t.key)).toEqual(['attach:s4:1']);
  });

  test('nothing to attach: a teammate’s story, an ended session, no session', () => {
    const theirs = drive({ card: '4', whose: 'Lee Park', mode: 'terminal' }).read([], []);

    expect(terminals(theirs.tree)).toEqual([]);
    expect(theirs.text()).toContain("Lee Park's story");
    // your session on their card: yours, attached (#306)
    const yours = drive({ card: '4', whose: 'Lee Park', mode: 'terminal' }).read();

    expect(terminals(yours.tree)).toHaveLength(1);
    const ended = drive({ card: '4', session: 's3', mode: 'terminal' }).read();

    expect(terminals(ended.tree)).toEqual([]);
    expect(ended.text()).toContain('Session ended');
    const none = drive({ card: '1', mode: 'terminal' }).read();

    expect(terminals(none.tree)).toEqual([]);
    expect(none.text()).toContain('No session on #1 yet');
  });
});

describe('a prototype session opened as its own chat (the `session` param)', () => {
  const CHAT = prototypeSession('working', 4);
  const open = (params: Record<string, string>): Input => ({ kind: 'open', params, size: SIZE });

  test('pinned by its id over the card’s session, with or without a card; ⌘4 attaches it', () => {
    const d = drive({ card: '4', session: 'prototype-a1b2' }).read([...SESSIONS, CHAT]);

    expect(pinned(d)).toBe('prototype-a1b2');
    d.send(open({ card: '4', session: 'prototype-a1b2', mode: 'terminal' }));
    expect(find(d.tree, 'chat-terminal')).toMatchObject({
      props: { argv: ['abe', 'session', 'attach', 'prototype-a1b2'] },
    });
    const bare = drive({ session: 'prototype-a1b2' }).read([
      ...SESSIONS,
      prototypeSession('working', null),
    ]);

    expect(pinned(bare)).toBe('prototype-a1b2');
    expect(bare.text()).not.toContain('No card selected');
  });

  const header = (tree: Node) => {
    const h = find(tree, 'chat-header');

    return h?.kind === 'ChatHeader' ? h.props : undefined;
  };
  const listed = (p: PrototypeData): Input => ({ ...prototypeListAnswer([p]), id: 'prototypes' });

  test('its header: Prototype · #4 <title>, then the preview’s address once live, where it runs, the state', () => {
    const d = drive({
      card: '4',
      session: 'prototype-a1b2',
      title: 'Show VAT under the cart total',
    })
      .read([...SESSIONS, CHAT])
      .send({ kind: 'tick', at: '2026-10-01T09:13:00.000Z' });

    expect(header(d.tree)).toMatchObject({
      story: { id: 'Prototype', title: '· #4 Show VAT under the cart total' },
      hint: '⌘⏎',
      rail: { segments: [], stage: 'Local', glyph: '●', elapsed: '12 min' },
    });
    expect(header(d.tree)?.address).toBeUndefined();
    d.send(listed(prototype('live', { card: 4 })));
    expect(header(d.tree)).toMatchObject({
      address: { id: 'chat:prototype-page', text: '127.0.0.1:50321' },
      rail: { stage: 'Local' },
    });
    // its app stopped: read again, said on line 2
    d.send(eventInput({ type: 'command.ran', data: { noun: 'prototype', verb: 'stop', exit: 0 } }));
    expect(argvs(d.commands)).toEqual(['prototype list']);
    d.send(listed(prototype('stopped', { card: 4 })));
    expect(header(d.tree)?.rail?.stage).toBe('Local · app stopped');
    // no card: `Prototype` alone
    const bare = drive({ session: 'prototype-a1b2' }).read([
      ...SESSIONS,
      prototypeSession('working', null),
    ]);

    expect(header(bare.tree)?.story).toEqual({ id: 'Prototype', title: '' });
  });

  test('its own reads move nothing (serve says command.ran for them too)', () => {
    const d = drive({ card: '4', session: 'prototype-a1b2' })
      .read([...SESSIONS, CHAT])
      .send(listed(prototype('live', { card: 4 })));

    for (const verb of ['list', 'show'])
      d.send(eventInput({ type: 'command.ran', data: { noun: 'prototype', verb, exit: 0 } }));
    expect(argvs(d.commands)).toEqual([]);
  });

  test('the address clicked opens its preview in the browser', () => {
    const d = drive({ card: '4', session: 'prototype-a1b2' })
      .read([...SESSIONS, CHAT])
      .send(listed(prototype('live', { card: 4 })))
      .send({ kind: 'click', id: 'chat:prototype-page' });

    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-url', url: prototype('live').url ?? '' } },
    ]);
  });

  test('ended: ⏎ Reopen, the same conversation reopened (session reopen, #343)', () => {
    const d = drive({ card: '4', session: 'prototype-a1b2' }).read([
      ...SESSIONS,
      prototypeSession('ended', 4),
    ]);

    expect(d.text()).toContain('"note":"· ⏎ Reopen · ⌘⏎ more"');
    d.send({ kind: 'key', key: '<CR>' });
    expect(d.commands).toEqual([
      { kind: 'run', id: 'chat:reopen', argv: ['session', 'reopen', 'prototype-a1b2'] },
    ]);
    // a second ⏎ while it is out asks nothing more
    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual([]);
    // reopened: the sessions read again (the same session, Chat stays on it)
    d.send({
      kind: 'result',
      id: 'chat:reopen',
      command: 'session reopen',
      reply: { ok: true, data: prototypeSession('starting', 4) },
    });
    expect(argvs(d.commands)).toContain('session list');
    expect(pinOf(d.state).session?.id).toBe('prototype-a1b2');
    // its claude never started (no transcript, #355): ⏎ Reopen all the same (serve starts a new
    // claude there); a reopen refused says why in a balloon
    const never = drive({ card: '4', session: 'prototype-a1b2' })
      .read([...SESSIONS, { ...prototypeSession('ended', 4), transcriptPath: null }])
      .send({ kind: 'focus', focused: true });

    expect(never.text()).toContain('"note":"· ⏎ Reopen · ⌘⏎ more"');
    never.send({ kind: 'key', key: '<CR>' });
    expect(argvs(never.commands)).toEqual(['session reopen prototype-a1b2']);
    never.send({
      kind: 'result',
      id: 'chat:reopen',
      command: 'session reopen',
      reply: {
        ok: false,
        error: {
          code: 'not-found',
          message: 'prototype proto-1 is gone: abe prototype chat starts a new one',
        },
      },
    });
    expect(never.commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'balloon',
          tone: 'error',
          text: 'prototype proto-1 is gone: abe prototype chat starts a new one (not-found)',
        },
      },
    ]);
  });
});

describe('Chat’s session for the Editor’s Terminal mode (#340)', () => {
  /** The sessions each `chat-session` effect named, in order. */
  const told = (commands: readonly Command[]) =>
    commands.flatMap((c) =>
      c.kind === 'shell' && c.effect.kind === 'chat-session' ? [c.effect.session] : [],
    );
  const open = (params: Record<string, string>): Input => ({ kind: 'open', params, size: SIZE });

  test('says the session Chat is pinned to once read, on every open and when it changes', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' });

    // nothing read yet: nothing said (the shell keeps what it has)
    expect(told(d.commands)).toEqual([]);
    d.send(sessionsAnswer(SESSIONS));
    expect(told(d.commands)).toEqual(['s4']);
    // the same pin: quiet, until the next open says it again
    d.send(runsAnswer(RUNS));
    expect(told(d.commands)).toEqual([]);
    d.send(open({ root: '/p/shop-wt/4-cart-total', mode: 'terminal' }));
    expect(told(d.commands)).toEqual(['s4']);
    // a cloud workspace's session on its box
    d.send(open({ root: '/box/repo', box: 'shop-5' }));
    expect(told(d.commands)).toEqual(['s5']);
  });

  test('none for no session or an ended one; a Retry’s new session at once', () => {
    const said = (params: Record<string, string>, sessions = SESSIONS) =>
      told(drive(params).send(sessionsAnswer(sessions)).commands);

    expect(said({ card: '1' })).toEqual([null]);
    expect(said({ card: '4', session: 's3' })).toEqual([null]);
    const old = { ...session('o1', 'ended', 7), stopped: true };

    expect(said({ root: '/p/shop', card: '7', session: 'o1' }, [old])).toEqual([null]);
    const d = drive({ root: '/p/shop', card: '7', session: 'o1' }).read([old], []);
    const fresh = { ...session('n1', 'starting', 7), startedAt: '2026-10-01T09:20:00.000Z' };

    d.send(sessionsAnswer([fresh, old]));
    expect(told(d.commands)).toEqual(['n1']);
  });
});

test.each<[string | undefined, number | undefined]>([
  ['card/1-show-stock', 1],
  ['card/1234', 1234],
  ['card/12x', undefined],
  ['main', undefined],
  [undefined, undefined],
])('the card of branch %s is %s', (branch, card) => {
  expect(cardOfBranch(branch)).toBe(card);
});

/** The pinning rule (#105 S1): the session it pins for a workspace, a card, a chosen session. */
describe('pinOf', () => {
  const at = (id: string, card: number, state: SessionData['state'], day: number, o = {}) => ({
    ...session(id, state, card),
    startedAt: `2026-10-${String(day).padStart(2, '0')}T09:00:00.000Z`,
    ...o,
  });
  const STORY = [
    at('old', 2, 'ended', 1, { worktree: '/w/2' }),
    at('live', 2, 'working', 3, { worktree: '/w/2' }),
    at('newer-ended', 2, 'ended', 5, { worktree: '/w/2' }),
    at('box', 2, 'waiting', 4, { worktree: '/workspace/repo', box: 'shop-2' }),
    at('ended-only', 3, 'ended', 2, { worktree: '/w/3' }),
    at('ended-newest', 3, 'ended', 6, { worktree: '/w/3' }),
  ];
  const base: PinnedState = { ...pinnedScreen.init, sessions: STORY, runs: [] };

  test.each<[string, Partial<PinnedState>, string | undefined, number | undefined]>([
    ['the story’s newest not ended, from its worktree', { root: '/w/2' }, 'box', 2],
    ['the same story from its box', { root: '/p/shop', box: 'shop-2' }, 'box', 2],
    ['the newest ended when all ended', { root: '/w/3' }, 'ended-newest', 3],
    ['the card param', { root: '/p/shop', card: 3 }, 'ended-newest', 3],
    ['a chosen session holds', { root: '/w/2', session: 'old' }, 'old', 2],
    ['the branch’s card, no session yet', { root: '/w/9', branch: 'card/9-x' }, undefined, 9],
    ['the main checkout: no story', { root: '/p/shop', branch: 'main' }, undefined, undefined],
  ])('%s', (_, over, id, card) => {
    const pin = pinOf({ ...base, ...over });

    expect(pin.session?.id).toBe(id);
    expect(pin.card).toBe(card);
  });
});

describe('a run ended as Abandoned in place (#230)', () => {
  const abandoned = (withEnd: boolean): Input =>
    eventInput(
      {
        type: 'factory.stage',
        data: {
          card: 4,
          session: 's4',
          stage: 'done',
          from: 'build',
          state: 'done',
          reason: null,
          since: '2026-10-01T09:30:00.000Z',
          cause: 'end',
          outcome: 'abandoned',
          ...(withEnd
            ? {
                ended: {
                  as: 'abandoned' as const,
                  reason: 'not needed',
                  at: '2026-10-01T09:30:00.000Z',
                  from: 'build' as const,
                },
              }
            : {}),
        },
      },
      '2026-10-01T09:30:00.000Z',
    );

  test('the header stays on the stage it was given up in, dim ○ Abandoned, never Done', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read().send(abandoned(true));

    expect(argvs(d.commands)).toEqual([]);
    expect(d.text()).toContain('"segments":["done","wait","todo","todo","todo"],"stage":"Build"');
    expect(d.text()).toContain('"glyph":"○","word":"Abandoned"');
  });

  test('an older box’s event with no `ended`: the runs read again', () => {
    const d = drive({ root: '/p/shop-wt/4-cart-total' }).read().send(abandoned(false));

    expect(argvs(d.commands)).toEqual(['factory status 4']);
  });
});

describe('a card’s session is its repo’s (#256)', () => {
  const OTHER = 'mkdir-swe/qa2-e-85a7';
  const theirs: SessionData = {
    ...session('q101', 'waiting', 101),
    repo: OTHER,
    worktree: '/workspace/repo',
    box: 'qa2-e-85a7-101',
  };
  const theirRun = factoryRun(101, 'Another repo’s #101', 'build', 'needs-you', {
    session: 'q101',
    repo: OTHER,
  });

  test('the Factory view’s card never pins another repo’s session on the same card number', () => {
    const d = drive({ root: '/p/demo-shop', card: '101' }).send(
      sessionsAnswer([...SESSIONS, theirs], DEMO_HERE),
      runsAnswer([...RUNS, theirRun], 'runs', DEMO_HERE),
    );

    expect(pinOf(d.state)).toEqual({ card: 101 });
    expect(d.text()).toContain('No session on #101 yet');
    expect(d.text()).not.toContain('qa2-e-85a7-101');
  });

  test('this repo’s session on the card still pins, local or on its box', () => {
    const ours: SessionData = {
      ...session('d101', 'waiting', 101),
      worktree: '/workspace/repo',
      box: 'demo-shop-101',
    };
    const d = drive({ root: '/p/demo-shop', card: '101' }).send(
      sessionsAnswer([...SESSIONS, theirs, ours], DEMO_HERE),
      runsAnswer(RUNS, 'runs', DEMO_HERE),
    );

    expect(pinOf(d.state).session?.id).toBe('d101');
  });
});

describe('another project shown: the repo is read again (#256)', () => {
  test('the old repo is dropped and the lists read in the new folder', () => {
    const d = drive({ root: '/p/demo-shop', card: '101' }).send(
      sessionsAnswer(SESSIONS, DEMO_HERE),
      runsAnswer(RUNS, 'runs', DEMO_HERE),
    );

    expect(d.state.here).toEqual(DEMO_HERE);
    d.send({ kind: 'root', root: '/p/qa2-e-85a7' });
    expect(d.state.here).toBeUndefined();
    expect(argvs(d.commands)).toContain('session list');
    expect(argvs(d.commands)).toContain('factory status');
  });
});

describe('the workspace jump on a box: Waking until the box is known to run (#339)', () => {
  const BOX3 = 'demo-shop-3';
  const T0 = '2026-10-25T13:50:00.000Z';
  const building = {
    step: 'base-image' as const,
    since: T0,
    startedAt: T0,
    box: BOX3,
    how: 'new' as const,
    detail: 'step 14/27',
    told: true,
    done: [],
  };
  const on3 = (state: SessionData['state'], launch: SessionData['launch'] = null): SessionData => ({
    ...session('3-6025', state, 3),
    worktree: '/workspace/repo',
    box: BOX3,
    launch,
  });
  const landed = () =>
    drive({ root: '/workspace/repo', box: BOX3, session: '3-6025', waking: BOX3 });

  test('its session building the workspace on the box: never Waking, its launch said instead', () => {
    const d = landed()
      .read([on3('starting', building)], [])
      .send({ kind: 'tick', at: '2026-10-25T13:50:20.000Z' });

    expect(d.text()).not.toContain('Waking demo-shop-3');
    expect(d.text()).not.toContain('Chat attaches once it runs');
    expect(d.text()).toContain('Building the workspace image');
  });

  test('asleep, then its session works: Chat follows the session, no box.state needed', () => {
    const d = landed().read([on3('ended')], []);

    expect(d.text()).toContain('Waking demo-shop-3…');
    d.send(
      eventInput({
        type: 'session.state',
        data: { id: '3-6025', card: 3, state: 'working', since: T0, cause: 'UserPromptSubmit' },
      }),
    );
    expect(d.text()).not.toContain('Waking demo-shop-3');
    expect(d.state.waking).toBeUndefined();
  });

  test('the workspace jump again with its session read working already: no Waking at all', () => {
    const d = drive({ root: '/workspace/repo', box: BOX3 }).read([on3('working')], []);

    d.send({
      kind: 'open',
      params: { root: '/workspace/repo', box: BOX3, session: '3-6025', waking: BOX3 },
      size: SIZE,
    });
    expect(d.text()).not.toContain('Waking demo-shop-3');
    expect(d.state.waking).toBeUndefined();
  });

  // the Editor's attach woke it straight on EC2 (#18): serve said nothing, so Chat asks serve itself
  test.each([
    ['answered running, no box.state', true, undefined],
    ['refused', false, 'Waking demo-shop-3 failed'],
  ])('its session ended: Chat starts the box itself, %s', (_, ok, says) => {
    const d = landed();

    expect(argvs(d.commands)).toContain(`box start ${BOX3}`);
    d.read([on3('ended')], []);
    d.send({
      kind: 'result',
      id: `waking:${BOX3}`,
      command: 'box start',
      reply: ok
        ? {
            ok: true,
            data: {
              name: BOX3,
              state: 'running',
              size: null,
              launchedAt: null,
              release: null,
              repo: null,
              card: null,
              title: null,
              costToday: null,
              serve: 'answers',
              workspace: null,
            },
          }
        : { ok: false, error: { code: 'aws-refused', message: 'not allowed' } },
    });
    if (says === undefined) {
      expect(d.text()).not.toContain('Waking demo-shop-3');
      expect(d.state.waking).toBeUndefined();
    } else {
      expect(d.text()).toContain(says);
      expect(d.text()).toContain('not allowed');
    }
  });

  test('a box.step booting while Waking (#213 B4): the box is booting, as the Boxes tab says it', () => {
    const d = landed().read([on3('ended')], []);

    expect(d.text()).toContain('the box is asleep; Chat attaches once it runs');
    d.send(
      eventInput({ type: 'box.state', data: { box: BOX3, state: 'starting', cause: 'wake' } }),
    );
    expect(d.text()).toContain('the box is starting; Chat attaches once it runs');
    // another box's step, or a later step: nothing
    d.send(eventInput({ type: 'box.step', data: { box: 'demo-shop-9', step: 'booting' } }));
    expect(d.text()).toContain('the box is starting;');
    d.send(eventInput({ type: 'box.step', data: { box: BOX3, step: 'booting' } }));
    expect(d.text()).toContain('Waking demo-shop-3…');
    expect(d.text()).toContain('the box is booting; Chat attaches once it runs');
    d.send(eventInput({ type: 'box.state', data: { box: BOX3, state: 'running', cause: 'wake' } }));
    expect(d.text()).not.toContain('Waking demo-shop-3');
  });

  test('still booting the box: Waking stays until it runs', () => {
    const booting = { ...building, step: 'box-booting' as const, detail: null };
    const d = landed().read([on3('starting', booting)], []);

    expect(d.text()).toContain('Waking demo-shop-3…');
    d.send(
      eventInput({
        type: 'session.step',
        data: { id: '3-6025', card: 3, launch: { ...building, done: [] } },
      }),
    );
    expect(d.text()).not.toContain('Waking demo-shop-3');
  });
});

describe('the Abe chat, and the install in it', () => {
  const part = (
    id: InstallView['parts'][number]['id'],
    state: InstallView['parts'][number]['state'],
    line: string | null,
    required = true,
  ) => ({ id, required, state, line, checkedAt: line === null ? null : AT });
  const VIEW: InstallView = {
    repo: '/p/shop',
    join: true,
    session: { id: 'abe-i1a2', state: 'waiting' },
    parts: [
      part('logins', 'pass', 'gh and aws answer'),
      part('board', 'warn', 'abe.yaml names no board that reads'),
      part('sources', 'todo', null, false),
      part('env-files', 'fail', '.abe/abe.test.env is missing'),
    ],
    done: false,
    files: ['abe.yaml', '.abe/abe.dev.env'],
  };
  const HUB: SessionData = {
    ...session('abe-i1a2', 'waiting'),
    card: null,
    kind: 'abe',
    title: 'Abe · shop',
    repo: '/p/shop',
    worktree: '/p/shop',
    branch: '',
    abe: { repo: '/p/shop' },
  };
  const parts = (d: { tree: Node }) => find(d.tree, 'install-parts');
  /** `abe chat`'s answer: `id` running. */
  const hubAnswer = (id: string): Input => ({
    kind: 'result',
    id: 'chat:hub',
    command: 'chat',
    reply: {
      ok: true,
      data: { repo: '/p/shop', id, title: HUB.title, state: 'working', opened: 'running' },
    },
  });

  test('the main checkout with no story: the Abe chat pinned; none yet, ⏎ starts it (abe chat)', () => {
    const none = drive({ root: '/p/shop' }).read([], []);

    expect(none.text()).toContain('Start the Abe chat');
    none.send({ kind: 'key', key: '<CR>' });
    expect(argvs(none.commands)).toEqual(['chat --repo /p/shop']);
    none.send({
      kind: 'result',
      id: 'chat:hub',
      command: 'chat',
      reply: {
        ok: true,
        data: { repo: '/p/shop', id: HUB.id, title: HUB.title, state: 'starting', opened: 'new' },
      },
    });
    expect(none.state.session).toBe(HUB.id);
    const d = drive({ root: '/p/shop' }).send(sessionsAnswer([HUB]));

    // the install's status read for it: a repo with no install answers none, so no panel
    expect(argvs(d.commands)).toContain('install status');
    d.send(runsAnswer([]));
    expect(pinned(d)).toBe(HUB.id);
    expect(d.text()).toContain('Local · no sandbox');
    expect(parts(d)).toBeUndefined();
  });

  test('its conversations are tabs: + a new one, a click pins one, × closes one, Recent conversations… reopens', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 9, m)).toISOString();
    // idle at your turn: no mark (a question would be ◆)
    const one = {
      ...HUB,
      waitingOn: 'turn' as const,
      startedAt: at(1),
      abe: { repo: '/p/shop', name: 'Abe 1' },
    };
    const two = {
      ...HUB,
      id: 'abe-b2c3',
      state: 'working' as const,
      startedAt: at(2),
      abe: { repo: '/p/shop', name: 'why the cart rounds' },
    };
    const old = {
      ...HUB,
      id: 'abe-0ld0',
      state: 'ended' as const,
      since: at(0),
      abe: { repo: '/p/shop', name: 'tax' },
    };
    const d = drive({ root: '/p/shop', session: one.id }).read([old, two, one], []);
    const header = () => {
      const [h] =
        d.tree.kind === 'Island' && d.tree.children[0]?.kind === 'Stack'
          ? d.tree.children[0].children
          : [];

      return h?.kind === 'ChatHeader' ? h.props : undefined;
    };

    // the open ones, oldest first; the working one dotted
    expect(header()?.tabs).toEqual([
      { id: 'chat:tab:abe-i1a2', label: 'Abe 1', selected: true, close: 'chat:tab-close:abe-i1a2' },
      {
        id: 'chat:tab:abe-b2c3',
        label: 'why the cart rounds',
        mark: 'working',
        close: 'chat:tab-close:abe-b2c3',
      },
    ]);
    d.send({ kind: 'key', key: '/' });
    expect(d.state.rendered?.find?.typing).toBe(true);
    d.send({ kind: 'click', id: 'chat:tab:abe-b2c3' });
    expect(d.state.session).toBe('abe-b2c3');
    expect(d.state.rendered?.find).toBeUndefined();
    d.send({ kind: 'click', id: 'chat:tab-new' });
    expect(argvs(d.commands)).toEqual(['chat --new --repo /p/shop']);
    // × on the one shown: stopped, never asked, its neighbour shown
    d.send({ kind: 'click', id: 'chat:tab-close:abe-b2c3' });
    expect(argvs(d.commands)).toContain('session stop abe-b2c3');
    expect(d.state.session).toBe(one.id);
    d.send({ kind: 'choice', menu: 'chat:session', row: 'recent', values: [old.id] });
    expect(argvs(d.commands)).toContain('session reopen abe-0ld0');
    expect(d.state.session).toBe(old.id);
  });

  test('the tab shown is kept by the repo: back from another workspace or ⌘§, not the newest', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 9, m)).toISOString();
    const one = { ...HUB, startedAt: at(1), abe: { repo: '/p/shop', name: 'Abe 1' } };
    const two = {
      ...HUB,
      id: 'abe-b2c3',
      startedAt: at(2),
      abe: { repo: '/p/shop', name: 'Abe 2' },
    };
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/p/shop' }).read([one, two, card], []);

    // none shown yet: the newest
    expect(pinned(d)).toBe(two.id);
    d.send({ kind: 'click', id: `chat:tab:${one.id}` });
    expect(pinned(d)).toBe(one.id);
    // round the workspaces and back
    d.send({ kind: 'root', root: '/wt/s4' }, { kind: 'root', root: '/p/shop' });
    expect(pinned(d)).toBe(one.id);
    // ⌘§ from a card's chat
    d.send({ kind: 'root', root: '/wt/s4' }, { kind: 'key', key: '<D-§>' });
    expect(d.state.session).toBe(one.id);
    // closed (ended): the newest open one again
    d.send(sessionsAnswer([{ ...one, state: 'ended' }, two, card]));
    d.send({ kind: 'root', root: '/wt/s4' }, { kind: 'root', root: '/p/shop' });
    expect(pinned(d)).toBe(two.id);
  });

  test('a tab shown is marked in serve; after a restart on a card, ⌘§ goes by the mark (F6)', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 9, m)).toISOString();
    const one = { ...HUB, startedAt: at(1), abe: { repo: '/p/shop', name: 'Abe 1' } };
    const two = {
      ...HUB,
      id: 'abe-b2c3',
      startedAt: at(2),
      abe: { repo: '/p/shop', name: 'Abe 2' },
    };
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/wt/s4', restore: card.id }).read([one, two, card], []);

    expect(pinned(d)).toBe(card.id);
    // ⌘§: none shown since the start, so not the newest: abe chat answers serve's mark
    d.send({ kind: 'key', key: '<D-§>' });
    expect(argvs(d.commands)).toEqual(['chat --repo /p/shop']);
    d.send(hubAnswer(one.id));
    expect(d.state.session).toBe(one.id);
    expect(argvs(d.commands)).toContain(`chat --shown ${one.id} --repo /p/shop`);
    // another tab shown: marked; shown again, not marked twice
    d.send({ kind: 'click', id: `${HUB_TAB}${two.id}` });
    expect(argvs(d.commands)).toContain(`chat --shown ${two.id} --repo /p/shop`);
    d.send({ kind: 'tick', at: at(3) });
    expect(argvs(d.commands).filter((a) => a.startsWith('chat --shown'))).toEqual([]);
    // the main checkout's newest by default, no tab chosen: not marked
    const main = drive({ root: '/p/shop' });

    main.send(sessionsAnswer([one, two]));
    expect(pinned(main)).toBe(two.id);
    expect(argvs(main.commands).filter((a) => a.startsWith('chat --shown'))).toEqual([]);
  });

  test(':chat after a restart: serve’s shown tab, not the newest the main checkout shows by default (F6)', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 9, m)).toISOString();
    const one = { ...HUB, startedAt: at(1), abe: { repo: '/p/shop', name: 'Abe 1' } };
    const two = {
      ...HUB,
      id: 'abe-b2c3',
      startedAt: at(2),
      abe: { repo: '/p/shop', name: 'Abe 2' },
    };
    const d = drive({ root: '/p/shop' }).read([one, two], []);

    expect(pinned(d)).toBe(two.id);
    d.send({ kind: 'open', params: { root: '/p/shop', hub: '1' }, size: SIZE });
    expect(argvs(d.commands)).toContain('chat --repo /p/shop');
    d.send(hubAnswer(one.id));
    expect(d.state.session).toBe(one.id);
  });

  test('after a restart the last quit’s tab is the one kept: ⌘§ and :chat go back to it (F6)', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 9, m)).toISOString();
    const one = { ...HUB, startedAt: at(1), abe: { repo: '/p/shop', name: 'Abe 1' } };
    const two = {
      ...HUB,
      id: 'abe-b2c3',
      startedAt: at(2),
      abe: { repo: '/p/shop', name: 'Abe 2' },
    };
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/p/shop', restore: one.id }).read([one, two, card], []);

    expect(pinned(d)).toBe(one.id);
    // a card's chat, then ⌘§: the kept tab, not the newest
    d.send({ kind: 'open', params: { root: '/wt/s4', session: card.id }, size: SIZE });
    d.send({ kind: 'key', key: '<D-§>' });
    expect(d.state.session).toBe(one.id);
    // `:chat`: abe chat answers its running newest; the kept tab is pinned
    d.send({ kind: 'open', params: { root: '/p/shop', hub: '1' }, size: SIZE });
    d.send({
      kind: 'result',
      id: 'chat:hub',
      command: 'chat',
      reply: {
        ok: true,
        data: {
          repo: '/p/shop',
          id: two.id,
          title: HUB.title,
          state: 'working',
          opened: 'running',
        },
      },
    });
    expect(d.state.session).toBe(one.id);
  });

  test('a prototype’s tile left for the workspace in the same folder: that workspace’s chat, never the prototype’s', () => {
    const proto = prototypeSession('working', null);
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const open = (params: Record<string, string>): Input => ({ kind: 'open', params, size: SIZE });

    // Abe, its prototype's tile (the bridge names the shown folder), Abe again (⌘↓ round)
    const d = drive({ root: '/p/shop' }).read([HUB, proto, card], []);

    expect(pinned(d)).toBe(HUB.id);
    d.send(open({ session: proto.id, root: '/p/shop' }));
    expect(pinned(d)).toBe(proto.id);
    d.send(open({ root: '/p/shop' }));
    expect(pinOf(d.state).session?.id).toBe(HUB.id);
    expect(pinned(d)).toBe(HUB.id);
    // a card's workspace shown under the prototype's tile: its own chat again
    const w = drive({ root: '/wt/s4' }).read([HUB, proto, card], []);

    w.send(open({ session: proto.id, root: '/wt/s4' }), open({ root: '/wt/s4' }));
    expect(pinOf(w.state).session?.id).toBe(card.id);
    // the last quit's session is a prototype's (Chat left on it there): the workspace's own
    const r = drive({ root: '/p/shop', restore: proto.id }).read([HUB, proto, card], []);

    expect(pinOf(r.state).session?.id).toBe(HUB.id);
  });

  test('`abe chat` answered after another workspace is shown pins nothing there', () => {
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/p/shop' }).read([card], []);

    d.send({ kind: 'key', key: '<CR>' });
    expect(argvs(d.commands)).toEqual(['chat --repo /p/shop']);
    d.send({ kind: 'open', params: { root: '/wt/s4' }, size: SIZE }, hubAnswer(HUB.id));
    expect(d.state.session).toBeUndefined();
    expect(pinOf(d.state).session?.id).toBe(card.id);
  });

  test('⌘§ pins the repo’s Abe chat, ⌘§ again goes back; none open, abe chat opens one', () => {
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/wt/s4', session: card.id }).read([card, HUB], []);

    // a find bar open closes as another chat shows, and stays closed coming back
    d.send({ kind: 'key', key: '<D-f>' }, { kind: 'key', key: 'x' });
    expect(d.state.rendered?.find?.text).toBe('x');
    d.send({ kind: 'key', key: '<D-§>' });
    // no tab shown since the start: abe chat names it (serve's mark)
    expect(argvs(d.commands)).toEqual(['chat --repo /p/shop']);
    d.send(hubAnswer(HUB.id));
    expect(d.state.session).toBe(HUB.id);
    expect(d.state.rendered?.find).toBeUndefined();
    d.send({ kind: 'key', key: '<D-§>' });
    expect(d.state.session).toBe(card.id);
    expect(d.state.rendered?.find).toBeUndefined();
    expect(pinnedScreen.typing?.(d.state)).toBe(false);
    const none = drive({ root: '/wt/s4', session: card.id }).read([card], []);

    none.send({ kind: 'key', key: '<D-§>' });
    expect(argvs(none.commands)).toEqual(['chat --repo /p/shop']);
  });

  test('the Board selecting no card leaves the Abe chat pinned; a card selected moves Chat (M1)', () => {
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/p/shop', session: HUB.id }).read([card, HUB], []);

    expect(pinOf(d.state).session?.id).toBe(HUB.id);
    // the install wrote its board: the Board's first selection, none
    d.send({ kind: 'open', params: { card: 'none' }, size: SIZE });
    expect(pinOf(d.state).session?.id).toBe(HUB.id);
    expect(d.commands).toContainEqual({
      kind: 'open',
      screen: 'chat',
      params: { session: HUB.id },
      slot: 'chat',
      ifOpen: true,
    });
    d.send({ kind: 'open', params: { card: '4' }, size: SIZE });
    expect(pinOf(d.state).session?.id).toBe(card.id);
    // on a card, none selected: Chat on nothing (#309)
    d.send({ kind: 'open', params: { card: 'none' }, size: SIZE });
    expect(pinOf(d.state)).toEqual({});
  });

  test('the Board’s click on its selected card shows the card’s Chat, off the Abe chat (M5)', () => {
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/p/shop', card: '4' }).read([card, HUB], []);

    d.send({ kind: 'key', key: '<D-§>' }, hubAnswer(HUB.id));
    expect(pinOf(d.state).session?.id).toBe(HUB.id);
    // the app's open again on the same card (Terminal mode toggled): the Abe chat stays
    d.send({ kind: 'open', params: { card: '4', mode: 'terminal' }, size: SIZE });
    expect(pinOf(d.state).session?.id).toBe(HUB.id);
    d.send({ kind: 'open', params: { card: '4', picked: '1' }, size: SIZE });
    expect(pinOf(d.state).session?.id).toBe(card.id);
  });

  test('⌘§ back from the Abe chat to the Board’s card Chat followed', () => {
    const card = { ...session('s4', 'working', 4), repo: '/p/shop', worktree: '/wt/s4' };
    const d = drive({ root: '/p/shop', card: '4' }).read([card, HUB], []);

    expect(pinOf(d.state).session?.id).toBe(card.id);
    d.send({ kind: 'key', key: '<D-§>' });
    // the bridge's open of the Abe chat names only its session
    d.send({ kind: 'open', params: { root: '/p/shop', session: HUB.id }, size: SIZE });
    expect(pinOf(d.state).session?.id).toBe(HUB.id);
    d.send({ kind: 'key', key: '<D-§>' });
    expect(pinOf(d.state).session?.id).toBe(card.id);
    expect(d.commands).toContainEqual({
      kind: 'open',
      screen: 'chat',
      params: { card: '4' },
      slot: 'chat',
      ifOpen: true,
    });
  });

  test('the strip shows under the Abe chat’s header; Done, only in the conversation it was Done in', () => {
    const d = drive({ root: '/p/shop' }).read([HUB], []);

    d.send({
      kind: 'result',
      id: 'chat:install-status',
      command: 'install status',
      reply: { ok: true, data: VIEW },
    });
    const column = d.tree.kind === 'Island' ? d.tree.children[0] : undefined;

    expect(column?.kind === 'Stack' && column.children.map((c) => c.kind).slice(0, 2)).toEqual([
      'ChatHeader',
      'InstallParts',
    ]);
    const done = (at: string) => ({
      ...VIEW,
      parts: [...VIEW.parts, part('done', 'pass', 'Every part passes')].map((p) =>
        p.id === 'done' ? { ...p, checkedAt: at } : p,
      ),
      done: true,
    });

    d.send(eventInput({ type: 'install.changed', data: done(HUB.startedAt) }));
    const strip = parts(d);

    if (strip?.kind !== 'InstallParts') throw new Error('no strip');
    expect([strip.props.state.text, strip.props.parts, strip.props.files?.text]).toEqual([
      '✓ Done',
      [],
      'Files 2',
    ]);
    // Done before this conversation began: nothing atop it
    d.send(eventInput({ type: 'install.changed', data: done('2020-01-01T00:00:00.000Z') }));
    expect(parts(d)).toBeUndefined();
  });

  test('`:install` asks abe install, pins Chat on the Abe chat, and draws each part with what its buttons say', () => {
    const d = drive({ root: '/p/shop', install: '1' });

    expect(argvs(d.commands)).toContain('install');
    d.send({
      kind: 'result',
      id: 'chat:install',
      command: 'install',
      reply: { ok: true, data: VIEW },
    }).read([HUB], []);
    const strip = () => {
      const s = parts(d);

      if (s?.kind !== 'InstallParts') throw new Error('no strip');

      return s.props;
    };

    expect(strip().join?.text).toBe('Join');
    expect(strip().state.text).toBe('2 of 4');
    expect(strip().parts.map((p) => `${p.glyph} ${p.name}`)).toEqual([
      '✓ Logins',
      '! Board',
      '○ Sources',
      '✗ Env files',
    ]);
    // a part clicked unfolds its last check; again, folds it
    d.send({ kind: 'click', id: 'install:part:sources' });
    expect(strip().unfolded).toMatchObject({
      kind: 'part',
      name: 'Sources',
      tag: 'optional',
      line: 'Not checked yet',
    });
    d.send({ kind: 'click', id: 'install:part:sources' });
    expect(strip().unfolded).toBeUndefined();
    // the files unfolded, each opened in the Editor
    d.send({ kind: 'click', id: 'install:files' });
    const files = strip().unfolded;

    expect(files?.kind === 'files' && files.files.map((f) => f.label)).toEqual([
      'abe.yaml',
      '.abe/abe.dev.env',
    ]);
    d.send({ kind: 'click', id: 'install:file:1' });
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-file', path: '/p/shop/.abe/abe.dev.env' } },
    ]);
    d.send({ kind: 'click', id: 'install:recheck:env-files' });
    expect(argvs(d.commands)).toEqual(['session send abe-i1a2 Re-check Env files']);
    d.send({ kind: 'click', id: 'install:again:board' });
    expect(argvs(d.commands)).toEqual(['session send abe-i1a2 Do Board again']);
    // its turn ended: the parts read again
    d.send(
      eventInput({
        type: 'session.state',
        data: { id: 'abe-i1a2', card: null, state: 'waiting', since: AT, cause: 'stop' },
      }),
    );
    expect(argvs(d.commands)).toContain('install status');
  });
});
