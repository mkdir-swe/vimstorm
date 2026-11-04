/**
 * Reading Claude Code's `/model` picker (#180), on screens Claude Code 2.1.310 drew in tmux
 * (`fixtures/model-picker/`, a session's rows from `sessionModelPicker`): which keys pick a
 * model for this session only, and what it said after.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  modelPicked,
  modelPickKeys,
  pickerFocus,
  pickerOpen,
  sessionModelPicker,
} from './model-pick';

const screen = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'model-picker', `${name}.txt`), 'utf8');

describe('the /model picker (#180)', () => {
  test("a session's rows: the allowed models by their own names, nothing built in", () => {
    expect(sessionModelPicker(['opus', 'sonnet'])).toEqual({
      replaceBuiltInOptions: true,
      options: [
        { model: 'opus', label: 'opus' },
        { model: 'sonnet', label: 'sonnet' },
      ],
    });
  });

  test('open with its "this session only" choice; not once it has answered', () => {
    expect(pickerOpen(screen('open'))).toBe(true);
    expect(pickerOpen(screen('again'))).toBe(true);
    expect(pickerOpen(screen('done'))).toBe(false);
    expect(pickerOpen('Select model\n  Enter to confirm · Esc to cancel')).toBe(false);
  });

  test.each([
    // focused on opus (row 2 of 4): haiku two down, sonnet one, opus none
    ['open', 'haiku', undefined, ['Down', 'Down', 's']],
    ['open', 'sonnet', undefined, ['Down', 's']],
    ['open', 'opus', undefined, ['s']],
    // focused on haiku, the last row: the rows wrap, Default first
    ['again', 'opus', undefined, ['Down', 'Down', 's']],
    ['again', 'sonnet', undefined, ['Down', 'Down', 'Down', 's']],
    // effort: down to low, then up to the one asked
    ['open', 'sonnet', 'low', ['Down', 'Left', 'Left', 'Left', 'Left', 's']],
    ['open', 'sonnet', 'high', ['Down', 'Left', 'Left', 'Left', 'Left', 'Right', 'Right', 's']],
    ['again', 'haiku', 'medium', ['Left', 'Left', 'Left', 'Left', 'Right', 's']],
  ] as const)('%s, %s at %s effort: %j', (name, model, effort, keys) => {
    expect(modelPickKeys(screen(name), { model, effort })).toEqual({
      ok: true,
      keys: [...keys],
      row: model,
    });
  });

  test('a model the picker has no row for is no key at all; a session launched before: its built-in label', () => {
    expect(modelPickKeys(screen('open'), { model: 'fable' })).toEqual({
      ok: false,
      reason: 'the /model picker has no fable row (Default (recommended), opus, sonnet, haiku)',
    });
    const builtIn = [
      'Select model',
      '  ❯ 1. Default (recommended)  Use the default model',
      '    2. Opus                   Opus 5.5 · Most capable',
      '    3. Sonnet ✔               Sonnet 5.5 · Everyday tasks',
      '  Enter to set as default · s to use this session only · Esc to cancel',
    ].join('\n');

    expect(modelPickKeys(builtIn, { model: 'sonnet' })).toEqual({
      ok: true,
      keys: ['Down', 'Down', 's'],
      row: 'Sonnet',
    });
  });

  test("the focused row's label, checked before s; none once the picker is gone", () => {
    expect(pickerFocus(screen('open'))).toBe('opus');
    expect(pickerFocus(screen('again'))).toBe('haiku');
    expect(pickerFocus(screen('done'))).toBeUndefined();
  });

  test('after the pick: "for this session only" is the switch, the last /model\'s answer only', () => {
    expect(modelPicked(screen('done'))).toEqual({
      kind: 'session',
      line: 'Set model to Opus 5.5 for this session only with high effort',
    });
    // the picker still open: the answer above it is an earlier one's
    expect(modelPicked(screen('again'))).toBeUndefined();
    expect(modelPicked('❯ /model\n\n────\n❯ ')).toBeUndefined();
    expect(
      modelPicked(
        '❯ /model\n  ⎿  Set model to Opus 5.5 and saved as your default for new sessions',
      ),
    ).toEqual({
      kind: 'saved',
      line: 'Set model to Opus 5.5 and saved as your default for new sessions',
    });
    expect(
      modelPicked('❯ /model\n  ⎿  Model switch to haiku was blocked by a PreModelSwitch hook'),
    ).toEqual({
      kind: 'other',
      line: 'Model switch to haiku was blocked by a PreModelSwitch hook',
    });
  });
});
