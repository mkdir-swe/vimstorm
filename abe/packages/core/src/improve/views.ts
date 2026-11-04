/**
 * View tweaks (spec #36 I2, ticket #85): your personal Layer's `views` hide, reorder or relabel
 * parts of a screen by node id, built only from the components already there. The rules are here:
 * a tweak's shape and the node ids each screen holds, which a write is checked against (an
 * unknown one is refused, `unknown-node`); `ui` applies them to every tree it draws.
 */
import { z } from 'zod';

/** One part of a screen a tweak may name: its node id (or a pattern of them) and what it is. */
export type ViewNode = {
  /** The node's id in the screen's tree; `<…>` marks a part filled in (`col:<state>`). */
  id: string;
  what: string;
  /** Whether it has words of its own to relabel (a column's name, a header's title, a row's text). */
  label: boolean;
  /** Where it shows when not on the overview itself: a Sheet. */
  part?: 'sheet';
  /** It may be moved to the stripe's top or bottom group (`group`, #20): a stripe item. */
  group?: true;
};

/** Each screen's parts a tweak may name, by screen (`ui/src/runtime/screens.ts`' names). */
export const VIEW_NODES: Readonly<Record<string, readonly ViewNode[]>> = {
  factory: [
    { id: 'board', what: 'the Board (its columns and cards)', label: false },
    { id: 'board-head', what: 'the Board’s header', label: true },
    { id: 'col:<state>', what: 'a Board column, by its state (`col:Active`)', label: true },
    { id: 'sheet-view', what: 'a Sheet’s page', label: false, part: 'sheet' },
    // the stripe's items (#20, `ui/src/shell/stripe.ts`): hidden, or moved to the other group
    {
      id: 'stripe:<item>',
      what: 'a tool window on the stripe, by its id (`stripe:git`), hidden or moved to the top or bottom group',
      label: false,
      group: true,
    },
  ],
  // the Chat slot's (#119)
  chat: [
    { id: 'chat', what: 'Chat, at the right', label: false },
    { id: 'chat-header', what: 'Chat’s header', label: false },
    { id: 'chat-terminal', what: 'Chat’s terminal', label: false },
  ],
  // the bottom pane's tabs (#119): their parts not named yet
  sessions: [],
  boxes: [],
  pipelines: [],
  // the Git Log's PR review (the review slot): the Git tool window draws its pane
  review: [],
  // Welcome (#212, no project open): its parts not named yet
  welcome: [],
  // a card's run (3.0 #21): its parts not named yet
  run: [],
  // the Card page: its parts not named yet
  card: [],
  // a prototype's tile's pages: its parts not named yet
  prototype: [],
  // the Skills place (#15): its parts not named yet
  status: [
    { id: 'serve', what: 'abe serve’s facts', label: false },
    { id: 'sessions', what: 'the sessions list', label: false },
    { id: 'reload', what: 'the reload key', label: true },
  ],
};

/**
 * A tweak: on `screen`, the node `node` hidden, moved to place `order` among its siblings,
 * relabelled, or (a stripe item, #20) moved to the stripe's `top` or `bottom` group.
 */
export const ViewTweak = z
  .strictObject({
    screen: z.string().min(1),
    node: z.string().min(1),
    hide: z.literal(true).optional(),
    order: z.number().int().nonnegative().optional(),
    label: z.string().trim().min(1).optional(),
    group: z.enum(['top', 'bottom']).optional(),
  })
  .refine(
    (t) => [t.hide, t.order, t.label, t.group].filter((x) => x !== undefined).length === 1,
    'a tweak does one of hide: true, order: <place>, label: <words> or group: top | bottom',
  );
export type ViewTweak = z.infer<typeof ViewTweak>;

/** The `views` setting: your tweaks, applied in order. */
export const ViewTweaks = z.array(ViewTweak);

const PART = /<[^>]+>/;

/** Whether a node id is the catalog entry's: itself, or its pattern with the part filled in. */
const isOf = (entry: ViewNode, node: string): boolean => {
  const at = PART.exec(entry.id);

  if (at === null) return entry.id === node;
  const head = entry.id.slice(0, at.index);
  const tail = entry.id.slice(at.index + at[0].length);

  return node.length > head.length + tail.length && node.startsWith(head) && node.endsWith(tail);
};

/** The catalog's entry for a screen's node, if it names one. */
export const viewNodeOf = (screen: string, node: string): ViewNode | undefined =>
  (Object.hasOwn(VIEW_NODES, screen) ? VIEW_NODES[screen] : undefined)?.find((e) => isOf(e, node));

/** What is wrong with the tweaks: a screen or node id none has (`unknown-node`), a label on wordless parts. */
export type ViewProblem = { code: 'unknown-node' | 'invalid-setting'; message: string };

export const viewProblems = (tweaks: readonly ViewTweak[]): ViewProblem[] =>
  tweaks.flatMap((t): ViewProblem[] => {
    if (!Object.hasOwn(VIEW_NODES, t.screen))
      return [
        {
          code: 'unknown-node' as const,
          message: `views: no screen ${t.screen}; the screens are ${Object.keys(VIEW_NODES).join(', ')}`,
        },
      ];
    const entry = viewNodeOf(t.screen, t.node);

    if (entry === undefined)
      return [
        {
          code: 'unknown-node' as const,
          message: `views: ${t.screen} has no node ${t.node}; its nodes are ${(VIEW_NODES[t.screen] ?? []).map((e) => e.id).join(', ')}`,
        },
      ];

    if (t.group !== undefined && entry.group !== true)
      return [
        {
          code: 'invalid-setting' as const,
          message: `views: ${t.screen} ${t.node} is no stripe item to move to a group`,
        },
      ];

    return t.label !== undefined && !entry.label
      ? [
          {
            code: 'invalid-setting' as const,
            message: `views: ${t.screen} ${t.node} has no words of its own to relabel; hide or order it`,
          },
        ]
      : [];
  });

/** The catalog as Improve's prompt lists it: a line per screen's node. */
export const viewNodeRows = (): string[] =>
  Object.entries(VIEW_NODES).flatMap(([screen, nodes]) =>
    nodes.map(
      (n) => `- \`${screen}\` \`${n.id}\`: ${n.what}${n.label ? '' : ' (hide or order only)'}`,
    ),
  );
