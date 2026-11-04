/**
 * The contract both sides read: `packages/ui/contract/schema.json` (the component set and the
 * bridge's frames as JSON schema) and one fixture per screen state these tests cover, plus every
 * frame. VimStorm's cargo tests (`app/tests/factory.rs`) read the same files. The files on disk
 * must equal what the code writes; `ABE_WRITE_CONTRACT=1 bun test packages/ui/src/contract.test.ts`
 * (`bun run contract`) writes them again.
 */
import { describe, expect, test } from 'bun:test';
import { localNumber } from '@abe/core/local-names';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  BoxData,
  CardData,
  FactoryRunData,
  InstallView,
  LayerSource,
  SessionData,
} from '@abe/core';
import {
  DEFAULT_LOOK_SETTINGS,
  feelOf,
  keyBinds,
  lookOf,
  mergeSettings,
  themeCatalogue,
  themeGroups,
  themeRow,
  toolCheck,
  TranscriptEntry,
} from '@abe/core';
import {
  cardSheet,
  CHAT_TURN_GALLERY,
  CHAT_TURN,
  CARD_TREES,
  pipelineTrees,
  runTrees,
  CARDS_GALLERY,
  LOCAL_GALLERY,
  LM_VIEW,
  READ_ONLY_VIEW,
  localStatusAnswer,
  COMPOSER_GALLERY,
  COMPOSER_TREES,
  CLEAN_LAYERS,
  OVERRIDE_LAYERS,
  RECORDS_LAYERS,
  DEMO_LAYERS,
  SETTINGS_RULES,
  settingsList,
  settingsListAnswer,
  settingsProblemsAnswer,
  settingsProblemsData,
  cardsAnswer,
  F_SESSIONS,
  helpAnswer,
  factoryRun,
  listCard,
  minutes,
  prototype,
  prototypeListAnswer,
  prototypeSession,
  runsAnswer,
  session,
  sessionsAnswer,
  theirsAnswers,
  sheetFindAnswer,
  sheetOpenAnswer,
  sheetSummary,
  STATUS,
  statusAnswer,
  HEADER_NOW,
  headerDemo,
  LINKED_ENV,
  LINKED_PARTS,
  LINKED_STORY,
  X_BOXES,
  boxesAnswer,
  reviewTrees,
  sampleWorkflows,
  workflowsAnswer,
} from '@abe/testing';
import { z } from 'zod';
import { KINDS, Node, UI_CONTRACT } from './runtime/components';
import { AppFrame, BridgeFrame } from './runtime/protocol';
import { applyPatch, patchOf } from './runtime/patch';
import { commandMode } from './command/command';
import { editorHere } from './command/editor-here';
import { factoryScreen } from './board/factory';
import { cardScreen } from './board/card-page';
import { withLive } from './live';
import { prototypeScreen } from './prototype/prototype';
import { prototypeLooks } from './prototype/prototype-look';
import { type StoryFacts, type StoryRead, storyDialog } from './board/story';
import { dialogSheets } from './board/sheet';
import { type DialogSheets } from './runtime/layers';
import { type Command, type Here, type Input, mountLayer, step } from './runtime/runtime';
import { WORDS } from './runtime/screens';
import { workspacesOf } from './board/workspaces';
import { linkedOf } from './linked/linked-rows';
import { statusScreen } from './shell/status';
import { settingsLayer } from './settings/settings';
import { pinnedScreen } from './chat/pinned';
import { boxesWidget } from './live/box-feed';
import { stripeAt, stripeGear, stripeItems, stripeMenu } from './shell/stripe';
import { boxesScreen } from './boxes/boxes';
import { sessionsScreen } from './sessions/sessions';
import { PROJECTS_PARAM, welcomeScreen, welcomeStripe, welcomeStripeAt } from './welcome/welcome';

/** The screens that show live facts, each with its own as the bridge feeds them. */
const LIVE_FACTORY = withLive(factoryScreen);
const LIVE_CARD = withLive(cardScreen);
const LIVE_CHAT = withLive(pinnedScreen);
const LIVE_SESSIONS = withLive(sessionsScreen);
const LIVE_WELCOME = withLive(welcomeScreen);
const LIVE_BOXES = withLive(boxesScreen);
const LIVE_STATUS = withLive(statusScreen);

const DIR = join(import.meta.dir, '..', 'contract');

const schema = () => {
  const registry = z.registry<{ id: string }>();

  registry.add(Node, { id: 'Node' });
  registry.add(AppFrame, { id: 'AppFrame' });
  registry.add(BridgeFrame, { id: 'BridgeFrame' });
  const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/$defs/${id}` });
  const defs = Object.fromEntries(
    Object.entries(schemas).map(([name, s]) => [
      name,
      Object.fromEntries(Object.entries(s).filter(([key]) => key !== '$schema' && key !== '$id')),
    ]),
  );

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Abe UI contract: component trees and abe ui bridge frames',
    version: UI_CONTRACT,
    kinds: KINDS,
    $defs: defs,
  };
};

const OPEN: Input = { kind: 'open', params: {}, size: { width: 1200, height: 800 } };

const statusTree = (...inputs: Input[]): Node => {
  let held = step(LIVE_STATUS, LIVE_STATUS.init, OPEN);

  for (const input of inputs) held = step(LIVE_STATUS, held.state, input);

  return held.tree;
};

/** Command mode's top layer after `:`, the help table's answer, then `keys` (one char each). */
const commandTree = (keys: string): Node => {
  const layer = mountLayer(commandMode(WORDS));

  layer.send(key(':'));
  if (keys !== '!loading') layer.send(helpAnswer());
  for (const k of keys === '!loading' ? [] : keys.split(' ')) if (k !== '') layer.send(key(k));
  if (layer.tree === undefined) throw new Error(`no layer after ${keys}`);

  return layer.tree;
};

/** The overview's demo: a sprint's cards, runs in every lane, one queued past the box limit. */
const pr61 = {
  repo: 'mkdir-swe/demo-shop',
  number: 61,
  url: 'https://github.com/mkdir-swe/demo-shop/pull/61',
  state: 'open' as const,
  merge: 'person' as const,
  checks: 'success' as const,
  mergeCommit: null,
  deploy: null,
  branch: null,
};
const MINE: CardData[] = [
  listCard(1251, 'Saved carts survive sign-out', 'New', 'Alex Example', { tags: ['cart'] }),
  listCard(1262, 'Greeted by time of day', 'New', 'Alex Example', { tags: ['greet'] }),
  listCard(1271, 'api() calls a double slash for a leading /', 'New', 'Alex Example', {
    type: 'Bug',
    tags: ['api'],
  }),
  listCard(1234, 'Cart total includes shipping', 'Active', 'Alex Example', {
    tags: ['cart', 'pricing'],
    description: [
      '## Why',
      '',
      'The amount a shopper sees in the cart is not the amount they pay: shipping is added only at checkout.',
      '',
      '## What',
      '',
      "The cart total includes shipping for the cart's country, from `/api/shipping/quote`.",
      '',
      '## How',
      '',
      'Add the fee after the subtotal in `cartTotal()` (`src/api/cart.ts`).',
      '',
      '## Markets',
      '',
      // long enough that the dialog scrolls in the shell's test window
      ...['SE', 'NO', 'DK', 'FI', 'DE', 'NL', 'BE', 'FR', 'ES', 'IT', 'PL', 'AT'].map(
        (m) => `- ${m}: its own threshold and fee, from \`src/config/markets.ts\``,
      ),
    ].join('\n'),
    acceptanceCriteria: [
      '- Total = items + shipping, rounded per currency',
      '- Free shipping over the threshold shows 0',
    ].join('\n'),
  }),
  listCard(1240, 'Checkout copy for Nordic markets', 'Active'),
  listCard(1266, 'Greeted loudly with shout()', 'Active', 'Alex Example', { tags: ['greet'] }),
  listCard(1263, 'Friendly greeting with no name', 'Resolved'),
  listCard(1258, 'Order history paginates', 'Resolved'),
];
const TEAM: CardData[] = [
  listCard(1253, 'Coupon field accepts spaces', 'New', 'Sam Sample', {
    type: 'Bug',
    tags: ['coupon', 'checkout'],
  }),
  ...MINE,
  listCard(1272, 'Query parameters for api()', 'Active', 'Robin Park', { tags: ['api'] }),
];
const RUNS: FactoryRunData[] = [
  factoryRun(1251, 'Saved carts survive sign-out', 'spec', 'running', { since: minutes(9) }),
  factoryRun(1234, 'Cart total includes shipping', 'build', 'needs-you', { since: minutes(6) }),
  factoryRun(1240, 'Checkout copy for Nordic markets', 'verify', 'running', {
    since: minutes(7),
  }),
  factoryRun(1263, 'Friendly greeting with no name', 'pr', 'needs-you', {
    since: minutes(-15),
    pr: pr61,
  }),
  factoryRun(1258, 'Order history paginates', 'done', 'done', {
    since: minutes(-40),
    pr: { ...pr61, number: 58, state: 'merged', deploy: 'success' },
    // a hard one (#87): its Chat's header suggests a retro
    hard: ['3 review rounds'],
  }),
  factoryRun(1266, 'Greeted loudly with shout()', 'spec', 'queued', { since: minutes(9) }),
];
const subagent = (id: string) => ({
  id,
  name: 'abe:reader',
  task: id,
  model: null,
  state: 'running' as const,
  startedAt: minutes(8),
  endedAt: null,
  result: null,
});
const SESSIONS: SessionData[] = [
  { ...session('s1251', 'starting', 1251), box: 'alex-3' },
  { ...session('s1234', 'waiting', 1234), box: 'alex-1' },
  {
    ...session('s1240', 'working', 1240),
    subagents: [subagent('tests'), subagent('api'), subagent('browser')],
  },
  { ...session('s1263', 'ended', 1263), box: 'alex-2' },
  { ...session('s1258', 'ended', 1258), box: 'alex-2' },
  { ...session('s1266', 'queued', 1266), box: 'alex-4' },
];

/** The factory screen, its reads answered and the clock at ten past, then `inputs`. */
const factoryInputs = (): Input[] => [
  cardsAnswer(MINE, true),
  cardsAnswer(TEAM, false),
  runsAnswer(RUNS),
  sessionsAnswer(SESSIONS),
  { kind: 'tick', at: minutes(10) },
];

const FACTORY_OPEN: Input = { kind: 'open', params: {}, size: { width: 1440, height: 846 } };

const factoryTree = (...inputs: Input[]): Node => {
  let held = step(LIVE_FACTORY, LIVE_FACTORY.init, FACTORY_OPEN);

  for (const input of [...factoryInputs(), ...inputs]) held = step(LIVE_FACTORY, held.state, input);

  return held.tree;
};

/**
 * The factory screen with Command mode over it, routed as the bridge routes them (a screen's
 * menu and dialog to Command mode, its choices back): the top layer after `inputs`.
 */
const cardLayer = (...inputs: Input[]): Node => {
  let held = step(LIVE_FACTORY, LIVE_FACTORY.init, {
    ...FACTORY_OPEN,
    params: { root: '/home/me/projects/demo-shop' },
  });
  const layer = mountLayer(commandMode(WORDS));
  const perform = (commands: readonly Command[]) => {
    for (const c of commands)
      if (
        c.kind === 'menu' ||
        c.kind === 'dialog' ||
        c.kind === 'comment' ||
        c.kind === 'launch' ||
        c.kind === 'confirm'
      )
        perform(layer.send(c));
      else if (c.kind === 'choice') {
        held = step(LIVE_FACTORY, held.state, c);
        perform(held.commands);
      }
  };

  for (const input of [...factoryInputs(), ...inputs])
    if (
      ((input.kind === 'key' || input.kind === 'text') && layer.tree !== undefined) ||
      (input.kind === 'result' &&
        (input.id.startsWith('comment:') ||
          input.id.startsWith('launch:standing:') ||
          input.id.startsWith('launch:workflows:') ||
          input.id.startsWith('launch:reach-')))
    )
      perform(layer.send(input));
    else {
      held = step(LIVE_FACTORY, held.state, input);
      perform(held.commands);
    }
  if (layer.tree === undefined) throw new Error('no layer up');

  return layer.tree;
};

/**
 * A story dialog in Command mode, as Welcome's Open story opens it: the
 * card's facts from the overview's demo (`theirs`: Team's view, not on Mine), its Sheets and what
 * `card show` read, then `inputs`.
 */
const storyLayer = (
  card: number,
  o: { theirs?: boolean; sheets?: DialogSheets; read?: StoryRead } = {},
  ...inputs: Input[]
): Node => {
  const data = TEAM.find((c) => c.id === card) ?? listCard(card, '', '');
  const run = RUNS.find((r) => r.card === card);
  const x = SESSIONS.find((y) => y.card === card);
  const f: StoryFacts = {
    card: data,
    ...(run === undefined ? {} : { run }),
    ...(x === undefined ? {} : { session: x }),
    mine: o.theirs !== true,
    root: '/home/me/projects/demo-shop',
    sprint: 'Sprint 14',
    now: Date.parse(minutes(10)),
  };
  const { dialog, lines } = storyDialog(f, o.sheets, o.read ?? {}, minutes(10));
  const layer = mountLayer(commandMode(WORDS));

  layer.send({ kind: 'dialog', id: dialog.id ?? `dialog:${card}`, dialog, lines });
  for (const input of inputs) layer.send(input);
  if (layer.tree === undefined) throw new Error('no story dialog up');

  return layer.tree;
};

/** The Card page on `card`, from the Board, its reads answered from the overview's demo, then `inputs`. */
const cardPageTree = (card: number, comments: boolean, ...inputs: Input[]): Node => {
  const data = TEAM.find((c) => c.id === card) ?? listCard(card, '', '');
  let held = step(LIVE_CARD, LIVE_CARD.init, {
    kind: 'open',
    params: { card: String(card), from: 'board', root: '/home/me/projects/demo-shop' },
    size: { width: 1440, height: 846 },
  });
  const answers: Input[] = [
    { kind: 'tick', at: minutes(10) },
    {
      kind: 'result',
      id: `card-show:${card}`,
      command: 'card show',
      reply: {
        ok: true,
        data: { ...data, sheets: [], comments: comments ? STORY_COMMENTS : [] },
      },
    },
    { ...sessionsAnswer(SESSIONS), id: 'sessions' },
    runsAnswer(RUNS, `run:${card}`),
    {
      kind: 'result',
      id: 'members',
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
    },
  ];

  for (const input of [...answers, ...inputs]) held = step(LIVE_CARD, held.state, input);

  return held.tree;
};

