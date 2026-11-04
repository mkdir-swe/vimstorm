/**
 * The Settings dialog's state (#345 split of `settings.ts`): its pages' names, `SettingsState` with
 * its one `Mode` (edit, propose, remove, add), the reads it keeps, and the helpers every part
 * shares. A change saves when it is made: `changes` holds each one until the rows read after its
 * write show it, `undo` the saves ⌘Z takes back.
 */
import {
  type BrowserListData,
  type ImportSource,
  type LoginStatusData,
  type SettingKey,
  type SettingsDialogName,
  type SettingsListData,
  type SettingsImportData,
  type SettingsProblemsData,
  type ThemeListData,
  type ThemeShowData,
  type SourcesData,
  type ToolsCheckData,
} from '@abe/core';
import { type Command } from '../runtime/runtime';
import { type ProposeFocus, type SettingsFocus } from './settings-components';

/**
 * The screen's name: the bridge's `open`, Command mode's `:settings` and `abe ui render` reach it
 * by it (core's `SETTINGS_DIALOG`, which `abe help ui render` names).
 */
export const SETTINGS_SCREEN = 'settings' satisfies SettingsDialogName;

/** Logins & tools: its rows are the checks', not settings. */
export const LOGINS_PAGE = 'logins-tools';
/** The pages whose theme list reads `abe theme list` (#108 S4). */
export const THEME_PAGES = new Set(['appearance', 'color-scheme']);
export const THEME_KEY = 'ui.theme';
/** Editor › Color scheme's pick (#345): `theme` (the theme's own) or a theme for the editor. */
export const SCHEME_KEY = 'editor.scheme';
export const SAME_AS_THEME = 'theme';
export const FEEL_KEY = 'ui.feel';
/** Color scheme's Colours row: the 260 tokens' lines in its place. */
export const COLOURS_ROW = 'colours';
export const COLOURS_PAGE = 'color-scheme';

/** Browser profiles: its table row is the profiles' own lines (#103 S4). */
export const PROFILES_PAGE = 'browser-profiles';
export const PROFILES_KEY = 'browser.profiles';
/** Local mode (#24): its checkbox is this checkout's, `abe local status`'s `on`. */
export const LOCAL_PAGE = 'local-mode';
export const LOCAL_ROW = 'local.here';
/** Import config: its lines are the sources and `abe settings import`'s rows. */
export const IMPORT_PAGE = 'import-config';

/** The run ids of a page's own reads (`settings:<what>:<n>`), dropped when they land closed. */
export const PAGE_READS: ReadonlySet<string> = new Set([
  'checks',
  'profiles',
  'themes',
  'import',
  'local',
]);

/** The page the dialog opens on the first time, with no problems. */
export const FIRST_PAGE = 'appearance';

/**
 * A change of yours, written at once (`abe settings set`): shown until the rows read after its
 * write say it, so the row never flips back in between.
 */
export type Change = {
  /** The home row's id. */
  row: string;
  key: SettingKey;
  field: string | null;
  /** As typed (a field row's alone), and as read. */
  typed: string;
  value: unknown;
  /** A 2.0 Layer Override's reason, when the change lowers an upper Layer's value. */
  reason?: string | undefined;
  /** A Feel picked: the values it gives the keys no Layer writes (core's `feelBrings`). */
  brings?: Readonly<Partial<Record<SettingKey, unknown>>> | undefined;
  /** Reset to default: yours taken out (`abe settings unset`), `value` what the Layers above give. */
  reset?: boolean | undefined;
  /** Its write answered: the rows read after this run show it, and it goes. */
  saved?: number | undefined;
};

/** What a save changed, for ⌘Z: the row's value before it (`unset`: yours had none). */
export type Undo =
  | {
      kind: 'setting';
      row: string;
      key: SettingKey;
      field: string | null;
      label: string;
      before: { unset: true } | { value: unknown };
    }
  /** Colours' tokens before a save of them. */
  | { kind: 'colours'; label: string; changed: Readonly<Record<string, string>> };

