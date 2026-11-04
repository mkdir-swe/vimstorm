/**
 * The screen runtime: a screen is pure, `(state, input) → { state, tree, commands }`. It never does
 * IO; it asks for `abe` commands (`run`, answered back as a `result` input) and shell effects
 * (`shell`), and the bridge (`serve/src/process/bridge.ts`) or `abe ui render` does them. A screen reads
 * only the CLI contract's types, as any other client of `serve` would.
 */
import type {
  ArgInfo,
  CommandId,
  Commands,
  Envelope,
  Event,
  Failure,
  FactoryRunData,
  LookStage,
  ViewTweak,
} from '@abe/core';
import { type z } from 'zod';
import { type BrowserEvent } from './browser';
import { Node } from './components';
import { type CardDialog } from './layers';
import { type NewCardOn } from '../command/new-card';
import { type KeyScope } from '../command/keys';
import { type Facts, type LiveRead, withLive } from '../live';
import {
  type Caret,
  type JumpTo,
  type Widget,
  type ShellEffect,
  type Slot,
  type UserInput,
  type ViewSize,
} from './protocol';

/** A status bar widget, as a screen's live facts word it (`live/box-feed.ts`). */
export type { Widget };

// The runtime's interface: the screen contract above, and the rest of the folder a screen draws
// and keys with (the closed component set, the protocol, layers, fields, lists, held presses).
export * from './components';
// (the protocol's types only: its schemas are built from the whole component set as it loads, so
// a screen loaded on the way there must not wait on them; the bridge reads them from protocol.ts)
export type * from './protocol';
export * from './layers';
export * from './browser';
export * from './field';
export * from './held';
export * from './list-moves';
export * from './said';
// a list's generic words under the names screens give them beside their own rows
export {
  FOOT_H,
  HEAD_H,
  ROW_H,
  filterNote,
  fits,
  holdOrder,
  keepInView,
  listClick,
  type ListFilter,
  listKey,
  type ListOf,
  type ListPlace,
  listScroll,
  listText,
  released,
  reopened,
  selectedRow as listSelected,
  selectOn,
  settle as settleList,
  shownRows as listShown,
  windowed,
} from './table-list';
/** The New card dialog Command mode keys for a screen: its menu id and what opens it. */
export { NEW_CARD_MENU, type NewCardOn } from '../command/new-card';

/** A command's `--json` answer, typed by which command it was. */
export type Answer = {
  [K in CommandId]: {
    kind: 'result';
    /** The `run` command's id. */
    id: string;
    command: K;
    reply: Envelope<z.output<Commands[K]['result']>>;
    /** A success's human text, as the command table words it (`abe <command>` without `--json`). */
    text?: string | undefined;
    /**
     * A kept read's (`run` with `keep`) last answer held by the host, handed at once while it is
     * read anew: the read is still out, its own answer comes after.
     */
    cached?: true | undefined;
  };
}[CommandId];

/** A `run` refused before any command ran: its argv is no command's usage (`usage`, `unknown-command`). */
export type Refused = {
  kind: 'result';
  id: string;
  command: null;
  reply: Failure;
  text?: undefined;
  cached?: undefined;
};

/**
 * What the person did, as a screen gets it: `at` (RFC 3339) when the bridge took it, for what
 * goes by how soon a key came (a card's grace); absent: not known (a test's, a layer's).
 */
export type PersonInput = UserInput & { at?: string | undefined };

