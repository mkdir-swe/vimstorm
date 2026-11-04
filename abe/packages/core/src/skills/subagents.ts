/**
 * Subagents (ADR 0020 CC7, ticket #65): core's two agent definitions, `reader` and `writer`, in
 * the one Claude Code plugin every session loads (`--plugin-dir`), their models lowered by the
 * `allowedModels` setting, and the subagent runs a session's hooks show. Where a run stands comes
 * from the hooks only (`PreToolUse` of the Agent tool, `SubagentStart`, `SubagentStop`); the
 * transcripts are kept as logs and never read for it.
 */
import { z } from 'zod';
import { CORE_SKILLS } from './skills';

/** The plugin's name: its agents are `abe:reader` and `abe:writer`, its skills `/abe:<skill>`. */
export const PLUGIN_NAME = 'abe';

/** A file of the session's plugin folder: its path inside the folder and its text. */
export type PluginFile = { path: string; text: string };

/** The agents of core's plugin. */
export const SUBAGENT_NAMES = ['reader', 'writer'] as const;
export type SubagentName = (typeof SUBAGENT_NAMES)[number];

type Definition = {
  description: string;
  /** The models it runs on by preference, best first (ADR 0020 CC7). */
  wants: readonly string[];
  /** Frontmatter lines besides name, description and model. */
  more: readonly string[];
  body: string;
};

/** What the coordinator runs on by preference. */
const COORDINATOR_WANTS = ['opus'] as const;

const DEFINITIONS: Readonly<Record<SubagentName, Definition>> = {
  reader: {
    description:
      "Reads, searches and reviews in the session's own workspace and changes nothing. Use for exploring code, reading a card's links, gathering facts for a decision, and the code review.",
    wants: ['sonnet', 'haiku'],
    // Read tools, plus Bash for `git diff` / `git log`, `abe … show` and test runs: what a reader
    // may run is its prompt's rule (and Reach's permission rules, #41), not the tool list.
    // `disallowedTools` names the editing tools again as a second guard, should `tools` grow.
    more: [
      'tools: Read, Grep, Glob, Bash, WebFetch, WebSearch',
      'disallowedTools: Edit, Write, NotebookEdit',
      'color: cyan',
    ],
    body: `You are a reader: a subagent the coordinator started for one piece of reading. You share the coordinator's workspace, so you leave it exactly as you found it.

- Read, search and run commands that only look: \`git log\`, \`git diff\`, \`git show\`, \`git status\`, \`abe … show\`, \`abe … status\`, and test runs that write nothing outside \`.scratch/\`.
- Edit no file, commit nothing, start no server, install nothing. When the brief seems to need a change, reply with the change you would make instead.
- Answer the brief's question and stop. Reply with the result in the shape the brief asks for, citing \`file:line\` for every claim about the code, under the length the brief gives, else under 400 words.
`,
  },
  writer: {
    description:
      'Writes code for one ticket in its own git worktree off the card branch, test-first, and commits there for the coordinator to merge; a big ticket it may split among writers of its own. Use for every code change bigger than a few lines.',
    wants: ['opus'],
    more: ['isolation: worktree', 'color: green'],
    body: `You are a writer: a subagent the coordinator started for one ticket of a card. You work in your own git worktree, branched from the card branch; the coordinator merges your branch when you return.

1. Check where you are: \`git rev-parse --show-toplevel\` and \`git branch --show-current\`. When the top folder is the coordinator's own worktree (the brief names it), stop and reply \`no worktree\`, changing nothing. When the brief names the branch to start from (a writer's writer: its writer's branch) and yours is not on it, \`git reset --hard <that branch>\` first.
2. Build the ticket test-first at the seams the brief names: a failing test, then the code that makes it pass.
3. Run the typecheck and the test files you touched; all green before you commit. The full suite is the coordinator's, at a milestone. A command that cannot run here (\`command not found\`, refused by the sandbox) is not green: say so, never work around it with a tool path of your own.
4. Commit on your branch in the repo's commit style. Push nothing.
5. Reply with exactly: your branch, your worktree path, your commits (\`git log --oneline\` since you started), each command you ran with its exit code, and one line per completion criterion with the test that shows it. A check that did not run is \`not run\` with why, never as a pass.

Stay inside the ticket's files. When it needs a file the brief did not give you, say so in your reply rather than editing it, because another writer may own it.

A ticket the brief marks \`Big\` you may split: hand parts with files that do not overlap to writers of your own (\`abe:writer\`), each brief naming your branch to start from and your worktree as the one not to write in, then merge each one's branch into yours (\`git merge --no-ff <its branch>\`) before you reply. Name their commits in your reply too.
`,
  },
};

