/** The local runner's source servers by folder (ADR 0027): every folder of a repo gets its main checkout's. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argvFile, ENTER, envFile, tmuxRunner } from './tmux';

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  });

  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
};

describe("sourceServers at a folder: a bare sources: name from its main checkout's local scope", () => {
  let root: string;
  let home: string;
  let main: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-src-')));
    home = join(root, 'home');
    main = join(root, 'shop');
    mkdirSync(home);
    mkdirSync(join(main, 'web'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(
      main,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'a',
    );
    git(main, 'worktree', 'add', '-q', join(root, 'shop-wt', 'card-1'), '-b', 'card-1');
    git(main, 'worktree', 'add', '-q', join(root, 'linked'), '-b', 'mine');
    mkdirSync(join(root, 'shop2'));
    git(join(root, 'shop2'), 'init', '-q', '-b', 'main');
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
        projects: {
          [main]: { mcpServers: { sentry: { type: 'http', url: 'https://s.test/mcp' } } },
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test.each<[string, (r: string) => string, string[]]>([
    ['the main checkout', (r) => join(r, 'shop'), ['sentry']],
    ['a folder in it', (r) => join(r, 'shop', 'web'), ['sentry']],
    ['a card worktree beside it', (r) => join(r, 'shop-wt', 'card-1'), ['sentry']],
    ['a linked worktree of it', (r) => join(r, 'linked'), ['sentry']],
    ['a sibling checkout: none', (r) => join(r, 'shop2'), []],
  ])('%s', (_, folder, loaded) => {
    const runner = tmuxRunner({
      stateDir: join(root, 'state'),
      tmux: null,
      env: { HOME: home, PATH: process.env.PATH ?? '' },
      self: ['abe'],
      plugins: join(root, 'plugins'),
    });

    expect(
      runner.sourceServers?.({ repo: folder(root), sources: ['sentry'], home }).loaded,
    ).toEqual(loaded);
  });
});

const TMUX = Bun.which('tmux', { PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin` });

describe.skipIf(TMUX === null)('send: Enter only once the paste shows in the pane', () => {
  let state: string;
  const tmux = TMUX ?? 'tmux';
  const tmuxAt = (...args: string[]) =>
    Bun.spawnSync([tmux, '-u', '-S', join(state, 'tmux.sock'), '-f', '/dev/null', ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: state },
    });
  const runner = () =>
    tmuxRunner({ stateDir: state, tmux, env: process.env, self: ['abe'], plugins: state });

  beforeAll(() => {
    state = realpathSync(mkdtempSync(join(tmpdir(), 'abe-send-')));
  });

  afterAll(() => {
    tmuxAt('kill-server');
    rmSync(state, { recursive: true, force: true });
  });

  test('a pane that takes the paste gets the line and its Enter', async () => {
    tmuxAt('new-session', '-d', '-s', 'abe-cat', '-x', '80', '-y', '10', 'cat');
    const sent = await runner().send('cat', 'hello there');

    expect(sent.ok).toBe(true);
    await Bun.sleep(200);
    const shown = tmuxAt('capture-pane', '-p', '-t', '=abe-cat:').stdout.toString();

    // cat echoes the typed line, then prints it once Enter ends it
    expect(shown.match(/hello there/g)?.length).toBe(2);
  });

  test('a pane the paste never shows in is refused, and no Enter goes to it', async () => {
    // a pane whose screen does not change: its tty neither echoes nor reads
    tmuxAt('new-session', '-d', '-s', 'abe-deaf', '-x', '80', '-y', '10', 'stty -echo; sleep 30');
    await Bun.sleep(200);
    const sent = await runner().send('deaf', 'hello there');

    expect(sent.ok).toBe(false);
    expect(sent.ok ? '' : sent.error.message).toContain('never showed');
  });
});

describe.skipIf(TMUX === null)(
  'ENTER: claude’s words from a file, past what tmux takes in one command',
  () => {
    let state: string;
    const tmux = TMUX ?? 'tmux';
    const tmuxAt = (...args: string[]) =>
      Bun.spawnSync([tmux, '-u', '-S', join(state, 'tmux.sock'), '-f', '/dev/null', ...args], {
        env: { PATH: '/usr/bin:/bin', HOME: state },
      });

    beforeAll(() => {
      state = realpathSync(mkdtempSync(join(tmpdir(), 'abe-enter-')));
    });

    afterAll(() => {
      tmuxAt('kill-server');
      rmSync(state, { recursive: true, force: true });
    });

    test('a 100 kB instruction with quotes and lines reaches the program whole; both files gone', async () => {
      const vars = join(state, 'env');
      const words = join(state, 'argv');
      const out = join(state, 'out');
      const long = `it's "quoted" $HOME \`x\`\n${'a'.repeat(100_000)}`;

      writeFileSync(vars, envFile({ SEEN: 'yes' }));
      writeFileSync(
        words,
        argvFile(['/bin/sh', '-c', 'printf "%s|%s" "$SEEN" "$1" > "$2"', 'sh', long, out]),
      );
      const started = tmuxAt(
        'new-session',
        '-d',
        '-s',
        'abe-long',
        '/usr/bin/env',
        '-i',
        '/bin/sh',
        '-c',
        ENTER,
        'sh',
        vars,
        words,
      );

      expect(started.exitCode).toBe(0);
      for (let i = 0; i < 50 && !existsSync(out); i += 1) await Bun.sleep(50);
      await Bun.sleep(100);
      expect(readFileSync(out, 'utf8')).toBe(`yes|${long}`);
      expect([existsSync(vars), existsSync(words)]).toEqual([false, false]);
    });
  },
);
