/** Imported config from VS Code (#120): its files as rows onto this app's settings. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ImportRow,
  nearestTheme,
  type SettingKey,
  vimRows,
  onlyRows,
  feelRows,
  readJsonc,
  readVscode,
  settingsImportText,
  unreadableSource,
  stripJsonc,
  vscodeRows,
} from '../index';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'vscode', name), 'utf8');

const vimRowsOf = (vimrc: string) => vimRows({ '.vimrc': vimrc });
const rows = vscodeRows({
  settings: fixture('settings.json'),
  keybindings: fixture('keybindings.json'),
});
const byId = new Map(rows.map((r) => [r.id, r]));
const to = (id: string) => byId.get(id)?.to ?? null;

describe('VS Code settings.json', () => {
  test('reads JSON with comments and trailing commas, keeping // inside strings', () => {
    expect(readJsonc('{ "a": "x//y", /* c */ "b": [1, 2,], // d\n }')).toEqual({
      doc: { a: 'x//y', b: [1, 2] },
    });
    expect(stripJsonc('"a\\"//b"')).toBe('"a\\"//b"');
    expect('error' in readJsonc('{ nope')).toBe(true);
    // a comma inside a string stays; a trailing one before a comment goes; a byte order mark goes
    expect(readJsonc('{"a": "x, }", "b": [1, /* c */ ], }')).toEqual({
      doc: { a: 'x, }', b: [1] },
    });
    expect(readJsonc('\uFEFF{"a": 1}')).toEqual({ doc: { a: 1 } });
  });

  test('the Feel vscode comes first, ticked', () => {
    expect(rows[0]).toMatchObject({
      id: 'feel',
      group: 'feel',
      to: { key: 'ui.feel', value: 'vscode' },
      ticked: true,
    });
  });

  test.each<[string, SettingKey, unknown]>([
    ['editor.fontFamily', 'ui.font.editorFamily', 'JetBrains Mono'],
    ['editor.fontSize', 'ui.font.editorSize', 14],
    ['editor.fontLigatures', 'ui.font.ligatures', true],
    ['workbench.colorTheme', 'ui.theme', 'dark-modern'],
    ['workbench.editor.enablePreview', 'tabs.preview', false],
    ['workbench.editor.limit.enabled', 'tabs.limit', 8],
    ['files.autoSave', 'files.autoSave', 'onFocusChange'],
    ['explorer.compactFolders', 'tree.compactFolders', false],
    ['explorer.autoReveal', 'tree.autoReveal', true],
    ['workbench.list.openMode', 'tree.singleClick', false],
    ['editor.minimap.enabled', 'editor.minimap', false],
  ])('%s becomes %s = %p, ticked', (id, key, value) => {
    expect(to(id)).toMatchObject({ key });
    const got: unknown = to(id)?.value;

    expect(got).toEqual(value);
    expect(byId.get(id)?.ticked).toBe(true);
  });

  test('what has no match here is listed dim and never ticked', () => {
    for (const id of ['editor.tabSize', 'url', '[language]'])
      expect(byId.get(id)).toMatchObject({ to: null, ticked: false });
    // the limit's value is the enabled row's, not a row of its own
    expect(byId.has('workbench.editor.limit.value')).toBe(false);
  });

  test('VSCodeVim’s settings keep Vim mode on over the Feel’s off (#131), stock Vim keys (#214)', () => {
    expect(byId.get('feel')?.to).toEqual({ key: 'ui.feel', value: 'vscode' });
    expect(byId.get('vim.*')).toMatchObject({
      from: 'VSCodeVim: 2 settings',
      to: { key: 'editor.vim', value: true },
      ticked: true,
      note: 'Vim mode on, stock Vim keys h j k l',
    });
  });

  test('a value the setting does not take is no match, with why', () => {
    const big = vscodeRows({ settings: '{ "editor.fontSize": 40 }' });

    expect(big[1]).toMatchObject({
      id: 'editor.fontSize',
      to: null,
      ticked: false,
      note: 'ui.font.editorSize takes no 40',
    });
  });

  test('an unreadable or missing file brings only the Feel', () => {
    expect(vscodeRows({ settings: '{ broken' }).map((r) => r.id)).toEqual(['feel']);
    expect(vscodeRows({}).map((r) => r.id)).toEqual(['feel']);
  });

  test('a parse error names its line and column', () => {
    expect(readJsonc('{ "editor.fontSize": 14, "files.autoSave": "afterDelay" "x": 1 }')).toEqual({
      error: 'line 1, column 57: expected , or }',
    });
    expect(readJsonc('{\n  // c\n  "a": 1\n  "b": 2\n}')).toEqual({
      error: 'line 4, column 3: expected , or }',
    });
    expect(readJsonc('{"editor.fontSize": 14 /* never closed\n')).toEqual({
      error: 'line 1, column 24: a /* comment is never closed',
    });
    expect(readJsonc('[1, 2')).toEqual({ error: 'line 1, column 6: expected , or ]' });
    expect(readJsonc('{\n  "a": 1,\n  "path": "C:\\Users\\me"\n}')).toEqual({
      error: 'line 3, column 14: expected a JSON escape (\\\\ for a backslash)',
    });
    expect(readJsonc('{"a": "\\u12"}')).toEqual({
      error: 'line 1, column 8: expected a JSON escape (\\\\ for a backslash)',
    });
    expect(readJsonc(`${'['.repeat(200_000)}x`)).toEqual({ error: 'nested too deep to read' });
  });

  test('a settings.json that is no object, keybindings.json no array, do not read', () => {
    expect(readVscode({ settings: '[1, 2, 3]', keybindings: '{"not": "array"}' })).toEqual({
      settings: { error: 'not an object' },
      keybindings: { error: 'not an array' },
    });
    expect(readVscode({ settings: '{ x' }).settings).toEqual({
      error: 'not JSON: line 1, column 3: expected a string',
    });
    // a /* never closed is no empty file
    expect(readVscode({ settings: '/* never closed {"a": 1}' }).settings).toEqual({
      error: 'not JSON: line 1, column 1: a /* comment is never closed',
    });
    // VS Code reads an empty file as no settings
    expect(readVscode({ settings: ' // nothing yet\n', keybindings: '' })).toEqual({
      settings: { doc: {} },
      keybindings: { doc: [] },
    });
  });

  test('a tab limit row shows both of its keys', () => {
    const [, row] = vscodeRows({
      settings: '{"workbench.editor.limit.enabled": true, "workbench.editor.limit.value": 0}',
    });

    expect(row?.from).toBe(
      'workbench.editor.limit.enabled: true · workbench.editor.limit.value: 0',
    );
  });

  test('a rounded font size says so', () => {
    expect(byId.get('editor.fontSize')?.note).toBe('rounded from 13.5');
  });

  test('a long value is cut where it is shown', () => {
    const long = 'x'.repeat(5000);
    const [, row] = vscodeRows({ settings: JSON.stringify({ 'some.key': long }) });

    expect(row?.from.length).toBeLessThan(100);
    expect(row?.from.endsWith('…')).toBe(true);
    const [, bad] = vscodeRows({ settings: JSON.stringify({ 'editor.fontSize': long }) });

    expect(bad?.note?.length).toBeLessThan(100);
  });

  test.each<[Record<string, boolean>, string, string | null]>([
    [{ 'explorer.decorations.badges': false }, 'colors', null],
    [{ 'explorer.decorations.badges': true }, 'letters', null],
    [
      { 'explorer.decorations.badges': false, 'explorer.decorations.colors': false },
      'colors',
      'no tree without colours here',
    ],
    [{ 'explorer.decorations.colors': false }, 'letters', 'the colours stay here'],
    [{ 'explorer.decorations.colors': true }, 'letters', null],
  ])('decorations %p: tree.decorations = %s', (doc, value, note) => {
    const got = vscodeRows({ settings: JSON.stringify(doc) }).slice(1);

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ to: { key: 'tree.decorations', value }, note });
  });

  test('the terminal font is the editor font here: said so', () => {
    const got = vscodeRows({
      settings: '{"terminal.integrated.fontFamily": "Menlo", "terminal.integrated.fontSize": 12}',
    }).slice(1);

    expect(got.map((r) => [r.to, r.note])).toEqual([
      [null, 'no match here: the terminal has the editor font (ui.font.editorFamily)'],
      [null, 'no match here: the terminal has the editor font (ui.font.editorSize)'],
    ]);
  });
});

