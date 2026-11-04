/**
 * Themes (#108 S4): the window's colours as the design system's tokens (`theme-tokens.ts`), a
 * built-in theme's values (`theme-built-in.ts`) or a theme file's changes over one, and the look
 * the shell draws (theme tokens, density, fonts). A theme file is `{name, base, tokens}` with only
 * the tokens it changes; yours sit in `<config>/themes/<slug>.json`. A built-in theme is never
 * written: a change to one saves `<Base> (yours)`.
 */
import { z } from 'zod';
import { type SettingProblem } from '../layer/settings/contract';
import { DENSITIES, SETTINGS } from '../layer/settings/keys';
import { type Merged } from '../layer/settings/layers';
import { DARK_MODERN, ISLANDS_DARK, ISLANDS_LIGHT } from './theme-built-in';
import { TOKENS } from './theme-tokens';

// ---------------------------------------------------------------- tokens and groups

export type TokenName = (typeof TOKENS)[number]['name'];

/** The Colours editor's groups, in its order. */
export const TOKEN_GROUPS = ['chrome', 'editor', 'abe', 'git', 'diff', 'terminal'] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number];

export const TOKEN_GROUP_LABELS: Readonly<Record<TokenGroup, string>> = {
  chrome: 'Chrome',
  editor: 'Editor',
  abe: 'Abe status',
  git: 'Git',
  diff: 'Diff',
  terminal: 'Terminal',
};

/**
 * The groups an editor scheme gives (#345, WebStorm's Color Scheme: the editor, VCS, diff and
 * console colours); the theme gives the rest (the chrome, Abe's status colours).
 */
export const SCHEME_GROUPS: readonly TokenGroup[] = ['editor', 'git', 'diff', 'terminal'];

/** `editor.scheme`'s value for the theme's own editor colours. */
export const SAME_AS_THEME = 'theme';

/** Every token's name, in the design system's order. */
export const TOKEN_NAMES: readonly TokenName[] = TOKENS.map((t) => t.name);

const NAMES = new Set<string>(TOKEN_NAMES);

export const isTokenName = (name: string): name is TokenName => NAMES.has(name);

/** A token's group and where it shows. */
export const tokenInfo = (name: TokenName): { group: TokenGroup; usage: string } => {
  const found = TOKENS.find((t) => t.name === name);

  if (found === undefined) throw new Error(`no colour token ${name}`);

  return { group: found.group, usage: found.usage };
};

/** How many tokens each group holds. */
export const groupCounts = (): Record<TokenGroup, number> => {
  const counts: Record<TokenGroup, number> = {
    chrome: 0,
    editor: 0,
    abe: 0,
    git: 0,
    diff: 0,
    terminal: 0,
  };

  for (const t of TOKENS) counts[t.group] += 1;

  return counts;
};

/** A colour as a theme file writes it: `#rrggbb`, or `#rrggbbaa` with its alpha; read lowercase. */
export const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'a colour like #b589ec (or #rrggbbaa)')
  .transform((s) => s.toLowerCase());
export type Hex = z.output<typeof Hex>;

// ---------------------------------------------------------------- built-in themes

export const BUILT_IN_THEMES = ['islands-dark', 'islands-light', 'dark-modern'] as const;
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];
export const BuiltInTheme = z.enum(BUILT_IN_THEMES);

/** A built-in theme value: a colour, or `{token}` (it follows that token). */
type BuiltInValues = Readonly<Record<TokenName, string>>;

/**
 * Which editor's capture mapping the syntax colours follow (#129): WebStorm's Darcula (function
 * calls plain, primitive types as keywords) or VS Code's (every function name in the function
 * colour, every type name, primitives too, in the type colour). A theme over a built-in keeps its.
 */
export const SYNTAX_MAPPINGS = ['darcula', 'vscode'] as const;
export type SyntaxMapping = (typeof SYNTAX_MAPPINGS)[number];

const BUILT_IN: Readonly<
  Record<
    BuiltInTheme,
    { name: string; dark: boolean; syntax: SyntaxMapping; values: BuiltInValues }
  >
