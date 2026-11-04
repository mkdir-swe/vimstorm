/**
 * The CLI seam: the real `abe` as a process against a temporary state directory, starting and
 * reaching a real detached `serve`, read through `--json` and exit codes only. Then the client's
 * own code (`runClient`) against a serve it starts or a stand-in socket: when it starts serve,
 * what a slow answer says, and the progress line a waiting box command draws.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  CheckFilesData,
  commandIds,
  type ExitCode,
  HelpData,
  journal,
  type Printed,
  PROTOCOL,
  readEnvelope,
  ServeData,
  StatusData,
  StopData,
} from '@abe/core';
import { type Answer, listen } from '@abe/ports';
import {
  cli,
  type Cli,
  fakeClock,
  refusingAws,
  refusingBoard,
  refusingSecrets,
  refusingTracking,
  T0,
  tempState,
  until,
} from '@abe/testing';
import { z } from 'zod';
import { type ClientOptions, runClient, startServe, VERSION, withProgress } from '.';

describe('abe status --json', () => {
  const abe = cli();

  afterAll(() => abe.close());

  test('with no serve running starts one detached and prints one document', async () => {
    const before = Date.now();
    const { exit, doc } = await abe.json(StatusData, 'status');

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data).toMatchObject({
      version: VERSION,
      socket: abe.state.socket,
      sessions: 0,
      workspaces: 0,
    });
    expect(Date.parse(doc.data.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(readFileSync(join(abe.state.dir, 'serve.log'), 'utf8')).toContain('listening on');
  });

  test('a second call reuses the same serve', async () => {
    const first = await abe.json(StatusData, 'status');
    const second = await abe.json(StatusData, 'status');

    expect(first.doc.ok && second.doc.ok).toBe(true);
    if (!first.doc.ok || !second.doc.ok) return;
    expect(second.doc.data.pid).toBe(first.doc.data.pid);
    expect(second.doc.data.startedAt).toBe(first.doc.data.startedAt);
  });

  test('a v2 request gets unsupported-version', async () => {
    const reply: unknown = JSON.parse(
      await abe.raw('{"v":2,"argv":["status","--json"],"cwd":"/"}'),
    );

    expect(reply).toMatchObject({ v: 1, exit: 1, error: { code: 'unsupported-version' } });
  });

  test('a request naming no command gets an answer, not a hang', async () => {
    const reply: unknown = JSON.parse(await abe.raw('{"v":1,"argv":["toString"],"cwd":"/"}'));

    expect(reply).toMatchObject({ v: 1, exit: 2 });
  });

  test('a v1 request gets the reply frame', async () => {
    const reply: unknown = JSON.parse(await abe.raw('{"v":1,"argv":["status"],"cwd":"/"}'));

    expect(reply).toMatchObject({ v: 1, exit: 0, stderr: '' });
    expect(reply).not.toHaveProperty('error');
  });

  test('abe serve with one running is refused, exit 1', async () => {
    const { exit, doc } = await abe.json(ServeData, 'serve');

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'serve-running' } });
  });
});

describe('abe help', () => {
  const abe = cli();

  afterAll(() => abe.close());

  test('--json lists every command in the table, without starting serve', async () => {
    const { exit, doc } = await abe.json(HelpData, 'help');

    expect(exit).toBe(0);
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.commands.map((c) => [c.noun, c.verb].filter(Boolean).join(' '))).toEqual(
      commandIds(),
    );
    expect(existsSync(abe.state.socket)).toBe(false);
  });

  test('text lists them too', async () => {
    const { exit, stdout } = await abe.run('help');

    expect(exit).toBe(0);
    expect(stdout).toContain('serve stop');
  });
});

describe('exit codes', () => {
  let abe: Cli;

  afterEach(() => abe.close());

  test('2: an unknown flag prints the command usage', async () => {
    abe = cli();
    const text = await abe.run('status', '--frob');

    expect(text.exit).toBe(2);
    expect(text.stderr).toStartWith('abe: unknown flag --frob\n\nusage: abe status [--json]\n');

    const { exit, doc } = await abe.json(StatusData, 'status', '--frob');

    expect(exit).toBe(2);
    expect(doc).toEqual({ ok: false, error: { code: 'usage', message: 'unknown flag --frob' } });
  });

  test.each(['frob', 'constructor'])('2: an unknown command (%s)', async (name) => {
    abe = cli();
    const { exit, doc } = await abe.json(StatusData, name);

    expect(exit).toBe(2);
    expect(doc).toMatchObject({ ok: false, error: { code: 'unknown-command' } });
  });

  test('2: help for an unknown command, with the usage', async () => {
    abe = cli();
    const { exit, stderr, doc } = await abe.json(HelpData, 'help', 'frob');

    expect(exit).toBe(2);
    expect(doc).toMatchObject({ ok: false, error: { code: 'unknown-command' } });
    expect(stderr).toStartWith('usage: abe help');
  });

  test('3: --no-start against a dead socket, and nothing is started', async () => {
    abe = cli();
    const { exit, doc } = await abe.json(StatusData, 'status', '--no-start');

    expect(exit).toBe(3);
    expect(doc).toMatchObject({ ok: false, error: { code: 'serve-unreachable' } });
    expect(existsSync(abe.state.socket)).toBe(false);
  });
});

describe('abe serve', () => {
  let abe: Cli;

  afterEach(() => abe.close());

  test('runs in the foreground until abe serve stop', async () => {
    abe = cli();
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, '..', 'main.ts'), 'serve', '--json'],
      {
        env: abe.state.env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const reader = child.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const started = readEnvelope(ServeData, JSON.parse(first));

    expect(started).toMatchObject({ ok: true, data: { pid: child.pid, socket: abe.state.socket } });
    const status = await abe.json(StatusData, 'status', '--no-start');

    expect(status.doc).toMatchObject({ ok: true, data: { pid: child.pid } });
    const stop = await abe.json(StopData, 'serve', 'stop');

    expect(stop).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { stopped: true, pid: child.pid } },
    });
    expect(await child.exited).toBe(0);
    expect(existsSync(abe.state.socket)).toBe(false);
  });

  test('serve stop with none running says so, exit 0', async () => {
    abe = cli();

    expect(await abe.json(StopData, 'serve', 'stop')).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { stopped: false, pid: null } },
    });
  });

  test('without $ABE_SOCKET the socket is in the state directory', async () => {
    abe = cli({ env: { ABE_SOCKET: '' } });
    const { doc } = await abe.json(StatusData, 'status');

    expect(doc).toMatchObject({ ok: true, data: { socket: join(abe.state.dir, 'serve.sock') } });
  });
});

describe('inside a workspace (ABE_WORKSPACE set)', () => {
  const abe = cli({ env: { ABE_WORKSPACE: '101' } });

  afterAll(() => abe.close());

  test('nothing answering is exit 3, and no serve is started there', async () => {
    const { exit, doc } = await abe.json(StatusData, 'status');

    expect(exit).toBe(3);
    expect(doc).toMatchObject({ ok: false, error: { code: 'serve-unreachable' } });
    expect(existsSync(abe.state.socket)).toBe(false);
  });

  test('abe serve is refused', async () => {
    const { exit, doc } = await abe.json(ServeData, 'serve');

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'not-in-session' } });
  });
});

describe('on a box (ABE_BOX set)', () => {
  const abe = cli({ env: { ABE_BOX: '1' } });

  afterAll(() => abe.close());

  // The box's serve is its systemd unit: an early `abe` (the agent's startup, an SSH command) must
  // never start one of its own without the unit's environment.
  test('nothing answering is exit 3, and no serve is started', async () => {
    const { exit, doc } = await abe.json(StatusData, 'status');

    expect(exit).toBe(3);
    expect(doc).toMatchObject({ ok: false, error: { code: 'serve-unreachable' } });
    expect(existsSync(abe.state.socket)).toBe(false);
  });
});

const printed = async (argv: string[], o: ClientOptions): Promise<Printed> => {
  const client = await runClient(argv, o);

  if (client.kind !== 'printed') throw new Error('expected a printed answer');

  return client.printed;
};

// A repo's static checks parse its config files with Abe itself (ADR 0026), read-only, in the
// client alone: no serve answers and none is started, as on a box, in CI or with serve down.
describe('abe check json|yaml, serve-free', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-files-'));
  const state = tempState();

  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'config.dev.json'), '{ "ENVIRONMENT": "dev" }\n');
  writeFileSync(join(dir, 'config.CI.json'), '{\n  "API_ENV": API_ENV_SED\n}\n');
  writeFileSync(
    join(dir, 'src', 'tenant.yaml'),
    'tenant:\n  name: ##ENVIRONMENT##\n---\nmore: 1\n',
  );
  writeFileSync(join(dir, 'broken.yml'), 'jobs:\n  a: [1, 2\n');
  afterAll(() => {
    state.remove();
    rmSync(dir, { recursive: true, force: true });
  });

  test.each<[string, string[], ExitCode, string]>([
    ['JSON that parses', ['json', 'config.dev.json'], 0, ''],
    ['YAML that parses, each document', ['yaml', 'src/tenant.yaml'], 0, ''],
    [
      'a JSON template not JSON yet: its file, line and column',
      ['json', 'config.dev.json', 'config.CI.json'],
      1,
      'config.CI.json:2:14: unexpected "A"',
    ],
    ['YAML that does not parse', ['yaml', 'src/tenant.yaml', 'broken.yml'], 1, 'broken.yml:3:1'],
    ['a file not there', ['json', 'nope.json'], 1, 'nope.json: no such file, or not readable'],
  ])('%s', async (_, argv, exit, said) => {
    const out = await printed(['check', ...argv, '--json'], {
      cwd: dir,
      // nothing listens there, and nothing may start or wait for a serve
      where: {
        stateDir: state.dir,
        socket: state.socket,
        log: join(state.dir, 'serve.log'),
        plugins: join(state.dir, 'plugins'),
        defaultStates: [],
      },
      startServe: () => {
        throw new Error('never starts serve');
      },
      sleep: () => Promise.reject(new Error('never waits')),
      now: () => T0,
    });
    const doc = readEnvelope(CheckFilesData, JSON.parse(out.stdout));

    expect(out.exit).toBe(exit);
    if (doc.ok) expect(doc.data.parsed).toEqual(argv.slice(1));
    else expect(doc.error.message).toStartWith(said);
  });
});

describe('inside a workspace the client never starts serve', () => {
  test('nothing answering on the workspace socket is exit 3 at once', async () => {
    const state = tempState();
    const out = await printed(['status', '--json'], {
      cwd: '/workspace/repo',
      where: {
        stateDir: state.dir,
        socket: state.socket,
        log: join(state.dir, 'serve.log'),
        plugins: join(state.dir, 'plugins'),
        defaultStates: [],
      },
      sleep: () => Promise.reject(new Error('never waits')),
      now: () => T0,
    });

    expect(out.exit).toBe(3);
    expect(JSON.parse(out.stdout)).toMatchObject({
      ok: false,
      error: { code: 'serve-unreachable' },
    });
    state.remove();
  });
});

describe('the client starts serve when none answers', () => {
  test('waits for a started serve, then sends the command once', async () => {
    const state = tempState();
    const clock = fakeClock();
    let starts = 0;
    let started: Promise<{ stop: () => Promise<void> }> | undefined;
    const out = await printed(['status', '--json'], {
      cwd: state.dir,
      where: {
        stateDir: state.dir,
        socket: state.socket,
        log: join(state.dir, 'serve.log'),
        plugins: join(state.dir, 'plugins'),
        defaultStates: [],
      },
      startServe: () => {
        starts += 1;
        started = startServe({
          socket: state.socket,
          clock,
          pid: 7,
          version: 'test',
          tracking: refusingTracking(),
          aws: refusingAws(),
          secrets: refusingSecrets(),
          board: refusingBoard(),
        });
      },
      sleep: async () => {
        await started;
        clock.tick(25);
      },
      now: clock.now,
    });

    expect(starts).toBe(1);
    expect(out.exit).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, data: { pid: 7 } });
    await (await started)?.stop();
    state.remove();
  });

  // A live serve holding the lock (starting, binding its socket again, or about to be ended by
  // the one just started) gets longer before the client gives up.
  test.each([
    ['no serve holds the lock', false, 5],
    ['a live serve holds it, answering nowhere', true, 25],
  ])('gives up with exit 3, naming the log: %s', async (_, held, seconds) => {
    const state = tempState();
    const clock = fakeClock();
    const log = join(state.dir, 'serve.log');
    const out = await printed(['status', '--json'], {
      cwd: state.dir,
      where: {
        stateDir: state.dir,
        socket: state.socket,
        log,
        plugins: join(state.dir, 'plugins'),
        defaultStates: [],
      },
      startServe: () => undefined,
      serveHeld: () => held,
      sleep: (ms) => {
        clock.tick(ms);

        return Promise.resolve();
      },
      now: clock.now,
    });

    expect(out.exit).toBe(3);
    expect(JSON.parse(out.stdout)).toEqual({
      ok: false,
      error: {
        code: 'serve-unreachable',
        message: `abe serve did not answer on ${state.socket} within ${seconds} s; its log is ${log}`,
      },
    });
    expect(clock.now() - T0).toBe(seconds * 1000);
    state.remove();
  });
});

describe('a slow answer says what it waits on', () => {
  /** A serve on `socket` that answers every request after `ms`. */
  const slowServe = (socket: string, ms: number) => {
    const server = createServer((conn) => {
      conn.once('data', () => {
        setTimeout(() => {
          conn.end(
            `${JSON.stringify({ v: PROTOCOL, exit: 1, stdout: '', stderr: 'abe: no region\n' })}\n`,
          );
        }, ms);
      });
    });

    return new Promise<{ close: () => void }>((resolve) => {
      server.listen(socket, () => {
        resolve({ close: () => server.close() });
      });
    });
  };
  const options = (state: ReturnType<typeof tempState>, said: string[]): ClientOptions => ({
    cwd: state.dir,
    where: {
      stateDir: state.dir,
      socket: state.socket,
      log: join(state.dir, 'serve.log'),
      plugins: join(state.dir, 'plugins'),
      defaultStates: [],
    },
    sleep: () => Promise.reject(new Error('never waits')),
    now: () => T0,
    slow: (line) => said.push(line),
    slowMs: 20,
  });

  test('box list: once its answer takes longer, a terminal is told it waits on EC2', async () => {
    const state = tempState();
    const serve = await slowServe(state.socket, 120);
    const said: string[] = [];
    const out = await printed(['box', 'list'], options(state, said));

    expect(said).toEqual(['abe: waiting on EC2 for your boxes (the aws CLI)…\n']);
    expect(out.stderr).toBe('abe: no region\n');
    // any other command waits on abe serve; --json says nothing
    said.length = 0;
    await printed(['status'], options(state, said));
    expect(said).toEqual(["abe: waiting on abe serve's answer…\n"]);
    said.length = 0;
    await printed(['box', 'list', '--json'], options(state, said));
    expect(said).toEqual([]);
    serve.close();
    state.remove();
  });

  test('a quick answer says nothing', async () => {
    const state = tempState();
    const serve = await slowServe(state.socket, 0);
    const said: string[] = [];

    await printed(['box', 'list'], { ...options(state, said), slowMs: 2000 });
    expect(said).toEqual([]);
    serve.close();
    state.remove();
  });
});

