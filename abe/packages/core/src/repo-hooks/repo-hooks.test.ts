/** A repo's hook points: the map from abe.yaml, and what an agent's abe run runs on a Mac and a box. */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HOOKS,
  hasHeading,
  hookScriptDirs,
  type RepoHooks,
  repoHooksOfDoc,
  type RunRole,
  type RunTrees,
  runAppSkill,
  runScriptIn,
  testingSkills,
  testingSkillWanted,
  verifySkill,
} from '.';

/** The two adapters' trees: a Mac session's worktree and Before's, a box's clone and Before's. */
const ADAPTERS: Readonly<Record<'mac' | 'box', RunTrees>> = {
  mac: { workdir: '/u/demo-wt/4-cart', base: '/u/demo-wt/4-cart-base' },
  box: { workdir: '/workspace/repo', base: '/workspace/repo-base' },
};

const MOVED = {
  hooks: {
    start: 'scripts/dev/start',
    'prototype-start': 'tools/proto',
    'run-app': 'app',
    verify: 'verify-web',
  },
};

type Want = { at: 'work' | 'base'; script: string; role?: RunRole } | undefined;

/**
 * What `abe run <path>` runs, by the map `doc` (abe.yaml) gives: `@work/` and `@base/` are the
 * adapter's worktree and Before's. Every row holds on both adapters alike.
 */
