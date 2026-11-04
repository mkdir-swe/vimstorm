/**
 * The Settings dialog's keys, clicks and answers (#345 split of `settings.ts`): moves, the mode
 * with the keys first, typed text.
 */
import { type SettingsDialogRules } from '@abe/core';
import { PAGE_ROWS, listMove } from '../runtime/list-moves';
import { type Input } from '../runtime/runtime';
import { type SettingsFocus } from './settings-components';
import {
  colourEditKey,
  colourFoldKey,
  colourSaved,
  coloursAnswered,
  coloursDue,
  resetToken,
  themesAnswered,
} from './settings-colours';
import { imported, tickImport } from './settings-import';
import { localAnswered } from './settings-local';
import { checked, dropFix } from './settings-logins';
import { addKey, openProfile, profileKey, profilesAnswered, removeKey } from './settings-profiles';
import { propose, proposeClick, proposeKey, proposed } from './settings-propose';
import {
  type Line,
  clampRow,
  close,
  focusedLine,
  runOf,
  lines,
  readAll,
  results,
  searching,
  without,
} from './settings-rows';
import { change, editKey, reset } from './settings-change';
import { listClick } from './settings-list';
import { recordsClick } from './settings-records';
import {
  type Editing,
  FIRST_PAGE,
  LEFT,
  type Out,
  PAGE_READS,
  RIGHT,
  type SettingsState,
  UP,
  addingOf,
  editMode,
  editingOf,
  proposeMode,
  proposingOf,
  removingOf,
  same,
  status,
  typedChar,
  unedit,
  downOf,
  edited,
  refusal,
} from './settings-state';
import { findNode, parentOf, pick, problemCount, walkable } from './settings-tree';
import { held, unread } from './settings-view';
import { changesRead, isRecord, setArgv, undoLast, written } from './settings-writes';

/** Where a move from `at` lands among `n` rows: first, last, or `by` on, kept inside. */
export const moved = (by: number | 'first' | 'last', at: number, n: number): number => {
  if (by === 'first') return 0;
  if (by === 'last') return n - 1;

  return Math.max(0, Math.min(n - 1, at + by));
};

const move = (r: SettingsDialogRules, s: SettingsState, by: number | 'first' | 'last'): Out => {
  // a first open still waiting for Problems: the first move shows the page the cursor is on
  if (s.focus === 'tree' && held(s)) return same(pick(s, s.node));
  if (s.focus === 'page' && unread(r, s)) return same(s);
  if (s.focus === 'tree') {
    const rows = walkable(r, s);
    const at = rows.findIndex((v) => v.node.id === s.node);
    const up = typeof by === 'number' && by < 0;
    // off the walk (a greyed page the search left the cursor on): ↓ takes the first, ↑ the last
    const off = up ? rows.length : -1;
    const from = at >= 0 ? at : off;
    const node = rows[moved(by, from, rows.length)]?.node.id ?? s.node;

    return same(pick(s, node));
  }

  return same({ ...s, row: Math.max(0, moved(by, s.row, lines(r, s).length)), moved: true });
};

const treeKey = (r: SettingsDialogRules, s: SettingsState, key: string): Out => {
  const node = findNode(r.tree, s.node);
  const kids = node?.children.length ?? 0;
  const folded = s.folded.includes(s.node);

  if (LEFT.has(key)) {
    if (kids > 0 && !folded) return same({ ...s, folded: [...s.folded, s.node] });
    const parent = parentOf(r.tree, s.node);

    return parent === undefined ? same(s) : same(pick(s, parent.id));
  }
  if (RIGHT.has(key)) {
    if (kids > 0 && folded) return same({ ...s, folded: s.folded.filter((f) => f !== s.node) });
    if (node?.page === null && node.children[0] !== undefined)
      return same(pick(s, node.children[0].id));

    return same({ ...pick(s, s.node), focus: 'page' });
  }
  if (key === '<CR>') return same({ ...pick(s, s.node), focus: 'page' });

  return same(s);
};

