/**
 * Switching a running session's model and effort without touching the person's own Claude Code
 * settings (#180). Claude Code 2.1.310's `/model <name>` and `/effort <level>` save what they set
 * as the default for new sessions: `model` and `effortLevel` in `~/.claude/settings.json`, every
 * plain `claude` the person starts afterwards on the model last picked in Chat. Its `/model`
 * picker has a choice that does not: `s`, "use this session only" (the model, and the effort its
 * ←/→ set, for this session, nothing saved).
 *
 * So `abe session model` opens the picker (`/model` alone) and picks with keys: down to the row
 * of the model (the picker's rows wrap), ←/→ for the effort, then `s`. A session's settings give
 * the picker its rows (`sessionModelPicker`): the Default row, then each allowed model under its
 * own name, so a row is found by the model's name on the screen. This module reads the screen
 * (tmux's capture of the pane) and says which keys to press, and whether the switch was made.
 */
import { EFFORTS } from '../layer/settings';

/** Claude Code's `modelPicker` setting: the rows `/model` shows. */
export type ModelPicker = {
  /** Only the Default row and these: no built-in lineup. */
  replaceBuiltInOptions: boolean;
  options: { model: string; label: string }[];
};

/** A session's `/model` picker: Default, then each model of its `allowedModels` by its name. */
export const sessionModelPicker = (allowed: readonly string[]): ModelPicker => ({
  replaceBuiltInOptions: true,
  options: allowed.map((model) => ({ model, label: model })),
});

/** The keys the picker is driven with, as tmux's `send-keys` names them. */
export type PickerKey = 'Down' | 'Left' | 'Right' | 's' | 'Escape';

/** ← presses that reach the lowest effort from any: Claude Code's levels are low … xhigh, max. */
const LEFTS = 4;
/** The line under the picker that has its "this session only" choice. */
const SESSION_ONLY = 's to use this session only';
/** A row: `❯ 2. opus ✔   Custom model (opus)`, the focused one with `❯`, the current one `✔`. */
const ROW = /^\s*(❯)?\s*(\d+)\.\s+(.+?)(?:\s+✔)?(?:\s{2,}.*)?$/;

/** Whether Claude Code's `/model` picker is on the screen, with its "this session only" choice. */
export const pickerOpen = (screen: string): boolean =>
  screen.includes('Select model') && screen.includes(SESSION_ONLY);

type Row = { n: number; label: string; focused: boolean };

const rowsOf = (screen: string): Row[] => {
  const lines = screen.split('\n');
  const start = lines.findLastIndex((l) => l.trim() === 'Select model');
  const rows: Row[] = [];

  for (const line of lines.slice(start + 1)) {
    if (line.includes(SESSION_ONLY)) break;
    const m = ROW.exec(line);

    if (m !== null) rows.push({ n: Number(m[2]), label: (m[3] ?? '').trim(), focused: !!m[1] });
  }

  return rows;
};

/**
 * The keys that pick `model` for this session only in the open picker: Down from the focused
 * row to the model's (the rows wrap), ← to the lowest effort and → up to `effort` (low, medium,
 * high are every model's first three; a model without effort ignores them), then `s`.
 */
export const modelPickKeys = (
  screen: string,
  want: { model: string; effort?: (typeof EFFORTS)[number] | undefined },
): { ok: true; keys: PickerKey[]; row: string } | { ok: false; reason: string } => {
  const rows = rowsOf(screen);
  const focused = rows.findIndex((r) => r.focused);
  // Its own row by name; a session launched before its rows were given: the built-in label.
  const exact = rows.findIndex((r) => r.label === want.model);
  const target =
    exact !== -1
      ? exact
      : rows.findIndex((r) => r.label.toLowerCase() === want.model.toLowerCase());

  if (focused === -1) return { ok: false, reason: 'the /model picker shows no focused row' };
  if (target === -1)
    return {
      ok: false,
      reason: `the /model picker has no ${want.model} row (${rows.map((r) => r.label).join(', ') || 'no rows'})`,
    };
  const down = (target - focused + rows.length) % rows.length;
  const effort =
    want.effort === undefined
      ? []
      : [
          ...Array<PickerKey>(LEFTS).fill('Left'),
          ...Array<PickerKey>(EFFORTS.indexOf(want.effort)).fill('Right'),
        ];

  return {
    ok: true,
    keys: [...Array<PickerKey>(down).fill('Down'), ...effort, 's'],
    row: rows[target]?.label ?? want.model,
  };
};

/** The label of the picker's focused row: checked before `s`, a key lost on the way never picks. */
export const pickerFocus = (screen: string): string | undefined =>
  pickerOpen(screen) ? rowsOf(screen).find((r) => r.focused)?.label : undefined;

/**
 * What Claude Code said to the last `/model` on the screen, once its picker is gone: `session`
 * for "Set model to … for this session only", `saved` when it saved it as the default after all,
 * `other` for anything else it answered (a hook that blocked it). Undefined while the picker is
 * open or nothing is said yet.
 */
export const modelPicked = (
  screen: string,
): { kind: 'session' | 'saved' | 'other'; line: string } | undefined => {
  if (pickerOpen(screen)) return undefined;
  const lines = screen.split('\n');
  const typed = lines.findLastIndex((l) => l.trim() === '❯ /model');

  if (typed === -1) return undefined;
  const said = lines
    .slice(typed + 1)
    .map((l) => l.trim())
    .find((l) => l.startsWith('⎿'));

  if (said === undefined) return undefined;
  const line = said.replace(/^⎿\s*/, '');

  if (line.startsWith('Set model to') && line.includes('for this session only'))
    return { kind: 'session', line };
  if (line.includes('saved as your default')) return { kind: 'saved', line };

  return { kind: 'other', line };
};
