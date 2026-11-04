/**
 * Command mode (`:`, spec #36 story 74, ticket #69): a pick of every command `abe help --json`
 * lists as runnable here, beside the words screens add (`:factory`) and your personal commands.
 * Typing filters at once, every letter; ↑ ↓ ⌃N ⌃P move; ⏎ asks a command's required arguments one
 * PromptLayer at a time (an enum's values as a pick), asks before a risky one (ConfirmLayer, No
 * the default) and runs it through `serve` as any client would. A success's one line goes to the
 * status line, a refusal to a balloon in its own words with its code. Esc closes the top layer
 * first. `::` (a `:` on the empty filter) is Neovim's own command line.
 *
 * The rows come only from the command table: a command that runs only inside a session, or only
 * in the `abe` client's terminal (`only`), is not listed. `:improve <wish>` says `/abe:improve
 * <wish>` to the repo's Abe chat in the Chat column.
 */
import type { ArgInfo, HelpData } from '@abe/core';
import { commandRows, type Entry, entries, filtered, type Row, typedAfter } from './command-rows';
import { type Node } from '../runtime/components';
import { localTimes, sentence } from '../runtime/said';
import { type Field, caretOf, caretProp, fieldInsert, fieldKey, fieldOf } from '../runtime/field';
import {
  isNewCardPick,
  isNewCardRun,
  NEW_CARD_MENU,
  type NewCardForm,
  type NewCardLayer,
  type NewCardOn,
  type NewCardStep,
  newCardDialog,
  onNewCard,
  onNewCardResult,
  openNewCard,
  picked,
  runBoard,
} from './new-card';
import { EVERY_KEY_MENU, KEY_HELP, KEY_HELP_MENU, keyHelp } from './keys';
import { shortRerun } from '../board/launch-short';
import {
  type LaunchDraft,
  type LaunchLayer,
  REACH_RUN,
  REFERENCE_RUN,
  STANDING_RUN,
  WORKFLOWS_RUN,
  onLaunch,
  onReach,
  onReference,
  onStanding,
  onWorkflows,
  openLaunch,
  viewLaunch,
} from './launch-box';
import { type ListMove, PAGE_ROWS, listMove, menuMove, movedRow } from '../runtime/list-moves';
import {
  LINKED_RUN,
  type LinkedLayer,
  type LinkedStep,
  linkedResult,
  onLinked,
  openLinked,
  viewLinked,
} from '../linked/linked';
import {
  type CardDialog,
  type CommentBox,
  type ConfirmLayer,
  PRIMARY_BOX,
  type PickLayer,
  type PickRow,
  type PromptLayer,
  type ThreadComment,
} from '../runtime/layers';
import {
  type Command,
  type CommentOn,
  type HereInput,
  type Dialog,
  type Input,
  type LayerScreen,
  type Menu,
  type MenuAsk,
  type MenuRow,
  type Question,
  type Word,
} from '../runtime/runtime';

export { type Entry, entries, matchScore } from './command-rows';

/** Rows a pick shows at once; the screen scrolls the window to keep the cursor in it. */
export const PICK_ROWS = 12;

/** A run not answered yet: the command as typed, and what it says once it went through. */
type Running = {
  typed: string;
  done?: string | undefined;
  chosen: boolean;
  /** What ran: a `box-short` refusal asks its question, the answer run again with it (#9). */
  argv?: readonly string[] | undefined;
};

/** A filtering list: the filter typed (its caret, `field.ts`: absent at the end) and the cursor. */
type List = { filter: string; caret?: number | undefined; cursor: number; top: number };

/**
 * The layers, bottom first: the commands' pick (or a screen's card dialog, then its Action menu),
 * then an argument asked each, then a confirm.
 */
type Layer =
  /** The `:` line (#346): `moved` once a move key took the cursor off where ⏎ rests. */
  | ({ kind: 'pick'; moved?: true | undefined } & List)
  | ({ kind: 'menu'; menu: Menu } & List)
  /** `sheet`: the Sheets row the keys are on (Tab), none while the body has them; `g` typed. */
  | DialogLayer
  | AskLayer
  | ({ kind: 'choose'; arg: MenuAsk; value?: string | undefined } & List)
  | { kind: 'confirm'; focus: 'risky' | 'no' }
  | CommentLayer
  | LaunchLayer
  /** The New card dialog (#346). */
  | NewCardLayer
  /** ⌃L's Linked popup (#109): over the view alone. */
  | LinkedLayer;

/** An argument asked: its field's text and caret (absent: at the end), why ⏎ refused it. */
type AskLayer = {
  kind: 'ask';
  arg: MenuAsk;
  text: string;
  caret?: number | undefined;
  error?: string | undefined;
};

type DialogLayer = {
  kind: 'dialog';
  dialog: Dialog;
  scroll: number;
  sheet?: number | undefined;
  g?: boolean | undefined;
  /**
   * When it opened, and when its last ⏎ came (ms, the clock's `now`): the primary takes no ⏎
   * within `PRIMARY_GUARD_MS` of either (#285). Unknown without a clock.
   */
  opened?: number | undefined;
  enter?: number | undefined;
  /** How far its page scrolls as the app drew it (`extent`, #253); none yet: the estimate. */
  extent?: number | undefined;
  /** Scrolled to its end (`G`, or `ö` there): a new extent keeps it at the end. */
  end?: boolean | undefined;
  /** The button the keys are on (← → Tab); none: the primary. */
  button?: string | undefined;
};

/** How a key moves between a layer's buttons: ← → stop at the ends, Tab and ⇧Tab wrap. */
const BUTTON_STEPS: Readonly<Record<string, { by: 1 | -1; wraps: boolean }>> = {
  k: { by: -1, wraps: false },
  '<Left>': { by: -1, wraps: false },
  ä: { by: 1, wraps: false },
  '<Right>': { by: 1, wraps: false },
  '<Tab>': { by: 1, wraps: true },
  '<S-Tab>': { by: -1, wraps: true },
};

/** The button `key` moves the keys to from `at`, of `ids` in order; none: not a button key. */
const buttonStep = <T extends string>(ids: readonly T[], at: T, key: string): T | undefined => {
  const step = BUTTON_STEPS[key];

  if (step === undefined || ids.length === 0) return undefined;
  const to = ids.indexOf(at) + step.by;

  return step.wraps
    ? ids[(to + ids.length) % ids.length]
    : ids[Math.max(0, Math.min(ids.length - 1, to))];
};

/**
 * How long a dialog's primary waits for its ⏎ (#285): from the dialog opening, and from the ⏎
 * before (a held ⏎'s repeats keep it waiting), so the ⏎ that opened a story, a double ⏎ or one
 * held never also launches. The bridge stamps the clock before a dialog and before each ⏎.
 */
export const PRIMARY_GUARD_MS = 500;

/** The clock's `now` in ms, or undefined before the first tick. */
const msOf = (now: string | undefined): number | undefined => {
  const ms = now === undefined ? Number.NaN : Date.parse(now);

  return Number.isFinite(ms) ? ms : undefined;
};

/** How far a dialog's page scrolls: as drawn once the app said, else its source's estimate. */
const pageLines = (l: DialogLayer): number => l.extent ?? l.dialog.lines;

/** The app measured a dialog's page (#253): its scroll within it, at the end if it was there. */
const withExtent = (state: CommandState, id: string, lines: number): CommandState => ({
  ...state,
  layers: state.layers.map((l) =>
    l.kind !== 'dialog' || l.dialog.dialog.id !== id
      ? l
      : { ...l, extent: lines, scroll: l.end === true ? lines : Math.min(l.scroll, lines) },
  ),
});

/** The CommentBox on a card: its thread once read, the draft, a post under way or failed. */
type CommentLayer = {
  kind: 'comment';
  on: CommentOn;
  draft: string;
  /** The draft's caret (`field.ts`); absent: at its end. */
  caret?: number | undefined;
  thread?: { comments: ThreadComment[]; destination: string } | { error: string } | undefined;
  posting: boolean;
  error?: string | undefined;
};

export type CommandState = {
  layers: Layer[];
  /** The row ⏎ took, while its arguments are asked. */
  entry?: Entry | undefined;
  help?: HelpData | undefined;
  /** Why the last `help` read failed. */
  failed?: string | undefined;
  /** Runs not answered yet, by id. */
  running: Readonly<Record<string, Running>>;
  runs: number;
  /** A CommentBox's draft per card, kept when it closes unposted (Esc, a failed post). */
  drafts: Readonly<Record<number, string>>;
  /** A Launch box's note and Grill pick per card, kept when it closes with no launch (Esc). */
  launchDrafts: Readonly<Record<number, LaunchDraft>>;
  /** The New card dialog's form per board, kept when it closes uncreated (Esc, refused, #346). */
  newCards?: Readonly<Record<string, NewCardForm>> | undefined;
  /** The clock (the bridge's `tick`), for a Linked opened between two. */
  now?: string | undefined;
  /** Where `:` or `?` was last pressed (#346): the bridge says it just before the key. */
  here?: HereInput | undefined;
};

const INIT: CommandState = { layers: [], running: {}, runs: 0, drafts: {}, launchDrafts: {} };

/** Whether an input opens Command mode (while no layer is up). */
export const opensCommandMode = (input: Input): boolean =>
  input.kind === 'key' && input.key === ':';

/**
 * `?` while no layer is up: this view's keys, `??` every key (`keys.ts`). The bridge takes it
 * from `main` alone, and not while its screen types (`Screen.typing`: the `/` filter).
 */
export const opensKeyHelp = (input: Input): boolean =>
  input.kind === 'key' && input.key === KEY_HELP;

