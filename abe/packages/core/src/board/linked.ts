/**
 * Linked (2.1 #109): everything tied to a story in ten rows, always the same ones in the same
 * order, each with its state. `abe story linked <id>` answers it; the rows' words are the ui's
 * rules (`ui/src/linked/linked-rows.ts`, which reuses the header's run look), composed in `serve` from
 * the story's reads, each read's failure kept on its own row.
 */
import { z } from 'zod';
import { FactoryPrData } from '../factory/factory-pr';
import { OUTCOMES, RunEnd, RUN_STATES, STAGES } from '../factory/factory';
import { SESSION_STATES } from '../session/session';
import { WAITING_ON } from '../session/waits-on';
import { LINKED_KEYS } from './linked-keys';

export { LINKED_KEYS, LINKED_PARTS, type LinkedKey, type LinkedPart } from './linked-keys';

/** What ⏎ on a row opens (#109 Behaviour 5); a dim row opens nothing. */
export const LinkedOpens = z.discriminatedUnion('kind', [
  /** The story's Card page (Open card). */
  z.object({ kind: z.literal('story'), card: z.number().int().positive() }),
  /** A page in the browser: the spec issue, the pull request. */
  z.object({ kind: z.literal('url'), url: z.string() }),
  /** The spec written in the run: its report file. */
  z.object({ kind: z.literal('file'), path: z.string() }),
  /** The Factory view with the card selected. */
  z.object({ kind: z.literal('factory'), card: z.number().int().positive() }),
  /**
   * These sessions in the Chat column (several: a pick); `reopen`: the one ended session of yours
   * ⏎ reopens there (#343: the same session and conversation).
   */
  z.object({
    kind: z.literal('sessions'),
    ids: z.array(z.string()).min(1),
    reopen: z.string().optional(),
  }),
  /** The bottom pane's Pipelines tab on this run (the provider's id: GitHub's run, Azure's build). */
  z.object({ kind: z.literal('pipeline'), id: z.string(), url: z.string() }),
  /** The story's workspace (⌃W): its session's, at `path`. */
  z.object({ kind: z.literal('workspace'), session: z.string().nullable(), path: z.string() }),
  /** The bottom pane's Boxes tab on this box; `card`: on the card's workspace row there (ADR 0022). */
  z.object({
    kind: z.literal('box'),
    name: z.string(),
    card: z.number().int().positive().optional(),
  }),
  /** These Sheets (`:show`; several: a pick), by the ref `sheet open` takes. */
  z.object({ kind: z.literal('sheets'), refs: z.array(z.string()).min(1) }),
]);
export type LinkedOpens = z.infer<typeof LinkedOpens>;

export const LinkedRow = z.object({
  key: z.enum(LINKED_KEYS),
  label: z.string(),
  /** The state as words, without its time (`time`). */
  words: z.string(),
  /** A time said after the words: in stage (`21 min`), or `ago` (`12 min ago`). */
  time: z.object({ since: z.iso.datetime(), ago: z.boolean() }).nullable(),
  /** Nothing there (`none yet`), or not read: drawn dim, in place. */
  dim: z.boolean(),
  /** Why its part could not be read (its words then `not read · <why>`); null when it was. */
  error: z.string().nullable(),
  opens: LinkedOpens.nullable(),
});
export type LinkedRow = z.infer<typeof LinkedRow>;

/** The run the Run row shows, for its StageRail and hue (the header's look) and live updates. */
export const LinkedRun = z.object({
  session: z.string(),
  stage: z.enum(STAGES),
  state: z.enum(RUN_STATES),
  /** Its clock's start: the Board's, Chat's header's and Sessions' (the ui's `clockSince`). */
  since: z.iso.datetime(),
  reason: z.string().nullable(),
  outcome: z.enum(OUTCOMES).nullable(),
  pr: FactoryPrData.nullable(),
  prototype: z.boolean(),
  /** Its session's state; null when the session is not listed. */
  sessionState: z.enum(SESSION_STATES).nullable(),
  /** You stopped its session (`SessionData.stopped`, #205). */
  sessionStopped: z.boolean().default(false),
  /** Why its session ended, and its box (#316: a box that stopped under it reads Box asleep). */
  sessionReason: z.string().nullable().default(null),
  sessionBox: z.string().nullable().default(null),
  /** Its session's question rounds (#342): the grill's round number. */
  sessionRounds: z.number().int().nonnegative().default(0),
  /** What its waiting session waits on (`SessionData.waitingOn`); null otherwise. */
  sessionWaitingOn: z.enum(WAITING_ON).nullable().default(null),
  /** How a person ended it (#184): an abandoned run's rail stays where it was given up (#229). */
  ended: RunEnd.nullable().default(null),
});
export type LinkedRun = z.infer<typeof LinkedRun>;

/** `abe story linked <id>`. */
export const StoryLinkedData = z.object({
  story: z.number().int().positive(),
  /** The story's title (the run's when the story could not be read); empty when neither. */
  title: z.string(),
  /** When the parts were read: the rows' times are said as of then. */
  at: z.iso.datetime(),
  /** The ten rows, in `LINKED_KEYS` order. */
  rows: z
    .array(LinkedRow)
    .length(LINKED_KEYS.length)
    .refine((rows) => rows.every((r, i) => r.key === LINKED_KEYS[i]), {
      message: 'the rows are the ten of LINKED_KEYS, in order',
    }),
  run: LinkedRun.nullable(),
  /**
   * The branch the story's work is on as read (its session's, else its card's; none known: absent):
   * what a fresh look's `pipelines.changed` and `github.changed` are matched on (#236).
   */
  branch: z.string().optional(),
  /**
   * The rows this answer did not read (`--part`: another part's), said `Reading…`: the popup
   * keeps what another part's answer drew there. Absent: every row read.
   */
  reading: z.array(z.enum(LINKED_KEYS)).optional(),
});
export type StoryLinkedData = z.infer<typeof StoryLinkedData>;

/** `9 s`, `4 min`, `1 h`, `2 h 5 min` (the header's time in stage). */
const elapsed = (since: string, now: string): string => {
  const s = Math.max(0, Math.floor((Date.parse(now) - Date.parse(since)) / 1000));

  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);

  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);

  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
};

/** A row's words with its time as of `now`: `Build ◆ Needs you · 21 min`. */
export const linkedRowText = (row: LinkedRow, now: string): string =>
  row.time === null
    ? row.words
    : `${row.words} · ${elapsed(row.time.since, now)}${row.time.ago ? ' ago' : ''}`;

export const storyLinkedText = (d: StoryLinkedData): string => {
  const width = Math.max(...d.rows.map((r) => r.label.length));

  return `${[
    `Linked · #${d.story}${d.title === '' ? '' : ` ${d.title}`}`,
    ...d.rows.map((r) => `  ${r.label.padEnd(width)}  ${linkedRowText(r, d.at)}`),
  ].join('\n')}\n`;
};
