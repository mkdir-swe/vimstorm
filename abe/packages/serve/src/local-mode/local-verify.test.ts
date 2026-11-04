/**
 * A local session's verify follows the pack (#182, #146) in a real `serve` in this test with the
 * fake `claude` in a real `tmux` and a real git checkout: `abe run` from the session runs the
 * pack's script in its worktree or Before's, outside the sandbox, with no token and the session's
 * database; the repo pack's `.claude/skills/run-app/scripts/db` gives the session that database at its launch; and
 * when the session stops, the stop script runs, what its scripts and its agent left running stops,
 * and the database hook's `stop` runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_OF,
  baseWorktreePath,
  BrowserData,
  FactoryRunData,
  FactoryStatusData,
  NO_DATABASE_NOTE,
  readEnvelope,
  type Reply,
  RunData,
  SessionData,
  SHELL_PREFIX_ENV,
  startingMode,
  SUBPROCESS_SCRUB_ENV,
  POSTGRES_IMAGE,
} from '@abe/core';
import {
  card,
  claudeOutput,
  fakeBoard,
  fakeBrowser,
  type FakeBrowser,
  killTmux,
  fakeClaude,
  type FakeClaude,
  fakeDbUrl,
  fakeMacDatabase,
  type FakeMacDatabase,
  scenario,
  scriptClaude,
  type ServeScenario,
  until,
  installDone,
} from '@abe/testing';
import { findDocker, macDatabase, sessionSocket } from '@abe/ports';
import { z } from 'zod';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const read = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> => {
  const doc = readEnvelope(schema, JSON.parse(reply.stdout));

  if (!doc.ok) throw new Error(`${doc.error.code}: ${doc.error.message}`);

  return doc.data;
};

const argvOf = (worktree: string) => z.array(z.string()).parse(claudeOutput(worktree).argv);

const errorOf = (reply: Reply) =>
  z
    .object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
    .parse(JSON.parse(reply.stdout)).error;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };
/** The repo's `abe.yaml`: its board. */
const REPO_SETTINGS = `board: ${JSON.stringify(BOARD)}\nenvironments: {}\n`;

const SCRIPTS = {
  // The app: a server left running (its pid kept), the URL last, what it was given written down.
  start: `env > "$PWD/start.env"\n'${process.execPath}' -e 'setTimeout(() => {}, 300000)' >/dev/null 2>&1 &\necho $! > "$PWD/app.pid"\necho starting >&2\necho http://127.0.0.1:3001`,
  stop: 'echo stopped >> "$PWD/stop.log"',
  seed: 'echo "seeded $1"',
  // Idempotent; its last line the URL; what it was asked written beside the checkout.
  db: 'echo "$1 $ABE_DB_NAME" >> "$(dirname "$PWD")/db.log"\n[ "$1" = start ] && { echo pulling; echo "postgres://abe:pw@127.0.0.1:55432/$ABE_DB_NAME"; }\nexit 0',
};