const pageKey = (r: SettingsDialogRules, s: SettingsState, key: string): Out => {
  // `Reading settings…`: no row to act on yet, only the way back to the tree
  if (unread(r, s)) return same(LEFT.has(key) ? { ...s, focus: 'tree' } : s);
  const line = focusedLine(r, s);
  const folded = colourFoldKey(r, s, line, key);

  if (folded !== undefined) return folded;

  // k to the tree, from the results too (#299: on a lit page, as Tab takes it there)
  if (LEFT.has(key))
    return same(results(s) === undefined ? { ...s, focus: 'tree' } : intoTree(r, s));
  if (key === '<CR>') return line === undefined ? same(s) : change(r, s, line);
  if (line?.kind === 'profile') {
    const done = profileKey(r, s, line.profile, key);

    if (done !== undefined) return done;
  }
  if (key === '<BS>' && line?.kind === 'token') return resetToken(s, line.token);
  if ((key === '<BS>' || key === '<Del>') && line?.kind === 'setting')
    return reset(s, line.row, line.listed);
  if (line?.kind === 'local' && key === '<Space>') return change(r, s, line);
  if (line?.kind === 'local' && key === '<D-CR>')
    return { state: s, commands: [status('Local mode: yours alone, not for the repo')] };
  if (key === '<D-CR>') return propose(r, s, line);
  if (key === '<Space>' && line?.kind === 'setting' && line.row.control === 'checkbox')
    return change(r, s, line);
  if (key === '<Space>' && line?.kind === 'import-row') return same(tickImport(s, line.row));

  return same(s);
};

/** Tab's order (#152): the search field, the tree, the page, Close, and round. */
const FOCUS_ORDER: readonly SettingsFocus[] = ['search', 'tree', 'page', 'close'];

const tab = (r: SettingsDialogRules, s: SettingsState, by: 1 | -1): SettingsState => {
  const at = FOCUS_ORDER.indexOf(s.focus);
  const focus = FOCUS_ORDER[(at + by + FOCUS_ORDER.length) % FOCUS_ORDER.length] ?? 'tree';

  if (focus === 'search') return startSearch(s);
  // the page taken while a first open waits for Problems: that page, no jump after (#297)
  if (focus === 'page' && held(s)) return { ...s, focus, moved: true };
  // out of a search with nothing typed: no search left behind for Esc to clear
  if (s.focus === 'search' && searching(s) === undefined)
    return { ...s, focus, search: null, before: undefined, picked: false };
  if (focus !== 'tree') return { ...s, focus };

  return intoTree(r, s);
};

/** The keys to the tree; while searching its cursor on a lit row (the results stay until a pick). */
const intoTree = (r: SettingsDialogRules, s: SettingsState): SettingsState => {
  const rows = walkable(r, s);

  return rows.some((v) => v.node.id === s.node)
    ? { ...s, focus: 'tree' }
    : { ...s, focus: 'tree', node: rows[0]?.node.id ?? s.node };
};

/** `/`: the caret in the search field, where it was kept to go back to. */
const startSearch = (s: SettingsState): SettingsState => ({
  ...s,
  focus: 'search',
  search: s.search ?? '',
  before: s.search === null ? { node: s.node, row: s.row, focus: s.focus } : s.before,
  mode: unedit(s),
});

/**
 * Esc on a search: back where `/` was pressed; on a page picked while searching, that page stays
 * (its rows, the keys where they are, the field's caret to the tree).
 */
const endSearch = (s: SettingsState): SettingsState =>
  s.picked
    ? {
        ...s,
        search: null,
        picked: false,
        before: undefined,
        focus: s.focus === 'search' ? 'tree' : s.focus,
      }
    : {
        ...s,
        search: null,
        picked: false,
        focus: s.before?.focus ?? 'tree',
        node: s.before?.node ?? s.node,
        row: s.before?.row ?? 0,
        before: undefined,
      };

/** The search's text as typed: a change shows the results again. */
export const searchTyped = (s: SettingsState, text: string): SettingsState =>
  text === s.search ? s : { ...s, search: text, row: 0, picked: false };

