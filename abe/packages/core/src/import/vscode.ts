/**
 * VS Code's config (#120): `settings.json` (with comments), `keybindings.json` and the colour
 * theme it names, as rows onto this app's settings. Picking VS Code picks the Feel `vscode`
 * first; your own `settings.json` values then set the same switches. A keybinding whose command
 * is one of the Keymap's actions (`keys.ts`, #129) becomes that key in your keys.json.
 */
import { type ImportRow } from './contract';
import { isBlankJsonc, type JsoncRead, readJsonc } from './jsonc';
import { vscodeKey } from '../theme/keymap';
import { keyRow, vscodeAction } from './keys';
import { mapped, roundedNote, sourceText, unmatched } from './rows';

/** Where VS Code keeps its user config on a Mac, under the home folder. */
export const VSCODE_FILES = {
  settings: 'Library/Application Support/Code/User/settings.json',
  keybindings: 'Library/Application Support/Code/User/keybindings.json',
} as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first family of a CSS font list, unquoted: `Menlo, 'Courier New', monospace` → Menlo. */
const firstFamily = (list: string) => {
  const families = list.split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, ''));

  return { first: families[0] ?? '', more: families.length - 1 };
};

/** The built-in nearest a VS Code colour theme, by its name. */
export const nearestTheme = (name: string): { slug: string; exact: boolean } => {
  if (/^(default )?dark modern$/i.test(name)) return { slug: 'dark-modern', exact: true };
  if (/light/i.test(name)) return { slug: 'islands-light', exact: false };
  if (/^(default )?dark\+?$|^visual studio dark$/i.test(name))
    return { slug: 'dark-modern', exact: false };

  return { slug: 'islands-dark', exact: false };
};

const AUTO_SAVE: Readonly<Record<string, string>> = {
  off: 'off',
  afterDelay: 'afterDelay',
  onFocusChange: 'onFocusChange',
  onWindowChange: 'onFocusChange',
};

const OPEN_MODE: Readonly<Record<string, boolean>> = { singleClick: true, doubleClick: false };

const BADGES = 'explorer.decorations.badges';
const COLORS = 'explorer.decorations.colors';

/**
 * `explorer.decorations.badges` and `.colors` (both on by default) as one `tree.decorations`:
 * letters while badges are on, else colours; here the colours always show.
 */
const decorationsRow = (all: Readonly<Record<string, unknown>>): ImportRow => {
  const keys = [BADGES, COLORS].filter((k) => k in all);
  const from = keys.map((k) => `${k}: ${sourceText(all[k])}`).join(' · ');
  const badges = all[BADGES] ?? true;
  const colors = all[COLORS] ?? true;
  const id = keys[0] ?? BADGES;

  if (typeof badges !== 'boolean' || typeof colors !== 'boolean')
    return unmatched(id, 'settings', from, `tree.decorations takes no ${sourceText(badges)}`);
  if (badges)
    return mapped(
      id,
      'settings',
      from,
      'tree.decorations',
      'letters',
      colors ? null : 'the colours stay here',
    );

  return mapped(
    id,
    'settings',
    from,
    'tree.decorations',
    'colors',
    colors ? null : 'no tree without colours here',
  );
};

const TERMINAL_FONT: Readonly<Record<string, string>> = {
  'terminal.integrated.fontFamily': 'ui.font.editorFamily',
  'terminal.integrated.fontSize': 'ui.font.editorSize',
};

/** A row for one entry of `settings.json`. */
const settingRow = (
  key: string,
  value: unknown,
  all: Readonly<Record<string, unknown>>,
): ImportRow => {
  const from = `${key}: ${sourceText(value)}`;
  const row = (to: Parameters<typeof mapped>[3], v: unknown, note: string | null = null) =>
    mapped(key, 'settings', from, to, v, note);

  switch (key) {
    case 'editor.fontFamily': {
      if (typeof value !== 'string') break;
      const { first, more } = firstFamily(value);

      return row('ui.font.editorFamily', first, more > 0 ? `the first of ${more + 1}` : null);
    }
    case 'editor.fontSize':
      return typeof value === 'number'
        ? row('ui.font.editorSize', Math.round(value), roundedNote(value))
        : row('ui.font.editorSize', value);
    case 'editor.fontLigatures':
      // a string names the font features: ligatures on
      return row('ui.font.ligatures', typeof value === 'string' ? value !== 'false' : value);
    case 'workbench.colorTheme': {
      if (typeof value !== 'string') break;
      const near = nearestTheme(value);

      return mapped(
        key,
        'theme',
        from,
        'ui.theme',
        near.slug,
        near.exact ? null : 'nearest built-in',
      );
    }
    case 'files.autoSave':
      return row(
        'files.autoSave',
        typeof value === 'string' ? (AUTO_SAVE[value] ?? value) : value,
        value === 'onWindowChange' ? 'saves when the editor loses focus too' : null,
      );
    case 'workbench.editor.enablePreview':
      return row('tabs.preview', value);
    case 'explorer.autoReveal':
      // `focusNoScroll` selects without scrolling: here it scrolls too
      return row(
        'tree.autoReveal',
        value === 'focusNoScroll' ? true : value,
        value === 'focusNoScroll' ? 'scrolls too' : null,
      );
    case 'explorer.compactFolders':
      return row('tree.compactFolders', value);
    case 'workbench.list.openMode':
      return row(
        'tree.singleClick',
        typeof value === 'string' ? (OPEN_MODE[value] ?? value) : value,
      );
    case BADGES:
    case COLORS:
      return decorationsRow(all);
    case 'terminal.integrated.fontFamily':
    case 'terminal.integrated.fontSize':
      return unmatched(
        key,
        'settings',
        from,
        `no match here: the terminal has the editor font (${TERMINAL_FONT[key] ?? ''})`,
      );
    case 'workbench.editor.limit.enabled': {
      if (value === false) return row('tabs.limit', null);
      const limit = all['workbench.editor.limit.value'];

      return limit === undefined
        ? row('tabs.limit', 10)
        : mapped(
            key,
            'settings',
            `${from} · workbench.editor.limit.value: ${sourceText(limit)}`,
            'tabs.limit',
            limit,
          );
    }
    case 'workbench.editor.limit.value':
      if (all['workbench.editor.limit.enabled'] === undefined)
        return unmatched(key, 'settings', from, 'a limit only with workbench.editor.limit.enabled');
      break;
    case 'editor.minimap.enabled':
      return row('editor.minimap', value);
    default:
      break;
  }

  return unmatched(key, 'settings', from);
};

