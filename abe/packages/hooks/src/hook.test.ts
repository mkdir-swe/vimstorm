import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempState } from '@abe/testing';
import {
  askDeny,
  FENCE_ENV,
  FENCED_TOOLS,
  HOOK_TIMEOUT_S,
  HOOK_WAIT_MS,
  PRE_TOOL_HOOK_TIMEOUT_S,
  hookSettings,
  PERMISSION_HOLD_MS,
  PERMISSION_HOOK_TIMEOUT_S,
  TURN_START_HOOK_TIMEOUT_S,
} from '@abe/core';
import { unattendedAnswer } from '@abe/core/permission';
import { SIGN_IN_ON_PAGE_ENV } from '@abe/core/source-tools';
import {
  ANSWERED_TOOLS,
  crashAnswer,
  FENCED_SESSION,
  fitPayload,
  HOOK_DEADLINE_MS,
  PERMISSION_DEADLINE_MS,
  PERMISSION_HOLD_DEADLINE_MS,
  runHook,
  TURN_START_DEADLINE_MS,
} from './hook';

const stdin = (text: string): AsyncIterable<string> => ({
  async *[Symbol.asyncIterator]() {
    await Promise.resolve();
    yield text;
  },
});

/** A stdin Claude Code never closes. */
const open: AsyncIterable<string> = {
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise<IteratorResult<string>>(() => undefined),
  }),
};

/** The payload in the request the hook sent: `abe hook <event> --payload <json> …`. */
const sentPayload = (line: string): unknown => {
  const sent: unknown = JSON.parse(line);
  const argv: unknown =
    typeof sent === 'object' && sent !== null && 'argv' in sent ? sent.argv : [];
  const payload: unknown = Array.isArray(argv) ? argv[3] : undefined;

  return typeof payload === 'string' ? JSON.parse(payload) : undefined;
};

describe('fitPayload', () => {
  test('a payload as it came, an empty one as {}', () => {
    expect(fitPayload('{"a":1}\n')).toBe('{"a":1}');
    expect(fitPayload('')).toBe('{}');
  });

  test('a payload too big for a socket line loses its tool fields first', () => {
    const big = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_response: 'x'.repeat(600_000),
    });
    const fitted: unknown = JSON.parse(fitPayload(big));

    expect(fitted).toEqual({
      hook_event_name: 'PostToolUse',
      tool_response: '[dropped: 600002 bytes]',
    });
  });
});

test('an oversize Bash prompt keeps its command and sandbox flag: it is still decided on', () => {
  const command = `echo ${'x'.repeat(300_000)}`;
  const big = JSON.stringify({
    hook_event_name: 'PermissionRequest',
    cwd: '/workspace/repo',
    tool_name: 'Bash',
    tool_input: { command, dangerouslyDisableSandbox: false, description: 'y'.repeat(300_000) },
  });
  const fitted: unknown = JSON.parse(fitPayload(big));

  expect(fitted).toMatchObject({
    tool_name: 'Bash',
    tool_input: {
      command,
      dangerouslyDisableSandbox: false,
      description: '[dropped: 300002 bytes]',
    },
  });
  expect(unattendedAnswer(fitted, '/workspace').log).toMatchObject({
    behavior: 'allow',
    reason: 'a sandboxed command',
  });
});

test('an oversize file prompt keeps its path fields', () => {
  const big = JSON.stringify({
    tool_name: 'Grep',
    tool_input: { pattern: 'p', path: 'src', glob: '*.ts', extra: 'z'.repeat(600_000) },
  });

  expect(JSON.parse(fitPayload(big))).toEqual({
    tool_name: 'Grep',
    tool_input: {
      pattern: 'p',
      path: 'src',
      glob: '[dropped: 6 bytes]',
      extra: '[dropped: 600002 bytes]',
    },
  });
});

test('measured as sent: quotes escaped twice count twice', () => {
  const quoted = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_response: '"'.repeat(150_000),
  });

  expect(quoted.length).toBeLessThan(512 * 1024);
  expect(JSON.parse(fitPayload(quoted))).toMatchObject({
    tool_response: '[dropped: 300002 bytes]',
  });
});

