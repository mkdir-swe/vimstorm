/**
 * Box parity from the Mac (3.2.1): what `boxSyncer` builds of a main checkout, with the install's
 * fakes and a fake Claude Code store. Prod's Abe env file and aws keys never go while prod is off;
 * what is this Mac's alone stays; no token, key or value is ever in what the box is told (an argv)
 * or in what serve logs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BoxSyncPort, DEFAULT_HOOKS } from '@abe/core';
import { z } from 'zod';
import { git, installFakes } from '@abe/testing';
import { startSettings, type SettingsService } from '../layer/settings';
import { boxSyncer, type BuiltSync } from './box-sync';

const SECRETS = [
  'dev-secret',
  'test-secret',
  'prod-secret',
  'sentry-access',
  'sentry-refresh',
  'fake-secret',
  'fake-id',
  'fake-token',
];

describe("boxSyncer: what a box's workspace gets of this Mac's", () => {
  let root: string;
  let main: string;
  let settings: SettingsService;
  let logged: string[];
  let pushed: string[];
  let renewed: string[];
  let expiresAt: number;
  const now = 1_000_000_000;

  const port: BoxSyncPort = {
    claudeStore: () =>
      Promise.resolve({
        mcpOAuth: {
          'sentry|0a1b2c3d4e5f6a7b': {
            serverName: 'sentry',
            serverUrl: 'https://mcp.sentry.dev/mcp',
            accessToken: 'sentry-access',
            refreshToken: 'sentry-refresh',
            expiresAt,
          },
        },
      }),
    push: (_, payload) => {
      pushed.push(payload);

      return Promise.resolve({ ok: true, data: null });
    },
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  const syncer = (envMap?: Parameters<typeof boxSyncer>[0]['envMap']) => {
    const fakes = installFakes({ env: { HOME: root, PATH: '/usr/bin:/bin' }, dir: root });

    fakes.expired.set('shop-test', 'its login expired: abe login aws --profile shop-test');

    return boxSyncer({
      port,
      settings,
      repo: {
        ...fakes.repo,
        mcp: (_, name) => {
          renewed.push(name);

          return Promise.resolve('connected');
        },
      },
      checked: () => Promise.resolve(['sentry']),
      home: root,
      ...(envMap === undefined ? {} : { envMap }),
      now: () => now,
      log: (m) => logged.push(m),
    });
  };
  const built = async (): Promise<BuiltSync> => {
    const b = await syncer().build(main);

    if (!b.ok) throw new Error(b.error.message);

    return b.data;
  };
  const decoded = (b: BuiltSync) =>
    Object.fromEntries(
      [...b.sync.team, ...b.sync.yours].map((f) => [
        f.path,
        Buffer.from(f.base64, 'base64').toString('utf8'),
      ]),
    );

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-bsync-'));
    main = join(root, 'shop');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    write(
      join(main, 'abe.yaml'),
      'sources:\n  - { name: sentry, transport: http, url: https://mcp.sentry.dev/mcp }\n',
    );
    write(join(main, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run\n');
    for (const env of ['dev', 'test', 'prod'])
      write(join(main, '.abe', `abe.${env}.env`), `API_KEY=${env}-secret\n`);
    write(
      join(main, '.abe', 'settings.local.yaml'),
      'credentials:\n  dev: { awsProfile: shop-dev }\n  test: { awsProfile: shop-test }\n  prod: { awsProfile: shop-prod }\nautoMerge: true\n',
    );
    settings = startSettings({
      places: { configDir: join(root, 'mine'), home: root },
      emit: () => undefined,
      every: 3_600_000,
    });
  });
  afterAll(() => {
    settings.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("prod off: never its Abe env file nor its aws keys; the team's files and yours, without this Mac's alone", async () => {
    logged = [];
    pushed = [];
    renewed = [];
    expiresAt = now + 3_600_000;
    const b = await built();
    const files = decoded(b);

    expect(Object.keys(files).sort()).toEqual([
      '.abe/abe.dev.env',
      '.abe/abe.test.env',
      '.abe/settings.local.yaml',
      '.claude/skills/run-app/SKILL.md',
      'abe.yaml',
    ]);
    expect(b.sync.envs).toEqual(['dev', 'test']);
    expect(Object.keys(b.sync.aws)).toEqual(['dev']);
    expect(JSON.stringify(b)).not.toContain('prod-secret');
    // your aws profiles are this Mac's alone; the rest of yours goes
    expect(files['.abe/settings.local.yaml']).not.toContain('awsProfile');
    expect(files['.abe/settings.local.yaml']).toContain('autoMerge: true');
    expect(Object.values(b.sync.mcp).map((a) => a.accessToken)).toEqual(['sentry-access']);
    expect(renewed).toEqual([]);
    expect(b.told).toEqual({
      repo: 'sources:\n  - { name: sentry, transport: http, url: https://mcp.sentry.dev/mcp }\n',
      checked: ['sentry'],
      envFiles: ['dev', 'test'],
      // nothing committed yet: every team file is the person's change
      locked: ['.claude/skills/run-app/SKILL.md', 'abe.yaml'],
      // no commit: what the box's abe run may run is today's places
      hooks: DEFAULT_HOOKS,
    });
    expect(b.due).toBe(now + 30 * 60_000);
  });

  test('prod on: its file and keys go too', async () => {
    write(
      join(main, '.abe', 'settings.local.yaml'),
      'agents.prod: true\ncredentials:\n  prod: { awsProfile: shop-prod }\n',
    );
    settings.poll();
    const b = await built();

    expect(b.sync.envs).toEqual(['dev', 'test', 'prod']);
    expect(Object.keys(b.sync.aws)).toEqual(['prod']);
    expect(decoded(b)['.abe/abe.prod.env']).toBe('API_KEY=prod-secret\n');
  });

  test("a token about to end: this Mac's Claude Code renews it first; no secret in what the box is told or in serve's log", async () => {
    write(
      join(main, '.abe', 'settings.local.yaml'),
      'credentials:\n  test: { awsProfile: shop-test }\n',
    );
    settings.poll();
    logged = [];
    renewed = [];
    expiresAt = now + 60_000;
    const s = syncer();
    const b = await s.build(main);

    if (!b.ok) throw new Error(b.error.message);
    expect(renewed).toEqual(['sentry']);
    // still ending (the fake store did not move): said by name, sent all the same
    expect(logged).toEqual([
      'box sync: no live token for sentry (sign in again)',
      'box sync: no aws keys for test (profile shop-test)',
    ]);
    await s.push(['true'], b.data);
    const said = [...logged, JSON.stringify(b.data.told)].join('\n');

    for (const secret of SECRETS) expect(said).not.toContain(secret);
    // they cross on stdin alone: the access token, never the refresh token
    const sent = z
      .object({ secrets: z.array(z.object({ b: z.string() })) })
      .parse(JSON.parse(pushed.at(-1) ?? '{}'))
      .secrets.map((x) => Buffer.from(x.b, 'base64').toString('utf8'))
      .join('\n');

    expect(sent).toContain('sentry-access');
    expect(sent).not.toContain('sentry-refresh');
  });

  test("only the team's files the person changed and has not committed go: one deleted goes as gone", async () => {
    const s = syncer();
    const before = await s.mark(main);

    write(join(main, '.claude', 'skills', 'verify-shop', 'SKILL.md'), '# verify\n');
    git(main, 'add', 'abe.yaml', '.claude');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@x.test', 'commit', '-q', '-m', 'team');
    // a commit moves the cheap look
    expect(await s.mark(main)).not.toBe(before);
    write(join(main, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run, edited\n');
    rmSync(join(main, '.claude', 'skills', 'verify-shop', 'SKILL.md'));
    const b = await built();

    expect(b.sync.team.map((f) => f.path)).toEqual(['.claude/skills/run-app/SKILL.md']);
    expect(b.sync.gone).toEqual(['.claude/skills/verify-shop/SKILL.md']);
    expect(b.told.locked).toEqual([
      '.claude/skills/run-app/SKILL.md',
      '.claude/skills/verify-shop/SKILL.md',
    ]);
  });

  test('the cheap look moves with an edit to a skill', async () => {
    const s = syncer();
    const before = await s.mark(main);

    await Bun.sleep(5);
    write(join(main, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run, edited\n');
    expect(await s.mark(main)).not.toBe(before);
    expect(await s.mark(main)).toBe(await s.mark(main));
  });

  test("the repo's worktree recipe: its files from this Mac's main checkout, prod's left out while prod is off, the script as a link", async () => {
    write(
      join(main, 'abe.yaml'),
      'worktree:\n  link: [backend/.env, backend/.env.prod]\n  copy: [.vscode]\nhooks:\n  worktree-setup: abe/scripts/worktree-setup\n',
    );
    write(join(main, 'backend', '.env'), 'API_URL=dev-secret\n');
    write(join(main, 'backend', '.env.prod'), 'API_URL=prod-secret\n');
    write(join(main, '.vscode', 'launch.json'), '{}\n');
    write(join(main, 'abe', 'scripts', 'worktree-setup'), '#!/bin/sh\n');
    chmodSync(join(main, 'abe', 'scripts', 'worktree-setup'), 0o755);
    write(join(main, '.abe', 'settings.local.yaml'), 'autoMerge: true\n');
    settings.poll();
    logged = [];
    const s = syncer(() =>
      Promise.resolve([
        { path: 'backend/.env', to: ['dev', 'test'] },
        { path: 'backend/.env.prod', to: ['prod'] },
      ]),
    );
    const before = await s.mark(main);
    const b = await s.build(main);

    if (!b.ok) throw new Error(b.error.message);
    expect(
      (b.data.sync.recipe ?? []).map((f) => [
        f.path,
        f.kind,
        f.mode,
        Buffer.from(f.base64, 'base64').toString('utf8'),
      ]),
    ).toEqual([
      ['backend/.env', 'link', '444', 'API_URL=dev-secret\n'],
      ['abe/scripts/worktree-setup', 'link', '555', '#!/bin/sh\n'],
      ['.vscode/launch.json', 'copy', '644', '{}\n'],
    ]);
    expect(JSON.stringify(b.data)).not.toContain('prod-secret');
    expect(logged).toContain(
      'box sync: backend/.env.prod not synced (feeds only prod, off for agents)',
    );
    // an edit to a recipe file on this Mac moves the cheap look: the next turn syncs it again
    await Bun.sleep(5);
    write(join(main, 'backend', '.env'), 'API_URL=dev-secret-2\n');
    expect(await s.mark(main)).not.toBe(before);
  });

  test("a grouped recipe places its env files itself: prod's group left out while prod is off, the record's map unread", async () => {
    write(
      join(main, 'abe.yaml'),
      'worktree:\n  link:\n    all: [frontend/.env]\n    dev: [backend/.env]\n    prod: [backend/.env.prod]\n',
    );
    write(join(main, 'frontend', '.env'), 'PUBLIC_URL=http://localhost:4000\n');
    write(join(main, 'backend', '.env'), 'API_URL=dev-secret\n');
    write(join(main, 'backend', '.env.prod'), 'API_URL=prod-secret\n');
    settings.poll();
    logged = [];
    // an older install's map on this Mac: it would place prod's file in dev
    const b = await syncer(() =>
      Promise.resolve([{ path: 'backend/.env.prod', to: ['dev'] }]),
    ).build(main);

    if (!b.ok) throw new Error(b.error.message);
    expect((b.data.sync.recipe ?? []).map((f) => [f.path, f.kind])).toEqual([
      ['frontend/.env', 'link'],
      ['backend/.env', 'link'],
    ]);
    expect(JSON.stringify(b.data)).not.toContain('prod-secret');
    expect(logged).toContain(
      'box sync: backend/.env.prod not synced (worktree.link.prod: prod is off for agents)',
    );
  });

  test("what the box's abe run may run: the committed abe.yaml's hook points, never the working copy's; a moved script's folder syncs", async () => {
    write(join(main, 'abe.yaml'), 'hooks:\n  start: scripts/dev/start\n');
    write(join(main, 'scripts', 'dev', 'start'), '#!/bin/sh\n');
    git(main, 'add', 'abe.yaml', 'scripts');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@x.test', 'commit', '-q', '-m', 'hooks');
    write(join(main, 'abe.yaml'), 'hooks:\n  start: elsewhere/start\n');
    write(join(main, 'scripts', 'dev', 'start'), '#!/bin/sh\necho moved\n');
    settings.poll();
    const b = await built();

    expect(b.told.hooks?.start).toBe('scripts/dev/start');
    expect(b.sync.team.map((f) => f.path)).toContain('scripts/dev/start');
  });
});
