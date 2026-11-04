/**
 * The layers of the component set (DS 2.0 `components/{PickLayer,PromptLayer,ConfirmLayer}`): a
 * popup over whatever view is shown, the Editor too. The bridge sends the top layer as its own
 * `layer` frame (`protocol.ts`), never inside a screen's tree; Rust draws it 480 px wide, centred
 * near the top, and every key goes to the layer while one is up.
 *
 * Keys are the screen's (`command.ts`): Rust only draws and forwards. A click on a pick's row
 * names the row's `id`; on a confirm's buttons `risky` or `no`.
 */
import { z } from 'zod';
import type { Hue } from './components';

const Id = z.string().min(1);

/** `components.ts`' Hue, its schema here: `components.ts` imports this module's schemas. */
const LinkHue: z.ZodType<Hue> = z.enum(['good', 'warn', 'needs-you', 'bad', 'accent', 'dim']);

/** One row of a pick: its label, dim detail, right note; a `reason` greys it out (why). */
export type PickRow = {
  id: string;
  text: string;
  dim?: string | undefined;
  note?: string | undefined;
  reason?: string | undefined;
  /** A separator line above the row. */
  separator?: boolean | undefined;
  /** Its title and key in bad (`--abe-bad`): the row deletes something (Terminate…). */
  risky?: boolean | undefined;
  /**
   * A group's dim heading drawn above the row (Command mode's `#1234 Cart total…`, `Board`,
   * `Anywhere`, `More`, #346), a separator line above it unless it is the first row.
   */
  section?: string | undefined;
  /** Dim, monospace, before the text in a column of its own (Held writes' `09:41`, #24). */
  lead?: string | undefined;
};
export type PickLayer = {
  kind: 'PickLayer';
  id?: string | undefined;
  props: {
    title: string;
    /** The filter row with what is typed so far; absent: no filter row. */
    filter?: string | undefined;
    /** The filter's dim words while nothing is typed (`Ask anything, or a command`, #346). */
    placeholder?: string | undefined;
    /** The filter's caret in characters (`field.ts`, #314); absent: at its end. */
    caret?: number | undefined;
    /** The rows shown (a window of them: the screen scrolls). */
    rows: PickRow[];
    /** The row the cursor is on. */
    selected?: string | undefined;
    /**
     * More rows than shown (#261): the first shown's index and how many there are. The popup
     * draws a scrollbar beside the rows, as a WebStorm list popup does; absent when all fit.
     */
    scroll?: { top: number; total: number } | undefined;
    /** `loading` (Loading…) or `error` (`✗ message`) in place of the rows. */
    state?: 'loading' | 'error' | undefined;
    message?: string | undefined;
    /** The ad text: only a key this pick adds. */
    hint?: string | undefined;
    /** Dim after the title (`demo-shop · nothing left this Mac`, #24). */
    caption?: string | undefined;
    /** 820 px wide, not 480: a list whose rows say a lot (Held writes, #24). */
    wide?: boolean | undefined;
    /** The house mark before the title, in the path hue (local mode, #24). */
    local?: boolean | undefined;
  };
};
export type PromptLayer = {
  kind: 'PromptLayer';
  id?: string | undefined;
  props: {
    title: string;
    /** The field's text. */
    text: string;
    /** Its caret in characters (`field.ts`, #314); absent: at its end. */
    caret?: number | undefined;
    hint?: string | undefined;
    /** Why ⏎ did not take the text: drawn as `✗ error` in the ad text. */
    error?: string | undefined;
  };
};
export type ConfirmLayer = {
  kind: 'ConfirmLayer';
  id?: string | undefined;
  props: {
    question: string;
    /** Dim lines under the question. */
    details?: string[] | undefined;
    /** The risky answer: a quiet button with its letter, first. */
    risky: { label: string; letter: string };
    /** The safe answer, the default (⏎), last: `No` when absent. */
    no?: string | undefined;
    /** Red: a production deploy, a destructive delete. */
    danger?: boolean | undefined;
    /** The button in focus; `no` when absent. */
    focus?: 'risky' | 'no' | undefined;
  };
};

export const PickRowSchema = z.strictObject({
  id: Id,
  text: z.string(),
  dim: z.string().optional(),
  note: z.string().optional(),
  reason: z.string().optional(),
  separator: z.boolean().optional(),
  risky: z.boolean().optional(),
  section: z.string().optional(),
  lead: z.string().optional(),
});

export const PickLayerSchema = z.strictObject({
  kind: z.literal('PickLayer'),
  id: Id.optional(),
  props: z.strictObject({
    title: z.string(),
    filter: z.string().optional(),
    placeholder: z.string().optional(),
    caret: z.number().int().min(0).optional(),
    rows: z.array(PickRowSchema),
    selected: Id.optional(),
    scroll: z
      .strictObject({ top: z.number().int().min(0), total: z.number().int().min(1) })
      .optional(),
    state: z.enum(['loading', 'error']).optional(),
    message: z.string().optional(),
    hint: z.string().optional(),
    caption: z.string().optional(),
    wide: z.boolean().optional(),
    local: z.boolean().optional(),
  }),
});

