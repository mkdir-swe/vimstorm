/**
 * Chat's components (ticket #71; DS 2.0 ChatView): the Terminal, a running program the shell
 * keeps in a PTY and draws with VimStorm's terminal element, and ChatHeader, the header over it
 * with Chat's quiet row (lane, AgentStatus, environment, subagents, `+ my skills`); 2.1's header
 * (B Signal) when it names a `story`, over the rendered Chat and Terminal mode alike. Their types
 * and schemas live here; `components.ts` adds them to the closed set.
 *
 * The Terminal's lifetime is the shell's one rule (`app/src/factory/terminal.rs`): one PTY per
 * `key`, started when a tree first holds the key, kept across trees while one holds it, dropped
 * 10 minutes after the last tree that held it (`TERMINAL_KEEP_MS`) or at once on the
 * `drop-terminal` shell effect. An exited program's last screen stays drawn under its key, never
 * started again: a screen that wants a fresh one names a new key. Every key typed into it goes
 * to the program, except `screenKeys` and ⌘ keys, which go to the screen as `key` inputs; the
 * shell tells the screen a program exited with an `exit` frame.
 */
import { z } from 'zod';
import { GLYPHS, type Glyph, RAIL_SEGMENTS, type RailSegment } from '../board/board';
import { CLOUD_STATES, type CloudState } from '../live';
import type { AgentState, Node } from '../runtime/components';

/** How long the shell keeps a terminal no tree holds. */
export const TERMINAL_KEEP_MS = 10 * 60_000;

export type Terminal = {
  kind: 'Terminal';
  id?: string | undefined;
  props: {
    /** One PTY per key: the same key across trees is the same running program. */
    key: string;
    /** The program and its arguments; `abe` is the bridge's own `abe`. */
    argv: string[];
    cwd?: string | undefined;
    /** Added to the app's environment. */
    env?: Record<string, string> | undefined;
    /** It has the keyboard. */
    focused?: boolean | undefined;
    /** Keys (nvim notation) the screen takes instead of the program, as `key` inputs. */
    screenKeys?: string[] | undefined;
    /**
     * Rows that are links: ⌘-click on a row whose text matches `pattern` (a regex both JS and
     * Rust's `regex` read) sends a `click` on `click`, its `$1` the first group, trimmed.
     */
    links?: TerminalLink[] | undefined;
  };
};

/** A link in a terminal's rows (`Terminal.links`). */
export type TerminalLink = { pattern: string; click: string };

/** The header's second line (2.1): the stage rail, the stage, the state word, how long. */
export type ChatRail = {
  /** Spec · Build · Review · PR · Done. */
  segments: RailSegment[];
  /** `Build`. */
  stage: string;
  state: AgentState;
  /** The state's glyph before its word, as the Board's rail row has it (`lookOf`): `●`, `◆`, `✓`. */
  glyph: Glyph;
  /** `Running`, `Needs you`. */
  word: string;
  /** `21 min`. */
  elapsed?: string | undefined;
};