/**
 * Whether `allowed` has `model`: the same name, or one names the other's family (`sonnet` and
 * `claude-sonnet-4-6`), as Claude Code's `availableModels` matches a family alias.
 */
export const allows = (allowed: readonly string[], model: string): boolean =>
  allowed.some((m) => m === model || m.includes(model) || model.includes(m));

/**
 * The model an agent runs on: the first it wants that `allowed` has (an allowed entry names the
 * model family, `sonnet`, or a full id containing it), else the first allowed one.
 */
export const allowedModel = (wants: readonly string[], allowed: readonly string[]): string => {
  for (const want of wants) {
    const found = allowed.find((m) => allows([m], want));

    if (found !== undefined) return found;
  }

  return allowed[0] ?? wants[0] ?? 'inherit';
};

/** The models of one session: its coordinator's and each of core's agents'. */
export const SessionModels = z.object({
  coordinator: z.string(),
  reader: z.string(),
  writer: z.string(),
} satisfies Record<'coordinator' | SubagentName, z.ZodString>);
export type SessionModels = z.infer<typeof SessionModels>;

/**
 * A session's models: each the one a Layer asks for (`models.coordinator`, `models.reader`,
 * `models.writer`; a prototype chat's `prototype.model` for all three, #350) when `allowed` has it,
 * else the first allowed; with none asked, core's preferences.
 */
export const sessionModels = (
  allowed: readonly string[],
  wants?: Readonly<SessionModels>,
): SessionModels => ({
  coordinator: allowedModel(wants === undefined ? COORDINATOR_WANTS : [wants.coordinator], allowed),
  reader: allowedModel(wants === undefined ? DEFINITIONS.reader.wants : [wants.reader], allowed),
  writer: allowedModel(wants === undefined ? DEFINITIONS.writer.wants : [wants.writer], allowed),
});

/** One agent file, `agents/<name>.md`, on `model`. */
export const agentFile = (name: SubagentName, model: string): PluginFile => {
  const d = DEFINITIONS[name];

  return {
    path: `agents/${name}.md`,
    text: `---\nname: ${name}\ndescription: ${d.description}\nmodel: ${model}\n${d.more.join('\n')}\n---\n\n${d.body}`,
  };
};

const MANIFEST = {
  name: PLUGIN_NAME,
  displayName: 'Abe core',
  description:
    "Abe's core Layer for Claude Code: the Factory skills and the reader and writer agents.",
  author: { name: 'Abe' },
};

/**
 * The core skills, `skills/<name>/SKILL.md` and their files (`skills.ts`); the plugin's `skills/`
 * folder is Claude Code's default place, so the manifest names no path.
 */
export const PLUGIN_SKILLS: readonly PluginFile[] = CORE_SKILLS;

/** The session's plugin folder: the manifest, the skills, and the agents on the session's models. */
export const sessionPlugin = (models: SessionModels): PluginFile[] => [
  { path: '.claude-plugin/plugin.json', text: `${JSON.stringify(MANIFEST, null, 2)}\n` },
  ...PLUGIN_SKILLS,
  ...SUBAGENT_NAMES.map((name) => agentFile(name, models[name])),
];

/** The plugin's agent behind an `agent_type` (`abe:writer`), if it is one. */
export const coreAgent = (type: string): SubagentName | undefined =>
  SUBAGENT_NAMES.find((name) => type === `${PLUGIN_NAME}:${name}`);

export const SUBAGENT_STATES = ['running', 'done'] as const;
export type SubagentState = (typeof SUBAGENT_STATES)[number];

