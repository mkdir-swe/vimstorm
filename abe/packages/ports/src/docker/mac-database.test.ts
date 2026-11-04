/**
 * The Mac database (#349) over a fake Docker (the CLI adapter is `docker.test.ts`'s): the container
 * made once, each database made and dropped idempotently, its URL the same after a restart. A
 * real-Docker run at the end, skipped when Docker or the Postgres image is not on this machine.
 */
import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Container,
  type ContainerSpec,
  type Docker,
  MAC_DB,
  MAC_PG_HBA,
  POSTGRES_IMAGE,
} from '@abe/core';
import { tempState } from '@abe/testing';
import { dockerCli } from './docker';
import { findDocker, macDatabase } from './mac-database';

type Fake = Docker & {
  runs: ContainerSpec[];
  starts: string[];
  hba: string[];
  sql: string[];
  dbs: Set<string>;
  box: Container[];
  removes: string[];
};

const fakeDocker = (
  o: {
    down?: boolean;
    readyAfter?: number;
    /** What `docker start` fails with (once). */
    startFails?: string;
    /** What `docker run` fails with. */
    runFails?: string;
    /** psql's stderr for a database's SQL, exiting 1. */
    sqlFails?: string;
  } = {},
): Fake => {
  const box: Container[] = [];
  const dbs = new Set<string>();
  const runs: ContainerSpec[] = [];
  const starts: string[] = [];
  const hba: string[] = [];
  const sql: string[] = [];
  const removes: string[] = [];
  let startFails = o.startFails;
  let ready = 0;
  const no = () => Promise.reject(new Error('not used'));

  return {
    runs,
    starts,
    hba,
    sql,
    dbs,
    box,
    removes,
    containers: (key, value) => {
      if (o.down === true)
        return Promise.reject(
          new Error(
            'docker ps failed: Cannot connect to the Docker daemon at unix:///home/u/.docker/run/docker.sock. Is the docker daemon running?',
          ),
        );

      return Promise.resolve(box.filter((c) => c.labels[key] === value));
    },
    image: () => Promise.resolve(undefined),
    build: no,
    network: no,
    removeNetwork: no,
    removeVolume: no,
    volumePath: no,
    volumeSizes: no,
    once: no,
    confinement: no,
    run: (spec) => {
      if (o.runFails !== undefined) return Promise.reject(new Error(o.runFails));
      runs.push(spec);
      box.push({ name: spec.name ?? '', state: 'running', labels: spec.labels });

      return Promise.resolve();
    },
    start: (name) => {
      starts.push(name);
      if (startFails !== undefined) {
        const said = startFails;

        startFails = undefined;

        return Promise.reject(new Error(said));
      }
      for (const c of box) if (c.name === name) c.state = 'running';

      return Promise.resolve();
    },
    remove: (name) => {
      removes.push(name);
      box.splice(0, box.length, ...box.filter((c) => c.name !== name));

      return Promise.resolve();
    },
    exec: (_name, argv, stdin) => {
      const answer = (stdout: string) => Promise.resolve({ exit: 0, stdout, stderr: '' });

      if (argv[0] === 'pg_isready') {
        ready += 1;

        return Promise.resolve({
          exit: ready > (o.readyAfter ?? 0) ? 0 : 2,
          stdout: '',
          stderr: '',
        });
      }
      if (argv[0] === 'sh') {
        hba.push(stdin ?? '');

        return answer('');
      }
      const text = stdin ?? '';

      sql.push(text);
      if (o.sqlFails !== undefined && text.includes('CREATE ROLE'))
        return Promise.resolve({ exit: 1, stdout: '', stderr: o.sqlFails });
      const made = /datname = '([a-z0-9_]+)'\) THEN/.exec(text)?.[1];

      if (made !== undefined) {
        const had = dbs.has(made);

        dbs.add(made);

        return answer(had ? 'had\n' : 'new\n');
      }
      const dropped = /DROP DATABASE IF EXISTS ([a-z0-9_]+)/.exec(text)?.[1];

      if (dropped !== undefined) dbs.delete(dropped);

      return answer('');
    },
  };
};

const ports = (...free: number[]) => {
  const left = [...free];

  return () => left.shift() ?? 0;
};

