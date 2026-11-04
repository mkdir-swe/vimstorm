/**
 * The key help (board Keys, `2.1 · Every key`) as Command mode's menu: `?` in the Abe view
 * lists this view's keys (the Board's, the window's, the jumps, the layers'), `?` in a dialog the
 * dialog's (#281), a second `?` (`??`) every key of the window, a section per row's detail;
 * typing filters it. The jump is there with its two exceptions (#106 AC 7): ⌃L, and ⌃⌥L in an
 * nvim split or a terminal. A row only says; ⏎ closes it.
 */
import { JUMP_KEYS } from '../board/jumps';
import { type Menu, type MenuRow } from '../runtime/runtime';

/** The key that opens it, when no layer is up; again (`??`) for every key. */
export const KEY_HELP = '?';

/** Its menu's id: this view's (or dialog's) keys, then every key. */
export const KEY_HELP_MENU = 'keys';
export const EVERY_KEY_MENU = 'keys:every';

/**
 * Where `?` was pressed (#346: the surface with the keys): the Abe view, a story dialog,
 * another dialog, the pane's Sessions, Boxes or Pipelines, Chat, the Editor, Welcome; `every`
 * for `??`.
 */
export type KeyScope =
  | 'view'
  | 'card'
  | 'story'
  | 'dialog'
  | 'sessions'
  | 'boxes'
  | 'pipelines'
  | 'chat'
  | 'editor'
  | 'welcome'
  | 'prototype'
  | 'every';

const LISTS = 'Lists · Sessions, Boxes, Pipelines';