> = {
  'islands-dark': { name: 'Islands Dark', dark: true, syntax: 'darcula', values: ISLANDS_DARK },
  'islands-light': {
    name: 'Islands Light',
    dark: false,
    syntax: 'darcula',
    values: ISLANDS_LIGHT,
  },
  'dark-modern': { name: 'Dark Modern', dark: true, syntax: 'vscode', values: DARK_MODERN },
};

export const isBuiltInTheme = (slug: string): slug is BuiltInTheme =>
  BUILT_IN_THEMES.some((built) => built === slug);

export const builtInName = (slug: BuiltInTheme): string => BUILT_IN[slug].name;

/** The theme `ui.theme` names when nothing else does, and the one a missing theme falls back to. */
export const DEFAULT_THEME: BuiltInTheme = 'islands-dark';

// ---------------------------------------------------------------- slugs and names

/**
 * A theme's file name (and its `ui.theme`) from its name: lowercase letters and digits, every other
 * run one `-`, accents dropped (`Islands Dark (yours)` → `islands-dark-yours`).
 */
export const themeSlug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** What a change to a theme you do not own saves as: `<Name> (yours)`. */
export const yoursName = (name: string): string => `${name} (yours)`;

// ---------------------------------------------------------------- theme files

/** A theme file as written: its name, the built-in it is over, the tokens it changes. */
export const ThemeFileDoc = z.strictObject({
  name: z.string().trim().min(1),
  base: BuiltInTheme,
  tokens: z.record(z.string(), Hex),
});
export type ThemeFileDoc = z.output<typeof ThemeFileDoc>;

/** Where a theme comes from. */
export const ThemeSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('built-in') }),
  z.strictObject({ kind: z.literal('yours'), file: z.string() }),
]);
export type ThemeSource = z.infer<typeof ThemeSource>;

/** A theme as the catalogue holds it: a built-in, or a file's changes over one. */
export type Theme = {
  slug: string;
  name: string;
  base: BuiltInTheme;
  source: ThemeSource;
  /** The tokens it changes over its base (a built-in changes none). */
  changes: Partial<Record<TokenName, Hex>>;
};

/** A theme file that does not read, and why: listed, never used. */
export type ThemeProblem = { file: string; message: string };

/** A file's text, read as the theme at `slug`, or why not. */
export const readThemeFile = (
  text: string,
  slug: string,
  source: Exclude<ThemeSource, { kind: 'built-in' }>,
): { ok: true; theme: Theme; unknown: string[] } | { ok: false; problem: ThemeProblem } => {
  const problem = (message: string) => ({
    ok: false as const,
    problem: { file: source.file, message },
  });

  if (isBuiltInTheme(slug)) return problem(`${slug} is a built-in theme's name: rename the file`);
  if (slug === SAME_AS_THEME)
    return problem(`${slug} is editor.scheme's word for the theme's own: rename the file`);
  if (themeSlug(slug) !== slug)
    return problem(`${slug} is no theme name: use ${themeSlug(slug)}.json`);
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return problem('not JSON');
  }
  const read = ThemeFileDoc.safeParse(doc);

  if (!read.success) return problem(z.prettifyError(read.error).replace(/\n/g, '; '));
  const changes: Partial<Record<TokenName, Hex>> = {};
  const unknown: string[] = [];

  for (const [name, hex] of Object.entries(read.data.tokens)) {
    if (isTokenName(name)) changes[name] = hex;
    else unknown.push(name);
  }

  return {
    ok: true,
    theme: { slug, name: read.data.name, base: read.data.base, source, changes },
    unknown,
  };
};

/** The built-in themes, as the catalogue holds them. */
export const builtInThemes = (): Theme[] =>
  BUILT_IN_THEMES.map((slug) => ({
    slug,
    name: BUILT_IN[slug].name,
    base: slug,
    source: { kind: 'built-in' },
    changes: {},
  }));

/** Every theme there is: the built-ins, then yours (by name); a slug taken already is passed over. */
export const themeCatalogue = (files: readonly Theme[]): Theme[] => {
  const all: Theme[] = [];

  for (const t of [...builtInThemes(), ...[...files].sort((a, b) => a.name.localeCompare(b.name))])
    if (!all.some((had) => had.slug === t.slug)) all.push(t);

  return all;
};

