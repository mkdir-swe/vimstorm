/** The Keymap catalogue (#129): keys read from each source, keys.json, the bindings the shell gets. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chordOfText,
  chordText,
  jetbrainsKey,
  KEYMAP_ACTIONS,
  keyBinds,
  nvimKeys,
  vimKey,
  vscodeKey,
  WINDOW_KEYS,
} from './keymap';

const text = (k: ReturnType<typeof vscodeKey> | undefined) => {
  if (k === undefined) return 'none';

  return 'none' in k ? k.none : chordText(k.chord);
};

describe('keys from each source', () => {
  test.each([
    ['cmd+shift+p', '⇧⌘P'],
    ['ctrl+alt+shift+cmd+o', '⌃⌥⇧⌘O'],
    ['alt+f12', '⌥F12'],
    ['cmd+enter', '⌘⏎'],
    ['ctrl+`', '⌃`'],
    ['cmd+=', '⌘='],
    ['cmd++', '⌘+'],
    ['shift+alt+down', '⌥⇧↓'],
    ['cmd+k cmd+s', 'no match here: a two-key chord (VimStorm binds one key)'],
  ])('VS Code %s is %s', (key, want) => {
    expect(text(vscodeKey(key))).toBe(want);
  });

  test.each([
    ['meta shift O', undefined, '⇧⌘O'],
    ['ctrl alt L', undefined, '⌃⌥L'],
    ['shift F6', undefined, '⇧F6'],
    ['meta OPEN_BRACKET', undefined, '⌘['],
    ['meta BACK_SPACE', undefined, '⌘⌫'],
    ['meta k', 'meta p', 'no match here: a two-key chord (VimStorm binds one key)'],
    // #325: a key with no VK_ name is its extended key code, 0x01000000 + the character's
    ['ctrl #10000d6', undefined, '⌃Ö'],
    ['shift ctrl #10000e5', undefined, '⌃⇧Å'],
  ])('JetBrains %s %s is %s', (first, second, want) => {
    expect(text(jetbrainsKey(first, second))).toBe(want);
  });

  test.each([
    ['<C-p>', '⌃P'],
    ['<C-P>', '⌃P'],
    ['<D-S-p>', '⇧⌘P'],
    ['<D-P>', '⇧⌘P'],
    ['<M-CR>', '⌥⏎'],
    ['<F2>', 'F2'],
    ['<C-S-Right>', '⌃⇧→'],
    ['<leader>f', 'none'],
    ['jk', 'none'],
    ['<Esc>', 'none'],
  ])('Vim %s is %s', (lhs, want) => {
    expect(text(vimKey(lhs))).toBe(want);
  });
});

describe('keys as nvim reads them', () => {
  test.each([
    ['⇧⌘P', ['<D-S-p>']],
    ['⌘Y', ['<D-y>']],
    ['⌃⌥→', ['<C-M-Right>']],
    ['F2', ['<F2>']],
    ['⌥⏎', ['<M-CR>']],
    // the Swedish layout's physical keys too
    ['⌘\\', ['<D-Bslash>', '<M-D-S-7>']],
    ['⌃`', ['<C-`>', '<C-S-´>']],
    ['⌘;', ['<D-;>', '<D-S-,>']],
    ['⌘/', ['<D-/>', '<D-S-7>']],
    // #325: the Swedish letters as the app sends them
    ['⌃Ö', ['<C-ö>']],
    ['⌃⇧Ö', ['<C-S-ö>']],
  ])('%s', (key, want) => {
    const chord = chordOfText(key);

    expect(chord === undefined ? [] : nvimKeys(chord)).toEqual(want);
  });

  test('keys.json: a key → an action of the catalogue, each as the shell binds it', () => {
    expect(keyBinds({ '⌘Y': 'goToFile', '⌃⌥→': 'nextTab', '⌘U': 'nothing', '': 'find' })).toEqual([
      { key: '⌘Y', action: 'goToFile', lhs: ['<D-y>'], does: '<D-o>' },
      { key: '⌃⌥→', action: 'nextTab', lhs: ['<C-M-Right>'], does: '<C-Right>' },
    ]);
    expect(keyBinds([1])).toEqual([]);
    // one entry at a time: a list's first action, a bad one skipped, never every key dropped
    expect(
      keyBinds({ '⌘U': ['nope', 'find'], '⌘I': 3, '⌘E': 'goToFile', '⏎': 'find', '⌥P': 'find' }),
    ).toEqual([{ key: '⌘U', action: 'find', lhs: ['<D-u>'], does: '<D-f>' }]);
    expect(keyBinds({ '⌘Y': 3 })).toEqual([]);
  });

  test('every action names its VimStorm key, nvim’s name for it too', () => {
    for (const [id, a] of Object.entries(KEYMAP_ACTIONS)) {
      const chord = chordOfText(a.key);

      expect(chord === undefined ? [] : nvimKeys(chord)).toContain(a.nvim);
      expect(id).toMatch(/^[a-z][A-Za-z]+$/);
    }
  });
});

/** `super+shift+d` as macOS writes it: `⇧⌘D`. */
const glyphOf = (trigger: string): string => {
  const parts = trigger.split(/\+(?!$)/);
  const key = parts.at(-1) ?? '';
  const mods = new Set(parts.slice(0, -1));
  // the Swedish layout's physical forms: ⇧0 is =, ⇧´ is `
  const shifted: Readonly<Record<string, string>> = { digit_0: '=', '´': '`' };
  const swedish = mods.has('shift') ? shifted[key] : undefined;

  if (swedish !== undefined) mods.delete('shift');
  const named: Readonly<Record<string, string>> = {
    enter: '⏎',
    arrow_up: '↑',
    arrow_down: '↓',
    arrow_left: '←',
    arrow_right: '→',
  };
  const k = swedish ?? named[key] ?? (key.startsWith('digit_') ? key.slice(6) : key.toUpperCase());

  return `${mods.has('ctrl') ? '⌃' : ''}${mods.has('alt') ? '⌥' : ''}${mods.has('shift') ? '⇧' : ''}${mods.has('super') ? '⌘' : ''}${k}`;
};

test("WINDOW_KEYS are the app's Window, App and Ignored rows (app/src/input/keymap.rs)", () => {
  const rs = readFileSync(
    join(import.meta.dir, '../../../../../app/src/editor/input/keymap.rs'),
    'utf8',
  );
  const keymap = rs.slice(rs.indexOf('pub const KEYMAP'), rs.indexOf('pub const VSCODE'));
  const rows = [...keymap.matchAll(/s\(\s*"([^"]+)",\s*"[^"]*",\s*(Window|App|Ignored),?\s*\)/g)];

  expect(rows.length).toBeGreaterThan(20);
  const want = rows.map((m) => glyphOf(m[1] ?? ''));

  expect([...WINDOW_KEYS].sort()).toEqual([...new Set(want)].sort());
});
