/**
 * The Settings dialog (2.1 #108 S2): WebStorm's Settings over every view, a layer the bridge mounts
 * once beside Command mode (`serve/src/process/bridge.ts`), opened by ⌘, (the app's `open settings`) and
 * `:settings`. Its tree is core's catalogue; each page's rows are `abe settings list`'s, read each
 * time it opens with `abe settings problems` (the login and tool checks run then, never behind
 * your back). A change for you saves the moment it is made (`abe settings set` into your Layer),
 * ⌘Z (Undo) takes the last save back, a refused one says why under its row and saves nothing; Esc
 * or Close closes. `/` searches every page.
 *
 * `ui` imports only types from core: the catalogue and its rules come in as `SettingsDialogRules`
 * (`settingsDialogRules` of core, built by the bridge). Its own popups (the combo's list, ⌘⏎'s
 * propose popup) are in its tree, so a question never hides it. ⌘⏎ on
 * a row proposes it for the repo (S3, S-Propose): a value and a reason, then
 * `abe settings propose`, one pull request. A theme, density or font picked is live in every
 * window at once (the `look` command, `lookDue`) until the rows read it back (S4).
 *
 * This file is the step; its parts live per page in `settings-*.ts` (#345): `settings-state` (the
 * state and its one `Mode`), `-tree`, `-rows`, `-change`, `-list`, `-records`, `-logins`, `-import`,
 * `-colours`, `-profiles`, `-propose`, `-writes`, `-keys`, `-view`.
 */
import { type SettingsDialogRules } from '@abe/core';
import { type Input, type LayerScreen, type Word } from '../runtime/runtime';
import { colourFilter, colourTyped } from './settings-colours';
import { emptied, onClick, reply, searchTyped, selectKey } from './settings-keys';
import { readLocal } from './settings-local';
import { checksDue, fixEnded, fixLeft, sourcesChanged } from './settings-logins';
import { profilesChanged } from './settings-profiles';
import { proposeText } from './settings-propose';
import { lineKey, lines, lookDue, opened, read, readAll, results, without } from './settings-rows';
import {
  INIT,
  type Out,
  SETTINGS_SCREEN,
  type SettingsState,
  addMode,
  editMode,
  same,
} from './settings-state';
import { pageShown } from './settings-tree';
import { view } from './settings-view';
import { digitsOf, fieldTyped } from './settings-change';
import { listText } from './settings-list';
import { recordsText } from './settings-records';

// the screen's public names, wherever their part keeps them
export { SETTINGS_SCREEN, type Change, type SettingsState } from './settings-state';
export { type Line, type SettingLine, changedLook } from './settings-rows';
export { propose } from './settings-propose';
export { cliArgv } from './settings-writes';

// ---------------------------------------------------------------- the step

const stepSettings =
  (r: SettingsDialogRules) =>
  (s: SettingsState, input: Input): Out =>
    selectionKept(
      s,
      fixLetGo(
        s,
        lookDue(checksDue(r, fixLeft(r, s, rowKept(r, s, input, stepInput(r, s, input))))),
      ),
    );

/**
 * The focus is a row, never an index (#297): an answer that adds or drops rows above it (Logins
 * before Tools, a problem gone, a profile added) keeps the cursor on the row it was on. Keys and
 * clicks move it themselves; an answer that put the cursor somewhere itself is left alone.
 */
const rowKept = (r: SettingsDialogRules, before: SettingsState, input: Input, out: Out): Out => {
  const s = out.state;

  if (
    input.kind === 'key' ||
    input.kind === 'click' ||
    input.kind === 'open' ||
    input.kind === 'text'
  )
    return out;
  // a list answer moves the cursor only to keep it on the page (`clampRow`): it still follows its row (#325)
  const clamped = input.kind === 'result' && input.command === 'settings list';

  if (!before.open || !s.open || (s.row !== before.row && !clamped)) return out;
  if (
    results(before) !== results(s) ||
    (results(s) === undefined && pageShown(r, before) !== pageShown(r, s))
  )
    return out;
  const was = lines(r, before)[before.row];

  if (was === undefined) return out;
  const key = lineKey(was);
  const now = lines(r, s);

  const cur = now[s.row];

  if (cur !== undefined && lineKey(cur) === key) return out;
  const at = now.findIndex((l) => lineKey(l) === key);

  return at < 0 ? out : { ...out, state: { ...s, row: at } };
};

/** Which field has the caret (`''`: none): ⌘A's selection is that field's. */
const caretField = (s: SettingsState): string => {
  const m = s.mode;

  if (m?.kind === 'propose') return `propose:${m.propose.focus}`;
  if (m?.kind === 'edit') return `edit:${m.edit.kind}:${m.edit.row}`;
  if (m !== undefined) return '';

  return s.focus === 'search' ? 'search' : '';
};