const ALIAS = /^\{([a-z0-9-]+)\}$/;

/**
 * Every token's colour in `theme`: its own changes over its base's values, an alias following
 * the token it names (so a changed `popup-bg` moves `popup-header-bg` too).
 */
export const resolveTheme = (theme: Pick<Theme, 'base' | 'changes'>): Record<TokenName, Hex> => {
  const base = BUILT_IN[theme.base].values;
  const out: Partial<Record<TokenName, Hex>> = {};
  const valueOf = (name: TokenName, seen: readonly TokenName[]): Hex => {
    const had = out[name];

    if (had !== undefined) return had;
    const own = theme.changes[name];
    const raw = own ?? base[name];
    const alias = ALIAS.exec(raw)?.[1];
    let hex: Hex;

    if (alias === undefined) hex = raw.toLowerCase();
    else if (!isTokenName(alias) || seen.includes(alias))
      throw new Error(`${theme.base}: ${name} follows ${alias}, which is no colour`);
    else hex = valueOf(alias, [...seen, name]);
    out[name] = hex;

    return hex;
  };
  const all: Record<string, Hex> = {};

  for (const name of TOKEN_NAMES) all[name] = valueOf(name, []);

  // every TOKEN_NAMES entry was set just above
  return all;
};

/** The base's own colour of each token (what ⌫ resets a changed token to). */
export const baseValues = (base: BuiltInTheme): Record<TokenName, Hex> =>
  resolveTheme({ base, changes: {} });

// ---------------------------------------------------------------- saving a theme

/** What a save writes: the file's slug and its document (only the tokens that differ). */
export type ThemeSavePlan = { slug: string; name: string; doc: ThemeFileDoc };

/**
 * A change to `from`'s colours saved as a theme file of yours. `edits` are colours over `from`'s
 * (one equal to the base's drops that token: ⌫'s reset). Your own theme is written in place; a
 * built-in is copied to `<Name> (yours)` (or `name`), and a built-in is never written.
 */
export const planThemeSave = (
  from: Theme,
  edits: Readonly<Partial<Record<TokenName, Hex>>>,
  name?: string,
): { ok: true; plan: ThemeSavePlan } | { ok: false; code: string; message: string } => {
  const named = name ?? (from.source.kind === 'yours' ? from.name : yoursName(from.name));
  const slug = from.source.kind === 'yours' && name === undefined ? from.slug : themeSlug(named);

  if (slug === '')
    return {
      ok: false,
      code: 'bad-theme-name',
      message: `${JSON.stringify(named)} makes no file name`,
    };
  if (isBuiltInTheme(slug))
    return {
      ok: false,
      code: 'built-in-theme',
      message: `${builtInName(slug)} is built in and never written: save it as ${yoursName(builtInName(slug))}`,
    };
  const base = baseValues(from.base);
  const tokens: Record<string, Hex> = {};

  for (const n of TOKEN_NAMES) {
    const value = edits[n] ?? from.changes[n];

    if (value !== undefined && value !== base[n]) tokens[n] = value;
  }

  return { ok: true, plan: { slug, name: named, doc: { name: named, base: from.base, tokens } } };
};

/** A theme file's text: its document as two-space JSON with a final newline. */
export const themeFileText = (doc: ThemeFileDoc): string => `${JSON.stringify(doc, null, 2)}\n`;

// ---------------------------------------------------------------- the look

export const LookFont = z.strictObject({
  /** The UI's font: tree, tabs, popups, Abe's screens. */
  family: z.string().min(1),
  size: z.number().positive(),
  /** The editor's and the terminal's. */
  editorFamily: z.string().min(1),
  editorSize: z.number().positive(),
  ligatures: z.boolean(),
});
export type LookFont = z.infer<typeof LookFont>;

/**
 * What the shell draws with (the `look` shell effect, `abe theme look`): the theme's every token
 * resolved, whether it is dark (nvim's `background`), the density and the fonts.
 */
