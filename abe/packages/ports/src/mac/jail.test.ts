/**
 * A local session's jail run for real (ADR 0029: environment access held, the rest open): the
 * profile `sessionBoundary` and `jailed` make
 * for a card's worktree, and the wrapper Claude Code runs each command line through, under macOS's
 * `sandbox-exec`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  homeSecrets,
  jailed,
  jailWrapper,
  sessionBoundary,
  sessionSettings,
  withWorktreeHeld,
} from '@abe/core';

const top = realpathSync(mkdtempSync(join(tmpdir(), 'abe-jail-')));
const checkout = join(top, 'shop');
const worktree = join(top, 'shop-wt', '4-cart');
const home = join(top, 'home');
const state = join(top, 'state');

afterAll(() => {
  rmSync(top, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: GIT_ENV });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: home,
  GIT_AUTHOR_NAME: 'Kim',
  GIT_AUTHOR_EMAIL: 'kim@example.com',
  GIT_COMMITTER_NAME: 'Kim',
  GIT_COMMITTER_EMAIL: 'kim@example.com',
};

mkdirSync(home, { recursive: true });
mkdirSync(checkout, { recursive: true });
git(checkout, 'init', '-q', '-b', 'main');
writeFileSync(join(checkout, 'README.md'), 'shop\n');
git(checkout, 'add', '.');
git(checkout, 'commit', '-q', '-m', 'First.');
git(checkout, 'worktree', 'add', '-q', '-b', 'card/4-cart', worktree);

/**
 * The jail of a session working in `tree` (a card's worktree), its profile and wrapper written in
 * its own folder as the runner writes them; a command line run through it the way Claude Code
 * runs one, in the tree.
 */
const jailAt = (tree: string, id: string) => {
  const folder = join(state, 'sessions', id);
  const settings = sessionSettings({
    abe: join(state, 'bin', 'abe'),
    models: { coordinator: 'opus', reader: 'haiku', writer: 'sonnet' },
    allowedModels: [],
    allow: [],
    boundary: sessionBoundary({
      state,
      serveSocket: join(state, 'serve.sock'),
      plugins: join(top, 'plugins'),
      socket: join(folder, 'session.sock'),
      checkout,
      home,
      worktree: tree,
      // the person's secrets, and an env file of an environment off (ADR 0029)
      secrets: [...homeSecrets(home), join(checkout, '.abe', 'abe.prod.env')],
    }),
    skillsOnTop: false,
    home,
    mode: 'auto',
  });
  const jail = jailed(withWorktreeHeld(settings, tree));
  const profile = join(folder, 'jail.sb');
  const wrapper = join(folder, 'jail.sh');

  mkdirSync(folder, { recursive: true });
  writeFileSync(profile, `${jail?.profile ?? ''}\n`);
  writeFileSync(wrapper, jailWrapper(profile), { mode: 0o700 });

  return (line: string, env: Record<string, string> = {}) => {
    const ran = Bun.spawnSync([wrapper, line], { cwd: tree, env: { ...GIT_ENV, ...env } });

    return { exit: ran.exitCode, out: ran.stdout.toString().trim(), err: ran.stderr.toString() };
  };
};

const jailedRun = jailAt(worktree, '4');

describe("the wrapper runs a command line in the shell it is written for: its snapshot's", () => {
  // Claude Code's line sources its snapshot of the person's shell, functions and all.
  const snapshot = join(home, '.claude', 'shell-snapshots', 'snapshot-zsh-1-abcd.sh');

  mkdirSync(join(home, '.claude', 'shell-snapshots'), { recursive: true });
  writeFileSync(
    snapshot,
    'awake-d () {\n  local -a parts\n  parts=(${(s/:/)1})\n  print -r -- ${#parts}\n}\n',
  );
  const line = `source ${snapshot} && eval 'awake-d a:b:c'`;

  test.each<[string, Record<string, string>]>([
    ["the person's SHELL", { SHELL: '/bin/zsh' }],
    ['no SHELL', {}],
    ['a SHELL of another kind', { SHELL: '/bin/bash' }],
  ])('a zsh-only function in a zsh snapshot, %s', (_, env) => {
    expect(jailedRun(line, env)).toMatchObject({ exit: 0, out: '3' });
  });

  test('/bin/sh dies on it (the line as it ran before)', () => {
    const ran = Bun.spawnSync(['/bin/sh', '-c', line], { cwd: worktree, env: GIT_ENV });

    expect(ran.exitCode).not.toBe(0);
  });

  test('a line with no snapshot: SHELL when zsh or bash, else /bin/sh', () => {
    expect(jailedRun('echo "${ZSH_VERSION:+zsh}"', { SHELL: '/bin/zsh' }).out).toBe('zsh');
    expect(
      jailedRun('echo "${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}"', { SHELL: '/opt/fish' }),
    ).toMatchObject({
      exit: 0,
      out: 'bash',
    });
  });
});

describe("git in a card's worktree: a commit and a branch written", () => {
  test('a commit, its branch moved, its log written', () => {
    const made = jailedRun(
      'echo cart >> README.md && git add README.md && git commit -q -m "Cart." && git log -1 --format=%s',
    );

    expect(made).toMatchObject({ exit: 0, out: 'Cart.' });
    expect(jailedRun('git branch -q card/4-more && git branch --list "card/*"').out).toContain(
      'card/4-more',
    );
  });

  test('its config and hooks held, a commit still made', () => {
    expect(
      jailedRun(`echo 'exit 0' > '${join(checkout, '.git', 'hooks', 'pre-push')}'`).exit,
    ).not.toBe(0);
    expect(jailedRun('git config user.name Someone').exit).not.toBe(0);
    expect(
      jailedRun('echo more >> README.md && git commit -qam "More." && git log -1 --format=%s'),
    ).toMatchObject({ exit: 0, out: 'More.' });
  });

  test('a worktree git named apart from its folder (a name taken): it commits there too', () => {
    const elsewhere = join(top, 'mine', '4-cart');

    git(checkout, 'worktree', 'add', '-q', '-b', 'card/4-mine', elsewhere);
    expect(
      jailAt(
        elsewhere,
        '5',
      )('echo x > x && git add x && git commit -q -m "Mine." && git log -1 --format=%s'),
    ).toMatchObject({ exit: 0, out: 'Mine.' });
  });
});

