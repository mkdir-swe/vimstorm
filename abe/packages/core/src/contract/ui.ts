/**
 * `abe ui render` and `abe ui bridge` as the command table sees them. Core has no UI (ADR 0015):
 * it knows a screen's tree only as its wire shape, `{ kind, id?, props, children? }`; which kinds
 * exist and what their props are is `ui`'s closed set (`packages/ui/src/runtime/components.ts`). Both
 * commands are answered by the client, never by `serve`.
 */
import { z } from 'zod';

/** The screens `abe ui render` and the bridge open (`ui/src/runtime/screens.ts`' `SCREENS`, by these names). */
export const SCREEN_NAMES = [
  'status',
  'factory',
  'chat',
  'sessions',
  'boxes',
  'pipelines',
  'review',
  'welcome',
  // a card's run in its workspace: the stripe's `run` place
  'run',
  // the story as a page: a workspace's Card page, or the Board's card with no workspace
  'card',
  // a prototype's tile: its Preview, Code and Logs pages (the `page` param)
  'prototype',
] as const;
export type ScreenName = (typeof SCREEN_NAMES)[number];

/**
 * The Settings dialog: a layer over every view, not a screen, but `abe ui render` draws it too
 * (`ui/src/settings/settings.ts`' `SETTINGS_SCREEN`, by this name), on the page its `--page` names.
 */
export const SETTINGS_DIALOG = 'settings';
export type SettingsDialogName = typeof SETTINGS_DIALOG;

export type UiNode = {
  kind: string;
  id?: string | undefined;
  props: Record<string, unknown>;
  children?: UiNode[] | undefined;
};

export const UiNode: z.ZodType<UiNode> = z.object({
  kind: z.string(),
  id: z.string().optional(),
  props: z.record(z.string(), z.unknown()),
  get children() {
    return z.array(UiNode).optional();
  },
});

/** `abe ui render <screen>`: the screen's tree for `serve`'s current state. */
export const UiRenderData = z.object({ screen: z.string(), tree: UiNode });
export type UiRenderData = z.infer<typeof UiRenderData>;

const outline = (node: UiNode, depth: number): string[] => {
  const props = Object.entries(node.props).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  const head = [node.kind, ...(node.id === undefined ? [] : [`#${node.id}`]), ...props].join(' ');

  return [
    `${'  '.repeat(depth)}${head}`,
    ...(node.children ?? []).flatMap((c) => outline(c, depth + 1)),
  ];
};

/** The tree as an indented outline: one node a line, `Kind #id prop=value …`, children under it. */
export const uiRenderText = (data: UiRenderData): string => `${outline(data.tree, 0).join('\n')}\n`;

/** `abe ui bridge` prints no document: its stdout is the bridge's frames. */
export const UiBridgeData = z.null();
