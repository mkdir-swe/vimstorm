/**
 * `abe session` and `abe hook` through the CLI seam: the real `abe` and its `serve`, a fake
 * `claude` in a real `tmux` (on `serve`'s own server in the temporary state directory) that runs
 * its `--settings` hooks through `abe hook`, the fake Azure DevOps for the card, a fake `aws` for
 * the read database's secret, and a real git checkout to branch from. Subagents' models and the
 * repo Layer's session settings on a `serve` in this process (`servedWorld`), the same fakes
 * through the ports the app builds from that environment.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  PLAIN_SESSION_INSTRUCTIONS,
  CORE_SKILLS,
  inSessionRules,
  EventLine,
  readEnvelope,
  HOOK_EVENTS,
  SessionAttachData,
  AttachSpec,
  SessionData,
  SessionListData,
  SessionSendData,
  sessionBoundary,
  accessRules,
  agentEnvsLine,
  homeSecrets,
  AWS_HOME_DENY,
  StatusData,
} from '@abe/core';
import { adoBoardFrom, awsFrom, githubLoginsFrom } from '@abe/ports';
import {
  claudeOutput,
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAws,
  type FakeAws,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  FAKE_GITHUB_TOKEN,
  fakeGh,
  type FakeGh,
  type FakeStep,
  type ScenarioOptions,
  ghIssue,
  ghPrView,
  ghPull,
  heldEvents,
  NOT_FOUND,
  scriptClaude,
  secretText,
  served,
  type ServedCli,
  type Streaming,
  installDone,
  tempState,
  tmuxPath,
  until,
} from '@abe/testing';
import { z } from 'zod';

// A real serve, tmux and claude per launch: past 5 s on a busy Mac (as box-version's).
setDefaultTimeout(30_000);

/**
 * The repo's settings: its board, its environments, and the writes it grants (an Override): a
 * local session must still get none.
 */
const repoSettings = (board: unknown) =>
  [
    `board: ${JSON.stringify(board)}`,
    'environments:',
    '  test:',
    '    account: "111111111111"',
    '    region: eu-west-1',
    '    db:',
    '      read: { secret: abe/test/db-read }',
    '      write: { secret: abe/test/db-write }',
    '  prod:',
    '    account: "222222222222"',
    '    region: eu-west-1',
    'overrides:',
    '  reach:',
    '    value: [ABE_AWS_WRITE_TEST, ABE_DB_WRITE_URL_TEST]',
    '    reason: the web team runs its own migrations on test',
    '',
  ].join('\n');

/** Yours on this Mac: launches in this world run on this machine, a fake claude here. */
const MINE = 'serve.target: local\n';

const READ_URL = 'postgres://reader:r3ad@test-db:5432/shop';

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

