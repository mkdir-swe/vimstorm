/**
 * `/` in the Settings dialog (#108): one matcher over every page's rows (label, key, value, help,
 * page name) and the pages themselves (their name and path, #152), results grouped under their
 * page. Other corpora sit beside the settings' (the Colours tokens, the Keymap actions): any list
 * of `SearchItem`s on a page.
 */
import { BUILT_IN_THEMES, type ThemeToken } from '../../theme/theme';
import { homeRows, pageOf, type PageId, PAGES, type SettingRow } from './pages';

export type SearchItem = {
  readonly page: PageId;
  /** A setting row's id, a token's name, an action's id, a page's id: what ⏎ on the result goes to. */
  readonly id: string;
  readonly kind: 'setting' | 'token' | 'action' | 'page';
  readonly label: string;
  readonly key: string | null;
  /** The value in effect as shown (`opus`, `#B589EC`, `⌘6`), or `''` when not known. */
  readonly value: string;
  readonly help: string;
  /**
   * Words it is found by but does not show: a row's choices (a combo's, the built-in themes), a
   * page's tables the dialog fills from elsewhere (Appearance's Colours).
   */
  readonly also?: string;
};

export type SearchHits = {
  /** The query as typed, trimmed. */
  readonly query: string;
  readonly total: number;
  /** The pages with hits, the most first (ties in tree order); each page's items in its order. */
  readonly pages: readonly { page: PageId; label: string; items: readonly SearchItem[] }[];
  /** Each page's hit count, for the tree's dim counts (pages without hits are left out). */
  readonly counts: Readonly<Partial<Record<PageId, number>>>;
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');

/** A row the dialog draws: a setting or a fixed line, never a table it fills from elsewhere. */
const drawn = (r: SettingRow) => r.key !== null || r.fixed !== null;

/** The choices a row is found by: its own, the built-in themes for the theme's and the editor scheme's (#299, #345). */
const choicesOf = (r: SettingRow): readonly string[] =>
  r.choices ?? (r.key === 'ui.theme' || r.key === 'editor.scheme' ? BUILT_IN_THEMES : []);

/**
 * Every setting row once (mirrors left out), as search items: the rows the dialog draws, so a
 * count is of rows shown (#299: Keymap's Actions table and Appearance's Colours are filled from
 * elsewhere and searched as their own corpora). `values` gives each row's value in effect as
 * shown, by row id (`abe settings list`'s); without it values are not searched.
 */
const worded = (r: SettingRow, v: string | undefined): string | undefined =>
  v === undefined ? undefined : (r.words?.[v] ?? v);

export const settingsCorpus = (values: ReadonlyMap<string, string> = new Map()): SearchItem[] =>
  homeRows()
    .filter(drawn)
    .map((r: SettingRow) => ({
      page: r.page,
      id: r.id,
      kind: 'setting',
      label: r.label,
      key: r.key,
      // a choice in words as the row shows it; every choice by its value and its words (#325)
      value: worded(r, values.get(r.id)) ?? r.fixed?.value ?? '',
      help: r.help,
      also: [...choicesOf(r), ...Object.values(r.words ?? {})].join(' '),
    }));

/**
 * Every page as a search item of its own (#152: `Import` finds Import config, which has no
 * setting), found by its own name; its path in the tree is the help, not searched (`box` would
 * find Browser profiles under Boxes & cloud). Problems is no page to find.
 */
export const pagesCorpus = (): SearchItem[] =>
  PAGES.filter((p) => p.id !== 'problems').map((p) => ({
    page: p.id,
    id: p.id,
    kind: 'page',
    label: p.label,
    key: null,
    value: '',
    help: p.crumb,
    // its tables found by their name, ⏎ opening the page they are on (#299: `colours`)
    also: p.rows
      .filter((r) => !drawn(r))
      .map((r) => r.label)
      .join(' '),
  }));

/**
 * The Colours tokens of the theme Colours edits (#345: `abe theme show`'s), as search items on
 * Editor › Color scheme: found by name (`needs you` too), hex and what it colours.
 */
export const tokensCorpus = (tokens: readonly ThemeToken[]): SearchItem[] =>
  tokens.map((t) => ({
    page: 'color-scheme',
    id: t.name,
    kind: 'token',
    label: t.name,
    key: null,
    value: t.value,
    help: t.usage,
    // its name in words too (`needs you`); never its page's or group's name, which would find
    // every token (`scheme`, `editor`)
    also: t.name,
  }));

/** A slug in words too: `islands-light` is also found as `islands light`. */
const withWords = (text: string) => {
  const spaced = text.replace(/[-_]/g, ' ');

  return spaced === text ? text : `${text}\n${spaced}`;
};

/** What an item is found by: a page by its name and tables, a token never by its page's name. */
const haystack = (item: SearchItem): string => {
  if (item.kind === 'page') return `${item.label}\n${item.also ?? ''}`.toLowerCase();
  const page = item.kind === 'token' ? '' : pageOf(item.page).label;

  return [
    item.label,
    item.key ?? '',
    withWords(item.value),
    item.help,
    page,
    withWords(item.also ?? ''),
  ]
    .join('\n')
    .toLowerCase();
};

/** The items whose label, key, value, help or page name hold every word of `query`. */
export const searchSettings = (
  query: string,
  corpora: readonly (readonly SearchItem[])[],
): SearchHits => {
  const trimmed = query.trim();
  const terms = words(trimmed);

  if (terms.length === 0) return { query: trimmed, total: 0, pages: [], counts: {} };
  const hits = corpora.flat().filter((item) => {
    const text = haystack(item);

    return terms.every((t) => text.includes(t));
  });
  const pages = PAGES.map(({ id: page, label }) => ({
    page,
    label,
    items: hits.filter((h) => h.page === page),
  }))
    .filter((p) => p.items.length > 0)
    .sort((a, b) => b.items.length - a.items.length);

  return {
    query: trimmed,
    total: hits.length,
    pages,
    counts: Object.fromEntries(pages.map((p) => [p.page, p.items.length])),
  };
};

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The results' heading: `Search · 5 settings on 3 pages` (`results` once tokens or actions are among them). */
export const searchSummary = (hits: SearchHits): string => {
  const settingsOnly = hits.pages.every((p) => p.items.every((i) => i.kind === 'setting'));

  return `Search · ${count(hits.total, settingsOnly ? 'setting' : 'result')} on ${count(hits.pages.length, 'page')}`;
};

/** What the page says when nothing matches. */
export const noMatch = (query: string): { text: string; hint: string } => ({
  text: `No setting matches "${query}"`,
  hint: 'Try a key name, like box.idleMinutes',
});
