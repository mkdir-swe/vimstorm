/**
 * Vim / Neovim config (#120): `~/.vimrc`, `~/.config/nvim/init.vim` or `init.lua` read for what
 * maps onto a setting here (the font, write-on-switch, a colour scheme); the leader and the
 * leader / plain-key mappings are listed read-only: picking Vim picks the Feel `vim` (#214), stock
 * Vim keys with your `~/.config/nvim` loaded on top (its leader and mappings too; `~/.vimrc` is
 * not loaded); a Ctrl / Cmd / Alt / F-key mapping that runs one of the Keymap's actions becomes
 * that key in your keys.json (#129). A row shows the line as written, its comment left out.
 */
import { vimKey } from '../theme/keymap';
import { type ImportRow } from './contract';
import { keyRow, vimAction } from './keys';
import { mapped, roundedNote, unmatched } from './rows';

/** The files read, under the home folder, in order. */
export const VIM_FILES = ['.vimrc', '.config/nvim/init.vim', '.config/nvim/init.lua'] as const;

const OWN_OPTION = 'no match here: Neovim’s own option';
const OWN_MAPPING = 'listed only: Neovim’s own mapping';
/** A flag Vim script and `vim.o` write as a number. */
const FLAG: Readonly<Record<string, boolean>> = { '1': true, '0': false };
const TOGGLE = 'no match here: a toggle sets no value to take';
const RESET = 'no match here: back to Vim’s default, no value to take';

/** `set guifont=JetBrains\ Mono,Menlo:h14` → its first family, how many more, and its size. */
const guifont = (value: string): { family: string; more: number; size: number | undefined } => {
  const [families = '', ...opts] = value.split(':');
  const h = opts.find((o) => o.startsWith('h'));
  const [first = '', ...rest] = families.split(/(?<!\\),/);

  return {
    family: first.replace(/\\(.)/g, '$1').replace(/_/g, ' '),
    more: rest.length,
    size: h === undefined ? undefined : Number(h.slice(1)),
  };
};