export const Look = z.strictObject({
  theme: z.strictObject({
    slug: z.string().min(1),
    name: z.string().min(1),
    dark: z.boolean(),
    /** The syntax colours' capture mapping: the base built-in's. */
    syntax: z.enum(SYNTAX_MAPPINGS),
  }),
  /**
   * The editor scheme (#345): nvim's `background` and syntax mapping are its. `follows`: the
   * theme's own (`editor.scheme: theme`), else a named one whose editor, git, diff and terminal
   * tokens are in `tokens` over the theme's.
   */
  scheme: z.strictObject({
    slug: z.string().min(1),
    name: z.string().min(1),
    dark: z.boolean(),
    syntax: z.enum(SYNTAX_MAPPINGS),
    follows: z.boolean(),
  }),
  tokens: z.record(z.string(), z.string()),
  density: z.enum(DENSITIES),
  font: LookFont,
  /** A Settings screen's staged change is in force (OK writes it, Cancel puts this look back). */
  staged: z.boolean(),
});
export type Look = z.infer<typeof Look>;

/** A theme as a look names it: the UI's, or the editor scheme's. */
export type LookThemeName = Look['theme'];

/**
 * A change shown before it is written (#108 Behaviour 4: Appearance changes are live while
 * staged): any of the theme, density and fonts, and colours over the theme.
 */
export const LookStage = z.strictObject({
  theme: z.string().min(1).optional(),
  /** `editor.scheme` staged: `theme` or a theme's slug. */
  scheme: z.string().min(1).optional(),
  density: z.enum(DENSITIES).optional(),
  font: LookFont.partial().optional(),
  tokens: z.record(z.string(), Hex).optional(),
});
export type LookStage = z.output<typeof LookStage>;

/** The settings a look reads. */
export type LookSettings = {
  'ui.theme': string;
  'editor.scheme': string;
  'ui.density': (typeof DENSITIES)[number];
  'ui.font.family': string;
  'ui.font.size': number;
  'ui.font.editorFamily': string;
  'ui.font.editorSize': number;
  'ui.font.ligatures': boolean;
};

/** The settings' own defaults: Islands Dark, compact, Inter 13 and JetBrains Mono 13. */
export const DEFAULT_LOOK_SETTINGS: LookSettings = {
  'ui.theme': SETTINGS['ui.theme'].default,
  'editor.scheme': SETTINGS['editor.scheme'].default,
  'ui.density': SETTINGS['ui.density'].default,
  'ui.font.family': SETTINGS['ui.font.family'].default,
  'ui.font.size': SETTINGS['ui.font.size'].default,
  'ui.font.editorFamily': SETTINGS['ui.font.editorFamily'].default,
  'ui.font.editorSize': SETTINGS['ui.font.editorSize'].default,
  'ui.font.ligatures': SETTINGS['ui.font.ligatures'].default,
};

const fallback = (catalogue: readonly Theme[]): Theme => {
  const theme = catalogue.find((t) => t.slug === DEFAULT_THEME) ?? builtInThemes()[0];

  if (theme === undefined) throw new Error('no built-in theme');

  return theme;
};

const nameOf = (theme: Theme): LookThemeName => ({
  slug: theme.slug,
  name: theme.name,
  dark: BUILT_IN[theme.base].dark,
  syntax: BUILT_IN[theme.base].syntax,
});

const SCHEME_TOKENS: ReadonlySet<string> = new Set(
  TOKENS.filter((t) => SCHEME_GROUPS.includes(t.group)).map((t) => t.name),
);

/** A token an editor scheme gives (#345): the editor, git, diff and terminal groups'. */
export const isSchemeToken = (name: string): boolean => SCHEME_TOKENS.has(name);

/**
 * The theme an editor scheme names (#345): the theme itself for `theme` or a scheme no one has
 * (a missing one falls back to the theme's own colours, never to another theme).
 */
export const schemeTheme = (
  scheme: string,
  theme: Theme,
  catalogue: readonly Theme[],
): { theme: Theme; follows: boolean } => {
  const named = scheme === SAME_AS_THEME ? undefined : catalogue.find((t) => t.slug === scheme);

  return named === undefined ? { theme, follows: true } : { theme: named, follows: false };
};

/**
 * The look in force: `ui.theme` from the catalogue (a theme no one has falls back to Islands
 * Dark), its editor colours from `editor.scheme` (#345: the theme's own, or a named theme's editor,
 * git, diff and terminal tokens over it), the density and fonts, a stage over them all. A stage's
 * colours are the Colours editor's: over the scheme's theme when one is named, else the theme's.
 */