export const PromptLayerSchema = z.strictObject({
  kind: z.literal('PromptLayer'),
  id: Id.optional(),
  props: z.strictObject({
    title: z.string(),
    text: z.string(),
    caret: z.number().int().min(0).optional(),
    hint: z.string().optional(),
    error: z.string().optional(),
  }),
});

export const ConfirmLayerSchema = z.strictObject({
  kind: z.literal('ConfirmLayer'),
  id: Id.optional(),
  props: z.strictObject({
    question: z.string(),
    details: z.array(z.string()).optional(),
    risky: z.strictObject({ label: z.string().min(1), letter: z.string().length(1) }),
    no: z.string().optional(),
    danger: z.boolean().optional(),
    focus: z.enum(['risky', 'no']).optional(),
  }),
});

/** A footer button of a dialog: its key at 70 % after the label; a `reason` greys it (why). */
export type DialogButton = {
  id: string;
  label: string;
  keys?: string | undefined;
  primary?: boolean | undefined;
  reason?: string | undefined;
};

/**
 * The card dialog (DS 2.0 StoryTab, App Map D14): the card read first, centred over the view in
 * the card-dialog look, 840 × 700 at most. The kicker (its type) · `#id` and its state badge, the
 * title and one meta line, then its sections as markdown (VimStorm's renderer), scrolled
 * `scroll` lines; the footer's buttons right-aligned, the primary last.
 */
export type CardDialog = {
  kind: 'CardDialog';
  id?: string | undefined;
  props: {
    kicker: string;
    /** 0: no card yet (Make card's draft of a new one): no `#id` drawn. */
    card: number;
    state: string;
    title: string;
    /** The meta line's words, in order: the assignee, the tags. */
    meta: string[];
    /**
     * The story look's facts line word by word, each in its colour (F-Story, #294): the type rose
     * for a Bug (else the story's), the points blue, the tags gold after a dim `label`; the rest
     * dim. Drawn in place of `meta` when given.
     */
    facts?: DialogFact[] | undefined;
    /** Each section's heading (a dim note after it) and its markdown; `''` reads `(empty)`. */
    sections: { title: string; note?: string | undefined; markdown: string }[];
    /** Lines scrolled down (`l ö`); the shell keeps it within the page. */
    scroll: number;
    buttons: DialogButton[];
    /**
     * The card's Sheets (#79), beside the sections: one row each (`sheet:<card>/<id>`), `loading`
     * or `error` while `abe card show` has not answered them. `focused`: the keys are in its rows
     * (Tab), `selected` the row they are on.
     */
    sheets?: DialogSheets | undefined;
    /**
     * The story look (2.1 #107 S3, board F-Story): a dim cap (`Story · demo-shop`) and a close
     * button over `#id` and the title, `meta` as the facts line under it; no kicker or state badge.
     */
    heading?: string | undefined;
    /**
     * The Linked block at the dialog's end (`Linked` and a chip per row: Run · Session · PR · Box),
     * each `label words`, the words in `hue`; a `dim` chip is not there yet and takes no click. A
     * click on one names its `id`.
     */
    linked?: DialogLink[] | undefined;
    /** Dim words before the footer's buttons (`⌘⏎ more`); a click on them is `dialog:menu`. */
    hint?: string | undefined;
    /** Why the last write was refused (New card's, #346): red on its own line over the footer. */
    error?: string | undefined;
    /**
     * The story look's Comments after the sections (#238): the card's thread oldest first, each
     * `by · when` over its markdown (VimStorm's renderer); being read, or unreadable (`message`).
     */
    comments?: CommentThread | undefined;
    /** The button the keys are on (← → Tab), drawn as the default; absent: the primary. */
    focus?: string | undefined;
  };
};

/**
 * The comment composer on the Card page: the draft and its caret (`field.ts`; absent: at the end),
 * the placeholder while empty, whether the keys are in it, and how the post goes (`posting`:
 * Sending…, `failed`: the draft kept and `error` said).
 */
export type PageComposer = {
  text: string;
  caret?: number | undefined;
  placeholder: string;
  focused: boolean;
  state: 'writing' | 'posting' | 'failed';
  error?: string | undefined;
};

/**
 * The Card page (`card` screen): the story as a page in the main slot, never a layer. The card
 * dialog's look filling its slot, with no backdrop and no close button, the comment composer
 * over its footer, the footer's buttons the card's actions.
 */
export type CardPage = {
  kind: 'CardPage';
  id?: string | undefined;
  props: CardDialog['props'] & { composer: PageComposer };
};

