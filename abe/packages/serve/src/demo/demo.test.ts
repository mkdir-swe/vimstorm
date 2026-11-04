/**
 * `abe demo new` on an in-process `serve` whose GitHub is a fake `gh` and whose git is the real
 * one, in a temporary home: the bundled demo copied, committed, created private, pushed and its
 * cards made issues; each refusal with its code. One `cli()` run checks the real `abe`'s wiring.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DemoNewData, DemoSeed } from '@abe/core';
import { demoPlaces, demoShopFrom } from '@abe/ports';
import {
  cli,
  fakeGh,
  type GhAnswer,
  NOT_FOUND,
  served,
  type ServedCli,
  tempState,
} from '@abe/testing';

// Each run copies the demo and runs git: slow on a loaded machine.
setDefaultTimeout(20_000);

const LOGIN = 'ada-example';
const REPO = `${LOGIN}/demo-shop`;
const SOURCE = demoPlaces(null)[0] ?? '';
const SEED = DemoSeed.parse(JSON.parse(readFileSync(join(SOURCE, 'board/seed.json'), 'utf8')));

/** gh as a new user with no demo-shop yet: each card's issue numbered in the seed's order. */
const fresh = (): [string, GhAnswer][] => [
  ['api user', { stdout: `${LOGIN}\n` }],
  ['repo view', NOT_FOUND],
  ['repo create', { stdout: `https://github.com/${REPO}\n` }],
  ...SEED.cards.map((c, i): [string, GhAnswer] => [
    `--title ${c.title}`,
    { stdout: `https://github.com/${REPO}/issues/${i + 1}\n` },
  ]),
];

const gh = fakeGh();
const state = tempState();
let places = () => [SOURCE];
let abe: ServedCli;
let before = 0;

const argvs = () =>
  gh
    .calls()
    .slice(before)
    .map((c) => c.argv.join(' '));
const git = (dir: string, ...argv: string[]) =>
  Bun.spawnSync(['git', ...argv], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: state.dir } })
    .stdout.toString()
    .trim();

beforeAll(async () => {
  abe = await served({
    state,
    demo: demoShopFrom({ ...state.env, PATH: gh.path }, { places: () => places() }),
  });
});

beforeEach(() => {
  before = gh.calls().length;
  places = () => [SOURCE];
  gh.answer(fresh());
});

afterAll(async () => {
  await abe.close();
  gh.remove();
});

