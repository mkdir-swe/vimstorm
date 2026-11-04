/**
 * `abe settings import` (#120) on an in-process `serve` (`served`), one contract test through the
 * real `abe`: VS Code's files under the run's own HOME, your Layer read back from disk.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FeelSwitches, SettingsImportData, SettingGetData, VSCODE_FILES } from '@abe/core';
import { cli, served, type ServedCli } from '@abe/testing';

const ALL = join(import.meta.dir, '..', '..', '..', 'core', 'src', 'import', 'fixtures');
const FIXTURES = join(ALL, 'vscode');

/** In-process (`served`), but for the one contract test through the real `abe` (`cli`). */
let abe: Omit<ServedCli, 'scenario' | 'watch'>;

afterEach(async () => {
  await abe.close();
});

/** A CLI whose HOME has VS Code's fixture files. */
const withVscode = async () => {
  abe = await served();
  const home = abe.state.dir;

  for (const [name, rel] of [
    ['settings.json', VSCODE_FILES.settings],
    ['keybindings.json', VSCODE_FILES.keybindings],
  ] as const) {
    mkdirSync(join(home, rel, '..'), { recursive: true });
    copyFileSync(join(FIXTURES, name), join(home, rel));
  }

  return { home, mine: join(home, '.config', 'abe', 'settings.yaml') };
};

