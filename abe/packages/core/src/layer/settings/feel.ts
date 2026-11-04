/**
 * Feel profiles (#121, #214): `ui.feel` picks a bundle of behaviour switches (VimStorm, WebStorm,
 * VS Code or Vim). The bundle is the value a key takes when no Layer writes it: the merge starts each
 * key from its Feel's value instead of core's default, so a switch you (or the repo) set wins
 * over the Feel.
 */
import { z } from 'zod';
import { KeyBind } from '../../theme/keymap';
import { type Feel, type SettingKey, type Settings, SettingsSchema } from './keys';

/**
 * The keys a Feel sets: the behaviour switches (the keymap joins when it lands). Never the theme
 * (#345): dark or light is Appearance › Theme's alone, so a Feel switch is no second theme switch.
 */
export const FEEL_KEYS = [
  'tree.autoReveal',
  'tree.singleClick',
  'tree.decorations',
  'tree.compactFolders',
  'tabs.limit',
  'tabs.dirtyDot',
  'tabs.preview',
  'files.autoSave',
  'editor.minimap',
  'editor.vim',
] as const satisfies readonly SettingKey[];
type FeelKey = (typeof FEEL_KEYS)[number];

type Bundle = { readonly [K in FeelKey]: Settings[K] };

/** VimStorm today: WebStorm's behaviour with IdeaVim's keys. */
const VIMSTORM: Bundle = {
  'tree.autoReveal': false,
  'tree.singleClick': false,
  'tree.decorations': 'colors',
  'tree.compactFolders': false,
  'tabs.limit': 10,
  'tabs.dirtyDot': false,
  'tabs.preview': false,
  'files.autoSave': 'onFocusChange',
  'editor.minimap': false,
  'editor.vim': true,
};

const BUNDLES: Readonly<Record<Feel, Bundle>> = {
  vimstorm: VIMSTORM,
  // WebStorm without IdeaVim (#131): VimStorm's switches, Vim mode off.
  webstorm: { ...VIMSTORM, 'editor.vim': false },
  // Stock Vim (#214): VimStorm's switches with Vim mode on; the editor's keys are Vim's own (h j k l,
  // no leader `,`) and your `~/.config/nvim` loads on top (`nvim/lua/config/feel_keys.lua`).
  vim: VIMSTORM,
  vscode: {
    'tree.autoReveal': true,
    'tree.singleClick': true,
    'tree.decorations': 'letters',
    'tree.compactFolders': true,
    'tabs.limit': null,
    'tabs.dirtyDot': true,
    'tabs.preview': true,
    'files.autoSave': 'off',
    'editor.minimap': true,
    'editor.vim': false,
  },
};

/** The values a Feel sets, by key. */
export const feelBundle = (feel: Feel): Partial<Settings> => BUNDLES[feel];

const isFeelKey = (key: SettingKey): key is FeelKey => FEEL_KEYS.some((k) => k === key);

/** Where the merge starts `key` from under `feel`: the Feel's value, else core's default. */
export const feelStart = (feel: Feel, key: SettingKey, core: unknown): unknown =>
  isFeelKey(key) ? BUNDLES[feel][key] : core;

/** The switches the shell honours, grouped as the bridge's `feel` effect carries them. */
const shape = SettingsSchema.shape;

export const FeelSwitches = z.strictObject({
  feel: shape['ui.feel'],
  tree: z.strictObject({
    autoReveal: shape['tree.autoReveal'],
    singleClick: shape['tree.singleClick'],
    decorations: shape['tree.decorations'],
    compactFolders: shape['tree.compactFolders'],
  }),
  tabs: z.strictObject({
    limit: shape['tabs.limit'],
    dirtyDot: shape['tabs.dirtyDot'],
    preview: shape['tabs.preview'],
  }),
  files: z.strictObject({ autoSave: shape['files.autoSave'] }),
  /** The minimap at each editor split's right (#122); Vim mode (#131): off, always typing. */
  editor: z.strictObject({ minimap: shape['editor.minimap'], vim: shape['editor.vim'] }),
  /** The Chat column (#119): shown when a window starts, and its width. */
  chat: z.strictObject({ openByDefault: shape['chat.openByDefault'], width: shape['chat.width'] }),
  /** Your keys (#129, your Layer's keys.json): each does a Keymap action, over any Feel's keys. */
  keys: z.array(KeyBind),
});
export type FeelSwitches = z.infer<typeof FeelSwitches>;

export const feelOf = (s: Settings, keys: readonly KeyBind[] = []): FeelSwitches => ({
  feel: s['ui.feel'],
  tree: {
    autoReveal: s['tree.autoReveal'],
    singleClick: s['tree.singleClick'],
    decorations: s['tree.decorations'],
    compactFolders: s['tree.compactFolders'],
  },
  tabs: { limit: s['tabs.limit'], dirtyDot: s['tabs.dirtyDot'], preview: s['tabs.preview'] },
  files: { autoSave: s['files.autoSave'] },
  editor: { minimap: s['editor.minimap'], vim: s['editor.vim'] },
  chat: { openByDefault: s['chat.openByDefault'], width: s['chat.width'] },
  keys: [...keys],
});

const word = (v: boolean | string | number | null): string => {
  if (typeof v === 'boolean') return v ? 'on' : 'off';

  return v === null ? 'none' : String(v);
};

const group = (o: Readonly<Record<string, boolean | string | number | null>>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${word(v)}`)
    .join(' · ');

/** `abe settings feel`'s text: the Feel, then each group's switches. */
export const feelText = (d: FeelSwitches): string =>
  [
    `feel   ${d.feel}`,
    `tree   ${group(d.tree)}`,
    `tabs   ${group(d.tabs)}`,
    `files  ${group(d.files)}`,
    `editor ${group(d.editor)}`,
    `chat   ${group(d.chat)}`,
    `keys   ${d.keys.length === 0 ? 'none' : d.keys.map((k) => `${k.key} ${k.action}`).join(' · ')}`,
    '',
  ].join('\n');
