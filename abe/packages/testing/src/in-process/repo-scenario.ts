/**
 * The setup most serve tests share (ADR 0030): a `demo` repo with one commit on `main` whose
 * committed `abe.yaml` names the board, your file on this Mac with your environment, the
 * fake board and the fake `claude`, and an in-process serve whose sessions run that `claude` in a
 * real `tmux`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CardDetail } from '@abe/core';
import { fakeBoard, type FakeBoard } from './board';
import { fakeClaude, type FakeClaude } from '../tools/claude';
import { git, GIT_ENV } from './prototype-app';
import { scenario, type ScenarioOptions, type ServeScenario } from './serve';

/** The repo's board. */
export const REPO_BOARD = {
  organization: 'https://dev.azure.com/demo-org',
  project: 'Shop',
  team: 'Web',
} as const;

/** The repo's settings after its `board:` unless a test gives its own. */
export const REPO_SETTINGS = 'environments: {}\n';

/** Yours on this Mac unless a test gives its own: your environment. */
export const MINE_SETTINGS = 'serve.target: local\n';

export type RepoScenarioOptions = {
  /** The board's cards, made with `card()`. */
  cards?: readonly CardDetail[];
  /** The rest of `fakeBoard`'s options, such as `me`, `states` and `sprint`. */
  board?: Parameters<typeof fakeBoard>[1];
  /** Lines after `board:` in the repo's `abe.yaml`. Defaults to `REPO_SETTINGS`. */
  settings?: string;
  /** Yours for this repo, `.abe/settings.local.yaml` (never committed); empty by default. */
  local?: string;
  /** Yours on this Mac, `settings.yaml`. Defaults to `MINE_SETTINGS`. */
  mine?: string;
  /**
   * The repo's `origin` on GitHub as `owner/name`. A bare repo beside it answers, with `main`
   * pushed.
   */
  origin?: string;
  /** More of the sessions' environment, applied after the fake `claude`'s `PATH`. */
  env?: Record<string, string>;
  /** Serve's other options. `board` and `sessions` here win over the preset's. */
  serve?: ScenarioOptions;
};

export type RepoScenario = {
  /** A temporary folder holding everything below. `close` removes it. */
  root: string;
  /** Your folder on this Mac, `ABE_CONFIG_DIR`. */
  mine: string;
  /** The checkout `demo`, with `.gitignore`, `README.md` and `abe.yaml` on `main`. */
  repo: string;
  /** The bare repo `origin` stands for. */
  remote: string;
  board: FakeBoard;
  claude: FakeClaude;
  /** The sessions' environment. It has `GIT_ENV`, the fake `claude` first on `PATH`, and yours. */
  env: Record<string, string>;
  s: ServeScenario;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export const repoScenario = async (o: RepoScenarioOptions = {}): Promise<RepoScenario> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-repo-')));
  const mine = join(root, 'mine');
  const repo = join(root, 'demo');
  const remote = join(root, 'remote.git');

  mkdirSync(mine);
  writeFileSync(join(mine, 'settings.yaml'), o.mine ?? MINE_SETTINGS);
  git(root, 'init', '-q', '-b', 'main', repo);
  mkdirSync(join(repo, '.abe'));
  // the fake claude's own folder is no work of a card's; yours for the repo is never committed
  writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.scratch/\n.abe/settings.local.yaml\n');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(
    join(repo, 'abe.yaml'),
    `board: ${JSON.stringify(REPO_BOARD)}\n${o.settings ?? REPO_SETTINGS}`,
  );
  // there already: the repo's one-time move of your old settings has nothing to do
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), o.local ?? '');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  if (o.origin !== undefined) {
    const url = `https://github.com/${o.origin}.git`;

    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(repo, 'remote', 'add', 'origin', url);
    git(repo, 'config', `url.${remote}.insteadOf`, url);
    git(repo, 'push', '-q', 'origin', 'main');
  }
  const claude = fakeClaude();
  const board = fakeBoard(o.cards ?? [], o.board);
  const env = {
    ...GIT_ENV,
    PATH: claude.path,
    ABE_CONFIG_DIR: mine,
    ...o.env,
  };
  const s = await scenario({ board, sessions: { env }, ...o.serve });
  const close = async () => {
    await s.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    mine,
    repo,
    remote,
    board,
    claude,
    env,
    s,
    close,
    [Symbol.asyncDispose]: close,
  };
};
