/**
 * Settings' themes and Colours (#108 S4, T-Appearance, T-Colours; #345 split of `settings.ts`): the
 * theme list, the token editor under Editor › Color scheme.
 */
import {
  type SettingsDialogRules,
  type ThemeRow,
  type ThemeShowData,
  type ThemeToken,
} from '@abe/core';
import { type Answer, type Refused } from '../runtime/runtime';
import { type ThemeCell, type SettingsGroup, type SettingRow } from './settings-components';
import { type Line, hitsOn, lines, pageLines, without } from './settings-rows';
import {
  COLOURS_ROW,
  type ColoursKey,
  type Editing,
  LEFT,
  type Out,
  RIGHT,
  SCHEME_KEY,
  type SettingsState,
  THEME_KEY,
  type Write,
  editMode,
  editingOf,
  same,
  status,
  unedit,
  COLOURS_PAGE,
  downOf,
  edited,
  refusal,
  plural,
} from './settings-state';
import { saveColours, setArgv, written } from './settings-writes';
import { tokenHelp } from './settings-words';
import { settingNode, page } from './settings-view';
import { type Node } from '../runtime/components';

export const readThemes = (s: SettingsState): Out => {
  const runs = s.runs + 1;

  return {
    state: { ...s, runs, themes: {} },
    commands: [{ kind: 'run', id: `settings:themes:${runs}`, argv: ['theme', 'list'] }],
  };
};

export const themesAnswered = (s: SettingsState, input: Answer | Refused): Out => {
  if (!input.reply.ok) return same({ ...s, themes: { down: downOf(input.reply.error) } });
  if (input.command === 'theme list') {
    return coloursDue({ ...s, themes: { data: input.reply.data } });
  }

  return same(s);
};

/**
 * Colours read once both the rows and the themes are in (#345: which theme they edit is the
 * scheme's while one is named), and again when that changes under them with nothing changed.
 */
export const coloursDue = (s: SettingsState): Out => {
  const edited = s.list === undefined ? undefined : coloursTheme(s);
  const c = s.colours;

  if (edited === undefined) return same(s);
  if (c?.key === edited.key && c.slug === edited.slug) return same(s);
  if (c !== undefined && Object.keys(c.changed).length > 0) return same(s);

  return readColours(s, edited.slug, edited.key);
};

/**
 * The theme Colours edits (#345): the editor scheme's while one is named (only its editor, git,
 * diff and terminal colours), else the theme in force.
 */
const coloursTheme = (s: SettingsState): { slug: string; key: ColoursKey } | undefined => {
  const scheme = s.list?.rows.find((l) => l.key === SCHEME_KEY && l.field === null)?.value;
  const named = themeRows(s).find((t) => t.slug === scheme);

  if (named !== undefined) return { slug: named.slug, key: SCHEME_KEY };
  const current = themeRows(s).find((t) => t.current);

  return current === undefined ? undefined : { slug: current.slug, key: THEME_KEY };
};

/** The setting Colours' save sets. */
export const coloursKey = (s: SettingsState): ColoursKey => s.colours?.key ?? THEME_KEY;

/** A theme picked and not read back yet (the theme, or the editor scheme): Colours wait for it. */
const pickedTheme = (s: SettingsState): string | undefined => {
  // only the pick of the theme Colours edit stands in their way (#345)
  const st = Object.values(s.changes).find((x) => x.key === coloursKey(s));

  if (st === undefined) return undefined;
  const theme = s.colours?.data?.theme.name ?? 'the theme';
  const what = st.key === SCHEME_KEY ? 'scheme' : 'theme';

  return `Colours edit ${theme}, the ${what} in force: the ${what} picked is still saving`;
};

/** Colours' tokens changed, saved at once; ⌘Z puts `before` back. */
const tokensSaved = (s: SettingsState, before: SettingsState, label: string): Out =>
  saveColours(s, { kind: 'colours', label, changed: before.colours?.changed ?? {} });

const sameTokens = (a: SettingsState, b: SettingsState) =>
  JSON.stringify(a.colours?.changed ?? {}) === JSON.stringify(b.colours?.changed ?? {});

// ---------------------------------------------------------------- Colours (#108 S4, T-Colours)

