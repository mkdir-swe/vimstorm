/**
 * Assign… › a teammate: the card's Action menu hands back `assign` with the pick's value (`me` or
 * a member's email); the card actions (`card-actions.ts`) write it with `card assign` and say
 * `Assigned #102 to Sam Sample · u undo`, Assign to me and launch's assign too. `u` as the very
 * next key puts the card back to whom it was assigned before (you, no one, or that person). Pure
 * rules; `card-actions.ts` holds the state.
 */
import type { BoardMember, CardData } from '@abe/core';
import type { Answer, Command, Refused } from '../runtime/runtime';

/** `card assign`'s run, and its undo's, by the card: `assign:<card>`, `assign-undo:<card>`. */
export const ASSIGN_RUN = 'assign:';
export const UNDO_ASSIGN_RUN = 'assign-undo:';

/** Where an undo puts the card back: `card assign`'s `who`, and that person in words. */
export type AssignUndo = { card: number; who: string; words: string };

/**
 * An assign asked and not answered: the card, whom it goes to in words, and its undo, if any.
 * Assign to me and launch asks it only once its launch is answered launched: a refused launch
 * changes nothing on the board.
 */
export type Assigning = { card: number; words: string; undo?: AssignUndo | undefined };

/** What the Board keeps of its assigns: the ones out, the undo `u` runs now, the undos out. */
export type AssignState = {
  asked: Readonly<Record<number, Assigning>>;
  undo?: AssignUndo | undefined;
  undoing: Readonly<Record<number, AssignUndo>>;
};

export const NO_ASSIGNS: AssignState = { asked: {}, undoing: {} };

/** The pick's value in words: `you`, `no one`, else the member's name (their email unknown). */
const wordsOf = (who: string, members: readonly BoardMember[]): string => {
  if (who === 'me') return 'you';
  if (who === 'none') return 'no one';

  return members.find((m) => m.email.toLowerCase() === who.toLowerCase())?.name ?? who;
};

/**
 * Who the card goes back to: you when it is yours, no one when no one's, else its assignee by
 * their email; an assignee Azure DevOps names with no email has no undo.
 */
const undoOf = (card: Pick<CardData, 'id' | 'assignee'>, mine: boolean): AssignUndo | undefined => {
  const a = card.assignee;

  if (mine) return { card: card.id, who: 'me', words: 'you' };
  if (a === null) return { card: card.id, who: 'none', words: 'no one' };

  return a.email === '' ? undefined : { card: card.id, who: a.email, words: a.name };
};

/** `assign` handed back with `who`: `card assign` run, its words and undo kept until it answers. */
export const assignOn = (
  s: AssignState,
  card: Pick<CardData, 'id' | 'assignee'>,
  who: string,
  o: { mine: boolean; members: readonly BoardMember[] },
): { state: AssignState; commands: Command[] } => {
  const undo = undoOf(card, o.mine);

  return {
    // a new assign takes the old undo's place
    state: {
      ...s,
      undo: undefined,
      asked: {
        ...s.asked,
        [card.id]: { card: card.id, words: wordsOf(who, o.members), undo },
      },
    },
    commands: [
      {
        kind: 'run',
        id: `${ASSIGN_RUN}${card.id}`,
        argv: ['card', 'assign', String(card.id), who],
      },
    ],
  };
};

/** `u`: the last assign undone, if it was answered and `u` is the key right after it. */
export const undoAssign = (s: AssignState): { state: AssignState; commands: Command[] } => {
  const u = s.undo;

  if (u === undefined) return { state: s, commands: [] };

  return {
    state: { ...s, undo: undefined, undoing: { ...s.undoing, [u.card]: u } },
    commands: [
      {
        kind: 'run',
        id: `${UNDO_ASSIGN_RUN}${u.card}`,
        argv: ['card', 'assign', String(u.card), u.who],
      },
    ],
  };
};

/** Any key but `u`: the undo offered is gone (it is the next key's only). */
export const keyed = (s: AssignState): AssignState =>
  s.undo === undefined ? s : { ...s, undo: undefined };

/** Whether a run's answer is an assign's or its undo's. */
export const isAssignRun = (id: string): boolean =>
  id.startsWith(ASSIGN_RUN) || id.startsWith(UNDO_ASSIGN_RUN);

const status = (text: string): Command => ({ kind: 'shell', effect: { kind: 'status', text } });

/**
 * An assign's (or undo's) answer: said on the status line, an assign's undo then offered;
 * refused, a balloon in Azure DevOps' (or serve's) words.
 */
export const assigned = (
  s: AssignState,
  input: Answer | Refused,
): { state: AssignState; commands: Command[] } => {
  const undoing = input.id.startsWith(UNDO_ASSIGN_RUN);
  const card = Number(input.id.slice((undoing ? UNDO_ASSIGN_RUN : ASSIGN_RUN).length));
  const asked = undoing ? undefined : s.asked[card];
  const undone = undoing ? s.undoing[card] : undefined;
  // only this answer's own: an assign asked again meanwhile keeps its words and undo
  const without = <T>(r: Readonly<Record<number, T>>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => Number(k) !== card));
  const rest: AssignState = undoing
    ? { ...s, undoing: without(s.undoing) }
    : { ...s, asked: without(s.asked) };

  if (!input.reply.ok)
    return {
      state: rest,
      commands: [
        {
          kind: 'shell',
          effect: {
            kind: 'balloon',
            tone: 'error',
            text: `${input.reply.error.message} (${input.reply.error.code})`,
          },
        },
      ],
    };
  if (undone !== undefined)
    return {
      state: rest,
      commands: [
        status(
          undone.who === 'none'
            ? `Unassigned #${card} again`
            : `Assigned #${card} back to ${undone.words}`,
        ),
      ],
    };
  if (asked === undefined) return { state: rest, commands: [] };

  return {
    state: { ...rest, undo: asked.undo },
    commands: [
      status(`Assigned #${card} to ${asked.words}${asked.undo === undefined ? '' : ' · u undo'}`),
    ],
  };
};