export type Input =
  | { kind: 'open'; params: Readonly<Record<string, string>>; size: ViewSize }
  | { kind: 'resize'; size: ViewSize }
  | PersonInput
  | Answer
  | Refused
  /** An `abe watch` event. */
  | { kind: 'event'; event: Event }
  /**
   * The live facts (`live/`), every screen handed the same ones as they move: the sessions, the
   * runs, the launches heard, the boxes, the prototypes. A screen never reads these itself.
   */
  | { kind: 'live'; facts: Facts }
  /** The clock (RFC 3339): on open and every `TICK_MS` after, for times like time in stage. */
  | { kind: 'tick'; at: string }
  /** A Terminal's program exited (`terminal.ts`). */
  | { kind: 'exit'; key: string; code: number | null }
  /** What a BrowserView's page did (`browser.ts`), by its key. */
  | { kind: 'browser'; key: string; event: BrowserEvent }
  /** A screen's `confirm`, handed to Command mode: it asks, then runs it. */
  | Confirm
  /** A screen's Action menu and card dialog, handed to Command mode, which draws and keys them. */
  | Menu
  | Dialog
  /** A command a screen hands to Command mode with its arguments to ask. */
  | Ask
  /** The CommentBox on a card, handed to Command mode, which reads, keys and posts it. */
  | CommentOn
  /** The Launch box on a card, handed to Command mode, which keys it and hands its ⏎ back. */
  | LaunchOn
  /** The New card dialog (#346), handed to Command mode, which keys it, drafts and creates. */
  | NewCardOn
  /** A row of a screen's menu (or a dialog's button) that Command mode hands back to it. */
  | Choice
  /**
   * The shown project's folder (the app's `hello` / `project`): where its commands run; its box
   * when it is a cloud workspace, and the branch checked out there, once the app named them.
   */
  | { kind: 'root'; root: string; box?: string | undefined; branch?: string | undefined }
  /**
   * The screen's slot got the keyboard (true) or lost it (the app's `focus`, #119). `layer`: lost
   * to a layer (a menu, a confirm, a pick, Command mode) opened over it; they come back to it as
   * the layer closes, else a plain `focused: false` follows (#264).
   */
  | { kind: 'focus'; focused: boolean; layer?: boolean | undefined }
  /** The Editor's caret (the app's `caret`, #119): the `chat` slot's screen gets it. */
  | ({ kind: 'caret' } & Caret)
  /** No file open in the Editor (the app's `no-caret`, #119): the caret is gone. */
  | { kind: 'no-caret' }
  /**
   * How far the card dialog with this node id really scrolls, in `l` / `ö` steps (the app's
   * `extent`, #253): its page as drawn, which its markdown's source lines only estimate.
   */
  | { kind: 'extent'; id: string; lines: number }
  /**
   * Your view tweaks for this screen (`views.ts`): its keys walk its parts as drawn. `all`: every
   * screen's, for a screen that writes the setting again (the stripe's menu, #20).
   */
  | { kind: 'views'; tweaks: readonly ViewTweak[]; all?: readonly ViewTweak[] | undefined }
  /** A jump along a story (#106), handed on by the bridge: `jumps.ts`. */
  | Jump
  /** Where `:` or `?` was pressed (#346): the bridge tells Command mode just before the key. */
  | HereInput;

/**
 * The Subject (#346): the one thing the keys are on (a card, a Sessions or Boxes row, Chat's
 * session, the file at the caret). `:` lists its actions first and asks about it.
 */
export type Subject = {
  /** The dim line over its rows: `#1234 Cart total includes shipping`. */
  caption: string;
  /** What `Ask about …` names: `#1234`, `cart.ts:42`, `box demo-shop-3`. */
  label: string;
  /** Flags naming it: `--card 1234`, `--file api/src/cart.ts --line 42`. */
  ask: readonly string[];
  /** Its Action menu, as ⌘⏎ opens it: `:` lists the rows that can run, at most six. */
  menu?: Menu | undefined;
  /** Its live session, for `Tell <who>'s session`: the id, whose (`#1234`), where it stands. */
  tell?: { session: string; whose: string; dim: string; card?: number | undefined } | undefined;
};

/** A view's own rows in `:` (#346): the Board's New card…, Triage, Prototype…, Mine ⇄ Team. */
export type ViewRows = { title: string; menu: Menu };