const readColours = (s: SettingsState, slug: string, key: ColoursKey): Out => {
  const runs = s.runs + 1;
  const read = `settings:colours:${runs}`;

  return {
    state: {
      ...s,
      runs,
      colours: { key, slug, read, filter: s.colours?.filter ?? '', changed: {} },
    },
    commands: [{ kind: 'run', id: read, argv: ['theme', 'show', slug] }],
  };
};

export const coloursAnswered = (
  r: SettingsDialogRules,
  s: SettingsState,
  input: Answer | Refused,
): Out => {
  const c = s.colours ?? { key: THEME_KEY, filter: '', changed: {} };

  if (c.read !== undefined && c.read !== input.id) return same(s);
  if (!input.reply.ok) return same({ ...s, colours: { ...c, down: downOf(input.reply.error) } });
  if (input.command !== 'theme show') return same(s);
  const d = input.reply.data;
  // a named scheme gives the editor its colours alone: the chrome's stay the theme's (#345)
  const data =
    c.key === SCHEME_KEY
      ? { ...d, groups: d.groups.filter((g) => r.schemeGroups.includes(g.group)) }
      : d;

  return same({ ...s, colours: { ...c, data, down: undefined } });
};

/** A colour as core takes it: `#rrggbb`, or `#rrggbbaa` (the scrims, the washes). */
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Colours' filter as matched: trimmed, in lower case (`''`: none). */
export const colourQuery = (s: SettingsState) => (s.colours?.filter ?? '').trim().toLowerCase();

/** The tokens the filter leaves: a token whose name holds what is typed. */
export const shownTokens = (s: SettingsState): ThemeToken[] => {
  const q = colourQuery(s);

  return (s.colours?.data?.groups ?? []).flatMap((g) =>
    g.tokens.filter((t) => q === '' || t.name.includes(q)),
  );
};

export type TokenGroup = ThemeShowData['groups'][number];

/**
 * Colours' lines: the filter, then each group with tokens the filter leaves, its tokens under it
 * while it is open (a filter typed opens every group it leaves).
 */
export const colourLines = (
  s: SettingsState,
  row: string,
  hits: ReadonlySet<string> = new Set(),
): Line[] => {
  // the page picked while searching (#345): the groups with hits open, Colours' own filter aside
  const found = (s.colours?.data?.groups ?? []).some((g) => g.tokens.some((t) => hits.has(t.name)));
  const q = found ? '' : colourQuery(s);

  return [
    { kind: 'colours-reset', row },
    { kind: 'colours-filter', row },
    ...(s.colours?.data?.groups ?? []).flatMap((group): Line[] => {
      const tokens = group.tokens.filter((t) => q === '' || t.name.includes(q));

      if (tokens.length === 0) return [];
      const open =
        q !== '' ||
        s.tokensOpen.includes(group.group) ||
        (found && tokens.some((t) => hits.has(t.name)));

      return [
        { kind: 'token-group', row, group },
        ...(open ? tokens.map((token): Line => ({ kind: 'token', row, token })) : []),
      ];
    }),
  ];
};

/** A token group folded or unfolded (`open`), the cursor on its head. */
export const foldTokens = (
  r: SettingsDialogRules,
  s: SettingsState,
  group: string,
  open: boolean,
): SettingsState => {
  const tokensOpen = open
    ? [...s.tokensOpen.filter((g) => g !== group), group]
    : s.tokensOpen.filter((g) => g !== group);
  const next = { ...s, tokensOpen };
  const at = lines(r, next).findIndex((l) => l.kind === 'token-group' && l.group.group === group);

  return at < 0 ? next : { ...next, row: at };
};

/** Folding keys on Colours (#300): ä opens a group, k on its head or a token folds it. */
export const colourFoldKey = (
  r: SettingsDialogRules,
  s: SettingsState,
  line: Line | undefined,
  key: string,
): Out | undefined => {
  // while a filter is typed every group it leaves is open: k goes to the tree as on any row
  if (colourQuery(s) !== '') return undefined;
  if (line?.kind === 'token-group') {
    const open = s.tokensOpen.includes(line.group.group);

    if (RIGHT.has(key) && !open) return same(foldTokens(r, s, line.group.group, true));
    if (LEFT.has(key) && open) return same(foldTokens(r, s, line.group.group, false));
  }
  if (line?.kind === 'token' && LEFT.has(key))
    return same(foldTokens(r, s, line.token.group, false));

  return undefined;
};

