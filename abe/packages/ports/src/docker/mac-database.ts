/**
 * The Mac database (#349): Abe's own Postgres container on this Mac through the Docker port, made
 * on first need, and a role and database per name in it. Each database's password is derived from
 * a secret kept in `serve`'s state directory (mode 0600), so the same name gives the same URL
 * after a restart. IO only: the names, the SQL and who may connect are core's (`mac-database.ts`).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Container,
  type Docker,
  MAC_DB,
  MAC_PG_HBA,
  type MacDatabase,
  type MacDbAnswer,
  macDatabaseSql,
  macDatabaseUrl,
  macDropSql,
  macPostgresSpec,
  madeOf,
} from '@abe/core';
import { dockerCli } from './docker';
import { type Env } from '../mac/locations';

/** Where Docker Desktop, OrbStack, colima (Homebrew) and Rancher put `docker` on a Mac. */
const MAC_DOCKER_DIRS = (home: string) => [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  join(home, '.orbstack', 'bin'),
  '/Applications/Docker.app/Contents/Resources/bin',
  join(home, '.rd', 'bin'),
];

/** `docker` on `PATH`, else where a Mac's Docker puts it; null when there is none. */
export const findDocker = (env: Env): string | null =>
  Bun.which('docker', {
    PATH: [env.PATH ?? '', ...MAC_DOCKER_DIRS(env.HOME ?? '/')].filter((p) => p !== '').join(':'),
  });

/** What Docker's CLI says when its daemon does not answer (Docker Desktop, OrbStack, colima). */
const DOWN =
  /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect|connection refused|no such file or directory.*docker\.sock/i;

const PG_READY_TRIES = 60;
const PG_READY_WAIT_MS = 500;

export type MacDatabaseOptions = {
  /** `serve`'s state directory's `mac-db` folder: the secret. */
  dir: string;
  /** The Docker to use; default `bin`, else `docker` found on the Mac (`findDocker`). */
  docker?: Docker;
  /** The `docker` to run (`$ABE_DOCKER`: tests point it at a fake). */
  bin?: string;
  env: Env;
  sleep?: (ms: number) => Promise<void>;
  /** Another container and volume (the real-Docker test's own). */
  names?: { container: string; volume: string };
  /** A free loopback port for the container, picked once (default: the OS's). */
  freePort?: () => number;
};

/** A loopback port no one listens on now, as the OS hands one out. */
export const osFreePort = (): number => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined } });
  const { port } = server;

  server.stop(true);

  return port;
};

/** What Docker says when the port a container is published on is someone else's now. */
const PORT_TAKEN = /port is already allocated|address already in use|bind.*failed/i;

/** The last lines of psql's stderr, never a password it may echo (`PASSWORD '…'`). */
const tail = (text: string, secret?: string) => {
  const last = text.trim().split('\n').slice(-3).join(' ').trim();
  // Every password here is hex: any long run of it hidden too (a context line psql cut short).
  const hidden = last
    .replace(/PASSWORD\s+'[^']*'?/gi, "PASSWORD '…'")
    .replace(/[0-9a-f]{12,}/gi, '…');

  return secret === undefined || secret === '' ? hidden : hidden.split(secret).join('…');
};

