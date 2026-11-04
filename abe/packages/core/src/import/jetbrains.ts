/**
 * A JetBrains IDE's config (#120: WebStorm first): the newest config folder's editor font, colour
 * scheme, the options that map one to one (#167: tabs, UI density and font, autosave, the
 * Project view) and the active keymap, as rows. The IDE writes only what differs from its
 * defaults, and those are the Feel `webstorm`'s, which picking WebStorm picks (with IdeaVim the
 * Feel `vim`, #214). A keymap's key on one of the Keymap's actions (`keys.ts`, #129) becomes that
 * key in your keys.json.
 */
import { chordText, jetbrainsKey } from '../theme/keymap';
import { type ImportRow } from './contract';
import { jetbrainsAction, jetbrainsActionWords, keyRow } from './keys';
import { mapped, roundedNote, unmatched } from './rows';

/** The JetBrains config root on a Mac, under the home folder. */
export const JETBRAINS_DIR = 'Library/Application Support/JetBrains';

/** Inside one IDE's folder: the files read. */
export const JETBRAINS_FILES = {
  font: 'options/editor-font.xml',
  scheme: 'options/colors.scheme.xml',
  /** UISettings: tabs, UI density, the UI font. */
  ui: 'options/ui.lnf.xml',
  /** GeneralSettings: autosave. */
  general: 'options/ide.general.xml',
  /** ProjectViewSharedSettings: the Project tool window. */
  projectView: 'options/projectView.xml',
  keymapPick: 'options/mac/keymap.xml',
  keymaps: 'keymaps',
} as const;

/** The IDE folder to read: WebStorm's newest, else any IDE's newest (`WebStorm2025.3`). */
export const pickIdeFolder = (names: readonly string[]): string | undefined => {
  const ides = names.flatMap((name) => {
    const m = /^([A-Za-z]+)(\d{4})\.(\d+)$/.exec(name);

    return m === null
      ? []
      : [{ name, product: m[1] ?? '', year: Number(m[2]), minor: Number(m[3]) }];
  });
  const newest = (list: typeof ides) =>
    [...list].sort((a, b) => b.year - a.year || b.minor - a.minor)[0]?.name;

  return newest(ides.filter((i) => i.product === 'WebStorm')) ?? newest(ides);
};

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** `<option name="X" value="Y" />` values in an options file. */
export const xmlOptions = (xml: string): Map<string, string> =>
  new Map(
    [...xml.matchAll(/<option\s+name="([^"]+)"\s+value="([^"]*)"/g)].map((m) => [
      m[1] ?? '',
      unescape(m[2] ?? ''),
    ]),
  );

const attr = (xml: string, tag: string, name: string) => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml);

  return m?.[1] === undefined ? undefined : unescape(m[1]);
};

/** A scheme's name as shown: `_@user_Darcula Contrast` → Darcula Contrast. */
const schemeName = (raw: string) => raw.replace(/^_@user_/, '');

const fontRows = (xml: string): ImportRow[] => {
  const o = xmlOptions(xml);
  const rows: ImportRow[] = [];
  const family = o.get('FONT_FAMILY');
  const size = o.get('FONT_SIZE_2D') ?? o.get('FONT_SIZE');
  const ligatures = o.get('USE_LIGATURES');

  if (family !== undefined)
    rows.push(
      mapped('FONT_FAMILY', 'settings', `Editor font: ${family}`, 'ui.font.editorFamily', family),
    );
  if (size !== undefined)
    rows.push(
      mapped(
        'FONT_SIZE',
        'settings',
        `Editor font size: ${size}`,
        'ui.font.editorSize',
        Math.round(Number(size)),
        roundedNote(Number(size)),
      ),
    );
  if (ligatures !== undefined)
    rows.push(
      mapped(
        'USE_LIGATURES',
        'settings',
        `Ligatures: ${ligatures}`,
        'ui.font.ligatures',
        ligatures === 'true',
      ),
    );

  return rows;
};

const schemeRow = (xml: string): ImportRow[] => {
  const raw = attr(xml, 'global_color_scheme', 'name');

  if (raw === undefined) return [];
  const name = schemeName(raw);
  const light = /light|intellij$/i.test(name);
  // the built-ins are WebStorm's Islands: that scheme is one exactly
  const exact = /^islands (dark|light)$/i.test(name);

  return [
    mapped(
      'scheme',
      'theme',
      `Color scheme: ${name}`,
      'ui.theme',
      light ? 'islands-light' : 'islands-dark',
      exact ? null : 'nearest built-in',
    ),
  ];
};

