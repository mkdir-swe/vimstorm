/**
 * A Factory run's permission prompts in a workspace (#67): nobody is at them, and a dialog nobody
 * sees holds the run for good, so its hook answers them. Only an unattended session's (serve's
 * `SessionMeta.unattended`); a person's session keeps Claude Code's own dialog.
 *
 * - Bash: allowed only while it stays in the sandbox (`dangerouslyDisableSandbox` refused; the
 *   managed settings' `allowUnsandboxedCommands: false` already ignores it).
 * - Read / Glob / Grep: allowed only inside the workspace (`/workspace`: the clone and its
 *   worktrees), by the path as written (`..` resolved) and by its real path (links resolved), which
 *   the hook adds inside the container (`withRealPaths`): serve does not see the container's files.
 * - The session's browser (`mcp__chrome-devtools__*`): allowed.
 * - Anything else: refused, saying what to do instead.
 *
 * The deny rules were applied before any prompt. Light on purpose: the hook loads it.
 *
 * Not closed here, and it cannot be: a time-of-check race. The hook resolves links when the prompt
 * comes and the tool reads later, so an always-allowed sandboxed Bash can re-point a link in
 * between (the hook never sees the read). What keeps the container's secrets from a file tool is
 * the managed deny rules on every one of them (`box-session.ts`: `CONTAINER_SECRETS`, whose test
 * fails a secret path no deny rule covers), not this check.
 */
import { z } from 'zod';

/** POSIX paths as text (core does no IO): `.` and `..` folded, `..` never above the root. */
const normalize = (path: string): string => {
  const parts: string[] = [];
  const rooted = path.startsWith('/');

  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else if (!rooted) parts.push('..');
  }
  const joined = parts.join('/');

  if (rooted) return `/${joined}`;

  return joined === '' ? '.' : joined;
};
const join = (a: string, b: string) => normalize(`${a}/${b}`);
const resolve = (cwd: string, path: string) =>
  normalize(path.startsWith('/') ? path : `${cwd}/${path}`);
const dirname = (path: string) => {
  const at = path.lastIndexOf('/');

  return at <= 0 ? '/' : path.slice(0, at);
};
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * What Claude Code reads from a PermissionRequest hook's stdout: the prompt answered for the
 * person, who then never sees it.
 */
export const PermissionAnswer = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: z.discriminatedUnion('behavior', [
      z.object({ behavior: z.literal('allow') }),
      z.object({ behavior: z.literal('deny'), message: z.string() }),
    ]),
  }),
});
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;

/**
 * What Claude Code reads from a PreToolUse hook's stdout: AskUserQuestion denied, so the question
 * is asked in Abe's Chat and the turn ends (#114).
 */
export const PreToolAnswer = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: z.literal('deny'),
    permissionDecisionReason: z.string(),
  }),
});
export type PreToolAnswer = z.infer<typeof PreToolAnswer>;

/** Any answer serve gives a hook to print: a PermissionRequest's or a PreToolUse's. */
export const HookAnswer = z.union([PermissionAnswer, PreToolAnswer]);
export type HookAnswer = z.infer<typeof HookAnswer>;

/** A JSON text, parsed: a reply's line and its `stdout` both go through it. */
const JsonText = z.string().transform((text, ctx) => {
  try {
    const doc: unknown = JSON.parse(text);

    return doc;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not JSON' });

    return z.NEVER;
  }
});

/**
 * Serve's reply to the hook's PermissionRequest (`abe hook PermissionRequest … --json`), the
 * socket's line as it came: its `stdout` is the CLI's `{"ok":true,"data":{…,"answer"}}`, the
 * answer in Claude Code's shape. Anything else is no answer, and the person decides.
 */
export const PermissionReply = JsonText.pipe(
  z.object({
    stdout: JsonText.pipe(
      z.object({ ok: z.literal(true), data: z.object({ answer: PermissionAnswer }) }),
    ),
  }),
);

