import { describe, expect, test } from 'bun:test';
import {
  APP_OF,
  databaseUrlOf,
  DB_NAME,
  dbEnv,
  leftovers,
  NO_DATABASE_NOTE,
  sessionAppEnv,
} from './session-apps';
import { dbNeed } from './mac-database';
import { awsOffEnv } from '../install/install-aws-off';

describe("a local session's apps (#182)", () => {
  test('a pack script gets APP_ENV of serve, no token, the session marked and its database', () => {
    const env = sessionAppEnv(
      {
        HOME: '/u',
        PATH: '/bin',
        GH_TOKEN: 'secret',
        ANTHROPIC_API_KEY: 'k',
        DATABASE_URL: 'postgres://serve',
      },
      '4-ab12',
      'postgres://own',
    );

    expect(env).toEqual({
      HOME: '/u',
      PATH: '/bin',
      DATABASE_URL: 'postgres://own',
      [APP_OF]: '4-ab12',
    });
  });

  test('aws off: every AWS_ name out, its config and credentials the empty file, no instance metadata', () => {
    const env = awsOffEnv(
      {
        HOME: '/u',
        PATH: '/bin',
        AWS_PROFILE: 'dev',
        AWS_DEFAULT_PROFILE: 'dev',
        AWS_ACCESS_KEY_ID: 'AKIAFAKE',
        AWS_SECRET_ACCESS_KEY: 'fake',
        AWS_SESSION_TOKEN: 'fake',
        AWS_SSO_SESSION: 'acme',
        AWS_CONFIG_FILE: '/u/.aws/config',
      },
      '/state/aws-off/empty',
    );

    expect(env).toEqual({
      HOME: '/u',
      PATH: '/bin',
      AWS_CONFIG_FILE: '/state/aws-off/empty',
      AWS_SHARED_CREDENTIALS_FILE: '/state/aws-off/empty',
      AWS_EC2_METADATA_DISABLED: 'true',
    });
  });

  test('without a database of its own, serve has none to give either', () => {
    expect(sessionAppEnv({ PATH: '/bin' }, '4-ab12', undefined)).toEqual({
      PATH: '/bin',
      [APP_OF]: '4-ab12',
    });
  });

  test("what the session left running: its socket or its mark in the process's environment, and their groups", () => {
    const socket = '/home/u/Library/Application Support/abe/s/4-ab12/session.sock';
    const ps = [
      `  101   101 node server.js HOME=/u ABE_SOCKET=${socket} PATH=/bin`,
      `  102   900 vite --port 5173 ABE_APP_OF=4-ab12 PATH=/bin`,
      `  103   103 node other.js ABE_SOCKET=/home/u/Library/Application Support/abe/s/4-ab1/session.sock`,
      `  104   104 node other.js ABE_APP_OF=4-ab123`,
      '  105   105 /bin/zsh -l',
      `  106   106 grep ABE_APP_OF=4-ab12`,
      `  107   900 chrome-headless-shell --single-process ABE_APP_OF=4-ab12`,
      'garbage line',
    ].join('\n');

    expect(leftovers(ps, { socket, id: '4-ab12', self: 106 })).toEqual({
      pids: [101, 102, 107],
      groups: [101, 900],
    });
    expect(leftovers(ps, { id: '4-ab12', self: 106 })).toEqual({ pids: [102, 107], groups: [900] });
  });

  test('the database hook never carries the mark: its database is stopped by its own stop', () => {
    expect(dbEnv({ PATH: '/bin' }, '4-ab12')).toEqual({
      PATH: '/bin',
      ABE_DB_NAME: 'abe-db-4-ab12',
    });
  });
});

describe("a local session's database (#146)", () => {
  test("the db script's last stdout line is the URL", () => {
    expect(databaseUrlOf('creating abe-db-4\npostgres://u:p@127.0.0.1:55432/abe-db-4\n')).toBe(
      'postgres://u:p@127.0.0.1:55432/abe-db-4',
    );
    expect(databaseUrlOf('ready\n')).toBeUndefined();
    expect(databaseUrlOf('')).toBeUndefined();
  });

  test("its name is the session's", () => {
    expect(DB_NAME('4-ab12')).toBe('abe-db-4-ab12');
  });

  test.each([
    [
      'names it',
      [{ path: '.claude/skills/verify-shop/SKILL.md', text: 'Everything needs `$DATABASE_URL`.' }],
      '.claude/skills/verify-shop/SKILL.md',
    ],
    [
      'in a comment of the second file',
      [
        { path: '.claude/skills/verify-shop/SKILL.md', text: '# Verify\n\nRun it.\n' },
        { path: 'abe.yaml', text: '# the tests need $DATABASE_URL\nchecks: []\n' },
      ],
      'abe.yaml',
    ],
    [
      'another variable only',
      [{ path: '.claude/skills/verify-shop/SKILL.md', text: 'TEST_DATABASE_URLS only' }],
      null,
    ],
    ['no pack', [], null],
  ] as const)('a repo whose pack %s needs the local database (#218, #349)', (_, files, said) => {
    expect(dbNeed({ hook: false, files })).toEqual(
      said === null ? { by: 'none' } : { by: 'mac', said },
    );
  });

  test('a session with no database is told not to ask for one', () => {
    expect(NO_DATABASE_NOTE).toContain("Docker isn't running");
    expect(NO_DATABASE_NOTE).toContain('never ask');
  });
});
