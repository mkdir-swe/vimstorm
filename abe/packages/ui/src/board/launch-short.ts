/**
 * A launch onto its repo's box short of memory or disk (ADR 0022): `factory run` refused
 * `box-short` with its question (core's `launchShortAsk`), asked as a menu headed by its line:
 * Resize to <next size> (recommended), Launch anyway, Cancel. Never Queued, never a second box.
 */
import type { BoxShortAsk, ShortAnswer } from '@abe/core';
import type { Command, Input, Menu, MenuRow } from '../runtime/runtime';

/** The question's menu id, `launchshort:<card>`: its choice comes back to the launching screen. */
export const LAUNCH_SHORT = 'launchshort:';

/** A choice's words: its note, `recommended`. */
const shortRow = (c: BoxShortAsk['choices'][number]): Omit<MenuRow, 'does'> => ({
  id: c.answer,
  text: c.label,
  ...(c.note === undefined && c.recommended !== true
    ? {}
    : {
        dim: [c.note, c.recommended === true ? 'recommended' : undefined]
          .filter((w) => w !== undefined)
          .join(' · '),
      }),
  ...(c.answer === 'resize' ? { costly: true } : {}),
});

/** The question for `card`; Resize stops the box, so the menu never opens on it. */
export const shortMenu = (card: number, ask: BoxShortAsk): Command => ({
  kind: 'menu',
  id: `${LAUNCH_SHORT}${card}`,
  title: ask.line,
  rows: ask.choices.map((c): MenuRow => ({ ...shortRow(c), does: { kind: 'back' } })),
});

/** The answer a chosen row gives the launch sent again; undefined: Cancel (or no such row). */
export const shortAnswerOf = (row: string): ShortAnswer | undefined =>
  row === 'resize' || row === 'anyway' ? row : undefined;

/** The menu id of the same question on any other run (Retry, Reopen, Move to cloud). */
export const SHORT_RERUN = 'shortrerun';

/**
 * The same question on a Retry run, a Reopen or a Move to cloud: the same menu, each answer
 * that run again with `--short <answer>` (Command mode runs it: a refusal is its balloon), Cancel
 * nothing.
 */
export const shortRerun = (ask: BoxShortAsk, argv: readonly string[]): Menu => ({
  kind: 'menu',
  id: SHORT_RERUN,
  title: ask.line,
  rows: ask.choices.map((c): MenuRow => {
    const answer = shortAnswerOf(c.answer);

    return {
      ...shortRow(c),
      does:
        answer === undefined
          ? { kind: 'do', commands: [] }
          : { kind: 'run', argv: [...argv, '--short', answer] },
    };
  }),
});

/** The runs of a screen whose answer may be the question: Retry run's and Reopen's ids. */
const ASKS = ['retry', 'reopen:', 'chat:reopen'];

/** What a screen kept of the runs that may come back `box-short`: their argv by run id. */
export type ShortRuns = Readonly<Record<string, readonly string[]>>;

type Stepped<S> = { state: S; commands: Command[] };

/**
 * A screen's step that asks the question on its Retry runs and Reopens: it keeps each such
 * run's argv until its answer, and on `box-short` shows the menu in place of the refusal's balloon
 * (the screen's own step still takes the answer, so what it waited on ends).
 */
export const withShortAsk =
  <S extends { shortRuns?: ShortRuns | undefined }>(step: (s: S, input: Input) => Stepped<S>) =>
  (s: S, input: Input): Stepped<S> => {
    const out = step(s, input);
    const answered = input.kind === 'result' ? input.id : undefined;
    const argv = answered === undefined ? undefined : s.shortRuns?.[answered];
    const shortRuns: ShortRuns = Object.fromEntries([
      ...Object.entries(out.state.shortRuns ?? s.shortRuns ?? {}).filter(([k]) => k !== answered),
      ...out.commands.flatMap((c) =>
        c.kind === 'run' && ASKS.some((p) => c.id.startsWith(p)) ? [[c.id, c.argv] as const] : [],
      ),
    ]);
    const state = { ...out.state, shortRuns };
    const ask = input.kind === 'result' && !input.reply.ok ? input.reply.error.boxShort : undefined;

    if (argv === undefined || ask === undefined) return { state, commands: out.commands };

    return {
      state,
      commands: [
        ...out.commands.filter((c) => !(c.kind === 'shell' && c.effect.kind === 'balloon')),
        shortRerun(ask, argv),
      ],
    };
  };
