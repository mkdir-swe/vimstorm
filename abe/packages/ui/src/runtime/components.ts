/**
 * The component tree: what a screen is, as plain data VimStorm draws (ADR 0013 T3). A closed union
 * of DS 2.0's components (`8-components.md`), each `{ kind, id?, props, children? }`. A kind
 * outside the set fails the type check here and `Node`'s parse at run time; on the Rust side it
 * draws a dim `needs component: <kind>` box. A new kind is a Rust change too (`app/src/factory`).
 *
 * `UI_CONTRACT` is the version of this set and of the bridge's frames (`protocol.ts`); the JSON
 * schema and fixtures in `packages/ui/contract/` are written from these schemas.
 */
import { REVIEW_KINDS, type ReviewPaneNode, reviewSchemas } from '../review/review-components';
import { z } from 'zod';
import {
  type CardDialog,
  CardDialogSchema,
  type CardPage,
  CardPageSchema,
  type CommentBox,
  CommentBoxSchema,
  type ConfirmLayer,
  ConfirmLayerSchema,
  type LaunchBox,
  LaunchBoxSchema,
  type PickLayer,
  PickLayerSchema,
  type PromptLayer,
  PromptLayerSchema,
} from './layers';
import {
  BOARD_KINDS,
  type BoardNode,
  boardSchemas,
  RAIL_SEGMENTS,
  type RailSegment,
} from '../board/board';
import { CLOUD_STATES, type CloudState } from '../live';
import { CHAT_KINDS, type ChatNode, chatSchemas } from '../chat/terminal';
import { BROWSER_KINDS, type BrowserNode, browserSchemas } from './browser';
import { LINKED_KINDS, type LinkedLayerNode, linkedSchemas } from '../linked/linked-layer';
import {
  CHAT_COMPONENT_KINDS,
  type ChatComponentNode,
  chatComponentSchemas,
} from '../chat/chat-components';
import { CARD_COMPONENT_KINDS, type CardNode, cardSchemas } from '../chat/cards';
import { COMPOSER_KINDS, type ComposerNode, composerSchemas } from '../chat/composer';
import {
  SETTINGS_KINDS,
  type SettingsNode,
  settingsSchemas,
} from '../settings/settings-components';
import {
  PIPELINE_KINDS,
  type PipelineNode,
  pipelineSchemas,
} from '../pipelines/pipeline-components';
import { LOCAL_KINDS, type LocalNode, localSchemas } from '../board/local-components';
import { RUN_KINDS, type RunNode, runSchemas } from '../run/run-components';
import { INSTALL_KINDS, type InstallNode, installSchemas } from '../chat/install-parts';
import {
  PROTOTYPE_KINDS,
  type PrototypeNode,
  prototypeSchemas,
} from '../prototype/prototype-components';

/** The contract's version (2: trees go as keyed patches once the app holds one, ADR 0036). */
export const UI_CONTRACT = 2;

/** A node's id: what a click names back (`input` `click`). */
export const NodeId = z.string().min(1);

/** A status hue (5-states.md): the word's colour and a badge's wash. */
export const Hue = z.enum(['good', 'warn', 'needs-you', 'bad', 'accent', 'dim']);
export type Hue = z.infer<typeof Hue>;

/**
 * A child's size along its Stack's direction: its content's, fixed px, a share of the rest, or
 * its content's up to a part of the Stack (`fit: 0.6`: past it the child scrolls its own).
 */
export const Size = z.union([
  z.literal('auto'),
  z.strictObject({ fixed: z.number().nonnegative() }),
  z.strictObject({ flex: z.number().positive() }),
  z.strictObject({ fit: z.number().positive().max(1) }),
]);
export type Size = z.infer<typeof Size>;

