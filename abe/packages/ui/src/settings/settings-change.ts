/**
 * The Settings dialog's changes (#345 split of `settings.ts`): ⏎ on a row changes it for you, saved
 * at once (an Override's reason asked in place, a refusal under the row), a combo / segmented /
 * field / records editor opened, Problems' ways out.
 */
import {
  type ListedRow,
  type RowLink,
  type SettingKey,
  type SettingRow as CatalogueRow,
  type SettingsDialogRules,
  type SettingsProblem,
} from '@abe/core';
import { colourChange, coloursKey, foldTokens, resetColours, themeRows } from './settings-colours';
import { readImport, runImport, tickImport } from './settings-import';
import { localPressed } from './settings-local';
import { checkPressed, problemFixId, runFix } from './settings-logins';
import { openProfile } from './settings-profiles';
import { listKey, openList } from './settings-list';
import { openRecords, recordsKey } from './settings-records';

import {
  type Line,
  aboveOf,
  changeOf,
  choicesOf,
  feelGives,
  homeRowOf,
  isRow,
  listedOf,
  pageLines,
  sameValue,
  shownOf,
  typedOf,
  valueOf,
  valueShown,
  withSchemes,
  without,
  closed,
  greyedOf,
  wordOf,
  lines,
  type SettingLine,
} from './settings-rows';
import {
  FEEL_KEY,
  type Out,
  type SettingsState,
  type Change,
  type Undo,
  THEME_KEY,
  addMode,
  editMode,
  plural,
  same,
  status,
  unedit,
  edited,
  typedChar,
  type Editing,
  DOWN,
  LEFT,
  RIGHT,
  UP,
} from './settings-state';
import { nodeOfPage, pick } from './settings-tree';
import { type ListMove, menuMove, movedRow, PAGE_ROWS } from '../runtime/list-moves';
import { type Command } from '../runtime/runtime';
import { writeChange } from './settings-writes';

/** What `abe settings set` / `propose` get for a value read: emptied to no value is `null` (#298). */
export const cliTyped = (value: unknown, typed: string): string =>
  value === null && typed.trim() === '' ? 'null' : typed;

/** What a row's value was before a save: yours, or none of yours (⌘Z then takes yours out). */
const beforeOf = (
  s: SettingsState,
  row: CatalogueRow,
  key: SettingKey,
  listed: ListedRow,
): Undo => {
  const was = s.changes[row.id];
  const yours = listed.source.kind === 'yours';
  const before: Extract<Undo, { kind: 'setting' }>['before'] =
    // a change not read back yet is what the row holds now
    (was === undefined ? !yours : was.reset === true)
      ? { unset: true }
      : { value: was === undefined ? (listed.value ?? undefined) : was.value };

  return {
    kind: 'setting',
    row: row.id,
    key,
    field: row.field,
    label: row.label,
    before,
  };
};

/**
 * A value for a row, saved at once (`abe settings set`): checked first as the CLI reads it, a
 * refusal under the row and nothing written (#298); an Override's reason asked in place when the
 * change lowers an upper value.
 */
export const save = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow,
  typed: string,
): Out => {
  const key = row.key;

  if (key === null) return same(s);
  const id = row.id;
  const changed = Object.keys(s.colours?.changed ?? {}).length;

  // the theme Colours edit is not picked away from under their changes being saved (#345)
  if (key === coloursKey(s) && changed > 0 && Object.keys(s.writing).length > 0)
    return {
      state: { ...s, mode: unedit(s) },
      commands: [
        status(
          `${plural(changed, 'colour')} being saved over ${s.colours?.data?.theme.name ?? 'the theme'}: pick again once saved`,
        ),
      ],
    };
  // none picked in a field row's combo: the field left out of yours
  const got =
    typed === '' && row.field !== null && row.clearable
      ? { ok: true as const, value: undefined }
      : r.read(key, typed, row.field ?? undefined);

  // refused: the field stays open with what was typed, the words under it (#298)
  if (!got.ok) return same({ ...s, errors: { ...s.errors, [id]: got.message } });
  const errors = without(s.errors, id);
  // the value the row shows already: nothing to write
  if (sameValue(got.value, valueOf(s, row, listed))) return same({ ...s, errors, mode: unedit(s) });
  const c: Change = {
    row: id,
    key,
    field: row.field,
    typed: cliTyped(got.value, typed),
    value: got.value,
    ...(key === FEEL_KEY && typeof got.value === 'string'
      ? { brings: r.feelBrings(got.value) }
      : {}),
  };
  const why = row.field === null ? r.needsOverride(key, aboveOf(listed), got.value) : undefined;

  if (why !== undefined)
    return same({ ...s, errors, mode: editMode({ kind: 'reason', row: id, text: '', change: c }) });

  return writeChange({ ...s, errors, mode: unedit(s) }, c, beforeOf(s, row, key, listed));
};

