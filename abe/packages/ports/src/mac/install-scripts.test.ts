/**
 * The install's start and stop helpers (`skills/install/scripts/ports.sh`, shipped in its plugin)
 * run for real, as `abe run` runs the scripts (`localSessionApps`, in its sandbox: no setuid tool
 * such as ps runs there): start waits for its own server on the port, stop ends the process group
 * and then what it started still on the port, a shim's forked server too, and never anything else.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTALL_SKILLS } from '@abe/core';
import { localSessionApps } from './session-apps';

const PORTS = INSTALL_SKILLS.find((f) => f.path === 'skills/install/scripts/ports.sh')?.text ?? '';
const ENV = { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', HOME: tmpdir() };
const SERVER = 'Bun.serve({ port: Number(process.argv[2]), fetch: () => new Response("ok") });\n';

let top: string;
const kept: number[] = [];

const freePort = (): number => {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = s;

  void s.stop(true);

  return port ?? 0;
};

const answers = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });

    return true;
  } catch {
    return false;
  }
};

const until = async (what: () => Promise<boolean>, ms = 5000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await what()) return true;
    await Bun.sleep(100);
  }

  return false;
};

const script = (name: string, text: string) => {
  const path = join(top, '.claude', 'skills', 'run-app', 'scripts', name);

  writeFileSync(path, text);
  chmodSync(path, 0o755);
};

/** A script run as `abe run` runs it: to its end, in a process group and sandbox of its own. */
const run = (name: string, port: number, path = ENV.PATH) =>
  localSessionApps({ stateDir: join(top, 'state') }).run({
    id: '1-ab12',
    cwd: top,
    script: `.claude/skills/run-app/scripts/${name}`,
    args: [],
    env: { ...ENV, PATH: path, PORT: String(port) },
    timeoutMs: 30_000,
    keep: true,
    denyRead: [join(top, '.env.aws.local')],
  });

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), 'install-scripts-'));
  mkdirSync(join(top, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
  writeFileSync(join(top, 'server.js'), SERVER);
  script('ports.sh', PORTS);
  // like Volta's node: a shim that forks the real server into a process group of its own
  script(
    'shim',
    `#!/bin/bash\nset -m\n'${process.execPath}' "$(dirname "$0")/../../../../server.js" "$1" &\nwait\n`,
  );
  script(
    'start',
    [
      '#!/bin/sh',
      'cd "$(dirname "$0")/../../../.."',
      '. .claude/skills/run-app/scripts/ports.sh',
      'abe_run_start',
      'abe_port_free "$PORT" || exit 1',
      '.claude/skills/run-app/scripts/shim "$PORT" >"$ABE_RUN/web.log" 2>&1 &',
      'abe_bound "$PORT" 20 || exit 1',
      'echo "http://localhost:$PORT"',
      '',
    ].join('\n'),
  );
  script(
    'stop',
    [
      '#!/bin/sh',
      'set -e',
      'cd "$(dirname "$0")/../../../.."',
      '. .claude/skills/run-app/scripts/ports.sh',
      'abe_stop',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  for (const pid of kept)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  rmSync(top, { recursive: true, force: true });
});

describe('the install’s start and stop: its own server on the port, then all of it gone', () => {
  test('start waits for its server, forked apart by a shim; stop ends the group and that server', async () => {
    const port = freePort();
    const started = await run('start', port);

    expect([started.exit, started.stdout.trim().split('\n').at(-1)]).toEqual([
      0,
      `http://localhost:${port}`,
    ]);
    expect(await answers(port)).toBe(true);
    const stopped = await run('stop', port);

    expect(stopped.exit).toBe(0);
    expect(await until(async () => !(await answers(port)))).toBe(true);
  });

  test('stop from a shell that may signal nothing, as a session’s: it fails saying so and keeps the run, which abe run stop then ends', async () => {
    const port = freePort();

    expect((await run('start', port)).exit).toBe(0);
    const state = ['pgid', 'owners'].map((f) => join(top, '.abe', '.run', f));
    const refused = Bun.spawnSync(
      [
        '/usr/bin/sandbox-exec',
        '-p',
        '(version 1) (allow default) (deny signal)',
        join(top, '.claude', 'skills', 'run-app', 'scripts', 'stop'),
      ],
      { cwd: top, env: ENV },
    );
    const said = refused.stderr.toString();

    expect(refused.exitCode).toBe(1);
    expect(said).toMatch(/^could not stop process group \d+: this shell may not signal it/);
    expect(said).toContain(`could not stop pid `);
    expect(said).toContain(`on port ${port}: this shell may not signal it`);
    expect(state.map((f) => existsSync(f))).toEqual([true, true]);
    expect(await answers(port)).toBe(true);
    const stopped = await run('stop', port);

    expect([stopped.exit, stopped.stderr]).toEqual([0, '']);
    expect(await until(async () => !(await answers(port)))).toBe(true);
    expect(state.map((f) => existsSync(f))).toEqual([false, false]);
  });

  test('stop once all of the run is gone already: the port free, it exits 0', async () => {
    const port = freePort();

    expect((await run('start', port)).exit).toBe(0);
    const ofRun = (f: string) => readFileSync(join(top, '.abe', '.run', f), 'utf8').trim();
    const [, server] = ofRun('owners').split(' ');

    process.kill(-Number(ofRun('pgid')), 'SIGKILL');
    process.kill(Number(server), 'SIGKILL');
    expect(await until(async () => !(await answers(port)))).toBe(true);
    const stopped = await run('stop', port);

    expect([stopped.exit, stopped.stderr]).toEqual([0, '']);
    expect(existsSync(join(top, '.abe', '.run', 'pgid'))).toBe(false);
  });

  test('no lsof: the port checks off, said why; start and stop still run, the group ended', async () => {
    // a PATH with the tools the scripts use, and no lsof
    const bin = join(top, 'bin-no-lsof');

    mkdirSync(bin);
    for (const tool of [
      'sh',
      'bash',
      'awk',
      'sed',
      'head',
      'mkdir',
      'sleep',
      'cat',
      'rm',
      'dirname',
    ]) {
      const at = Bun.which(tool, { PATH: ENV.PATH });

      if (at !== null) symlinkSync(at, join(bin, tool));
    }
    const port = freePort();
    const off =
      'port checks off: lsof is not on PATH, so start does not check that a port is free or that its own server bound it, and stop ends only the process group';
    const started = await run('start', port, bin);

    expect([started.exit, started.stdout.trim(), started.stderr.trim()]).toEqual([
      0,
      `http://localhost:${port}`,
      off,
    ]);
    expect(await until(() => answers(port))).toBe(true);
    const stopped = await run('stop', port, bin);

    expect([stopped.exit, stopped.stderr.trim()]).toEqual([0, off]);
    // the shim's server left the group: without the checks it stays (ended here)
    const left = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      env: ENV,
    });

    for (const pid of left.stdout
      .toString()
      .split('\n')
      .filter((p) => p !== ''))
      kept.push(Number(pid));
  });

  test('a port something else holds: start fails saying what, stop leaves it as it is', async () => {
    const port = freePort();
    const other = Bun.spawn([process.execPath, join(top, 'server.js'), String(port)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });

    kept.push(other.pid);
    expect(await until(() => answers(port))).toBe(true);
    const started = await run('start', port);

    expect([started.exit, started.stdout]).toEqual([1, '']);
    expect(started.stderr).toMatch(
      new RegExp(`^port ${port} is held by \\S+ \\(pid ${other.pid}\\): stop it first`),
    );
    // a run that bound it once: its owner gone, the port someone else's now
    writeFileSync(join(top, '.abe', '.run', 'pgid'), '999999\n');
    writeFileSync(join(top, '.abe', '.run', 'owners'), `${port} 999998\n`);
    const stopped = await run('stop', port);

    expect(stopped.exit).toBe(1);
    expect(stopped.stderr).toContain(`port ${port} is held by `);
    expect(stopped.stderr).toContain(`(pid ${other.pid}), not this run's: left as it is`);
    expect(await answers(port)).toBe(true);
    expect(
      readFileSync(join(top, '.claude', 'skills', 'run-app', 'scripts', 'ports.sh'), 'utf8'),
    ).toBe(PORTS);
  });
});