export const lookOf = (
  settings: LookSettings,
  catalogue: readonly Theme[],
  stage?: LookStage,
): Look => {
  const wanted = stage?.theme ?? settings['ui.theme'];
  const theme = catalogue.find((t) => t.slug === wanted) ?? fallback(catalogue);
  const scheme = schemeTheme(stage?.scheme ?? settings['editor.scheme'], theme, catalogue);
  const extra: Partial<Record<TokenName, Hex>> = {};

  for (const [name, hex] of Object.entries(stage?.tokens ?? {}))
    if (isTokenName(name)) extra[name] = hex;
  const own = (t: Theme, edits: boolean) =>
    resolveTheme({ base: t.base, changes: edits ? { ...t.changes, ...extra } : t.changes });
  const tokens: Record<string, Hex> = own(theme, scheme.follows);

  if (!scheme.follows) {
    const editor = own(scheme.theme, true);

    for (const name of TOKEN_NAMES) if (isSchemeToken(name)) tokens[name] = editor[name];
  }

  return {
    theme: nameOf(theme),
    scheme: { ...nameOf(scheme.theme), follows: scheme.follows },
    tokens,
    density: stage?.density ?? settings['ui.density'],
    font: {
      family: stage?.font?.family ?? settings['ui.font.family'],
      size: stage?.font?.size ?? settings['ui.font.size'],
      editorFamily: stage?.font?.editorFamily ?? settings['ui.font.editorFamily'],
      editorSize: stage?.font?.editorSize ?? settings['ui.font.editorSize'],
      ligatures: stage?.font?.ligatures ?? settings['ui.font.ligatures'],
    },
    staged: stage !== undefined,
  };
};

// ---------------------------------------------------------------- the commands' answers

const ThemeRow = z.strictObject({
  slug: z.string(),
  name: z.string(),
  base: BuiltInTheme,
  source: ThemeSource,
  dark: z.boolean(),
  /** The one `ui.theme` names (or the fallback while it names none there is). */
  current: z.boolean(),
  /** How many tokens it changes over its base. */
  changed: z.number().int().nonnegative(),
  /** Every token's colour, for its preview cell. */
  tokens: z.record(z.string(), z.string()),
});
export type ThemeRow = z.infer<typeof ThemeRow>;

/** `abe theme list`: every theme, the current one marked, and the files that do not read. */
export const ThemeListData = z.strictObject({
  themes: z.array(ThemeRow),
  problems: z.array(z.strictObject({ file: z.string(), message: z.string() })),
});
export type ThemeListData = z.infer<typeof ThemeListData>;

/** One token of a theme, as the Colours editor shows it. */
export const ThemeToken = z.strictObject({
  name: z.string(),
  group: z.enum(TOKEN_GROUPS),
  value: z.string(),
  /** Its base's colour when the theme changes it (`· was #b589ec`), else null. */
  was: z.string().nullable(),
  usage: z.string(),
});
export type ThemeToken = z.infer<typeof ThemeToken>;

/** `abe theme show <slug>`: the theme and its every token, by group. */
export const ThemeShowData = z.strictObject({
  theme: ThemeRow,
  groups: z.array(
    z.strictObject({
      group: z.enum(TOKEN_GROUPS),
      label: z.string(),
      count: z.number().int(),
      changed: z.number().int(),
      tokens: z.array(ThemeToken),
    }),
  ),
});
export type ThemeShowData = z.infer<typeof ThemeShowData>;

/** `abe theme save`: the file written and the tokens it holds. */
export const ThemeSaveData = z.strictObject({
  slug: z.string(),
  name: z.string(),
  file: z.string(),
  tokens: z.record(z.string(), z.string()),
  /** Another theme of yours the file held, replaced (`--replace`, #177); `null`: none. */
  replaced: z.strictObject({ name: z.string(), changed: z.number().int() }).nullable(),
});
export type ThemeSaveData = z.infer<typeof ThemeSaveData>;

const sourceWords = (s: ThemeSource): string => {
  switch (s.kind) {
    case 'built-in':
      return 'built-in';
    case 'yours':
      return 'yours';
  }
};