describe('abe settings import vscode', () => {
  test('--dry-run lists the rows and writes nothing', async () => {
    const { mine } = await withVscode();
    const { exit, doc } = await abe.json(
      SettingsImportData,
      'settings',
      'import',
      'vscode',
      '--dry-run',
    );

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.files.map((f) => [f.path.endsWith('settings.json'), f.found])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(doc.data.rows[0]?.to).toEqual({ key: 'ui.feel', value: 'vscode' });
    expect(doc.data.written).toEqual([]);
    expect(existsSync(mine)).toBe(false);
  }, 15_000);

  test('writes the ticked rows to your Layer only, and the merge reads them', async () => {
    const { mine } = await withVscode();
    const { doc } = await abe.json(SettingsImportData, 'settings', 'import', 'vscode');

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.written).toContain('ui.feel');
    expect(doc.data.written).toContain('tabs.limit');
    expect(doc.data.written).not.toContain('tree.decorations');
    expect(readFileSync(mine, 'utf8')).toContain('feel: vscode');
    const limit = await abe.json(SettingGetData, 'settings', 'get', 'tabs.limit');

    expect(limit.doc).toMatchObject({ ok: true, data: { value: 8, layer: 'individual' } });
    // the Feel gives what settings.json does not say
    const dot = await abe.json(SettingGetData, 'settings', 'get', 'tabs.dirtyDot');

    expect(dot.doc).toMatchObject({ ok: true, data: { value: true } });
  }, 15_000);

  test('--only ticks just the named settings; an unknown one is refused', async () => {
    const { mine } = await withVscode();
    const { doc } = await abe.json(
      SettingsImportData,
      'settings',
      'import',
      'vscode',
      '--only',
      'ui.font.editorSize',
    );

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.written).toEqual(['ui.font.editorSize']);
    expect(readFileSync(mine, 'utf8')).not.toContain('feel');
    const bad = await abe.json(
      SettingsImportData,
      'settings',
      'import',
      'vscode',
      '--only',
      'nope',
    );

    expect(bad.doc).toMatchObject({ ok: false, error: { code: 'unknown-setting' } });
  }, 15_000);

  // #129: the keybindings on the Keymap's actions go to your keys.json, the keys there kept
  test('the key bindings into keys.json, and settings feel binds them', async () => {
    const { home } = await withVscode();
    const keys = join(home, '.config', 'abe', 'keys.json');

    mkdirSync(join(keys, '..'), { recursive: true });
    writeFileSync(keys, '{ "⌘U": "find", "⌘Y": "rename" }\n');
    const dry = await abe.run('settings', 'import', 'vscode', '--dry-run');

    expect(dry.stdout).toContain('✓ cmd+y → workbench.action.quickOpen  →  ⌘Y = goToFile\n');
    expect(dry.stdout).toContain(`dry run: 2 keys would be written to ${keys}\n`);
    expect(readFileSync(keys, 'utf8')).toBe('{ "⌘U": "find", "⌘Y": "rename" }\n');
    const { doc } = await abe.json(SettingsImportData, 'settings', 'import', 'vscode');

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.keysFile).toBe(keys);
    expect(doc.data.keysWritten).toEqual(['⌃⇧`', '⌘Y']);
    expect(JSON.parse(readFileSync(keys, 'utf8'))).toEqual({
      '⌘U': 'find',
      '⌘Y': 'goToFile',
      '⌃⇧`': 'newTerminal',
    });
    const feel = await abe.json(FeelSwitches, 'settings', 'feel');

    expect(feel.doc).toMatchObject({
      ok: true,
      data: {
        keys: [
          { key: '⌘U', action: 'find', lhs: ['<D-u>'], does: '<D-f>' },
          { key: '⌘Y', action: 'goToFile', lhs: ['<D-y>'], does: '<D-o>' },
          { key: '⌃⇧`', action: 'newTerminal', lhs: ['<C-S-`>', '<C-S-´>'], does: '<D-S-t>' },
        ],
      },
    });
  }, 15_000);

  test('--only key:<the key> takes just that binding; a keys.json that does not read is refused', async () => {
    const { home, mine } = await withVscode();
    const keys = join(home, '.config', 'abe', 'keys.json');
    const { doc } = await abe.json(
      SettingsImportData,
      'settings',
      'import',
      'vscode',
      '--only',
      'key:⌘Y',
    );

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.written).toEqual([]);
    expect(doc.data.keysWritten).toEqual(['⌘Y']);
    expect(existsSync(mine)).toBe(false);
    expect(JSON.parse(readFileSync(keys, 'utf8'))).toEqual({ '⌘Y': 'goToFile' });
    const bad = await abe.json(
      SettingsImportData,
      'settings',
      'import',
      'vscode',
      '--only',
      'key:nope',
    );

    expect(bad.doc).toMatchObject({ ok: false, error: { code: 'unknown-setting' } });
    writeFileSync(keys, '[1]');
    const unread = await abe.json(SettingsImportData, 'settings', 'import', 'vscode');

    expect(unread.doc).toMatchObject({ ok: false, error: { code: 'bad-keys-file' } });
    expect(readFileSync(keys, 'utf8')).toBe('[1]');
    // refused whole: your settings untouched too
    expect(existsSync(mine)).toBe(false);
  }, 15_000);

  // the CLI contract: exit 1 and the --json error through the real `abe`
  test('no VS Code on this Mac, or a settings.json that does not read: nothing written, exit 1', async () => {
    abe = cli();
    const mine = join(abe.state.dir, '.config', 'abe', 'settings.yaml');
    const none = await abe.run('settings', 'import', 'vscode');

    expect(none.exit).toBe(1);
    expect(none.stdout + none.stderr).toContain('settings.json not found');
    const settings = join(abe.state.dir, VSCODE_FILES.settings);

    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(settings, '{ "editor.fontSize": 14,\n  "files.autoSave": "afterDelay" "x": 1 }');
    const bad = await abe.json(SettingsImportData, 'settings', 'import', 'vscode', '--dry-run');

    expect(bad.exit).toBe(1);
    if (bad.doc.ok) throw new Error('read');
    expect(bad.doc.error.code).toBe('import-unreadable');
    expect(bad.doc.error.message).toContain(
      'settings.json does not read: not JSON: line 2, column 34: expected , or }',
    );
    writeFileSync(settings, '[1, 2, 3]');
    const arr = await abe.run('settings', 'import', 'vscode');

    expect(arr.exit).toBe(1);
    expect(arr.stdout + arr.stderr).toContain('settings.json does not read: not an object');
    expect(existsSync(mine)).toBe(false);
    // --only takes what it names all the same
    const feel = await abe.json(
      SettingsImportData,
      'settings',
      'import',
      'vscode',
      '--only',
      'ui.feel',
    );

    expect(feel.doc).toMatchObject({ ok: true, data: { written: ['ui.feel'] } });
  }, 15_000);

  test('a value the Feel gives is not written, so switching the Feel moves it (#171)', async () => {
    abe = await served();
    const settings = join(abe.state.dir, VSCODE_FILES.settings);

    mkdirSync(join(settings, '..'), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        'explorer.autoReveal': true,
        'workbench.editor.enablePreview': true,
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.editor.limit.enabled': true,
        'workbench.editor.limit.value': 8,
      }),
    );
    const { doc } = await abe.json(SettingsImportData, 'settings', 'import', 'vscode');

    if (!doc.ok) throw new Error(doc.error.message);
    // the theme is no Feel's (#345): VS Code's is written as yours
    expect(doc.data.written).toEqual(['ui.feel', 'ui.theme', 'tabs.limit']);
    expect(doc.data.rows.find((r) => r.id === 'explorer.autoReveal')).toMatchObject({
      ticked: false,
      note: 'the Feel VS Code gives it',
    });
    await abe.run('settings', 'set', 'ui.feel', 'vimstorm');
    for (const [key, value] of [
      ['tree.autoReveal', false],
      ['tabs.preview', false],
      ['ui.theme', 'dark-modern'],
      ['tabs.limit', 8],
    ] as const) {
      const got = await abe.json(SettingGetData, 'settings', 'get', key);

      expect(got.doc).toMatchObject({ ok: true, data: { value } });
    }
    // your own value set apart from the Feel is written again over it
    await abe.run('settings', 'set', 'tabs.preview', 'false');
    await abe.run('settings', 'set', 'ui.feel', 'vscode');
    const again = await abe.json(SettingsImportData, 'settings', 'import', 'vscode', '--dry-run');

    if (!again.doc.ok) throw new Error(again.doc.error.message);
    expect(again.doc.data.rows.find((r) => r.id === 'workbench.editor.enablePreview')?.ticked).toBe(
      true,
    );
  }, 30_000);
});

