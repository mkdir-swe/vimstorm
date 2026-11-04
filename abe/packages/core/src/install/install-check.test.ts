/** A check is serve's to prove: which commands it runs for the install, and which are not proven yet. */
import { describe, expect, test } from 'bun:test';
import { checkCommandWhyNot, checksUnproven, checkTail, installCheckText } from './install-check';

const READ = {
  ci: [{ file: '.github/workflows/ci.yml', commands: ['npm ci', 'npx tsc --noEmit', 'npm test'] }],
  scripts: { test: 'vitest run', lint: 'eslint .', deploy: 'sls deploy', 'sync:vars': 'x' },
  workspaces: [
    {
      dir: 'frontend',
      scripts: { test: 'jest' },
      tests: ['test'],
      envExample: null,
      envKeys: [],
      stack: [],
    },
  ],
  outward: [
    { name: 'sync:vars', dir: '.', file: null, seen: 'package.json:5', why: 'gh secret set' },
  ],
  kind: null,
};

describe("checkCommandWhyNot: serve runs only the repo's own checks", () => {
  test.each<[string, string, string | null]>([
    ['a command CI runs, as it runs it', 'npx  tsc --noEmit', null],
    ['a package script', 'npm test', null],
    ["npm's short test", 'npm t -- --run', null],
    ['a package script with run', 'pnpm run lint', null],
    ["a workspace's script", 'cd frontend && npm test', null],
    [
      'a script the folder lacks',
      'cd frontend && npm run lint',
      'frontend/package.json has no script lint',
    ],
    [
      'out of the checkout',
      'cd ../other && npm test',
      "it is none of the repo's checks: give a command CI runs or a package script (npm test, cd web && npm run lint)",
    ],
    [
      'any other command',
      'cat frontend/.env',
      "it is none of the repo's checks: give a command CI runs or a package script (npm test, cd web && npm run lint)",
    ],
    [
      'chained to another',
      'npm test; cat .env',
      "it is none of the repo's checks: give a command CI runs or a package script (npm test, cd web && npm run lint)",
    ],
    [
      "installs dependencies, CI's too",
      'npm ci',
      'it installs dependencies: never in your main checkout',
    ],
    [
      'installs in a folder',
      'cd frontend && npm install',
      'it installs dependencies: never in your main checkout',
    ],
    [
      'a deploy script',
      'npm run deploy',
      'deploy writes outside this machine (its name says deploy)',
    ],
    [
      'a script Read says writes',
      'npm run sync:vars',
      'sync:vars writes outside this machine (gh secret set)',
    ],
    ['an outward command', 'aws s3 ls', 'it writes outside this machine (aws s3)'],
  ])('%s', (_, command, why) => {
    expect(checkCommandWhyNot(command, READ)).toBe(why);
  });
});

describe('checksUnproven: a listed check serve has not seen pass', () => {
  const TESTS = { name: 'tests', run: 'npm test' };

  test.each<[string, Record<string, { ok: boolean; exit: number | null; at: string }>, string[]]>([
    ['never run by serve', {}, ['tests (npm test) has not run: abe install try tests']],
    ['passed', { 'npm test': { ok: true, exit: 0, at: 't' } }, []],
    [
      'failed',
      { 'npm test': { ok: false, exit: 1, at: 't' } },
      [
        'tests (npm test) failed when serve ran it (exit 1): fix it, or leave it out of checks: and tell the person what fails and why',
      ],
    ],
  ])('%s', (_, runs, said) => {
    expect(checksUnproven([TESTS], runs)).toEqual(said);
  });
});

describe('installCheckText: pass or fail, its exit, the tail on a failure', () => {
  test.each<[string, Parameters<typeof installCheckText>[0], string]>([
    [
      'a pass and a failing try',
      {
        repo: '/r',
        runs: [
          {
            name: 'tests',
            run: 'npm test',
            ok: true,
            exit: 0,
            timedOut: false,
            durationMs: 3,
            tail: 'ok',
          },
          {
            name: null,
            run: 'npm run lint',
            ok: false,
            exit: 1,
            timedOut: false,
            durationMs: 3,
            tail: 'a\nb',
          },
        ],
      },
      'pass  tests (npm test)  exit 0\nfail  try (npm run lint)  exit 1\n  a\n  b',
    ],
  ])('%s', (_, d, text) => {
    expect(installCheckText(d)).toBe(text);
  });

  test('the tail is the last lines', () => {
    expect(
      checkTail(`${Array.from({ length: 50 }, (_, n) => n).join('\n')}\n`).split('\n'),
    ).toHaveLength(40);
  });
});