const usageOf = (ask: readonly ArgInfo[]): string =>
  ask
    .map((a) => {
      const value = a.values?.join('|') ?? `<${a.name}>`;

      return a.kind === 'positional' ? value : `--${a.name} ${value}`;
    })
    .join(' ');

/** Where the pick's window starts so the cursor stays in it. */
const scrolled = (list: List): List => {
  if (list.cursor < list.top) return { ...list, top: list.cursor };
  if (list.cursor >= list.top + PICK_ROWS) return { ...list, top: list.cursor - PICK_ROWS + 1 };

  return list;
};

const moved = (list: List, m: ListMove, count: number): List =>
  count === 0 ? list : scrolled({ ...list, cursor: movedRow(m, list.cursor, count) });

/** A menu's or pick's own steps beside every menu's moves (`list-moves.ts`): Tab ⇧Tab. */
const STEPS: Readonly<Record<string, number>> = { '<S-Tab>': -1, '<Tab>': 1 };

/**
 * The `:` line's moves (#346): it is a text line, as Vim's `:` is, so every letter types (`k l ö
 * ä` too: `look`, `card list`); ↑ ↓, ⌃N ⌃P and Tab ⇧Tab move the rows, PageUp / PageDown a page.
 * Home / End stay its caret's. The other layers keep every menu's moves (`menuMove`).
 */
const LINE_MOVES: Readonly<Record<string, ListMove>> = {
  '<Up>': { kind: 'by', rows: -1 },
  '<Down>': { kind: 'by', rows: 1 },
  '<C-p>': { kind: 'by', rows: -1 },
  '<C-n>': { kind: 'by', rows: 1 },
  '<S-Tab>': { kind: 'by', rows: -1 },
  '<Tab>': { kind: 'by', rows: 1 },
  '<PageUp>': { kind: 'by', rows: -PICK_ROWS },
  '<PageDown>': { kind: 'by', rows: PICK_ROWS },
};

/** A move on a menu or pick: every menu's (#334: Home / End the first and last row), or a step. */
const listMoveOf = (key: string): ListMove | undefined => {
  const step = STEPS[key];

  if (step !== undefined) return { kind: 'by', rows: step };

  return menuMove(key, PICK_ROWS);
};

/** The list with its filter's field after a key: a new text puts the cursor on the first row. */
const withFilterField = (list: List, f: Field): List =>
  f.text === list.filter
    ? { ...list, caret: caretProp(f) }
    : { filter: f.text, caret: caretProp(f), cursor: 0, top: 0 };

/**
 * A key or text on a filtering list: moved, typed, or neither (`undefined`). ↑ ↓ move the cursor;
 * every letter types; ← → and the rest of a macOS field's keys are the filter's (`field.ts`, #314).
 */
const onList = (list: List, input: Input, count: number): List | undefined => {
  const f = fieldOf(list.filter, list.caret);

  if (input.kind === 'text')
    return withFilterField(list, fieldInsert(f, input.text.replaceAll('\n', ' ')));
  if (input.kind !== 'key') return undefined;
  const m = listMoveOf(input.key);

  if (m !== undefined) return moved(list, m, count);
  const next = fieldKey(f, input.key);

  return next === undefined ? undefined : withFilterField(list, next);
};

/** A key or text on the `:` line (#346): every letter types, `LINE_MOVES` move the rows. */
const onLine = (list: List, input: Input, count: number): List | undefined => {
  const f = fieldOf(list.filter, list.caret);

  if (input.kind === 'text')
    return withFilterField(list, fieldInsert(f, input.text.replaceAll('\n', ' ')));
  if (input.kind !== 'key') return undefined;
  const m = LINE_MOVES[input.key];

  if (m !== undefined) return moved(list, m, count);
  const next = fieldKey(f, input.key);

  return next === undefined ? undefined : withFilterField(list, next);
};

/** A key or text on a prompt's field (`field.ts`): the field after it, or `undefined`. */
const onField = (f: Field, input: Input): Field | undefined => {
  if (input.kind === 'text') return fieldInsert(f, input.text.replaceAll('\n', ' '));
  if (input.kind !== 'key') return undefined;

  return fieldKey(f, input.key);
};

/** What a layer step gives: the next state and what to do. */
type Out = { state: CommandState; commands: Command[] };

const same = (state: CommandState): Out => ({ state, commands: [] });

const withTop = (state: CommandState, top: Layer): CommandState => ({
  ...state,
  layers: [...state.layers.slice(0, -1), top],
});

const pop = (state: CommandState): CommandState => {
  const layers = state.layers.slice(0, -1);

  return layers.length === 0 ? { ...state, layers, entry: undefined } : { ...state, layers };
};

const READ_HELP: Command = { kind: 'run', id: 'help', argv: ['help'] };

/**
 * `:`: the line over the layers up (none, or a dialog's), the table read afresh; its rows start
 * from where it was opened (`here`, #346).
 */
const opened = (state: CommandState): Out => ({
  state: { ...state, layers: [...state.layers, { kind: 'pick', filter: '', cursor: 0, top: 0 }] },
  commands: [{ kind: 'shell', effect: { kind: 'status', text: '' } }, READ_HELP],
});

/** The key help's menus: ⏎ or a click on a row closes only it (a dialog under it stays). */
const isKeyHelp = (menu: Menu) => menu.id === KEY_HELP_MENU || menu.id === EVERY_KEY_MENU;

const valuesOf = (arg: ArgInfo): string[] =>
  arg.values ?? (arg.type === 'boolean' ? ['true', 'false'] : []);

/** A value as its pick row reads: its label (`Me`), else itself. */
const labelOf = (arg: MenuAsk, value: string): string => arg.labels?.[value] ?? value;

/** The values the filter finds: by their labels, then by their unshown words (Me by your name). */
const shownValues = (arg: MenuAsk, filter: string): string[] =>
  filtered(valuesOf(arg), filter, (v) => [labelOf(arg, v), arg.words?.[v] ?? '']);

/** The asked values so far, in the order of `entry.ask`. */
const answers = (state: CommandState): string[] =>
  state.layers.flatMap((l) => {
    if (l.kind === 'ask') return [l.text.trim()];

    return l.kind === 'choose' && l.value !== undefined ? [l.value] : [];
  });

/** `entry`'s argv with `values` for its asked arguments. */
export const argvOf = (entry: Entry, values: readonly string[]): string[] => [
  ...entry.argv,
  ...entry.ask.flatMap((arg, i) => {
    const value = values[i] ?? '';

    if (arg.kind === 'positional')
      return arg.repeats ? value.split(/\s+/).filter((w) => w !== '') : [value];
    if (arg.type === 'boolean') return value === 'true' ? [`--${arg.name}`] : [];

    return [`--${arg.name}`, value];
  }),
];

/** A word's commands, given its asked values. */
const wordCommands = (commands: NonNullable<Entry['commands']>, values: readonly string[]) =>
  typeof commands === 'function' ? [...commands(values)] : [...commands];

/** `:improve <wish>`'s run: `/abe:improve <wish>` said to the repo's Abe chat. */
const IMPROVE_CHAT_RUN = 'improve-chat:';

/** `:improve <wish>`: the Abe chat follows /abe:improve on the wish (none: it asks for one). */
const improveChat = (state: CommandState, wish: string): Out => ({
  state: { ...state, layers: [], entry: undefined, runs: state.runs + 1 },
  commands: [
    {
      kind: 'run',
      id: `${IMPROVE_CHAT_RUN}${state.runs + 1}`,
      argv: ['chat', '/abe:improve', ...(wish.trim() === '' ? [] : [wish.trim()])],
    },
  ],
});

