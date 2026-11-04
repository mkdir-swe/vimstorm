/**
 * The Keymap catalogue (#108 S5), the part `abe settings import` needs (#129): VimStorm's actions a
 * key of yours can be bound to, your Layer's `keys.json` (a key → its action) and the bindings the
 * shell applies (the `feel` effect's `keys`). Each action is what one of VimStorm's own keys does
 * in the editor: a key of yours does what that key's map does (`config/keys.lua`). Keys are written
 * as macOS shows them, modifiers in Apple's order: `⌃⌥⇧⌘P`.
 */
import { z } from 'zod';

/** One action: its name, VimStorm's key for it, and that key as nvim reads it (its map does it). */
type KeymapAction = { title: string; key: string; nvim: string };

export const KEYMAP_ACTIONS = {
  goToFile: { title: 'Go to File', key: '⌘O', nvim: '<D-o>' },
  findInFiles: { title: 'Find in Files', key: '⇧⌘F', nvim: '<D-S-f>' },
  find: { title: 'Find', key: '⌘F', nvim: '<D-f>' },
  replace: { title: 'Replace in File', key: '⌘R', nvim: '<D-r>' },
  saveAll: { title: 'Save All', key: '⌘S', nvim: '<D-s>' },
  recentProjects: { title: 'Recent Projects', key: '⇧⌘O', nvim: '<D-S-o>' },
  projectTree: { title: 'Project tool window', key: '⌘1', nvim: '<D-1>' },
  editor: { title: 'The open file', key: '⌘2', nvim: '<D-2>' },
  newTerminal: { title: 'New terminal tab', key: '⇧⌘T', nvim: '<D-S-t>' },
  goToDeclaration: { title: 'Go to Declaration or Usages', key: '⌘B', nvim: '<D-b>' },
  quickDefinition: { title: 'Quick Definition', key: '⌘L', nvim: '<D-l>' },
  rename: { title: 'Rename', key: '⇧F6', nvim: '<S-F6>' },
  reformat: { title: 'Reformat Code', key: '⌥⌘L', nvim: '<M-D-l>' },
  contextActions: { title: 'Show Context Actions', key: '⌥⏎', nvim: '<M-CR>' },
  commentLine: { title: 'Comment with Line Comment', key: '⌘/', nvim: '<D-/>' },
  duplicate: { title: 'Duplicate Line or Selection', key: '⌘D', nvim: '<D-d>' },
  extendSelection: { title: 'Extend Selection', key: '⌘W', nvim: '<D-w>' },
  shrinkSelection: { title: 'Shrink Selection', key: '⇧⌘W', nvim: '<D-S-w>' },
  nextTab: { title: 'Next Tab', key: '⌃→', nvim: '<C-Right>' },
  previousTab: { title: 'Previous Tab', key: '⌃←', nvim: '<C-Left>' },
  commit: { title: 'Commit', key: '⌘K', nvim: '<D-k>' },
  push: { title: 'Push', key: '⇧⌘K', nvim: '<D-S-k>' },
  revealInFinder: { title: 'Reveal in Finder', key: '⌃⇧⌘O', nvim: '<C-D-S-o>' },
  rollbackLines: { title: 'Rollback Lines', key: '⌥⌘Z', nvim: '<M-D-z>' },
} as const satisfies Readonly<Record<string, KeymapAction>>;

export type KeymapActionId = keyof typeof KEYMAP_ACTIONS;

export const isKeymapAction = (id: string): id is KeymapActionId =>
  Object.prototype.hasOwnProperty.call(KEYMAP_ACTIONS, id);

/** A catalogue action's id, read. */
export const KeymapActionName = z.string().refine(isKeymapAction, 'an action of the Keymap');

/**
 * The keys VimStorm's window takes before the editor or swallows (`app/src/input/keymap.rs`'
 * `Window`, `App` and `Ignored` rows: the Chat column, Code's bottom panel, the rail and the pages, the
 * jumps, Close Project, Hide, the font size, ⌘E …): a key of yours there would never reach its action. (⌘T
 * is the bottom panel's Terminal under every Feel but vscode, so it is kept from all.)
 */
