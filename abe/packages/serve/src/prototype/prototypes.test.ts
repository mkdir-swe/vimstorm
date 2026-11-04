/**
 * A prototype's app as a prototype session's starts it (`launch`, `halt`, `dropDatabase`): the real
 * prototype apps and proxy, a small Bun shop in a temporary git repo started by its run-app start
 * script, its database (#349) and the run-app copy of a checkout whose scripts are not committed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { journal, PORT_RANGE, PORT_SPAN } from '@abe/core';
import { localPrototypeApps, localPrototypeProxy, systemClock } from '@abe/ports';
import {
  FAILING_START,
  fakeDbUrl,
  fakeMacDatabase,
  type FakeMacDatabase,
  git,
  prototypeRepo,
  repoState,
  shopPrototypeStart,
  until,
} from '@abe/testing';
import { openDatabases } from '../local-mode/databases';
import { openPortBases } from '../local-mode/port-bases';
import {
  dropDatabase,
  fresh,
  halt,
  launch,
  newMeta,
  openPrototypes,
  type Prototypes,
  restartPrototype,
  RUNNING,
} from './prototypes';

const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;

describe("a prototype's database (#349)", () => {
  const VERIFY = '# Verification pack\n\nEverything needs `$DATABASE_URL`.\n';
  // its Verification pack's skill (#64), the file that says it needs a database
  const VERIFY_SKILL = '.claude/skills/verify-shop/SKILL.md';
  let root: string;
  let p: Prototypes | undefined;
  let mac: FakeMacDatabase;
  const open = (): Prototypes => p ?? expect.unreachable();
  const seedLog = () => join(root, 'seed.log');
  const seed = () => `#!/bin/sh\necho "seed $DATABASE_URL" >>"${seedLog()}"\n`;
  const shop = (name: string, files: Record<string, string>) => {
    const repo = join(root, name);

    prototypeRepo(repo, { files });

    return repo;
  };
  const started = async (repo: string, card: number) => {
    const head = await open().apps.head(repo);

    if (!head.ok) throw new Error(head.error.message);
    const meta = await newMeta(open(), head.data, card);

    return { meta, answer: await launch(open(), meta, 'start') };
  };
  const envOf = (id: string) =>
    Object.fromEntries(
      readFileSync(join(root, 'state', id, 'app', '.scratch', 'run', 'start.env'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  const metaOf = async (id: string) => (await fresh(open(), id)) ?? expect.unreachable();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-pdb-'));
  });
  afterAll(async () => {
    await p?.close();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await p?.close();
    mac = fakeMacDatabase();
    const dir = join(root, 'state');

    p = openPrototypes({
      dir,
      apps: localPrototypeApps({
        dir,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          DATABASE_URL: 'postgres://serve',
        },
      }),
      proxy: localPrototypeProxy(),
      clock: systemClock,
      emit: journal(systemClock).emit,
      databases: openDatabases({ mac }),
      ports: openPortBases(),
    });
  });

  test('database, then the seed on a new one, then the start with DATABASE_URL and ABE_PORT_BASE; stop keeps it', async () => {
    const repo = shop('shop-a', {
      [VERIFY_SKILL]: VERIFY,
      '.claude/skills/run-app/scripts/seed': seed(),
    });
    const { meta, answer } = await started(repo, 1);
    const name = `abe_${meta.id.replace('-', '_')}`;

    expect(answer.ok ? answer.data.state : answer.error.message).toBe('live');
    expect(answer.ok && answer.data.database).toEqual({ name, by: 'mac', seeded: true });
    const env = envOf(meta.id);

    expect(env.DATABASE_URL).toBe(fakeDbUrl(name));
    expect(Number(env.ABE_PORT_BASE)).toBeGreaterThanOrEqual(PORT_RANGE.first);
    expect(readFileSync(seedLog(), 'utf8')).toBe(`seed ${fakeDbUrl(name)}\n`);

    // stop keeps it; the next start finds it and seeds nothing
    await halt(open(), await metaOf(meta.id), 'stop');
    expect(mac.dbs.has(name)).toBe(true);
    const again = await launch(open(), await metaOf(meta.id), 'retry');

    expect(again.ok && again.data.state).toBe('live');
    expect(
      readFileSync(seedLog(), 'utf8')
        .split('\n')
        .filter((l) => l !== ''),
    ).toHaveLength(1);
    expect(mac.calls).toEqual([`ensure ${name}`, `ensure ${name}`]);

    // discarded (or done with) while Docker is down: kept, to drop later
    await halt(open(), await metaOf(meta.id), 'stop');
    mac.at = 'down';
    expect(await dropDatabase(open(), await metaOf(meta.id))).toBe(
      `database ${name} not dropped: Docker isn't running`,
    );
    expect((await metaOf(meta.id)).database).toEqual({ name, by: 'mac', seeded: true });
    mac.at = 'up';
    // then dropped
    await dropDatabase(open(), await metaOf(meta.id));
    expect(mac.dbs.has(name)).toBe(false);
    expect((await metaOf(meta.id)).database).toBeNull();
    rmSync(seedLog(), { force: true });
  }, 30_000);

  test('two prototypes at once: two databases, two port bases, both live', async () => {
    const repo = shop('shop-b', { [VERIFY_SKILL]: VERIFY });
    const [a, b] = await Promise.all([started(repo, 1), started(repo, 2)]);

    expect([a.answer.ok && a.answer.data.state, b.answer.ok && b.answer.data.state]).toEqual([
      'live',
      'live',
    ]);
    const [ea, eb] = [envOf(a.meta.id), envOf(b.meta.id)];

    expect(ea.DATABASE_URL).not.toBe(eb.DATABASE_URL);
    expect(Math.abs(Number(ea.ABE_PORT_BASE) - Number(eb.ABE_PORT_BASE))).toBeGreaterThanOrEqual(
      PORT_SPAN,
    );
    expect(mac.dbs.size).toBe(2);
  }, 30_000);

  test('Docker down: the words with the fix, no worktree left; Docker up, Retry: live, the reason gone', async () => {
    const repo = shop('shop-c', { [VERIFY_SKILL]: VERIFY });

    mac.at = 'down';
    const { meta, answer } = await started(repo, 1);

    expect(answer.ok ? '' : answer.error.message).toBe(
      "shop-c needs a database and Docker isn't running.\nStart Docker (Docker Desktop, OrbStack or colima)",
    );
    const failed = await metaOf(meta.id);

    expect([failed.state, failed.reason]).toEqual([
      'failed',
      answer.ok ? '' : answer.error.message,
    ]);
    expect(existsSync(join(root, 'state', meta.id, 'app'))).toBe(false);
    mac.at = 'up';
    const retried = await launch(open(), failed, 'retry');

    expect(retried.ok && [retried.data.state, retried.data.reason]).toEqual(['live', null]);
  }, 30_000);

  test("the repo's own hook wins; when it fails, its words; serve's DATABASE_URL never", async () => {
    const hook = shop('shop-d', {
      [VERIFY_SKILL]: VERIFY,
      '.claude/skills/run-app/scripts/db':
        '#!/bin/sh\necho "postgres://own@127.0.0.1:6543/$ABE_DB_NAME"\n',
    });
    const ok = await started(hook, 1);

    expect(envOf(ok.meta.id).DATABASE_URL).toBe(
      `postgres://own@127.0.0.1:6543/abe-db-${ok.meta.id}`,
    );
    expect(ok.answer.ok && ok.answer.data.database?.by).toBe('hook');
    const broken = shop('shop-e', {
      '.claude/skills/run-app/scripts/db':
        '#!/bin/sh\necho starting\necho "role shop does not exist" >&2\nexit 1\n',
    });
    const bad = await started(broken, 2);

    expect(bad.answer.ok ? '' : bad.answer.error.message).toBe(
      'The repo\'s database hook failed: .claude/skills/run-app/scripts/db start exited 1 (last line: "role shop does not exist").\nFix the hook',
    );
    // a repo that needs none: no database, not serve's either
    const plain = await started(shop('shop-f', {}), 3);

    expect(envOf(plain.meta.id).DATABASE_URL).toBe('');
    expect(mac.calls).toEqual([]);
  }, 30_000);

  test("a developer's prototype done with: its hook's stop in its worktree while there, else the repo's; kept when the hook is gone", async () => {
    const said = join(root, 'hook.log');
    const hookOf = (where: string) =>
      `#!/bin/sh\nif [ "$1" = stop ]; then echo "${where} stop $ABE_DB_NAME $ABE_PORT_BASE" >>"${said}"; exit 0; fi\necho "postgres://own@127.0.0.1:6543/$ABE_DB_NAME"\n`;
    const repo = shop('shop-g', { '.claude/skills/run-app/scripts/db': hookOf('repo') });
    const { meta } = await started(repo, 1);
    const wt = join(root, 'shop-g-wt');

    mkdirSync(join(wt, '.claude', 'skills', 'run-app', 'scripts'), { recursive: true });
    writeFileSync(join(wt, '.claude', 'skills', 'run-app', 'scripts', 'db'), hookOf('worktree'), {
      mode: 0o755,
    });
    const code = {
      session: 's',
      branch: 'proto/1',
      worktree: wt,
      box: null,
      spec: null,
      stored: null,
      commented: false,
      sent: null,
      made: null,
      ended: true,
    };
    const live = await metaOf(meta.id);
    const base = live.portBase;

    await open().local.write({ ...live, code });
    expect(await dropDatabase(open(), await metaOf(meta.id))).toBe(
      '.claude/skills/run-app/scripts/db stop: exit 0',
    );
    expect(readFileSync(said, 'utf8')).toBe(`worktree stop abe-db-${meta.id} ${base ?? ''}\n`);
    expect((await metaOf(meta.id)).database).toBeNull();

    // its worktree gone: the repo's hook
    rmSync(wt, { recursive: true });
    await open().local.write({ ...(await metaOf(meta.id)), database: live.database });
    await dropDatabase(open(), await metaOf(meta.id));
    expect(readFileSync(said, 'utf8').split('\n').at(-2)).toBe(
      `repo stop abe-db-${meta.id} ${base ?? ''}`,
    );

    // no hook anywhere any more: kept, to stop by a checkout that has it
    rmSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'db'));
    await open().local.write({ ...(await metaOf(meta.id)), database: live.database });
    expect(await dropDatabase(open(), await metaOf(meta.id))).toBe(
      `.claude/skills/run-app/scripts/db stop: no .claude/skills/run-app/scripts/db in ${(await metaOf(meta.id)).repo}`,
    );
    expect((await metaOf(meta.id)).database).toEqual(live.database);
  }, 30_000);
});

describe("a checkout whose run-app scripts are not committed yet (the install's change)", () => {
  let root: string;
  const opened: Prototypes[] = [];
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(['git', '-C', cwd, ...args])
      .stdout.toString()
      .trim();
  /** The shop with `.claude/` untracked: the checkout has it, no commit. */
  const untracked = (name: string) => {
    const repo = join(root, name);

    prototypeRepo(repo);
    git(repo, 'rm', '-r', '-q', '--cached', '.claude');
    git(repo, 'commit', '-q', '-m', 'skills not committed yet');

    return repo;
  };
  const asked: string[] = [];
  const prototypes = (copies?: string[], over: string[] = [], printedGraceMs?: number) => {
    const dir = join(root, 'state');
    const p = openPrototypes({
      dir,
      apps: localPrototypeApps({
        dir,
        env: { PATH },
        ...(printedGraceMs === undefined ? {} : { printedGraceMs }),
      }),
      proxy: localPrototypeProxy(),
      clock: systemClock,
      emit: journal(systemClock).emit,
      ports: openPortBases(),
      appValues: (_, env) => {
        asked.push(env);

        return Promise.resolve({ ok: true, data: { SHOP_DEMO_USER: 'demo@shop.test' } });
      },
      ...(copies === undefined
        ? {}
        : {
            worktreeCopies: () =>
              Promise.resolve([
                ...copies.map((path) => ({ path })),
                ...over.map((path) => ({ path, over: true as const })),
              ]),
          }),
    });

    opened.push(p);

    return p;
  };
  const started = async (p: Prototypes, repo: string) => {
    const head = await p.apps.head(repo);

    if (!head.ok) throw new Error(head.error.message);
    const meta = await newMeta(p, head.data, 1);

    return { meta, answer: await launch(p, meta, 'start') };
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-pex-'));
  });
  afterAll(async () => {
    for (const p of opened) await p.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('without the copy: no start script at the commit (the bug)', async () => {
    const repo = untracked('shop-x');
    const commit = git(repo, 'rev-parse', 'HEAD');
    const { answer } = await started(prototypes(), repo);

    expect(answer.ok ? answer.data.state : answer.error.message).toBe(
      `The repo has no abe/scripts/prototype-start (nor .claude/skills/run-app/scripts/start) at ${commit.slice(0, 7)}: add one that starts the app (the install's Prototype part writes it)`,
    );
  }, 30_000);

  test("the card worktree's copies come in first: the checkout's start script runs, live", async () => {
    const repo = untracked('shop-y');
    const before = repoState(repo);
    const p = prototypes(['.claude']);
    const { meta, answer } = await started(p, repo);

    expect(answer.ok ? answer.data.state : answer.error.message).toBe('live');
    expect(
      existsSync(
        join(root, 'state', meta.id, 'app', '.claude', 'skills', 'run-app', 'scripts', 'stop'),
      ),
    ).toBe(true);
    await halt(p, (await fresh(p, meta.id)) ?? meta, 'stop');
    expect(repoState(repo)).toEqual(before);
  }, 30_000);

  test("abe/scripts/prototype-start not committed yet: the start over the pack's, on its port base, with its env file's values", async () => {
    const repo = untracked('shop-p');

    mkdirSync(join(repo, 'abe', 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'abe', 'scripts', 'prototype-start'), shopPrototypeStart(), {
      mode: 0o755,
    });
    const p = prototypes(['.claude'], ['abe/scripts']);
    const { meta, answer } = await started(p, repo);
    const live = (await fresh(p, meta.id)) ?? expect.unreachable();

    expect([answer.ok ? answer.data.state : answer.error.message, live.app]).toEqual([
      'live',
      `http://127.0.0.1:${String(live.portBase)}`,
    ]);
    expect(asked).toEqual(['dev']);
    expect(
      readFileSync(join(root, 'state', meta.id, 'app', '.scratch', 'run', 'login'), 'utf8'),
    ).toBe('demo@shop.test\n');
    await halt(p, live, 'stop');
  }, 30_000);

  test('a start that prints its URL and goes on (a wait on its server): failed in words, its group killed', async () => {
    const repo = join(root, 'shop-wait');
    const pidFile = join(root, 'wait-sleep.pid');

    prototypeRepo(repo, {
      start: `#!/bin/sh\nsleep 600 &\necho $! >"${pidFile}"\necho "http://127.0.0.1:$ABE_PORT_BASE"\nwait\n`,
    });
    const { answer } = await started(prototypes(undefined, [], 300), repo);

    expect(answer.ok ? answer.data.state : answer.error.message).toStartWith(
      '.claude/skills/run-app/scripts/start must print its URL and exit; it ran ',
    );
    const pid = Number(readFileSync(pidFile, 'utf8'));

    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  test('no database to have: the step moves on to the start while it runs', async () => {
    const repo = join(root, 'shop-nodb');
    const ran = join(root, 'nodb-ran');
    const go = join(root, 'nodb-go');

    prototypeRepo(repo, {
      start: `#!/bin/sh\ntouch "${ran}"\nwhile [ ! -f "${go}" ]; do sleep 0.05; done\nexit 1\n`,
    });
    const p = prototypes();
    const head = await p.apps.head(repo);

    if (!head.ok) throw new Error(head.error.message);
    const meta = await newMeta(p, head.data, 1);
    const launched = launch(p, meta, 'start');

    await until('its start runs', () => (existsSync(ran) ? true : undefined));
    expect((await fresh(p, meta.id))?.step).toBe('start');
    writeFileSync(go, '');
    expect((await launched).ok).toBe(false);
  }, 30_000);

  test('restart while a start never ends: that start killed, the restart goes on at once', async () => {
    const repo = join(root, 'shop-stuck');
    const once = join(root, 'stuck-once');

    prototypeRepo(repo, {
      start: `#!/bin/sh\nif [ -f "${once}" ]; then echo "http://127.0.0.1:$ABE_PORT_BASE"; exit 0; fi\ntouch "${once}"\nexec sleep 600\n`,
    });
    const p = prototypes();
    const head = await p.apps.head(repo);

    if (!head.ok) throw new Error(head.error.message);
    const meta = await newMeta(p, head.data, 1);
    const first = p.serial(meta.id, () => launch(p, meta, 'start'));

    await until('the first start runs', () => (existsSync(once) ? true : undefined));
    const again = await restartPrototype(p, meta.id, async (m) =>
      launch(p, RUNNING.includes(m.state) ? await halt(p, m, 'restart') : m, 'restart'),
    );

    expect((await first).ok).toBe(false);
    expect(again.ok ? again.data.state : again.error.message).toBe('live');
    await halt(p, (await fresh(p, meta.id)) ?? meta, 'stop');
  }, 20_000);

  test("committed: the commit's, never the checkout's edits over it", async () => {
    const repo = join(root, 'shop-z');

    prototypeRepo(repo);
    writeFileSync(join(repo, '.claude', 'skills', 'run-app', 'scripts', 'start'), FAILING_START);
    const p = prototypes(['.claude']);
    const { meta, answer } = await started(p, repo);

    expect(answer.ok ? answer.data.state : answer.error.message).toBe('live');
    await halt(p, (await fresh(p, meta.id)) ?? meta, 'stop');
  }, 30_000);
});

describe('a repo whose app takes fixed ports (ADR 0039): the normal start on them, no proxy, one at a time', () => {
  let root: string;
  let repo: string;
  let port: number;
  let p: Prototypes | undefined;
  const hand: string[] = [];
  const open = (): Prototypes => p ?? expect.unreachable();
  const metaOf = async (id: string) => (await fresh(open(), id)) ?? expect.unreachable();
  /** A prototype session's: its own worktree on a proto/ branch. */
  const prototype = async (n: number) => {
    const head = await open().apps.head(repo);

    if (!head.ok) throw new Error(head.error.message);
    const meta = await newMeta(open(), head.data, n);
    const branch = `proto/${String(n)}-vat`;
    const worktree = join(root, 'shop-wt', `proto-${String(n)}-vat`);

    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree);
    const kept = {
      ...meta,
      code: {
        session: `${String(n)}-ab12`,
        branch,
        worktree,
        box: null,
        spec: null,
        stored: null,
        commented: false,
        sent: null,
        made: null,
        ended: false,
      },
    };

    await open().local.write(kept);

    return kept;
  };
  const page = async (url: string) => (await fetch(url)).text();

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-pfx-')));
    repo = join(root, 'shop');
    // a free port taken as the app's fixed one, as an auth redirect fixes :4000
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });

    port = probe.port ?? 0;
    await probe.stop(true);
    const start = `#!/bin/sh
set -eu
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
run="$root/.scratch/run"
mkdir -p "$run"
rm -f "$run/port"
printf 'ABE_PORT_BASE=%s\\n' "\${ABE_PORT_BASE:-}" >"$run/start.env"
nohup bun "$root/server.ts" "$run/port" ${String(port)} </dev/null >"$run/app.log" 2>&1 &
i=0
while [ ! -s "$run/port" ]; do i=$((i + 1)); [ "$i" -gt 100 ] && exit 1; sleep 0.1; done
echo "http://127.0.0.1:${String(port)}/"
`;

    // its prototype-start is not the one a fixed-port repo's prototype runs
    prototypeRepo(repo, { start, files: { 'abe/scripts/prototype-start': FAILING_START } });
    chmodSync(join(repo, 'abe', 'scripts', 'prototype-start'), 0o755);
    const dir = join(root, 'state');

    p = openPrototypes({
      dir,
      apps: localPrototypeApps({ dir, env: { PATH } }),
      proxy: localPrototypeProxy(),
      clock: systemClock,
      emit: journal(systemClock).emit,
      ports: openPortBases(),
      fixedPorts: () => Promise.resolve([port]),
      hand: {
        takePorts: (_, by) => {
          hand.push(`take ${by}`);

          return Promise.resolve({ ok: true, data: null });
        },
        givePorts: (_, by) => {
          hand.push(`give ${by}`);

          return Promise.resolve(null);
        },
      },
      portsFreeMs: 2_000,
    });
  });
  afterAll(async () => {
    await p?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('the start hook on the fixed port, its own URL the preview link; another takes it over, the last hands it back', async () => {
    const a = await prototype(1);
    const live = await launch(open(), a, 'start');
    const url = `http://127.0.0.1:${String(port)}`;

    expect(live.ok && [live.data.state, live.data.url, live.data.app]).toEqual(['live', url, url]);
    expect(await page(url)).toContain('<h1>Shop one</h1>');
    expect((await metaOf(a.id)).ports).toEqual([port]);
    // the backend's own port base still comes with it
    expect(readFileSync(join(a.code.worktree, '.scratch', 'run', 'start.env'), 'utf8')).toMatch(
      /^ABE_PORT_BASE=\d+\n$/,
    );
    // Show another: the first stopped (its worktree kept), the second on the port
    const b = await prototype(2);
    const second = await launch(open(), b, 'start');

    expect(second.ok && second.data.url).toBe(url);
    expect([(await metaOf(a.id)).state, (await metaOf(a.id)).ports]).toEqual(['stopped', []]);
    expect(existsSync(a.code.worktree)).toBe(true);
    expect(hand).toEqual([`take ${a.id}`, `take ${b.id}`]);
    // the last one stopped: the ports back to the app they were taken from
    await halt(open(), await metaOf(b.id), 'stop');
    expect(hand).toEqual([`take ${a.id}`, `take ${b.id}`, `give ${b.id}`]);
    expect((await metaOf(b.id)).state).toBe('stopped');
    // a restart keeps them: nothing handed back between
    hand.length = 0;
    await restartPrototype(open(), b.id, async (m) =>
      launch(open(), await halt(open(), m, 'restart', { handBack: false }), 'restart'),
    );
    expect(hand).toEqual([`take ${b.id}`]);
    await halt(open(), await metaOf(b.id), 'stop');
  }, 60_000);

  test('the port held by an app Abe did not start: refused in words, handed back', async () => {
    const other = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('mine') });

    try {
      hand.length = 0;
      const a = await metaOf((await open().local.all()).find((m) => m.card === 1)?.id ?? '');
      const answer = await launch(open(), a, 'show');

      expect(answer.ok ? '' : answer.error.message).toStartWith(
        `:${String(port)} is in use by an app Abe did not start`,
      );
      expect(hand).toEqual([`take ${a.id}`, `give ${a.id}`]);
      expect((await metaOf(a.id)).state).toBe('failed');
    } finally {
      await other.stop(true);
    }
  }, 30_000);
});