/**
 * A list row's editor (⏎ on a list): `cursor` on an item, or on `+ Add` after the last; `field`
 * an item typed in place (`at` its index, `null` a new one at the end).
 */
export type ListEditing = {
  kind: 'list';
  row: string;
  cursor: number;
  field?: { at: number | null; text: string } | undefined;
};

/**
 * A records row's editor (⏎ on `views`, `environments`): `rows` its records as typed (a refused
 * one kept until it reads, nothing saved), the cursor on a cell (`row` = the rows' count: `+ Add`);
 * `field` the cell typed in place, `pick` a choice cell's list open, filtered as typed.
 */
export type RecordsEditing = {
  kind: 'records';
  row: string;
  rows: readonly (readonly string[])[];
  cursor: { row: number; col: number };
  field?: { text: string } | undefined;
  pick?: { cursor: number; filter: string } | undefined;
};

export type Editing =
  | { kind: 'combo'; row: string; cursor: number; filter: string }
  /** Appearance's theme list has the keys: k / ä move the cursor, ⏎ picks (saved, live). */
  | { kind: 'themes'; row: string; cursor: number }
  /** Colours' filter field takes the typing. */
  | { kind: 'colours-filter'; row: string; text: string }
  /** A token's hex as a colour field: each valid `#rrggbb` live; `before` what Esc puts back. */
  | { kind: 'token'; row: string; name: string; text: string; before: string | undefined }
  | { kind: 'segmented'; row: string; at: number }
  | { kind: 'field'; row: string; text: string }
  | ListEditing
  | RecordsEditing
  /** The change lowers an upper value: its reason, asked in place. */
  | { kind: 'reason'; row: string; text: string; error?: string | undefined; change: Change };

/** ⌘⏎'s popup: a value and its reason for the repo, one pull request when sent. */
export type Proposing = {
  /** The home row's id. */
  row: string;
  key: SettingKey;
  field: string | null;
  label: string;
  /** The value in force, as the row shows it. */
  from: string;
  /** The row's choices in words (#325): a pick shows them, the proposal writes the choice. */
  words: Readonly<Record<string, string>> | null;
  /** `pick`: one of `choices` (`at`); `toggle`: `on`; `field`: `text` as typed. */
  value:
    | { kind: 'pick'; choices: readonly string[]; at: number }
    | { kind: 'toggle'; on: boolean }
    | { kind: 'field'; text: string; chips: boolean }
    /** A value the dialog put together (a list with your profile added): shown, not typed. */
    | { kind: 'fixed'; text: string; typed: string };
  reason: string;
  focus: ProposeFocus;
  error?: string | undefined;
  /** `abe settings propose` under way: its run id. */
  running?: string | undefined;
};

/**
 * Add profile…: its name, then its purpose, typed in place. `from`: a profile of yours renamed
 * instead, its new name typed in its own row.
 */
export type Adding = {
  name: string | null;
  text: string;
  error?: string | undefined;
  from?: string | undefined;
};

/**
 * What has the dialog's keys in place of its moves (#345, one at a time): a row being edited,
 * ⌘⏎'s popup, `Remove po-review? y / n`, Add profile… typed in place.
 */
type Mode =
  | { kind: 'edit'; edit: Editing }
  | { kind: 'propose'; propose: Proposing }
  | { kind: 'remove'; name: string }
  | { kind: 'add'; add: Adding };

export const editingOf = (s: SettingsState): Editing | undefined =>
  s.mode?.kind === 'edit' ? s.mode.edit : undefined;
export const proposingOf = (s: SettingsState): Proposing | undefined =>
  s.mode?.kind === 'propose' ? s.mode.propose : undefined;
export const removingOf = (s: SettingsState): string | undefined =>
  s.mode?.kind === 'remove' ? s.mode.name : undefined;
export const addingOf = (s: SettingsState): Adding | undefined =>
  s.mode?.kind === 'add' ? s.mode.add : undefined;
export const editMode = (edit: Editing): Mode => ({ kind: 'edit', edit });
export const proposeMode = (propose: Proposing): Mode => ({ kind: 'propose', propose });
export const addMode = (add: Adding): Mode => ({ kind: 'add', add });
/** The mode with an edit left (`undefined` for it), any other kept. */
export const unedit = (s: SettingsState): Mode | undefined =>
  s.mode?.kind === 'edit' ? undefined : s.mode;