/** ⌃L's Linked on #2 in Command mode: read (or still reading), then `inputs`. */
const linkedTree = (read: boolean, ...inputs: Input[]): Node => {
  const layer = mountLayer(commandMode(WORDS));

  layer.send({ kind: 'tick', at: LINKED_ENV.now });
  layer.send({ kind: 'jump', to: 'linked', story: LINKED_STORY });
  if (read)
    layer.send({
      kind: 'result',
      id: 'linked:2:1',
      command: 'story linked',
      reply: { ok: true, data: linkedOf(LINKED_PARTS, LINKED_ENV) },
    });
  for (const input of inputs) layer.send(input);
  if (layer.tree === undefined) throw new Error('no Linked up');

  return layer.tree;
};

/** Keys the shell's test types on the overview, and the tree after each (the first: before any). */
const REPLAY_KEYS = ['ä', 'ö', 'ä', 'ä', 'k', 'k', '<Tab>'];

const replay = (): Node[] => {
  let held = step(LIVE_FACTORY, LIVE_FACTORY.init, FACTORY_OPEN);

  for (const input of factoryInputs()) held = step(LIVE_FACTORY, held.state, input);
  const trees = [held.tree];

  for (const key of REPLAY_KEYS) {
    held = step(LIVE_FACTORY, held.state, { kind: 'key', key });
    trees.push(held.tree);
  }

  return trees;
};

const key = (k: string): Input => ({ kind: 'key', key: k });

/**
 * The rules with Box owner drawn as a secret: no setting holds a token today, so the secret
 * field's tree shows one on a row that exists.
 */
const SECRET_RULES: typeof SETTINGS_RULES = {
  ...SETTINGS_RULES,
  page: (id) => {
    const page = SETTINGS_RULES.page(id);

    return {
      ...page,
      rows: page.rows.map((r) => (r.key === 'box.owner' ? { ...r, control: 'secret' } : r)),
    };
  },
};

/** A setting no typed editor knows (Advanced stays for those): View tweaks drawn as its JSON. */
const ADVANCED_RULES: typeof SETTINGS_RULES = {
  ...SETTINGS_RULES,
  page: (id) => {
    const page = SETTINGS_RULES.page(id);

    return {
      ...page,
      rows: page.rows.map((r) => (r.key === 'views' ? { ...r, control: 'advanced' } : r)),
    };
  },
};

const click = (id: string): Input => ({ kind: 'click', id });

/** `:show cart` on #1234 answered (#79): its Sheet as a tab in the Board's place. */
const SHEET_SHOWN: Input[] = [
  click('card:1234'),
  { kind: 'choice', menu: 'show', row: 'cart' },
  sheetFindAnswer('cart', [
    sheetSummary('cart-totals-by-market-a1b2c3', 'Cart totals by market', {
      card: 1234,
      session: 's1234',
    }),
  ]),
  sheetOpenAnswer('cart-totals-by-market-a1b2c3', 'Cart totals by market'),
];
const CARD_SHEETS = [
  cardSheet(1234, 'cart-totals-by-market-a1b2c3', 'Cart totals by market', { version: 2 }),
  cardSheet(1234, 'prototype-v3-c4d5e6', 'Prototype v3', { at: minutes(8) }),
];
const card1234 = MINE.find((c) => c.id === 1234) ?? listCard(1234, '', '');

/** #238: the story's image, and where `card images` kept it (the app's test writes a PNG there). */
const STORY_IMAGE =
  'https://dev.azure.com/demo-org/demo-shop/_apis/wit/attachments/5e0c7a3b?fileName=cart.png';
const STORY_IMAGE_FILE = '/abe-contract/images/cart.png';
/** #1234's comments: one with an image. */
const STORY_COMMENTS = [
  {
    id: 7,
    by: 'Sam Sample',
    at: '2026-10-20T09:05:00.000Z',
    text: 'Shipping is added **twice** at checkout.',
  },
  {
    id: 8,
    by: 'Alex Example',
    at: '2026-10-21T14:30:00.000Z',
    text: `How it looks:\n\n![cart.png](${STORY_IMAGE})`,
  },
];

/** What the story's `card show` and `card images` read: its comments, its image as a file. */
const STORY_SHOWN: StoryRead = {
  text: {
    description: card1234.description,
    acceptanceCriteria: card1234.acceptanceCriteria,
  },
  comments: STORY_COMMENTS,
  images: { [STORY_IMAGE]: STORY_IMAGE_FILE },
};

/** A live prototype, as `prototype list` has it. */
const PROTOTYPE_LIVE = prototype('live');
/** The repo's Abe chat in the main checkout's Chat column. */
const HUB_SESSION: SessionData = {
  ...session('abe-a1b2', 'waiting', 1),
  card: null,
  abe: { repo: '/home/me/projects/demo-shop' },
  kind: 'abe',
  title: 'Abe · demo-shop',
  repo: '/home/me/projects/demo-shop',
  worktree: '/home/me/projects/demo-shop',
  branch: '',
};

/** The main checkout's Chat column: the Abe chat (`sessions`), or none yet. */
const hubTree = (sessions: SessionData[]): Node =>
  chatTree({ root: '/home/me/projects/demo-shop' }, sessionsAnswer(sessions), runsAnswer([]), {
    kind: 'result',
    id: 'transcript',
    command: 'session transcript',
    reply: { ok: true, data: { session: 'abe-a1b2', from: 0, entries: [] } },
  });

/**
 * The Settings dialog (#108) after it opened on the demo shop's Layers (`clean`: no problems) and
 * `inputs`; `down`: serve not answering.
 */
const settingsTree = (
  o: {
    clean?: boolean;
    down?: boolean;
    params?: Record<string, string>;
    layers?: readonly LayerSource[];
    rules?: typeof SETTINGS_RULES;
  },
  ...inputs: Input[]
): Node => {
  const layers = o.layers ?? (o.clean === true ? CLEAN_LAYERS : DEMO_LAYERS);
  const layer = mountLayer(settingsLayer(o.rules ?? SETTINGS_RULES));

  layer.send({ kind: 'open', params: o.params ?? {}, size: { width: 1440, height: 900 } });
  if (o.down === true)
    layer.send({
      kind: 'result',
      id: 'settings:list:1',
      command: 'settings list',
      reply: {
        ok: false,
        error: { code: 'serve-unreachable', message: 'abe serve is not answering' },
      },
    });
  else {
    layer.send(settingsListAnswer('settings:list:1', settingsList(layers)));
    layer.send(
      settingsProblemsAnswer('settings:problems:2', settingsProblemsData(layers, o.clean !== true)),
    );
  }
  for (const input of inputs) layer.send(input);
  if (layer.tree === undefined) throw new Error('the dialog closed');

  return layer.tree;
};

/** One tree per screen state the tests cover, by file name. */
/** The pane's `boxes` screen (#104 S2) on board X-Boxes' clock, then `inputs`. */
const boxesTree = (...inputs: Input[]): Node => {
  let held = step(LIVE_BOXES, LIVE_BOXES.init, {
    kind: 'open',
    params: {},
    size: { width: 1400, height: 280 },
  });

  for (const input of [{ kind: 'tick' as const, at: X_BOXES.now }, ...inputs])
    held = step(LIVE_BOXES, held.state, input);

  return held.tree;
};

/**
 * The box menu (#104 S3, board X-BoxMenu) in Command mode: ⌘⏎ on `box` of the Boxes tab, then
 * `keys` there; what Command mode hands back goes to the screen, the screen's menus to it.
 */
const boxMenuTree = (boxes: BoxData[], box: string, ...keys: string[]): Node =>
  menuTreeAfter([boxesAnswer(boxes)], box, ...keys);

/** The box menu after `answers` (`box list`'s, `port list`'s, …): ⌘⏎ on the row `box` names. */
const menuTreeAfter = (answers: Input[], box: string, ...keys: string[]): Node => {
  let held = step(boxesScreen, boxesScreen.init, {
    kind: 'open',
    params: { box },
    size: { width: 1400, height: 280 },
  });
  const layer = mountLayer(commandMode(WORDS));
  const perform = (commands: readonly Command[]) => {
    for (const c of commands)
      if (c.kind === 'menu' || c.kind === 'confirm') perform(layer.send(c));
      else if (c.kind === 'choice') {
        held = step(boxesScreen, held.state, c);
        perform(held.commands);
      }
  };

  for (const input of [{ kind: 'tick' as const, at: X_BOXES.now }, ...answers])
    held = step(boxesScreen, held.state, input);
  held = step(boxesScreen, held.state, key('<D-CR>'));
  perform(held.commands);
  for (const k of keys) perform(layer.send(key(k)));
  if (layer.tree === undefined) throw new Error('no layer up');

  return layer.tree;
};

/** #16: a repo's box with two workspaces, each with dev servers listening. */
const PORTS_BOX: BoxData = {
  ...X_BOXES.running,
  name: 'demo-shop',
  workspaces: [X_BOXES.ws(101, 'mkdir-swe/demo-shop'), X_BOXES.ws(102, 'mkdir-swe/demo-shop')],
};

/** `port list` (#16): #101's 3000 open on 3001, #102's 3000 asleep, #101's 5173 and #102's 8080 offered. */
const PORTS_ANSWER: Input = {
  kind: 'result',
  id: 'boxes:ports',
  command: 'port list',
  reply: {
    ok: true,
    data: {
      forwards: [
        {
          box: 'demo-shop',
          card: '101',
          port: 3000,
          local: 3001,
          state: 'open',
          fixed: false,
          note: 'localhost:3000 was taken',
          since: X_BOXES.now,
        },
        {
          box: 'demo-shop',
          card: '102',
          port: 3000,
          local: 3000,
          state: 'asleep',
          fixed: false,
          since: X_BOXES.now,
        },
      ],
      offered: [
        { box: 'demo-shop', card: '101', port: 5173, fixed: false },
        { box: 'demo-shop', card: '102', port: 8080, fixed: true },
      ],
      unread: [],
    },
  },
};

/** Command mode's `:` line from where it was opened (#346): `here`, `:`, the table, `keys`. */
const lineTree = (here: Extract<Input, { kind: 'here' }>, ...keys: string[]): Node => {
  const layer = mountLayer(commandMode(WORDS));

  layer.send(here);
  layer.send(key(':'));
  layer.send(helpAnswer());
  for (const k of keys) layer.send(key(k));
  if (layer.tree === undefined) throw new Error('no layer up');

  return layer.tree;
};

/** What a screen tells `:` (#346) as the bridge words it: serve answering, the project shown. */
const hereOf = (here: Here): Extract<Input, { kind: 'here' }> => ({
  kind: 'here',
  here,
  serving: true,
  project: 'demo-shop',
});

/** The Board on the overview's demo after `inputs`: what it tells `:` (#346). */
const boardHere = (...inputs: Input[]): Here => {
  let held = step(LIVE_FACTORY, LIVE_FACTORY.init, {
    ...FACTORY_OPEN,
    params: { root: '/home/me/projects/demo-shop' },
  });

  for (const input of [...factoryInputs(), ...inputs]) held = step(LIVE_FACTORY, held.state, input);

  return LIVE_FACTORY.here?.(held.state) ?? {};
};

/** The Boxes tab on board X-Boxes with `box` selected: what it tells `:` (#346). */
const boxHere = (boxes: BoxData[], box: string): Here => {
  let held = step(boxesScreen, boxesScreen.init, {
    kind: 'open',
    params: { box },
    size: { width: 1400, height: 280 },
  });

  for (const input of [{ kind: 'tick' as const, at: X_BOXES.now }, boxesAnswer(boxes)])
    held = step(boxesScreen, held.state, input);

  return boxesScreen.here?.(held.state) ?? {};
};

/** The words typed one key each, a space as `<Space>`. */
const keysOf = (text: string): string[] => Array.from(text, (c) => (c === ' ' ? '<Space>' : c));

/** A prototype chat's turn (#350): two changes written and added, then its words. */
const PROTO_ENTRIES: TranscriptEntry[] = (() => {
  const t = (s: number) => `2026-10-24T10:00:${String(s).padStart(2, '0')}.000Z`;
  const dir = '/cache/abe/prototype-chats/proto-1a2b3c';
  const write = (id: string, file: string, content: string, s: number): TranscriptEntry[] => [
    {
      kind: 'tool-use',
      id,
      at: t(s),
      agent: null,
      tool: 'Write',
      input: { file_path: `${dir}/${file}`, content },
    },
    { kind: 'tool-result', id, at: t(s), agent: null, ok: true, text: 'ok', cut: 0, patch: null },
  ];
  const add = (id: string, command: string, said: string, s: number): TranscriptEntry[] => [
    { kind: 'tool-use', id, at: t(s), agent: null, tool: 'Bash', input: { command } },
    { kind: 'tool-result', id, at: t(s), agent: null, ok: true, text: said, cut: 0, patch: null },
  ];

  return [
    {
      kind: 'user',
      id: 'u1',
      at: t(0),
      agent: null,
      text: 'make the Buy button green',
      context: null,
    },
    ...write('w1', '1.css', '.buy { background: #34c759 }\n', 1),
    ...add(
      'b1',
      'abe prototype change add --kind css --file 1.css --what "the Buy button in green" --target .buy --id proto-1a2b3c',
      'change 1 (css) on proto-1a2b3c: the Buy button in green\n',
      2,
    ),
    ...write('w2', '9.js', "document.title = 'Hello'\n", 3),
    ...add(
      'b2',
      'abe prototype change add --kind js --file 9.js --what "the title says Hello" --target h1 --id proto-1a2b3c',
      'change 9 (js) on proto-1a2b3c: the title says Hello\n',
      4,
    ),
    {
      kind: 'assistant-text',
      id: 'a1',
      at: t(5),
      agent: null,
      text: 'Change 1: the Buy button is green.',
    },
  ];
})();

/**
 * The New card dialog (#346) as the Board opens it on the overview's demo (`:new <title>`), keyed
 * in Command mode; each run it starts answered in turn by `answers`.
 */
const newCardTree = (
  title: string,
  keys: readonly string[],
  answers: readonly ((id: string) => Input)[] = [],
): Node => {
  let held = step(LIVE_FACTORY, LIVE_FACTORY.init, FACTORY_OPEN);

  for (const input of [
    ...factoryInputs(),
    { kind: 'choice' as const, menu: 'newcard', row: 'open', values: [title] },
  ])
    held = step(LIVE_FACTORY, held.state, input);
  const on = held.commands.find((c) => c.kind === 'newcard');

  if (on?.kind !== 'newcard') throw new Error('the Board opened no New card dialog');
  const layer = mountLayer(commandMode(WORDS));
  const pending = [...answers];

  layer.send(on);
  for (const k of keys) {
    const run = layer.send(key(k)).find((c) => c.kind === 'run');
    const answer = pending.shift();

    if (run?.kind === 'run' && answer !== undefined) layer.send(answer(run.id));
    else if (answer !== undefined) pending.unshift(answer);
  }
  if (layer.tree === undefined) throw new Error('no layer up');

  return layer.tree;
};