export const WINDOW_KEYS: readonly string[] = [
  '⌘E',
  // the pane keys (app/src/shell/pane_key.rs: shown with the keys, the keys, again hidden): the Project tree,
  // Code's bottom panel's Git (⌘J the panel shown / hidden), Chat in its mode; Chat / Claude Code
  '⌘1',
  '⌘3',
  '⌘J',
  '⌘4',
  '⌃⌘←',
  '⌃⌘→',
  '⇧⌘D',
  // the rail: the workspace above / below, the Board, into the card, Abe and back
  '⌘↑',
  '⌘↓',
  '⌘←',
  '⌘→',
  '⌘§',
  // a workspace's pages (Code, Run, Card), the bottom panel's Terminal
  '⌃1',
  '⌃2',
  '⌃3',
  '⌃`',
  // the tile's Chat docked ↔ maximized, hidden ↔ shown
  '⇧⌘2',
  '⌥⌘2',
  '⌥⌘A',
  '⌘,',
  '⌘T',
  '⌘Q',
  '⌥⌘⏎',
  '⌃L',
  '⌃⌥L',
  '⌘H',
  '⌥⌘H',
  '⌘M',
  '⌃⌘F',
  '⌃⌘=',
  '⌃⌘+',
  '⌃⌘-',
  '⌘0',
];

// ---------------------------------------------------------------- keys

type Mod = 'ctrl' | 'alt' | 'shift' | 'cmd';

/** A key as a chord: its modifiers and the key (`P`, `7`, `F12`, `⏎`, `→`, `/`). */
export type Chord = { mods: ReadonlySet<Mod>; key: string };

const GLYPH: Readonly<Record<Mod, string>> = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' };
const ORDER: readonly Mod[] = ['ctrl', 'alt', 'shift', 'cmd'];

/** A chord as macOS writes it: `⌃⇧⌘P`. */
export const chordText = (c: Chord): string =>
  `${ORDER.filter((m) => c.mods.has(m))
    .map((m) => GLYPH[m])
    .join('')}${c.key}`;

/** The named keys: the glyph a chord writes, nvim's name. */
const NAMED: Readonly<Record<string, string>> = {
  '⏎': 'CR',
  '⎋': 'Esc',
  '⇥': 'Tab',
  Space: 'Space',
  '⌫': 'BS',
  '⌦': 'Del',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
  Home: 'Home',
  End: 'End',
  PgUp: 'PageUp',
  PgDn: 'PageDown',
};

/** Punctuation nvim names otherwise. */
const NVIM_PUNCT: Readonly<Record<string, string>> = { '\\': 'Bslash', '<': 'lt', '|': 'Bar' };

/**
 * Where the Swedish layout types a key with other modifiers (the app sends the keys pressed:
 * `\` is ⌥⇧7, `[` ⌥8, `]` ⌥9, `` ` `` ⇧´, `/` ⇧7, `=` ⇧0).
 */
const SWEDISH: Readonly<Record<string, { mods: readonly Mod[]; key: string }>> = {
  '\\': { mods: ['alt', 'shift'], key: '7' },
  '[': { mods: ['alt'], key: '8' },
  ']': { mods: ['alt'], key: '9' },
  '`': { mods: ['shift'], key: '´' },
  '/': { mods: ['shift'], key: '7' },
  '=': { mods: ['shift'], key: '0' },
  ';': { mods: ['shift'], key: ',' },
};

/** nvim's modifier order, as `app/src/input/keys.rs` builds it: C-M-D-S. */
const notation = (mods: ReadonlySet<Mod>, key: string): string => {
  const prefix = `${mods.has('ctrl') ? 'C-' : ''}${mods.has('alt') ? 'M-' : ''}${
    mods.has('cmd') ? 'D-' : ''
  }${mods.has('shift') ? 'S-' : ''}`;

  return prefix === '' && key.length === 1 ? key : `<${prefix}${key}>`;
};

/**
 * A key the app hands nvim as a key, not text for the editor: one with ⌃ or ⌘, an F-key, or a
 * named key (⏎, ↑, ⇥ …) with ⌥ (`app/src/input/keys.rs`: ⌥ with a character is the character it
 * types; plain and ⇧ keys type).
 */
export const bindable = (c: Chord): boolean =>
  c.mods.has('ctrl') ||
  c.mods.has('cmd') ||
  /^F([1-9]|1[0-9])$/.test(c.key) ||
  (c.key in NAMED && c.mods.has('alt'));

