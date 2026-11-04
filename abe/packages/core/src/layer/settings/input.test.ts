/** A setting's input by its schema, where a change of yours goes, and its default in a row. */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { type SettingKey } from './keys';
import {
  controlFits,
  defaultOf,
  inputOf,
  itemInputOf,
  schemaInput,
  scopeOfKey,
  takesNone,
  type SettingInput,
  type SettingScope,
} from './input';

describe('the input a setting takes', () => {
  // key, field, its input, a list's items', its scope, its default
  const ROWS: readonly [
    SettingKey,
    string | null,
    SettingInput,
    SettingInput | undefined,
    SettingScope,
    unknown,
  ][] = [
    ['ui.font.ligatures', null, 'toggle', undefined, 'yours', false],
    ['ui.density', null, 'choice', undefined, 'yours', 'compact'],
    ['ui.font.size', null, 'number', undefined, 'yours', 13],
    ['tabs.limit', null, 'number', undefined, 'yours', 10],
    ['models.coordinator', null, 'text', undefined, 'local', 'opus'],
    ['testFiles', null, 'list', 'text', 'local', ['*.test.*', '*.spec.*', 'test/', 'tests/']],
    ['ports.fixed', null, 'list', 'number', 'local', []],
    ['localMode', null, 'list', 'text', 'yours', []],
    ['environments', null, 'object', undefined, 'local', {}],
    ['views', null, 'list', 'object', 'yours', []],
    ['board', 'done', 'text', undefined, 'local', undefined],
    ['board', 'types', 'list', 'text', 'local', undefined],
    ['agents.prod', null, 'toggle', undefined, 'local', false],
  ];

  test.each(ROWS)('%s %p', (key, field, input, item, scope, value) => {
    expect({
      input: inputOf(key, field),
      item: itemInputOf(key, field),
      scope: scopeOfKey(key),
      value: defaultOf(key, field),
    }).toEqual({ input, item, scope, value });
  });

  test('wrappers are seen through; a name or an entry is typed as its name', () => {
    expect(schemaInput(z.boolean().nullable().optional())).toBe('toggle');
    expect(schemaInput(z.enum(['a', 'b']).default('a'))).toBe('choice');
    expect(schemaInput(z.union([z.string(), z.object({ name: z.string() })]))).toBe('text');
    expect(schemaInput(z.record(z.string(), z.number()))).toBe('object');
  });

  test.each<[SettingKey, string | null, boolean]>([
    ['box.profile', null, true],
    ['tabs.limit', null, true],
    ['ui.density', null, false],
    ['board', 'organization', true],
    ['factory.done', null, false],
  ])('%s %p takes none: %p', (key, field, none) => {
    expect(takesNone(key, field)).toBe(none);
  });

  test('a control fits its input: never a free field for a number, never JSON for a boolean', () => {
    expect(controlFits('checkbox', 'toggle')).toBe(true);
    expect(controlFits('text', 'number')).toBe(false);
    expect(controlFits('advanced', 'toggle')).toBe(false);
    expect(controlFits('chips', 'list')).toBe(true);
    expect(controlFits('advanced', 'object')).toBe(true);
    expect(controlFits('records', 'object')).toBe(true);
    expect(controlFits('records', 'list')).toBe(true);
  });
});