describe('writes open but what decides its reach (ADR 0029)', () => {
  const outside = join(top, 'elsewhere');

  mkdirSync(outside, { recursive: true });
  mkdirSync(join(checkout, '.abe'), { recursive: true });
  writeFileSync(join(checkout, '.abe', 'abe.prod.env'), 'PROD_KEY=canary\n');
  writeFileSync(join(checkout, '.abe', 'abe.dev.env'), 'DEV_KEY=dev\n');

  test.each<[string, string]>([
    ['a folder outside the worktree', join(outside, 'note.txt')],
    ["the repository's info (not run by git)", join(checkout, '.git', 'info', 'exclude')],
    ['HOME', join(home, 'notes.txt')],
  ])('%s: written', (_, path) => {
    expect(jailedRun(`echo '# x' >> '${path}'`).exit).toBe(0);
  });

  test.each<[string, string]>([
    ['your own settings in the checkout', join(checkout, '.abe', 'settings.local.yaml')],
    ['your own settings in its worktree', join(worktree, '.abe', 'settings.local.yaml')],
    ["the repo's settings in the checkout", join(checkout, 'abe.yaml')],
    ['an Abe env file', join(checkout, '.abe', 'abe.dev.env')],
    ['Abe state', join(state, 'x')],
    // serve's own git runs these outside the jail
    ["the repository's config", join(checkout, '.git', 'config')],
    ["the repository's hooks", join(checkout, '.git', 'hooks', 'pre-push')],
    ["the worktree's own config", join(checkout, '.git', 'worktrees', '4-cart', 'config.worktree')],
  ])('%s: never written', (_, path) => {
    const ran = jailedRun(
      `mkdir -p "$(dirname '${path}')"; echo 'agents: {prod: true}' >> '${path}'`,
    );

    expect(ran.exit).not.toBe(0);
    expect(ran.err.toLowerCase()).toContain('operation not permitted');
  });

  test("an off environment's env file: never read; an on one's read", () => {
    const off = jailedRun(`cat '${join(checkout, '.abe', 'abe.prod.env')}'`);

    expect(off.exit).not.toBe(0);
    expect(off.out).not.toContain('canary');
    expect(jailedRun(`cat '${join(checkout, '.abe', 'abe.dev.env')}'`).out).toBe('DEV_KEY=dev');
  });

  test("a person's secret: never read", () => {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key\n');
    expect(jailedRun(`cat '${join(home, '.ssh', 'id_ed25519')}'`).exit).not.toBe(0);
  });
});

describe("Unix sockets: open but Abe's own (serve's, another session's)", () => {
  const listen = (path: string) => {
    mkdirSync(join(path, '..'), { recursive: true });

    return Bun.listen({ unix: path, socket: { data: () => undefined } });
  };
  // a socket's path is at most 104 bytes: one of its own, short
  const open = join(realpathSync(tmpdir()), `abe-sock-${process.pid}.sock`);
  const servers = [
    listen(open),
    listen(join(state, 'serve.sock')),
    listen(join(state, 'sessions', '9', 'session.sock')),
    listen(join(state, 'sessions', '4', 'session.sock')),
  ];
  const connects = (path: string) =>
    jailedRun(
      `/usr/bin/python3 -I -c 'import socket,sys; socket.socket(socket.AF_UNIX).connect(sys.argv[1])' '${path}'`,
    ).exit === 0;

  afterAll(() => {
    for (const s of servers) s.stop(true);
    rmSync(open, { force: true });
  });

  test("another tool's (Docker's, a database's): reached", () => {
    expect(connects(open)).toBe(true);
  });

  test("its own session's: reached", () => {
    expect(connects(join(state, 'sessions', '4', 'session.sock'))).toBe(true);
  });

  test.each([
    ["serve's", join(state, 'serve.sock')],
    ["another session's", join(state, 'sessions', '9', 'session.sock')],
  ])('%s: never', (_, path) => {
    expect(connects(path)).toBe(false);
  });
});

describe("Claude Code's folder file: written, so a command's exit code and folder are its own", () => {
  const file = `/tmp/claude-${process.pid.toString(16)}a-cwd`;

  afterAll(() => {
    rmSync(file, { force: true });
  });

  test('its pwd written where Claude Code reads it', () => {
    expect(jailedRun(`pwd -P >| ${file}`).exit).toBe(0);
    expect(readFileSync(file, 'utf8').trim()).toBe(worktree);
  });
});

describe("Claude Code's own tokens: never handed to a command", () => {
  test('CLAUDE_CODE_*_TOKEN unset, the rest of the environment kept', () => {
    const ran = jailedRun('env | cut -d= -f1 | sort', {
      CLAUDE_CODE_MESSAGING_TOKEN: 'm',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'r',
      CLAUDE_CODE_SESSION_ID: 's',
      ABE_DB_READ_URL_TEST: 'postgres://r@db/x',
    });
    const names = ran.out.split('\n');

    expect(ran.exit).toBe(0);
    expect(names.filter((n) => n.endsWith('_TOKEN'))).toEqual([]);
    expect(names).toContain('CLAUDE_CODE_SESSION_ID');
    expect(names).toContain('ABE_DB_READ_URL_TEST');
  });
});
