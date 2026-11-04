/**
 * Welcome (#212, board W-Welcome): its reads from home, the groups and their folding (Needs you
 * never), Mine / Team, one cursor from the cards into the projects, `/` over both, ⏎ and ⌘⏎ on a
 * card and a project, the empty states.
 */
import { describe, expect, test } from 'bun:test';
import { BOXES_OFF } from '@abe/core/box-text';
import type { BoxData, CardData, FactoryRunData, SessionData } from '@abe/core';
import {
  cardsAnswer,
  eventInput,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
  X_BOXES,
} from '@abe/testing';
import { type Node, type Table } from '../runtime/components';
import { type Command, type Input, type Menu, type MenuDoes, step } from '../runtime/runtime';
import { screenOf } from '../runtime/screens';
import { withLive } from '../live';
import {
  type CardRow,
  foldGroups,
  PROJECTS_PARAM,
  type WelcomeProject,
  welcomeScreen,
  type WelcomeState,
} from './welcome';

const PROJECTS: WelcomeProject[] = [
  {
    name: 'demo-shop',
    path: '/p/demo-shop',
    shown: '~/projects/demo-shop',
    initials: 'DS',
    branch: 'main',
  },
  {
    name: 'vimstorm',
    path: '/p/vimstorm',
    shown: '~/projects/vimstorm',
    initials: 'V',
    branch: 'abe',
  },
];

const MINE: CardData[] = [
  listCard(101, 'Cart total rounds wrong', 'Active'),
  listCard(102, 'Count each line’s qty', 'Active'),
  listCard(103, 'Show stock on a product', 'Active'),
  listCard(104, 'Saved carts', 'New'),
];
const TEAM: CardData[] = [...MINE, listCard(201, 'Their question', 'Active', 'Bo Teammate')];

const RUNS: FactoryRunData[] = [
  factoryRun(101, 'Cart total rounds wrong', 'build', 'needs-you', {
    repo: '/p/demo-shop',
    worktree: '/wt/s101',
  }),
  factoryRun(103, 'Show stock on a product', 'build', 'running', {
    repo: '/p/demo-shop',
    worktree: '/wt/s103',
  }),
  factoryRun(201, 'Their question', 'spec', 'needs-you', {
    repo: '/p/demo-shop',
    worktree: '/wt/s201',
  }),
];
const SESSIONS: SessionData[] = [
  { ...session('s101', 'waiting', 101), repo: '/p/demo-shop', worktree: '/wt/s101' },
  { ...session('s103', 'working', 103), repo: '/p/demo-shop', worktree: '/wt/s103' },
  { ...session('s201', 'waiting', 201), repo: '/p/demo-shop', worktree: '/wt/s201' },
];

const key = (k: string): Input => ({ kind: 'key', key: k });
const box = (name: string, state: BoxData['state'], card: number | null): BoxData =>
  X_BOXES.box(name, { state, card });

/** The Action menu a command is, else the test fails. */
const menuOf = (c: Command | undefined): Menu => {
  if (c?.kind !== 'menu') throw new Error(`not a menu: ${JSON.stringify(c)}`);

  return c;
};

/** Welcome with its live facts, as the bridge feeds them. */
const LIVE_WELCOME = withLive(welcomeScreen);

const drive = (projects: WelcomeProject[] = PROJECTS, height = 680) => {
  let held = step(LIVE_WELCOME, LIVE_WELCOME.init, {
    kind: 'open',
    params: { [PROJECTS_PARAM]: JSON.stringify(projects) },
    size: { width: 1000, height },
  });
  let commands: Command[] = held.commands;
  const d = {
    get state(): WelcomeState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return commands;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(LIVE_WELCOME, held.state, input);
        commands = held.commands;
      }
      return d;
    },
    table(id: string): Table {
      const find = (n: Node): Table | undefined => {
        if (n.kind === 'Table') return n.id === id ? n : undefined;
        for (const c of 'children' in n ? (n.children ?? []) : []) {
          const hit = find(c);

          if (hit !== undefined) return hit;
        }
        return undefined;
      };
      const t = find(held.tree);

      if (t === undefined) throw new Error(`no table ${id}`);
      return t;
    },
    /** The cards table as lines: captions, `#id word`, `N more…`. */
    lines(): string[] {
      return d
        .table('welcome-cards')
        .props.rows.map((r) =>
          r.id?.startsWith('card:') === true
            ? `${r.cells[0]?.accent ?? ''} ${r.cells.find((c) => c.mark !== undefined)?.text ?? ''}`
            : (r.cells[0]?.text ?? ''),
        );
    },
  };
  return d;
};