/** What a screen tells `:` and `?` of where its keys are (`Screen.here`, #346). */
export type Here = {
  subject?: Subject | undefined;
  view?: ViewRows | undefined;
  /** `?`'s keys: the surface's (default: the Factory view's). */
  keys?: KeyScope | undefined;
  /** A board is in force here: `New card “<words>”` is offered. */
  board?: boolean | undefined;
};

/**
 * The bridge's word to Command mode before `:` or `?` (#346): what the screen with the keys says
 * (`Here`), whether serve answers (an Ask needs it), the shown project's folder name (`Ask about
 * demo-shop` with no Subject), and in the Editor the Ex commands Neovim knows (`Run in Neovim`).
 */
export type HereInput = {
  kind: 'here';
  here: Here;
  serving: boolean;
  project?: string | undefined;
  ex?: readonly string[] | undefined;
  /**
   * The shown folder's checkout (#11): the repo's main one or a worktree, and whether it is
   * installed (`abe.yaml`). `Install the Factory…` is offered by it; none: no repo here.
   */
  checkout?: { main: boolean; installed: boolean } | undefined;
  /** The place in the main area (#20: `project`, `board`, `run`): Go to leaves it out. */
  place?: string | undefined;
  /** The stripe's items as the role shows them (#20): `:`'s Go to, once typed. */
  stripe?: readonly StripeGo[] | undefined;
};

/** A stripe item as `:`'s Go to lists it (#11): its id, name, key, group, a workspace's only. */
export type StripeGo = {
  id: string;
  label: string;
  key?: string | undefined;
  group: 'top' | 'bottom';
  workspaceOnly?: true | undefined;
};

/**
 * A jump to `story`'s workspace, its story dialog or its Linked popup: the bridge gives `story`
 * and `workspace` to the `main` screen (the Factory overview holds the sessions and the cards),
 * `linked` to Command mode, which draws the popup.
 */
export type Jump = { kind: 'jump'; to: JumpTo; story: number };

/** A ConfirmLayer's words: the question, what it means, the risky answer (No the default). */
export type Question = {
  question: string;
  details?: string[] | undefined;
  /** The risky answer's words (`Stop`); its letter is Command mode's `y`. */
  yes: string;
  /** The safe answer's words, the default (`Keep running`); absent: `No`. */
  no?: string | undefined;
  /** Red: a production deploy's yes (spec story 81), a destructive delete. */
  danger?: boolean | undefined;
};

/** Run `abe <argv>` once the person says yes in a ConfirmLayer (No the default). */
export type Confirm = Question & {
  kind: 'confirm';
  argv: string[];
  /** The status line once it went through, not the CLI's answer (#204). */
  done?: string | undefined;
};

/**
 * Command mode on a command (`settings set role`): its arguments asked there in order (a pick for
 * an enum), then run, its answer on the status line.
 */
export type Ask = {
  kind: 'ask';
  argv: string[];
  summary: string;
  ask: readonly MenuAsk[];
};

/**
 * The CommentBox on a card (#77, DS CommentBox): Command mode reads its thread (`abe card show`),
 * keys the draft and posts it with `abe card comment <card> --text`, then runs `then` (a
 * product owner's answer takes the `needs-info` tag off); a failed post keeps the draft.
 */
export type CommentOn = {
  kind: 'comment';
  card: number;
  title: string;
  /** Run in order once the comment is posted. */
  then?: readonly (readonly string[])[] | undefined;
  /** The empty draft's words (default: an answer's, `Your answer, as markdown`). */
  placeholder?: string | undefined;
};

/**
 * The Launch box on a card (#342, #347), in Command mode: the Launch note typed, the workflow,
 * where it runs, prod for that session. Its ⏎ hands `row` of `id` back to the screen that opened
 * it as a choice, the values `[note, workflow, runs, prod]` (`workflow` an id, '' the one the
 * card's `on:` takes; `runs` `local-sandbox` or `cloud`, '' where `serve.target` says; `prod`
 * `prod` or ''); Esc keeps the draft for the card until the app quits.
 */
