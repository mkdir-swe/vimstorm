/**
 * A Layer's file opened and changed (#15 stories 24, 26–28, 36) on an in-process `serve`: the
 * readable side and problems (`workflow read`), Edit my copy (`copy`), Propose (a fake `gh` for
 * the repo's Git Data API), Change with AI and Retro on a file (the fake `claude -p`).
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
  newRun,
  runWorkflowOf,
  WorkflowChangeData,
  WorkflowCopyData,
  WorkflowProposeData,
  WorkflowReadData,
  WorkflowRetroData,
  WorkflowsData,
} from '@abe/core';
import {
  claudeOneShot,
  ghLayerPullsFrom,
  copyAbeFiles,
  ghTrackingFrom,
  writeRun,
} from '@abe/ports';
import {
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  type GhAnswer,
  ghPull,
  NOT_FOUND,
  oneShotCalls,
  scriptOneShot,
  served,
  type ServedCli,
  T0,
  tempState,
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
};

const HOTFIX =
  'name: Hotfix\ndescription: A small bug, straight to a PR.\non: bug\nsteps:\n  - implement\n  - verify\n  - pr\n';
const UI_BUG = 'name: UI bug\nsteps:\n  - scout\n  - verify\n  - implement\n  - pr\n';

const GH: [string, GhAnswer][] = [
  ['-X GET repos/o/shop/pulls', { json: [] }],
  ['-X POST repos/o/shop/pulls', { json: ghPull('o/shop', 61) }],
  ['repos/o/shop/contents/', NOT_FOUND],
  ['repos/o/shop/git/ref/heads/main', { json: { object: { sha: 'base-sha' } } }],
  ['repos/o/shop/git/commits/base-sha', { json: { sha: 'base-sha', tree: { sha: 'base-tree' } } }],
  ['-X POST repos/o/shop/git/trees', { json: { sha: 'tree-new' } }],
  ['-X POST repos/o/shop/git/commits', { json: { sha: 'commit-new' } }],
  ['-X POST repos/o/shop/git/refs', { json: { object: { sha: 'commit-new' } } }],
  ['api repos/o/shop', { json: { default_branch: 'main' } }],
];

let root = '';
let mine = '';
let demo = '';
let gh: FakeGh;
let claude: FakeClaude;
let abe: ServedCli;

const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const answer = (doc: unknown) => {
  scriptOneShot(abe.state.dir, { answers: [JSON.stringify(doc)] });
};
/** The repo's: its own file in abe/workflows/ (ADR 0033). */
const hotfix = () => join(demo, 'abe/workflows/hotfix.yaml');
/** Yours beside the repo's: never committed. */
const uiBug = () => join(demo, '.abe/workflows/ui-bug.local.yaml');
const myHotfix = () => join(demo, '.abe/workflows/hotfix.local.yaml');
const json = async <T extends z.ZodType>(schema: T, ...argv: string[]) => {
  const { doc } = await abe.jsonWith({ cwd: join(root, 'demo') }, schema, 'workflow', ...argv);

  return doc;
};
const ok = async <T extends z.ZodType>(schema: T, ...argv: string[]): Promise<z.output<T>> => {
  const doc = await json(schema, ...argv);

  if (!doc.ok) throw new Error(doc.error.message);

  return doc.data;
};

beforeAll(async () => {
  // real: the repo Layer's files are named under the checkout's real path
  root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-wfe-')));
  mine = join(root, 'mine');
  demo = join(root, 'demo');
  put(join(mine, 'settings.yaml'), 'serve.target: local\n');
  // installed: Abe's workflows and skills are the repo's copies in abe/ (ADR 0033)
  copyAbeFiles(demo, '3.3.1');
  put(hotfix(), HOTFIX);
  put(
    join(demo, '.claude/skills/unslop/SKILL.md'),
    '---\nname: unslop\ndescription: Plain text.\n---\n# unslop\n',
  );
  put(join(demo, '.claude/skills/unslop/rules.md'), '- short\n');
  put(join(demo, '.claude/skills/unslop/ports.json'), '{ "web": 3000 }\n');
  git(root, 'init', '-q', '-b', 'main', demo);
  git(demo, 'add', '.');
  git(demo, 'commit', '-q', '-m', 'first');
  git(demo, 'remote', 'add', 'origin', 'https://github.com/o/shop.git');
  put(uiBug(), UI_BUG);
  gh = fakeGh(GH);
  claude = fakeClaude();
  const state = tempState();
  const layers = { ABE_CONFIG_DIR: mine };
  const own = { PATH: `${claude.dir}:${gh.dir}:/usr/bin:/bin`, ...GIT_ENV };
  const env = { ...state.env, ...layers, ...own };

  abe = await served({
    state,
    env: layers,
    sessions: { env: own },
    tracking: ghTrackingFrom(env),
    layerPulls: ghLayerPullsFrom(env),
    oneShot: claudeOneShot(),
  });
});