/** `[keys, what, section]`, in the board's order. */
const EVERY_KEY: readonly (readonly [string, string, string])[] = [
  [
    '⌘1',
    'The page’s left pane · Code: the Project tree · Run: the steps · the story',
    'Views & panes',
  ],
  ['⌘2', 'The page’s main pane · Code: the open file · Run: the picked step', 'Views & panes'],
  ['⌘3', 'Git · the bottom panel’s Git tab · again hides it', 'Views & panes'],
  ['⌘J', 'Code’s bottom panel shown · hidden', 'Views & panes'],
  ['⌘4', 'Chat · the right column, in its mode', 'Views & panes'],
  [
    '⌃⌘← ⌃⌘→',
    'Chat · Claude Code, the keys there · on Code with the keys elsewhere, that pane’s tabs',
    'Views & panes',
  ],
  ['⌥⌘← ⌥⌘→', 'The tabs of what has the keys · editor tabs, the shells, Git’s', 'Views & panes'],
  ['⌘⇧2 · ⌘⌥2', 'Chat docked ↔ maximized · hidden ↔ shown', 'Views & panes'],
  [
    '⌘↑ ⌘↓',
    'The rail: above · below in its group (workspaces and prototypes, or Board · Boxes · Pipelines)',
    'Views & panes',
  ],
  ['⌘←', 'Down to the Board', 'Views & panes'],
  ['⌘→', 'From the Board, Boxes or Pipelines: up to the workspaces', 'Views & panes'],
  ['⌘§', 'Abe · again, back', 'Views & panes'],
  ['⌃1 ⌃2 ⌃3', 'The workspace’s page: Code · Run · Card', 'Views & panes'],
  ['⌃1 ⌃2 ⌃3', 'A prototype’s page: Preview · Code · Logs', 'Prototype'],
  ['⏎', 'Preview: the app takes the keys · stopped: start it · failed: ask it to fix', 'Prototype'],
  ['Esc', 'The keys back from the app, always Abe’s', 'Prototype'],
  ['r · R', 'Reload the preview · restart the app', 'Prototype'],
  ['v', 'The next viewport · Fit 1280 768 390', 'Prototype'],
  ['o', 'Open in the browser', 'Prototype'],
  ['m', 'Make card… · asks its session', 'Prototype'],
  ['s · d', 'Stop the app · Discard… (asked, Cancel the default)', 'Prototype'],
  ['⌘⏎ · right-click', 'The prototype’s actions', 'Prototype'],
  ['l ö · ⏎', 'Code: the files · open one in the editor', 'Prototype'],
  ['⌘T · ⌃`', 'The bottom panel’s Terminal · again hides it', 'Views & panes'],
  ['⌘⌥A', 'The Board ↔ the workspace you were in', 'Views & panes'],
  ['⇧⇧', 'Search Everywhere', 'Views & panes'],
  ['⌘,', 'Settings', 'Views & panes'],
  [':', 'Ask anything, or a command', 'Views & panes'],
  ['? ??', 'This view’s keys · every key', 'Views & panes'],
  ['⌥⌘⏎', 'Fill the window with the island you are in', 'Maximize'],
  ['⌥⌘⏎ · Esc', 'Restore · toolbar and status bar stay', 'Maximize'],
  [JUMP_KEYS.linked, 'Linked: everything on the story', 'Jumps'],
  ['⌃⌥L', 'The same, from anywhere', 'Jumps'],
  [JUMP_KEYS.linked, 'In an nvim split: add a caret above; ⌃⌥ jumps there', 'Jumps'],
  [JUMP_KEYS.linked, 'In a terminal: the shell’s; ⌃⌥ jumps there', 'Jumps'],
  ['⏎', 'The card’s page, as a popup over the Board', 'Board'],
  ['⌘⏎ · right-click', 'Actions · the likely next step first', 'Board'],
  ['k ä', 'The column left · right · back on the card you left there', 'Board'],
  ['l ö', 'The card above · below', 'Board'],
  ['L Ö', 'Five cards up · down', 'Board'],
  ['gg G · Home End', 'The column’s first · last card', 'Board'],
  ['3ö · 5G', 'A count before a move · three down, the fifth card', 'Board'],
  ['⇟ ⇞ · ⌃F ⌃B', 'A page down · up', 'Board'],
  ['⌃D ⌃U', 'Half a page down · up', 'Board'],
  ['Tab ⇧Tab', 'Mine · Team · Sessions', 'Board'],
  ['l ö · ⏎', 'On Sessions: move · Chat on the session, to read; never its workspace', 'Board'],
  ['/', 'Filter as you type · ↑ ↓ move, ← → the caret, ⏎ opens, Esc puts it back', 'Board'],
  ['r', 'Read the Board again', 'Board'],
  ['Esc', 'Filter off · restore a maximized Board', 'Board'],
  [':', 'Ask about the card, or a command', 'Board'],
  ['wheel', 'Scroll the column under the pointer · sideways the columns', 'Board'],
  ['l ö', 'Scroll · PageUp PageDown a page', 'Card page'],
  ['gg G · Home End', 'The top · the end', 'Card page'],
  ['⏎', 'Comment: into the composer · there, post it', 'Card page'],
  ['⇧⏎', 'A new line in the comment', 'Card page'],
  ['Tab ⇧Tab', 'The composer · the actions · back to the page', 'Card page'],
  ['k ä · ← →', 'On the actions: the one beside', 'Card page'],
  ['⏎', 'On an action: Move…, Assign…, Launch again…, Stop the session (asked first)', 'Card page'],
  ['⌘⏎', 'The card’s actions', 'Card page'],
  ['r', 'Read the card again', 'Card page'],
  ['Esc', 'Out of the composer · the Board’s popup: back to the Board', 'Card page'],
  ['⏎', 'The button the keys are on (the primary) · a story’s next step', 'Dialogs'],
  ['← → · k ä · Tab ⇧Tab', 'Move between its buttons', 'Dialogs'],
  ['⌘⏎', 'More · a story’s actions', 'Dialogs'],
  ['l ö', 'Scroll · PageUp PageDown a page', 'Dialogs'],
  ['gg G · Home End', 'The top · the end', 'Dialogs'],
  [':', 'Ask, or a command, over the dialog', 'Dialogs'],
  ['Esc', 'Close the dialog', 'Dialogs'],
  ['Tab ⇧Tab', 'Past its buttons into its Sheets · back out', 'Story dialog'],
  ['l ö · ⏎', 'In Sheets: move · show the sheet', 'Story dialog'],
  ['typing', 'Filters the rows · every letter types; ↑ ↓ ⌃N ⌃P move', 'Linked'],
  ['⏎', 'Open the row', 'Linked'],
  ['Esc', 'Close', 'Linked'],
  ['l ö', 'Move · a count first: 3ö', LISTS],
  ['L Ö', 'Five rows', LISTS],
  ['⇟ ⇞ · ⌃F ⌃B', 'A page down · up', LISTS],
  ['⌃D ⌃U', 'Half a page down · up', LISTS],
  ['gg G · 5G Home End', 'First · last · the fifth row', LISTS],
  ['/', 'Filter as you type · ↑ ↓ move, ← → the caret, ⏎ opens, Esc puts it back', LISTS],
  ['Esc', 'Filter off · then the keys back', LISTS],
  ['⏎', 'Open · a box: attach', LISTS],
  ['⌘⏎', 'The row’s actions', LISTS],
  ['r', 'Read again · Boxes, Pipelines', LISTS],
  ['Tab ⇧Tab', 'This workspace · All · Mine', 'Pipelines'],
  ['w', 'One workflow’s history · Esc back', 'Pipelines'],
  ['⏎', 'The run’s graph · again the job’s log', 'Pipelines'],
  ['k l ö ä', 'Between the graph’s boxes', 'Pipelines'],
  ['l ö · o', 'In the log: its evidence · open the file a failure names', 'Pipelines'],
  ['⏎', 'In the log: Fix with agent with that evidence, asked first', 'Pipelines'],
  ['⌘⏎', 'The run’s actions · rerun, cancel, approve, Fix with agent, Run workflow…', 'Pipelines'],
  ['m', 'More runs · the next page, older', 'Pipelines'],
  ['Esc', 'Log → graph → runs', 'Pipelines'],
  ['⌘4', 'Chat, in its mode · the keys there', 'Chat'],
  ['⌃⌘← ⌃⌘→', 'Chat · Claude Code', 'Chat'],
  ['×', 'Hide the column', 'Chat'],
  ['⌘⇧D', 'Chat in its own window · again docks it', 'Chat'],
  ['/override', 'Lower a limit · this session, with a reason', 'Chat'],
  [':override', 'The same, from anywhere', 'Chat'],
  ['⏎', 'Launch agent · when there is no session', 'Chat'],
  ['⌘⏎', 'The session’s actions', 'Chat'],
  ['⌫', 'On the context chip: drop it · this message', 'Chat'],
  ['⏎ · ⇧⏎', 'Send · new line, in the composer', 'Chat'],
  ['/', 'Commands over the field · /override /compact /clear /model', 'Chat'],
  ['1–9', 'Pick an option · the recommended one is 1', 'Question cards'],
  ['⏎', 'Confirm · a grill round: send all', 'Question cards'],
  ['y', 'Accept the recommended answer', 'Question cards'],
  ['Tab', 'The next card in a grill round', 'Question cards'],
  ['o', 'Type your own answer', 'Question cards'],
  ['Esc', 'Leave it for later · it stays ◆ Needs you', 'Question cards'],
  ['typing', 'A text line · every letter types, k l ö ä too', 'Command mode'],
  ['↑ ↓ · ⌃N ⌃P · Tab ⇧Tab', 'Move the rows', 'Command mode'],
  ['⏎', 'The highlighted row · a sentence or a ? asks, one word runs its command', 'Command mode'],
  ['::', 'Neovim’s own command line', 'Command mode'],
  ['⏎ · Esc', 'In a prompt: take the text · back', 'Command mode'],
  ['⌘V', 'Paste into the prompt', 'Command mode'],
  ['y · n', 'A risky command: run it · No, the default', 'Command mode'],
  ['⏎ · ⇧⏎', 'In a comment: post · new line', 'Command mode'],
  ['⌘Z', 'Undo the last save', 'Settings'],
  ['Esc', 'Close · every change is saved already', 'Settings'],
  ['Tab ⇧Tab', 'Search · tree · page · Close', 'Settings'],
  ['/', 'Search every page', 'Settings'],
  ['k ä', 'In the tree: fold · unfold, into the page', 'Settings'],
  ['⏎', 'Change the row · saved at once; a dropdown filters as you type', 'Settings'],
  ['Space', 'Tick a checkbox', 'Settings'],
  ['⌘⏎', 'Propose the row to the repo', 'Settings'],
  [':', 'Command mode · an Ex command (:w, :q, :42) runs in Neovim', 'Editor'],
  ['⌘⏎ · right-click', 'The caret’s actions', 'Editor'],
  [',?', 'Every Neovim key', 'Editor'],
  ['Esc', 'Close the popup or menu', 'Layers'],
  ['typing', 'Filters a menu · every letter types; ↑ ↓ ⌃N ⌃P move', 'Layers'],
  ['Home End', 'A menu’s first · last row', 'Layers'],
];

