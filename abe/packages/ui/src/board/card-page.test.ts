/**
 * The Card page (`card`) as the bridge drives it, Command mode over it: opened on a card, its
 * reads answered from the Board's sample sprint (card 4 is yours, its session running on a box).
 * What it draws, Esc, Tab's round and the comment composer's post.
 */
import { describe, expect, test } from 'bun:test';
import type { CardComment, CardData } from '@abe/core';
import {
  type Answer,
  BOARD_MINE,
  cardSheet,
  chatOpened,
  eventInput,
  factoryRun,
  BOARD_RUNS,
  BOARD_SESSIONS,
  type Command,
  driveScreen,
  type Input,
  listCard,
  minutes,
  type Refused,
  type Replies,
  repliesBy,
  runsAnswer,
  session,
  sessionsAnswer,
  settingAnswer,
} from '@abe/testing';
import { cardScreen } from './index';

const FOUR = BOARD_MINE[0] ?? listCard(4, '', '');
const SIX = BOARD_MINE[2] ?? listCard(6, '', '');

const COMMENTS: CardComment[] = [
  { id: 1, by: 'Sam Sample', at: '2026-10-01T09:02:00.000Z', text: 'Seen on mobile too.' },
];

const shown = (card: CardData, comments: CardComment[] = COMMENTS): Answer => ({
  kind: 'result',
  id: '',
  command: 'card show',
  reply: { ok: true, data: { ...card, comments, sheets: [] } },
});

const MEMBERS: Answer = {
  kind: 'result',
  id: '',
  command: 'card members',
  reply: {
    ok: true,
    data: {
      members: [
        { name: 'Alex Example', email: 'alex@example.test', you: true },
        { name: 'Sam Sample', email: 'sam@example.test', you: false },
      ],
    },
  },
};

/** The page's reads answered: the card shown by its number, the sprint's runs and sessions. */
const REPLIES: Replies = repliesBy({
  'card show': ({ argv }) => shown(argv[2] === '6' ? SIX : FOUR),
  'session list': sessionsAnswer(BOARD_SESSIONS),
  'factory status': runsAnswer(BOARD_RUNS),
  'card members': MEMBERS,
  'settings get': settingAnswer('target', 'serve.target', 'cloud'),
});

const page = (params: Readonly<Record<string, string>> = { card: '4', from: 'board' }) =>
  driveScreen(cardScreen, { params, now: minutes(6), focused: true, replies: REPLIES }).answer();

type Page = ReturnType<typeof page>;

const props = (d: Page) => {
  const t = d.tree;

  if (t.kind !== 'CardPage') throw new Error(`no Card page: ${t.kind}`);

  return t.props;
};

const reads = (d: Page): string[] => d.asked.map((a) => a.argv.join(' '));

const posted = (card: number, text: string) => `card comment ${card} --text ${text}`;