describe('VS Code keybindings.json and the theme', () => {
  // #129: a keybinding on one of the Keymap's actions is that key in keys.json; the rest say why not
  test('each keybinding onto the Keymap: its key and action, or no match with why', () => {
    const keys = rows.filter((r) => r.group === 'keys');

    expect(keys.map((r) => [r.from, r.bind, r.ticked, r.note])).toEqual([
      [
        'cmd+k cmd+t → workbench.action.selectTheme',
        null,
        false,
        'no match here: a two-key chord (VimStorm binds one key)',
      ],
      [
        'ctrl+shift+` → workbench.action.terminal.new when terminalProcessSupported',
        { key: '⌃⇧`', action: 'newTerminal' },
        true,
        'everywhere here, not only when terminalProcessSupported',
      ],
      [
        'cmd+p removed from workbench.action.quickOpen',
        null,
        false,
        'no match here: VimStorm’s own keys stay',
      ],
      ['cmd+y → workbench.action.quickOpen', { key: '⌘Y', action: 'goToFile' }, true, null],
      [
        'cmd+q → workbench.action.files.saveAll',
        null,
        false,
        "no match here: ⌘Q is VimStorm's own (Save All keeps ⌘S)",
      ],
    ]);
    expect(keys.every((r) => r.to === null)).toBe(true);
  });

  test('a command VimStorm has none of, a key it cannot name', () => {
    const got = vscodeRows({
      settings: '{}',
      keybindings:
        '[{"key": "cmd+i", "command": "editor.action.inlineSuggest.trigger"}, {"key": "cmd+numpad1", "command": "workbench.action.quickOpen"}]',
    }).filter((r) => r.group === 'keys');

    expect(got.map((r) => r.note)).toEqual([
      'no match here: VimStorm has no editor.action.inlineSuggest.trigger',
      'no match here: no key cmd+numpad1 here',
    ]);
  });

  test('a key that types is none; one of VimStorm’s own keys says what it covers', () => {
    const got = vscodeRows({
      settings: '{}',
      keybindings: JSON.stringify([
        { key: 'enter', command: 'workbench.action.quickOpen' },
        { key: 'alt+p', command: 'workbench.action.quickOpen' },
        { key: 'shift+a', command: 'workbench.action.quickOpen' },
        { key: 'alt+enter', command: 'editor.action.formatDocument' },
        { key: 'cmd+k', command: 'actions.find' },
      ]),
    }).filter((r) => r.group === 'keys');

    expect(got.map((r) => [r.bind?.key ?? null, r.note])).toEqual([
      [null, 'no match here: ⏎ types (VimStorm binds ⌃ / ⌘ keys, F-keys and ⌥ with a named key)'],
      [null, 'no match here: ⌥P types (VimStorm binds ⌃ / ⌘ keys, F-keys and ⌥ with a named key)'],
      [null, 'no match here: ⇧A types (VimStorm binds ⌃ / ⌘ keys, F-keys and ⌥ with a named key)'],
      ['⌥⏎', 'covers ⌥⏎ Show Context Actions'],
      ['⌘K', 'covers ⌘K Commit'],
    ]);
  });

  test.each([
    ['Default Dark Modern', 'dark-modern', true],
    ['Dark Modern', 'dark-modern', true],
    ['Default Dark+', 'dark-modern', false],
    ['Default Light Modern', 'islands-light', false],
    ['Solarized Light', 'islands-light', false],
    ['Monokai', 'islands-dark', false],
  ])('the theme %s is the built-in %s (exact %p)', (name, slug, exact) => {
    expect(nearestTheme(name)).toEqual({ slug, exact });
  });
});