const DRAFTED = (id: string): Input => ({
  kind: 'result',
  id,
  command: 'card draft',
  reply: {
    ok: true,
    data: {
      title: 'Customers can save a wishlist',
      why: 'Shoppers lose the products they liked between visits.',
      what: 'A heart on each product saves it; the wishlist page lists what was saved.',
      criteria: ['A heart on a product saves it', 'The wishlist lists every saved product'],
    },
  },
});

/** The Chat slot's `chat` screen (#119) opened on `params`, then the sessions and runs read. */
const chatTree = (params: Record<string, string>, ...inputs: Input[]): Node => {
  let held = step(LIVE_CHAT, LIVE_CHAT.init, {
    kind: 'open',
    params,
    size: { width: 420, height: 800 },
  });

  for (const input of inputs) held = step(LIVE_CHAT, held.state, input);

  return held.tree;
};

/** A teammate's install, under way: one part of each state, the optional one never checked. */
const INSTALL_VIEW: InstallView = {
  repo: 'mkdir-swe/demo-shop',
  join: true,
  session: { id: 'abe-i1a2', state: 'waiting' },
  parts: [
    {
      id: 'logins',
      required: true,
      state: 'pass',
      line: 'gh as ada and aws answer; az not needed for a GitHub board.',
      checkedAt: '2026-10-28T09:00:00.000Z',
    },
    {
      id: 'board',
      required: true,
      state: 'warn',
      line: 'abe.yaml names GitHub Projects, which has no cards yet.',
      checkedAt: '2026-10-28T09:00:00.000Z',
    },
    { id: 'sources', required: false, state: 'todo', line: null, checkedAt: null },
    {
      id: 'env-files',
      required: true,
      state: 'fail',
      line: '.abe/abe.test.env is missing: env-map writes it from web/.env.test.',
      checkedAt: '2026-10-28T09:01:00.000Z',
    },
    { id: 'checks', required: true, state: 'todo', line: null, checkedAt: null },
    { id: 'done', required: true, state: 'todo', line: null, checkedAt: null },
  ],
  done: false,
  files: [
    'abe.yaml',
    'CLAUDE.md',
    '.claude/skills/demo-shop-testing/SKILL.md',
    '.abe/abe.dev.env',
    '.abe/settings.local.yaml',
  ],
};

/**
 * `:install` (#71): Chat on the Abe chat, the install's strip under its header: its marks alone
 * (420) or named, then what a click unfolds under it.
 */
const installTree = (width: number, ...clicks: string[]): Node =>
  chatTree(
    { install: '1' },
    {
      kind: 'result',
      id: 'chat:install',
      command: 'install',
      reply: { ok: true, data: INSTALL_VIEW },
    },
    sessionsAnswer([
      {
        ...session('abe-i1a2', 'waiting'),
        card: null,
        kind: 'abe',
        title: 'Abe · demo-shop',
        abe: { repo: 'mkdir-swe/demo-shop' },
      },
    ]),
    runsAnswer([]),
    {
      kind: 'result',
      id: 'transcript',
      command: 'session transcript',
      reply: { ok: true, data: { session: 'abe-i1a2', from: 0, entries: [] } },
    },
    { kind: 'resize', size: { width, height: 800 } },
    ...clicks.map((id): Input => ({ kind: 'click', id })),
  );

/** The Chat column on the Factory view's card, over the overview's runs and sessions. */
const columnTree = (card: number, ...inputs: Input[]): Node =>
  chatTree({ card: String(card) }, sessionsAnswer(SESSIONS), runsAnswer(RUNS), ...inputs);

const CHAT_SESSIONS = [
  {
    ...session('s1240', 'working', 1240),
    worktree: '/home/me/projects/demo-shop-wt/1240-cart-total',
  },
];
const CHAT_RUNS = [
  factoryRun(1240, 'Cart total includes shipping', 'build', 'running', {
    session: 's1240',
    worktree: '/home/me/projects/demo-shop-wt/1240-cart-total',
  }),
];

