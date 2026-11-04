/**
 * The rendered Chat's components (2.1, #113 slice t113c; canvas boards R-Anatomy, R-Turn,
 * R-Working): the transcript a session's Chat draws natively in its column (420 px, any width
 * 320–640), changes first. A turn is your message (ChatMessage, its context chip folded in), then
 * the agent's turn (Turn): the ChangesBar and one DiffCard per file when it changed code, its
 * StepRows (or StepsFold for an earlier turn), its Prose; a StageDivider between stages; NewBelow
 * at the bottom while scrolled up; QueuedMessages wait above the composer while the agent works.
 * Transcript holds them, newest at the bottom.
 *
 * Types and schemas live here; `components.ts` adds them to the closed set. The Rust half draws
 * them (`app/src/factory/{transcript,diff_card}.rs`). The builders below hold the few rules the
 * parts have (a diff card's 12 lines, a step's 10 output lines); which turn, which row is selected
 * and what is folded is the transcript model's (t113d). The question card, the proposal card and
 * the composer are added beside these later (t114, t115).
 */
import { z } from 'zod';
import type { Node } from '../runtime/components';

/** A diff card shows this many lines, then a dim `show N more` row. */
export const DIFF_CARD_LINES = 12;
/** An unfolded step row shows this many lines of its output. */
export const STEP_OUTPUT_LINES = 10;

/** A quiet text button (`Open all`, `Keep`, `Revert`): a click names its id. */
export type PartAction = { id: string; label: string; tooltip?: string | undefined };

/** Your message: its words on the hover wash, its context chip dim at the top. */
export type ChatMessage = {
  kind: 'ChatMessage';
  id?: string | undefined;
  props: {
    text: string;
    /** What went with it: `#2 The cart total ignores quantity · story`, `@api/src/cart.ts#L12-18`. */
    context?: string | undefined;
  };
};

/** First in a turn that changed code: `2 files changed · +4 −2` and its quiet buttons. */
export type ChangesBar = {
  kind: 'ChangesBar';
  id?: string | undefined;
  props: {
    files: number;
    added?: number | undefined;
    removed?: number | undefined;
    /** Dim after the counts (Improve's `~/.config/abe/user.json`). */
    where?: string | undefined;
    actions?: PartAction[] | undefined;
    /** Keep was pressed: the bar dim, `kept` after its counts. */
    kept?: boolean | undefined;
    /** The transcript's cursor is on it (t113d). */
    selected?: boolean | undefined;
    /** In place of `N files changed` (#350: a prototype chat's `2 changes`). */
    label?: string | undefined;
  };
};

/** One line of a diff card: a context, inserted or deleted line, its number in its side. */
export type DiffLine = {
  kind: 'context' | 'inserted' | 'deleted';
  number?: number | undefined;
  text: string;
};

/**
 * One changed file: its header (path, `+3 −1`, the dim note) and the unified diff under it. A
 * click on the header names the node's id (fold / unfold); `more` is the dim `show 18 more` row.
 */
export type DiffCard = {
  kind: 'DiffCard';
  id?: string | undefined;
  props: {
    path: string;
    added: number;
    removed: number;
    /** The lines drawn (none while folded). */
    lines: DiffLine[];
    /** At the header's right, dim: `⏎ open · u revert`, folded `show 4 lines`. */
    note?: string | undefined;
    folded?: boolean | undefined;
    /** Lines not drawn: a dim `show N more` row, a click on `id`; `selected`: the cursor's. */
    more?: { count: number; id?: string | undefined; selected?: boolean | undefined } | undefined;
    selected?: boolean | undefined;
    /** The code's language for its colours; else the path's extension says. */
    lang?: string | undefined;
    /**
     * In place of the path in the header (#350: a prototype change's `2 · JS · the VAT line · on
     * #total`); the path still names its icon and colours.
     */
    title?: string | undefined;
    /** Drawn dim: a prototype change undone since (`2 · undone`). */
    dim?: boolean | undefined;
  };
};

