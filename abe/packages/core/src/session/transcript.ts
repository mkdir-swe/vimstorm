/**
 * A session's transcript as Chat draws it (#113; the platform facts are slice t113a's comment on
 * it): typed entries read from Claude Code's transcript JSONL, one line at a time, and from the
 * hook payloads that come before the JSONL has the same thing (a running tool call, its result).
 * Both give an entry the same kind and id (`tool_use_id`, `prompt_id`), so a reader keeps one list
 * and replaces an entry by kind and id: a hook's result has the patch and a Bash's output, the
 * JSONL's line that comes after it has every tool's text too. The transcript gives the words only: where a session
 * stands still comes from the hooks (`sessionStep` in `session-state`), but for Esc mid-turn, which runs
 * none (`interruptedAt`).
 *
 * Kept: the person's messages, the agent's text, tool calls and their results (a file tool's patch
 * with them), compactions; serve adds each turn's `changes` (from git; `changes.ts` reads its
 * diff); your message typed mid-turn is the `queued_command` attachment Claude Code took it as
 * (#197). Dropped quietly: thinking (empty in the JSONL), other attachments, request lines, Claude
 * Code's bookkeeping, subagents' hand-backs, command wrappers, and any line or kind this build
 * does not know. Long texts are capped: a result's text and a patch say how much they
 * cut, a long input string ends in `…`.
 */
import { z } from 'zod';
import { splitContext } from './context';
import { HUB_HELLO, HUB_REOPENED_PROMPT } from './hub-prompts';
import { stepOf, stepText } from './steps';

/** A tool result's text is cut to its first `RESULT_HEAD` and last characters beyond this. */
export const RESULT_TEXT_MAX = 4000;
const RESULT_HEAD = 1000;
/** A string inside a tool call's input is cut beyond this (a Write's content, a long prompt). */
export const INPUT_TEXT_MAX = 2000;
/** A patch keeps this many hunk lines in all (`cut` counts the rest), each cut as an input string. */
export const PATCH_LINES_MAX = 400;
/** A turn's `changes` entry keeps this many files (`cut` counts the rest). */
export const CHANGES_FILES_MAX = 100;
/**
 * Claude Code's own wrappers around a slash command, its output, a reminder, a background
 * subagent's hand-back or task notice (sent as a prompt mid-turn, its own UserPromptSubmit): not yours.
 */
const WRAPPER =
  /^\s*<(command-|local-command-|system-reminder|task-notification|bash-|agent-message)/;
/** What Claude Code writes as a user line when you press Esc mid-turn. */
const INTERRUPTED = '[Request interrupted by user';

export const COMPACT_TRIGGERS = ['manual', 'auto'] as const;

/** One hunk of a unified diff, as Claude Code's `structuredPatch` has it: lines start ` `, `-`, `+`. */
export const PatchHunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});
export type PatchHunk = z.infer<typeof PatchHunk>;

/** What a file tool (Edit, MultiEdit, Write) changed in one file: a diff card's body. */
export const FilePatch = z.object({
  /** Absolute, as the tool wrote it; the reader makes it relative to the workspace. */
  path: z.string(),
  /** The file was new (a Write that created it). */
  created: z.boolean(),
  /** Counted over every line, before the cap. */
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  hunks: z.array(PatchHunk),
  /** Hunk lines left out past `PATCH_LINES_MAX`. */
  cut: z.number().int().nonnegative(),
});
export type FilePatch = z.infer<typeof FilePatch>;

const common = {
  id: z.string(),
  /** ISO time: the JSONL line's, or when the hook came. */
  at: z.string(),
  /** The subagent the line is from (its `agent_id`); null for the session's own agent. */
  agent: z.string().nullable(),
};

