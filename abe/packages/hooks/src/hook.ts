/**
 * `abe hook <event>`, as Claude Code runs it for every hook event: the event's JSON on stdin is
 * sent to the session's own socket (`$ABE_SOCKET`) as `abe hook <event> --payload <json>`. The
 * whole run gives up one second after the process started, prints nothing (Claude Code reads a
 * hook's stdout) and always exits 0, so a hiccup in Abe never stalls or steers Claude Code. The
 * exceptions print serve's answer:
 *
 * - a PermissionRequest (an unattended Factory session's, #67, or one held under an Override for
 *   its permission card, #114): its stdin read within four seconds, serve's answer waited for up
 *   to the hold (`PERMISSION_HOLD_DEADLINE_MS`); its file tool's paths go with it resolved here,
 *   in the container (`withRealPaths`);
 * - AskUserQuestion's PreToolUse (#114): denied by serve so the question is asked in Abe's Chat,
 *   within four seconds (late, Claude Code's own picker shows);
 * - a fenced tool's PreToolUse (#181, core's `FENCED_TOOLS`: a file tool's write, WebFetch): denied
 *   by serve when it reaches past a local session's fence, within four seconds (its stdin read
 *   for as long); late, serve gone, or its payload not read whole, the hook denies it itself in a
 *   local session (`FENCED_SESSION`): never unchecked;
 * - Claude Code's own tool that starts a source's sign-in (`authenticate`, core's
 *   `signInToolRefusal`) in a session of Abe's servers and the sources alone (core's
 *   `SIGN_IN_ON_PAGE_ENV`): denied here, never sent on: the person uses the install page's Sign
 *   in (the install's session) or Settings' (any other), which serve runs outside any sandbox.
 *
 * A UserPromptSubmit prints nothing either, but waits for serve's answer (`TURN_START_DEADLINE_MS`):
 * the turn's start snapshot is taken before the agent writes (#113).
 */
import { readlinkSync, realpathSync } from 'node:fs';
import { SIGN_IN_ON_PAGE_ENV, signInToolRefusal } from '@abe/core/source-tools';
import { type Forwarded, forward } from './forward';

/** From the process's start: reading stdin and the answer share it. */
export const HOOK_DEADLINE_MS = 1000;

/**
 * A PermissionRequest's, under Claude Code's hook timeout (core's `HOOK_TIMEOUT_S`, 5 s): its
 * stdin, the permission module's import, the real paths and serve's answer share it. A late one
 * prints nothing, and an unattended run then waits at a dialog nobody sees.
 */
export const PERMISSION_DEADLINE_MS = 4000;

/**
 * A PermissionRequest's wait for serve's answer: past serve's hold (core's `PERMISSION_HOLD_MS`,
 * ten minutes) and under Claude Code's timeout for it (`PERMISSION_HOOK_TIMEOUT_S`); the tests hold
 * it to both. Without an Override serve answers at once, so it is only waited on for a held card.
 */
export const PERMISSION_HOLD_DEADLINE_MS = 615_000;

/**
 * A UserPromptSubmit's wait for serve (#113): serve answers once the turn's start snapshot is
 * taken, so the agent writes nothing before it; under Claude Code's timeout for it (core's
 * `TURN_START_HOOK_TIMEOUT_S`). Serve unreachable: given up at once, as any hook.
 */
export const TURN_START_DEADLINE_MS = 615_000;

/**
 * The tools whose PreToolUse serve may answer: AskUserQuestion, and core's `FENCED_TOOLS` (spelled
 * here so the hook loads no core module for every other event; the tests hold the two the same).
 */
export const ANSWERED_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Skill',
]);

/**
 * The variable a local session's `claude` runs with (core's `FENCE_ENV`): its fenced tools are
 * refused when serve cannot check them (#181), never let through unchecked.
 */
export const FENCED_SESSION = 'FENCED_BY_ABE';

/** Whether a payload reads as JSON: one read only in part (late) does not. */
const readsWhole = (text: string): boolean => {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
};

/** The tool a payload read only in part names (`"tool_name":"…"` comes early), when it does. */
const namedTool = (text: string): string | undefined =>
  /"tool_name"\s*:\s*"([^"\\]*)"/.exec(text)?.[1];

