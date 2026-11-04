/** `serve` itself: its answers in process, the owner it ends with and the PATH it starts with. */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import {
  BOARD_COMMANDS,
  BOX_COMMANDS,
  BROWSER_COMMANDS,
  DEMO_COMMANDS,
  envelope,
  FACTORY_COMMANDS,
  IMPORT_COMMANDS,
  IMPROVE_COMMANDS,
  INSTALL_COMMANDS,
  LAYER_COMMANDS,
  LOCAL_MODE_COMMANDS,
  LOGIN_COMMANDS,
  PROTOTYPE_COMMANDS,
  readEnvelope,
  Reply,
  REVIEW_COMMANDS,
  SESSION_COMMANDS,
  SHEET_COMMANDS,
  StatusData,
  THEME_COMMANDS,
  ToolsCheckData,
  TRIAGE_COMMANDS,
  WORKFLOW_COMMANDS,
} from '@abe/core';
import { ask } from '@abe/ports';
import { cli, type Cli, scenario, T0, tempState, until } from '@abe/testing';
import { BOARD_HANDLERS } from '../board';
import { BOX_HANDLERS } from '../box';
import { BROWSER_HANDLERS } from '../browser';
import { DEMO_HANDLERS } from '../demo';
import { FACTORY_HANDLERS } from '../factory';
import { IMPROVE_HANDLERS } from '../improve';
import { INSTALL_HANDLERS } from '../install';
import { LAYER_HANDLERS } from '../layer';
import { LOCAL_MODE_HANDLERS } from '../local-mode';
import { LOGIN_HANDLERS } from '../logins';
import { PROTOTYPE_HANDLERS } from '../prototype';
import { REVIEW_HANDLERS } from '../review';
import { SESSION_HANDLERS } from '../session';
import { SHEET_HANDLERS } from '../sheets';
import { WORKFLOW_HANDLERS } from '../skills';
import { THEME_HANDLERS } from '../theme';
import { TRIAGE_HANDLERS } from '../triage';
import { VERSION } from '.';
import { alive, ownerOf, watchOwner } from './owner';

// A folder's set is spread into serve's table, which skips the excess-key check its type would do.
describe("each serve folder's handlers answer only its own noun's rows", () => {
  test.each<[string, object, object[]]>([
    ['board', BOARD_HANDLERS, [BOARD_COMMANDS]],
    ['box', BOX_HANDLERS, [BOX_COMMANDS]],
    ['browser', BROWSER_HANDLERS, [BROWSER_COMMANDS]],
    ['demo', DEMO_HANDLERS, [DEMO_COMMANDS]],
    ['factory', FACTORY_HANDLERS, [FACTORY_COMMANDS]],
    ['improve', IMPROVE_HANDLERS, [IMPROVE_COMMANDS]],
    ['install', INSTALL_HANDLERS, [INSTALL_COMMANDS]],
    ['layer', LAYER_HANDLERS, [LAYER_COMMANDS, IMPORT_COMMANDS]],
    ['local-mode', LOCAL_MODE_HANDLERS, [LOCAL_MODE_COMMANDS]],
    ['logins', LOGIN_HANDLERS, [LOGIN_COMMANDS]],
    ['prototype', PROTOTYPE_HANDLERS, [PROTOTYPE_COMMANDS]],
    ['review', REVIEW_HANDLERS, [REVIEW_COMMANDS]],
    ['session', SESSION_HANDLERS, [SESSION_COMMANDS]],
    ['sheets', SHEET_HANDLERS, [SHEET_COMMANDS]],
    ['skills', WORKFLOW_HANDLERS, [WORKFLOW_COMMANDS]],
    ['theme', THEME_HANDLERS, [THEME_COMMANDS]],
    ['triage', TRIAGE_HANDLERS, [TRIAGE_COMMANDS]],
  ])('%s', (_, handlers, rows) => {
    const own = new Set(rows.flatMap((r) => Object.keys(r)));

    expect(Object.keys(handlers).filter((id) => !own.has(id))).toEqual([]);
  });
});