/** A row yours sets: ⌫ (or its Reset) takes yours out, the Layers above give it again. */
export const resettable = (row: CatalogueRow, listed: ListedRow | undefined): boolean =>
  row.key !== null && row.link === null && listed?.fixed === null && listed.source.kind === 'yours';

/** Reset to default: yours taken out at once (`abe settings unset`), the value above shown. */
export const reset = (s: SettingsState, row: CatalogueRow, listed: ListedRow | undefined): Out => {
  const key = row.key;

  if (key === null || listed === undefined || !resettable(row, listed))
    return { state: s, commands: [status(`${row.label}: nothing of yours to reset`)] };
  const c: Change = {
    row: row.id,
    key,
    field: row.field,
    typed: '',
    value: aboveOf(listed),
    reset: true,
  };

  return writeChange({ ...s, mode: unedit(s) }, c, beforeOf(s, row, key, listed));
};

/** ⏎ on a setting: a checkbox flips, a combo opens, a field takes the caret (a fixed one says why). */
export const change = (r: SettingsDialogRules, s: SettingsState, line: Line): Out => {
  if (line.kind === 'page-hit')
    return same({ ...pick(s, nodeOfPage(r, line.page)), focus: 'page', row: 0 });
  if (line.kind === 'problem') return wayOut(r, s, line.problem);
  if (line.kind === 'check') return checkPressed(s, line.item);
  if (line.kind === 'profile') return openProfile(s, line.profile);
  if (line.kind === 'import-source') return readImport(s, line.source);
  if (line.kind === 'import-row') return same(tickImport(s, line.row));
  if (line.kind === 'import-go') return runImport(s);
  if (line.kind === 'add-profile') return same({ ...s, mode: addMode({ name: null, text: '' }) });
  if (line.kind === 'token-group')
    return same(foldTokens(r, s, line.group.group, !s.tokensOpen.includes(line.group.group)));
  if (line.kind === 'colours-filter' || line.kind === 'token')
    return colourChange(s, line) ?? same(s);
  if (line.kind === 'colours-reset') return resetColours(s);
  if (line.kind === 'local') return localPressed(s);
  const { row, listed } = line;

  if (row.link !== null) return goTo(r, s, row.link);
  if (listed === undefined) return same(s);
  if (listed.fixed !== null)
    return {
      state: s,
      commands: [status(`${row.label} is fixed: ${listed.fixed.why}`)],
    };
  const id = row.id;

  switch (row.control) {
    case 'checkbox':
      return save(r, s, row, listed, valueOf(s, row, listed) === true ? 'false' : 'true');
    case 'combo': {
      const v = valueOf(s, row, listed);
      const now = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
      const at = comboChoices(row, listed, '').findIndex((c) => c.choice === now);

      return same({
        ...s,
        mode: editMode({ kind: 'combo', row: id, cursor: Math.max(0, at), filter: '' }),
      });
    }
    case 'segmented': {
      const at = choicesOf(row, listed).indexOf(shownOf(r, s, row, listed));

      return same({ ...s, mode: editMode({ kind: 'segmented', row: id, at: Math.max(0, at) }) });
    }
    case 'text':
    case 'number':
    case 'path':
    case 'advanced':
      return same({
        ...s,
        mode: editMode({ kind: 'field', row: id, text: typedOf(r, s, row, listed) }),
      });
    // a secret is typed anew, never shown back
    case 'secret':
      return same({ ...s, mode: editMode({ kind: 'field', row: id, text: '' }) });
    case 'chips':
      return same(openList(s, row));
    case 'records':
      return same(openRecords(r, s, row, listed));
    case 'preview': {
      if (row.key === THEME_KEY && themeRows(s).length > 0) {
        const at = themeRows(s).findIndex((t) => t.slug === shownSlug(s, row, listed));

        return same({ ...s, mode: editMode({ kind: 'themes', row: id, cursor: Math.max(0, at) }) });
      }

      return {
        state: s,
        commands: [status(`${row.label} is changed on its own page, not here yet`)],
      };
    }
    case 'table':
    case 'link':
      return {
        state: s,
        commands: [status(`${row.label} is changed on its own page, not here yet`)],
      };
  }
};