/** A step's mark: done (✓ good), failed (✗ bad), running now (● warn, its time so far). */
export const STEP_MARKS = ['good', 'bad', 'live'] as const;
export type StepMark = (typeof STEP_MARKS)[number];

/** One tool call, 24 px: mark, verb, object, the dim result; unfolded, its output under it. */
export type StepRow = {
  kind: 'StepRow';
  id?: string | undefined;
  props: {
    mark: StepMark;
    /** `Read`, `Ran`, `Searched`, `Running`. */
    verb: string;
    object?: string | undefined;
    /** A path in the path colour, a command in mono, else plain text. */
    objectKind?: 'path' | 'command' | 'text' | undefined;
    /** Dim after the object: `12 passed · 1 skipped` (drawn after a `·`). */
    result?: string | undefined;
    /** At the right, dim: a live step's time so far (`4 s`). */
    time?: string | undefined;
    unfolded?: boolean | undefined;
    /** The output an unfolded row shows (mono, on the editor background). */
    output?: string[] | undefined;
    /**
     * Output lines not drawn (#343, as a diff card's): a dim `show N more` row under it, a click
     * on `id`; `selected`: the cursor's.
     */
    more?: { count: number; id?: string | undefined; selected?: boolean | undefined } | undefined;
    selected?: boolean | undefined;
  };
};

/** An earlier turn's steps, folded to one dim line: `12 steps`. */
export type StepsFold = {
  kind: 'StepsFold';
  id?: string | undefined;
  props: { count: number; selected?: boolean | undefined };
};

/** The agent's words as markdown, in the card dialog's reading profile (13 px). */
export type Prose = { kind: 'Prose'; id?: string | undefined; props: { markdown: string } };

/** A stage change between turns: `── Build → Review · 12:41 ──`, centred and dim. */
export type StageDivider = {
  kind: 'StageDivider';
  id?: string | undefined;
  props: { from: string; to: string; at: string };
};

/** Scrolled up while entries came: a dim `↓ N new` row at the bottom; a click jumps down. */
export type NewBelow = {
  kind: 'NewBelow';
  id?: string | undefined;
  props: { count: number; selected?: boolean | undefined };
};

/** A message typed while the agent works, sent when its turn ends; × (`remove`) takes it back. */
export type QueuedMessage = {
  kind: 'QueuedMessage';
  id?: string | undefined;
  props: { text: string; remove?: string | undefined };
};

/** The agent's turn: its parts 8 px apart (step rows abut). */
export type Turn = {
  kind: 'Turn';
  id?: string | undefined;
  props: Record<string, never>;
  children: Node[];
};

/**
 * The column's scrolling transcript: messages, turns and dividers 16 px apart, the newest at the
 * bottom. The shell keeps its scroll: it sticks to the bottom while there, and scrolled up new
 * parts leave it in place; it says which with a click on `<id>:up` / `<id>:bottom` (the screen
 * shows NewBelow, pinned under the parts, while up).
 */
export type Transcript = {
  kind: 'Transcript';
  id?: string | undefined;
  props: {
    /** Brought into view when it changes: a part's id (the cursor's). */
    reveal?: string | undefined;
    /** Scrolled to the bottom when it changes (`↓ N new`'s ⏎ adds one). */
    bottom?: number | undefined;
    /** Whose transcript it is: the shell keeps its scroll by it, not carried to another session. */
    session?: string | undefined;
    /**
     * A question was answered and the agent goes on with it (#311): at the bottom, what goes (the
     * card folding to its line) leaves its room there for what comes, nothing above moves down.
     */
    hold?: boolean | undefined;
    /** Find's bar at its top (⌘F, `/`), the matches it marks in the parts' text. */
    find?: TranscriptFind | undefined;
    /** `abe`: the Abe chat's, Abe's face (128 px, 12 %) faint behind its parts. */
    mark?: 'abe' | undefined;
  };
  children: Node[];
};

/**
 * Find's bar over the transcript: the field (`typing`: its caret, the keys in it), `3 of 12`
 * (`none`: `No matches`, red), ↑ ↓ × (`<id>:find:prev`, `:next`, `:close`; the field
 * `<id>:find`). Every match of `text` in the parts' text is marked, ignoring case; `at` is the
 * current one: the `n`th match in part `part`, counted top to bottom.
 */