describe('serve in process, through the socket protocol', () => {
  test('status reports the start time from its clock', async () => {
    await using s = await scenario();

    s.clock.tick(60_000);
    const reply = await s.request('status', '--json');

    expect(reply.exit).toBe(0);
    expect(readEnvelope(StatusData, JSON.parse(reply.stdout))).toEqual({
      ok: true,
      data: {
        version: VERSION,
        pid: process.pid,
        startedAt: new Date(T0).toISOString(),
        socket: s.state.socket,
        sessions: 0,
        workspaces: 0,
      },
    });
  });

  test('status names the abe installed beside its own, as serve reads it now', async () => {
    let installed: string | undefined = VERSION;
    await using s = await scenario({ installed: () => installed });
    const status = async () => {
      const r = await s.request('status', '--json');
      const d = readEnvelope(StatusData, JSON.parse(r.stdout));
      const text = await s.request('status');

      return [
        d.ok ? [d.data.version, d.data.installed] : [],
        text.stdout.split('\n').find((l) => l.startsWith('installed')) ?? null,
      ];
    };

    expect(await status()).toEqual([[VERSION, VERSION], `installed   abe ${VERSION}`]);
    // install.sh replaced it while serve ran
    installed = '99.0.0';
    expect(await status()).toEqual([[VERSION, '99.0.0'], 'installed   abe 99.0.0']);
  });

  test('serve stop answers, then stops and removes the socket', async () => {
    await using s = await scenario();
    const reply = await s.request('serve', 'stop', '--json');

    expect(JSON.parse(reply.stdout)).toEqual({
      ok: true,
      data: { stopped: true, pid: process.pid },
    });
    await s.serve.stopped;
    expect(existsSync(s.state.socket)).toBe(false);
  });
});

const ENTRY = join(import.meta.dir, '..', 'main.ts');

test('abe --version: its build alone, nothing started (what serve asks of the abe installed)', () => {
  const ran = Bun.spawnSync([process.execPath, ENTRY, '--version'], {
    env: { PATH: '/usr/bin:/bin' },
  });

  expect([ran.exitCode, ran.stdout.toString()]).toEqual([0, `${VERSION}\n`]);
});

