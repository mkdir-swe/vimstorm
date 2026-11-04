/**
 * A card's worktree made ready on a fixture monorepo (npm workspaces, a real git worktree): its
 * packages linked from the main checkout, the repo's own into the worktree, `.bin` and `npx`
 * working; a changed lockfile's install reaching the registries alone; files copied in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareWorktree, putFiles, repairTeamFiles } from './worktree-setup';
import { cloneFolder, readyPackages } from './clone-packages';
import { setupPassed, setupReason } from '@abe/core';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const write = (path: string, text: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
};

const pkg = (
  dir: string,
  json: Record<string, unknown>,
  index = 'module.exports = __dirname;\n',
) => {
  write(join(dir, 'package.json'), `${JSON.stringify(json)}\n`);
  write(join(dir, 'index.js'), index);
};

const BIN =
  '#!/usr/bin/env node\nconsole.log(require("path").dirname(require("fs").realpathSync(__filename)));\n';

/** Runs `argv` in `cwd` with this test's node on PATH: its stdout, trimmed. */
const run = (cwd: string, ...argv: string[]) => {
  const ran = Bun.spawnSync(argv, {
    cwd,
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
      npm_config_offline: 'true',
    },
  });

  return ran.exitCode === 0
    ? ran.stdout.toString().trim()
    : `exit ${ran.exitCode}: ${ran.stderr.toString()}`;
};