const READ_ALL: Input[] = [
  cardsAnswer(MINE, true),
  cardsAnswer(TEAM, false),
  runsAnswer(RUNS),
  sessionsAnswer(SESSIONS),
  { kind: 'tick', at: minutes(10) },
];

describe('welcome', () => {
  test('is registered and reads the Board’s lists from home on open', () => {
    expect(screenOf('welcome')?.name).toBe('welcome');
    const d = drive();
    const argv = d.commands.map((c) => (c.kind === 'run' ? c.argv.join(' ') : c.kind));

    expect(argv).toEqual([
      'card members',
      'settings problems',
      // the window told its chrome: nothing needs you yet, no board crumb; then its stripe
      'shell',
      'shell',
      // the live facts it follows, read once for every screen open: the card lists have the
      // sprint's done cards too, which Welcome leaves out
      'session list',
      'factory status',
      'box list',
      'card list --mine --closed',
      'card list --closed',
    ]);
    expect(d.commands.find((c) => c.kind === 'shell')).toEqual({
      kind: 'shell',
      effect: { kind: 'welcome', needsYou: 0, crumb: '', page: 'board' },
    });
  });

  test('groups Mine by state, Needs you first, captions with counts', () => {
    const d = drive().send(...READ_ALL);

    expect(d.lines()).toEqual([
      'NEEDS YOU · 1',
      '#101 Needs you',
      'RUNNING · 1',
      '#103 Running',
      'NOT STARTED · 2',
      '#102 Not started',
      '#104 Not started',
    ]);
  });

  test('Team on Tab: a teammate’s ask is ◇ Needs someone, never your ◆', () => {
    const d = drive().send(...READ_ALL, key('<Tab>'));
    const rows = d.table('welcome-cards').props.rows;
    const theirs = rows.find((r) => r.id === 'card:201');

    expect(d.lines()).toContain('NEEDS SOMEONE · 1');
    expect(theirs?.cells.find((c) => c.mark !== undefined)).toMatchObject({
      mark: '◇',
      hue: 'dim',
    });
    d.send(key('<S-Tab>'));
    expect(d.lines()).not.toContain('NEEDS SOMEONE · 1');
  });

  test('folding: Needs you never, the longest other group first', () => {
    const row = (id: number, group: CardRow['group']): CardRow => ({
      card: listCard(id, `Card ${id}`, 'Active'),
      group,
      rail: [],
      mark: '●',
      word: '',
      hue: 'dim',
    });
    const rows = [
      ...[1, 2, 3, 4].map((i) => row(i, 'needs-you')),
      ...[5, 6, 7, 8, 9, 10].map((i) => row(i, 'running')),
      ...[11, 12].map((i) => row(i, 'not-started')),
    ];
    const folded = foldGroups(rows, 10);

    expect(folded.map((g) => [g.group, g.rows.length, g.more])).toEqual([
      ['needs-you', 4, 0],
      ['running', 0, 6],
      ['not-started', 1, 1],
    ]);
    // all fit: nothing folds
    expect(foldGroups(rows, 40).every((g) => g.more === 0)).toBe(true);
    // a tiny room still shows Needs you whole
    expect(foldGroups(rows, 2)[0]).toMatchObject({ group: 'needs-you', more: 0 });
    // unfolded: it folds last
    const unfolded = foldGroups(rows, 14, 'running');

    expect(unfolded.find((g) => g.group === 'running')?.more).toBe(0);
  });

  test('one cursor from the cards on into the projects; ⏎ on a project opens it', () => {
    const d = drive().send(...READ_ALL);

    expect(d.state.selected).toBe('card:101');
    d.send(key('G'));
    expect(d.state.selected).toBe('project:/p/vimstorm');
    d.send(key('l'));
    expect(d.state.selected).toBe('project:/p/demo-shop');
    d.send(key('l'));
    expect(d.state.selected).toBe('card:104');
    d.send(key('ö'), key('<CR>'));
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/p/demo-shop' } },
    ]);
    d.send(key('<S-CR>'));
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/p/demo-shop' } },
    ]);
  });

  test('/ filters both lists as you type; Esc clears it', () => {
    const d = drive().send(...READ_ALL, key('/'), key('v'), key('i'), key('m'));

    expect(d.table('welcome-cards').props.rows).toEqual([]);
    expect(d.table('welcome-projects').props.rows.map((r) => r.id)).toEqual([
      'project:/p/vimstorm',
    ]);
    expect(d.state.selected).toBe('project:/p/vimstorm');
    d.send(key('<Esc>'));
    expect(d.table('welcome-projects').props.rows).toHaveLength(2);
    d.send(key('/'), key('1'), key('0'), key('3'));
    expect(d.lines()).toEqual(['RUNNING · 1', '#103 Running']);
  });

  test('⏎ on a card opens its live worktree in the Factory view on the card', () => {
    const d = drive().send(...READ_ALL);

    expect(d.table('welcome-cards').props.foot).toEqual([
      { keys: '⏎', label: 'open demo-shop on this card' },
    ]);
    d.send(key('<CR>'));
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/wt/s101', card: 101 } },
    ]);
  });

  test('⏎ on a card with no run: the one project at once, else a pick of them', () => {
    const d = drive().send(...READ_ALL, key('G'), key('l'), key('l'), key('<CR>'));
    const pick = menuOf(d.commands[0]);

    expect(pick.kind).toBe('menu');
    expect(pick.title).toBe('Open #104 in');
    expect(pick.rows.map((r) => r.does)).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/p/demo-shop', card: 104 } },
      { kind: 'shell', effect: { kind: 'open-project', path: '/p/vimstorm', card: 104 } },
    ]);
    const one = drive(PROJECTS.slice(0, 1)).send(...READ_ALL, key('G'), key('l'), key('<CR>'));

    expect(one.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/p/demo-shop', card: 104 } },
    ]);
  });

  test('⏎ on a box session’s card attaches its workspace', () => {
    const boxed = SESSIONS.map((x) => (x.id === 's103' ? { ...x, box: 'demo-shop-103' } : x));
    const d = drive().send(...READ_ALL, sessionsAnswer(boxed), key('ö'), key('<CR>'));

    expect(d.commands).toEqual([
      { kind: 'run', id: 'welcome-open:103:s103', argv: ['workspace', 'attach-spec', 's103'] },
    ]);
  });

  test('⌘⏎ on a card: what works here, the rest dim with “open the project first”', () => {
    const d = drive().send(...READ_ALL, key('<D-CR>'));
    const menu = menuOf(d.commands[0]);

    expect(menu.rows.map((r) => [r.text, r.reason ?? ''])).toEqual([
      ['Open demo-shop on this card', ''],
      ['Open worktree', ''],
      ['Open story', ''],
      ['Assign…', 'already yours'],
      ['Move…', ''],
      ['Comment…', ''],
      ['Open in browser', ''],
      ['New card…', ''],
      ['Answer', '— open the project first'],
      ['Stop…', '— open the project first'],
      ['Launch agent', '— open the project first'],
    ]);
    // Open story: the story dialog, from what `card list` read; New card on the team's board
    expect(menu.rows.find((r) => r.id === 'story')?.does).toMatchObject({
      kind: 'do',
      commands: [{ kind: 'dialog', id: 'dialog:101' }],
    });
    expect(menu.rows.find((r) => r.id === 'new-card')?.does).toMatchObject({
      kind: 'do',
      commands: [{ kind: 'newcard', sprint: 'Sprint 14' }],
    });
    // Assign… › a teammate: handed back, written with `card assign`, `u` undoes it
    const team: Input = {
      kind: 'result',
      id: 'members',
      command: 'card members',
      reply: {
        ok: true,
        data: { members: [{ name: 'Sam Sample', email: 'sam@x.se', you: false }] },
      },
    };

    d.send(team, { kind: 'choice', menu: 'welcome-card:101', row: 'assign', values: ['sam@x.se'] });
    expect(d.commands).toEqual([
      { kind: 'run', id: 'assign:101', argv: ['card', 'assign', '101', 'sam@x.se'] },
    ]);
    d.send({
      kind: 'result',
      id: 'assign:101',
      command: 'card assign',
      reply: { ok: true, data: listCard(101, 'Cart total rounds wrong', 'Active', 'Sam Sample') },
    });
    expect(d.table('welcome-cards').props.note).toBe('Assigned #101 to Sam Sample · u undo');
    d.send(key('u'));
    expect(d.commands).toEqual([
      { kind: 'run', id: 'assign-undo:101', argv: ['card', 'assign', '101', 'me'] },
    ]);
    expect(menu.rows.find((r) => r.id === 'move')?.does).toMatchObject({
      kind: 'run',
      argv: ['card', 'move', '101'],
    });
  });

  // Open worktree on Welcome: a local session's worktree opens; a box's needs the project
  test.each([
    [
      'a local session',
      SESSIONS,
      { kind: 'shell', effect: { kind: 'open-project', path: '/wt/s101' } },
    ],
    [
      'a box session',
      SESSIONS.map((x) => (x.id === 's101' ? { ...x, box: 'demo-shop-101' } : x)),
      undefined,
    ],
  ] as const)('⌘⏎ Open worktree: %s', (_, sessions, want: MenuDoes | undefined) => {
    const d = drive().send(...READ_ALL, sessionsAnswer([...sessions]), key('<D-CR>'));
    const row = menuOf(d.commands[0]).rows.find((r) => r.id === 'worktree');

    expect(row?.does).toEqual(want);
  });

  test('a project’s ⌘⏎: Open, Show in Finder, Remove from list; a gone folder is a dim row', () => {
    const gone: WelcomeProject = {
      name: 'old-shop',
      path: '/p/old-shop',
      shown: '~/projects/old-shop',
      initials: 'OS',
      gone: true,
    };
    const d = drive([...PROJECTS, gone]).send(...READ_ALL, key('<D-S-o>'), key('G'));
    const row = d.table('welcome-projects').props.rows.at(-1);

    expect(row?.cells[1]).toMatchObject({ text: 'old-shop', hue: 'dim' });
    expect(d.table('welcome-projects').props.foot).toBeUndefined();
    d.send(key('<D-CR>'));
    const menu = menuOf(d.commands[0]);

    expect(menu.rows.map((r) => [r.text, r.reason ?? ''])).toEqual([
      ['Open', 'its folder is gone'],
      ['Show in Finder', 'its folder is gone'],
      ['Remove from list', ''],
    ]);
    expect(menu.rows.at(-1)?.does).toEqual({
      kind: 'shell',
      effect: { kind: 'forget-project', path: '/p/old-shop' },
    });
  });

  test('Open… and New Project…: the window’s folder panel, from the header and `:`', () => {
    const d = drive().send(...READ_ALL);
    const open: Command = { kind: 'shell', effect: { kind: 'app', action: 'open' } };

    // (⌘O itself is the window's: Rust opens the panel before the screen sees the key)
    d.send({ kind: 'click', id: 'open' });
    expect(d.commands).toEqual([open]);
    d.send({ kind: 'click', id: 'new-project' });
    expect(d.commands).toEqual([{ kind: 'shell', effect: { kind: 'app', action: 'new-project' } }]);
    const view = welcomeScreen.here?.(d.state).view;

    expect(view?.menu.rows.map((r) => r.text)).toEqual([
      'New card…',
      'Open…',
      'New Project…',
      'Clone…',
      'Projects',
      'Sessions',
      'Boxes',
    ]);
    d.send({ kind: 'choice', menu: 'welcome-view', row: 'page:sessions' });
    expect(d.state.page).toBe('sessions');
  });

  // Clone… (#3): the header's button asks the URL in Command mode; its answer is the window's;
  // `:clone <url>` (3.0) the same in one line
  test.each([
    [
      'a URL',
      ['git@github.com:demo/demo-shop.git'],
      [
        {
          kind: 'shell',
          effect: { kind: 'clone-project', url: 'git@github.com:demo/demo-shop.git' },
        },
      ],
    ],
    [
      'spaces around it trimmed',
      ['  /tmp/demo-shop  '],
      [{ kind: 'shell', effect: { kind: 'clone-project', url: '/tmp/demo-shop' } }],
    ],
    ['nothing typed', ['  '], []],
    ['no value', undefined, []],
  ] as const)('Clone… and :clone: %s', (_, values, want) => {
    const d = drive().send(...READ_ALL, { kind: 'click', id: 'clone' });
    const menu = menuOf(d.commands[0]);

    expect(menu.rows.map((r) => [r.id, r.does.kind])).toEqual([['clone', 'back']]);
    d.send({
      kind: 'choice',
      menu: menu.id,
      row: 'clone',
      ...(values === undefined ? {} : { values }),
    });
    expect(
      d.commands.filter((c) => c.kind === 'shell' && c.effect.kind === 'clone-project'),
    ).toEqual([...want]);
    const word = screenOf('welcome')?.words.find((w) => w.word === 'clone')?.commands;

    expect(typeof word === 'function' ? word(values ?? []) : word).toEqual([...want]);
  });

  test('empty states: no board, nothing yours, serve not answering, a page read refused', () => {
    const noBoard: Input = {
      kind: 'result',
      id: 'cards:mine',
      command: 'card list',
      reply: { ok: false, error: { code: 'no-board', message: 'no board' } },
    };
    const d = drive().send(noBoard);

    expect(d.table('welcome-cards').props.empty?.title).toBe('No board yet');
    d.send(key('<CR>'));
    expect(d.commands).toEqual([
      { kind: 'open', screen: 'settings', params: { page: 'board-team' } },
    ]);
    const none = drive().send(cardsAnswer([], true));

    expect(none.table('welcome-cards').props.empty).toEqual({
      title: 'Nothing needs you',
      line: 'Tab · Team',
    });
    const down: Input = {
      kind: 'result',
      id: 'cards:mine',
      command: 'card list',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'connect ECONNREFUSED' } },
    };
    const off = drive().send(down);

    expect(off.table('welcome-cards').props.empty?.title).toBe('Abe isn’t answering');
    // a refused page read says why, never reads on (serve.target local: boxes are off)
    const local = drive().send(
      {
        kind: 'result',
        id: 'boxes',
        command: 'box list',
        reply: { ok: false, error: { code: BOXES_OFF.code, message: BOXES_OFF.message } },
      },
      {
        kind: 'result',
        id: 'sessions',
        command: 'session list',
        reply: { ok: false, error: { code: 'serve-unreachable', message: 'connect ECONNREFUSED' } },
      },
      key('<D-6>'),
    );

    expect(local.table('welcome-boxes').props.empty).toEqual({
      title: BOXES_OFF.title,
      line: BOXES_OFF.line,
    });
    local.send(key('<D-5>'));
    expect(local.table('welcome-sessions').props.empty).toEqual({
      title: 'Sessions not read',
      line: 'connect ECONNREFUSED',
    });
    // the projects still open
    off.send(key('<CR>'));
    expect(off.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/p/demo-shop' } },
    ]);
  });

  test('a board.changed moves the cards in place, nothing read; done cards never shown', () => {
    const d = drive().send(...READ_ALL);

    d.send(
      eventInput({
        type: 'board.changed',
        data: {
          board: {
            organization: 'https://dev.azure.com/demo-org',
            project: 'Sandbox',
            team: 'Sandbox',
          },
          cards: [
            { card: { ...(MINE[3] ?? listCard(104, 'x', 'New')), state: 'Closed' }, mine: true },
          ],
          gone: [],
        },
      }),
    );
    expect(d.commands.filter((c) => c.kind === 'run')).toEqual([]);
    expect(d.lines()).not.toContain('#104 Not started');
  });

  test('the window told its chrome once it changed: the Dock badge, the crumb, the page', () => {
    const d = drive().send(...READ_ALL);

    expect(d.state.told).toBe('1|Sandbox · Sprint 14|board');
    // told once: the same answers again tell nothing; Needs you moving tells it anew
    d.send(cardsAnswer(MINE, true));
    expect(d.commands).toEqual([]);
    d.send(runsAnswer(RUNS.filter((r) => r.card !== 101)), sessionsAnswer(SESSIONS.slice(1)));
    expect(d.commands).toContainEqual({
      kind: 'shell',
      effect: { kind: 'welcome', needsYou: 0, crumb: 'Sandbox · Sprint 14', page: 'board' },
    });
    d.send(runsAnswer(RUNS), sessionsAnswer(SESSIONS));
    d.send(key('<D-S-o>'));

    expect(d.state.page).toBe('projects');
    expect(d.commands).toContainEqual({
      kind: 'shell',
      effect: { kind: 'welcome', needsYou: 1, crumb: 'Sandbox · Sprint 14', page: 'projects' },
    });
    expect(d.table('welcome-projects').props.rows).toHaveLength(2);
    d.send(key('<Esc>'));
    expect(d.state.page).toBe('board');
  });

  /** The last `stripe` effect sent: its items' ids shown by the shell, dots and workspace flags. */
  const stripeOf = (commands: readonly Command[]) => {
    const e = commands
      .flatMap((c) => (c.kind === 'shell' && c.effect.kind === 'stripe' ? [c.effect] : []))
      .at(-1);

    return e === undefined
      ? undefined
      : {
          items: e.items.map(
            (i) =>
              `${i.id}${i.dot === undefined ? '' : ` ${i.dot}`}${i.workspaceOnly === true ? ' (workspace)' : ''}${i.hidden === true ? ' (hidden)' : ''}`,
          ),
          gear: e.gear.dot ?? 'none',
        };
  };

  // the stripe on Welcome (#3): a project window's items; dots, never counts
  const STRIPE_ROWS: { name: string; inputs: Input[]; items: string[]; gear: string }[] = [
    {
      name: 'nothing read yet: no dots; a repo’s tool windows a workspace’s',
      inputs: [],
      items: [
        'project',
        'board',
        'run (workspace)',
        'terminal (workspace)',
        'sessions',
        'boxes',
        'pipelines (workspace)',
        'git (workspace)',
      ],
      gear: 'none',
    },
    {
      name: 'a card and sessions need you: Board and Sessions teal',
      inputs: READ_ALL,
      items: [
        'project',
        'board needs-you',
        'run (workspace)',
        'terminal (workspace)',
        'sessions needs-you',
        'boxes',
        'pipelines (workspace)',
        'git (workspace)',
      ],
      gear: 'none',
    },
    {
      name: 'only running: Sessions amber; Settings with problems: the gear’s dot',
      inputs: [
        sessionsAnswer(SESSIONS.slice(1, 2)),
        {
          kind: 'result',
          id: 'problems',
          command: 'settings problems',
          reply: {
            ok: true,
            data: {
              problems: [
                {
                  kind: 'login',
                  code: 'login-missing',
                  text: 'GitHub isn’t signed in',
                  where: 'Logins & tools › GitHub',
                  page: 'tools',
                  way: { kind: 'fix', command: 'abe login github' },
                },
              ],
              checked: { logins: true, tools: true },
            },
          },
        },
      ],
      items: [
        'project',
        'board',
        'run (workspace)',
        'terminal (workspace)',
        'sessions running',
        'boxes',
        'pipelines (workspace)',
        'git (workspace)',
      ],
      gear: 'failed',
    },
    {
      name: 'your stripe tweaks (the factory screen’s): Boxes hidden',
      inputs: [
        {
          kind: 'views',
          tweaks: [],
          all: [{ screen: 'factory', node: 'stripe:boxes', hide: true }],
        },
      ],
      items: [
        'project',
        'board',
        'run (workspace)',
        'terminal (workspace)',
        'sessions',
        'boxes (hidden)',
        'pipelines (workspace)',
        'git (workspace)',
      ],
      gear: 'none',
    },
  ];

  test.each(STRIPE_ROWS)('the stripe: $name', ({ inputs, items, gear }) => {
    const d = drive();
    let last = stripeOf(d.commands);

    for (const input of inputs) {
      d.send(input);
      last = stripeOf(d.commands) ?? last;
    }
    expect(last).toEqual({ items, gear });
  });

  // a click on the stripe: the page it shows; Sessions or Boxes again goes back to the Board
  test.each([
    ['board', 'projects', 'board'],
    ['project', 'board', 'projects'],
    ['sessions', 'board', 'sessions'],
    ['sessions', 'sessions', 'board'],
    ['boxes', 'sessions', 'boxes'],
    ['boxes', 'boxes', 'board'],
    // what is not on Welcome's stripe
    ['run', 'projects', 'projects'],
  ] as const)('the stripe: %s clicked on %s shows %s', (id, from, to) => {
    const d = drive().send(...READ_ALL, {
      kind: 'click',
      id:
        from === 'board'
          ? 'widget:stripe:board'
          : `widget:stripe:${from === 'projects' ? 'project' : from}`,
    });

    expect(d.state.page).toBe(from);
    d.send({ kind: 'click', id: `widget:stripe:${id}` });
    expect(d.state.page).toBe(to);
  });

  test('the stripe: its menu in Command mode writes your view tweaks; the gear opens Settings', () => {
    const d = drive().send(...READ_ALL, {
      kind: 'views',
      tweaks: [],
      all: [{ screen: 'board', node: 'col:new', hide: true }],
    });

    // right-click on Board: the menu in Command mode, the workspace's items grey with why
    d.send({ kind: 'click', id: 'widget:stripe-at:board' });
    const m = menuOf(d.commands[0]);

    expect(
      m.rows.map(
        (r) =>
          `${r.separator === true ? '— ' : ''}${r.text}${r.reason === undefined ? '' : ` (${r.reason})`}`,
      ),
    ).toEqual([
      'Project',
      'Board',
      '— Sessions',
      'Boxes',
      '— Run (Only in a workspace)',
      'Terminal (Only in a workspace)',
      'Pipelines (Only in a workspace)',
      'Git (Only in a workspace)',
      '— Move to Bottom Group',
      'Reset the Stripe',
    ]);
    d.send({ kind: 'choice', menu: m.id, row: 'widget:stripe-menu:toggle:boxes' });
    const views = [
      { screen: 'board', node: 'col:new', hide: true },
      { screen: 'factory', node: 'stripe:boxes', hide: true },
    ];

    expect(d.commands).toContainEqual({
      kind: 'run',
      id: 'stripe:views',
      argv: ['settings', 'set', 'views', JSON.stringify(views)],
    });
    expect(stripeOf(d.commands)?.items).toContain('boxes (hidden)');
    d.send({ kind: 'choice', menu: m.id, row: 'widget:stripe-menu:reset' });
    expect(stripeOf(d.commands)?.items).toContain('boxes');
    d.send({ kind: 'click', id: 'widget:stripe:settings' });
    expect(d.commands).toEqual([
      { kind: 'open', screen: 'settings', params: { page: 'problems' } },
    ]);
  });

  test('Sessions (⌘5) and Boxes (⌘6): serve-wide pages', () => {
    const d = drive().send(...READ_ALL);
    d.send(key('<D-5>'));
    // the ones that need you first
    expect(d.table('welcome-sessions').props.rows.map((r) => r.id)).toEqual([
      'session:s101',
      'session:s201',
      'session:s103',
    ]);
    d.send(key('<CR>'));
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-project', path: '/wt/s101', card: 101 } },
    ]);
    const boxes: Input = {
      kind: 'result',
      id: 'boxes',
      command: 'box list',
      reply: {
        ok: true,
        data: {
          boxes: [box('demo-shop-1', 'running', 103), box('demo-shop-2', 'stopped', null)],
          queued: [],
        },
      },
    };

    d.send(boxes, key('<D-6>'));
    expect(d.table('welcome-boxes').props.rows.map((r) => r.id)).toEqual([
      'box:demo-shop-1',
      'box:demo-shop-2',
    ]);
    d.send(key('<Esc>'));
    expect(d.state.page).toBe('board');
  });
});