afterAll(async () => {
  await abe.close();
  gh.remove();
  claude.remove();
  rmSync(root, { recursive: true, force: true });
});

describe('abe workflow read: the readable side, whose it is, the problems with their fixes', () => {
  test("the repo's workflow: the checkout's own file, changed in place, its steps in words", async () => {
    const d = await ok(WorkflowReadData, 'read', hotfix());

    expect(d).toMatchObject({ kind: 'workflow', layer: 'repo', id: 'hotfix', readOnly: false });
    expect(d.mine).toBeNull();
    expect(d.markdown.split('\n').slice(0, 5)).toEqual([
      '# Hotfix',
      '',
      "*from repo demo* · The team's file: commit it like the code.",
      '',
      '[Change with AI ⌘G](abe:change) · [Retro…](abe:retro)',
    ]);
    expect(d.markdown).toContain('## Runs on\n\na bug card\n');
    // go to definition: each step's line to its skill's SKILL.md, the repo's copy of Abe's
    expect(d.defs).toEqual(
      ['implement', 'verify', 'pr'].map((name, i) => ({
        line: 5 + i,
        name,
        path: join(demo, `abe/skills/${name}/SKILL.md`),
      })),
    );
    // find usages from a skill: the steps running it
    const implement = await ok(
      WorkflowReadData,
      'read',
      join(demo, 'abe/skills/implement/SKILL.md'),
    );

    expect(implement.refs).toContainEqual({ path: hotfix(), line: 5, text: 'Hotfix · implement' });
  });

  test('the text the Editor has now: its problems, each fix one that takes it away', async () => {
    const d = await ok(
      WorkflowReadData,
      'read',
      uiBug(),
      '--text',
      UI_BUG.replace('scout', 'scuot'),
    );

    expect(d.readOnly).toBe(false);
    expect(d.problems.map((p) => [p.code, p.line, p.fixes.map((f) => f.title)])).toEqual([
      ['unknown-skill', 3, ['Remove step scuot']],
      ['needs-build', 4, ['Move verify after implement']],
    ]);
    expect(d.problems[1]?.fixes[0]?.text).toBe(
      'name: UI bug\nsteps:\n  - scuot\n  - implement\n  - verify\n  - pr\n',
    );
    expect(d.markdown).toContain("> **Can't run ui-bug.yaml**: line 3, No skill named scuot");
    expect(d.text).toBe(UI_BUG.replace('scout', 'scuot'));
    // the preview beside the YAML: a card per step top to bottom, each problem under its card
    expect(d.preview?.problems.map((p) => p.line)).toEqual([3, 4]);
    expect(d.preview?.steps.map((x) => [x.name, x.skill, x.bad, x.line, x.about])).toEqual([
      ['scuot', 'scuot', true, 3, '✗ no such skill'],
      ['verify', 'verify', true, 4, expect.any(String)],
      ['implement', 'implement', false, 5, expect.any(String)],
      ['pr', 'pr', false, 6, expect.any(String)],
    ]);
    expect(d.preview).toMatchObject({
      badges: [
        { text: 'Yours', hue: 'dim' },
        { text: 'picked by hand', hue: 'accent' },
      ],
      summary: '4 steps',
      banner:
        '✗ 2 problems · not loadable. No card gets UI bug until it loads. Line 3: No skill named scuot in any Layer',
      end: 'a pull request',
    });
  });

  test('Abe’s, copied in: the repo’s file, changed in place; a skill’s file', async () => {
    const feature = await ok(WorkflowReadData, 'read', join(demo, 'abe/workflows/feature.yaml'));

    expect(feature).toMatchObject({ layer: 'repo', id: 'feature', readOnly: false });
    const skill = await ok(WorkflowReadData, 'read', join(demo, '.claude/skills/unslop/SKILL.md'));

    expect(skill).toMatchObject({ kind: 'skill', id: 'unslop', layer: 'repo', readOnly: false });
    expect(skill.markdown).toContain('\n# unslop\n');
    expect(skill.text.startsWith('---\nname: unslop\n')).toBe(true);
    expect(skill.body.startsWith('# unslop\n')).toBe(true);
  });

  test('a file no Layer has is refused', async () => {
    const doc = await json(WorkflowReadData, 'read', join(root, 'demo/.github/workflows/ci.yaml'));

    expect(doc).toMatchObject({ ok: false, error: { code: 'not-a-layer-file' } });
  });

  test("a skill folder's markdown is a Layer's file; its JSON or script is not", async () => {
    const rules = await ok(WorkflowReadData, 'read', join(demo, '.claude/skills/unslop/rules.md'));

    expect(rules).toMatchObject({ kind: 'skill', id: 'unslop' });
    const doc = await json(
      WorkflowReadData,
      'read',
      join(demo, '.claude/skills/unslop/ports.json'),
    );

    expect(doc).toMatchObject({ ok: false, error: { code: 'not-a-layer-file' } });
  });
});