/** Another repo's `abe.yaml`: the world's board, then `text`. */
const repoFile = (w: Setup, repo: string, text: string) => {
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(w.ado.board)}\n${text}`);
};

/** Yours for `repo` (`.abe/settings.local.yaml`), never committed. */
const yoursFor = (repo: string, text: string) => {
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), text);
};

type Setup = {
  root: string;
  repo: string;
  ado: FakeAdo;
  az: FakeAz;
  aws: FakeAws;
  claude: FakeClaude;
};

type World = Setup & { abe: Cli };

/** Yours on this Mac, a checkout with the repo's settings, and the fakes; `env`: what serve runs with. */
const setup = async (o: { path?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'abe-s-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const aws = fakeAws([['--secret-id abe/test/db-read ', secretText(READ_URL)]]);
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), MINE);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'abe.yaml'), repoSettings(ado.board));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  yoursFor(repo, '');
  const env = {
    PATH: `${o.path === undefined ? '' : `${o.path}:`}${claude.dir}:${az.dir}:${aws.dir}:/usr/bin:/bin`,
    ABE_CONFIG_DIR: join(root, 'mine'),
    ABE_TMUX: tmuxPath(),
    ...ado.env,
  };
  const made: Setup = { root, repo, ado, az, aws, claude };

  return { made, env };
};

const world = async (o: { path?: string } = {}): Promise<World> => {
  const { made, env } = await setup(o);
  const abe = cli({ env, cwd: made.repo });

  // the Mac's serve starts a card only where the install is done
  await installDone(abe.state.dir, made.repo);

  return { ...made, abe };
};

/**
 * The same world on a `serve` in this process: the Mac's board, AWS and secrets built from that
 * environment as the app builds them (the fake Azure DevOps, the fake `aws`).
 */
const servedWorld = async (
  o: Pick<ScenarioOptions, 'github'> = {},
): Promise<Setup & { abe: ServedCli }> => {
  const { made, env } = await setup();
  const state = tempState();
  const own = { ...state.env, ...env };

  return {
    ...made,
    abe: await served({
      state,
      cwd: made.repo,
      env: { ABE_CONFIG_DIR: env.ABE_CONFIG_DIR },
      board: adoBoardFrom(own, join(state.dir, 'images')),
      ...awsFrom(own),
      sessions: { env: own },
      ...o,
    }),
  };
};

const done = async (w: Setup & { abe: { close: () => Promise<void> } }) => {
  await w.abe.close();
  await w.ado.stop();
  w.az.remove();
  w.aws.remove();
  w.claude.remove();
  rmSync(w.root, { recursive: true, force: true });
};

const StateEvent = z.object({
  type: z.literal('session.state'),
  data: z.object({ id: z.string(), state: z.string(), cause: z.string() }),
});

/** The `session.state` events of `id` read from a watch until `last` comes. */
const statesUntil = async (
  w: Streaming,
  id: string,
  last: (cause: string, state: string) => boolean,
) => {
  const seen: [string, string][] = [];

  for (;;) {
    const line = EventLine.parse(JSON.parse(await w.next(8000)));
    const event = StateEvent.safeParse(line);

    if (!event.success || event.data.data.id !== id) continue;
    seen.push([event.data.data.cause, event.data.data.state]);
    if (last(event.data.data.cause, event.data.data.state)) return seen;
  }
};

const launch = async (abe: Pick<Cli, 'json'>, repo: string, card: string) => {
  const out = await abe.json(SessionData, 'session', 'launch', '--card', card, '--repo', repo);

  if (!out.doc.ok) throw new Error(`launch refused: ${JSON.stringify(out.doc.error)}`);

  return out.doc.data;
};

const show = async (abe: Cli, id: string, env: Record<string, string> = {}) => {
  const out = await abe.runWith({ env }, 'session', 'show', id, '--json');

  const doc: unknown = JSON.parse(out.stdout);

  return { exit: out.exit, doc };
};

const shown = async (abe: Pick<Cli, 'json'>, id: string) => {
  const out = await abe.json(SessionData, 'session', 'show', id);

  if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

  return out.doc.data;
};

const socketOf = (abe: Cli, id: string) => join(abe.state.dir, 'sessions', id, 'session.sock');

describe('a session: launch, hooks, state, send, scope', () => {
  let w: World;
  let s: SessionData;
  let watch: Streaming;
  let launched: [string, string][];

  beforeAll(async () => {
    w = await world();
    scriptClaude(w.abe.state.dir, [
      { hook: 'PreToolUse' },
      {
        hook: 'Notification',
        payload: {
          notification_type: 'permission_prompt',
          message: 'Claude needs your permission to use Bash',
        },
      },
      { hook: 'PostToolUse' },
      { abe: ['session', 'list', '--json'] },
      { abe: ['reach', 'env', '--target', 'local', '--json'] },
    ]);
    await w.abe.run('status');
    watch = w.abe.spawn('watch', '--json');
    s = await launch(w.abe, w.repo, '4');
    launched = await statesUntil(watch, s.id, (cause) => cause === 'Stop');
  });
  afterAll(async () => {
    watch.signal('SIGKILL');
    await done(w);
  });

  test("a worktree on the card's branch, claude started with the launch prompt", () => {
    expect(s).toMatchObject({
      card: 4,
      title: 'As a visitor I can sign in with email',
      // the checkout by its real path, as git names its worktree (#337)
      repo: realpathSync(w.repo),
      branch: 'card/4-as-a-visitor-i-can',
      // git names the checkout by its real path (/private/var on macOS).
      worktree: join(realpathSync(w.root), 'demo-wt', '4-as-a-visitor-i-can'),
    });
    // #190: starting until its claude's first hook (which may come before the launch answers).
    expect(['starting', 'working']).toContain(s.state);
    expect(s.id).toMatch(/^4-[0-9a-f]{4}$/);
    expect(git(s.worktree, 'branch', '--show-current')).toBe(s.branch);
    const argv = z.array(z.string()).parse(claudeOutput(s.worktree).argv);

    expect(argv.at(-1)).toBe(
      'Work on card AB#4: As a visitor I can sign in with email\n\n### Why\n\nVisitors need an account to see their *orders*.\n\n- email + password\n- remember me\n\n## Acceptance criteria\n\n- A wrong password says so\n- Signed in, the header shows the name\n\n## Comments, oldest first\n\nSam Sample, 2026-09-28:\nShould we support **magic links** too?\n\nAlex Example, 2026-09-29:\nLater, as its own story.',
    );
    // A plain session: core's sections, and that it is no Factory run (#186); a repo that needs
    // no database: no note of one (#349; Docker's absence is local-verify's).
    // A card's session is told which environments it reaches (ADR 0029).
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(
      `${PLAIN_SESSION_INSTRUCTIONS}\n\n${agentEnvsLine(['dev', 'test'])}`,
    );
    const settings = z
      .object({
        hooks: z.record(z.string(), z.unknown()),
        permissions: z.object({ allow: z.array(z.string()) }),
      })
      .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));

    expect(Object.keys(settings.hooks)).toEqual([...HOOK_EVENTS]);
    // every Bash command without asking: its jail holds them (ADR 0029)
    expect(settings.permissions.allow).toEqual([...inSessionRules(), 'Bash']);
  });

  test("the settings carry the session's boundary on real paths, its plugin outside the state", () => {
    const argv = z.array(z.string()).parse(claudeOutput(s.worktree).argv);
    const state = realpathSync(w.abe.state.dir);
    // beside its own ABE_STATE_DIR, never in it
    const plugins = join(`${state}-cache`, 'plugins');
    const settings = z
      .object({
        sandbox: z.unknown(),
        permissions: z.object({ allow: z.array(z.string()), deny: z.array(z.string()) }),
      })
      .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));
    const boundary = sessionBoundary({
      state,
      // the default state, beside its own ABE_STATE_DIR: hidden too
      defaultStates: [join(state, '.local', 'state', 'abe')],
      serveSocket: join(state, 's.sock'),
      plugins,
      // your own Layer's folder (`ABE_CONFIG_DIR`): never written
      config: realpathSync(join(w.root, 'mine')),
      socket: join(state, 'sessions', s.id, 'session.sock'),
      checkout: realpathSync(w.repo),
      home: state,
      // A card's: its worktree's `.git` denied by name to the file tools, its settings to all (#181).
      worktree: realpathSync(s.worktree),
      // the person's secrets (ADR 0029)
      secrets: homeSecrets(state),
    });

    // the boundary's, then the access rules': prod off by default, its Abe env file denied in the
    // checkout and the worktree, to its file tools and its shell, and secret output (ADR 0029)
    const access = accessRules({
      servers: [],
      enabled: ['dev', 'test'],
      trees: [realpathSync(w.repo), realpathSync(s.worktree)],
    });
    const { filesystem } = boundary.sandbox;
    const profile = readFileSync(join(state, 'sessions', s.id, 'jail.sb'), 'utf8');

    // Claude Code's sandbox off: its commands run in Abe's jail, built from the same lists, and
    // ~/.aws whatever is enabled: aws only through injected short-lived keys (ADR 0029)
    expect(settings.sandbox).toEqual({ enabled: false });
    for (const path of [
      ...filesystem.denyRead,
      join(state, '.aws'),
      ...access.denyRead,
      // a glob is a regex there (`pathFilters`); writes open but these (ADR 0029)
      ...filesystem.denyWrite.filter((p) => !p.includes('*')),
      join(realpathSync(s.worktree), '.abe', 'settings.local.yaml'),
    ])
      expect([path, profile.includes(`(literal "${path}")`)]).toEqual([path, true]);
    expect(settings.permissions.deny).toEqual([...boundary.deny, ...access.deny, ...AWS_HOME_DENY]);
    expect(settings.permissions.deny).toContain(`Read(/${state}/**)`);
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe(
      join(`${w.abe.state.dir}-cache`, 'plugins', s.id),
    );
  });

  test("skillsOnTop off (the default): the project's and local setting sources only, core's skills in the plugin", () => {
    const argv = z.array(z.string()).parse(claudeOutput(s.worktree).argv);
    const plugin = argv[argv.indexOf('--plugin-dir') + 1] ?? '';

    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(
      z
        .object({ claudeMdExcludes: z.array(z.string()) })
        .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8'))),
    ).toEqual({ claudeMdExcludes: [join(w.abe.state.dir, '.claude', '**')] });
    for (const file of CORE_SKILLS)
      expect(readFileSync(join(plugin, file.path), 'utf8')).toBe(file.text);
  });

  test("a card's session loads Abe's own MCP servers alone, session.mcp yours (the default) too: none of the person's, nor the repo's .mcp.json", () => {
    const argv = z.array(z.string()).parse(claudeOutput(s.worktree).argv);

    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
  });

  test('the environment is exactly the allowlist, its socket and the local read names', () => {
    const env = z.record(z.string(), z.string()).parse(claudeOutput(s.worktree).env);

    const tmp = env.TMPDIR ?? '';

    // its own temp folder, by every name a tool reads it by
    expect(tmp).toEndWith(`/abe-sessions/${s.id}`);
    expect(existsSync(tmp)).toBe(true);
    expect(env.AWS_CONFIG_FILE).toEndWith('/aws-off/empty');
    expect(env).toEqual({
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      HOME: w.abe.state.dir,
      // The test's serve has no USER: it is the user serve runs as.
      USER: Bun.spawnSync(['/usr/bin/id', '-un']).stdout.toString().trim(),
      PATH: `${join(w.abe.state.dir, 'bin')}:${w.claude.dir}:${w.az.dir}:${w.aws.dir}:/usr/bin:/bin`,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      ABE_SOCKET: socketOf(w.abe, s.id),
      // its commands in Abe's jail (ADR 0029); no CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, which starts
      // Claude Code in default mode: this allowlist holds no credential of its own
      CLAUDE_CODE_SHELL_PREFIX: join(w.abe.state.dir, 'sessions', s.id, 'jail.sh'),
      // no profile of ~/.aws in its shell, whatever is enabled (ADR 0029)
      AWS_CONFIG_FILE: env.AWS_CONFIG_FILE ?? '',
      AWS_SHARED_CREDENTIALS_FILE: env.AWS_CONFIG_FILE ?? '',
      AWS_EC2_METADATA_DISABLED: 'true',
      ABE_AWS_READ_PROD: 'abe-read-prod',
      ABE_AWS_READ_TEST: 'abe-read-test',
      ABE_DB_READ_URL_TEST: READ_URL,
      // Its hook refuses a fenced tool serve could not check (#181).
      FENCED_BY_ABE: '1',
      // A stalling MCP server gives up in 15 s, inside serve's 60 s wait for the first hook.
      MCP_TIMEOUT: '15000',
      // Its servers are Abe's and the sources: a source's sign-in is Settings'.
      SIGN_IN_ON_PAGE_BY_ABE: 'settings',
    });
  });

  test('state follows the hooks, each change a session.state event', () => {
    // #190: starting until SessionStart; heard before the launch answered, the launch says working.
    const [first, ...rest] = launched;

    expect(first?.[0]).toBe('launch');
    expect(first?.[1] === 'starting' ? rest : [['SessionStart', 'working'], ...rest]).toEqual([
      ['SessionStart', 'working'],
      ['Notification', 'waiting'],
      ['PostToolUse', 'working'],
      ['Stop', 'waiting'],
    ]);
  });

  test("every hook reached serve: hooks.jsonl and meta.json in the session's folder", () => {
    const dir = join(w.abe.state.dir, 'sessions', s.id);
    const events = readFileSync(join(dir, 'hooks.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => z.object({ event: z.string() }).parse(JSON.parse(l)).event);

    expect(events).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'Notification',
      'PostToolUse',
      'Stop',
    ]);
    expect(existsSync(join(dir, 'meta.json'))).toBe(true);
    // The variables' file is gone once claude read it: no value is left on disk.
    expect(existsSync(join(dir, 'env'))).toBe(false);
    for (const h of claudeOutput(s.worktree).hooks)
      expect(h).toMatchObject({ exit: 0, stdout: '', stderr: '' });
  });

  test('show: state, since, transcript path and the last message, from the hooks', async () => {
    const now = await shown(w.abe, s.id);
    const slug = s.worktree.replace(/[^A-Za-z0-9]/g, '-');

    expect(now).toMatchObject({
      state: 'waiting',
      lastAssistantMessage: 'Done: Work on card AB#4: As a visitor I can sign in with email',
    });
    expect(now.transcriptPath).toStartWith(join(w.abe.state.dir, '.claude', 'projects', slug));
    expect(existsSync(now.transcriptPath ?? '')).toBe(true);
    expect(Date.parse(now.since)).toBeGreaterThanOrEqual(Date.parse(now.startedAt));
  });

  test("where its branch came from is in its log and show: here no origin, so the checkout's main (#198)", async () => {
    const head = git(w.repo, 'rev-parse', 'HEAD');

    expect(s.base).toEqual({
      from: 'main',
      commit: head,
      note: "no origin remote: the checkout's own main",
    });
    expect((await shown(w.abe, s.id)).base).toEqual(s.base);
    const meta: unknown = JSON.parse(
      readFileSync(join(w.abe.state.dir, 'sessions', s.id, 'meta.json'), 'utf8'),
    );

    expect(meta).toMatchObject({ base: s.base });
    expect((await w.abe.run('session', 'show', s.id)).stdout).toContain(
      `  base        main at ${head.slice(0, 7)}: no origin remote: the checkout's own main\n`,
    );
  });

  test('list shows it; status counts it', async () => {
    const listed = await w.abe.json(SessionListData, 'session', 'list');

    expect(listed.doc.ok && listed.doc.data.sessions.map((x) => [x.id, x.state])).toEqual([
      [s.id, 'waiting'],
    ]);
    const status = await w.abe.json(StatusData, 'status');

    expect(status.doc.ok && status.doc.data.sessions).toBe(1);
  });

  test('send types into the pane: claude answers and the state moves', async () => {
    const sent = await w.abe.json(SessionSendData, 'session', 'send', s.id, 'hello', 'there');

    expect(sent.doc).toEqual({ ok: true, data: { id: s.id, sent: 'hello there', queued: null } });
    expect(await statesUntil(watch, s.id, (cause) => cause === 'Stop')).toEqual([
      ['UserPromptSubmit', 'working'],
      ['Stop', 'waiting'],
    ]);
    expect(claudeOutput(s.worktree).typed).toEqual(['hello there']);
    expect((await shown(w.abe, s.id)).lastAssistantMessage).toBe('You said: hello there');
  });

  test("from inside: abe on the session's socket sees only its own session", () => {
    const [list, reach] = claudeOutput(s.worktree).abe;
    const doc = z.object({ stdout: z.string(), exit: z.number() });

    const listed = readEnvelope(SessionListData, JSON.parse(doc.parse(list).stdout));

    expect(listed.ok && listed.data.sessions.map((x) => x.id)).toEqual([s.id]);
    expect(doc.parse(reach)).toMatchObject({ exit: 1 });
    expect(JSON.parse(doc.parse(reach).stdout)).toMatchObject({
      ok: false,
      error: { code: 'not-in-session' },
    });
  });

  test('send from inside is refused, to itself as to any other: only a person sends', async () => {
    const env = { ABE_SOCKET: socketOf(w.abe, s.id) };

    for (const id of [s.id, '9-ffff']) {
      const out = await w.abe.runWith({ env }, 'session', 'send', id, 'yes, go on', '--json');

      expect([out.exit, JSON.parse(out.stdout)]).toMatchObject([
        1,
        { ok: false, error: { code: 'not-in-session' } },
      ]);
    }
    expect(claudeOutput(s.worktree).typed).not.toContain('yes, go on');
  });

  test('naming another session from inside is refused: not-your-session', async () => {
    const env = { ABE_SOCKET: socketOf(w.abe, s.id) };

    for (const argv of [
      ['session', 'show', '9-ffff'],
      ['session', 'stop', '9-ffff'],
    ]) {
      const out = await w.abe.runWith({ env }, ...argv, '--json');

      expect([out.exit, JSON.parse(out.stdout)]).toEqual([
        1,
        {
          ok: false,
          error: {
            code: 'not-your-session',
            message: `session ${s.id} may act only on itself, not on 9-ffff`,
          },
        },
      ]);
    }
    expect(await show(w.abe, s.id, env)).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { id: s.id } },
    });
    // prod-on and every settings set are the person's (or the Abe chat's): never a card session's
    const prod = await w.abe.runWith(
      { env },
      'settings',
      'set',
      'agents.prod',
      'true',
      '--mine',
      '--json',
    );

    expect([prod.exit, JSON.parse(prod.stdout)]).toMatchObject([
      1,
      { ok: false, error: { code: 'not-in-session' } },
    ]);
    const launchInside = await w.abe.runWith(
      { env },
      'session',
      'launch',
      '--card',
      '5',
      '--repo',
      w.repo,
      '--json',
    );

    expect(JSON.parse(launchInside.stdout)).toMatchObject({
      ok: false,
      error: { code: 'not-in-session' },
    });
  });

  test("abe hook on serve's own socket is refused; a second launch on the card too", async () => {
    // `abe hook` on the command line is the hook client; a request on serve's socket is refused.
    const hook = await w.abe.raw(
      JSON.stringify({ v: 1, argv: ['hook', 'Stop', '--payload', '{}', '--json'], cwd: w.root }),
    );

    expect(
      JSON.parse(z.object({ stdout: z.string() }).parse(JSON.parse(hook)).stdout),
    ).toMatchObject({
      ok: false,
      error: { code: 'not-a-session' },
    });
    const again = await w.abe.json(
      SessionData,
      'session',
      'launch',
      '--card',
      'AB#4',
      '--repo',
      w.repo,
    );

    expect(again.doc).toMatchObject({ ok: false, error: { code: 'card-has-session' } });
    // the way on, named (#187)
    expect(again.doc.ok ? '' : again.doc.error.message).toContain(
      `attach it (abe session attach ${s.id}) or stop it first (abe session stop ${s.id})`,
    );
  });

  test('workspace attach-spec: its worktree as a plain local project (#74)', async () => {
    const out = await w.abe.json(AttachSpec, 'workspace', 'attach-spec', s.id);

    expect(out.doc).toMatchObject({
      ok: true,
      data: { where: 'local', root: s.worktree, exec: [], box: null, waking: false },
    });
    expect(out.doc.ok && out.doc.data.nvim).toEqual(['nvim', '--embed']);
    const none = await w.abe.json(AttachSpec, 'workspace', 'attach-spec', '9-zzzz');

    expect(none.doc).toMatchObject({ ok: false, error: { code: 'no-session' } });
  });

  test('attach --json names the tmux command; without --json it attaches this terminal', async () => {
    const out = await w.abe.json(SessionAttachData, 'session', 'attach', s.id);

    expect(out.doc).toEqual({
      ok: true,
      data: {
        id: s.id,
        argv: [
          tmuxPath(),
          '-u',
          '-S',
          join(w.abe.state.dir, 'tmux.sock'),
          'attach-session',
          '-t',
          `=abe-${s.id}`,
        ],
      },
    });
    // A terminal for `abe session attach`: a pane of another tmux server.
    const outer = join(w.abe.state.dir, 'outer.sock');
    const env = Object.entries({ ...w.abe.state.env, PATH: `${w.claude.dir}:/usr/bin:/bin` }).map(
      ([k, v]) => `${k}=${v}`,
    );

    Bun.spawnSync([
      tmuxPath(),
      '-S',
      outer,
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '/usr/bin/env',
      ...env,
      process.execPath,
      join(import.meta.dir, '..', 'main.ts'),
      'session',
      'attach',
      s.id,
    ]);
    try {
      await until('a client on the session', () => {
        const clients = Bun.spawnSync([
          tmuxPath(),
          '-S',
          join(w.abe.state.dir, 'tmux.sock'),
          'list-clients',
          '-t',
          `=abe-${s.id}`,
        ]);

        return clients.stdout.toString().trim() === '' ? undefined : true;
      });
    } finally {
      Bun.spawnSync([tmuxPath(), '-S', outer, 'kill-server']);
    }
  });

  test('typed in an attached terminal reaches claude; abe session send shows up in it too', async () => {
    // Chat's terminal (#71) is `abe session attach` in a PTY: here a pane of another tmux server.
    const outer = join(w.abe.state.dir, 'chat.sock');
    const env = Object.entries({ ...w.abe.state.env, PATH: `${w.claude.dir}:/usr/bin:/bin` }).map(
      ([k, v]) => `${k}=${v}`,
    );
    const pane = (...args: string[]) => Bun.spawnSync([tmuxPath(), '-S', outer, ...args]);

    pane(
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-x',
      '120',
      '-y',
      '40',
      '/usr/bin/env',
      ...env,
      process.execPath,
      join(import.meta.dir, '..', 'main.ts'),
      'session',
      'attach',
      s.id,
    );
    const screen = () => pane('capture-pane', '-p', '-J').stdout.toString();
    // Claude Code alone in the terminal: the session's tmux draws no status line
    const status = Bun.spawnSync([
      tmuxPath(),
      '-S',
      join(w.abe.state.dir, 'tmux.sock'),
      'show-options',
      '-t',
      `=abe-${s.id}:`,
      'status',
    ]);

    expect(status.stdout.toString().trim()).toBe('status off');

    try {
      await until('the attach shows claude', () =>
        screen().includes('fake claude ') ? true : undefined,
      );
      pane('send-keys', '-l', 'typed in chat');
      pane('send-keys', 'Enter');
      // a turn each, as any typed prompt
      expect(await statesUntil(watch, s.id, (cause) => cause === 'Stop')).toEqual([
        ['UserPromptSubmit', 'working'],
        ['Stop', 'waiting'],
      ]);
      expect(claudeOutput(s.worktree).typed).toContain('typed in chat');
      const sent = await w.abe.json(
        SessionSendData,
        'session',
        'send',
        s.id,
        'sent from elsewhere',
      );

      expect(sent.doc.ok).toBe(true);
      expect((await statesUntil(watch, s.id, (cause) => cause === 'Stop')).at(-1)).toEqual([
        'Stop',
        'waiting',
      ]);
      await until('the same terminal shows it', () =>
        screen().includes('sent from elsewhere') ? true : undefined,
      );
      expect(claudeOutput(s.worktree).typed).toContain('sent from elsewhere');
    } finally {
      pane('kill-server');
    }
  }, 20_000);

  test("a local session's permission prompt is the person's: the hook answers nothing", async () => {
    const out = await w.abe.runWith(
      {
        stdin: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
        env: { ABE_SOCKET: socketOf(w.abe, s.id) },
      },
      'hook',
      'PermissionRequest',
    );

    expect(out.stdout).toBe('');
    expect((await shown(w.abe, s.id)).state).toBe('waiting');
  });

  test('stop ends it: ended, its tmux session gone, its worktree kept', async () => {
    const stopped = await w.abe.json(SessionData, 'session', 'stop', s.id);

    expect(stopped.doc).toMatchObject({
      ok: true,
      data: { id: s.id, state: 'ended', stopped: true },
    });
    expect(await statesUntil(watch, s.id, () => true)).toEqual([['stop', 'ended']]);
    // Stopped by you, not ended on its own (#205): show says so too.
    expect((await shown(w.abe, s.id)).stopped).toBe(true);
    const sessions = Bun.spawnSync([
      tmuxPath(),
      '-S',
      join(w.abe.state.dir, 'tmux.sock'),
      'has-session',
      '-t',
      `=abe-${s.id}`,
    ]);

    expect(sessions.exitCode).not.toBe(0);
    expect(existsSync(s.worktree)).toBe(true);
    const send = await w.abe.json(SessionSendData, 'session', 'send', s.id, 'hi');

    expect(send.doc).toMatchObject({ ok: false, error: { code: 'session-ended' } });
    const attach = await w.abe.json(SessionAttachData, 'session', 'attach', s.id);

    expect(attach.doc).toMatchObject({ ok: false, error: { code: 'session-ended' } });
  });
});

const SubagentEvent = z.object({
  type: z.literal('session.subagent'),
  data: z.object({
    id: z.string(),
    agent: z.string(),
    name: z.string(),
    task: z.string().nullable(),
    model: z.string().nullable(),
    state: z.string(),
    result: z.string().nullable(),
  }),
});

/** The first `count` `session.subagent` events of `id`, once serve holds them. */
const subagentEvents = (abe: ServedCli, id: string, count: number) =>
  until(`${count} subagent events of ${id}`, async () => {
    const seen = (await heldEvents(abe.state.socket)).flatMap((line) => {
      const event = SubagentEvent.safeParse(line);

      return event.success && event.data.data.id === id ? [event.data.data] : [];
    });

    return seen.length >= count ? seen.slice(0, count) : undefined;
  });

/** What a session's `claude` was handed: its settings file and its plugin folder. */
const handed = async (worktree: string) => {
  const argv = z
    .array(z.string())
    .parse(await until('claude started', () => claudeOutput(worktree).argv));
  const plugin = argv[argv.indexOf('--plugin-dir') + 1] ?? '';
  const model = (name: string) =>
    /^model: (.+)$/m.exec(readFileSync(join(plugin, 'agents', `${name}.md`), 'utf8'))?.[1];

  return {
    settings: z
      .object({
        model: z.string(),
        availableModels: z.array(z.string()),
        worktree: z.object({ baseRef: z.string() }),
      })
      .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8'))),
    plugin,
    reader: model('reader'),
    writer: model('writer'),
  };
};

/** The model each subagent transcript the fake wrote says it ran on, by agent id. */
const transcriptModels = (transcript: string): Record<string, string | null> => {
  const dir = join(transcript.replace(/\.jsonl$/, ''), 'subagents');

  return Object.fromEntries(
    readdirSync(dir).map((file) => {
      const line = z
        .object({ agentId: z.string(), message: z.object({ model: z.string() }) })
        .parse(JSON.parse(readFileSync(join(dir, file), 'utf8').split('\n')[0] ?? ''));

      return [line.agentId, line.message.model];
    }),
  );
};

const DELEGATING: FakeStep[] = [
  {
    subagent: { type: 'abe:reader', task: 'Find the product card', result: 'web/src/Card.tsx:12' },
  },
  {
    subagent: {
      type: 'abe:writer',
      task: 'Stock badge',
      result: 'Branch worktree-stock, 2 commits\nmore lines',
    },
  },
  {
    subagent: {
      type: 'Explore',
      task: 'Find the API',
      model: 'haiku',
      result: 'api/src/products.ts',
    },
  },
];

describe('from inside, a session acts on its own card, repo and pull request only', () => {
  const GH_REPO = 'acme/demo';
  let w: World;
  let gh: FakeGh;
  let s: SessionData;
  let inside: { env: Record<string, string>; cwd: string };
  const error = (out: { stdout: string }) =>
    z
      .object({ ok: z.literal(false), error: z.object({ code: z.string() }) })
      .safeParse(JSON.parse(out.stdout)).data?.error.code;
  const run = (...argv: string[]) => w.abe.runWith(inside, ...argv, '--json');

  beforeAll(async () => {
    gh = fakeGh();
    w = await world({ path: gh.dir });
    git(w.repo, 'remote', 'add', 'origin', `https://github.com/${GH_REPO}.git`);
    await w.abe.run('status');
    s = await launch(w.abe, w.repo, '4');
    inside = { env: { ABE_SOCKET: socketOf(w.abe, s.id) }, cwd: s.worktree };
    writeFileSync(join(s.worktree, 'note.md'), 'From the session.\n');
    writeFileSync(join(w.root, 'secret.md'), "Not the session's.\n");
  });
  afterAll(async () => {
    await done(w);
    gh.remove();
  });

  test('its own card: commented on, tagged and moved; any other card is not-your-session', async () => {
    const said = await run('card', 'comment', '4', '--body-file', 'note.md');

    expect(said.exit).toBe(0);
    // marked as AI's, naming the session (#187), as triage's comments are
    expect(JSON.parse(said.stdout)).toMatchObject({
      ok: true,
      data: { text: `> *This was generated by AI in session ${s.id}.*\n\nFrom the session.` },
    });
    expect((await run('card', 'tag', '4', '--add', 'abe-test')).exit).toBe(0);
    expect(JSON.parse((await run('card', 'move', '4', 'Resolved')).stdout)).toMatchObject({
      ok: true,
      data: { id: 4, state: 'Resolved' },
    });
    for (const argv of [
      ['card', 'comment', '5', '--body-file', 'note.md'],
      ['card', 'tag', '5', '--add', 'abe-test'],
      ['card', 'move', '5', 'Resolved'],
    ])
      expect(error(await run(...argv))).toBe('not-your-session');
    expect(
      w.ado.requests().filter((r) => /^(PATCH|POST) \S*\/work[iI]tems\/5[/?]/.test(r)),
    ).toEqual([]);
  });

  test('a new card only as a ticket of its own card: no --parent, or another card, is not-your-session', async () => {
    const before = w.ado.requests().length;

    for (const parent of [[], ['--parent', '5']])
      expect(error(await run('card', 'create', '--title', 'A ticket', ...parent))).toBe(
        'not-your-session',
      );
    expect(w.ado.requests().length).toBe(before);
    const made = await run('card', 'create', '--title', 'A ticket', '--parent', 'AB#4');

    expect(JSON.parse(made.stdout)).toMatchObject({ ok: true, data: { title: 'A ticket' } });
  });

  test('a body file outside its worktree, through a link too, is not-your-session: serve never reads it', async () => {
    symlinkSync(join(w.root, 'secret.md'), join(s.worktree, 'link.md'));
    for (const file of [join(w.root, 'secret.md'), 'link.md'])
      expect(error(await run('card', 'comment', '4', '--body-file', file))).toBe(
        'not-your-session',
      );
  });

  test("the board is its checkout's, not the one where the command was typed", async () => {
    const elsewhere = join(w.root, 'elsewhere');

    mkdirSync(join(elsewhere, '.abe'), { recursive: true });
    git(elsewhere, 'init', '-q', '-b', 'main');
    writeFileSync(
      join(elsewhere, 'abe.yaml'),
      `board: ${JSON.stringify({ ...w.ado.board, project: 'Nowhere' })}\n`,
    );
    const shownThere = await w.abe.runWith(
      { ...inside, cwd: elsewhere },
      'card',
      'show',
      '4',
      '--json',
    );

    expect(JSON.parse(shownThere.stdout)).toMatchObject({ ok: true, data: { id: 4 } });
  });

  test('issue create only in its repo; a pull request only from its branch, updated only if it is its own', async () => {
    gh.answer([
      ['-X POST', { json: ghPull(GH_REPO, 3) }],
      ['-X PATCH', { json: ghPull(GH_REPO, 3) }],
      ['pr view 3', { json: ghPrView(GH_REPO, 3, { head: s.branch }) }],
      ['pr view 7', { json: ghPrView(GH_REPO, 7, { head: 'card/7-other' }) }],
    ]);
    const before = gh.calls().length;
    const pr = (head: string, repo = GH_REPO) =>
      run(
        'pr',
        'create',
        '--repo',
        repo,
        '--head',
        head,
        '--base',
        'main',
        '--title',
        'T',
        '--body-file',
        'note.md',
      );

    expect((await pr(s.branch)).exit).toBe(0);
    expect(error(await pr('card/7-other'))).toBe('not-your-session');
    expect(error(await pr(s.branch, 'acme/other'))).toBe('not-your-session');
    expect((await run('pr', 'update', `${GH_REPO}#3`, '--body-file', 'note.md')).exit).toBe(0);
    expect(error(await run('pr', 'update', `${GH_REPO}#7`, '--body-file', 'note.md'))).toBe(
      'not-your-session',
    );
    expect(error(await run('pr', 'update', 'acme/other#3', '--body-file', 'note.md'))).toBe(
      'not-your-session',
    );
    expect(
      error(
        await run(
          'issue',
          'create',
          '--repo',
          'acme/other',
          '--title',
          'T',
          '--body-file',
          'note.md',
        ),
      ),
    ).toBe('not-your-session');
    // What reached GitHub: one pull request opened and one updated, both its own, nothing else.
    expect(
      gh
        .calls()
        .slice(before)
        .map((c) => c.argv.join(' '))
        .filter((a) => / -X (POST|PATCH) /.test(a)),
    ).toEqual([
      `api -X POST repos/${GH_REPO}/pulls --input -`,
      `api -X PATCH repos/${GH_REPO}/pulls/3 --input -`,
    ]);
  });

  test("issue create in its run's repo goes through", async () => {
    gh.answer([
      ['-X POST', { json: ghIssue(GH_REPO, 21) }],
      ['issues/21/sub_issues', { json: [] }],
      ['issues/21/parent', NOT_FOUND],
      ['issues/21', { json: ghIssue(GH_REPO, 21) }],
    ]);
    const out = await run(
      'issue',
      'create',
      '--repo',
      GH_REPO,
      '--title',
      'T',
      '--body-file',
      'note.md',
    );

    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, data: { number: 21 } });
  });
});

