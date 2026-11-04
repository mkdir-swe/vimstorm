/**
 * `abe settings` on fixture folders (ADR 0030): a checkout with `abe.yaml` and
 * `.abe/settings.local.yaml`, and yours on this Mac; read only through `--json` and exits:
 * in-process (`served`), watch and propose through the real `abe` and its `serve` (`cli`).
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
import {
  Event,
  FeelSwitches,
  LOCAL_HEADER,
  SettingExplainData,
  SettingGetData,
  SettingSetData,
  SettingsCheckData,
  SettingsListData,
  SettingsProposeData,
  SettingsProblemsData,
} from '@abe/core';
import {
  cli,
  type Cli,
  served,
  type ServedCli,
  fakeGh,
  type FakeGh,
  type GhAnswer,
  ghChecks,
  GH_PR_HEAD,
  ghPrView,
  ghPull,
} from '@abe/testing';
import { z } from 'zod';
import { yourHandedLayer } from './settings';

type Fixture = {
  root: string;
  mine: string;
  write: (path: string, text: string) => void;
};

/** Yours on this Mac: an editor preference and your environment. */
const MINE_TEXT = 'serve:\n  target: cloud\nui:\n  theme: islands-light\n';

const fixture = (mine = MINE_TEXT): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'abe-layers-'));
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  write('mine/settings.yaml', mine);

  return { root, mine: join(root, 'mine'), write };
};

/** The repo's file of a CLI from `inRepo`, as the CLI's cwd names it. */
const repoFileOf = (abe: Pick<Cli, 'state'>) => join(realpathSync(abe.state.dir), 'abe.yaml');
/** Yours for the repo of a CLI from `inRepo`. */
const localFileOf = (abe: Pick<Cli, 'state'>) =>
  join(realpathSync(abe.state.dir), '.abe', 'settings.local.yaml');

/** A serve whose folder is a git checkout with `abe.yaml` (and yours for it, when given). */
const inRepo = async (f: Fixture, repoText: string, localText?: string) => {
  const abe = await served({ env: { ABE_CONFIG_DIR: f.mine } });

  mkdirSync(join(abe.state.dir, '.git'));
  mkdirSync(join(abe.state.dir, '.abe'));
  writeFileSync(join(abe.state.dir, 'abe.yaml'), repoText);
  if (localText !== undefined)
    writeFileSync(join(abe.state.dir, '.abe', 'settings.local.yaml'), localText);

  return abe;
};

const read = (path: string) => readFileSync(path, 'utf8');

