import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Image } from '../ports';
import {
  basePlan,
  baseLabels,
  branchOf,
  cardBranch,
  isBusy,
  cloneScript,
  cardOfSession,
  databaseSql,
  databaseUrl,
  dropDatabaseSql,
  excludePlaceholders,
  JAIL_PLACEHOLDERS,
  LEGACY_NAMES,
  PG_HBA,
  workspaceNames,
  SANDBOX_PLACEHOLDERS,
  parseCard,
  workspaceImage,
  workspaceImageCurrent,
  stateOf,
  type WorkspaceState,
  claudeFolderShell,
} from './workspace';

describe("a card's branch", () => {
  test.each([
    ['101', 'Cart total is wrong', 'card/101-cart-total-is-wrong'],
    ['7', 'Fix: the stock badge, on every page & then some', 'card/7-fix-the-stock-badge-on'],
    ['42', 'Café crème', 'card/42-cafe-creme'],
    ['42', '!!!', 'card/42'],
    ['42', undefined, 'card/42'],
  ])('card %s titled %j: %s', (card, title, branch) => {
    expect(cardBranch(card, title)).toBe(branch);
  });
});

describe('a card id', () => {
  test.each([
    ['101', '101'],
    ['AB-12', 'AB-12'],
    ['-1', undefined],
    ['1;rm', undefined],
    ['a/b', undefined],
  ])('%j: %j', (text, card) => {
    expect(parseCard(text)).toBe(card);
  });
});

test("a repo's workspace image is named for it, lowercase", () => {
  expect(workspaceImage('mkdir-swe/Demo-Shop')).toBe('abe-workspace-mkdir-swe-demo-shop:latest');
});

describe("a container's state as the workspace's", () => {
  test.each<[string, WorkspaceState]>([
    ['running', 'running'],
    ['restarting', 'running'],
    ['created', 'stopped'],
    ['exited', 'stopped'],
    ['paused', 'failed'],
    ['dead', 'failed'],
    ['removing', 'failed'],
  ])('%s: %s', (docker, state) => {
    expect(stateOf(docker)).toBe(state);
  });
});

describe('the clone, run in the workspace image', () => {
  test("from the box's mirror on the card's branch, with .scratch kept out of git", () => {
    const script = cloneScript('mkdir-swe/demo-shop', 'card/101-cart', true);

    expect(script).toContain('if [ ! -d /workspace/repo/.git ]; then');
    expect(script).toContain('git clone -q /src.git /workspace/.clone');
    expect(script).toContain('mv /workspace/.clone /workspace/repo');
    expect(script.split('\n').at(-1)).toBe('git -C /workspace/repo branch --show-current');
    expect(script).toContain("git checkout -q 'card/101-cart'");
    expect(script).toContain("git checkout -q -b 'card/101-cart'");
    expect(script).toContain(
      "git remote set-url origin 'https://github.com/mkdir-swe/demo-shop.git'",
    );
    expect(script).toContain('mkdir -p .scratch');
  });

  test("shared with the script user, but git's and Claude Code's own files are the session user's", () => {
    const script = cloneScript('mkdir-swe/demo-shop', 'card/101-cart', true);
    const lines = script.split('\n');

    // What the clone makes is group-writable for abe-work (the script user's group)…
    expect(lines[1]).toBe('umask 002');
    // …but git's files never: whatever umask the session writes with, git makes them 0644 / 0755.
    expect(script).toContain('git -C /workspace/repo config core.sharedRepository 0644');
    expect(script).toContain('chmod -R go-w /workspace/repo/.git');
    // Claude Code's project settings: read by the script user (a check walking the tree, eslint .),
    // never written; the local settings file the session user's alone.
    expect(script).toContain(claudeFolderShell('/workspace/repo/.claude'));
    // Sticky: the script user renames or replaces none of the session user's entries there.
    expect(script).toContain('chmod +t /workspace /workspace/repo');
    // A volume from before the script user is given to the group once (a mark), not through a
    // link, never git's or Claude Code's folders.
    expect(script).toContain('[ -e /workspace/.abe-shared ] ||');
    expect(script).toContain(
      '\\( -path /workspace/repo/.git -o -path /workspace/repo/.claude -o -path /workspace/repo-base \\) -prune',
    );
    // Only on an image that has the group (an older base has none).
    expect(script).toContain('if getent group abe-work >/dev/null 2>&1; then');
  });

  test('with no mirror it only says whether a clone is there', () => {
    const script = cloneScript('mkdir-swe/demo-shop', 'card/101-cart', false);

    expect(script).not.toContain('git clone');
    expect(script).toContain('exit 3');
  });
});