describe('runHook', () => {
  const io = (env: Record<string, string>, text = '{}') => ({
    env,
    stdin: stdin(text),
    cwd: '/',
    elapsed: () => 0,
  });

  test('outside a session it sends nothing', async () => {
    expect(await runHook(['hook', 'Stop'], io({}))).toBe('not-in-session');
    expect(await runHook(['hook'], io({ ABE_SOCKET: '/nowhere' }))).toBe('no-event');
  });

  test('the event and its payload go to the session socket as abe hook --payload', async () => {
    const state = tempState();
    const lines: string[] = [];
    const server = createServer((conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        lines.push(chunk);
        conn.end('{"v":1,"exit":0,"stdout":"","stderr":""}\n');
      });
    });

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      expect(await runHook(['hook', 'Stop'], io({ ABE_SOCKET: state.socket }, '{"x":1}'))).toBe(
        'answered',
      );
      expect(JSON.parse(lines.join(''))).toEqual({
        v: 1,
        argv: ['hook', 'Stop', '--payload', '{"x":1}'],
        cwd: '/',
      });
    } finally {
      server.close();
      state.remove();
    }
  });

  test("a PermissionRequest asks for serve's answer and prints it for Claude Code", async () => {
    const state = tempState();
    const lines: string[] = [];
    const answer = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    };
    const reply = {
      v: 1,
      exit: 0,
      stdout: `${JSON.stringify({ ok: true, data: { id: 's', event: 'PermissionRequest', state: 'working', answer } })}\n`,
      stderr: '',
    };
    const server = createServer((conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        lines.push(chunk);
        conn.end(`${JSON.stringify(reply)}\n`);
      });
    });
    const printed: string[] = [];

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      expect(
        await runHook(['hook', 'PermissionRequest'], {
          ...io({ ABE_SOCKET: state.socket }, '{"tool_name":"Bash"}'),
          print: (text) => printed.push(text),
        }),
      ).toBe('answered');
      expect(JSON.parse(lines.join(''))).toMatchObject({
        argv: ['hook', 'PermissionRequest', '--payload', '{"tool_name":"Bash"}', '--json'],
      });
      expect(printed.map((t): unknown => JSON.parse(t))).toEqual([answer]);
    } finally {
      server.close();
      state.remove();
    }
  });

  test("a file tool's PermissionRequest carries its paths' real paths, links resolved in here", async () => {
    const state = tempState();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abe-hook-')));
    let got = '';
    const server = createServer((conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        got += chunk;
        if (got.includes('\n'))
          conn.end(`${JSON.stringify({ v: 1, exit: 0, stdout: '', stderr: '' })}\n`);
      });
    });

    mkdirSync(join(dir, 'repo'));
    mkdirSync(join(dir, 'home'));
    symlinkSync(join(dir, 'home'), join(dir, 'repo', 'out'));
    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      const prompt = {
        cwd: join(dir, 'repo'),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Read',
        tool_input: { file_path: 'out/.credentials.json' },
      };

      await runHook(
        ['hook', 'PermissionRequest'],
        io({ ABE_SOCKET: state.socket }, JSON.stringify(prompt)),
      );
      expect(sentPayload(got)).toEqual({
        ...prompt,
        abe_real_paths: {
          [join(dir, 'repo', 'out', '.credentials.json')]: join(dir, 'home', '.credentials.json'),
        },
      });
    } finally {
      server.close();
      state.remove();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an answer not in Claude Code's shape is never printed", async () => {
    const state = tempState();
    const reply = {
      v: 1,
      exit: 0,
      stdout: `${JSON.stringify({ ok: true, data: { id: 's', event: 'PermissionRequest', state: 'working', answer: { decision: 'allow' } } })}\n`,
      stderr: '',
    };
    const server = createServer((conn) => {
      conn.on('data', () => conn.end(`${JSON.stringify(reply)}\n`));
    });
    const printed: string[] = [];

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      await runHook(['hook', 'PermissionRequest'], {
        ...io({ ABE_SOCKET: state.socket }, '{"tool_name":"Bash"}'),
        print: (text) => printed.push(text),
      });
      expect(printed).toEqual([]);
    } finally {
      server.close();
      state.remove();
    }
  });

  test('a PermissionRequest serve has no answer for prints nothing: the person decides', async () => {
    const state = tempState();
    const reply = {
      v: 1,
      exit: 0,
      stdout: `${JSON.stringify({ ok: true, data: { id: 's', event: 'PermissionRequest', state: 'waiting' } })}\n`,
      stderr: '',
    };
    const server = createServer((conn) => {
      conn.on('data', () => conn.end(`${JSON.stringify(reply)}\n`));
    });
    const printed: string[] = [];

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      await runHook(['hook', 'PermissionRequest'], {
        ...io({ ABE_SOCKET: state.socket }),
        print: (text) => printed.push(text),
      });
      expect(printed).toEqual([]);
    } finally {
      server.close();
      state.remove();
    }
  });

  test('a PermissionRequest has its own deadline: still answered and printed after 1 s', async () => {
    const state = tempState();
    const answer = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    };
    const reply = {
      v: 1,
      exit: 0,
      stdout: `${JSON.stringify({ ok: true, data: { answer } })}\n`,
      stderr: '',
    };
    const server = createServer((conn) => {
      conn.on('data', () => conn.end(`${JSON.stringify(reply)}\n`));
    });
    const printed: string[] = [];

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      const slow = {
        ...io({ ABE_SOCKET: state.socket }, '{"tool_name":"Bash"}'),
        elapsed: () => 1500,
      };

      expect(await runHook(['hook', 'Stop'], slow)).toBe('late');
      expect(
        await runHook(['hook', 'PermissionRequest'], {
          ...slow,
          stdin: stdin('{"tool_name":"Bash"}'),
          print: (text) => printed.push(text),
        }),
      ).toBe('answered');
      expect(printed.map((t): unknown => JSON.parse(t))).toEqual([answer]);
    } finally {
      server.close();
      state.remove();
    }
  });

  test("the PermissionRequest deadline ends before Claude Code's hook timeout", () => {
    expect(PERMISSION_DEADLINE_MS).toBeGreaterThan(HOOK_DEADLINE_MS);
    expect(PERMISSION_DEADLINE_MS).toBeLessThan(HOOK_TIMEOUT_S * 1000);
  });

  test("serve's own waits for a hook end inside its one second, its start and socket given room", () => {
    expect(HOOK_WAIT_MS * 2).toBeLessThanOrEqual(HOOK_DEADLINE_MS);
  });

  /** A serve that answers every request with `answer` in its `--json` data, and keeps the lines. */
  const answering = async (answer: unknown, heard: () => void = () => undefined) => {
    const state = tempState();
    const lines: string[] = [];
    const reply = {
      v: 1,
      exit: 0,
      stdout: `${JSON.stringify({ ok: true, data: { answer } })}\n`,
      stderr: '',
    };
    const server = createServer((conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string) => {
        lines.push(chunk);
        heard();
        conn.end(`${JSON.stringify(reply)}\n`);
      });
    });

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));

    return {
      socket: state.socket,
      lines,
      [Symbol.dispose]: () => {
        server.close();
        state.remove();
      },
    };
  };

  test("AskUserQuestion's PreToolUse asks for serve's deny and prints it, with four seconds", async () => {
    const deny = askDeny('Which market table?');
    using serve = await answering(deny);
    const printed: string[] = [];
    const ask = '{"tool_name":"AskUserQuestion","tool_input":{"questions":[]}}';

    expect(
      await runHook(['hook', 'PreToolUse'], {
        ...io({ ABE_SOCKET: serve.socket }, ask),
        // Past the 1 s of any other hook once stdin is read.
        elapsed: (() => {
          let n = 0;

          return () => (n++ < 2 ? 0 : 1500);
        })(),
        print: (text) => printed.push(text),
      }),
    ).toBe('answered');
    expect(JSON.parse(serve.lines.join(''))).toMatchObject({
      argv: ['hook', 'PreToolUse', '--payload', ask, '--json'],
    });
    expect(printed.map((t): unknown => JSON.parse(t))).toEqual([deny]);
  });

  test.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch'])(
    "a fenced %s's PreToolUse asks for serve's answer and prints it, with four seconds (#181)",
    async (tool) => {
      const deny = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${tool} refused: outside this session's worktree`,
        },
      };
      using serve = await answering(deny);
      const printed: string[] = [];
      const pre = JSON.stringify({ tool_name: tool, tool_input: { file_path: '/x' } });

      expect(
        await runHook(['hook', 'PreToolUse'], {
          ...io({ ABE_SOCKET: serve.socket }, pre),
          elapsed: (() => {
            let n = 0;

            return () => (n++ < 2 ? 0 : 1500);
          })(),
          print: (text) => printed.push(text),
        }),
      ).toBe('answered');
      expect(JSON.parse(serve.lines.join(''))).toMatchObject({
        argv: ['hook', 'PreToolUse', '--payload', pre, '--json'],
      });
      expect(printed.map((t): unknown => JSON.parse(t))).toEqual([deny]);
    },
  );

  /** What the hook printed for a fenced session's Write, serve as given. */
  const fencedWrite = async (env: Record<string, string>, elapsed: () => number = () => 0) => {
    const printed: string[] = [];
    const pre = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/home/kim/x' } });

    await runHook(['hook', 'PreToolUse'], {
      ...io(env, pre),
      elapsed,
      print: (text) => printed.push(text),
    });

    return printed.map((t): unknown => JSON.parse(t));
  };
  const unchecked = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        "Write refused: abe serve did not answer in time, so this session's fence could not check it. Try it again.",
    },
  };

  test("a fenced session's Write with serve gone: refused, never let through unchecked (#181)", async () => {
    expect(await fencedWrite({ ABE_SOCKET: '/nowhere', [FENCED_SESSION]: '1' })).toEqual([
      unchecked,
    ]);
  });

  test("a fenced session's Write read past its deadline: refused (#181)", async () => {
    expect(
      await fencedWrite(
        { ABE_SOCKET: '/nowhere', [FENCED_SESSION]: '1' },
        (() => {
          let n = 0;

          return () => (n++ < 1 ? 0 : 5000);
        })(),
      ),
    ).toEqual([unchecked]);
  });

  test("a fenced session's Write serve let through: nothing printed", async () => {
    using serve = await answering(undefined);

    expect(await fencedWrite({ ABE_SOCKET: serve.socket, [FENCED_SESSION]: '1' })).toEqual([]);
  });

  /** A stdin that gives `text`, then stays open (Claude Code still writing the payload). */
  const partial = (text: string): AsyncIterable<string> => ({
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield text;
      await new Promise<never>(() => undefined);
    },
  });
  /** What the hook printed for a PreToolUse read only in part, nearly four seconds in. */
  const readInPart = async (env: Record<string, string>, text: string) => {
    using serve = await answering(undefined);
    const printed: string[] = [];

    await runHook(['hook', 'PreToolUse'], {
      env: { ABE_SOCKET: serve.socket, ...env },
      stdin: partial(text),
      cwd: '/',
      elapsed: () => PERMISSION_DEADLINE_MS - 20,
      print: (t) => printed.push(t),
    });

    return printed.map((t): unknown => JSON.parse(t));
  };
  const unread = (tool: string) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${tool} refused: its call could not be read whole in time, so this session's fence could not check it. Try it again.`,
    },
  });

  test.each(['Write', 'WebFetch'])(
    "a fenced session's %s read only in part: refused, never sent on unchecked (#181)",
    async (tool) => {
      expect(
        await readInPart(
          { [FENCED_SESSION]: '1' },
          `{"session_id":"c1","tool_name":"${tool}","tool_input":{"file_path":"/home/kim/.zshrc","content":"aaa`,
        ),
      ).toEqual([unread(tool)]);
    },
  );

  test("a fenced session's payload read only in part, its tool not even named: refused", async () => {
    expect(await readInPart({ [FENCED_SESSION]: '1' }, '{"session_id":"c1","cwd":"/Us')).toEqual([
      unread('The tool'),
    ]);
  });

  test("a fenced session's Bash read only in part: not the fence's, nothing printed", async () => {
    expect(
      await readInPart(
        { [FENCED_SESSION]: '1' },
        '{"tool_name":"Bash","tool_input":{"command":"ls',
      ),
    ).toEqual([]);
  });

  test("a box's Write read only in part: nothing printed (no fence there)", async () => {
    expect(await readInPart({}, '{"tool_name":"Write","tool_input":{"file_path":"/x')).toEqual([]);
  });

  test("a box's Write with serve gone: nothing printed (no fence there)", async () => {
    expect(await fencedWrite({ ABE_SOCKET: '/nowhere' })).toEqual([]);
  });

  test("a fenced session's AskUserQuestion with serve gone: nothing printed (Claude Code asks)", async () => {
    const printed: string[] = [];

    await runHook(['hook', 'PreToolUse'], {
      ...io(
        { ABE_SOCKET: '/nowhere', [FENCED_SESSION]: '1' },
        '{"tool_name":"AskUserQuestion","tool_input":{"questions":[]}}',
      ),
      print: (text) => printed.push(text),
    });
    expect(printed).toEqual([]);
  });

  test("the fenced session's mark is core's", () => {
    expect(FENCED_SESSION).toBe(FENCE_ENV);
  });

  test("the hook waits on exactly core's fenced tools and AskUserQuestion", () => {
    expect([...ANSWERED_TOOLS].sort()).toEqual([...FENCED_TOOLS, 'AskUserQuestion'].sort());
  });

  test("an oversize NotebookEdit keeps its notebook's path: the fence still decides", () => {
    const big = 'x'.repeat(600 * 1024);
    const fitted: unknown = JSON.parse(
      fitPayload(
        JSON.stringify({
          tool_name: 'NotebookEdit',
          tool_input: { notebook_path: '/home/kim/n.ipynb', new_source: big },
        }),
      ),
    );

    expect(fitted).toMatchObject({ tool_input: { notebook_path: '/home/kim/n.ipynb' } });
  });

  test('any other PreToolUse is only sent: no --json, nothing printed', async () => {
    using serve = await answering(askDeny('x'));
    const printed: string[] = [];

    expect(
      await runHook(['hook', 'PreToolUse'], {
        ...io({ ABE_SOCKET: serve.socket }, '{"tool_name":"Bash"}'),
        print: (text) => printed.push(text),
      }),
    ).toBe('answered');
    expect(JSON.parse(serve.lines.join(''))).toEqual({
      v: 1,
      argv: ['hook', 'PreToolUse', '--payload', '{"tool_name":"Bash"}'],
      cwd: '/',
    });
    expect(printed).toEqual([]);
  });

  test('an answer for another event is never printed (a PreToolUse deny on a PermissionRequest)', async () => {
    using serve = await answering(askDeny('x'));
    const printed: string[] = [];

    await runHook(['hook', 'PermissionRequest'], {
      ...io({ ABE_SOCKET: serve.socket }, '{"tool_name":"Bash"}'),
      print: (text) => printed.push(text),
    });
    expect(printed).toEqual([]);
  });

  test("a held PermissionRequest is waited for past serve's hold, under Claude Code's timeout", async () => {
    expect(PERMISSION_HOLD_DEADLINE_MS).toBeGreaterThan(PERMISSION_HOLD_MS);
    expect(PERMISSION_HOLD_DEADLINE_MS).toBeLessThan(PERMISSION_HOOK_TIMEOUT_S * 1000);
    const allow = {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    };
    let now = 0;
    // Serve holds it nine minutes: still printed.
    using serve = await answering(allow, () => {
      now = 540_000;
    });
    const printed: string[] = [];

    expect(
      await runHook(['hook', 'PermissionRequest'], {
        ...io({ ABE_SOCKET: serve.socket }, '{"tool_name":"Bash"}'),
        elapsed: () => now,
        print: (text) => printed.push(text),
      }),
    ).toBe('answered');
    expect(printed.map((t): unknown => JSON.parse(t))).toEqual([allow]);
  });

  test("UserPromptSubmit waits for serve's turn-start snapshot, under Claude Code's timeout", async () => {
    expect(TURN_START_DEADLINE_MS).toBeLessThan(TURN_START_HOOK_TIMEOUT_S * 1000);
    expect(hookSettings('abe').hooks.UserPromptSubmit?.[0]?.hooks[0]?.timeout).toBe(
      TURN_START_HOOK_TIMEOUT_S,
    );
    using serve = await answering(undefined);

    expect(
      await runHook(['hook', 'UserPromptSubmit'], {
        ...io({ ABE_SOCKET: serve.socket }, '{"prompt":"go"}'),
        // Past the 1 s of any other hook once stdin is read: still sent and waited for.
        elapsed: (() => {
          let n = 0;

          return () => (n++ < 2 ? 0 : 1500);
        })(),
      }),
    ).toBe('answered');
  });

  test("Claude Code's hook settings: the PermissionRequest hook gets the long timeout", () => {
    const hooks = hookSettings('abe').hooks;

    expect(hooks.PermissionRequest?.[0]?.hooks[0]?.timeout).toBe(PERMISSION_HOOK_TIMEOUT_S);
    // A fenced tool's own deadline is four seconds; Claude Code's timeout (a tool let through)
    // leaves a slow start of the hook room (#181).
    expect(hooks.PreToolUse?.[0]?.hooks[0]?.timeout).toBe(PRE_TOOL_HOOK_TIMEOUT_S);
    expect(PRE_TOOL_HOOK_TIMEOUT_S * 1000).toBeGreaterThanOrEqual(PERMISSION_DEADLINE_MS + 10_000);
  });

  test("a hook that throws in a fenced session's PreToolUse: refused, never let through (#181)", () => {
    const deny = crashAnswer(['hook', 'PreToolUse'], { [FENCED_SESSION]: '1' });

    expect(JSON.parse(deny ?? 'null')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          "The tool refused: abe hook failed, so this session's fence could not check it. Try it again.",
      },
    });
    expect(crashAnswer(['hook', 'PreToolUse'], {})).toBeUndefined();
    expect(crashAnswer(['hook', 'Stop'], { [FENCED_SESSION]: '1' })).toBeUndefined();
  });

  test('a stdin that never ends: gives up at the deadline, sends nothing', async () => {
    const before = Date.now();

    expect(
      await runHook(['hook', 'Stop'], {
        env: { ABE_SOCKET: '/nowhere' },
        stdin: open,
        cwd: '/',
        elapsed: () => 900 + (Date.now() - before),
      }),
    ).toBe('late');
    expect(Date.now() - before).toBeLessThan(500);
  });
});