const searchKey = (r: SettingsDialogRules, s: SettingsState, key: string): Out => {
  if (key === '<Esc>') return same(endSearch(s));
  if (key === '<Tab>') return same(tab(r, s, 1));
  if (key === '<S-Tab>') return same(tab(r, s, -1));
  if (key === '<CR>' || key === '<Down>') return same({ ...s, focus: 'page', row: 0 });

  return same(searchTyped(s, edited(s.search ?? '', key)));
};

/** What ⌘A's selection is typed over with: these empty the field first. */
const OVER = new Set(['<BS>', '<Del>', '<D-BS>', '<C-u>']);

/**
 * The state with the text of the field that has the caret emptied (⌘A then a key over it), or
 * `undefined` when no field has the caret. In the order `onKey` gives the keys to them.
 */
export const emptied = (s: SettingsState): SettingsState | undefined => {
  if (removingOf(s) !== undefined) return undefined;
  const p = proposingOf(s);

  if (p !== undefined) {
    if (p.running !== undefined) return undefined;
    if (p.focus === 'reason') return { ...s, mode: proposeMode({ ...p, reason: '' }) };
    if (p.focus === 'value' && p.value.kind === 'field')
      return { ...s, mode: proposeMode({ ...p, value: { ...p.value, text: '' } }) };

    return undefined;
  }
  // Add profile's cells are table text with no field to draw a selection in
  if (addingOf(s) !== undefined) return undefined;
  const e = editingOf(s);

  if (e !== undefined) {
    switch (e.kind) {
      case 'field':
        return { ...s, mode: editMode({ ...e, text: '' }), errors: without(s.errors, e.row) };
      case 'colours-filter':
      case 'token':
      case 'reason':
        return { ...s, mode: editMode({ ...e, text: '' }) };
      case 'records':
        return e.field === undefined
          ? undefined
          : { ...s, mode: editMode({ ...e, field: { text: '' } }) };
      // a combo's filter is no field: nothing to select in it
      default:
        return undefined;
    }
  }

  // the search emptied: its results anew
  return s.focus === 'search' ? { ...s, search: '', picked: false, row: 0 } : undefined;
};

/** ⌘A selects a field's text; a key then types over it (⌫ empties it), any other lets it go. */
export const selectKey = (r: SettingsDialogRules, s0: SettingsState, raw: string): Out => {
  if (raw === '<D-a>') return same({ ...s0, all: emptied(s0) !== undefined });
  const s = { ...s0, all: false };

  if (!s0.all || (!OVER.has(raw) && typedChar(raw) === undefined)) return onKey(r, s, raw);
  return onKey(r, emptied(s) ?? s, raw);
};

/** ⌘S: every change saves as it is made; a field open takes its value as ⏎ does. */
const SAVED_ALREADY = 'Settings save as you change them';