describe("the sandbox's placeholders, kept out of git", () => {
  const sh = (script: string, cwd: string) => {
    const ran = Bun.spawnSync(['sh', '-ec', script], { cwd });

    if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());

    return ran.stdout.toString();
  };

  test('every empty mount point is unseen by git, a real file still seen, and run again nothing is added', () => {
    const repo = mkdtempSync(join(tmpdir(), 'placeholders-'));

    try {
      sh('git init -q . && mkdir .claude && touch README.md', repo);
      // What the sandbox leaves when they are missing: empty files (its own, read-only).
      for (const name of SANDBOX_PLACEHOLDERS) writeFileSync(join(repo, name), '');
      // What the jail leaves when what decides reach is missing: the same, in `.abe`.
      mkdirSync(join(repo, '.abe'));
      for (const name of JAIL_PLACEHOLDERS) writeFileSync(join(repo, name), '');
      // A repo's own nested one is no placeholder: still seen.
      mkdirSync(join(repo, 'web'));
      writeFileSync(join(repo, 'web', '.npmrc'), 'x');
      writeFileSync(join(repo, 'web', '.mcp.json'), '{}');
      const script = excludePlaceholders(repo).join('\n');

      sh(script, repo);
      sh(script, repo);
      expect(sh('git status --porcelain --untracked-files=all', repo).split('\n').sort()).toEqual([
        '',
        '?? README.md',
        '?? web/.mcp.json',
        '?? web/.npmrc',
      ]);
      const exclude = readFileSync(join(repo, '.git/info/exclude'), 'utf8').split('\n');

      for (const name of [...SANDBOX_PLACEHOLDERS, ...JAIL_PLACEHOLDERS])
        expect(exclude.filter((line) => line === `/${name}`)).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("Claude Code's own folder in the clone is unseen by git (its writes, writers' worktrees, the sandbox's names there), a tracked file in it still seen", () => {
    const repo = mkdtempSync(join(tmpdir(), 'claude-folder-'));

    try {
      sh(
        'git init -q . && mkdir .claude && echo a > .claude/settings.json && git add . && git -c user.name=t -c user.email=t@t commit -qm x',
        repo,
      );
      mkdirSync(join(repo, '.claude', '.cc-writes'));
      writeFileSync(join(repo, '.claude', '.cc-writes', 'w'), 'x');
      mkdirSync(join(repo, '.claude', 'worktrees', 'agent-1'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'worktrees', 'agent-1', 'a.ts'), 'x');
      writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}');
      writeFileSync(join(repo, '.claude', 'scheduled_tasks.json'), '');
      sh(excludePlaceholders(repo).join('\n'), repo);
      expect(sh('git status --porcelain --untracked-files=all', repo)).toBe('');
      writeFileSync(join(repo, '.claude', 'settings.json'), 'b');
      expect(sh('git status --porcelain', repo)).toBe(' M .claude/settings.json\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the repo's tracked settings stay seen: a change to abe.yaml is the card's work", () => {
    const repo = mkdtempSync(join(tmpdir(), 'jail-placeholders-'));

    try {
      sh(
        'git init -q . && mkdir .abe && echo a > abe.yaml && git add . && git -c user.name=t -c user.email=t@t commit -qm x',
        repo,
      );
      sh(excludePlaceholders(repo).join('\n'), repo);
      writeFileSync(join(repo, 'abe.yaml'), 'b');
      expect(sh('git status --porcelain', repo)).toBe(' M abe.yaml\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the jail's read-only names in each tree, by their paths (no glob on Linux)", () => {
    expect(JAIL_PLACEHOLDERS).toEqual([
      'abe.yaml',
      '.abe/settings.local.yaml',
      '.abe/abe.dev.env',
      '.abe/abe.test.env',
      '.abe/abe.prod.env',
    ]);
  });

  test("Claude Code's sandbox's read-only names in the clone's root, as its sandbox makes them", () => {
    expect(SANDBOX_PLACEHOLDERS).toEqual([
      '.gitconfig',
      '.gitmodules',
      '.bashrc',
      '.bash_profile',
      '.zshrc',
      '.zprofile',
      '.profile',
      '.ripgreprc',
      '.mcp.json',
      '.vscode',
      '.idea',
      '.claude/commands',
      '.claude/agents',
    ]);
  });

  test('the clone script keeps them out on every up, a clone made earlier too', () => {
    const script = cloneScript('mkdir-swe/demo-shop', 'card/101-cart', true);
    const lines = script.split('\n');

    expect(lines.indexOf(excludePlaceholders('/workspace/repo')[0] ?? '')).toBeGreaterThan(
      lines.indexOf('fi'),
    );
  });
});

test.each([
  ['card/101-cart\n', 'card/101-cart'],
  ['Cloning…\ncard/101-cart\n\n', 'card/101-cart'],
  ['', undefined],
])('the branch from the clone script printing %j', (out, branch) => {
  expect(branchOf(out)).toBe(branch);
});

test.each([
  ['', false],
  ['p bash\n', false],
  ['c\np bash\n', true],
  ['p bash\np claude\n', true],
])('tmux saying %j: busy %p', (probe, busy) => {
  expect(isBusy(probe)).toBe(busy);
});

describe("a card's workspace on its repo's box (ADR 0022)", () => {
  test.each([
    [
      '101',
      {
        container: 'abe-ws-101',
        volume: 'abe-ws-101',
        database: 'ws_101',
        socketDir: 'workspaces/101',
        network: 'abe-ws-101',
      },
    ],
    [
      'AB-12',
      {
        container: 'abe-ws-AB-12',
        volume: 'abe-ws-AB-12',
        database: 'ws_ab_12',
        socketDir: 'workspaces/AB-12',
        network: 'abe-ws-AB-12',
      },
    ],
  ])('card %s: its own container, volume, database and socket folder', (card, names) => {
    expect(workspaceNames(card)).toEqual(names);
  });

  test("a 2.2 box's one workspace keeps its fixed names", () => {
    expect(LEGACY_NAMES).toEqual({
      container: 'abe-workspace',
      volume: 'abe-workspace',
      database: 'workspace',
      socketDir: 'workspace',
      network: 'abe-net',
    });
  });

  test.each([
    ['101-ab12', '101'],
    ['AB-12-0f0f', 'AB-12'],
    ['101', undefined],
    ['101-xyz1', undefined],
    ['../x-ab12', undefined],
  ])('session %j belongs to card %j', (id, card) => {
    expect(cardOfSession(id)).toBe(card);
  });
});

describe("a workspace's database", () => {
  test('made when missing, the role given this password, closed to every other role', () => {
    expect(databaseSql('0123abcd0123abcd', 'ws_101')).toBe(
      [
        "SELECT 'CREATE ROLE ws_101 LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_101')\\gexec",
        "ALTER ROLE ws_101 LOGIN PASSWORD '0123abcd0123abcd';",
        "SELECT 'CREATE DATABASE ws_101 OWNER ws_101' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ws_101')\\gexec",
        'REVOKE ALL ON DATABASE ws_101 FROM PUBLIC;',
        'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;',
        'REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;',
      ].join('\n'),
    );
  });

  test('a password that is not hex, or a name that is no workspace database, is refused, never quoted into SQL', () => {
    expect(() => databaseSql("x'; DROP ROLE postgres; --", 'ws_101')).toThrow();
    expect(() => databaseSql('0123abcd0123abcd', 'ws_1; DROP ROLE postgres')).toThrow();
    expect(() => dropDatabaseSql('postgres; --')).toThrow();
  });

  test('removed with its connections ended, its role after it', () => {
    expect(dropDatabaseSql('ws_101')).toBe(
      ['DROP DATABASE IF EXISTS ws_101 WITH (FORCE);', 'DROP ROLE IF EXISTS ws_101;'].join('\n'),
    );
  });

  test("its URL: its own role and database over Postgres' socket", () => {
    expect(databaseUrl('0123abcd0123abcd', 'ws_101')).toBe(
      'postgresql://ws_101:0123abcd0123abcd@/ws_101?host=/run/postgresql',
    );
  });

  test("each role reaches only the database of its own name: one card's is never another's", () => {
    expect(PG_HBA.split('\n')).toEqual([
      '# Written by abe workspace up (#67, ADR 0022).',
      'local all postgres peer',
      'local sameuser all scram-sha-256',
      'local all all reject',
      'host workspace workspace all scram-sha-256',
      'host all all all reject',
      '',
    ]);
  });
});

describe('the base image, against the abe installed on the box', () => {
  const release = { version: '2.0.0-alpha.0-90ca905c', hash: 'a1'.repeat(32) };
  const image = (labels: Record<string, string>): Image => ({ id: 'sha256:base1', labels });

  test('built with the release as its labels', () => {
    expect(baseLabels(release)).toEqual({
      'abe.version': '2.0.0-alpha.0-90ca905c',
      'abe.hash': release.hash,
    });
  });

  test.each<[string, Image | undefined, 'reuse' | 'build']>([
    ['labelled with this release: reused', image(baseLabels(release)), 'reuse'],
    [
      'another build of the same version: rebuilt',
      image({ ...baseLabels(release), 'abe.hash': 'b2'.repeat(32) }),
      'build',
    ],
    [
      'another version: rebuilt',
      image({ ...baseLabels(release), 'abe.version': '2.0.0-alpha.0-f7728053' }),
      'build',
    ],
    // From before the labels (no abe-run user): rebuilt.
    ['no labels: rebuilt', image({ 'abe.base.version': '2.0.0-alpha.0' }), 'build'],
    ['missing: built', undefined, 'build'],
  ])('%s', (_, have, plan) => {
    expect(basePlan(have, release)).toBe(plan);
  });

  test('a serve that knows no release (not a box install) uses the one there is, or has none', () => {
    expect(basePlan(image({}), undefined)).toBe('reuse');
    expect(basePlan(undefined, undefined)).toBe('missing');
  });
});

describe("a repo's workspace image", () => {
  const built = (labels: Record<string, string>): Image => ({ id: 'sha256:ws1', labels });
  const current = built({ 'abe.image.tree': 'tree1', 'abe.base.id': 'sha256:base1' });

  test.each<[string, Image | undefined, string, string, boolean]>([
    ['the same tree on the same base: kept', current, 'tree1', 'sha256:base1', true],
    ['a rebuilt base: rebuilt after it', current, 'tree1', 'sha256:base2', false],
    ['a changed .abe/session: rebuilt', current, 'tree2', 'sha256:base1', false],
    ['none yet: built', undefined, 'tree1', 'sha256:base1', false],
    ['no labels: rebuilt', built({}), 'tree1', 'sha256:base1', false],
  ])('%s', (_, have, tree, baseId, kept) => {
    expect(workspaceImageCurrent(have, tree, baseId)).toBe(kept);
  });
});