/** ⏎ on a link row (#345): its home row's page, the cursor on that row. */
const goTo = (r: SettingsDialogRules, s: SettingsState, link: RowLink): Out => {
  const next: SettingsState = { ...pick(s, nodeOfPage(r, link.page)), focus: 'page' };
  const at = pageLines(r, next, link.page).findIndex((l) => isRow(l, link.row));

  return same({ ...next, row: Math.max(0, at) });
};

/** A link row's value (#345): its settings' values as their home rows show them, changes too. */
export const linkText = (r: SettingsDialogRules, s: SettingsState, link: RowLink): string =>
  link.keys
    .map((key) => {
      const found = homeRowOf(r, key);

      if (found === undefined) return '';
      const home = withSchemes(s, found);
      const listed = listedOf(s, home);

      if (listed === undefined && changeOf(s, home) === undefined) return '…';

      return valueShown(r, home, valueOf(s, home, listed));
    })
    .filter((w) => w !== '')
    .join(' ');

/** The theme a row shows: changed, else in force. */
export const shownSlug = (s: SettingsState, row: CatalogueRow, listed: ListedRow): string => {
  const v = changeOf(s, row)?.value ?? feelGives(s, row.key, listed)?.value ?? listed.value;

  return typeof v === 'string' ? v : '';
};

/** A problem's way out: its fix (typed into the fix strip in S6; said here), or its row. */
export const wayOut = (r: SettingsDialogRules, s: SettingsState, p: SettingsProblem): Out => {
  if (p.way.kind === 'fix') {
    const item = problemFixId(p, p.way.command);
    const f = s.fix;

    if (f?.item === item && f.state === 'queued') return runFix(s, f);
    if (f?.state === 'running')
      return { state: s, commands: [status(`A fix is running: ${f.command}`)] };
    // `Logins & tools › AWS SSO · sso-session abe` names it AWS SSO
    const label = /› ([^·]+?) ·/.exec(p.where)?.[1] ?? p.text;

    return same({ ...s, fix: { item, label, command: p.way.command, state: 'queued' } });
  }
  if (p.way.kind === 'file') {
    const saving = Object.keys(s.writing).length;
    const effect: Command = { kind: 'shell', effect: { kind: 'open-file', path: p.way.path } };

    // the file is edited in the Editor: the dialog goes, never over changes not written
    return saving > 0
      ? {
          state: s,
          commands: [
            status(`${plural(saving, 'change')} still saving: open ${p.way.path} once saved`),
          ],
        }
      : { state: closed(s), commands: [effect] };
  }
  const way = p.way;
  const at: SettingsState = {
    ...s,
    node: nodeOfPage(r, way.page),
    focus: 'page',
    row: 0,
    moved: true,
  };
  const row = way.row;

  if (row === null) return same(at);
  const ix = pageLines(r, at, way.page).findIndex((l) => isRow(l, row));

  return same({ ...at, row: Math.max(0, ix) });
};