describe('abe settings get / explain: the repo, then yours (ADR 0030)', () => {
  const f = fixture();
  let abe: ServedCli;

  beforeAll(async () => {
    abe = await inRepo(
      f,
      'checks: [e2e]\nallowedModels: [opus, sonnet]\nautoMerge: true\n',
      'allowedModels: [haiku]\nmodels:\n  reader: haiku\n',
    );
  });
  afterAll(async () => {
    await abe.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  test('a factory value from the repo, yours over it; an editor preference yours on this Mac', async () => {
    const get = async (key: string) => (await abe.json(SettingGetData, 'settings', 'get', key)).doc;

    expect(await get('checks')).toMatchObject({
      ok: true,
      data: {
        value: ['tests', 'types', 'lint', 'no-deleted-tests', 'no-new-suppressions', 'e2e'],
        layer: 'repo',
      },
    });
    expect(await get('models.reader')).toMatchObject({
      ok: true,
      data: { value: 'haiku', layer: 'individual' },
    });
    expect(await get('ui.theme')).toMatchObject({
      ok: true,
      data: { value: 'islands-light', layer: 'individual' },
    });
  });

  test('explain names each file the key is read from', async () => {
    const { doc } = await abe.json(SettingExplainData, 'settings', 'explain', 'autoMerge');

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.layers.map((l) => [l.layer, l.written, l.file])).toEqual([
      ['core', false, null],
      ['repo', true, repoFileOf(abe)],
      ['individual', null, localFileOf(abe)],
    ]);
  });

  test("yours changing a guarded value without an Override: reported, the repo's value stays", async () => {
    const file = localFileOf(abe);

    expect((await abe.json(SettingGetData, 'settings', 'get', 'allowedModels')).doc).toEqual({
      ok: true,
      data: {
        key: 'allowedModels',
        value: ['opus', 'sonnet'],
        layer: 'repo',
        lowered: null,
        problems: [
          {
            code: 'override-required',
            layer: 'individual',
            file,
            key: 'allowedModels',
            message: `${file}: allowedModels changes the value above without an Override; the repo value stays in force`,
          },
        ],
      },
    });
    expect((await abe.run('settings', 'get', 'allowedModels')).stdout).toStartWith(
      '["opus","sonnet"]\n! override-required: ',
    );
  });

  test.each(['get', 'explain'])(
    '%s of an unknown key is refused: unknown-setting',
    async (verb) => {
      expect(await abe.json(SettingGetData, 'settings', verb, 'colour')).toMatchObject({
        exit: 1,
        doc: { ok: false, error: { code: 'unknown-setting', message: 'colour is not a setting' } },
      });
    },
  );
});

describe('abe settings set --repo | --mine: the file each value goes to (ADR 0030)', () => {
  const f = fixture();
  let abe: ServedCli;

  beforeAll(async () => {
    abe = await inRepo(f, '# the repo\nchecks: [e2e]\n');
  });
  afterAll(async () => {
    await abe.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  const set = (...argv: string[]) => abe.json(SettingSetData, 'settings', 'set', ...argv);

  test.each<[string, string[], 'repo' | 'local' | 'machine', string]>([
    ['--repo: the repo file', ['setup', 'npm ci', '--repo'], 'repo', 'setup: npm ci'],
    ['--mine: yours for this repo', ['models.reader', 'haiku', '--mine'], 'local', 'reader: haiku'],
    ['--here is --mine', ['limits.maxBoxDisk', '150', '--here'], 'local', 'maxBoxDisk: 150'],
    [
      "a box's idle stop by default: yours on this machine",
      ['box.idleMinutes', '20'],
      'machine',
      'idleMinutes: 20',
    ],
    ['a factory key by default: yours for this repo', ['effort', 'high'], 'local', 'effort: high'],
    [
      "where cards run by default in a repo: yours for it, over the repo's and this machine's (3.2.2)",
      ['serve.target', 'local'],
      'local',
      'target: local',
    ],
    [
      'an editor preference by default: yours on this machine',
      ['tabs.limit', '7'],
      'machine',
      'limit: 7',
    ],
  ])('%s', async (_, argv, place, line) => {
    const out = await set(...argv);
    const file = {
      repo: repoFileOf(abe),
      local: localFileOf(abe),
      machine: join(f.mine, 'settings.yaml'),
    }[place];

    expect(out).toMatchObject({ exit: 0, doc: { ok: true, data: { place, file } } });
    expect(read(file)).toContain(line);
  });

  test("the repo's file keeps its comments; yours for the repo starts with its header and is kept out of git", () => {
    expect(read(repoFileOf(abe))).toStartWith('# the repo\n');
    expect(read(localFileOf(abe))).toStartWith(LOCAL_HEADER);
    expect(read(join(abe.state.dir, '.git', 'info', 'exclude'))).toContain(
      '.abe/settings.local.yaml\n',
    );
  });

  test.each<[string, string[], string, string]>([
    [
      'prod on for agents in the repo file (ADR 0029)',
      ['agents.prod', 'true', '--repo'],
      'personal-only',
      "only you turn prod on or off for this repo's agents, in .abe/settings.local.yaml",
    ],
    [
      'your GitHub login in the repo file',
      ['logins.gh', 'me', '--repo'],
      'personal-only',
      'yours alone',
    ],
    [
      'an editor preference in the repo file',
      ['ui.feel', 'vim', '--repo'],
      'not-in-repo',
      'yours on this machine',
    ],
    [
      'an editor preference for this repo',
      ['ui.feel', 'vim', '--mine'],
      'not-in-repo',
      'yours on this machine',
    ],
    [
      'both files at once',
      ['effort', 'low', '--repo', '--mine'],
      'usage',
      '--repo or --mine, not both',
    ],
  ])('%s: refused, saying why, nothing written', async (_, argv, code, words) => {
    const before = [repoFileOf(abe), localFileOf(abe)].map((p) => (existsSync(p) ? read(p) : ''));
    const out = await set(...argv);

    expect(out.doc).toMatchObject({ ok: false, error: { code } });
    expect(out.doc.ok ? '' : out.doc.error.message).toContain(words);
    expect([repoFileOf(abe), localFileOf(abe)].map((p) => (existsSync(p) ? read(p) : ''))).toEqual(
      before,
    );
  });

  test('prod on for agents, yours: written, on', async () => {
    expect(await set('agents.prod', 'true', '--mine')).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { place: 'local', value: true, winner: 'individual' } },
    });
  });

  test("yours loosening the repo's value: refused, naming the Override; the Override writes it", async () => {
    await set('limits.maxBoxesPerPerson', '2', '--repo');
    const plain = await set('limits.maxBoxesPerPerson', '9');

    expect(plain.doc).toMatchObject({ ok: false, error: { code: 'reason-required' } });
    expect(plain.doc.ok ? '' : plain.doc.error.message).toContain(
      'abe settings set limits.maxBoxesPerPerson 9 --override --reason "<why>"',
    );
    expect(
      await set('limits.maxBoxesPerPerson', '9', '--override', '--reason', 'many cards'),
    ).toMatchObject({ exit: 0, doc: { ok: true, data: { entry: 'override', value: 9 } } });
  });

  test('an Override without a reason, and --reason alone, are refused', async () => {
    expect((await set('autoMerge', 'true', '--override')).doc).toMatchObject({
      ok: false,
      error: { code: 'reason-required' },
    });
    expect(await set('autoMerge', 'true', '--reason', 'x')).toMatchObject({
      exit: 2,
      doc: { ok: false, error: { code: 'usage' } },
    });
  });

  test('your az folder is yours for this repo; never the repo file', async () => {
    expect(await set('board.azureConfigDir', '/az/work')).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { key: 'board.azureConfigDir', place: 'local', value: '/az/work' } },
    });
    expect((await set('board.azureConfigDir', '/az', '--repo')).doc).toMatchObject({
      ok: false,
      error: { code: 'personal-only' },
    });
  });

  test("the lanes and tag a repo leaves out: board's fields in the repo's file; explain says what each is", async () => {
    expect(await set('board.excludeLanes', '[External dependencies]', '--repo')).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { key: 'board.excludeLanes', place: 'repo' } },
    });
    expect((await set('board.notTag', 'blocked', '--repo')).doc).toMatchObject({ ok: true });
    expect(read(repoFileOf(abe))).toContain(
      'board:\n  excludeLanes:\n    - External dependencies\n  notTag: blocked\n',
    );
    expect((await set('board.excludeLanes', '[]', '--repo')).doc).toMatchObject({
      ok: false,
      error: {
        code: 'invalid-setting',
        message: 'board.excludeLanes []: a swimlane, or a list of them',
      },
    });
    const { doc } = await abe.json(SettingExplainData, 'settings', 'explain', 'board.excludeLanes');

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data).toMatchObject({
      key: 'board.excludeLanes',
      value: ['External dependencies'],
      winner: 'repo',
    });
    expect(doc.data.about).toContain('System.BoardLane, set by the board of the team that owns');
    const text = await abe.run('settings', 'explain', 'board.notTag');

    expect(text.stdout).toStartWith(
      'board.notTag = blocked  from repo\n  a tag whose cards this repo leaves out of every list',
    );
    // any other key: its summary
    const other = await abe.json(SettingExplainData, 'settings', 'explain', 'autoMerge');

    expect(other.doc.ok && other.doc.data.about).toBe(
      'merge a green pull request without a person (opt-in by Override)',
    );
  });

  test('unset takes the entry out of that file, so the value above stands again', async () => {
    await set('setup', 'make', '--mine');
    const out = await abe.json(SettingSetData, 'settings', 'unset', 'setup', '--mine');

    expect(out).toMatchObject({
      exit: 0,
      doc: { ok: true, data: { place: 'local', value: 'npm ci', winner: 'repo' } },
    });
    expect(read(localFileOf(abe))).not.toContain('setup');
  });
});

