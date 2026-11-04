/**
 * A fake `claude` for sessions in a real `tmux`. It reads the `--settings` file it gets and runs
 * that file's hook commands with Claude Code's payloads, one at a time, waiting for each. It writes
 * a transcript where Claude Code would, runs the `abe` commands a test scripts, echoes what is
 * typed into it and keeps its environment. Everything it writes for a test to read goes to
 * `.fake-claude/` in the folder it runs in, which is the session's worktree.
 *
 * Hooks come from the `--settings` file and the managed settings. Those are in
 * `/etc/claude-code/…`, or at the path in `managed-settings-path` beside the fake, as set by
 * `fakeClaude({ managed })`.
 *
 * A test may write a script to `$HOME/fake-claude.json`. Its `{ "steps": [...] }` run in the first
 * turn instead of the default tool call. Its `"replies": { <typed line>: [...] }` are the steps of
 * the turn that a typed line starts. A step is one of:
 *
 * - `{ "hook": <event>, "payload"?: {} }`
 * - `{ "abe": [argv…] }`
 * - `{ "write": { path, text } }`, a file in its folder
 * - `{ "say": <text> }`, the turn's answer
 * - `{ "sleep": <ms> }`
 * - `{ "interrupt": true }`, Esc pressed mid-turn: as Claude Code, the turn stops there with its
 *   `[Request interrupted by user]` line in the transcript and no hook (no Stop)
 * - `{ "subagent": { type, task?, model?, result } }`, an Agent tool call as Claude Code makes one.
 *   That is `PreToolUse`, `SubagentStart`, the subagent's own transcript, `SubagentStop` and
 *   `PostToolUse`. It picks the model as Claude Code does. That is the call's, else the
 *   `--plugin-dir` agent file's, else the main model. A model that `availableModels` lacks runs on
 *   the main model. The subagent's transcript records the model.
 *
 * Like Claude Code, it takes a paste as one message. It turns bracketed paste on, and the lines
 * between the terminal's paste markers are one typed message. `abe session send` and checks'
 * output arrive that way.
 *
 * Like Claude Code 2.1.310, it queues a message typed while a turn runs and takes it at the turn's
 * next step. It sends the message's `UserPromptSubmit` under the running turn's prompt id, then
 * writes its `queued_command` attachment line in the transcript. `.fake-claude/taken.jsonl` lists
 * the messages it took mid-turn, and `typed.jsonl` has each of them too. A message typed as the
 * turn ends starts the next turn.
 *
 * Like Claude Code, it first asks whether to trust a folder that `$HOME/.claude.json` does not
 * trust (`projects[<cwd>].hasTrustDialogAccepted`). It asks before any hook and waits for a typed
 * line. `.fake-claude/trust.json` says whether it asked.
 *
 * With `"dialog": <text>` in its script it shows that text and never starts or runs a hook, as a
 * `claude` stuck on a settings error does.
 *
 * With `-p` it is a one-shot (`scriptOneShot`) that answers its stdin's prompt once and exits.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { allows } from '@abe/core';
import { z } from 'zod';

const Settings = z.object({
  model: z.string().optional(),
  availableModels: z.array(z.string()).optional(),
  effortLevel: z.string().optional(),
  modelPicker: z
    .object({ options: z.array(z.object({ model: z.string(), label: z.string() })) })
    .optional(),
  hooks: z
    .record(
      z.string(),
      z.array(
        z.object({
          matcher: z.string().optional(),
          hooks: z.array(z.object({ type: z.string(), command: z.string() })),
        }),
      ),
    )
    .default({}),
});

const Step = z.union([
  z.object({ hook: z.string(), payload: z.record(z.string(), z.unknown()).optional() }),
  z.object({ abe: z.array(z.string()) }),
  /** A file written in the folder it runs in, such as a prototype chat's change file. */
  z.object({ write: z.object({ path: z.string(), text: z.string() }) }),
  z.object({ say: z.string() }),
  z.object({ sleep: z.number() }),
  z.object({ interrupt: z.literal(true) }),
  z.object({
    subagent: z.object({
      type: z.string(),
      task: z.string().optional(),
      model: z.string().optional(),
      result: z.string(),
    }),
  }),
]);
const Script = z.object({
  steps: z.array(Step),
  replies: z.record(z.string(), z.array(Step)).default({}),
  /** Shown instead of starting, as a `claude` with a settings error does. No hook ever runs. */
  dialog: z.string().optional(),
});