/** The rows of the open combo's list as filtered: each choice with its index and why it is grey. */
export const comboChoices = (
  row: CatalogueRow,
  listed: ListedRow | undefined,
  filter: string,
): ComboPick[] => {
  const all = [...(row.clearable ? [''] : []), ...choicesOf(row, listed)];
  const f = filter.toLowerCase();
  const shown: ComboPick[] = all
    // by what the list shows: a choice in words is found by its words (#325)
    .filter((c) => comboWords(row, c).toLowerCase().includes(f))
    .map((choice) => ({ choice, greyed: greyedOf(listed, choice) }));
  const typed = filter.trim();

  // a free combo takes a name its list lacks, as typed, last
  if (row.free && typed !== '' && !all.some((c) => c.toLowerCase() === typed.toLowerCase()))
    shown.push({ choice: typed, greyed: undefined, typed: true });

  return shown;
};

/** One choice of an open combo: `typed` a free combo's name typed, not one of its list. */
export type ComboPick = { choice: string; greyed: string | undefined; typed?: true };

/** No value as a combo says it: `none · the default profile`. */
export const noneWords = (row: Pick<CatalogueRow, 'none'>): string =>
  row.none === null ? 'none' : `none · ${row.none}`;

/** A combo's choice as its list says it: none's words for no value, else the choice's. */
export const comboWords = (row: Pick<CatalogueRow, 'none' | 'words'>, choice: string): string =>
  choice === '' ? noneWords(row) : wordOf(row, choice);

/** The next selectable choice from `at` by `by` (greyed ones passed over), or `at`. */
const nextChoice = (choices: { greyed: string | undefined }[], at: number, by: number) => {
  for (let i = at + by; i >= 0 && i < choices.length; i += by)
    if (choices[i]?.greyed === undefined) return i;

  return at;
};

/** A combo's choice after a move (every menu's, `list-moves.ts`, #334), over greyed ones. */
const choiceMoved = (choices: { greyed: string | undefined }[], at: number, m: ListMove) => {
  if (m.kind === 'by' && Math.abs(m.rows) === 1) return nextChoice(choices, at, m.rows);
  const to = movedRow(m, at, choices.length);

  if (choices[to]?.greyed === undefined) return to;
  // a greyed one there: the nearest choice back toward where the cursor was
  const back = nextChoice(choices, to, to <= at ? 1 : -1);

  return back === to ? at : back;
};

const lineOfRow = (r: SettingsDialogRules, s: SettingsState, id: string) =>
  lines(r, s).find((l): l is SettingLine => l.kind === 'setting' && l.row.id === id);

