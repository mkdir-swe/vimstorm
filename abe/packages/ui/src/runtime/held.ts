/**
 * An early ⌘⏎, one rule on every screen (#315): asked while the reads the menu stands on are still
 * pending, the press is held (the status line says it waits) and the menu opens once they land; a
 * key, a click, a choice, typed text or the keyboard gone elsewhere drops it, its status line
 * cleared. The Board's card menu and Chat's both hold theirs this way.
 */
import { type Command, type Input } from './runtime';

type Out<S> = { state: S; commands: Command[] };

/** How a screen keeps its held press (`H`: what it names, a card) and acts on it. */
export type Hold<S, H> = {
  /** The press held, if one is. */
  held: (s: S) => H | undefined;
  /** `s` holding `h`, or none. */
  hold: (s: S, h: H | undefined) => S;
  /** Its reads landed (or failed, or what it was asked on is gone): it acts now. */
  ready: (s: S, h: H) => boolean;
  /** What it does then, on `s` holding nothing: the menu, or nothing once what it named is gone. */
  act: (s: S, h: H) => Out<S>;
};

/** One line on the status line; empty clears it. */
export const statusLine = (text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'status', text },
});

/** What the status line says while a card's ⌘⏎ (or next step) waits for its run (#315). */
export const readingWords = (card: number): string => `Reading #${card}'s run and session…`;

/** The person went on: a held press gives way to it. */
const personWent = (input: Input): boolean =>
  input.kind === 'key' ||
  input.kind === 'click' ||
  input.kind === 'choice' ||
  input.kind === 'text' ||
  input.kind === 'blur' ||
  (input.kind === 'focus' && !input.focused);

/** The press asked now, its reads pending: held, the status line saying what it waits on. */
export const holdPress = <S, H>(rule: Hold<S, H>, s: S, h: H, waits: string): Out<S> => ({
  state: rule.hold(s, h),
  commands: [statusLine(waits)],
});

/** Before a step: a person's input drops the held press (the step may hold it again). */
export const dropHeld = <S, H>(rule: Hold<S, H>, s: S, input: Input): S =>
  personWent(input) && rule.held(s) !== undefined ? rule.hold(s, undefined) : s;

/**
 * After a step from `before` to `after`: a press still held acts once it is ready; one dropped
 * clears its status line. The commands go before the step's own (which may set the line again).
 */
export const settleHeld = <S, H>(rule: Hold<S, H>, before: S, after: S): Out<S> => {
  const h = rule.held(after);

  if (h === undefined)
    return { state: after, commands: rule.held(before) === undefined ? [] : [statusLine('')] };
  if (!rule.ready(after, h)) return { state: after, commands: [] };
  const acted = rule.act(rule.hold(after, undefined), h);

  return { state: acted.state, commands: [statusLine(''), ...acted.commands] };
};

/** A screen's step with the rule around it. */
export const holding =
  <S, H>(rule: Hold<S, H>, step: (s: S, input: Input) => Out<S>) =>
  (s: S, input: Input): Out<S> => {
    const stepped = step(dropHeld(rule, s, input), input);
    const settled = settleHeld(rule, s, stepped.state);

    return { state: settled.state, commands: [...settled.commands, ...stepped.commands] };
  };