const flag = (argv: readonly string[], name: string) => {
  const i = argv.indexOf(name);

  return i === -1 ? undefined : argv[i + 1];
};

const argv = process.argv.slice(2);

/**
 * `claude -p`, a one-shot. It reads the prompt from stdin and appends the call's argv, env, cwd
 * and prompt to `$HOME/fake-claude-p.jsonl`. The script `$HOME/fake-claude-p.json` sets the answer.
 * `answers[n]` answers the n-th call, and the last one repeats after that. `sleep` waits that many
 * ms before answering and `exit` is the exit code. With no answer it prints a fixed line.
 */
const OneShotScript = z.object({
  answers: z.array(z.string()).default([]),
  exit: z.number().int().default(0),
  sleep: z.number().default(0),
});

// A launch picks a claude by its `claude --version`. This one is new enough.
if (argv[0] === '--version') {
  process.stdout.write('2.1.310 (Claude Code)\n');
  process.exit(0);
}
if (argv.includes('-p')) {
  const home = process.env.HOME ?? process.cwd();
  const calls = join(home, 'fake-claude-p.jsonl');
  const n = existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .split('\n')
        .filter((l) => l !== '').length
    : 0;
  const prompt = await new Response(Bun.stdin.stream()).text();

  appendFileSync(
    calls,
    `${JSON.stringify({ argv, env: process.env, cwd: process.cwd(), prompt })}\n`,
  );
  const file = join(home, 'fake-claude-p.json');
  const script = OneShotScript.parse(
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {},
  );

  if (script.sleep > 0) await Bun.sleep(script.sleep);
  process.stdout.write(`${script.answers[n] ?? script.answers.at(-1) ?? 'fake claude -p'}\n`);
  process.exit(script.exit);
}

const settingsFile = flag(argv, '--settings');
const pluginDir = flag(argv, '--plugin-dir');
// `--resume <id>` goes on with an earlier session, whose transcript must be there already.
const resumed = flag(argv, '--resume');
const sessionId = resumed ?? flag(argv, '--session-id') ?? crypto.randomUUID();
// With no prompt after the instructions, as in a reopened conversation, it waits for one typed.
const prompt = argv.at(-2) === '--append-system-prompt' ? '' : (argv.at(-1) ?? '');
const cwd = process.cwd();
const home = process.env.HOME ?? cwd;
const out = join(cwd, '.fake-claude');

mkdirSync(out, { recursive: true });
// Its own files are no change to the worktree, so checks' diff never sees them.
writeFileSync(join(out, '.gitignore'), '*\n');
writeFileSync(join(out, 'env.json'), `${JSON.stringify(process.env)}\n`);
writeFileSync(join(out, 'argv.json'), `${JSON.stringify(argv)}\n`);

const given = Settings.parse(
  settingsFile === undefined ? {} : JSON.parse(readFileSync(settingsFile, 'utf8')),
);
// Managed settings, where Claude Code reads them on Linux. A test can name another place.
const pointer = join(dirname(process.argv[1] ?? ''), 'managed-settings-path');
const managedFile = existsSync(pointer)
  ? readFileSync(pointer, 'utf8').trim()
  : '/etc/claude-code/managed-settings.json';
const managed = Settings.parse(
  existsSync(managedFile) ? JSON.parse(readFileSync(managedFile, 'utf8')) : {},
);
// Both sources' hooks run, managed first. As in Claude Code, a managed model and model list win.
const settings = {
  model: managed.model ?? given.model,
  availableModels: managed.availableModels ?? given.availableModels,
  hooks: Object.fromEntries(
    [...new Set([...Object.keys(managed.hooks), ...Object.keys(given.hooks)])].map((event) => [
      event,
      [...(managed.hooks[event] ?? []), ...(given.hooks[event] ?? [])],
    ]),
  ),
};
const scriptFile = join(home, 'fake-claude.json');
const script = existsSync(scriptFile)
  ? Script.parse(JSON.parse(readFileSync(scriptFile, 'utf8')))
  : undefined;