const pack = (dir: string, scripts: Readonly<Record<string, string>>) => {
  mkdirSync(join(dir, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, '.claude', 'skills', 'run-app', 'scripts', name);

    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
};

describe.skipIf(process.platform !== 'darwin')("a local session's verify follows the pack", () => {
  let root: string;
  let repo: string;
  let bare: string;
  let claude: FakeClaude;
  let s: ServeScenario;

  const launch = async (id: number, at = repo, on = s) =>
    on.request('session', 'launch', '--card', String(id), '--repo', at, '--json');

  const serveOn = (state?: ServeScenario['state']) =>
    scenario({
      ...(state === undefined ? {} : { state }),
      board: fakeBoard([4, 5, 6, 7].map((id) => card(id, `Cart total ${id}`))),
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          GH_TOKEN: 'never-given',
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });

  const checkout = (
    dir: string,
    scripts: Readonly<Record<string, string>>,
    files: Readonly<Record<string, string>> = {},
  ) => {
    git(root, 'init', '-q', '-b', 'main', dir);
    // yours for the repo is never committed
    writeFileSync(
      join(dir, '.gitignore'),
      '.fake-claude/\n*.env\n*.pid\n*.log\n.abe/settings.local.yaml\n',
    );
    pack(dir, scripts);
    writeFileSync(join(dir, 'abe.yaml'), REPO_SETTINGS);
    mkdirSync(join(dir, '.abe'), { recursive: true });
    writeFileSync(join(dir, '.abe', 'settings.local.yaml'), '');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-lv-'));
    repo = join(root, 'demo');
    bare = join(root, 'plain');
    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    checkout(repo, SCRIPTS);
    checkout(bare, { start: SCRIPTS.start });
    claude = fakeClaude();
    s = await serveOn();
    scriptClaude(s.state.dir, []);
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "abe run in the worktree and Before's, the database given, and all of it stopped at the end",
    { timeout: 30_000 },
    async () => {
      const session = read(SessionData, await launch(4));
      const db = `postgres://abe:pw@127.0.0.1:55432/abe-db-${session.id}`;

      // The database hook ran before claude, and its URL is the session's.
      await until('claude started', () =>
        claudeOutput(session.worktree).env === undefined ? undefined : true,
      );
      expect(
        z.record(z.string(), z.string()).parse(claudeOutput(session.worktree).env).DATABASE_URL,
      ).toBe(db);
      expect(readFileSync(join(root, 'db.log'), 'utf8')).toBe(`start abe-db-${session.id}\n`);

      // In its worktree: outside the sandbox, no token, its mark and its database.
      const ran = read(
        RunData,
        await s.requestAs(session.id, session.worktree, 'run', 'start', '--json'),
      );

      expect(ran).toMatchObject({
        script: '.claude/skills/run-app/scripts/start',
        cwd: session.worktree,
        exit: 0,
      });
      expect(ran.stdout.trim().split('\n').at(-1)).toBe('http://127.0.0.1:3001');
      expect(ran.stderr).toBe('starting\n');
      const given = readFileSync(join(session.worktree, 'start.env'), 'utf8');

      expect(given).toContain(`${APP_OF}=${session.id}\n`);
      expect(given).toContain(`DATABASE_URL=${db}\n`);
      expect(given).not.toContain('GH_TOKEN');
      expect(given).not.toContain('ABE_SOCKET');
      const seeded = read(
        RunData,
        await s.requestAs(
          session.id,
          session.worktree,
          'run',
          '.claude/skills/run-app/scripts/seed',
          'carts',
          '--json',
        ),
      );

      expect(seeded.stdout).toBe('seeded carts\n');

      // Before's, by its absolute path.
      const base = baseWorktreePath(repo, session.branch);

      git(repo, 'worktree', 'add', '-q', '--detach', base, 'main');
      const before = read(
        RunData,
        await s.requestAs(
          session.id,
          base,
          'run',
          join(base, '.claude', 'skills', 'run-app', 'scripts', 'start'),
          '--json',
        ),
      );

      // named by its real path, as its session's checkout (#337)
      expect(before.cwd).toBe(realpathSync(base));

      // Nothing else: another folder, a path out of the trees.
      for (const path of [
        join(bare, '.claude', 'skills', 'run-app', 'scripts', 'start'),
        '../x',
        '.claude/skills/run-app/scripts/../x',
      ]) {
        const refusal = await s.requestAs(session.id, session.worktree, 'run', path, '--json');

        expect(refusal.exit).toBe(2);
        expect(errorOf(refusal).code).toBe('not-a-pack-script');
      }
      // The person's own abe, in no session: run the script yourself.
      expect(errorOf(await s.request('run', 'start', '--json')).code).toBe('not-a-box');

      // What the agent started itself in the sandbox, with its socket in its environment.
      const agent = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 300_000)'], {
        env: { PATH: '/usr/bin:/bin', ABE_SOCKET: sessionSocket(s.state.dir, session.id) },
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const apps = [session.worktree, base].map((t) =>
        Number(readFileSync(join(t, 'app.pid'), 'utf8')),
      );

      // A writer whose work the card branch holds, its folder removed in the sandbox (#183).
      const writer = join(session.worktree, '.claude', 'worktrees', 'agent-a1');

      git(session.worktree, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', writer, 'HEAD');
      writeFileSync(join(writer, 'a1.txt'), 'a1\n');
      git(writer, 'add', 'a1.txt');
      git(writer, 'commit', '-q', '-m', 'a1');
      git(session.worktree, 'merge', '-q', '--no-ff', '-m', 'merge a1', 'worktree-agent-a1');
      rmSync(writer, { recursive: true, force: true });
      try {
        expect([...apps, agent.pid].every(alive)).toBe(true);
        read(SessionData, await s.request('session', 'stop', session.id, '--json'));
        await until('its writer tidied', () =>
          git(repo, 'branch', '--list', 'worktree-agent-a1') === '' &&
          !git(repo, 'worktree', 'list', '--porcelain').includes('agent-a1')
            ? true
            : undefined,
        );
        await until('the apps and the agent stopped', () =>
          [...apps, agent.pid].some(alive) ? undefined : true,
        );
        await until('the stop scripts ran', () =>
          [session.worktree, base].every((t) => existsSync(join(t, 'stop.log'))) ? true : undefined,
        );
        await until('the database stopped', () =>
          readFileSync(join(root, 'db.log'), 'utf8').includes(`stop abe-db-${session.id}`)
            ? true
            : undefined,
        );
      } finally {
        agent.kill('SIGKILL');
      }
    },
  );

  test(
    "a card's start against a backend nothing says is test: started all the same, the gate's words its warning",
    { timeout: 30_000 },
    async () => {
      const warned = join(root, 'warned');

      checkout(warned, { start: `export API_URL=https://api.example.com\n${SCRIPTS.start}` });
      await installDone(s.state.dir, warned);
      const session = read(SessionData, await launch(6, warned));
      const ran = read(
        RunData,
        await s.requestAs(session.id, session.worktree, 'run', 'start', '--json'),
      );

      expect([ran.exit, ran.warning?.split('. Ways on:')[0]]).toEqual([
        0,
        "warning, started all the same: .claude/skills/run-app/scripts/start talks to api.example.com (API_URL): the gate can't prove it local",
      ]);
      await s.request('session', 'stop', session.id, '--json');
    },
  );

  test(
    'a serve started again stops what a session that ended while none ran left behind',
    { timeout: 30_000 },
    async () => {
      const first = await serveOn();

      scriptClaude(first.state.dir, []);
      const session = read(SessionData, await launch(7, repo, first));

      read(RunData, await first.requestAs(session.id, session.worktree, 'run', 'start', '--json'));
      const app = Number(readFileSync(join(session.worktree, 'app.pid'), 'utf8'));

      // serve stops; the session's claude ends while none runs.
      await first.serve.stop();
      await killTmux(first.state.dir);
      expect(alive(app)).toBe(true);
      await using again = await serveOn(first.state);

      read(SessionData, await again.request('session', 'show', session.id, '--json'));
      await until('the app it left stopped', () => (alive(app) ? undefined : true));
      await until('its database stopped', () =>
        readFileSync(join(root, 'db.log'), 'utf8').includes(`stop abe-db-${session.id}`)
          ? true
          : undefined,
      );
    },
  );

  test(
    'a database hook that fails refuses the launch, saying why and offering the cloud',
    { timeout: 30_000 },
    async () => {
      const broken = join(root, 'broken');

      checkout(broken, { db: 'echo "Cannot connect to the Docker daemon" >&2\nexit 1' });
      const reply = await launch(5, broken);
      const error = errorOf(reply);

      expect(error.code).toBe('no-database');
      expect(error.message).toContain('Cannot connect to the Docker daemon');
      expect(error.message).toContain('--target cloud');
    },
  );

  test(
    'a Factory run on a repo whose pack needs a database, with no Docker, is refused up front (#218, #349)',
    { timeout: 30_000 },
    async () => {
      const needs = join(root, 'needs-db');

      checkout(
        needs,
        { start: SCRIPTS.start },
        {
          '.claude/skills/verify-needs-db/SKILL.md':
            '# Verification pack\n\nEverything needs `$DATABASE_URL`.\n',
        },
      );
      scriptClaude(s.state.dir, []);
      const error = errorOf(await s.request('factory', 'run', '5', '--repo', needs, '--json'));

      expect(error.code).toBe('no-docker');
      expect(error.message).toStartWith(
        "needs-db needs a database and Docker isn't installed.\nInstall Docker Desktop, OrbStack or colima",
      );
      expect(error.message).toContain('--target cloud');
      // Nothing launched: no worktree but the checkout.
      expect(git(needs, 'worktree', 'list').split('\n')).toHaveLength(1);

      // A plain session on it is no run with checks: it goes on, told it has no database.
      const session = read(SessionData, await launch(5, needs));

      await until('claude started', () =>
        claudeOutput(session.worktree).argv === undefined ? undefined : true,
      );
      expect(
        z
          .array(z.string())
          .parse(claudeOutput(session.worktree).argv)
          .some((a) => a.includes(NO_DATABASE_NOTE)),
      ).toBe(true);
      read(SessionData, await s.request('session', 'stop', session.id, '--json'));
    },
  );

  test(
    'a repo that needs no database: none, and no word of one (#349)',
    { timeout: 30_000 },
    async () => {
      const session = read(SessionData, await launch(6, bare));

      await until('claude started', () =>
        claudeOutput(session.worktree).argv === undefined ? undefined : true,
      );
      const argv = z.array(z.string()).parse(claudeOutput(session.worktree).argv);

      expect(argv.some((a) => a.includes(NO_DATABASE_NOTE))).toBe(false);
      expect(
        z.record(z.string(), z.string()).parse(claudeOutput(session.worktree).env).DATABASE_URL,
      ).toBeUndefined();
      read(SessionData, await s.request('session', 'stop', session.id, '--json'));
    },
  );
});

describe.skipIf(process.platform !== 'darwin')("a local Factory run's own browser", () => {
  let root: string;
  let repo: string;
  let claude: FakeClaude;
  let chrome: FakeBrowser;
  let s: ServeScenario;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-lb-'));
    repo = join(root, 'demo');
    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(root, 'init', '-q', '-b', 'main', repo);
    mkdirSync(join(repo, '.abe'));
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.scratch/\n.abe/settings.local.yaml\n');
    writeFileSync(join(repo, 'abe.yaml'), REPO_SETTINGS);
    mkdirSync(join(repo, '.abe'), { recursive: true });
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    claude = fakeClaude();
    // chrome-devtools-mcp runs through npx on the session's PATH.
    writeFileSync(join(claude.dir, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chrome = fakeBrowser();
    s = await scenario({
      board: fakeBoard([4, 5].map((id) => card(id, `Cart total ${id}`))),
      localBrowser: {
        browser: chrome,
        executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'launched with chrome-devtools-mcp on its own port; abe browser starts Chrome; verify and the end stop it',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        { abe: ['factory', 'stage-done', 'build', '--json'] },
        { abe: ['factory', 'review', '--findings', '0', '--json'] },
      ]);
      const run = read(
        FactoryRunData,
        await s.request('factory', 'run', '4', '--repo', repo, '--json'),
      );

      await until(
        'AB#4 in verify',
        async () =>
          read(FactoryStatusData, await s.request('factory', 'status', '4', '--json')).runs[0]
            ?.stage === 'verify'
            ? true
            : undefined,
        { ms: 15_000, every: 25 },
      );
      const argv = z.array(z.string()).parse(claudeOutput(run.worktree).argv);
      const file = argv[argv.indexOf('--mcp-config') + 1] ?? '';
      // A Factory run starts in auto in its jail: Claude Code reads its settings and environment
      // so (CLAUDE_CODE_SUBPROCESS_ENV_SCRUB there would start it in default).
      const launched = z
        .object({
          permissions: z.object({ defaultMode: z.enum(['default', 'acceptEdits', 'auto']) }),
        })
        .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));
      const env = z.record(z.string(), z.string()).parse(claudeOutput(run.worktree).env);

      expect(env[SHELL_PREFIX_ENV]).toEndWith('/jail.sh');
      expect(startingMode(launched, env)).toBe('auto');
      // A Factory run loads its browser alone, whatever session.mcp says.
      expect(argv).toContain('--strict-mcp-config');
      expect(argv[argv.indexOf('--mcp-config') + 2]).toBe('--strict-mcp-config');
      const config = z
        .object({
          mcpServers: z.object({
            'chrome-devtools': z.object({ command: z.string(), args: z.array(z.string()) }),
          }),
        })
        .parse(JSON.parse(readFileSync(file, 'utf8'))).mcpServers['chrome-devtools'];

      // npx from serve's state, never the worktree, on the pinned version.
      expect(config.command).toBe('/bin/sh');
      expect(config.args.slice(2, 6)).toEqual([
        join(s.state.dir, 'browsers'),
        join(claude.dir, 'npx'),
        '-y',
        'chrome-devtools-mcp@1.11.0',
      ]);
      expect(config.args).toContain(`--workspace=${run.worktree}`);
      const port = Number(
        /--browserUrl=http:\/\/127\.0\.0\.1:(\d+)/.exec(config.args.join(' '))?.[1],
      );

      expect(port).toBeGreaterThan(0);

      // The session's own Chrome, outside its sandbox, on that port.
      const started = read(
        BrowserData,
        await s.requestAs(run.session, run.worktree, 'browser', 'start', '--json'),
      );

      expect(started).toMatchObject({
        state: 'running',
        port,
        endpoint: `http://127.0.0.1:${port}`,
        mcpConfig: file,
      });
      expect(chrome.running?.dir).toBe(join(s.state.dir, 'browsers', run.session));
      expect(chrome.running?.argv).toContain('--use-mock-keychain');
      expect(chrome.running?.argv[0]).toBe(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      );

      // The After pass names each mapped feature: driven with how it was judged, its screenshot
      // and recording in its Evidence, or not driven with why; refused while its proof is not there.
      const report = join(run.worktree, '.scratch', 'verify-after.md');
      const map = join(run.worktree, '.claude', 'skills', 'verify-demo', 'features');
      const evidence = join(
        run.worktree,
        '.scratch',
        String(run.card),
        'verify',
        'evidence',
        'cart',
      );
      const after = (path: string) =>
        s.requestAs(
          run.session,
          run.worktree,
          'factory',
          'verify',
          '--phase',
          'after',
          '--result',
          'pass',
          '--report',
          path,
          '--json',
        );

      mkdirSync(map, { recursive: true });
      writeFileSync(
        join(map, 'README.md'),
        '# Demo\n\n- [Cart](./cart.md)\n- [Search](./search.md)\n',
      );
      writeFileSync(
        report,
        '# Verify after\n\nResult: pass\n\n## Features\n\n- `cart` pass. Judged by: the total counts the item. Evidence: verify/evidence/cart/total.png, verify/evidence/cart/drive.webm\n- `search` not driven. Why: the diff touches no search code.\n',
      );
      expect(errorOf(await after(report)).code).toBe('feature-unproven');
      mkdirSync(evidence, { recursive: true });
      for (const f of ['total.png', 'drive.webm']) writeFileSync(join(evidence, f), '');

      // With a Feature map, the pass needs its HTML report.
      const missing = errorOf(await after(report));

      expect(missing.code).toBe('no-verify-html');
      expect(missing.message).toContain('Write the HTML report from the verify kit');

      // Its HTML report: refused while a feature's verdict is not its ## Features line's.
      const html = join(run.worktree, '.scratch', 'verify-after.html');
      const cart =
        '<script>alert(1)</script><section class="ab-verify-feature" data-feature="cart" data-verdict="pass"><h4 class="ab-verify-head">Cart</h4><figure class="ab-verify-shot"><img src="verify/evidence/cart/total.png" alt="" onerror="alert(2)"></figure><figure class="ab-verify-shot"><img src="https://x.io/t.png" alt=""></figure><figure class="ab-verify-recording"><video src="verify/evidence/cart/drive.webm"></video></figure></section>';
      const search = (verdict: string) =>
        `<section class="ab-verify-feature" data-feature="search" data-verdict="${verdict}"><h4 class="ab-verify-head">Search</h4><p class="ab-verify-not-driven">No search code touched.</p></section>`;
      const withHtml = () =>
        s.requestAs(
          run.session,
          run.worktree,
          'factory',
          'verify',
          '--phase',
          'after',
          '--result',
          'pass',
          '--report',
          report,
          '--html',
          html,
          '--json',
        );

      writeFileSync(html, cart);
      const left = errorOf(await withHtml());

      expect(left.code).toBe('feature-html-differs');
      expect(left.message).toContain('has no section for search');
      writeFileSync(html, cart + search('pass'));
      const differs = errorOf(await withHtml());

      expect(differs.code).toBe('feature-html-differs');
      expect(differs.message).toContain('says search pass, ## Features says not-driven');

      // Kept sanitised beside the report, the verdicts on the verification.
      writeFileSync(html, cart + search('not-driven'));
      // The After pass ends verification: its browser stops.
      const passed = read(FactoryRunData, await withHtml());
      const last = passed.verifications.at(-1);

      expect(last?.features?.map((f) => [f.feature, f.verdict])).toEqual([
        ['cart', 'pass'],
        ['search', 'not-driven'],
      ]);
      expect(readFileSync(last?.html ?? '', 'utf8')).toBe(
        [
          '<section class="ab-verify-feature" data-feature="cart" data-verdict="pass">',
          '  <h4 class="ab-verify-head">Cart</h4>',
          '  <figure class="ab-verify-shot"><img src="verify/evidence/cart/total.png" alt=""></figure>',
          '  <figure class="ab-verify-recording"><video src="verify/evidence/cart/drive.webm"></video></figure>',
          '</section>',
          '<section class="ab-verify-feature" data-feature="search" data-verdict="not-driven">',
          '  <h4 class="ab-verify-head">Search</h4>',
          '  <p class="ab-verify-not-driven">No search code touched.</p>',
          '</section>',
          '',
        ].join('\n'),
      );
      expect(chrome.running).toBeUndefined();
      expect(
        read(
          BrowserData,
          await s.requestAs(run.session, run.worktree, 'browser', 'status', '--json'),
        ).stopped?.reason,
      ).toBe('verified');

      // Started again, then the session ends: stopped, its folder gone.
      read(BrowserData, await s.requestAs(run.session, run.worktree, 'browser', 'start', '--json'));
      expect(chrome.running).toBeDefined();
      read(SessionData, await s.request('session', 'stop', run.session, '--json'));
      await until('its browser stopped', () => (chrome.running === undefined ? true : undefined));
      await until('its folder gone', () =>
        existsSync(join(s.state.dir, 'browsers', run.session)) ? undefined : true,
      );
    },
  );

  test('a plain session has none: abe browser says so', { timeout: 30_000 }, async () => {
    scriptClaude(s.state.dir, []);
    const session = read(
      SessionData,
      await s.request('session', 'launch', '--card', '5', '--repo', repo, '--json'),
    );
    const refusal = await s.requestAs(session.id, session.worktree, 'browser', 'start', '--json');

    expect(errorOf(refusal).code).toBe('no-browser');
    expect(errorOf(await s.request('browser', 'status', '--json')).code).toBe('not-a-box');
    read(SessionData, await s.request('session', 'stop', session.id, '--json'));
  });
});

