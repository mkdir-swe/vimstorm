/**
 * Two cards' workspaces on one box against a real Postgres (Docker, ADR 0022): the box's
 * `pg_hba.conf` and each workspace's role and database exactly as `workspace up` writes them, a
 * client on the shared socket as each workspace reaches it. Neither card's role reaches the other's
 * database, nor Postgres' own. Runs where Docker answers and has `postgres:17-alpine`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  databaseSql,
  databaseUrl,
  dropDatabaseSql,
  PG_HBA,
  PG_SOCKET_DIR,
  POSTGRES_IMAGE,
  workspaceNames,
} from '@abe/core';

const docker = (args: readonly string[], stdin?: string) => {
  const ran = Bun.spawnSync(['docker', ...args], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
  });

  return { exit: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
};

const usable =
  Bun.which('docker') !== null &&
  docker(['info', '--format', '{{.ServerVersion}}']).exit === 0 &&
  docker(['image', 'inspect', POSTGRES_IMAGE]).exit === 0;

const tag = randomBytes(3).toString('hex');
const PG = `abe-pg-dbtest-${tag}`;
const SOCKET = `abe-pg-socket-dbtest-${tag}`;
const password = (card: string) => `${card.padStart(4, '0')}${randomBytes(8).toString('hex')}`;
const cards = { '101': password('101'), '102': password('102') };

/** psql in a throwaway client with the socket mounted where a workspace has it, as `url`. */
const asWorkspace = (url: string, sql: string) =>
  docker([
    'run',
    '--rm',
    '-v',
    `${SOCKET}:${PG_SOCKET_DIR.workspace}:ro`,
    POSTGRES_IMAGE,
    'psql',
    url,
    '-qtAc',
    sql,
  ]);

/** psql as the box's serve: Postgres' superuser by peer in its own container. */
const asServe = (sql: string) =>
  docker(['exec', '-i', '--user', 'postgres', PG, 'psql', '-v', 'ON_ERROR_STOP=1', '-qtA'], sql);

describe.skipIf(!usable)("each card's database on the box's one Postgres (Docker)", () => {
  beforeAll(async () => {
    docker([
      'run',
      '-d',
      '--name',
      PG,
      '-e',
      `POSTGRES_PASSWORD=${randomBytes(16).toString('hex')}`,
      '-v',
      `${SOCKET}:${PG_SOCKET_DIR.postgres}`,
      POSTGRES_IMAGE,
    ]);
    for (let i = 0; i < 120; i += 1) {
      // Ready over TCP once the image's first start is through (its first server is socket only).
      if (
        docker(['exec', '--user', 'postgres', PG, 'pg_isready', '-q', '-h', '127.0.0.1']).exit ===
          0 &&
        asServe('SELECT 1;').exit === 0
      )
        break;
      await Bun.sleep(500);
    }
    expect(
      docker(
        ['exec', '-i', '--user', 'postgres', PG, 'sh', '-c', 'cat > "$PGDATA/pg_hba.conf"'],
        PG_HBA,
      ).exit,
    ).toBe(0);
    expect(asServe('SELECT pg_reload_conf();').exit).toBe(0);
    for (const [card, pw] of Object.entries(cards))
      expect(asServe(databaseSql(pw, workspaceNames(card).database)).stderr).toBe('');
  }, 90_000);

  afterAll(() => {
    docker(['rm', '-f', PG]);
    docker(['volume', 'rm', SOCKET]);
  });

  test('each workspace reaches its own database with its URL', () => {
    for (const [card, pw] of Object.entries(cards)) {
      const db = workspaceNames(card).database;
      const ran = asWorkspace(databaseUrl(pw, db), 'SELECT current_database();');

      expect(ran.stdout.trim()).toBe(db);
    }
  }, 60_000);

  test("card 101's role reaches neither card 102's database nor Postgres' own", () => {
    const own = databaseUrl(cards['101'], 'ws_101');

    for (const other of ['ws_102', 'postgres', 'template1']) {
      const ran = asWorkspace(own.replace('@/ws_101?', `@/${other}?`), 'SELECT 1;');

      expect(ran.exit).not.toBe(0);
      expect(ran.stderr).toMatch(/pg_hba\.conf rejects|permission denied/);
    }
    // Card 102's password does not open card 101's database as its role either.
    const swapped = databaseUrl(cards['102'], 'ws_101');

    expect(asWorkspace(swapped, 'SELECT 1;').exit).not.toBe(0);
  }, 60_000);

  test('a removed workspace leaves nothing: its database and role gone, the other kept', () => {
    expect(asServe(dropDatabaseSql('ws_101')).exit).toBe(0);
    expect(
      asServe("SELECT datname FROM pg_database WHERE datname LIKE 'ws_%';").stdout.trim(),
    ).toBe('ws_102');
    expect(asServe("SELECT rolname FROM pg_roles WHERE rolname LIKE 'ws_%';").stdout.trim()).toBe(
      'ws_102',
    );
  }, 60_000);
});
