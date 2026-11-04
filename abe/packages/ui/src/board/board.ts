/**
 * The Factory view's Board components: the Board's header, its columns (equal widths, or at least
 * 200 px each, scrolled sideways when they do not fit), a column, and the card with its rail row.
 * Their types and schemas live here; `components.ts` adds them to the closed set (`boardSchemas`
 * takes the set's own primitives, so this module needs nothing of it at run time).
 */
import { z } from 'zod';
import { BOX_MARKS, type BoxMark } from '../live';
import type { AgentState, Hue, Node } from '../runtime/runtime';

/** A selection's look: none, where the keys are (blue), or elsewhere (grey). */
export const SELECTIONS = ['default', 'selected', 'selected-inactive'] as const;
export type Selection = (typeof SELECTIONS)[number];

/** One segment of a card's stage rail (Spec · Build · Review · PR · Done). */
export const RAIL_SEGMENTS = ['todo', 'done', 'now', 'need', 'fail', 'ready', 'wait'] as const;
export type RailSegment = (typeof RAIL_SEGMENTS)[number];

/** How a card reads: as any card, or standing out (needs you, failed). */
export const EMPHASES = ['normal', 'needs-you', 'failed'] as const;
export type Emphasis = (typeof EMPHASES)[number];

/** The state's glyph before its word: running, needs you, done, failed, idle. */
export const GLYPHS = ['●', '◆', '✓', '✗', '○'] as const;
export type Glyph = (typeof GLYPHS)[number];

// The box mark at the rail row's right (`box-look.ts`): a 12 px cloud in the accent while its box
// runs, dashed while it starts, `☁ asleep` and `☁ Queued` dim. A local session has none.

/** The Board's header: its title, tabs, dim words after them (`Sprint 1 · 3 cards`), a note at the right. */
export type BoardHeader = {
  kind: 'BoardHeader';
  id?: string | undefined;
  props: {
    title: string;
    tabs?: { id: string; label: string }[] | undefined;
    selected?: string | undefined;
    /** The Board has the keys: its selected tab in the active look. */
    active?: boolean | undefined;
    /** Words after the title and tabs, each in its hue (`Sprint 1 · 3 cards`, `◆ 1 needs you`). */
    counts?: { text: string; hue?: Hue | undefined }[] | undefined;
    /** Dim at the right: the `/` filter, `Board not read · <reason>`, `Reading…`. */
    note?: string | undefined;
    /** Dim at the far right while the columns scroll sideways: those out of view, `Closed 0 ›`. */
    more?: string | undefined;
  };
};

/**
 * The Board's columns side by side. With no `scroll` each takes an equal share of the width
 * (`width ÷ count`, whatever it holds); with it each is `scroll.width` px and the row is moved
 * `scroll.offset` px left, so the selected column stays in view.
 */
export type BoardColumns = {
  kind: 'BoardColumns';
  id?: string | undefined;
  props: {
    /** `view`: the width the columns are shown in, for the sideways scrollbar. */
    scroll?: { width: number; offset: number; view: number } | undefined;
  };
  /** BoardColumn. */
  children: Node[];
};

/** One Azure column: its header (`New 1`), then its cards; an empty one keeps its width. */
export type BoardColumn = {
  kind: 'BoardColumn';
  id?: string | undefined;
  props: {
    name: string;
    /** None until the board is read: a column not read is not an empty one. */
    count?: number | undefined;
    /** Dim, after the count: `+2 below`. */
    note?: string | undefined;
    /** The column holds the cursor: its name bold. */
    focused?: boolean | undefined;
    /** Dim in the column's body: `No stories in Sprint 1`. */
    empty?: string | undefined;
    /** An empty column's dim row `＋ New card`: a click is `newcard:<name>`. */
    add?: string | undefined;
  };
  /** BoardCard. */
  children: Node[];
};