export type TranscriptFind = {
  text: string;
  caret?: number | undefined;
  typing?: boolean | undefined;
  count?: string | undefined;
  none?: boolean | undefined;
  at?: { part: string; n: number } | undefined;
};

export type ChatComponentNode =
  | Transcript
  | Turn
  | ChatMessage
  | ChangesBar
  | DiffCard
  | StepRow
  | StepsFold
  | Prose
  | StageDivider
  | NewBelow
  | QueuedMessage;

export const CHAT_COMPONENT_KINDS = [
  'Transcript',
  'Turn',
  'ChatMessage',
  'ChangesBar',
  'DiffCard',
  'StepRow',
  'StepsFold',
  'Prose',
  'StageDivider',
  'NewBelow',
  'QueuedMessage',
] as const;

/** The schemas, built on the set's own primitives (`components.ts` calls this). */
export const chatComponentSchemas = (d: { nodeId: z.ZodString; node: () => z.ZodType<Node> }) => {
  const id = d.nodeId.optional();
  const count = z.number().int().nonnegative();
  const action = z.strictObject({
    id: d.nodeId,
    label: z.string().min(1),
    tooltip: z.string().optional(),
  });

  return [
    z.strictObject({
      kind: z.literal('Transcript'),
      id,
      props: z.strictObject({
        reveal: d.nodeId.optional(),
        bottom: z.number().int().nonnegative().optional(),
        session: z.string().min(1).optional(),
        hold: z.boolean().optional(),
        find: z
          .strictObject({
            text: z.string(),
            caret: count.optional(),
            typing: z.boolean().optional(),
            count: z.string().min(1).optional(),
            none: z.boolean().optional(),
            at: z.strictObject({ part: d.nodeId, n: count }).optional(),
          })
          .optional(),
        mark: z.literal('abe').optional(),
      }),
      get children() {
        return z.array(d.node());
      },
    }),
    z.strictObject({
      kind: z.literal('Turn'),
      id,
      props: z.strictObject({}),
      get children() {
        return z.array(d.node());
      },
    }),
    z.strictObject({
      kind: z.literal('ChatMessage'),
      id,
      props: z.strictObject({ text: z.string(), context: z.string().optional() }),
    }),
    z.strictObject({
      kind: z.literal('ChangesBar'),
      id,
      props: z.strictObject({
        files: count,
        added: count.optional(),
        removed: count.optional(),
        where: z.string().optional(),
        actions: z.array(action).optional(),
        kept: z.boolean().optional(),
        selected: z.boolean().optional(),
        label: z.string().min(1).optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('DiffCard'),
      id,
      props: z.strictObject({
        path: z.string().min(1),
        added: count,
        removed: count,
        lines: z.array(
          z.strictObject({
            kind: z.enum(['context', 'inserted', 'deleted']),
            number: z.number().int().positive().optional(),
            text: z.string(),
          }),
        ),
        note: z.string().optional(),
        folded: z.boolean().optional(),
        more: z
          .strictObject({
            count: z.number().int().positive(),
            id: d.nodeId.optional(),
            selected: z.boolean().optional(),
          })
          .optional(),
        selected: z.boolean().optional(),
        lang: z.string().optional(),
        title: z.string().min(1).optional(),
        dim: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('StepRow'),
      id,
      props: z.strictObject({
        mark: z.enum(STEP_MARKS),
        verb: z.string().min(1),
        object: z.string().optional(),
        objectKind: z.enum(['path', 'command', 'text']).optional(),
        result: z.string().optional(),
        time: z.string().optional(),
        unfolded: z.boolean().optional(),
        output: z.array(z.string()).optional(),
        more: z
          .strictObject({
            count: z.number().int().positive(),
            id: d.nodeId.optional(),
            selected: z.boolean().optional(),
          })
          .optional(),
        selected: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('StepsFold'),
      id,
      props: z.strictObject({
        count: z.number().int().positive(),
        selected: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('Prose'),
      id,
      props: z.strictObject({ markdown: z.string() }),
    }),
    z.strictObject({
      kind: z.literal('StageDivider'),
      id,
      props: z.strictObject({ from: z.string(), to: z.string(), at: z.string() }),
    }),
    z.strictObject({
      kind: z.literal('NewBelow'),
      id,
      props: z.strictObject({
        count: z.number().int().positive(),
        selected: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('QueuedMessage'),
      id,
      props: z.strictObject({ text: z.string(), remove: d.nodeId.optional() }),
    }),
  ] as const;
};

/** What the transcript model knows of one changed file (t113d fills it from the session). */
export type FileChange = {
  path: string;
  added: number;
  removed: number;
  /** Every line of the file's diff, context included. */
  lines: DiffLine[];
};

/**
 * A file's diff card: folded, only its header (`show N lines`); else its first
 * `DIFF_CARD_LINES` lines and a `show N more` row (`more`, a click on `<id>:more`) unless `full`.
 */
export const diffCard = (
  nodeId: string,
  f: FileChange,
  o: { folded?: boolean; full?: boolean; selected?: boolean } = {},
): DiffCard => {
  const n = f.lines.length;
  const shown = o.full === true ? f.lines : f.lines.slice(0, DIFF_CARD_LINES);
  const lines = o.folded === true ? [] : shown;
  const hidden = o.folded === true ? 0 : n - lines.length;

  return {
    kind: 'DiffCard',
    id: nodeId,
    props: {
      path: f.path,
      added: f.added,
      removed: f.removed,
      lines,
      note: o.folded === true ? `show ${n} line${n === 1 ? '' : 's'}` : '⏎ open · u revert',
      ...(o.folded === true ? { folded: true } : {}),
      ...(hidden > 0 ? { more: { count: hidden, id: `${nodeId}:more` } } : {}),
      ...(o.selected === true ? { selected: true } : {}),
    },
  };
};

/** The changes bar over a turn's files: their count and lines, Open all · Keep · Revert. */
export const changesBar = (nodeId: string, files: readonly FileChange[]): ChangesBar => ({
  kind: 'ChangesBar',
  id: nodeId,
  props: {
    files: files.length,
    added: files.reduce((s, f) => s + f.added, 0),
    removed: files.reduce((s, f) => s + f.removed, 0),
    actions: [
      { id: `${nodeId}:open-all`, label: 'Open all', tooltip: 'Open the diffs' },
      { id: `${nodeId}:keep`, label: 'Keep', tooltip: 'Keep these changes' },
      { id: `${nodeId}:revert`, label: 'Revert', tooltip: 'Revert the files' },
    ],
  },
});

/**
 * A step row; unfolded, the first `STEP_OUTPUT_LINES` lines of its output and a `show N more` row
 * for the rest (`<id>:more`, #343), or every line once `full`.
 */
export const stepRow = (
  nodeId: string,
  s: Omit<StepRow['props'], 'output' | 'unfolded' | 'more'>,
  o: {
    output?: readonly string[];
    unfolded?: boolean;
    full?: boolean;
    moreSelected?: boolean;
  } = {},
): StepRow => {
  const output = o.output ?? [];
  const hidden = o.full === true ? 0 : Math.max(0, output.length - STEP_OUTPUT_LINES);

  return {
    kind: 'StepRow',
    id: nodeId,
    props: {
      ...s,
      ...(o.unfolded === true
        ? {
            unfolded: true,
            output: hidden > 0 ? output.slice(0, STEP_OUTPUT_LINES) : [...output],
            ...(hidden > 0
              ? {
                  more: {
                    count: hidden,
                    id: `${nodeId}:more`,
                    ...(o.moreSelected === true ? { selected: true } : {}),
                  },
                }
              : {}),
          }
        : {}),
    },
  };
};

/** Whether an unfolded step's output is cut at `STEP_OUTPUT_LINES` (#343: `show N more`). */
export const stepCut = (output: readonly string[], full: boolean): boolean =>
  !full && output.length > STEP_OUTPUT_LINES;
