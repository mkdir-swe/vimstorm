/**
 * `abe install` through the socket: each part's check, its reads over the fake InstallRepo and
 * core's verdict on them, one row a part; two changes at once never losing one another's; its
 * session the repo's Abe chat, launched unjailed and told `/abe:install` while not Done; the Abe
 * chat running every abe command, prod-on too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  checkedSourceServers,
  HubData,
  Install,
  INSTALL_PARTS,
  InstallCheckedData,
  InstallPart,
  type PartState,
  InstallSourcesData,
  InstallView,
  ReadFindings,
  type Reply,
  REPO_ID_PATH,
  RepoMoved,
  SessionData,
  SessionListData,
  SettingGetData,
  SourcesData,
} from '@abe/core';
import { localPrototypeApps, localPrototypeProxy } from '@abe/ports';
import {
  card,
  fakeBoard,
  heldEvents,
  installDone,
  fakeLoginStore,
  fakeLoginTools,
  fakeMacDatabase,
  installFakes,
  type InstallFakes,
  refusingTracking,
  requestAt,
  prototypeRepo,
  repoScenario,
  served,
  type ServedCli,
  shopPrototypeStart,
  until,
} from '@abe/testing';
import { z } from 'zod';

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  });

  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

/** GitHub as gh answers for ann: who she is and the repo's pull requests, nothing else. */
const tracking = () => ({
  ...refusingTracking(),
  me: () => Promise.resolve({ ok: true as const, data: { login: 'ann' } }),
  recentPrs: () => Promise.resolve({ ok: true as const, data: [] }),
});

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'install-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("abe install check: each part's reads and verdict, over the fake InstallRepo", () => {
  let cli: ServedCli;
  let fakes: InstallFakes;
  let n = 0;

  beforeAll(async () => {
    fakes = installFakes({ env: { PATH: '/usr/bin:/bin', HOME: dir }, dir: join(dir, 'parts-s') });
    // a board with no cards: the Board check's live read answers
    cli = await served({ install: fakes, board: fakeBoard([]) });
  });
  afterAll(async () => {
    await cli.close();
  });

  /** A main checkout with one commit, its install begun here (no join), then `files` written. */
  const checkout = async (files: Readonly<Record<string, string>>) => {
    const top = realpathSync(mkdtempSync(join(dir, `parts-${(n += 1)}-`)));

    writeFileSync(join(top, 'package.json'), '{}');
    git(top, 'init', '-q', '-b', 'main');
    git(top, 'add', 'package.json');
    git(top, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init');
    const begun = await cli.jsonWith({ cwd: top }, InstallView, 'install');

    if (!begun.doc.ok) throw new Error(begun.doc.error.message);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(top, path)), { recursive: true });
      writeFileSync(join(top, path), text.replaceAll('<top>', basename(top)));
    }

    return top;
  };
  /** A part checked: the exit, and its state, its fail's code and its line as recorded. */
  const check = async (top: string, part: string) => {
    const r = await cli.jsonWith({ cwd: top }, InstallCheckedData, 'install', 'check', part);
    const kept = Install.parse(await fakes.store.read(top)).parts[InstallPart.parse(part)];

    return [r.exit, kept?.state, kept?.why ?? null, kept?.line ?? ''] as const;
  };
  const LOCAL_BOARD = 'board:\n  provider: local\n  project: shop\n';
  const TESTING = { '.claude/skills/<top>-testing/SKILL.md': '# t\n' };
  const ENV_FILES = { '.abe/abe.dev.env': '', '.abe/abe.test.env': '', '.abe/abe.prod.env': '' };

  test.each<
    [
      string,
      InstallPart,
      Readonly<Record<string, string>>,
      ((f: InstallFakes) => void) | null,
      [number, PartState, string | null, string],
    ]
  >([
    [
      'Env files: none there',
      'env-files',
      {},
      null,
      [
        1,
        'fail',
        'env-files-missing',
        '.abe/abe.dev.env, .abe/abe.test.env, .abe/abe.prod.env not there: abe install env-map writes them, prefilled',
      ],
    ],
    [
      'Env files: the three there',
      'env-files',
      ENV_FILES,
      null,
      [0, 'pass', null, '.abe/abe.dev.env'],
    ],
    [
      "Env files: abe.yaml's groups place them (a teammate's install): prefilled from those, no env map",
      'env-files',
      {
        'abe.yaml': 'worktree:\n  link:\n    dev: [backend/.env]\n',
        'backend/.env': 'API_URL=http://localhost:4000\n',
      },
      null,
      [0, 'pass', null, '.abe/abe.dev.env, .abe/abe.test.env, .abe/abe.prod.env are there'],
    ],
    ['Board: none named', 'board', {}, null, [1, 'fail', 'no-board', 'abe.yaml names no board']],
    [
      'Board: one on this machine, where specs go unsaid',
      'board',
      { 'abe.yaml': LOCAL_BOARD },
      null,
      [1, 'fail', 'spec-where-unwritten', 'abe.yaml does not say where specs go'],
    ],
    [
      'Board: one on this machine, specs to files',
      'board',
      { 'abe.yaml': `${LOCAL_BOARD}spec.where: file\n` },
      null,
      [0, 'pass', null, 'On this machine'],
    ],
    [
      'Board: an Azure board leaving out a lane and a tag, specs to files',
      'board',
      {
        'abe.yaml':
          'board:\n  organization: https://dev.azure.com/demo-org\n  project: Demo\n  team: Shop team\n  excludeLanes: [External dependencies]\n  notTag: blocked\nspec.where: file\n',
      },
      null,
      [0, 'pass', null, 'Azure Boards'],
    ],
    [
      'Skills: no testing skill',
      'skills',
      {},
      null,
      [1, 'fail', 'no-testing-skill', 'No testing skill in .claude/skills'],
    ],
    [
      'Skills: CLAUDE.md without its find-out section',
      'skills',
      { ...TESTING, 'CLAUDE.md': '# demo-shop\n' },
      null,
      [1, 'fail', 'no-find-out', 'CLAUDE.md has no ## Find out before you ask'],
    ],
    [
      'Skills: the testing skill and CLAUDE.md written',
      'skills',
      { ...TESTING, 'CLAUDE.md': '# demo-shop\n\n## Find out before you ask\n\n- Data: …\n' },
      null,
      [0, 'pass', null, '.claude/skills/'],
    ],
    [
      "Sources: a source's ${KEY} with no value of the person's",
      'sources',
      {
        'abe.yaml':
          'sources:\n  - name: flags\n    transport: stdio\n    command: npx\n    env:\n      FLAGS_API_USER: ${FLAGS_API_USER}\n',
      },
      null,
      [
        1,
        'fail',
        'source-value-missing',
        'FLAGS_API_USER has no value: sources: references it; the person adds FLAGS_API_USER=<value> to .abe/sources.env (theirs, never committed)',
      ],
    ],
    [
      'Checks: one fails as serve runs it',
      'checks',
      { 'abe.yaml': 'checks:\n  - name: unit\n    run: make unit-red\n' },
      (f) => f.checkEnds.set('unit-red', { exit: 1, output: 'FAIL' }),
      [1, 'fail', 'check-unproven', 'unit'],
    ],
    [
      'Checks: each passes as serve runs it',
      'checks',
      { 'abe.yaml': 'checks:\n  - name: unit\n    run: make unit\n' },
      null,
      [0, 'pass', null, 'unit pass as serve runs them'],
    ],
    ['Workflows: Abe’s copied in', 'workflows', {}, null, [0, 'pass', null, 'Copied ']],
    [
      'Worktree: no recipe',
      'worktree',
      {},
      null,
      [1, 'fail', 'no-recipe', 'abe.yaml has no worktree'],
    ],
    [
      'Verify: the app never ran',
      'verify',
      {},
      null,
      [1, 'fail', 'not-run', 'The app has not run'],
    ],
    ['Done: parts left', 'done', {}, null, [1, 'fail', 'parts-left', 'Logins, ']],
  ])('%s', async (_, part, files, given, [exit, state, why, line]) => {
    given?.(fakes);
    try {
      const top = await checkout(files);
      const [ran, kept, code, said] = await check(top, part);

      expect([ran, kept, code, said]).toEqual([exit, state, why, said]);
      expect(said).toContain(line.replaceAll('<top>', basename(top)));
    } finally {
      fakes.checkEnds.clear();
    }
  });

  // A check's reads take their time (its checks run, a worktree is tried) while other changes
  // save: each change is the move on the record as kept, so none is lost.
  test.each<[string, (top: string) => Promise<unknown>, (i: Install) => unknown, unknown]>([
    [
      'another part checked meanwhile',
      (top) => check(top, 'env-files'),
      (i) => i.parts['env-files']?.state,
      'fail',
    ],
    [
      "the checks' environment said meanwhile",
      (top) => cli.runWith({ cwd: top }, 'install', 'checks-env', 'test'),
      (i) => i.checksEnv?.env,
      'test',
    ],
  ])('a part checked while %s: both kept', async (_, meanwhile, kept, want) => {
    const top = await checkout({ 'abe.yaml': 'checks:\n  - name: unit\n    run: make slow\n' });

    fakes.holdChecks.add('make slow');
    try {
      const checked = check(top, 'checks');

      await until('the check running', () =>
        fakes.checkHeld.open().length === 1 ? true : undefined,
      );
      await meanwhile(top);
      fakes.checkHeld.resolve('make slow', { exit: 0, output: '' });
      expect((await checked).slice(0, 2)).toEqual([0, 'pass']);
      const i = Install.parse(await fakes.store.read(top));

      expect([i.parts.checks?.state, kept(i)]).toEqual(['pass', want]);
    } finally {
      fakes.holdChecks.clear();
      fakes.checkHeld.settled();
    }
  });

  // What the install judges of the repo is the team's (ADR 0040): each move writes abe.yaml, its
  // other keys and comments kept, so a teammate's install reads it rather than judging again.
  test.each<[string, string[][], Record<string, unknown>]>([
    [
      'the env map as worktree groups, its not-used files as env.notUsed',
      [
        [
          'install',
          'env-map',
          '--file',
          'backend/.env -> dev,test,prod: backend/package.json:11 dotenv -e .env',
          '--file',
          'backend/.env.dev -> dev: dotenv -c dev',
          '--file',
          'backend/.env.prod -> prod: deploy.yml:20',
          '--file',
          'backend/.env.bak -> not-used: an old copy',
        ],
      ],
      {
        worktree: {
          link: {
            all: ['node_modules/.cache', 'backend/.env'],
            dev: ['backend/.env.dev'],
            prod: ['backend/.env.prod'],
          },
        },
        'env.notUsed': [{ key: 'backend/.env.bak', why: 'an old copy' }],
      },
    ],
    [
      "the checks' environment",
      [['install', 'checks-env', 'test', '--why', 'ci.yml:9']],
      { checksEnv: 'test' },
    ],
    [
      "the gate's test and read-only hosts and keys not used, each once",
      [
        [
          'install',
          'gate',
          '--before-run',
          '--test-host',
          'API.test.demo-shop.example',
          '--read-only-host',
          'cdn.demo-shop.example',
          '--not-used',
          'LEGACY_KEY: nothing reads it',
        ],
        ['install', 'gate', '--before-run', '--test-host', 'api.test.demo-shop.example'],
      ],
      {
        'gate.testHosts': ['api.test.demo-shop.example'],
        'gate.readOnlyHosts': ['cdn.demo-shop.example'],
        'env.notUsed': [{ key: 'LEGACY_KEY', why: 'nothing reads it' }],
      },
    ],
    [
      "the repo's kind, then a monorepo part's",
      [
        ['install', 'kind', 'library'],
        // a part said: the repo is a monorepo of parts, the whole repo's kind gone
        ['install', 'kind', 'web-app', '--part', 'apps/web/'],
      ],
      { kind: { 'apps/web': 'web-app' } },
    ],
  ])('%s: written to abe.yaml', async (_, commands, want) => {
    const team =
      "# demo-shop's team file\nchecks:\n  - name: unit\n    run: make unit\nworktree:\n  link: [node_modules/.cache]\n";
    const top = await checkout({ 'abe.yaml': team });

    for (const c of commands) await cli.runWith({ cwd: top }, ...c);
    const text = readFileSync(join(top, 'abe.yaml'), 'utf8');
    const doc = z.record(z.string(), z.unknown()).parse(Bun.YAML.parse(text));
    const flat = Object.fromEntries(
      Object.keys(want).map((k) => {
        const [head = '', tail] = k.split('.');
        const v = doc[head];

        return [k, tail === undefined ? v : z.record(z.string(), z.unknown()).parse(v)[tail]];
      }),
    );

    expect(flat).toEqual(want);
    expect(text).toStartWith(
      "# demo-shop's team file\nchecks:\n  - name: unit\n    run: make unit\n",
    );
  });

  test('Read writes the fixed ports it found into abe.yaml, beside those there', async () => {
    const top = realpathSync(mkdtempSync(join(dir, 'ports-')));

    git(top, 'init', '-q', '-b', 'main');
    writeFileSync(join(top, 'abe.yaml'), 'ports.fixed: [9000]\n');
    writeFileSync(join(top, '.env.example'), 'AUTH_CALLBACK_URL=http://localhost:3000/callback\n');
    await cli.runWith({ cwd: top }, 'install');

    expect(Bun.YAML.parse(readFileSync(join(top, 'abe.yaml'), 'utf8'))).toEqual({
      ports: { fixed: [9000, 3000] },
    });
  });

  // A source's sign-in is serve's, in the background: its end is recorded while a check that read
  // the record before it ended still runs, and that check's save keeps it.
  test("a source's sign-in that ends while a part is checked: its end kept", async () => {
    const top = await checkout({ 'abe.yaml': 'checks:\n  - name: unit\n    run: make slow\n' });
    const record = Install.parse(await fakes.store.read(top));

    await fakes.store.write(top, {
      ...record,
      sources: { sentry: 'add' },
      sourceServers: { sentry: { from: 'yours' } },
    });
    fakes.mcp.set('sentry', 'needs-auth');
    fakes.holdSignIns.add('sentry');
    fakes.holdChecks.add('make slow');
    try {
      const signIn = await cli.jsonWith({ cwd: top }, SourcesData, 'source', 'sign-in', 'sentry');

      expect(signIn.doc.ok ? signIn.doc.data.sources.map((x) => [x.id, x.signIn]) : []).toEqual([
        ['sentry', 'signing-in'],
      ]);
      await until('the sign-in in the browser', () =>
        fakes.signInHeld.open().length === 1 ? true : undefined,
      );
      const checked = check(top, 'checks');

      await until('the check running', () =>
        fakes.checkHeld.open().length === 1 ? true : undefined,
      );
      fakes.signInHeld.resolve('sentry', { signedIn: true });
      await until('its end recorded', async () =>
        Install.parse(await fakes.store.read(top)).signingIn.length === 0 ? true : undefined,
      );
      fakes.checkHeld.resolve('make slow', { exit: 0, output: '' });
      await checked;
      const i = Install.parse(await fakes.store.read(top));

      expect([i.signingIn, i.sourceChecks.sentry?.mcp, i.parts.checks?.state]).toEqual([
        [],
        'connected',
        'pass',
      ]);
    } finally {
      fakes.holdSignIns.clear();
      fakes.holdChecks.clear();
      fakes.signInHeld.settled();
      fakes.checkHeld.settled();
      fakes.mcp.delete('sentry');
    }
  });

  // After the install (or a source it did not add) the sign-in is Settings': Signing in… on its
  // row while it runs, then how it ended, kept by serve for the row.
  test("a source's sign-in from Settings: Signing in…, then how it ended", async () => {
    const top = await checkout({ 'abe.yaml': 'sources:\n  - sentry\n' });
    const rows = async (...argv: string[]) => {
      const r = await cli.jsonWith({ cwd: top }, SourcesData, 'source', ...argv);

      return r.doc.ok ? r.doc.data.sources.map((x) => [x.id, x.check, x.signIn]) : [];
    };

    const asked = fakes.signInAsks.length;

    fakes.mcp.set('sentry', 'needs-auth');
    fakes.holdSignIns.add('sentry');
    try {
      expect(await rows('sign-in', 'sentry')).toEqual([['sentry', 'Signing in…', 'signing-in']]);
      await until('the sign-in in the browser', () =>
        fakes.signInHeld.open().length === 1 ? true : undefined,
      );
      // a second one while it runs: the same sign-in, never another browser
      expect(await rows('sign-in', 'sentry')).toEqual([['sentry', 'Signing in…', 'signing-in']]);
      fakes.signInHeld.resolve('sentry', {
        signedIn: false,
        why: 'the browser closed',
        fallback: false,
      });
      await until('its end', async () =>
        JSON.stringify(await rows('status')).includes('signing-in') ? undefined : true,
      );
      expect(await rows('status')).toEqual([
        ['sentry', 'sign-in failed: the browser closed', 'offered'],
      ]);
      expect(fakes.signInAsks.slice(asked)).toEqual(['sentry']);
    } finally {
      fakes.holdSignIns.clear();
      fakes.signInHeld.settled();
      fakes.mcp.delete('sentry');
    }
  });
});