describe('the Mac database (#349)', () => {
  test('the container made once on first need, its access rules written, each database made once', async () => {
    const state = tempState();
    const docker = fakeDocker({ readyAfter: 2 });
    const db = macDatabase({
      dir: join(state.dir, 'mac-db'),
      docker,
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(54123),
    });

    const [a, b] = await Promise.all([
      db.ensure('abe_proto_3fa2c1', 'demo-shop'),
      db.ensure('abe_4_a1b2', 'demo-shop'),
    ]);

    expect(docker.runs.map((r) => [r.name, r.publish, r.labels])).toEqual([
      [
        MAC_DB.container,
        [{ host: '127.0.0.1', port: 54123, target: 5432 }],
        { [MAC_DB.label]: MAC_DB.role, [MAC_DB.portLabel]: '54123' },
      ],
    ]);
    expect(docker.hba).toEqual([MAC_PG_HBA]);
    if (!a.ok || !b.ok) throw new Error('not made');
    expect([a.made, b.made]).toEqual([true, true]);
    expect(a.url).toMatch(
      /^postgresql:\/\/abe_proto_3fa2c1:[0-9a-f]{32}@127\.0\.0\.1:54123\/abe_proto_3fa2c1$/,
    );
    expect(a.url).not.toBe(b.url.replaceAll('abe_4_a1b2', 'abe_proto_3fa2c1'));
    // the role closed to others: the box's rules
    expect(docker.sql[1]).toContain('REVOKE ALL ON DATABASE abe_proto_3fa2c1 FROM PUBLIC;');
    expect(statSync(join(state.dir, 'mac-db', 'secret')).mode & 0o777).toBe(0o600);

    // again: had, the same URL, no new container
    const again = await db.ensure('abe_proto_3fa2c1', 'demo-shop');

    expect(again).toEqual({ ok: true, url: a.url, made: false });
    expect(docker.runs.length).toBe(1);

    // a serve started again: the same URL from the kept secret and the container's port label
    const later = macDatabase({
      dir: join(state.dir, 'mac-db'),
      docker,
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(60000),
    });

    expect(await later.ensure('abe_proto_3fa2c1', 'demo-shop')).toEqual({
      ok: true,
      url: a.url,
      made: false,
    });
    expect(docker.runs.length).toBe(1);
    state.remove();
  });

  test('a stopped container is started again, its data kept', async () => {
    const state = tempState();
    const docker = fakeDocker();
    const db = macDatabase({
      dir: state.dir,
      docker,
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(54123),
    });

    await db.ensure('abe_proto_aaaaaa', 'demo-shop');
    for (const c of docker.box) c.state = 'exited';
    expect((await db.ensure('abe_proto_aaaaaa', 'demo-shop')).ok).toBe(true);
    expect(docker.starts).toEqual([MAC_DB.container]);
    expect(docker.runs.length).toBe(1);
    state.remove();
  });

  test('its port taken while it was stopped (a reboot): made again on another, its volume kept', async () => {
    const state = tempState();
    const docker = fakeDocker();
    const db = macDatabase({
      dir: state.dir,
      docker,
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(54123, 54999),
    });
    const first = await db.ensure('abe_proto_aaaaaa', 'demo-shop');

    for (const c of docker.box) c.state = 'exited';
    Object.assign(docker, {
      start: () =>
        Promise.reject(
          new Error(
            'docker start failed: Bind for 127.0.0.1:54123 failed: port is already allocated',
          ),
        ),
    });
    const again = await db.ensure('abe_proto_aaaaaa', 'demo-shop');

    if (!first.ok || !again.ok) throw new Error(JSON.stringify(again));
    expect(docker.removes).toEqual([MAC_DB.container]);
    expect(docker.runs.map((r) => [r.publish?.[0]?.port, r.mounts[0]?.source])).toEqual([
      [54123, MAC_DB.volume],
      [54999, MAC_DB.volume],
    ]);
    expect(again.url).toBe(first.url.replace(':54123/', ':54999/'));
    state.remove();
  });

  test("a failure after Docker answered is the Mac database's, a password never in its words", async () => {
    const state = tempState();
    const run = macDatabase({
      dir: state.dir,
      docker: fakeDocker({ runFails: 'docker run failed: error during connect: no space left' }),
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(54123),
    });
    const ran = await run.ensure('abe_proto_aaaaaa', 'demo-shop');

    expect(ran.ok ? 'ok' : ran.failure.kind).toBe('mac');
    const sql = macDatabase({
      dir: state.dir,
      docker: fakeDocker({
        sqlFails:
          "ERROR:  syntax error at or near\nLINE 1: ALTER ROLE abe_proto_aaaaaa LOGIN PASSWORD 'deadbeef00112233';",
      }),
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(54123),
    });
    const said = await sql.ensure('abe_proto_aaaaaa', 'demo-shop');

    if (said.ok || said.failure.kind !== 'mac') throw new Error(JSON.stringify(said));
    expect(said.failure.said).toContain("PASSWORD '…'");
    expect(said.failure.said).not.toContain('deadbeef00112233');
    state.remove();
  });

  test('dropped idempotently: gone already, or no container at all, is fine', async () => {
    const state = tempState();
    const docker = fakeDocker();
    const db = macDatabase({
      dir: state.dir,
      docker,
      env: {},
      sleep: () => Promise.resolve(),
      freePort: ports(54123),
    });

    expect(await db.drop('abe_proto_aaaaaa')).toEqual({ ok: true });
    expect(docker.runs).toEqual([]);
    await db.ensure('abe_proto_aaaaaa', 'demo-shop');
    expect(await db.drop('abe_proto_aaaaaa')).toEqual({ ok: true });
    expect(await db.drop('abe_proto_aaaaaa')).toEqual({ ok: true });
    expect(docker.dbs.size).toBe(0);
    expect(docker.sql.at(-1)).toBe(
      'DROP DATABASE IF EXISTS abe_proto_aaaaaa WITH (FORCE);\nDROP ROLE IF EXISTS abe_proto_aaaaaa;',
    );
    // made anew after a drop: new again, so seeded again
    const fresh = await db.ensure('abe_proto_aaaaaa', 'demo-shop');

    expect(fresh.ok && fresh.made).toBe(true);
    state.remove();
  });

  test("Docker down or missing: the failure's kind, for its words", async () => {
    const state = tempState();
    const down = macDatabase({
      dir: state.dir,
      docker: fakeDocker({ down: true }),
      env: {},
    });

    expect(await down.ensure('abe_proto_aaaaaa', 'demo-shop')).toEqual({
      ok: false,
      failure: { kind: 'docker-down', repo: 'demo-shop' },
    });
    expect(await down.docker()).toBe('down');
    // never taken for gone: its database is dropped once Docker answers
    expect(await down.drop('abe_proto_aaaaaa')).toEqual({
      ok: false,
      said: "Docker isn't running",
    });
    // no docker anywhere
    const missing = macDatabase({ dir: state.dir, env: { PATH: '/nowhere', HOME: '/nowhere' } });

    if (findDocker({ PATH: '/nowhere', HOME: '/nowhere' }) === null) {
      expect(await missing.ensure('abe_proto_aaaaaa', 'demo-shop')).toEqual({
        ok: false,
        failure: { kind: 'no-docker', repo: 'demo-shop' },
      });
      expect(await missing.docker()).toBe('missing');
    }
    state.remove();
  });
});

