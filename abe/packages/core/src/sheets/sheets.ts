/**
 * Sheets: one self-contained HTML page an agent makes to show something (a table, a report, a
 * before and after). Saved in your environment as yours, every save under the same title a new
 * version; attached to a card, it is copied to the org store under the card, where teammates
 * open it (`abe card show` lists it; nothing is written on the card). The rules: the
 * self-contained check, the save plan, the fuzzy find, refs and keys, and the no-network policy a
 * Sheet is served under.
 */
import { z } from 'zod';
import { CardDetail, cardDetailText, parseCardId } from '../board/board';

/** What a Sheet is served with: nothing but its own inline code and `data:` images. */
export const SHEET_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** Every answer of a Sheet's origin carries these. */
export const SHEET_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': SHEET_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

// ---------------------------------------------------------------------------------------------
// The self-contained check

export type SheetProblemKind =
  | 'src'
  | 'srcset'
  | 'poster'
  | 'data'
  | 'background'
  | 'href'
  | 'import'
  | '@import'
  | 'url()'
  | 'fetch'
  | 'XMLHttpRequest'
  | 'WebSocket'
  | 'EventSource';

/** One way a page reaches outside itself; `text` names it: `src https://cdn.test/x.js (line 4)`. */
export type SheetProblem = { kind: SheetProblemKind; ref: string; line: number; text: string };

type Found = { kind: SheetProblemKind; ref: string; at: number };

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  sol: '/',
  period: '.',
  lpar: '(',
  rpar: ')',
  tab: '\t',
  newline: '\n',
};

/** An attribute's value as the browser reads it: character references decoded. */
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);?/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);

      // As the browser reads one out of range: the replacement character.
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }

    return NAMED[name.toLowerCase()] ?? whole;
  });

/** A reference that stays inside the page: none, `data:`, `blob:`, `about:` or a fragment. */
const isInside = (ref: string) => {
  const r = ref.trim().toLowerCase();

  return (
    r === '' ||
    r.startsWith('data:') ||
    r.startsWith('blob:') ||
    r.startsWith('about:') ||
    r.startsWith('#')
  );
};

/** Blanks a match out, newlines kept, so positions after it still count lines. */
const blank = (text: string) => text.replace(/[^\n]/g, ' ');