/** A theme's row for `list` / `show`. */
export const themeRow = (theme: Theme, current: string): ThemeRow => ({
  slug: theme.slug,
  name: theme.name,
  base: theme.base,
  source: theme.source,
  dark: BUILT_IN[theme.base].dark,
  current: theme.slug === current,
  changed: Object.keys(theme.changes).length,
  tokens: resolveTheme(theme),
});

const slugsOf = (catalogue: readonly Theme[]) => catalogue.map((t) => t.slug).join(', ');

/** The theme `typed` names: by its slug, else by its name as `theme list` shows it (#177). */
export const findTheme = (catalogue: readonly Theme[], typed: string): Theme | undefined =>
  catalogue.find((t) => t.slug === typed) ??
  catalogue.find((t) => t.name.toLowerCase() === typed.trim().toLowerCase());

/**
 * Why a slug is no theme (`theme show`, `settings set ui.theme`, a stage): the themes there are;
 * a theme's name typed for its slug is told its slug (#177).
 */
export const noThemeText = (slug: string, catalogue: readonly Theme[]): string => {
  const named = findTheme(catalogue, slug);

  return named === undefined
    ? `no theme ${slug}; the themes: ${slugsOf(catalogue)}`
    : `no theme ${slug}: that is ${named.name}'s name, its slug is ${named.slug}; the themes: ${slugsOf(catalogue)}`;
};

/** `1 changed token`, `3 changed tokens`. */
export const changedTokens = (n: number): string => `${n} changed token${n === 1 ? '' : 's'}`;

/**
 * `--tokens` of `theme save` read (#177): a JSON object of token names and colours, each wrong
 * entry said in words (`frame-bg: red is not a colour like #b589ec`), unknown names first.
 */
export const readTokenEdits = (
  text: string,
):
  | { ok: true; edits: Partial<Record<TokenName, Hex>> }
  | { ok: false; code: string; message: string } => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, code: 'bad-tokens', message: '--tokens is not JSON' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc))
    return {
      ok: false,
      code: 'bad-tokens',
      message: '--tokens is no object of colours, like {"abe-needs-you": "#a979f7"}',
    };
  const entries = Object.entries(doc);
  const unknown = entries.map(([n]) => n).filter((n) => !isTokenName(n));

  if (unknown.length > 0)
    return { ok: false, code: 'unknown-token', message: `no such colour: ${unknown.join(', ')}` };
  const edits: Partial<Record<TokenName, Hex>> = {};
  const wrong: string[] = [];

  for (const [name, value] of entries) {
    const hex = Hex.safeParse(value);

    if (!isTokenName(name)) continue;
    if (hex.success) edits[name] = hex.data;
    else
      wrong.push(
        `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)} is not a colour like #b589ec (or #rrggbbaa)`,
      );
  }

  return wrong.length === 0
    ? { ok: true, edits }
    : { ok: false, code: 'bad-tokens', message: wrong.join('; ') };
};

/**
 * `ui.theme` in force naming no theme of the catalogue (#172): a problem of the Layer that wrote
 * it, saying what is drawn in its place; `undefined` when the theme is there.
 */
export const unknownThemeProblem = (
  merged: Merged,
  catalogue: readonly Theme[],
): SettingProblem | undefined => {
  const e = merged.explain('ui.theme');
  const slug = e.value;
  const file = e.layers.find((step) => step.layer === e.winner && step.applied)?.file ?? null;

  if (typeof slug !== 'string' || file === null || catalogue.some((t) => t.slug === slug))
    return undefined;
  const drawn = catalogue.find((t) => t.slug === DEFAULT_THEME)?.name ?? DEFAULT_THEME;

  return {
    code: 'unknown-theme',
    layer: e.winner,
    file,
    key: 'ui.theme',
    message: noThemeText(slug, catalogue).replace(/;/, `, so ${drawn} is drawn;`),
  };
};

/**
 * `editor.scheme` in force naming no theme of the catalogue (#345): a problem of the Layer that
 * wrote it; the editor takes the theme's own colours in its place.
 */