const onKey = (r: SettingsDialogRules, s0: SettingsState, raw: string): Out => {
  const mode = s0.mode;

  if (mode?.kind === 'propose') return proposeKey(r, s0, mode.propose, raw);
  if (mode?.kind === 'remove') return removeKey(s0, mode.name, raw);
  if (mode?.kind === 'add' && raw !== '<D-s>') return addKey(s0, mode.add, raw);
  const e = mode?.kind === 'edit' ? mode.edit : undefined;

  // ⌘S takes the field as ⏎ would; a hex ⏎ refuses keeps it open, nothing written
  if (e?.kind === 'colours-filter' || e?.kind === 'token')
    return colourEditKey(s0, e, raw === '<D-s>' ? '<CR>' : raw);
  // ⌘Z in a list's or records' editor undoes the last save, the editor kept open on it
  if (
    (e?.kind === 'list' && e.field === undefined && raw === '<D-z>') ||
    (e?.kind === 'records' && e.field === undefined && e.pick === undefined && raw === '<D-z>')
  ) {
    const back = undoLast(r, s0);

    return { ...back, state: { ...back.state, mode: s0.mode } };
  }
  if (e !== undefined) return editKey(r, s0, e, raw === '<D-s>' ? '<CR>' : raw);
  if (s0.focus === 'search' && raw !== '<D-s>') return searchKey(r, s0, raw);
  const key = s0.g && raw === 'g' ? 'gg' : raw;
  const s = { ...s0, g: false };

  if (key === '<D-s>') return { state: s, commands: [status(SAVED_ALREADY)] };
  if (key === '<D-z>') return undoLast(r, s);
  if (key === '<Esc>') {
    if (s.fix !== undefined) return dropFix(s);
    if (s.search !== null) return same(endSearch(s));

    return close(s);
  }
  if (key === '/') return same(startSearch(s));
  if (key === '<Tab>') return same(tab(r, s, 1));
  if (key === '<S-Tab>') return same(tab(r, s, -1));
  if (s.focus === 'close') return key === '<CR>' || key === '<Space>' ? close(s) : same(s);
  if (key === 'g') return same({ ...s, g: true });
  // ↑ off the first result: back in the search field (#299, WebStorm's)
  if (UP.has(key) && s.focus === 'page' && s.row === 0 && results(s) !== undefined)
    return same({ ...s, focus: 'search' });
  // every list's moves (`list-moves.ts`, #334): Home / End as `gg` / `G`, the pages
  const m = listMove(key, PAGE_ROWS);

  if (m?.kind === 'to') return move(r, s, m.row === 'last' ? 'last' : 'first');
  if (m !== undefined) return move(r, s, m.rows);

  return s.focus === 'tree' ? treeKey(r, s, key) : pageKey(r, s, key);
};

/**
 * A click on part of a row (the shell's hit areas, `<row id>:<part>`): `press` its control (the
 * checkbox and its label, the combo, the field, a ProblemRow's or CheckRow's button), `choice:<i>`
 * a segment or a theme cell, `cell:<r>:<c>` a cell of records not open yet.
 */
const PART = /^settings:line:(\d+):(?:(press)|choice:(\d+)|cell:(\d+):(\d+))$/;

type Part =
  { kind: 'press' } | { kind: 'choice'; at: number } | { kind: 'cell'; row: number; col: number };

const partOf = (id: string): { at: number; part: Part } | undefined => {
  const m = PART.exec(id);

  if (m === null) return undefined;
  const at = Number(m[1]);

  if (m[2] !== undefined) return { at, part: { kind: 'press' } };
  if (m[3] !== undefined) return { at, part: { kind: 'choice', at: Number(m[3]) } };

  return { at, part: { kind: 'cell', row: Number(m[4]), col: Number(m[5]) } };
};

/** Lines that are a button themselves (a search's page, Add profile…, a group's fold): one click acts. */
const BUTTON_LINES: ReadonlySet<Line['kind']> = new Set(['page-hit', 'add-profile', 'token-group']);

/** Whether `e` is this line's editor. */
const editsLine = (e: Editing, line: Line): boolean => {
  if (line.kind === 'setting' || line.kind === 'local') return e.row === line.row.id;
  if (line.kind === 'token') return e.kind === 'token' && e.name === line.token.name;
  if (line.kind === 'colours-filter') return e.kind === 'colours-filter';

  return false;
};

/** The line `e` edits, by its index on the page. */
const editedAt = (r: SettingsDialogRules, s: SettingsState, e: Editing): number =>
  lines(r, s).findIndex((l) => editsLine(e, l));

/** The click lands in the field typed in: the caret stays, nothing commits. */
const inField = (r: SettingsDialogRules, s: SettingsState, e: Editing, id: string): boolean => {
  if (e.kind === 'list') {
    const at = e.field?.at;

    return at !== undefined && at !== null && id === `settings:item:${at}`;
  }
  if (e.kind === 'records')
    return e.field !== undefined && id === `settings:cell:${e.cursor.row}:${e.cursor.col}`;
  if (e.kind !== 'field' && e.kind !== 'token' && e.kind !== 'colours-filter') return false;

  return id === `settings:line:${editedAt(r, s, e)}:press`;
};

