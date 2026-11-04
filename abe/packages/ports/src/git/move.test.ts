/**
 * The shell Mover (#88) on real repositories, nothing between (`exec: []`): what the pack holds
 * and what the unpack lets onto a worktree. The review of #88's first cut found the holes these
 * close: macOS's `._*` AppleDouble entries, the person's diff config in the patches, a pack
 * extracted unchecked, `checkout -B` over a branch with its own commits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { worktreePath } from '@abe/core';
import { shellMover } from './move';

const ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};

const sh = (cwd: string, script: string) => {
  const ran = Bun.spawnSync(['sh', '-ec', script], { cwd, env: { ...ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`${script}: ${ran.stderr.toString()}`);

  return ran.stdout.toString();
};

const tarList = (cwd: string, file: string) =>
  sh(cwd, `tar -tf ${JSON.stringify(file)}`)
    .split('\n')
    .filter((l) => l !== '');

let root: string;
/** The worktree moved from: a branch with a commit of its own, changes and new files. */
let from: string;
/** This Mac's checkout of the same repo, at the first commit. */
let mac: string;
let head: string;
const mover = () => shellMover({ ...ENV, HOME: root });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-mv-')));
  from = join(root, 'from');
  mac = join(root, 'mac');
  mkdirSync(from);
  sh(
    from,
    [
      'git init -q -b main',
      'printf "# shop\\n" > README.md && printf "export const total = 1;\\n" > cart.ts',
      'git add . && git commit -q -m first',
      `git clone -q . ${mac}`,
      'git checkout -q -b card/4-sign-in',
      'printf "export const total = 2;\\n" > cart.ts && git commit -q -am work',
      'printf "export const sign = 1;\\n" > sign.ts && git add sign.ts',
      'printf "# shop, signed in\\n" > README.md',
      'printf "notes\\n" > notes.md',
      'mkdir -p .scratch/4 && printf "# checks\\n" > .scratch/4/checks.md',
      // the person's git config shapes diffs: never the pack's
      'git config diff.noprefix true && git config diff.mnemonicPrefix true',
      'git config color.ui always && git config diff.external /usr/bin/false',
    ].join('\n'),
  );
  head = sh(from, 'git rev-parse HEAD').trim();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the pack', () => {
  let pack: string;
  let inside: string;

  beforeAll(async () => {
    // a file with an extended attribute: macOS tar would add its `._notes.md`
    sh(from, 'xattr -w com.example.note x notes.md');
    pack = join(root, 'pack.tar');
    inside = join(root, 'inside');
    mkdirSync(inside);
    const packed = await mover().pack({
      exec: [],
      root: from,
      files: ['notes.md', '.scratch/4/checks.md'],
      transcript: null,
      out: pack,
    });

    if (!packed.ok) throw new Error(packed.error.message);
    sh(inside, `tar -xf ${JSON.stringify(pack)}`);
  });

  test('no AppleDouble entries, in the pack or in its files', () => {
    expect(tarList(root, pack).filter((e) => e.includes('._'))).toEqual([]);
    expect(tarList(inside, join(inside, 'files.tar')).sort()).toEqual([
      '.scratch/4/checks.md',
      'notes.md',
    ]);
  });

  test('the diffs are git’s own, whatever the person’s config: a/ b/ prefixes, no color, no external diff', () => {
    const staged = readFileSync(join(inside, 'staged.patch'), 'utf8');
    const unstaged = readFileSync(join(inside, 'unstaged.patch'), 'utf8');

    expect(staged).toStartWith('diff --git a/sign.ts b/sign.ts\n');
    expect(unstaged).toStartWith('diff --git a/README.md b/README.md\n');
    expect(staged + unstaged).not.toContain('\u001b[');
  });
});

describe('a refusal is one line (#189)', () => {
  test('a side that answers with a usage dump: its first line and the exit, not the dump', async () => {
    const dump = [
      'sh',
      '-c',
      'printf "abe: command: Too small\\n\\nusage: abe box attach\\n" >&2; exit 2',
      'attach',
    ];
    const packed = await mover().pack({
      exec: dump,
      root: from,
      files: [],
      transcript: null,
      out: join(root, 'dump.tar'),
    });

    expect(packed).toEqual({
      ok: false,
      error: { code: 'move-failed', message: `packing ${from}: exit 2: abe: command: Too small` },
    });
  });
});

