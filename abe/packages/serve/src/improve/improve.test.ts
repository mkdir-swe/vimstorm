/**
 * `abe improve` on an in-process `serve` (`served`): the fake `claude` answering the one-shot, a
 * fake `gh` for the VimStorm issue, a temporary personal Layer, and a checkout `shop` the
 * commands are typed in (yours for it, `.abe/settings.local.yaml`, takes a factory setting). The
 * real `abe` runs the personal commands (client-side) and checks `improve`'s exit code and
 * `--json` document once.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventLine,
  HelpData,
  IMPROVE_SKILL,
  ImproveApplyData,
  ImproveData,
  ImproveSuggestData,
  ImproveUndoData,
  SettingGetData,
  StatusData,
} from '@abe/core';
import { claudeOneShot, ghTrackingFrom, githubLoginsFrom } from '@abe/ports';
import {
  cli,
  FAKE_GITHUB_TOKEN,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  type GhAnswer,
  ghIssue,
  NOT_FOUND,
  oneShotCalls,
  scriptOneShot,
  served,
  type ServedCli,
  tempState,
  watching,
  type Watching,
} from '@abe/testing';
import { z } from 'zod';

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

const SETTINGS = '# mine\nui.density: compact\n';

/** GitHub as the fake `gh` answers it: the VimStorm issue. */
const GH: [string, GhAnswer][] = [
  ['auth token --hostname github.com --user me-work', { stdout: `${FAKE_GITHUB_TOKEN}\n` }],
  ['-X POST repos/mkdir-swe/vimstorm/issues', { json: ghIssue('mkdir-swe/vimstorm', 101) }],
  ['issues/101/sub_issues', { json: [] }],
  ['issues/101/parent', NOT_FOUND],
  [
    'repos/mkdir-swe/vimstorm/issues/101',
    { json: ghIssue('mkdir-swe/vimstorm', 101, { title: 'A view of my own' }) },
  ],
];

type World = {
  root: string;
  mine: string;
  /** The checkout `shop`: where every command is typed. */
  repo: string;
  gh: FakeGh;
  claude: FakeClaude;
  abe: ServedCli;
};

const world = async (): Promise<World> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-improve-')));
  const mine = join(root, 'mine');
  const repo = join(root, 'shop');

  mkdirSync(mine);
  mkdirSync(join(repo, '.abe'), { recursive: true });
  writeFileSync(join(mine, 'settings.yaml'), SETTINGS);
  writeFileSync(join(repo, 'abe.yaml'), 'environments: {}\n');
  // yours for the repo: there already, so the one-time move has nothing to do
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  git(root, 'init', '-q', '-b', 'main', repo);
  const gh = fakeGh(GH);
  const claude = fakeClaude();
  const state = tempState();
  const layers = { ABE_CONFIG_DIR: mine };
  const own = { PATH: `${claude.dir}:${gh.dir}:/usr/bin:/bin`, ...GIT_ENV };
  // As the real serve wires them, over its environment (gh on its PATH).
  const env = { ...state.env, ...layers, ...own };
  const abe = await served({
    state,
    cwd: repo,
    env: layers,
    sessions: { env: own },
    tracking: ghTrackingFrom(env),
    github: githubLoginsFrom(env),
    oneShot: claudeOneShot(),
  });

  return { root, mine, repo, gh, claude, abe };
};

const change = (summary: string, files: { path: string; after: string | null }[]) =>
  JSON.stringify({ kind: 'change', summary, files });

const SettingsChanged = z.object({
  type: z.literal('settings.changed'),
  data: z.object({ keys: z.array(z.string()), files: z.array(z.string()).optional() }),
});

