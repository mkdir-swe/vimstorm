/**
 * A mode takes the Board's place until Esc: a Sheet as a tab and a local pull request. A mode keeps its own state and takes the keys and answers while it is up. The Board
 * holds only which mode is up, hands it the inputs, and does the few things a mode asks of it. One
 * answer comes before its mode is up: a Sheet's find and open (`sheetAnswer`), so its module hands
 * the Board what to do with it.
 *
 * A mode's runs, menus and dialogs carry its tag in their id (`sheet:find:cart totals`), so an answer or
 * a chosen row reaches the mode that asked, whatever else is on the Board. The Board reads the tag
 * with `routeOf` and nothing else of the id; the rest is the mode's own to read.
 */
import type { Event, FactoryRunData, LocalModeView, SessionData } from '@abe/core';
import type { Answer, BrowserEvent, Command, Node, Refused, ViewSize } from '../runtime/runtime';

export const MODE_TAGS = ['sheet', 'local-pr'] as const;

export type ModeTag = (typeof MODE_TAGS)[number];

/** A mode's run, menu or dialog id: its tag, then what the mode reads back. */
export const modeId = (tag: ModeTag, ask: string): string => `${tag}:${ask}`;

/** The mode an answer or a chosen row belongs to, and what followed its tag. Undefined: the Board's. */
export const routeOf = (id: string): { tag: ModeTag; ask: string } | undefined => {
  const at = id.indexOf(':');
  const tag = at < 0 ? undefined : MODE_TAGS.find((t) => t === id.slice(0, at));

  return tag === undefined ? undefined : { tag, ask: id.slice(at + 1) };
};

/** What a mode reads of the Board under it. */
export type Under = {
  size: ViewSize;
  /** The Chat column or a layer has the keys, so the mode draws itself grey. */
  away: boolean;
  /** The shown project's folder. */
  root: string | undefined;
  /** A card's title as the Board lists it, undefined for a card it does not list. */
  title: (card: number) => string | undefined;
  sessions: readonly SessionData[] | undefined;
  /** The shown repo's runs. */
  runs: () => readonly FactoryRunData[];
  local: LocalModeView | undefined;
};

/** What a mode asks the Board to do, since only the Board has what it takes. */
export type BoardTask =
  /** Read the runs and the sessions again, and draw the widgets from them. */
  | { kind: 'read' }
  /** The card's story dialog over the view. */
  | { kind: 'story'; card: number };

/** A mode's step: undefined `mode` closes it, the Board back in its place. */
export type ModeOut<M> = { mode: M | undefined; commands: Command[]; board?: readonly BoardTask[] };

export type Mode<M> = {
  /** A key while it has the keys. */
  key: (m: M, key: string, u: Under) => ModeOut<M>;
  /** A click on one of its nodes. Undefined: not its node. */
  click: (m: M, id: string, u: Under) => ModeOut<M> | undefined;
  /** A row of one of its menus or dialogs. `ask` is what followed its tag in the menu's id. */
  choice: (m: M, ask: string, row: string, u: Under) => ModeOut<M>;
  /** One of its runs answered. `ask` is what followed its tag in the run's id. */
  answer: (m: M, ask: string, input: Answer | Refused, u: Under) => ModeOut<M>;
  /** An `abe watch` event. Undefined: not its, the Board takes it. */
  event: (m: M, e: Event, u: Under) => ModeOut<M> | undefined;
  /** What a page it shows did. Undefined: not its page. */
  browser: (m: M, key: string, e: BrowserEvent, u: Under) => ModeOut<M> | undefined;
  /** Its place's tree. Undefined: nothing of its to draw, the Board drawn under it. */
  view: (m: M, u: Under) => Node | undefined;
  /** The story its keys are on, what ⌃L jumps along. Left out: the Board's selected card. */
  linked?: (m: M) => number | undefined;
};

/** The mode as it is, nothing asked. */
export const stay = <M>(mode: M | undefined, commands: Command[] = []): ModeOut<M> => ({
  mode,
  commands,
});

/** Back to the Board. */
export const close = <M>(commands: Command[] = []): ModeOut<M> => ({ mode: undefined, commands });

export const balloon = (tone: 'info' | 'error', text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'balloon', tone, text },
});

/** A refusal as a balloon says it, `message (code)`; nothing for a success. */
export const refusalText = (input: Answer | Refused): string | undefined =>
  input.reply.ok ? undefined : `${input.reply.error.message} (${input.reply.error.code})`;

/** A refusal's balloon; none for a success. */
export const refusedBalloon = (input: Answer | Refused): Command[] => {
  const why = refusalText(input);

  return why === undefined ? [] : [balloon('error', why)];
};

/** A blocked URL as a message shows it: origin and path, never its query (a token) or fragment. */
export const shownUrl = (url: string): string => url.split(/[?#]/)[0] ?? url;
