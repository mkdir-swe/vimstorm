/**
 * `abe workflow list` (#15): a real `serve` in this process over disposable Layers (yours: your
 * skills in your config folder and the checkout's `.abe/workflows/<id>.local.yaml`; the repo's
 * `abe/workflows/<id>.yaml` and `.claude/skills/`) and core's built-in ones.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_WORKFLOW,
  newRun,
  preselected,
  runWorkflowOf,
  unmetTypes,
  WORKFLOW_GUIDE,
  WorkflowPathData,
  WorkflowsData,
  WorkflowTreeData,
  WorkflowUpdateData,
  AbeInstalled,
} from '@abe/core';
import { copyAbeFiles, writeRun } from '@abe/ports';
import { served, type ServedCli, T0 } from '@abe/testing';

let root = '';
let abe: ServedCli;

const put = (path: string, text: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'abe-wf-'));
  put('mine/settings.yaml', 'serve.target: local\n');
  put(
    'mine/skills/reproduce/SKILL.md',
    '---\nname: reproduce\ndescription: >-\n  Reproduce the bug\n  first.\n---\n',
  );
  put('mine/skills/reproduce/scripts/seed.sh', 'echo seed\n');
  put('mine/skills/reproduce/.DS_Store', '');
  put('demo/.git/HEAD', 'ref: refs/heads/main\n');
  put('plain/.git/HEAD', 'ref: refs/heads/main\n');
  // installed: Abe's workflows and skills copied into abe/, the repo's from now on (ADR 0033)
  copyAbeFiles(join(root, 'demo'), '3.3.1');
  // and the team's own beside them
  put('demo/abe/workflows/hotfix.yaml', 'name: Hotfix\nsteps: [implement, verify, pr]\n');
  put(
    'demo/abe/workflows/prod-fix.yaml',
    'name: Prod fix\non: bug\nsteps:\n  - reproduce\n  - verify\n  - pr\n',
  );
  // a team workflow left in .abe/workflows/ is read no more
  put('demo/.abe/workflows/old.yaml', 'name: Old\nsteps: [implement, pr]\n');
  put(
    'demo/.abe/workflows/ui-bug.local.yaml',
    'name: UI bug\nsteps:\n  - reproduce\n  - implement\nloops:\n  - from: implement\n    to: implement\n    when: { check: checks.failed > 0 }\n',
  );
  put('demo/.abe/workflows/broken.local.yaml', 'name: Broken\nsteps:\n  - a\n  b: c\n');
  // yours for Tasks: over Abe's Quick fix
  put(
    'demo/.abe/workflows/chore.local.yaml',
    'name: Chore\non: { type: Task }\nsteps: [implement, pr]\n',
  );
  // yours in your config folder is no card workflow's place: only the checkout's .local.yaml
  put('mine/workflows/quick.yaml', 'name: Quick\non: bug\nsteps: [implement, pr]\n');
  // a card worktree of demo: yours are its main checkout's, never committed
  put('demo/.git/worktrees/w1/HEAD', 'ref: refs/heads/card/1\n');
  put('card-1/.git', `gitdir: ${join(root, 'demo/.git/worktrees/w1')}\n`);
  put('card-1/abe/workflows/hotfix.yaml', 'name: Hotfix\nsteps: [implement, verify, pr]\n');
  abe = await served({
    env: { ABE_CONFIG_DIR: join(root, 'mine') },
  });
});

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A Factory run on this Mac, started `days` ago, its workflow and what it did. */
const ran = (session: string, days: number, o: Partial<ReturnType<typeof newRun>> = {}) => {
  writeRun(abe.state.dir, {
    ...newRun({
      session,
      card: 4,
      title: 'T',
      repo: '/r',
      worktree: '/w',
      at: iso(T0 - days * DAY),
    }),
    ...o,
  });
};

afterAll(async () => {
  await abe.close();
  rmSync(root, { recursive: true, force: true });
});

