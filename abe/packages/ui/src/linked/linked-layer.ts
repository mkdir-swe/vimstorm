/**
 * The Linked popup's node (#109, board W-Linked): its type and schema, apart from its rules
 * (`linked.ts`) so the component set (`components.ts`) reads only this. Drawn by
 * `app/src/factory/linked.rs` in Search Everywhere's look.
 */
import { z } from 'zod';
import { type RailSegment, RAIL_SEGMENTS } from '../board/board';
import type { Hue } from '../runtime/components';

/** One row as drawn: its label, its state as spans (a mark in its hue), dim, the Run row's rail. */
export type LinkedRowView = {
  id: string;
  label: string;
  value: { text: string; hue?: Hue | undefined }[];
  dim?: boolean | undefined;
  rail?: RailSegment[] | undefined;
};

/** The popup's node: drawn by `app/src/factory/linked.rs` in Search Everywhere's look. */
export type LinkedLayerNode = {
  kind: 'LinkedLayer';
  id?: string | undefined;
  props: {
    /** After `Linked · `: `#2 The cart total ignores quantity`. */
    story: string;
    /** Dim at the title's right: `⌃L`. */
    keys: string;
    /** What is typed so far (the rows it leaves); empty: no filter row. */
    filter: string;
    rows: LinkedRowView[];
    selected?: string | undefined;
    /** `loading` until the first read is in, `error` when it failed (`message`). */
    state?: 'loading' | 'error' | undefined;
    message?: string | undefined;
    hint: string;
  };
};

export const LINKED_KINDS = ['LinkedLayer'] as const;

/** The popup's schema, on the set's own primitives (`components.ts` calls this). */
export const linkedSchemas = (d: { nodeId: z.ZodString; hue: z.ZodType<Hue> }) =>
  [
    z.strictObject({
      kind: z.literal('LinkedLayer'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        story: z.string(),
        keys: z.string(),
        filter: z.string(),
        rows: z.array(
          z.strictObject({
            id: d.nodeId,
            label: z.string(),
            value: z.array(z.strictObject({ text: z.string(), hue: d.hue.optional() })),
            dim: z.boolean().optional(),
            rail: z.array(z.enum(RAIL_SEGMENTS)).optional(),
          }),
        ),
        selected: d.nodeId.optional(),
        state: z.enum(['loading', 'error']).optional(),
        message: z.string().optional(),
        hint: z.string(),
      }),
    }),
  ] as const;