/** A token's colour as shown: changed here (saved over the theme read), else the theme's. */
export const tokenValue = (s: SettingsState, t: ThemeToken): string =>
  s.colours?.changed[t.name] ?? t.value;

/** Its base's colour: the theme file's change, or one changed here (`· was #b589ec`). */
export const tokenWas = (s: SettingsState, t: ThemeToken): string | undefined => {
  const base = t.was ?? t.value;

  return tokenValue(s, t) === base ? undefined : base;
};

const putToken = (s: SettingsState, name: string, hex: string | undefined): SettingsState => {
  const c = s.colours ?? { key: THEME_KEY, filter: '', changed: {} };
  const changed = hex === undefined ? without(c.changed, name) : { ...c.changed, [name]: hex };

  return { ...s, colours: { ...c, changed } };
};

/** A colour field closed unconfirmed (Close, ⌘, again): its old hex back, as Esc does. */
export const unconfirmed = (s: SettingsState): SettingsState => {
  const e = editingOf(s);

  return e?.kind === 'token' ? putToken(s, e.name, e.before) : s;
};

/** ⏎ on Colours' lines: the filter takes the typing, a token's hex becomes a colour field. */
export const colourChange = (s: SettingsState, line: Line): Out | undefined => {
  if (line.kind === 'colours-filter')
    return same({
      ...s,
      mode: editMode({ kind: 'colours-filter', row: line.row, text: s.colours?.filter ?? '' }),
    });
  const picked = pickedTheme(s);

  if (line.kind === 'token' && picked !== undefined)
    return { state: s, commands: [status(picked)] };
  if (line.kind === 'token')
    return same({
      ...s,
      mode: editMode({
        kind: 'token',
        row: line.row,
        name: line.token.name,
        text: tokenValue(s, line.token),
        before: s.colours?.changed[line.token.name],
      }),
    });

  return undefined;
};

/** Every token differing from its base theme's colour: changed here or in the theme file. */
export const tokensChanged = (s: SettingsState): ThemeToken[] =>
  (s.colours?.data?.groups ?? []).flatMap((g) =>
    g.tokens.filter((t) => tokenWas(s, t) !== undefined),
  );

/** The base theme by its name: `Islands Dark` for Islands Dark (yours) too. */
export const baseName = (s: SettingsState): string => {
  const theme = s.colours?.data?.theme;

  if (theme === undefined) return 'the theme';

  return themeRows(s).find((t) => t.slug === theme.base)?.name ?? theme.name;
};

/** Reset colours (#325): each changed token back to its base theme's colour, saved at once. */
export const resetColours = (s: SettingsState): Out => {
  const picked = pickedTheme(s);

  if (picked !== undefined) return { state: s, commands: [status(picked)] };
  const changed = tokensChanged(s);

  if (changed.length === 0)
    return {
      state: s,
      commands: [status(`${baseName(s)}’s colours are its own: nothing to reset`)],
    };

  return tokensSaved(changed.reduce(tokenBack, s), s, 'Reset colours');
};

/**
 * A token back at its base theme's colour: a change the theme file holds is undone by saving the
 * base colour, one changed here (saved already) by saving the theme's own as read.
 */
const tokenBack = (s: SettingsState, t: ThemeToken): SettingsState =>
  putToken(s, t.name, t.was ?? (s.colours?.changed[t.name] === undefined ? undefined : t.value));

/**
 * Colours' changes as they were before a save (⌘Z): each token changed since back at its colour
 * then, one not changed then at the theme's own as read, so the save writes it back too.
 */
export const coloursBack = (
  s: SettingsState,
  before: Readonly<Record<string, string>>,
): SettingsState => {
  const c = s.colours;

  if (c === undefined) return s;
  const tokens = new Map((c.data?.groups ?? []).flatMap((g) => g.tokens).map((t) => [t.name, t]));
  const since = Object.keys(c.changed).filter((name) => !Object.hasOwn(before, name));
  const back = Object.fromEntries(
    since.flatMap((name) => {
      const value = tokens.get(name)?.value;

      return value === undefined ? [] : [[name, value]];
    }),
  );

  return { ...s, colours: { ...c, changed: { ...before, ...back } } };
};