const transcriptDir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
const transcript = join(transcriptDir, `${sessionId}.jsonl`);

mkdirSync(transcriptDir, { recursive: true });
if (resumed !== undefined && !existsSync(transcript)) {
  process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
  process.exit(1);
}

const log = (file: string, doc: unknown) => {
  appendFileSync(join(out, file), `${JSON.stringify(doc)}\n`);
};

/** A transcript line as Claude Code writes one, with its own uuid. A user line has `promptId`. */
const said = (role: 'user' | 'assistant', text: string, promptId?: string) => {
  appendFileSync(
    transcript,
    `${JSON.stringify({ type: role, uuid: crypto.randomUUID(), sessionId, timestamp: new Date().toISOString(), ...(promptId === undefined ? {} : { promptId }), message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } })}\n`,
  );
};

const matches = (matcher: string | undefined, payload: Record<string, unknown>) => {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  const tool = payload.tool_name;

  return typeof tool === 'string' && new RegExp(`^(${matcher})$`).test(tool);
};

/**
 * Runs each hook command for `event` as Claude Code does, in `sh -c` with the payload on stdin.
 * It waits for each one.
 */
const hook = async (event: string, extra: Record<string, unknown> = {}) => {
  const payload = {
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    permission_mode: 'default',
    hook_event_name: event,
    ...extra,
  };

  for (const group of settings.hooks[event] ?? []) {
    if (!matches(group.matcher, payload)) continue;
    for (const h of group.hooks) {
      const started = performance.now();
      const child = Bun.spawn(['/bin/sh', '-c', h.command], {
        cwd,
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      log('hooks.jsonl', {
        event,
        exit,
        stdout,
        stderr,
        ms: Math.round(performance.now() - started),
      });
    }
  }
};

/** The `model:` of the plugin's agent file for `type` (`abe:writer`), if there is one. */
const agentModel = (type: string) => {
  const name = type.split(':').at(-1) ?? type;
  const file = pluginDir === undefined ? undefined : join(pluginDir, 'agents', `${name}.md`);

  if (file === undefined || !existsSync(file)) return undefined;

  return /^model: *(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim();
};

let agents = 0;

const subagent = async (s: {
  type: string;
  task?: string | undefined;
  model?: string | undefined;
  result: string;
}) => {
  const main = settings.model ?? 'opus';
  const wanted = s.model ?? agentModel(s.type) ?? main;
  const allowed = settings.availableModels;
  const model = allowed === undefined || allows(allowed, wanted) ? wanted : main;
  const id = `a${String(++agents).padStart(4, '0')}`;
  const toolUse = `toolu_agent_${id}`;
  const input = {
    subagent_type: s.type,
    description: s.task ?? 'a piece of work',
    prompt: s.task ?? 'a piece of work',
    ...(s.model === undefined ? {} : { model: s.model }),
  };
  const agentTranscript = join(transcriptDir, sessionId, 'subagents', `agent-${id}.jsonl`);

  await hook('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: toolUse });
  await hook('SubagentStart', { agent_id: id, agent_type: s.type });
  mkdirSync(join(transcriptDir, sessionId, 'subagents'), { recursive: true });
  appendFileSync(
    agentTranscript,
    `${JSON.stringify({ type: 'assistant', agentId: id, isSidechain: true, message: { role: 'assistant', model, content: s.result } })}\n`,
  );
  await hook('SubagentStop', {
    stop_hook_active: false,
    agent_id: id,
    agent_type: s.type,
    agent_transcript_path: agentTranscript,
    last_assistant_message: s.result,
  });
  await hook('PostToolUse', {
    tool_name: 'Agent',
    tool_input: input,
    tool_response: { content: s.result },
    tool_use_id: toolUse,
  });
};

const runAbe = async (args: readonly string[]) => {
  const child = Bun.spawn(['abe', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  log('abe.jsonl', { argv: args, exit, stdout, stderr });
};

/**
 * Runs a slash command where it is typed, mid-turn too, and returns true. It knows `/model`,
 * `/effort` and `/exit`. Anything else returns false.
 */
const command = async (line: string): Promise<boolean> => {
  if (line === '/model') {
    await picker();

    return true;
  }
  // `/model <name>` and `/effort <level>` set the value and save it as the default for new sessions
  const inline = /^\/(model|effort) (\S+)$/.exec(line);

  if (inline !== null) {
    if (inline[1] === 'model') model = inline[2] ?? model;
    else effort = inline[2] ?? effort;
    saveDefault(inline[1] === 'model' ? { model } : { effortLevel: effort });
    process.stdout.write(`Set ${inline[1]} to ${inline[2] ?? ''} and saved as your default\r\n`);

    return true;
  }
  if (line === '/exit') {
    await hook('SessionEnd', { reason: 'prompt_input_exit' });
    process.exit(0);
  }

  return false;
};

/**
 * Takes what was typed while the turn `promptId` ran, at the turn's next step, as Claude Code
 * 2.1.310 does. It sends `UserPromptSubmit` under the running turn's prompt id, then writes a
 * `queued_command` line.
 */
const takeQueued = async (promptId: string) => {
  while (typed.waiting()) {
    const next = await typed.next();

    if (next.done) return;
    const line = next.value;

    log('typed.jsonl', line);
    if (await command(line)) continue;
    await hook('UserPromptSubmit', { prompt: line, prompt_id: promptId });
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'attachment', uuid: crypto.randomUUID(), isSidechain: false, sessionId, timestamp: new Date().toISOString(), attachment: { type: 'queued_command', prompt: line, commandMode: 'prompt', origin: { kind: 'human' } } })}\n`,
    );
    log('taken.jsonl', line);
  }
};

/** The tool calls whose PreToolUse ran and PostToolUse not yet, by their tool. */
const openCalls: { id: string; tool: string }[] = [];

/**
 * A tool hook's `tool_use_id`, as Claude Code gives them. Each PreToolUse gets a new one. Its
 * PostToolUse gets the same one, from the newest open call of its tool. An AskUserQuestion waiting
 * on you stays open. An id the step names is kept. Ids are unique in the session, across a resume
 * too.
 */
const toolUseId = (step: { hook: string; payload?: Record<string, unknown> | undefined }) => {
  const named = step.payload?.tool_use_id;
  const namedTool = step.payload?.tool_name;
  const tool = typeof namedTool === 'string' ? namedTool : 'Bash';
  const fresh = () => `toolu_fake_${crypto.randomUUID()}`;

  if (step.hook === 'PreToolUse') {
    const id = typeof named === 'string' ? named : fresh();

    openCalls.push({ id, tool });

    return id;
  }
  const open = openCalls.findLastIndex((c) =>
    typeof named === 'string' ? c.id === named : c.tool === tool,
  );
  const [call] = open === -1 ? [] : openCalls.splice(open, 1);

  return typeof named === 'string' ? named : (call?.id ?? fresh());
};

const turn = async (text: string, steps: readonly z.infer<typeof Step>[] | undefined) => {
  const promptId = crypto.randomUUID();

  await hook('UserPromptSubmit', { prompt: text, prompt_id: promptId });
  said('user', text, promptId);
  let answer = text === prompt ? `Done: ${text.split('\n')[0] ?? ''}` : `You said: ${text}`;

  for (const step of steps ?? [{ hook: 'PreToolUse' }, { hook: 'PostToolUse' }]) {
    await takeQueued(promptId);
    if ('hook' in step) {
      const tool =
        step.hook === 'PreToolUse' || step.hook === 'PostToolUse'
          ? { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: toolUseId(step) }
          : {};

      await hook(step.hook, { ...tool, ...step.payload });
    } else if ('abe' in step) await runAbe(step.abe);
    else if ('write' in step) {
      mkdirSync(dirname(join(cwd, step.write.path)), { recursive: true });
      writeFileSync(join(cwd, step.write.path), step.write.text);
    } else if ('subagent' in step) await subagent(step.subagent);
    else if ('interrupt' in step) {
      said('user', '[Request interrupted by user]', promptId);
      process.stdout.write('Interrupted · What should Claude do instead?\n');

      return;
    } else if ('say' in step) answer = step.say;
    else await Bun.sleep(step.sleep);
  }
  await takeQueued(promptId);
  said('assistant', answer);
  process.stdout.write(`${answer}\n`);
  await hook('Stop', { stop_hook_active: false, last_assistant_message: answer });
};

const Trust = z.object({
  projects: z.record(z.string(), z.object({ hasTrustDialogAccepted: z.boolean().optional() })),
});

/** Whether Claude Code's config in `$HOME` trusts this folder, by its given name or real path. */
const trusted = () => {
  try {
    const config = Trust.parse(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')));

    return [cwd, realpathSync(cwd)].some(
      (p) => config.projects[p]?.hasTrustDialogAccepted === true,
    );
  } catch {
    return false;
  }
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** The keys it knows by their escape sequence. In raw mode, tmux's `send-keys Down` sends these. */
const KEYS: Record<string, string> = {
  '\x1b[A': 'Up',
  '\x1b[B': 'Down',
  '\x1b[C': 'Right',
  '\x1b[D': 'Left',
  '\x1bOA': 'Up',
  '\x1bOB': 'Down',
  '\x1bOC': 'Right',
  '\x1bOD': 'Left',
};

/**
 * What is typed into it, read raw a key at a time as Claude Code reads it. That way its `/model`
 * picker takes keys with no Enter after them. A line ends at Enter. A bracketed paste's lines and
 * what follows them up to Enter are one message.
 */
const input = (() => {
  let buffer = '';
  let ended = false;
  let wake: (() => void) | undefined;
  const decoder = new TextDecoder();

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    // Typed text shows in the input, as in Claude Code: Abe's send waits for it before its Enter
    // eslint-disable-next-line no-control-regex -- keys and paste marks are not shown
    const shown = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b[OA-Z]?|[\r\n]/g, '');

    if (shown !== '') process.stdout.write(shown);
    buffer += text;
    wake?.();
  });
  process.stdin.on('end', () => {
    ended = true;
    wake?.();
  });
  const more = () =>
    new Promise<void>((r) => {
      wake = r;
    });

  return {
    /** Whether an Enter outside a paste has ended a whole message. If so, `next` has it now. */
    waiting: (): boolean => {
      let rest = buffer;

      for (;;) {
        const paste = rest.indexOf(PASTE_START);
        const enter = rest.search(/[\r\n]/);

        if (paste === -1 || (enter !== -1 && enter < paste)) return enter !== -1;
        const end = rest.indexOf(PASTE_END, paste);

        if (end === -1) return false;
        rest = rest.slice(end + PASTE_END.length);
      }
    },
    /** The next key: a character, Enter, a paste's text, `Escape` or an arrow's name. */
    key: async (): Promise<{ kind: 'char' | 'paste' | 'key'; value: string } | undefined> => {
      for (;;) {
        if (buffer.startsWith(PASTE_START)) {
          const end = buffer.indexOf(PASTE_END);

          if (end !== -1) {
            const value = buffer.slice(PASTE_START.length, end).replace(/\r\n?/g, '\n');

            buffer = buffer.slice(end + PASTE_END.length);

            return { kind: 'paste', value };
          }
        } else if (buffer.startsWith('\x1b')) {
          const seq = Object.keys(KEYS).find((k) => buffer.startsWith(k));

          if (seq !== undefined) {
            buffer = buffer.slice(seq.length);

            return { kind: 'key', value: KEYS[seq] ?? '' };
          }
          // A lone Esc, with no more of a sequence after it
          if (buffer.length === 1 || !'[O'.includes(buffer[1] ?? '')) {
            buffer = buffer.slice(1);

            return { kind: 'key', value: 'Escape' };
          }
        } else if (buffer.length > 0) {
          const value = buffer[0] ?? '';

          buffer = buffer.slice(1);

          return value === '\r' || value === '\n'
            ? { kind: 'key', value: 'Enter' }
            : { kind: 'char', value };
        }
        if (ended) return undefined;
        await more();
      }
    },
  };
})();

/** The next message typed, up to Enter. A paste's lines stay in it as they were. */
const typed = {
  waiting: input.waiting,
  next: async (): Promise<{ done: true } | { done: false; value: string }> => {
    let line = '';

    for (;;) {
      const key = await input.key();

      if (key === undefined) return { done: true };
      if (key.kind === 'key' && key.value === 'Enter') return { done: false, value: line };
      if (key.kind !== 'key') line += key.value;
    }
  },
};

/** What Claude Code's `/model` and `/effort` save as the default for new sessions. */
const saveDefault = (change: Record<string, string>) => {
  const file = join(home, '.claude', 'settings.json');
  const read: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const was = z.record(z.string(), z.unknown()).safeParse(read).data ?? {};

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...was, ...change }, null, 2)}\n`);
};

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
let model = given.model ?? 'opus';
let effort = given.effortLevel ?? 'medium';

/**
 * `/model` alone opens Claude Code 2.1.310's picker. Its rows are the settings' `modelPicker`,
 * Default first, and focus starts on the model in use. ↑/↓ move and wrap. ←/→ change the effort.
 * Enter sets the model as the default for new sessions and saves it. `s` sets it for this session
 * only. Esc keeps the current one.
 */
const picker = async () => {
  const rows = ['Default (recommended)', ...(given.modelPicker?.options.map((o) => o.label) ?? [])];
  const models = ['default', ...(given.modelPicker?.options.map((o) => o.model) ?? [])];
  let focus = Math.max(0, models.indexOf(model));
  let level = Math.max(0, LEVELS.indexOf(effort));
  const draw = () => {
    process.stdout.write(
      [
        '\x1b[2J\x1b[H❯ /model',
        '────',
        '  Select model',
        ...rows.map(
          (r, i) => `  ${i === focus ? '❯' : ' '} ${i + 1}. ${r}${models[i] === model ? ' ✔' : ''}`,
        ),
        '',
        `  ${LEVELS[level] ?? ''} effort ←/→ to adjust`,
        '',
        '  Enter to set as default · s to use this session only · Esc to cancel',
        '',
      ].join('\r\n'),
    );
  };
  const said = (text: string) => {
    process.stdout.write(`\x1b[2J\x1b[H❯ /model\r\n  ⎿  ${text}\r\n`);
  };

  draw();
  for (;;) {
    const key = await input.key();

    if (key === undefined) return;
    log('keys.jsonl', key.value);
    if (key.value === 'Down' || key.value === 'Up')
      focus = (focus + (key.value === 'Down' ? 1 : rows.length - 1)) % rows.length;
    else if (key.value === 'Left' || key.value === 'Right')
      level = Math.min(LEVELS.length - 1, Math.max(0, level + (key.value === 'Left' ? -1 : 1)));
    else if (key.value === 'Escape') {
      said(`Kept model as ${model}`);

      return;
    } else if (key.value === 's' || key.value === 'Enter') {
      model = models[focus] ?? model;
      effort = LEVELS[level] ?? effort;
      if (key.value === 'Enter') {
        saveDefault({ model, effortLevel: effort });
        said(`Set model to ${model} and saved as your default for new sessions`);

        return;
      }
      said(`Set model to ${model} for this session only with ${effort} effort`);

      return;
    }
    draw();
  }
};

process.stdout.write('\x1b[?2004h');
const asked = !trusted();

writeFileSync(join(out, 'trust.json'), `${JSON.stringify({ asked })}\n`);
if (asked) {
  process.stdout.write(
    'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n',
  );
  await typed.next();
}
if (script?.dialog !== undefined) {
  process.stdout.write(`${script.dialog}\n`);
  for (;;) if ((await typed.next()).done) process.exit(1);
}
process.stdout.write(`fake claude ${sessionId}\n`);
await hook('SessionStart', { source: resumed === undefined ? 'startup' : 'resume', model: 'fake' });
// Resumed with no prompt, as on a reopen, it waits at its prompt as Claude Code does.
// A resumed session's prompt is a message to its conversation, and its turn is the line's reply.
if (resumed === undefined) await turn(prompt, script?.steps);
else if (prompt !== '') await turn(prompt, script?.replies[prompt]);

for (;;) {
  const next = await typed.next();

  if (next.done) break;
  const line = next.value;

  log('typed.jsonl', line);
  if (!(await command(line))) await turn(line, script?.replies[line]);
}