/** A chord as the app sends it to nvim: the US key's name, and the Swedish layout's where it differs. */
export const nvimKeys = (c: Chord): string[] => {
  const named = NAMED[c.key] ?? NVIM_PUNCT[c.key];
  const key = named ?? (/^\p{Lu}$/u.test(c.key) ? c.key.toLowerCase() : c.key);
  const sv = SWEDISH[c.key];

  return [
    notation(c.mods, key),
    ...(sv === undefined ? [] : [notation(new Set([...c.mods, ...sv.mods]), sv.key)]),
  ];
};

/** Java's extended key code a JetBrains keymap writes a key with no `VK_` name as (#325). */
const EXTENDED = 0x01000000;

/**
 * A chord's key from its name in a source: a letter (å ä ö too), a digit, F1–F19, a named key,
 * punctuation, or JetBrains' `#10000d6` (Ö: the extended key code, 0x01000000 + the character).
 */
const keyOf = (name: string): string | undefined => {
  const code = /^#([0-9a-f]+)$/i.exec(name)?.[1];

  if (code !== undefined) {
    const n = Number.parseInt(code, 16) - EXTENDED;

    return n > 0 && n <= 0x10ffff ? keyOf(String.fromCodePoint(n)) : undefined;
  }
  // one key, one letter: ß's capital is two (SS), no key's name
  if (/^[\p{L}0-9]$/u.test(name))
    return name.toUpperCase().length === 1 ? name.toUpperCase() : undefined;
  if (/^f([1-9]|1[0-9])$/i.test(name)) return name.toUpperCase();
  if (name.length === 1 && "`-=+[]\\;',./".includes(name)) return name;

  return undefined;
};

// VS Code's and JetBrains' names for the named keys
const SOURCE_NAMED: Readonly<Record<string, string>> = {
  enter: '⏎',
  escape: '⎋',
  tab: '⇥',
  space: 'Space',
  backspace: '⌫',
  back_space: '⌫',
  delete: '⌦',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  page_up: 'PgUp',
  pagedown: 'PgDn',
  page_down: 'PgDn',
  // JetBrains' punctuation
  minus: '-',
  equals: '=',
  open_bracket: '[',
  close_bracket: ']',
  back_slash: '\\',
  semicolon: ';',
  quote: "'",
  comma: ',',
  period: '.',
  slash: '/',
  back_quote: '`',
};

