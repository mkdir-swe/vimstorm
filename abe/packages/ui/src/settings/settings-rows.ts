/**
 * The Settings dialog's lines (#345 split of `settings.ts`): a page's or `/`'s results' rows, the
 * values they show, the reads a page asks for, the live look of the changes being saved.
 */
import {
  type CheckItem,
  type ImportRow,
  type ImportSource,
  type ListedRow,
  type PageId,
  type SettingKey,
  type SettingRow as CatalogueRow,
  type SearchHits,
  type SettingsDialogRules,
  type SettingsListData,
  type SettingsProblem,
  type LookStage,
  type ThemeRow,
  type ThemeShowData,
  type ThemeToken,
  type TreeNode,
} from '@abe/core';
import { type TokenGroup, colourLines, themeRows, unconfirmed } from './settings-colours';
import { importLines } from './settings-import';

import { checksShown } from './settings-logins';

import {
  COLOURS_ROW,
  FEEL_KEY,
  IMPORT_PAGE,
  LOCAL_ROW,
  LOGINS_PAGE,
  type Out,
  PROFILES_KEY,
  type ProfileLine,
  SAME_AS_THEME,
  SCHEME_KEY,
  type SettingsState,
  type Change,
  THEME_KEY,
  editingOf,
  same,
} from './settings-state';
import { nodeOfPage, pageShown, problemCount } from './settings-tree';

/** A focusable line of the page: a setting row, or a problem. */
export type SettingLine = { kind: 'setting'; row: CatalogueRow; listed: ListedRow | undefined };

export type Line =
  | SettingLine
  | { kind: 'problem'; problem: SettingsProblem; at: number }
  | { kind: 'check'; item: CheckItem }
  | { kind: 'profile'; profile: ProfileLine }
  | { kind: 'add-profile' }
  | { kind: 'import-source'; source: ImportSource; label: string }
  | { kind: 'import-row'; row: ImportRow }
  | { kind: 'import-go'; count: number; keys: number }
  | { kind: 'colours-filter'; row: string }
  /** Reset colours (#108 §10, #325): every token back to the base theme's colour. */
  | { kind: 'colours-reset'; row: string }
  /** A token group's head (Chrome · 125): folded until ⏎ or ä, open while filtering (#300). */
  | { kind: 'token-group'; row: string; group: TokenGroup }
  | { kind: 'token'; row: string; token: ThemeToken }
  /** A page `/` found by its name (#152): ⏎ opens it. */
  | { kind: 'page-hit'; page: PageId }
  /** Local mode's checkbox (#24): this checkout's, on and off with `abe local on|off`. */
  | { kind: 'local'; row: CatalogueRow };

/** A row's listed value. */
export const listedOf = (s: SettingsState, row: CatalogueRow): ListedRow | undefined =>
  s.list?.rows.find((l) => l.id === row.id);

/**
 * A row the dialog draws: a setting, a fixed line or a link to a home row elsewhere (a table no
 * setting fills waits for its page).
 */
const drawable = (row: CatalogueRow) => row.key !== null || row.fixed !== null || row.link !== null;

/** The UI theme shown: changed, else in force (`undefined` until the themes are read). */
const uiThemeShown = (s: SettingsState): ThemeRow | undefined => {
  const changed = Object.values(s.changes).find((c) => c.key === THEME_KEY)?.value;

  return themeRows(s).find((t) => (changed === undefined ? t.current : t.slug === changed));
};

/**
 * Editor › Color scheme's pick with the themes read (#345): `Same as theme (Islands Dark)`, then
 * each theme by its name; any other row as it is.
 */
export const withSchemes = (s: SettingsState, row: CatalogueRow): CatalogueRow => {
  if (row.key !== SCHEME_KEY) return row;
  const themes = themeRows(s);
  const ui = uiThemeShown(s)?.name;

  return {
    ...row,
    choices: [SAME_AS_THEME, ...themes.map((t) => t.slug)],
    words: {
      [SAME_AS_THEME]: `same as theme${ui === undefined ? '' : ` (${ui})`}`,
      ...Object.fromEntries(themes.map((t) => [t.slug, t.name])),
    },
  };
};

const boardProviderIs = (s: SettingsState, provider: string): boolean =>
  (s.list?.rows ?? []).some((l) => l.id === 'board#provider' && l.value === provider);

/** The repo's board is On this machine, as the settings list says (unread: not). */
export const boardOnThisMachine = (s: SettingsState): boolean => boardProviderIs(s, 'local');