describe('a factory setting set on one repo does not change another', () => {
  const f = fixture();

  afterAll(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  test('--repo and --mine in one checkout; the other keeps its own', async () => {
    const one = await inRepo(f, '');
    const two = await inRepo(f, '');

    try {
      await one.json(SettingSetData, 'settings', 'set', 'factory.done', 'merged', '--repo');
      await one.json(SettingSetData, 'settings', 'set', 'models.writer', 'haiku', '--mine');
      const got = async (abe: ServedCli, key: string) => {
        const { doc } = await abe.json(SettingGetData, 'settings', 'get', key);

        return doc.ok ? doc.data.value : doc.error.message;
      };

      expect([await got(one, 'factory.done'), await got(one, 'models.writer')]).toEqual([
        'merged',
        'haiku',
      ]);
      expect([await got(two, 'factory.done'), await got(two, 'models.writer')]).toEqual([
        'test',
        'opus',
      ]);
    } finally {
      await one.close();
      await two.close();
    }
  });
});

describe("a box is handed yours: on this Mac and for the repo, but this Mac's alone (#222)", () => {
  test('yourHandedLayer', () => {
    const root = mkdtempSync(join(tmpdir(), 'abe-handed-'));
    const repo = join(root, 'shop');

    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.abe'));
    writeFileSync(join(root, 'settings.yaml'), 'ui:\n  feel: vim\n');
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), 'logins.gh: me\ntestWrites: true\n');
    try {
      expect(yourHandedLayer({ configDir: root, home: root }, repo)).toEqual({
        machine: { ui: { feel: 'vim' } },
        local: { 'logins.gh': 'me' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('abe settings check <dir>', () => {
  const f = fixture();

  afterAll(() => {
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a checkout: its two files, each as its place says; a file's problem fails it", async () => {
    f.write('shop/abe.yaml', 'checks: [e2e]\n');
    f.write('shop/.abe/settings.local.yaml', 'models:\n  reader: haiku\n');
    const abe = await served({ env: { ABE_CONFIG_DIR: f.mine } });

    try {
      expect(
        await abe.json(SettingsCheckData, 'settings', 'check', join(f.root, 'shop')),
      ).toMatchObject({
        exit: 0,
        doc: {
          ok: true,
          data: {
            files: [
              join(f.root, 'shop', 'abe.yaml'),
              join(f.root, 'shop', '.abe', 'settings.local.yaml'),
            ],
          },
        },
      });
      f.write('shop/abe.yaml', 'agents:\n  prod: true\n');
      const bad = await abe.json(SettingsCheckData, 'settings', 'check', join(f.root, 'shop'));

      expect(bad).toMatchObject({ exit: 1, doc: { ok: false, error: { code: 'personal-only' } } });
      expect(
        (await abe.json(SettingsCheckData, 'settings', 'check', join(f.root, 'nothing'))).doc,
      ).toMatchObject({ ok: false, error: { code: 'no-layer-files' } });
    } finally {
      await abe.close();
    }
  });
});

describe('settings.changed through abe watch', () => {
  const f = fixture();
  let abe: Cli;

  beforeAll(() => {
    abe = cli({ env: { ABE_CONFIG_DIR: f.mine } });
    mkdirSync(join(abe.state.dir, '.git'));
    mkdirSync(join(abe.state.dir, '.abe'));
    writeFileSync(join(abe.state.dir, 'abe.yaml'), 'checks: [e2e]\n');
  });
  afterAll(async () => {
    await abe.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  test('a changed repo file streams the keys whose merged value changed', async () => {
    // The get has this checkout watched; `--since 0` replays what happened before watch started.
    await abe.json(SettingGetData, 'settings', 'get', 'checks');
    writeFileSync(repoFileOf(abe), 'checks: [e2e, audit2]\nlimits:\n  maxBoxDisk: 100\n');
    const w = abe.spawn('watch', '--json', '--since', '0');

    try {
      const seen = [];

      for (;;) {
        const event = Event.parse(JSON.parse(await w.next(5000)));

        if (event.type !== 'settings.changed') continue;
        seen.push(event.data);
        if (event.data.repo !== null) break;
      }
      expect(seen).toContainEqual({
        keys: ['checks', 'limits.maxBoxDisk'],
        repo: realpathSync(abe.state.dir),
      });
    } finally {
      w.signal('SIGKILL');
    }
  }, 15_000);
});

describe('abe settings list: each factory setting says Repo or Yours', () => {
  const f = fixture();
  let abe: ServedCli;

  beforeAll(async () => {
    abe = await inRepo(f, 'checks: [e2e]\nfactory.done: merged\n', 'effort: high\n');
  });
  afterAll(async () => {
    await abe.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  test('the source lines', async () => {
    const out = await abe.json(SettingsListData, 'settings', 'list');

    if (!out.doc.ok) throw new Error(out.doc.error.message);
    const source = (id: string) => out.doc.ok && out.doc.data.rows.find((r) => r.id === id)?.source;

    expect(source('factory.done')).toEqual({ kind: 'repo', layer: 'repo', text: 'Repo' });
    expect(source('effort')).toEqual({ kind: 'yours', layer: 'individual', text: 'Yours' });
    expect(source('ui.theme')).toEqual({ kind: 'yours', layer: 'individual', text: 'yours' });
    expect(source('autoMerge')).toEqual({ kind: 'built-in', layer: 'core', text: 'built-in' });
    expect(out.doc.data.scope.text).toBe(realpathSync(abe.state.dir).split('/').at(-1) ?? '');
  });
});

describe('abe settings feel', () => {
  const f = fixture();
  let abe: ServedCli;

  afterAll(async () => {
    await abe.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  test('VimStorm by default, then VS Code once your Layer picks it, a switch you set winning', async () => {
    abe = await inRepo(f, '');
    const before = await abe.json(FeelSwitches, 'settings', 'feel');

    expect(before.doc).toEqual({
      ok: true,
      data: {
        feel: 'vimstorm',
        tree: {
          autoReveal: false,
          singleClick: false,
          decorations: 'colors',
          compactFolders: false,
        },
        tabs: { limit: 10, dirtyDot: false, preview: false },
        files: { autoSave: 'onFocusChange' },
        editor: { minimap: false, vim: true },
        chat: { openByDefault: true, width: 420 },
        keys: [],
      },
    });

    f.write('mine/settings.yaml', 'ui:\n  feel: vscode\ntabs:\n  limit: 6\n');
    await abe.close();
    abe = await inRepo(f, '');
    const after = await abe.json(FeelSwitches, 'settings', 'feel');

    expect(after.doc).toEqual({
      ok: true,
      data: {
        feel: 'vscode',
        tree: { autoReveal: true, singleClick: true, decorations: 'letters', compactFolders: true },
        tabs: { limit: 6, dirtyDot: true, preview: true },
        files: { autoSave: 'off' },
        editor: { minimap: true, vim: false },
        chat: { openByDefault: true, width: 420 },
        keys: [],
      },
    });
    const text = await abe.run('settings', 'feel');

    expect(text.exit).toBe(0);
    expect(text.stdout).toBe(
      [
        'feel   vscode',
        'tree   autoReveal on · singleClick on · decorations letters · compactFolders on',
        'tabs   limit 6 · dirtyDot on · preview on',
        'files  autoSave off',
        'editor minimap on · vim off',
        'chat   openByDefault on · width 420',
        'keys   none',
        '',
      ].join('\n'),
    );
  }, 15_000);

  // #129: your keys.json's keys, each as the shell binds it; one that names no action is left out
  test('your keys.json’s keys ride with the Feel', async () => {
    abe = await inRepo(f, '');
    f.write('mine/keys.json', '{ "⌘Y": "goToFile", "⌘U": "nothing" }\n');
    const got = await abe.json(FeelSwitches, 'settings', 'feel');

    expect(got.doc).toMatchObject({
      ok: true,
      data: { keys: [{ key: '⌘Y', action: 'goToFile', lhs: ['<D-y>'], does: '<D-o>' }] },
    });
    const text = await abe.run('settings', 'feel');

    expect(text.stdout).toContain('keys   ⌘Y goToFile\n');
  }, 15_000);
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: cwd, ...GIT_ENV },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString();
};

const REPO_TEXT = 'testFiles:\n  - e2e/\n';

/** A file at a Layer repo's default branch, as the contents API answers it. */
const contents = (repo: string, path: string, text: string): [string, GhAnswer] => [
  `repos/${repo}/contents/${path}?ref=base-sha`,
  { json: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } },
];

/** An open pull request as `GET /pulls` lists it, from the repo's own branch. */
const openPull = (repo: string, number: number, ref: string) => ({
  ...ghPull(repo, number),
  head: { ref, repo: { full_name: repo } },
});

/** GitHub as the fake `gh` answers it for a Layer repo: its default branch, a file, the Git Data API. */
const layerRepo = (
  repo: string,
  file: [string, string],
  open: readonly ReturnType<typeof openPull>[],
): [string, GhAnswer][] => [
  contents(repo, file[0], file[1]),
  [`repos/${repo}/contents/`, { stderr: 'gh: Not Found (HTTP 404)', exit: 1 }],
  [`repos/${repo}/git/ref/heads/main`, { json: { object: { sha: 'base-sha' } } }],
  [`repos/${repo}/git/commits/base-sha`, { json: { sha: 'base-sha', tree: { sha: 'base-tree' } } }],
  [`-X POST repos/${repo}/git/trees`, { json: { sha: 'tree-new' } }],
  [`-X POST repos/${repo}/git/commits`, { json: { sha: 'commit-new' } }],
  [`-X POST repos/${repo}/git/refs`, { json: { object: { sha: 'commit-new' } } }],
  [`-X PATCH repos/${repo}/git/refs/heads/`, { json: {} }],
  [`-X GET repos/${repo}/pulls`, { json: open }],
  ...open.map((p): [string, GhAnswer] => [
    `pr view ${p.number} -R ${repo}`,
    { json: ghPrView(repo, p.number, { head: p.head.ref }) },
  ]),
  [`-X POST repos/${repo}/pulls`, { json: ghPull(repo, 14) }],
  [`-X PATCH repos/${repo}/pulls/14`, { json: ghPull(repo, 14) }],
  // An open pull request's head has no checks (before the repo's own answer, which takes the rest).
  ...ghChecks(GH_PR_HEAD, []),
  [`api repos/${repo}`, { json: { default_branch: 'main' } }],
];

const Tree = z.object({
  base_tree: z.string(),
  tree: z.array(z.object({ path: z.string(), content: z.string() })),
});
const Body = z.object({ title: z.string(), body: z.string() });

describe('abe settings propose on a fake gh: one pull request per setting, on the repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'abe-propose-'));
  const mine = join(root, 'mine');
  let gh: FakeGh;
  let abe: Cli;
  const answer = (open: string[] = [], first: readonly (readonly [string, GhAnswer])[] = []) => {
    gh.answer([
      ...first,
      ...layerRepo(
        'o/demo-shop',
        ['abe.yaml', REPO_TEXT],
        open.map((ref) => openPull('o/demo-shop', 15, ref)),
      ),
    ]);
  };
  const calls = (from: number, what: string) =>
    gh
      .calls()
      .slice(from)
      .filter((c) => c.argv.join(' ').includes(what));
  const propose = (...args: string[]) =>
    abe.json(SettingsProposeData, 'settings', 'propose', ...args);

  beforeAll(() => {
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'settings.yaml'), 'ui:\n  theme: islands-dark\n');
    gh = fakeGh();
    answer();
    abe = cli({ env: { PATH: `${gh.dir}:/usr/bin:/bin`, ABE_CONFIG_DIR: mine, ...GIT_ENV } });
    const shop = abe.state.dir;

    mkdirSync(join(shop, '.abe'));
    writeFileSync(join(shop, 'abe.yaml'), REPO_TEXT);
    git(shop, 'init', '-q', '-b', 'main');
    git(shop, 'remote', 'add', 'origin', 'git@github.com:o/demo-shop.git');
  });
  afterAll(async () => {
    await abe.close();
    gh.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test('to the repo: abe.yaml on the checkout’s GitHub repo, settings/repo/<key>', async () => {
    answer();
    const before = gh.calls().length;
    const out = await propose('setup', 'npm ci', '--reason', 'Pin the install');

    expect(out.doc).toMatchObject({
      ok: true,
      data: {
        repo: 'o/demo-shop',
        path: 'abe.yaml',
        branch: 'settings/repo/setup',
        updated: false,
      },
    });
    const made = Tree.parse(
      JSON.parse(calls(before, '-X POST repos/o/demo-shop/git/trees')[0]?.stdin ?? '{}'),
    );

    expect(made.tree).toEqual([{ path: 'abe.yaml', content: `${REPO_TEXT}setup: npm ci\n` }]);
    // #175: the repo as GitHub names it, never the checkout's folder.
    const asked = Body.parse(
      JSON.parse(calls(before, '-X POST repos/o/demo-shop/pulls')[0]?.stdin ?? '{}'),
    );

    expect(asked.title).toBe('Repo o/demo-shop: Worktree setup → npm ci');
    expect(asked.body).toContain('proposed for repo o/demo-shop.');
    // The checkout's own file is as it was.
    expect(readFileSync(join(abe.state.dir, 'abe.yaml'), 'utf8')).toBe(REPO_TEXT);
  });

  test('settings list fills the row’s pr from the open pull request, the repo by its GitHub name (#175)', async () => {
    answer(['settings/repo/setup']);
    const out = await abe.json(SettingsListData, 'settings', 'list');

    if (!out.doc.ok) throw new Error(out.doc.error.message);
    expect(out.doc.data.scope).toEqual({ repo: 'o/demo-shop', text: 'o/demo-shop' });
    expect(out.doc.data.rows.find((r) => r.id === 'setup')?.prs).toEqual([
      { number: 15, url: 'https://github.com/o/demo-shop/pull/15' },
    ]);
  });

  test('a checks cut is proposed as an Override (#168)', async () => {
    answer();
    const before = gh.calls().length;
    const out = await propose('checks', '[tests]', '--reason', 'only tests');

    expect(out.doc).toMatchObject({ ok: true, data: { entry: 'override' } });
    const made = Tree.parse(
      JSON.parse(calls(before, '-X POST repos/o/demo-shop/git/trees')[0]?.stdin ?? '{}'),
    );

    expect(made.tree[0]?.content).toContain(
      'overrides:\n  checks:\n    value:\n      - tests\n    reason: only tests\n',
    );
  });

  test('a setting that is yours alone, a value that does not read, no reason: refused, nothing sent', async () => {
    answer();
    const before = gh.calls().length;
    const own = await propose('agents.prod', 'true', '--reason', 'x');
    const editor = await propose('ui.feel', 'vim', '--reason', 'x');
    const big = await propose('subagents.max', '500', '--reason', 'x');
    const bare = await propose('autoMerge', 'true', '--reason', '  ');

    expect(own.doc).toMatchObject({
      ok: false,
      error: { code: 'personal-only', message: 'agents.prod: yours alone: not for the repo' },
    });
    expect(editor.doc).toMatchObject({ ok: false, error: { code: 'personal-only' } });
    expect(big.doc).toMatchObject({ ok: false, error: { code: 'invalid-setting' } });
    expect(bare.doc).toMatchObject({ ok: false, error: { code: 'reason-required' } });
    expect(gh.calls().length).toBe(before);
  });

  test('settings list still lists when GitHub does not answer: no pull requests', async () => {
    answer(
      [],
      [['-X GET repos/o/demo-shop/pulls', { stderr: 'gh: Server Error (HTTP 500)', exit: 1 }]],
    );
    const out = await abe.json(SettingsListData, 'settings', 'list');

    expect(out.doc.ok).toBe(true);
    if (out.doc.ok) expect(out.doc.data.rows.every((r) => r.prs.length === 0)).toBe(true);
  });

  test('settings check and problems in a GitHub repo never ask for branch protection (#196: not required)', async () => {
    answer();
    const before = gh.calls().length;
    const checked = await abe.json(SettingsCheckData, 'settings', 'check', abe.state.dir);

    expect(checked).toMatchObject({ exit: 0, doc: { ok: true } });
    const problems = await abe.json(SettingsProblemsData, 'settings', 'problems');

    expect(problems.doc.ok).toBe(true);
    expect(
      gh
        .calls()
        .slice(before)
        .filter((c) => /protection|rules\/branches|default_branch/.test(c.argv.join(' '))),
    ).toEqual([]);
  });
});