export const TranscriptEntry = z.discriminatedUnion('kind', [
  /** Your message (id: its `promptId`), its implicit context split off. */
  z.object({
    kind: z.literal('user'),
    ...common,
    text: z.string(),
    /** The context's first line after `Context: ` (`api/src/cart.ts lines 12–18`), or none. */
    context: z.string().nullable(),
    /** Abe sent it, never the person: the Abe chat's start (`/abe:abe`) and reopen prompts. */
    abe: z.literal(true).optional(),
  }),
  /** The agent's words (id: the line's uuid), markdown as written. */
  z.object({ kind: z.literal('assistant-text'), ...common, text: z.string() }),
  /** A tool call (id: its `tool_use_id`); string values of its input capped. */
  z.object({
    kind: z.literal('tool-use'),
    ...common,
    tool: z.string(),
    input: z.record(z.string(), z.json()),
  }),
  /** A tool call's result (id: the call's `tool_use_id`). */
  z.object({
    kind: z.literal('tool-result'),
    ...common,
    ok: z.boolean(),
    text: z.string(),
    /** Characters of `text` left out in its middle. */
    cut: z.number().int().nonnegative(),
    patch: FilePatch.nullable(),
  }),
  /**
   * What a turn changed in the worktree's files (serve's, from git: its snapshot at the turn's
   * start against the latest, so a Bash `sed` and a merged subagent's work count too); id and
   * `turn`: the turn's `user` entry's id. A later one for the same turn replaces it. Where it
   * sits in the list is when it was first seen, not the turn's order: a reader places it by `turn`.
   */
  z.object({
    kind: z.literal('changes'),
    ...common,
    turn: z.string(),
    files: z.array(FilePatch),
    /** Files left out past `CHANGES_FILES_MAX`. */
    cut: z.number().int().nonnegative(),
  }),
  /** The conversation was compacted (`/compact`: `manual`, or `auto`). */
  z.object({
    kind: z.literal('compact'),
    ...common,
    /** Null when Claude Code named none this build knows. */
    trigger: z.enum(COMPACT_TRIGGERS).nullable(),
    preTokens: z.number().int().nonnegative().nullable(),
  }),
]);
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

/** One option of an AskUserQuestion question, its `(Recommended)` suffix read off the label. */
export type AskedOption = { label: string; note: string | null; recommended: boolean };
export type AskedQuestion = {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: AskedOption[];
};

// What a line or payload is read with: loose, so Claude Code's other keys pass and a line of
// another shape fails to parse (and is dropped) instead of throwing.
const Block = z.looseObject({ type: z.string() });
const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.json()),
});
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().nullish(),
  content: z.union([z.string(), z.array(Block)]).nullish(),
});
const Line = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  agentId: z.string().optional(),
  promptId: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  origin: z.looseObject({ kind: z.string() }).optional(),
  subtype: z.string().optional(),
  compactMetadata: z
    .looseObject({ trigger: z.unknown().optional(), preTokens: z.unknown().optional() })
    .optional(),
  message: z
    .looseObject({ id: z.string().optional(), content: z.union([z.string(), z.array(Block)]) })
    .optional(),
  toolUseResult: z.unknown().optional(),
  attachment: z.unknown().optional(),
});
type Line = z.infer<typeof Line>;
type Common = { id: string; at: string; agent: string | null };

const Response = z.looseObject({
  filePath: z.string(),
  type: z.string().optional(),
  content: z.string().optional(),
  structuredPatch: z.array(PatchHunk).optional(),
});
const Shell = z.looseObject({ stdout: z.string(), stderr: z.string().optional() });

const Hook = z.looseObject({
  hook_event_name: z.string(),
  agent_id: z.string().optional(),
  prompt: z.string().optional(),
  prompt_id: z.string().optional(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_input: z.record(z.string(), z.json()).optional(),
  tool_response: z.unknown().optional(),
  error: z.string().optional(),
});

const Questions = z.looseObject({
  questions: z.array(
    z.looseObject({
      question: z.string(),
      header: z.string().optional(),
      multiSelect: z.boolean().optional(),
      options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })),
    }),
  ),
});

const Trigger = z.enum(COMPACT_TRIGGERS);
const Tokens = z.number().int().nonnegative();

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

type Json = z.infer<ReturnType<typeof z.json>>;

/** A long text as its head and tail with a mark between, and how many characters went. */
const capped = (text: string): { text: string; cut: number } => {
  if (text.length <= RESULT_TEXT_MAX) return { text, cut: 0 };
  const tail = RESULT_TEXT_MAX - RESULT_HEAD;
  const cut = text.length - RESULT_TEXT_MAX;

  return {
    text: `${text.slice(0, RESULT_HEAD)}\n… ${cut} characters cut …\n${text.slice(-tail)}`,
    cut,
  };
};

const cappedJson = (value: Json): Json => {
  if (typeof value === 'string')
    return value.length <= INPUT_TEXT_MAX ? value : `${value.slice(0, INPUT_TEXT_MAX)}…`;
  if (Array.isArray(value)) return value.map(cappedJson);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cappedJson(v)]));
};

const cappedInput = (input: Record<string, Json>): Record<string, Json> =>
  Object.fromEntries(Object.entries(input).map(([k, v]) => [k, cappedJson(v)]));