export const unknownSchemeProblem = (
  merged: Merged,
  catalogue: readonly Theme[],
): SettingProblem | undefined => {
  const e = merged.explain('editor.scheme');
  const slug = e.value;
  const file = e.layers.find((step) => step.layer === e.winner && step.applied)?.file ?? null;

  if (
    typeof slug !== 'string' ||
    slug === SAME_AS_THEME ||
    file === null ||
    catalogue.some((t) => t.slug === slug)
  )
    return undefined;

  return {
    code: 'unknown-scheme',
    layer: e.winner,
    file,
    key: 'editor.scheme',
    message: noThemeText(slug, catalogue).replace(/;/, ", so the editor takes the theme's own;"),
  };
};

/** The slug `ui.theme` names, or the fallback when no theme has it. */
export const currentTheme = (wanted: string, catalogue: readonly Theme[]): string =>
  catalogue.some((t) => t.slug === wanted) ? wanted : DEFAULT_THEME;

/** `show`'s groups: every token of `theme`, its base's colour beside a changed one. */
export const themeGroups = (theme: Theme): ThemeShowData['groups'] => {
  const now = resolveTheme(theme);
  const was = baseValues(theme.base);

  return TOKEN_GROUPS.map((group) => {
    const tokens = TOKENS.filter((t) => t.group === group).map((t): ThemeToken => ({
      name: t.name,
      group,
      value: now[t.name],
      was: now[t.name] === was[t.name] ? null : was[t.name],
      usage: t.usage,
    }));

    return {
      group,
      label: TOKEN_GROUP_LABELS[group],
      count: tokens.length,
      changed: tokens.filter((t) => t.was !== null).length,
      tokens,
    };
  });
};

export const themeListText = (d: ThemeListData): string => {
  const width = Math.max(0, ...d.themes.map((t) => t.name.length)) + 2;
  const slugs = Math.max(0, ...d.themes.map((t) => t.slug.length)) + 2;
  // the slug beside the name: what show, save and ui.theme take (#177)
  const lines = d.themes.map(
    (t) =>
      `${t.name.padEnd(width)}${t.slug.padEnd(slugs)}${[
        sourceWords(t.source),
        ...(t.current ? ['current'] : []),
        ...(t.changed > 0 ? [`${t.changed} changed over ${builtInName(t.base)}`] : []),
      ].join(' · ')}`,
  );

  return `${[...lines, ...d.problems.map((p) => `⚠ ${p.file}: ${p.message}`)].join('\n')}\n`;
};

export const themeShowText = (d: ThemeShowData): string => {
  const total = d.groups.reduce((n, g) => n + g.count, 0);
  const head = `${d.theme.name}  ${sourceWords(d.theme.source)}${d.theme.current ? ' · current' : ''} · ${total} tokens in ${d.groups.length} groups`;
  const groups = d.groups.flatMap((g) => [
    `${g.label}  ${g.count}${g.changed > 0 ? ` · ${g.changed} changed` : ''}`,
    ...g.tokens.map(
      (t) => `  ${t.name.padEnd(28)}${t.value}${t.was === null ? '' : ` · was ${t.was}`}`,
    ),
  ]);

  return `${[head, ...groups].join('\n')}\n`;
};

export const lookText = (d: Look): string =>
  `${[
    `${d.theme.name} (${d.theme.slug}, ${d.theme.dark ? 'dark' : 'light'})${d.staged ? ' · staged' : ''}`,
    ...(d.scheme.follows
      ? []
      : [`editor scheme ${d.scheme.name} (${d.scheme.slug}, ${d.scheme.dark ? 'dark' : 'light'})`]),
    `density ${d.density}`,
    `UI font ${d.font.family} ${d.font.size} · editor and terminal ${d.font.editorFamily} ${d.font.editorSize}${d.font.ligatures ? ' · ligatures' : ''}`,
  ].join('\n')}\n`;

export const themeSaveText = (d: ThemeSaveData): string =>
  `saved ${d.name} (${d.slug}) to ${d.file}: ${changedTokens(Object.keys(d.tokens).length)}${
    d.replaced === null
      ? ''
      : `, replacing your ${d.replaced.name} (${changedTokens(d.replaced.changed)})`
  }\n`;
