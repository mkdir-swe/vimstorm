/**
 * Chat's cards on the pinned session (#114 t114b): what the `chat` screen (`pinned.ts`) holds of
 * them and feeds the rendered body (`rendered.ts` slots). On a session it reads `abe session asks`
 * once, then follows `session.ask` / `session.answered` (`serve.started` and `watch.gap` read it
 * again); its run's Needs you comes from `factory status` (`chatCardsRun`). While a card is up it
 * takes the keys first (before the transcript's and the composer's), Esc included; the pill takes
 * ⏎ while nothing in the transcript is under the cursor. `:override <what>` comes as the
 * `override` choice, the status bar's `◆ needs you` as the `cards` / `reopen` one.
 *
 * Its nodes: the answered cards' lines placed by time, the open card after the last turn, the
 * pill above the composer.
 */
import type { FactoryRunData, SessionData } from '@abe/core';
import {
  cardNode,
  type CardFacts,
  type Cards,
  cardsClick,
  cardsDraft,
  cardsEvent,
  cardsKey,
  cardsOpen,
  cardsRead,
  cardsReopen,
  cardsResult,
  cardsRun,
  cardsText,
  shownCard,
  foldedNodes,
  isCardsResult,
  NO_CARDS,
  openOverride,
  pillNode,
} from './cards';
import { stack } from '../runtime/components';
import { type Slots } from './rendered';
import { type Command, type Input } from '../runtime/runtime';

/**
 * The pinned session's cards; `reading` while `session asks` is out, `stale` when a card was asked
 * or answered meanwhile (its answer is then older than the events: read again instead).
 */
export type ChatCards = {
  session: string;
  cards: Cards;
  reading: boolean;
  stale: boolean;
  /** Its session had ended when last settled: its cards read-only, serve's empty asks not taken. */
  ended?: boolean;
  /** Live again (resumed), its asks being read: the old cards stay read-only until they are in. */
  resuming?: boolean;
  /**
   * The shown card (a round by its id) came while you typed: it waits, the keys not its own until
   * you go to it (Tab, a click), so a message's keys never answer it (N2).
   */
  waits?: string | undefined;
};

/** The `choice` menus the cards answer: `:override <what>`, and the status bar's reopen. */
export const OVERRIDE_MENU = 'override';
export const CARDS_MENU = 'cards';

const ASKS_ID = 'cards:asks';

const readAsks = (session: string): Command => ({
  kind: 'run',
  id: ASKS_ID,
  argv: ['session', 'asks', session],
});

/** A session's cards before anything was read: its open cards asked. */
export const chatCardsFor = (session: string): { held: ChatCards; commands: Command[] } => ({
  held: { session, cards: NO_CARDS, reading: true, stale: false },
  commands: [readAsks(session)],
});

/**
 * What the cards take from the pin: the session's card, whose it is, whether the transcript has a
 * cursor, and whether you are typing a message (#115's composer: its keys stay its own).
 */
export type ChatCardsFacts = CardFacts & { cursor: boolean; composing?: boolean | undefined };

type Out = { held: ChatCards; commands: Command[] };

const kept = (h: ChatCards, cards: Cards, commands: Command[] = []): Out => ({
  held: cards === h.cards ? h : { ...h, cards },
  commands,
});

/** Every left-for-later card shown again (the status bar's `◆ needs you`). */
const reopenAll = (c: Cards): Cards => (c.later.length === 0 ? c : { ...c, later: [] });

/**
 * One input on the cards: undefined when it is not theirs (the transcript's, the composer's, the
 * screen's). Events are taken and handed on alike: the caller passes them on whatever this says.
 */