export const AGENT_STATES = [
  'starting',
  'running',
  'needs-you',
  'idle',
  'ready',
  'failed',
  'ended',
  'merged',
  'on-test',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Each state's fixed word (AgentStatus README); a running step's word replaces Running's. */
export const AGENT_WORDS: Readonly<Record<AgentState, string>> = {
  starting: 'Starting',
  running: 'Running',
  'needs-you': 'Needs you',
  idle: 'Idle',
  ready: 'Ready for review',
  failed: 'Failed',
  ended: 'Ended',
  merged: 'Merged',
  'on-test': 'On test',
};

export type Island = {
  kind: 'Island';
  id?: string | undefined;
  props: Record<string, never>;
  children: Node[];
};
export type Stack = {
  kind: 'Stack';
  id?: string | undefined;
  props: {
    direction: 'row' | 'column';
    /** px between children. */
    gap?: number | undefined;
    /** One per child, in order; a missing one is `auto`. */
    sizes?: Size[] | undefined;
    /** Across the direction: children centred (a row's default) or stretched to the Stack. */
    align?: 'center' | 'stretch' | undefined;
    /** px inside the Stack: top, right, bottom, left. */
    pad?: [number, number, number, number] | undefined;
  };
  children: Node[];
};
export type ToolWindowHeader = {
  kind: 'ToolWindowHeader';
  id?: string | undefined;
  props: {
    title: string;
    count?: number | undefined;
    /** A tab's id is what a click on it names. */
    tabs?: { id: string; label: string }[] | undefined;
    selected?: string | undefined;
    /** The one dim key note at the right (`r reload`). */
    note?: string | undefined;
  };
};
export type ListRow = {
  kind: 'ListRow';
  id?: string | undefined;
  props: {
    text: string;
    dim?: string | undefined;
    /** Right-aligned text. */
    note?: string | undefined;
    /** An icon name of the app's set (assets/icons). */
    icon?: string | undefined;
    state?: 'default' | 'selected' | 'selected-inactive' | 'disabled' | undefined;
    /** Why a disabled row is (its tooltip). */
    reason?: string | undefined;
    key?: string | undefined;
  };
  /** Drawn inline after the text, before the note: Badge, AgentStatus, KeyHint. */
  children?: Node[] | undefined;
};
export type Badge = { kind: 'Badge'; id?: string | undefined; props: { text: string; hue: Hue } };
export type KeyHint = {
  kind: 'KeyHint';
  id?: string | undefined;
  props: {
    /** As the app writes keys: glyphs (`⌘⏎`, `r`), never keycaps. */
    keys: string;
    /** The action's words after the keys. */
    label?: string | undefined;
    context: 'row' | 'footer' | 'button';
    dim?: boolean | undefined;
  };
};
export type AgentStatus = {
  kind: 'AgentStatus';
  id?: string | undefined;
  props: {
    state: AgentState;
    /** The drawn word: the state's (`AGENT_WORDS`), or a running step's (`Verifying`). */
    word: string;
    /** Failed's why: dim, after the word. */
    reason?: string | undefined;
    connection?: 'Connecting' | 'Disconnected' | undefined;
    /** `Local`, `Local sandbox`, `Cloud`: dim, after the word. */
    env?: string | undefined;
    dot?: boolean | undefined;
  };
};
/**
 * An Empty's way on (W-NoSession, #292): the primary one a button with its key after its label
 * (`Launch agent ⏎`), the rest dim key hints (`⌘⏎ more`); a click names its id.
 */
export type EmptyAction = {
  id: string;
  label: string;
  keys: string;
  primary?: boolean | undefined;
};
export type Empty = {
  kind: 'Empty';
  id?: string | undefined;
  props: {
    title: string;
    line: string;
    /** Abe's head (32 px) above the title (W-NoSession). */
    head?: boolean | undefined;
    /** One row centred under the title, 12 px below it. */
    actions?: EmptyAction[] | undefined;
  };
};

/** A Table column's width: fixed px, or a share of what the fixed ones leave. */
export const ColumnWidth = z.union([
  z.strictObject({ fixed: z.number().nonnegative() }),
  z.strictObject({ flex: z.number().positive() }),
]);
export type ColumnWidth = z.infer<typeof ColumnWidth>;

export type TableColumn = {
  /** The header cell's words, dim. */
  label: string;
  width: ColumnWidth;
  /** `end`: the column's header and cells right-aligned (times, counts). */
  align?: 'start' | 'end' | undefined;
};

/**
 * One cell, drawn left to right and elided at its column's width: the accent words (`#2`), the
 * stage rail, the box's cloud, the mark (`◆`, `●`, `✗`), the text; mark and text in `hue`.
 */
export type TableCell = {
  accent?: string | undefined;
  /** The 5-segment stage rail (Spec · Build · Review · PR · Done). */
  rail?: RailSegment[] | undefined;
  /** A box's 12 px cloud: filled running, outlined asleep, dashed starting. */
  cloud?: CloudState | undefined;
  mark?: string | undefined;
  text?: string | undefined;
  hue?: Hue | undefined;
  /** Said on hover. */
  tooltip?: string | undefined;
  /** A button in the row (Open): a click names this id, not the row's. */
  id?: string | undefined;
};

export type TableRow = {
  /** What a click on the row names; a row without one is a note (`Box sessions not read`). */
  id?: string | undefined;
  /** One per column; a row with fewer, its last cell spans the columns it leaves. */
  cells: TableCell[];
  /** The whole row washed in a hue (a box in trouble: `bad`). */
  hue?: Hue | undefined;
};

/**
 * A list of rows under a header of columns (DS 2.1 Sessions, Boxes): 30 px rows, the selected one
 * tinted (blue where the keys are, grey elsewhere), an Empty in the rows' place while there are
 * none, a dim key line under them with a dim note at its right (#156: never over the column
 * labels). The screen windows the rows to what fits; the shell draws what it is given.
 */
export type Table = {
  kind: 'Table';
  id?: string | undefined;
  props: {
    columns: TableColumn[];
    rows: TableRow[];
    /** The selected row's id. */
    selected?: string | undefined;
    note?: string | undefined;
    /** The `/` filter's text while one is on (#263): Esc is the list's then, it clears it. */
    filter?: string | undefined;
    /** Drawn under the header while `rows` is empty. */
    empty?: { title: string; line: string } | undefined;
    /** The key line under the rows: each key in the accent, its words dim. */
    foot?: { keys: string; label: string }[] | undefined;
  };
};

export type Node =
  | Island
  | Stack
  | ToolWindowHeader
  | ListRow
  | Badge
  | KeyHint
  | AgentStatus
  | Empty
  | PickLayer
  | PromptLayer
  | ConfirmLayer
  | CardDialog
  | CardPage
  | CommentBox
  | LaunchBox
  | BoardNode
  | ChatNode
  | BrowserNode
  | ChatComponentNode
  | CardNode
  | ComposerNode
  | SettingsNode
  | Table
  | LinkedLayerNode
  | ReviewPaneNode
  | PipelineNode
  | LocalNode
  | RunNode
  | InstallNode
  | PrototypeNode;
export type Kind = Node['kind'];

const id = NodeId.optional();
const children = (): z.ZodType<Node[]> => z.array(Node);

const IslandSchema = z.strictObject({
  kind: z.literal('Island'),
  id,
  props: z.strictObject({}),
  get children() {
    return children();
  },
});
const StackSchema = z.strictObject({
  kind: z.literal('Stack'),
  id,
  props: z.strictObject({
    direction: z.enum(['row', 'column']),
    gap: z.number().nonnegative().optional(),
    sizes: z.array(Size).optional(),
    align: z.enum(['center', 'stretch']).optional(),
    pad: z
      .tuple([
        z.number().nonnegative(),
        z.number().nonnegative(),
        z.number().nonnegative(),
        z.number().nonnegative(),
      ])
      .optional(),
  }),
  get children() {
    return children();
  },
});
const ToolWindowHeaderSchema = z.strictObject({
  kind: z.literal('ToolWindowHeader'),
  id,
  props: z.strictObject({
    title: z.string(),
    count: z.number().int().nonnegative().optional(),
    tabs: z.array(z.strictObject({ id: NodeId, label: z.string() })).optional(),
    selected: NodeId.optional(),
    note: z.string().optional(),
  }),
});
const ListRowSchema = z.strictObject({
  kind: z.literal('ListRow'),
  id,
  props: z.strictObject({
    text: z.string(),
    dim: z.string().optional(),
    note: z.string().optional(),
    icon: z.string().optional(),
    state: z.enum(['default', 'selected', 'selected-inactive', 'disabled']).optional(),
    reason: z.string().optional(),
    key: z.string().optional(),
  }),
  get children() {
    return children().optional();
  },
});
const BadgeSchema = z.strictObject({
  kind: z.literal('Badge'),
  id,
  props: z.strictObject({ text: z.string(), hue: Hue }),
});
const KeyHintSchema = z.strictObject({
  kind: z.literal('KeyHint'),
  id,
  props: z.strictObject({
    keys: z.string(),
    label: z.string().optional(),
    context: z.enum(['row', 'footer', 'button']),
    dim: z.boolean().optional(),
  }),
});
const AgentStatusSchema = z.strictObject({
  kind: z.literal('AgentStatus'),
  id,
  props: z.strictObject({
    state: z.enum(AGENT_STATES),
    word: z.string(),
    reason: z.string().optional(),
    connection: z.enum(['Connecting', 'Disconnected']).optional(),
    env: z.string().optional(),
    dot: z.boolean().optional(),
  }),
});
const EmptySchema = z.strictObject({
  kind: z.literal('Empty'),
  id,
  props: z.strictObject({
    title: z.string(),
    line: z.string(),
    head: z.boolean().optional(),
    actions: z
      .array(
        z.strictObject({
          id: z.string(),
          label: z.string(),
          keys: z.string(),
          primary: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
});
const TableCellSchema = z.strictObject({
  accent: z.string().optional(),
  rail: z.array(z.enum(RAIL_SEGMENTS)).optional(),
  cloud: z.enum(CLOUD_STATES).optional(),
  mark: z.string().optional(),
  text: z.string().optional(),
  hue: Hue.optional(),
  tooltip: z.string().optional(),
  id: z.string().optional(),
});
const TableSchema = z.strictObject({
  kind: z.literal('Table'),
  id,
  props: z.strictObject({
    columns: z
      .array(
        z.strictObject({
          label: z.string(),
          width: ColumnWidth,
          align: z.enum(['start', 'end']).optional(),
        }),
      )
      .min(1),
    rows: z.array(
      z.strictObject({
        id: NodeId.optional(),
        cells: z.array(TableCellSchema).min(1),
        hue: Hue.optional(),
      }),
    ),
    selected: NodeId.optional(),
    note: z.string().optional(),
    filter: z.string().optional(),
    empty: z.strictObject({ title: z.string(), line: z.string() }).optional(),
    foot: z.array(z.strictObject({ keys: z.string().min(1), label: z.string() })).optional(),
  }),
});

/** Any node of the closed set; `Node.parse` refuses every other kind. */
export const Node: z.ZodType<Node> = z.discriminatedUnion('kind', [
  IslandSchema,
  StackSchema,
  ToolWindowHeaderSchema,
  ListRowSchema,
  BadgeSchema,
  KeyHintSchema,
  AgentStatusSchema,
  EmptySchema,
  ...boardSchemas({ nodeId: NodeId, hue: Hue, agentState: z.enum(AGENT_STATES), node: () => Node }),
  PickLayerSchema,
  PromptLayerSchema,
  ConfirmLayerSchema,
  CardDialogSchema,
  CommentBoxSchema,
  LaunchBoxSchema,
  CardPageSchema,
  ...chatSchemas({ nodeId: NodeId, agentState: z.enum(AGENT_STATES) }),
  ...browserSchemas({ nodeId: NodeId }),
  TableSchema,
  ...chatComponentSchemas({ nodeId: NodeId, node: () => Node }),
  ...cardSchemas({ nodeId: NodeId, node: () => Node }),
  ...composerSchemas({ nodeId: NodeId, node: () => Node }),
  ...settingsSchemas({ nodeId: NodeId, node: () => Node }),
  ...linkedSchemas({ nodeId: NodeId, hue: Hue }),
  ...reviewSchemas(),
  ...pipelineSchemas({ nodeId: NodeId, hue: Hue }),
  ...localSchemas({ nodeId: NodeId, hue: Hue }),
  ...runSchemas({ nodeId: NodeId, hue: Hue }),
  ...installSchemas({ nodeId: NodeId, hue: Hue }),
  ...prototypeSchemas({ nodeId: NodeId, hue: Hue }),
]);

/** The set, in the order the contract lists it. */
export const KINDS: readonly Kind[] = [
  'Island',
  'Stack',
  'ToolWindowHeader',
  'ListRow',
  'Badge',
  'KeyHint',
  'AgentStatus',
  'Empty',
  ...BOARD_KINDS,
  'PickLayer',
  'PromptLayer',
  'ConfirmLayer',
  'CardDialog',
  'CommentBox',
  'LaunchBox',
  'CardPage',
  ...CHAT_KINDS,
  ...BROWSER_KINDS,
  ...CHAT_COMPONENT_KINDS,
  ...SETTINGS_KINDS,
  'Table',
  ...CARD_COMPONENT_KINDS,
  ...COMPOSER_KINDS,
  ...LINKED_KINDS,
  ...REVIEW_KINDS,
  ...PIPELINE_KINDS,
  ...LOCAL_KINDS,
  ...RUN_KINDS,
  ...INSTALL_KINDS,
  ...PROTOTYPE_KINDS,
];

/** The builders a screen writes its tree with. */
export const island = (children: Node[], nodeId?: string): Island => ({
  kind: 'Island',
  ...(nodeId === undefined ? {} : { id: nodeId }),
  props: {},
  children,
});
export const stack = (
  direction: 'row' | 'column',
  children: Node[],
  o: {
    sizes?: Size[];
    gap?: number;
    align?: 'center' | 'stretch';
    pad?: [number, number, number, number];
  } = {},
): Stack => ({ kind: 'Stack', props: { direction, ...o }, children });
export const agentStatus = (
  state: AgentState,
  extra: { step?: string; connection?: 'Connecting' | 'Disconnected'; env?: string } = {},
): AgentStatus => ({
  kind: 'AgentStatus',
  props: {
    state,
    word: state === 'running' && extra.step !== undefined ? extra.step : AGENT_WORDS[state],
    ...(extra.connection === undefined ? {} : { connection: extra.connection }),
    ...(extra.env === undefined ? {} : { env: extra.env }),
  },
});
export const empty = (title: string, line: string): Empty => ({
  kind: 'Empty',
  props: { title, line },
});