const SOURCE_MODS: Readonly<Record<string, Mod>> = {
  cmd: 'cmd',
  meta: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/** One key from its parts (`['cmd', 'shift', 'p']`); none when a part is no modifier or key. */
const chordOf = (parts: readonly string[]): Chord | undefined => {
  const mods = new Set<Mod>();
  const last = parts.at(-1);

  for (const p of parts.slice(0, -1)) {
    const m = SOURCE_MODS[p.toLowerCase()];

    if (m === undefined) return undefined;
    mods.add(m);
  }
  if (last === undefined || last === '') return undefined;
  const key = SOURCE_NAMED[last.toLowerCase()] ?? keyOf(last);

  return key === undefined ? undefined : { mods, key };
};

/** What a source's key reads as: one chord, or why it is none here. */
export type ReadKey = { chord: Chord } | { none: string };

const TWO_KEYS = 'no match here: a two-key chord (VimStorm binds one key)';

/** VS Code's `cmd+shift+p` (`cmd+k cmd+s`: two keys, none here). */
export const vscodeKey = (key: string): ReadKey => {
  if (key.trim().includes(' ')) return { none: TWO_KEYS };
  const chord = chordOf(key.trim().split(/\+(?!$)/));

  return chord === undefined ? { none: `no match here: no key ${key} here` } : { chord };
};

/** JetBrains' `meta shift O` (a `second-keystroke`: two keys, none here). */
export const jetbrainsKey = (first: string, second?: string): ReadKey => {
  if (second !== undefined) return { none: TWO_KEYS };
  const chord = chordOf(first.trim().split(/\s+/));

  return chord === undefined ? { none: `no match here: no key ${first} here` } : { chord };
};

const VIM_MODS: Readonly<Record<string, Mod>> = {
  C: 'ctrl',
  M: 'alt',
  A: 'alt',
  D: 'cmd',
  S: 'shift',
};
const VIM_NAMED: Readonly<Record<string, string>> = {
  cr: '⏎',
  enter: '⏎',
  return: '⏎',
  esc: '⎋',
  tab: '⇥',
  space: 'Space',
  bs: '⌫',
  del: '⌦',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  bslash: '\\',
  lt: '<',
  bar: '|',
};

/**
 * A Vim mapping's lhs as one chord: `<C-p>`, `<D-S-p>`, `<M-x>`, `<F2>`; anything else (a leader
 * sequence, plain keys) is Vim's own, none here.
 */
export const vimKey = (lhs: string): ReadKey | undefined => {
  const m = /^<((?:[CMADS]-)*)([^>]+)>$/i.exec(lhs.trim());

  if (m === null) return undefined;
  const mods = new Set<Mod>();

  for (const p of (m[1] ?? '').split('-').filter((x) => x !== '')) {
    const mod = VIM_MODS[p.toUpperCase()];

    if (mod !== undefined) mods.add(mod);
  }
  const name = m[2] ?? '';
  const named = VIM_NAMED[name.toLowerCase()];
  const fkey = /^f([1-9]|1[0-9])$/i.test(name) ? name.toUpperCase() : undefined;
  const letter = /^[a-z]$/i.test(name) ? name : undefined;

  if (mods.size === 0 && fkey === undefined) return undefined;
  // <D-P> is ⌘⇧P (Ctrl letters have no case)
  if (letter !== undefined && letter !== letter.toLowerCase() && !mods.has('ctrl'))
    mods.add('shift');
  const key = named ?? fkey ?? (letter === undefined ? keyOf(name) : letter.toUpperCase());

  return key === undefined
    ? { none: `no match here: no key ${lhs} here` }
    : { chord: { mods, key } };
};

// ---------------------------------------------------------------- keys.json

/**
 * Your Layer's `keys.json`: a key (`⌘Y`) → its action (`goToFile`) or actions; any object reads
 * (Improve writes it too, `mapFileProblem`), each entry on its own.
 */
export const KeysDoc = z.record(z.string(), z.unknown());
export type KeysDoc = z.infer<typeof KeysDoc>;

/** A key's binding as the shell applies it: nvim's names for the key, and the action's key. */
export const KeyBind = z.strictObject({
  /** As keys.json writes it: `⌘E`. */
  key: z.string().min(1),
  action: z.string().min(1),
  /** The key as the app sends it to nvim (the US name, the Swedish layout's too). */
  lhs: z.array(z.string().min(1)),
  /** VimStorm's key for the action, as nvim reads it: its map does it. */
  does: z.string().min(1),
});
export type KeyBind = z.infer<typeof KeyBind>;

/** A keys.json key read back as a chord (`⌃⇧⌘P`, `⌥F12`, `⌘⏎`). */
export const chordOfText = (text: string): Chord | undefined => {
  const mods = new Set<Mod>();
  let rest = text;

  for (;;) {
    const mod = ORDER.find((m) => rest.startsWith(GLYPH[m]));

    if (mod === undefined) break;
    mods.add(mod);
    rest = rest.slice(GLYPH[mod].length);
  }
  const key =
    rest in NAMED || /^F([1-9]|1[0-9])$/.test(rest) || /^[A-Z0-9]$/.test(rest) ? rest : keyOf(rest);

  return key === undefined || rest === '' ? undefined : { mods, key };
};

/**
 * The bindings keys.json gives, in its order: each key that reads, reaches the editor and names a
 * catalogue action (the first of a list that does); the rest left out, one by one (the Keymap page
 * will say why).
 */
export const keyBinds = (doc: unknown): KeyBind[] => {
  const read = KeysDoc.safeParse(doc);

  if (!read.success) return [];

  return Object.entries(read.data).flatMap(([key, value]) => {
    const chord = chordOfText(key);
    const action = (Array.isArray(value) ? value : [value]).find(
      (a): a is KeymapActionId => typeof a === 'string' && isKeymapAction(a),
    );

    if (chord === undefined || action === undefined || !bindable(chord)) return [];
    if (WINDOW_KEYS.includes(chordText(chord))) return [];

    return [{ key, action, lhs: nvimKeys(chord), does: KEYMAP_ACTIONS[action].nvim }];
  });
};