/**
 * Logins & tools' reads (S6): run when the page shows, once per open. The last answers are kept
 * while they are read again (a reopen, a fix's end), so the page never blanks (#297).
 */
/** Logins & tools' reads. */
export type CheckRead = 'login status' | 'tools check' | 'source status';

export type Checks = {
  logins?: LoginStatusData | undefined;
  tools?: ToolsCheckData | undefined;
  /** This checkout's sources (`abe source status`), each one's sign-in serve's. */
  sources?: SourcesData | undefined;
  /** A read refused (serve down): why. */
  down?: string | undefined;
  /** The reads asked and not answered yet. */
  reading?: readonly CheckRead[] | undefined;
  /** Read at an earlier open: shown until this open's answers land. */
  stale?: boolean | undefined;
  /** A read refused, why: its rows stay, saying they can't be checked (#345). */
  refused?: Readonly<Partial<Record<CheckRead, string>>> | undefined;
  /** Where the tools were last checked (`this Mac`, `this box`), kept while they are read again. */
  where?: ToolsCheckData['where'] | undefined;
};

/** The setting Colours' theme is (#345): the theme's, or a named editor scheme's. */
export type ColoursKey = typeof THEME_KEY | typeof SCHEME_KEY;

/** Browser profiles' list (#103 S4): read when its page shows, once per open, and after a write. */
type Profiles = { data?: BrowserListData | undefined; down?: string | undefined };

/** A profile of the list as a line of Browser profiles' table. */
export type ProfileLine = BrowserListData['profiles'][number];

/** Import config (#120): a source read with `--dry-run`, its rows ticked, then imported. */
export type Imports = {
  source: ImportSource;
  data?: SettingsImportData | undefined;
  /** Ticks changed here, by row id (else the source's own). */
  ticks: Readonly<Record<string, boolean>>;
  /** A read or the import under way: its run id. */
  running?: string | undefined;
  error?: string | undefined;
};

export const IMPORT_SOURCES_SHOWN: readonly { source: ImportSource; label: string }[] = [
  { source: 'vscode', label: 'VS Code' },
  { source: 'webstorm', label: 'WebStorm' },
  { source: 'vim', label: 'Vim / Neovim' },
];

/** The fix strip: a row's fix typed in, run on ⏎ in a terminal under the page. */
export type Fix = {
  /** The check row's id (`login:github`). */
  item: string;
  label: string;
  command: string;
  state: 'queued' | 'running' | 'ended';
  /** The terminal's key once it runs. */
  key?: string | undefined;
  exit?: number | null | undefined;
};

/** A write under way for one key: its rows, and for a field row the fields to put. */
export type Write = {
  key: SettingKey;
  rows: string[];
  fields: Readonly<Record<string, unknown>> | null;
  typed: string;
  reason?: string | undefined;
  /** Reset to default: yours taken out with `abe settings unset`. */
  unset?: boolean | undefined;
  /** What ⌘Z puts back once it is written; none: an undo's own write. */
  undo?: Undo | undefined;
};