const bool = (v: string | undefined) => (v === undefined ? undefined : v === 'true');

/** A row for one option as WebStorm's Settings name it (`Tab limit: 20`), when the file has it. */
const optionRow = (
  o: Map<string, string>,
  option: string,
  label: string,
  key: Parameters<typeof mapped>[3],
  value: (raw: string) => unknown,
  note: string | null = null,
): ImportRow[] => {
  const raw = o.get(option);

  return raw === undefined
    ? []
    : [mapped(option, 'settings', `${label}: ${raw}`, key, value(raw), note)];
};

/** The UI font: WebStorm's own unless "Use custom font" is on, then its face and size. */
const uiFontRows = (o: Map<string, string>): ImportRow[] => {
  const face = o.get('FONT_FACE');
  const size = o.get('FONT_SIZE_2D') ?? o.get('FONT_SIZE');

  if (bool(o.get('OVERRIDE_NONIDEA_LAF_FONTS')) !== true)
    return face === undefined
      ? []
      : [
          unmatched(
            'FONT_FACE',
            'settings',
            `UI font: ${face}`,
            'not in use: Use custom font is off there',
          ),
        ];

  return [
    ...(face === undefined
      ? []
      : [mapped('FONT_FACE', 'settings', `UI font: ${face}`, 'ui.font.family', face)]),
    ...(size === undefined
      ? []
      : [
          mapped(
            'UI_FONT_SIZE',
            'settings',
            `UI font size: ${size}`,
            'ui.font.size',
            Math.round(Number(size)),
            roundedNote(Number(size)),
          ),
        ]),
  ];
};

/** `ui.lnf.xml`: the tab limit, preview tab, the modified mark, UI density and the UI font. */
const uiRows = (xml: string): ImportRow[] => {
  const o = xmlOptions(xml);

  return [
    ...optionRow(o, 'EDITOR_TAB_LIMIT', 'Tab limit', 'tabs.limit', Number),
    ...optionRow(o, 'OPEN_IN_PREVIEW_TAB_IF_POSSIBLE', 'Enable preview tab', 'tabs.preview', bool),
    ...optionRow(
      o,
      'MARK_MODIFIED_TABS_WITH_ASTERISK',
      'Mark modified (*)',
      'tabs.dirtyDot',
      bool,
      'a ● here, not *',
    ),
    ...optionRow(o, 'UI_DENSITY', 'UI density', 'ui.density', (v) => v.toLowerCase()),
    ...uiFontRows(o),
  ];
};

/**
 * `ide.general.xml`'s autosave as one `files.autoSave`: saving when idle is afterDelay; saving on
 * a switch to another app (on by default) is onFocusChange, off it is off.
 */
const generalRows = (xml: string): ImportRow[] => {
  const o = xmlOptions(xml);
  const idle = bool(o.get('autoSaveIfInactive'));
  const onSwitch = bool(o.get('autoSaveFiles'));

  if (idle === undefined && onSwitch === undefined) return [];
  const timeout = o.get('inactiveTimeout') ?? '15';
  const from = [
    ...(idle === undefined ? [] : [`if idle for ${timeout} s: ${String(idle)}`]),
    ...(onSwitch === undefined ? [] : [`on switching apps: ${String(onSwitch)}`]),
  ].join(' · ');
  const row = (value: string, note: string | null = null) =>
    mapped('autoSave', 'settings', `Save files ${from}`, 'files.autoSave', value, note);

  if (idle === true) return [row('afterDelay', 'here a second after typing stops')];

  return [row(onSwitch === false ? 'off' : 'onFocusChange')];
};

/** `projectView.xml`: select the opened file, open on a single click, compact folders. */
const projectViewRows = (xml: string): ImportRow[] => {
  const o = xmlOptions(xml);
  const folders = o.get('openDirectoriesWithSingleClick');

  return [
    ...optionRow(o, 'autoscrollFromSource', 'Always select opened file', 'tree.autoReveal', bool),
    ...optionRow(o, 'autoscrollToSource', 'Open files with single click', 'tree.singleClick', bool),
    ...optionRow(o, 'compactDirectories', 'Compact directories', 'tree.compactFolders', bool),
    ...(folders === undefined
      ? []
      : [
          unmatched(
            'openDirectoriesWithSingleClick',
            'settings',
            `Open directories with single click: ${folders}`,
            'no match here: a single click opens files here, folders open on their arrow',
          ),
        ]),
  ];
};