/** The tool's own hunks, or a created file's text as one hunk of added lines. */
const hunksOf = (patch: PatchHunk[], created: string | undefined): PatchHunk[] => {
  if (patch.length > 0 || created === undefined) return patch;
  const lines = created.replace(/\n$/, '').split('\n');

  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      lines: lines.map((l) => `+${l}`),
    },
  ];
};

/** A file tool's result (JSONL `toolUseResult`, hook `tool_response`) as a patch, else null. */
const patchOf = (value: unknown): FilePatch | null => {
  const r = Response.safeParse(value);

  if (!r.success) return null;
  const created = r.data.type === 'create';
  const hunks = hunksOf(r.data.structuredPatch ?? [], created ? r.data.content : undefined);

  return hunks.length === 0 ? null : filePatch(r.data.filePath, created, hunks);
};

/**
 * One file's hunks as a patch: `+` / `-` counted over every line, then the lines capped at
 * `PATCH_LINES_MAX` in all (each at `INPUT_TEXT_MAX`).
 */
export const filePatch = (path: string, created: boolean, hunks: PatchHunk[]): FilePatch => {
  const all = hunks.flatMap((h) => h.lines);
  let room = PATCH_LINES_MAX;
  const kept = hunks.flatMap((h) => {
    if (room <= 0) return [];
    const taken = h.lines
      .slice(0, room)
      .map((l) => (l.length <= INPUT_TEXT_MAX ? l : `${l.slice(0, INPUT_TEXT_MAX)}…`));

    room -= taken.length;

    return [{ ...h, lines: taken }];
  });

  return {
    path,
    created,
    added: all.filter((l) => l.startsWith('+')).length,
    removed: all.filter((l) => l.startsWith('-')).length,
    hunks: kept,
    cut: Math.max(0, all.length - PATCH_LINES_MAX),
  };
};

/** A Bash result's output, or a tool's plain text; other structured results have none. */
const responseText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const shell = Shell.safeParse(value);

  if (!shell.success) return '';
  const { stdout, stderr = '' } = shell.data;

  return [stdout, stderr].filter((s) => s !== '').join('\n');
};

const blockText = (content: z.infer<typeof ToolResultBlock>['content']): string => {
  if (typeof content === 'string') return content;

  return (content ?? [])
    .flatMap((b) => {
      const t = TextBlock.safeParse(b);

      return t.success ? [t.data.text] : [];
    })
    .join('\n');
};

/** Claude Code's marks around a long paste, in the prompt it gives the agent (#197). */
const PASTED = /<pasted_content id="([^"]*)">\n([\s\S]*?)\n<\/pasted_content id="\1">/g;

/** The prompts Abe sends the Abe chat itself: no message of the person's. */
const ABE_SENT: ReadonlySet<string> = new Set([HUB_HELLO, HUB_REOPENED_PROMPT]);

/** Your message and the context the composer put after it. */
const userEntry = (c: Common, raw: string): TranscriptEntry[] => {
  if (WRAPPER.test(raw) || raw.startsWith(INTERRUPTED) || raw.trim() === '') return [];
  // The first mark in one of #115's forms (`context.ts`): a selection's own lines may hold another.
  return [
    {
      kind: 'user',
      ...c,
      // blank lines before it are no part of it: a grill round's answers came with two (#12)
      ...splitContext(raw.replace(PASTED, '$2').replace(/^\s*\n/, '')),
      ...(ABE_SENT.has(raw.trim()) ? { abe: true as const } : {}),
    },
  ];
};

/**
 * A message typed while a turn ran, as Claude Code took it at the next tool result (#197): a
 * `queued_command` attachment of yours, not a user line. A task's notice queued the same way is not.
 */
const QueuedCommand = z.looseObject({
  type: z.literal('queued_command'),
  prompt: z.string(),
  commandMode: z.string().optional(),
  origin: z.looseObject({ kind: z.string() }).optional(),
});

const userLine = (line: Line, c: Common): TranscriptEntry[] => {
  const content = line.message?.content;

  if (content === undefined) return [];
  const results =
    typeof content === 'string'
      ? []
      : content.flatMap((b) => {
          const r = ToolResultBlock.safeParse(b);

          return r.success ? [r.data] : [];
        });

  if (results.length === 0) {
    // A subagent's hand-back (`origin.kind: peer`) and the compact summary are not the person's.
    if (line.isMeta === true || line.isCompactSummary === true) return [];
    if (line.origin !== undefined && line.origin.kind !== 'human') return [];
    // A message with an image is text blocks beside it.
    const text = typeof content === 'string' ? content : blockText(content);

    // A subagent's task prompt carries its coordinator's `promptId`: its own uuid keeps ids apart.
    return userEntry({ ...c, id: c.agent === null ? (line.promptId ?? c.id) : c.id }, text);
  }

  return results.map((r) => ({
    kind: 'tool-result',
    ...c,
    id: r.tool_use_id,
    ok: r.is_error !== true,
    ...capped(blockText(r.content)),
    // The line's structured result belongs to its one tool result.
    patch: results.length === 1 ? patchOf(line.toolUseResult) : null,
  }));
};

