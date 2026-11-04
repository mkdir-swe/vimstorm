/**
 * A prototype's tile's page (Design B · Tiles): one component, `PrototypePage`, for its three
 * pages. Rust draws it (`app/src/factory/prototype.rs`); the screen (`prototype.ts`) decides
 * every word, hue and place.
 *
 * - **Preview** (⌃1): the URL bar (host and path, reload, ↗ open in the browser, the viewports
 *   Fit · 1280 · 768 · 390, Make card) over the body: the live app (its BrowserView, in `app`
 *   mode, the node's one child, laid out `width` px wide and centred, a device frame at the phone
 *   width), or Starting the app… with its steps, the failed start's last lines and what to do, or
 *   a stopped one's last screenshot dimmed under its words and buttons.
 * - **Code** (⌃2): the diff by file, the selected file's lines, its screenshots.
 * - **Logs** (⌃3): the app's output, then the hosts its proxy refused.
 *
 * Clicks name: `proto:make-card`, `proto:open`, `proto:reload`, `proto:restart`, `proto:stop`,
 * `proto:discard`, `proto:start`, `proto:fix`, a viewport's `proto:viewport:<fit|1280|768|390>`,
 * a file's `proto:file:<n>`, a screenshot's `proto:shot:<n>`.
 */
import { z } from 'zod';
import type { Hue } from '../runtime/components';
import { type BrowserView, browserSchemas } from '../runtime/browser';

export const PROTOTYPE_KINDS = ['PrototypePage'] as const;

export const VIEWPORTS = ['fit', '1280', '768', '390'] as const;
export type Viewport = (typeof VIEWPORTS)[number];

export type ProtoAction = {
  id: string;
  label: string;
  keys: string;
  primary?: boolean | undefined;
};

export type ProtoBody =
  | {
      kind: 'live';
      /** px; null: Fit (the whole middle). */
      width: number | null;
      /** The phone width: a device frame around it. */
      phone: boolean;
      /** The page has the keys (`keys in the app · Esc gives them back`). */
      keys: boolean;
    }
  | {
      kind: 'starting';
      title: string;
      steps: { mark: string; hue: Hue; text: string }[];
      note: string;
    }
  | { kind: 'failed'; title: string; lines: string[]; hint: string; actions: ProtoAction[] }
  | {
      kind: 'stopped';
      title: string;
      /** Its last screenshot (absolute); '' none. */
      shot: string;
      line: string;
      actions: ProtoAction[];
    }
  | {
      kind: 'code';
      files: { id: string; path: string; added: number; removed: number; selected: boolean }[];
      /** The selected file's lines: ` ` `-` `+` or `@@` first. */
      lines: string[];
      shots: { id: string; path: string; what: string }[];
      note: string;
    }
  | { kind: 'logs'; log: string[]; refused: string[]; note: string };

export type PrototypePage = {
  kind: 'PrototypePage';
  id?: string | undefined;
  props: {
    page: 'preview' | 'code' | 'logs';
    /** The Preview's URL bar. */
    bar?:
      | {
          host: string;
          path: string;
          viewports: { id: string; label: string; on: boolean }[];
          reload: string;
          open: string;
          actions: ProtoAction[];
        }
      | undefined;
    body: ProtoBody;
  };
  /** The live app's BrowserView (body `live` only). */
  children?: BrowserView[] | undefined;
};

export type PrototypeNode = PrototypePage;

/** The schema, on the set's own primitives (`components.ts` calls this). */
export const prototypeSchemas = (d: { nodeId: z.ZodString; hue: z.ZodType<Hue> }) => {
  const action = z.strictObject({
    id: d.nodeId,
    label: z.string().min(1),
    keys: z.string(),
    primary: z.boolean().optional(),
  });
  const [browser] = browserSchemas(d);

  return [
    z.strictObject({
      kind: z.literal('PrototypePage'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        page: z.enum(['preview', 'code', 'logs']),
        bar: z
          .strictObject({
            host: z.string(),
            path: z.string(),
            viewports: z.array(
              z.strictObject({ id: d.nodeId, label: z.string().min(1), on: z.boolean() }),
            ),
            reload: d.nodeId,
            open: d.nodeId,
            actions: z.array(action),
          })
          .optional(),
        body: z.discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('live'),
            width: z.number().int().positive().nullable(),
            phone: z.boolean(),
            keys: z.boolean(),
          }),
          z.strictObject({
            kind: z.literal('starting'),
            title: z.string(),
            steps: z.array(z.strictObject({ mark: z.string(), hue: d.hue, text: z.string() })),
            note: z.string(),
          }),
          z.strictObject({
            kind: z.literal('failed'),
            title: z.string(),
            lines: z.array(z.string()),
            hint: z.string(),
            actions: z.array(action),
          }),
          z.strictObject({
            kind: z.literal('stopped'),
            title: z.string(),
            shot: z.string(),
            line: z.string(),
            actions: z.array(action),
          }),
          z.strictObject({
            kind: z.literal('code'),
            files: z.array(
              z.strictObject({
                id: d.nodeId,
                path: z.string(),
                added: z.number().int().nonnegative(),
                removed: z.number().int().nonnegative(),
                selected: z.boolean(),
              }),
            ),
            lines: z.array(z.string()),
            shots: z.array(z.strictObject({ id: d.nodeId, path: z.string(), what: z.string() })),
            note: z.string(),
          }),
          z.strictObject({
            kind: z.literal('logs'),
            log: z.array(z.string()),
            refused: z.array(z.string()),
            note: z.string(),
          }),
        ]),
      }),
      children: z.array(browser).max(1).optional(),
    }),
  ] as const;
};
