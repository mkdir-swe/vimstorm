/** A repo's worktree recipe: which files a new worktree gets, the env map's rule, the install's verdict. */
import { describe, expect, test } from 'bun:test';
import { recipeCopies, recipeWithMap, WorktreeRecipe } from './worktree-recipe';
import { worktreePart, type WorktreeTried } from '../install/install-parts';

const MAPPING = [
  { path: 'backend/.env', to: ['dev', 'test'] as const },
  { path: 'backend/.env.prod', to: ['prod'] as const },
  { path: 'frontend/.env.local', to: 'not-sure' as const },
];

describe('recipeCopies', () => {
  test('links and copies listed; a file feeding only prod, or not placed yet, skipped with why; prod on: it goes', () => {
    const recipe = {
      link: ['backend/.env', 'backend/.env.prod', 'frontend/.env.local'],
      copy: ['.vscode', 'backend/.env'],
    };

    expect(recipeCopies(recipe, MAPPING, ['dev', 'test'])).toEqual([
      { path: 'backend/.env', link: true, listed: true },
      {
        path: 'backend/.env.prod',
        link: true,
        listed: true,
        skip: 'feeds only prod, off for agents',
      },
      {
        path: 'frontend/.env.local',
        link: true,
        listed: true,
        skip: "not placed yet: in no abe.yaml worktree group, nor the install's env map",
      },
      // listed twice: linked
      { path: '.vscode', listed: true },
    ]);
    expect(
      recipeCopies(recipe, MAPPING, ['dev', 'test', 'prod']).find(
        (c) => c.path === 'backend/.env.prod',
      ),
    ).toEqual({ path: 'backend/.env.prod', link: true, listed: true });
  });

  test('a path out of the checkout is no recipe', () => {
    expect(WorktreeRecipe.safeParse({ link: ['../secrets/.env'] }).success).toBe(false);
    expect(WorktreeRecipe.safeParse({ link: ['/etc/hosts'] }).success).toBe(false);
  });

  test.each<[string, unknown, boolean]>([
    ['flat lists', { link: ['backend/.env'], copy: ['.vscode'] }, true],
    ['grouped lists', { link: { all: ['frontend/.env'], prod: ['backend/.env.prod'] } }, true],
    ['one grouped, one flat', { link: { dev: ['backend/.env.dev'] }, copy: ['.vscode'] }, true],
    ['a group no environment is', { link: { staging: ['backend/.env.staging'] } }, false],
    ['a grouped path out of the checkout', { copy: { test: ['../x/.env'] } }, false],
  ])('%s: a recipe %p', (_, value, ok) => {
    expect(WorktreeRecipe.safeParse(value).success).toBe(ok);
  });

  // abe.yaml's groups place the files (ADR 0040): the record's mapping says otherwise, unread
  const GROUPED = {
    link: {
      all: ['frontend/.env'],
      dev: ['backend/.env', 'backend/.env.dev'],
      test: ['backend/.env', 'backend/.env.test'],
      prod: ['backend/.env.prod'],
    },
    copy: { dev: ['.vscode'] },
  };

  test.each<[string, ('dev' | 'test' | 'prod')[], [string, string | undefined][]]>([
    [
      'prod off: its group skipped whole, named',
      ['dev', 'test'],
      [
        ['frontend/.env', undefined],
        ['backend/.env', undefined],
        ['backend/.env.dev', undefined],
        ['backend/.env.test', undefined],
        ['backend/.env.prod', 'worktree.link.prod: prod is off for agents'],
        ['.vscode', undefined],
      ],
    ],
    [
      'prod on, test off: a file in an on group goes',
      ['dev', 'prod'],
      [
        ['frontend/.env', undefined],
        ['backend/.env', undefined],
        ['backend/.env.dev', undefined],
        ['backend/.env.test', 'worktree.link.test: test is off for agents'],
        ['backend/.env.prod', undefined],
        ['.vscode', undefined],
      ],
    ],
    [
      'every environment off: all still goes',
      [],
      [
        ['frontend/.env', undefined],
        ['backend/.env', 'worktree.link.dev, worktree.link.test: dev, test are off for agents'],
        ['backend/.env.dev', 'worktree.link.dev: dev is off for agents'],
        ['backend/.env.test', 'worktree.link.test: test is off for agents'],
        ['backend/.env.prod', 'worktree.link.prod: prod is off for agents'],
        ['.vscode', 'worktree.copy.dev: dev is off for agents'],
      ],
    ],
  ])('grouped, %s', (_, enabled, want) => {
    const record = [{ path: 'backend/.env.prod', to: ['dev', 'test'] as const }];

    expect(recipeCopies(GROUPED, record, enabled).map((c) => [c.path, c.skip])).toEqual(want);
  });

  test("the env map written as groups: all, each environment's, copy kept, not sure out, the rest in all", () => {
    expect(
      recipeWithMap(
        { link: ['backend/.env', 'node_modules/.cache', 'old/.env'], copy: ['backend/.env.test'] },
        [
          { path: 'backend/.env', to: ['dev', 'test', 'prod'] },
          { path: 'backend/.env.dev', to: ['dev'] },
          { path: 'backend/.env.test', to: ['test'] },
          { path: 'backend/.env.prod', to: ['prod'] },
          { path: 'old/.env', to: 'not-sure' },
          { path: 'backend/.env.bak', to: 'not-used' },
        ],
      ),
    ).toEqual({
      link: {
        all: ['node_modules/.cache', 'backend/.env'],
        dev: ['backend/.env.dev'],
        prod: ['backend/.env.prod'],
      },
      copy: { test: ['backend/.env.test'] },
    });
    // a map that places no file in an environment leaves the recipe as it is
    expect(recipeWithMap({ link: ['a'] }, [{ path: 'b', to: 'not-used' }])).toEqual({
      link: ['a'],
    });
  });
});

describe('worktreePart: the install check', () => {
  const ran = { run: '', exit: 0, output: '', how: 'none' as const, copied: [] };
  const tried = (over: Partial<WorktreeTried> = {}): WorktreeTried => ({
    written: true,
    tried: { ok: true, ran: { ...ran, links: ['backend/.env'] }, absent: [] },
    uncovered: [],
    ...over,
  });

  test.each<[string, WorktreeTried, string, string]>([
    ['no recipe', tried({ written: false }), 'fail', 'no-recipe'],
    [
      "abe.yaml's recipe dropped by the settings",
      tried({ dropped: 'abe.yaml: worktree: link.0: a path in the checkout, from its top' }),
      'fail',
      'recipe-dropped',
    ],
    [
      'a listed file the checkout lacks',
      tried({ tried: { ok: true, ran: { ...ran, missing: ['backend/.env'] }, absent: [] } }),
      'fail',
      'recipe-missing',
    ],
    [
      'its script failing',
      tried({
        tried: {
          ok: true,
          ran: { ...ran, script: { run: 'abe/scripts/worktree-setup', exit: 1, output: 'boom' } },
          absent: [],
        },
      }),
      'fail',
      'recipe-script-failed',
    ],
    [
      'an env file the tests read left out',
      tried({ uncovered: ['frontend/.env'] }),
      'warn',
      'env-not-in-recipe',
    ],
  ])('%s', (_, w, state, why) => {
    expect(worktreePart(w)).toMatchObject({ state, why });
  });

  test('passes, saying what a new worktree gets', () => {
    expect(worktreePart(tried())).toEqual({
      state: 'pass',
      line: 'A new worktree gets linked backend/.env',
    });
  });
});