/** #113 t113d: a real session's transcript (slice t113b's run, redacted) as its events came. */
const REPLAY_ROOT = '/home/me/projects/demo-shop-wt/2-the-cart-total-ignores-quantity';
const REPLAY_SESSION: SessionData = {
  ...session('2-1e65', 'working', 2),
  title: 'The cart total ignores quantity',
  worktree: REPLAY_ROOT,
  branch: 'card/2-the-cart-total-ignores-quantity',
  since: '2026-10-24T01:42:31.000Z',
  startedAt: '2026-10-24T01:42:31.000Z',
};
const REPLAY_RUN = factoryRun(2, 'The cart total ignores quantity', 'build', 'running', {
  session: '2-1e65',
  worktree: REPLAY_ROOT,
  since: '2026-10-24T01:42:31.000Z',
  stages: [
    {
      stage: 'spec',
      startedAt: '2026-10-24T01:30:00.000Z',
      endedAt: '2026-10-24T01:42:00.000Z',
      durationMs: 720_000,
      report: null,
    },
  ],
});
const ReplayLine = z.object({
  data: z.object({ from: z.number().int(), entries: z.array(TranscriptEntry) }),
});
const transcriptReplay = (): Input[] =>
  readFileSync(join(import.meta.dir, 'fixtures', 'transcript-replay.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => ReplayLine.parse(JSON.parse(l)).data)
    .map((d): Input => ({
      kind: 'event',
      event: {
        seq: 1,
        at: '2026-10-24T01:50:00.000Z',
        type: 'session.transcript',
        data: { session: '2-1e65', ...d },
      },
    }));
/** The rendered Chat on the replayed session: read, then the keys given. */
const renderedTree = (
  o: {
    session?: SessionData;
    run?: FactoryRunData;
    whose?: string;
    keys?: string[];
    read?: 'ok' | 'unreadable';
  } = {},
): Node => {
  const s = o.session ?? REPLAY_SESSION;
  const read: Input =
    o.read === 'unreadable'
      ? {
          kind: 'result',
          id: 'transcript',
          command: 'session transcript',
          reply: {
            ok: false,
            error: { code: 'transcript-unreadable', message: 'not readable here' },
          },
        }
      : {
          kind: 'result',
          id: 'transcript',
          command: 'session transcript',
          reply: { ok: true, data: { session: s.id, from: 0, entries: [] } },
        };

  return chatTree(
    { root: REPLAY_ROOT },
    sessionsAnswer([s]),
    runsAnswer([o.run ?? REPLAY_RUN]),
    // a teammate's story: not in your Mine, assigned to them (the session pinned is yours, #306)
    ...(o.whose === undefined ? [] : theirsAnswers(REPLAY_RUN.card, o.whose, REPLAY_RUN.title)),
    { kind: 'tick', at: '2026-10-24T02:03:31.000Z' },
    read,
    ...(o.read === 'unreadable' ? [] : transcriptReplay()),
    ...(o.keys ?? []).map((key): Input => ({ kind: 'key', key })),
  );
};

/** Welcome (#212, board W-Welcome): two recent projects, then `inputs`. */
const WELCOME_PROJECTS = [
  {
    name: 'demo-shop',
    path: '/home/me/projects/demo-shop',
    shown: '~/projects/demo-shop',
    initials: 'DS',
    branch: 'main',
  },
  {
    name: 'vimstorm',
    path: '/home/me/projects/vimstorm',
    shown: '~/projects/vimstorm',
    initials: 'V',
    branch: 'abe',
  },
];
const welcomeHeld = (...inputs: Input[]) => {
  let held = step(LIVE_WELCOME, LIVE_WELCOME.init, {
    kind: 'open',
    params: { [PROJECTS_PARAM]: JSON.stringify(WELCOME_PROJECTS) },
    size: { width: 1000, height: 616 },
  });

  for (const input of inputs) held = step(LIVE_WELCOME, held.state, input);

  return { ...held, state: held.state.screen };
};
const welcomeTree = (...inputs: Input[]): Node => welcomeHeld(...inputs).tree;
const WELCOME_MINE = [
  listCard(101, 'Cart total rounds wrong', 'Active'),
  listCard(102, 'Count each line’s qty', 'Active'),
  listCard(103, 'Show stock on a product page', 'Active'),
  listCard(104, 'Saved carts survive sign-out', 'New'),
];
const WELCOME_RUNS = [
  factoryRun(101, 'Cart total rounds wrong', 'build', 'needs-you', {
    repo: '/home/me/projects/demo-shop',
  }),
  factoryRun(103, 'Show stock on a product page', 'build', 'running', {
    repo: '/home/me/projects/demo-shop',
  }),
  factoryRun(201, 'Their question', 'spec', 'needs-you', { repo: '/home/me/projects/demo-shop' }),
];
const WELCOME_SESSIONS = [
  { ...session('s101', 'waiting', 101), repo: '/home/me/projects/demo-shop' },
  { ...session('s103', 'working', 103), repo: '/home/me/projects/demo-shop' },
  { ...session('s201', 'waiting', 201), repo: '/home/me/projects/demo-shop' },
];
const WELCOME_READ: Input[] = [
  cardsAnswer(WELCOME_MINE, true),
  cardsAnswer([...WELCOME_MINE, listCard(201, 'Their question', 'Active', 'Bo Teammate')], false),
  runsAnswer(WELCOME_RUNS),
  sessionsAnswer(WELCOME_SESSIONS),
  { kind: 'tick', at: minutes(20) },
];
/** Welcome's stripe as the screen sends it once read (#3). */
const WELCOME_STRIPE = {
  kind: 'stripe' as const,
  items: welcomeStripe(welcomeHeld(...WELCOME_READ).state),
  gear: stripeGear(undefined),
};
/** Welcome's ⌘⏎ on its first card (or `then`: the stripe's right-click), as Command mode draws the menu. */
const welcomeMenu = (then: Input = key('<D-CR>')): Node => {
  const layer = mountLayer(commandMode(WORDS));
  const menu = welcomeHeld(...WELCOME_READ, then).commands.find((c) => c.kind === 'menu');

  if (menu?.kind !== 'menu') throw new Error('no menu');
  layer.send(menu);
  if (layer.tree === undefined) throw new Error('no menu layer');

  return layer.tree;
};

/** The pane's `sessions` screen (#107) on board F-Sessions' sprint, then `inputs`. */
const sessionsTree = (params: Record<string, string>, ...inputs: Input[]): Node => {
  let held = step(LIVE_SESSIONS, LIVE_SESSIONS.init, {
    kind: 'open',
    params,
    size: { width: 1020, height: 280 },
  });

  for (const input of inputs) held = step(LIVE_SESSIONS, held.state, input);

  return held.tree;
};
const SPRINT: Input[] = [
  sessionsAnswer(F_SESSIONS.sessions),
  runsAnswer(F_SESSIONS.runs),
  cardsAnswer(F_SESSIONS.cards, false, 'Sprint 1'),
  { kind: 'tick', at: F_SESSIONS.now },
];

/** Every prop of the Table (#107, shared with #104's Boxes): X-Boxes' rows and the cloud's looks. */
const TABLE_BOXES: Node = {
  kind: 'Island',
  id: 'boxes',
  props: {},
  children: [
    {
      kind: 'Table',
      id: 'boxes-table',
      props: {
        columns: [
          { label: 'Box', width: { fixed: 140 } },
          { label: 'Story', width: { fixed: 220 } },
          { label: 'State', width: { fixed: 100 } },
          { label: 'Size', width: { fixed: 90 } },
          { label: 'Up', width: { fixed: 90 }, align: 'end' },
          { label: 'Cost', width: { fixed: 100 }, align: 'end' },
          { label: 'Until', width: { flex: 1 } },
        ],
        rows: [
          {
            id: 'box:demo-shop-1',
            cells: [
              { cloud: 'running', text: 'demo-shop-1', tooltip: 'Box demo-shop-1 · running' },
              { accent: '#1', text: 'Show stock on a product card', hue: 'dim' },
              { mark: '●', text: 'running', hue: 'warn' },
              { text: 'm7g.large', hue: 'dim' },
              { text: '1 h 12 min' },
              { text: '$0.21', tooltip: 'today since 00:00 · on-demand estimate' },
              { text: 'stops at 01:30', hue: 'dim' },
            ],
          },
          {
            id: 'box:demo-shop-2',
            hue: 'bad',
            cells: [
              { cloud: 'starting', text: 'demo-shop-2' },
              { accent: '#2', text: 'The cart total ignores quantity', hue: 'dim' },
              { mark: '●', text: 'starting · 6 min', hue: 'bad' },
              { text: 'm7g.large', hue: 'dim' },
              { text: '6 min' },
              { text: '$0.01' },
              { text: '—', hue: 'dim' },
            ],
          },
          {
            id: 'box:demo-shop-3',
            cells: [
              { cloud: 'asleep', text: 'demo-shop-3' },
              { accent: '#3', text: 'Pin the Node version', hue: 'dim' },
              { mark: '○', text: 'asleep', hue: 'dim' },
              { text: 'm7g.large', hue: 'dim' },
              { text: '—', hue: 'dim' },
              { text: '$0.84 today' },
              { text: '—', hue: 'dim' },
            ],
          },
          {
            id: 'box:4',
            cells: [{ rail: ['done', 'need', 'todo', 'todo', 'todo'], text: 'Build' }],
          },
          { cells: [{ text: 'Box sessions not read: AWS login expired', hue: 'dim' }] },
        ],
        selected: 'box:demo-shop-1',
        note: 'Boxes not read · EC2 not answering',
        foot: [
          { keys: '⏎', label: 'attach' },
          { keys: '⌘⏎', label: 'actions' },
        ],
      },
    },
  ],
};

/** A prototype session's code, on this Mac. */
const PROTO_CODE = {
  session: 'prototype-a1b2',
  branch: 'proto/p7-cart-badge',
  worktree: '/home/me/projects/demo-shop-wt/proto-p7-cart-badge',
  box: null,
  spec: null,
  stored: null,
  commented: false,
  sent: null,
  made: null,
  ended: false,
};

/** The `prototype` screen on `page`, `prototype list` answering with `p`, then `inputs`. */
const prototypeTree = (
  page: 'preview' | 'code' | 'logs',
  p: ReturnType<typeof prototype>,
  ...inputs: Input[]
): Node => {
  let held = step(prototypeScreen, prototypeScreen.init, {
    kind: 'open',
    params: { id: p.id, page },
    size: { width: 1180, height: 760 },
  });

  for (const input of [
    { kind: 'tick' as const, at: minutes(10) },
    {
      kind: 'result' as const,
      id: 'proto-list',
      command: 'prototype list' as const,
      reply: { ok: true as const, data: { prototypes: [p] } },
    },
    ...inputs,
  ])
    held = step(prototypeScreen, held.state, input);

  return held.tree;
};

/** `prototype show` of the cart badge prototype. */
const PROTO_SHOW: Input = {
  kind: 'result',
  id: 'proto-show',
  command: 'prototype show',
  reply: {
    ok: true,
    data: {
      id: 'proto-1a2b3c',
      files: [
        {
          path: 'web/src/Header.tsx',
          added: 14,
          removed: 2,
          lines: [
            '@@ -3,4 +3,9 @@',
            '   export function CartLink() {',
            '     const count = useCart().lines.length;',
            '+    const label = count > 9 ? "9+" : String(count);',
            '-    return <a href="/cart">Cart ({count})</a>;',
          ],
        },
        { path: 'web/src/cart.css', added: 9, removed: 0, lines: ['@@ -0,0 +1,9 @@', '+.badge {'] },
      ],
      cut: 0,
      noDiff: null,
      screenshots: [
        {
          n: 1,
          what: 'products page, 3 in the cart',
          path: '/home/me/.local/state/abe/prototypes/proto-1a2b3c/screenshots/1.png',
        },
      ],
      log: ['$ abe/scripts/prototype-start', '  vite v5.4.2  dev server', '  ready in 412 ms'],
      refused: [
        {
          at: '2026-10-31T09:12:04.000Z',
          method: 'GET',
          host: 'fonts.example.com',
          reason: 'fonts.example.com is not the app',
        },
      ],
    },
  },
};

const PROTO_LIVE = prototype('live', {
  card: null,
  url: 'http://127.0.0.1:41207',
  app: 'http://127.0.0.1:41230',
  code: PROTO_CODE,
  title: 'cart badge shows item count',
});

const trees = (): Record<string, Node> => ({
  // #119: the Chat slot's screen pinned to the shown workspace; no session yet; the main checkout
  'chat-pinned': chatTree(
    { root: '/home/me/projects/demo-shop-wt/1240-cart-total' },
    sessionsAnswer(CHAT_SESSIONS),
    runsAnswer(CHAT_RUNS),
  ),
  'chat-no-session': chatTree(
    {
      root: '/home/me/projects/demo-shop-wt/1-show-stock',
      branch: 'card/1-show-stock-on-a-product-card',
    },
    sessionsAnswer(CHAT_SESSIONS),
    runsAnswer(CHAT_RUNS),
    {
      kind: 'result',
      id: 'card:1',
      command: 'card show',
      reply: {
        ok: true,
        data: { ...listCard(1, 'Show stock on a product card', 'New'), comments: [], sheets: [] },
      },
    },
  ),
  // #113 t113d: the rendered Chat on a real session; the cursor on a diff card and a step
  // unfolded; ended; unreadable; your session on a teammate's card: yours (#306)
  'chat-rendered': renderedTree(),
  'chat-rendered-keys': renderedTree({ keys: ['g', 'g', 'ö', 'ö', '<CR>', 'G', '<CR>'] }),
  // find in the transcript: `vat.ts` typed, on the newest match (in the last part)
  'chat-find': renderedTree({ keys: ['/', 'v', 'a', 't', '.', 't', 's'] }),
  'chat-ended': renderedTree({ session: { ...REPLAY_SESSION, state: 'ended' } }),
  'chat-unreadable': renderedTree({ read: 'unreadable' }),
  'chat-their-card': renderedTree({ whose: 'Alex Example' }),
  // #168: the run launched under your Override: the pill on the story line
  'chat-override': renderedTree({
    run: {
      ...REPLAY_RUN,
      personal: [
        {
          key: 'autoMerge',
          value: true,
          shown: 'on',
          reason: 'my sandbox',
          since: '2026-10-24T09:30:00.000Z',
        },
      ],
    },
  }),
  'chat-no-story': chatTree(
    { root: '/home/me/projects/demo-shop', branch: 'main' },
    sessionsAnswer(CHAT_SESSIONS),
    runsAnswer(CHAT_RUNS),
  ),
  // Welcome (#212): Mine by state, Team, no cards of yours, no board yet, ⌘⏎ on a card
  welcome: welcomeTree(...WELCOME_READ),
  'welcome-team': welcomeTree(...WELCOME_READ, key('<Tab>')),
  'welcome-empty': welcomeTree(cardsAnswer([], true), runsAnswer([]), sessionsAnswer([])),
  'welcome-no-board': welcomeTree({
    kind: 'result',
    id: 'cards:mine',
    command: 'card list',
    reply: { ok: false, error: { code: 'no-board', message: 'no team yet' } },
  }),
  'welcome-menu': welcomeMenu(),
  // #3: the stripe's right-click on Welcome, in Command mode (no project's native menu there)
  'welcome-stripe-menu': welcomeMenu({ kind: 'click', id: 'widget:stripe-at:board' }),
  // #350: Prototype mode's Chat column pinned on the prototype chat (`pin`), and ⌘4 on it
  'chat-prototype': chatTree(
    { card: '1234', session: 'prototype-a1b2', title: 'Cart total includes shipping' },
    sessionsAnswer([...CHAT_SESSIONS, prototypeSession()]),
    runsAnswer(CHAT_RUNS),
    { ...prototypeListAnswer([PROTOTYPE_LIVE]), id: 'prototypes' },
  ),
  // #350: its change cards: change 1 still in, change 2 undone since; the cursor on the first
  'chat-prototype-changes': chatTree(
    { card: '1234', session: 'prototype-a1b2', title: 'Cart total includes shipping' },
    sessionsAnswer([...CHAT_SESSIONS, prototypeSession()]),
    runsAnswer(CHAT_RUNS),
    { ...prototypeListAnswer([PROTOTYPE_LIVE]), id: 'prototypes' },
    {
      kind: 'result',
      id: 'transcript',
      command: 'session transcript',
      reply: { ok: true, data: { session: 'prototype-a1b2', from: 0, entries: PROTO_ENTRIES } },
    },
    { kind: 'focus', focused: true },
    // the keys come in the composer: Esc gives them to the transcript
    key('<Esc>'),
    key('g'),
    key('g'),
    key('ö'),
  ),
  'chat-prototype-terminal': chatTree(
    { card: '1234', session: 'prototype-a1b2', mode: 'terminal' },
    sessionsAnswer([...CHAT_SESSIONS, prototypeSession()]),
    runsAnswer(CHAT_RUNS),
  ),
  // the bottom pane's Sessions tab (#107 S4): F-Sessions with #2 selected; filtered; none;
  // boxes unread; the Table's every prop, Boxes' look (#104), and its empty state
  sessions: sessionsTree({ card: '2' }, ...SPRINT),
  'sessions-filter': sessionsTree({}, ...SPRINT, ...['/', 'p', 'i', 'n'].map(key)),
  'sessions-empty': sessionsTree(
    {},
    sessionsAnswer([]),
    runsAnswer([]),
    cardsAnswer(F_SESSIONS.cards, false, 'Sprint 1'),
  ),
  'sessions-unread': sessionsTree(
    {},
    {
      kind: 'result',
      id: 'sessions',
      command: 'session list',
      reply: {
        ok: true,
        data: {
          sessions: F_SESSIONS.sessions.filter((x) => x.box === undefined),
          boxes: 'AWS login expired · aws sso login --profile abe-tooling',
        },
      },
    },
    ...SPRINT.slice(1),
  ),
  'table-boxes': TABLE_BOXES,
  'table-empty': {
    kind: 'Table',
    props: {
      columns: [{ label: 'Box', width: { flex: 1 } }],
      rows: [],
      empty: { title: 'No boxes', line: 'a story launched on a box makes one' },
    },
  },
  // the bottom pane's Boxes tab (#104 S2): X-Boxes; problems first with a Queued row; none;
  // the AWS login expired; not read again (the rows kept)
  boxes: boxesTree(boxesAnswer([X_BOXES.asleep, X_BOXES.running])),
  'boxes-problems': boxesTree(
    boxesAnswer([X_BOXES.asleep, X_BOXES.running, X_BOXES.stuck, X_BOXES.silent], [X_BOXES.queued]),
  ),
  'boxes-empty': boxesTree(boxesAnswer([])),
  // ADR 0022: a repo's box with its workspaces under it (titles read), its disk; an old box marked
  'boxes-workspaces': boxesTree(
    boxesAnswer([
      {
        ...X_BOXES.running,
        name: 'demo-shop',
        workspaces: [
          X_BOXES.ws(101, 'mkdir-swe/demo-shop'),
          X_BOXES.ws(102, 'mkdir-swe/demo-shop', 'stopped'),
        ],
        load: {
          at: X_BOXES.now,
          memory: { availableMb: 9000, totalMb: 16_000 },
          cpuPercent: 20,
          disk: { freeGb: 29, totalGb: 60 },
          workspaces: [
            { card: '101', diskGb: 4.1 },
            { card: '102', diskGb: 3.8 },
          ],
        },
      },
      X_BOXES.old,
    ]),
    cardsAnswer(
      [listCard(101, 'Show stock on cards', 'Active'), listCard(102, 'Cart total', 'Active')],
      false,
    ),
  ),
  // #16: a workspace's ports under its row: open (on another local port, said on hover), asleep
  // with its box, offered (fixed: its auth callback's)
  'boxes-ports': boxesTree(boxesAnswer([PORTS_BOX]), PORTS_ANSWER),
  'boxes-login': boxesTree({
    kind: 'result',
    id: 'boxes',
    command: 'box list',
    reply: {
      ok: false,
      error: {
        code: 'aws-auth',
        message:
          'not logged in to AWS (Token has expired): run `aws sso login --profile abe-tooling`',
        profile: 'abe-tooling',
      },
    },
  }),
  'boxes-unread': boxesTree(boxesAnswer([X_BOXES.running]), {
    kind: 'event',
    event: {
      seq: 2,
      at: X_BOXES.now,
      type: 'boxes.unread',
      data: { code: 'aws-failed', message: 'EC2 not answering' },
    },
  }),
  // #104 S3: the box menu on a running box (Keep awake first, Terminate… red with t), kept
  // awake, asleep (Wake first), Terminate…'s ask, Forward port…'s field
  'box-menu': boxMenuTree([X_BOXES.running, X_BOXES.asleep], 'demo-shop-1'),
  'box-menu-kept': boxMenuTree(
    [{ ...X_BOXES.running, idle: X_BOXES.idle(null, ['awake']) }],
    'demo-shop-1',
  ),
  'box-menu-asleep': boxMenuTree([X_BOXES.running, X_BOXES.asleep], 'demo-shop-3'),
  'box-menu-terminate': boxMenuTree([X_BOXES.running, X_BOXES.asleep], 'demo-shop-3', 't'),
  'box-menu-forward': boxMenuTree([X_BOXES.running], 'demo-shop-1', 'f', '<CR>', '3', '0'),
  // #16: a forwarded port's menu: Open in browser, Stop forwarding
  'box-menu-port': menuTreeAfter(
    [boxesAnswer([PORTS_BOX]), PORTS_ANSWER],
    'demo-shop:ws:101:port:3000',
  ),
  // the bottom pane's Pipelines tab (2.2): the overview, a run's graph and log
  ...pipelineTrees(),
  ...runTrees(),
  'factory-overview': factoryTree(),
  // #346: Mine with nothing Resolved: that column's `＋ New card`
  'factory-empty-column': factoryTree(
    cardsAnswer(
      MINE.filter((c) => c.state !== 'Resolved'),
      true,
    ),
  ),
  // #239: the sprint's done cards in Closed, dim: #1258's merged run ✓, #1245 closed by hand ✓ Done
  'factory-closed': factoryTree(
    cardsAnswer(
      [
        ...MINE.map((c) => (c.id === 1258 ? { ...c, state: 'Closed' } : c)),
        listCard(1245, 'Guest checkout keeps the basket', 'Closed', 'Alex Example'),
      ],
      true,
    ),
  ),
  // #104 S4: #1262 has no run, its box (tagged abe:card 1262) asleep: `No session` and `☁ asleep`
  'factory-boxes': factoryTree(
    boxesAnswer([X_BOXES.box('demo-shop-9', { state: 'stopped', card: 1262, serve: null })]),
  ),
  // under 200 px a column (#107): scrolled sideways to keep Resolved in view
  'factory-narrow': factoryTree({ kind: 'resize', size: { width: 600, height: 846 } }, key('ä')),
  // the narrowest a column gets (#270: the columns in view fill the Board, 200 at the least):
  // 430 px leaves 406 for two of 200, Resolved in view
  'factory-tightest': factoryTree({ kind: 'resize', size: { width: 430, height: 846 } }, key('ä')),
  // the narrowest Board, one column in view, a filter typed: the note and the columns out of
  // view share the header (#270)
  'factory-tightest-filter': factoryTree(
    { kind: 'resize', size: { width: 400, height: 846 } },
    key('/'),
    key('c'),
    key('a'),
    key('r'),
    key('t'),
  ),
  // 800 px wide: three columns fit, filling the Board; the fourth out of view and named
  'factory-800': factoryTree({ kind: 'resize', size: { width: 800, height: 846 } }),
  'factory-team': factoryTree(key('<Tab>')),
  'factory-filter': factoryTree(key('/'), key('c'), key('a'), key('r'), key('t')),
  'factory-asking': step(LIVE_FACTORY, LIVE_FACTORY.init, FACTORY_OPEN).tree,
  // Chat (#71) as the window's column draws it on the Factory view's card (2.1 #105): a local
  // session's terminal with the keys; a cloud one starting; a card with none
  'factory-chat': columnTree(1240),
  'factory-chat-starting': columnTree(1251),
  // a hard session's Chat (#87)
  'factory-chat-hard': columnTree(1258),
  // the main checkout's Chat: the repo's Abe chat (its header's line 2 its checkout), or ⏎ to
  // start it
  'chat-hub': hubTree([HUB_SESSION]),
  // two conversations open: a tab each, the other one working
  'chat-hub-tabs': hubTree([
    { ...HUB_SESSION, abe: { ...HUB_SESSION.abe, repo: HUB_SESSION.repo, name: 'Abe 1' } },
    {
      ...HUB_SESSION,
      id: 'abe-c3d4',
      state: 'working',
      startedAt: '2026-10-24T03:00:00.000Z',
      abe: { repo: HUB_SESSION.repo, name: 'why the cart total rounds wrong' },
    },
  ]),
  'chat-hub-none': hubTree([]),
  // `:install` (#71): the Abe chat and the install's strip, marks alone in the column, named wide,
  // a part's last check or the files unfolded under it
  'chat-install': installTree(420),
  'chat-install-part': installTree(900, 'install:part:env-files'),
  'chat-install-files': installTree(900, 'install:files'),
  'factory-chat-none': columnTree(1262),
  // #72, #105 Behaviour 4: Launch agent ⏎ in the column on a card with no run, then the Launch
  // box's ⏎: ● Launching…
  'factory-launching': columnTree(1262, key('<CR>'), {
    kind: 'choice',
    menu: 'launchbox:1262',
    row: 'launch',
    values: ['', '', '', ''],
  }),
  'factory-team-card': factoryTree(key('<Tab>'), click('card:1253')),
  // the Board's Sessions tab: your sessions on the sprint and the Abe chats, to read
  'factory-sessions': factoryTree(click('tab:sessions'), key('ö')),
  // the card's Action menu (⌘⏎), filtered, on a teammate's card, by a right-click; the card dialog
  'command-menu': cardLayer(click('card:1262'), key('<D-CR>')),
  'command-menu-filtered': cardLayer(
    click('card:1262'),
    key('<D-CR>'),
    key('m'),
    key('o'),
    key('v'),
  ),
  // #342 / #347: the Launch box from Launch agent, a standing note read, a note typed
  'command-launch': cardLayer(
    click('card:1262'),
    key('<D-CR>'),
    key('<PageUp>'),
    key('<CR>'),
    {
      kind: 'result',
      id: 'launch:standing:1262',
      command: 'settings explain',
      reply: {
        ok: true,
        data: {
          key: 'launch.notes',
          value: ['write the test first'],
          winner: 'individual',
          lowered: null,
          feel: 'vimstorm',
          problems: [],
          layers: [
            {
              layer: 'individual',
              file: '/home/me/.config/abe/settings.json',
              entry: 'plain',
              written: ['write the test first'],
              reason: null,
              applied: true,
            },
          ],
        },
      },
    },
    { kind: 'text', text: 'use the existing price helper' },
    key('<S-CR>'),
    { kind: 'text', text: "don't add a dependency" },
    // the card workflows read, Feature preselected (no other takes it)
    workflowsAnswer(sampleWorkflows(), 'launch:workflows:1262'),
  ),
  // another workflow picked (its on: misses the card: a warning), run local, prod on for it
  'command-launch-picked': cardLayer(
    click('card:1262'),
    key('<D-CR>'),
    key('<PageUp>'),
    key('<CR>'),
    workflowsAnswer(sampleWorkflows(), 'launch:workflows:1262'),
    key('<Up>'),
    key('<C-r>'),
    key('<C-p>'),
  ),
  'command-menu-team': cardLayer(key('<Tab>'), click('card:1253'), key('<D-CR>')),
  // #107 S2: a card that needs you on its box: Open workspace first, Launch agent dim in its place
  'command-menu-running': cardLayer(click('menu:card:1234')),
  // the story dialog (board F-Story; Welcome's Open story): a card that needs you on its box (Open
  // workspace ⏎), yours with no session (Launch agent ⏎), a teammate's (only ⌘⏎ more)
  'command-dialog': storyLayer(1234),
  'story-running': storyLayer(1234),
  'story-no-session': storyLayer(1262),
  'story-teammate': storyLayer(1253, { theirs: true }),
  // its comments oldest first, and an image `card images` read (the app's test puts a file there)
  'story-comments': storyLayer(1234, { read: STORY_SHOWN }),
  // the Card page (⏎ on a Board card with no workspace here; a workspace's ⌃3): the story as a
  // page, its comments, a comment typed in its composer
  // Design B · Tiles: a prototype's tile's pages; the phone viewport, the page loaded at /products
  'prototype-preview': prototypeTree(
    'preview',
    PROTO_LIVE,
    { kind: 'key', key: 'v' },
    {
      kind: 'key',
      key: 'v',
    },
    { kind: 'key', key: 'v' },
    {
      kind: 'browser',
      key: 'prototype:proto-1a2b3c',
      event: { kind: 'loaded', url: 'http://127.0.0.1:41207/products' },
    },
  ),
  'prototype-starting': prototypeTree(
    'preview',
    prototype('starting', {
      card: null,
      code: PROTO_CODE,
      title: 'one-page checkout',
      step: 'start',
      database: { name: 'abe_proto_9f2c', by: 'mac', seeded: true },
    }),
  ),
  'prototype-failed': prototypeTree(
    'preview',
    prototype('failed', {
      card: null,
      code: PROTO_CODE,
      reason:
        'abe/scripts/prototype-start exited 1; its last lines:\n  vite v5.4.2  dev server\nError: listen EADDRINUSE: address already in use :::3000',
    }),
  ),
  'prototype-stopped': prototypeTree(
    'preview',
    prototype('stopped', {
      card: null,
      code: PROTO_CODE,
      title: 'product grid with filters',
      since: minutes(-2 * 24 * 60),
      shot: '/home/me/.local/state/abe/prototypes/proto-1a2b3c/screenshots/1.png',
      database: { name: 'abe_proto_5a1e', by: 'mac', seeded: true },
    }),
  ),
  'prototype-code': prototypeTree('code', PROTO_LIVE, PROTO_SHOW),
  'prototype-logs': prototypeTree('logs', PROTO_LIVE, PROTO_SHOW),
  'card-page': cardPageTree(
    1234,
    true,
    key('<CR>'),
    ...Array.from('Seen it').map((ch) => key(ch === ' ' ? '<Space>' : ch)),
  ),
  // a card no one runs, the keys on Move…
  'card-page-actions': cardPageTree(1262, false, key('<Tab>'), key('<Tab>'), key('<Tab>')),
  // #109: ⌃L's Linked on #2 (board W-Linked): reading, its ten rows, `pu` typed
  'linked-loading': linkedTree(false),
  linked: linkedTree(true),
  'linked-filtered': linkedTree(true, key('p'), key('u')),
  // Local mode (#24): the band, #1240 dashed (LM-Board); its local pull request (LM-PR); Held
  // writes (LM-Held)
  'factory-local': factoryTree(localStatusAnswer(LM_VIEW)),
  'factory-local-pr': factoryTree(localStatusAnswer(LM_VIEW), {
    kind: 'choice',
    menu: 'local:held',
    row: 'held:5',
  }),
  'command-local-held': cardLayer(localStatusAnswer(LM_VIEW), click('local:held')),
  // the board read-only alone: its band, #1240 edited and commented on here (dashed); Discard
  // local changes asked
  'factory-read-only': factoryTree(localStatusAnswer(READ_ONLY_VIEW)),
  'command-discard-local': cardLayer(localStatusAnswer(READ_ONLY_VIEW), click('local:discard')),
  // a held card (made here, LC1) on the Board: dashed, `#LC1`, asking with its prototype
  'factory-local-held-card': factoryTree(
    localStatusAnswer(LM_VIEW),
    cardsAnswer(
      [
        listCard(localNumber(1), 'Gift wrap at checkout', 'New', null, {
          tags: ['prototype'],
          url: 'local:LC1',
        }),
        ...MINE,
      ],
      true,
    ),
  ),
  // the CommentBox (a card's Comment…): its thread read, an answer typed
  'command-comment': cardLayer(
    click('card:1262'),
    key('<D-CR>'),
    ...Array.from('Com').map((ch) => key(ch)),
    key('<CR>'),
    {
      kind: 'result',
      id: 'comment:thread:1262',
      command: 'card show',
      reply: {
        ok: true,
        data: {
          ...(MINE.find((c) => c.id === 1262) ?? listCard(1262, 'x', 'New')),
          tags: ['needs-info'],
          sheets: [],
          comments: [
            {
              id: 41,
              by: 'Abe',
              at: '2026-10-22T15:41:00Z',
              text: '> *This was generated by AI during triage.*\n\n## Triage notes\n\n**Needs info:** no criterion for two devices\n\n**What we still need from you:**\n\n- "The last one" on which device?',
            },
          ],
        },
      },
    },
    ...Array.from('The phone wins.').map((ch) => key(ch === ' ' ? '<Space>' : ch)),
    key('<S-CR>'),
    ...Array.from('Say so').map((ch) => key(ch === ' ' ? '<Space>' : ch)),
  ),
  'command-dialog-scrolled': storyLayer(1234, {}, key('ö'), key('ö')),
  // #79: a Sheet as a tab, its page with the keys; the card dialog's Sheets, a row with the keys
  'factory-sheet': factoryTree(...SHEET_SHOWN),
  'factory-sheet-focused': factoryTree(...SHEET_SHOWN, key('<CR>')),
  'command-dialog-sheets': storyLayer(
    1234,
    { sheets: dialogSheets(1234, CARD_SHEETS), read: { comments: [] } },
    key('<Tab>'),
    key('ö'),
  ),
  'command-dialog-sheets-error': storyLayer(1234, {
    sheets: { rows: [], state: 'error', message: 'no org store is set up' },
    read: { error: 'no org store is set up' },
  }),
  'status-asking': statusTree(),
  'status-unreachable': statusTree({
    kind: 'result',
    id: 'status',
    command: 'status',
    reply: {
      ok: false,
      error: {
        code: 'serve-unreachable',
        message: 'no abe serve answers on /state/abe/serve.sock',
      },
    },
  }),
  'status-no-sessions': statusTree(statusAnswer({ ...STATUS, sessions: 0 }), sessionsAnswer([])),
  'status-sessions': statusTree(
    statusAnswer({ ...STATUS, sessions: 3 }),
    sessionsAnswer([
      session('s1', 'waiting', 12),
      session('s2', 'working', 14),
      session('s3', 'ended', 9),
    ]),
  ),
  'command-loading': commandTree('!loading'),
  'command-pick': commandTree('c a r d <Down>'),
  // #346: the `:` line on the Board's card (its next step first), on a box, a sentence asked,
  // an Ex command typed in the Editor
  'command-subject-card': lineTree(hereOf(boardHere(click('card:1234')))),
  'command-subject-box': lineTree(
    hereOf(boxHere([X_BOXES.running, X_BOXES.asleep], 'demo-shop-1')),
  ),
  'command-ask': lineTree(
    hereOf(boardHere(click('card:1234'))),
    ...keysOf('why does the cart total ignore quantity'),
  ),
  // the Editor's `:` as the app says it (`editor-here`): the caret's items, Neovim's Ex names
  'command-editor-ex': lineTree(
    editorHere(
      {
        ex: ['write', 'wq', 'quit', 'substitute'],
        caret: { file: 'api/src/cart.ts', line: 42 },
        items: [
          { text: 'Go to Declaration', key: '⌘B' },
          { text: 'Find Usages', key: '⌥F7' },
        ],
      },
      { serving: true, project: 'demo-shop' },
    ),
    'w',
  ),
  // #346: New card, drafted by the agent; then refused by Azure (its state for a Bug)
  'dialog-new-card': newCardTree('Customers can save a wishlist', ['<D-CR>'], [DRAFTED]),
  'dialog-new-card-refused': newCardTree(
    'Cart total ignores quantity',
    // Type Bug, Column Active, back on the title, Create
    [
      '<Tab>',
      '<CR>',
      '<Down>',
      '<CR>',
      '<Tab>',
      '<CR>',
      '<Down>',
      '<CR>',
      '<S-Tab>',
      '<S-Tab>',
      '<CR>',
    ],
    [
      (id) => ({
        kind: 'result',
        id,
        command: 'card create',
        reply: {
          ok: false,
          error: {
            code: 'rejected',
            message: "'Active' is not a state of a Bug: New, Resolved, Closed",
          },
        },
      }),
    ],
  ),
  'command-prompt': commandTree('c a r d <Space> s h <CR> 1 2'),
  'command-prompt-error': commandTree('c a r d <Space> s h <CR> <CR>'),
  // #314: the caret moved back into the text, in the prompt and in the filter
  'command-prompt-caret': commandTree('c a r d <Space> s h <CR> 1 2 3 <Left>'),
  'command-pick-caret': commandTree('c a r d <Space> s o w <Left> <Left> h'),
  'command-value': commandTree('c a r d <Space> m o <CR> 7 <CR>'),
  'command-confirm': commandTree('s e s s <CR> 4 <CR>'),
  // The rendered Chat (2.1, #113 t113c): board R-Turn's column end to end, and every prop of its
  // parts. No screen draws them yet (t113d builds the transcript from the session).
  'chat-turn': CHAT_TURN,
  'chat-turn-gallery': CHAT_TURN_GALLERY,
  // The Git Log's PR review (the `review` slot): read, being read, none under review
  ...reviewTrees(),
  // Chat's cards (2.1, #114 t114b): each card state of board 6.8, and every prop of the cards.
  ...CARD_TREES,
  'cards-gallery': CARDS_GALLERY,
  // Local mode (#24): every prop of its band, a dashed card, a local pull request, Held writes.
  'local-gallery': LOCAL_GALLERY,
  // Chat's composer (2.1, #115 t115b): each composer state of R-Anatomy, R-Composer, C-Context and
  // R-Working, and every prop of its parts.
  ...COMPOSER_TREES,
  'composer-gallery': COMPOSER_GALLERY,
  // The Settings dialog (2.1 #108 S2): T-Appearance's page with Chat's row focused; Problems
  // first (S-Problems); `/box` (S-Search); Agents & models with Reader's list open (T-Agents);
  // a change staged and Cancel's question; an Override's reason asked; ⌘⏎'s propose popup; serve
  // down; an empty page.
  'settings-appearance': settingsTree(
    { clean: true },
    click('settings:tree:appearance'),
    key('ä'),
    // past the Feel row (#121) to Chat column open by default
    ...['ö', 'ö', 'ö', 'ö', 'ö', 'ö', 'ö'].map(key),
  ),
  // #108 S4 (T-Appearance): the theme list, its cursor on Islands Light while ⏎ has it open
  'settings-themes': settingsTree(
    { clean: true },
    {
      kind: 'result',
      id: 'settings:themes:5',
      command: 'theme list',
      reply: {
        ok: true,
        data: { themes: themeCatalogue([]).map((t) => themeRow(t, 'islands-dark')), problems: [] },
      },
    },
    click('settings:tree:appearance'),
    ...['ä', 'ö', '<CR>', 'ä'].map(key),
  ),
  // #108 S4 (T-Colours): Colours filtered to `needs`, abe-needs-you's hex open as a colour field
  'settings-colours': settingsTree(
    { clean: true },
    {
      kind: 'result',
      id: 'settings:themes:5',
      command: 'theme list',
      reply: {
        ok: true,
        data: { themes: themeCatalogue([]).map((t) => themeRow(t, 'islands-dark')), problems: [] },
      },
    },
    ((): Input => {
      const dark = themeCatalogue([]).find((t) => t.slug === 'islands-dark');

      if (dark === undefined) throw new Error('no Islands Dark');

      return {
        kind: 'result',
        id: 'settings:colours:6',
        command: 'theme show',
        reply: {
          ok: true,
          data: { theme: themeRow(dark, 'islands-dark'), groups: themeGroups(dark) },
        },
      };
    })(),
    // #345: Colours under Editor › Color scheme, after Scheme and Reset colours (#297: last)
    click('settings:tree:color-scheme'),
    click('settings:line:2'),
    key('<CR>'),
    { kind: 'text', text: 'needs' },
    // past its group's head (#300: groups fold) to the token
    ...['<CR>', 'ö', 'ö', '<CR>'].map(key),
  ),
  'settings-problems': settingsTree({}, key('ä')),
  // #168: your Override as an info row, no problems
  'settings-override-info': settingsTree(
    { clean: true, layers: OVERRIDE_LAYERS },
    click('settings:tree:problems'),
  ),
  'settings-search': settingsTree(
    { clean: true },
    ...['/', 'b', 'o', 'x', '<CR>', 'ö', 'ö', 'ö', 'ö', 'ö'].map(key),
  ),
  // #152: a page picked in the tree while searching, its hits marked; ⌘A in the search field
  'settings-search-page': settingsTree(
    { clean: true },
    ...['/', 'i', 'd', 'l', 'e'].map(key),
    click('settings:tree:boxes-cloud'),
  ),
  'settings-select-all': settingsTree({ clean: true }, ...['/', 'b', 'o', 'x', '<D-a>'].map(key)),
  'settings-agents': settingsTree(
    {},
    click('settings:tree:agents'),
    key('ä'),
    key('ö'),
    key('<CR>'),
  ),
  // A change saved at once: Chat column open by default ticked and written, ⌘Z's Undo in the footer.
  'settings-saved': settingsTree(
    { clean: true },
    click('settings:tree:appearance'),
    key('ä'),
    ...['ö', 'ö', 'ö', 'ö', 'ö', 'ö', 'ö', '<CR>'].map(key),
    {
      kind: 'result',
      id: 'settings:set:6',
      command: 'settings set',
      reply: {
        ok: true,
        data: {
          key: 'chat.openByDefault',
          layer: 'individual',
          place: 'machine',
          file: '/home/me/.config/abe/settings.yaml',
          entry: 'plain',
          written: true,
          reason: null,
          value: true,
          winner: 'individual',
        },
      },
    },
  ),
  // An account's dropdown: AWS profile open, filtered by `demo` (the profiles serve knows, then the name as typed).
  'settings-combo-account': settingsTree(
    { params: { page: 'boxes-cloud', row: 'box.profile' } },
    ...['<CR>', 'd', 'e', 'm', 'o'].map(key),
  ),
  // A refused value: AWS region typed as `eu`, taken from its dropdown, its reason under the row, nothing saved.
  'settings-refused': settingsTree(
    { params: { page: 'boxes-cloud', row: 'box.region' } },
    ...['<CR>', 'e', 'u', '<End>', '<CR>'].map(key),
  ),
  // Records: View tweaks' editor, a tweak added, its Screen's list open.
  'settings-records-pick': settingsTree(
    { layers: RECORDS_LAYERS, params: { page: 'appearance', row: 'views' } },
    ...['<CR>', 'a'].map(key),
  ),
  // Records: a cell typed in place, the tweak refused till it reads (its reason under the row).
  'settings-records': settingsTree(
    { layers: RECORDS_LAYERS, params: { page: 'appearance', row: 'views' } },
    ...['<CR>', 'a', '<CR>', 'ä', '<CR>'].map(key),
    { kind: 'text', text: 'col:Resolved' },
  ),
  // Records closed: Reach's environments as rows of fields.
  'settings-environments': settingsTree({
    layers: RECORDS_LAYERS,
    params: { page: 'reach', row: 'environments' },
  }),
  'settings-reason': settingsTree(
    { params: { page: 'boxes-cloud', row: 'box.idleMinutes' } },
    ...['<CR>', '<BS>', '<BS>', '4', '5', '<CR>', '<CR>'].map(key),
  ),
  // ⌘⏎ on Largest disk (S-Propose): a new value and the reason typed, for the repo.
  'settings-propose': settingsTree(
    { params: { page: 'boxes-cloud', row: 'limits.maxBoxDisk' } },
    ...['<D-CR>', '<C-u>'].map(key),
    { kind: 'text', text: '400' },
    key('<Tab>'),
    { kind: 'text', text: 'Large builds fill the disk' },
  ),
  // Logins & tools (S-Logins): Azure DevOps' login expired, node missing, the az fix queued.
  'settings-logins': settingsTree(
    { params: { page: 'logins-tools' } },
    {
      kind: 'result',
      id: 'settings:checks:5',
      command: 'login status',
      reply: {
        ok: true,
        data: { secret: null, logins: { github: 'ok', claude: 'ok', az: 'expired' } },
      },
    },
    {
      kind: 'result',
      id: 'settings:checks:6',
      command: 'tools check',
      reply: {
        ok: true,
        data: {
          where: 'this Mac',
          tools: [
            toolCheck('node', { found: false }, false),
            toolCheck('tmux', { found: true, exit: 0, stdout: 'tmux 3.5a', stderr: '' }, false),
          ],
        },
      },
    },
    {
      kind: 'result',
      id: 'settings:checks:7',
      command: 'source status',
      reply: { ok: true, data: { repo: '/r/demo-shop', sources: [] } },
    },
    ...['ö', 'ö', '<CR>'].map(key),
  ),
  // Logins & tools with the checkout's sources (ADR 0028): Sentry signs in (serve runs it), Figma
  // needs a sign-in, its Sign in… focused.
  'settings-logins-sources': settingsTree(
    { params: { page: 'logins-tools' } },
    {
      kind: 'result',
      id: 'settings:checks:5',
      command: 'login status',
      reply: {
        ok: true,
        data: { secret: null, logins: { github: 'ok', claude: 'ok', az: 'ok' } },
      },
    },
    {
      kind: 'result',
      id: 'settings:checks:6',
      command: 'tools check',
      reply: { ok: true, data: { where: 'this Mac', tools: [] } },
    },
    {
      kind: 'result',
      id: 'settings:checks:7',
      command: 'source status',
      reply: {
        ok: true,
        data: {
          repo: '/r/demo-shop',
          sources: [
            {
              id: 'sentry',
              server: 'sentry',
              check: 'Signing in…',
              signIn: 'signing-in',
              reads: false,
            },
            {
              id: 'figma',
              server: 'figma',
              check: 'needs your sign-in',
              signIn: 'offered',
              reads: false,
            },
          ],
        },
      },
    },
    ...['ö', 'ö', 'ö', 'ö'].map(key),
  ),
  // Browser profiles (#103 S4, S-Profiles): the team's work, your po-review, the built-in default.
  'settings-profiles': settingsTree(
    { params: { page: 'browser-profiles' } },
    {
      kind: 'result',
      id: 'settings:profiles:5',
      command: 'browser list',
      reply: {
        ok: true,
        data: {
          profiles: [
            {
              name: 'work',
              purpose: 'app user',
              layer: 'repo',
              default: true,
              storedAt: '2026-10-20T08:00:00Z',
              folder: true,
              open: false,
              storedAgo: '11 days ago',
              storeFailed: null,
            },
            {
              name: 'po-review',
              purpose: "product owner's login",
              layer: 'individual',
              default: false,
              storedAt: null,
              folder: true,
              open: true,
              storedAgo: null,
              storeFailed: null,
            },
            {
              name: 'default',
              purpose: 'empty · a fresh profile every start',
              layer: 'built-in',
              default: false,
              storedAt: null,
              folder: null,
              open: null,
              storedAgo: null,
              storeFailed: null,
            },
          ],
          unlisted: [],
          migrated: [],
          missingDefault: null,
        },
      },
    },
    key('ä'),
  ),
  // Local mode (#24, LM-Setting): this checkout on, what it means, every checkout yours lists.
  'settings-local-mode': settingsTree(
    { params: { page: 'local-mode' } },
    {
      kind: 'result',
      id: 'settings:local:5',
      command: 'local status',
      reply: {
        ok: true,
        data: { checkout: '/work/demo-shop', on: true, held: [], prs: [], cards: [] },
      },
    },
  ),
  // Import config (#120): VS Code read with --dry-run, its rows ticked or no match here.
  'settings-import': settingsTree({ params: { page: 'import-config' } }, key('<CR>'), {
    kind: 'result',
    id: 'settings:import:5',
    command: 'settings import',
    reply: {
      ok: true,
      data: {
        source: 'vscode',
        files: [
          {
            path: '~/Library/Application Support/Code/User/settings.json',
            found: true,
            error: null,
          },
        ],
        rows: [
          {
            id: 'editor.fontSize',
            group: 'settings',
            from: 'editor.fontSize: 14',
            to: { key: 'ui.font.editorSize', value: 14 },
            bind: null,
            note: null,
            ticked: true,
          },
          {
            id: 'editor.minimap.enabled',
            group: 'settings',
            from: 'editor.minimap.enabled: false',
            to: null,
            bind: null,
            note: 'no match here',
            ticked: false,
          },
        ],
        file: '/home/me/.config/abe/settings.yaml',
        dryRun: true,
        written: [],
        keysFile: '~/.config/abe/keys.json',
        keysWritten: [],
        refused: [],
      },
    },
  }),
  // #345: Logins & tools drawn at once, every row checking…; then the logins landed in place.
  'settings-logins-checking': settingsTree({ params: { page: 'logins-tools' } }),
  'settings-logins-half': settingsTree(
    { params: { page: 'logins-tools' } },
    {
      kind: 'result',
      id: 'settings:checks:5',
      command: 'login status',
      reply: {
        ok: true,
        data: {
          secret: null,
          logins: { github: 'ok', claude: 'ok', az: 'expired' },
          who: { github: 'octocat', claude: 'octo@example.com' },
        },
      },
    },
  ),
  // A repo's logins: names aws for its SSO profile: its row beside the Mac's, its fix abe's own.
  'settings-logins-aws': settingsTree(
    { params: { page: 'logins-tools' } },
    {
      kind: 'result',
      id: 'settings:checks:5',
      command: 'login status',
      reply: {
        ok: true,
        data: {
          secret: null,
          logins: { github: 'ok', claude: 'ok', az: 'ok', aws: 'expired' },
          awsProfile: 'shop-test',
        },
      },
    },
  ),
  'settings-serve-down': settingsTree({ down: true, params: { page: 'appearance' } }),
  // A list setting's editor: Test files opened, one added (saved at once), the cursor on it.
  'settings-list': settingsTree(
    { params: { page: 'factory-policy', row: 'testFiles' } },
    ...['<CR>', 'a'].map(key),
    { kind: 'text', text: 'e2e/' },
    ...['<CR>', 'l'].map(key),
  ),
  // A new item typed in place in a list's editor.
  'settings-list-add': settingsTree(
    { params: { page: 'factory-policy', row: 'testFiles' } },
    ...['<CR>', 'a'].map(key),
    { kind: 'text', text: 'spec/' },
  ),
  // A folder's field and its Choose… button, focused.
  'settings-path': settingsTree({ params: { page: 'board-team', row: 'board#azureConfigDir' } }),
  // A secret typed: dots, never its text.
  'settings-secret': settingsTree(
    { rules: SECRET_RULES, params: { page: 'boxes-cloud', row: 'box.owner' } },
    key('<CR>'),
    { kind: 'text', text: 'hunter2' },
  ),
  // Advanced: View tweaks' JSON in its code field, a refused value's reason under it.
  'settings-advanced': settingsTree(
    { rules: ADVANCED_RULES, params: { page: 'appearance', row: 'views' } },
    ...['<CR>', '<C-u>'].map(key),
    { kind: 'text', text: '[{"node":"board","hide":"yes"}]' },
  ),
  // Yours set on this Mac: the row's scope, its default and Reset (⌫).
  'settings-reset': settingsTree({ params: { page: 'appearance', row: 'chat.openByDefault' } }),
  // Not a screen state: every prop of the set once, so the shell draws each.
  gallery: {
    kind: 'Island',
    id: 'gallery',
    props: {},
    children: [
      {
        kind: 'Stack',
        props: {
          direction: 'column',
          gap: 4,
          sizes: [{ fixed: 31 }, 'auto', 'auto', 'auto', { flex: 1 }, { fixed: 160 }],
        },
        children: [
          {
            kind: 'ToolWindowHeader',
            props: {
              title: 'Git',
              count: 2,
              tabs: [
                { id: 'tab:log', label: 'Log' },
                { id: 'tab:changes', label: 'Local Changes' },
              ],
              selected: 'tab:log',
              note: '⌘⏎ more',
            },
          },
          {
            kind: 'ListRow',
            id: 'row:selected',
            props: {
              text: 'selected',
              dim: 'dim text',
              note: 'note',
              icon: 'folder',
              state: 'selected',
              key: '⏎',
            },
          },
          {
            kind: 'ListRow',
            id: 'row:inactive',
            props: { text: 'selected, inactive', state: 'selected-inactive' },
          },
          {
            kind: 'ListRow',
            id: 'row:disabled',
            props: { text: 'disabled', state: 'disabled', reason: 'why it is' },
          },
          {
            kind: 'Stack',
            props: { direction: 'row', gap: 8 },
            children: [
              ...(['good', 'warn', 'needs-you', 'bad', 'accent', 'dim'] as const).map(
                (hue): Node => ({ kind: 'Badge', props: { text: hue, hue } }),
              ),
              {
                kind: 'AgentStatus',
                props: {
                  state: 'running',
                  word: 'Verifying',
                  connection: 'Connecting',
                  env: 'Local',
                },
              },
              { kind: 'AgentStatus', props: { state: 'starting', word: 'Starting', dot: true } },
              {
                kind: 'AgentStatus',
                props: { state: 'failed', word: 'Failed', reason: 'checks failed' },
              },
              { kind: 'KeyHint', props: { keys: '⏎', label: 'drop', context: 'row' } },
              {
                kind: 'KeyHint',
                props: { keys: 'Esc', label: 'put back', context: 'button', dim: true },
              },
              { kind: 'Empty', props: { title: 'Nothing here', line: 'One line under it.' } },
            ],
          },
          {
            kind: 'BrowserView',
            id: 'gallery-browser',
            props: {
              key: 'gallery:sheet',
              url: 'http://127.0.0.1:50123/s/9f2c4e1a',
              title: 'Sheet',
              sub: 'Cart totals by market',
              address: 'sheet://1234/cart-totals-by-market-a1b2c3',
              version: 2,
              badges: ['yours', 'sandboxed', 'no network', 'attached'],
              action: { keys: '⌘⏎', label: 'Attach to card' },
              focused: true,
            },
          },
        ],
      },
    ],
  },
});

/** A tree with a kind outside the set: Node refuses it; the shell draws `needs component: Chooser`. */
/** The stripe as the bridge sends it for a developer (#20): one asks, two run, boxes, a Settings problem. */
const STRIPE_EFFECT = {
  kind: 'stripe' as const,
  items: stripeItems({
    counts: { needsYou: 1, running: 2 },
    waiting: [{ card: 1234, title: 'Cart total includes shipping' }],
    boxes: { badge: '3 · 1 running', hue: 'dim', words: '3 boxes, 1 running' },
  }),
  gear: stripeGear(2),
};

const UNKNOWN = {
  kind: 'Island',
  props: {},
  children: [
    { kind: 'Chooser', id: 'chooser', props: { title: 'Pick one' } },
    { kind: 'Empty', props: { title: 'Known', line: 'drawn as usual' } },
  ],
};

const frames = (tree: Node, layer: Node): Record<string, unknown> => ({
  'app-hello': {
    v: UI_CONTRACT,
    type: 'hello',
    size: { width: 1200, height: 800 },
    version: '2.0.0',
    root: '/home/me/projects/demo-shop',
  },
  'app-project': { v: UI_CONTRACT, type: 'project', root: '/home/me/projects/demo-api' },
  // #119: a cloud workspace shown (its box, root the last local folder), and its branch
  'app-project-box': {
    v: UI_CONTRACT,
    type: 'project',
    root: '/home/me/projects/demo-shop',
    box: 'demo-shop-102',
    branch: 'card/102-cart-total-ignores-quantity',
  },
  'app-open-chat': {
    v: UI_CONTRACT,
    type: 'open',
    screen: 'chat',
    params: { root: '/home/me/projects/demo-shop-wt/1240-cart-total' },
    slot: 'chat',
  },
  'app-open-pane': { v: UI_CONTRACT, type: 'open', screen: 'sessions', params: {}, slot: 'pane' },
  // the Git Log's PR review: PR #7 in its worktree, the `PR ⌄` pick, a `,ic`, Create Draft PR's read
  'app-open-review': {
    v: UI_CONTRACT,
    type: 'open',
    screen: 'review',
    params: { pr: '7', path: '/home/me/projects/demo-shop-pr-7', list: 'heat' },
    slot: 'review',
  },
  'app-open-review-pick': {
    v: UI_CONTRACT,
    type: 'open',
    screen: 'review',
    params: { pick: '/home/me/projects/demo-shop' },
    slot: 'review',
  },
  'app-input-review': {
    v: UI_CONTRACT,
    type: 'input',
    input: {
      kind: 'review',
      ask: {
        kind: 'comment',
        path: 'src/cart.ts',
        side: 'RIGHT',
        line: 12,
        start: 10,
        body: 'Guard this?',
        base: 'base000',
        head: 'c0ffee1234',
      },
    },
    slot: 'review',
  },
  'app-run': {
    v: UI_CONTRACT,
    type: 'run',
    id: 'draft-pr:1',
    argv: ['pr', 'draft-plan', '--path', '/home/me/projects/demo-shop'],
  },
  'bridge-answer': {
    v: UI_CONTRACT,
    type: 'answer',
    id: 'draft-pr:1',
    reply: {
      ok: false,
      error: { code: 'invalid', message: 'This checkout has no GitHub repository' },
    },
  },
  'bridge-tree-review': {
    v: UI_CONTRACT,
    type: 'tree',
    screen: 'review',
    rev: 5,
    tree: reviewTrees()['review-pane'] ?? statusTree(),
    slot: 'review',
  },
  'bridge-shell-show-diff': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'show-diff',
      root: '/home/me/projects/demo-shop-pr-7',
      files: [
        { path: 'src/cart.ts', status: 'M' },
        { path: 'src/total.ts', oldPath: 'src/sum.ts', status: 'R' },
      ],
      index: 1,
      base: 'base000',
      head: 'c0ffee1234',
      line: 3,
      pr: { number: 7, head: 'c0ffee1234' },
    },
  },
  'bridge-shell-review-said': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'review-said',
      root: '/home/me/projects/demo-shop-pr-7',
      text: '✎ Draft on cart.ts:12 · ,is submits 1 draft in one review',
      tone: 'ok',
    },
  },
  'bridge-shell-review-open': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'review-open',
      path: '/home/me/projects/demo-shop-pr-7',
      repo: 'acme/demo-shop',
      number: 7,
      unchecked: null,
    },
  },
  'bridge-shell-pr-pick': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'pr-pick',
      root: '/home/me/projects/demo-shop',
      repo: 'acme/demo-shop',
      rows: [
        { caption: 'Mine' },
        { number: 9, label: '#9 Pay by card   feature/AB-12-pay', note: 'Draft' },
        { caption: 'Others' },
        { number: 7, label: '#7 Cart totals   bob', note: 'Review requested' },
      ],
    },
  },
  'app-input-key-chat': {
    v: UI_CONTRACT,
    type: 'input',
    input: { kind: 'key', key: '<CR>' },
    slot: 'chat',
  },
  'app-resize-chat': {
    v: UI_CONTRACT,
    type: 'resize',
    size: { width: 420, height: 760 },
    slot: 'chat',
  },
  'app-focus-chat': { v: UI_CONTRACT, type: 'focus', slot: 'chat' },
  'app-focus-none': { v: UI_CONTRACT, type: 'focus', slot: null },
  // #236: the Factory view shown in the window in front (the bridge keeps its data fresh)
  'app-window-factory': { v: UI_CONTRACT, type: 'window', view: 'factory', active: true },
  'app-window-editor-back': { v: UI_CONTRACT, type: 'window', view: 'editor', active: false },
  'app-caret': { v: UI_CONTRACT, type: 'caret', file: 'src/cart.ts', line: 15 },
  'app-no-caret': { v: UI_CONTRACT, type: 'no-caret' },
  // #253: the story dialog's page as drawn scrolls 12 rows
  'app-extent': { v: UI_CONTRACT, type: 'extent', id: 'dialog:1240', lines: 12 },
  'app-caret-selection': {
    v: UI_CONTRACT,
    type: 'caret',
    file: 'src/cart.ts',
    line: 18,
    selection: { from: 12, to: 18 },
  },
  'app-open': { v: UI_CONTRACT, type: 'open', screen: 'factory', params: {} },
  'app-open-from-editor': {
    v: UI_CONTRACT,
    type: 'open',
    screen: 'factory',
    params: { from: 'editor' },
  },
  'app-input-key': { v: UI_CONTRACT, type: 'input', input: { kind: 'key', key: 'r' } },
  'app-input-click': { v: UI_CONTRACT, type: 'input', input: { kind: 'click', id: 'reload' } },
  'app-input-text': { v: UI_CONTRACT, type: 'input', input: { kind: 'text', text: 'å' } },
  'app-input-blur': { v: UI_CONTRACT, type: 'input', input: { kind: 'blur' } },
  'app-resize': { v: UI_CONTRACT, type: 'resize', size: { width: 900, height: 600 } },
  'app-exit': { v: UI_CONTRACT, type: 'exit', key: 'retro:s1240:0', code: 0 },
  'app-browser': {
    v: UI_CONTRACT,
    type: 'browser',
    key: 'sheet:cart-totals-by-market-a1b2c3:yours:v1',
    event: { kind: 'focus', focused: true },
  },
  'bridge-tree': { v: UI_CONTRACT, type: 'tree', screen: 'factory', rev: 1, tree },
  'bridge-tree-chat': {
    v: UI_CONTRACT,
    type: 'tree',
    screen: 'chat',
    rev: 4,
    tree: trees()['chat-pinned'] ?? statusTree(),
    slot: 'chat',
  },
  'bridge-tree-popup': {
    v: UI_CONTRACT,
    type: 'tree',
    screen: 'card',
    rev: 6,
    tree: trees()['card-page'] ?? statusTree(),
    slot: 'popup',
  },
  'bridge-closed-popup': { v: UI_CONTRACT, type: 'closed', slot: 'popup' },
  'app-close-popup': { v: UI_CONTRACT, type: 'close', slot: 'popup' },
  'bridge-tree-welcome': {
    v: UI_CONTRACT,
    type: 'tree',
    screen: 'welcome',
    rev: 1,
    tree: trees().welcome ?? statusTree(),
  },
  'bridge-shell-welcome': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'welcome', needsYou: 2, crumb: 'Sandbox · Sprint 14', page: 'board' },
  },
  // #3: Welcome on its Sessions page, its stripe (a card and sessions need you), Clone…
  'bridge-shell-welcome-sessions': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'welcome', needsYou: 2, crumb: 'Sandbox · Sprint 14', page: 'sessions' },
  },
  'bridge-shell-stripe-welcome': { v: UI_CONTRACT, type: 'shell', effect: WELCOME_STRIPE },
  'bridge-shell-clone-project': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'clone-project', url: 'git@github.com:demo/demo-shop.git' },
  },
  'bridge-shell-open-project-card': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'open-project', path: '/home/me/projects/demo-shop', card: 101 },
  },
  'bridge-tree-status': {
    v: UI_CONTRACT,
    type: 'tree',
    screen: 'status',
    rev: 1,
    tree: trees()['status-sessions'] ?? statusTree(),
  },
  'bridge-layer': { v: UI_CONTRACT, type: 'layer', rev: 2, tree: layer },
  'bridge-layer-none': { v: UI_CONTRACT, type: 'layer', rev: 3, tree: null },
  'bridge-shell-view': { v: UI_CONTRACT, type: 'shell', effect: { kind: 'view', view: 'editor' } },
  'bridge-shell-status': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'status', text: 'abe card move 7 --column Done: #7 moved to Done' },
  },
  'bridge-shell-clipboard': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'clipboard', text: 'api/src/cart.ts' },
  },
  'bridge-shell-repo-moved': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'repo-moved', from: '/home/ann/shop', to: '/home/ann/shop-moved' },
  },
  'bridge-shell-cmdline': { v: UI_CONTRACT, type: 'shell', effect: { kind: 'cmdline' } },
  // #346: Run in Neovim; Anywhere's Search Everywhere
  'bridge-shell-ex': { v: UI_CONTRACT, type: 'shell', effect: { kind: 'ex', text: '%s/a/b/g' } },
  'bridge-shell-app': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'app', action: 'search-everywhere' },
  },
  // #106: ⌃L in the Editor; ⌃⌥W from a Terminal-mode tab of the Chat column
  'app-jump': {
    v: UI_CONTRACT,
    type: 'jump',
    to: 'linked',
    from: { place: 'editor', view: 'editor' },
  },
  'app-jump-chat': {
    v: UI_CONTRACT,
    type: 'jump',
    to: 'workspace',
    from: { place: 'chat', view: 'editor' },
  },
  // ⌃W's landing (#105 S4): the workspace with Chat beside it; Linked's targets
  'bridge-shell-open-project-chat': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'open-project', path: '/home/me/projects/demo-shop-wt/2-cart', chat: true },
  },
  'bridge-shell-open-file': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'open-file', path: '/home/me/projects/demo-shop-wt/2-cart/.abe/spec.md' },
  },
  // Sessions ⏎: the session's workspace on its page, else the Factory view on its card
  'bridge-shell-workspace-page': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'workspace-page', path: '/home/me/projects/demo-shop-wt/2-cart', card: 2 },
  },
  // ⏎ on a Board card whose workspace is on this machine: that workspace on its Card page
  'bridge-shell-workspace-page-card': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'workspace-page',
      path: '/home/me/projects/demo-shop-wt/2-cart',
      card: 2,
      page: 'card',
    },
  },
  'bridge-shell-show': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'show', place: 'pipelines' },
  },
  'bridge-shell-show-chat': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'show', place: 'chat' },
  },
  'bridge-shell-open-project': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'open-project', path: '/home/me/projects/demo-shop' },
  },
  'bridge-shell-open-workspace': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'open-project',
      path: '/workspace/repo',
      attach: {
        nvim: [
          'abe',
          'box',
          'attach',
          'shop-4',
          '--',
          'env',
          '-C',
          '/workspace/repo',
          'NVIM_APPNAME=vimstorm',
          'nvim',
          '--embed',
        ],
        shell: [
          'abe',
          'box',
          'attach',
          'shop-4',
          '--',
          'env',
          '-C',
          '/workspace/repo',
          'bash',
          '-l',
        ],
        exec: ['abe', 'box', 'attach', 'shop-4', '--'],
        box: { name: 'shop-4', region: 'eu-west-1' },
        waking: true,
        download: 'download:4-a1b2',
      },
    },
  },
  'bridge-shell-balloon': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'balloon', tone: 'warning', text: 'abe serve restarted' },
  },
  // #20: the stripe, a developer's (one asks, two run, boxes, a Settings problem), then a
  // one with your tweaks (Pipelines hidden, Git moved to the top), then Pipelines' dot
  'bridge-shell-stripe': { v: UI_CONTRACT, type: 'shell', effect: STRIPE_EFFECT },
  'bridge-shell-stripe-tweaked': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'stripe',
      items: stripeItems({
        counts: { needsYou: 0, running: 0 },
        tweaks: [
          { screen: 'factory', node: 'stripe:pipelines', hide: true },
          { screen: 'factory', node: 'stripe:git', group: 'top' },
        ],
      }),
      gear: stripeGear(undefined),
    },
  },
  'bridge-shell-stripe-dot': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'stripe-dot',
      id: 'pipelines',
      dot: 'failed',
      words: '1 run failed on your branch',
    },
  },
  'bridge-shell-widgets': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'widgets',
      widgets: [
        {
          id: 'factory',
          text: 'Factory ◆ 1',
          hue: 'needs-you',
          tooltip: '#1234 Cart total includes shipping needs you · ⌘⌥A',
          view: 'editor',
          place: 'start',
        },
        {
          id: 'needs-you',
          text: '◆ 1 needs you',
          hue: 'needs-you',
          tooltip: '#1234 Cart total includes shipping needs you',
          view: 'factory',
        },
        { id: 'running', text: '● 1 running', hue: 'warn', view: 'factory' },
      ],
    },
  },
  // #104 S4: the status bar's `☁ N boxes` red, demo-shop-2 stuck starting (board X-Boxes)
  'bridge-shell-widgets-boxes': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'widgets',
      widgets: [
        boxesWidget(
          { boxes: [X_BOXES.stuck, X_BOXES.running, X_BOXES.asleep], queued: [] },
          Date.parse(X_BOXES.now),
        ) ?? { id: 'none', text: '' },
      ],
    },
  },
  // #108 S4: the look Islands Light at WebStorm's default density (AC 8), Islands Dark as it is
  // built in (the shell's palette is exactly its own), and Islands Dark with abe-needs-you changed
  // while staged (AC 9)
  'bridge-shell-look': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'look',
      look: lookOf(
        { ...DEFAULT_LOOK_SETTINGS, 'ui.theme': 'islands-light', 'ui.density': 'default' },
        themeCatalogue([]),
      ),
    },
  },
  'bridge-shell-look-dark': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'look', look: lookOf(DEFAULT_LOOK_SETTINGS, themeCatalogue([])) },
  },
  // #129: Dark Modern's look, VS Code's capture mapping
  'bridge-shell-look-dark-modern': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'look',
      look: lookOf({ ...DEFAULT_LOOK_SETTINGS, 'ui.theme': 'dark-modern' }, themeCatalogue([])),
    },
  },
  // #345: Islands Light's chrome with Islands Dark as the editor scheme (Darcula on a light UI)
  'bridge-shell-look-light-scheme-dark': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'look',
      look: lookOf(
        { ...DEFAULT_LOOK_SETTINGS, 'ui.theme': 'islands-light', 'editor.scheme': 'islands-dark' },
        themeCatalogue([]),
      ),
    },
  },
  'bridge-shell-look-staged': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'look',
      look: lookOf(DEFAULT_LOOK_SETTINGS, themeCatalogue([]), {
        tokens: { 'abe-needs-you': '#a979f7' },
        font: { editorSize: 15, ligatures: true },
      }),
    },
  },
  // #121: the Feel VS Code's switches, as the bridge sends them; #129: your keys.json's keys
  'bridge-shell-feel': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'feel',
      feel: feelOf(
        mergeSettings([
          { place: 'machine', file: '/me/settings.yaml', doc: { 'ui.feel': 'vscode' } },
        ]).values,
        keyBinds({ '⌘Y': 'goToFile', '⌃⌥→': 'nextTab' }),
      ),
    },
  },
  // #116: the header's feed on the demo (H-EditorB, H-States), and with serve not answering
  'bridge-shell-workspaces': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'workspaces',
      ...workspacesOf({
        ...headerDemo(),
        now: HEADER_NOW,
        root: '/home/me/projects/demo-shop',
        sprint: 'Sprint 1',
        counts: { running: 1, needsYou: 1, failed: 0, ready: 0 },
        answering: true,
      }),
    },
  },
  'bridge-shell-workspaces-prototypes': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'workspaces',
      ...workspacesOf({
        runs: undefined,
        sessions: undefined,
        now: undefined,
        root: '/home/me/projects/demo-shop',
        sprint: undefined,
        counts: { running: 0, needsYou: 0, failed: 0, ready: 0 },
        answering: true,
      }),
      prototypes: prototypeLooks(
        [
          PROTO_LIVE,
          prototype('starting', {
            id: 'proto-9f2c00',
            card: 1234,
            code: { ...PROTO_CODE, session: 'prototype-c3d4', branch: 'proto/1234-cart-total' },
          }),
        ],
        undefined,
        { 1234: 'Cart total includes shipping' },
      ),
    },
  },
  'bridge-shell-open-prototype': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'open-prototype', id: 'proto-1a2b3c' },
  },
  'bridge-shell-workspaces-down': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'workspaces',
      ...workspacesOf({
        runs: undefined,
        sessions: undefined,
        now: undefined,
        root: '/home/me/projects/demo-shop',
        sprint: undefined,
        counts: { running: 0, needsYou: 0, failed: 0, ready: 0 },
        answering: false,
      }),
    },
  },
  'bridge-shell-chat-session': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'chat-session', session: '3-6025' },
  },
  'bridge-shell-chat-session-none': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'chat-session', session: null },
  },
  'bridge-shell-drop-terminal': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'drop-terminal', key: 'retro:s1240:0' },
  },
  'bridge-shell-open-url': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'open-url',
      url: 'https://dev.azure.com/demo-org/Sandbox/_workitems/edit/1234',
    },
  },
  // #105 S3, #309: the Factory view's selected card and its title, the Chat column follows it
  'bridge-shell-selected': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'selected', card: 4, owner: null, title: 'Cart total includes shipping' },
  },
  // #107: ⏎ on a Sessions row gives Chat the keys
  'bridge-shell-focus': { v: UI_CONTRACT, type: 'shell', effect: { kind: 'focus', slot: 'chat' } },
  'bridge-shell-unhandled': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: { kind: 'unhandled', slot: 'chat', key: '<Esc>' },
  },
  // #104: ⏎ on a box attaches in a Terminal mode tab
  'bridge-shell-terminal-tab': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'terminal-tab',
      argv: ['abe', 'box', 'attach', 'demo-shop-1'],
      title: 'demo-shop-1',
    },
  },
  // ADR 0022: ⏎ on a workspace row attaches to that card's workspace on the repo's box
  'bridge-shell-terminal-tab-card': {
    v: UI_CONTRACT,
    type: 'shell',
    effect: {
      kind: 'terminal-tab',
      argv: ['abe', 'box', 'attach', 'demo-shop', '--card', '101'],
      title: 'demo-shop #101',
    },
  },
  'bridge-error': {
    v: UI_CONTRACT,
    type: 'error',
    error: {
      code: 'unsupported-version',
      message:
        'this abe ui bridge speaks v3, the app v2: VimStorm and Abe are of different releases, update both',
    },
  },
});