describe('a worktree whose lockfile is the main checkout’s: its packages linked', () => {
  let root: string;
  let main: string;
  let wt: string;
  let before: string[];

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wts-')));
    main = join(root, 'shop');
    wt = join(root, 'shop-wt', '4-cart');
    pkg(main, { name: 'shop', private: true, workspaces: ['packages/*'] });
    write(join(main, 'package-lock.json'), '{"lockfileVersion":3}\n');
    write(join(main, '.gitignore'), 'node_modules\n.env*\ngenerated/\n');
    pkg(join(main, 'packages', 'ui'), { name: '@acme/ui', bin: { 'ui-tool': 'bin.js' } });
    write(join(main, 'packages', 'ui', 'bin.js'), BIN, 0o755);
    pkg(join(main, 'packages', 'app'), { name: '@acme/app' });
    git(root, 'init', '-q', '-b', 'main', main);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'first');
    // the main checkout's install, as npm made it
    const nm = join(main, 'node_modules');

    pkg(join(nm, 'left-pad'), { name: 'left-pad', version: '1.3.0', bin: { lp: 'bin/lp.js' } });
    write(join(nm, 'left-pad', 'bin', 'lp.js'), BIN, 0o755);
    mkdirSync(join(nm, '.bin'));
    symlinkSync('../left-pad/bin/lp.js', join(nm, '.bin', 'lp'));
    symlinkSync('../@acme/ui/bin.js', join(nm, '.bin', 'ui-tool'));
    mkdirSync(join(nm, '@acme'));
    symlinkSync('../../packages/ui', join(nm, '@acme', 'ui'));
    symlinkSync('../../packages/app', join(nm, '@acme', 'app'));
    write(join(nm, '.package-lock.json'), '{}\n');
    write(join(nm, '.vite', 'deps', '_metadata.json'), '{}\n');
    // a workspace's own: another left-pad, and a link to its sibling
    const appNm = join(main, 'packages', 'app', 'node_modules');

    pkg(join(appNm, 'left-pad'), { name: 'left-pad', version: '1.1.0' });
    mkdirSync(join(appNm, '@acme'), { recursive: true });
    symlinkSync('../../../ui', join(appNm, '@acme', 'ui'));
    write(join(main, '.env.test'), 'VITE_API=http://localhost:3000\n');
    // the install's own folder kept out of git, its Abe env files (ADR 0028) linked, never copied
    write(join(main, '.abe', 'verify.md'), '# verify\n');
    write(join(main, '.abe', 'abe.dev.env'), 'API_KEY=fake\n');
    write(join(main, '.abe', 'abe.test.env'), 'API_KEY=fake-test\n');
    write(join(main, '.git', 'info', 'exclude'), '.abe/\n');
    git(main, 'worktree', 'add', '-q', '-b', 'card/4-cart', wt);
    before = readdirSync(nm, { recursive: true }).map(String).sort();
    const ran = await prepareWorktree({
      checkout: main,
      worktree: wt,
      // its install linked instead, its other steps (codegen) run after
      setup: 'npm ci && mkdir -p generated && echo gen > generated/api.ts',
      env: { PATH: '/usr/bin:/bin', HOME: root },
      copy: [
        { path: '.env.test' },
        { path: '.env.missing' },
        { path: '.abe' },
        { path: '.abe/abe.dev.env' },
        { path: '.abe/abe.test.env' },
        { path: '.abe/abe.prod.env' },
      ],
      tracked: git(wt, 'ls-files').split('\n'),
      timeoutMs: 10_000,
    });

    expect(ran).toEqual({
      run: 'mkdir -p generated && echo gen > generated/api.ts',
      exit: 0,
      output: '',
      how: 'linked',
      from: main,
      copied: ['.env.test', '.abe', '.abe/abe.dev.env', '.abe/abe.test.env'],
    });
    expect(readFileSync(join(wt, 'generated', 'api.ts'), 'utf8')).toBe('gen\n');
    expect(readdirSync(join(wt, '.abe')).sort()).toEqual([
      'abe.dev.env',
      'abe.test.env',
      'verify.md',
    ]);
    // linked: one edit in the main checkout reaches the card
    expect(lstatSync(join(wt, '.abe', 'abe.test.env')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(wt, '.abe', 'abe.test.env'))).toBe(join(main, '.abe', 'abe.test.env'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test.each<[string, string, (main: string, wt: string) => string]>([
    [
      'a third-party package: the checkout’s',
      'node_modules/left-pad',
      (m) => `${m}/node_modules/left-pad`,
    ],
    [
      'the repo’s own package: the worktree’s',
      'node_modules/@acme/ui',
      (_, w) => `${w}/packages/ui`,
    ],
    ['the other one too', 'node_modules/@acme/app', (_, w) => `${w}/packages/app`],
    [
      "a workspace's own third-party package: the checkout's",
      'packages/app/node_modules/left-pad',
      (m) => `${m}/packages/app/node_modules/left-pad`,
    ],
    [
      "a workspace's link to its sibling: the worktree's",
      'packages/app/node_modules/@acme/ui',
      (_, w) => `${w}/packages/ui`,
    ],
    [
      "a tool's bin: the checkout's package",
      'node_modules/.bin/lp',
      (m) => `${m}/node_modules/left-pad/bin/lp.js`,
    ],
    [
      "the repo's own tool: the worktree's",
      'node_modules/.bin/ui-tool',
      (_, w) => `${w}/packages/ui/bin.js`,
    ],
  ])('%s', (_, path, where) => {
    expect(realpathSync(join(wt, path))).toBe(where(main, wt));
  });

  test("node, npx and .bin resolve the repo's own packages in the worktree, the rest in the checkout", () => {
    const app = join(wt, 'packages', 'app');

    expect(run(app, 'node', '-p', "require.resolve('@acme/ui')")).toBe(
      join(wt, 'packages', 'ui', 'index.js'),
    );
    expect(run(app, 'node', '-p', "require('left-pad')")).toBe(
      join(main, 'packages', 'app', 'node_modules', 'left-pad'),
    );
    expect(run(wt, 'npx', '--no-install', 'ui-tool')).toBe(join(wt, 'packages', 'ui'));
    expect(run(wt, 'npx', '--no-install', 'lp')).toBe(
      join(main, 'node_modules', 'left-pad', 'bin'),
    );
    expect(run(wt, join('node_modules', '.bin', 'lp'))).toBe(
      join(main, 'node_modules', 'left-pad', 'bin'),
    );
  });

  test('the checkout untouched; the caches and npm’s own record not shared; git sees nothing new', () => {
    expect(readdirSync(join(main, 'node_modules'), { recursive: true }).map(String).sort()).toEqual(
      before,
    );
    expect(
      ['.vite', '.package-lock.json'].map((f) => existsSync(join(wt, 'node_modules', f))),
    ).toEqual([false, false]);
    expect(readFileSync(join(wt, '.env.test'), 'utf8')).toBe('VITE_API=http://localhost:3000\n');
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  // box parity (3.2.1): the team's files the person changed and has not committed are the card's
  // too, held out of its commits; one the same as the branch's stays the card's own
  test("abe.yaml and .claude/skills as the checkout's uncommitted changes: held out, nothing to commit, the rest the card's", async () => {
    const base = join(root, 'shop-team');
    const card = join(root, 'shop-wt', '6-team');

    git(main, 'worktree', 'add', '-q', '-b', 'team', base);
    write(join(base, 'abe.yaml'), 'board: { provider: azure }\n');
    write(join(base, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run\n');
    write(join(base, '.claude', 'skills', 'old', 'SKILL.md'), '# old\n');
    write(join(base, '.claude', 'skills', 'verify-shop', 'SKILL.md'), '# verify\n');
    git(base, 'add', 'abe.yaml', '.claude');
    git(base, 'commit', '-q', '-m', 'team files');
    git(main, 'worktree', 'add', '-q', '-b', 'card/6-team', card, 'team');
    // the person's edits in the main checkout: one changed, one gone, one new, one the same
    write(join(main, 'abe.yaml'), 'board: { provider: local }\n');
    write(join(main, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run, edited\n');
    write(join(main, '.claude', 'skills', 'new', 'SKILL.md'), '# new\n');
    write(join(main, '.claude', 'skills', 'verify-shop', 'SKILL.md'), '# verify\n');
    const mainStatus = git(main, 'status', '--porcelain', '--untracked-files=all');
    const ran = await prepareWorktree({
      checkout: main,
      worktree: card,
      setup: null,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      copy: [
        { path: 'abe.yaml', over: true },
        { path: '.claude/skills', over: true },
        { path: '.abe/abe.dev.env' },
      ],
      tracked: [],
      timeoutMs: 10_000,
    });

    expect(ran?.copied).toEqual(['abe.yaml', '.claude/skills', '.abe/abe.dev.env']);
    expect([
      readFileSync(join(card, 'abe.yaml'), 'utf8'),
      readFileSync(join(card, '.claude', 'skills', 'run-app', 'SKILL.md'), 'utf8'),
      existsSync(join(card, '.claude', 'skills', 'old', 'SKILL.md')),
      readFileSync(join(card, '.claude', 'skills', 'new', 'SKILL.md'), 'utf8'),
      git(card, 'status', '--porcelain', '--untracked-files=all'),
    ]).toEqual(['board: { provider: local }\n', '# run, edited\n', false, '# new\n', '']);
    expect(git(card, 'ls-files', '-v', 'abe.yaml', '.claude').split('\n').filter(Boolean)).toEqual([
      'S .claude/skills/old/SKILL.md',
      'S .claude/skills/run-app/SKILL.md',
      'H .claude/skills/verify-shop/SKILL.md',
      'S abe.yaml',
    ]);
    // the main checkout still shows the person's changes: nothing went in its shared exclude
    expect(git(main, 'status', '--porcelain', '--untracked-files=all')).toBe(mainStatus);
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).not.toContain('new');
    // what the agent commits never carries them; the Verification pack is its own to change
    write(join(card, '.claude', 'skills', 'verify-shop', 'SKILL.md'), '# verify, kept\n');
    git(card, 'add', '-A');
    git(card, 'commit', '-q', '-m', 'work');
    expect(git(card, 'show', '--name-only', '--format=', 'HEAD')).toBe(
      '.claude/skills/verify-shop/SKILL.md',
    );
  });

  // serve runs it on its only loop: a hook arriving meanwhile is answered, never held behind git
  test("the team's files go in without holding the loop: a timer set before fires before they are in", async () => {
    const card = join(root, 'shop-wt', '7-loop');

    git(main, 'worktree', 'add', '-q', '-b', 'card/7-loop', card);
    write(join(main, 'abe.yaml'), 'board: { provider: local }\n');
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
    }, 0);
    const put = await putFiles(main, card, [{ path: 'abe.yaml', over: true }]);

    clearTimeout(timer);
    expect([fired, put.copied]).toEqual([true, ['abe.yaml']]);
  });
});

// The team's files a card's worktree gets as the main checkout has them (not committed yet: an
// install run there), whatever abe.yaml says or where the card was launched from; one that could
// not go in said, the rest in all the same.
describe("a prototype's worktree: the main checkout's packages cloned, copy on write (ADR 0039)", () => {
  let root: string;
  let main: string;
  let wt: string;
  let setup: Awaited<ReturnType<typeof prepareWorktree>>;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wtc-')));
    main = join(root, 'shop');
    wt = join(root, 'shop-wt', 'proto-1a2b3c-vat');
    pkg(main, { name: 'shop', private: true, workspaces: ['packages/*'] });
    write(join(main, 'package-lock.json'), '{"lockfileVersion":3}\n');
    write(join(main, '.gitignore'), 'node_modules\n');
    pkg(join(main, 'packages', 'ui'), { name: '@acme/ui' });
    pkg(join(main, 'packages', 'app'), { name: '@acme/app' });
    git(root, 'init', '-q', '-b', 'main', main);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'first');
    // npm's install: a package, its own nested one, the workspaces' relative links
    const nm = join(main, 'node_modules');

    pkg(join(nm, 'left-pad'), { name: 'left-pad', version: '1.3.0' });
    pkg(join(nm, 'left-pad', 'node_modules', 'pad-core'), { name: 'pad-core' });
    mkdirSync(join(nm, '@acme'));
    symlinkSync('../../packages/ui', join(nm, '@acme', 'ui'));
    symlinkSync('../../packages/app', join(nm, '@acme', 'app'));
    write(join(nm, '.vite', 'deps', '_metadata.json'), '{}\n');
    const appNm = join(main, 'packages', 'app', 'node_modules');

    pkg(join(appNm, 'left-pad'), { name: 'left-pad', version: '1.1.0' });
    mkdirSync(join(appNm, '@acme'), { recursive: true });
    symlinkSync('../../../ui', join(appNm, '@acme', 'ui'));
    git(main, 'worktree', 'add', '-q', '-b', 'proto/1a2b3c-vat', wt);
    setup = await prepareWorktree({
      checkout: main,
      worktree: wt,
      setup: null,
      env: { PATH: '/usr/bin:/bin', HOME: root },
      copy: [],
      tracked: git(wt, 'ls-files').split('\n'),
      timeoutMs: 10_000,
      packages: 'clone',
    });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("cloned, no install: the manifests are the checkout's", () => {
    expect(setup).toEqual({ run: '', exit: 0, output: '', how: 'cloned', from: main, copied: [] });
  });

  test.each<[string, string, (wt: string) => string]>([
    [
      'a third-party package: its own copy',
      'node_modules/left-pad',
      (w) => `${w}/node_modules/left-pad`,
    ],
    [
      "a package's nested one, with it",
      'node_modules/left-pad/node_modules/pad-core',
      (w) => `${w}/node_modules/left-pad/node_modules/pad-core`,
    ],
    [
      "a workspace's relative link: into the worktree",
      'node_modules/@acme/ui',
      (w) => `${w}/packages/ui`,
    ],
    [
      "a workspace's own node_modules, its sibling's link too",
      'packages/app/node_modules/@acme/ui',
      (w) => `${w}/packages/ui`,
    ],
    [
      "a workspace's own package",
      'packages/app/node_modules/left-pad',
      (w) => `${w}/packages/app/node_modules/left-pad`,
    ],
    [
      'the caches its own as well',
      'node_modules/.vite/deps/_metadata.json',
      (w) => `${w}/node_modules/.vite/deps/_metadata.json`,
    ],
  ])('%s', (_, path, where) => {
    expect(realpathSync(join(wt, path))).toBe(where(wt));
  });

  test("node resolves every package in the worktree; a write there leaves the checkout's as it was", () => {
    expect(run(join(wt, 'packages', 'app'), 'node', '-p', "require.resolve('@acme/ui')")).toBe(
      join(wt, 'packages', 'ui', 'index.js'),
    );
    expect(run(wt, 'node', '-p', "require('left-pad')")).toBe(join(wt, 'node_modules', 'left-pad'));
    writeFileSync(join(wt, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    expect(readFileSync(join(main, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe(
      'module.exports = __dirname;\n',
    );
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });

  test('the install runs only once the manifests differ, until it passes', async () => {
    const runs: string[] = [];
    let exit = 0;
    const ready = () =>
      readyPackages({
        checkout: main,
        worktree: wt,
        env: { PATH: '/usr/bin:/bin', HOME: root },
        install: (cmd) => {
          runs.push(cmd);

          return Promise.resolve({ run: cmd, exit, output: '' });
        },
      });

    // the same: nothing cloned again, nothing installed
    expect(await ready()).toEqual({ cloned: [], notCloned: {}, installed: null });
    // a package added in the prototype: its install, then none
    pkg(join(wt, 'packages', 'app'), { name: '@acme/app', dependencies: { 'left-pad': '^1' } });
    exit = 1;
    expect((await ready()).installed).toEqual({ run: 'npm install', exit: 1, output: '' });
    exit = 0;
    expect((await ready()).installed?.run).toBe('npm install');
    expect((await ready()).installed).toBeNull();
    expect(runs).toEqual(['npm install', 'npm install']);
  });

  test('a folder copied copy on write, its links kept as they are', async () => {
    const to = join(root, 'copied', 'node_modules');

    expect(['clonefile', 'cp -c', 'cp']).toContain(
      (await cloneFolder(join(main, 'node_modules'), to)) ?? 'none',
    );
    expect(readlinkSync(join(to, '@acme', 'ui'))).toBe('../../packages/ui');
  });
});

describe("the team's files a card's worktree gets from the main checkout", () => {
  const TEAM = [
    { path: 'abe.yaml', over: true as const },
    { path: 'abe/workflows', over: true as const },
    { path: '.claude/skills', over: true as const },
    { path: 'CLAUDE.md', over: true as const },
    { path: '.abe/abe.dev.env' },
  ];
  /** A main checkout with one commit and the install's files untracked, and a card's worktree. */
  const repo = () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-team-')));
    const main = join(root, 'shop');

    write(join(main, 'README.md'), '# shop\n');
    write(join(main, '.gitignore'), '.abe/\n');
    git(root, 'init', '-q', '-b', 'main', main);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'first');
    write(join(main, 'abe.yaml'), 'board: { provider: local }\n');
    write(join(main, 'abe', 'workflows', 'feature.yaml'), 'id: feature\n');
    write(join(main, '.claude', 'skills', 'run-app', 'SKILL.md'), '# run\n');
    write(join(main, 'CLAUDE.md'), '# notes\n');
    write(join(main, '.abe', 'abe.dev.env'), 'API_KEY=fake\n');
    const card = (name: string) => {
      const wt = join(root, 'shop-wt', name);

      git(main, 'worktree', 'add', '-q', '-b', `card/${name}`, wt);

      return wt;
    };

    return { root, main, card };
  };
  type Row = {
    /** What happened before: the checkout the launch names, and the worktree it makes ready. */
    arrange: (r: ReturnType<typeof repo>) => Promise<{ checkout: string; wt: string }>;
    /** True: a worktree made before, started again (`repairTeamFiles`). */
    repair?: true;
    copied: string[];
    notCopied: Record<string, string>;
    /** The worktree's files after, by path from its top (null: none there). */
    files: Record<string, string | null>;
  };

  test.each<[string, Row]>([
    [
      "launched from another card's worktree: the main checkout's, the untracked ones that card holds out among them",
      {
        arrange: async ({ main, card }) => {
          const other = card('1-other');

          await putFiles(main, other, TEAM);

          return { checkout: other, wt: card('2-new') };
        },
        copied: ['abe.yaml', 'abe/workflows', '.claude/skills', 'CLAUDE.md', '.abe/abe.dev.env'],
        notCopied: {},
        files: {
          'abe.yaml': 'board: { provider: local }\n',
          '.claude/skills/run-app/SKILL.md': '# run\n',
        },
      },
    ],
    [
      'abe.yaml gone while the install writes it again: the rest still go in',
      {
        arrange: ({ main, card }) => {
          rmSync(join(main, 'abe.yaml'));

          return Promise.resolve({ checkout: main, wt: card('3-gone') });
        },
        copied: ['abe/workflows', '.claude/skills', 'CLAUDE.md', '.abe/abe.dev.env'],
        notCopied: {},
        files: { 'abe.yaml': null, 'CLAUDE.md': '# notes\n' },
      },
    ],
    [
      'abe.yaml half written, not YAML: copied as it is, nothing read from it',
      {
        arrange: ({ main, card }) => {
          write(join(main, 'abe.yaml'), 'board: { provider: lo');

          return Promise.resolve({ checkout: main, wt: card('4-half') });
        },
        copied: ['abe.yaml', 'abe/workflows', '.claude/skills', 'CLAUDE.md', '.abe/abe.dev.env'],
        notCopied: {},
        files: { 'abe.yaml': 'board: { provider: lo' },
      },
    ],
    [
      "hidden in the main checkout by the person's own excludes: put in whole, held out",
      {
        arrange: ({ root, main, card }) => {
          // git's HOME is the checkout here: its global excludes file, `.config/git/ignore`
          write(join(main, '.config', 'git', 'ignore'), '.claude/\n.config/\n');
          write(join(root, '.config', 'git', 'ignore'), '.claude/\n');

          return Promise.resolve({ checkout: main, wt: card('5-hidden') });
        },
        copied: ['abe.yaml', 'abe/workflows', '.claude/skills', 'CLAUDE.md', '.abe/abe.dev.env'],
        notCopied: {},
        files: { '.claude/skills/run-app/SKILL.md': '# run\n' },
      },
    ],
    [
      'one that cannot go in: said with why, the rest go in all the same',
      {
        arrange: ({ card }) => {
          const wt = card('6-blocked');

          // a file where the skills' folder goes
          write(join(wt, '.claude'), 'not a folder\n');

          return Promise.resolve({ checkout: wt.replace(/-wt\/6-blocked$/, ''), wt });
        },
        copied: ['abe.yaml', 'abe/workflows', 'CLAUDE.md', '.abe/abe.dev.env'],
        notCopied: { '.claude/skills': 'ENOTDIR: not a directory' },
        files: { 'abe.yaml': 'board: { provider: local }\n', '.claude': 'not a folder\n' },
      },
    ],
    [
      'a worktree made before, missing them: what it lacks put in and held out, its own edit kept',
      {
        arrange: async ({ main, card }) => {
          const wt = card('7-reused');

          await putFiles(main, wt, TEAM);
          // the card's own CLAUDE.md, and the team's skills and workflows gone from it
          write(join(wt, 'CLAUDE.md'), "# the card's\n");
          rmSync(join(wt, '.claude'), { recursive: true });
          rmSync(join(wt, 'abe'), { recursive: true });

          return { checkout: main, wt };
        },
        repair: true,
        copied: ['abe/workflows', '.claude/skills'],
        notCopied: {},
        files: { 'CLAUDE.md': "# the card's\n", 'abe/workflows/feature.yaml': 'id: feature\n' },
      },
    ],
  ])('%s', async (_, row) => {
    const r = repo();

    try {
      const { checkout, wt } = await row.arrange(r);
      const put =
        row.repair === true
          ? await repairTeamFiles(checkout, wt, TEAM)
          : await putFiles(checkout, wt, TEAM);

      expect({ copied: put.copied, notCopied: put.notCopied }).toEqual({
        copied: row.copied,
        notCopied: row.notCopied,
      });
      expect(
        Object.fromEntries(
          Object.keys(row.files).map((f) => {
            const at = join(wt, f);

            return [f, existsSync(at) ? readFileSync(at, 'utf8') : null];
          }),
        ),
      ).toEqual(row.files);
      // held out of the card's commits, whichever way they went in
      if (Object.keys(row.notCopied).length === 0)
        expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });

  test('a launch whose team files did not all go in: its setup failed, saying which and why', async () => {
    const r = repo();

    try {
      const wt = r.card('8-said');

      write(join(wt, '.claude'), 'not a folder\n');
      const ran = await prepareWorktree({
        checkout: r.main,
        worktree: wt,
        setup: null,
        env: { PATH: '/usr/bin:/bin', HOME: r.root },
        copy: TEAM,
        tracked: [],
        timeoutMs: 10_000,
      });

      expect(ran?.notCopied).toEqual({ '.claude/skills': 'ENOTDIR: not a directory' });
      expect(ran === null ? true : setupPassed(ran)).toBe(false);
      expect(ran === null ? null : setupReason(ran)).toContain(
        '.claude/skills (ENOTDIR: not a directory)',
      );
    } finally {
      rmSync(r.root, { recursive: true, force: true });
    }
  });
});

describe('a worktree whose lockfile changed: its install, the registries alone reachable', () => {
  let root: string;
  let registry: Server;
  let port: number;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wtr-')));
    registry = createServer((_, res) => res.end('ok'));
    await new Promise<void>((up) => registry.listen(0, '127.0.0.1', up));
    const at = registry.address();

    port = typeof at === 'object' && at !== null ? at.port : 0;
  });
  afterAll(async () => {
    await new Promise((down) => registry.close(down));
    rmSync(root, { recursive: true, force: true });
  });

  test("through the proxy to the registry the checkout names; anywhere else, or around it, refused; the test browsers' downloads skipped", async () => {
    const main = join(root, 'shop');
    const wt = join(root, 'shop-wt', '5-cart');

    pkg(main, { name: 'shop' });
    write(join(main, 'package-lock.json'), '{"lockfileVersion":3}\n');
    write(join(main, '.gitignore'), 'node_modules\n');
    // the registry named in the checkout: the worktree's own .npmrc is the agent's, never read
    write(join(main, '.npmrc'), `registry=http://127.0.0.1:${port}/\n`);
    git(root, 'init', '-q', '-b', 'main', main);
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'first');
    mkdirSync(join(main, 'node_modules', 'left-pad'), { recursive: true });
    git(main, 'worktree', 'add', '-q', '-b', 'card/5-cart', wt);
    write(join(wt, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
    write(join(wt, '.npmrc'), 'registry=https://evil.example/\n');
    const curl = `curl -s -o /dev/null --max-time 3 -w '%{http_code}'`;
    const ran = await prepareWorktree({
      checkout: main,
      worktree: wt,
      setup: [
        `echo "tunnel $(${curl} -p http://127.0.0.1:${port}/left-pad)"`,
        `echo "forward $(${curl} http://127.0.0.1:${port}/left-pad)"`,
        `echo "elsewhere $(${curl} http://evil.example/)"`,
        `echo "around $(${curl} --noproxy '*' http://127.0.0.1:${port}/left-pad)"`,
        // their binaries are in the person's cache, shared with the main checkout
        'echo "skip $CYPRESS_INSTALL_BINARY $PUPPETEER_SKIP_DOWNLOAD $PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"',
      ].join('\n'),
      env: { PATH: '/usr/bin:/bin', HOME: root },
      copy: [],
      tracked: ['package.json'],
      timeoutMs: 20_000,
    });

    expect(ran).toMatchObject({ how: 'ran', exit: 0, copied: [] });
    expect(ran?.output).toBe(
      'tunnel 200\nforward 200\nelsewhere 403\naround 000\nskip 0 true 1\n\n[network refused, not a package registry: evil.example]\n',
    );
    expect(existsSync(join(wt, 'node_modules'))).toBe(false);
  });
});