// The progress line goes through `serve`'s socket: a box command asks for progress, and `serve`
// streams the box's events beside the command's answer (`withProgress`).

const REPLY = { v: PROTOCOL, exit: 0, stdout: 'demo-shop-3  running\n', stderr: '' };

type World = {
  clock: ReturnType<typeof fakeClock>;
  events: ReturnType<typeof journal>;
  asked: string[];
  written: string[];
  /** The client's one-second tick, fired by the test. */
  tick: () => void;
  ticking: boolean;
  /** Lets the command answer. */
  answer: () => void;
  options: ClientOptions;
  close: () => Promise<void>;
  remove: () => void;
};

const world = async (tty: boolean, serve: 'progress' | 'before' = 'progress'): Promise<World> => {
  const state = tempState();
  const clock = fakeClock();
  const events = journal(clock);
  const answered = Promise.withResolvers<undefined>();
  const w: Omit<World, 'options' | 'close' | 'remove'> = {
    clock,
    events,
    asked: [],
    written: [],
    tick: () => undefined,
    ticking: false,
    answer: () => {
      answered.resolve(undefined);
    },
  };
  const command = async (line: string): Promise<Answer> => {
    w.asked.push(line);
    await answered.promise;

    return { line: JSON.stringify(REPLY) };
  };
  const listener = await listen(
    state.socket,
    serve === 'progress' ? withProgress(events, command) : command,
  );
  const options: ClientOptions = {
    cwd: state.dir,
    where: {
      stateDir: state.dir,
      socket: state.socket,
      log: join(state.dir, 'serve.log'),
      plugins: join(state.dir, 'plugins'),
      defaultStates: [],
    },
    sleep: () => Promise.resolve(),
    now: clock.now,
    progress: {
      tty,
      write: (text) => {
        w.written.push(text);
      },
      every: (fn) => {
        w.tick = fn;
        w.ticking = true;

        return () => {
          w.ticking = false;
        };
      },
    },
  };

  return Object.assign(w, { options, close: () => listener.close(), remove: state.remove });
};