export type LaunchOn = {
  kind: 'launch';
  /** The menu id the choice comes back as (`launchbox:102`). */
  id: string;
  /** The row the choice names (default `launch`). */
  row?: string | undefined;
  card: number;
  title: string;
  /** Where it runs, as Launch agent's detail says it. */
  where: string;
  /** The card has a prototype (its tag): the box reads what goes along as reference (#347). */
  prototype?: boolean | undefined;
  /** The note and picks to open with (a launch the screen refused, back to the person). */
  draft?: { note: string; workflow?: string | undefined; runs?: string | undefined } | undefined;
  /** The card's type and tags: which workflow its `on:` preselects. */
  type?: string | undefined;
  tags?: readonly string[] | undefined;
  /** Where `serve.target` says it runs: the Runs pick's start. */
  target?: string | undefined;
  /** The card's live session the launch stops first (`factory run --replace`), by its id. */
  stops?: string | undefined;
};

/** An argument a menu row asks before it runs: as the command table's, a pick's rows labelled. */
export type MenuAsk = ArgInfo & {
  labels?: Readonly<Record<string, string>> | undefined;
  /** More words a pick's value is found by as you type (Me by your name), never shown. */
  words?: Readonly<Record<string, string>> | undefined;
  /** The field's or pick's title in place of the command typed so far (`Port on the box`). */
  title?: string | undefined;
  /** A pick's value the cursor starts on (End run…'s neutral way, #320); else the first. */
  preselect?: string | undefined;
  /** Dim words under a pick's values (a workflow input's description); a field shows `summary`. */
  hint?: string | undefined;
};

/** What choosing a menu row does: run a command (asking first), hand it back, or a shell effect. */
export type MenuDoes =
  | {
      kind: 'run';
      argv: string[];
      ask?: readonly MenuAsk[] | undefined;
      risky?: boolean | undefined;
      /** A risky row's own question, in place of `Run abe …?` (#204). */
      confirm?: Question | undefined;
      /**
       * The status line once it went through (`Stopped #30's session`), not the CLI's answer; given
       * the asked values when it says them (`Moved #22 to Active`).
       */
      done?: string | ((values: readonly string[]) => string) | undefined;
    }
  /**
   * Hand the row back to the screen, once `ask`'s values are asked (they ride the choice as
   * `values`) and `confirm`'s question is answered `y` (Terminate…).
   */
  | {
      kind: 'back';
      ask?: readonly MenuAsk[] | undefined;
      confirm?: Question | undefined;
    }
  | { kind: 'shell'; effect: ShellEffect }
  /** These commands, in order (a Linked row's ⏎: open a screen in a slot, a jump). */
  | { kind: 'do'; commands: readonly Command[] };

/** One row of an Action menu (DS ActionMenu): its title, detail, key, or why it is grey. */
export type MenuRow = {
  id: string;
  text: string;
  dim?: string | undefined;
  /** A key it has, dim at the right (`⏎`, `⌃L`). */
  key?: string | undefined;
  /** Grey, never selectable: why it cannot run. */
  reason?: string | undefined;
  /** A separator line above it (the card menu's 2.0 rows, #107); drawn only while unfiltered. */
  separator?: boolean | undefined;
  /** Drawn red (`--abe-bad`): it deletes something (Terminate…, #104). */
  risky?: boolean | undefined;
  /**
   * It starts, stops or ends paid work (an agent, a box): the menu never opens on it, so a fast
   * ⌘⏎ ⏎ spends nothing (#313). Still where it is in the order, one key away.
   */
  costly?: boolean | undefined;
  /** Its letter: as the menu's first key (nothing filtered yet) it chooses the row; after, it filters. */
  letter?: string | undefined;
  /** Dim, monospace, before its text (Held writes' time, #24). */
  lead?: string | undefined;
  /** Dim at the right in its key's place (`would go to GitHub Projects`, #24). */
  note?: string | undefined;
  does: MenuDoes;
};