const RUNS: [string, unknown, string, Want][] = [
  // undeclared: today's places
  [
    'a role by its path',
    {},
    '.claude/skills/run-app/scripts/start',
    { at: 'work', script: '.claude/skills/run-app/scripts/start', role: 'start' },
  ],
  [
    './ in front',
    {},
    './.claude/skills/run-app/scripts/seed',
    { at: 'work', script: '.claude/skills/run-app/scripts/seed', role: 'seed' },
  ],
  [
    'by its absolute path',
    {},
    '@work/.claude/skills/run-app/scripts/stop',
    { at: 'work', script: '.claude/skills/run-app/scripts/stop', role: 'stop' },
  ],
  [
    "in Before's worktree",
    {},
    '@base/.claude/skills/run-app/scripts/start',
    { at: 'base', script: '.claude/skills/run-app/scripts/start', role: 'start' },
  ],
  [
    "a helper in run-app's scripts",
    {},
    '.claude/skills/run-app/scripts/cart-total.sh',
    { at: 'work', script: '.claude/skills/run-app/scripts/cart-total.sh' },
  ],
  [
    'a bare role',
    {},
    'seed',
    { at: 'work', script: '.claude/skills/run-app/scripts/seed', role: 'seed' },
  ],
  [
    'a bare helper',
    {},
    'cart-total.sh',
    { at: 'work', script: '.claude/skills/run-app/scripts/cart-total.sh' },
  ],
  [
    'a bare prototype role',
    {},
    'prototype-start',
    { at: 'work', script: 'abe/scripts/prototype-start', role: 'prototype-start' },
  ],
  [
    "the prototype's stop by its path",
    {},
    'abe/scripts/prototype-stop',
    { at: 'work', script: 'abe/scripts/prototype-stop', role: 'prototype-stop' },
  ],
  [
    "any verify-* pack's helper",
    {},
    '.claude/skills/verify-demo-shop/scripts/drive',
    { at: 'work', script: '.claude/skills/verify-demo-shop/scripts/drive' },
  ],
  [
    "a pack helper in Before's",
    {},
    '@base/.claude/skills/verify-demo-shop/scripts/drive',
    { at: 'base', script: '.claude/skills/verify-demo-shop/scripts/drive' },
  ],
  ['no other folder', {}, 'scripts/start', undefined],
  ['no empty name', {}, '.claude/skills/run-app/scripts/', undefined],
  ['no ..', {}, '.claude/skills/run-app/scripts/../../x', undefined],
  ['no .. as a name', {}, '.claude/skills/run-app/scripts/..', undefined],
  ['no subfolder', {}, '.claude/skills/run-app/scripts/a/b', undefined],
  ['no shell', {}, '.claude/skills/run-app/scripts/start;id', undefined],
  ['no other tree', {}, '/u/other/.claude/skills/run-app/scripts/start', undefined],
  ['no home', {}, '/home/abe/.claude/skills/run-app/scripts/start', undefined],
  ['no bare ..', {}, '..', undefined],
  ['no bare .', {}, '.', undefined],
  ['no bare path up', {}, '../seed', undefined],
  ['no bare a..b', {}, 'a..b', undefined],
  ['no bare flag', {}, '-seed', undefined],
  ['no bare shell', {}, 'seed;id', undefined],
  ['no bare subfolder', {}, 'seed/x', undefined],
  ['no bare name by an absolute path', {}, '@base/seed', undefined],
  ['no root', {}, '/seed', undefined],
  ["no testing skill's script", {}, '.claude/skills/demo-shop-testing/scripts/run', undefined],
  ['no pack .. ', {}, '.claude/skills/verify-demo-shop/scripts/../../../x', undefined],
  ['no pack file outside scripts', {}, '.claude/skills/verify-demo-shop/drive', undefined],
  [
    "never the worktree's own script",
    { hooks: { 'worktree-setup': 'abe/scripts/worktree-setup' } },
    'abe/scripts/worktree-setup',
    undefined,
  ],
  // declared: the map's places, and no longer today's
  [
    'a moved start by its role',
    MOVED,
    'start',
    { at: 'work', script: 'scripts/dev/start', role: 'start' },
  ],
  [
    'a moved start by its path',
    MOVED,
    '@work/scripts/dev/start',
    { at: 'work', script: 'scripts/dev/start', role: 'start' },
  ],
  [
    'a moved prototype start',
    MOVED,
    'prototype-start',
    { at: 'work', script: 'tools/proto', role: 'prototype-start' },
  ],
  ['the old prototype start goes', MOVED, 'abe/scripts/prototype-start', undefined],
  [
    "the run-app skill's scripts move with it",
    MOVED,
    '.claude/skills/app/scripts/seed',
    { at: 'work', script: '.claude/skills/app/scripts/seed', role: 'seed' },
  ],
  [
    'a bare helper in the moved run-app',
    MOVED,
    'cart-total.sh',
    { at: 'work', script: '.claude/skills/app/scripts/cart-total.sh' },
  ],
  ['the old run-app goes', MOVED, '.claude/skills/run-app/scripts/seed', undefined],
  ['no helper beside a moved start', MOVED, 'scripts/dev/helper', undefined],
  [
    "the declared pack's helper",
    MOVED,
    '.claude/skills/verify-web/scripts/drive',
    { at: 'work', script: '.claude/skills/verify-web/scripts/drive' },
  ],
  ["another pack's no more", MOVED, '.claude/skills/verify-demo-shop/scripts/drive', undefined],
  [
    'a hooks: that does not parse is today',
    { hooks: { start: '../x' } },
    'start',
    { at: 'work', script: '.claude/skills/run-app/scripts/start', role: 'start' },
  ],
];

describe('runScriptIn: what an agent may run, the same on a Mac and a box', () => {
  test.each(
    RUNS.flatMap(([name, doc, path, want]) =>
      (['mac', 'box'] as const).map((on) => [`${name} (${on})`, on, doc, path, want] as const),
    ),
  )('%s', (_, on, doc, path, want) => {
    const trees = ADAPTERS[on];
    const at = (p: string) => p.replace('@work', trees.workdir).replace('@base', trees.base);
    const ran = runScriptIn(repoHooksOfDoc(doc), trees, at(path));

    expect(ran).toEqual(
      want === undefined
        ? undefined
        : {
            cwd: want.at === 'work' ? trees.workdir : trees.base,
            script: want.script,
            ...(want.role === undefined ? {} : { role: want.role }),
          },
    );
  });
});

const has = (h: RepoHooks, text: string) => [
  hasHeading(h, 'find-out', text),
  hasHeading(h, 'read-data', text),
];