describe('abe improve on a fake claude -p, a fake gh and a checkout', () => {
  let w: World;
  let watch: Watching;
  const at = (path: string) => join(w.mine, path);
  const read = (path: string) => (existsSync(at(path)) ? readFileSync(at(path), 'utf8') : null);
  const answer = (text: string) => {
    scriptOneShot(w.abe.state.dir, { answers: [text] });
  };
  const improve = async (wish: string) => w.abe.json(ImproveData, 'improve', wish);
  const proposed = async (wish: string) => {
    const out = await improve(wish);

    if (!out.doc.ok || out.doc.data.kind !== 'proposal')
      throw new Error(`no proposal: ${JSON.stringify(out.doc)}`);

    return out.doc.data.proposal;
  };
  const nextFilesChanged = async () => {
    for (;;) {
      const event = SettingsChanged.safeParse(
        EventLine.parse(JSON.parse(await watch.next(20_000))),
      );

      if (event.success && event.data.data.files !== undefined) return event.data.data;
    }
  };

  beforeAll(async () => {
    w = await world();
    watch = watching(w.abe.state.socket);
  });

  afterAll(async () => {
    watch.close();
    await w.abe.close();
    w.gh.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('a wish answers a proposal: a before and after of personal files, nothing written', async () => {
    answer(
      change('⌘⌥A also closes Chat, and your skills ride on top', [
        { path: 'keys.json', after: '{\n  "⌘⌥A": ["abe.lastView", "chat.hideInWorkspace"]\n}\n' },
        { path: 'settings.yaml', after: `${SETTINGS}tabs.limit: 5\n` },
      ]),
    );
    const p = await proposed('make ⌘⌥A also close Chat');

    expect(p.id).toMatch(/^imp-[0-9a-f]{6}$/);
    expect(p.wish).toBe('make ⌘⌥A also close Chat');
    expect(p.files).toEqual([
      {
        path: 'keys.json',
        before: null,
        after: '{\n  "⌘⌥A": ["abe.lastView", "chat.hideInWorkspace"]\n}\n',
      },
      { path: 'settings.yaml', before: SETTINGS, after: `${SETTINGS}tabs.limit: 5\n` },
    ]);
    expect(read('keys.json')).toBeNull();
    expect(read('settings.yaml')).toBe(SETTINGS);
    const call = oneShotCalls(w.abe.state.dir).at(-1);

    expect(call?.argv.slice(0, 3)).toEqual(['-p', '--model', 'opus']);
    expect(call?.argv.at(-1)).toBe(IMPROVE_SKILL);
    expect(call?.prompt).toContain('make ⌘⌥A also close Chat');
    expect(call?.prompt).toContain('### settings.yaml\n\n```\n# mine\nui.density: compact\n```');
    const text = await w.abe.run('improve', 'show it in text');

    expect(text.stdout).toContain('settings.yaml (changed)\n  + tabs.limit: 5\n');
  });

  test('a path outside the personal Layer is refused and nothing is kept or written', async () => {
    answer(
      change('Change things', [
        { path: 'keys.json', after: '{}\n' },
        { path: '../shop/abe.yaml', after: 'evil: true\n' },
        { path: '/etc/hosts', after: '' },
      ]),
    );
    const out = await improve('change the repo');

    expect(out.exit).toBe(1);
    expect(out.doc).toEqual({
      ok: false,
      error: {
        code: 'outside-personal-layer',
        message: 'outside your personal Layer: ../shop/abe.yaml; /etc/hosts',
      },
    });
    expect(read('keys.json')).toBeNull();
    expect(readFileSync(join(w.repo, 'abe.yaml'), 'utf8')).toBe('environments: {}\n');
  });

  test('apply writes it and emits settings.changed; undo restores files and deletions exactly, one further back each time', async () => {
    answer(
      change('Five tabs', [
        { path: 'settings.yaml', after: `${SETTINGS}tabs.limit: 5\n` },
        { path: 'keys.json', after: '{ "⌘5": "chat.toggle" }\n' },
      ]),
    );
    const first = await proposed('five tabs at most');
    const applied = await w.abe.json(ImproveApplyData, 'improve', 'apply', first.id);

    expect(applied.doc).toEqual({
      ok: true,
      data: {
        id: first.id,
        files: [
          { path: 'settings.yaml', file: at('settings.yaml'), change: 'changed' },
          { path: 'keys.json', file: at('keys.json'), change: 'created' },
        ],
        undo: 1,
      },
    });
    expect(await nextFilesChanged()).toEqual({ keys: [], files: ['settings.yaml', 'keys.json'] });
    expect(read('settings.yaml')).toBe(`${SETTINGS}tabs.limit: 5\n`);
    const setting = await w.abe.json(SettingGetData, 'settings', 'get', 'tabs.limit');

    expect(setting.doc).toMatchObject({ ok: true, data: { value: 5, layer: 'individual' } });
    const again = await w.abe.json(ImproveApplyData, 'improve', 'apply', first.id);

    expect(again.doc).toMatchObject({ ok: false, error: { code: 'already-applied' } });

    answer(
      change('A command for my status, no key file', [
        { path: 'commands.yaml', after: 'st: { argv: [status], summary: how serve is }\n' },
        { path: 'keys.json', after: null },
      ]),
    );
    const second = await proposed('a short status command');

    expect(second.files).toEqual([
      {
        path: 'commands.yaml',
        before: null,
        after: 'st: { argv: [status], summary: how serve is }\n',
      },
      { path: 'keys.json', before: '{ "⌘5": "chat.toggle" }\n', after: null },
    ]);
    expect((await w.abe.json(ImproveApplyData, 'improve', 'apply', second.id)).doc).toMatchObject({
      ok: true,
      data: { undo: 2 },
    });
    expect(read('keys.json')).toBeNull();

    const back = await w.abe.json(ImproveUndoData, 'improve', 'undo');

    expect(back.doc).toEqual({
      ok: true,
      data: {
        id: second.id,
        summary: second.summary,
        files: [
          { path: 'commands.yaml', file: at('commands.yaml'), change: 'deleted' },
          { path: 'keys.json', file: at('keys.json'), change: 'created' },
        ],
        left: 1,
      },
    });
    expect(read('commands.yaml')).toBeNull();
    expect(read('keys.json')).toBe('{ "⌘5": "chat.toggle" }\n');
    expect((await w.abe.json(ImproveUndoData, 'improve', 'undo')).doc).toMatchObject({
      ok: true,
      data: { id: first.id, left: 0 },
    });
    expect(read('settings.yaml')).toBe(SETTINGS);
    expect(read('keys.json')).toBeNull();
    expect((await w.abe.json(ImproveUndoData, 'improve', 'undo')).doc).toMatchObject({
      ok: false,
      error: { code: 'nothing-to-undo' },
    });
  });

  test('undo refuses to overwrite a change made since the apply, unless forced', async () => {
    answer(change('Keys', [{ path: 'keys.json', after: '{ "a": "b" }\n' }]));
    const p = await proposed('a key');

    await w.abe.json(ImproveApplyData, 'improve', 'apply', p.id);
    writeFileSync(at('keys.json'), '{ "a": "c" }\n');
    const refusedUndo = await w.abe.json(ImproveUndoData, 'improve', 'undo');

    expect(refusedUndo.doc).toMatchObject({ ok: false, error: { code: 'stale-undo' } });
    expect(read('keys.json')).toBe('{ "a": "c" }\n');
    const forced = await w.abe.json(ImproveUndoData, 'improve', 'undo', '--force');

    expect(forced.doc).toMatchObject({ ok: true, data: { id: p.id } });
    expect(read('keys.json')).toBeNull();
  });

  test('a link out of the personal Layer is refused', async () => {
    const elsewhere = join(w.root, 'elsewhere');

    mkdirSync(elsewhere);
    symlinkSync(elsewhere, at('skills'));
    answer(change('A skill', [{ path: 'skills/standup/SKILL.md', after: '# Standup\n' }]));
    const out = await improve('a standup skill');

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'outside-personal-layer' } });
    expect(existsSync(join(elsewhere, 'standup'))).toBe(false);
    rmSync(at('skills'));
  });

  test('a setting core opts in by Override is refused in a proposal', async () => {
    answer(
      change('Merge myself', [{ path: 'settings.yaml', after: `${SETTINGS}autoMerge: true\n` }]),
    );
    const out = await improve('merge my pull requests automatically');

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'invalid-proposal' } });
  });

  test('a stale proposal is refused: the file changed since', async () => {
    answer(change('Keys', [{ path: 'keys.json', after: '{}\n' }]));
    const p = await proposed('empty keys');

    writeFileSync(at('keys.json'), '{ "x": "y" }\n');
    const out = await w.abe.json(ImproveApplyData, 'improve', 'apply', p.id);

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'stale-proposal' } });
    expect(read('keys.json')).toBe('{ "x": "y" }\n');
    rmSync(at('keys.json'));
  });

  test('personal commands, the real abe (client-side): Command mode lists them (abe help --json), abe <word> runs one', async () => {
    answer(
      change('st runs status', [
        {
          path: 'commands.yaml',
          after: 'st: { argv: [status], summary: how serve is }\nbad: [nothing]\n',
        },
      ]),
    );
    const refusedOut = await improve('a bad command');

    expect(refusedOut.doc).toMatchObject({ ok: false, error: { code: 'invalid-proposal' } });
    answer(
      change('st runs status', [
        { path: 'commands.yaml', after: 'st: { argv: [status], summary: how serve is }\n' },
      ]),
    );
    const p = await proposed('a short status command');

    await w.abe.json(ImproveApplyData, 'improve', 'apply', p.id);
    const abe = cli({ env: { ABE_CONFIG_DIR: w.mine }, cwd: w.repo });

    try {
      const listed = await abe.json(HelpData, 'help');

      expect(listed.doc).toMatchObject({
        ok: true,
        data: { personal: [{ name: 'st', argv: ['status'], summary: 'how serve is' }] },
      });
      expect((await abe.run('help')).stdout).toContain('your own commands (commands.yaml):\n  st');
      const ran = await abe.json(StatusData, 'st');

      expect(ran.exit).toBe(0);
      expect(ran.doc.ok).toBe(true);
      // improve's exit code and --json through the process: its own serve has nothing to undo.
      const none = await abe.json(ImproveUndoData, 'improve', 'undo');

      expect(none.exit).toBe(1);
      expect(none.doc).toMatchObject({ ok: false, error: { code: 'nothing-to-undo' } });
    } finally {
      await abe.close();
    }
    await w.abe.json(ImproveUndoData, 'improve', 'undo');
  });

  test('the Neovim config: a proposal holds it', async () => {
    answer(
      change('Relative numbers', [
        { path: 'nvim/init.lua', after: 'vim.o.relativenumber = true\n' },
      ]),
    );
    const dev = await proposed('relative line numbers');

    expect(dev.files).toEqual([
      { path: 'nvim/init.lua', before: null, after: 'vim.o.relativenumber = true\n' },
    ]);
    writeFileSync(at('settings.yaml'), SETTINGS);
  });

  test('a code wish is a draft issue on Abe for the person to read, and changes nothing', async () => {
    answer(
      JSON.stringify({
        kind: 'needs-code',
        title: 'A view of my own',
        body: 'They want a new chart view.',
      }),
    );
    const before = w.gh.calls().length;
    const out = await improve('a burn-down chart on the overview');
    const data = ImproveData.parse(z.object({ data: z.unknown() }).parse(out.doc).data);

    expect(data).toMatchObject({
      kind: 'needs-code',
      wish: 'a burn-down chart on the overview',
      draft: { repo: 'mkdir-swe/vimstorm', title: 'A view of my own' },
      issues: 'mkdir-swe/vimstorm',
    });
    expect(data.kind === 'needs-code' && data.draft.body).toContain('They want a new chart view.');
    expect(
      w.gh
        .calls()
        .slice(before)
        .some((c) => c.argv.includes('POST')),
    ).toBe(false);
    expect(read('settings.yaml')).toBe(SETTINGS);
    expect(read('keys.json')).toBeNull();
  });

  test("a factory setting goes to yours for the repo (ADR 0030): this Mac's file keeps the rest", async () => {
    const local = join(w.repo, '.abe', 'settings.local.yaml');

    answer(
      change('Skills on top, five tabs', [
        { path: 'settings.yaml', after: `${SETTINGS}skillsOnTop: true\ntabs.limit: 5\n` },
      ]),
    );
    const p = await proposed('my skills on top, five tabs');

    expect(p.files).toEqual([
      { path: 'settings.yaml', before: SETTINGS, after: `${SETTINGS}tabs.limit: 5\n` },
      { path: local, before: '', after: 'skillsOnTop: true\n' },
    ]);
    const applied = await w.abe.json(ImproveApplyData, 'improve', 'apply', p.id);

    expect(applied.doc).toMatchObject({
      ok: true,
      data: { files: [{ file: at('settings.yaml') }, { path: local, file: local }] },
    });
    expect(readFileSync(local, 'utf8')).toBe('skillsOnTop: true\n');
    expect(read('settings.yaml')).toBe(`${SETTINGS}tabs.limit: 5\n`);
    const setting = await w.abe.json(SettingGetData, 'settings', 'get', 'skillsOnTop');

    expect(setting.doc).toMatchObject({ ok: true, data: { value: true } });
    expect((await w.abe.json(ImproveUndoData, 'improve', 'undo')).doc).toMatchObject({ ok: true });
    expect(readFileSync(local, 'utf8')).toBe('');
    expect(read('settings.yaml')).toBe(SETTINGS);
  });

  test('suggestions: off by default; opted in, at most once in 24 hours', async () => {
    const off = await w.abe.json(ImproveSuggestData, 'improve', 'suggest');

    expect(off.doc).toMatchObject({ ok: false, error: { code: 'suggest-off' } });
    writeFileSync(at('settings.yaml'), `${SETTINGS}improve.suggest: true\n`);
    answer(change('A command for status', [{ path: 'commands.yaml', after: 'st: [status]\n' }]));
    const first = await w.abe.json(ImproveSuggestData, 'improve', 'suggest');

    expect(first.doc).toMatchObject({
      ok: true,
      data: { suggestion: { kind: 'proposal', proposal: { summary: 'A command for status' } } },
    });
    expect(oneShotCalls(w.abe.state.dir).at(-1)?.prompt).toContain('- abe improve apply');
    expect(read('commands.yaml')).toBeNull();
    const second = await w.abe.json(ImproveSuggestData, 'improve', 'suggest');

    expect(second.doc).toMatchObject({ ok: false, error: { code: 'suggested-today' } });
  });
});