/** ⌘A's selection goes when the caret moves to another field (an answer, a click, a key). */
const selectionKept = (before: SettingsState, out: Out): Out =>
  out.state.all && caretField(out.state) !== caretField(before)
    ? { ...out, state: { ...out.state, all: false } }
    : out;

/**
 * The fix strip gone (the dialog closed with Esc or Close, or the strip dropped): its
 * terminal is let go at once, never left running unseen.
 */
const fixLetGo = (before: SettingsState, out: Out): Out => {
  const key = before.fix?.key;

  if (key === undefined || out.state.fix?.key === key) return out;
  const told = out.commands.some(
    (c) => c.kind === 'shell' && c.effect.kind === 'drop-terminal' && c.effect.key === key,
  );

  return told
    ? out
    : {
        ...out,
        commands: [...out.commands, { kind: 'shell', effect: { kind: 'drop-terminal', key } }],
      };
};

const stepInput = (r: SettingsDialogRules, s: SettingsState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return opened(r, s, input.params);
    case 'key':
      return s.open ? selectKey(r, s, input.key) : same(s);
    case 'text':
      if (!s.open) return same(s);

      return typedText(r, { ...(s.all ? (emptied(s) ?? s) : s), all: false }, input.text);
    case 'click':
      return s.open ? onClick(r, { ...s, all: false }, input.id) : same(s);
    case 'result':
      return reply(r, s, input);
    case 'event':
      // a write anywhere, or serve back after a break: read the rows again while open
      if (!s.open) return same(s);
      if (input.event.type === 'settings.changed') return localAgain(read(s, 'list'));
      if (input.event.type === 'serve.started' && s.down !== undefined) return readAll(s);
      if (input.event.type === 'sources.changed') return sourcesChanged(s, input.event.data);
      if (input.event.type === 'browser.profile') return profilesChanged(s);

      return same(s);
    case 'root':
      // another checkout: its local mode is read again with the rest
      return s.open ? readAll({ ...s, local: undefined }) : same(s);
    case 'exit':
      return fixEnded(s, input.key, input.code);
    // the dialog is modal: it stays when the keyboard goes (a ⌘ key, another window)
    default:
      return same(s);
  }
};

/** A write anywhere (`abe local on` in a terminal too): the checkbox read again once read. */
const localAgain = (out: Out): Out => {
  const l = out.state.local;

  if (l?.data === undefined || l.running === true) return out;
  const again = readLocal(out.state);

  return { state: again.state, commands: [...out.commands, ...again.commands] };
};

/** Typed (or pasted) text: into the field with the caret. */
const typedText = (r: SettingsDialogRules, s: SettingsState, text: string): Out => {
  const m = s.mode;

  if (m?.kind === 'propose') return proposeText(s, m.propose, text);
  if (m?.kind === 'add')
    return same({ ...s, mode: addMode({ ...m.add, text: m.add.text + text }) });
  const e = m?.kind === 'edit' ? m.edit : undefined;

  if (e?.kind === 'colours-filter') {
    const typed = e.text + text;

    return same(colourFilter({ ...s, mode: editMode({ ...e, text: typed }) }, typed));
  }
  if (e?.kind === 'token') return colourTyped(s, e, e.text + text);
  if (e?.kind === 'records') return same(recordsText(s, e, text));
  // pasted into a combo's filter: as typed, the cursor on the first choice left
  if (e?.kind === 'combo')
    return same({ ...s, mode: editMode({ ...e, filter: e.filter + text, cursor: 0 }) });
  if (e?.kind === 'list') {
    const numbers = s.list?.rows.some((l) => l.id === e.row && l.item === 'number') === true;

    return same(listText(s, e, text, numbers));
  }
  if (e?.kind === 'field') {
    const id = e.row;
    const line = lines(r, s).find((l) => l.kind === 'setting' && l.row.id === id);
    const number = line?.kind === 'setting' && line.row.control === 'number';
    const typed = e.text + (number ? digitsOf(text) : text);

    return same(
      line?.kind === 'setting'
        ? fieldTyped(r, s, line.row, e, typed)
        : { ...s, mode: editMode({ ...e, text: typed }), errors: without(s.errors, id) },
    );
  }
  if (e?.kind === 'reason') return same({ ...s, mode: editMode({ ...e, text: e.text + text }) });
  if (s.focus === 'search') return same(searchTyped(s, (s.search ?? '') + text));

  return same(s);
};

/** The Settings dialog as the bridge mounts it, with core's rules. */
export const settingsLayer = (rules: SettingsDialogRules): LayerScreen<SettingsState> => ({
  name: SETTINGS_SCREEN,
  init: INIT,
  step: stepSettings(rules),
  view: (s) => view(rules, s),
});

/** `:settings`: the dialog from Command mode, on any view. */
export const SETTINGS_WORD: Word = {
  word: 'settings',
  summary: 'Settings: every setting, where its value comes from, changed for you or proposed',
  commands: [{ kind: 'open', screen: SETTINGS_SCREEN }],
};