describe('a serve ends with its owner', () => {
  test('ownerOf reads a positive pid, nothing else', () => {
    expect(ownerOf({ ABE_SERVE_OWNER_PID: '42' })).toBe(42);
    expect(ownerOf({})).toBeUndefined();
    expect(ownerOf({ ABE_SERVE_OWNER_PID: '' })).toBeUndefined();
    expect(ownerOf({ ABE_SERVE_OWNER_PID: '0' })).toBeUndefined();
    expect(ownerOf({ ABE_SERVE_OWNER_PID: 'x' })).toBeUndefined();
  });

  test('ends what it runs, then exits, once the owner is gone', async () => {
    const owner = { up: true };
    const said: string[] = [];
    const unwatch = watchOwner({
      pid: 7,
      alive: () => owner.up,
      gone: () => {
        said.push('gone');

        return Promise.resolve();
      },
      exit: () => said.push('exit'),
      everyMs: 10,
    });

    await Bun.sleep(50);
    expect(said).toEqual([]);
    owner.up = false;
    await until('exit', () => (said.includes('exit') ? true : undefined), { ms: 1_000 });
    unwatch();
    expect(said).toEqual(['gone', 'exit']);
  });

  test('exits once, after the grace, when its stop never settles', async () => {
    let exits = 0;
    const from = Date.now();
    let at = 0;

    watchOwner({
      pid: 7,
      alive: () => false,
      gone: () => new Promise<void>(() => undefined),
      exit: () => {
        exits += 1;
        at = Date.now();
      },
      everyMs: 10,
      graceMs: 200,
    });
    await until('exit', () => (exits > 0 ? true : undefined), { ms: 2_000 });
    await Bun.sleep(100);
    expect(exits).toBe(1);
    expect(at - from).toBeGreaterThanOrEqual(200);
  });

  test('exits once when its stop rejects or throws', async () => {
    const fails: (() => Promise<void>)[] = [
      () => Promise.reject(new Error('x')),
      () => {
        throw new Error('y');
      },
    ];

    for (const gone of fails) {
      let exits = 0;

      watchOwner({
        pid: 7,
        alive: () => false,
        gone,
        exit: () => (exits += 1),
        everyMs: 10,
        graceMs: 50,
      });
      await until('exit', () => (exits > 0 ? true : undefined), { ms: 1_000 });
      await Bun.sleep(100);
      expect(exits).toBe(1);
    }
  });

  // Two clients auto-starting at once start two serves; the one that loses the socket printed
  // "something answers" and then ran on unwatched, a handle its start left open (the orphans).
  // After `abe serve stop`, the app's and a command's starts raced: one serve ran on, its socket
  // gone, and nothing answered.
  test('of serves started at once one runs and answers, the rest exit; again right after a stop; the winner ends once its owner is SIGKILLed', async () => {
    const state = tempState();
    const owner = Bun.spawn(['sleep', '60']);
    const started: Bun.Subprocess<'ignore', 'pipe', 'pipe'>[] = [];
    const startAll = () =>
      [0, 1, 2].map(() => {
        const s = Bun.spawn([process.execPath, ENTRY, 'serve'], {
          env: { ...state.env, ABE_SERVE_OWNER_PID: String(owner.pid) },
          cwd: state.dir,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        started.push(s);

        return s;
      });
    const within = (exited: Promise<number>, ms: number) =>
      Promise.race([exited, Bun.sleep(ms).then(() => 'still running')]);
    const status = async () => {
      const asked = await ask(
        state.socket,
        JSON.stringify({ v: 1, argv: ['status', '--json'], cwd: state.dir }),
        5_000,
      );

      return asked.ok
        ? readEnvelope(StatusData, JSON.parse(Reply.parse(JSON.parse(asked.line)).stdout))
        : undefined;
    };
    /** One of `serves` runs and answers on the socket, the others exited 1. */
    const oneRuns = async (serves: typeof started) => {
      await until(
        'a serve answering',
        async () => ((await status()) === undefined ? undefined : true),
        {
          ms: 15_000,
        },
      );
      const ended: (number | undefined)[] = serves.map(() => undefined);

      serves.forEach((s, i) => {
        void s.exited.then((code) => {
          ended[i] = code;
        });
      });
      await until(
        'two serves exited',
        () => (ended.filter((e) => e !== undefined).length >= 2 ? true : undefined),
        { ms: 8_000 },
      );
      const running = serves.filter((_, i) => ended[i] === undefined);

      expect(running).toHaveLength(1);
      expect(ended.filter((e) => e !== undefined)).toEqual([1, 1]);
      const [winner] = running;

      if (winner === undefined) throw new Error('no serve runs');
      expect(alive(winner.pid)).toBe(true);
      // the losers left its socket alone
      expect(await status()).toMatchObject({ ok: true, data: { pid: winner.pid } });

      return winner;
    };

    try {
      const first = await oneRuns(startAll());
      // a client that has not asked yet: the stopped serve's close waits for it
      const idle = createConnection(state.socket);

      idle.on('error', () => undefined);
      await new Promise((resolve) => idle.once('connect', resolve));
      const stopped = await ask(
        state.socket,
        JSON.stringify({ v: 1, argv: ['serve', 'stop'], cwd: state.dir }),
      );

      expect(stopped.ok).toBe(true);
      const winner = await oneRuns(startAll());

      idle.destroy();
      expect(await within(first.exited, 8_000)).toBe(0);
      expect(await status()).toMatchObject({ ok: true, data: { pid: winner.pid } });
      owner.kill('SIGKILL');
      expect(await within(winner.exited, 12_000)).toBe(0);
    } finally {
      owner.kill('SIGKILL');
      for (const s of started) s.kill('SIGKILL');
      state.remove();
    }
  }, 90_000);
});

// The Mac's serve takes its person's login shell's PATH at start: a real `abe` and its detached
// `serve`, started with a minimal PATH and a fake login shell, read through `abe tools check`.

const open: Cli[] = [];

afterEach(async () => {
  for (const abe of open.splice(0)) await abe.close();
});

const script = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

/** A `node` that says its version. */
const node = (dir: string) => {
  script(join(dir, 'node'), 'echo v22.11.0');
};

/** An `abe` whose serve reads the login shell `body` runs, its HOME the state directory. */
const started = (body: string) => {
  const abe = cli({ env: { ABE_LOGIN_PATH: '' } });
  const shell = join(abe.state.dir, 'zsh');

  open.push(abe);
  script(shell, body);

  return { abe, shell, home: abe.state.dir };
};

const nodeRow = async (abe: Cli, shell: string) => {
  const ran = await abe.runWith({ env: { SHELL: shell } }, 'tools', 'check', '--json');
  const doc = envelope(ToolsCheckData).parse(JSON.parse(ran.stdout));

  if (!doc.ok) throw new Error(doc.error.message);

  return doc.data.tools.find((t) => t.tool === 'node');
};

test("serve's PATH is the login shell's first: its node is found, where it is", async () => {
  const { abe, shell, home } = started(`printf %s "$HOME/login-bin:$PATH" > "$ABE_PATH_OUT"`);

  node(join(home, 'login-bin'));
  expect(await nodeRow(abe, shell)).toMatchObject({
    state: 'ok',
    version: '22.11.0',
    where: join(home, 'login-bin', 'node'),
  });
  expect(readFileSync(join(home, 'serve.log'), 'utf8')).toContain(
    `PATH from your login shell (${shell})`,
  );
});

test("no PATH from the shell: Volta's node on disk is still found", async () => {
  const { abe, shell, home } = started('exit 1');

  node(join(home, '.volta', 'bin'));
  expect(await nodeRow(abe, shell)).toMatchObject({
    state: 'ok',
    where: join(home, '.volta', 'bin', 'node'),
    manager: 'Volta',
  });
  expect(readFileSync(join(home, 'serve.log'), 'utf8')).toContain(
    `PATH as serve was started (${shell} -lic printed no PATH (exit 1)), with Volta's node`,
  );
});