describe('the map: each role its declared place, else today', () => {
  test.each<[string, unknown, (h: RepoHooks) => unknown, unknown]>([
    ['nothing declared is today', undefined, (h) => h, DEFAULT_HOOKS],
    [
      'the app scripts in run-app',
      {},
      (h) => [h.start, h.query],
      ['.claude/skills/run-app/scripts/start', '.claude/skills/run-app/scripts/query'],
    ],
    [
      "a prototype's in abe/scripts",
      {},
      (h) => [h['prototype-start'], h['prototype-stop']],
      ['abe/scripts/prototype-start', 'abe/scripts/prototype-stop'],
    ],
    ['no worktree script', {}, (h) => h['worktree-setup'], null],
    [
      'the declared worktree script',
      { hooks: { 'worktree-setup': 'bin/setup' } },
      (h) => h['worktree-setup'],
      'bin/setup',
    ],
    [
      'run-app moves its scripts',
      { hooks: { 'run-app': 'app', db: 'docker/db' } },
      (h) => [runAppSkill(h).skill, h.seed, h.db],
      ['.claude/skills/app/SKILL.md', '.claude/skills/app/scripts/seed', 'docker/db'],
    ],
    [
      'the pack named for the checkout',
      {},
      (h) => verifySkill(h, '/u/demo-shop/'),
      'verify-demo-shop',
    ],
    [
      'the declared pack',
      { hooks: { verify: 'verify-web' } },
      (h) => verifySkill(h, '/u/demo-shop'),
      'verify-web',
    ],
    [
      'any *-testing skill',
      {},
      (h) => testingSkills(h, ['run-app', 'shop-testing', 'demo-testing']),
      ['shop-testing', 'demo-testing'],
    ],
    [
      'the declared testing skill',
      { hooks: { testing: 'qa' } },
      (h) => testingSkills(h, ['qa', 'shop-testing']),
      ['qa'],
    ],
    [
      'the testing skill asked for',
      {},
      (h) => testingSkillWanted(h, 'demo-shop'),
      'demo-shop-testing',
    ],
    [
      "today's headings",
      {},
      (h) => has(h, '# Notes\n## Find out before you ask  \n## Read data\n'),
      [true, true],
    ],
    [
      'a heading is a line of its own',
      {},
      (h) => has(h, '### Find out before you ask\nsee ## Read data'),
      [false, false],
    ],
    [
      'declared headings',
      { hooks: { 'find-out': '## Ask last', 'read-data': '## Data' } },
      (h) => has(h, '## Ask last\n## Data\n## Read data'),
      [true, true],
    ],
    [
      'the declared ones only',
      { hooks: { 'find-out': '## Ask last' } },
      (h) => has(h, '## Find out before you ask'),
      [false, false],
    ],
    [
      'an absolute path is refused, all of hooks: today',
      { hooks: { start: '/bin/start', stop: 'ok/stop' } },
      (h) => h.stop,
      DEFAULT_HOOKS.stop,
    ],
    [
      'a heading that is none is refused',
      { hooks: { 'find-out': 'Find out' } },
      (h) => h['find-out'],
      DEFAULT_HOOKS['find-out'],
    ],
    [
      "the scripts' folders a sync carries",
      {},
      hookScriptDirs,
      ['.claude/skills/run-app/scripts', 'abe/scripts'],
    ],
    [
      'a moved script brings its folder',
      {
        ...MOVED,
        hooks: { ...MOVED.hooks, stop: 'stop.sh', 'worktree-setup': 'scripts/dev/x/setup' },
      },
      hookScriptDirs,
      ['scripts/dev', 'stop.sh', '.claude/skills/app/scripts', 'tools', 'abe/scripts'],
    ],
    ['an unknown role is refused', { hooks: { deploy: 'x' } }, (h) => h, DEFAULT_HOOKS],
  ])('%s', (_, doc, read, want) => {
    expect(read(repoHooksOfDoc(doc))).toEqual(want);
  });
});
