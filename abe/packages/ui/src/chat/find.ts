/**
 * Find in the rendered Chat's transcript (⌘F; `/` in the transcript's keys), WebStorm's find bar
 * at the transcript's top: the field, `3 of 12` (`No matches`), every match marked in the text,
 * the current one as selected. ⏎ / ↓ the next one (newer), ⇧⏎ / ↑ the one before, wrapping;
 * typing starts at the newest. Esc closes it, the keys back where they were (the composer, else
 * the transcript), whose `n` / `N` go on with the last text. Ignoring case.
 *
 * It searches what the transcript says: your messages, the agent's prose, its step rows (verb,
 * object, result), a folded turn's rows too (a jump there opens them). Not a step's output, a diff
 * card, a card's line or a divider. Counted in the markdown as written; the app marks the matches
 * in the text as drawn, part by part in the same order, so a match across a mark (`**a** b`) is
 * counted but not marked. Pure: the screen keeps a `ChatFind` in its state (`rendered.ts`).
 */
import { caretProp, fieldInsert, fieldKey, fieldOf } from '../runtime/field';
import { type TranscriptFind } from './chat-components';
import { type Folds, ids, messageShown, openFrom, type Turn } from './transcript';

/** The field while it shows. */
export type ChatFind = {
  text: string;
  /** Its caret (`field.ts`); absent: at the end. */
  caret?: number | undefined;
  /** The keys type into it (⌘F, `/`); else it shows `n` / `N`'s text. */
  typing: boolean;
  /** The current match's index among `findMatches`'. */
  at: number;
  /** The composer had the keys as it opened: Esc gives them back there. */
  composer?: true | undefined;
};

/** The last text searched and where, once the field closed: `n` / `N` go on from there. */
export type Found = { text: string; at: number };

/** One match: the part it is in and its place among that part's. */
export type FindMatch = {
  /** The part's node id (a message, a step row, the prose): revealed, its text marked. */
  part: string;
  /** Its place among the part's matches, top to bottom (the app counts them so). */
  n: number;
  /** In a folded turn's rows: the turn a jump there opens. */
  opens?: string | undefined;
};

/** How often `needle` (lower case) is in `text`, ignoring case, no two overlapping. */
const occurrences = (text: string, needle: string): number => {
  if (needle === '') return 0;
  const hay = text.toLowerCase();
  let n = 0;

  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;

  return n;
};

/** Every match of `text` in the turns, top to bottom; none for an empty one. */
export const findMatches = (turns: readonly Turn[], folds: Folds, text: string): FindMatch[] => {
  const needle = text.toLowerCase();

  if (needle === '') return [];
  const open = openFrom(turns);
  const out: FindMatch[] = [];
  const add = (part: string, texts: readonly (string | null | undefined)[], opens?: string) => {
    const k = texts.reduce((sum, t) => sum + occurrences(t ?? '', needle), 0);

    for (let n = 0; n < k; n++) out.push({ part, n, ...(opens === undefined ? {} : { opens }) });
  };

  turns.forEach((turn, i) => {
    if (turn.message !== undefined) add(ids.message(turn.id), [messageShown(turn.message).text]);
    // an earlier turn's rows fold to `N steps` until opened
    const folded = i < open && !folds.opened.includes(turn.id);

    for (const s of turn.steps)
      add(
        ids.step(s.id),
        [s.step.verb, s.step.object, s.step.result],
        folded ? turn.id : undefined,
      );
    if (turn.prose.length > 0) add(ids.prose(turn.id), [turn.prose.join('\n\n')]);
  });

  return out;
};

/** ⌘F or `/`: the field with the keys, the text it shows kept (else empty). */
export const findOpened = (f: ChatFind | undefined, composer: boolean): ChatFind => ({
  text: f?.text ?? '',
  ...(f?.caret === undefined ? {} : { caret: f.caret }),
  typing: true,
  at: f?.at ?? 0,
  ...(composer ? { composer: true } : {}),
});

/** The current match moved by `by`, wrapping. */
export const findMoved = (f: ChatFind, total: number, by: 1 | -1): ChatFind =>
  total === 0 ? f : { ...f, at: (((f.at + by) % total) + total) % total };

/** `n` / `N` from the transcript: the last text shown again, on the next (previous) match. */
export const findAgain = (found: Found, total: number, by: 1 | -1): ChatFind =>
  findMoved({ text: found.text, typing: false, at: Math.min(found.at, total) }, total, by);

/**
 * A key while the field has the keys: the field after it, or undefined when the key is not its
 * (a chord the screen has: ⌘⏎, ⌘4). Esc closes it (`closed`); ⏎ ↓ / ⇧⏎ ↑ move; any other named
 * key is swallowed.
 */
export const findKey = (
  f: ChatFind,
  key: string,
  matches: (text: string) => number,
): { find: ChatFind; closed?: true } | undefined => {
  const total = matches(f.text);

  switch (key) {
    case '<Esc>':
      return { find: f, closed: true };
    case '<CR>':
    case '<Down>':
      return { find: findMoved(f, total, 1) };
    case '<S-CR>':
    case '<Up>':
      return { find: findMoved(f, total, -1) };
  }
  const next = fieldKey(fieldOf(f.text, f.caret), key);

  if (next === undefined) return /^<[DC]-/.test(key) ? undefined : { find: f };

  return { find: findTyped(f, next.text, caretProp(next), matches) };
};

/** Text pasted (or an IME's) into the field. */
export const findText = (
  f: ChatFind,
  text: string,
  matches: (text: string) => number,
): ChatFind => {
  const next = fieldInsert(fieldOf(f.text, f.caret), text.replace(/\s*\n\s*/g, ' '));

  return findTyped(f, next.text, caretProp(next), matches);
};

/** The field's text changed: on the newest match (the bottom's); moving the caret keeps it. */
const findTyped = (
  f: ChatFind,
  text: string,
  caret: number | undefined,
  matches: (text: string) => number,
): ChatFind => ({
  ...f,
  text,
  caret,
  at: text === f.text ? f.at : Math.max(0, matches(text) - 1),
});

/** What the Transcript draws of it: the field, its count, the text to mark and the current one. */
export const findLook = (f: ChatFind, matches: readonly FindMatch[]): TranscriptFind => {
  const i = Math.min(f.at, matches.length - 1);
  const at = matches[i];
  const counted = (): Partial<TranscriptFind> => {
    if (f.text === '') return {};

    return matches.length === 0
      ? { count: 'No matches', none: true }
      : { count: `${i + 1} of ${matches.length}` };
  };

  return {
    text: f.text,
    ...(f.caret === undefined ? {} : { caret: f.caret }),
    ...(f.typing ? { typing: true } : {}),
    ...counted(),
    ...(at === undefined ? {} : { at: { part: at.part, n: at.n } }),
  };
};