/** The sections `?` lists where it was pressed, in this order. */
const HERE: Readonly<Record<Exclude<KeyScope, 'every'>, readonly string[]>> = {
  view: ['Board', 'Views & panes', 'Jumps', 'Layers'],
  card: ['Card page', 'Views & panes', 'Jumps', 'Layers'],
  story: ['Dialogs', 'Story dialog', 'Jumps', 'Layers'],
  dialog: ['Dialogs', 'Layers'],
  sessions: [LISTS, 'Jumps', 'Views & panes', 'Layers'],
  boxes: [LISTS, 'Jumps', 'Views & panes', 'Layers'],
  pipelines: ['Pipelines', LISTS, 'Views & panes', 'Layers'],
  chat: ['Chat', 'Question cards', 'Jumps', 'Views & panes', 'Layers'],
  editor: ['Editor', 'Command mode', 'Jumps', 'Views & panes', 'Layers'],
  welcome: [LISTS, 'Command mode', 'Layers'],
  prototype: ['Prototype', 'Views & panes', 'Jumps', 'Layers'],
};

const TITLE: Readonly<Record<KeyScope, string>> = {
  view: 'Abe view keys · ? every key',
  card: 'Card page keys · ? every key',
  story: 'Story dialog keys · ? every key',
  dialog: 'Dialog keys · ? every key',
  sessions: 'Sessions keys · ? every key',
  boxes: 'Boxes keys · ? every key',
  pipelines: 'Pipelines keys · ? every key',
  chat: 'Chat keys · ? every key',
  editor: 'Editor keys · ? every key',
  welcome: 'Welcome keys · ? every key',
  prototype: 'Prototype keys · ? every key',
  every: 'Every key',
};

const ROW: MenuRow['does'] = { kind: 'do', commands: [] };

const rowOf = ([key, text, section]: readonly [string, string, string], i: number): MenuRow => ({
  id: `key:${i}`,
  text,
  dim: section,
  key,
  does: ROW,
});

/** The key help as Command mode's menu, each key dim at its row's right; `every` for `??`. */
export const keyHelp = (scope: KeyScope = 'view'): Menu => ({
  kind: 'menu',
  id: scope === 'every' ? EVERY_KEY_MENU : KEY_HELP_MENU,
  title: TITLE[scope],
  rows:
    scope === 'every'
      ? EVERY_KEY.map(rowOf)
      : HERE[scope].flatMap((section) =>
          EVERY_KEY.flatMap((row, i) => (row[2] === section ? [rowOf(row, i)] : [])),
        ),
});
