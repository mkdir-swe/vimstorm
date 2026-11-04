/**
 * What the PR review's surfaces ask of the `review` slot's screen (the app's `review` input): the
 * diff's `,i` keys (`config/app/review.lua`, through the Git tool window), the Submit review
 * dialog, the strip's buttons, the files pane's clicks and menu, the Log's selection and PR pick.
 */
import { z } from 'zod';

const Side = z.enum(['LEFT', 'RIGHT']);

export const ReviewAsk = z.discriminatedUnion('kind', [
  /**
   * `,ic` (`now`: `,ip` / ⌘⏎, posted at once): a comment on a line (or the lines from `start`) of
   * the diff of `base`..`head`; `replaces` an outdated draft it rewrites, deleted once it is kept.
   */
  z.strictObject({
    kind: z.literal('comment'),
    path: z.string(),
    side: Side,
    line: z.number().int().positive(),
    start: z.number().int().positive().optional(),
    body: z.string(),
    base: z.string(),
    head: z.string(),
    now: z.boolean().optional(),
    replaces: z.number().int().optional(),
  }),
  z.strictObject({ kind: z.literal('reply'), thread: z.string(), body: z.string() }),
  z.strictObject({ kind: z.literal('resolve'), thread: z.string(), resolved: z.boolean() }),
  /** A draft card's Edit draft: its text replaced, its line kept. */
  z.strictObject({ kind: z.literal('edit'), seq: z.number().int(), body: z.string() }),
  /** A draft card's Delete… (after its confirm). */
  z.strictObject({ kind: z.literal('delete'), seq: z.number().int() }),
  /** The Submit review dialog's Submit (`,ia` / `,ir` / `,is` open it): the review, its body. */
  z.strictObject({
    kind: z.literal('verdict'),
    verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
    body: z.string(),
  }),
  /** `,in`: the next file by heat not reviewed. */
  z.strictObject({ kind: z.literal('next') }),
  /** A click on the files pane's line (0-based); `open`: a double click, ⏎ on it too. */
  z.strictObject({
    kind: z.literal('at'),
    line: z.number().int().nonnegative(),
    open: z.boolean().optional(),
  }),
  /** The Log's selection: no commit is all changes, one that commit, more the range they span. */
  z.strictObject({ kind: z.literal('scope'), commits: z.array(z.string()) }),
  /** The diff's scope switch: the scope, then `path`'s first change in it. */
  z.strictObject({ kind: z.literal('rescope'), commits: z.array(z.string()), path: z.string() }),
  /** The strip's ‹ ›: the commit before or after the scope's, round through all changes. */
  z.strictObject({ kind: z.literal('step'), dir: z.union([z.literal(1), z.literal(-1)]) }),
  /** The files pane's order switch: By heat, else By folder. */
  z.strictObject({ kind: z.literal('order'), heat: z.boolean() }),
  /** The diff's Reviewed tick: `path` marked (or back to review). */
  z.strictObject({ kind: z.literal('mark'), path: z.string() }),
  /** A row of the files pane's right-click menu, by what it runs. */
  z.strictObject({ kind: z.literal('menu'), run: z.string() }),
  /** The conversation's Comment: a comment on the PR, not on a line, not in a review. */
  z.strictObject({ kind: z.literal('say'), body: z.string() }),
  /** A lifecycle row of the Log's PR menu (Mark ready, Merge…, Close…). */
  z.strictObject({ kind: z.literal('lifecycle'), id: z.string() }),
  /** The PR pick's row: check PR `number` out and review it. */
  z.strictObject({ kind: z.literal('pick'), number: z.number().int().positive() }),
]);
export type ReviewAsk = z.infer<typeof ReviewAsk>;

/** A row of the Git Log's PR pick: a caption (Mine, Others) or a PR with its note at the right. */
export const PrPickRow = z.union([
  z.strictObject({ caption: z.string() }),
  z.strictObject({
    number: z.number().int().positive(),
    label: z.string(),
    /** Right: Draft / Open, or Review requested. */
    note: z.string(),
  }),
]);
export type PrPickRow = z.infer<typeof PrPickRow>;