/**
 * Serve's reply to a hook that may be answered (a PermissionRequest, AskUserQuestion's
 * PreToolUse): its answer to print, either of Claude Code's shapes, for the event it was asked.
 */
export const HookReply = JsonText.pipe(
  z.object({
    stdout: JsonText.pipe(
      z.object({ ok: z.literal(true), data: z.object({ answer: HookAnswer }) }),
    ),
  }),
);

/** One auto-answer as the session's `hooks.jsonl` keeps it: no input beyond a short summary. */
export const PermissionLog = z.object({
  tool: z.string(),
  behavior: z.enum(['allow', 'deny']),
  reason: z.string(),
  input: z.string(),
});
export type PermissionLog = z.infer<typeof PermissionLog>;

/** The payload key the hook adds: each path a file tool reaches → its real path. */
export const REAL_PATHS = 'abe_real_paths';

/** Claude Code's PermissionRequest input (`tool_name`, `tool_input`, `cwd`), plus the hook's key. */
const Prompt = z.looseObject({
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
  cwd: z.string().optional(),
  [REAL_PATHS]: z.record(z.string(), z.string()).optional(),
});
type Prompt = z.infer<typeof Prompt>;

const BashInput = z.looseObject({
  command: z.string(),
  dangerouslyDisableSandbox: z.boolean().optional(),
});
const ReadInput = z.looseObject({ file_path: z.string() });
/** Glob's and Grep's: a pattern, and the folder (or file) searched, the cwd when none. */
const SearchInput = z.looseObject({ pattern: z.string(), path: z.string().optional() });

const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);
const BROWSER = 'mcp__chrome-devtools__';
const GLOB_CHARS = /[*?[\]{}!]/;
const SUMMARY_MAX = 120;

const NEEDS_YOU = 'abe factory needs-you --reason "<what you need>"';

/** A prompt's `tool_input`, read once by its `tool_name`. */
type ToolInput =
  | { tool: 'Bash'; command: string; outside: boolean }
  | { tool: 'Read'; path: string }
  | { tool: 'Glob' | 'Grep'; pattern: string; path: string | undefined }
  | { tool: 'browser' }
  /** Bash or a file tool whose input is not its shape. */
  | { tool: 'unreadable' }
  | { tool: 'other' };

const toolInputOf = (name: string, input: unknown): ToolInput => {
  if (name === 'Bash') {
    const bash = BashInput.safeParse(input);

    return bash.success
      ? {
          tool: 'Bash',
          command: bash.data.command,
          outside: bash.data.dangerouslyDisableSandbox === true,
        }
      : { tool: 'unreadable' };
  }
  if (name === 'Read') {
    const read = ReadInput.safeParse(input);

    return read.success ? { tool: 'Read', path: read.data.file_path } : { tool: 'unreadable' };
  }
  if (name === 'Glob' || name === 'Grep') {
    const search = SearchInput.safeParse(input);

    return search.success
      ? { tool: name, pattern: search.data.pattern, path: search.data.path }
      : { tool: 'unreadable' };
  }

  return name.startsWith(BROWSER) ? { tool: 'browser' } : { tool: 'other' };
};

/** A prompt as decided on: its tool's name, its input read once, the cwd and the real paths. */
type Asked = {
  name: string;
  input: ToolInput;
  cwd: string | undefined;
  real: Readonly<Record<string, string>>;
};

const askedFrom = (p: Prompt): Asked => ({
  name: p.tool_name,
  input: toolInputOf(p.tool_name, p.tool_input),
  cwd: p.cwd,
  real: p[REAL_PATHS] ?? {},
});

const askedOf = (payload: unknown): Asked | undefined => {
  const p = Prompt.safeParse(payload);

  return p.success ? askedFrom(p.data) : undefined;
};

type Paths = { ok: true; paths: string[] } | { ok: false; reason: string };

/** A path as written, made absolute against the cwd (`..` resolved); undefined for `~` or no cwd. */
export const absolutePath = (path: string, cwd: string | undefined): string | undefined => {
  if (path.startsWith('~')) return undefined;
  if (path.startsWith('/')) return normalize(path);

  return cwd === undefined ? undefined : resolve(cwd, path);
};