/** The repo's board is not on Azure DevOps (On this machine, or its GitHub Issues): no az for it. */
export const boardNotAzure = (s: SettingsState): boolean =>
  boardOnThisMachine(s) || boardProviderIs(s, 'github');

/** The board fields only an Azure DevOps board has: none drawn for another. */
const AZURE_FIELDS: ReadonlySet<string> = new Set(['organization', 'team', 'azureConfigDir']);
/** The board fields only a GitHub board has. */
const GITHUB_FIELDS: ReadonlySet<string> = new Set(['repo']);

const boardField = (row: CatalogueRow, fields: ReadonlySet<string>) =>
  row.key === 'board' && row.field !== null && fields.has(row.field);

/** A board field drawn for its own provider only: Azure's, and a GitHub board's repo. */
const otherBoards = (row: CatalogueRow, s: SettingsState): boolean =>
  (boardField(row, AZURE_FIELDS) && boardNotAzure(s)) ||
  (boardField(row, GITHUB_FIELDS) && !boardProviderIs(s, 'github'));

export const pageLines = (r: SettingsDialogRules, s: SettingsState, page: PageId): Line[] => {
  if (page === 'problems')
    return (s.problems?.problems ?? []).map((problem, at) => ({ kind: 'problem', problem, at }));
  if (page === IMPORT_PAGE) return importLines(s);
  if (page === LOGINS_PAGE) {
    const shown = checksShown(s);

    return shown === undefined ? [] : r.checks(shown).map((item) => ({ kind: 'check', item }));
  }

  return r
    .page(page)
    .rows.filter((row) => !otherBoards(row, s))
    .filter(
      (row) =>
        drawable(row) ||
        row.id === LOCAL_ROW ||
        (row.id === COLOURS_ROW && s.colours?.data !== undefined),
    )
    .flatMap((row): Line[] => {
      if (row.id === LOCAL_ROW) return [{ kind: 'local', row }];
      if (row.id === COLOURS_ROW) return colourLines(s, row.id, hitsOn(r, s));
      if (row.key === PROFILES_KEY && s.profiles?.data !== undefined)
        return [
          ...s.profiles.data.profiles.map((profile): Line => ({ kind: 'profile', profile })),
          { kind: 'add-profile' },
        ];
      const shown = withSchemes(s, row);

      return [{ kind: 'setting', row: shown, listed: listedOf(s, shown) }];
    });
};

/** The values as shown, by row id, for `/`. */
const shownValues = (s: SettingsState): Map<string, string> =>
  new Map((s.list?.rows ?? []).map((l) => [l.id, l.shown]));

/** Searching with something typed. */
export const searching = (s: SettingsState): string | undefined => {
  const q = s.search?.trim() ?? '';

  return q === '' ? undefined : q;
};

/** The Colours tokens `/` finds (#345): the theme Colours edits, once read. */
const searchedTokens = (s: SettingsState): ThemeToken[] =>
  (s.colours?.data?.groups ?? []).flatMap((g) => g.tokens);

/** `/`'s hits for `q`, the last answer kept: a frame asks it for every row and the tree. */
let lastHits:
  | {
      r: SettingsDialogRules;
      q: string;
      list: SettingsListData | undefined;
      colours: ThemeShowData | undefined;
      hits: SearchHits;
    }
  | undefined;

export const hitsOf = (r: SettingsDialogRules, s: SettingsState, q: string): SearchHits => {
  const last = lastHits;
  const colours = s.colours?.data;

  if (last?.r === r && last.q === q && last.list === s.list && last.colours === colours)
    return last.hits;
  const hits = r.search(q, shownValues(s), searchedTokens(s));

  lastHits = { r, q, list: s.list, colours, hits };

  return hits;
};

/** The results of `/` fill the page: something typed, no page picked in the tree since. */
export const results = (s: SettingsState): string | undefined =>
  s.picked ? undefined : searching(s);

/** The ids of the items `/` finds on a page picked while searching: its rows marked. */
export const hitsOn = (r: SettingsDialogRules, s: SettingsState): ReadonlySet<string> => {
  const q = searching(s);

  if (q === undefined || !s.picked) return new Set();
  const page = pageShown(r, s);

  return new Set(
    hitsOf(r, s, q)
      .pages.filter((p) => p.page === page)
      .flatMap((p) => p.items.map((i) => i.id)),
  );
};

const catalogueRow = (r: SettingsDialogRules, page: PageId, id: string) =>
  r.page(page).rows.find((row) => row.id === id);