export const stepChatCards = (
  h: ChatCards,
  facts: ChatCardsFacts,
  input: Input,
): Out | undefined => {
  const c = h.cards;
  const f = factsOf(h, facts);

  switch (input.kind) {
    case 'result':
      if (input.id === ASKS_ID) {
        if (h.stale) return { held: { ...h, stale: false }, commands: [readAsks(h.session)] };
        const done: ChatCards = { ...h, reading: false, resuming: false };

        if (input.command !== 'session asks' || !input.reply.ok) return kept(done, c);
        // an ended session's asks are none to serve; the cards it had open stay, read-only (#317)
        if (facts.ended === true) return kept(done, c);

        return input.reply.data.id === h.session
          ? kept(done, cardsRead(c, input.reply.data.cards))
          : kept(done, c);
      }
      if (!isCardsResult(input.id)) return undefined;
      {
        const out = cardsResult(c, input);

        return kept(h, out.cards, out.commands);
      }
    case 'event': {
      const e = input.event;

      if (e.type === 'serve.started' || e.type === 'watch.gap')
        return h.reading
          ? { held: { ...h, stale: true }, commands: [] }
          : { held: { ...h, reading: true }, commands: [readAsks(h.session)] };
      // its end clears its asks in serve (answered outside Chat): here they stay, read-only (#317)
      if (
        e.type === 'session.answered' &&
        e.data.id === h.session &&
        e.data.answer === null &&
        f.ended === true
      )
        return kept(h, c);
      if ((e.type === 'session.ask' || e.type === 'session.answered') && e.data.id === h.session) {
        const next = kept(h, cardsEvent(c, h.session, e));

        return h.reading ? { ...next, held: { ...next.held, stale: true } } : next;
      }

      return undefined;
    }
    case 'key': {
      // a message being typed keeps its keys (a card that came meanwhile waits for it)
      if ((f.composing === true && c.override === undefined) || chatCardsWait(h, f))
        return undefined;
      if (cardsOpen(c)) {
        const out = cardsKey(c, input.key, f, input.at);

        return out.handled ? kept(h, out.cards, out.commands) : undefined;
      }
      // the pill above the composer: ⏎ opens it while the transcript's cursor is on nothing
      if (input.key === '<CR>' && !f.cursor && pillNode(c) !== null) return kept(h, cardsReopen(c));

      return undefined;
    }
    case 'text': {
      const pasted = cardsText(c, input.text);

      return pasted === c ? undefined : kept(h, pasted);
    }
    case 'draft': {
      // your own words typed in the app's field while a card takes them
      if (c.typing === undefined) return undefined;

      return kept(h, cardsDraft(c, input.text, input.seq));
    }
    case 'click': {
      const out = cardsClick(c, input.id, f);

      // a click on it is going to it: it has the keys
      return out === undefined
        ? undefined
        : kept({ ...h, waits: undefined }, out.cards, out.commands);
    }
    case 'choice':
      if (input.menu === OVERRIDE_MENU)
        return f.whose === undefined ? kept(h, openOverride(c, input.row, f)) : kept(h, c);
      if (input.menu === CARDS_MENU && input.row === 'reopen') return kept(h, reopenAll(c));

      return undefined;
    default:
      return undefined;
  }
};

/**
 * The shown card waits, the keys not its own: a message is being typed, or it came while one was
 * (`waits`); Tab or a click goes to it. An Override card never waits (its reason is the keys).
 */
export const chatCardsWait = (h: ChatCards, f: Pick<ChatCardsFacts, 'composing'>): boolean =>
  h.cards.override === undefined &&
  shownCard(h.cards) !== undefined &&
  (f.composing === true || (h.waits !== undefined && h.waits === shownCard(h.cards)));

/** A read's answer (the session's asks, its run), not a card's own write coming back. */
export const chatCardsRead = (input: Input): boolean =>
  input.kind === 'result' && (input.id === ASKS_ID || !isCardsResult(input.id));

/** The card that just came waits for you (`waits`), or has the keys again (Tab, a click). */
export const chatCardsWaits = (h: ChatCards, waits: boolean): ChatCards => {
  const id = waits ? shownCard(h.cards) : undefined;

  return id === h.waits ? h : { ...h, waits: id };
};

/** `/override <what>` from the composer (#115): the Override card, on your own session only. */
export const chatCardsOverride = (h: ChatCards, what: string, f: CardFacts): ChatCards =>
  f.whose === undefined ? { ...h, cards: openOverride(h.cards, what, f) } : h;

/** The run as the pin has it: its Needs you card kept, or gone. */
/** The facts the cards act on: read-only too while a resumed session's asks are read. */
const factsOf = <F extends CardFacts>(h: ChatCards, f: F): F =>
  h.resuming === true ? { ...f, ended: true } : f;

/**
 * The session's state as the pin has it now (after any input): live again after its end (resumed,
 * whichever read or event told), its asks read afresh, the read-only cards replaced by the read.
 */
export const chatCardsLive = (
  h: ChatCards,
  session: Pick<SessionData, 'state'>,
): { held: ChatCards; commands: Command[] } => {
  const ended = session.state === 'ended';

  if (ended === (h.ended === true)) return { held: h, commands: [] };
  if (ended) return { held: { ...h, ended }, commands: [] };
  // a read already out may be the ended session's: read again once it is in
  if (h.reading) return { held: { ...h, ended, stale: true, resuming: true }, commands: [] };

  return {
    held: { ...h, ended, reading: true, resuming: true },
    commands: [readAsks(h.session)],
  };
};

export const chatCardsRun = (
  h: ChatCards,
  run: FactoryRunData | undefined,
  session: Pick<SessionData, 'state'> | undefined,
): ChatCards => {
  const cards = cardsRun(h.cards, run, session);

  return cards === h.cards ? h : { ...h, cards };
};

/** The cards' nodes in the rendered body: lines by time, the open card, the pill (`foot`'s top). */
export const chatCardsSlots = (h: ChatCards, f: ChatCardsFacts): Slots => {
  const card = cardNode(h.cards, { ...factsOf(h, f), waits: chatCardsWait(h, f) });
  const pill = pillNode(h.cards);

  return {
    placed: foldedNodes(h.cards),
    tail: card === null ? [] : [card],
    // inset as the column's parts are, just above the composer; as wide as the column at most,
    // so a long question gives way with `…` inside it (#276)
    foot:
      pill === null ? [] : [stack('row', [pill], { pad: [4, 12, 4, 12], sizes: [{ flex: 1 }] })],
  };
};