describe('Edit my copy, then Propose: a pull request on the Layer it is a copy of', () => {
  test("the repo's workflow copied into yours: it wins for you; again answers it", async () => {
    const copy = await ok(WorkflowCopyData, 'copy', hotfix());
    const path = myHotfix();

    expect(copy).toEqual({ from: hotfix(), layer: 'repo', path, existed: false });
    expect(readFileSync(path, 'utf8')).toBe(HOTFIX);
    // never committed: Abe's exclude block holds yours beside the repo's, the repo's id with them
    expect(readFileSync(join(demo, '.git/info/exclude'), 'utf8')).toContain(
      '# abe install: kept out of git\n.abe/id\n.abe/settings.local.yaml\n.abe/workflows/*.local.yaml\n',
    );
    expect(
      Bun.spawnSync(['git', '-C', demo, 'status', '--porcelain'], {
        env: { PATH: '/usr/bin:/bin' },
      }).stdout.toString(),
    ).toBe('');
    expect(await ok(WorkflowCopyData, 'copy', hotfix())).toMatchObject({ existed: true });
    const list = await ok(WorkflowsData, 'list');

    expect(
      list.workflows.filter((w) => w.id === 'hotfix').map((w) => [w.layer, w.inForce]),
    ).toEqual([
      ['yours', true],
      ['repo', false],
    ]);
    expect(await ok(WorkflowReadData, 'read', hotfix())).toMatchObject({ mine: path });
    const yours = await ok(WorkflowReadData, 'read', path);

    expect(yours).toMatchObject({
      readOnly: false,
      proposeTo: 'repo',
      compare: { layer: 'repo', theirs: hotfix(), mine: path },
    });
    expect(yours.markdown).toContain('[Propose to repo demo…](abe:propose)');
  });

  test("a skill's whole folder is copied", async () => {
    const copy = await ok(WorkflowCopyData, 'copy', join(demo, '.claude/skills/unslop/rules.md'));

    expect(copy.path).toBe(join(mine, 'skills/unslop/rules.md'));
    expect(existsSync(join(mine, 'skills/unslop/SKILL.md'))).toBe(true);
  });

  test("your copy proposed: one commit on the repo's default branch, its pull request", async () => {
    const path = myHotfix();

    writeFileSync(path, HOTFIX.replace('  - verify\n', '  - code-review\n  - verify\n'));
    const before = gh.calls().length;
    const out = await ok(
      WorkflowProposeData,
      'propose',
      path,
      '--why',
      '3 of 12 runs broke at verify',
    );

    expect(out).toEqual({
      path,
      to: 'repo',
      where: 'repo demo',
      repo: 'o/shop',
      branch: 'abe/propose-workflow-hotfix',
      files: ['abe/workflows/hotfix.yaml'],
      pr: { number: 61, url: 'https://github.com/o/shop/pull/61' },
      existing: false,
      held: false,
    });
    const sent = (what: string) =>
      gh
        .calls()
        .slice(before)
        .find((c) => c.argv.join(' ').includes(`-X POST repos/o/shop/${what}`));
    const tree = z
      .object({ tree: z.array(z.object({ path: z.string(), content: z.string() })) })
      .parse(JSON.parse(sent('git/trees')?.stdin ?? '{}'));

    // the repo's abe/workflows/hotfix.yaml, your copy's text
    expect(tree.tree).toEqual([
      { path: 'abe/workflows/hotfix.yaml', content: readFileSync(path, 'utf8') },
    ]);
    expect(JSON.parse(sent('pulls')?.stdin ?? '{}')).toMatchObject({
      head: 'abe/propose-workflow-hotfix',
      title: 'repo demo: hotfix from a copy',
    });
  });

  test.each<[string, () => string[], string]>([
    ["the repo's own file: copy first", () => ['propose', hotfix(), '--why', 'x'], 'not-your-copy'],
    [
      'your own, over no farther Layer',
      () => ['propose', uiBug(), '--why', 'x'],
      'nothing-to-propose-to',
    ],
    ['no why', () => ['propose', myHotfix(), '--why', ' '], 'reason-required'],
  ])('refused: %s', async (_, argv, code) => {
    expect(await json(WorkflowProposeData, ...argv())).toMatchObject({
      ok: false,
      error: { code },
    });
  });
});