const json = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * What the shell draws of `bridge-shell-stripe` (#20), per place and bottom tool window shown,
 * and its right-click menu in a workspace (on Prototype) and on the Board (on Board): the app's
 * stripe tests (`app/tests/stripe.rs`) draw the same.
 */
const stripeFiles = (): Record<string, unknown> => {
  const items = STRIPE_EFFECT.items;

  return {
    editor: stripeAt(items, { place: 'project' }),
    board: stripeAt(items, { place: 'board' }),
    run: stripeAt(items, { place: 'run' }),
    'pane-sessions': stripeAt(items, { place: 'project', pane: 'sessions' }),
    'pane-boxes': stripeAt(items, { place: 'project', pane: 'boxes' }),
    'pane-pipelines': stripeAt(items, { place: 'project', pane: 'pipelines' }),
    'pane-terminal': stripeAt(items, { place: 'project', pane: 'terminal' }),
    'pane-git': stripeAt(items, { place: 'project', pane: 'git' }),
    'board-pane-sessions': stripeAt(items, { place: 'board', pane: 'sessions' }),
    'menu-workspace': stripeMenu(items, true, 'pipelines'),
    'menu-board': stripeMenu(items, false, 'board'),
    // #3: Welcome's (no project open), per page
    'welcome-board': welcomeStripeAt(WELCOME_STRIPE.items, 'board'),
    'welcome-projects': welcomeStripeAt(WELCOME_STRIPE.items, 'projects'),
    'welcome-sessions': welcomeStripeAt(WELCOME_STRIPE.items, 'sessions'),
  };
};

/** A Chat on a session of `entries` transcript entries, then `more` come: its trees before and after. */
const chatGrowing = (entries: number, more: number): [Node, Node] => {
  const W = '/home/me/projects/demo-shop-wt/4-cart-total';
  const at = (i: number) => new Date(Date.parse(minutes(0)) + i * 1000).toISOString();
  const entry = (i: number): TranscriptEntry => {
    const head = { at: at(i), agent: null };

    switch (i % 4) {
      case 0:
        return { ...head, kind: 'user', id: `u${i}`, text: `question ${i}`, context: null };
      case 1:
        return {
          ...head,
          kind: 'tool-use',
          id: `t${i}`,
          tool: 'Read',
          input: { file_path: `${W}/src/f${i}.ts` },
        };
      case 2:
        return {
          ...head,
          kind: 'tool-result',
          id: `t${i - 1}`,
          ok: true,
          text: 'line of output',
          cut: 0,
          patch: null,
        };
      default:
        return { ...head, kind: 'assistant-text', id: `a${i}`, text: `Words for ${i}.` };
    }
  };
  const x = { ...session('s4', 'working', 4), worktree: W };
  let held = step(LIVE_CHAT, LIVE_CHAT.init, {
    kind: 'open',
    params: { root: W, session: 's4' },
    size: { width: 420, height: 800 },
  });

  for (const input of [
    sessionsAnswer([x]),
    runsAnswer([]),
    {
      kind: 'result' as const,
      id: 'transcript',
      command: 'session transcript' as const,
      reply: {
        ok: true as const,
        data: {
          session: 's4',
          from: 0,
          entries: Array.from({ length: entries }, (_, i) => entry(i)),
        },
      },
    },
  ])
    held = step(LIVE_CHAT, held.state, input);
  const before = held.tree;

  held = step(LIVE_CHAT, held.state, {
    kind: 'event',
    event: {
      seq: 100,
      at: at(entries),
      type: 'session.transcript',
      data: {
        session: 's4',
        from: entries,
        entries: Array.from({ length: more }, (_, i) => entry(entries + i)),
      },
    },
  });

  return [before, held.tree];
};

/**
 * A slot's tree, then the next, as the bridge patches it (ADR 0036): `base`, the patch frame, and
 * `want`, the tree it gives. The window applies each and checks it gets `want`.
 */
const patches = (all: Readonly<Record<string, Node>>): Record<string, unknown> => {
  const tree = (name: string): Node => {
    const t = all[name];

    if (t === undefined) throw new Error(`no tree ${name}`);

    return t;
  };
  const pairs: Record<string, [string, string | undefined, Node, Node]> = {
    // a transcript entry on a Chat: one turn spliced in, never the transcript
    'chat-entry': ['chat', 'chat', ...chatGrowing(24, 1)],
    'chat-entries': ['chat', 'chat', ...chatGrowing(24, 6)],
    'chat-rendered-keys': ['chat', 'chat', tree('chat-rendered'), tree('chat-rendered-keys')],
    'factory-team': ['factory', undefined, tree('factory-overview'), tree('factory-team')],
    'factory-filter': ['factory', undefined, tree('factory-overview'), tree('factory-filter')],
    'sessions-filter': ['sessions', 'pane', tree('sessions'), tree('sessions-filter')],
    'welcome-team': ['welcome', undefined, tree('welcome'), tree('welcome-team')],
  };

  return Object.fromEntries(
    Object.entries(pairs).map(([name, [screen, slot, base, want]]) => [
      name,
      {
        base,
        frame: {
          v: UI_CONTRACT,
          type: 'patch',
          screen,
          rev: 2,
          base: 1,
          ops: patchOf(base, want),
          ...(slot === undefined ? {} : { slot }),
        },
        want,
      },
    ]),
  );
};

/** Every file of the contract, by path under `contract/`. */
const files = (): Record<string, string> => {
  const all = trees();

  return {
    'schema.json': json(schema()),
    ...Object.fromEntries(
      Object.entries(all).map(([name, tree]) => [`trees/${name}.json`, json(tree)]),
    ),
    'unknown/needs-component.json': json(UNKNOWN),
    ...Object.fromEntries(
      Object.entries(patches(all)).map(([name, doc]) => [`patches/${name}.json`, json(doc)]),
    ),
    ...Object.fromEntries(
      Object.entries(stripeFiles()).map(([name, doc]) => [`stripe/${name}.json`, json(doc)]),
    ),
    ...Object.fromEntries(
      Object.entries(
        frames(all['factory-overview'] ?? statusTree(), all['command-pick'] ?? commandTree('')),
      ).map(([name, f]) => [`frames/${name}.json`, json(f)]),
    ),
    // The overview after each of REPLAY_KEYS: the shell's fake bridge answers its keys with these.
    'replay/factory/keys.json': json(REPLAY_KEYS),
    ...Object.fromEntries(
      replay().map((tree, i) => [
        `replay/factory/${i}.json`,
        json({ v: UI_CONTRACT, type: 'tree', screen: 'factory', rev: i + 1, tree }),
      ]),
    ),
  };
};

const onDisk = (): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(DIR, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;

      if (entry.isDirectory()) walk(path);
      else found[path] = readFileSync(join(DIR, path), 'utf8');
    }
  };

  try {
    walk('');
  } catch {
    return {};
  }

  return found;
};

