/**
 * A local session's database (#146, #349) as `localApps` decides it, over a fake `SessionApps` and
 * a fake Mac database: serve's own `DATABASE_URL` is never handed on; the repo's hook gives the
 * session its own, else a repo whose pack names `DATABASE_URL` gets its own in the Mac database,
 * dropped at the end; every pack script gets its port base.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionApps, SessionMeta } from '@abe/core';
import { fakeCompose, fakeDbUrl, fakeMacDatabase, LOCAL_DOCKER } from '@abe/testing';
import { openDatabases } from './databases';
import { localApps } from './local-apps';
import { openPortBases } from './port-bases';

type Call = Parameters<SessionApps['run']>[0];

const fakeApps = () => {
  const calls: Call[] = [];
  const apps: SessionApps = {
    run: (c) => {
      calls.push(c);

      return Promise.resolve({
        exit: 0,
        stdout: c.args[0] === 'start' ? 'postgres://abe:pw@127.0.0.1:55432/own\n' : '',
        stderr: '',
      });
    },
    end: () => Promise.resolve([]),
  };

  return { apps, calls };
};

describe("a local session's database", () => {
  let root: string;
  let repo: string;
  let meta: SessionMeta;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-la-'));
    repo = join(root, 'demo');
    mkdirSync(join(repo, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'), '#!/bin/sh\n');
    const at = new Date(0).toISOString();

    meta = SessionMeta.parse({
      v: 1,
      id: '4-ab12',
      card: 4,
      title: 'Cart total',
      repo,
      worktree: join(root, 'demo-wt', '4-cart'),
      branch: 'card/4-cart',
      state: 'working',
      since: at,
      startedAt: at,
      transcriptPath: null,
      lastAssistantMessage: null,
      claudeSession: 'c',
      socket: join(root, 's.sock'),
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("serve's own is never the session's: the hook gives it its own (#349)", async () => {
    const { apps, calls } = fakeApps();
    const local = localApps({
      apps,
      env: { PATH: '/bin', DATABASE_URL: 'postgres://serve/db' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
    });

    expect(await local.database({ id: meta.id, repo })).toEqual({
      ok: true,
      data: 'postgres://abe:pw@127.0.0.1:55432/own',
    });
    await local.run(meta, 'start', []);
    expect(calls.map((c) => [c.script, c.env.DATABASE_URL])).toEqual([
      ['.claude/skills/run-app/scripts/db', undefined],
      ['.claude/skills/run-app/scripts/start', 'postgres://abe:pw@127.0.0.1:55432/own'],
    ]);
  });

  test('none in serve: the hook gives it its own once, and stops it at the end', async () => {
    const { apps, calls } = fakeApps();
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
    });

    await local.run(meta, 'start', []);
    await local.run(meta, 'seed', []);
    expect(local.leftBehind()).toEqual([meta.id]);
    await local.end(meta);
    expect(calls.map((c) => [c.script, c.args[0], c.env.DATABASE_URL])).toEqual([
      ['.claude/skills/run-app/scripts/db', 'start', undefined],
      ['.claude/skills/run-app/scripts/start', undefined, 'postgres://abe:pw@127.0.0.1:55432/own'],
      ['.claude/skills/run-app/scripts/seed', undefined, 'postgres://abe:pw@127.0.0.1:55432/own'],
      ['.claude/skills/run-app/scripts/db', 'stop', undefined],
    ]);
    expect(local.leftBehind()).toEqual([]);
  });

  test('no hook and a pack that names DATABASE_URL: its own Mac database and port base, dropped at the end (#349)', async () => {
    const { apps, calls } = fakeApps();
    const mac = fakeMacDatabase();

    rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'));
    mkdirSync(join(repo, '.claude', 'skills', 'verify-demo'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'skills', 'verify-demo', 'SKILL.md'),
      'Everything needs `$DATABASE_URL`.\n',
    );
    const local = localApps({
      apps,
      env: { PATH: '/bin', DATABASE_URL: 'postgres://serve/db' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac }),
      ports: openPortBases(() => true),
    });

    await local.run(meta, 'start', []);
    await local.run(meta, 'seed', []);
    expect(local.leftBehind()).toEqual([meta.id]);
    expect(calls.map((c) => [c.script, c.env.DATABASE_URL, c.env.ABE_PORT_BASE])).toEqual([
      ['.claude/skills/run-app/scripts/start', fakeDbUrl('abe_4_ab12'), '41000'],
      ['.claude/skills/run-app/scripts/seed', fakeDbUrl('abe_4_ab12'), '41000'],
    ]);
    await local.end(meta);
    expect(mac.calls).toEqual(['ensure abe_4_ab12', 'drop abe_4_ab12']);
    expect(local.leftBehind()).toEqual([]);
  });

  test("Docker down: refused in words with the fix, never serve's DATABASE_URL instead (#349)", async () => {
    const { apps } = fakeApps();

    rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'));
    mkdirSync(join(repo, '.claude', 'skills', 'verify-demo'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'skills', 'verify-demo', 'SKILL.md'),
      'Everything needs `$DATABASE_URL`.\n',
    );
    const local = localApps({
      apps,
      env: { PATH: '/bin', DATABASE_URL: 'postgres://serve/db' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase('down') }),
    });
    const db = await local.database({ id: meta.id, repo });

    expect(db.ok ? '' : db.error.code).toBe('no-docker');
    expect(db.ok ? '' : db.error.message).toStartWith(
      "demo needs a database and Docker isn't running.\nStart Docker (Docker Desktop, OrbStack or colima)",
    );
  });

  test('the Mac database failing otherwise refuses the session (no-database), never runs it without (#349)', async () => {
    const { apps } = fakeApps();
    const mac = fakeMacDatabase();

    mac.broken = 'docker run failed: no space left on device';
    rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'));
    mkdirSync(join(repo, '.claude', 'skills', 'verify-demo'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'skills', 'verify-demo', 'SKILL.md'),
      'Everything needs `$DATABASE_URL`.\n',
    );
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac }),
    });
    const db = await local.database({ id: meta.id, repo });

    expect(db.ok ? '' : db.error.code).toBe('no-database');
    expect(db.ok ? '' : db.error.message).toContain('no space left on device');
  });

  test('Docker down at the end: its database kept to drop, dropped once Docker is back (#349)', async () => {
    const { apps } = fakeApps();
    const mac = fakeMacDatabase();

    rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'));
    mkdirSync(join(repo, '.claude', 'skills', 'verify-demo'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'skills', 'verify-demo', 'SKILL.md'),
      'Everything needs `$DATABASE_URL`.\n',
    );
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac }),
    });

    await local.run(meta, 'start', []);
    mac.at = 'down';
    expect(await local.end(meta)).toEqual([
      "database abe_4_ab12 not dropped: Docker isn't running",
    ]);
    expect(local.leftBehind()).toEqual([meta.id]);
    expect(mac.dbs.has('abe_4_ab12')).toBe(true);
    mac.at = 'up';
    expect(await local.end(meta)).toEqual(['database abe_4_ab12 dropped']);
    expect(local.leftBehind()).toEqual([]);
    expect(mac.dbs.size).toBe(0);
  });

  test('its port base kept on disk: a serve started again hands the same one on, its hook too (#349)', async () => {
    const { apps, calls } = fakeApps();
    const first = openPortBases(() => true);

    first.take('another prototype');
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      ports: first,
    });

    await local.run(meta, 'start', []);
    const again = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      ports: openPortBases(() => true),
    });

    await again.run(meta, 'start', []);
    expect(calls.map((c) => [c.script, c.args[0], c.env.ABE_PORT_BASE])).toEqual([
      ['.claude/skills/run-app/scripts/db', 'start', '41010'],
      ['.claude/skills/run-app/scripts/start', undefined, '41010'],
      ['.claude/skills/run-app/scripts/db', 'start', '41010'],
      ['.claude/skills/run-app/scripts/start', undefined, '41010'],
    ]);
  });

  test('a repo that needs no database gets none, and no Docker is asked', async () => {
    const { apps } = fakeApps();
    const mac = fakeMacDatabase();

    rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'));
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac }),
    });

    expect(await local.database({ id: meta.id, repo })).toEqual({ ok: true, data: undefined });
    expect(mac.calls).toEqual([]);
  });
});

describe("a pack script gets the person's credentials (ADR 0028), Abe's own over them", () => {
  let root: string;
  let repo: string;
  let meta: SessionMeta;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-lc-'));
    repo = join(root, 'demo');
    mkdirSync(join(repo, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'start'), '#!/bin/sh\n');
    const at = new Date(0).toISOString();

    meta = SessionMeta.parse({
      v: 1,
      id: '5-cd34',
      card: 5,
      title: 'Cart',
      repo,
      worktree: repo,
      branch: 'card/5-cart',
      state: 'working',
      since: at,
      startedAt: at,
      transcriptPath: null,
      lastAssistantMessage: null,
      claudeSession: 'c',
      socket: join(root, 's.sock'),
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('what it prints of a value it was given comes back redacted, by its key', async () => {
    const apps: SessionApps = {
      run: (c) =>
        Promise.resolve({ exit: 0, stdout: `listening, key ${c.env.API_KEY ?? ''}\n`, stderr: '' }),
      end: () => Promise.resolve([]),
    };
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      injected: () => Promise.resolve({ ok: true, data: { API_KEY: 'fake-key-2718' } }),
    });
    const ran = await local.run(meta, 'start', []);

    expect(ran.ok ? ran.data.stdout : '').toBe('listening, key [redacted:API_KEY]\n');
  });

  // `abe run --env <env>` (ADR 0028): that environment's set alone, and every
  // Abe env file's value redacted, whichever environment it ran in
  test.each<[string, string | undefined, string]>([
    ['none: dev', undefined, 'env=dev key=[redacted:API_KEY] prod=[redacted:PROD_TOKEN]'],
    ['test', 'test', 'env=test key=[redacted:API_KEY] prod=[redacted:PROD_TOKEN]'],
  ])('run --env: %s', async (_, envName, want) => {
    const asked: string[] = [];
    const apps: SessionApps = {
      run: (c) =>
        Promise.resolve({
          exit: 0,
          stdout: `env=${c.env.APP_ENV ?? ''} key=${c.env.API_KEY ?? ''} prod=fake-prod-token-7\n`,
          stderr: '',
        }),
      end: () => Promise.resolve([]),
    };
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      injected: (_repo, env) => {
        asked.push(env);

        return Promise.resolve({ ok: true, data: { APP_ENV: env, API_KEY: `fake-key-${env}-1` } });
      },
      redacted: () => Promise.resolve([{ kind: 'PROD_TOKEN', value: 'fake-prod-token-7' }]),
    });
    const ran = await local.run(meta, 'start', [], envName);

    expect([ran.ok ? ran.data.stdout.trim() : ran.error.code, asked]).toEqual([
      want,
      [envName ?? 'dev'],
    ]);
  });

  // `abe run --env <env>` from a session (ADR 0029): only in an environment on for agents; one
  // that is off refused before its values or aws keys are read
  test.each<[string, string | undefined, readonly ('dev' | 'test' | 'prod')[] | undefined, string]>(
    [
      ['prod, off by default', 'prod', undefined, 'env-off'],
      ['prod, on', 'prod', ['dev', 'test', 'prod'], 'ran'],
      ['test, off', 'test', ['dev'], 'env-off'],
      ['dev, on', undefined, ['dev'], 'ran'],
    ],
  )('run --env: %s', async (_, envName, enabled, want) => {
    const asked: string[] = [];
    const { apps, calls } = fakeApps();
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      ports: openPortBases(() => true),
      injected: (_repo, env) => {
        asked.push(env);

        return Promise.resolve({ ok: true, data: {} });
      },
      ...(enabled === undefined ? {} : { agentEnvs: () => enabled }),
    });
    const ran = await local.run(meta, 'start', [], envName);

    expect([ran.ok ? 'ran' : ran.error.code, calls.length, asked.length]).toEqual(
      want === 'ran' ? ['ran', 1, 1] : [want, 0, 0],
    );
    if (!ran.ok)
      expect(ran.error.message).toStartWith(
        `${envName ?? 'dev'} isn't enabled for agents in this repo`,
      );
  });

  test.each<
    [
      string,
      Awaited<ReturnType<NonNullable<Parameters<typeof localApps>[0]['injected']>>>,
      Record<string, string> | string,
    ]
  >([
    [
      'the Abe env file and the profile: in its environment',
      { ok: true, data: { API_KEY: 'fake-1', AWS_ACCESS_KEY_ID: 'fake-id' } },
      { API_KEY: 'fake-1', AWS_ACCESS_KEY_ID: 'fake-id' },
    ],
    [
      "a key Abe hands it too: Abe's",
      { ok: true, data: { ABE_PORT_BASE: '1', API_KEY: 'fake-1' } },
      { API_KEY: 'fake-1' },
    ],
    [
      'an expired aws login: not started, its sign-in named',
      {
        ok: false,
        error: {
          code: 'aws-login-expired',
          message:
            'shop-dev gave no credentials (its login expired?): abe login aws --profile shop-dev',
        },
      },
      'aws-login-expired',
    ],
  ])('%s', async (_, injected, want) => {
    const { apps, calls } = fakeApps();
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      ports: openPortBases(() => true),
      injected: () => Promise.resolve(injected),
    });
    const ran = await local.run(meta, 'start', []);

    if (typeof want === 'string') {
      expect([ran.ok ? '' : ran.error.code, calls]).toEqual([want, []]);

      return;
    }
    const env = calls[0]?.env ?? {};

    expect(Object.fromEntries(Object.keys(want).map((k) => [k, env[k]]))).toEqual(want);
    expect(env.ABE_PORT_BASE).not.toBe('1');
  });
});

// Compose runs locally only, in each card's own project, down when the card's session ends; one
// runner per session at a time.
describe("a local session's compose and runner", () => {
  let root: string;
  const metaOf = (card: number) => {
    const at = new Date(0).toISOString();

    return SessionMeta.parse({
      v: 1,
      id: `${card}-ab12`,
      card,
      title: 'Cart total',
      repo: join(root, 'demo'),
      worktree: join(root, 'demo-wt', `${card}-cart`),
      branch: `card/${card}-cart`,
      state: 'working',
      since: at,
      startedAt: at,
      transcriptPath: null,
      lastAssistantMessage: null,
      claudeSession: 'c',
      socket: join(root, 's.sock'),
    });
  };
  const worktree = (meta: SessionMeta, dotEnv?: string) => {
    mkdirSync(join(meta.worktree, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
    writeFileSync(
      join(meta.worktree, '.claude', 'skills', 'run-app', 'scripts', 'start'),
      'docker compose up -d\n',
    );
    writeFileSync(join(meta.worktree, 'compose.yaml'), 'services:\n  db:\n    image: postgres\n');
    if (dotEnv !== undefined) writeFileSync(join(meta.worktree, '.env'), dotEnv);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-lc-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test.each([
    {
      name: 'a local socket: its own project',
      context: LOCAL_DOCKER,
      dotEnv: undefined,
      refused: '',
    },
    {
      name: 'a remote DOCKER_HOST in the .env beside the compose file: refused, nothing run',
      context: LOCAL_DOCKER,
      dotEnv: 'DOCKER_HOST=tcp://10.0.0.5:2376\n',
      refused: 'DOCKER_HOST is tcp://10.0.0.5:2376, not a local socket',
    },
    {
      name: 'a remote docker context: refused, nothing run',
      context: { name: 'far', host: 'ssh://deploy@10.0.0.5' },
      dotEnv: undefined,
      refused: 'the docker context far reaches ssh://10.0.0.5, not a local socket',
    },
  ])('compose locally only: $name', async (row) => {
    const { apps, calls } = fakeApps();
    const compose = fakeCompose(row.context);
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      compose,
    });
    const [a, b] = [metaOf(4), metaOf(5)];

    worktree(a, row.dotEnv);
    worktree(b, row.dotEnv);
    const ran = [await local.run(a, 'start', []), await local.run(b, 'start', [])];

    if (row.refused !== '') {
      expect(
        ran.map((r) => (r.ok ? '' : `${r.error.code} ${r.error.message.includes(row.refused)}`)),
      ).toEqual(['compose-not-local true', 'compose-not-local true']);
      expect(calls).toEqual([]);

      return;
    }
    // two cards side by side, each in its own project; each down when its session ends
    expect(calls.map((c) => c.env.COMPOSE_PROJECT_NAME)).toEqual(['abe-demo-4', 'abe-demo-5']);
    await local.end(a);
    expect(compose.downs.map((d) => d.project)).toEqual(['abe-demo-4']);
    expect(local.leftBehind()).toEqual([b.id]);
    await local.end(b);
    expect(compose.downs.map((d) => d.project)).toEqual(['abe-demo-4', 'abe-demo-5']);
  });

  test('a fixed published host port: run all the same, warned by file and line', async () => {
    const { apps } = fakeApps();
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      compose: fakeCompose(),
    });
    const meta = metaOf(4);

    worktree(meta);
    writeFileSync(
      join(meta.worktree, 'compose.yaml'),
      'services:\n  db:\n    ports:\n      - "5432:5432"\n      - "${API_PORT}:80"\n',
    );
    const ran = await local.run(meta, 'start', []);

    // the one written as a number, not the one from a variable
    expect(ran.ok ? ran.data.warning : ran.error.code).toStartWith(
      'compose publishes fixed host ports (compose.yaml:4 5432:5432):',
    );
  });

  test('one runner per session: a second abe run while one runs is refused; stop still runs', async () => {
    const calls: string[] = [];
    const drive = Promise.withResolvers<null>();
    const ok = { exit: 0, stdout: '', stderr: '' };
    const apps: SessionApps = {
      run: (c) => {
        calls.push(c.script);

        return c.script === '.claude/skills/run-app/scripts/drive'
          ? drive.promise.then(() => ok)
          : Promise.resolve(ok);
      },
      end: () => Promise.resolve([]),
    };
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
    });
    const meta = metaOf(4);
    const first = local.run(meta, 'drive', []);
    const second = await local.run(meta, 'start', []);
    const stop = await local.run(meta, 'stop', []);

    drive.resolve(null);
    expect([second.ok ? '' : second.error.code, stop.ok, (await first).ok]).toEqual([
      'one-runner',
      true,
      true,
    ]);
    expect(calls.toSorted()).toEqual([
      '.claude/skills/run-app/scripts/drive',
      '.claude/skills/run-app/scripts/stop',
    ]);
    expect((await local.run(meta, 'start', [])).ok).toBe(true);
  });
  test("a prototype takes the fixed ports: the session's app stopped, started again as it ran once they are handed back", async () => {
    const calls: string[] = [];
    const apps: SessionApps = {
      run: (c) => {
        calls.push(`${c.script.split('/').at(-1) ?? ''} ${c.args.join(' ')}`.trim());

        return Promise.resolve({ exit: 0, stdout: 'http://localhost:4000\n', stderr: '' });
      },
      end: () => Promise.resolve([]),
    };
    const sessions = new Map<string, SessionMeta>();
    const local = localApps({
      apps,
      env: { PATH: '/bin' },
      stateDir: join(root, 'state'),
      databases: openDatabases({ mac: fakeMacDatabase() }),
      fixedPorts: () => Promise.resolve([4000]),
      metaOf: (id) => sessions.get(id),
    });
    // the main checkout's app, started by the Abe chat's abe run start
    const chat = { ...metaOf(4), id: 'hub-1', card: null };
    const card = metaOf(5);
    const repo = chat.repo;

    sessions.set(chat.id, chat);
    sessions.set(card.id, card);
    expect((await local.run(chat, 'start', ['--watch'])).ok).toBe(true);
    const held = await local.run(card, 'start', []);

    expect(held.ok ? '' : held.error.message).toContain('held by session hub-1');
    // the prototype's: the chat's app stopped by its stop, the ports the prototype's
    const took = await local.takePorts(repo, 'proto-1a2b3c');

    expect(took).toEqual({
      ok: true,
      data: "stopped session hub-1's app (the main checkout) for prototype proto-1a2b3c",
    });
    const meanwhile = await local.run(chat, 'start', []);

    expect(meanwhile.ok ? '' : meanwhile.error.message).toContain('held by prototype proto-1a2b3c');
    // another prototype takes them over: nothing more is stopped; only the last one hands back
    expect(await local.takePorts(repo, 'proto-4d5e6f')).toEqual({ ok: true, data: null });
    expect(await local.givePorts(repo, 'proto-1a2b3c')).toBeNull();
    expect(await local.givePorts(repo, 'proto-4d5e6f')).toBe("started session hub-1's app again");
    expect(calls).toEqual(['start --watch', 'stop', 'start --watch']);
    // its own again: a card's start waits on it
    const after = await local.run(card, 'start', []);

    expect(after.ok ? '' : after.error.message).toContain('held by session hub-1');
    // a session ended meanwhile is not started again
    await local.takePorts(repo, 'proto-1a2b3c');
    sessions.set(chat.id, { ...chat, state: 'ended' });
    expect(await local.givePorts(repo, 'proto-1a2b3c')).toBeNull();
    expect(calls).toEqual(['start --watch', 'stop', 'start --watch', 'stop']);
  });
});