describe('local mode: a proposal is held on this Mac, never sent', () => {
  test('held where the checkout asked in is in local mode', async () => {
    await abe.jsonWith({ cwd: demo }, z.unknown(), 'local', 'on');
    const before = gh.calls().length;
    const out = await ok(WorkflowProposeData, 'propose', myHotfix(), '--why', 'try it here first');

    expect(out).toMatchObject({ held: true, where: 'repo demo' });
    expect(
      gh
        .calls()
        .slice(before)
        .filter((c) => c.argv.includes('POST')),
    ).toEqual([]);
    const status = await abe.jsonWith(
      { cwd: demo },
      z.object({ held: z.array(z.object({ kind: z.string() })) }),
      'local',
      'status',
    );

    expect(status.doc).toMatchObject({ ok: true, data: { held: [{ kind: 'layer-propose' }] } });
    await abe.jsonWith({ cwd: demo }, z.unknown(), 'local', 'off');
  });
});

describe('Change with AI', () => {
  test('a change answers the whole file after it, nothing written', async () => {
    const after = UI_BUG.replace('  - verify\n  - implement\n', '  - implement\n  - verify\n');

    answer({ summary: 'verify after the build', text: after });
    const d = await ok(WorkflowChangeData, 'change', uiBug(), 'fix', 'the', 'order');

    expect(d).toMatchObject({
      summary: 'verify after the build',
      before: UI_BUG,
      text: after,
      problems: 1,
      written: null,
    });
    // the changed text as the load check reads it
    expect(d.view?.steps.map((x) => x.name)).toEqual(['scout', 'implement', 'verify', 'pr']);
    expect(readFileSync(uiBug(), 'utf8')).toBe(UI_BUG);
    // (no Layer has scout: the change says so as a count)
    const call = oneShotCalls(abe.state.dir).at(-1);

    expect(call?.prompt).toContain('Change this workflow file: fix the order');
    expect(call?.prompt).toContain('### The skills the Layers have');
  });

  test("--write on the repo's file writes your copy", async () => {
    rmSync(myHotfix());
    answer({
      summary: 'a review first',
      text: HOTFIX.replace('  - verify\n', '  - code-review\n  - verify\n'),
    });
    const d = await ok(WorkflowChangeData, 'change', hotfix(), 'add a review', '--write');

    expect(d.written).toBe(myHotfix());
    expect(readFileSync(myHotfix(), 'utf8')).toContain('code-review');
    expect(readFileSync(hotfix(), 'utf8')).toBe(HOTFIX);
  });
});

describe('Retro on a file: its runs here, findings, a fix kept for the readable side', () => {
  test('the runs of that workflow only; a fix that does not load is dropped, the finding kept', async () => {
    const theirs = (await ok(WorkflowsData, 'list')).workflows.find(
      (w) => w.id === 'hotfix' && w.layer === 'repo',
    );

    if (theirs === undefined) throw new Error('no hotfix');
    const run = (
      session: string,
      card: number,
      ago: number,
      o: Partial<ReturnType<typeof newRun>>,
    ) => {
      writeRun(abe.state.dir, {
        ...newRun({
          session,
          card,
          title: `Card ${card}`,
          repo: '/r',
          worktree: '/w',
          at: new Date(T0 - ago).toISOString(),
        }),
        workflow: runWorkflowOf(theirs),
        ...o,
      });
    };

    run('s-1272', 1272, 0, {
      stage: 'verify',
      step: 'verify',
      needsYou: { reason: 'red', since: new Date(T0).toISOString() },
    });
    run('s-1255', 1255, 3_600_000, { stage: 'done', step: null, outcome: 'done' });
    answer({
      findings: [
        {
          severity: 'high',
          title: 'Steps',
          what: 'Runs broke at verify on a type error.',
          moments: ['#1272 verify'],
          fix: {
            summary: 'a review before verify',
            text: HOTFIX.replace('  - verify\n', '  - code-review\n  - verify\n'),
          },
        },
        {
          severity: 'low',
          title: 'Steps',
          what: 'x',
          moments: ['#1255'],
          fix: { summary: 'broken', text: 'steps: [' },
        },
      ],
    });
    const d = await ok(WorkflowRetroData, 'retro', hotfix());

    expect(d.runs.map((r) => [r.card, r.outcome])).toEqual([
      [1272, 'stopped at verify'],
      [1255, 'done'],
    ]);
    expect(d.findings.map((f) => f.fix?.summary ?? null)).toEqual(['a review before verify', null]);
    const read = await ok(WorkflowReadData, 'read', hotfix());

    expect(read.markdown).toContain('## Retro · 2 runs read');
    expect(read.markdown).toContain('[Fix it in the file: a review before verify](abe:fix/1)');
  });
});
