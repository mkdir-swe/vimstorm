/**
 * The Launch note (#347): what a developer tells the agent before a launch starts, read with the
 * card in its first prompt and kept on the run and its session, never written to the card. A
 * Standing note is one a Layer adds to every launch (`launch.notes`, each Layer adding to the
 * ones above, an Override dropping an upper one), kept with its Layer as it was at launch.
 */
import { type Merged } from '../layer/settings';
import {
  type LaunchNote,
  MAX_NOTE,
  type StandingNote,
  standingOf,
  standingWords,
} from './launch-words';
import { type Outcome, refused } from '../command';

export * from './launch-words';

/** The standing notes in force (`launch.notes`), each with the Layer that wrote it. */
export const standingNotes = (merged: Pick<Merged, 'values' | 'explain'>): StandingNote[] =>
  standingOf(merged.values['launch.notes'], merged.explain('launch.notes').layers);

/**
 * The prompt's section of the person's words (#347), after the card's text: their Launch note
 * under `## Notes from <name>`, then the standing notes with whose each is; '' for none.
 */
export const notesPrompt = (
  note: LaunchNote | null | undefined,
  standing: readonly StandingNote[] = [],
): string =>
  [
    ...(note === null || note === undefined ? [] : [`## Notes from ${note.by}\n${note.text}`]),
    ...(standing.length === 0
      ? []
      : [
          ['## Standing notes', ...standing.map((s) => `- ${s.text} (${standingWords(s)})`)].join(
            '\n',
          ),
        ]),
  ].join('\n\n');

/**
 * `--note` / `--note-file`'s text as a note, or why not: one of the two only, its words trimmed,
 * at most `MAX_NOTE`; none given, or only blanks, is no note.
 */
export const noteText = (o: {
  note?: string | undefined;
  file?: string | undefined;
}): Outcome<string | null> => {
  if (o.note !== undefined && o.file !== undefined)
    return refused('usage', 'give --note or --note-file, not both', 2);
  const text = (o.note ?? o.file ?? '').trim();

  if (text.length > MAX_NOTE)
    return refused(
      'note-too-long',
      `a Launch note says at most ${MAX_NOTE} characters, this one ${text.length}`,
      2,
    );

  return { ok: true, data: text === '' ? null : text };
};

/** The note and standing notes as `session show` / `factory status` print them. */
export const noteLines = (
  note: LaunchNote | null | undefined,
  standing: readonly StandingNote[] = [],
): string[] => [
  ...(note === null || note === undefined
    ? []
    : [`  note        ${note.text.split('\n')[0] ?? ''} · ${note.by}`]),
  ...standing.map((s) => `  standing    ${s.text} · ${standingWords(s)}`),
];