/** The click lands in the open editor (a combo's list, a list's or records' own parts). */
const inEditor = (r: SettingsDialogRules, s: SettingsState, e: Editing, id: string): boolean => {
  if (id.startsWith(`settings:line:${editedAt(r, s, e)}:`)) return true;
  if (e.kind === 'combo') return id.startsWith('settings:choice:');
  if (e.kind === 'list') return id.startsWith('settings:item');
  if (e.kind === 'records') return /^settings:(cell|record|choice)[-:]/.test(id);

  return false;
};

/**
 * What was typed in a field, taken as ⏎ takes it, before a click elsewhere: a field, a hex, a
 * list's item or a records cell; `undefined` for any other editor (nothing typed to take).
 */
const commitTyped = (r: SettingsDialogRules, s: SettingsState, e: Editing): Out | undefined => {
  if (e.kind === 'token') return colourEditKey(s, e, '<CR>');
  if (e.kind === 'field') return editKey(r, s, e, '<CR>');
  if ((e.kind === 'list' || e.kind === 'records') && e.field !== undefined)
    return editKey(r, s, e, '<CR>');

  return undefined;
};

/** The commit refused or asked for more (a reason): the field stays and the click goes no further. */
const heldBack = (before: Editing, out: Out): boolean => {
  const e = editingOf(out.state);

  if (e === undefined) return false;
  // a list or records editor keeps what was typed, refused too: the click goes on in it
  if (e.kind === 'list' || e.kind === 'records') return e.field !== undefined;
  if (out.state.errors[before.row] !== undefined) return true;

  return e.kind === 'field' || e.kind === 'token' || e.kind === 'reason';
};

/**
 * Every click in the dialog: a click outside the field typed in commits it as ⏎ does (a refusal
 * keeps it, its reason under the row), outside an open combo or list closes it, then the click
 * acts on what it landed on, its row focused.
 */
export const onClick = (r: SettingsDialogRules, s: SettingsState, id: string): Out => {
  const p = proposingOf(s);

  if (p !== undefined) return proposeClick(r, s, p, id);
  // the footer's buttons: as before, a field open is let go (Close), Undo takes the last save
  if (id === 'settings:close') return close(s);
  if (id === 'settings:undo') return undoLast(r, s);
  const e = editingOf(s);

  if (e === undefined) return clicked(r, s, id, false);
  if (inField(r, s, e, id)) return same(s);
  // its own Choose…: the field opens again for the folder picked, nothing typed taken
  if (id === `settings:browse:${editedAt(r, s, e)}`) return clicked(r, s, id, true);
  const typed = commitTyped(r, s, e) ?? same(s);

  if (typed.state !== s && heldBack(e, typed)) return typed;
  const t = typed.state;
  const open = editingOf(t);
  const kept = open !== undefined && inEditor(r, t, open, id);
  const out = clicked(r, kept ? t : { ...t, mode: unedit(t) }, id, true);

  return { state: out.state, commands: [...typed.commands, ...out.commands] };
};