/**
 * `workbench.editor.limit.value` beside `.enabled` is that row's, `.decorations.colors` beside
 * `.badges` too: listed once.
 */
const folded = (key: string, all: Readonly<Record<string, unknown>>) =>
  (key === 'workbench.editor.limit.value' && all['workbench.editor.limit.enabled'] !== undefined) ||
  (key === COLORS && BADGES in all);

const settingRows = (doc: Readonly<Record<string, unknown>>): ImportRow[] => {
  const keys = Object.keys(doc);
  const vim = keys.filter((k) => k.startsWith('vim.'));
  const languages = keys.filter((k) => /^\[.+\]$/.test(k));
  const rows = keys
    .filter((k) => !k.startsWith('vim.') && !languages.includes(k) && !folded(k, doc))
    .map((k) => settingRow(k, doc[k], doc));

  return [
    ...rows,
    ...(languages.length === 0
      ? []
      : [unmatched('[language]', 'settings', `${languages.join(' ')}: per-language settings`)]),
    ...(vim.length === 0
      ? []
      : [
          // VSCodeVim in use: Vim mode stays on (#131), with stock Vim keys (#214)
          mapped(
            'vim.*',
            'settings',
            `VSCodeVim: ${vim.length} setting${vim.length === 1 ? '' : 's'}`,
            'editor.vim',
            true,
            'Vim mode on, stock Vim keys h j k l',
          ),
        ]),
  ];
};

const keyRows = (doc: unknown): ImportRow[] =>
  (Array.isArray(doc) ? doc : []).flatMap((b): ImportRow[] => {
    if (!isObject(b) || typeof b.key !== 'string' || typeof b.command !== 'string') return [];
    const when = typeof b.when === 'string' ? ` when ${b.when}` : '';
    // `-command` takes the key off that command
    const from = b.command.startsWith('-')
      ? `${b.key} removed from ${b.command.slice(1)}${when}`
      : `${b.key} → ${b.command}${when}`;

    const id = `keys:${b.key}:${b.command}`;

    // a removal leaves VimStorm's keys as they are: no key of yours to write
    return [
      b.command.startsWith('-')
        ? unmatched(id, 'keys', from, 'no match here: VimStorm’s own keys stay')
        : keyRow(
            id,
            from,
            vscodeKey(b.key),
            vscodeAction(b.command),
            b.command,
            typeof b.when === 'string' ? `everywhere here, not only when ${b.when}` : null,
          ),
    ];
  });

export type VscodeTexts = { settings?: string; keybindings?: string };

/** Each file read, none when it was not there: `settings.json` an object, keybindings an array. */
export type VscodeRead = { settings?: JsoncRead; keybindings?: JsoncRead };

const readAs = (text: string, empty: unknown, want: 'object' | 'array'): JsoncRead => {
  // VS Code reads a file with nothing in it (comments at most) as no settings
  if (isBlankJsonc(text)) return { doc: empty };
  const read = readJsonc(text);

  if ('error' in read) return { error: `not JSON: ${read.error}` };
  if (want === 'object' ? !isObject(read.doc) : !Array.isArray(read.doc))
    return { error: `not an ${want}` };

  return read;
};

export const readVscode = (texts: VscodeTexts): VscodeRead => ({
  ...(texts.settings === undefined ? {} : { settings: readAs(texts.settings, {}, 'object') }),
  ...(texts.keybindings === undefined
    ? {}
    : { keybindings: readAs(texts.keybindings, [], 'array') }),
});

const docOf = (read: JsoncRead | undefined): unknown =>
  read !== undefined && 'doc' in read ? read.doc : undefined;

/** The rows VS Code's files bring: the Feel first, then each setting, the theme, each key. */
export const vscodeRowsOf = (read: VscodeRead): ImportRow[] => {
  const settings = docOf(read.settings);

  return [
    mapped(
      'feel',
      'feel',
      'VS Code',
      'ui.feel',
      'vscode',
      'Vim mode off, its tree, tabs and save switches',
    ),
    ...settingRows(isObject(settings) ? settings : {}),
    ...keyRows(docOf(read.keybindings)),
  ];
};

export const vscodeRows = (texts: VscodeTexts): ImportRow[] => vscodeRowsOf(readVscode(texts));