// A source's writing tool goes on in every session (ADR 0029): no tool of a source is refused.
describe("runHook: a source's writing tool", () => {
  test.each([
    'mcp__sentry__update_issue',
    'mcp__figma__use_figma',
    'mcp__claude_ai_Gmail__sendMessage',
  ])('%s: nothing printed', async (tool) => {
    const printed: string[] = [];

    await runHook(['hook', 'PreToolUse'], {
      env: {},
      stdin: stdin(JSON.stringify({ tool_name: tool, tool_input: {} })),
      cwd: '/',
      elapsed: () => 0,
      print: (text) => printed.push(text),
    });
    expect(printed).toEqual([]);
  });
});

describe("runHook: a source's sign-in started in a session", () => {
  const page = { [SIGN_IN_ON_PAGE_ENV]: 'install' };
  const settings = { [SIGN_IN_ON_PAGE_ENV]: 'settings' };

  test.each<[string, Record<string, string>, string, boolean]>([
    ["a source's authenticate", page, 'mcp__sentry__authenticate', true],
    ["a card's: Settings' Sign in", settings, 'mcp__sentry__authenticate', true],
    ['its second half', page, 'mcp__sentry__complete_authentication', true],
    ["a claude.ai connector's", page, 'mcp__claude_ai_Figma__authenticate', true],
    ["a source's own tool of a longer name", page, 'mcp__sentry__authenticate_user', false],
    ['no MCP tool', page, 'authenticate', false],
    ["a chat of the person's own, its servers theirs", {}, 'mcp__figma__authenticate', false],
  ])('%s', async (_, env, tool, refused) => {
    const printed: string[] = [];
    const how = await runHook(['hook', 'PreToolUse'], {
      env,
      stdin: stdin(JSON.stringify({ tool_name: tool, tool_input: {} })),
      cwd: '/',
      elapsed: () => 0,
      print: (text) => printed.push(text),
    });
    const server = tool.split('__')[1] ?? '';

    expect([how === 'sign-in', printed.map((t): unknown => JSON.parse(t))]).toEqual([
      refused,
      refused
        ? [
            {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: `${tool} refused: ${server}'s sign-in is the person's: ${env === settings ? 'use Sign in on its row in Settings › Logins & tools' : "the install's own session runs abe source sign-in for them"} (serve runs it in their browser, outside any sandbox). ${env === settings ? 'A session never starts one' : "Never Claude Code's own sign-in tool"}.`,
              },
            },
          ]
        : [],
    ]);
  });
});