/** The rail row: the five segments, the stage word, the state in its hue, the time, the box mark. */
export type RailRow = {
  segments: RailSegment[];
  /** `Build`; none once Done. */
  stage?: string | undefined;
  glyph: Glyph;
  word: string;
  /** The hue of the glyph and the word. */
  state: AgentState;
  /** Time in the stage: `21 min`. */
  time?: string | undefined;
  box?: BoxMark | undefined;
};

/**
 * A card (DS `vs-card`): `#id`, the type badge, initials (a round badge), points; the title (two
 * lines at most); its rail row or a dim line with no run (`No session`). The rail row is one
 * line at any width: too narrow, the shell leaves words out whole (the stage word first, the
 * segments still say the stage; then the box mark's word), then narrows the segments, and only
 * then cuts the state's word with an ellipsis; the glyph, the time and the cloud always show.
 */
export type BoardCard = {
  kind: 'BoardCard';
  id?: string | undefined;
  props: {
    card: number;
    /** The card has a prototype linked (its `prototype` tag): the mark before `#id`. */
    prototype?: boolean | undefined;
    /** The type badge: `US`, `Bug`. */
    type: string;
    bug?: boolean | undefined;
    initials?: string | undefined;
    /** `3 pt`, dim. */
    points?: string | undefined;
    title: string;
    rail?: RailRow | undefined;
    /**
     * The last row with no run: `No session` dim, `◆ Needs info` in the needs-you hue, `? Can we
     * do this` in the accent; the box mark at its right when a box is tagged with the card.
     */
    note?: { text: string; hue?: Hue | undefined; box?: BoxMark | undefined } | undefined;
    emphasis?: Emphasis | undefined;
    /** A teammate's card on the Team tab: its title dim. */
    theirs?: boolean | undefined;
    /** A done card (Closed, Done) of the sprint: its title dim, the sprint's work done. */
    closed?: boolean | undefined;
    selection?: Selection | undefined;
    /**
     * Local mode: its state here over the board's, `Resolved here · GitHub: Active`. The card
     * drawn dashed in the path hue, this line with the house mark under its title.
     */
    local?: string | undefined;
    /**
     * `#id title · word · reason`. The shell shows it below the card (never over it) only when
     * it says what the card does not: `tipAdds` (a reason), or the card cut its title or its
     * state's word.
     */
    tooltip?: string | undefined;
    /** The tooltip says more than the card shows whole (a reason): it shows on every hover. */
    tipAdds?: boolean | undefined;
  };
};

export type BoardNode = BoardHeader | BoardColumns | BoardColumn | BoardCard;

export const BOARD_KINDS = ['BoardHeader', 'BoardColumns', 'BoardColumn', 'BoardCard'] as const;