/** `map`, `nnoremap`, and the short `no`, `nn`, `vn`, `xn`, `ino`, `nm`, `im` … */
const MAP = /^\s*(?:[nvxsoict]?(?:nore)?map|[nvxsoict]?no|[nvx]n|[nvxsoict]m)!?\s+(\S.*)$/;
const LUA_MAP = /^vim\.(?:keymap\.set|api\.nvim_(?:buf_)?set_keymap)\s*\(/;
/** `:set` and its short and local forms. */
const SET = /^(?:se|set|setg|setglobal|setl|setlocal)\s+(.+)$/;
/** One option of a `:set` line: `noawa`, `tabstop=4`, `path+=src`, `guifont=A\ B:h12`. */
const SET_ARG = /^(no|inv)?(\w+)(!|&)?(?:([-+^]?=|:)(.*))?$/;
const LUA_OPTION = /^vim\.(?:o|opt|opt_global|go|wo|bo)\.(\w+)\s*=\s*(.+)$/;
/** `let &autowriteall = 1`, `let &g:guifont = '…'`. */
const LET_OPTION = /^let\s+&(?:[gl]:)?(\w+)\s*=\s*("[^"]*"|'[^']*'|[^\s"]+)/;
/** A Lua block comment, `--[[ … ]]` or `--[==[ … ]==]`. */
const LUA_BLOCK = /--\[(=*)\[[\s\S]*?\]\1\]/g;
/** `colorscheme x`, `colo x`, `silent! colorscheme x`. */
const COLORSCHEME = /^(?:sil(?:ent)?!?\s+)?colo\w*\s+([\w.-]+)/;
/** `vim.cmd("colorscheme x")`, `vim.cmd([[colo x]])`, `pcall(vim.cmd, "…")`, `nvim_command`. */
const LUA_CMD_SCHEME =
  /vim\.(?:cmd|api\.nvim_command)\s*[(,]?\s*(?:["']|\[\[)\s*(?:sil(?:ent)?!?\s+)?colo\w*\s+([\w.-]+)/;
const LUA_SCHEME = /vim\.cmd\.colorscheme\s*[(,]?\s*(?:["']|\[\[)([\w.-]+)/;
const LEADER = /(?:^let\s+(?:g:)?|^vim\.g\.)mapleader\s*=\s*(["'])(.*?)\1/;

/** A Vim script line's trailing comment (`" …` after a space) left out; a mapping keeps its `"`. */
const vimComment = (line: string) => line.replace(/\s+".*$/, '');

/** A Lua line's trailing `-- …` left out, outside strings. */
const luaComment = (line: string) => {
  let quote: string | undefined;

  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);

    if (quote !== undefined) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (line.startsWith('--', i)) return line.slice(0, i).trimEnd();
  }

  return line;
};

/** A Lua value as Vim reads it: `true`, `2`, `"light"` → true, 2, light. */
const luaValue = (raw: string): string | boolean => {
  if (raw === 'true' || raw === 'false') return raw === 'true';

  return raw.replace(/^(["'])(.*)\1$/, '$2');
};

/** The leader as shown: a space, `\<Space>` or `<Space>` is `<space>`; `"\\"` is `\`. */
const leaderWord = (raw: string) => {
  const v = raw.replace(/\\\\/g, '\\');

  return v === ' ' || /^\\?<space>$/i.test(v) ? '<space>' : v;
};

type Background = 'light' | 'dark' | undefined;

/** The background a file ends on (`set bg=light`, `set nu background=light`, `let &bg = 'light'`, `vim.o.background = "light"`). */
const backgroundOf = (text: string): Background => {
  let bg: Background;

  for (const m of text.matchAll(
    /^\s*(?:(?:se|set|setg|setglobal|setl|setlocal)\s+(?:.*\s)?(?:background|bg)=|let\s+&(?:[gl]:)?(?:background|bg)\s*=\s*["']|vim\.(?:o|opt|go)\.background\s*=\s*["'])(light|dark)/gm,
  ))
    bg = m[1] === 'light' ? 'light' : 'dark';

  return bg;
};

const themeRow = (id: string, name: string, bg: Background): ImportRow => {
  const light = /light|day|latte|dawn/i.test(name);
  const dark = /dark|night|moon|storm|mocha|frappe|macchiato/i.test(name);
  const byBg = !light && !dark && bg === 'light';

  return mapped(
    id,
    'theme',
    `colorscheme ${name}`,
    'ui.theme',
    light || byBg ? 'islands-light' : 'islands-dark',
    byBg ? 'nearest built-in, background light' : 'nearest built-in',
  );
};

/** One option's rows, `from` as the line writes it. */
const optionRows = (
  id: string,
  from: string,
  name: string,
  value: string | boolean | undefined,
): ImportRow[] => {
  if (typeof value === 'string' && value.startsWith('{'))
    return [unmatched(id, 'settings', from, 'no match here: a Lua table')];
  if (name === 'guifont' && typeof value === 'string') {
    const font = guifont(value);

    return [
      mapped(
        `${id}:family`,
        'settings',
        from,
        'ui.font.editorFamily',
        font.family,
        font.more > 0 ? `the first of ${font.more + 1}` : null,
      ),
      ...(font.size === undefined
        ? []
        : [
            mapped(
              `${id}:size`,
              'settings',
              from,
              'ui.font.editorSize',
              Math.round(font.size),
              roundedNote(font.size),
            ),
          ]),
    ];
  }
  if (name === 'autowriteall' || name === 'awa') {
    if (value === undefined)
      return [unmatched(id, 'settings', from, from.endsWith('&') ? RESET : TOGGLE)];
    // Vim script and `vim.o` take 0 / 1 for a flag too
    const on = typeof value === 'string' ? (FLAG[value] ?? value) : value;

    if (typeof on === 'boolean')
      return [mapped(id, 'settings', from, 'files.autoSave', on ? 'onFocusChange' : 'off')];
  }
  if (name === 'background' || name === 'bg')
    return [unmatched(id, 'settings', from, 'read for the colorscheme’s nearest built-in')];

  return [unmatched(id, 'settings', from, OWN_OPTION)];
};

/** A `:set` line: each option its own row. */
const setRows = (id: string, args: string): ImportRow[] => {
  const words = args.split(/(?<!\\)\s+/).filter((w) => w !== '');

  return words.flatMap((word, n) => {
    const at = words.length === 1 ? id : `${id}:${n + 1}`;
    const m = SET_ARG.exec(word);

    if (m === null) return [unmatched(at, 'settings', `set ${word}`, OWN_OPTION)];
    const [, prefix, name = '', toggle, op, value = ''] = m;
    // `set awa` on, `set noawa` off, `set invawa` / `set awa!` a toggle (no value)
    const flag = toggle !== undefined || prefix === 'inv' ? undefined : prefix !== 'no';

    return optionRows(at, `set ${word}`, name, op === undefined ? flag : value);
  });
};

/** A mapping's keys, what it runs and its modes as Vim names them (`n`; `` all of `map`'s). */
type Mapping = { lhs: string; rhs: string; mode: string };

/** `nnoremap <silent> <C-p> :Files<CR>`: its mode, the special arguments left out. */
const vimMapping = (line: string, args: string): Mapping | undefined => {
  const command = /^\s*(\w+)/.exec(line)?.[1] ?? '';
  const mode = /^(?:map|no)/.test(command) ? '' : command.charAt(0);
  const rest = args.replace(/^(?:<(?:silent|buffer|nowait|expr|unique|script|special)>\s*)+/i, '');
  const m = /^(\S+)\s+(.+)$/.exec(rest);

  return m === null ? undefined : { lhs: m[1] ?? '', rhs: m[2] ?? '', mode };
};

/** `vim.keymap.set("n", "<C-p>", "<cmd>Files<cr>")`, `nvim_set_keymap('n', '<C-p>', …)`. */
const luaMapping = (line: string): Mapping | undefined => {
  const m = /\(\s*(\{[^}]*\}|(["'])[^"']*\2)\s*,\s*(["'])(.+?)\3\s*,\s*(.*)$/.exec(line);

  if (m === null) return undefined;
  // `"n"`, `{ "n", "x" }`, `""` (all of map's)
  const mode = (m[1] ?? '').replace(/[^a-z]/g, '');
  const rest = m[5] ?? '';
  // a string's own text, else what follows (a function, a require(…) call)
  const quoted = /^(["'])(.*?)\1/.exec(rest);

  return { lhs: m[4] ?? '', rhs: quoted === null ? rest : (quoted[2] ?? ''), mode };
};

/**
 * A mapping's row: a chord (`<C-p>`, `<D-s>`, `<F2>`) running one of the Keymap's actions becomes
 * that key in keys.json (#129); a leader or plain-key mapping is Vim's own, listed only.
 */
const mappingRow = (id: string, from: string, mapping: Mapping | undefined): ImportRow => {
  const key = mapping === undefined ? undefined : vimKey(mapping.lhs);

  if (mapping === undefined || key === undefined) return unmatched(id, 'keys', from, OWN_MAPPING);

  // VimStorm binds a key of yours in Normal, Insert and Visual mode alike
  const modes = mapping.mode === '' ? null : `every mode here, not only Vim's ${mapping.mode} mode`;

  return keyRow(id, from, key, vimAction(mapping.rhs), `action for ${mapping.rhs}`, modes);
};

/** One file's rows: each line that sets, maps or names something. */
export const vimLines = (file: string, raw: string): ImportRow[] => {
  // a Lua block comment is blanked, its lines kept so each line keeps its number
  const text = raw.replace(LUA_BLOCK, (c) => c.replace(/[^\n]/g, ' '));
  const bg = backgroundOf(text);

  return text.split('\n').flatMap((raw, i): ImportRow[] => {
    const trimmed = raw.trim();
    const id = `${file}:${i + 1}`;

    if (trimmed === '' || trimmed.startsWith('"') || trimmed.startsWith('--')) return [];
    const lua = luaComment(trimmed);
    const leader = LEADER.exec(lua);

    if (leader !== null)
      return [
        unmatched(
          id,
          'keys',
          `leader ${leaderWord(leader[2] ?? '')}`,
          'yours under the Feel vim (VimStorm’s is ,)',
        ),
      ];
    const set = SET.exec(vimComment(trimmed));

    if (set !== null) return setRows(id, set[1] ?? '');
    const option = LUA_OPTION.exec(lua);

    if (option !== null) return optionRows(id, lua, option[1] ?? '', luaValue(option[2] ?? ''));
    const letOption = LET_OPTION.exec(trimmed);

    if (letOption !== null)
      return optionRows(id, letOption[0], letOption[1] ?? '', luaValue(letOption[2] ?? ''));
    const scheme =
      COLORSCHEME.exec(vimComment(trimmed)) ?? LUA_CMD_SCHEME.exec(lua) ?? LUA_SCHEME.exec(lua);

    if (scheme !== null) return [themeRow(id, scheme[1] ?? '', bg)];
    if (LUA_MAP.test(lua)) {
      // a mapping spread over lines (`function()` … `end)`): its first line, cut
      const open = (lua.match(/\(/g) ?? []).length > (lua.match(/\)/g) ?? []).length;
      const from = open ? `${lua} …` : lua;

      return [mappingRow(id, from, luaMapping(lua))];
    }
    const map = MAP.exec(trimmed);

    return map === null ? [] : [mappingRow(id, trimmed, vimMapping(trimmed, map[1] ?? ''))];
  });
};

/** The rows a Vim / Neovim config brings: the Feel first, then each file's lines. */
export const vimRows = (
  texts: Readonly<Partial<Record<(typeof VIM_FILES)[number], string>>>,
): ImportRow[] => [
  mapped(
    'feel',
    'feel',
    'Vim / Neovim',
    'ui.feel',
    'vim',
    'stock Vim keys h j k l, your ~/.config/nvim loaded on top',
  ),
  ...VIM_FILES.flatMap((f) => {
    const text = texts[f];

    return text === undefined ? [] : vimLines(f, text);
  }),
];