/** The Action menu of the object in focus (`⌘⏎`): a filtering pick over its rows. */
export type Menu = {
  kind: 'menu';
  id: string;
  title: string;
  rows: readonly MenuRow[];
  /** A row chosen as it opens (New workflow's): its words asked at once, the list never shown. */
  chosen?: string | undefined;
  /**
   * The row the cursor starts on when it can be chosen, a costly one too (Run workflow…'s, the
   * run's workflow; a card's next step), and where an erased filter puts it back.
   */
  preselect?: string | undefined;
  /**
   * `preselect` holds while it is grey too (a teammate's card's Launch agent): the cursor starts
   * there, ⏎ chooses nothing, a move goes on from it; never a row further down.
   */
  greyPreselect?: boolean | undefined;
  /** A list rather than actions (Held writes, #24): wide, its caption after the title, its hint under it. */
  look?:
    | { caption?: string | undefined; hint?: string | undefined; local?: boolean | undefined }
    | undefined;
};

/** A reading dialog (the card dialog): Esc closes it, its buttons hand back as choices. */
export type Dialog = {
  kind: 'dialog';
  id: string;
  dialog: CardDialog;
  lines: number;
  /**
   * The open dialog with this id drawn anew (its Sheets read), its scroll and Sheets cursor kept;
   * none open: nothing (it was closed meanwhile).
   */
  update?: boolean | undefined;
};

/**
 * `row` of menu (or dialog) `menu` was chosen. As a command, `slot` names the screen it goes to
 * (a word's choice for the Chat column's, `:override`); absent, the screen that asked.
 */
export type Choice = {
  kind: 'choice';
  menu: string;
  row: string;
  slot?: Slot | undefined;
  /** The values the row asked (`back` with `ask`), in its order. */
  values?: readonly string[] | undefined;
};

/** How often the bridge sends a `tick`. */
export const TICK_MS = 15_000;

/** How often it sends one while a screen open shows a clock by the second (`Screen.seconds`). */
export const SECOND_TICK_MS = 1000;

export type Command =
  /**
   * Run `abe <argv> --json`; its answer comes back as a `result` input with this id. `keep`: the
   * host keeps its answers (`live/queries.ts`): asked again, the last one comes at once as
   * `cached` while it is read anew, and two asks of it while one is out are one read.
   */
  | { kind: 'run'; id: string; argv: string[]; keep?: true | undefined }
  /**
   * The live facts read again (`r`): these, or every one an open screen follows; `ran`, the run a
   * launch just answered with, held at once until the read brings it.
   */
  | { kind: 'live'; reads?: readonly LiveRead[] | undefined; ran?: FactoryRunData | undefined }
  | { kind: 'shell'; effect: ShellEffect }
  /** Open this screen (`screens.ts`) in a slot (absent: `main`), in place of the one open there. */
  | {
      kind: 'open';
      screen: string;
      params?: Readonly<Record<string, string>> | undefined;
      slot?: Slot | undefined;
      /**
       * Only while this screen is the one open in the slot (it gets the `open` input): the
       * Board's card to the pane's Sessions, whose tab is the shell's to pick.
       */
      ifOpen?: true | undefined;
    }
  /** Ask in Command mode's ConfirmLayer, then run (its answer goes to the status line). */
  | Confirm
  /** Show in Command mode: an Action menu, a card dialog (over any layer of its own up). */
  | Menu
  | Dialog
  /** Command mode on a command, its arguments asked. */
  | Ask
  /** The CommentBox on a card, in Command mode. */
  | CommentOn
  /** The Launch box on a card, in Command mode. */
  | LaunchOn
  /** The New card dialog, in Command mode (#346). */
  | NewCardOn
  /** Hand a chosen row back to the open screen (Command mode's, for a screen's menu). */
  | Choice
  /** A jump along the story (a Linked row, a menu row): the bridge hands it on as the keys' are. */
  | Jump
  /**
   * The window's look with a change not written yet over it (#108: Appearance is live while
   * staged): the bridge sends the `look` effect of `abe theme look --stage`, and keeps the stage
   * over every settings change until a `look` with `stage: null` (Cancel, or OK once written)
   * puts the look in force back.
   */
  | { kind: 'look'; stage: LookStage | null };