/** ⌫ on a changed token: back to its base theme's colour. */
export const resetToken = (s: SettingsState, t: ThemeToken): Out =>
  tokenWas(s, t) === undefined ? same(s) : tokensSaved(tokenBack(s, t), s, t.name);

export const colourEditKey = (
  s: SettingsState,
  e: Extract<Editing, { kind: 'colours-filter' | 'token' }>,
  key: string,
): Out => {
  if (e.kind === 'colours-filter') {
    if (key === '<CR>' || key === '<Esc>') return same({ ...s, mode: unedit(s) });
    const text = edited(e.text, key);

    return same(colourFilter({ ...s, mode: editMode({ ...e, text }) }, text));
  }
  if (key === '<Esc>') return same({ ...putToken(s, e.name, e.before), mode: unedit(s) });
  if (key === '<CR>') {
    if (!HEX.test(e.text))
      return same({
        ...s,
        errors: { ...s.errors, [e.row]: `${e.text}: not #RRGGBB or #RRGGBBAA` },
      });
    // any token, not only the filter's: a search's result may be one the filter hides
    const t = (s.colours?.data?.groups ?? [])
      .flatMap((g) => g.tokens)
      .find((x) => x.name === e.name);
    const hex = e.text.toLowerCase();
    // back at the theme's own colour: nothing to save
    const kept = hex === t?.value ? undefined : hex;
    const before = putToken(s, e.name, e.before);

    if (sameTokens(before, putToken(s, e.name, kept)))
      return same({ ...before, mode: unedit(s), errors: without(s.errors, e.row) });

    return tokensSaved(
      { ...putToken(s, e.name, kept), mode: unedit(s), errors: without(s.errors, e.row) },
      before,
      e.name,
    );
  }

  return colourTyped(s, e, edited(e.text, key));
};

/** Text into a colour field: each valid `#rrggbb` is live at once. */
export const colourTyped = (
  s: SettingsState,
  e: Extract<Editing, { kind: 'token' }>,
  text: string,
): Out => {
  const next = { ...s, mode: editMode({ ...e, text }) };

  return same(HEX.test(text) ? putToken(next, e.name, text.toLowerCase()) : next);
};

export const colourFilter = (s: SettingsState, filter: string): SettingsState => {
  const c = s.colours ?? { key: THEME_KEY, filter: '', changed: {} };

  return { ...s, colours: { ...c, filter } };
};

/** The theme save answered: `ui.theme` set yours to the theme it wrote, then the rest closes it. */
export const colourSaved = (s: SettingsState, input: Answer | Refused): Out => {
  if (!Object.hasOwn(s.writing, input.id)) return same(s);
  // refused: the colours stay as changed and live, the reason on the Filter row and the status
  if (!input.reply.ok) {
    const why = `Colours not saved: ${refusal(input.reply.error)}`;

    return {
      state: {
        ...s,
        writing: without(s.writing, input.id),
        errors: { ...s.errors, [COLOURS_ROW]: why },
      },
      commands: [status(why)],
    };
  }
  if (input.command !== 'theme save') return same(s);
  const saved = input.reply.data;
  const told =
    saved.replaced === null
      ? []
      : [status(`Colours saved as ${saved.name}, replacing your earlier one`)];
  const theme = s.colours?.data?.theme;
  const key = coloursKey(s);
  // the theme in force already (yours): nothing more to write. The changes stay over the read
  // theme (and live) until the dialog closes, so the window never shows the old colours in
  // between. A named scheme is the scheme in force by being edited (#345).
  if ((key === SCHEME_KEY || theme?.current === true) && theme?.slug === saved.slug) {
    const done = written(s, input.id, undefined);

    return { ...done, commands: [...told, ...done.commands] };
  }
  const next = { ...s, writing: without(s.writing, input.id) };
  const runs = s.runs + 1;
  const id = `settings:set:${runs}`;
  const w: Write = {
    key,
    rows: [],
    fields: null,
    typed: saved.slug,
    undo: s.writing[input.id]?.undo,
  };

  return {
    state: { ...next, runs, writing: { ...next.writing, [id]: w } },
    commands: [...told, { kind: 'run', id, argv: setArgv(w, saved.slug) }],
  };
};