/** One keystroke as macOS writes it (`meta shift O` is ⇧⌘O), else as the file has it. */
const jetbrainsKeyWords = (keystroke: string): string => {
  const read = jetbrainsKey(keystroke);

  return 'chord' in read ? chordText(read.chord) : keystroke;
};

/**
 * One row per key the keymap file gives an action (`meta shift O`), the action's row once when
 * its keys are removed: a key on one of the Keymap's actions becomes yours in keys.json (#129).
 */
export const keymapRows = (xml: string): ImportRow[] => {
  const name = attr(xml, 'keymap', 'name') ?? 'keymap';

  // `<action id="X" />`: the keys the parent keymap gives X removed
  return [...xml.matchAll(/<action id="([^"]+)"\s*(?:\/>|>([\s\S]*?)<\/action>)/g)].flatMap((m) => {
    const id = m[1] ?? '';
    const keys = [
      ...(m[2] ?? '').matchAll(/first-keystroke="([^"]+)"(?:\s+second-keystroke="([^"]+)")?/g),
    ].map((k) => ({ first: k[1] ?? '', second: k[2] }));
    // keyed by mouse only: nothing a key does
    if (keys.length === 0 && m[2] !== undefined) return [];
    // #325: the action in words, its keys as macOS writes them (`ctrl #10000d6` is ⌃Ö)
    const action = jetbrainsActionWords(id);

    if (keys.length === 0)
      return [
        unmatched(
          `keys:${id}`,
          'keys',
          `${name}: ${action} = none (its keys removed)`,
          'no match here: VimStorm’s own keys stay',
        ),
      ];

    return keys.map((k) => {
      const text = k.second === undefined ? k.first : `${k.first}, ${k.second}`;
      const words = [k.first, ...(k.second === undefined ? [] : [k.second])]
        .map(jetbrainsKeyWords)
        .join(', ');

      return keyRow(
        `keys:${id}:${text}`,
        `${name}: ${action} = ${words}`,
        jetbrainsKey(k.first, k.second),
        jetbrainsAction(id),
        action,
      );
    });
  });
};

export type JetbrainsTexts = {
  /** The IDE folder read (`WebStorm2025.3`), none when no IDE was found. */
  ide?: string;
  font?: string;
  scheme?: string;
  /** `ui.lnf.xml`, `ide.general.xml`, `projectView.xml`. */
  ui?: string;
  general?: string;
  projectView?: string;
  /** The active keymap's file. */
  keymap?: string;
  /** IdeaVim in use (`~/.ideavimrc` or the IDE's IdeaVIM plugin): Vim mode stays on (#131). */
  ideavim?: string;
};

/** The rows a JetBrains IDE brings: the Feel first, the font, the scheme, the keymap's actions. */
export const jetbrainsRows = (t: JetbrainsTexts): ImportRow[] => [
  // IdeaVim in use picks the Feel vim (#214): WebStorm's switches and Cmd keys, stock Vim keys
  t.ideavim === undefined
    ? mapped(
        'feel',
        'feel',
        t.ide ?? 'WebStorm',
        'ui.feel',
        'webstorm',
        'Vim mode off, its tree, tabs and save switches',
      )
    : mapped(
        'feel',
        'feel',
        t.ide ?? 'WebStorm',
        'ui.feel',
        'vim',
        'WebStorm’s tree, tabs, save switches and ⌘ keys, stock Vim keys h j k l',
      ),
  ...(t.ideavim === undefined
    ? []
    : [
        mapped(
          'ideavim',
          'settings',
          `IdeaVim: ${t.ideavim}`,
          'editor.vim',
          true,
          'Vim mode on, stock Vim keys h j k l',
        ),
      ]),
  ...(t.font === undefined ? [] : fontRows(t.font)),
  ...(t.scheme === undefined ? [] : schemeRow(t.scheme)),
  ...(t.ui === undefined ? [] : uiRows(t.ui)),
  ...(t.general === undefined ? [] : generalRows(t.general)),
  ...(t.projectView === undefined ? [] : projectViewRows(t.projectView)),
  ...(t.keymap === undefined ? [] : keymapRows(t.keymap)),
];

/** The active keymap's name in `options/mac/keymap.xml` (none: the IDE's default). */
export const activeKeymap = (xml: string): string | undefined => attr(xml, 'active_keymap', 'name');
