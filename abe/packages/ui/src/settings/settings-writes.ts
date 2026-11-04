/**
 * Settings' writes (#345 split of `settings.ts`): each change written to yours the moment it is made
 * with `abe settings set` (ADR 0030: an editor preference on this Mac, a factory setting for this
 * repo), `unset` for a reset; their answers, and ⌘Z's write of what a save changed.
 */
import { type SettingsDialogRules } from '@abe/core';
import { colourSave, coloursBack, coloursKey } from './settings-colours';

import { aboveOf, read, runOf, without } from './settings-rows';
import {
  type Change,
  type Out,
  type SettingsState,
  type Undo,
  type Write,
  same,
  status,
} from './settings-state';

/**
 * An `abe` argv with text a person typed: a flag's value inline (`--reason=…`), and the
 * positionals after `--` when one starts with `-`, so typed text is never read as a flag.
 */
export const cliArgv = (
  words: readonly string[],
  positionals: readonly string[],
  flags: readonly string[],
): string[] =>
  positionals.some((p) => p.startsWith('-'))
    ? [...words, ...flags, '--', ...positionals]
    : [...words, ...positionals, ...flags];

/**
 * No `--repo` or `--mine`: `settings set` writes yours, an editor or environment key on this Mac
 * and a factory key for this repo (ADR 0030).
 */
export const setArgv = (w: Write, typed: string) =>
  cliArgv(
    ['settings', 'set'],
    [w.key, typed],
    w.reason === undefined ? [] : ['--override', `--reason=${w.reason}`],
  );

/** A write's first command: `settings unset` for a reset, `set`, or a field's `explain` first. */
const writeArgv = (w: Write): string[] => {
  if (w.fields !== null) return ['settings', 'explain', w.key];

  return w.unset === true ? ['settings', 'unset', w.key] : setArgv(w, w.typed);
};

/** A change as its write: a field row's with every field of its key changed and not yet read back. */
const writeOf = (s: SettingsState, c: Change, undo: Undo | undefined): Write => {
  const then = undo === undefined ? {} : { undo };

  if (c.field === null)
    return {
      key: c.key,
      rows: [c.row],
      fields: null,
      typed: c.typed,
      reason: c.reason,
      ...(c.reset === true ? { unset: true } : {}),
      ...then,
    };
  // a field reset is left out of yours (`undefined` is no entry once written); the key's other
  // fields changed a moment ago go too, so two quick changes never write over each other
  const others = Object.values(s.changes).filter(
    (x) => x.key === c.key && x.field !== null && x.row !== c.row,
  );
  const fields = Object.fromEntries(
    [...others, c].map((x) => [x.field ?? '', x.reset === true ? undefined : x.value]),
  );

  return { key: c.key, rows: [c.row], fields, typed: '', ...then };
};

/** A change written at once: shown on its row until the rows read after it say it. */
export const writeChange = (s: SettingsState, c: Change, undo: Undo | undefined): Out => {
  const runs = s.runs + 1;
  const w = writeOf(s, c, undo);
  const id = `settings:${w.fields === null ? 'set' : 'explain'}:${runs}`;

  return {
    state: {
      ...s,
      runs,
      changes: { ...s.changes, [c.row]: c },
      writing: { ...s.writing, [id]: w },
      errors: without(s.errors, c.row),
    },
    commands: [{ kind: 'run', id, argv: writeArgv(w) }],
  };
};

/** Colours' changed tokens saved at once over the theme Colours edit (`abe theme save`). */
export const saveColours = (s: SettingsState, undo: Undo | undefined): Out => {
  const save = colourSave(s);

  if (save === undefined) return same(s);
  const runs = s.runs + 1;
  const id = `settings:save:${runs}`;
  const w: Write = {
    key: coloursKey(s),
    rows: [],
    fields: null,
    typed: '',
    ...(undo === undefined ? {} : { undo }),
  };

  return {
    state: { ...s, runs, writing: { ...s.writing, [id]: w } },
    // it writes what the dialog shows: over another theme of yours too (#177)
    commands: [
      {
        kind: 'run',
        id,
        argv: ['theme', 'save', save.slug, '--tokens', JSON.stringify(save.tokens), '--replace'],
      },
    ],
  };
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A write answered: saved, its change kept until the rows read now show it, ⌘Z offered; refused,
 * its change gone (the row back as it was) and the reason under the row, nothing saved.
 */
export const written = (s: SettingsState, id: string, refused: string | undefined): Out => {
  const w = s.writing[id];

  if (w === undefined) return same(s);
  const writing = without(s.writing, id);

  if (refused !== undefined) {
    const changes = Object.fromEntries(
      Object.entries(s.changes).filter(([row]) => !w.rows.includes(row)),
    );
    const errors = { ...s.errors, ...Object.fromEntries(w.rows.map((row) => [row, refused])) };

    return same({ ...s, writing, changes, errors });
  }
  const changes = Object.fromEntries(
    Object.entries(s.changes).map(([row, c]) => [
      row,
      w.rows.includes(row) ? { ...c, saved: s.runs } : c,
    ]),
  );
  const undo = w.undo === undefined ? s.undo : [...s.undo, w.undo];
  const next: SettingsState = { ...s, writing, changes, undo };

  // closed meanwhile: the next open reads the rows anyway
  if (!s.open) return same(next);
  const again = read(next, 'list');

  return {
    state: again.state,
    commands: [
      ...again.commands,
      status(w.undo === undefined ? 'Undone' : `Saved ${w.undo.label}`),
    ],
  };
};

/** The rows read again: the changes saved before that read go, the rows say them now. */
export const changesRead = (s: SettingsState, id: string): SettingsState => {
  const at = runOf(id);
  const changes = Object.fromEntries(
    Object.entries(s.changes).filter(([, c]) => c.saved === undefined || c.saved >= at),
  );

  return Object.keys(changes).length === Object.keys(s.changes).length ? s : { ...s, changes };
};

/** ⌘Z: the last save taken back, written at once as the change was. */
export const undoLast = (r: SettingsDialogRules, s: SettingsState): Out => {
  const last = s.undo.at(-1);

  if (last === undefined) return { state: s, commands: [status('Nothing to undo')] };
  const rest: SettingsState = { ...s, undo: s.undo.slice(0, -1) };
  const told = status(`Undoing ${last.label}`);

  if (last.kind === 'colours') {
    const back = saveColours(coloursBack(rest, last.changed), undefined);

    return { ...back, commands: [...back.commands, told] };
  }
  const listed = s.list?.rows.find((l) => l.id === last.row);
  const change: Change =
    'value' in last.before
      ? {
          row: last.row,
          key: last.key,
          field: last.field,
          typed: JSON.stringify(last.before.value ?? null),
          value: last.before.value,
        }
      : {
          row: last.row,
          key: last.key,
          field: last.field,
          typed: '',
          // what the Layers above give, as a reset shows it
          value: listed === undefined ? r.shown(undefined) : aboveOf(listed),
          reset: true,
        };
  const back = writeChange(rest, change, undefined);

  return { ...back, commands: [...back.commands, told] };
};