/** The Abe chat's answer: Chat pinned on it and shown; refused, said. */
const onImproveChat = (state: CommandState, input: Input & { kind: 'result' }): Out => {
  if (input.command !== 'chat') return same(state);
  if (input.reply.ok)
    return {
      state,
      commands: [
        { kind: 'open', screen: 'chat', params: { session: input.reply.data.id }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
      ],
    };

  return {
    state,
    commands: [
      {
        kind: 'shell',
        effect: {
          kind: 'balloon',
          tone: 'error',
          text: `${input.reply.error.message} (${input.reply.error.code})`,
        },
      },
    ],
  };
};

const run = (state: CommandState, entry: Entry): Out => {
  if (entry.improve === true) return improveChat(state, answers(state)[0] ?? '');
  if (entry.commands !== undefined)
    return {
      state: { ...state, layers: [], entry: undefined },
      commands: wordCommands(entry.commands, answers(state)),
    };
  const id = `run:${state.runs + 1}`;
  const values = answers(state);
  const argv = argvOf(entry, values);
  const done = typeof entry.done === 'function' ? entry.done(values) : entry.done;

  return {
    state: {
      ...state,
      layers: [],
      entry: undefined,
      runs: state.runs + 1,
      running: {
        ...state.running,
        [id]: { typed: argv.join(' '), done, chosen: entry.chosen === true, argv },
      },
    },
    commands: [{ kind: 'run', id, argv }],
  };
};

const askLayer = (arg: MenuAsk): Layer => {
  const values = valuesOf(arg);

  // a field starts on its preselected text (a workflow input's default), the caret at its end
  if (values.length === 0) return { kind: 'ask', arg, text: arg.preselect ?? '' };
  // the cursor on its preselected value (#320), else the first
  const at = arg.preselect === undefined ? -1 : values.indexOf(arg.preselect);

  return { kind: 'choose', arg, ...scrolled({ filter: '', cursor: Math.max(0, at), top: 0 }) };
};

/** The next step once a row or an answer is in: the next argument, the confirm, or the run. */
const advance = (state: CommandState): Out => {
  const entry = state.entry;

  if (entry === undefined) return same(state);
  const asked = answers(state).length;
  const next = entry.ask[asked];

  if (next !== undefined) return same({ ...state, layers: [...state.layers, askLayer(next)] });
  if (entry.risky && state.layers.at(-1)?.kind !== 'confirm')
    return same({ ...state, layers: [...state.layers, { kind: 'confirm', focus: 'no' }] });

  return run(state, entry);
};

const choose = (state: CommandState, entry: Entry, filter = ''): Out => {
  // a word with one argument typed after it (`:show cart`): run with that, nothing asked
  const after = typedAfter(entry, filter);
  const [arg] = entry.ask;
  const rest = filter.trimStart().slice(entry.name.length).trim();

  // a command of one argument with it typed after its name (`card show 4`): that is its value
  if (
    entry.commands === undefined &&
    entry.improve !== true &&
    arg !== undefined &&
    entry.ask.length === 1 &&
    filter.trimStart().toLowerCase().startsWith(`${entry.name.toLowerCase()} `) &&
    rest !== '' &&
    refusedValue(arg, rest) === undefined &&
    (valuesOf(arg).length === 0 || valuesOf(arg).includes(rest))
  )
    return advance({
      ...state,
      entry,
      layers: [...state.layers, { kind: 'ask', arg, text: rest }],
    });

  // `:improve <wish>`: the Abe chat follows /abe:improve on it
  if (entry.improve === true) return improveChat(state, after ?? '');
  if (entry.commands !== undefined && entry.ask.length === 1 && after !== undefined && after !== '')
    return {
      state: { ...state, layers: [], entry: undefined },
      commands: wordCommands(entry.commands, [after]),
    };

  return entry.commands === undefined || entry.ask.length > 0
    ? advance({ ...state, entry })
    : {
        state: { ...state, layers: [], entry: undefined },
        commands: wordCommands(entry.commands, []),
      };
};

/** Anywhere's rows (#346): the window's own, from every view. */
const ANYWHERE: Menu = {
  kind: 'menu',
  id: 'anywhere',
  title: 'Anywhere',
  rows: [
    {
      id: 'search',
      text: 'Search Everywhere',
      key: '⇧⇧',
      does: { kind: 'shell', effect: { kind: 'app', action: 'search-everywhere' } },
    },
    {
      id: 'settings',
      text: 'Settings',
      key: '⌘,',
      // the Settings dialog's own screen (`settings.ts` SETTINGS_SCREEN), as `:settings` opens it
      does: { kind: 'do', commands: [{ kind: 'open', screen: 'settings' }] },
    },
    {
      id: 'recent',
      text: 'Recent projects',
      key: '⌘⇧O',
      does: { kind: 'shell', effect: { kind: 'app', action: 'recent-projects' } },
    },
    {
      // the Project tree's Abe node: the workflows and skills in force, read in the Editor
      id: 'workflows',
      text: 'Workflows',
      key: ':workflows',
      does: { kind: 'shell', effect: { kind: 'app', action: 'workflows' } },
    },
  ],
};

/** Anywhere's rows: Search Everywhere, Settings, Improve VimStorm…, Recent projects, Workflows, Keys. */
const anywhereRows = (all: readonly Entry[]): Row[] => {
  const improve = all.find((e) => e.improve === true);
  const [search, settings, recent, workflows] = ANYWHERE.rows.map((r): Row => ({
    id: `anywhere:${r.id}`,
    text: r.text,
    ...(r.key === undefined ? {} : { note: r.key }),
    does: { kind: 'row', menu: ANYWHERE, row: r },
  }));

  return [
    ...(search === undefined ? [] : [search]),
    ...(settings === undefined ? [] : [settings]),
    ...(improve === undefined
      ? []
      : [
          {
            id: 'anywhere:improve',
            text: 'Improve VimStorm…',
            dim: 'say what to change',
            does: { kind: 'entry' as const, entry: improve },
          },
        ]),
    ...(recent === undefined ? [] : [recent]),
    ...(workflows === undefined ? [] : [workflows]),
    { id: 'anywhere:keys', text: 'Keys', note: '?', does: { kind: 'keys' } },
  ];
};

/** The `:` line's rows now, and where ⏎ rests. */
const lineRows = (state: CommandState, words: readonly Word[], filter: string) => {
  const all = state.help === undefined ? [] : entries(state.help, words);

  const shown = commandRows({
    here: state.here,
    entries: all,
    anywhere: anywhereRows(all),
    filter,
  });
  // typed while the table could not be read: More says why, grey
  const failed: Row[] =
    filter.trim() !== '' && state.help === undefined && state.failed !== undefined
      ? [
          {
            id: 'more:failed',
            text: 'Commands',
            reason: state.failed,
            section: 'More',
            does: { kind: 'keys' },
          },
        ]
      : [];

  return { rows: [...shown.rows, ...failed], resting: shown.resting };
};

/** The row the cursor is on: where ⏎ rests until a move took it elsewhere. */
const lineCursor = (top: { moved?: true | undefined } & List, resting: number): number =>
  top.moved === true ? top.cursor : resting;

/** `abe chat`'s run: its answer pins Chat on the repo's Abe chat. */
const ASK_RUN = 'ask-run:';

/** Words said to the Abe chat: `abe chat <words> (about <the Subject>)`, Chat pinned on it once it answers. */
const asked = (state: CommandState, words: string): Out => {
  const about = state.here?.here.subject?.caption;

  return {
    state: { ...state, layers: [], entry: undefined, runs: state.runs + 1 },
    commands: [
      {
        kind: 'run',
        id: `${ASK_RUN}${state.runs + 1}`,
        argv: [
          'chat',
          ...words.split(/\s+/).filter((w) => w !== ''),
          ...(about === undefined ? [] : [`(about ${about})`]),
        ],
      },
    ],
  };
};

/** The Abe chat opened: Chat pinned on it and shown; refused, said in a balloon. */
const onAsked = (state: CommandState, input: Input & { kind: 'result' }): Out => {
  if (input.command === 'chat' && input.reply.ok)
    return {
      state,
      commands: [
        { kind: 'open', screen: 'chat', params: { session: input.reply.data.id }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
      ],
    };

  return input.reply.ok
    ? same(state)
    : {
        state,
        commands: [
          {
            kind: 'shell',
            effect: {
              kind: 'balloon',
              tone: 'error',
              text: `${input.reply.error.message} (${input.reply.error.code})`,
            },
          },
        ],
      };
};

/** A row of the `:` line chosen: its entry, its menu row, an Ask, a Tell, Neovim's line, a menu. */
const chooseLineRow = (state: CommandState, row: Row, filter: string): Out => {
  const closed = { ...state, layers: [], entry: undefined };
  const d = row.does;

  if (row.reason !== undefined) return same(state);
  switch (d.kind) {
    case 'entry':
      return choose(state, d.entry, filter);
    case 'row':
      return chooseRow(state, d.menu, d.row);
    case 'ask':
      return asked(state, d.words);
    case 'tell':
      return run(state, {
        id: `tell:${d.session}`,
        name: `session send ${d.session}`,
        summary: row.text,
        argv: ['session', 'send', d.session, ...d.words.split(/\s+/).filter((w) => w !== '')],
        ask: [],
        risky: false,
        chosen: true,
        done: `Told ${row.text.replace(/^Tell /, '')}`,
      });
    case 'ex':
      return { state: closed, commands: [{ kind: 'shell', effect: { kind: 'ex', text: d.text } }] };
    // the Board opens it with what it knows of its board (types, sprint, kept form)
    case 'new':
      return {
        state: closed,
        commands: [{ kind: 'choice', menu: NEW_CARD_MENU, row: 'open', values: [d.words] }],
      };
    case 'all':
      return same({
        ...state,
        entry: undefined,
        layers: [...state.layers.slice(0, -1), menuLayer(d.menu)],
      });
    case 'keys':
      return same({
        ...state,
        entry: undefined,
        layers: [...state.layers.slice(0, -1), keyHelpLayer(state)],
      });
  }
};

/** The key help of where `?` (or Keys) was pressed: the surface with the keys (#346). */
const keyHelpLayer = (state: CommandState): Layer => ({
  kind: 'menu',
  menu: keyHelp(state.here?.here.keys ?? 'view'),
  filter: '',
  cursor: 0,
  top: 0,
});

const onPick = (
  state: CommandState,
  top: { kind: 'pick'; moved?: true | undefined } & List,
  input: Input,
  words: readonly Word[],
): Out => {
  const { rows, resting } = lineRows(state, words, top.filter);
  const at = lineCursor(top, resting);

  if (input.kind === 'key' && input.key === '<Esc>') return same(pop(state));
  if (input.kind === 'key' && input.key === ':' && top.filter === '')
    return {
      state: { ...state, layers: [], entry: undefined },
      commands: [{ kind: 'shell', effect: { kind: 'cmdline' } }],
    };
  if (input.kind === 'key' && input.key === '<CR>') {
    const row = at < 0 ? undefined : rows[at];

    return row === undefined ? same(state) : chooseLineRow(state, row, top.filter);
  }
  // ⌘⏎ while words are typed: New card on them, where a board is in force (#346)
  if (input.kind === 'key' && input.key === '<D-CR>') {
    const row = rows.find((r) => r.does.kind === 'new');

    return row === undefined ? same(state) : chooseLineRow(state, row, top.filter);
  }
  if (input.kind === 'click') {
    const row = rows.find((r) => r.id === input.id);

    return row === undefined ? same(state) : chooseLineRow(state, row, top.filter);
  }
  const list = onLine({ ...top, cursor: at }, input, rows.length);

  if (list === undefined) return same(state);
  // typed: the cursor rests where ⏎ goes for the new text; a move: where it took it
  if (list.filter !== top.filter)
    return same(
      withTop(state, { kind: 'pick', filter: list.filter, caret: list.caret, cursor: 0, top: 0 }),
    );
  // a move passes over grey rows, the way it went (from nowhere: the first that can run)
  if (isMove(input)) {
    const cursor = enabledFrom(rows, list.cursor, list.cursor < at ? -1 : 1);

    return same(withTop(state, { kind: 'pick', ...scrolled({ ...list, cursor }), moved: true }));
  }

  return same(withTop(state, { ...top, caret: list.caret }));
};

/** Whether the key is one of the `:` line's moves. */
const isMove = (input: Input): boolean =>
  input.kind === 'key' && LINE_MOVES[input.key] !== undefined;

const onChoose = (
  state: CommandState,
  top: { kind: 'choose'; arg: MenuAsk; value?: string | undefined } & List,
  input: Input,
): Out => {
  const shown = shownValues(top.arg, top.filter);
  const pick = (value: string | undefined) =>
    value === undefined ? same(state) : advance(withTop(state, { ...top, value }));

  if (input.kind === 'key' && input.key === '<Esc>') return same(pop(state));
  if (input.kind === 'key' && input.key === '<CR>') return pick(shown[top.cursor]);
  if (input.kind === 'click') return pick(shown.find((v) => `value:${v}` === input.id));
  const list = onList(top, input, shown.length);

  return list === undefined ? same(state) : same(withTop(state, { ...top, ...list }));
};

/** Why `text` is no value of `arg`, or `undefined`. */
const refusedValue = (arg: MenuAsk, text: string): string | undefined => {
  const value = text.trim();

  // an argument said not required (a workflow input without a default) may be left empty
  if (value === '' && arg.required) return `${arg.name} is needed`;
  if (arg.type === 'number' && !Number.isFinite(Number(value))) return `${arg.name} is a number`;

  return undefined;
};

const onAsk = (state: CommandState, top: AskLayer, input: Input): Out => {
  if (input.kind === 'key' && input.key === '<Esc>') return same(pop(state));
  if (input.kind === 'key' && input.key === '<CR>') {
    const error = refusedValue(top.arg, top.text);

    return error === undefined ? advance(state) : same(withTop(state, { ...top, error }));
  }
  const f = onField(fieldOf(top.text, top.caret), input);

  return f === undefined
    ? same(state)
    : same(withTop(state, { ...top, text: f.text, caret: caretProp(f), error: undefined }));
};

// ---------------------------------------------------------------- a screen's menu and dialog

/**
 * A menu's rows whose "title detail" holds the filter, the title's prefix first, then the
 * title, then the detail; the menu's order within one.
 */
const menuRows = (top: { menu: Menu } & List): MenuRow[] => {
  const f = top.filter.trim().toLowerCase();
  const score = (r: MenuRow): number | undefined => {
    const text = r.text.toLowerCase();

    if (text.startsWith(f)) return 0;
    if (text.includes(f)) return 1;

    return (r.dim ?? '').toLowerCase().includes(f) ? 2 : undefined;
  };

  return top.menu.rows
    .map((r, i) => ({ r, i, s: score(r) }))
    .filter((m): m is { r: MenuRow; i: number; s: number } => m.s !== undefined)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((m) => m.r);
};

/** A menu's or the `:` line's row: grey with its reason. */
type Greys = { reason?: string | undefined };

const isEnabled = (r: Greys | undefined): boolean => r !== undefined && r.reason === undefined;

/** The enabled row nearest `at` going `by` (then the other way); `at` when none is. */
const enabledFrom = (rows: readonly Greys[], at: number, by: 1 | -1): number => {
  for (const dir of [by, -by])
    for (let i = Math.max(0, Math.min(at, rows.length - 1)); i >= 0 && i < rows.length; i += dir)
      if (isEnabled(rows[i])) return i;

  return Math.max(0, Math.min(at, rows.length - 1));
};

/** A row ⏎ should not reach by accident: it spends, deletes, or asks yes / no first (#313, #278). */
const spends = (row: MenuRow): boolean =>
  row.costly === true ||
  row.risky === true ||
  ((row.does.kind === 'run' || row.does.kind === 'back') && row.does.confirm !== undefined) ||
  (row.does.kind === 'run' && row.does.risky === true);

/** Where a fast or held ⏎ is harmless: 0 runs nothing paid and asks nothing, 1 asks first, 2 spends. */
const harm = (row: MenuRow): 0 | 1 | 2 => {
  if (spends(row)) return 2;

  const asks = row.does.kind === 'run' || row.does.kind === 'back' ? row.does.ask : undefined;

  return (asks?.length ?? 0) > 0 ? 1 : 0;
};

/**
 * Where a menu's cursor rests unfiltered (#313): its first row that can run and spends nothing,
 * one that asks nothing before one that asks first (a held ⏎ goes no further than that row's own
 * box or pick); none (-1) when every row spends, so ⏎ chooses nothing until a move picks one.
 * Costly and risky rows keep their place in the order.
 */
const restingCursor = (rows: readonly MenuRow[]): number => {
  const at = (h: 0 | 1) => rows.findIndex((r) => isEnabled(r) && harm(r) === h);
  const none = at(0);

  return none === -1 ? at(1) : none;
};

/** Where a menu opens unfiltered: on its `preselect` (grey too when it says so), else resting. */
const openingCursor = (menu: Menu, rows: readonly MenuRow[]): number => {
  const at = rows.findIndex(
    (r) => r.id === menu.preselect && (isEnabled(r) || menu.greyPreselect === true),
  );

  return at === -1 ? restingCursor(rows) : at;
};

const menuLayer = (menu: Menu): Layer => {
  const list = { filter: '', cursor: 0, top: 0 };
  const cursor = openingCursor(menu, menu.rows);

  return { kind: 'menu', menu, ...(cursor === -1 ? list : scrolled({ ...list, cursor })), cursor };
};

/** A chosen row: handed back, a shell effect, or its command asked and run; a grey one nothing. */
const chooseRow = (state: CommandState, menu: Menu, row: MenuRow | undefined): Out => {
  // a New card field's pick (#346): its value back on the dialog under it
  if (isNewCardPick(menu.id)) return onNewCardPick(state, menu.id, row);
  if (row === undefined || !isEnabled(row)) return same(state);
  const closed = { ...state, layers: [], entry: undefined };

  switch (row.does.kind) {
    case 'back': {
      const { ask, confirm } = row.does;

      if (ask === undefined && confirm === undefined)
        return { state: closed, commands: [{ kind: 'choice', menu: menu.id, row: row.id }] };

      // its values asked and its question answered first, then handed back with the values
      return advance({
        ...state,
        entry: {
          id: `menu:${menu.id}:${row.id}`,
          name: row.text,
          summary: row.text,
          argv: [],
          ask: ask ?? [],
          risky: confirm !== undefined,
          commands: (values) => [
            {
              kind: 'choice',
              menu: menu.id,
              row: row.id,
              ...(values.length === 0 ? {} : { values }),
            },
          ],
          ...(confirm === undefined
            ? {}
            : {
                asks: asksOf(confirm),
              }),
        },
      });
    }
    case 'shell':
      return { state: closed, commands: [{ kind: 'shell', effect: row.does.effect }] };
    case 'do':
      return { state: closed, commands: [...row.does.commands] };
    case 'run': {
      const { confirm, done } = row.does;

      return advance({
        ...state,
        entry: {
          id: `menu:${menu.id}:${row.id}`,
          name: row.does.argv.join(' '),
          summary: row.text,
          argv: row.does.argv,
          ask: row.does.ask ?? [],
          risky: (row.does.risky ?? false) || confirm !== undefined,
          chosen: true,
          done,
          ...(confirm === undefined
            ? {}
            : {
                asks: asksOf(confirm),
              }),
        },
      });
    }
  }
};

const ERASES = new Set(['<BS>', '<C-u>', '<D-BS>']);

const onMenu = (state: CommandState, top: { kind: 'menu'; menu: Menu } & List, input: Input) => {
  const rows = menuRows(top);

  if (input.kind === 'key' && (input.key === '<Esc>' || input.key === '<D-CR>'))
    return same(pop(state));
  if (
    isKeyHelp(top.menu) &&
    (input.kind === 'click' || (input.kind === 'key' && input.key === '<CR>'))
  )
    return same(pop(state));
  if (input.kind === 'key' && input.key === '<CR>')
    return chooseRow(state, top.menu, rows[top.cursor]);
  // a row's letter as the first key, before any filter text (Terminate…'s `t`); later it types
  const lettered =
    input.kind === 'key' && top.filter === ''
      ? top.menu.rows.find((r) => r.letter === input.key && isEnabled(r))
      : undefined;

  if (lettered !== undefined) return chooseRow(state, top.menu, lettered);
  if (input.kind === 'click')
    return chooseRow(
      state,
      top.menu,
      rows.find((r) => r.id === input.id),
    );
  const list = onList(top, input, rows.length);

  if (list === undefined) return same(state);
  // ⌫ or ⌃U on an empty filter: nothing to erase, the cursor stays
  if (list.filter === top.filter && input.kind === 'key' && ERASES.has(input.key))
    return same(state);
  if (list.filter !== top.filter) {
    const next = menuRows({ ...top, ...list });
    // typed: the first match, whatever it does; erased: where the menu rested (#313)
    const cursor = list.filter === '' ? openingCursor(top.menu, next) : enabledFrom(next, 0, 1);

    return same(withTop(state, { ...top, ...list, cursor, top: 0 }));
  }
  // a move passes over grey rows, the way it went
  const by = list.cursor < top.cursor ? -1 : 1;

  return same(
    withTop(state, {
      ...top,
      ...scrolled({ ...list, cursor: enabledFrom(rows, list.cursor, by) }),
    }),
  );
};

/** A key while the keys are in the dialog's Sheets rows (Tab): move, show one, or back. */
const onDialogSheets = (
  state: CommandState,
  top: DialogLayer,
  at: number,
  input: Input,
  back: (row: string, close: boolean) => Out,
): Out => {
  const rows = top.dialog.dialog.props.sheets?.rows ?? [];

  if (input.kind !== 'key') return same(state);
  // `gg`: the second `g` (a `g` waits on the dialog's layer, as for its scroll)
  const key = top.g === true && input.key === 'g' ? 'gg' : input.key;

  if (key === 'g') return same(withTop(state, { ...top, g: true }));
  const enabled = top.dialog.dialog.props.buttons.filter((b) => b.reason === undefined);

  switch (key) {
    case '<Esc>':
      return same(withTop(state, { ...top, g: false, sheet: undefined }));
    // on to the buttons: Tab the first, ⇧Tab the last
    case '<Tab>':
    case '<S-Tab>':
      return same(
        withTop(state, {
          ...top,
          g: false,
          sheet: undefined,
          button: (key === '<Tab>' ? enabled[0] : enabled.at(-1))?.id,
        }),
      );
    case '<CR>': {
      const row = rows[at];

      return row === undefined ? same(state) : back(row.id, true);
    }
    case '<D-CR>':
      return back('menu', false);
    default: {
      const m = listMove(key, PAGE_ROWS);

      if (m === undefined || rows.length === 0) return same(withTop(state, { ...top, g: false }));

      return same(withTop(state, { ...top, g: false, sheet: movedRow(m, at, rows.length) }));
    }
  }
};

/** A Linked row's click id in a card dialog (`dialog:linked:pr`). */
const DIALOG_LINK = 'dialog:linked:';

const onDialog = (state: CommandState, top: DialogLayer, input: Input): Out => {
  const d = top.dialog;
  const back = (row: string, close: boolean): Out => ({
    state: close ? { ...state, layers: [], entry: undefined } : state,
    commands: [{ kind: 'choice', menu: d.id, row }],
  });
  const rows = d.dialog.props.sheets?.rows ?? [];

  // a click on a Linked row (#107 S3): handed back as `linked:<key>`, the dialog closed
  if (input.kind === 'click' && input.id.startsWith(DIALOG_LINK)) {
    const link = d.dialog.props.linked?.find((l) => l.id === input.id);

    return link === undefined || link.dim === true
      ? same(state)
      : back(input.id.slice('dialog:'.length), true);
  }
  // a click on a Sheets row shows it, wherever the keys are
  if (input.kind === 'click' && rows.some((r) => r.id === input.id)) return back(input.id, true);
  // `?` the dialog's keys over it, `:` every command over it (#281); Esc back to the dialog
  // (a `g` typed before them waits no more)
  if (opensKeyHelp(input)) {
    const help = keyHelp(d.dialog.props.heading === undefined ? 'dialog' : 'story');
    const under = withTop(state, { ...top, g: false });

    return same({
      ...under,
      layers: [...under.layers, { kind: 'menu', menu: help, filter: '', cursor: 0, top: 0 }],
    });
  }
  if (opensCommandMode(input)) return opened(withTop(state, { ...top, g: false }));
  if (top.sheet !== undefined && rows.length > 0)
    return onDialogSheets(state, top, Math.min(top.sheet, rows.length - 1), input, back);
  const primary = d.dialog.props.buttons.find((b) => b.primary === true && b.reason === undefined);
  // its buttons take the keys as a confirm's do (← → Tab), Tab past the ends into its Sheets
  const enabled = d.dialog.props.buttons.filter((b) => b.reason === undefined).map((b) => b.id);
  const on = top.button ?? primary?.id ?? enabled.at(-1);

  if (input.kind === 'key' && on !== undefined) {
    const edge = input.key === '<Tab>' ? enabled.at(-1) : enabled[0];

    if ((input.key === '<Tab>' || input.key === '<S-Tab>') && rows.length > 0 && on === edge)
      return same(withTop(state, { ...top, g: false, sheet: 0 }));
    const button = buttonStep(enabled, on, input.key);

    if (button !== undefined) return same(withTop(state, { ...top, g: false, button }));
  }
  if (input.kind === 'key' && (input.key === '<Tab>' || input.key === '<S-Tab>'))
    return rows.length === 0 ? same(state) : same(withTop(state, { ...top, sheet: 0 }));
  // ⏎ on a button the keys moved to: its click
  if (input.kind === 'key' && input.key === '<CR>' && on !== undefined && on !== primary?.id)
    return onDialog(state, top, { kind: 'click', id: on });
  const named = (): string | undefined => {
    if (input.kind === 'key') return input.key;

    return input.kind === 'click' ? input.id : undefined;
  };
  const key = named();

  const lines = pageLines(top);
  const scrollTo = (scroll: number): Out => {
    const to = Math.max(0, Math.min(lines, scroll));

    return same(withTop(state, { ...top, scroll: to, g: false, end: lines > 0 && to >= lines }));
  };

  switch (key) {
    case '<Esc>':
    case 'dialog:close':
      return same(pop(state));
    case '<CR>': {
      if (primary === undefined) return same(state);
      const at = msOf(state.now);
      const early = (since: number | undefined) =>
        at !== undefined && since !== undefined && at - since < PRIMARY_GUARD_MS;

      // too soon after the dialog opened or the ⏎ before: nothing, and the wait starts again
      return early(top.opened) || early(top.enter)
        ? same(withTop(state, { ...top, enter: at }))
        : back('primary', true);
    }
    case 'dialog:primary':
      return primary === undefined ? same(state) : back('primary', true);
    // the Launch box on Launch agent (#347): the screen says whether its primary takes one
    case '<S-CR>':
      return primary === undefined ? same(state) : back(PRIMARY_BOX, true);
    case '<D-CR>':
    case 'dialog:menu':
      return back('menu', false);
    // `gg` the top
    case 'g':
      return top.g === true ? scrollTo(0) : same(withTop(state, { ...top, g: true }));
    default: {
      // every list's moves as lines (`list-moves.ts`, #334): `G` / End the end, Home the top
      const m = input.kind === 'key' ? listMove(input.key, PAGE_ROWS) : undefined;

      if (m === undefined)
        return same(top.g === true ? withTop(state, { ...top, g: false }) : state);
      if (m.kind === 'to') return scrollTo(m.row === 'last' ? lines : m.row);

      return scrollTo(top.scroll + m.rows);
    }
  }
};

/**
 * A dialog drawn anew (its Sheets read): the open one with its id, top or under its menu, keeps
 * its scroll (within the new page) and Sheets cursor (within the new rows); none: nothing.
 */
const updateDialog = (state: CommandState, input: Dialog): CommandState => ({
  ...state,
  layers: state.layers.map((l) => {
    if (l.kind !== 'dialog' || l.dialog.id !== input.id) return l;
    const rows = input.dialog.props.sheets?.rows.length ?? 0;
    const sheet = l.sheet === undefined || rows === 0 ? undefined : Math.min(l.sheet, rows - 1);

    return {
      ...l,
      dialog: input,
      scroll: Math.min(l.scroll, pageLines({ ...l, dialog: input })),
      sheet,
    };
  }),
});

const RISKY_LETTER = 'y';

const onConfirm = (
  state: CommandState,
  top: { kind: 'confirm'; focus: 'risky' | 'no' },
  input: Input,
): Out => {
  const entry = state.entry;
  const yes = () => (entry === undefined ? same(state) : run(state, entry));

  if (input.kind === 'click') {
    if (input.id === 'risky') return yes();

    return input.id === 'no' ? same(pop(state)) : same(state);
  }
  if (input.kind !== 'key') return same(state);
  switch (input.key) {
    case RISKY_LETTER:
    case RISKY_LETTER.toUpperCase():
      return yes();
    case 'n':
    case 'N':
    case '<Esc>':
      return same(pop(state));
    case '<CR>':
      return top.focus === 'risky' ? yes() : same(pop(state));
    default: {
      const focus = buttonStep(['risky', 'no'] as const, top.focus, input.key);

      return same(focus === undefined ? state : withTop(state, { ...top, focus }));
    }
  }
};

const linesOf = (text: string | undefined): string[] =>
  (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/** A typed command's many lines (`:session list`): its rows in a list over the view, Esc closes it. */
const OUTPUT_MENU = 'command:output';

const outputMenu = (typed: string, lines: readonly string[]): Menu => ({
  kind: 'menu',
  id: OUTPUT_MENU,
  title: `abe ${typed}`,
  rows: lines.map((text, i) => ({ id: `line:${i}`, text, does: { kind: 'do', commands: [] } })),
});

/**
 * A run's answer in words (#204): its own done words; a chosen row's the CLI's first line as a
 * sentence; a typed one's `abe <typed>: <line>`, its many lines in a list. Times in local time.
 */
const said = (state: CommandState, r: Running, text: string | undefined): Out => {
  if (r.done !== undefined) return status(state, r.done);
  const lines = linesOf(localTimes(text ?? '', state.now));
  const [first] = lines;

  if (r.chosen) return status(state, first === undefined ? 'Done' : sentence(first));
  if (lines.length > 1)
    return same({ ...state, layers: [...state.layers, menuLayer(outputMenu(r.typed, lines))] });

  return status(state, `abe ${r.typed}: ${first ?? 'done'}`);
};

const status = (state: CommandState, text: string): Out => ({
  state,
  commands: [{ kind: 'shell', effect: { kind: 'status', text } }],
});

const onResult = (state: CommandState, input: Input & { kind: 'result' }): Out => {
  if (input.id === 'help') {
    if (input.command !== 'help') return same(state);

    return same(
      input.reply.ok
        ? { ...state, help: input.reply.data, failed: undefined }
        : { ...state, failed: input.reply.error.message },
    );
  }
  const ran = state.running[input.id];

  if (ran === undefined) return same(state);
  const running = Object.fromEntries(Object.entries(state.running).filter(([k]) => k !== input.id));
  const next = { ...state, running };
  const short = input.reply.ok ? undefined : input.reply.error.boxShort;

  // onto a box short of memory or disk (Move to cloud, #9): its question, then it runs again
  if (short !== undefined && ran.argv !== undefined) {
    const under = next.layers.at(-1)?.kind === 'dialog' ? next.layers : [];

    return same({
      ...next,
      entry: undefined,
      layers: [...under, menuLayer(shortRerun(short, ran.argv))],
    });
  }
  if (!input.reply.ok)
    return {
      state: next,
      commands: [
        {
          kind: 'shell',
          effect: {
            kind: 'balloon',
            tone: 'error',
            text: `${input.reply.error.message} (${input.reply.error.code})`,
          },
        },
      ],
    };

  // what follows a post (the tag taken off) says nothing when it went through
  if (input.id.startsWith('then:')) return same(next);

  return said(next, ran, input.text);
};

// ---------------------------------------------------------------- the CommentBox (#77)

const POST = 'comment:post:';
const THREAD = 'comment:thread:';

/** `org · project · #id · Azure Boards`, from a card's Azure Boards address; else the address. */
export const destinationOf = (url: string, card: number): string => {
  const m = /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\//.exec(url);
  const words = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };

  return m?.[1] === undefined || m[2] === undefined
    ? url
    : `${words(m[1])} · ${words(m[2])} · #${card} · Azure Boards`;
};

/** The CommentBox open on `card`, wherever it is in the layers. */
const commentAt = (state: CommandState, card: number): number =>
  state.layers.findIndex((l) => l.kind === 'comment' && l.on.card === card);

const withLayer = (state: CommandState, at: number, layer: Layer): CommandState => ({
  ...state,
  layers: state.layers.map((l, i) => (i === at ? layer : l)),
});

/**
 * Every layer closed, an open CommentBox's draft kept for its card; a box posting stays up, so
 * its answer still closes it and runs what follows.
 */
const closedKeeping = (state: CommandState): CommandState => ({
  ...draftsKept(state),
  // a box posting and a card being created stay up for their answers
  layers: state.layers.filter(
    (l) => (l.kind === 'comment' && l.posting) || (l.kind === 'newcard' && l.phase === 'creating'),
  ),
  entry: undefined,
});

/** The open CommentBoxes' and Launch boxes' drafts kept per card, before their layers go. */
const draftsKept = (state: CommandState): CommandState => {
  const drafts = { ...state.drafts };
  const launchDrafts = { ...state.launchDrafts };

  const newCards = { ...state.newCards };

  for (const l of state.layers) {
    if (l.kind === 'comment' && !l.posting) drafts[l.on.card] = l.draft;
    if (l.kind === 'launch') launchDrafts[l.on.card] = { note: l.draft };
    if (l.kind === 'newcard' && l.phase !== 'creating') newCards[l.on.board] = l.form;
  }

  return { ...state, drafts, launchDrafts, newCards };
};

const openComment = (state: CommandState, on: CommentOn): Out => ({
  state: {
    // a Launch box's or New card's draft up is kept for its card or board
    ...draftsKept(state),
    entry: undefined,
    layers: [{ kind: 'comment', on, draft: state.drafts[on.card] ?? '', posting: false }],
  },
  commands: [{ kind: 'run', id: `${THREAD}${on.card}`, argv: ['card', 'show', String(on.card)] }],
});

const post = (state: CommandState, top: CommentLayer): Out => {
  if (top.posting) return same(state);
  // an empty text closes the box
  if (top.draft.trim() === '')
    return same({ ...pop(state), drafts: { ...state.drafts, [top.on.card]: '' } });

  return {
    state: withTop(state, { ...top, posting: true, error: undefined }),
    commands: [
      {
        kind: 'run',
        id: `${POST}${top.on.card}`,
        argv: ['card', 'comment', String(top.on.card), '--text', top.draft],
      },
    ],
  };
};

const onComment = (state: CommandState, top: CommentLayer, input: Input): Out => {
  // while the post is under way nothing changes: its answer closes the box or says why not
  if (top.posting) return same(state);
  if (input.kind === 'click') return input.id === 'comment:send' ? post(state, top) : same(state);
  const f = fieldOf(top.draft, top.caret);
  const edited = (next: Field | undefined): Out =>
    next === undefined
      ? same(state)
      : same(withTop(state, { ...top, draft: next.text, caret: caretProp(next) }));

  if (input.kind === 'text') return edited(fieldInsert(f, input.text));
  if (input.kind !== 'key') return same(state);
  switch (input.key) {
    case '<Esc>':
      return same({ ...pop(state), drafts: { ...state.drafts, [top.on.card]: top.draft } });
    case '<CR>':
      return post(state, top);
    case '<S-CR>':
      return edited(fieldInsert(f, '\n'));
    default:
      // its lines: ⌘← ⌘→ ⌘⌫ stop at the caret's line's ends
      return edited(fieldKey(f, input.key, { lines: true }));
  }
};

/** The thread read, or the post answered: the box keeps it, or closes and runs what follows. */
const onCommentResult = (state: CommandState, input: Input & { kind: 'result' }): Out => {
  const thread = input.id.startsWith(THREAD);
  const card = Number(input.id.slice((thread ? THREAD : POST).length));
  const at = commentAt(state, card);
  const layer = state.layers[at];

  if (thread) {
    if (layer?.kind !== 'comment') return same(state);
    if (!input.reply.ok)
      return same(withLayer(state, at, { ...layer, thread: { error: input.reply.error.message } }));
    if (input.command !== 'card show') return same(state);
    const shown = input.reply.data;

    return same(
      withLayer(state, at, {
        ...layer,
        thread: {
          comments: shown.comments.map((c) => ({
            by: c.by,
            when: c.at.slice(0, 10),
            markdown: threadLines(c.text),
          })),
          destination: destinationOf(shown.url, card),
        },
      }),
    );
  }
  if (!input.reply.ok) {
    const error = `${input.reply.error.message} (${input.reply.error.code})`;

    // the draft stays, in the box while it is up and for the next one
    return layer?.kind === 'comment'
      ? same({
          ...withLayer(state, at, { ...layer, posting: false, error }),
          drafts: { ...state.drafts, [card]: layer.draft },
        })
      : {
          state,
          commands: [{ kind: 'shell', effect: { kind: 'balloon', tone: 'error', text: error } }],
        };
  }
  const then = layer?.kind === 'comment' ? (layer.on.then ?? []) : [];
  const drafts = Object.fromEntries(
    Object.entries(state.drafts).filter(([k]) => Number(k) !== card),
  );
  const closed: CommandState = {
    ...state,
    drafts,
    layers: at < 0 ? state.layers : state.layers.filter((_, i) => i !== at),
    ...(at >= 0 && state.layers.length === 1 ? { entry: undefined } : {}),
  };
  // what follows runs as any command: its line on the status line, a refusal in a balloon
  const runs = then.map((argv, i) => ({ id: `then:${state.runs + i + 1}`, argv: [...argv] }));

  return {
    state: {
      ...closed,
      runs: state.runs + runs.length,
      running: {
        ...closed.running,
        ...Object.fromEntries(
          runs.map((r): [string, Running] => [r.id, { typed: r.argv.join(' '), chosen: true }]),
        ),
      },
    },
    commands: [
      { kind: 'shell', effect: { kind: 'status', text: `Comment posted on #${card}` } },
      ...runs.map((r): Command => ({ kind: 'run', ...r })),
    ],
  };
};

/** A key or click on the Launch box: typed, closed keeping the draft, or the launch handed back. */
const onLaunchLayer = (state: CommandState, top: LaunchLayer, input: Input): Out => {
  const step = onLaunch(top, input, msOf(state.now), PRIMARY_GUARD_MS);
  const card = top.on.card;

  switch (step.kind) {
    case 'open':
      return same(withTop(state, step.layer));
    case 'closed':
      return same({ ...pop(state), launchDrafts: { ...state.launchDrafts, [card]: step.kept } });
    case 'launched': {
      const launchDrafts = Object.fromEntries(
        Object.entries(state.launchDrafts).filter(([k]) => Number(k) !== card),
      );

      return { state: { ...pop(state), launchDrafts }, commands: [step.choice] };
    }
  }
};

// ---------------------------------------------------------------- New card (#346)

/** The board's kept forms after a step: put back, forgotten (`null`), or as they were. */
const keptCards = (
  state: CommandState,
  board: string,
  keep: NewCardStep['keep'],
): CommandState['newCards'] => {
  if (keep === undefined) return state.newCards;
  const rest = Object.fromEntries(
    Object.entries(state.newCards ?? {}).filter(([b]) => b !== board),
  );

  return keep === null ? rest : { ...rest, [board]: keep };
};

const newCardAt = (state: CommandState): number =>
  state.layers.findIndex((l) => l.kind === 'newcard');

/** A step of the dialog applied: the layer in its place (or gone), a pick over it, its runs counted. */
const newCardOut = (state: CommandState, board: string, step: NewCardStep): Out => {
  const at = newCardAt(state);
  const next = step.layer;
  const placed = (): Layer[] => {
    if (at < 0) return state.layers;
    if (next === undefined) return state.layers.filter((_, i) => i !== at);

    return state.layers.map((l, i) => (i === at ? next : l));
  };
  const layers = placed();
  const up = step.pick === undefined ? layers : [...layers, menuLayer(step.pick)];
  const runs = step.commands.filter((c) => c.kind === 'run').length;

  return {
    state: {
      ...state,
      layers: up,
      ...(up.length === 0 ? { entry: undefined } : {}),
      runs: state.runs + runs,
      newCards: keptCards(state, board, step.keep),
    },
    commands: step.commands,
  };
};

/** A screen opens the dialog: in place of any layer up, on the form kept for its board. */
const openNewCardLayer = (state: CommandState, on: NewCardOn): Out => {
  const closed = closedKeeping(state);

  return same({
    ...closed,
    entry: undefined,
    layers: [openNewCard(on, closed.newCards?.[on.board], msOf(state.now))],
  });
};

/** A pick's value chosen: set on the dialog under it, the keys back there. */
const onNewCardPick = (state: CommandState, menu: string, row: MenuRow | undefined): Out => {
  const popped = pop(state);
  const at = newCardAt(popped);
  const l = popped.layers[at];

  if (row === undefined || l?.kind !== 'newcard') return same(popped);

  return same(withLayer(popped, at, picked(l, menu, row.id)));
};

/** The dialog's draft or create answered, whether it is still up or not. */
const onNewCardAnswer = (state: CommandState, input: Input & { kind: 'result' }): Out => {
  const board = runBoard(input.id) ?? '';
  const l = state.layers[newCardAt(state)];
  // the dialog up is this run's only while it is on the same board; else the board's kept form
  const up = l?.kind === 'newcard' && l.on.board === board ? l : undefined;
  const step = onNewCardResult(up, state.newCards?.[board], input);

  // another board's dialog up stays as it is
  return newCardOut(
    state,
    board,
    up === undefined && l?.kind === 'newcard' ? { ...step, layer: l } : step,
  );
};

/** Linked's step taken: the popup in its place (or gone), its runs counted. */
const linkedOut = (state: CommandState, step: LinkedStep): Out => {
  const others = state.layers.filter((l) => l.kind !== 'linked');

  return {
    state: {
      ...state,
      layers: step.layer === undefined ? others : [...others, step.layer],
      ...(step.layer === undefined && others.length === 0 ? { entry: undefined } : {}),
      runs: state.runs + step.runs,
    },
    commands: step.commands,
  };
};

const linkedUp = (state: CommandState): LinkedLayer | undefined => {
  const top = state.layers.at(-1);

  return top?.kind === 'linked' ? top : undefined;
};

const stepCommand =
  (words: readonly Word[]) =>
  (state: CommandState, input: Input): Out => {
    if (input.kind === 'result' && (input.id.startsWith(THREAD) || input.id.startsWith(POST)))
      return onCommentResult(state, input);
    for (const [run, read] of [
      [STANDING_RUN, onStanding],
      [REFERENCE_RUN, onReference],
      [WORKFLOWS_RUN, onWorkflows],
      [REACH_RUN.dev, onReach('dev')],
      [REACH_RUN.test, onReach('test')],
      [REACH_RUN.prod, onReach('prod')],
    ] as const) {
      if (input.kind !== 'result' || !input.id.startsWith(run)) continue;
      const card = Number(input.id.slice(run.length));
      const at = state.layers.findIndex((l) => l.kind === 'launch' && l.on.card === card);
      const layer = state.layers[at];

      return layer?.kind === 'launch'
        ? same(withLayer(state, at, read(layer, input)))
        : same(state);
    }
    if (input.kind === 'result' && input.id.startsWith(IMPROVE_CHAT_RUN))
      return onImproveChat(state, input);
    if (input.kind === 'result' && input.id.startsWith(ASK_RUN)) return onAsked(state, input);
    if (input.kind === 'result' && isNewCardRun(input.id)) return onNewCardAnswer(state, input);
    // where the next `:` or `?` is pressed (#346): kept for the line's rows and the key help
    if (input.kind === 'here') return same({ ...state, here: input });
    if (input.kind === 'result' && input.id.startsWith(LINKED_RUN)) {
      const up = linkedUp(state);

      // closed meanwhile: its answer is no one's
      return up === undefined
        ? same(state)
        : linkedOut(state, linkedResult(up, input, state.runs + 1));
    }
    if (input.kind === 'result') return onResult(state, input);
    // ⌃L (#106): Linked in place of any layer up; ⌃W leaves every layer for the workspace
    if (input.kind === 'jump') {
      if (input.to === 'linked')
        return linkedOut(closedKeeping(state), openLinked(input.story, state.runs + 1, state.now));

      return input.to === 'workspace' ? same(closedKeeping(state)) : same(state);
    }
    // the clock and `abe watch` keep an open Linked live; no other layer reads them
    if (input.kind === 'tick') {
      const up = linkedUp(state);
      const ticked = { ...state, now: input.at };

      return up === undefined ? same(ticked) : linkedOut(ticked, onLinked(up, input, 0));
    }
    if (input.kind === 'event') {
      const up = linkedUp(state);

      return up === undefined ? same(state) : linkedOut(state, onLinked(up, input, state.runs + 1));
    }
    // A screen's CommentBox on a card: in place of any layer up.
    if (input.kind === 'comment') return openComment(state, input);
    // A screen's Launch box on a card (#342, #347): in place of any layer up, its draft back.
    if (input.kind === 'launch') {
      const opened = openLaunch(input, state.launchDrafts[input.card], msOf(state.now));

      return {
        state: { ...closedKeeping(state), layers: [opened.layer] },
        commands: opened.commands,
      };
    }
    // a screen's layer in place of a box up: the box's draft kept for its card
    const kept =
      input.kind === 'confirm' ||
      input.kind === 'ask' ||
      input.kind === 'menu' ||
      (input.kind === 'dialog' && input.update !== true)
        ? draftsKept(state)
        : state;

    // A screen's New card dialog (#346): in place of any layer up.
    if (input.kind === 'newcard') return openNewCardLayer(state, input);
    // A screen asks before a risky run of its own (Stop…): the confirm, over any layer up.
    if (input.kind === 'confirm')
      return same({
        ...kept,
        entry: {
          id: `confirm:${input.argv.join(' ')}`,
          name: input.argv.join(' '),
          summary: input.question,
          argv: input.argv,
          ask: [],
          risky: true,
          chosen: true,
          done: input.done,
          asks: asksOf(input),
        },
        layers: [{ kind: 'confirm', focus: 'no' }],
      });
    // A screen's command with its arguments to ask (the role widget's `settings set role`).
    if (input.kind === 'ask')
      return advance({
        ...kept,
        layers: [],
        entry: {
          id: `ask:${input.argv.join(' ')}`,
          name: input.argv.join(' '),
          summary: input.summary,
          argv: input.argv,
          ask: input.ask,
          risky: false,
          chosen: true,
        },
      });
    // A screen's Action menu: over its own dialog, else alone; its dialog in place of any layer.
    if (input.kind === 'menu') {
      const under = kept.layers.at(-1)?.kind === 'dialog' ? kept.layers : [];
      const chosen = input.rows.find((r) => r.id === input.chosen);

      return chosen === undefined
        ? same({ ...kept, entry: undefined, layers: [...under, menuLayer(input)] })
        : chooseRow({ ...kept, entry: undefined, layers: under }, input, chosen);
    }
    if (input.kind === 'dialog' && input.update === true) return same(updateDialog(kept, input));
    if (input.kind === 'extent') return same(withExtent(kept, input.id, input.lines));
    if (input.kind === 'dialog') {
      // the same dialog opened again (Open story over it): its page is the one the app measured
      const was = kept.layers.find(
        (l): l is DialogLayer => l.kind === 'dialog' && l.dialog.dialog.id === input.dialog.id,
      );

      return same({
        ...kept,
        entry: undefined,
        layers: [
          {
            kind: 'dialog',
            dialog: input,
            scroll: 0,
            opened: msOf(kept.now),
            extent: was?.extent,
          },
        ],
      });
    }
    const top = state.layers.at(-1);

    // the keyboard went elsewhere: every layer closes (a later `:` starts afresh), a draft kept
    if (input.kind === 'blur') return same(closedKeeping(state));
    if (top === undefined) {
      if (opensKeyHelp(input))
        return same({
          ...state,
          layers: [keyHelpLayer(state)],
        });
      if (!opensCommandMode(input)) return same(state);

      return opened(state);
    }
    // `??`: from this view's keys to every key; `?` there types nothing
    if (top.kind === 'menu' && top.filter === '' && opensKeyHelp(input)) {
      if (top.menu.id === KEY_HELP_MENU)
        return same(withTop(state, { ...top, menu: keyHelp('every'), cursor: 0, top: 0 }));
      if (top.menu.id === EVERY_KEY_MENU) return same(state);
    }
    switch (top.kind) {
      case 'pick':
        return onPick(state, top, input, words);
      case 'menu':
        return onMenu(state, top, input);
      case 'dialog':
        return onDialog(state, top, input);
      case 'choose':
        return onChoose(state, top, input);
      case 'ask':
        return onAsk(state, top, input);
      case 'confirm':
        return onConfirm(state, top, input);
      case 'comment':
        return onComment(state, top, input);
      case 'launch':
        return onLaunchLayer(state, top, input);
      case 'newcard':
        return newCardOut(
          state,
          top.on.board,
          onNewCard(top, input, state.runs + 1, { at: msOf(state.now), ms: PRIMARY_GUARD_MS }),
        );
      case 'linked':
        return linkedOut(state, onLinked(top, input, state.runs + 1));
    }
  };

const windowOf = <T>(items: readonly T[], list: List): T[] =>
  items.slice(list.top, list.top + PICK_ROWS);

/** Where the window is in `items` when they don't all fit (#261: the popup draws a scrollbar). */
const scrollOf = (items: readonly unknown[], list: List): Pick<PickLayer['props'], 'scroll'> =>
  items.length > PICK_ROWS ? { scroll: { top: list.top, total: items.length } } : {};

/** A row of the `:` line as the pick draws it: a command's usage at its right. */
const lineRow = (r: Row): PickRow => {
  const usage =
    r.does.kind === 'entry' && r.does.entry.ask.length > 0 ? usageOf(r.does.entry.ask) : undefined;
  const note = r.note ?? usage;

  return {
    id: r.id,
    text: r.text,
    ...(r.dim === undefined ? {} : { dim: r.dim }),
    ...(note === undefined ? {} : { note }),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    ...(r.section === undefined ? {} : { section: r.section }),
    ...(r.risky === true ? { risky: true } : {}),
  };
};

/** The `:` line's placeholder while nothing is typed (#346). */
export const LINE_PLACEHOLDER = 'Ask anything, or a command';

const typedSoFar = (state: CommandState): string => {
  const entry = state.entry;

  return entry === undefined ? '' : `abe ${argvOf(entry, answers(state)).join(' ')}`;
};

const viewPick = (
  state: CommandState,
  top: { moved?: true | undefined } & List,
  words: readonly Word[],
): PickLayer => {
  const { rows, resting } = lineRows(state, words, top.filter);
  const cursor = lineCursor(top, resting);
  const list = top.moved === true ? top : scrolled({ ...top, cursor: Math.max(0, cursor) });
  const at = cursor < 0 ? undefined : rows[cursor];
  // nothing to list yet: the table is still read (or failed), and nothing else came
  const body = (): Pick<PickLayer['props'], 'state' | 'message'> => {
    if (rows.length > 0 || state.help !== undefined) return {};

    return state.failed === undefined
      ? { state: 'loading' }
      : { state: 'error', message: state.failed };
  };

  return {
    kind: 'PickLayer',
    id: 'command-mode',
    props: {
      title: 'Command mode',
      filter: top.filter,
      ...caretOf(top.caret),
      placeholder: LINE_PLACEHOLDER,
      // the line's one footer (#346): only while words are typed where a board is in force
      ...(rows.some((r) => r.does.kind === 'new' && r.reason === undefined)
        ? { hint: '⌘⏎ new card' }
        : {}),
      rows: windowOf(rows, list).map(lineRow),
      ...scrollOf(rows, list),
      ...(at === undefined || at.reason !== undefined ? {} : { selected: at.id }),
      ...body(),
    },
  };
};

const askTitle = (state: CommandState, arg: MenuAsk): string => {
  if (arg.title !== undefined) return arg.title;
  const name = state.entry?.name ?? '';

  // a screen's word is typed after `:`, a command after `abe`
  return `${state.entry?.commands === undefined ? 'abe ' : ':'}${name} ${usageOf([arg])}`;
};

const viewChoose = (state: CommandState, top: { arg: MenuAsk } & List): PickLayer => {
  const shown = shownValues(top.arg, top.filter);
  const at = shown[top.cursor];

  return {
    kind: 'PickLayer',
    id: 'command-value',
    props: {
      title: askTitle(state, top.arg),
      filter: top.filter,
      ...caretOf(top.caret),
      rows: windowOf(shown, top).map((v) => ({ id: `value:${v}`, text: labelOf(top.arg, v) })),
      ...scrollOf(shown, top),
      ...(at === undefined ? {} : { selected: `value:${at}` }),
      ...(top.arg.hint === undefined ? {} : { hint: top.arg.hint }),
    },
  };
};

const viewAsk = (state: CommandState, top: AskLayer): PromptLayer => ({
  kind: 'PromptLayer',
  id: 'command-arg',
  props: {
    title: askTitle(state, top.arg),
    text: top.text,
    ...caretOf(top.caret),
    hint: top.arg.summary,
    ...(top.error === undefined ? {} : { error: top.error }),
  },
});

/** A screen's question as the confirm asks it: its lines, its yes, its no, red when it is. */
const asksOf = (q: Question): NonNullable<Entry['asks']> => ({
  question: q.question,
  details: q.details ?? [],
  yes: q.yes,
  ...(q.no === undefined ? {} : { no: q.no }),
  ...(q.danger === true ? { danger: true } : {}),
});

const viewConfirm = (state: CommandState, focus: 'risky' | 'no'): ConfirmLayer => {
  const asks = state.entry?.asks;
  const summary = state.entry === undefined ? [] : [state.entry.summary];

  return {
    kind: 'ConfirmLayer',
    id: 'command-confirm',
    props: {
      question: asks?.question ?? `Run ${typedSoFar(state)}?`,
      details: asks === undefined ? summary : [...asks.details],
      risky: { label: asks?.yes ?? 'Yes, run it', letter: RISKY_LETTER },
      no: asks?.no ?? 'No',
      ...(asks?.danger === true ? { danger: true } : {}),
      focus,
    },
  };
};

/** A list menu's look (#24): wide, its caption, its hint, the house mark. */
const lookOf = (look: Menu['look']): Partial<PickLayer['props']> =>
  look === undefined
    ? {}
    : {
        wide: true,
        ...(look.caption === undefined ? {} : { caption: look.caption }),
        ...(look.hint === undefined ? {} : { hint: look.hint }),
        ...(look.local === true ? { local: true } : {}),
      };

const viewMenu = (top: { menu: Menu } & List): PickLayer => {
  const rows = menuRows(top);
  const at = rows[top.cursor];

  return {
    kind: 'PickLayer',
    id: 'action-menu',
    props: {
      title: top.menu.title,
      filter: top.filter,
      ...caretOf(top.caret),
      rows: windowOf(rows, top).map((r): PickRow => ({
        id: r.id,
        text: r.text,
        ...(r.dim === undefined ? {} : { dim: r.dim }),
        ...(r.key === undefined ? {} : { note: r.key }),
        ...(r.note === undefined ? {} : { note: r.note }),
        ...(r.lead === undefined ? {} : { lead: r.lead }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        ...(r.separator === true && top.filter === '' ? { separator: true } : {}),
        ...(r.risky === true ? { risky: true } : {}),
      })),
      ...scrollOf(rows, top),
      ...(isEnabled(at) && at !== undefined ? { selected: at.id } : {}),
      ...lookOf(top.menu.look),
    },
  };
};

const viewDialog = (top: {
  dialog: Dialog;
  scroll: number;
  sheet?: number | undefined;
  button?: string | undefined;
}): CardDialog => {
  const p = top.dialog.dialog.props;
  const sheets = p.sheets;
  const at = top.sheet === undefined ? undefined : sheets?.rows[top.sheet];

  return {
    ...top.dialog.dialog,
    props: {
      ...p,
      scroll: top.scroll,
      ...(top.button === undefined ? {} : { focus: top.button }),
      ...(sheets === undefined
        ? {}
        : {
            sheets: {
              ...sheets,
              ...(at === undefined ? {} : { selected: at.id, focused: true }),
            },
          }),
    },
  };
};

/**
 * A comment as the CommentBox's thread draws it, a line each (#98: the content's call, made here):
 * its blank lines dropped and each line's leading quote marks (`> `) with them.
 */
export const threadLines = (text: string): string =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.replace(/^[> ]+/, ''))
    .join('\n');

const threadOf = (t: CommentLayer['thread']): CommentBox['props']['thread'] => {
  if (t === undefined) return { state: 'loading', comments: [] };

  return 'error' in t
    ? { state: 'error', message: t.error, comments: [] }
    : { state: 'ready', comments: t.comments };
};

const boxState = (top: CommentLayer): CommentBox['props']['state'] => {
  if (top.posting) return 'posting';

  return top.error === undefined ? 'writing' : 'failed';
};

const viewComment = (top: CommentLayer): CommentBox => {
  const t = top.thread;

  return {
    kind: 'CommentBox',
    id: `comment:${top.on.card}`,
    props: {
      title: `Comment on #${top.on.card} ${top.on.title}`,
      thread: threadOf(t),
      destination:
        t !== undefined && 'destination' in t ? t.destination : `#${top.on.card} · Azure Boards`,
      draft: top.draft,
      ...caretOf(top.caret),
      placeholder: top.on.placeholder ?? 'Your answer, as markdown',
      state: boxState(top),
      ...(top.error === undefined ? {} : { error: top.error }),
      hint: '⏎ post · ⇧⏎ new line · draft kept',
    },
  };
};

const viewCommand =
  (words: readonly Word[]) =>
  (state: CommandState): Node | undefined => {
    const top = state.layers.at(-1);

    switch (top?.kind) {
      case undefined:
        return undefined;
      case 'pick':
        return viewPick(state, top, words);
      case 'menu':
        return viewMenu(top);
      case 'dialog':
        return viewDialog(top);
      case 'choose':
        return viewChoose(state, top);
      case 'ask':
        return viewAsk(state, top);
      case 'confirm':
        return viewConfirm(state, top.focus);
      case 'comment':
        return viewComment(top);
      case 'launch':
        return viewLaunch(top);
      case 'newcard':
        return newCardDialog(top).dialog;
      case 'linked':
        return viewLinked(top);
    }
  };

/** The story of the layer up (#106): Linked's, the story dialog's; none for the others. */
const linkedOfCommand = (state: CommandState): number | undefined => {
  const top = state.layers.at(-1);

  if (top?.kind === 'linked') return top.story;
  if (top?.kind === 'dialog' && top.dialog.dialog.props.card > 0)
    return top.dialog.dialog.props.card;

  return undefined;
};

/** Command mode over the screens' `words`. */
export const commandMode = (words: readonly Word[]): LayerScreen<CommandState> => ({
  name: 'command',
  init: INIT,
  step: stepCommand(words),
  view: viewCommand(words),
  linked: linkedOfCommand,
});