export type SettingsState = {
  open: boolean;
  focus: SettingsFocus;
  /** The tree's cursor: the node whose page is shown. */
  node: string;
  folded: readonly string[];
  /** The focused row on the page (or the results), by index. */
  row: number;
  /** Moved since it opened: Problems' answer no longer lands it there. */
  moved: boolean;
  /**
   * A first open with no page asked: no page shows until Problems answers, so the dialog never
   * jumps from the page it would show to Problems under you (#297).
   */
  holding: boolean;
  /** `/`'s text while searching (`null`: not); where it was before. */
  search: string | null;
  before?: { node: string; row: number; focus: SettingsFocus } | undefined;
  /**
   * A page picked in the tree while searching (#152: a click, ↑ ↓, ⏎): the page shows in place of
   * the results, its hits marked, until the search's text changes.
   */
  picked: boolean;
  /** ⌘A: the text of the field with the caret is selected; the next key types over it. */
  all: boolean;
  list?: SettingsListData | undefined;
  problems?: SettingsProblemsData | undefined;
  /** The runs of the rows' and the problems' reads in force: an older answer landing later is dropped. */
  read: { list: number; problems: number };
  /** Why the last read failed (serve not answering). */
  down?: string | undefined;
  /** Changes saved or being saved, by home row, until the rows read after them show them. */
  changes: Readonly<Record<string, Change>>;
  /** ⌘Z: what each save changed, the last on top. */
  undo: readonly Undo[];
  /** A refused write's words, by home row. */
  errors: Readonly<Record<string, string>>;
  /** What has the keys in place of the page's moves (#345: one at a time). */
  mode?: Mode | undefined;
  checks?: Checks | undefined;
  fix?: Fix | undefined;
  profiles?: Profiles | undefined;
  /** `abe theme list` (#108 S4): read when Appearance or Color scheme shows, once per open. */
  themes?: { data?: ThemeListData | undefined; down?: string | undefined } | undefined;
  /**
   * Colours (#108 S4, T-Colours): `abe theme show` of the theme in force, the filter, and the
   * tokens changed over it (each change saved at once with `abe theme save`: yours, only those).
   */
  colours?:
    | {
        /** What a save sets: `ui.theme`, or `editor.scheme` while a named scheme is edited (#345). */
        key: ColoursKey;
        /** The theme read (`theme show <slug>`) and that read's run id: an older answer is dropped. */
        slug?: string | undefined;
        read?: string | undefined;
        data?: ThemeShowData | undefined;
        down?: string | undefined;
        filter: string;
        changed: Readonly<Record<string, string>>;
      }
    | undefined;
  /** Colours' token groups unfolded (#300: folded by default), kept while the app runs. */
  tokensOpen: readonly string[];
  /** The stage the last `look` command sent, as JSON (`null`: none): a new one only when it moves. */
  lookSent: string;
  imports?: Imports | undefined;
  /**
   * Local mode's checkbox (#24): this checkout's, read when its page shows (`abe local status`);
   * `running`: `abe local on|off` under way.
   */
  local?:
    | {
        data?: { checkout: string | null; on: boolean } | undefined;
        down?: string | undefined;
        running?: boolean | undefined;
      }
    | undefined;
  /** Writes not answered yet, by run id. */
  writing: Readonly<Record<string, Write>>;
  /** `g` was pressed: a second one is `gg`. */
  g: boolean;
  runs: number;
};

export const INIT: SettingsState = {
  open: false,
  focus: 'tree',
  node: FIRST_PAGE,
  folded: [],
  row: 0,
  moved: false,
  holding: false,
  search: null,
  picked: false,
  all: false,
  changes: {},
  undo: [],
  read: { list: 0, problems: 0 },
  errors: {},
  writing: {},
  tokensOpen: [],
  lookSent: 'null',
  g: false,
  runs: 0,
};

export type Out = { state: SettingsState; commands: Command[] };

export const same = (state: SettingsState): Out => ({ state, commands: [] });

export const status = (text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'status', text },
});

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a key types into a field: one character (`<Space>`, `<lt>` as theirs). */
export const typedChar = (key: string): string | undefined => {
  if (key === '<Space>') return ' ';
  if (key === '<lt>') return '<';

  return Array.from(key).length === 1 ? key : undefined;
};

export const UP = new Set(['l', '<Up>']);
export const DOWN = new Set(['ö', '<Down>']);

export const LEFT = new Set(['k', '<Left>']);
export const RIGHT = new Set(['ä', '<Right>']);

export const edited = (text: string, key: string) => {
  if (key === '<BS>') return text.slice(0, -1);
  if (key === '<C-u>' || key === '<D-BS>') return '';
  const c = typedChar(key);

  return c === undefined ? text : text + c;
};

export const refusal = (e: { code: string; message: string }) => `${e.message} (${e.code})`;

export const downOf = (e: { code: string; message: string }) =>
  e.code === 'serve-unreachable' ? 'abe serve not answering' : e.message;
