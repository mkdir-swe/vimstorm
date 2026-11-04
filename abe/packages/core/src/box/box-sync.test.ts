import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOX_SYNC_SCRIPT,
  type BoxSync,
  boxSyncPayload,
  mcpAccessOf,
  mcpAccessWanted,
  SYNC_TOKEN_MARGIN_MS,
  syncedEnvs,
} from './box-sync';
import { excludePlaceholders } from './workspace';

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('syncedEnvs: the Abe env files a sync sends', () => {
  test('dev and test by default; prod never unless it is on', () => {
    expect(syncedEnvs(() => undefined)).toEqual(['dev', 'test']);
    expect(syncedEnvs((env) => (env === 'prod' ? false : undefined))).toEqual(['dev', 'test']);
    expect(syncedEnvs((env) => (env === 'prod' ? true : undefined))).toEqual([
      'dev',
      'test',
      'prod',
    ]);
    expect(syncedEnvs((env) => env === 'test')).toEqual(['test']);
  });
});

describe("mcpAccessOf: the access token of Claude Code's store, by its key", () => {
  const store = {
    claudeAiOauth: { accessToken: 'login' },
    mcpOAuth: {
      'sentry|0a1b2c3d4e5f6a7b': {
        serverName: 'sentry',
        serverUrl: 'https://mcp.sentry.dev/mcp',
        accessToken: 'sentry-access',
        refreshToken: 'sentry-refresh',
        clientId: 'client',
        clientSecret: 'client-secret',
        expiresAt: 2_000_000,
      },
      // the same name at another URL: another definition's
      'sentry|ffffffffffffffff': {
        serverName: 'sentry',
        serverUrl: 'https://other.example/mcp',
        accessToken: 'other-access',
      },
      'linear|1111111111111111': {
        serverName: 'linear',
        serverUrl: 'https://mcp.linear.app/sse',
        accessToken: '',
        refreshToken: 'linear-refresh',
      },
    },
  };
  const servers = {
    sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
    linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
    local: { type: 'stdio', command: 'local-mcp', args: [] },
  };

  test("the access token alone, under the Mac's key: never a refresh token or client secret", () => {
    const got = mcpAccessOf(store, servers);

    expect(got).toEqual({
      'sentry|0a1b2c3d4e5f6a7b': {
        serverName: 'sentry',
        serverUrl: 'https://mcp.sentry.dev/mcp',
        accessToken: 'sentry-access',
        expiresAt: 2_000_000,
      },
    });
    const text = JSON.stringify(got);

    for (const secret of ['refresh', 'client', 'login', 'other-access'])
      expect(text).not.toContain(secret);
  });

  test('wanted: a remote one with no token, or one about to end', () => {
    const got = mcpAccessOf(store, servers);

    expect(mcpAccessWanted(servers, got, 0)).toEqual(['linear']);
    expect(mcpAccessWanted(servers, got, 2_000_000 - SYNC_TOKEN_MARGIN_MS)).toEqual([
      'sentry',
      'linear',
    ]);
    expect(mcpAccessOf(undefined, servers)).toEqual({});
  });
});