describe('abe install: its session', () => {
  type Launched = {
    id: string;
    folder?: string;
    prompt: string;
    plugin: string[];
    instructions: string;
    deny: readonly string[];
    ask: readonly string[];
    env: Readonly<Record<string, string>>;
    sandboxRead: readonly string[] | null;
    /** `claude --resume` on its conversation. */
    resumed: boolean;
    mcp: string;
    /** The source servers it starts, and those it is told no install check passed for. */
    servers: readonly string[];
    unchecked: readonly string[];
  };
  const launched: Launched[] = [];
  const typed: { id: string; text: string }[] = [];
  const running = new Set<string>();
  let other: ServedCli;
  let otherFakes: InstallFakes;
  let signedIn: ReturnType<typeof fakeLoginTools>;
  /** Abe's local database, Docker up unless a test says otherwise. */
  const otherMac = fakeMacDatabase();
  let shop: string;

  beforeAll(async () => {
    shop = join(dir, 'shop-2');
    mkdirSync(shop);
    git(shop, 'init', '-q', '-b', 'main');
    writeFileSync(join(shop, 'package.json'), '{}');
    git(shop, 'add', '.');
    git(shop, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init');
    const home2 = join(dir, 'home2');

    mkdirSync(home2);
    signedIn = fakeLoginTools(home2);

    for (const t of ['github', 'claude', 'az'] as const) signedIn.set(t, true);
    otherFakes = installFakes({ env: { PATH: '/usr/bin:/bin', HOME: dir }, dir: join(dir, 's2') });
    other = await served({
      mac: otherMac,
      storedLogins: { secret: null, store: fakeLoginStore(), tools: signedIn, home: home2 },
      install: otherFakes,
      // your gh login in this checkout (`logins.gh`, ADR 0025): its token only on Connected
      github: {
        githubAs: () => ({ tracking: tracking() }),
        githubToken: () => () => Promise.resolve({ ok: true, data: 'fake-gh-token' }),
        githubAccounts: () => Promise.resolve({ active: 'ann', signedIn: ['ann'] }),
      },
      sessions: {
        // a fake aws first on PATH (below); `abe run` for real
        env: { PATH: `${join(dir, 'fake-bin')}:/usr/bin:/bin` },
        local: true,
        runner: {
          abe: 'abe',
          bin: join(dir, 'bin'),
          // a local runner's: its sessions jailed, but an install's
          plugins: join(dir, 's2-plugins'),
          socket: (id) => ({
            listen: join(dir, 's2', id, 'session.sock'),
            session: join(dir, 's2', id, 'session.sock'),
            mode: 0o600,
          }),
          launch: (spec) => {
            launched.push({
              id: spec.id,
              ...(spec.folder === undefined ? {} : { folder: spec.folder }),
              prompt: spec.prompt,
              plugin: spec.plugin.map((p) => p.path),
              instructions: spec.instructions,
              deny: spec.settings.permissions?.deny ?? [],
              ask: spec.settings.permissions?.ask ?? [],
              sandboxRead: spec.settings.sandbox?.filesystem?.denyRead ?? null,
              env: spec.env,
              resumed: spec.reopen === true,
              mcp: spec.mcpMode,
              servers: Object.keys(spec.sources?.servers ?? {}),
              unchecked: spec.sources?.unchecked ?? [],
            });
            running.add(spec.id);

            return Promise.resolve({
              ok: true,
              data: { worktree: spec.folder ?? shop, setup: null, trusted: false },
            });
          },
          baseWorktree: () => Promise.resolve({ ok: false, error: { code: 'no', message: 'no' } }),
          // the main checkout's own local server, never checked at this install yet
          sourceServers: () => ({
            servers: { sentry: { type: 'http', url: 'https://s.test/mcp' } },
            loaded: ['sentry'],
            missing: [],
            withheld: [],
          }),
          send: (id, text) => {
            typed.push({ id, text });

            return Promise.resolve({ ok: true, data: null });
          },
          keys: () => Promise.resolve({ ok: true, data: null }),
          screen: () => Promise.resolve({ ok: true, data: '' }),
          attach: () => [],
          stop: (id) => {
            running.delete(id);

            return Promise.resolve({ ok: true, data: null });
          },
          running: () => Promise.resolve({ ok: true, data: [...running] }),
        },
      },
    });
  });

  afterAll(async () => {
    await other.close();
  });

  const start = async () => {
    const r = await other.jsonWith({ cwd: shop }, InstallView, 'install');

    if (!r.doc.ok) throw new Error(r.doc.error.message);

    return r.doc.data;
  };
  const check = async (part: string) => {
    const r = await other.jsonWith({ cwd: shop }, InstallCheckedData, 'install', 'check', part);

    if (!r.doc.ok) throw new Error(r.doc.error.message);

    return { exit: r.exit, part: r.doc.data.parts.find((p) => p.id === part) };
  };

  test('the Abe chat: unjailed, told /abe:install while not Done and not busy, the same one again; --new a fresh one', async () => {
    const first = await start();
    const l = launched[0];

    expect(Object.keys(first).sort()).toEqual([
      'done',
      'files',
      'join',
      'parts',
      'prototype',
      'read',
      'repo',
      'session',
    ]);
    expect([first.join, first.done, first.session?.id]).toEqual([false, false, l?.id]);
    expect(first.session?.id).toMatch(/^abe-[0-9a-f]{4}$/);
    expect(first.parts.map((p) => [p.id, p.required, p.state])).toEqual(
      INSTALL_PARTS.map((p) => [p, p !== 'sources' && p !== 'prototype', 'todo']),
    );
    // as the person's own Claude Code: no Seatbelt sandbox, no fence, no file of its own denied
    expect([l?.sandboxRead, l?.env.FENCED_BY_ABE]).toEqual([null, undefined]);
    expect(l?.deny.filter((r) => r.includes(`/${first.repo}`))).toEqual([]);
    expect(
      ['skills/abe/SKILL.md', 'skills/install/SKILL.md'].filter((f) => l?.plugin.includes(f)),
    ).toHaveLength(2);
    expect([l?.folder, l?.prompt]).toEqual([first.repo, '/abe:install']);
    // while it runs (its turn over), the same session, told /abe:install again; abe chat opens it
    await requestAt(
      join(dir, 's2', first.session?.id ?? '', 'session.sock'),
      shop,
      'hook',
      'Stop',
      '--payload',
      '{}',
    );
    expect((await start()).session?.id).toBe(first.session?.id);
    expect(typed.at(-1)).toEqual({ id: first.session?.id ?? '', text: '/abe:install' });
    // at a turn of its own: only opened, nothing typed into it
    await requestAt(
      join(dir, 's2', first.session?.id ?? '', 'session.sock'),
      shop,
      'hook',
      'UserPromptSubmit',
      '--payload',
      '{}',
    );
    const told = typed.length;

    expect((await start()).session?.id).toBe(first.session?.id);
    expect(typed.length).toBe(told);
    const chat = await other.jsonWith({ cwd: shop }, HubData, 'chat');

    expect(chat.doc.ok ? [chat.doc.data.id, chat.doc.data.opened] : []).toEqual([
      first.session?.id ?? '',
      'running',
    ]);
    // once it ended, the same record reopened (this fake's claude never heard a hook: no
    // conversation to resume), /abe:install its first message
    await other.runWith({ cwd: shop }, 'session', 'stop', first.session?.id ?? '');
    const again = await start();

    expect([again.session?.id, launched.length, launched.at(-1)?.prompt]).toEqual([
      first.session?.id,
      2,
      '/abe:install',
    ]);
    // a new conversation beside it: the old one goes on, the install's session the new one
    const fresh = await other.jsonWith({ cwd: shop }, HubData, 'chat', '--new');
    const freshId = fresh.doc.ok ? fresh.doc.data.id : '';
    const show = async (id: string) => {
      const r = await other.jsonWith({ cwd: shop }, SessionData, 'session', 'show', id);

      return r.doc.ok ? [r.doc.data.state === 'ended', r.doc.data.abe?.name] : [];
    };

    expect([fresh.doc.ok && fresh.doc.data.opened, launched.at(-1)?.prompt]).toEqual([
      'new',
      '/abe:abe',
    ]);
    expect(freshId).not.toBe(first.session?.id);
    expect(await show(first.session?.id ?? '')).toEqual([false, 'Install']);
    expect(await show(freshId)).toEqual([false, 'Abe 2']);
    expect((await start()).session?.id).toBe(freshId);
    // your first message names it; a later one not
    await other.runWith(
      { cwd: shop },
      'session',
      'send',
      freshId,
      'why does the cart round',
      'wrong?',
    );
    await other.runWith({ cwd: shop }, 'session', 'send', freshId, 'and the tax');
    expect(await show(freshId)).toEqual([false, 'why does the cart round wrong?']);
    // the old one closed: the newer one is the repo's again
    await other.runWith({ cwd: shop }, 'session', 'stop', first.session?.id ?? '');
  });

  test('the Abe chat runs every abe command as the person: settings set, prod for agents too', async () => {
    const id = (await start()).session?.id ?? '';
    const set = await requestAt(
      join(dir, 's2', id, 'session.sock'),
      shop,
      'settings',
      'set',
      'agents.prod',
      'true',
      '--mine',
      '--json',
    );
    const got = await other.jsonWith(
      { cwd: shop },
      SettingGetData,
      'settings',
      'get',
      'agents.prod',
    );

    expect([set.exit, got.doc.ok ? got.doc.data.value : null]).toEqual([0, true]);
    await other.runWith({ cwd: shop }, 'settings', 'set', 'agents.prod', 'false', '--mine');
  });

  // The team's sources (ADR 0031): abe install source writes abe.yaml's sources:, never claude mcp
  // add; abe install check sources records each one's check under its name, and a session here
  // loads only those whose check passed (`checkedSourceServers`).
  test('a source in abe.yaml: written by install source, its check recorded, loaded once it passed', async () => {
    const top = realpathSync(mkdtempSync(join(dir, 'team-sources-')));
    const sources = async (...argv: string[]) => {
      const r = await other.jsonWith({ cwd: top }, InstallSourcesData, 'install', ...argv);

      return r.doc.ok ? r.doc.data.sources : `${r.doc.error.code}: ${r.doc.error.message}`;
    };
    const checkSources = async () => {
      const r = await other.jsonWith(
        { cwd: top },
        InstallCheckedData,
        'install',
        'check',
        'sources',
      );
      const record = Install.parse(await otherFakes.store.read(top));

      return [r.exit, checkedSourceServers(record)];
    };

    git(top, 'init', '-q', '-b', 'main');
    writeFileSync(join(top, 'package.json'), '{}');
    git(top, 'add', '.');
    git(top, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init');
    otherFakes.found.push(
      {
        name: 'linear',
        found: 'user-scope',
        definition: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      },
      {
        name: 'keyed',
        found: 'user-scope',
        definition: { type: 'http', url: 'https://k.test/mcp', headers: { Authorization: 'B v' } },
      },
    );
    try {
      await other.jsonWith({ cwd: top }, InstallView, 'install');
      // yours copied as it is, a new one by its URL; never a secret, never claude mcp add
      await sources('source', 'linear');
      expect(await sources('source', 'https://mcp.sentry.dev/mcp')).toMatchObject([
        { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' },
        { name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' },
        { name: 'keyed', found: 'user-scope' },
      ]);
      expect(readFileSync(join(top, 'abe.yaml'), 'utf8')).toContain('name: linear');
      expect(await sources('source', 'keyed')).toContain('source-secret');
      expect(otherFakes.added).toEqual([]);
      // linear reads, sentry wants a sign-in: only linear is loaded, and the part fails
      otherFakes.mcp.set('linear', 'connected');
      otherFakes.mcp.set('sentry', 'needs-auth');
      expect(await checkSources()).toEqual([1, ['linear']]);
      // signed in since: checked again, both loaded
      otherFakes.mcp.set('sentry', 'connected');
      expect(await checkSources()).toEqual([0, ['linear', 'sentry']]);
    } finally {
      otherFakes.found.length = 0;
      otherFakes.mcp.delete('linear');
      otherFakes.mcp.delete('sentry');
    }
  });

  // A teammate's repo: its abe.yaml there, no record on this Mac. Status and the checks read it as
  // a join not begun; the install's other tools are the join's, /abe:install's.
  test('a join not begun here: status and checks answer, the rest says /abe:install', async () => {
    const top = realpathSync(mkdtempSync(join(dir, 'join-')));

    git(top, 'init', '-q', '-b', 'main');
    writeFileSync(join(top, 'abe.yaml'), '{}\n');
    const envMap = await other.jsonWith({ cwd: top }, InstallView, 'install', 'env-map');
    const status = await other.jsonWith({ cwd: top }, InstallView, 'install', 'status');

    expect(envMap.doc.ok ? null : envMap.doc.error).toEqual({
      code: 'installed',
      message: `${top} is set up for Abe (abe.yaml), not yet on this Mac: /abe:install in its Abe chat joins it`,
    });
    expect(
      status.doc.ok ? [status.doc.data.join, status.doc.data.session, status.doc.data.done] : null,
    ).toEqual([true, null, false]);
    expect(await otherFakes.store.read(top)).toBeUndefined();
    const checked = await other.jsonWith(
      { cwd: top },
      InstallCheckedData,
      'install',
      'check',
      'env-files',
    );

    expect([checked.exit, checked.doc.ok ? checked.doc.data.join : null]).toEqual([1, true]);
    expect(Install.parse(await otherFakes.store.read(top)).parts['env-files']?.state).toBe('fail');
  });

  test('.abe/ reset: its untracked and ignored files deleted, the ones the repo commits there kept', async () => {
    const top = realpathSync(mkdtempSync(join(dir, 'reset-')));
    const at = (path: string) => join(top, path);

    git(top, 'init', '-q', '-b', 'main');
    mkdirSync(at('.abe/scripts'), { recursive: true });
    writeFileSync(at('.abe/settings.yaml'), 'serve.target: local\n');
    writeFileSync(at('.abe/scripts/start'), '#!/bin/sh\n');
    git(top, 'add', '.');
    git(top, '-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'init');
    writeFileSync(join(top, '.git', 'info', 'exclude'), '.abe/.run/\n');
    mkdirSync(at('.abe/.run'));
    writeFileSync(at('.abe/.run/pgid'), '1\n');
    writeFileSync(at('.abe/abe.dev.env'), 'KEY=v\n');
    writeFileSync(at('.abe/scripts/mine'), '#!/bin/sh\n');
    expect((await other.jsonWith({ cwd: top }, InstallView, 'install')).doc.ok).toBe(true);

    expect((await other.runWith({ cwd: top }, 'install', 'reset')).exit).toBe(0);
    expect(
      [
        '.abe/settings.yaml',
        '.abe/scripts/start',
        '.abe/.run',
        '.abe/abe.dev.env',
        '.abe/scripts/mine',
      ].map((p) => [p, existsSync(at(p))]),
    ).toEqual([
      ['.abe/settings.yaml', true],
      ['.abe/scripts/start', true],
      ['.abe/.run', false],
      ['.abe/abe.dev.env', false],
      ['.abe/scripts/mine', false],
    ]);
  });

  test("cards on cloud boxes by your serve.target on this Mac: aws's login read on your box.profile there, never asked for", async () => {
    const was = await start();
    const record = Install.parse(await otherFakes.store.read(was.repo));
    const read = ReadFindings.parse({
      files: [],
      ci: [],
      scripts: {},
      envExample: null,
      envKeys: [],
      logins: ['aws'],
      board: null,
      fixedPorts: [],
    });

    await otherFakes.store.write(was.repo, { ...record, read });
    // yours on this Mac, everywhere: none in the checkout's own settings
    for (const [key, value] of [
      ['serve.target', 'cloud'],
      ['box.profile', 'abe-tooling'],
    ] as const)
      expect((await other.runWith({ cwd: shop }, 'settings', 'set', key, value)).exit).toBe(0);
    signedIn.set('aws', true);
    signedIn.awsProfiles.length = 0;
    const logins = await check('logins');

    expect(signedIn.awsProfiles).toContain('abe-tooling');
    expect(
      Install.parse(await otherFakes.store.read(was.repo)).logins?.find((l) => l.tool === 'aws')
        ?.state,
    ).toBe('ok');
    expect(logins.part?.line ?? '').not.toContain('abe login aws');
    for (const key of ['serve.target', 'box.profile'])
      expect((await other.runWith({ cwd: shop }, 'settings', 'unset', key)).exit).toBe(0);
    await otherFakes.store.write(was.repo, record);
  });

  test('Done: the Abe chat opened, /abe:install no more', async () => {
    const was = await start();
    const record = Install.parse(await otherFakes.store.read(was.repo));
    const at = '2026-10-28T09:00:00.000Z';

    await otherFakes.store.write(was.repo, {
      ...record,
      parts: Object.fromEntries(
        INSTALL_PARTS.map((p) => [p, { state: 'pass', line: `${p} ok`, checkedAt: at }]),
      ),
      finishedAt: at,
    });
    await other.runWith({ cwd: shop }, 'session', 'stop', was.session?.id ?? '');
    const launches = launched.length;
    const done = await start();

    expect(done.done).toBe(true);
    // the same chat reopened on its own words, never told to install
    expect(done.session?.id).toBe(was.session?.id);
    expect(launched.length).toBe(launches + 1);
    expect(launched.at(-1)?.prompt).not.toContain('/abe:install');
  });
});

describe('abe install check prototype: abe/scripts/prototype-start tried step by step', () => {
  let cli: ServedCli;
  let shop: string;
  const shots: string[] = [];
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const script = (text: string | null) => {
    const file = join(shop, 'abe', 'scripts', 'prototype-start');

    rmSync(file, { force: true });
    if (text === null) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { mode: 0o755 });
  };
  const check = async () => {
    const r = await cli.jsonWith(
      { cwd: shop },
      InstallCheckedData,
      'install',
      'check',
      'prototype',
    );

    if (!r.doc.ok) throw new Error(r.doc.error.message);
    const part = r.doc.data.parts.find((p) => p.id === 'prototype');

    return {
      exit: r.exit,
      state: part?.state,
      required: part?.required,
      tried: r.doc.data.prototype,
    };
  };

  beforeAll(async () => {
    shop = realpathSync(mkdtempSync(join(dir, 'proto-shop-')));
    prototypeRepo(shop);
    mkdirSync(join(shop, '.abe'), { recursive: true });
    writeFileSync(join(shop, '.abe', 'abe.dev.env'), 'SHOP_DEMO_USER=demo@shop.test\n');
    const state = join(dir, 'proto-state');

    cli = await served({
      install: installFakes({ env: { PATH, HOME: dir }, dir: join(dir, 'proto-s') }),
      prototypes: {
        dir: state,
        apps: localPrototypeApps({ dir: state, env: { PATH, HOME: dir } }),
        proxy: localPrototypeProxy(),
        shot: ({ url, file }) => {
          shots.push(url);
          writeFileSync(file, PNG);

          return Promise.resolve({ ok: true });
        },
      },
    });
    // the install begun here, so its team parts are its own (no join)
    const begun = await cli.jsonWith({ cwd: shop }, InstallView, 'install');

    if (!begun.doc.ok) throw new Error(begun.doc.error.message);
  });
  afterAll(async () => {
    await cli.close();
  });

  test('no script: refused no-start-script at its first step, optional so Done does not wait on it', async () => {
    script(null);
    const r = await check();

    expect([r.exit, r.state, r.required, r.tried?.steps.map((s) => [s.step, s.ok, s.why])]).toEqual(
      [1, 'fail', false, [['script', false, 'no-start-script']]],
    );
  });

  test('the demo shop: started on its port base with its env file, ready, its page loaded, signed in, a screenshot kept, stopped again', async () => {
    script(shopPrototypeStart({ login: 'SHOP_DEMO_USER' }));
    const r = await check();
    const base = r.tried?.portBase ?? 0;

    expect([r.exit, r.state, r.tried?.steps.map((s) => [s.step, s.ok])]).toEqual([
      0,
      'pass',
      [
        ['script', true],
        ['start', true],
        ['ready', true],
        ['page', true],
        ['login', true],
        ['screenshot', true],
      ],
    ]);
    expect(r.tried?.url).toBe(`http://127.0.0.1:${base}/`);
    expect(shots.at(-1)).toBe(`http://127.0.0.1:${base}/`);
    expect(r.tried?.screenshot).toBe(join(dir, 'proto-state', 'install-check', 'screenshot.png'));
    expect(r.tried?.log).toBe(join(dir, 'proto-state', 'install-check', 'start.out'));
    // stopped again: nothing on its port, its worktree gone
    expect(
      await fetch(`http://127.0.0.1:${base}/`).then(
        () => 'up',
        () => 'down',
      ),
    ).toBe('down');
    expect(existsSync(join(dir, 'proto-state', 'install-check', 'app'))).toBe(false);
  });

  test.each([
    ['a fixed port', { port: 0 }, 'ready', 'port-not-base'],
    ['a page that is not there', { path: '/nope' }, 'page', 'no-page'],
    ['a sign-in page', { path: '/account', login: 'SHOP_DEMO_USER' }, 'login', 'login-failed'],
    ['a login key the env file lacks', { login: 'SHOP_ADMIN_USER' }, 'script', 'login-key-missing'],
  ] as const)('%s: refused at its step with its code', async (_, o, step, why) => {
    script(shopPrototypeStart(o));
    const r = await check();
    const last = r.tried?.steps.at(-1);

    expect([r.exit, r.state, last?.step, last?.why]).toEqual([1, 'fail', step, why]);
  });
});

describe('a repo moved on this Mac: known by its id, followed at its new folder', () => {
  const ok = <T extends z.ZodType>(schema: T, reply: Reply): z.output<T> =>
    schema.parse(
      z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(reply.stdout)).data,
    );
  const gitIn = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(['git', '-C', cwd, ...args], { env: { PATH: '/usr/bin:/bin' } });

  test(
    'its install, sessions, held writes, local mode and worktrees follow; a copy is another repo; a worktree of one not found says so',
    { timeout: 60_000 },
    async () => {
      await using w = await repoScenario({ cards: [card(4, 'Sign in')], local: 'effort: high\n' });
      const { s, repo } = w;
      const moves = async () =>
        (await heldEvents(s.serve.socket))
          .filter((e) => e.type === 'repo.moved')
          .map((e) => RepoMoved.parse(e.data));

      await installDone(s.state.dir, repo);
      writeFileSync(join(w.mine, 'settings.yaml'), `serve.target: local\nlocalMode: [${repo}]\n`);
      s.serve.pollSettings();
      // met once: its id minted in .abe/, nothing followed
      ok(InstallView, await s.requestIn(repo, 'install', 'status', '--json'));
      expect(readFileSync(join(repo, REPO_ID_PATH), 'utf8')).toMatch(/^[0-9a-f]{16}\n$/);
      // never in git status, never committed: Abe's exclude block holds it
      expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('\n.abe/id\n');
      expect(gitIn(repo, 'status', '--porcelain').stdout.toString()).toBe('');
      const launched = ok(
        SessionData,
        await s.request('session', 'launch', '--card', '4', '--repo', repo, '--json'),
      );
      const worktree = launched.worktree;

      await s.request('session', 'stop', launched.id, '--json');
      // yours for the repo, as its worktree reads it from the main checkout
      const effort = async () =>
        ok(
          z.object({ value: z.unknown() }),
          await s.requestIn(worktree, 'settings', 'get', 'effort', '--json'),
        ).value;

      expect(await effort()).toBe('high');
      expect(await moves()).toEqual([]);

      // renamed while serve runs: its worktree no longer reads as git
      const moved = `${repo}-moved`;

      renameSync(repo, moved);
      expect(gitIn(worktree, 'status').exitCode).not.toBe(0);
      // serve's settings look before anything comes from the new folder: the files are gone
      s.serve.pollSettings();
      const view = ok(InstallView, await s.requestIn(moved, 'install', 'status', '--json'));

      expect(view.repo).toBe(moved);
      expect(view.done).toBe(true);
      expect(await moves()).toMatchObject([
        {
          from: repo,
          to: moved,
          seenAt: moved,
          install: true,
          sessions: 1,
          worktrees: [worktree],
          problems: [],
        },
      ]);
      expect(gitIn(worktree, 'status').exitCode).toBe(0);
      expect(await effort()).toBe('high');
      expect(
        gitIn(worktree, 'config', '--worktree', 'core.hooksPath').stdout.toString(),
      ).toStartWith(`${moved}/.git/`);
      const [session] = ok(
        SessionListData,
        await s.requestIn(moved, 'session', 'list', '--json'),
      ).sessions;

      expect(session).toMatchObject({ id: launched.id, repo: moved, worktree });
      // local mode follows: its writes stay held
      expect(readFileSync(join(w.mine, 'settings.yaml'), 'utf8')).toContain(moved);
      const local = z
        .object({ checkout: z.string().nullable() })
        .parse(
          z
            .object({ data: z.unknown() })
            .parse(JSON.parse((await s.requestIn(moved, 'local', 'status', '--json')).stdout)).data,
        );

      expect(local.checkout).toBe(moved);

      // a copy beside it is another repo: an id of its own, nothing followed
      const copy = `${repo}-copy`;

      cpSync(moved, copy, { recursive: true });
      ok(InstallView, await s.requestIn(moved, 'install', 'status', '--json'));
      await s.requestIn(copy, 'install', 'status', '--json');
      expect(readFileSync(join(copy, REPO_ID_PATH), 'utf8')).not.toBe(
        readFileSync(join(moved, REPO_ID_PATH), 'utf8'),
      );
      expect(await moves()).toHaveLength(1);

      // moved far off: its worktree says where it was, and that the repo is not found
      const far = join(w.root, 'elsewhere');

      mkdirSync(far);
      renameSync(moved, join(far, 'demo'));
      await s.requestIn(worktree, 'session', 'list', '--json');
      await until('the worktree says so', async () =>
        (await moves()).length === 2 ? true : undefined,
      );
      expect((await moves())[1]).toMatchObject({ from: moved, to: null, seenAt: worktree });
    },
  );
});