/** The four schemas, built on the set's own primitives (`components.ts` calls this). */
export const boardSchemas = (d: {
  nodeId: z.ZodString;
  hue: z.ZodType<Hue>;
  agentState: z.ZodType<AgentState>;
  node: () => z.ZodType<Node>;
}) => {
  const id = d.nodeId.optional();

  return [
    z.strictObject({
      kind: z.literal('BoardHeader'),
      id,
      props: z.strictObject({
        title: z.string(),
        tabs: z.array(z.strictObject({ id: d.nodeId, label: z.string() })).optional(),
        selected: d.nodeId.optional(),
        active: z.boolean().optional(),
        counts: z.array(z.strictObject({ text: z.string(), hue: d.hue.optional() })).optional(),
        note: z.string().optional(),
        more: z.string().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('BoardColumns'),
      id,
      props: z.strictObject({
        scroll: z
          .strictObject({
            width: z.number().positive(),
            offset: z.number().nonnegative(),
            view: z.number().positive(),
          })
          .optional(),
      }),
      get children() {
        return z.array(d.node());
      },
    }),
    z.strictObject({
      kind: z.literal('BoardColumn'),
      id,
      props: z.strictObject({
        name: z.string(),
        count: z.number().int().nonnegative().optional(),
        note: z.string().optional(),
        focused: z.boolean().optional(),
        empty: z.string().optional(),
        add: z.string().optional(),
      }),
      get children() {
        return z.array(d.node());
      },
    }),
    z.strictObject({
      kind: z.literal('BoardCard'),
      id,
      props: z.strictObject({
        card: z.number().int().positive(),
        prototype: z.boolean().optional(),
        type: z.string(),
        bug: z.boolean().optional(),
        initials: z.string().optional(),
        points: z.string().optional(),
        title: z.string(),
        rail: z
          .strictObject({
            segments: z.array(z.enum(RAIL_SEGMENTS)),
            stage: z.string().optional(),
            glyph: z.enum(GLYPHS),
            word: z.string(),
            state: d.agentState,
            time: z.string().optional(),
            box: z.enum(BOX_MARKS).optional(),
          })
          .optional(),
        note: z
          .strictObject({
            text: z.string(),
            hue: d.hue.optional(),
            box: z.enum(BOX_MARKS).optional(),
          })
          .optional(),
        emphasis: z.enum(EMPHASES).optional(),
        theirs: z.boolean().optional(),
        closed: z.boolean().optional(),
        selection: z.enum(SELECTIONS).optional(),
        local: z.string().min(1).optional(),
        tooltip: z.string().optional(),
        tipAdds: z.boolean().optional(),
      }),
    }),
  ] as const;
};

/** px: a column's least width, the gap between columns. */
export const COLUMN_MIN = 200;
export const COLUMN_GAP = 6;

/**
 * How `count` columns sit in `width` px: an equal share each while that is at least
 * `COLUMN_MIN`, else `COLUMN_MIN` each, scrolled sideways, `fits` of them in view whole.
 */
export type ColumnLayout = { scrolled: false } | { scrolled: true; fits: number };

export const columnLayout = (width: number, count: number): ColumnLayout => {
  if (count === 0) return { scrolled: false };
  const share = (width - COLUMN_GAP * (count - 1)) / count;

  if (share >= COLUMN_MIN) return { scrolled: false };

  return {
    scrolled: true,
    fits: Math.max(1, Math.floor((width + COLUMN_GAP) / (COLUMN_MIN + COLUMN_GAP))),
  };
};

/** The leftmost column shown so that `at` is in view, `first` moved as little as it must. */
export const firstShown = (first: number, at: number, fits: number, count: number): number => {
  const start = Math.min(Math.max(first, at - fits + 1), at);

  return Math.max(0, Math.min(start, count - fits));
};

/**
 * The BoardColumns props for `count` columns in `width` px, the leftmost shown `first`. Scrolled,
 * the columns in view share the width whole (at least `COLUMN_MIN` each), so none is cut at the
 * edge; `view` is that width, for the shell's sideways scrollbar.
 */
export const columnsProps = (
  width: number,
  count: number,
  first: number,
): BoardColumns['props'] => {
  const l = columnLayout(width, count);

  if (!l.scrolled) return {};
  const each = Math.max(COLUMN_MIN, Math.floor((width - COLUMN_GAP * (l.fits - 1)) / l.fits));

  return { scroll: { width: each, offset: first * (each + COLUMN_GAP), view: width } };
};

/**
 * The columns out of view while the Board scrolls sideways, named with their counts at the
 * header's right: `‹ New 2` those to the left, `Closed 0 ›` those to the right.
 */
export const columnsOutOfView = (
  columns: readonly { name: string; count?: number | undefined }[],
  first: number,
  fits: number,
): string | undefined => {
  const named = (c: { name: string; count?: number | undefined }) =>
    c.count === undefined ? c.name : `${c.name} ${c.count}`;
  const left = columns.slice(0, first).map(named);
  const right = columns.slice(first + fits).map(named);
  const words = [
    ...(left.length === 0 ? [] : [`‹ ${left.join(' · ')}`]),
    ...(right.length === 0 ? [] : [`${right.join(' · ')} ›`]),
  ];

  return words.length === 0 ? undefined : words.join(' · ');
};
