import { describe, expect, test } from 'bun:test';
import {
  dbFailureWords,
  dbNeed,
  MAC_DB,
  macDbName,
  macDatabaseSql,
  macDatabaseUrl,
  macDropSql,
  MAC_PG_HBA,
  macPostgresSpec,
  madeOf,
  packScriptEnv,
  PORT_BASE,
} from './mac-database';

describe('the Mac database (#349)', () => {
  test("a session's and a prototype's database names: Postgres identifiers of their own", () => {
    expect(macDbName.session('4-a1b2')).toBe('abe_4_a1b2');
    expect(macDbName.session('improve-Ab12')).toBe('abe_improve_ab12');
    expect(macDbName.prototype('proto-3fa2c1')).toBe('abe_proto_3fa2c1');
    expect(() => macDbName.session('x'.repeat(70))).toThrow();
  });

  test('a repo needs a database when it has the hook or its pack or env example names DATABASE_URL (Postgres)', () => {
    const verify = {
      path: '.claude/skills/verify-shop/SKILL.md',
      text: 'Everything needs `$DATABASE_URL`.',
    };
    const plain = { path: '.claude/skills/verify-shop/SKILL.md', text: 'Run npm start.' };

    expect(dbNeed({ hook: true, files: [plain] })).toEqual({ by: 'hook' });
    expect(dbNeed({ hook: false, files: [plain, verify] })).toEqual({
      by: 'mac',
      said: '.claude/skills/verify-shop/SKILL.md',
    });
    expect(dbNeed({ hook: false, files: [plain] })).toEqual({ by: 'none' });
    // a word that only contains it is no mention
    expect(
      dbNeed({
        hook: false,
        files: [{ path: '.claude/skills/run-app/scripts/start', text: 'MY_DATABASE_URLS=1' }],
      }),
    ).toEqual({ by: 'none' });
    // Factory install's Run locally: the env example says it before any pack file
    const at = (path: string, text: string) => dbNeed({ hook: false, files: [{ path, text }] }).by;

    expect(at('.env.example', 'DATABASE_URL=\nPORT=3000')).toBe('mac');
    expect(at('.env.example', 'DATABASE_URL="postgresql://shop:shop@localhost/shop"')).toBe('mac');
    expect(at('.env.example', 'DATABASE_URL=mysql://shop@localhost/shop')).toBe('none');
    expect(at('.env.example', '# DATABASE_URL=postgres://x\nPORT=3000')).toBe('none');
    // a first install's Checks, before any pack file: dev's Abe env file says it as an example does
    expect(at('.abe/abe.dev.env', '# header\nDATABASE_URL=\n')).toBe('mac');
    expect(at('.abe/abe.dev.env', 'DATABASE_URL=postgres://u:pw@db.example.com/shop\n')).toBe(
      'mac',
    );
    expect(at('.abe/abe.dev.env', 'DATABASE_URL=mysql://shop@localhost/shop\n')).toBe('none');
    // or CI's checks run on Postgres: a DATABASE_URL set to one, never a secret's or another engine's
    const ci = '.github/workflows/ci.yml';

    expect(
      at(ci, 'jobs:\n  checks:\n    env:\n      DATABASE_URL: postgres://s:s@localhost/s\n'),
    ).toBe('mac');
    expect(at(ci, "    env:\n      DATABASE_URL: 'postgresql://shop@localhost/shop'\n")).toBe(
      'mac',
    );
    expect(
      at('azure-pipelines.yml', '  - script: DATABASE_URL=postgres://c@localhost/c npm test'),
    ).toBe('mac');
    expect(at(ci, '      DATABASE_URL: ${{ secrets.DATABASE_URL }}\n')).toBe('none');
    expect(at(ci, '      DATABASE_URL: mysql://root@localhost/shop\n')).toBe('none');
    expect(at(ci, '      # DATABASE_URL: postgres://old@localhost/shop\n')).toBe('none');
  });

  test('the role and database made when missing, closed to every other role, said new or had', () => {
    const sql = macDatabaseSql('abe_proto_3fa2c1', 'a'.repeat(32));

    expect(sql.split('\n')).toEqual([
      "SELECT CASE WHEN EXISTS (SELECT FROM pg_database WHERE datname = 'abe_proto_3fa2c1') THEN 'had' ELSE 'new' END;",
      "SELECT 'CREATE ROLE abe_proto_3fa2c1 LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'abe_proto_3fa2c1')\\gexec",
      `ALTER ROLE abe_proto_3fa2c1 LOGIN PASSWORD '${'a'.repeat(32)}';`,
      "SELECT 'CREATE DATABASE abe_proto_3fa2c1 OWNER abe_proto_3fa2c1' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'abe_proto_3fa2c1')\\gexec",
      'REVOKE ALL ON DATABASE abe_proto_3fa2c1 FROM PUBLIC;',
      'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;',
      'REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;',
    ]);
    expect(() => macDatabaseSql("abe_x'; DROP", 'a'.repeat(32))).toThrow();
    expect(() => macDatabaseSql('abe_x', 'not hex')).toThrow();
    expect(madeOf('new\n')).toBe(true);
    expect(madeOf('had\n')).toBe(false);
  });

  test('dropped with its connections, then its role; gone already is fine', () => {
    expect(macDropSql('abe_4_a1b2').split('\n')).toEqual([
      'DROP DATABASE IF EXISTS abe_4_a1b2 WITH (FORCE);',
      'DROP ROLE IF EXISTS abe_4_a1b2;',
    ]);
  });

  test('each role reaches only the database of its own name, over loopback TCP', () => {
    expect(MAC_PG_HBA).toContain('local all postgres peer');
    expect(MAC_PG_HBA).toContain('host sameuser all all scram-sha-256');
    expect(MAC_PG_HBA.trim().split('\n').at(-1)).toBe('host all all all reject');
    expect(macDatabaseUrl('abe_4_a1b2', 'ff', 54123)).toBe(
      'postgresql://abe_4_a1b2:ff@127.0.0.1:54123/abe_4_a1b2',
    );
  });

  test("the container: the boxes' Postgres, on the Mac's loopback at its kept port, back after Docker's start", () => {
    const spec = macPostgresSpec({ password: 'b'.repeat(32), port: 54123 });

    expect(spec.name).toBe(MAC_DB.container);
    expect(spec.image).toBe('postgres:17-alpine');
    expect(spec.publish).toEqual([{ host: '127.0.0.1', port: 54123, target: 5432 }]);
    expect(spec.labels).toEqual({ [MAC_DB.label]: MAC_DB.role, [MAC_DB.portLabel]: '54123' });
    expect(spec.mounts).toEqual([
      { type: 'volume', source: MAC_DB.volume, target: '/var/lib/postgresql/data' },
    ]);
    expect(spec.restart).toBe('unless-stopped');
  });

  test("a pack script's port base and database ride its env, never serve's DATABASE_URL", () => {
    expect(
      packScriptEnv(
        { PATH: '/bin', DATABASE_URL: 'postgres://serve', GH_TOKEN: 't' },
        { ABE_PROTOTYPE: 'proto-1' },
        { database: 'postgres://own', portBase: 41020 },
      ),
    ).toEqual({
      PATH: '/bin',
      ABE_PROTOTYPE: 'proto-1',
      DATABASE_URL: 'postgres://own',
      [PORT_BASE]: '41020',
    });
    expect(
      packScriptEnv({ PATH: '/bin', DATABASE_URL: 'postgres://serve' }, {}, { portBase: 41000 }),
    ).toEqual({ PATH: '/bin', [PORT_BASE]: '41000' });
  });
});