/** The theme save: the changed tokens over the theme in force, as `abe theme save` takes them. */
export const colourSave = (
  s: SettingsState,
): { slug: string; tokens: Record<string, string> } | undefined => {
  const c = s.colours;
  const slug = c?.data?.theme.slug;

  if (c === undefined || slug === undefined || Object.keys(c.changed).length === 0)
    return undefined;

  return { slug, tokens: { ...c.changed } };
};

const fromWords = (source: ThemeRow['source']): string => {
  switch (source.kind) {
    case 'yours':
      return 'yours';
    case 'built-in':
      return '';
  }
};

/** A cell's line: `yours`, `current`; a built-in one says only whether it is current (#345). */
const sourceWords = (t: ThemeRow): string =>
  [fromWords(t.source), ...(t.current ? ['current'] : [])].filter((w) => w !== '').join(' · ');

/** A theme's preview cell: the colours of a mini window (strip tab, card, status bar) from its tokens. */
export const themeCell = (t: ThemeRow): ThemeCell => {
  const c = (name: string, fallback: string) => t.tokens[name] ?? fallback;

  return {
    slug: t.slug,
    name: t.name,
    source: sourceWords(t),
    colors: {
      frame: c('frame-bg', '#26282b'),
      panel: c('panel-bg', '#191a1c'),
      editor: c('editor-bg', '#1e1f22'),
      text: c('text', '#d1d3d9'),
      dim: c('text-dim', '#6f737a'),
      accent: c('abe-accent', '#6b9bfa'),
      selection: c('tab-selected-bg', '#25324d'),
      needsYou: c('abe-needs-you', '#5ec8c0'),
      good: c('abe-good', '#5fad65'),
      border: c('island-border', '#2b2d30'),
    },
  };
};

export const themeRows = (s: SettingsState): readonly ThemeRow[] => s.themes?.data?.themes ?? [];

/** A Colours line as a row: the filter field, or a token's swatch, hex and usage. */
export const colourNode = (
  s: SettingsState,
  line: Line,
  at: number,
  hit = false,
): SettingRow | undefined => {
  const focused = s.focus === 'page' && s.row === at;
  const e = editingOf(s);

  if (line.kind === 'colours-reset') {
    const n = tokensChanged(s).length;

    return {
      kind: 'SettingRow',
      id: `settings:line:${at}`,
      props: {
        label: 'Reset colours',
        control: {
          kind: 'value',
          // drawn once the colours are read (`pageLines`)
          text: n === 0 ? 'nothing changed' : `${n} changed`,
        },
        help: `back to ${baseName(s)}’s own colours`,
        source: { text: '' },
        ...(focused ? { focused, ...(n === 0 ? {} : { hint: '⏎ reset' }) } : {}),
      },
    };
  }

  if (line.kind === 'colours-filter') {
    const editing = e?.kind === 'colours-filter';
    const saveRefused = e?.kind === 'token' ? undefined : s.errors[COLOURS_ROW];
    const groups = s.colours?.data?.groups ?? [];
    const total = groups.reduce((n, g) => n + g.count, 0);
    const n = shownTokens(s).length;

    return {
      kind: 'SettingRow',
      id: `settings:line:${at}`,
      props: {
        label: 'Filter',
        control: {
          kind: 'field',
          text: editing ? e.text : (s.colours?.filter ?? ''),
          ...(editing ? { editing } : {}),
        },
        source: {
          text:
            colourQuery(s) === ''
              ? `${total} in ${groups.length} groups`
              : `${plural(n, 'token')} ${n === 1 ? 'matches' : 'match'} · ${total} in ${groups.length} groups`,
        },
        ...(focused ? { focused, hint: '⏎ type to filter' } : {}),
        ...(saveRefused === undefined ? {} : { error: saveRefused }),
      },
    };
  }
  if (line.kind !== 'token') return undefined;
  const t = line.token;
  const editing = e?.kind === 'token' && e.name === t.name ? e : undefined;
  const was = tokenWas(s, t);
  const changed = was !== undefined && s.colours?.changed[t.name] !== undefined;
  const error = editing === undefined ? undefined : s.errors[editing.row];

  return {
    kind: 'SettingRow',
    id: `settings:line:${at}`,
    props: {
      label: t.name,
      control: {
        kind: 'colour',
        hex: tokenValue(s, t),
        ...(editing === undefined ? {} : { editing: true, text: editing.text }),
      },
      help: tokenHelp(t.usage),
      source: was === undefined ? { text: '' } : { text: `was ${was}`, tone: 'link' },
      ...(focused ? { focused, hint: was === undefined ? '⏎ change' : '⏎ change · ⌫ reset' } : {}),
      ...(changed ? { changed } : {}),
      ...(hit ? { hit } : {}),
      ...(error === undefined ? {} : { error }),
    },
  };
};

