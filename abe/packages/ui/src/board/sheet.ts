/**
 * A Sheet as a tab: the page `abe sheet open` serves, in a BrowserView in place of the Factory
 * view's Board, under its bar (title, `sheet://…` address, version, `yours · sandboxed · no
 * network`, `attached` once it is). `:show <name>`, the `Show <title>` link in Chat's terminal or a
 * row of the card dialog's Sheets finds it. Pure rules; `sheet-mode.ts` holds the tab and its keys.
 */
import type { CardSheet, SheetFindData, SheetOpenData, SheetSummary } from '@abe/core';
import type { BrowserView, DialogSheets, Menu, MenuRow } from '../runtime/runtime';

/** The Sheet shown as a tab. */
export type SheetTab = {
  open: SheetOpenData;
  /** Yours (opened by id); else one attached to a card, opened by `<card>/<id>`. */
  yours: boolean;
  /** The card Attach to card writes to: the Sheet's own, else the current one; none known: asked. */
  card: number | null;
  /** On a card (in the org store). */
  attached: boolean;
  /** The page has the keyboard. */
  focused: boolean;
  /** It finished loading. */
  loaded: boolean;
};

/** Where a find or a link looks first: the current card and its session. */
export type SheetContext = { card?: number | undefined; session?: string | undefined };

/** One web view per Sheet, owner and version. */
export const sheetKey = (o: Pick<SheetOpenData, 'id' | 'card' | 'version'>): string =>
  `sheet:${o.id}:${o.card ?? 'yours'}:v${o.version}`;

/** `abe sheet find <words…>` with the current card and session put first. */
export const findArgv = (text: string, ctx: SheetContext): string[] => [
  'sheet',
  'find',
  ...text.split(/\s+/).filter((w) => w !== ''),
  ...(ctx.card === undefined ? [] : ['--card', String(ctx.card)]),
  ...(ctx.session === undefined ? [] : ['--session', ctx.session]),
];

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The Sheet a find opens: its best (find's order: the current card's and session's first); from
 * a `Show <title>` link the one with that title exactly, when there is one.
 */
export const bestSheet = (found: SheetFindData, exact?: string): SheetSummary | undefined =>
  (exact === undefined ? undefined : found.sheets.find((s) => norm(s.title) === norm(exact))) ??
  found.sheets[0];

/** What a find found nothing for says. */
export const noMatchText = (text: string): string => `No Sheet matches “${text.trim()}”`;

/** The tab once `abe sheet open` answered: yours or a card's, the card to attach to. */
export const sheetTab = (
  open: SheetOpenData,
  o: { found?: SheetSummary | undefined; ctx: SheetContext },
): SheetTab => {
  const yours = open.card === null;

  return {
    open,
    yours,
    card: yours ? (o.found?.card ?? o.ctx.card ?? null) : open.card,
    attached: !yours || (o.found?.attached.length ?? 0) > 0,
    focused: false,
    loaded: false,
  };
};

/** Why Attach to card cannot run, or undefined. */
export const attachRefusal = (t: SheetTab): string | undefined =>
  t.yours ? undefined : `attached to #${t.open.card ?? t.card ?? '?'}`;

/** The tab's BrowserView: the bar's words and the page in sheet mode (no network). */
export const sheetView = (t: SheetTab): BrowserView => ({
  kind: 'BrowserView',
  id: 'sheet-view',
  props: {
    key: sheetKey(t.open),
    url: t.open.url,
    title: 'Sheet',
    sub: t.open.title,
    address: t.open.address,
    version: t.open.version,
    badges: [
      ...(t.yours ? ['yours'] : []),
      'sandboxed',
      'no network',
      ...(t.attached ? ['attached'] : []),
    ],
    ...(attachRefusal(t) === undefined ? { action: { keys: '⌘⏎', label: 'Attach to card' } } : {}),
    ...(t.focused ? { focused: true } : {}),
  },
});

/** The tab's Action menu (⌘⏎): Attach to card, back to the Board. */
export const sheetMenu = (t: SheetTab): Menu => {
  const refused = attachRefusal(t);
  const attach: MenuRow = {
    id: 'attach',
    text: 'Attach to card',
    dim: t.card === null ? 'listed on the card' : `#${t.card} · listed on the card`,
    ...(refused === undefined ? {} : { reason: refused }),
    does: {
      kind: 'run',
      argv: ['sheet', 'attach', t.open.id, ...(t.card === null ? [] : ['--card', String(t.card)])],
      ...(t.card === null
        ? {
            ask: [
              {
                name: 'card',
                kind: 'flag',
                type: 'string',
                required: true,
                repeats: false,
                summary: 'the card: its id (`4`, `AB#4`)',
              },
            ],
          }
        : {}),
    },
  };

  return {
    kind: 'menu',
    id: `sheet:${t.open.id}`,
    title: t.open.title,
    rows: [attach, { id: 'back', text: 'Back to the Board', key: 'Esc', does: { kind: 'back' } }],
  };
};

/** `abe sheet open <card>/<id>`: a row of the card dialog's Sheets, by its id. */
export const dialogSheetRef = (row: string): string | undefined =>
  row.startsWith('sheet:') ? row.slice('sheet:'.length) : undefined;

/** A card's attached Sheets as the dialog's rows, the newest attach first. */
export const dialogSheets = (card: number, sheets: readonly CardSheet[]): DialogSheets => ({
  rows: [...sheets]
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .map((s) => ({
      id: `sheet:${card}/${s.id}`,
      title: s.title,
      dim: `v${s.version} · ${s.at.slice(0, 10)}`,
    })),
});