/** A key while a control is open in place. */
export const editKey = (r: SettingsDialogRules, s: SettingsState, e: Editing, key: string): Out => {
  const line = lineOfRow(r, s, e.row);

  // Esc puts the value back: a refusal's words go with what was typed (#298)
  if (key === '<Esc>')
    return same({
      ...s,
      mode: unedit(s),
      errors: e.kind === 'field' ? without(s.errors, e.row) : s.errors,
    });
  if (line?.listed === undefined) return same({ ...s, mode: unedit(s) });
  const { row, listed } = line;

  switch (e.kind) {
    case 'combo': {
      const shown = comboChoices(row, listed, e.filter);

      const m = menuMove(key, PAGE_ROWS);

      if (m !== undefined)
        return same({ ...s, mode: editMode({ ...e, cursor: choiceMoved(shown, e.cursor, m) }) });
      if (key === '<CR>') {
        const picked = shown[e.cursor];

        if (picked === undefined || picked.greyed !== undefined) return same(s);
        const out = save(r, s, row, listed, picked.choice);

        // refused: the list closes so its reason shows under the row, nothing saved
        return out.state.errors[row.id] === undefined
          ? out
          : { ...out, state: { ...out.state, mode: unedit(out.state) } };
      }
      if (key === '<BS>')
        return same({ ...s, mode: editMode({ ...e, filter: e.filter.slice(0, -1), cursor: 0 }) });
      const c = typedChar(key);

      if (c === undefined) return same(s);
      const filter = e.filter + c;
      const left = comboChoices(row, listed, filter);

      return same({
        ...s,
        mode: editMode({ ...e, filter, cursor: Math.max(0, nextChoice(left, -1, 1)) }),
      });
    }
    case 'segmented': {
      const choices = choicesOf(row, listed);

      if (LEFT.has(key) || RIGHT.has(key)) {
        const at = Math.max(0, Math.min(choices.length - 1, e.at + (LEFT.has(key) ? -1 : 1)));

        return same({ ...s, mode: editMode({ ...e, at }) });
      }
      if (key === '<CR>') {
        const choice = choices[e.at];

        return choice === undefined ? same(s) : save(r, s, row, listed, choice);
      }

      return same(s);
    }
    case 'themes': {
      const themes = themeRows(s);

      if (LEFT.has(key) || RIGHT.has(key) || UP.has(key) || DOWN.has(key)) {
        const back = LEFT.has(key) || UP.has(key);
        const cursor = Math.max(0, Math.min(themes.length - 1, e.cursor + (back ? -1 : 1)));

        return same({ ...s, mode: editMode({ ...e, cursor }) });
      }
      if (key === '<CR>') {
        const theme = themes[e.cursor];

        return theme === undefined ? same(s) : save(r, s, row, listed, theme.slug);
      }

      return same(s);
    }
    case 'list':
      return listKey(r, s, e, key, row, listed);
    case 'records':
      return recordsKey(r, s, e, key, row, listed);
    // Colours' fields take their keys before this (`colourEditKey`)
    case 'colours-filter':
    case 'token':
      return same(s);
    case 'field': {
      if (key === '<CR>') return save(r, s, row, listed, e.text);
      const text = row.control === 'number' ? numberEdited(e.text, key) : edited(e.text, key);

      return same(fieldTyped(r, s, row, e, text));
    }
    case 'reason': {
      if (key === '<CR>') {
        const reason = e.text.trim();

        if (reason === '')
          return same({
            ...s,
            mode: editMode({ ...e, error: 'An Override needs its reason (override-needs-reason)' }),
          });
        return writeChange(
          { ...s, mode: unedit(s) },
          { ...e.change, reason },
          beforeOf(s, row, e.change.key, listed),
        );
      }

      return same({ ...s, mode: editMode({ ...e, text: edited(e.text, key), error: undefined }) });
    }
  }
};

/**
 * A field's text changed: checked as typed, its reason under it at once (never written while it
 * stands); empty says nothing until ⏎.
 */
export const fieldTyped = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  e: Extract<Editing, { kind: 'field' }>,
  text: string,
): SettingsState => {
  const next = { ...s, mode: editMode({ ...e, text }) };

  if (text === e.text) return next;
  if (row.key === null || text.trim() === '') return { ...next, errors: without(s.errors, e.row) };
  const got = r.read(row.key, text, row.field ?? undefined);

  return {
    ...next,
    errors: got.ok ? without(s.errors, e.row) : { ...s.errors, [e.row]: got.message },
  };
};

/**
 * A number field's keys (#345): digits alone are typed; l / ↑ add one, ö / ↓ take one off (an
 * empty field starts from 0), as WebStorm's spinner without its arrows.
 */
const numberEdited = (text: string, key: string): string => {
  const step = (UP.has(key) ? 1 : 0) - (DOWN.has(key) ? 1 : 0);

  if (step !== 0) {
    const n = Number(text.trim() === '' ? '0' : text);

    return Number.isFinite(n) ? String(Math.max(0, Math.round(n) + step)) : text;
  }
  const c = typedChar(key);

  return c !== undefined && !/^[0-9]$/.test(c) ? text : edited(text, key);
};

/** Text typed into a number field: its digits alone. */
export const digitsOf = (text: string) => text.replace(/[^0-9]/g, '');