/** A click on `id`, an edit left before it (`left`). */
const clicked = (r: SettingsDialogRules, s: SettingsState, id: string, left: boolean): Out => {
  const e = editingOf(s);

  if (
    e?.kind === 'records' &&
    (id.startsWith('settings:cell') ||
      id.startsWith('settings:record') ||
      id.startsWith('settings:choice'))
  ) {
    const line = lines(r, s).find((l) => l.kind === 'setting' && l.row.id === e.row);
    const done =
      line?.kind === 'setting' && line.listed !== undefined
        ? recordsClick(r, s, e, id, line.row, line.listed)
        : undefined;

    if (done !== undefined) return done;
  }
  if (e?.kind === 'list' && id.startsWith('settings:item')) {
    const line = lines(r, s).find((l) => l.kind === 'setting' && l.row.id === e.row);
    const done =
      line?.kind === 'setting' && line.listed !== undefined
        ? listClick(r, s, e, id, line.row, line.listed)
        : undefined;

    if (done !== undefined) return done;
  }
  const part = partOf(id);

  if (part !== undefined) return pressed(r, s, part.at, part.part);
  const opening = /^settings:open:(\d+)$/.exec(id);

  if (opening !== null) {
    const at = Number(opening[1]);
    const line = lines(r, s)[at];

    if (line?.kind !== 'profile') return same(s);

    return openProfile(
      { ...s, focus: 'page', row: at, moved: true, mode: undefined },
      line.profile,
    );
  }
  const rowAt = /^settings:(reset|browse):(\d+)$/.exec(id);

  if (rowAt !== null) {
    const at = Number(rowAt[2]);
    const line = lines(r, s)[at];

    if (line?.kind !== 'setting') return same(s);
    const next = { ...s, focus: 'page' as const, row: at, moved: true, mode: unedit(s) };

    if (rowAt[1] === 'reset') return reset(next, line.row, line.listed);

    return same(browsed(next, line.row.id, line.row.control === 'chips'));
  }
  if (id === 'settings:search') return same(startSearch(s));
  if (id === 'settings:retry') return readAll({ ...s, down: undefined });
  if (id.startsWith('settings:tree:')) {
    const node = id.slice('settings:tree:'.length);

    return same({
      ...pick(s, node),
      focus: 'tree',
      mode: undefined,
    });
  }
  if (id.startsWith('settings:choice:')) {
    if (e?.kind !== 'combo') return same(s);
    const picked = { ...e, cursor: Number(id.slice('settings:choice:'.length)) };

    return editKey(r, { ...s, mode: editMode(picked) }, picked, '<CR>');
  }
  const lineAt = /^settings:line:(\d+)$/.exec(id);

  if (lineAt !== null) {
    const at = Number(lineAt[1]);
    const line = lines(r, s)[at];

    if (line === undefined) return same(s);
    const focused = s.focus === 'page' && s.row === at;
    const next = { ...s, focus: 'page' as const, row: at, moved: true, mode: unedit(s) };
    // a button line acts at once (Add profile… not again while it is typed in); any other
    // focused line clicked again acts as ⏎ (its control acts on the first, `pressed`)
    const button =
      BUTTON_LINES.has(line.kind) && !(line.kind === 'add-profile' && addingOf(s) !== undefined);
    const again = focused && !left;

    return button || again ? change(r, next, line) : same(next);
  }

  // the page's empty room: an edit left (above), nothing else
  return same(s);
};

/** A click on a row's part: the row focused, then its control acts as a click on it does. */
const pressed = (r: SettingsDialogRules, s: SettingsState, at: number, part: Part): Out => {
  const line = lines(r, s)[at];

  if (line === undefined) return same(s);
  const next: SettingsState = { ...s, focus: 'page', row: at, moved: true };
  const e = editingOf(s);
  const mine = e !== undefined && editsLine(e, line);

  if (part.kind === 'press') {
    // its open combo, segments or themes clicked again close; a list or records editor stays
    if (mine)
      return same(
        e.kind === 'combo' || e.kind === 'segmented' || e.kind === 'themes'
          ? { ...next, mode: unedit(s) }
          : next,
      );

    return change(r, { ...next, mode: unedit(s) }, line);
  }
  const unedited: SettingsState = { ...next, mode: unedit(s) };

  if (line.kind !== 'setting') return same(unedited);
  if (line.listed?.fixed !== null) return change(r, unedited, line);
  const { row, listed } = line;

  if (part.kind === 'choice') {
    const picked: Editing =
      row.control === 'segmented'
        ? { kind: 'segmented', row: row.id, at: part.at }
        : { kind: 'themes', row: row.id, cursor: part.at };

    return editKey(r, { ...unedited, mode: editMode(picked) }, picked, '<CR>');
  }
  // a cell of records not open: open them, that cell typed in
  const opened = change(r, unedited, line);
  const o = editingOf(opened.state);
  const done =
    o?.kind === 'records'
      ? recordsClick(r, opened.state, o, `settings:cell:${part.row}:${part.col}`, row, listed)
      : undefined;

  return done === undefined
    ? opened
    : { state: done.state, commands: [...opened.commands, ...done.commands] };
};