/** The results of `/`, page by page: each hit a setting line. */
export const resultGroups = (r: SettingsDialogRules, s: SettingsState, query: string) => {
  const hits = hitsOf(r, s, query);
  const tokens = new Map(searchedTokens(s).map((t) => [t.name, t]));

  return {
    hits,
    groups: hits.pages.map((p) => ({
      page: p.page,
      label: p.label,
      lines: p.items.flatMap((item): Line[] => {
        if (item.kind === 'page') return [{ kind: 'page-hit', page: p.page }];
        if (item.kind === 'token') {
          const token = tokens.get(item.id);

          return token === undefined ? [] : [{ kind: 'token', row: COLOURS_ROW, token }];
        }
        const found = catalogueRow(r, p.page, item.id);
        const row = found === undefined ? undefined : withSchemes(s, found);

        return row === undefined || !drawable(row)
          ? []
          : [{ kind: 'setting', row, listed: listedOf(s, row) }];
      }),
    })),
  };
};

/** The page's focusable lines, in order: the results while searching. */
export const lines = (r: SettingsDialogRules, s: SettingsState): Line[] => {
  const q = results(s);

  if (q !== undefined) return resultGroups(r, s, q).groups.flatMap((g) => g.lines);

  return pageLines(r, s, pageShown(r, s));
};

export const focusedLine = (r: SettingsDialogRules, s: SettingsState): Line | undefined =>
  lines(r, s)[s.row];

/** What a line is, whatever its place: the focus follows it as rows come and go around it. */
export const lineKey = (l: Line): string => {
  switch (l.kind) {
    case 'setting':
      return `setting:${l.row.id}`;
    case 'problem':
      // never its text: a partial fix changes it (`tests has no command`), the row is the same
      return `problem:${l.problem.code}:${l.problem.where}`;
    case 'check':
      return `check:${l.item.id}`;
    case 'profile':
      return `profile:${l.profile.name}`;
    case 'import-source':
      return `import-source:${l.source}`;
    case 'import-row':
      return `import-row:${l.row.id}`;
    case 'token-group':
      return `token-group:${l.group.group}`;
    case 'token':
      return `token:${l.token.name}`;
    case 'page-hit':
      return `page-hit:${l.page}`;
    case 'add-profile':
    case 'local':
    case 'import-go':
    case 'colours-filter':
    case 'colours-reset':
      return l.kind;
  }
};

export const clampRow = (r: SettingsDialogRules, s: SettingsState): SettingsState => {
  const n = lines(r, s).length;

  return { ...s, row: Math.max(0, Math.min(s.row, n - 1)) };
};

// ---------------------------------------------------------------- values

/** A row's change: being saved, or waiting for its Override's reason. */
export const changeOf = (s: SettingsState, row: CatalogueRow): Change | undefined => {
  const id = row.id;
  const e = editingOf(s);

  return s.changes[id] ?? (e?.kind === 'reason' && e.row === id ? e.change : undefined);
};

/**
 * What a Feel picked gives a row no Layer writes (#300: Feel vscode shows Dark Modern at once), as
 * `abe settings list` will once it is read again; `undefined` when it changes nothing there.
 */
export const feelGives = (
  s: SettingsState,
  key: SettingKey | null,
  listed: ListedRow | undefined,
): { feel: string; value: unknown } | undefined => {
  if (key === null || listed?.field !== null) return undefined;
  if (listed.source.kind !== 'feel' && listed.source.kind !== 'built-in') return undefined;
  if (s.changes[listed.id] !== undefined) return undefined;
  const feel = Object.values(s.changes).find((c) => c.key === FEEL_KEY);

  if (feel?.brings === undefined || !Object.hasOwn(feel.brings, key)) return undefined;
  const value = feel.brings[key];

  return sameValue(value, listed.value) ? undefined : { feel: String(feel.value), value };
};

/** The value a row shows: its change, a Feel's being saved, else the listed one. */
export const valueOf = (
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
): unknown => {
  const c = changeOf(s, row);

  if (c !== undefined) return c.value;
  const feel = feelGives(s, row.key, listed);

  return feel === undefined ? listed?.value : feel.value;
};

export const shownOf = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  listed: ListedRow | undefined,
): string => {
  const c = changeOf(s, row);

  if (c !== undefined) return r.shown(c.value);
  const feel = feelGives(s, row.key, listed);

  if (feel !== undefined) return r.shown(feel.value);

  return listed?.shown ?? '…';
};

export const choicesOf = (row: CatalogueRow, listed: ListedRow | undefined): readonly string[] =>
  listed?.choices ?? row.choices ?? [];

type Worded = Pick<CatalogueRow, 'words'>;