const assistantLine = (line: Line, c: Common): TranscriptEntry[] => {
  const content = line.message?.content;

  if (content === undefined || typeof content === 'string') return [];

  return content.flatMap((b, i): TranscriptEntry[] => {
    const text = TextBlock.safeParse(b);

    if (text.success)
      return text.data.text.trim() === ''
        ? []
        : [
            {
              kind: 'assistant-text',
              ...c,
              id: content.length === 1 ? c.id : `${c.id}:${i}`,
              text: text.data.text,
            },
          ];
    const use = ToolUseBlock.safeParse(b);

    return use.success
      ? [
          {
            kind: 'tool-use',
            ...c,
            id: use.data.id,
            tool: use.data.name,
            input: cappedInput(use.data.input),
          },
        ]
      : [];
  });
};

/**
 * The entries of one transcript JSONL line (the session's file or a subagent's): none for a
 * line that is not JSON, of a kind Chat does not draw, or of a shape this build does not know.
 */
export const entriesOfLine = (text: string): TranscriptEntry[] => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const line = Line.safeParse(doc);

  if (!line.success || line.data.uuid === undefined || line.data.timestamp === undefined) return [];
  const c: Common = {
    id: line.data.uuid,
    at: line.data.timestamp,
    agent: line.data.isSidechain === true ? (line.data.agentId ?? null) : null,
  };

  switch (line.data.type) {
    case 'user':
      return userLine(line.data, c);
    case 'assistant':
      return assistantLine(line.data, c);
    case 'attachment': {
      const q = QueuedCommand.safeParse(line.data.attachment);

      return q.success &&
        (q.data.commandMode ?? 'prompt') === 'prompt' &&
        (q.data.origin?.kind ?? 'human') === 'human'
        ? userEntry(c, q.data.prompt)
        : [];
    }
    case 'system':
      return line.data.subtype === 'compact_boundary'
        ? [
            {
              kind: 'compact',
              ...c,
              trigger: Trigger.safeParse(line.data.compactMetadata?.trigger).data ?? null,
              preTokens: Tokens.safeParse(line.data.compactMetadata?.preTokens).data ?? null,
            },
          ]
        : [];
    default:
      return [];
  }
};

/**
 * When the session's own agent was stopped mid-turn (Esc in Claude Code), from that line's time:
 * Claude Code runs no hook then (no `Stop`, no idle notice), so this line is the only word that it
 * waits at its prompt. A subagent's line, or any other, gives none.
 */
export const interruptedAt = (text: string): string | undefined => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const line = Line.safeParse(doc);

  if (!line.success || line.data.type !== 'user' || line.data.isSidechain === true)
    return undefined;
  const content = line.data.message?.content;
  const words = content === undefined || typeof content === 'string' ? content : blockText(content);

  return words?.startsWith(INTERRUPTED) === true ? line.data.timestamp : undefined;
};

/**
 * The entries a hook's payload gives before the JSONL has them: `UserPromptSubmit` your message,
 * `PreToolUse` the call (the running step), `PostToolUse` / `PostToolUseFailure` its result. `at`
 * is when the hook came (core has no clock). Every other event gives none.
 */
export const entriesOfHook = (payload: unknown, at: string): TranscriptEntry[] => {
  const hook = Hook.safeParse(payload);

  if (!hook.success) return [];
  const h = hook.data;
  const agent = h.agent_id ?? null;

  switch (h.hook_event_name) {
    case 'UserPromptSubmit':
      return h.prompt === undefined || h.prompt_id === undefined
        ? []
        : userEntry({ id: h.prompt_id, at, agent }, h.prompt);
    case 'PreToolUse':
      return h.tool_use_id === undefined || h.tool_name === undefined
        ? []
        : [
            {
              kind: 'tool-use',
              id: h.tool_use_id,
              at,
              agent,
              tool: h.tool_name,
              input: cappedInput(h.tool_input ?? {}),
            },
          ];
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (h.tool_use_id === undefined) return [];
      const failed = h.hook_event_name === 'PostToolUseFailure';

      return [
        {
          kind: 'tool-result',
          id: h.tool_use_id,
          at,
          agent,
          ok: !failed,
          ...capped(failed ? (h.error ?? '') : responseText(h.tool_response)),
          patch: failed ? null : patchOf(h.tool_response),
        },
      ];
    }
    default:
      return [];
  }
};