describe('abe workflow list', () => {
  const list = async () => {
    const { doc } = await abe.jsonWith(
      { cwd: join(root, 'demo') },
      WorkflowsData,
      'workflow',
      'list',
    );

    if (!doc.ok) throw new Error(doc.error.message);

    return doc.data;
  };

  test('every Layer, nearest first; each problem with its file and line', async () => {
    const d = await list();

    // Abe's are the repo's copies: no built-in one loads in an installed repo
    expect(d.workflows.map((w) => [w.id, w.layer, w.inForce])).toEqual([
      ['broken', 'yours', false],
      ['chore', 'yours', true],
      ['ui-bug', 'yours', false],
      ['bug', 'repo', true],
      ['feature', 'repo', true],
      ['hotfix', 'repo', true],
      ['investigate', 'repo', true],
      ['prod-fix', 'repo', false],
      ['quick-fix', 'repo', true],
    ]);
    expect(d.problems.map((p) => [p.workflow, p.layer, p.code, p.line])).toEqual([
      ['broken', 'yours', 'not-yaml', 4],
      ['ui-bug', 'yours', 'no-max', 6],
      ['prod-fix', 'repo', 'needs-build', 5],
    ]);
    expect(d.problems[0]?.text).toBe(
      "Can't read broken.local.yaml: line 4: All mapping items must start at the same column",
    );
  });

  test("a card worktree's yours are its main checkout's .local.yaml; your config folder has none", async () => {
    const { doc } = await abe.jsonWith(
      { cwd: join(root, 'card-1') },
      WorkflowsData,
      'workflow',
      'list',
    );
    if (!doc.ok) throw new Error(doc.error.message);
    const mine = doc.data.workflows.filter((w) => w.layer !== 'built-in');

    expect(mine.map((w) => [w.id, w.layer, w.file])).toEqual([
      ['broken', 'yours', join(realpathSync(root), 'demo/.abe/workflows/broken.local.yaml')],
      ['chore', 'yours', join(realpathSync(root), 'demo/.abe/workflows/chore.local.yaml')],
      ['ui-bug', 'yours', join(realpathSync(root), 'demo/.abe/workflows/ui-bug.local.yaml')],
      ['hotfix', 'repo', join(realpathSync(root), 'card-1/abe/workflows/hotfix.yaml')],
    ]);
  });

  test("each Layer's skills: folder, description, files (dot files not), what uses it", async () => {
    const d = await list();
    const of = (layer: string, name: string) =>
      d.skills.find((k) => k.layer === layer && k.name === name);

    expect(of('yours', 'reproduce')).toEqual({
      name: 'reproduce',
      layer: 'yours',
      dir: join(root, 'mine/skills/reproduce'),
      description: 'Reproduce the bug first.',
      files: ['SKILL.md', 'scripts/seed.sh'],
      inForce: true,
      // yours over the repo's copy of Abe's reproduce: its Bug's reproduce step runs yours
      shadows: ['repo'],
      usedBy: ['bug'],
      invoked: false,
    });
    // the repo's copy of Abe's /abe:triage is one you invoke in the Abe chat
    expect(of('repo', 'triage')?.invoked).toBe(true);
    expect([of('repo', 'tdd')?.dir, of('repo', 'tdd')?.files]).toEqual([
      join(realpathSync(root), 'demo/abe/skills/tdd'),
      ['SKILL.md', 'mocking.md', 'tests.md'],
    ]);
    expect(of('repo', 'implement')?.usedBy).toEqual([
      'chore',
      'bug',
      'feature',
      'hotfix',
      'quick-fix',
    ]);
  });

  test('the Layers that apply: their names and folders', async () => {
    expect((await list()).layers).toEqual([
      { layer: 'yours', name: null, dir: join(root, 'mine') },
      { layer: 'repo', name: 'demo', dir: join(realpathSync(root), 'demo/.abe') },
      { layer: 'built-in', name: null, dir: null },
    ]);
  });

  test("recent: this Mac's runs of the last 30 days by workflow, and the runs each loop fired in", async () => {
    const hotfix = (await list()).workflows.find((w) => w.id === 'hotfix');
    const visit = (stage: 'build' | 'checks') => ({
      stage,
      startedAt: iso(T0),
      endedAt: iso(T0),
      report: null,
    });

    // back from checks to build once (its count 0 again since); in review's loop now; too old
    ran('r1', 1, { stage: 'build', step: 'build', visits: [visit('build'), visit('checks')] });
    ran('r2', 2, { stage: 'review', step: 'review', looped: { '2': 1, '1': 0 } });
    ran('r3', 31, { stage: 'build', step: 'build', looped: { '1': 1 } });
    ran('r4', 0, hotfix === undefined ? {} : { workflow: runWorkflowOf(hotfix) });

    expect((await list()).recent).toEqual([
      { workflow: 'feature', runs: 2, loops: { '1': 1, '2': 1 } },
      { workflow: 'hotfix', runs: 1, loops: {} },
    ]);
  });

  test("Abe's feature.yaml, as the install copied it, is the Feature a run carries", async () => {
    const feature = (await list()).workflows.find((w) => w.id === 'feature');

    expect(feature === undefined ? null : runWorkflowOf(feature)).toEqual({
      ...FEATURE_WORKFLOW,
      layer: 'repo',
    });
  });

  test("a repo not installed (no abe/ folder) runs Abe's own", async () => {
    const { doc } = await abe.jsonWith(
      { cwd: join(root, 'plain') },
      WorkflowsData,
      'workflow',
      'list',
    );

    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.data.workflows.map((w) => [w.id, w.layer])).toEqual([
      ['bug', 'built-in'],
      ['feature', 'built-in'],
      ['investigate', 'built-in'],
      ['quick-fix', 'built-in'],
    ]);
  });

  test('Abe’s base workflows: their steps, main skills, fresh ones, gates and ends', async () => {
    const d = await list();
    const of = (id: string) =>
      d.workflows
        .find((w) => w.id === id)
        ?.steps.map((x) =>
          [
            x.name,
            x.skill ?? '-',
            x.fresh,
            x.gate === null ? '' : 'gated',
            x.ends === null ? '' : `ends ${x.ends.when?.kind ?? 'always'}`,
          ].join(' '),
        );

    expect(
      d.problems.filter((p) => ['feature', 'quick-fix', 'bug', 'investigate'].includes(p.workflow)),
    ).toEqual([]);
    expect(of('feature')).toEqual([
      'create-specification create-specification never  ',
      'to-tickets to-tickets never  ',
      'build implement loop  ',
      'checks - never  ',
      'review code-review always  ',
      'verify verify always  ',
      'playbook playbook never gated ',
      'pr pr always  ',
    ]);
    expect(of('quick-fix')?.[0]).toBe('build implement loop  ');
    expect(of('bug')?.slice(0, 2)).toEqual([
      'reproduce reproduce never  ends check',
      'build implement loop  ',
    ]);
    expect(of('investigate')).toEqual(['investigate investigate never  ends always']);
  });

  test.each<[string, { type: string; tags: string[] }, string]>([
    ['a Bug: Abe’s Bug', { type: 'Bug', tags: [] }, 'bug'],
    ['a Task: yours over Abe’s Quick fix', { type: 'Task', tags: [] }, 'chore'],
    ['a User Story: Abe’s default, Feature', { type: 'User Story', tags: [] }, 'feature'],
  ])('on: preselects %s', async (_, card, id) => {
    expect(preselected(card, await list())?.id).toBe(id);
  });

  test('a board with no Task cards: the Task ones never preselected, Feature instead', async () => {
    const loaded = await list();

    expect(unmetTypes(loaded, ['User Story', 'bug'])).toEqual({
      workflows: [
        { name: 'Quick fix', types: ['Task'] },
        { name: 'Chore', types: ['Task'] },
      ],
      fallback: 'Feature',
    });
    expect(unmetTypes(loaded, ['User Story', 'Bug', 'Task'])).toBeNull();
  });

  test('in words: on:, steps with their main skill, fresh and gates, loops, problems', async () => {
    const out = await abe.runWith({ cwd: join(root, 'demo') }, 'workflow', 'list');

    expect(out.stdout).toContain(
      'feature  repo\n  on: default\n  create-specification → to-tickets → build (implement, fresh on loop) → checks → review (code-review, fresh) → verify (fresh) → playbook? → pr (fresh)\n  1. checks → build when checks.failed > 0, up to 10\n',
    );
    expect(out.stdout).toContain('ui-bug  yours  (not run: 1 problem)');
  });
});