/**
 * Its own database in Abe's local database (faked; on real Docker at the end, when it runs): the
 * repo's Verification pack's skill names `DATABASE_URL`, no hook. The session's environment has it
 * (its shell's and its writers'), `abe run` and the run's checks in dev too, over dev's Abe env
 * file's; `abe run --env test` gets test's file's; serve's own never.
 */
describe.skipIf(process.platform !== 'darwin')("a local session's own database", () => {
  let root: string;
  let repo: string;
  let claude: FakeClaude;
  let mac: FakeMacDatabase;
  let s: ServeScenario;
  const SERVES = 'postgres://serve:pw@127.0.0.1:5432/serve';
  const nameOf = (session: string) => `abe_${session.replace('-', '_')}`;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-ldb-'));
    repo = join(root, 'shop');
    mkdirSync(join(root, 'mine'), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(root, 'init', '-q', '-b', 'main', repo);
    writeFileSync(
      join(repo, '.gitignore'),
      '.fake-claude/\n*.env\n*.pid\n*.db\n.scratch/\n.abe/settings.local.yaml\n',
    );
    pack(repo, { start: SCRIPTS.start, stop: SCRIPTS.stop });
    mkdirSync(join(repo, '.claude', 'skills', 'verify-shop'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'skills', 'verify-shop', 'SKILL.md'),
      '# Verification pack\n\nThe API needs `$DATABASE_URL`: run it only with `abe run start`.\n',
    );
    writeFileSync(
      join(repo, 'abe.yaml'),
      `${REPO_SETTINGS}checks:\n  - name: tests\n    run: printenv DATABASE_URL > checks.db\n`,
    );
    mkdirSync(join(repo, '.abe'), { recursive: true });
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    // the person's own in dev's Abe env file, and test's
    writeFileSync(
      join(repo, '.abe', 'abe.dev.env'),
      'DATABASE_URL=postgres://mine:pw@localhost:5432/shop\nAPI_KEY=fake-dev-key\n',
    );
    writeFileSync(
      join(repo, '.abe', 'abe.test.env'),
      'DATABASE_URL=postgres://t:pw@test.example/shop\n',
    );
    claude = fakeClaude();
    mac = fakeMacDatabase();
    s = await scenario({
      mac,
      board: fakeBoard([4, 5].map((id) => card(id, `Cart total ${id}`))),
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          DATABASE_URL: SERVES,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    'a Factory run: in its environment, its abe run and its checks in dev; test gets its file; dropped at its end',
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        { abe: ['factory', 'stage-done', 'build', '--json'] },
      ]);
      const run = read(
        FactoryRunData,
        await s.request('factory', 'run', '4', '--repo', repo, '--json'),
      );
      const own = fakeDbUrl(nameOf(run.session));

      await until('claude started', () =>
        claudeOutput(run.worktree).env === undefined ? undefined : true,
      );
      const env = z.record(z.string(), z.string()).parse(claudeOutput(run.worktree).env);

      // its own, in the environment its jail runs each command in; never one a scrub would strip
      expect([env.DATABASE_URL, env[SHELL_PREFIX_ENV]?.endsWith('/jail.sh')]).toEqual([own, true]);
      expect(env[SUBPROCESS_SCRUB_ENV]).toBeUndefined();
      expect(argvOf(run.worktree).some((a) => a.includes(NO_DATABASE_NOTE))).toBe(false);
      // abe run in dev: its own over dev's file's, the file's other values still there
      const ran = read(
        RunData,
        await s.requestAs(run.session, run.worktree, 'run', 'start', '--json'),
      );
      const given = readFileSync(join(run.worktree, 'start.env'), 'utf8');

      expect(ran.exit).toBe(0);
      expect(given).toContain(`DATABASE_URL=${own}\n`);
      expect(given).toContain('API_KEY=fake-dev-key\n');
      // in test: test's file's, never this machine's
      read(
        RunData,
        await s.requestAs(run.session, run.worktree, 'run', 'start', '--env', 'test', '--json'),
      );
      expect(readFileSync(join(run.worktree, 'start.env'), 'utf8')).toContain(
        'DATABASE_URL=postgres://t:pw@test.example/shop\n',
      );
      // the run's checks (dev): its own
      await until(
        'its checks ran',
        () => (existsSync(join(run.worktree, 'checks.db')) ? true : undefined),
        { ms: 15_000, every: 25 },
      );
      expect(readFileSync(join(run.worktree, 'checks.db'), 'utf8').trim()).toBe(own);
      read(SessionData, await s.request('session', 'stop', run.session, '--json'));
      await until('its database dropped', () =>
        mac.dbs.has(nameOf(run.session)) ? undefined : true,
      );
    },
  );

  test(
    "a plain session gets its own in its environment too, never serve's",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, []);
      const session = read(
        SessionData,
        await s.request('session', 'launch', '--card', '5', '--repo', repo, '--json'),
      );

      await until('claude started', () =>
        claudeOutput(session.worktree).env === undefined ? undefined : true,
      );
      expect(
        z.record(z.string(), z.string()).parse(claudeOutput(session.worktree).env).DATABASE_URL,
      ).toBe(fakeDbUrl(nameOf(session.id)));
      read(SessionData, await s.request('session', 'stop', session.id, '--json'));
    },
  );
});

