/**
 * Local mode's own components: the band over the Board while local mode is on, and a local pull
 * request (`#L3`) in the Board's place.
 * Rust draws them (`app/src/factory/local.rs`) dashed in the path hue (`--abe-path`) with the
 * house mark; the screen (`local-view.ts`) decides every word.
 *
 * Clicks name: a band link's `id` (`local:held`, `local:settings`); a local pull request's
 * buttons `local-pr:merge` and `local-pr:discard`, its `Diff` `local-pr:diff`, a file row
 * `local-pr:file:<n>` (1-based).
 */
import { z } from 'zod';
import type { Hue } from '../runtime/runtime';

/**
 * The band over the Board: `Local mode` bold, then what it means, its links at the
 * right (`7 held writes`, `Settings`). One line, 30 high, dashed in the path hue.
 */
export type LocalBand = {
  kind: 'LocalBand';
  id?: string | undefined;
  props: {
    /** Bold first: `Local mode`. */
    lead: string;
    /** After it: `the board, issues and CI are read from GitHub; writes stay on this Mac, …`. */
    text: string;
    /** Links at the right, a click names the `id`. */
    links: { id: string; label: string }[];
  };
};

/** One check of a local pull request (`✓ tests`), its glyph in its hue. */
export type LocalCheck = { name: string; glyph: string; hue: Hue };

/** One changed file of a local pull request: `M +24 −3 src/x.ts`. */
export type LocalFile = {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  added: number;
  removed: number;
};

/** One commit of a local pull request: its short sha (7) and subject. */
export type LocalCommit = { sha: string; subject: string };

/**
 * A local pull request: its head (`Pull request #L3`, `local · card/… → main · not
 * pushed`), its title, what it is, the checks run here, its body, and Merge locally · Discard
 * while open (`focus` the button the keys are on); once merged or discarded `done` says so in
 * their place. `note` dim at the right of the buttons: where it would have opened.
 */
export type LocalPullRequest = {
  kind: 'LocalPullRequest';
  id?: string | undefined;
  props: {
    /** `#L3`. */
    name: string;
    /** Dim after it: `local · card/1240-checkout-copy → main · not pushed`. */
    line: string;
    title: string;
    /** Dim under the title: what a local pull request is. */
    about: string;
    /** `Checks, run here`; none: no checks were run. */
    checks?: LocalCheck[] | undefined;
    /** `Files`: one row each, a click `local-pr:file:<n>` (1-based). */
    files?: LocalFile[] | undefined;
    /** A `Diff` button at the right of the Files caption, click `local-pr:diff`. */
    diff?: boolean | undefined;
    /** `Commits`: sha (shortened here, 7) and subject. */
    commits?: LocalCommit[] | undefined;
    /** Its body as written, kept as is (white space too). */
    body: string;
    /** Open: the two buttons, and the one the keys are on. */
    actions?: { focus: 'merge' | 'discard' } | undefined;
    /** Merged or discarded: in the buttons' place (`✓ Merged into main · 3f2a1b9`), in its hue. */
    done?: { text: string; hue: Hue } | undefined;
    /** Dim at the right: `would open on github.com/mkdir-swe/demo-shop`. */
    note?: string | undefined;
    /** The keys are elsewhere (the Chat column has them): the focused button drawn grey. */
    away?: boolean | undefined;
  };
};

export type LocalNode = LocalBand | LocalPullRequest;

export const LOCAL_KINDS = ['LocalBand', 'LocalPullRequest'] as const;

/** The two schemas, on the set's own primitives (`components.ts` calls this). */
export const localSchemas = (d: { nodeId: z.ZodString; hue: z.ZodType<Hue> }) => {
  const id = d.nodeId.optional();

  return [
    z.strictObject({
      kind: z.literal('LocalBand'),
      id,
      props: z.strictObject({
        lead: z.string().min(1),
        text: z.string(),
        links: z.array(z.strictObject({ id: d.nodeId, label: z.string().min(1) })),
      }),
    }),
    z.strictObject({
      kind: z.literal('LocalPullRequest'),
      id,
      props: z.strictObject({
        name: z.string().min(1),
        line: z.string(),
        title: z.string(),
        about: z.string(),
        checks: z
          .array(z.strictObject({ name: z.string().min(1), glyph: z.string().min(1), hue: d.hue }))
          .optional(),
        files: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              status: z.enum(['A', 'M', 'D', 'R']),
              added: z.number().int().nonnegative(),
              removed: z.number().int().nonnegative(),
            }),
          )
          .optional(),
        diff: z.boolean().optional(),
        commits: z
          .array(z.strictObject({ sha: z.string().min(1), subject: z.string() }))
          .optional(),
        body: z.string(),
        actions: z.strictObject({ focus: z.enum(['merge', 'discard']) }).optional(),
        done: z.strictObject({ text: z.string().min(1), hue: d.hue }).optional(),
        note: z.string().optional(),
        away: z.boolean().optional(),
      }),
    }),
  ] as const;
};
