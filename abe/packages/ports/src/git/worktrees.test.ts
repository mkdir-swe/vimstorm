/**
 * A card's new worktree starts from origin's default branch as fetched at launch, never the
 * checkout's `HEAD` (#198), and Before's merge base is taken against it: a real git checkout of a
 * bare origin that a teammate pushed to after the checkout last pulled.
 *
 * A session's worktree (#196): its pre-push hook refuses a push to the default branch with a
 * readable reason, lets the card's branch through, and every hook the repository has (its own
 * `core.hooksPath` too) still runs there. The main checkout keeps its own push and hooks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH_PUSH, SESSION_HOOK_NAMES, SESSION_HOOKS } from '@abe/core';
import { cardGit } from './git';
import { reviewGit } from './review-git';
import { gitWorktrees } from './worktrees';

const ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const run = (cwd: string, home: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...ENV, HOME: home } });

  return { exit: ran.exitCode, out: `${ran.stdout.toString()}${ran.stderr.toString()}` };
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const commit = (repo: string, file: string, text: string) => {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', file);

  return git(repo, 'rev-parse', 'HEAD');
};

describe("a card's worktree branches from origin's default branch, fetched at launch (#198)", () => {
  let root: string;
  let origin: string;
  let checkout: string;
  let teammate: string;
  let stale: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'abe-wt-'));
    origin = join(root, 'origin.git');
    checkout = join(root, 'shop');
    teammate = join(root, 'teammate');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, checkout);
    stale = commit(checkout, 'README.md', '# shop\n');
    git(checkout, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, teammate);
    // The checkout is on a branch of its own, and main moved on origin since it last fetched.
    git(checkout, 'checkout', '-q', '-b', 'wip');
    commit(checkout, 'wip.txt', 'mine\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a new branch starts at origin/main as it is now, not the checkout's HEAD; no upstream", async () => {
    const merged = commit(teammate, 'merged.txt', 'a PR merged on GitHub\n');

    git(teammate, 'push', '-q', 'origin', 'main');
    const made = await gitWorktrees(ENV).onBranch(checkout, 'card/104-cart');

    if (!made.ok) throw new Error(made.error.message);
    expect(git(made.data.path, 'rev-parse', 'HEAD')).toBe(merged);
    expect(made.data.base).toEqual({ from: 'origin/main', commit: merged, note: null });
    expect(
      Bun.spawnSync(['git', '-C', made.data.path, 'rev-parse', '--abbrev-ref', '@{upstream}'], {
        env: ENV,
      }).exitCode,
    ).not.toBe(0);
  });

  test('origin not reached: origin/main as last fetched, and a note saying so', async () => {
    git(checkout, 'remote', 'set-url', 'origin', join(root, 'gone.git'));
    const made = await gitWorktrees(ENV).onBranch(checkout, 'card/105-bug');

    if (!made.ok) throw new Error(made.error.message);
    expect(git(made.data.path, 'rev-parse', 'HEAD')).toBe(stale);
    expect(made.data.base?.from).toBe('origin/main');
    expect(made.data.base?.note).toMatch(
      /^origin not reached \(.+\): origin\/main as last fetched$/,
    );
  });

  test("no origin: the checkout's own main, said so", async () => {
    git(checkout, 'remote', 'remove', 'origin');
    const made = await gitWorktrees(ENV).onBranch(checkout, 'card/106-x');

    if (!made.ok) throw new Error(made.error.message);
    expect(git(made.data.path, 'rev-parse', 'HEAD')).toBe(stale);
    expect(made.data.base).toEqual({
      from: 'main',
      commit: stale,
      note: "no origin remote: the checkout's own main",
    });
  });

  test('a branch there already is reused as it is: nothing said about a base', async () => {
    git(checkout, 'branch', 'card/107-y', 'main');
    const made = await gitWorktrees(ENV).onBranch(checkout, 'card/107-y');

    if (!made.ok) throw new Error(made.error.message);
    expect(made.data.base).toBeUndefined();
    expect(git(made.data.path, 'rev-parse', 'HEAD')).toBe(stale);
  });

  test(".scratch/ and a PR checkout's copied files kept out of git in Abe's block of info/exclude while a worktree of Abe's is there; the last one removed takes the block out", async () => {
    const exclude = join(checkout, '.git', 'info', 'exclude');
    const mine = '# mine\n*.log\n';
    const block = (...paths: string[]) =>
      ['# abe: card worktrees (kept out of git)', ...paths, '# abe: card worktrees end\n'].join(
        '\n',
      );

    writeFileSync(exclude, mine);
    const made = await Promise.all(
      ['card/108-a', 'card/109-b'].map((b) => gitWorktrees(ENV).onBranch(checkout, b)),
    );
    const [a, b] = made.map((m) => (m.ok ? m.data.path : ''));

    expect(readFileSync(exclude, 'utf8')).toBe(`${mine}${block('.scratch/')}`);
    // a PR checked out for review gets the checkout's own CLAUDE.md, kept out in the same block
    git(origin, 'update-ref', 'refs/pull/7/head', stale);
    writeFileSync(join(checkout, 'CLAUDE.md'), 'notes\n');
    const pr = `${checkout}-pr-7`;
    const out = await reviewGit(ENV).checkoutPr({
      main: checkout,
      path: pr,
      number: 7,
      branch: 'pr-7',
      base: 'main',
      reuse: false,
    });

    expect([out.ok, readFileSync(exclude, 'utf8')]).toEqual([
      true,
      `${mine}${block('.scratch/', 'CLAUDE.md')}`,
    ]);
    for (const wt of [a, b]) {
      expect((await cardGit({ env: ENV }).remove(wt ?? '')).ok).toBe(true);
      expect(readFileSync(exclude, 'utf8')).toBe(`${mine}${block('.scratch/', 'CLAUDE.md')}`);
    }
    expect((await cardGit({ env: ENV }).remove(pr)).ok).toBe(true);
    expect(readFileSync(exclude, 'utf8')).toBe(mine);
  });

  test("Before's merge base is taken against origin/main fetched now", async () => {
    const worktrees = gitWorktrees(ENV);
    const first = commit(teammate, 'one.txt', '1\n');

    git(teammate, 'push', '-q', 'origin', 'main');
    const made = await worktrees.onBranch(checkout, 'card/108-z');

    if (!made.ok) throw new Error(made.error.message);
    commit(made.data.path, 'card.txt', 'the change\n');
    // main moves on again after the launch; the base stays where the branch left it.
    commit(teammate, 'two.txt', '2\n');
    git(teammate, 'push', '-q', 'origin', 'main');
    const before = await worktrees.atMergeBase(checkout, 'card/108-z');

    if (!before.ok) throw new Error(before.error.message);
    expect(before.data).toMatchObject({ base: first, against: 'origin/main' });
    expect(before.data.note).toBeUndefined();
    expect(git(checkout, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(first);
  });

  test("Before with no origin: the checkout's own main, said so as at launch", async () => {
    const worktrees = gitWorktrees(ENV);

    git(checkout, 'remote', 'remove', 'origin');
    const made = await worktrees.onBranch(checkout, 'card/109-w');

    if (!made.ok) throw new Error(made.error.message);
    const before = await worktrees.atMergeBase(checkout, 'card/109-w');

    if (!before.ok) throw new Error(before.error.message);
    expect(before.data).toMatchObject({
      base: stale,
      against: 'main',
      note: "no origin remote: the checkout's own main",
    });
  });
});

describe("a session worktree's pre-push hook (#196)", () => {
  let root: string;
  let repo: string;
  let remote: string;
  const gitIn = (cwd: string, ...args: string[]) => {
    const ran = run(cwd, root, ...args);

    if (ran.exit !== 0) throw new Error(`git ${args.join(' ')}: ${ran.out}`);

    return ran.out;
  };
  const worktree = async (branch: string) => {
    const made = await gitWorktrees({ ...ENV, HOME: root }).onBranch(repo, branch);

    if (!made.ok) throw new Error(made.error.message);

    return made.data.path;
  };
  const commitIn = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    gitIn(cwd, 'add', file);
    gitIn(cwd, 'commit', '-q', '-m', file);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wt-')));
    repo = join(root, 'shop');
    remote = join(root, 'shop.git');
    gitIn(root, 'init', '-q', '--bare', '-b', 'main', remote);
    gitIn(root, 'init', '-q', '-b', 'main', repo);
    commitIn(repo, 'README.md');
    gitIn(repo, 'remote', 'add', 'origin', remote);
    gitIn(repo, 'push', '-q', '-u', 'origin', 'main');
    gitIn(repo, 'remote', 'set-head', 'origin', 'main');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('a push to the default branch is refused and says why; the card branch goes', async () => {
    const wt = await worktree('2-cart-total');

    commitIn(wt, 'cart.ts');
    for (const ref of ['HEAD:main', 'HEAD:refs/heads/main', '2-cart-total:main']) {
      const pushed = run(wt, root, 'push', 'origin', ref);

      expect(pushed.exit).not.toBe(0);
      expect(pushed.out).toContain(DEFAULT_BRANCH_PUSH);
      expect(pushed.out).toContain('main is the default branch');
    }
    // Deleting it is a push to it too.
    expect(run(wt, root, 'push', 'origin', ':main').exit).not.toBe(0);
    expect(gitIn(remote, 'log', '--format=%s', 'main')).toBe('README.md\n');
    expect(run(wt, root, 'push', '-q', 'origin', 'HEAD').exit).toBe(0);
    expect(gitIn(remote, 'log', '--format=%s', '2-cart-total')).toBe('cart.ts\nREADME.md\n');
  });

  test("the card's Before worktree refuses a push to the default branch too (#181, #196)", async () => {
    const wt = await worktree('2-cart-total');

    commitIn(wt, 'cart.ts');
    const before = await gitWorktrees({ ...ENV, HOME: root }).atMergeBase(repo, '2-cart-total');

    if (!before.ok) throw new Error(before.error.message);
    commitIn(before.data.path, 'old.ts');
    const pushed = run(before.data.path, root, 'push', '--force', 'origin', 'HEAD:main');

    expect(pushed.exit).not.toBe(0);
    expect(pushed.out).toContain(DEFAULT_BRANCH_PUSH);
  });

  test('the main checkout keeps its own push to main', async () => {
    await worktree('2-cart-total');
    commitIn(repo, 'NOTES.md');
    expect(run(repo, root, 'push', '-q', 'origin', 'main').exit).toBe(0);
  });

  test("a repository's own hooks still run in the worktree: .git/hooks and core.hooksPath", async () => {
    const marks = join(root, 'marks');

    mkdirSync(marks);
    const hook = (dir: string, name: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, name),
        `#!/bin/sh\necho "$(basename "$0") $*" >> ${marks}/${name}\ncat >> ${marks}/${name}\n`,
      );
      chmodSync(join(dir, name), 0o755);
    };

    hook(join(repo, '.git', 'hooks'), 'pre-commit');
    hook(join(repo, '.git', 'hooks'), 'pre-push');
    const wt = await worktree('2-cart-total');

    commitIn(wt, 'cart.ts');
    expect(existsSync(join(marks, 'pre-commit'))).toBe(true);
    expect(run(wt, root, 'push', '-q', 'origin', 'HEAD').exit).toBe(0);
    // The repository's pre-push got its arguments and the refs on its stdin.
    expect(readFileSync(join(marks, 'pre-push'), 'utf8')).toMatch(
      /^pre-push origin .*shop\.git\nHEAD [0-9a-f]+ refs\/heads\/2-cart-total 0+\n$/,
    );
    // A repository whose hooks live in the tree (husky's way): those run instead.
    hook(join(repo, '.githooks'), 'commit-msg');
    gitIn(repo, 'add', '.githooks');
    gitIn(repo, 'commit', '-q', '-m', 'hooks in the tree');
    gitIn(repo, 'config', 'core.hooksPath', '.githooks');
    gitIn(wt, 'merge', '-q', '--no-edit', 'main');
    commitIn(wt, 'total.ts');
    expect(readFileSync(join(marks, 'commit-msg'), 'utf8')).toContain('commit-msg');
  });

  test('a worktree with hooks of its own (a developer prototype’s) keeps them', async () => {
    const wt = await worktree('proto/2-cart');
    const theirs = join(repo, '.git', 'hooks', 'abe-prototype');

    gitIn(wt, 'config', '--worktree', 'core.hooksPath', theirs);
    await worktree('proto/2-cart');
    expect(gitIn(wt, 'config', '--worktree', 'core.hooksPath')).toBe(`${theirs}\n`);
  });

  test('no hook git runs on every ref or index change: those would slow every command', async () => {
    await worktree('2-cart-total');
    const names = readdirSync(join(repo, '.git', 'hooks', SESSION_HOOKS)).sort();

    expect(names).toEqual([...SESSION_HOOK_NAMES].sort());
    expect(names).not.toContain('reference-transaction');
    expect(names).not.toContain('post-index-change');
  });

  test('each launch leaves the hooks as they are, and puts back one changed whole', async () => {
    await worktree('2-cart-total');
    const prePush = join(repo, '.git', 'hooks', SESSION_HOOKS, 'pre-push');
    const before = statSync(prePush);
    const text = readFileSync(prePush, 'utf8');

    await worktree('2-cart-total');
    expect(statSync(prePush).ino).toBe(before.ino);
    expect(statSync(prePush).mtimeMs).toBe(before.mtimeMs);
    writeFileSync(prePush, '#!/bin/sh\nexit 0\n');
    chmodSync(prePush, 0o644);
    await worktree('2-cart-total');
    expect(readFileSync(prePush, 'utf8')).toBe(text);
    expect(statSync(prePush).mode & 0o777).toBe(0o755);
    // Written beside it and renamed over: never a half-written hook, nothing left behind.
    expect(statSync(prePush).ino).not.toBe(before.ino);
    expect(readdirSync(join(repo, '.git', 'hooks', SESSION_HOOKS)).sort()).toEqual(
      [...SESSION_HOOK_NAMES].sort(),
    );
  });

  test("a repository hook's refusal still refuses", async () => {
    const hooks = join(repo, '.git', 'hooks');

    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    const wt = await worktree('2-cart-total');

    writeFileSync(join(wt, 'cart.ts'), 'x\n');
    gitIn(wt, 'add', 'cart.ts');
    expect(run(wt, root, 'commit', '-q', '-m', 'cart').exit).not.toBe(0);
  });
});

describe('launches at once in one repository (#301)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wt-')));
    const remote = join(root, 'shop.git');

    repo = join(root, 'shop');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'init', '-q', '-b', 'main', repo);
    commit(repo, 'README.md', '# shop\n');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('each of four launches at once gets its worktree, Before too: none trips over git’s locks', async () => {
    const worktrees = gitWorktrees({ ...ENV, HOME: root });
    const branches = ['card/1-a', 'card/2-b', 'card/3-c', 'card/4-d'];
    const made = await Promise.all(branches.map((branch) => worktrees.onBranch(repo, branch)));

    expect(made.map((m) => (m.ok ? 'ok' : m.error.message))).toEqual(branches.map(() => 'ok'));
    const before = await Promise.all([
      ...branches.map((branch) => worktrees.atMergeBase(repo, branch)),
      ...branches.map((branch) => worktrees.onBranch(repo, branch)),
    ]);

    expect(before.map((m) => (m.ok ? 'ok' : m.error.message))).toEqual(
      [...branches, ...branches].map(() => 'ok'),
    );
    expect(git(repo, 'config', '--get', 'extensions.worktreeConfig')).toBe('true');
  }, 20_000);

  test('a lock another git holds on .git/config is waited out, not failed on', async () => {
    const lock = join(repo, '.git', 'config.lock');

    writeFileSync(lock, '');
    const freed = Bun.sleep(1500).then(() => {
      rmSync(lock);
    });
    const made = await gitWorktrees({ ...ENV, HOME: root }).onBranch(repo, 'card/7-g');

    await freed;
    expect(made.ok ? 'ok' : made.error.message).toBe('ok');
    expect(git(repo, 'config', '--get', 'extensions.worktreeConfig')).toBe('true');
  }, 20_000);

  test('a lock held for good still fails, saying git’s words', async () => {
    writeFileSync(join(repo, '.git', 'config.lock'), '');
    const made = await gitWorktrees({ ...ENV, HOME: root }).onBranch(repo, 'card/8-h');

    expect(made.ok ? 'ok' : made.error.message).toContain('could not lock config file');
  }, 20_000);

  test('a second Worktrees in this process waits its turn too', async () => {
    const made = await Promise.all(
      ['card/1-a', 'card/2-b', 'card/3-c', 'card/4-d'].map((branch) =>
        gitWorktrees({ ...ENV, HOME: root }).onBranch(repo, branch),
      ),
    );

    expect(made.map((m) => (m.ok ? 'ok' : m.error.message))).toEqual(['ok', 'ok', 'ok', 'ok']);
  }, 20_000);
});

describe("a card's branch from origin, checked out on this Mac (`card checkout`, #4)", () => {
  let root: string;
  let checkout: string;
  let teammate: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wt-')));
    const origin = join(root, 'origin.git');

    checkout = join(root, 'shop');
    teammate = join(root, 'teammate');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, checkout);
    commit(checkout, 'README.md', '# shop\n');
    git(checkout, 'push', '-q', 'origin', 'main');
    git(root, 'clone', '-q', origin, teammate);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The teammate's `branch` pushed with one commit of `file`; its commit. */
  const pushed = (branch: string, file: string) => {
    git(teammate, 'checkout', '-q', '-B', branch, 'origin/main');
    const sha = commit(teammate, file, `${file}\n`);

    git(teammate, 'push', '-q', 'origin', branch);

    return sha;
  };

  type Row = {
    name: string;
    /** Done before the checkout; the commit the worktree should be at. */
    given: () => string | undefined;
    card: string;
    want: { branch: string; made: boolean } | { code: string };
  };
  const rows: Row[] = [
    {
      name: "a teammate's pushed branch, new here: a worktree tracking origin's",
      given: () => pushed('card/12-cart-total', 'cart.txt'),
      card: '12',
      want: { branch: 'card/12-cart-total', made: true },
    },
    {
      name: 'of two branches for the card, the newest commit; card/123 is not card/12',
      given: () => {
        pushed('card/123-other', 'other.txt');
        pushed('card/12-old', 'old.txt');
        Bun.sleepSync(1100);

        return pushed('card/12-renamed', 'new.txt');
      },
      card: '12',
      want: { branch: 'card/12-renamed', made: true },
    },
    {
      name: 'a bare card/<id> branch counts',
      given: () => pushed('card/7', 'seven.txt'),
      card: '7',
      want: { branch: 'card/7', made: true },
    },
    {
      name: 'a local branch behind origin moves on to it',
      given: () => {
        pushed('card/5-x', 'a.txt');
        git(checkout, 'fetch', '-q', 'origin');
        git(checkout, 'branch', '-q', 'card/5-x', 'origin/card/5-x');
        git(teammate, 'checkout', '-q', 'card/5-x');
        const sha = commit(teammate, 'b.txt', 'b\n');

        git(teammate, 'push', '-q', 'origin', 'card/5-x');

        return sha;
      },
      card: '5',
      want: { branch: 'card/5-x', made: true },
    },
    {
      name: 'checked out already: that worktree, not a second',
      given: () => {
        const sha = pushed('card/9-y', 'y.txt');

        git(checkout, 'fetch', '-q', 'origin');
        git(checkout, 'checkout', '-q', '-b', 'card/9-y', 'origin/card/9-y');

        return sha;
      },
      card: '9',
      want: { branch: 'card/9-y', made: false },
    },
    {
      name: 'nothing pushed for the card: refused, said why',
      given: () => {
        pushed('card/40-z', 'z.txt');

        return undefined;
      },
      card: '4',
      want: { code: 'no-branch' },
    },
  ];

  test.each(rows)(
    '$name',
    async ({ given, card, want }) => {
      const at = given();
      const out = await gitWorktrees({ ...ENV, HOME: root }).fromOrigin(checkout, card);

      if ('code' in want) {
        expect(out.ok ? 'ok' : out.error.code).toBe(want.code);

        return;
      }
      if (!out.ok) throw new Error(out.error.message);
      expect({ branch: out.data.branch, made: out.data.made }).toEqual(want);
      expect(git(out.data.path, 'rev-parse', 'HEAD')).toBe(at ?? '');
      expect(git(out.data.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(
        `origin/${want.branch}`,
      );
      if (want.made)
        expect(out.data.path).toBe(join(root, 'shop-wt', want.branch.slice('card/'.length)));
      else expect(out.data.path).toBe(checkout);
    },
    20_000,
  );
});