/** A choice in words, as a sentence says it (#325): `after a pause`; else the choice itself. */
export const wordOf = (row: Worded, choice: string): string => row.words?.[choice] ?? choice;

/** A choice in words as a control shows it: `After a pause`, `VS Code`. */
export const choiceWords = (row: Worded, choice: string): string => {
  const w = row.words?.[choice];

  return w === undefined ? choice : `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
};

/** A value as a control shows it: a choice in words, else as a row shows any value. */
export const valueShown = (r: SettingsDialogRules, row: Worded, v: unknown): string =>
  typeof v === 'string' && row.words?.[v] !== undefined ? choiceWords(row, v) : r.shown(v);

/** Every home row of the catalogue by its setting (a whole setting's, not a field's), once per rules. */
export const byKey = new WeakMap<SettingsDialogRules, ReadonlyMap<string, CatalogueRow>>();

export const homeRowOf = (r: SettingsDialogRules, key: string): CatalogueRow | undefined => {
  let rows = byKey.get(r);

  if (rows === undefined) {
    const pages = (nodes: readonly TreeNode[]): PageId[] =>
      nodes.flatMap((n) => [...(n.page === null ? [] : [n.page]), ...pages(n.children)]);

    rows = new Map(
      pages(r.tree).flatMap((page) =>
        r
          .page(page)
          .rows.filter((x) => x.key !== null && x.field === null && x.link === null)
          .map((x) => [x.key ?? '', x]),
      ),
    );
    byKey.set(r, rows);
  }

  return rows.get(key);
};

/** A Feel by its name (`VS Code`), as the Feel row's words say it. */
export const feelName = (r: SettingsDialogRules, feel: string): string => {
  const row = r.page('appearance').rows.find((x) => x.key === FEEL_KEY);

  return row === undefined ? feel : wordOf(row, feel);
};

export const greyedOf = (listed: ListedRow | undefined, choice: string): string | undefined =>
  listed?.greyed.find((g) => g.choice === choice)?.why;

/** A fixed line (`list` gives it a `fixed`): ⏎ only says why. */
export const isFixed = (listed: ListedRow | undefined) =>
  listed !== undefined && listed.fixed !== null;

/** A setting line showing row `id` (its own, or the home row it mirrors). */
export const isRow = (l: Line, id: string) => l.kind === 'setting' && l.row.id === id;

/** A list value's items as text (`[a, b]` → `a`, `b`). */
export const items = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];

/** What ⏎ puts in a field to edit: the value as it would be typed again. */
export const typedOf = (
  r: SettingsDialogRules,
  s: SettingsState,
  row: CatalogueRow,
  l?: ListedRow,
) => {
  const c = s.changes[row.id];

  if (c !== undefined && c.reset !== true) return c.value === null ? '' : c.typed;
  const v = l?.value;

  if (v === null || v === undefined) return '';
  if (row.control === 'advanced') return JSON.stringify(v);
  if (Array.isArray(v)) return items(v).join(', ');
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);

  return r.shown(v);
};

/** The Layers above yours give this (what an Override would lower). */
export const aboveOf = (listed: ListedRow): unknown =>
  listed.source.kind === 'yours' && listed.differs !== null ? listed.differs.value : listed.value;

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- reads

/**
 * A read of the rows or the problems; `filesOnly`: only what the settings in force say, answered
 * at once (no GitHub, login or tool check), so a page shows before the slow read lands.
 */
export const read = (s: SettingsState, what: 'list' | 'problems', filesOnly = false): Out => {
  const runs = s.runs + 1;

  return {
    state: { ...s, runs },
    commands: [
      {
        kind: 'run',
        id: `settings:${what}:${runs}`,
        argv: ['settings', what, ...(filesOnly ? ['--files-only'] : [])],
      },
    ],
  };
};

/** The run an answer's id names: `settings:list:7` is 7. */
export const runOf = (id: string): number => Number(id.split(':').at(-1) ?? '0');

/**
 * Every read the dialog makes when it opens (Retry, a serve back): the rows and the problems, each
 * from the settings files at once and then in full.
 */
export const readAll = (s0: SettingsState): Out => {
  // a page whose own read found serve down reads again with the rest
  const s: SettingsState = {
    ...s0,
    checks: s0.checks?.down === undefined ? s0.checks : undefined,
    profiles: s0.profiles?.down === undefined ? s0.profiles : undefined,
    local: s0.local?.down === undefined ? s0.local : undefined,
  };
  // the settings files' own first, at once; then the reads that wait on GitHub and the checks
  const reads = [
    ['list', true],
    ['list', false],
    ['problems', true],
    ['problems', false],
  ] as const;

  return reads.reduce<Out>(
    (out, [what, quick]) => {
      const next = read(out.state, what, quick);

      return { state: next.state, commands: [...out.commands, ...next.commands] };
    },
    { state: s, commands: [] },
  );
};

export const opened = (
  r: SettingsDialogRules,
  s: SettingsState,
  params: Readonly<Record<string, string>>,
) => {
  const page = params.page;
  // the page asked for, else Problems while there are any, else the page last shown
  const landing = problemCount(s) > 0 ? 'problems' : s.node;
  const node = page === undefined ? landing : nodeOfPage(r, page);
  const base: SettingsState = {
    ...unconfirmed(s),
    open: true,
    node,
    focus: page !== undefined ? 'page' : 'tree',
    row: 0,
    moved: page !== undefined,
    holding: page === undefined && s.problems === undefined,
    search: null,
    before: undefined,
    picked: false,
    all: false,
    // opened again while open: an edit goes, a proposal under way (its answer lands on it), a
    // removal or an Add profile… stay
    mode: s.mode?.kind === 'edit' ? undefined : s.mode,
    g: false,
    ...(s.open ? {} : { changes: {}, undo: [], errors: {}, writing: {} }),
  };
  const at = params.row;
  const placed =
    at === undefined
      ? base
      : {
          ...base,
          row: Math.max(
            0,
            pageLines(r, base, pageShown(r, base)).findIndex((l) => isRow(l, at)),
          ),
        };

  return readAll(placed);
};

export const closed = (s: SettingsState): SettingsState => ({
  ...s,
  open: false,
  changes: {},
  undo: [],
  errors: {},
  mode: undefined,
  // the last answers kept for the next open to show while it reads them again (#297)
  checks:
    s.checks?.logins === undefined && s.checks?.tools === undefined
      ? undefined
      : { logins: s.checks.logins, tools: s.checks.tools, stale: true },
  fix: undefined,
  profiles: undefined,
  themes: undefined,
  colours: undefined,
  imports: undefined,
  local: undefined,
  search: null,
  before: undefined,
  picked: false,
  all: false,
  g: false,
});

/** Closes: every change is saved already (a colour field open puts its hex back, as Esc does). */
export const close = (s: SettingsState): Out => same(closed(unconfirmed(s)));

/** The `ui.*` keys a look shows while their change saves (#108 S4), by where they go in its stage. */
const LOOK_KEYS: Readonly<Record<string, (stage: LookStage, value: unknown) => LookStage>> = {
  'ui.theme': (st, v) => (typeof v === 'string' ? { ...st, theme: v } : st),
  'editor.scheme': (st, v) => (typeof v === 'string' ? { ...st, scheme: v } : st),
  'ui.density': (st, v) => (v === 'compact' || v === 'default' ? { ...st, density: v } : st),
  'ui.font.family': (st, v) =>
    typeof v === 'string' ? { ...st, font: { ...st.font, family: v } } : st,
  'ui.font.size': (st, v) =>
    typeof v === 'number' ? { ...st, font: { ...st.font, size: v } } : st,
  'ui.font.editorFamily': (st, v) =>
    typeof v === 'string' ? { ...st, font: { ...st.font, editorFamily: v } } : st,
  'ui.font.editorSize': (st, v) =>
    typeof v === 'number' ? { ...st, font: { ...st.font, editorSize: v } } : st,
  'ui.font.ligatures': (st, v) =>
    typeof v === 'boolean' ? { ...st, font: { ...st.font, ligatures: v } } : st,
};

/** The look the changes being saved show: theme, density, fonts (`null`: none moves it). */
export const changedLook = (s: SettingsState): LookStage | null => {
  let stage: LookStage = {};
  let any = false;

  for (const st of Object.values(s.changes)) {
    const put = LOOK_KEYS[st.key];

    if (put === undefined) continue;
    stage = put(stage, st.value);
    any = true;
  }

  const tokens = s.colours?.changed ?? {};

  if (Object.keys(tokens).length > 0) return { ...stage, tokens };

  return any ? stage : null;
};

/**
 * After a step: the `look` command when the changed look moved, so a theme, density or font picked
 * is live in every window at once, and the look in force is put back once the rows read it.
 */
export const lookDue = (out: Out): Out => {
  const stage = changedLook(out.state);
  const text = JSON.stringify(stage);

  if (text === out.state.lookSent) return out;

  return {
    state: { ...out.state, lookSent: text },
    commands: [...out.commands, { kind: 'look', stage }],
  };
};

/** `rec` without `key`. */
export const without = <T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).filter(([k]) => k !== key));