describe('abe workflow tree: the Project tree’s abe/ folder and its tags', () => {
  const tree = async (dir: string) => {
    const { doc } = await abe.jsonWith(
      { cwd: join(root, dir) },
      WorkflowTreeData,
      'workflow',
      'tree',
    );

    if (!doc.ok) throw new Error(doc.error.message);

    return doc.data;
  };

  test('abe/ shown first; each workflow file tagged with its source and on:, a failing one red', async () => {
    const d = await tree('demo');
    const at = (rel: string) => join(realpathSync(root), 'demo', rel);

    expect([d.main, d.dir]).toEqual([true, at('abe')]);
    expect(d.tags.map((t) => [t.path.slice(at('').length + 1), t.tag, t.bad])).toEqual([
      ['.abe/workflows/broken.local.yaml', 'Yours · 1 problem', true],
      ['.abe/workflows/chore.local.yaml', 'Yours · on type Task', false],
      ['.abe/workflows/ui-bug.local.yaml', 'Yours · 1 problem', true],
      ['abe/workflows/bug.yaml', 'Repo’s · on type Bug', false],
      ['abe/workflows/feature.yaml', 'Repo’s · on default', false],
      ['abe/workflows/hotfix.yaml', 'Repo’s · picked by hand', false],
      ['abe/workflows/investigate.yaml', 'Repo’s · picked by hand', false],
      ['abe/workflows/prod-fix.yaml', 'Repo’s · 1 problem', true],
      ['abe/workflows/quick-fix.yaml', 'Repo’s · on type Task', false],
    ]);
  });

  test('a card worktree has none: only the main checkout; a repo not installed has no abe/', async () => {
    expect(await tree('card-1')).toEqual({ main: false, dir: null, tags: [] });
    expect(await tree('plain')).toEqual({ main: true, dir: null, tags: [] });
  });

  test("a newer Abe's skill is said on abe/; abe workflow update --write applies it and moves its base", async () => {
    const at = join(root, 'aged');
    const old = '---\nname: verify\ndescription: An older Abe verify, as it was copied.\n---\n';

    put('aged/.git/HEAD', 'ref: refs/heads/main\n');
    copyAbeFiles(at, '3.3.1');
    const record = AbeInstalled.parse(
      JSON.parse(readFileSync(join(at, 'abe/installed.json'), 'utf8')),
    );

    put('aged/abe/skills/verify/SKILL.md', old);
    put(
      'aged/abe/installed.json',
      JSON.stringify({
        ...record,
        files: {
          ...record.files,
          'skills/verify/SKILL.md': createHash('sha256').update(old).digest('hex'),
        },
      }),
    );
    const notes = async () =>
      (await tree('aged')).tags.filter((t) => t.path === join(realpathSync(root), 'aged', 'abe'));

    const said = (await notes()).map((t) => t.tag);

    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Abe .+ has newer verify$/);
    const update = async (...args: string[]) => {
      const { doc } = await abe.jsonWith(
        { cwd: at },
        WorkflowUpdateData,
        'workflow',
        'update',
        ...args,
      );

      if (!doc.ok) throw new Error(doc.error.message);

      return doc.data;
    };

    expect((await update()).files.map((f) => [f.path, f.how])).toEqual([
      ['skills/verify/SKILL.md', 'copy'],
    ]);
    expect(readFileSync(join(at, 'abe/skills/verify/SKILL.md'), 'utf8')).toBe(old);
    expect((await update('verify', '--write')).written).toBe(true);
    expect(readFileSync(join(at, 'abe/skills/verify/SKILL.md'), 'utf8')).not.toBe(old);
    expect(await notes()).toEqual([]);
    expect((await update()).files).toEqual([]);
  });
});