/** One subagent run of a session, as `abe session show` lists it. */
export const SubagentRun = z.object({
  /** Claude Code's `agent_id`. */
  id: z.string(),
  /** Its `agent_type`: `abe:reader`, `abe:writer`, or another agent (`Explore`). */
  name: z.string(),
  /** The Agent call's `description`, when its `PreToolUse` came first. */
  task: z.string().nullable(),
  /** The Agent call's model, else the model the session rendered its definition on; null when neither says. */
  model: z.string().nullable(),
  state: z.enum(SUBAGENT_STATES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** The first line of its `last_assistant_message`, from `SubagentStop`. */
  result: z.string().nullable(),
  /** Its last tool call, from its own `PreToolUse` (`Bash git status`, `Read cart.ts`). */
  tool: z.string().nullable().optional(),
  /** Its tool calls so far. */
  tools: z.number().int().nonnegative().optional(),
  /** When it last called a tool (its start before any): how long it has been silent. */
  lastAt: z.iso.datetime().nullable().optional(),
  /** Its coordinator was told it went silent with no hand-back (`silentSubagents`): once. */
  silentTold: z.boolean().optional(),
  /** The coordinator's Agent call that started it (its `tool_use_id`): its row in the transcript. */
  call: z.string().nullable().optional(),
  /** Its own transcript as Claude Code writes it (`…/subagents/agent-<id>.jsonl`). */
  transcript: z.string().nullable().optional(),
});
export type SubagentRun = z.infer<typeof SubagentRun>;

/** How long a run with no `SubagentStop` still counts as running (its hook may have been lost). */
export const SUBAGENT_RUN_MAX_MS = 60 * 60 * 1000;

/**
 * Whether a subagent runs that the coordinator may be waiting on at `at`: one started no more than
 * `SUBAGENT_RUN_MAX_MS` ago and not ended.
 */
export const subagentRunning = (runs: readonly SubagentRun[], at: string): boolean =>
  runs.some(
    (r) => r.state === 'running' && Date.parse(at) - Date.parse(r.startedAt) <= SUBAGENT_RUN_MAX_MS,
  );

/** How long a running subagent may go with no tool call before its coordinator is told. */
export const SUBAGENT_SILENT_MS = 15 * 60 * 1000;

/**
 * The running subagents silent at `at`: no tool call for `SUBAGENT_SILENT_MS` and no hand-back
 * (`SubagentStop`), their coordinator not told yet. A background one that stopped this way is
 * otherwise waited on for ever.
 */
export const silentSubagents = (runs: readonly SubagentRun[], at: string): SubagentRun[] =>
  runs.filter(
    (r) =>
      r.state === 'running' &&
      r.silentTold !== true &&
      Date.parse(at) - Date.parse(r.lastAt ?? r.startedAt) >= SUBAGENT_SILENT_MS,
  );

/** What a coordinator is told of a silent subagent (`silentSubagents`). */
export const silentSubagentPrompt = (r: SubagentRun): string =>
  `Abe: your subagent ${r.name}${r.task === null ? '' : ` (${r.task})`} has made no tool call for ${SUBAGENT_SILENT_MS / 60_000} minutes and has not handed back${r.lastAt === null || r.lastAt === undefined ? '' : ` (last at ${r.lastAt})`}. Read its transcript${r.transcript === null || r.transcript === undefined ? '' : ` (${r.transcript})`}, then resume it or start the step again; do not wait on it.`;

/** An Agent tool call seen in `PreToolUse`, waiting for its `SubagentStart`. */
export const AgentCall = z.object({
  type: z.string(),
  model: z.string().nullable(),
  task: z.string().nullable(),
  /** Its `tool_use_id`. */
  call: z.string().nullable().optional(),
});
export type AgentCall = z.infer<typeof AgentCall>;

/** What a session keeps to follow its subagents. */
export type Subagents = { calls: AgentCall[]; runs: SubagentRun[] };

/** Claude Code's tool that starts a subagent (named `Task` before 2.1). */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const text = z.string().optional().catch(undefined);

/**
 * The fields of a hook's payload the subagents are followed by, each read leniently (one of
 * another type reads as absent): part of the session's `HookPayload`, parsed once with it.
 */
export const AGENT_HOOK_FIELDS = {
  agent_id: text,
  agent_type: text,
  last_assistant_message: text,
  tool_name: text,
  tool_use_id: text,
  transcript_path: text,
  agent_transcript_path: text,
  tool_input: z
    .looseObject({
      subagent_type: text,
      model: text,
      description: text,
      command: text,
      file_path: text,
      path: text,
      pattern: text,
      url: text,
      query: text,
    })
    .optional()
    .catch(undefined),
};

/** A hook's payload as `subagentsAfter` reads it. */
export type AgentHook = z.output<z.ZodObject<typeof AGENT_HOOK_FIELDS>>;

const TOOL_MAX = 60;

/** The parts of a tool call's input its one line names. */
type ToolInput = {
  command?: string | undefined;
  file_path?: string | undefined;
  path?: string | undefined;
  pattern?: string | undefined;
  url?: string | undefined;
  query?: string | undefined;
};

/** A subagent's tool call in one short line: `Bash git status`, `Read cart.ts`, `Grep total`. */
export const subagentToolWords = (name: string, input: ToolInput = {}): string => {
  const file = input.file_path ?? input.path;
  const what =
    input.command ??
    (file === undefined ? undefined : file.split('/').at(-1)) ??
    input.pattern ??
    input.url ??
    input.query;
  const line = what === undefined ? name : `${name} ${what.split('\n')[0]?.trim() ?? ''}`.trim();

  return line.length > TOOL_MAX ? `${line.slice(0, TOOL_MAX - 1)}…` : line;
};

/** A run after one of its own tool calls. */
const toolCalled = (
  run: SubagentRun,
  name: string,
  input: ToolInput | undefined,
  at: string,
): SubagentRun => ({
  ...run,
  tool: subagentToolWords(name, input),
  tools: (run.tools ?? 0) + 1,
  lastAt: at,
  silentTold: false,
});

/** Where Claude Code writes a subagent's own transcript: beside its session's, by its id. */
export const agentTranscript = (sessionTranscript: string, agent: string): string =>
  `${sessionTranscript.replace(/\.jsonl$/, '')}/subagents/agent-${agent}.jsonl`;

const RESULT_MAX = 160;

/** The first non-empty line of a message, cut to one readable line. */
export const oneLine = (message: string): string | null => {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');

  if (line === undefined) return null;

  return line.length > RESULT_MAX ? `${line.slice(0, RESULT_MAX - 1)}…` : line;
};

/** Whether an Agent call of `call` asked for the agent `type` (`writer` or `abe:writer`). */
const callFor = (call: string, type: string) =>
  call === type || type.endsWith(`:${call}`) || call.endsWith(`:${type}`);

/**
 * The model a run is on: a model the Agent call named, held to `allowedModels` the way Claude
 * Code's `availableModels` holds it (a model it lacks runs on the coordinator's); else the model
 * the session rendered core's agent on; else unknown (another agent's own default).
 */
const runModel = (
  call: AgentCall | undefined,
  type: string,
  models: SessionModels | null,
  allowed: readonly string[],
): string | null => {
  const asked = call?.model ?? null;

  if (asked !== null) return allows(allowed, asked) ? asked : (models?.coordinator ?? null);
  const own = coreAgent(type);

  return own === undefined || models === null ? null : models[own];
};

/**
 * The subagents after a hook: an Agent call's `PreToolUse` is held until its `SubagentStart`
 * (matched by agent type, oldest first) starts a run; `SubagentStop` ends it with its result.
 * `changed` is the run a `session.subagent` event tells about.
 */
export const subagentsAfter = (
  book: Subagents,
  event: string,
  p: AgentHook,
  o: { at: string; models: SessionModels | null; allowed: readonly string[] },
): { book: Subagents; changed?: SubagentRun } => {
  // A turn's Agent calls have all started by its end; one denied or failed never will.
  if (event === 'Stop' || event === 'StopFailure')
    return { book: book.calls.length === 0 ? book : { ...book, calls: [] } };
  if (
    (event === 'PostToolUseFailure' || event === 'PermissionDenied') &&
    AGENT_TOOLS.has(p.tool_name ?? '')
  ) {
    const type = p.tool_input?.subagent_type ?? 'general-purpose';
    const at = book.calls.findIndex((c) => c.type === type);

    return at === -1
      ? { book }
      : { book: { ...book, calls: book.calls.filter((_, i) => i !== at) } };
  }
  if (event === 'PreToolUse' && AGENT_TOOLS.has(p.tool_name ?? '')) {
    const input = p.tool_input;
    const call: AgentCall = {
      type: input?.subagent_type ?? 'general-purpose',
      model: input?.model ?? null,
      task: input?.description ?? null,
      call: p.tool_use_id ?? null,
    };
    // an Agent call of a subagent's own counts as its tool call too
    const by = p.agent_id === undefined ? undefined : book.runs.find((r) => r.id === p.agent_id);
    const runs =
      by === undefined
        ? book.runs
        : book.runs.map((r) => (r === by ? toolCalled(r, p.tool_name ?? 'Agent', input, o.at) : r));
    const changed = by === undefined ? undefined : runs.find((r) => r.id === by.id);

    return {
      book: { calls: [...book.calls, call], runs },
      ...(changed === undefined ? {} : { changed }),
    };
  }
  // a subagent's own tool call: its last tool, counted
  if (event === 'PreToolUse' && p.agent_id !== undefined) {
    const by = book.runs.find((r) => r.id === p.agent_id && r.state === 'running');

    if (by === undefined) return { book };
    const run = toolCalled(by, p.tool_name ?? 'tool', p.tool_input, o.at);

    return { book: { ...book, runs: book.runs.map((r) => (r === by ? run : r)) }, changed: run };
  }
  // Claude Code's own helpers (a background agent's progress line) stop with no type and no start.
  const known = book.runs.some((r) => r.id === p.agent_id);

  if ((p.agent_type ?? '') === '' && !known) return { book };
  if (event === 'SubagentStart' && p.agent_id !== undefined) {
    const type = p.agent_type ?? 'unknown';
    const at = book.calls.findIndex((c) => callFor(c.type, type));
    const call = at === -1 ? undefined : book.calls[at];
    const run: SubagentRun = {
      id: p.agent_id,
      name: type,
      task: call?.task ?? null,
      model: runModel(call, type, o.models, o.allowed),
      state: 'running',
      startedAt: o.at,
      endedAt: null,
      result: null,
      tool: null,
      tools: 0,
      call: call?.call ?? null,
      transcript:
        p.transcript_path === undefined ? null : agentTranscript(p.transcript_path, p.agent_id),
    };

    return {
      book: {
        calls: book.calls.filter((_, i) => i !== at),
        runs: [...book.runs.filter((r) => r.id !== run.id), run],
      },
      changed: run,
    };
  }
  if (event === 'SubagentStop' && p.agent_id !== undefined) {
    const id = p.agent_id;
    const type = p.agent_type ?? 'unknown';
    const before = book.runs.find((r) => r.id === id);
    const run: SubagentRun = {
      ...(before ?? {
        id,
        name: type,
        task: null,
        model: runModel(undefined, type, o.models, o.allowed),
        startedAt: o.at,
        tool: null,
        tools: 0,
        call: null,
      }),
      state: 'done',
      endedAt: o.at,
      result: oneLine(p.last_assistant_message ?? ''),
      transcript: p.agent_transcript_path ?? before?.transcript ?? null,
    };

    return {
      book: {
        ...book,
        runs:
          before === undefined
            ? [...book.runs, run]
            : book.runs.map((r) => (r.id === id ? run : r)),
      },
      changed: run,
    };
  }

  return { book };
};

/** One run as `abe session show` and `abe watch` say it. */
export const subagentText = (
  r: Pick<SubagentRun, 'name' | 'model' | 'state' | 'task' | 'result'>,
): string =>
  `${r.name} on ${r.model ?? 'its own model'} ${r.state === 'running' ? 'running' : 'done'}${
    r.task === null ? '' : ` (${r.task})`
  }${r.result === null ? '' : `: ${r.result}`}`;