describe('BOX_SYNC_SCRIPT: the sync in the workspace', () => {
  let root: string;
  let repo: string;
  let home: string;
  const sh = (cwd: string, ...argv: string[]) => {
    const ran = Bun.spawnSync(argv, {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x.test',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x.test',
      },
    });

    if (ran.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${ran.stderr.toString()}`);

    return ran.stdout.toString();
  };
  const sync = (s: BoxSync) =>
    Bun.spawnSync(['sh', '-c', BOX_SYNC_SCRIPT, 'sh', repo, home], {
      env: { PATH: '/usr/bin:/bin', HOME: home },
      stdin: new TextEncoder().encode(boxSyncPayload(s, base64)),
    });
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  const mode = (path: string) => statSync(path).mode & 0o777;
  const first: BoxSync = {
    // the Mac's uncommitted team changes: two changed, one new, one the same as the card's base
    team: [
      { path: 'abe.yaml', mode: '444', base64: base64('board: { provider: local }\n') },
      { path: '.claude/skills/run-app/SKILL.md', mode: '444', base64: base64('# run, mine\n') },
      { path: '.claude/skills/run-app/scripts/start', mode: '555', base64: base64('#!/bin/sh\n') },
      { path: '.claude/skills/verify-shop/SKILL.md', mode: '444', base64: base64('# verify\n') },
    ],
    gone: ['.claude/skills/old/SKILL.md'],
    yours: [{ path: '.abe/abe.dev.env', mode: '400', base64: base64('API_KEY=dev-secret\n') }],
    envs: ['dev'],
    mcp: {
      'sentry|0a1b': {
        serverName: 'sentry',
        serverUrl: 'https://mcp.sentry.dev/mcp',
        accessToken: 'sentry-access',
      },
    },
    aws: { dev: { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'aws-secret' } },
    sourceValues: 'FLAGS_API_PASSWORD=flags-secret\n',
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-sync-'));
    repo = join(root, 'repo');
    home = join(root, 'home');
    mkdirSync(repo);
    mkdirSync(join(home, '.claude'), { recursive: true });
    // the box's own Claude Code store: its login stays
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"x":1}}');
    sh(repo, 'git', 'init', '-q', '-b', 'main');
    write(join(repo, 'abe.yaml'), 'board: { provider: azure }\n');
    write(join(repo, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run\n');
    write(join(repo, '.claude', 'skills', 'old', 'SKILL.md'), '# old\n');
    write(join(repo, '.claude', 'skills', 'verify-shop', 'SKILL.md'), '# verify\n');
    // a stale env file of an environment now off: gone with the sync
    write(join(repo, '.abe', 'abe.prod.env'), 'API_KEY=prod-secret\n');
    // your source values where 3.5.1's sync put them, where a command reads them: gone
    write(join(repo, '.abe', 'sources.env'), 'FLAGS_API_PASSWORD=old\n');
    sh(repo, 'git', 'add', 'abe.yaml', '.claude');
    sh(repo, 'git', 'commit', '-q', '-m', 'team');
    // as the clone script keeps it: the sync alone keeps an untracked team file out
    Bun.spawnSync(['sh', '-ec', excludePlaceholders(repo).join('\n')]);
  });
  afterAll(() => {
    Bun.spawnSync(['chmod', '-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
  });

  test("the Mac's changed team files read-only and held out of commits; an unchanged one the card's own; the secrets out of the clone", () => {
    expect(sync(first).exitCode).toBe(0);
    expect(readFileSync(join(repo, 'abe.yaml'), 'utf8')).toBe('board: { provider: local }\n');
    expect(readFileSync(join(repo, '.claude/skills/run-app/SKILL.md'), 'utf8')).toBe(
      '# run, mine\n',
    );
    expect(mode(join(repo, 'abe.yaml'))).toBe(0o444);
    expect(mode(join(repo, '.claude/skills/run-app/scripts/start'))).toBe(0o555);
    expect(mode(join(repo, '.abe/abe.dev.env'))).toBe(0o400);
    expect(() => statSync(join(repo, '.abe/abe.prod.env'))).toThrow();
    expect(() => statSync(join(repo, '.claude/skills/old/SKILL.md'))).toThrow();
    // the same as the card's base: untouched, writable, committed as usual (its Verification pack)
    expect(mode(join(repo, '.claude/skills/verify-shop/SKILL.md')) & 0o200).toBe(0o200);
    expect(mode(join(repo, '.claude/skills/run-app')) & 0o200).toBe(0o200);
    expect(sh(repo, 'git', 'ls-files', '-v', 'abe.yaml', '.claude').split('\n')).toEqual([
      'S .claude/skills/old/SKILL.md',
      'S .claude/skills/run-app/SKILL.md',
      'H .claude/skills/verify-shop/SKILL.md',
      'S abe.yaml',
      '',
    ]);
    // the new one too (untracked here): out of `git status` by the sync's block of `info/exclude`
    expect(sh(repo, 'git', 'status', '--porcelain', '--untracked-files=all')).toBe('');
    // what the jail holds read-only: the changed ones alone
    expect(readFileSync(join(home, '.abe', 'sync', 'locked'), 'utf8').split('\n')).toEqual([
      'abe.yaml',
      '.claude/skills/run-app/SKILL.md',
      '.claude/skills/run-app/scripts/start',
      '.claude/skills/old/SKILL.md',
      '',
    ]);
    // the secrets: in the home's sync folder alone, its own
    const dir = join(home, '.abe', 'sync');

    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'aws', 'dev.json'))).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'aws', 'dev.json'), 'utf8'))).toEqual(first.aws.dev);
    expect(mode(join(dir, 'sources.env'))).toBe(0o600);
    expect(readFileSync(join(dir, 'sources.env'), 'utf8')).toBe(first.sourceValues ?? '');
    expect(() => statSync(join(repo, '.abe/sources.env'))).toThrow();
    const store = join(home, '.claude', '.credentials.json');

    expect(mode(store)).toBe(0o600);
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({
      claudeAiOauth: { x: 1 },
      mcpOAuth: first.mcp,
    });
  });

  test('the Mac committed them: the next sync gives each back to the card as its base has it', () => {
    const again: BoxSync = { team: [], gone: [], yours: [], envs: [], mcp: first.mcp, aws: {} };

    expect(sync(again).exitCode).toBe(0);
    expect(() => statSync(join(repo, '.abe/abe.dev.env'))).toThrow();
    expect(() => statSync(join(repo, '.claude/skills/run-app/scripts/start'))).toThrow();
    expect(() => statSync(join(home, '.abe', 'sync', 'aws'))).toThrow();
    expect(() => statSync(join(home, '.abe', 'sync', 'sources.env'))).toThrow();
    expect(readFileSync(join(repo, 'abe.yaml'), 'utf8')).toBe('board: { provider: azure }\n');
    expect(readFileSync(join(repo, '.claude/skills/old/SKILL.md'), 'utf8')).toBe('# old\n');
    expect(mode(join(repo, 'abe.yaml')) & 0o200).toBe(0o200);
    expect(sh(repo, 'git', 'ls-files', '-v', 'abe.yaml', '.claude').split('\n')).toEqual([
      'H .claude/skills/old/SKILL.md',
      'H .claude/skills/run-app/SKILL.md',
      'H .claude/skills/verify-shop/SKILL.md',
      'H abe.yaml',
      '',
    ]);
    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(home, '.abe', 'sync', 'locked'), 'utf8')).toBe('');
    // the sync's block gone from `info/exclude`: a card's own new skill there is its work, seen
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).not.toContain('Abe sync');
    write(join(repo, '.claude/skills/run-app/scripts/start'), '#!/bin/sh\n');
    expect(sh(repo, 'git', 'status', '--porcelain', '--untracked-files=all')).toBe(
      '?? .claude/skills/run-app/scripts/start\n',
    );
    rmSync(join(repo, '.claude/skills/run-app/scripts'), { recursive: true });
  });

  test("the recipe's files: a link replaced each sync and gone when not sent, a copy put in once, a tracked path never; all out of git", () => {
    const none: BoxSync = { team: [], gone: [], yours: [], envs: [], mcp: {}, aws: {} };
    const recipe = (env: string, copy: string): BoxSync => ({
      ...none,
      recipe: [
        { path: 'backend/.env', mode: '444', base64: base64(env), kind: 'link' },
        { path: '.vscode/launch.json', mode: '644', base64: base64(copy), kind: 'copy' },
        // the clone tracks it: the card's own
        { path: 'abe.yaml', mode: '444', base64: base64('board: {}\n'), kind: 'link' },
      ],
    });

    expect(sync(recipe('API_URL=one\n', '{}\n')).exitCode).toBe(0);
    write(join(repo, '.vscode', 'launch.json'), '{ "mine": true }\n');
    expect(sync(recipe('API_URL=two\n', '{}\n')).exitCode).toBe(0);
    expect(readFileSync(join(repo, 'backend', '.env'), 'utf8')).toBe('API_URL=two\n');
    expect(mode(join(repo, 'backend', '.env'))).toBe(0o444);
    expect(readFileSync(join(repo, '.vscode', 'launch.json'), 'utf8')).toBe('{ "mine": true }\n');
    expect(readFileSync(join(repo, 'abe.yaml'), 'utf8')).toBe('board: { provider: azure }\n');
    expect(sh(repo, 'git', 'status', '--porcelain', '--untracked-files=all')).toBe('');
    // the Mac dropped it from the recipe: the link goes, the card's copy stays
    expect(sync(none).exitCode).toBe(0);
    expect(() => statSync(join(repo, 'backend', '.env'))).toThrow();
    expect(readFileSync(join(repo, '.vscode', 'launch.json'), 'utf8')).toBe('{ "mine": true }\n');
    rmSync(join(repo, '.vscode'), { recursive: true });
  });

  test('a path out of the clone is refused before anything is written', () => {
    expect(() =>
      boxSyncPayload({ ...first, yours: [{ path: '../x', mode: '444', base64: '' }] }, base64),
    ).toThrow();
    // a team path that is none of the team's
    expect(() =>
      boxSyncPayload({ ...first, team: [{ path: 'src/a.ts', mode: '444', base64: '' }] }, base64),
    ).toThrow();
  });
});
