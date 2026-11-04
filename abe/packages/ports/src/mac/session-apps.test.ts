/**
 * A local session's apps (#182) with real processes: a pack script run in its own group, what it
 * leaves running stopped at the session's end (the stop script first, then the group), and what
 * the session's agent started with its socket in the environment found by `ps -E` and stopped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_OF } from '@abe/core';
import { localSessionApps } from './session-apps';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const until = async (what: string, ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;

  while (!ok()) {
    if (Date.now() > end) throw new Error(`still not: ${what}`);
    await Bun.sleep(25);
  }
};

const script = (dir: string, name: string, body: string) => {
  mkdirSync(join(dir, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
  const path = join(dir, '.claude', 'skills', 'run-app', 'scripts', name);

  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

describe.skipIf(process.platform !== 'darwin')("a local session's apps", () => {
  let root: string;
  let state: string;
  let tree: string;
  const id = '4-ab12';
  const socket = () => join(state, 'sessions', id, 'session.sock');
  const env = () => ({ PATH: '/usr/bin:/bin', HOME: root, [APP_OF]: id });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-apps-'));
    state = join(root, 'state');
    tree = join(root, 'demo-wt', '4-cart');
    mkdirSync(tree, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a script runs in its worktree with exactly its env, its output kept, its exit said', async () => {
    script(
      tree,
      'seed',
      'pwd; echo "token=${GH_TOKEN:-none} mark=$ABE_APP_OF arg=$1"; echo oops >&2; exit 3',
    );
    const apps = localSessionApps({ stateDir: state });
    const ran = await apps.run({
      id,
      cwd: tree,
      script: '.claude/skills/run-app/scripts/seed',
      args: ['x'],
      env: env(),
      timeoutMs: 10_000,
      keep: true,
    });

    expect(ran.exit).toBe(3);
    expect(ran.stdout.split('\n').slice(1).join('\n')).toBe('token=none mark=4-ab12 arg=x\n');
    expect(ran.stderr).toBe('oops\n');
  });

  test('never-read paths: neither the script nor what it starts reads them, the rest it reads', async () => {
    mkdirSync(join(tree, 'backend', 'secrets'), { recursive: true });
    writeFileSync(join(tree, 'backend', '.env.aws.dev'), 'AWS_ACCESS_KEY_ID=AKIAFAKE\n');
    writeFileSync(join(tree, 'backend', 'secrets', 'key'), 'k\n');
    writeFileSync(join(tree, 'backend', '.env.example'), 'A=\n');
    script(
      tree,
      'start',
      [
        'for f in backend/.env.aws.dev backend/secrets/key backend/.env.example; do',
        '  /bin/sh -c "cat $f >/dev/null 2>&1" && echo "$f read" || echo "$f unread"',
        'done',
      ].join('\n'),
    );
    const ran = await localSessionApps({ stateDir: state }).run({
      id,
      cwd: tree,
      script: '.claude/skills/run-app/scripts/start',
      args: [],
      env: env(),
      timeoutMs: 10_000,
      keep: false,
      denyRead: [join(tree, 'backend', '.env.aws.dev'), join(tree, 'backend', 'secrets')],
    });

    expect([ran.exit, ran.stdout]).toEqual([
      0,
      'backend/.env.aws.dev unread\nbackend/secrets/key unread\nbackend/.env.example read\n',
    ]);
  });

  test('no script, or one not executable, is said as a shell would', async () => {
    const apps = localSessionApps({ stateDir: state });
    const missing = await apps.run({
      id,
      cwd: tree,
      script: '.claude/skills/run-app/scripts/x',
      args: [],
      env: env(),
      timeoutMs: 1000,
      keep: true,
    });

    expect(missing.exit).toBe(127);
    script(tree, 'y', 'true');
    chmodSync(join(tree, '.claude', 'skills', 'run-app', 'scripts', 'y'), 0o644);
    expect(
      (
        await apps.run({
          id,
          cwd: tree,
          script: '.claude/skills/run-app/scripts/y',
          args: [],
          env: env(),
          timeoutMs: 1000,
          keep: true,
        })
      ).exit,
    ).toBe(126);
  });

  test('one that runs too long is killed, its exit null', async () => {
    script(tree, 'slow', 'sleep 30');
    const apps = localSessionApps({ stateDir: state });
    const ran = await apps.run({
      id,
      cwd: tree,
      script: '.claude/skills/run-app/scripts/slow',
      args: [],
      env: env(),
      timeoutMs: 300,
      keep: false,
    });

    expect(ran.exit).toBeNull();
  });

  test('abe run stop: what start left in its worktree stopped by serve, whatever the stop script did', async () => {
    const base = `${tree}-base`;

    mkdirSync(base, { recursive: true });
    for (const t of [tree, base]) {
      script(
        t,
        'start',
        `'${process.execPath}' -e 'setTimeout(() => {}, 300000)' >/dev/null 2>&1 &\necho $! > app.pid`,
      );
      // A stop that ends nothing, as one whose kills a sandbox refuses.
      script(t, 'stop', 'exit 1');
    }
    const apps = localSessionApps({ stateDir: state });
    const run = (cwd: string, name: string) =>
      apps.run({
        id,
        cwd,
        script: `.claude/skills/run-app/scripts/${name}`,
        args: [],
        env: env(),
        timeoutMs: 10_000,
        keep: true,
      });

    for (const t of [tree, base]) expect((await run(t, 'start')).exit).toBe(0);
    const [mine, before] = [tree, base].map((t) =>
      Number(readFileSync(join(t, 'app.pid'), 'utf8')),
    );

    try {
      expect((await run(tree, 'stop')).exit).toBe(1);
      await until('the worktree’s app stopped', () => !alive(mine ?? 0));
      expect(alive(before ?? 0)).toBe(true);
      expect(await apps.end({ id, socket: socket(), env: env() })).toContain(
        'stopped 1 process group(s)',
      );
    } finally {
      for (const pid of [mine, before])
        if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  test('the end: the stop script in each worktree, then the groups, then what the agent left', async () => {
    const base = `${tree}-base`;

    mkdirSync(base, { recursive: true });
    // Each start leaves a server running in its group, its pid in a file, as a pack's would.
    for (const t of [tree, base]) {
      script(
        t,
        'start',
        `'${process.execPath}' -e 'setTimeout(() => {}, 300000)' >/dev/null 2>&1 &\necho $! > app.pid\necho http://127.0.0.1:3001`,
      );
      script(t, 'stop', 'echo stopped >> stop.log');
    }
    const apps = localSessionApps({ stateDir: state });

    for (const t of [tree, base])
      expect(
        (
          await apps.run({
            id,
            cwd: t,
            script: '.claude/skills/run-app/scripts/start',
            args: [],
            env: env(),
            timeoutMs: 10_000,
            keep: true,
          })
        ).exit,
      ).toBe(0);
    const pids = [tree, base].map((t) => Number(readFileSync(join(t, 'app.pid'), 'utf8')));

    expect(pids.every(alive)).toBe(true);
    // What the agent started itself in the sandbox, out of any group of ours, its socket in its env.
    const agent = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 300_000)'], {
      env: { PATH: '/usr/bin:/bin', ABE_SOCKET: socket() },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    // Another session's, with a socket that starts the same way: left alone.
    const other = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 300_000)'], {
      env: { PATH: '/usr/bin:/bin', ABE_SOCKET: join(state, 'sessions', '4-ab1', 'session.sock') },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    // A group kept in the file whose number is someone else's now (reused): never signalled.
    const stranger = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 300_000)'], {
      env: { PATH: '/usr/bin:/bin' },
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    appendFileSync(
      join(state, 'sessions', id, 'apps', 'apps.jsonl'),
      `${JSON.stringify({ pgid: stranger.pid, cwd: tree })}\n`,
    );
    await Bun.sleep(300);
    try {
      const said = await apps.end({ id, socket: socket(), env: env() });

      await until(
        "the apps and the agent's server stopped",
        () => !pids.some(alive) && !alive(agent.pid),
      );
      expect([tree, base].map((t) => readFileSync(join(t, 'stop.log'), 'utf8'))).toEqual([
        'stopped\n',
        'stopped\n',
      ]);
      expect(said.join('\n')).toContain('process(es) the session left');
      expect(alive(other.pid)).toBe(true);
      expect(alive(stranger.pid)).toBe(true);
      expect(existsSync(join(state, 'sessions', id, 'apps', 'apps.jsonl'))).toBe(false);
      // Ended: nothing to do a second time.
      expect(await apps.end({ id, socket: socket(), env: env() })).toEqual([]);
    } finally {
      agent.kill('SIGKILL');
      other.kill('SIGKILL');
      stranger.kill('SIGKILL');
    }
  });
});