const run = async (argv: string[], o: ClientOptions): Promise<Printed> => {
  const client = await runClient(argv, o);

  if (client.kind !== 'printed') throw new Error('expected a printed answer');

  return client.printed;
};

const written = (w: World, n: number) =>
  until(`${n} writes, got ${JSON.stringify(w.written)}`, () =>
    w.written.length >= n ? w.written : undefined,
  );

describe('a waiting box command says what it waits for', () => {
  test('off a terminal: a line a second in, then one per step, then the reply', async () => {
    const w = await world(false);

    try {
      const out = run(['box', 'start', 'demo-shop-3'], w.options);

      await until('the request', () => w.asked[0]);
      expect(JSON.parse(w.asked[0] ?? '{}')).toMatchObject({ progress: true });
      w.clock.tick(1000);
      w.tick();
      expect(w.written).toEqual(['demo-shop-3: waking… 0:01\n']);
      // A second tick off a terminal draws nothing new: only steps add lines.
      w.clock.tick(1000);
      w.tick();
      expect(w.written).toHaveLength(1);
      w.events.emit('box.state', { box: 'demo-shop-3', state: 'starting', cause: 'start' });
      await written(w, 2);
      w.clock.tick(7000);
      w.events.emit('box.step', { box: 'demo-shop-3', step: 'booting' });
      // Another box's moves are not this command's.
      w.events.emit('box.state', { box: 'demo-shop-4', state: 'running', cause: 'start' });
      await written(w, 3);
      w.answer();

      expect(await out).toEqual({ exit: 0, stdout: REPLY.stdout, stderr: '' });
      expect(w.written).toEqual([
        'demo-shop-3: waking… 0:01\n',
        'demo-shop-3: starting (EC2 pending)… 0:02\n',
        'demo-shop-3: running, waiting for its abe serve… 0:09\n',
      ]);
      expect(w.ticking).toBe(false);
    } finally {
      await w.close();
      w.remove();
    }
  });

  test('on a terminal: one line redrawn each second and on each step, gone once answered', async () => {
    const w = await world(true);

    try {
      const out = run(['box', 'stop', 'demo-shop-3'], w.options);

      await until('the request', () => w.asked[0]);
      w.clock.tick(1000);
      w.tick();
      w.clock.tick(1000);
      w.tick();
      w.events.emit('box.state', { box: 'demo-shop-3', state: 'stopping', cause: 'stop' });
      await written(w, 3);
      w.answer();
      await out;

      expect(w.written).toEqual([
        '\r\x1b[Kdemo-shop-3: stopping… 0:01',
        '\r\x1b[Kdemo-shop-3: stopping… 0:02',
        '\r\x1b[Kdemo-shop-3: stopping (EC2)… 0:02',
        '\r\x1b[K',
      ]);
    } finally {
      await w.close();
      w.remove();
    }
  });

  test('an answer within the second draws nothing', async () => {
    const w = await world(true);

    try {
      w.answer();

      expect(await run(['box', 'list'], w.options)).toMatchObject({
        exit: 0,
        stdout: REPLY.stdout,
      });
      expect(w.written).toEqual([]);
    } finally {
      await w.close();
      w.remove();
    }
  });

  test('a serve from before answers with the reply alone; the line still shows the wait', async () => {
    const w = await world(false, 'before');

    try {
      const out = run(['--on', 'demo-shop-9', 'status'], w.options);

      await until('the request', () => w.asked[0]);
      w.clock.tick(1000);
      w.tick();
      w.answer();

      expect(await out).toMatchObject({ exit: 0, stdout: REPLY.stdout });
      expect(w.written).toEqual([
        'demo-shop-9: reaching its abe serve (a sleeping box is woken first)… 0:01\n',
      ]);
    } finally {
      await w.close();
      w.remove();
    }
  });

  test('--json asks for no progress and stays one document', async () => {
    const w = await world(false);

    try {
      w.answer();
      await run(['box', 'list', '--json'], w.options);

      expect(JSON.parse(w.asked[0] ?? '{}')).not.toHaveProperty('progress');
      expect(w.written).toEqual([]);
    } finally {
      await w.close();
      w.remove();
    }
  });
});