describe('abe workflow path', () => {
  const path = async (file: string) => {
    const { doc } = await abe.jsonWith(
      { cwd: join(root, 'demo') },
      WorkflowPathData,
      'workflow',
      'path',
      file,
    );

    return doc.ok ? doc.data.path : doc.error.code;
  };
  const builtIn = (rest: string) => join(abe.state.dir, 'built-in', rest);

  test.each<[string, () => string, () => string]>([
    [
      "a Layer's workflow file: as it is",
      () => join(realpathSync(root), 'demo/.abe/workflows/ui-bug.local.yaml'),
      () => join(realpathSync(root), 'demo/.abe/workflows/ui-bug.local.yaml'),
    ],
    [
      "a Layer's skill file",
      () => join(root, 'mine/skills/reproduce/scripts/seed.sh'),
      () => join(root, 'mine/skills/reproduce/scripts/seed.sh'),
    ],
    [
      'a built-in workflow: written out',
      () => 'built-in/workflows/feature.yaml',
      () => builtIn('workflows/feature.yaml'),
    ],
    [
      'a built-in skill file',
      () => 'built-in/skills/tdd/tests.md',
      () => builtIn('skills/tdd/tests.md'),
    ],
    ['the guide', () => 'built-in/workflow-yaml.md', () => builtIn('workflow-yaml.md')],
    ['a file of no Layer', () => join(root, 'mine/settings.yaml'), () => 'not-a-layer-file'],
    [
      'a built-in file there is none of',
      () => 'built-in/skills/tdd/nope.md',
      () => 'not-a-layer-file',
    ],
    ['out of built-in', () => 'built-in/../settings.yaml', () => 'not-a-layer-file'],
  ])('%s', async (_, file, want) => {
    expect(await path(file())).toBe(want());
  });

  test('a built-in file is read-only, written again when its text changed', async () => {
    const file = builtIn('workflow-yaml.md');

    await path('built-in/workflow-yaml.md');
    expect(statSync(file).mode & 0o777).toBe(0o444);
    rmSync(file);
    writeFileSync(file, 'old', { mode: 0o444 });
    await path('built-in/workflow-yaml.md');
    expect([readFileSync(file, 'utf8'), statSync(file).mode & 0o777]).toEqual([
      WORKFLOW_GUIDE,
      0o444,
    ]);
  });

  test('in words: the path', async () => {
    const out = await abe.runWith(
      { cwd: join(root, 'demo') },
      'workflow',
      'path',
      'built-in/skills/tdd/SKILL.md',
    );

    expect(out.stdout).toBe(`${builtIn('skills/tdd/SKILL.md')}\n`);
  });
});