/**
 * AskUserQuestion's input (a `tool-use` entry's, or its PreToolUse payload's) as the questions a
 * card draws, in order; null when it is not that shape.
 */
export const askedQuestions = (input: unknown): AskedQuestion[] | null => {
  const q = Questions.safeParse(input);

  if (!q.success) return null;

  return q.data.questions.map((one) => ({
    question: one.question,
    header: one.header ?? null,
    multiSelect: one.multiSelect ?? false,
    options: one.options.map((o) => ({
      label: o.label.replace(RECOMMENDED, ''),
      note: o.description ?? null,
      recommended: RECOMMENDED.test(o.label),
    })),
  }));
};

/**
 * `abe session transcript <id> [--since <n>]` (#113): the session's transcript entries numbered
 * `from` on, as the `session.transcript` events number them (a reader puts each at its number;
 * one already there of the same kind and id is replaced). An earlier `--since` than the oldest
 * entry kept answers from that one.
 */
export const SessionTranscriptData = z.object({
  session: z.string(),
  from: z.number().int().nonnegative(),
  entries: z.array(TranscriptEntry),
});
export type SessionTranscriptData = z.infer<typeof SessionTranscriptData>;

/**
 * `abe session revert <id> --turn <user entry id> [--file <path>]` (#113): the turn's files put
 * back as they were at its start, paths relative to the worktree; `removed`: files the turn made.
 */
export const SessionRevertData = z.object({
  session: z.string(),
  turn: z.string(),
  restored: z.array(z.string()),
  removed: z.array(z.string()),
});
export type SessionRevertData = z.infer<typeof SessionRevertData>;

const firstLine = (text: string, max = 100) => {
  const line = text.trim().split('\n')[0] ?? '';

  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/**
 * `abe session transcript`: one line per entry with its number, a tool call as its step row with
 * its result (when the answer holds it), which then has no line of its own.
 */
export const sessionTranscriptText = (t: SessionTranscriptData): string => {
  if (t.entries.length === 0) return `${t.session}: no transcript entries from ${t.from}\n`;
  const results = new Map(
    t.entries.flatMap((e) => (e.kind === 'tool-result' ? [[e.id, e] as const] : [])),
  );
  const uses = new Set(t.entries.flatMap((e) => (e.kind === 'tool-use' ? [e.id] : [])));
  const GLYPH = { ok: '✓', failed: '✗', running: '●' } as const;

  return t.entries
    .flatMap((e, i): string[] => {
      // A subagent's entries (its own transcript file) marked as its.
      const n = `${`${t.from + i}`.padStart(4)}${e.agent === null ? '' : ' ↳'}`;

      switch (e.kind) {
        case 'user':
          return [`${n}  you    ${firstLine(e.text)}`];
        case 'assistant-text':
          return [`${n}  agent  ${firstLine(e.text)}`];
        case 'tool-use': {
          const step = stepOf(e, results.get(e.id) ?? null);

          return [`${n}  ${GLYPH[step.glyph]}      ${stepText(step)}`];
        }
        case 'tool-result':
          return uses.has(e.id) ? [] : [`${n}  ${e.ok ? '✓' : '✗'}      ${firstLine(e.text)}`];
        case 'changes': {
          const added = e.files.reduce((sum, f) => sum + f.added, 0);
          const removed = e.files.reduce((sum, f) => sum + f.removed, 0);
          const files = e.files.length + e.cut;

          return [
            `${n}  files  ${files} ${files === 1 ? 'file' : 'files'} changed · +${added} −${removed}`,
          ];
        }
        case 'compact':
          return [`${n}  ──     compacted${e.trigger === null ? '' : ` (${e.trigger})`}`];
      }
    })
    .map((l) => `${l}\n`)
    .join('');
};

export const sessionRevertText = (r: SessionRevertData): string =>
  `${
    [
      r.restored.length === 0 ? null : `restored ${r.restored.join(', ')}`,
      r.removed.length === 0 ? null : `removed ${r.removed.join(', ')}`,
    ]
      .filter((p) => p !== null)
      .join('; ') || `${r.session}: nothing to revert in that turn`
  }\n`;
