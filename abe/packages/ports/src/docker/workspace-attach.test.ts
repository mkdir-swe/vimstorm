/**
 * Attaching to a box session (#63's real-box run): `docker exec -it` leaves its process in the
 * container running when its client dies, so a dropped SSH left a tmux client attached for good,
 * which kept the box up (`idle.keptBy: attached`) forever. The attach's script runs for real here;
 * a fake `docker exec -it` that dies on a hangup and leaves its child running stands in, and a
 * fake tmux client that only waits. The mark the client's pid goes in is a fresh file in the
 * container user's home (0700), never a name in the shared /tmp another user could make first;
 * `home` stands in for it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRunner } from './workspace-runner';

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attach-'));
  home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
});
afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(root, { recursive: true, force: true });
});

const script = (name: string, body: string) => {
  const path = join(root, name);

  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);

  return path;
};

/** `docker exec -it`: the command inside runs on after its client is gone. */
const fakeTerminal = () => script('terminal', `trap 'exit 129' HUP TERM\n"$@" &\nwait $!`);
const fakePlain = () => script('plain', 'exec "$@"');
const fakeTmux = () => script('tmux', 'while :; do sleep 1; done');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const until = async <T>(what: string, look: () => T | undefined): Promise<T> => {
  for (let i = 0; i < 200; i++) {
    const seen = look();

    if (seen !== undefined) return seen;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const attachArgv = (detach: boolean) =>
  workspaceRunner({
    exec: () => Promise.resolve({ exit: 0, stdout: '', stderr: '' }),
    socketDir: root,
    socketMount: '/run/abe',
    attachVia: [fakeTerminal()],
    ...(detach ? { execVia: [fakePlain()] } : {}),
    paths: { home, tmux: [fakeTmux(), '-u'] },
  }).attach('4-0ab8');

const spawn = (argv: readonly string[]) =>
  Bun.spawn([...argv], { stdio: ['ignore', 'ignore', 'pipe'] });

/** The marks in the home: the attach's own files. */
const marks = () => readdirSync(home).filter((name) => name.startsWith('.abe-attach.'));

/** The attach started; its bash, the fake terminal's pid and the client's from the mark. */
const started = async (argv: readonly string[]) => {
  const child = spawn(argv);
  const mark = await until('the mark', () => {
    const [name] = marks();

    return name === undefined ? undefined : join(home, name);
  });
  const client = await until('the pid in the mark', () => {
    const pid = readFileSync(mark, 'utf8').trim();

    return pid === '' ? undefined : Number(pid);
  });
  const terminal = Number(
    Bun.spawnSync(['pgrep', '-P', String(child.pid)])
      .stdout.toString()
      .trim()
      .split('\n')[0],
  );

  return { child, mark, client, terminal };
};

test("a hangup ends the attach's tmux client in the container too", async () => {
  const a = await started(attachArgv(true));

  expect(alive(a.client)).toBe(true);
  // sshd's hangup reaches the attach and the terminal's client, never the process inside.
  process.kill(a.child.pid, 'SIGHUP');
  process.kill(a.terminal, 'SIGHUP');
  expect(await a.child.exited).toBe(129);
  await until('the client gone', () => (alive(a.client) ? undefined : true));
  expect(existsSync(a.mark)).toBe(false);
});

test("the mark is the attach's own fresh file in the home, no name another user could make first", async () => {
  const a = await started(attachArgv(true));

  expect(statSync(a.mark).mode & 0o777).toBe(0o600);
  expect(marks()).toHaveLength(1);
  process.kill(a.client, 'SIGTERM');
  expect(await a.child.exited).toBe(143);
  expect(marks()).toEqual([]);
});

test('a mark that cannot be made aborts the attach before the client starts', async () => {
  chmodSync(home, 0o500);
  const child = spawn(attachArgv(true));

  expect(await child.exited).not.toBe(0);
  expect(await new Response(child.stderr).text()).toContain('no mark for the attach');
  expect(Bun.spawnSync(['pgrep', '-f', join(root, 'tmux')]).exitCode).toBe(1);
});

test('a normal end passes its exit on and only removes the mark', async () => {
  const a = await started(attachArgv(true));

  // The client detached on its own: the terminal's command ends with it.
  process.kill(a.client, 'SIGTERM');
  expect(await a.child.exited).toBe(143);
  expect(existsSync(a.mark)).toBe(false);
});

test('without the plain command the argv is the terminal and the client alone', () => {
  const argv = attachArgv(false);

  expect(argv.slice(1)).toEqual([join(root, 'tmux'), '-u', 'attach-session', '-t', '=abe-4-0ab8']);
});