/** A word a screen adds to Command mode (`:factory`), listed beside the command table's. */
export type Word = {
  readonly word: string;
  readonly summary: string;
  /** Its arguments, asked as a command's are (an enum's values as a pick) before it does anything. */
  readonly ask?: readonly ArgInfo[];
  /** What choosing it does: given the asked values, in `ask`'s order, when it asks any. */
  readonly commands: readonly Command[] | ((values: readonly string[]) => readonly Command[]);
};

export type Screen<S> = {
  readonly name: string;
  readonly init: S;
  readonly step: (state: S, input: Input) => { state: S; commands: Command[] };
  readonly view: (state: S) => Node;
  /** Its words in Command mode. */
  readonly words?: readonly Word[];
  /** The story what has its focus belongs to (#106 Behaviour 4): what ⌃L jumps along. */
  readonly linked?: (state: S) => number | undefined;
  /** A field of its own takes every key (`/`'s filter): `?` is typed, not the key help. */
  readonly typing?: (state: S) => boolean;
  /**
   * What it keeps when another screen takes its slot (#156): opened there again, it starts from
   * this state, its last rows drawn at once while it reads them again. Absent: it starts at `init`.
   */
  readonly keep?: (state: S) => S;
  /** It shows a clock by the second now (a cloud launch's, #142): ticks come every `SECOND_TICK_MS`. */
  readonly seconds?: (state: S) => boolean;
  /**
   * Opened in another slot with no `card` param, it opens on the main screen's story (its
   * `linked`: the Board's selected card, #107): the bridge names it as `card` (#137).
   */
  readonly opensOnMainCard?: boolean;
  /** What `:` and `?` start from while it has the keys (#346): its Subject, its view's rows. */
  readonly here?: (state: S) => Here;
  /** The live facts it shows now: live reads these while it is open and hands them as `live`. */
  readonly follows?: (state: S) => readonly LiveRead[];
  /**
   * The watch's events it takes; any other never reaches its step, so its tree is reused (a
   * Board event re-views no Chat). Every screen says its own: the live facts' moves come as
   * `live`, never as the events behind them.
   */
  readonly events: ReadonlySet<Event['type']>;
};

/**
 * A layer screen (Command mode): pure as a screen, mounted once for the bridge's life, over
 * whatever view is shown. Its view is the top layer, or `undefined` while none is up (it keeps
 * its state, so a command's answer still reaches it after it closed).
 */
export type LayerScreen<S> = {
  readonly name: string;
  readonly init: S;
  readonly step: (state: S, input: Input) => { state: S; commands: Command[] };
  readonly view: (state: S) => Node | undefined;
  /** The story of the layer up (Linked's, the story dialog's), if it has one. */
  readonly linked?: (state: S) => number | undefined;
};

export type MountedLayer = {
  readonly name: string;
  readonly tree: Node | undefined;
  readonly send: (input: Input) => Command[];
  readonly linked: () => number | undefined;
};

export const mountLayer = <S>(layer: LayerScreen<S>): MountedLayer => {
  let state = layer.init;
  let tree: Node | undefined;
  const mounted: MountedLayer = {
    name: layer.name,
    get tree() {
      return tree;
    },
    send: (input) => {
      const next = layer.step(state, input);

      // its state unchanged: its tree too, not viewed again
      if (next.state === state) return next.commands;
      const shown = layer.view(next.state);

      state = next.state;
      tree = shown === undefined ? undefined : Node.parse(shown);

      return next.commands;
    },
    linked: () => layer.linked?.(state),
  };

  return mounted;
};

export type Stepped<S> = { state: S; tree: Node; commands: Command[] };