describe('abe demo new', () => {
  test('copies the demo to ~/projects/demo-shop, commits it, creates it private, pushes and makes its cards issues assigned to you', async () => {
    const folder = join(state.dir, 'projects', 'demo-shop');
    const { exit, doc } = await abe.json(DemoNewData, 'demo', 'new');

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        folder,
        repo: REPO,
        url: `https://github.com/${REPO}`,
        private: true,
        issues: SEED.cards.map((c, i) => ({
          number: i + 1,
          title: c.title,
          url: `https://github.com/${REPO}/issues/${i + 1}`,
        })),
        next: ['cd ~/projects/demo-shop', 'abe install'],
      },
    });
    // the app, without the seed or anything a build or run left
    expect(readdirSync(folder).sort()).toEqual([
      '.git',
      '.github',
      '.gitignore',
      'README.md',
      'api',
      'eslint.config.js',
      'package-lock.json',
      'package.json',
      'tsconfig.base.json',
      'web',
    ]);
    expect(existsSync(join(folder, 'api', 'test', 'cart.test.ts'))).toBe(true);
    // one commit on main, everything in it, signed as the gh login when git knows no one
    expect(git(folder, 'log', '--format=%an <%ae> %s', 'main')).toBe(
      `${LOGIN} <${LOGIN}@users.noreply.github.com> Start the demo shop.`,
    );
    expect(git(folder, 'status', '--porcelain')).toBe('');
    expect(argvs()).toEqual([
      'api user --jq .login',
      `repo view ${REPO} --json name`,
      `repo create ${REPO} --private --source ${folder} --remote origin --push`,
      ...SEED.cards.map(
        (c) =>
          `issue create --repo ${REPO} --title ${c.title} --body-file - ${c.labels.map((l) => `--label ${l}`).join(' ')} --assignee ${LOGIN}`,
      ),
    ]);
    expect(
      gh
        .calls()
        .slice(before)
        .filter((c) => c.argv[0] === 'issue')
        .map((c) => c.stdin),
    ).toEqual(SEED.cards.map((c) => c.body));
  });

  test('a named folder is read from where it was typed, and the text says what to do next', async () => {
    const r = await abe.runWith({ cwd: state.dir }, 'demo', 'new', 'named/shop');
    // the request's folder as serve gets it, its links followed
    const folder = join(realpathSync(state.dir), 'named', 'shop');

    expect(r.exit).toBe(0);
    expect(existsSync(join(folder, 'package.json'))).toBe(true);
    expect(r.stdout).toBe(
      [
        `Your demo is ${folder}, pushed to https://github.com/${REPO} (private).`,
        `${SEED.cards.length} cards as issues:`,
        ...SEED.cards.map((c, i) => `  #${i + 1} ${c.title}`),
        'Next:',
        `  cd ${folder}`,
        '  abe install',
        '',
      ].join('\n'),
    );
  });

  // [what, folder made first, gh's answers over a new user's, code, words, folder made, gh calls]
  test.each<[string, boolean, [string, GhAnswer][], string, string, boolean, string[]]>([
    ['the folder is there', true, [], 'folder-exists', 'rm -rf ~/taken', true, []],
    [
      'the repo is on GitHub',
      false,
      [['repo view', { json: { name: 'demo-shop' } }]],
      'repo-exists',
      `gh repo delete ${REPO} --yes`,
      false,
      ['api user', 'repo view'],
    ],
    [
      'gh is signed in to no one',
      false,
      [
        [
          'api user',
          {
            stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
            exit: 1,
          },
        ],
      ],
      'no-gh-login',
      'gh auth login',
      false,
      ['api user'],
    ],
    [
      'GitHub refuses the repo',
      false,
      [['repo create', { stderr: 'HTTP 422: Name already exists on this account', exit: 1 }]],
      'repo-create-failed',
      'rm -rf ~/taken',
      true,
      ['api user', 'repo view', 'repo create'],
    ],
    [
      'a card does not become an issue',
      false,
      [[`--title ${SEED.cards[1]?.title ?? ''}`, { stderr: 'HTTP 502', exit: 1 }]],
      'issue-create-failed',
      `(1 did)`,
      true,
      ['api user', 'repo view', 'repo create', 'issue create', 'issue create'],
    ],
  ])('%s: refused', async (_, made, answers, code, words, after, calls) => {
    const folder = join(state.dir, 'taken');

    Bun.spawnSync(['rm', '-rf', folder]);
    if (made) mkdirSync(folder);
    gh.answer([...answers, ...fresh()]);
    const { exit, doc } = await abe.json(DemoNewData, 'demo', 'new', '~/taken');

    expect(exit).toBe(1);
    if (doc.ok) throw new Error('made');
    expect(doc.error.code).toBe(code);
    expect(doc.error.message).toContain(words);
    expect(existsSync(folder)).toBe(after);
    expect(argvs().map((a) => a.split(' ').slice(0, 2).join(' '))).toEqual(calls);
  });

  test.each<[string, string[], string]>([
    ['an abe with no demo bundled', ['~/none'], 'no-demo'],
    ['a repo name GitHub would not take', ['--name', 'my shop'], 'bad-name'],
  ])('%s: refused before anything', async (what, argv, code) => {
    if (code === 'no-demo') places = () => [join(state.dir, 'nowhere')];
    const { exit, doc } = await abe.json(DemoNewData, 'demo', 'new', ...argv);

    expect(exit).toBe(1);
    expect(doc.ok ? what : doc.error.code).toBe(code);
    expect(argvs()).toEqual([]);
  });

  test('--name names the repo and the default folder', async () => {
    const { doc } = await abe.json(DemoNewData, 'demo', 'new', '--name', 'shop-two');

    expect(doc.ok ? [doc.data.folder, doc.data.repo, doc.data.next[0]] : doc.error).toEqual([
      join(state.dir, 'projects', 'shop-two'),
      `${LOGIN}/shop-two`,
      'cd ~/projects/shop-two',
    ]);
    expect(argvs().slice(1, 3)).toEqual([
      `repo view ${LOGIN}/shop-two --json name`,
      `repo create ${LOGIN}/shop-two --private --source ${join(state.dir, 'projects', 'shop-two')} --remote origin --push`,
    ]);
  });
});

describe('abe demo new, the real abe', () => {
  test('finds the demo its checkout bundles and answers one JSON line', async () => {
    const real = fakeGh(fresh());
    const abeCli = cli({ env: { PATH: real.path } });

    try {
      const { exit, doc } = await abeCli.json(DemoNewData, 'demo', 'new');

      expect(exit).toBe(0);
      expect(doc.ok ? [doc.data.folder, doc.data.issues.length] : doc.error).toEqual([
        join(abeCli.state.dir, 'projects', 'demo-shop'),
        SEED.cards.length,
      ]);
      expect(existsSync(join(abeCli.state.dir, 'projects', 'demo-shop', 'web', 'src'))).toBe(true);
    } finally {
      await abeCli.close();
      real.remove();
    }
  }, 30_000);
});