/** A PreToolUse payload's tool, when it names one. */
const toolOf = (text: string): string | undefined => {
  try {
    const doc: unknown = JSON.parse(text);

    return typeof doc === 'object' &&
      doc !== null &&
      'tool_name' in doc &&
      typeof doc.tool_name === 'string'
      ? doc.tool_name
      : undefined;
  } catch {
    return undefined;
  }
};

const preToolAnswer = (decision: 'deny' | 'ask', reason: string) =>
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  })}\n`;
const preToolDeny = (reason: string) => preToolAnswer('deny', reason);

/**
 * What `abe hook` prints when it throws (main's catch): a fenced session's PreToolUse refused,
 * whatever its tool (its payload may not be read yet), never let through unchecked (#181).
 */
export const crashAnswer = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined =>
  argv[1] === 'PreToolUse' && env[FENCED_SESSION] === '1'
    ? preToolDeny(
        "The tool refused: abe hook failed, so this session's fence could not check it. Try it again.",
      )
    : undefined;

/** Whether serve's reply line is a plain `ok` (an answer in it or none: the tool goes on). */
const servedOk = (line: string): boolean => {
  try {
    const reply: unknown = JSON.parse(line);

    if (typeof reply !== 'object' || reply === null || !('stdout' in reply)) return false;
    if (typeof reply.stdout !== 'string') return false;
    const out: unknown = JSON.parse(reply.stdout);

    return typeof out === 'object' && out !== null && 'ok' in out && out.ok === true;
  } catch {
    return false;
  }
};

/**
 * A socket line stays under `serve`'s 1 MiB; a bigger payload loses its tool fields first. It is
 * measured as sent: escaped again as a string inside the request's argv.
 */
const MAX_PAYLOAD = 512 * 1024;
const sentSize = (text: string) => JSON.stringify(text).length;

/**
 * What a permission decision reads of `tool_input` (Bash's command and sandbox flag, a file tool's
 * paths): kept while its other keys go, so a long command is still decided on.
 */
const DECIDED = new Set([
  'command',
  'dangerouslyDisableSandbox',
  'file_path',
  // NotebookEdit's: the fence decides on it (#181).
  'notebook_path',
  'path',
  'pattern',
  // WebFetch's: a network Override's card matches on it (#114).
  'url',
  // Skill's: the fence decides on it (#181).
  'skill',
]);
const dropped = (value: unknown) => `[dropped: ${JSON.stringify(value).length} bytes]`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The bulky tool fields lightened: `tool_response` gone, `tool_input` down to `DECIDED`, or gone. */
const lightened = (doc: Record<string, unknown>, wholeInput: boolean) =>
  Object.fromEntries(
    Object.entries(doc).map(([key, value]: [string, unknown]) => {
      if (key === 'tool_response') return [key, dropped(value)];
      if (key !== 'tool_input') return [key, value];
      if (wholeInput || !isRecord(value)) return [key, dropped(value)];

      return [
        key,
        Object.fromEntries(
          Object.entries(value).map(([k, v]: [string, unknown]) => [
            k,
            DECIDED.has(k) ? v : dropped(v),
          ]),
        ),
      ];
    }),
  );

/** The payload as sent: as read, or without its bulky tool fields when it is too big. */
export const fitPayload = (text: string): string => {
  const trimmed = text.trim() === '' ? '{}' : text.trim();

  if (sentSize(trimmed) <= MAX_PAYLOAD) return trimmed;
  let doc: unknown;

  try {
    doc = JSON.parse(trimmed);
  } catch {
    return JSON.stringify({ abe_dropped: `a payload of ${trimmed.length} bytes that is not JSON` });
  }
  if (!isRecord(doc))
    return JSON.stringify({ abe_dropped: `a payload of ${trimmed.length} bytes` });
  for (const wholeInput of [false, true]) {
    const fitted = JSON.stringify(lightened(doc, wholeInput));

    if (sentSize(fitted) <= MAX_PAYLOAD) return fitted;
  }

  return JSON.stringify({ abe_dropped: `a payload of ${trimmed.length} bytes` });
};

/** Reads `input` to its end, or what came by the deadline. */
const readUntil = async (input: AsyncIterable<Uint8Array | string>, ms: number) => {
  let text = '';
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => {
      resolve('late');
    }, ms);
  });
  const read = (async () => {
    for await (const chunk of input)
      text += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    return 'read' as const;
  })();

  await Promise.race([read, late]);
  clearTimeout(timer);

  return text;
};

export type HookIo = {
  env: Readonly<Record<string, string | undefined>>;
  stdin: AsyncIterable<Uint8Array | string>;
  cwd: string;
  /** Milliseconds since the process started (`performance.now()`). */
  elapsed: () => number;
  /**
   * Claude Code reads it: only serve's answer to a PermissionRequest or an answered PreToolUse is
   * printed, or a fenced tool's deny when serve could not check it.
   */
  print?: (text: string) => void;
};

/** What happened, for tests; the process exits 0 whatever it is. */
export type Hooked = Forwarded | 'no-event' | 'not-in-session' | 'late' | 'sign-in';

export const runHook = async (argv: readonly string[], io: HookIo): Promise<Hooked> => {
  const [, event] = argv;

  if (event === undefined || event === '') return 'no-event';
  const permission = event === 'PermissionRequest';
  const inFence = io.env[FENCED_SESSION] === '1';
  const pre = event === 'PreToolUse';
  // A local session's PreToolUse is read as long as a fenced tool's answer may take: its tool is
  // only known once its payload is in.
  const readBy = permission || (pre && inFence) ? PERMISSION_DEADLINE_MS : HOOK_DEADLINE_MS;
  const text = await readUntil(io.stdin, Math.max(0, readBy - io.elapsed()));
  const socket = io.env.ABE_SOCKET;

  // Still not read whole: a fenced tool (or one not named yet) is refused, never sent on for
  // serve to find no tool in (#181).
  if (pre && inFence && !readsWhole(text)) {
    const named = namedTool(text);

    if (named === undefined || (ANSWERED_TOOLS.has(named) && named !== 'AskUserQuestion')) {
      io.print?.(
        preToolDeny(
          `${named ?? 'The tool'} refused: its call could not be read whole in time, so this session's fence could not check it. Try it again.`,
        ),
      );

      return 'late';
    }
  }
  const tool = pre ? toolOf(text) : undefined;
  // A source's sign-in started in a session: the person's, on the page; serve runs it.
  const page = io.env[SIGN_IN_ON_PAGE_ENV];
  const signIn =
    pre && (page === 'install' || page === 'settings')
      ? signInToolRefusal(tool ?? namedTool(text) ?? '', page)
      : null;

  if (signIn !== null) {
    io.print?.(preToolDeny(signIn));

    return 'sign-in';
  }
  const asking = tool !== undefined && ANSWERED_TOOLS.has(tool);
  // A local session's fenced tool: serve must say it may go on (#181).
  const fenced = asking && tool !== 'AskUserQuestion' && inFence ? tool : undefined;
  const unchecked = (how: Hooked): Hooked => {
    if (fenced !== undefined)
      io.print?.(
        preToolDeny(
          `${fenced} refused: abe serve did not answer in time, so this session's fence could not check it. Try it again.`,
        ),
      );

    return how;
  };
  let deadline = HOOK_DEADLINE_MS;

  if (permission) deadline = PERMISSION_HOLD_DEADLINE_MS;
  else if (asking) deadline = PERMISSION_DEADLINE_MS;
  else if (event === 'UserPromptSubmit') deadline = TURN_START_DEADLINE_MS;
  const left = () => deadline - io.elapsed();

  const readIn = io.elapsed();

  if (socket === undefined || socket === '') return unchecked('not-in-session');
  if (readIn >= readBy || left() <= 0) return unchecked('late');

  if (!permission && !asking)
    return forward(
      socket,
      { argv: ['hook', event, '--payload', fitPayload(text)], cwd: io.cwd },
      left(),
    );
  // Serve does not see the container's files: a file tool's paths are resolved here (#67).
  const { HookReply, withRealPaths } = await import('@abe/core/permission');
  const payload = fitPayload(permission ? withRealPaths(text, realpathSync, readlinkSync) : text);

  if (left() <= 0) return unchecked('late');
  let line = '';
  const how = await forward(
    socket,
    { argv: ['hook', event, '--payload', payload, '--json'], cwd: io.cwd },
    left(),
    (reply) => {
      line = reply;
    },
  );
  // Only Claude Code's own shape for this event is printed: anything else leaves its own dialog.
  const reply = how === 'answered' ? HookReply.safeParse(line) : undefined;
  const answer = reply?.success === true ? reply.data.stdout.data.answer : undefined;

  if (answer?.hookSpecificOutput.hookEventName === event) io.print?.(`${JSON.stringify(answer)}\n`);
  else if (how !== 'answered' || !servedOk(line)) return unchecked(how);

  return how;
};