const cssProblems = (css: string, at: (i: number) => number, out: Found[]) => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  const imports: [number, number][] = [];

  for (const m of text.matchAll(/@import\b\s*(?:url\(\s*)?(["']?)([^"')\s;]+)\1[^;]*;?/gi)) {
    imports.push([m.index, m.index + m[0].length]);
    out.push({ kind: '@import', ref: m[2] ?? '', at: at(m.index) });
  }
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    const ref = m[1] ?? m[2] ?? m[3] ?? '';

    if (imports.some(([from, to]) => m.index >= from && m.index < to) || isInside(ref)) continue;
    out.push({ kind: 'url()', ref, at: at(m.index) });
  }
};

/** The call's first argument from `from`: a string literal's text, else the expression as typed. */
const firstArgument = (js: string, from: number): { ref: string; literal: boolean } => {
  const quote = js[from];

  if (quote === '"' || quote === "'" || quote === '`') {
    let i = from + 1;

    while (i < js.length && js[i] !== quote) i += js[i] === '\\' ? 2 : 1;

    return { ref: js.slice(from + 1, i), literal: true };
  }
  const end = /[,)]/.exec(js.slice(from));

  return {
    ref: js.slice(from, end === null ? undefined : from + end.index).trim(),
    literal: false,
  };
};

const CALLS: readonly [SheetProblemKind, RegExp][] = [
  ['fetch', /(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?fetch\s*\(\s*/g],
  ['WebSocket', /\bnew\s+WebSocket\s*\(\s*/g],
  ['EventSource', /\bnew\s+EventSource\s*\(\s*/g],
  ['import', /(?<![\w$.])import\s*\(\s*/g],
];

const jsProblems = (js: string, at: (i: number) => number, out: Found[]) => {
  const found: Found[] = [];

  for (const [kind, pattern] of CALLS)
    for (const m of js.matchAll(pattern)) {
      const arg = firstArgument(js, m.index + m[0].length);

      if (!arg.literal || !isInside(arg.ref)) found.push({ kind, ref: arg.ref, at: at(m.index) });
    }
  // A module's static imports: `import x from '…'`, `import '…'`.
  for (const m of js.matchAll(
    /(?<![\w$.])import\s*(?:[\w$*{},\s]+?\s*from\s*)?(["'])([^"'\n]*)\1/g,
  )) {
    const ref = m[2] ?? '';

    if (!isInside(ref)) found.push({ kind: 'import', ref, at: at(m.index) });
  }
  for (const m of js.matchAll(/\bnew\s+XMLHttpRequest\b/g)) {
    const open = /\.open\s*\(\s*(["'`])[A-Za-z]+\1\s*,\s*/.exec(js.slice(m.index));
    const url =
      open === null ? undefined : firstArgument(js, m.index + open.index + open[0].length);

    found.push({
      kind: 'XMLHttpRequest',
      ref: url?.ref ?? 'new XMLHttpRequest()',
      at: at(m.index),
    });
  }
  out.push(...found.sort((a, b) => a.at - b.at));
};

/** Elements whose `href` loads something into the page (not a link the reader follows). */
const RESOURCE_HREF = new Set(['link', 'use', 'image', 'feimage', 'script']);

/** Attributes beside `src` whose value an element loads, on any element. */
const LOADS: Readonly<Record<string, SheetProblemKind>> = {
  poster: 'poster',
  background: 'background',
};

/** `srcset`'s candidate URLs: each one's first word, split where a comma is followed by a space. */
const srcsetUrls = (value: string) =>
  value
    .split(/,\s+/)
    .map((c) => c.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u !== '');

type Attr = { name: string; value: string; at: number };

/** The attributes of the tag whose name ends at `from`, and where the tag ends. */
const readAttrs = (html: string, from: number): { attrs: Attr[]; end: number } => {
  const attrs: Attr[] = [];
  let i = from;

  for (;;) {
    while (i < html.length && /[\s/]/.test(html[i] ?? '')) i += 1;
    if (i >= html.length || html[i] === '>') return { attrs, end: i + 1 };
    const name = /^[^\s"'>/=]+/.exec(html.slice(i))?.[0] ?? html[i] ?? '';
    const at = i;

    i += name.length;
    while (/\s/.test(html[i] ?? '')) i += 1;
    if (html[i] !== '=') {
      attrs.push({ name: name.toLowerCase(), value: '', at });
      continue;
    }
    i += 1;
    while (/\s/.test(html[i] ?? '')) i += 1;
    const quote = html[i];
    let value: string;

    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      const stop = close < 0 ? html.length : close;

      value = html.slice(i + 1, stop);
      i = stop + 1;
    } else {
      value = /^[^\s>]*/.exec(html.slice(i))?.[0] ?? '';
      i += value.length;
    }
    attrs.push({ name: name.toLowerCase(), value: decode(value), at });
  }
};

const htmlProblems = (html: string, at: (i: number) => number, out: Found[]) => {
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);

    if (lt < 0) return;
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);

      i = close < 0 ? html.length : close + 3;
      continue;
    }
    const tag = /^[a-zA-Z][^\s/>]*/.exec(html.slice(lt + 1))?.[0];

    if (tag === undefined) {
      i = lt + 1;
      continue;
    }
    const name = tag.toLowerCase();
    const { attrs, end } = readAttrs(html, lt + 1 + tag.length);

    for (const a of attrs) {
      const here = () => at(a.at);

      const loads = a.name === 'data' && name === 'object' ? 'data' : LOADS[a.name];

      if (a.name === 'src' && !isInside(a.value))
        out.push({ kind: 'src', ref: a.value.trim(), at: at(a.at) });
      else if (a.name === 'srcset')
        for (const u of srcsetUrls(a.value)) {
          if (!isInside(u)) out.push({ kind: 'srcset', ref: u, at: at(a.at) });
        }
      else if (loads !== undefined && !isInside(a.value))
        out.push({ kind: loads, ref: a.value.trim(), at: at(a.at) });
      else if (
        (a.name === 'href' || a.name === 'xlink:href') &&
        RESOURCE_HREF.has(name) &&
        !isInside(a.value)
      )
        out.push({ kind: 'href', ref: a.value.trim(), at: at(a.at) });
      else if (a.name === 'style') cssProblems(a.value, here, out);
      else if (a.name.startsWith('on')) jsProblems(a.value, here, out);
      else if (a.name === 'srcdoc' && name === 'iframe') htmlProblems(a.value, here, out);
    }
    i = end;
    if (name === 'script' || name === 'style') {
      const close = html.slice(end).search(new RegExp(`</${name}[\\s>]`, 'i'));
      const stop = close < 0 ? html.length : end + close;
      const body = html.slice(end, stop);
      const inBody = (j: number) => at(end + j);

      if (name === 'script') jsProblems(body, inBody, out);
      else cssProblems(body, inBody, out);
      i = stop;
    }
  }
};

/**
 * Every way the page reaches outside itself, in page order: an external `src` (or `srcset`,
 * `poster`, `background`, `<object data>`, a module `import`), a stylesheet or resource `href`,
 * any `@import`, a `url(…)` that is not `data:`, and a `fetch`, `XMLHttpRequest`,
 * `WebSocket` or `EventSource` URL. `data:` URIs, fragments and inline code are fine; links a
 * reader follows (`<a href>`) and markup shown as text are not loads.
 */
export const selfContainedProblems = (html: string): SheetProblem[] => {
  const found: Found[] = [];

  htmlProblems(html, (i) => i, found);

  return found.map((f) => {
    const line = html.slice(0, f.at).split('\n').length;

    return { kind: f.kind, ref: f.ref, line, text: `${f.kind} ${f.ref} (line ${line})` };
  });
};

export const notSelfContainedMessage = (problems: readonly SheetProblem[]): string =>
  `the page reaches outside itself: ${problems.map((p) => p.text).join('; ')}. A Sheet carries its own data: inline its scripts, styles and data (data: URIs are fine)`;

// ---------------------------------------------------------------------------------------------
// What a Sheet is

const At = z.iso.datetime();
const Count = z.number().int().positive();
const SheetId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const SheetVersion = z.object({ n: Count, at: At, bytes: z.number().int().nonnegative() });
export type SheetVersion = z.infer<typeof SheetVersion>;

/** One attach: the version copied to the org store under the card, at `key`. */
export const SheetAttachment = z.object({ card: Count, version: Count, at: At, key: z.string() });
export type SheetAttachment = z.infer<typeof SheetAttachment>;

/** A Sheet as your environment keeps it (`meta.json` beside its versions). */
export const SheetMeta = z.object({
  id: SheetId,
  title: z.string(),
  /** The card it was made for, or none. */
  card: Count.nullable(),
  /** The session that made it, or none. */
  session: z.string().nullable(),
  versions: z.array(SheetVersion).min(1),
  attached: z.array(SheetAttachment),
});
export type SheetMeta = z.infer<typeof SheetMeta>;

/** `sheet://<id>` for yours, `sheet://<card>/<id>` for one attached to a card. */
export const sheetAddress = (id: string, card?: number): string =>
  card === undefined ? `sheet://${id}` : `sheet://${card}/${id}`;

/** A Sheet as a row of `abe sheet list` and `find`: its newest version. */
export const SheetSummary = z.object({
  id: SheetId,
  title: z.string(),
  card: Count.nullable(),
  session: z.string().nullable(),
  version: Count,
  at: At,
  /** The cards it is attached to. */
  attached: z.array(Count),
  address: z.string(),
});
export type SheetSummary = z.infer<typeof SheetSummary>;

const newest = (m: SheetMeta): SheetVersion => {
  const last = m.versions.at(-1);

  if (last === undefined) throw new Error(`sheet ${m.id} has no version`);

  return last;
};

export const summaryOf = (m: SheetMeta): SheetSummary => {
  const last = newest(m);

  return {
    id: m.id,
    title: m.title,
    card: m.card,
    session: m.session,
    version: last.n,
    at: last.at,
    attached: [...new Set(m.attached.map((a) => a.card))],
    address: sheetAddress(m.id),
  };
};

// ---------------------------------------------------------------------------------------------
// A save

/** Why a title cannot be a Sheet's (it is one `Show <title>` line), or `undefined`. */
export const titleProblem = (title: string): string | undefined => {
  const t = title.trim();

  if (t === '') return 'the title is empty';
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(t)) return 'the title is one line';
  if (t.length > 120) return 'the title is longer than 120 characters';

  return undefined;
};

const sameTitle = (a: string, b: string) => {
  const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

  return norm(a) === norm(b);
};

/** The title as a slug: ASCII letters and digits, `-` between words, at most 40; else `sheet`. */
export const sheetSlug = (title: string): string => {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

  return slug === '' ? 'sheet' : slug;
};

export type SaveInput = {
  title: string;
  /** A card or session not given keeps the Sheet's. */
  card: number | null;
  session: string | null;
  at: string;
  bytes: number;
  /** Makes a new Sheet's id unique across the org (serve's randomness): `<slug>-<suffix>`. */
  suffix: string;
};

/** Where a save goes: the Sheet with this title (any case) at its next version, else a new one. */
export const planSave = (
  sheets: readonly SheetMeta[],
  s: SaveInput,
): { id: string; version: number; meta: SheetMeta } => {
  const before = sheets.find((m) => sameTitle(m.title, s.title));
  const title = s.title.trim().replace(/\s+/g, ' ');

  if (before === undefined) {
    const id = `${sheetSlug(title)}-${s.suffix}`;

    return {
      id,
      version: 1,
      meta: {
        id,
        title,
        card: s.card,
        session: s.session,
        versions: [{ n: 1, at: s.at, bytes: s.bytes }],
        attached: [],
      },
    };
  }
  const n = newest(before).n + 1;

  return {
    id: before.id,
    version: n,
    meta: {
      ...before,
      card: s.card ?? before.card,
      session: s.session ?? before.session,
      versions: [...before.versions, { n, at: s.at, bytes: s.bytes }],
    },
  };
};

/** The Sheet a ref names among yours: its id, else its title (any case). */
export const findYours = (sheets: readonly SheetMeta[], ref: string): SheetMeta | undefined =>
  sheets.find((m) => m.id === ref) ?? sheets.find((m) => sameTitle(m.title, ref));

// ---------------------------------------------------------------------------------------------
// The fuzzy find

/** What `list` and `find` put first: the current card's and session's Sheets. */
export type SheetContext = { card: number | null; session: string | null };

const contextHits = (s: SheetSummary, c: SheetContext) =>
  (c.card !== null && s.card === c.card ? 1 : 0) +
  (c.session !== null && s.session === c.session ? 1 : 0);

/** How well one word of the query matches `text`: prefix, word start, inside, letters in order. */
const wordScore = (word: string, text: string): number | undefined => {
  if (text.startsWith(word)) return 800;
  const inside = text.indexOf(word);

  if (inside > 0) return /[a-z0-9]/.test(text[inside - 1] ?? '') ? 400 : 600;
  let span: [number, number] | undefined;

  // The tightest run of the letters in order.
  for (
    let start = text.indexOf(word[0] ?? '');
    start >= 0;
    start = text.indexOf(word[0] ?? '', start + 1)
  ) {
    let at = start;

    for (const ch of word.slice(1)) {
      at = text.indexOf(ch, at + 1);
      if (at < 0) break;
    }
    if (at < 0) break;
    if (span === undefined || at - start < span[1] - span[0]) span = [start, at];
  }

  return span === undefined ? undefined : Math.max(1, 200 - (span[1] - span[0] + 1 - word.length));
};

/** How well `query` matches `text` (higher is better), or `undefined` when it does not. */
export const fuzzyScore = (query: string, text: string): number | undefined => {
  const q = query.trim().replace(/\s+/g, ' ').toLowerCase();
  const t = text.toLowerCase();

  if (q === '') return undefined;
  if (q === t) return 1000;
  const words = q.split(' ').map((w) => wordScore(w, t));

  if (words.some((w) => w === undefined)) return undefined;

  return words.reduce<number>((sum, w) => sum + (w ?? 0), 0) / words.length;
};

const byContextThenNewest = (c: SheetContext) => (a: SheetSummary, b: SheetSummary) =>
  contextHits(b, c) - contextHits(a, c) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id);

/** `abe sheet list`: the current card's and session's first, then newest first. */
export const listOrder = (sheets: readonly SheetSummary[], c: SheetContext): SheetSummary[] =>
  [...sheets].sort(byContextThenNewest(c));

/** `abe sheet find`: the Sheets whose title or id match, the current card's and session's first, then the best match, then newest. */
export const rankSheets = (
  sheets: readonly SheetSummary[],
  query: string,
  c: SheetContext,
): SheetSummary[] => {
  const scored = sheets.flatMap((s) => {
    const scores = [fuzzyScore(query, s.title), fuzzyScore(query, s.id)].filter(
      (n) => n !== undefined,
    );

    return scores.length === 0 ? [] : [{ s, score: Math.max(...scores) }];
  });
  const then = byContextThenNewest(c);

  return scored
    .sort(
      (a, b) => contextHits(b.s, c) - contextHits(a.s, c) || b.score - a.score || then(a.s, b.s),
    )
    .map((x) => x.s);
};

// ---------------------------------------------------------------------------------------------
// Refs and the org store's keys

export type SheetRef = { kind: 'yours'; id: string } | { kind: 'card'; card: number; id: string };

/**
 * A Sheet as typed: yours by id or title (`cart-totals-a1b2c3`, `sheet://cart-totals-a1b2c3`),
 * or one attached to a card (`4/<id>`, `AB#4/<id>`, `sheet://4/<id>`), which anyone can open.
 * `undefined` for nothing typed.
 */
export const parseSheetRef = (text: string): SheetRef | undefined => {
  const t = text.trim().replace(/^sheet:\/\//, '');
  const slash = t.indexOf('/');

  if (t === '') return undefined;
  const card = slash < 0 ? undefined : parseCardId(t.slice(0, slash));
  const id = SheetId.safeParse(t.slice(slash + 1));

  // Anything else is yours by id or title (a title may hold a `/`).
  return card !== undefined && id.success
    ? { kind: 'card', card, id: id.data }
    : { kind: 'yours', id: t };
};

/**
 * Why `key` is no org store key, or `undefined`: `/`-separated parts of letters, digits, `.`,
 * `_` and `-` (S3's safe characters), none empty, `.` or `..`.
 */
export const orgKeyProblem = (key: string): string | undefined => {
  if (key === '') return 'empty';
  if (key.length > 1024) return 'longer than 1024 characters';
  const parts = key.split('/');

  if (parts.some((p) => p === '')) return 'an empty part';
  if (parts.some((p) => p === '.' || p === '..')) return '. or ..';
  if (parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p)))
    return 'a character outside A-Z a-z 0-9 . _ -';

  return undefined;
};

/** Where a card's attached Sheets are kept in the org store. */
export const cardSheetsPrefix = (card: number): string => `sheets/${card}/`;

/** One attached version of a Sheet in the org store. */
export const sheetKey = (card: number, id: string, version: number): string =>
  `sheets/${card}/${id}/v${version}.html`;

/** What the org store knows of a Sheet attached to a card, beside its versions. */
export const sheetInfoKey = (card: number, id: string): string => `sheets/${card}/${id}/sheet.json`;

/** The Sheet id whose `sheet.json` `key` is, under the card; `undefined` for any other key. */
export const sheetOfInfoKey = (card: number, key: string): string | undefined => {
  const id = key.startsWith(cardSheetsPrefix(card))
    ? /^([^/]+)\/sheet\.json$/.exec(key.slice(cardSheetsPrefix(card).length))?.[1]
    : undefined;

  return id !== undefined && SheetId.safeParse(id).success ? id : undefined;
};

/** Where the host keeps one page: a version of yours, or of one attached to a card. */
export const sheetHostKey = (card: number | null, id: string, version: number): string =>
  card === null ? `yours/${id}/v${version}` : `${card}/${id}/v${version}`;

/** `sheet.json` under the card: the Sheet's title and every version attached. */
export const OrgSheet = z.object({
  id: SheetId,
  title: z.string(),
  versions: z.array(z.object({ n: Count, at: At })).min(1),
});
export type OrgSheet = z.infer<typeof OrgSheet>;

/** `sheet.json` with one more version attached (again: its time moves). */
export const withAttached = (
  before: OrgSheet | undefined,
  s: { id: string; title: string; version: number; at: string },
): OrgSheet => ({
  id: s.id,
  title: s.title,
  versions: [
    ...(before?.versions ?? []).filter((v) => v.n !== s.version),
    { n: s.version, at: s.at },
  ].sort((a, b) => a.n - b.n),
});

/** A card's attached Sheet, as `abe card show` lists it. */
export const CardSheet = z.object({
  id: SheetId,
  title: z.string(),
  version: Count,
  at: At,
  address: z.string(),
});
export type CardSheet = z.infer<typeof CardSheet>;

export const cardSheetOf = (card: number, s: OrgSheet): CardSheet => {
  const last = s.versions.at(-1) ?? { n: 1, at: '' };

  return {
    id: s.id,
    title: s.title,
    version: last.n,
    at: last.at,
    address: sheetAddress(s.id, card),
  };
};

/** A card's Sheets as listed: the newest attach first. */
export const newestAttachFirst = (sheets: readonly CardSheet[]): CardSheet[] =>
  [...sheets].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));

// ---------------------------------------------------------------------------------------------
// The commands' results

export const SheetSaveData = z.object({
  id: SheetId,
  title: z.string(),
  version: Count,
  card: Count.nullable(),
  session: z.string().nullable(),
  /** The saved version's file in your environment. */
  path: z.string(),
  address: z.string(),
});
export type SheetSaveData = z.infer<typeof SheetSaveData>;

export const SheetListData = z.object({
  /** The context put first. */
  card: Count.nullable(),
  session: z.string().nullable(),
  sheets: z.array(SheetSummary),
});
export type SheetListData = z.infer<typeof SheetListData>;

export const SheetFindData = SheetListData.extend({ query: z.string() });
export type SheetFindData = z.infer<typeof SheetFindData>;

/** `abe sheet show`: the Sheet, with `version` the one shown and `path` its file. */
export const SheetShowData = SheetMeta.extend({
  version: Count,
  path: z.string(),
  address: z.string(),
});
export type SheetShowData = z.infer<typeof SheetShowData>;

export const SheetAttachData = z.object({
  id: SheetId,
  title: z.string(),
  version: Count,
  card: Count,
  /** Where the org store keeps the version. */
  key: z.string(),
  address: z.string(),
});
export type SheetAttachData = z.infer<typeof SheetAttachData>;

export const SheetOpenData = z.object({
  id: SheetId,
  title: z.string(),
  version: Count,
  /** `null` for yours; the card for one opened from the org store. */
  card: Count.nullable(),
  address: z.string(),
  /** A local URL `serve` hosts; its origin serves this page and nothing else. */
  url: z.string(),
  csp: z.string(),
});
export type SheetOpenData = z.infer<typeof SheetOpenData>;

/** `abe card show`: the card, its comments and its attached Sheets. */
export const CardShowData = CardDetail.extend({ sheets: z.array(CardSheet) });
export type CardShowData = z.infer<typeof CardShowData>;

const where = (s: { card: number | null; attached: readonly unknown[] }) =>
  [
    ...(s.card === null ? [] : [`AB#${s.card}`]),
    ...(s.attached.length === 0 ? [] : ['attached']),
  ].join(', ');

export const sheetSaveText = (s: SheetSaveData): string =>
  `saved ${s.title} v${s.version} as ${s.id} (yours)\n${s.path}\n`;

export const sheetListText = (l: SheetListData): string => {
  if (l.sheets.length === 0) return 'no Sheets\n';
  const width = Math.max(...l.sheets.map((s) => s.id.length));

  return `${l.sheets
    .map((s) => {
      const tail = where({ card: s.card, attached: s.attached });

      return `${s.id.padEnd(width)}  v${String(s.version).padEnd(3)} ${s.title}${tail === '' ? '' : `  (${tail})`}`;
    })
    .join('\n')}\n`;
};

export const sheetFindText = (f: SheetFindData): string =>
  f.sheets.length === 0 ? `no Sheet matches ${f.query}\n` : sheetListText(f);

export const sheetShowText = (s: SheetShowData): string => {
  const tail = where(s);

  return `${[
    `${s.title} v${s.version} (${s.id})${tail === '' ? '' : ` · ${tail}`}`,
    s.path,
    ...s.versions.map((v) => `  v${v.n}  ${v.at}  ${v.bytes} bytes`),
    ...s.attached.map((a) => `  attached v${a.version} to AB#${a.card} at ${a.at}`),
  ].join('\n')}\n`;
};

export const sheetAttachText = (a: SheetAttachData): string =>
  `attached ${a.title} v${a.version} to AB#${a.card}: ${a.address}\n`;

export const cardShowText = (c: CardShowData): string =>
  `${cardDetailText(c)}${
    c.sheets.length === 0
      ? ''
      : `\nSheets:\n${c.sheets.map((s) => `  ${s.title} v${s.version}  ${s.address}\n`).join('')}`
  }`;