describe('the unpack', () => {
  const files = ['notes.md', '.scratch/4/checks.md'];
  let worktree: string;

  /** A pack as the other side made it, with `filesTar`'s entries in place of the honest ones. */
  const hostile = (filesTar: string[]) => {
    const dir = mkdtempSync(join(root, 'hostile-'));

    sh(from, `git bundle create -q ${JSON.stringify(join(dir, 'commits.bundle'))} HEAD`);
    writeFileSync(join(dir, 'head'), `${head}\n`);
    writeFileSync(join(dir, 'staged.patch'), '');
    writeFileSync(join(dir, 'unstaged.patch'), '');
    const tree = join(dir, 'tree');

    for (const f of filesTar) {
      mkdirSync(join(tree, f, '..'), { recursive: true });
      writeFileSync(join(tree, f), `${f}\n`);
    }
    sh(tree, `tar -cf ../files.tar ${filesTar.map((f) => JSON.stringify(f)).join(' ')}`);
    rmSync(tree, { recursive: true });
    sh(dir, 'tar -cf ../pack-h.tar -C . head commits.bundle staged.patch unstaged.patch files.tar');

    return join(root, 'pack-h.tar');
  };

  beforeAll(async () => {
    const made = await mover().worktree(mac, 'card/4-sign-in');

    if (!made.ok) throw new Error(made.error.message);
    worktree = made.data;
  });

  test('a new worktree at Abe’s place, detached', () => {
    expect(worktree).toBe(worktreePath(mac, 'card/4-sign-in'));
    expect(sh(worktree, 'git rev-parse --abbrev-ref HEAD').trim()).toBe('HEAD');
  });

  test('only the planned files land: an extra entry and one into .git stay in the pack', async () => {
    const pack = hostile([...files, 'extra.md', '.git/hooks/post-checkout']);
    const copied = await mover().unpack({
      exec: [],
      root: worktree,
      pack,
      files,
      branch: 'card/4-sign-in',
      log: null,
      stash: 'abe: before',
    });

    expect(copied).toEqual({ ok: true, data: null });
    expect(sh(worktree, 'git rev-parse HEAD').trim()).toBe(head);
    expect(sh(worktree, 'git symbolic-ref --short HEAD').trim()).toBe('card/4-sign-in');
    expect(readFileSync(join(worktree, 'notes.md'), 'utf8')).toBe('notes.md\n');
    expect(readFileSync(join(worktree, '.scratch', '4', 'checks.md'), 'utf8')).toBe(
      '.scratch/4/checks.md\n',
    );
    expect(existsSync(join(worktree, 'extra.md'))).toBe(false);
    expect(
      existsSync(join(sh(worktree, 'git rev-parse --git-dir').trim(), 'hooks', 'post-checkout')),
    ).toBe(false);
    expect(existsSync(join(mac, '.git', 'hooks', 'post-checkout'))).toBe(false);
  });

  test('a planned file the pack lacks fails the unpack', async () => {
    const pack = hostile(['notes.md']);
    const copied = await mover().unpack({
      exec: [],
      root: worktree,
      pack,
      files,
      branch: 'card/4-sign-in',
      log: null,
      stash: 'abe: before',
    });

    expect(copied.ok).toBe(false);
    expect(copied.ok ? '' : copied.error.code).toBe('move-failed');
  });

  test('a branch here with commits the moved head lacks is refused, nothing touched', async () => {
    const other = join(root, 'other');

    sh(mac, `git worktree add -q -b card/4-sign-in-b ${other} main`);
    sh(other, 'printf "mine\\n" > mine.md && git add mine.md && git commit -q -m mine');
    sh(mac, `git worktree remove ${other}`);
    const made = await mover().worktree(mac, 'card/4-sign-in-b');

    if (!made.ok) throw new Error(made.error.message);
    writeFileSync(join(made.data, 'wip.md'), 'wip\n');
    const stashes = sh(mac, 'git stash list');
    const copied = await mover().unpack({
      exec: [],
      root: made.data,
      pack: hostile(files),
      files,
      branch: 'card/4-sign-in-b',
      log: null,
      stash: 'abe: before',
    });

    expect(copied.ok).toBe(false);
    expect(copied.ok ? '' : copied.error.code).toBe('branch-diverged');
    expect(copied.ok ? '' : copied.error.message).toContain('card/4-sign-in-b');
    expect(sh(made.data, 'git rev-parse --abbrev-ref HEAD').trim()).toBe('HEAD');
    expect(sh(mac, 'git stash list')).toBe(stashes);
    expect(readFileSync(join(made.data, 'wip.md'), 'utf8')).toBe('wip\n');
    expect(existsSync(join(made.data, 'notes.md'))).toBe(false);
    // a worktree this run made is taken away again
    const dropped = await mover().dropWorktree(mac, made.data);

    expect(dropped).toEqual({ ok: true, data: null });
    expect(existsSync(made.data)).toBe(false);
    expect(sh(mac, 'git worktree list')).not.toContain(made.data);
  });
});
