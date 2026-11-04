/**
 * A Sheet as a tab in the Board's place. `:show`, a link and the card dialog's Sheet row find or
 * open one first (`SheetAsks`, kept while the Board is shown); once `abe sheet open` answers, the
 * tab is up with its page, until Esc or Back to the Board.
 */
import type { SheetSummary } from '@abe/core';
import {
  balloon,
  close,
  type Mode,
  modeId,
  type ModeOut,
  refusedBalloon,
  shownUrl,
  stay,
} from './mode';
import {
  bestSheet,
  findArgv,
  noMatchText,
  type SheetContext,
  sheetKey,
  sheetMenu,
  type SheetTab,
  sheetTab,
  sheetView,
} from './sheet';
import { type Answer, type Command, island, type Refused } from '../runtime/runtime';

/** The find and the open out for a Sheet. Only the newest ask's answer counts. */
export type SheetAsks = {
  /** Asks made so far, each one's number. */
  n: number;
  finding?: { n: number; text: string; exact: boolean; ctx: SheetContext } | undefined;
  opening?: { n: number; found?: SheetSummary | undefined; ctx: SheetContext } | undefined;
};

const NO_ASKS: SheetAsks = { n: 0 };

const FIND = 'find:';
const OPEN = 'open:';

/** `abe sheet find <text>`, the current card and session first. `exact`: a link's title. */
export const findSheet = (
  asks: SheetAsks | undefined,
  text: string,
  exact: boolean,
  ctx: SheetContext,
): { asks: SheetAsks | undefined; commands: Command[] } => {
  const t = text.trim();

  if (t === '') return { asks, commands: [] };
  const n = (asks?.n ?? 0) + 1;

  return {
    asks: { ...asks, n, finding: { n, text: t, exact, ctx } },
    commands: [{ kind: 'run', id: modeId('sheet', `${FIND}${n}`), argv: findArgv(t, ctx) }],
  };
};

/** `abe sheet open <ref>`: yours by id, or a card's as `<card>/<id>`. */
export const openSheet = (
  asks: SheetAsks | undefined,
  ref: string,
  o: { n?: number; found?: SheetSummary | undefined; ctx: SheetContext },
): { asks: SheetAsks; commands: Command[] } => {
  // a find's open keeps its number; one of its own, the card dialog's row, takes the next
  const n = o.n ?? (asks?.n ?? 0) + 1;

  return {
    asks: { ...asks, n: Math.max(n, asks?.n ?? 0), opening: { ...o, n } },
    commands: [{ kind: 'run', id: modeId('sheet', `${OPEN}${n}`), argv: ['sheet', 'open', ref] }],
  };
};

/**
 * A find's or an open's answer: the best match opened, or that nothing matches; the open's, the
 * tab to show. An older ask's answer is no one's.
 */
export const sheetAnswer = (
  asks0: SheetAsks | undefined,
  ask: string,
  input: Answer | Refused,
): { asks: SheetAsks | undefined; tab?: SheetTab; commands: Command[] } => {
  const asks = asks0 ?? NO_ASKS;

  if (ask.startsWith(FIND)) {
    const asked = asks.finding;

    if (asked === undefined || ask !== `${FIND}${asked.n}`) return { asks: asks0, commands: [] };
    const next: SheetAsks = { ...asks, finding: undefined };

    if (!input.reply.ok) return { asks: next, commands: refusedBalloon(input) };
    if (input.command !== 'sheet find') return { asks: next, commands: [] };
    const best = bestSheet(input.reply.data, asked.exact ? asked.text : undefined);

    if (best === undefined)
      return { asks: next, commands: [balloon('info', noMatchText(asked.text))] };

    return openSheet(next, best.id, { n: asked.n, found: best, ctx: asked.ctx });
  }
  const asked = asks.opening;

  if (asked === undefined || ask !== `${OPEN}${asked.n}`) return { asks: asks0, commands: [] };
  const next: SheetAsks = { ...asks, opening: undefined };

  if (!input.reply.ok) return { asks: next, commands: refusedBalloon(input) };
  if (input.command !== 'sheet open') return { asks: next, commands: [] };

  return { asks: next, tab: sheetTab(input.reply.data, asked), commands: [] };
};

const key = (t: SheetTab, k: string): ModeOut<SheetTab> => {
  switch (k) {
    case '<Esc>':
      return close();
    case '<D-CR>':
      return stay(t, [sheetMenu(t)]);
    case '<CR>':
      // the page gets the keys, and the shell gives them back on Esc
      return stay({ ...t, focused: true });
    default:
      return stay(t);
  }
};

const browser: Mode<SheetTab>['browser'] = (t, k, event) => {
  if (k !== sheetKey(t.open)) return undefined;
  switch (event.kind) {
    case 'focus':
      return stay({ ...t, focused: event.focused });
    case 'loaded':
      return stay({ ...t, loaded: true });
    case 'blocked':
      return stay(t, [
        {
          kind: 'shell',
          effect: {
            kind: 'status',
            text: `Sheet blocked ${event.what} ${shownUrl(event.url)}: a Sheet has no network`,
          },
        },
      ]);
    case 'failed':
      return stay(t, [balloon('error', `Sheet: ${event.message}`)]);
  }
};

export const sheetMode: Mode<SheetTab> = {
  key,
  click: () => undefined,
  // its menu: Back to the Board. Attach to card runs in Command mode.
  choice: (t, _ask, row) => (row === 'back' ? close() : stay(t)),
  answer: (t) => stay(t),
  // the tab's Sheet went onto a card
  event: (t, e) =>
    e.type === 'sheet.attached' && e.data.id === t.open.id
      ? stay({ ...t, attached: true, card: e.data.card })
      : undefined,
  browser,
  view: (t) => island([sheetView(t)], 'sheet'),
};