const realDocker = findDocker(process.env);
const realUp =
  realDocker !== null &&
  Bun.spawnSync([realDocker, 'image', 'inspect', POSTGRES_IMAGE], { stdout: 'ignore' }).exitCode ===
    0;

/** On real Docker, in a container and volume of its own (never `abe-pg`), removed after. */
describe.skipIf(process.platform !== 'darwin' || !realUp)(
  "a local session's own database on real Docker",
  () => {
    let root: string;
    let repo: string;
    let claude: FakeClaude;
    let s: ServeScenario;
    const tag = randomBytes(4).toString('hex');
    const names = { container: `abe-pg-test-${tag}`, volume: `abe-pg-test-${tag}-data` };
    const docker = (...args: string[]) =>
      Bun.spawnSync([realDocker ?? 'docker', ...args])
        .stdout.toString()
        .trim();

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'abe-rdb-'));
      repo = join(root, 'shop');
      mkdirSync(join(root, 'mine'), { recursive: true });
      writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
      git(root, 'init', '-q', '-b', 'main', repo);
      writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.abe/settings.local.yaml\n');
      mkdirSync(join(repo, '.claude', 'skills', 'verify-shop'), { recursive: true });
      writeFileSync(
        join(repo, '.claude', 'skills', 'verify-shop', 'SKILL.md'),
        '# Verification pack\n\nThe API needs `$DATABASE_URL`.\n',
      );
      writeFileSync(join(repo, 'abe.yaml'), REPO_SETTINGS);
      mkdirSync(join(repo, '.abe'), { recursive: true });
      writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'first');
      claude = fakeClaude();
      const env = { ...GIT_ENV, PATH: claude.path, ABE_CONFIG_DIR: join(root, 'mine') };

      s = await scenario({
        mac: macDatabase({
          dir: join(root, 'mac-db'),
          env: process.env,
          bin: realDocker ?? 'docker',
          names,
        }),
        board: fakeBoard([4].map((id) => card(id, `Cart total ${id}`))),
        sessions: { env },
      });
    }, 30_000);
    afterAll(async () => {
      await s.close();
      claude.remove();
      docker('rm', '--force', names.container);
      docker('volume', 'rm', '--force', names.volume);
      rmSync(root, { recursive: true, force: true });
    });

    test(
      'its URL in its environment reaches its own database, dropped at its end',
      { timeout: 120_000 },
      async () => {
        scriptClaude(s.state.dir, []);
        const session = read(
          SessionData,
          await s.request('session', 'launch', '--card', '4', '--repo', repo, '--json'),
        );

        await until(
          'claude started',
          () => (claudeOutput(session.worktree).env === undefined ? undefined : true),
          { ms: 90_000, every: 100 },
        );
        const url = new URL(
          z.record(z.string(), z.string()).parse(claudeOutput(session.worktree).env).DATABASE_URL ??
            '',
        );
        const db = url.pathname.slice(1);
        const asIt = () =>
          docker(
            'exec',
            '--env',
            `PGPASSWORD=${decodeURIComponent(url.password)}`,
            names.container,
            'psql',
            '-h',
            '127.0.0.1',
            '-U',
            decodeURIComponent(url.username),
            '-d',
            db,
            '-tAc',
            'select current_database()',
          );

        expect([url.hostname, db]).toEqual(['127.0.0.1', `abe_${session.id.replace('-', '_')}`]);
        expect(asIt()).toBe(db);
        read(SessionData, await s.request('session', 'stop', session.id, '--json'));
        await until(
          'its database dropped',
          () =>
            docker(
              'exec',
              '--user',
              'postgres',
              names.container,
              'psql',
              '-tAc',
              `select count(*) from pg_database where datname = '${db}'`,
            ) === '0'
              ? true
              : undefined,
          { ms: 30_000, every: 200 },
        );
      },
    );
  },
);