/**
 * Why a glob is refused before its folder is looked at: a `..` anywhere (a brace's `{..,x}` too),
 * a `~`, or a brace holding a `/` (`{a,/etc}`), any of which can reach past its folder.
 */
const globRefusal = (pattern: string): string | undefined => {
  if (pattern.includes('..')) return `${pattern} climbs with .., outside the workspace`;
  if (/(?:^|[/{,])~/.test(pattern)) return `${pattern} names a home (~), outside the workspace`;
  if (/\{[^}]*\//.test(pattern))
    return `${pattern} has a / inside braces, which may reach outside the workspace`;

  return undefined;
};

/** A glob's folder before its first wildcard (`globRefusal` passed). */
const globBase = (pattern: string): string => {
  const parts = pattern.split('/');
  const wild = parts.findIndex((part) => GLOB_CHARS.test(part));

  if (wild === -1) return pattern;
  const base = parts.slice(0, wild).join('/');

  if (base !== '') return base;

  return pattern.startsWith('/') ? '/' : '.';
};

const pathsOf = (a: Asked): Paths => {
  const { cwd, input } = a;
  const reach = (path: string | undefined): Paths => {
    const at = path === undefined ? undefined : absolutePath(path, cwd);

    return at === undefined
      ? { ok: false, reason: `${path ?? 'its path'} is outside the workspace` }
      : { ok: true, paths: [at] };
  };

  switch (input.tool) {
    case 'unreadable':
      return { ok: false, reason: `its ${a.name} input could not be read` };
    case 'Read':
      return reach(input.path);
    case 'Grep':
      return reach(input.path ?? cwd);
    case 'Glob': {
      const refused = globRefusal(input.pattern);

      if (refused !== undefined) return { ok: false, reason: refused };
      const base = globBase(input.pattern);
      const from = input.path ?? cwd;

      if (base.startsWith('/')) return reach(base);

      return reach(from === undefined ? undefined : join(from, base));
    }
    default:
      return { ok: true, paths: [] };
  }
};

/** Where a Read / Glob / Grep prompt reaches, as written (absolute, `..` resolved); [] otherwise. */
export const promptPaths = (payload: unknown): Paths => {
  const asked = askedOf(payload);

  return asked === undefined ? { ok: false, reason: 'not a permission prompt' } : pathsOf(asked);
};

/** Links followed at most this deep (the kernel's own `MAXSYMLINKS`): a loop resolves to none. */
const MAX_LINKS = 32;

const linkTarget = (
  path: string,
  readlink: ((p: string) => string) | undefined,
): string | undefined => {
  if (readlink === undefined) return undefined;
  try {
    return readlink(path);
  } catch {
    return undefined;
  }
};

/**
 * A path's real path: its nearest entry that exists resolved (links), the rest as written. A link
 * to a path not there yet (dangling) counts as where it leads (#181: a write through it lands
 * there), when `readlink` is given.
 */
export const realPathOf = (
  path: string,
  realpath: (p: string) => string,
  readlink?: (p: string) => string,
  hops = 0,
): string | undefined => {
  let rest = '';

  for (let at = path; ; at = dirname(at)) {
    try {
      const real = realpath(at);

      return rest === '' ? real : join(real, rest);
    } catch {
      const target = linkTarget(at, readlink);

      if (target !== undefined) {
        const parent =
          hops < MAX_LINKS ? realPathOf(dirname(at), realpath, readlink, hops + 1) : undefined;

        if (parent === undefined) return undefined;
        const to = resolve(parent, target);

        return realPathOf(rest === '' ? to : join(to, rest), realpath, readlink, hops + 1);
      }
      if (at === '/') return undefined;
      rest = rest === '' ? basename(at) : join(basename(at), rest);
    }
  }
};

/**
 * The hook's side, inside the container: a file tool's prompt with each path it reaches and that
 * path's real path under `REAL_PATHS`; any other payload as it came.
 */
export const withRealPaths = (
  text: string,
  realpath: (p: string) => string,
  readlink?: (p: string) => string,
): string => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  const p = Prompt.safeParse(doc);

  if (!p.success || !FILE_TOOLS.has(p.data.tool_name)) return text;
  const reached = pathsOf(askedFrom(p.data));

  if (!reached.ok) return text;
  const real = Object.fromEntries(
    reached.paths.flatMap((path) => {
      const to = realPathOf(path, realpath, readlink);

      return to === undefined ? [] : [[path, to]];
    }),
  );

  return JSON.stringify({ ...p.data, [REAL_PATHS]: real });
};

/** Strictly under the root: the clone and its worktrees, never the volume itself. */
const inside = (path: string, root: string) => path.startsWith(`${root}/`);

const short = (text: string) => {
  const line = text.split('\n')[0] ?? '';

  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
};

/** What the log keeps of the input, uncut: a command, a file tool's path; a browser's none. */
const inputOf = (a: Asked): string => {
  const { input } = a;

  switch (input.tool) {
    case 'Bash':
      return input.command;
    case 'Read':
      return input.path;
    case 'Glob':
    case 'Grep':
      return `${input.pattern} in ${input.path ?? a.cwd ?? '?'}`;
    default:
      return '';
  }
};

type Decision = { behavior: 'allow'; reason: string } | { behavior: 'deny'; reason: string };

const decide = (a: Asked, root: string): Decision => {
  const { input } = a;

  switch (input.tool) {
    case 'Bash':
      return input.outside
        ? { behavior: 'deny', reason: 'a command outside the sandbox' }
        : { behavior: 'allow', reason: 'a sandboxed command' };
    case 'browser':
      return { behavior: 'allow', reason: "the session's browser" };
    case 'other':
      return { behavior: 'deny', reason: `${a.name} needs a person's yes` };
    default:
      break;
  }
  const reached = pathsOf(a);

  if (!reached.ok) return { behavior: 'deny', reason: reached.reason };

  for (const path of reached.paths) {
    if (!inside(path, root))
      return { behavior: 'deny', reason: `${path} is outside the workspace (${root})` };
    const to = a.real[path];

    if (to === undefined) return { behavior: 'deny', reason: `${path} could not be resolved` };
    if (!inside(to, root))
      return {
        behavior: 'deny',
        reason: `${path} is a link to ${to}, outside the workspace (${root})`,
      };
  }

  return { behavior: 'allow', reason: 'inside the workspace' };
};

/** What the agent is told to do instead, by tool. */
const insteadOf = (tool: string): string => {
  if (tool === 'Bash') return 'Run it in the sandbox (no dangerouslyDisableSandbox)';
  if (FILE_TOOLS.has(tool)) return 'Read only the repo clone and its worktrees';

  return 'Do it another way';
};

/** What the agent is told on a refusal: why, and what to do instead. */
const refusal = (tool: string, reason: string): string =>
  `${tool} refused: ${reason}, and nobody is at this prompt (a Factory run in a workspace). ${insteadOf(tool)}, or run ${NEEDS_YOU}.`;

/**
 * The answer to an unattended session's permission prompt (`root`: the workspace's mount), and
 * its log line, whose input summary is `redact`ed before it is cut short.
 */
export const unattendedAnswer = (
  payload: unknown,
  root: string,
  redact: (text: string) => string = (text) => text,
): { answer: PermissionAnswer; log: PermissionLog } => {
  const asked = askedOf(payload);
  const tool = asked?.name ?? 'This tool';
  const decision: Decision =
    asked === undefined
      ? { behavior: 'deny', reason: 'not a permission prompt' }
      : decide(asked, root);

  return {
    answer: {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision:
          decision.behavior === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: refusal(tool, decision.reason) },
      },
    },
    log: {
      tool,
      behavior: decision.behavior,
      reason: decision.reason,
      input: asked === undefined ? '' : short(redact(inputOf(asked))),
    },
  };
};