export type ChatHeader = {
  kind: 'ChatHeader';
  id?: string | undefined;
  props: {
    /** `Chat`. */
    title: string;
    /** `Local`, `Local sandbox`, `Cloud`. */
    env?: string | undefined;
    /** Subagents working now: `N subagents`, dim. */
    subagents?: number | undefined;
    /** The Hide button's id (`Hide ⌘5`). */
    hide?: string | undefined;
    /**
     * One dim line under the quiet row: a suggestion that opens nothing. With `story` and no
     * `rail`, the header's line 2 (an Improve chat's `your layer · ~/.config/abe`, #136).
     */
    note?: string | undefined;
    // 2.1 (header B Signal, #113 t113c): with `story` the header draws the 2.1 look, three
    // rows: the `Chat | Terminal` toggle with ⋮ and ×, `#2 <title>` with where it runs and
    // `⌘⏎`, then the rail line (or, with none, `note`); an override's warn row under them
    // (2.0's look and its `scope`, `lane`, `status`, `skills` and `actions` went with #350).
    /** `#2` and the story's title. */
    story?: { id: string; title: string } | undefined;
    /**
     * Chat mode and Terminal mode: a tab each, a click names its id; `mode` the shown one;
     * `needsYou` puts ◆ on a hidden tab (Chat, while the session needs you).
     */
    modes?:
      | {
          id: string;
          label: string;
          tooltip?: string | undefined;
          needsYou?: boolean | undefined;
        }[]
      | undefined;
    mode?: string | undefined;
    /** The ⋮ button's id (Start fresh conversation, …). */
    menu?: string | undefined;
    /** A box's cloud and name; without one, `env` dim (`Local sandbox`). */
    box?: { name: string; state: CloudState } | undefined;
    /** Dim at the right of the story line: `⌘⏎`. */
    hint?: string | undefined;
    /**
     * Line 2's first words as a link (#350: a prototype chat's `127.0.0.1:61234`, a click names
     * its id), before the rail's stage.
     */
    address?: { id: string; text: string } | undefined;
    rail?: ChatRail | undefined;
    /** An override live in this session: `Test DB write · overridden by you: <reason>`. */
    override?: string | undefined;
    /**
     * Your settings Overrides the run launched under (#168): `Override · autoMerge on`, a pill on
     * the story line before the hint; its tooltip says why and since when.
     */
    pill?: { text: string; tooltip?: string | undefined } | undefined;
    /** The Abe chat: Abe's face before the story, drawn `Abe · <repo>` (no card number). */
    face?: boolean | undefined;
    /**
     * The Abe chat's conversations, a slim row of tabs under the header (the newest at the right):
     * a click on one names its `id`, on its × its `close`; `mark` its working dot or ◆ (a question
     * or a dialog only). `add`: the `+` (a new conversation) at the row's end.
     */
    tabs?: ChatTab[] | undefined;
    add?: string | undefined;
  };
};

/** One of the Abe chat's conversations in the header's tab row. */
export type ChatTab = {
  id: string;
  label: string;
  selected?: boolean | undefined;
  mark?: 'working' | 'needs-you' | undefined;
  close: string;
};

export type ChatNode = Terminal | ChatHeader;

export const CHAT_KINDS = ['Terminal', 'ChatHeader'] as const;

/** The two schemas, built on the set's own primitives (`components.ts` calls this). */
export const chatSchemas = (d: { nodeId: z.ZodString; agentState: z.ZodType<AgentState> }) => {
  const id = d.nodeId.optional();

  return [
    z.strictObject({
      kind: z.literal('Terminal'),
      id,
      props: z.strictObject({
        key: z.string().min(1),
        argv: z.array(z.string()).min(1),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        focused: z.boolean().optional(),
        screenKeys: z.array(z.string().min(1)).optional(),
        links: z.array(z.strictObject({ pattern: z.string().min(1), click: d.nodeId })).optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('ChatHeader'),
      id,
      props: z.strictObject({
        title: z.string(),
        env: z.string().optional(),
        subagents: z.number().int().positive().optional(),
        hide: d.nodeId.optional(),
        note: z.string().optional(),
        story: z.strictObject({ id: z.string().min(1), title: z.string() }).optional(),
        modes: z
          .array(
            z.strictObject({
              id: d.nodeId,
              label: z.string(),
              tooltip: z.string().optional(),
              needsYou: z.boolean().optional(),
            }),
          )
          .optional(),
        mode: d.nodeId.optional(),
        menu: d.nodeId.optional(),
        box: z.strictObject({ name: z.string().min(1), state: z.enum(CLOUD_STATES) }).optional(),
        hint: z.string().optional(),
        address: z.strictObject({ id: d.nodeId, text: z.string().min(1) }).optional(),
        rail: z
          .strictObject({
            segments: z.array(z.enum(RAIL_SEGMENTS)),
            stage: z.string(),
            state: d.agentState,
            glyph: z.enum(GLYPHS),
            word: z.string(),
            elapsed: z.string().optional(),
          })
          .optional(),
        override: z.string().optional(),
        pill: z
          .strictObject({ text: z.string().min(1), tooltip: z.string().optional() })
          .optional(),
        face: z.boolean().optional(),
        tabs: z
          .array(
            z.strictObject({
              id: d.nodeId,
              label: z.string().min(1),
              selected: z.boolean().optional(),
              mark: z.enum(['working', 'needs-you']).optional(),
              close: d.nodeId,
            }),
          )
          .optional(),
        add: d.nodeId.optional(),
      }),
    }),
  ] as const;
};

/** Whether a node is one of these (a type guard for walks). */
export const isTerminal = (n: Node): n is Terminal => n.kind === 'Terminal';