export const macDatabase = (o: MacDatabaseOptions): MacDatabase => {
  const bin = o.docker === undefined ? (o.bin ?? findDocker(o.env)) : 'docker';
  const docker =
    o.docker ??
    (bin === null
      ? undefined
      : dockerCli({
          bin,
          // Its credential helpers sit beside it (Docker Desktop's `docker-credential-desktop`).
          env: { ...o.env, PATH: `${dirname(bin)}:${o.env.PATH ?? '/usr/bin:/bin'}` },
        }));
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const container = o.names?.container ?? MAC_DB.container;
  const secretFile = join(o.dir, 'secret');
  // One ensure at a time: two first prototypes make one container.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);

    queue = next.catch(() => undefined);

    return next;
  };
  /** Its access rules written once per container start in this serve. */
  let ruled: string | undefined;

  const secret = () => {
    if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    const made = randomBytes(32).toString('hex');

    try {
      writeFileSync(secretFile, `${made}\n`, { mode: 0o600, flag: 'wx' });
    } catch {
      // Another serve wrote it first: theirs.
      return readFileSync(secretFile, 'utf8').trim();
    }

    return made;
  };
  const passwordOf = (name: string) =>
    createHmac('sha256', secret()).update(name).digest('hex').slice(0, 32);

  const psql = (sql: string) => {
    if (docker === undefined) throw new Error('no docker');

    return docker.exec(
      container,
      ['psql', '-v', 'ON_ERROR_STOP=1', '-qtA', '-U', 'postgres'],
      sql,
      {
        user: 'postgres',
      },
    );
  };

  /** Docker's state: up, down (its daemon does not answer) or missing (no `docker`). */
  const state = async (): Promise<
    { at: 'up'; found: Container | undefined } | { at: 'down' | 'missing' }
  > => {
    if (docker === undefined) return { at: 'missing' };
    try {
      const found = (await docker.containers(MAC_DB.label, MAC_DB.role)).find(
        (c) => c.name === container,
      );

      return { at: 'up', found };
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);

      if (/ENOENT|executable not found|not found in \$PATH/i.test(said)) return { at: 'missing' };
      if (DOWN.test(said)) return { at: 'down' };
      throw err;
    }
  };

  /** A new container on a free port (its volume, with the data, kept): its port. */
  const made = async (d: Docker): Promise<number> => {
    const port = (o.freePort ?? osFreePort)();

    await d.run(
      macPostgresSpec({
        password: randomBytes(16).toString('hex'),
        port,
        ...(o.names === undefined ? {} : { names: o.names }),
      }),
    );

    return port;
  };

  /** The container running and ready, made when missing: its port. */
  const up = async (d: Docker, found: Container | undefined): Promise<number> => {
    let port = Number(found?.labels[MAC_DB.portLabel]);

    if (found === undefined || !Number.isInteger(port) || port <= 0) {
      if (found !== undefined) await d.remove(found.name);
      port = await made(d);
      ruled = undefined;
    } else if (found.state !== 'running') {
      try {
        await d.start(found.name);
      } catch (err) {
        // Its port taken while it was stopped (a reboot): made again on another, same volume.
        if (!PORT_TAKEN.test(err instanceof Error ? err.message : String(err))) throw err;
        await d.remove(found.name);
        port = await made(d);
      }
      ruled = undefined;
    }
    for (let i = 0; i < PG_READY_TRIES; i += 1) {
      // Over TCP: the image's first-start server (initdb's) listens on its socket only.
      const ready = await d.exec(
        container,
        ['pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'],
        undefined,
        { user: 'postgres' },
      );

      if (ready.exit === 0) {
        if (ruled !== container) {
          const hba = await d.exec(
            container,
            ['sh', '-c', 'cat > "$PGDATA/pg_hba.conf"'],
            MAC_PG_HBA,
            { user: 'postgres' },
          );
          const reloaded = hba.exit === 0 ? await psql('SELECT pg_reload_conf();') : hba;

          if (reloaded.exit !== 0)
            throw new Error(
              `its access rules: ${tail(reloaded.stderr) || `exit ${reloaded.exit}`}`,
            );
          ruled = container;
        }

        return port;
      }
      await sleep(PG_READY_WAIT_MS);
    }
    throw new Error('Postgres did not get ready');
  };

  const ensure: MacDatabase['ensure'] = (name, repo) =>
    serial(async (): Promise<MacDbAnswer> => {
      try {
        const at = await state();

        if (at.at === 'missing') return { ok: false, failure: { kind: 'no-docker', repo } };
        if (at.at !== 'up' || docker === undefined)
          return { ok: false, failure: { kind: 'docker-down', repo } };
        const port = await up(docker, at.found);
        const password = passwordOf(name);
        const ran = await psql(macDatabaseSql(name, password));

        if (ran.exit !== 0)
          return {
            ok: false,
            failure: {
              kind: 'mac',
              said: tail(ran.stderr, password) || `psql exited ${ran.exit}`,
            },
          };

        return { ok: true, url: macDatabaseUrl(name, password, port), made: madeOf(ran.stdout) };
      } catch (err) {
        // Docker's state is `state()`'s: what fails after it (run, start, exec) is the container's.
        return {
          ok: false,
          failure: { kind: 'mac', said: tail(err instanceof Error ? err.message : String(err)) },
        };
      }
    });

  return {
    ensure,
    drop: (name) =>
      serial(async () => {
        try {
          const at = await state();

          // No Docker at all: no container, nothing to drop.
          if (at.at === 'missing') return { ok: true };
          // Docker not answering: not dropped (kept to drop later), never taken for gone.
          if (at.at !== 'up' || docker === undefined)
            return { ok: false, said: "Docker isn't running" };
          // No container, no database: nothing to drop.
          if (at.found === undefined) return { ok: true };
          const { found } = at;
          await up(docker, found);
          const dropped = await psql(macDropSql(name));

          return dropped.exit === 0
            ? { ok: true }
            : { ok: false, said: tail(dropped.stderr) || `psql exited ${dropped.exit}` };
        } catch (err) {
          return { ok: false, said: err instanceof Error ? err.message : String(err) };
        }
      }),
    docker: async () => {
      try {
        const at = await state();

        return at.at;
      } catch {
        return 'down';
      }
    },
  };
};