/** One step: the screen's next state, its tree (checked against the closed set), what to do. */
export const step = <S>(screen: Screen<S>, state: S, input: Input): Stepped<S> => {
  const next = screen.step(state, input);

  return { state: next.state, tree: Node.parse(screen.view(next.state)), commands: next.commands };
};

/** A screen with its state held: what the bridge keeps for the open screen. */
export type Mounted = {
  readonly name: string;
  readonly tree: Node;
  readonly send: (input: Input) => Command[];
  /** The story its focus belongs to (`Screen.linked`). */
  readonly linked: () => number | undefined;
  /** Its own field takes every key (`Screen.typing`). */
  readonly typing: () => boolean;
  /** It keeps something for a reopen (`Screen.keep`). */
  readonly keeps: boolean;
  /**
   * The same screen opened anew from what it keeps (`Screen.keep`), once another took its slot;
   * undefined when it keeps nothing.
   */
  readonly reopen: (
    params: Readonly<Record<string, string>>,
    size: ViewSize,
  ) => { mounted: Mounted; commands: Command[] } | undefined;
  /** It shows a clock by the second now (`Screen.seconds`). */
  readonly seconds: () => boolean;
  /** What `:` and `?` start from (`Screen.here`); none: nothing of its own. */
  readonly here: () => Here | undefined;
  /** The live facts it follows now (`Screen.follows`); none: it shows none. */
  readonly follows: () => readonly LiveRead[];
};

/** Opens a screen: its state starts at `from` (`init` unless reopened) and takes the `open` input. */
export const mount = <S>(
  screen: Screen<S>,
  params: Readonly<Record<string, string>>,
  size: ViewSize,
  from: S = screen.init,
): { mounted: Mounted; commands: Command[] } => {
  let held = step(screen, from, { kind: 'open', params, size });
  const mounted: Mounted = {
    name: screen.name,
    get tree() {
      return held.tree;
    },
    send: (input) => {
      // an event it does not follow: nothing to step, its tree as it was
      if (input.kind === 'event' && !screen.events.has(input.event.type)) return [];
      const next = screen.step(held.state, input);

      // its state unchanged: its tree too, not viewed again
      held =
        next.state === held.state
          ? { state: held.state, tree: held.tree, commands: next.commands }
          : {
              state: next.state,
              tree: Node.parse(screen.view(next.state)),
              commands: next.commands,
            };

      return held.commands;
    },
    linked: () => screen.linked?.(held.state),
    typing: () => screen.typing?.(held.state) === true,
    keeps: screen.keep !== undefined,
    reopen: (again, sized) =>
      screen.keep === undefined ? undefined : mount(screen, again, sized, screen.keep(held.state)),
    seconds: () => screen.seconds?.(held.state) === true,
    here: () => screen.here?.(held.state),
    follows: () => screen.follows?.(held.state) ?? [],
  };

  return { mounted, commands: held.commands };
};

/** A screen of any state, as the registry holds it. */
export type AnyScreen = {
  readonly name: string;
  readonly words: readonly Word[];
  /** `Screen.opensOnMainCard`: the bridge gives it the main screen's card. */
  readonly opensOnMainCard: boolean;
  readonly mount: (
    params: Readonly<Record<string, string>>,
    size: ViewSize,
  ) => { mounted: Mounted; commands: Command[] };
  /** Mounted alone, with live facts of its own (`abe ui render`): no bridge hands it any. */
  readonly mountAlone: (
    params: Readonly<Record<string, string>>,
    size: ViewSize,
  ) => { mounted: Mounted; commands: Command[] };
};

export const anyScreen = <S>(screen: Screen<S>): AnyScreen => ({
  name: screen.name,
  words: screen.words ?? [],
  opensOnMainCard: screen.opensOnMainCard === true,
  mount: (params, size) => mount(screen, params, size),
  mountAlone: (params, size) => mount(withLive(screen), params, size),
});