describe('a serve of another abe build is said, with what to do', () => {
  const MINE = '3.0.0+new';
  const LINE =
    'abe serve is abe 3.0.0+old, this abe is 3.0.0+new: restart it once no session runs (abe serve stop; the next abe command starts it again)';
  const where = (state: ReturnType<typeof tempState>) => ({
    stateDir: state.dir,
    socket: state.socket,
    log: join(state.dir, 'serve.log'),
    plugins: join(state.dir, 'plugins'),
    defaultStates: [],
  });
  const options = (state: ReturnType<typeof tempState>): ClientOptions => ({
    cwd: state.dir,
    where: where(state),
    version: MINE,
    sleep: () => Promise.reject(new Error('never waits')),
    now: () => T0,
  });

  test.each<[string, string[], string, { stdout: boolean; stderr: boolean }]>([
    ['abe status says it', ['status'], '3.0.0+old', { stdout: true, stderr: false }],
    ['the same build: nothing', ['status'], MINE, { stdout: false, stderr: false }],
    [
      'another command: one line on stderr',
      ['card', 'list'],
      '3.0.0+old',
      { stdout: false, stderr: true },
    ],
    [
      '--json: the document alone',
      ['card', 'list', '--json'],
      '3.0.0+old',
      { stdout: false, stderr: false },
    ],
    [
      'abe status --json: the document alone',
      ['status', '--json'],
      '3.0.0+old',
      { stdout: false, stderr: false },
    ],
  ])('%s', async (_, argv, version, said) => {
    const state = tempState();
    const serve = await startServe({
      socket: state.socket,
      clock: fakeClock(),
      pid: 7,
      version,
      tracking: refusingTracking(),
      aws: refusingAws(),
      secrets: refusingSecrets(),
      board: refusingBoard(),
    });

    try {
      const out = await printed(argv, options(state));

      expect([out.stdout.endsWith(`\n${LINE}\n`), out.stderr.endsWith(`abe: ${LINE}\n`)]).toEqual([
        said.stdout,
        said.stderr,
      ]);
    } finally {
      await serve.stop();
      state.remove();
    }
  });

  test('a serve from before replies without its version: asked with abe status', async () => {
    const state = tempState();
    const asked: unknown[] = [];
    const server = createServer((conn) => {
      conn.once('data', (data) => {
        const { argv } = z.object({ argv: z.array(z.string()) }).parse(JSON.parse(String(data)));
        const status = {
          ok: true,
          data: {
            version: '3.0.0+old',
            pid: 7,
            startedAt: new Date(T0).toISOString(),
            socket: state.socket,
            sessions: 0,
            workspaces: 0,
          },
        };

        asked.push(argv);
        conn.end(
          `${JSON.stringify(
            argv[0] === 'status'
              ? { v: PROTOCOL, exit: 0, stdout: `${JSON.stringify(status)}\n`, stderr: '' }
              : { v: PROTOCOL, exit: 0, stdout: 'none\n', stderr: '' },
          )}\n`,
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(state.socket, resolve));
    try {
      const out = await printed(['card', 'list'], options(state));

      expect([out.stdout, out.stderr, asked]).toEqual([
        'none\n',
        `abe: ${LINE}\n`,
        [
          ['card', 'list'],
          ['status', '--json'],
        ],
      ]);
    } finally {
      server.close();
      state.remove();
    }
  });
});