/**
 * Choose…: the row's field (a list's new item) open for the folder the app's panel picks, which
 * it types in and ⏎s (Esc when the panel is cancelled).
 */
const browsed = (s: SettingsState, row: string, list: boolean): SettingsState =>
  list
    ? {
        ...s,
        mode: editMode({ kind: 'list', row, cursor: 0, field: { at: null, text: '' } }),
      }
    : { ...s, mode: editMode({ kind: 'field', row, text: '' }) };

// ---------------------------------------------------------------- answers

export const reply = (r: SettingsDialogRules, s: SettingsState, input: Input): Out => {
  if (input.kind !== 'result' || !input.id.startsWith('settings:')) return same(s);
  const what = input.id.split(':')[1];

  // a page's own read answered after the dialog closed: the next open reads it again
  if (!s.open && PAGE_READS.has(what ?? '')) return same(s);

  const p = proposingOf(s);

  if (p?.running === input.id) return proposed(s, p, input);
  if (what === 'checks') return checked(s, input);
  if (what === 'profiles') return profilesAnswered(s, input);
  if (what === 'local') return localAnswered(s, input);
  if (what === 'themes') return themesAnswered(s, input);
  if (what === 'colours') return coloursAnswered(r, s, input);
  if (what === 'save') return colourSaved(s, input);
  if (what === 'import') return imported(s, input);
  if (input.command === 'settings list') {
    const at = runOf(input.id);

    // an older read landing after a newer one (the full list before the quick one): dropped
    if (at < s.read.list) return same(s);
    if (!input.reply.ok) return same({ ...s, down: downOf(input.reply.error) });

    return coloursDue(
      clampRow(
        r,
        changesRead(
          { ...s, list: input.reply.data, down: undefined, read: { ...s.read, list: at } },
          input.id,
        ),
      ),
    );
  }
  if (input.command === 'settings problems') {
    const at = runOf(input.id);

    if (at < s.read.problems) return same({ ...s, holding: false });
    if (!input.reply.ok) return same({ ...s, holding: false });
    const problems = input.reply.data;
    const next: SettingsState = {
      ...s,
      problems,
      holding: false,
      read: { ...s.read, problems: at },
    };

    // Problems first: the answer the page waited for lands there while you have not moved (an
    // info row alone never lands it); a later one never moves the page under you (#297)
    if (s.holding && problemCount(next) > 0 && !s.moved && s.open && s.search === null)
      return same({ ...next, node: 'problems', row: 0 });
    // none left: off Problems, once the checks said so too (a files-only answer has not checked)
    const checked = problems.checked.logins || problems.checked.tools || s.holding;

    if (problems.problems.length === 0 && s.node === 'problems' && checked)
      return same({ ...next, node: FIRST_PAGE, row: 0 });

    return same(next);
  }
  if (input.command === 'settings explain' && what === 'explain') {
    const w = s.writing[input.id];

    if (w === undefined) return same(s);
    if (!input.reply.ok) return written(s, input.id, refusal(input.reply.error));
    const mine = input.reply.data.layers.find((l) => l.layer === 'individual')?.written;
    const whole = { ...(isRecord(mine) ? mine : {}), ...w.fields };
    const runs = s.runs + 1;
    const id = `settings:set:${runs}`;
    const rest = without(s.writing, input.id);

    return {
      state: { ...s, runs, writing: { ...rest, [id]: w } },
      commands: [{ kind: 'run', id, argv: setArgv(w, JSON.stringify(whole)) }],
    };
  }
  // a set's answer, or any write refused before it ran
  if (Object.hasOwn(s.writing, input.id))
    return written(s, input.id, input.reply.ok ? undefined : refusal(input.reply.error));

  return same(s);
};