describe('abe settings import webstorm / vim', () => {
  test('webstorm: the newest WebStorm folder’s font and scheme written, its keymap listed', async () => {
    abe = await served();
    const root = join(abe.state.dir, 'Library', 'Application Support', 'JetBrains');

    cpSync(join(ALL, 'jetbrains'), root, { recursive: true });
    mkdirSync(join(root, 'WebStorm2024.2'));
    const { doc } = await abe.json(SettingsImportData, 'settings', 'import', 'webstorm');

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.files.every((f) => f.path.includes('WebStorm2025.3') && f.found)).toBe(true);
    expect(doc.data.files.map((f) => f.path.split('WebStorm2025.3/')[1])).toEqual([
      'options/editor-font.xml',
      'options/colors.scheme.xml',
      'options/ui.lnf.xml',
      'options/ide.general.xml',
      'options/projectView.xml',
      'keymaps/Example keymap.xml',
    ]);
    // Darcula Contrast is Islands Dark: written, no Feel gives a theme (#345)
    expect(doc.data.written).toEqual([
      'ui.feel',
      'ui.font.editorFamily',
      'ui.font.editorSize',
      'ui.font.ligatures',
      'ui.theme',
      'tabs.limit',
      'tabs.preview',
      'tabs.dirtyDot',
      'ui.density',
      'ui.font.family',
      'ui.font.size',
      'files.autoSave',
      'tree.autoReveal',
      'tree.singleClick',
      'tree.compactFolders',
    ]);
    // #129: the keymap's ⌘Y Go to File is yours in keys.json
    expect(doc.data.rows.filter((r) => r.group === 'keys')).toHaveLength(6);
    expect(doc.data.keysWritten).toEqual(['⌘Y']);
    expect(JSON.parse(readFileSync(doc.data.keysFile, 'utf8'))).toEqual({ '⌘Y': 'goToFile' });
  }, 15_000);

  test('webstorm with IdeaVim (~/.ideavimrc): the Feel vim, Vim mode on (#131, #214)', async () => {
    abe = await served();
    const root = join(abe.state.dir, 'Library', 'Application Support', 'JetBrains');

    cpSync(join(ALL, 'jetbrains'), root, { recursive: true });
    writeFileSync(join(abe.state.dir, '.ideavimrc'), 'let mapleader=","\n');
    const { doc } = await abe.json(SettingsImportData, 'settings', 'import', 'webstorm');

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.rows[0]?.to).toEqual({ key: 'ui.feel', value: 'vim' });
    // the Feel vim gives Vim mode on: the IdeaVim row is listed, not written on its own
    expect(doc.data.rows.find((r) => r.id === 'ideavim')).toMatchObject({
      from: 'IdeaVim: ~/.ideavimrc',
      to: { key: 'editor.vim', value: true },
      ticked: false,
    });
    expect(doc.data.written).toContain('ui.feel');
    const vim = await abe.json(SettingGetData, 'settings', 'get', 'editor.vim');

    expect(vim.doc).toMatchObject({ ok: true, data: { value: true } });
  }, 15_000);

  test('vim: the font from guifont, mappings listed only', async () => {
    abe = await served();
    cpSync(join(ALL, 'vim'), abe.state.dir, { recursive: true });
    const ran = await abe.run('settings', 'import', 'vim', '--dry-run');

    expect(ran.exit).toBe(0);
    expect(ran.stdout).toContain(
      '✓ set guifont=Fira\\ Code:h15  →  ui.font.editorFamily = Fira Code',
    );
    expect(ran.stdout).toContain('· inoremap jk <Esc>  →  listed only: Neovim’s own mapping');
    expect(ran.stdout).toContain('.config/nvim/init.vim  not found');
  }, 15_000);

  test("vim: a ~/.config/nvim that is VimStorm's own nvim/ (a link to a checkout) is left out (#213)", async () => {
    abe = await served();
    cpSync(join(ALL, 'vim'), abe.state.dir, { recursive: true });
    // the fixture's init.lua moved into a VimStorm checkout's nvim/, ~/.config/nvim linked to it
    const own = join(abe.state.dir, 'checkout', 'nvim');

    mkdirSync(join(own, 'lua', 'config'), { recursive: true });
    mkdirSync(join(own, 'colors'), { recursive: true });
    writeFileSync(join(own, 'lua', 'config', 'app.lua'), 'return {}\n');
    writeFileSync(join(own, 'colors', 'darcula-contrast.lua'), '');
    writeFileSync(join(own, 'init.lua'), 'vim.opt.relativenumber = true\nvim.g.mapleader = ","\n');
    const config = join(abe.state.dir, '.config');

    rmSync(join(config, 'nvim'), { recursive: true });
    symlinkSync(own, join(config, 'nvim'));
    const read = await abe.json(SettingsImportData, 'settings', 'import', 'vim', '--dry-run');

    if (!read.doc.ok) throw new Error(JSON.stringify(read.doc));
    const doc = read.doc.data;

    expect(doc.files.find((f) => f.path.endsWith('init.lua'))).toEqual({
      path: join(config, 'nvim', 'init.lua'),
      found: false,
      error: null,
      skipped: "VimStorm's own nvim/ config",
    });
    // only the .vimrc's rows: none of VimStorm's own (its relativenumber, its , leader)
    expect(doc.rows.map((r) => r.from).filter((f) => f.includes('relativenumber'))).toEqual([]);
    expect(doc.rows.length).toBeGreaterThan(0);
    const text = await abe.run('settings', 'import', 'vim', '--dry-run');

    expect(text.stdout).toContain(".config/nvim/init.lua  left out: VimStorm's own nvim/ config");
  }, 15_000);
});