describe('--only and the text', () => {
  test('two rows setting one setting: the later wins, the earlier unticked', () => {
    const twice = onlyRows(
      vimRowsOf('colorscheme gruvbox\ncolorscheme catppuccin-latte\n'),
      undefined,
    ).filter((r) => r.group === 'theme');

    expect(twice.map((r) => [r.ticked, r.to?.value, r.note])).toEqual([
      [false, 'islands-dark', 'a later one sets it'],
      [true, 'islands-light', 'nearest built-in'],
    ]);
  });

  test('--only ticks just the settings it names', () => {
    const only = onlyRows(rows, ['ui.feel', 'tabs.limit']);

    expect(only.filter((r) => r.ticked).map((r) => r.to?.key)).toEqual(['ui.feel', 'tabs.limit']);
  });

  test('the text: files, then each row, then what was written', () => {
    const some: ImportRow[] = rows.filter((r) => ['feel', 'editor.tabSize'].includes(r.id));

    expect(
      settingsImportText({
        source: 'vscode',
        files: [
          { path: '/h/settings.json', found: true, error: null },
          { path: '/h/keybindings.json', found: false, error: null },
        ],
        rows: some,
        file: '/h/.config/abe/settings.yaml',
        dryRun: true,
        written: [],
        keysFile: '~/.config/abe/keys.json',
        keysWritten: [],
        refused: [],
      }),
    ).toBe(
      [
        '/h/settings.json  read',
        '/h/keybindings.json  not found',
        '✓ VS Code  →  ui.feel = vscode  (Vim mode off, its tree, tabs and save switches)',
        '· editor.tabSize: 2  →  no match here',
        'dry run: 1 would be written to /h/.config/abe/settings.yaml',
        '',
      ].join('\n'),
    );
  });
});