const realDocker = findDocker(process.env);
const realUp =
  realDocker !== null &&
  Bun.spawnSync([realDocker, 'image', 'inspect', POSTGRES_IMAGE], { stdout: 'ignore' }).exitCode ===
    0;

describe('the Mac database on real Docker (#349)', () => {
  test.skipIf(!realUp)(
    'made, reached by its own role only, dropped; its own container and volume removed after',
    async () => {
      const state = tempState();
      const tag = randomBytes(3).toString('hex');
      const names = { container: `abe-pg-test-${tag}`, volume: `abe-pg-test-${tag}` };
      const docker = dockerCli({ bin: realDocker ?? 'docker', env: process.env });
      const db = macDatabase({ dir: state.dir, docker, env: process.env, names });

      try {
        const a = await db.ensure('abe_proto_aaaaaa', 'demo-shop');
        const b = await db.ensure('abe_proto_bbbbbb', 'demo-shop');

        if (!a.ok || !b.ok) throw new Error(JSON.stringify([a, b]));
        expect(a.made && b.made).toBe(true);
        const own = new Bun.SQL(a.url);

        const rows: unknown = await own`SELECT current_database() AS db`;

        expect(rows).toEqual([{ db: 'abe_proto_aaaaaa' }]);
        await own.close();
        // a's role on b's database: refused
        const other = new Bun.SQL(a.url.replace(/\/abe_proto_aaaaaa$/, '/abe_proto_bbbbbb'));

        expect(
          await other`SELECT 1`.then(
            () => 'reached',
            () => 'refused',
          ),
        ).toBe('refused');
        await other.close().catch(() => undefined);
        expect((await db.ensure('abe_proto_aaaaaa', 'demo-shop')).ok).toBe(true);
        expect(await db.drop('abe_proto_aaaaaa')).toEqual({ ok: true });
        const again = await db.ensure('abe_proto_aaaaaa', 'demo-shop');

        expect(again.ok && again.made).toBe(true);
      } finally {
        await docker.remove(names.container).catch(() => undefined);
        Bun.spawnSync([realDocker ?? 'docker', 'volume', 'rm', '--force', names.volume]);
        state.remove();
      }
    },
    120_000,
  );
});