/** A fact's colour on the story's facts line (`--abe-bug`, `--abe-story`, `--abe-points`, `--abe-tags`). */
export const FACT_TONES = ['bug', 'story', 'points', 'tags'] as const;

/** One word of the story's facts line: dim with no `tone`, a dim `label` before it (`tags`). */
export type DialogFact = {
  text: string;
  tone?: (typeof FACT_TONES)[number] | undefined;
  label?: string | undefined;
};

/** One chip of the dialog's Linked block. */
export type DialogLink = {
  id: string;
  label: string;
  words: string;
  state?: string | undefined;
  hue?: Hue | undefined;
  dim?: boolean | undefined;
};

/** The card dialog's Sheets section. */
export type DialogSheets = {
  rows: { id: string; title: string; dim?: string | undefined }[];
  state?: 'loading' | 'error' | undefined;
  message?: string | undefined;
  selected?: string | undefined;
  focused?: boolean | undefined;
};

/** A card's comments in a tree: the story dialog's and the CommentBox's thread. */
const CommentThreadSchema = z.strictObject({
  state: z.enum(['loading', 'error', 'ready']),
  message: z.string().optional(),
  comments: z.array(z.strictObject({ by: z.string(), when: z.string(), markdown: z.string() })),
});

const CardDialogProps = z.strictObject({
  kicker: z.string(),
  /** 0: no card yet (Make card's draft of a new one): no `#id` drawn. */
  card: z.number().int().nonnegative(),
  state: z.string(),
  title: z.string(),
  meta: z.array(z.string()),
  facts: z
    .array(
      z.strictObject({
        text: z.string(),
        tone: z.enum(FACT_TONES).optional(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  sections: z.array(
    z.strictObject({ title: z.string(), note: z.string().optional(), markdown: z.string() }),
  ),
  scroll: z.number().int().nonnegative(),
  buttons: z.array(
    z.strictObject({
      id: Id,
      label: z.string().min(1),
      keys: z.string().optional(),
      primary: z.boolean().optional(),
      reason: z.string().optional(),
    }),
  ),
  sheets: z
    .strictObject({
      rows: z.array(z.strictObject({ id: Id, title: z.string(), dim: z.string().optional() })),
      state: z.enum(['loading', 'error']).optional(),
      message: z.string().optional(),
      selected: Id.optional(),
      focused: z.boolean().optional(),
    })
    .optional(),
  heading: z.string().optional(),
  linked: z
    .array(
      z.strictObject({
        id: Id,
        label: z.string().min(1),
        words: z.string(),
        state: z.string().optional(),
        hue: LinkHue.optional(),
        dim: z.boolean().optional(),
      }),
    )
    .optional(),
  hint: z.string().optional(),
  error: z.string().optional(),
  comments: CommentThreadSchema.optional(),
  focus: Id.optional(),
});

export const CardDialogSchema = z.strictObject({
  kind: z.literal('CardDialog'),
  id: Id.optional(),
  props: CardDialogProps,
});

export const CardPageSchema = z.strictObject({
  kind: z.literal('CardPage'),
  id: Id.optional(),
  props: CardDialogProps.extend({
    composer: z.strictObject({
      text: z.string(),
      caret: z.number().int().min(0).optional(),
      placeholder: z.string(),
      focused: z.boolean(),
      state: z.enum(['writing', 'posting', 'failed']),
      error: z.string().optional(),
    }),
  }),
});

/**
 * One comment of a thread: who, when, its text. In the story dialog its markdown; in a
 * CommentBox its lines as the box draws them (`threadLines`: quote marks and blank lines dropped).
 */
export type ThreadComment = { by: string; when: string; markdown: string };

/** A card's comments: being read, unreadable (`message`), or read. */
export type CommentThread = {
  state: 'loading' | 'error' | 'ready';
  message?: string | undefined;
  comments: ThreadComment[];
};

/**
 * The CommentBox (DS 2.0 `components/CommentBox`, ticket #77): a card's thread, oldest first, the
 * destination, the draft with its caret, Send. 640 px, near the top of the view. A
 * click names `comment:send`.
 */
export type CommentBox = {
  kind: 'CommentBox';
  id?: string | undefined;
  props: {
    /** `Comment on #8 Address picker remembers the last one`. */
    title: string;
    /** The thread: being read, unreadable (`message`), or its comments. */
    thread: CommentThread;
    /** Where it posts: `demo-org · Sandbox · #8 · Azure Boards`. */
    destination: string;
    /** The text so far (lines by `\n`); empty: the placeholder after the caret. */
    draft: string;
    /** The draft's caret in characters (`field.ts`, #314); absent: at its end. */
    caret?: number | undefined;
    placeholder?: string | undefined;
    /** Writing, Sending…, or failed: the draft kept and `error` said. */
    state: 'writing' | 'posting' | 'failed';
    error?: string | undefined;
    /** The ad text: only this box's keys. */
    hint?: string | undefined;
  };
};

export const CommentBoxSchema = z.strictObject({
  kind: z.literal('CommentBox'),
  id: Id.optional(),
  props: z.strictObject({
    title: z.string(),
    thread: CommentThreadSchema,
    destination: z.string(),
    draft: z.string(),
    caret: z.number().int().min(0).optional(),
    placeholder: z.string().optional(),
    state: z.enum(['writing', 'posting', 'failed']),
    error: z.string().optional(),
    hint: z.string().optional(),
  }),
});

/** One of the Launch box's places to run: `Local · its card worktree`, `A box · your environment`. */
export type LaunchPick = { id: string; label: string };

/** A row of the Launch box's workflows: a source's head, or one workflow. */
export type LaunchWorkflowRow =
  | { kind: 'head'; text: string }
  | {
      kind: 'item';
      id: string;
      name: string;
      desc: string;
      /** Its `on:` in words: `type Bug`, `tags docs`, `default`. */
      on: string;
      /** Its `on:` takes this card. */
      takes: boolean;
      picked: boolean;
    };

/** One environment agents reach: `✓ dev`, `○ prod off`, `● prod on · this session`. */
export type LaunchReach = { env: string; label: string; on: boolean; click?: string | undefined };

/**
 * The Launch box (#342, #347): a launch set up before it starts, its Launch note typed (lines by
 * ⇧⏎), the standing notes and reference going along dim, its workflow and where it runs. 640 px,
 * near the top of the view, as the CommentBox. A click names `launch:go`, a workflow's
 * `launch:workflow:<id>`, a place's `launch:runs:<id>` or `launch:prod`.
 */
export type LaunchBox = {
  kind: 'LaunchBox';
  id?: string | undefined;
  props: {
    /** `Launch #102 Show VAT under the cart total`. */
    title: string;
    /** The field's label: `Notes for the agent (optional)`. */
    label: string;
    /** The note so far (lines by `\n`); empty: the placeholder after the caret. */
    draft: string;
    /** The draft's caret in characters (`field.ts`); absent: at its end. */
    caret?: number | undefined;
    placeholder?: string | undefined;
    /** What goes along, dim: `+ standing · write the test first · yours`. */
    along: string[];
    /** `Cloud · demo-shop`, `Local sandbox`: where `serve.target` says. */
    where: string;
    /**
     * The card workflows, grouped Repo's, Yours, Abe's (heads), the picked one marked, each its
     * `on:` and whether it takes the card; `note` the preselection's why (or that they are being
     * read), `warn` when the one picked does not take the card (it still runs it).
     */
    workflows: {
      rows: LaunchWorkflowRow[];
      note: string;
      warn?: string | undefined;
    };
    /** Where it runs: local or a box, and the one picked. */
    runs: LaunchPick[];
    ran: string;
    /** The environments agents reach (ADR 0029); `click` on the one the person may turn on here. */
    reach: LaunchReach[];
    /** Prod turned on for this session alone: the warning beside it. */
    prodWarn?: string | undefined;
    /** `1612 / 2000`, from 1500 characters on; `over` once past the most: ⏎ launches nothing. */
    count?: string | undefined;
    over?: boolean | undefined;
    /** The ad text: only this box's keys. */
    hint?: string | undefined;
  };
};

export const LaunchBoxSchema = z.strictObject({
  kind: z.literal('LaunchBox'),
  id: Id.optional(),
  props: z.strictObject({
    title: z.string(),
    label: z.string(),
    draft: z.string(),
    caret: z.number().int().min(0).optional(),
    placeholder: z.string().optional(),
    along: z.array(z.string()),
    where: z.string(),
    workflows: z.strictObject({
      rows: z.array(
        z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('head'), text: z.string().min(1) }),
          z.strictObject({
            kind: z.literal('item'),
            id: z.string().min(1),
            name: z.string().min(1),
            desc: z.string(),
            on: z.string(),
            takes: z.boolean(),
            picked: z.boolean(),
          }),
        ]),
      ),
      note: z.string(),
      warn: z.string().optional(),
    }),
    runs: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) })),
    ran: z.string(),
    reach: z.array(
      z.strictObject({
        env: z.string().min(1),
        label: z.string().min(1),
        on: z.boolean(),
        click: z.string().optional(),
      }),
    ),
    prodWarn: z.string().optional(),
    count: z.string().optional(),
    over: z.boolean().optional(),
    hint: z.string().optional(),
  }),
});

/** The story dialog's ⇧⏎ on its primary (#347): handed back as this row; Launch agent opens the Launch box. */
export const PRIMARY_BOX = 'primary-box';