if (process.env.ABE_WRITE_CONTRACT === '1') {
  rmSync(DIR, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files())) {
    mkdirSync(dirname(join(DIR, path)), { recursive: true });
    writeFileSync(join(DIR, path), text);
  }
}

describe('the contract files', () => {
  test('on disk are what the code writes (ABE_WRITE_CONTRACT=1 writes them)', () => {
    expect(onDisk()).toEqual(files());
  });

  test('every tree parses, the unknown kind does not', () => {
    for (const tree of Object.values(trees())) expect(Node.safeParse(tree).success).toBe(true);
    expect(Node.safeParse(UNKNOWN).success).toBe(false);
  });

  test('every patch on file is a bridge frame that gives its want from its base, never the tree', () => {
    const docs = Object.values(patches(trees()));

    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      const p = z.object({ base: Node, frame: BridgeFrame, want: Node }).parse(doc);

      if (p.frame.type !== 'patch') throw new Error('not a patch');
      expect(p.frame.ops.some((op) => op.path.length === 0)).toBe(false);
      expect(applyPatch(p.base, p.frame.ops)).toEqual(p.want);
    }
  });

  test('every frame is its side’s', () => {
    for (const [name, frame] of Object.entries(frames(statusTree(), commandTree('')))) {
      const side = name.startsWith('app-') ? AppFrame : BridgeFrame;

      expect(side.safeParse(frame).success).toBe(true);
    }
  });

  test('the fixtures draw every kind of the set', () => {
    const kinds = new Set<string>();
    const walk = (n: Node) => {
      kinds.add(n.kind);
      if ('children' in n) for (const c of n.children ?? []) walk(c);
    };

    for (const [name, tree] of Object.entries(trees()))
      if (
        [
          'status-',
          'factory-',
          'command-',
          'chat-',
          'settings-',
          'cards-',
          'composer-',
          'sessions',
          'linked',
          'review-',
          'pipelines-',
          'local-',
          'run-',
          'card-page',
          'prototype-',
        ].some((p) => name.startsWith(p))
      )
        walk(tree);
    expect([...kinds].sort()).toEqual([...KINDS].sort());
  });
});
