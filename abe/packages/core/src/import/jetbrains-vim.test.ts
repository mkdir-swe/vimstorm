/** Imported config from WebStorm and from Vim / Neovim (#120): their files as rows. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeKeymap,
  feelRows,
  jetbrainsRows,
  keymapRows,
  pickIdeFolder,
  type SettingKey,
  vimRows,
} from '../index';

const read = (...p: string[]) => readFileSync(join(import.meta.dir, 'fixtures', ...p), 'utf8');
const ide = (...p: string[]) => read('jetbrains', 'WebStorm2025.3', ...p);

describe('WebStorm', () => {
  test('the newest WebStorm folder is read, else the newest IDE', () => {
    expect(
      pickIdeFolder([
        'DataGrip2025.2',
        'WebStorm2024.3',
        'WebStorm2025.3',
        'WebStorm2025.10',
        'Webstorm',
      ]),
    ).toBe('WebStorm2025.10');
    expect(pickIdeFolder(['DataGrip2024.2', 'DataGrip2025.2', 'consentOptions'])).toBe(
      'DataGrip2025.2',
    );
    expect(pickIdeFolder(['bl'])).toBeUndefined();
  });

  const rows = jetbrainsRows({
    ide: 'WebStorm2025.3',
    font: ide('options', 'editor-font.xml'),
    scheme: ide('options', 'colors.scheme.xml'),
    keymap: ide('keymaps', 'Example keymap.xml'),
    ui: ide('options', 'ui.lnf.xml'),
    general: ide('options', 'ide.general.xml'),
    projectView: ide('options', 'projectView.xml'),
  });
  const of = (from: string) => rows.find((r) => r.from.startsWith(from));

  test('the Feel webstorm, the editor font, the scheme as the nearest built-in', () => {
    expect(rows.slice(0, 5).map((r) => [r.from, r.to])).toEqual([
      ['WebStorm2025.3', { key: 'ui.feel', value: 'webstorm' }],
      ['Editor font: JetBrains Mono', { key: 'ui.font.editorFamily', value: 'JetBrains Mono' }],
      ['Editor font size: 13.5', { key: 'ui.font.editorSize', value: 14 }],
      ['Ligatures: true', { key: 'ui.font.ligatures', value: true }],
      ['Color scheme: Darcula Contrast', { key: 'ui.theme', value: 'islands-dark' }],
    ]);
    expect(of('Editor font size')?.note).toBe('rounded from 13.5');
  });

  test('IdeaVim in use picks the Feel vim (#214): WebStorm’s switches, stock Vim keys', () => {
    const vim = jetbrainsRows({ ide: 'WebStorm2025.3', ideavim: '~/.ideavimrc' });

    expect(vim.slice(0, 2).map((r) => [r.from, r.to, r.ticked])).toEqual([
      ['WebStorm2025.3', { key: 'ui.feel', value: 'vim' }, true],
      ['IdeaVim: ~/.ideavimrc', { key: 'editor.vim', value: true }, true],
    ]);
    // the Feel vim gives Vim mode on: the IdeaVim row is not written on its own
    expect(feelRows(vim, undefined, () => undefined)[1]).toMatchObject({
      ticked: false,
      note: 'Vim mode on, stock Vim keys h j k l · the Feel Vim gives it',
    });
  });

  test('an Islands scheme is that built-in exactly', () => {
    const scheme = (name: string) =>
      jetbrainsRows({
        scheme: `<application><component name="EditorColorsManagerImpl"><global_color_scheme name="${name}" /></component></application>`,
      })[1];

    expect(scheme('_@user_Islands Light')).toMatchObject({
      to: { key: 'ui.theme', value: 'islands-light' },
      note: null,
    });
    expect(scheme('Islands Dark')?.note).toBeNull();
    expect(scheme('IntelliJ Light')).toMatchObject({
      to: { value: 'islands-light' },
      note: 'nearest built-in',
    });
  });

  test.each<[string, SettingKey, unknown, string | null]>([
    ['Tab limit: 12', 'tabs.limit', 12, null],
    ['Enable preview tab: true', 'tabs.preview', true, null],
    ['Mark modified (*): true', 'tabs.dirtyDot', true, 'a ● here, not *'],
    ['UI density: COMPACT', 'ui.density', 'compact', null],
    ['UI font: Helvetica Neue', 'ui.font.family', 'Helvetica Neue', null],
    ['UI font size: 15', 'ui.font.size', 15, null],
    ['Always select opened file: true', 'tree.autoReveal', true, null],
    ['Open files with single click: true', 'tree.singleClick', true, null],
    ['Compact directories: true', 'tree.compactFolders', true, null],
  ])('the one-to-one option %s becomes %s = %p', (from, key, value, note) => {
    expect(of(from)).toMatchObject({ from, to: { key, value }, note, ticked: true });
  });

  test('autosave: idle saving is afterDelay, saving on app switch off is off', () => {
    expect(of('Save files if idle')).toMatchObject({
      from: 'Save files if idle for 5 s: true · on switching apps: false',
      to: { key: 'files.autoSave', value: 'afterDelay' },
      note: 'here a second after typing stops',
    });
    const general = (options: string) =>
      jetbrainsRows({
        general: `<application><component name="GeneralSettings">${options}</component></application>`,
      }).slice(1);

    expect(general('<option name="autoSaveFiles" value="false" />')).toMatchObject([
      { from: 'Save files on switching apps: false', to: { value: 'off' } },
    ]);
    expect(general('<option name="confirmExit" value="false" />')).toEqual([]);
  });

  test('folders opening on a single click and a UI font not in use are no match', () => {
    expect(of('Open directories with single click')).toMatchObject({
      to: null,
      note: 'no match here: a single click opens files here, folders open on their arrow',
    });
    const off = jetbrainsRows({
      ui: '<application><component name="UISettings"><option name="FONT_FACE" value="Arial" /></component></application>',
    }).slice(1);

    expect(off).toMatchObject([
      { from: 'UI font: Arial', to: null, note: 'not in use: Use custom font is off there' },
    ]);
  });

  // #129: each key of the active keymap onto the Keymap: a key of one of its actions is yours
  test('the active keymap’s keys onto the Keymap: its key and action, or no match with why', () => {
    expect(activeKeymap(ide('options', 'mac', 'keymap.xml'))).toBe('Example keymap');
    const keys = rows.filter((r) => r.group === 'keys');

    // #325: an action in words (the Keymap's title where it has one), its key as macOS writes it
    expect(keys.map((r) => [r.from, r.bind, r.note])).toEqual([
      [
        'Example keymap: Activate Terminal Tool Window = ⌘T',
        null,
        'no match here: VimStorm has no Activate Terminal Tool Window',
      ],
      [
        'Example keymap: Close Content = none (its keys removed)',
        null,
        'no match here: VimStorm’s own keys stay',
      ],
      [
        'Example keymap: Close Project = ⌥Q',
        null,
        'no match here: ⌥Q types (VimStorm binds ⌃ / ⌘ keys, F-keys and ⌥ with a named key)',
      ],
      ['Example keymap: Close Project = ⌘Q', null, 'no match here: VimStorm has no Close Project'],
      ['Example keymap: Go to File = ⌘Y', { key: '⌘Y', action: 'goToFile' }, null],
      [
        'Example keymap: Goto Action = ⌘K, ⌘P',
        null,
        'no match here: a two-key chord (VimStorm binds one key)',
      ],
    ]);
    expect(keys.filter((r) => r.ticked).map((r) => r.bind?.key)).toEqual(['⌘Y']);
  });

  test('JetBrains key names: punctuation, named keys and F-keys', () => {
    const xml = (id: string, key: string) =>
      `<keymap name="k"><action id="${id}"><keyboard-shortcut first-keystroke="${key}" /></action></keymap>`;
    const bind = (id: string, key: string) => keymapRows(xml(id, key))[0]?.bind;

    expect(bind('CommentByLineComment', 'meta shift SLASH')).toEqual({
      key: '⇧⌘/',
      action: 'commentLine',
    });
    expect(bind('ShowIntentionActions', 'alt ENTER')).toEqual({
      key: '⌥⏎',
      action: 'contextActions',
    });
    expect(bind('RenameElement', 'F2')).toEqual({ key: 'F2', action: 'rename' });
    expect(bind('NextTab', 'ctrl alt RIGHT')).toEqual({ key: '⌃⌥→', action: 'nextTab' });
  });

  // #325: WebStorm writes ⌃ö on a Swedish keyboard as `ctrl #10000d6`
  test('a Swedish letter key reads: ⌃Ö onto an action, words for one VimStorm has not', () => {
    const xml = (id: string, key: string) =>
      `<keymap name="k"><action id="${id}"><keyboard-shortcut first-keystroke="${key}" /></action></keymap>`;
    const [clone] = keymapRows(xml('EditorCloneCaretBelow', 'ctrl #10000d6'));

    expect(clone).toMatchObject({
      from: 'k: Clone Caret Below = ⌃Ö',
      bind: null,
      note: 'no match here: VimStorm has no Clone Caret Below',
    });
    expect(keymapRows(xml('GotoFile', 'shift ctrl #10000d6'))[0]?.bind).toEqual({
      key: '⌃⇧Ö',
      action: 'goToFile',
    });
  });

  test('a default font file (no options) brings only the Feel and the scheme', () => {
    const bare = jetbrainsRows({
      font: '<application><component name="DefaultFont"><option name="VERSION" value="1" /></component></application>',
    });

    expect(bare.map((r) => r.id)).toEqual(['feel']);
  });
});

describe('Vim / Neovim', () => {
  const rows = vimRows({
    '.vimrc': read('vim', '.vimrc'),
    '.config/nvim/init.lua': read('vim', '.config', 'nvim', 'init.lua'),
  });
  const ticked = rows.filter((r) => r.ticked).map((r) => [r.from, r.to]);

  test('the Feel vim (#214), the font, write-on-switch and the scheme map; the rest is listed', () => {
    expect(ticked).toEqual([
      ['Vim / Neovim', { key: 'ui.feel', value: 'vim' }],
      ['set guifont=Fira\\ Code:h15', { key: 'ui.font.editorFamily', value: 'Fira Code' }],
      ['set guifont=Fira\\ Code:h15', { key: 'ui.font.editorSize', value: 15 }],
      ['set autowriteall', { key: 'files.autoSave', value: 'onFocusChange' }],
      ['colorscheme gruvbox', { key: 'ui.theme', value: 'islands-dark' }],
      ['colorscheme catppuccin-latte', { key: 'ui.theme', value: 'islands-light' }],
    ]);
  });

  test('set with += / -= / ^= is shown as written', () => {
    expect(
      vimRows({ '.vimrc': 'set path+=src\nset shortmess-=F\nset cpo^=x\n' }).map((r) => r.from),
    ).toEqual(['Vim / Neovim', 'set path+=src', 'set shortmess-=F', 'set cpo^=x']);
  });

  test('the leader, options and mappings are read-only rows, Lua lines in their own words', () => {
    const dim = rows.filter((r) => !r.ticked).map((r) => r.from);

    expect(dim).toEqual([
      'leader <space>',
      'set number',
      'set tabstop=2',
      'nnoremap <leader>w :w<CR>',
      'inoremap jk <Esc>',
      'leader ,',
      'vim.opt.relativenumber = true',
      'vim.keymap.set("n", "<leader>f", "<cmd>Telescope find_files<cr>")',
    ]);
  });

  const lines = (text: string, file: '.vimrc' | '.config/nvim/init.lua' = '.vimrc') =>
    vimRows({ [file]: text })
      .slice(1)
      .map((r) => [r.from, r.to?.value ?? r.note]);

  test.each([
    ['set autowriteall', 'onFocusChange'],
    ['set awa', 'onFocusChange'],
    ['set noautowriteall', 'off'],
    ['set noawa', 'off'],
  ])('%s: files.autoSave = %s', (line, value) => {
    expect(lines(line)).toEqual([[line, value]]);
  });

  test('vim.o / vim.opt autowriteall takes its value', () => {
    const lua = (l: string) => lines(l, '.config/nvim/init.lua');

    expect(lua('vim.o.autowriteall = false')).toEqual([['vim.o.autowriteall = false', 'off']]);
    expect(lua('vim.opt.autowriteall = true -- save')).toEqual([
      ['vim.opt.autowriteall = true', 'onFocusChange'],
    ]);
  });

  test.each([
    ['vim.cmd("colorscheme tokyonight-day")', 'tokyonight-day'],
    ["vim.cmd('colorscheme gruvbox')", 'gruvbox'],
    ['vim.cmd([[colorscheme catppuccin-latte]])', 'catppuccin-latte'],
    ['vim.cmd.colorscheme("rose-pine")', 'rose-pine'],
    ["vim.cmd.colorscheme 'kanagawa'", 'kanagawa'],
    ['pcall(vim.cmd, "colorscheme nord")', 'nord'],
    ['vim.api.nvim_command("colorscheme onedark")', 'onedark'],
  ])('%s names the colorscheme %s', (line, name) => {
    expect(lines(line, '.config/nvim/init.lua').map(([from]) => from)).toEqual([
      `colorscheme ${name}`,
    ]);
  });

  test('silent! colo and colorscheme at line start are read too', () => {
    expect(lines('silent! colorscheme desert\ncolo morning').map(([from]) => from)).toEqual([
      'colorscheme desert',
      'colorscheme morning',
    ]);
  });

  test('a light background picks the light built-in for a scheme its name does not tell', () => {
    expect(lines('colorscheme solarized\nset background=light')).toEqual([
      ['colorscheme solarized', 'islands-light'],
      ['set background=light', 'read for the colorscheme’s nearest built-in'],
    ]);
    expect(
      vimRows({ '.config/nvim/init.lua': 'vim.o.background = "light"\nvim.cmd("colo gruvbox")' })[2]
        ?.note,
    ).toBe('nearest built-in, background light');
    expect(lines('set bg=light\ncolorscheme tokyonight-night')[1]).toEqual([
      'colorscheme tokyonight-night',
      'islands-dark',
    ]);
  });

  test('each option of a multi-option set is its own row', () => {
    expect(lines('set number relativenumber\nset tabstop=4 shiftwidth=4 expandtab')).toEqual([
      ['set number', 'no match here: Neovim’s own option'],
      ['set relativenumber', 'no match here: Neovim’s own option'],
      ['set tabstop=4', 'no match here: Neovim’s own option'],
      ['set shiftwidth=4', 'no match here: Neovim’s own option'],
      ['set expandtab', 'no match here: Neovim’s own option'],
    ]);
    expect(lines('set guifont=JetBrains\\ Mono:h15 number')).toEqual([
      ['set guifont=JetBrains\\ Mono:h15', 'JetBrains Mono'],
      ['set guifont=JetBrains\\ Mono:h15', 15],
      ['set number', 'no match here: Neovim’s own option'],
    ]);
  });

  test('trailing comments are left out; comment lines give no row', () => {
    expect(lines('set clipboard=unnamed " system clipboard\n" set number')).toEqual([
      ['set clipboard=unnamed', 'no match here: Neovim’s own option'],
    ]);
    expect(
      lines('vim.o.tabstop = 2 -- two spaces\n-- vim.o.number = true', '.config/nvim/init.lua'),
    ).toEqual([['vim.o.tabstop = 2', 'no match here: Neovim’s own option']]);
  });

  test('the leader as Vim writes it: \\<Space> and a quoted space are <space>', () => {
    expect(lines('let mapleader = "\\<Space>"').map(([from]) => from)).toEqual(['leader <space>']);
    expect(
      lines('vim.g.mapleader = "\\\\"', '.config/nvim/init.lua').map(([from]) => from),
    ).toEqual(['leader \\']);
  });

  test('nvim_set_keymap and a mapping spread over lines are listed once each', () => {
    const lua = [
      'vim.api.nvim_set_keymap("n", "<C-s>", ":w<CR>", { noremap = true })',
      'vim.keymap.set("n", "<leader>e", function()',
      '  require("oil").open()',
      'end)',
    ].join('\n');

    expect(lines(lua, '.config/nvim/init.lua').map(([from]) => from)).toEqual([
      'vim.api.nvim_set_keymap("n", "<C-s>", ":w<CR>", { noremap = true })',
      'vim.keymap.set("n", "<leader>e", function() …',
    ]);
  });

  // #129: a Ctrl / Cmd / Alt / F-key mapping running one of the Keymap's actions is that key
  test('a chord mapping onto the Keymap; leader and plain-key mappings stay Vim’s own', () => {
    const vimrc = [
      'nnoremap <silent> <C-p> :Files<CR>',
      'nnoremap <D-B> :NERDTreeToggle<CR>',
      'nmap <C-x> :Foo<CR>',
      'nnoremap <leader>w :w<CR>',
      'inoremap jk <Esc>',
    ].join('\n');
    const lua = [
      'vim.api.nvim_set_keymap("n", "<C-s>", ":w<CR>", { noremap = true })',
      "vim.keymap.set('n', '<F2>', vim.lsp.buf.rename)",
      'vim.keymap.set("", "<C-S-f>", "<cmd>Telescope live_grep<cr>")',
      // ⌥ with a letter types its character here
      'vim.keymap.set("n", "<M-f>", "<cmd>Telescope live_grep<cr>")',
    ].join('\n');
    const rowsOf = (text: string, file: '.vimrc' | '.config/nvim/init.lua') =>
      vimRows({ [file]: text }).filter((r) => r.group === 'keys');

    expect(lines(vimrc)).toHaveLength(5);
    expect(rowsOf(vimrc, '.vimrc').map((r) => [r.bind, r.note])).toEqual([
      [{ key: '⌃P', action: 'goToFile' }, "every mode here, not only Vim's n mode"],
      [{ key: '⇧⌘B', action: 'projectTree' }, "every mode here, not only Vim's n mode"],
      [null, 'no match here: VimStorm has no action for :Foo<CR>'],
      [null, 'listed only: Neovim’s own mapping'],
      [null, 'listed only: Neovim’s own mapping'],
    ]);
    expect(rowsOf(lua, '.config/nvim/init.lua').map((r) => [r.bind, r.note])).toEqual([
      [{ key: '⌃S', action: 'saveAll' }, "every mode here, not only Vim's n mode"],
      [{ key: 'F2', action: 'rename' }, "every mode here, not only Vim's n mode"],
      [{ key: '⌃⇧F', action: 'findInFiles' }, null],
      [null, 'no match here: ⌥F types (VimStorm binds ⌃ / ⌘ keys, F-keys and ⌥ with a named key)'],
    ]);
  });

  test('a Lua block comment gives no rows; the lines after keep their numbers', () => {
    const rows = vimRows({
      '.config/nvim/init.lua':
        '--[[\nvim.cmd("colorscheme gruvbox")\n]]\n--[==[ set awa ]==] vim.o.awa = 1\n',
    }).slice(1);

    expect(rows.map((r) => [r.id, r.from, r.to?.value])).toEqual([
      ['.config/nvim/init.lua:4', 'vim.o.awa = 1', 'onFocusChange'],
    ]);
  });

  test.each([
    ['set awa!', 'no match here: a toggle sets no value to take'],
    ['set invawa', 'no match here: a toggle sets no value to take'],
    ['let &autowriteall = 1', 'onFocusChange'],
    ['let &g:awa = 0 " off', 'off'],
  ])('%s → %s', (line, said) => {
    expect(lines(line).map(([, v]) => v)).toEqual([said]);
  });

  test('a Lua table for guifont is no match, a long line is cut', () => {
    expect(lines('vim.opt.guifont = { "Fira Code", ":h14" }', '.config/nvim/init.lua')).toEqual([
      ['vim.opt.guifont = { "Fira Code", ":h14" }', 'no match here: a Lua table'],
    ]);
    const [, row] = vimRows({ '.vimrc': `nnoremap x ${'y'.repeat(5000)}` });

    expect(row?.from.length).toBeLessThanOrEqual(120);
  });

  test('a guifont list takes its first family; a size in between is rounded, said so', () => {
    expect(
      vimRows({ '.vimrc': 'set guifont=Fira\\ Code,Menlo:h14.5' })
        .slice(1)
        .map((r) => [r.to?.value, r.note]),
    ).toEqual([
      ['Fira Code', 'the first of 2'],
      [15, 'rounded from 14.5'],
    ]);
  });

  test.each([
    'set number background=light\ncolorscheme solarized',
    "let &background = 'light'\ncolorscheme solarized",
  ])('a light background read anywhere: %s', (text) => {
    expect(vimRows({ '.vimrc': text }).at(-1)?.to?.value).toBe('islands-light');
  });

  test('Lua tables are no mappings; short mapping commands are', () => {
    expect(
      vimRows({ '.config/nvim/init.lua': 'x = 1\n  i = { "a" },\nnn <leader>w :w<CR>\n' })
        .slice(1)
        .map((r) => r.from),
    ).toEqual(['nn <leader>w :w<CR>']);
  });

  test('set awa& is a reset, no value', () => {
    expect(lines('set awa&')).toEqual([
      ['set awa&', 'no match here: back to Vim’s default, no value to take'],
    ]);
  });
});