describe('subagents: core plugin, models lowered by allowedModels, runs from the hooks', () => {
  let w: Setup & { abe: ServedCli };

  beforeAll(async () => {
    w = await servedWorld();
    scriptClaude(w.abe.state.dir, DELEGATING);
  });
  afterAll(async () => {
    await done(w);
  });

  test("the plugin and settings: reader on Sonnet, writer and coordinator on Opus, writers' worktrees off HEAD", async () => {
    const s = await launch(w.abe, w.repo, '4');
    const h = await handed(s.worktree);

    expect(h.settings).toEqual({
      ...h.settings,
      model: 'opus',
      availableModels: ['opus', 'sonnet', 'haiku'],
      worktree: { baseRef: 'head' },
    });
    expect([h.reader, h.writer]).toEqual(['sonnet', 'opus']);
    expect(
      z
        .object({ name: z.string() })
        .parse(JSON.parse(readFileSync(join(h.plugin, '.claude-plugin', 'plugin.json'), 'utf8')))
        .name,
    ).toBe('abe');
    expect(readFileSync(join(h.plugin, 'agents', 'writer.md'), 'utf8').split('\n')).toContain(
      'isolation: worktree',
    );

    const events = await subagentEvents(w.abe, s.id, 6);

    expect(events.map((e) => [e.name, e.model, e.state, e.result])).toEqual([
      ['abe:reader', 'sonnet', 'running', null],
      ['abe:reader', 'sonnet', 'done', 'web/src/Card.tsx:12'],
      ['abe:writer', 'opus', 'running', null],
      ['abe:writer', 'opus', 'done', 'Branch worktree-stock, 2 commits'],
      ['Explore', 'haiku', 'running', null],
      ['Explore', 'haiku', 'done', 'api/src/products.ts'],
    ]);

    await until('waiting', async () =>
      (await shown(w.abe, s.id)).state === 'waiting' ? true : undefined,
    );
    const now = await shown(w.abe, s.id);

    expect(now.models).toEqual({ coordinator: 'opus', reader: 'sonnet', writer: 'opus' });
    expect(now.subagents.map((r) => [r.name, r.task, r.model, r.state, r.result])).toEqual([
      ['abe:reader', 'Find the product card', 'sonnet', 'done', 'web/src/Card.tsx:12'],
      ['abe:writer', 'Stock badge', 'opus', 'done', 'Branch worktree-stock, 2 commits'],
      ['Explore', 'Find the API', 'haiku', 'done', 'api/src/products.ts'],
    ]);
    // What Abe says from the hooks is what the transcripts say the subagents ran on.
    expect(transcriptModels(now.transcriptPath ?? '')).toEqual(
      Object.fromEntries(now.subagents.map((r) => [r.id, r.model])),
    );
    const text = await w.abe.run('session', 'show', s.id);

    expect(text.stdout).toContain('  models      opus, reader sonnet, writer opus\n');
    expect(text.stdout).toContain(
      '  subagents\n    abe:reader on sonnet done (Find the product card): web/src/Card.tsx:12\n',
    );
  });

  test('allowedModels lowered to Sonnet by an Override with a reason: the writer runs on Sonnet', async () => {
    const repo = join(w.root, 'lowered');

    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    repoFile(
      w,
      repo,
      [
        'overrides:',
        '  allowedModels:',
        '    value: [sonnet]',
        '    reason: this repo stays on Sonnet while we measure cost',
        '',
      ].join('\n'),
    );
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    const s = await launch(w.abe, repo, '5');
    const h = await handed(s.worktree);

    expect([h.settings.model, h.settings.availableModels, h.reader, h.writer]).toEqual([
      'sonnet',
      ['sonnet'],
      'sonnet',
      'sonnet',
    ]);
    const events = await subagentEvents(w.abe, s.id, 6);

    expect(events.filter((e) => e.state === 'done').map((e) => [e.name, e.model])).toEqual([
      ['abe:reader', 'sonnet'],
      ['abe:writer', 'sonnet'],
      // Explore asked for Haiku, which this repo does not allow: it runs on the coordinator's.
      ['Explore', 'sonnet'],
    ]);
    await until('waiting', async () =>
      (await shown(w.abe, s.id)).state === 'waiting' ? true : undefined,
    );
    const now = await shown(w.abe, s.id);

    expect(transcriptModels(now.transcriptPath ?? '')).toEqual(
      Object.fromEntries(now.subagents.map((r) => [r.id, r.model])),
    );
  });

  test("skillsOnTop on in the repo's Layer: every setting source, the person's own skills too", async () => {
    const repo = join(w.root, 'on-top');

    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    repoFile(w, repo, 'skillsOnTop: true\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    const s = await launch(w.abe, repo, '6');
    const argv = z
      .array(z.string())
      .parse(await until('claude started', () => claudeOutput(s.worktree).argv));

    expect(argv).not.toContain('--setting-sources');
    expect(argv).toContain('--plugin-dir');
  });

  test("session.mcp abe-only in the repo's Layer: --strict-mcp-config, its sources looked for as a run's, one no config names said missing", async () => {
    const repo = join(w.root, 'abe-only');

    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    repoFile(w, repo, 'session:\n  mcp: abe-only\nsources: [sentry]\n');
    // the repo's own .mcp.json names it: never loaded
    writeFileSync(join(repo, '.mcp.json'), '{"mcpServers":{"sentry":{"type":"http"}}}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    const s = await launch(w.abe, repo, '7');
    const argv = z
      .array(z.string())
      .parse(await until('claude started', () => claudeOutput(s.worktree).argv));

    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
    // no config names sentry: it does not load, and the session is told
    expect((await shown(w.abe, s.id)).sourcesMissing).toEqual(['sentry']);
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toContain(
      "Sources: this repo's sentry is not loaded in this session:",
    );
  });

  test("subagents.max 2 in the repo's Layer: the session is told at most 2 subagents at once", async () => {
    const repo = join(w.root, 'two-subagents');

    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    repoFile(w, repo, 'subagents:\n  max: 2\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    const s = await launch(w.abe, repo, '8');
    const argv = z
      .array(z.string())
      .parse(await until('claude started', () => claudeOutput(s.worktree).argv));
    const told = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';

    expect(told).toContain('At most 2 subagents at once.');
    expect(told).not.toContain('At most 4');
  });

  // What a session reaches (ADR 0029): every tool of every source, writes too, in local mode as
  // out of it; no MCP deny; the enabled environments in full, the others not at all: their Abe
  // env file denied in the checkout and the worktree, their hosts refused by its sandbox.
  const PROD = 'API_URL=https://api.shop.example/v1\nSTRIPE_KEY=sk_live_abcdef123456\n';

  test.each([
    {
      name: 'sentry, local off: every tool of it allowed, none denied',
      sources: ['sentry'],
      local: false,
      boardReadOnly: false,
      card: '10',
      prod: undefined,
      prodOn: false,
      allowed: ['mcp__sentry__*'],
      // no config of yours names it: its rules stand, its tools are not loaded
      told: "Sources: this repo's sentry is not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there. Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.",
    },
    {
      name: 'sentry and figma, local on: every tool of both allowed, writes too',
      sources: ['sentry', 'figma'],
      local: true,
      boardReadOnly: false,
      card: '11',
      prod: undefined,
      prodOn: false,
      allowed: ['mcp__sentry__*', 'mcp__figma__*'],
      told: "Sources: this repo's sentry, figma are not loaded in this session: a session on this machine loads a source only from the repo's abe.yaml sources: (a bare name there from the person's Claude Code, until abe install source <name> writes its definition), never from a repo's .mcp.json, and a claude.ai connector does not load there. Their tools are not here: say so to the person in one line at your start, and where a step needed one, say it was not read and go on; never ask for a token or set one up.",
    },
    {
      name: "no sources, local on: no connector's tool denied",
      sources: [],
      local: true,
      boardReadOnly: false,
      card: '13',
      prod: undefined,
      prodOn: false,
      allowed: [],
      told: undefined,
    },
    {
      name: 'board read-only, local off: Azure Boards writes denied, a push not',
      sources: [],
      local: false,
      boardReadOnly: true,
      card: '12',
      prod: undefined,
      prodOn: false,
      allowed: [],
      told: undefined,
    },
    {
      name: 'prod off (the default): its file denied',
      sources: [],
      local: false,
      boardReadOnly: false,
      card: '9',
      prod: PROD,
      prodOn: false,
      allowed: [],
      told: undefined,
    },
    {
      name: 'prod on, by you for this checkout: its file read',
      sources: [],
      local: false,
      boardReadOnly: false,
      card: '3',
      prod: PROD,
      prodOn: true,
      allowed: [],
      told: undefined,
    },
  ])(
    'access: $name',
    async ({ sources, local, boardReadOnly, card, prod, prodOn, allowed, told }) => {
      const repo = join(w.root, `sources-${card}`);
      const mine = join(w.root, 'mine', 'settings.yaml');

      mkdirSync(join(repo, '.abe'), { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      repoFile(w, repo, `sources: ${JSON.stringify(sources)}\n`);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'first');
      if (prod !== undefined) writeFileSync(join(repo, '.abe', 'abe.prod.env'), prod);
      if (local || boardReadOnly)
        writeFileSync(
          mine,
          `${MINE}${local ? 'localMode' : 'boardReadOnly'}: [${JSON.stringify(realpathSync(repo))}]\n`,
        );
      // prod on for agents: only you, for this repo
      yoursFor(repo, prodOn ? 'agents.prod: true\n' : '');
      try {
        const s = await launch(w.abe, repo, card);
        const argv = z
          .array(z.string())
          .parse(await until('claude started', () => claudeOutput(s.worktree).argv));
        const settings = z
          .object({
            permissions: z.object({ allow: z.array(z.string()), deny: z.array(z.string()) }),
            sandbox: z.object({ enabled: z.literal(false) }),
          })
          .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));
        const { permissions } = settings;
        // its commands' jail (ADR 0029), beside its settings
        const profile = readFileSync(
          join(dirname(argv[argv.indexOf('--settings') + 1] ?? ''), 'jail.sb'),
          'utf8',
        );
        const mcp = (rules: string[]) => rules.filter((r) => r.startsWith('mcp__'));
        const instructions = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
        const prodFiles = [realpathSync(repo), realpathSync(s.worktree)].map((t) =>
          join(t, '.abe', 'abe.prod.env'),
        );

        expect(mcp(permissions.allow).filter((r) => !r.startsWith('mcp__abe'))).toEqual([
          ...allowed,
        ]);
        // no per-tool MCP deny
        expect(mcp(permissions.deny)).toEqual([]);
        // an environment off: its Abe env file, in the checkout and the worktree, denied to its
        // file tools and its shell; no other env file
        expect(prodFiles.map((f) => permissions.deny.includes(`Read(/${f})`))).toEqual(
          prodFiles.map(() => !prodOn),
        );
        expect(prodFiles.map((f) => profile.includes(`(literal "${f}")`))).toEqual(
          prodFiles.map(() => !prodOn),
        );
        expect(
          permissions.deny.filter((r) => /^Read\(.*env/.test(r) && !r.includes('abe.prod.env')),
        ).toEqual([]);
        // aws is never denied whole
        expect(permissions.deny).not.toContain('Bash(aws:*)');
        // Board writes follow either setting, a push local mode alone.
        expect(permissions.deny.includes('Bash(az boards work-item update:*)')).toBe(
          local || boardReadOnly,
        );
        expect(permissions.deny.includes('Bash(git push:*)')).toBe(local);
        // the network open: no host named, no secret written into its settings or its jail
        expect(profile).not.toContain('api.shop.example');
        expect(`${JSON.stringify(settings)}${profile}`).not.toContain('sk_live_abcdef123456');
        // every Bash command allowed without asking, as the sandbox did; the person's ssh keys never read
        expect(permissions.allow).toContain('Bash');
        expect(profile).toContain('/.ssh")');
        expect(instructions).toContain(
          agentEnvsLine(prodOn ? ['dev', 'test', 'prod'] : ['dev', 'test']),
        );
        expect(instructions.split('\n').filter((l) => l.startsWith('Sources:'))).toEqual(
          told === undefined ? [] : [told],
        );
      } finally {
        writeFileSync(mine, MINE);
      }
    },
  );
});

describe("a session's gh: your gh login for its checkout, gh's active one never switched (ADR 0025)", () => {
  const gh = fakeGh([
    ['auth token --hostname github.com --user me-work', { stdout: `${FAKE_GITHUB_TOKEN}\n` }],
  ]);
  let w: Setup & { abe: ServedCli };

  beforeAll(async () => {
    w = await servedWorld({ github: githubLoginsFrom({ PATH: `${gh.dir}:/usr/bin:/bin` }) });
    scriptClaude(w.abe.state.dir, []);
  });
  afterAll(async () => {
    await done(w);
    gh.remove();
  });

  test.each<{
    name: string;
    card: string;
    account: string | null;
    here: boolean;
    env: string | undefined;
    local?: boolean;
  }>([
    { name: 'none named: gh as it is', card: '5', account: null, here: true, env: undefined },
    {
      name: 'logins.gh in local mode: none, Abe reads GitHub for it',
      card: '9',
      account: 'me-work',
      here: true,
      env: undefined,
      local: true,
    },
    {
      name: 'logins.gh for its checkout: GH_TOKEN, that login’s token',
      card: '6',
      account: 'me-work',
      here: true,
      env: FAKE_GITHUB_TOKEN,
    },
    {
      name: 'logins.gh for another checkout: gh as it is',
      card: '7',
      account: 'me-work',
      here: false,
      env: undefined,
    },
  ])('$name', async ({ card, account, here, env, local }) => {
    const repo = join(w.root, `gh-${card}`);
    const mine = join(w.root, 'mine', 'settings.yaml');

    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    repoFile(w, repo, '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    // yours for this repo, or for another (the world's own checkout)
    const named = account === null ? '' : `logins.gh: ${account}\n`;

    yoursFor(repo, here ? named : '');
    yoursFor(w.repo, here ? '' : named);
    try {
      if (local === true) await w.abe.runWith({ cwd: repo }, 'local', 'on');
      const s = await launch(w.abe, repo, card);
      const launched = z
        .record(z.string(), z.string())
        .parse(await until('claude started', () => claudeOutput(s.worktree).env));

      expect(launched.GH_TOKEN).toEqual(env);
    } finally {
      writeFileSync(mine, MINE);
      yoursFor(w.repo, '');
    }
  });

  test('a login gh does not have: the launch is refused, naming it', async () => {
    const repo = join(w.root, 'gh-8');

    mkdirSync(join(repo, '.abe'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    repoFile(w, repo, '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    yoursFor(repo, 'logins.gh: me-other\n');
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '8', '--repo', repo);

    expect(out.doc.ok ? null : out.doc.error).toEqual({
      code: 'github-account',
      message: 'gh is not signed in as me-other (logins.gh): gh auth login, as me-other',
    });
  });
});

describe('a session outlives its serve', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });
  afterAll(() => done(w));

  test('after serve restarts, list still shows it and its hooks reach the new serve', async () => {
    const s = await launch(w.abe, w.repo, '5');

    await until('waiting', async () =>
      (await shown(w.abe, s.id)).state === 'waiting' ? true : undefined,
    );
    expect((await w.abe.run('serve', 'stop')).exit).toBe(0);
    await until('serve gone', async () =>
      (await w.abe.run('status', '--no-start')).exit === 3 ? true : undefined,
    );
    const listed = await w.abe.json(SessionListData, 'session', 'list');

    expect(listed.doc.ok && listed.doc.data.sessions.map((x) => [x.id, x.state])).toEqual([
      [s.id, 'waiting'],
    ]);
    const watch = w.abe.spawn('watch', '--json');

    try {
      await w.abe.json(SessionSendData, 'session', 'send', s.id, '/exit');
      expect(await statesUntil(watch, s.id, (_, state) => state === 'ended')).toEqual([
        ['SessionEnd', 'ended'],
      ]);
    } finally {
      watch.signal('SIGKILL');
    }
    expect(await shown(w.abe, s.id)).toMatchObject({ state: 'ended' });
  });

  test('a claude that is gone without a SessionEnd is ended on the next look', async () => {
    const s = await launch(w.abe, w.repo, '6');

    await until('waiting', async () =>
      (await shown(w.abe, s.id)).state === 'waiting' ? true : undefined,
    );
    Bun.spawnSync([
      tmuxPath(),
      '-S',
      join(w.abe.state.dir, 'tmux.sock'),
      'kill-session',
      '-t',
      `=abe-${s.id}`,
    ]);
    expect(await shown(w.abe, s.id)).toMatchObject({ state: 'ended' });
  });

  test('an id no session has: no-session for show, send, attach and stop', async () => {
    for (const argv of [
      ['session', 'show', '9-ffff'],
      ['session', 'send', '9-ffff', 'hi'],
      ['session', 'attach', '9-ffff'],
      ['session', 'stop', '9-ffff'],
    ]) {
      const out = await w.abe.json(z.unknown(), ...argv);

      expect([out.exit, out.doc]).toEqual([
        1,
        { ok: false, error: { code: 'no-session', message: 'no session 9-ffff' } },
      ]);
    }
  });

  test('a checkout that is not git is refused', async () => {
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '7', '--repo', w.root);

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'not-a-repo' } });
  });
});