describe('a database failure in words (#349)', () => {
  const table: [Parameters<typeof dbFailureWords>[0], string][] = [
    [
      { kind: 'docker-down', repo: 'demo-shop' },
      "demo-shop needs a database and Docker isn't running.\nStart Docker (Docker Desktop, OrbStack or colima)",
    ],
    [
      { kind: 'no-docker', repo: 'demo-shop' },
      "demo-shop needs a database and Docker isn't installed.\nInstall Docker Desktop, OrbStack or colima",
    ],
    [
      { kind: 'hook', exit: 1, said: 'starting\nrole shop does not exist\n' },
      'The repo\'s database hook failed: .claude/skills/run-app/scripts/db start exited 1 (last line: "role shop does not exist").\nFix the hook',
    ],
    [
      { kind: 'hook', exit: 0, said: 'started\n' },
      'The repo\'s database hook failed: .claude/skills/run-app/scripts/db start printed no database URL as its last line (last line: "started").\nFix the hook',
    ],
    [
      { kind: 'hook', exit: null, said: '' },
      "The repo's database hook failed: .claude/skills/run-app/scripts/db start took too long.\nFix the hook",
    ],
    [
      { kind: 'seed', exit: 2, said: 'error: relation "products" does not exist' },
      'The new database was made but .claude/skills/run-app/scripts/seed exited 2 (last line: "error: relation "products" does not exist").\nFix the seed',
    ],
    [
      { kind: 'mac', said: 'docker run failed: pull access denied' },
      "Abe's local database (abe-pg) did not start: docker run failed: pull access denied.\nCheck Docker",
    ],
  ];

  for (const [failure, words] of table)
    test(`${failure.kind}: ${words.split('\n')[0] ?? ''}`, () => {
      expect(dbFailureWords(failure)).toBe(words);
    });

  test('never the raw DATABASE_URL is not set', () => {
    for (const [failure] of table) expect(dbFailureWords(failure)).not.toContain('is not set');
  });
});