describe('the Card page', () => {
  test('the story as a page: its head, sections, comments, the actions; ⌘⏎ the card’s menu', () => {
    const d = page();
    const p = props(d);

    expect(p).toMatchObject({
      heading: 'Card · alex-1',
      card: 4,
      title: 'Cart total includes shipping',
      hint: '⌘⏎ actions · ? keys',
      comments: { state: 'ready', comments: [{ by: 'Sam Sample' }] },
      composer: { text: '', focused: false, state: 'writing' },
    });
    expect(p.sections.map((s) => s.title)).toEqual(['Description', 'Acceptance criteria']);
    // its session runs: Stop the session; Launch again… stops it first
    expect(
      p.buttons.map((b) => `${b.label}${b.reason === undefined ? '' : ` (${b.reason})`}`),
    ).toEqual(['Comment', 'Move…', 'Assign…', 'Launch again…', 'Stop the session']);
    d.keys('<D-CR>');
    const rows = d.layer?.kind === 'PickLayer' ? d.layer.props.rows : [];

    expect(rows.map((r) => r.text)).not.toContain('Comment…');
    // Open workspace stays a row, with no key: ⌃W is gone
    const workspace = rows.find((r) => r.text === 'Open workspace');

    expect(workspace).toBeDefined();
    expect(workspace?.note).toBeUndefined();
  });

  test.each<[string, Readonly<Record<string, string>>, string]>([
    ['its session’s box', { card: '4', from: 'board' }, 'Card · alex-1'],
    ['none: never the window’s', { card: '6', from: 'board', root: '/wt/5-saved' }, 'Card'],
  ])('the heading names the card’s own workspace: %s', (_, params, heading) => {
    expect(props(page(params)).heading).toBe(heading);
  });

  test.each<[string, Readonly<Record<string, string>>, Command[]]>([
    [
      'the Board’s popup: the Board again, on the card (as its close button)',
      { card: '4', from: 'board' },
      [{ kind: 'open', screen: 'factory', params: { card: '4' }, slot: 'main' }],
    ],
    [
      'in its workspace (the branch’s card): the window’s',
      { branch: 'card/4-cart-total' },
      [{ kind: 'shell', effect: { kind: 'unhandled', slot: 'main', key: '<Esc>' } }],
    ],
  ])('Esc on the page: %s; in the composer or on an action, the page again', (_, params, want) => {
    const d = page(params);

    expect(props(d).card).toBe(4);
    d.take();
    d.keys('<CR>', '<Esc>', '<Tab>', '<Tab>', '<Esc>');
    expect(d.take()).toEqual([]);
    expect(props(d).composer.focused).toBe(false);
    d.keys('<Esc>');
    expect(d.take()).toEqual(want);
    expect(d.click('dialog:close').take()).toEqual(want);
  });

  test('Tab goes round the page, the composer and the actions that can run; ⇧Tab back', () => {
    const d = page();
    const at = (): string => {
      const p = props(d);

      return p.composer.focused ? 'composer' : (p.focus ?? 'page');
    };
    const round: string[] = [];

    for (let i = 0; i < 7; i += 1) {
      round.push(at());
      d.keys('<Tab>');
    }
    expect(round).toEqual([
      'page',
      'composer',
      'card:comment',
      'card:move',
      'card:assign',
      'card:launch',
      'card:stop',
    ]);
    expect(at()).toBe('page');
    d.keys('<S-Tab>');
    expect(at()).toBe('card:stop');
    // ← → along the actions
    d.keys('k', 'k');
    expect(at()).toBe('card:assign');
  });

  test('Stop the session asks first, No the default', () => {
    const d = page().click('card:stop');

    expect(d.layer).toMatchObject({
      kind: 'ConfirmLayer',
      props: { question: "Stop #4's session?" },
    });
    d.keys('<CR>');
    expect(d.layer).toBeUndefined();
    expect(reads(d)).not.toContain('session stop s4');
  });

  const failed: Refused = {
    kind: 'result',
    id: '',
    command: null,
    reply: { ok: false, error: { code: 'offline', message: 'Azure DevOps cannot be reached' } },
  };
  const ok: Answer = {
    kind: 'result',
    id: '',
    command: 'card comment',
    reply: {
      ok: true,
      data: { card: 4, id: 9, text: 'Seen it', by: 'Alex Example', at: minutes(7) },
    },
  };

  test.each<
    [string, Answer | Refused, { text: string; state: string; error?: string; again: boolean }]
  >([
    [
      'posted: the draft goes, the thread read again',
      ok,
      { text: '', state: 'writing', again: true },
    ],
    [
      'refused: the draft kept, why in the composer',
      failed,
      {
        text: 'Seen it',
        state: 'failed',
        error: 'Azure DevOps cannot be reached (offline)',
        again: false,
      },
    ],
  ])('⏎ comments: into the composer, typed, ⏎ posts it once; %s', (_, answer, want) => {
    const d = page();

    d.take();
    d.keys('<CR>').type('Seen it');
    expect(props(d).composer).toMatchObject({ text: 'Seen it', focused: true });
    d.keys('<CR>', '<CR>');
    expect(reads(d)).toEqual([posted(4, 'Seen it')]);
    expect(props(d).composer.state).toBe('posting');
    // nothing typed while it posts
    d.type('x');
    expect(props(d).composer.text).toBe('Seen it');
    d.answer(repliesBy({ 'card comment': answer }));
    expect(props(d).composer).toMatchObject({
      text: want.text,
      state: want.state,
      ...(want.error === undefined ? {} : { error: want.error }),
    });
    expect(reads(d)).toEqual(want.again ? ['card show 4'] : []);
  });

  test('its draft is kept per card, the empty one never posted', () => {
    const open = (card: number): Input => ({
      kind: 'open',
      params: { card: String(card) },
      size: { width: 1400, height: 760 },
    });
    const d = page();

    d.keys('<CR>').type('Half');
    d.send(open(6)).answer();
    expect(props(d)).toMatchObject({ card: 6, composer: { text: '', focused: false } });
    d.take();
    d.keys('<CR>', '<CR>');
    expect(reads(d)).toEqual([]);
    d.send(open(4)).answer();
    expect(props(d).composer.text).toBe('Half');
  });

  describe('its comments, images and Sheets, as card show and card images read them', () => {
    const IMAGE =
      'https://dev.azure.com/demo-org/Shop/_apis/wit/attachments/9b2c6c4e?fileName=cart.png';
    const OTHER = 'https://img.example/elsewhere.png';
    const WITH_IMAGES: CardComment[] = [
      ...COMMENTS,
      { id: 2, by: 'Abe', at: '2026-10-01T09:04:00.000Z', text: `Like this: ![](${OTHER})` },
    ];
    const SHOWN: Answer = {
      kind: 'result',
      id: '',
      command: 'card show',
      reply: {
        ok: true,
        data: {
          ...FOUR,
          description: `The total adds shipping twice.\n\n![cart.png](${IMAGE})`,
          comments: WITH_IMAGES,
          sheets: [
            cardSheet(4, 'cart-a1', 'Cart totals', { at: minutes(3), version: 2 }),
            cardSheet(4, 'proto-b2', 'Prototype v3', { at: minutes(5) }),
          ],
        },
      },
    };
    const IMAGES: Answer = {
      kind: 'result',
      id: '',
      command: 'card images',
      reply: {
        ok: true,
        data: {
          images: [
            { url: IMAGE, path: '/state/images/ab12.png' },
            { url: OTHER, error: 'not an attachment of https://dev.azure.com/demo-org' },
          ],
        },
      },
    };
    const read = () =>
      driveScreen(cardScreen, {
        params: { card: '4', from: 'board' },
        now: minutes(6),
        focused: true,
        replies: (asked) => repliesBy({ 'card show': SHOWN })(asked) ?? REPLIES(asked),
      }).answer();

    test('the org’s image from its file, any other a link; its Sheets newest first beside them', () => {
      const d = read();

      expect(reads(d)).toEqual([`card images ${IMAGE} ${OTHER}`]);
      expect(props(d).sections[0]?.markdown).toBe(
        `The total adds shipping twice.\n\n[cart.png](${IMAGE})`,
      );
      d.answer(repliesBy({ 'card images': IMAGES }));
      const p = props(d);

      expect(p.sections[0]?.markdown).toContain('![cart.png](file:///state/images/ab12.png)');
      expect(p.comments?.comments.map((c) => c.markdown)).toEqual([
        'Seen on mobile too.',
        `Like this: [image](${OTHER})`,
      ]);
      expect(p.sheets?.rows.map((r) => r.title)).toEqual(['Prototype v3', 'Cart totals']);
      // read again (a card write): only the image not read is asked again
      d.send(
        eventInput({ type: 'command.ran', seq: 3, data: { noun: 'card', verb: 'tag', exit: 0 } }),
      );
      d.answer(repliesBy({ 'card show': SHOWN }));
      expect(reads(d)).toEqual([`card images ${OTHER}`]);
    });

    test('a click on a Sheet: the Board in its place on the card, that Sheet a tab there', () => {
      const d = read();

      d.take();
      d.click('sheet:4/cart-a1');
      expect(d.commands).toEqual([
        {
          kind: 'open',
          screen: 'factory',
          params: { card: '4', sheet: '4/cart-a1' },
          slot: 'main',
        },
      ]);
    });

    test('card show refused: the page says it was not read, and why', () => {
      const d = driveScreen(cardScreen, {
        params: { card: '4' },
        replies: (asked) =>
          asked.argv[1] === 'show'
            ? {
                kind: 'result',
                id: '',
                command: null,
                reply: {
                  ok: false,
                  error: { code: 'offline', message: 'Azure DevOps cannot be reached' },
                },
              }
            : REPLIES(asked),
      }).answer();

      expect(props(d)).toMatchObject({
        title: '#4 not read',
        meta: ['Azure DevOps cannot be reached'],
      });
    });
  });

  test('board.changed on its card: its text at once, card show again; another card’s, nothing', () => {
    const changed = (card: CardData): Input =>
      eventInput({
        type: 'board.changed',
        seq: 30,
        data: {
          board: {
            organization: 'https://dev.azure.com/demo-org',
            project: 'Sandbox',
            team: 'Sandbox',
          },
          cards: [{ card, mine: true }],
          gone: [],
        },
      });
    const d = page();

    d.send(changed({ ...SIX, title: 'Other' }));
    expect(reads(d)).toEqual([]);
    d.send(
      changed({ ...FOUR, title: 'Cart total includes shipping and tax', description: 'Tax too.' }),
    );
    expect(props(d)).toMatchObject({ title: 'Cart total includes shipping and tax' });
    expect(props(d).sections[0]?.markdown).toBe('Tax too.');
    expect(reads(d)).toEqual(['card show 4']);
  });

  test.each<[string, string, Command[]]>([
    ['a dim one (no pull request yet): nothing', 'dialog:linked:pr', []],
    [
      'Box: the Boxes tab on it, shown',
      'dialog:linked:box',
      [
        { kind: 'open', screen: 'boxes', slot: 'pane', params: { box: 'alex-1', card: '4' } },
        { kind: 'shell', effect: { kind: 'show', place: 'boxes' } },
      ],
    ],
    ['Session: Chat on it', 'dialog:linked:session', chatOpened(4, 's4')],
  ])('a click on a Linked chip opens what it names: %s', (_, chip, want) => {
    const d = page();

    d.take();
    expect(d.click(chip).commands).toEqual(want);
  });

  /** The Card page on `card`, its reads answered; its Launch box's ⏎ pressed a minute on. */
  const launched = (card: CardData) => {
    const d = driveScreen(cardScreen, {
      params: { card: String(card.id), from: 'board' },
      now: minutes(6),
      focused: true,
      replies: (asked) => (asked.argv[1] === 'show' ? shown(card) : REPLIES(asked)),
    }).answer();

    expect(props(d).buttons.find((b) => b.id === 'card:launch')).toMatchObject({
      label: 'Launch agent…',
    });
    d.click('card:launch');
    expect(d.layer?.kind).toBe('LaunchBox');
    // a minute on: the box's ⏎ is never the one that opened it
    d.send({ kind: 'tick', at: minutes(7) }).keys('<CR>');
    expect(d.layer).toBeUndefined();

    return d;
  };
  const writes = (d: Page) => reads(d).filter((r) => /^(factory run|card assign)/.test(r));

  test('yours, no session: Launch agent… is the Launch box, its ⏎ launches once', () => {
    const d = launched(SIX);

    expect(writes(d)).toEqual(['factory run 6']);
    d.click('card:launch')
      .send({ kind: 'tick', at: minutes(8) })
      .keys('<CR>');
    expect(writes(d)).toHaveLength(1);
  });

  test('its session live: Launch again… says it stops it first, its ⏎ launches with --replace', () => {
    const d = page();

    expect(props(d).buttons.find((b) => b.id === 'card:launch')).toEqual({
      id: 'card:launch',
      label: 'Launch again…',
    });
    d.click('card:launch');
    expect(d.layer).toMatchObject({
      kind: 'LaunchBox',
      props: { along: ['stops s4 first · its run and worktree kept, ended'] },
    });
    d.send({ kind: 'tick', at: minutes(7) }).keys('<CR>');
    expect(writes(d)).toEqual(['factory run 4 --replace']);
    // the launch going: a second ⏎ launches nothing more
    d.click('card:launch')
      .send({ kind: 'tick', at: minutes(8) })
      .keys('<CR>');
    expect(writes(d)).toHaveLength(1);
  });

  test('launched: Launch again… stays on its card, Esc the page then the Board', () => {
    const d = launched(SIX);
    const run = factoryRun(6, SIX.title, 'spec', 'running');

    d.answer(
      repliesBy({
        'factory run': {
          kind: 'result',
          id: '',
          command: 'factory run',
          reply: { ok: true, data: run },
        },
        'factory status': runsAnswer([...BOARD_RUNS, run]),
        'session list': sessionsAnswer([...BOARD_SESSIONS, session('s6', 'working', 6)]),
      }),
    );
    expect(props(d).buttons.find((b) => b.id === 'card:launch')?.reason).toBeUndefined();
    // the keys stay on it: Esc puts them on the page, the next Esc the Board
    expect(props(d).focus).toBe('card:launch');
    d.keys('<Esc>');
    expect(props(d).focus).toBeUndefined();
    d.take();
    d.keys('<Esc>');
    expect(d.take()).toEqual([
      { kind: 'open', screen: 'factory', params: { card: '6' }, slot: 'main' },
    ]);
  });

  test('no one’s: its ⏎ launches, then assigns it to you once launched', () => {
    const free = listCard(12, 'Gift cards at checkout', 'New', null);
    const d = launched(free);

    expect(writes(d)).toEqual(['factory run 12']);
    d.answer(
      repliesBy({
        'factory run': {
          kind: 'result',
          id: '',
          command: 'factory run',
          reply: { ok: true, data: factoryRun(12, 'Gift cards at checkout', 'spec', 'running') },
        },
      }),
    );
    expect(writes(d)).toEqual(['card assign 12 me']);
    // its Launching… cleared as it answered
    expect(d.effects.filter((e) => e.kind === 'status').at(-1)).toEqual({
      kind: 'status',
      text: '',
    });
  });

  test('no one’s, its launch refused (an expired aws login): nothing written to the board', () => {
    const d = launched(listCard(12, 'Gift cards at checkout', 'New', null));

    d.answer(
      repliesBy({
        'factory run': {
          kind: 'result',
          id: '',
          command: 'factory run',
          reply: {
            ok: false,
            error: { code: 'aws-login-expired', message: 'the aws login of dev is expired' },
          },
        },
      }),
    );
    expect(writes(d)).toEqual([]);
    expect(d.effects.filter((e) => e.kind !== 'status')).toEqual([
      {
        kind: 'balloon',
        tone: 'error',
        text: 'the aws login of dev is expired (aws-login-expired)',
      },
    ]);
    expect(d.effects.filter((e) => e.kind === 'status').at(-1)).toEqual({
      kind: 'status',
      text: '',
    });
  });
});