describe('abe hook never stalls claude', () => {
  let abe: Cli;

  beforeAll(() => {
    abe = cli();
  });
  afterAll(() => abe.close());

  test('serve down: exit 0, nothing printed, never hangs', async () => {
    const before = Date.now();
    const out = await abe.runWith(
      {
        stdin: '{"hook_event_name":"Stop"}',
        env: { ABE_SOCKET: join(abe.state.dir, 'none', 'session.sock') },
      },
      'hook',
      'Stop',
    );

    expect(out).toEqual({ exit: 0, stdout: '', stderr: '' });
    // A cold `abe` start, so wider than the hook's own 1.1 s (hooks/hook.test.ts holds that).
    expect(Date.now() - before).toBeLessThan(5000);
  });

  test('a socket that never answers: gives up, exit 0', async () => {
    const socket = join(abe.state.dir, 'silent.sock');
    const silent = createServer(() => undefined);

    await new Promise<void>((resolve) => silent.listen(socket, resolve));
    try {
      const before = Date.now();
      const out = await abe.runWith(
        { stdin: '{}', env: { ABE_SOCKET: socket } },
        'hook',
        'PreToolUse',
      );

      expect(out).toEqual({ exit: 0, stdout: '', stderr: '' });
      // A cold `abe` start, so wider than the hook's own 1.1 s (hooks/hook.test.ts holds that).
      expect(Date.now() - before).toBeLessThan(5000);
    } finally {
      silent.close();
    }
  });

  test('no session (no ABE_SOCKET of one): exit 0, nothing printed', async () => {
    const out = await abe.runWith({ stdin: '{}' }, 'hook', 'Stop');

    expect(out).toEqual({ exit: 0, stdout: '', stderr: '' });
  });
});