/** Color scheme with its Colours (T-Colours, #345): the scheme, then the filter and each token group. */
export const coloursPage = (
  r: SettingsDialogRules,
  s: SettingsState,
  crumbs: string[],
  scope: string,
): Node => {
  const ls = pageLines(r, s, COLOURS_PAGE).map((line, at) => ({ line, at }));
  const hits = hitsOn(r, s);
  const groups: SettingsGroup[] = [];
  const settingsGroup = (caption: string | null, rows: Node[]) =>
    groups.push({
      kind: 'SettingsGroup',
      id: `settings:group:${groups.length}`,
      props: caption === null ? {} : { caption },
      children: rows,
    });
  let held: { caption: string | null; rows: Node[] } | undefined;
  const flush = () => {
    if (held !== undefined) settingsGroup(held.caption, held.rows);
    held = undefined;
  };

  // Colours in its place: the filter, then each group's head and, while open, its tokens (#300)
  const theme = s.colours?.data?.theme.name ?? '';
  const tokenGroup = (g: TokenGroup, head: number): SettingsGroup => {
    const rows = ls.flatMap(({ line, at }) => {
      const n =
        line.kind === 'token' && line.token.group === g.group
          ? colourNode(s, line, at, hits.has(line.token.name))
          : undefined;

      return n === undefined ? [] : [n];
    });
    // what differs from the base theme: a reset back to it counts no more (#325)
    const changed = g.tokens.filter((t) => tokenWas(s, t) !== undefined).length;
    const open = rows.length > 0;
    const focused = s.focus === 'page' && s.row === head;

    return {
      kind: 'SettingsGroup',
      id: `settings:colours:${g.group}`,
      props: { tight: true },
      children: [
        {
          kind: 'SettingRow',
          id: `settings:line:${head}`,
          props: {
            label: `${open ? '▾' : '▸'} ${g.label}`,
            control: { kind: 'value', text: plural(g.count, 'token') },
            source: { text: changed > 0 ? `${changed} changed` : '' },
            ...(focused ? { focused, hint: open ? '⏎ hides them' : '⏎ shows them' } : {}),
          },
        },
        ...rows,
      ],
    };
  };
  let reset: SettingRow | undefined;
  const colours = (filter: SettingRow | undefined): SettingsGroup[] => [
    {
      kind: 'SettingsGroup',
      id: 'settings:colours',
      props: {
        caption: 'Colours',
        note: `${theme} · a change saves your copy, never the built-in`,
      },
      children: [reset, filter].filter((n) => n !== undefined),
    },
    ...ls.flatMap(({ line, at }) =>
      line.kind === 'token-group' ? [tokenGroup(line.group, at)] : [],
    ),
  ];

  for (const { line, at } of ls) {
    if (line.kind === 'setting') {
      if (held?.caption !== line.row.group) {
        flush();
        held = { caption: line.row.group, rows: [] };
      }
      held.rows.push(settingNode(r, s, line, at));
    } else if (line.kind === 'colours-reset') {
      reset = colourNode(s, line, at);
    } else if (line.kind === 'colours-filter') {
      flush();
      groups.push(...colours(colourNode(s, line, at)));
    }
  }
  flush();

  return page(crumbs, scope, groups, s.row);
};