describe('values the Feel gives (#171)', () => {
  const vs = (settings: object) => vscodeRows({ settings: JSON.stringify(settings) });
  const feel = vs({
    'workbench.editor.enablePreview': true,
    'explorer.autoReveal': true,
    'editor.fontSize': 15,
    'workbench.editor.limit.enabled': true,
    'workbench.editor.limit.value': 8,
  });

  test('a Feel key equal to the picked Feel’s value is not ticked, said why', () => {
    const got = feelRows(feel, undefined, () => undefined);

    expect(got.map((r) => [r.to?.key, r.ticked, r.note])).toEqual([
      ['ui.feel', true, 'Vim mode off, its tree, tabs and save switches'],
      ['tabs.preview', false, 'the Feel VS Code gives it'],
      ['tree.autoReveal', false, 'the Feel VS Code gives it'],
      ['ui.font.editorSize', true, null],
      ['tabs.limit', true, null],
    ]);
  });

  test('still ticked where something else is in force, or --only names it, or no Feel is picked', () => {
    const inForce = (key: SettingKey) => (key === 'tabs.preview' ? false : undefined);

    expect(feelRows(feel, undefined, inForce)[1]?.ticked).toBe(true);
    expect(feelRows(feel, ['ui.feel', 'tree.autoReveal'], () => undefined)[2]?.ticked).toBe(true);
    const noFeel = onlyRows(feel, ['tabs.preview']);

    expect(feelRows(noFeel, ['tabs.preview'], () => undefined)[1]?.ticked).toBe(true);
  });
});

describe('a source that does not read (#170)', () => {
  const file = (path: string, found: boolean, error: string | null = null) => ({
    path,
    found,
    error,
  });

  test('VS Code: settings.json missing or unreadable', () => {
    const keys = file('/h/Library/Application Support/Code/User/keybindings.json', true);
    const settings = '/h/Library/Application Support/Code/User/settings.json';

    expect(unreadableSource('vscode', [file(settings, false), keys])).toBe(`${settings} not found`);
    expect(unreadableSource('vscode', [file(settings, true, 'not an object'), keys])).toBe(
      `${settings} does not read: not an object`,
    );
    expect(unreadableSource('vscode', [file(settings, true), file(keys.path, true, 'x')])).toBe(
      undefined,
    );
  });

  test('WebStorm: no IDE folder; Vim: none of its files', () => {
    expect(
      unreadableSource('webstorm', [file('/h/Library/Application Support/JetBrains', false)]),
    ).toBe('/h/Library/Application Support/JetBrains: no JetBrains IDE config there');
    expect(
      unreadableSource('webstorm', [file('/h/.../WebStorm2025.3/options/editor-font.xml', false)]),
    ).toBe(undefined);
    expect(unreadableSource('vim', [file('/h/.vimrc', false), file('/h/init.lua', false)])).toBe(
      'none of /h/.vimrc, /h/init.lua found',
    );
    expect(unreadableSource('vim', [file('/h/.vimrc', false), file('/h/init.lua', true)])).toBe(
      undefined,
    );
  });
});
