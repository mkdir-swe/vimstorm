/** Rule tables for checks: the plan, what a test file is, and the two diff checks on git's output. */
import { describe, expect, test } from 'bun:test';
import {
  addChecks,
  addedLines,
  addedSuppressions,
  type BaseDiff,
  type CheckStatus,
  builtInCheck,
  checkEntries,
  checksConfigured,
  checksEnv,
  CHECKS_NO_AWS_PROFILE,
  checksExample,
  checksGreen,
  checksMarkdown,
  checksPlan,
  checksSaid,
  checksVerdict,
  coreDefaults,
  deletedTests,
  type FactoryChecksData,
  isTestFile,
  parseNameStatus,
  factoryChecksText,
  tail,
  unconfiguredChecks,
} from '../index';

const TEST_FILES = coreDefaults().testFiles;

describe('the plan: commands as listed, then the built-ins', () => {
  test("core's defaults with a repo pack's commands", () => {
    expect(
      checksPlan(
        checkEntries([
          'no-deleted-tests',
          { name: 'tests', run: 'bun test' },
          'types',
          'no-new-suppressions',
          { name: 'lint', run: 'bun run lint' },
        ]),
      ),
    ).toEqual([
      { kind: 'command', name: 'tests', run: 'bun test' },
      { kind: 'no-run', name: 'types' },
      { kind: 'command', name: 'lint', run: 'bun run lint' },
      { kind: 'built-in', name: 'no-deleted-tests' },
      { kind: 'built-in', name: 'no-new-suppressions' },
    ]);
  });

  const C = (status: CheckStatus) => ({ kind: 'command' as const, status });
  const B = (status: CheckStatus) => ({ kind: 'built-in' as const, status });

  test.each([
    ['commands and built-ins green', [C('green'), B('green')], 'green'],
    ['a command green, one not configured', [C('green'), C('not-configured')], 'green'],
    ['a command red', [C('red'), C('green'), B('green')], 'red'],
    ['a built-in red, no command run', [C('not-configured'), B('red')], 'red'],
    // #159: a repo with no pack: the built-ins pass, no test, typecheck or lint ran
    ['nothing configured, the built-ins green', [C('not-configured'), B('green')], 'none'],
    ['the built-ins alone', [B('green'), B('green')], 'none'],
    ['no checks at all', [], 'none'],
  ] as const)('%s: %s', (_, results, verdict) => {
    expect(checksVerdict(results)).toBe(verdict);
    expect(checksGreen(results)).toBe(verdict === 'green');
  });

  test("core's defaults alone configure no check; a repo pack's command does", () => {
    const defaults = checkEntries(coreDefaults().checks);

    expect(checksConfigured(defaults)).toBe(false);
    expect(unconfiguredChecks(defaults)).toEqual(['tests', 'types', 'lint']);
    // A repo pack giving tests its command, merged as the Layers merge it.
    const packed = checkEntries(
      addChecks(coreDefaults().checks, [{ name: 'tests', run: 'bun test' }]),
    );

    expect(checksConfigured(packed)).toBe(true);
    expect(unconfiguredChecks(packed)).toEqual(['types', 'lint']);
    expect(unconfiguredChecks(checkEntries([{ name: 'tests', run: 'bun test' }, 'lint']))).toEqual([
      'lint',
    ]);
  });

  test("a minimal pack's checks: package.json's scripts where it has them, else a placeholder", () => {
    expect(checksExample({ test: 'bun test', typecheck: 'tsc' })).toBe(
      [
        'checks:',
        '  - name: tests',
        '    run: npm test',
        '  - name: types',
        '    run: npm run typecheck',
        '  - name: lint',
        '    run: <the command that runs your lint>',
        '',
      ].join('\n'),
    );
  });
});

describe('what a test file is', () => {
  test.each<[string, boolean]>([
    ['src/cart.test.ts', true],
    ['cart.spec.js', true],
    ['api/src/cart.test.tsx', true],
    ['test/cart.ts', true],
    ['api/tests/fixtures/cart.json', true],
    ['src/latest/cart.ts', false],
    ['src/testing.ts', false],
    ['contest/x.ts', false],
    ['src/cart.ts', false],
    ['tests', false],
  ])("core's patterns: %s is %p", (path, is) => {
    expect(isTestFile(path, TEST_FILES)).toBe(is);
  });

  test.each<[string, string, boolean]>([
    ['e2e/', 'web/e2e/login.ts', true],
    ['web/e2e/', 'web/e2e/login.ts', true],
    ['web/e2e/', 'api/web/e2e/login.ts', false],
    ['/specs/*.ts', 'specs/a.ts', true],
    ['/specs/*.ts', 'specs/deep/a.ts', false],
    ['specs/**/*.ts', 'specs/deep/er/a.ts', true],
    ['specs/**/*.ts', 'specs/a.ts', true],
    ['*_test.go', 'pkg/cart_test.go', true],
    ['test_?.py', 'tests_/test_a.py', true],
    ['test_?.py', 'test_ab.py', false],
    ['*.test.*', 'a.test', false],
  ])('%s matches %s: %p', (pattern, path, is) => {
    expect(isTestFile(path, [pattern])).toBe(is);
  });
});

describe('no deleted tests: git diff --name-status -z read', () => {
  const z = (...parts: string[]) => `${parts.join('\0')}\0`;

  test('every kind of line', () => {
    expect(
      parseNameStatus(z('M', 'a.ts', 'D', 'b.test.ts', 'R087', 'c.ts', 'd.ts', 'A', 'e.ts')),
    ).toEqual([
      { status: 'M', path: 'a.ts', to: null },
      { status: 'D', path: 'b.test.ts', to: null },
      { status: 'R', path: 'c.ts', to: 'd.ts' },
      { status: 'A', path: 'e.ts', to: null },
    ]);
    expect(parseNameStatus('')).toEqual([]);
  });

  test.each<[string, string, string[]]>([
    ['nothing changed', '', []],
    ['a source file deleted', z('D', 'src/cart.ts'), []],
    ['a test file deleted', z('D', 'src/cart.test.ts'), ['deleted: src/cart.test.ts']],
    ['a file under tests/ deleted', z('D', 'tests/x.ts'), ['deleted: tests/x.ts']],
    ['a test file changed', z('M', 'src/cart.test.ts'), []],
    ['a test file added', z('A', 'src/new.test.ts'), []],
    ['a test file renamed to another test file', z('R100', 'a.test.ts', 'b.test.ts'), []],
    [
      'a test file moved out of the tests',
      z('R100', 'tests/a.ts', 'src/a.ts'),
      ['moved out of the test files: tests/a.ts → src/a.ts'],
    ],
    ['a source file moved into tests/', z('R100', 'src/a.ts', 'tests/a.ts'), []],
  ])('%s', (_, text, found) => {
    expect(deletedTests(parseNameStatus(text), TEST_FILES)).toEqual(found);
  });
});

describe('no new suppressions: the lines git diff adds', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,0 +4,2 @@ export const a = 1;',
    '+// @ts-ignore the types are wrong',
    '+++counter;',
    '@@ -10,2 +11 @@',
    '-// @ts-expect-error removed is fine',
    '-x();',
    '+y();',
    'diff --git a/new.py b/new.py',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.py',
    '@@ -0,0 +1,2 @@',
    '+import os  # noqa: F401',
    '+--- not a header',
    '\\ No newline at end of file',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-// eslint-disable-next-line',
    '',
  ].join('\n');

  test('added lines with their file and line, by the hunk counts', () => {
    expect(addedLines(patch)).toEqual([
      { file: 'src/a.ts', line: 4, text: '// @ts-ignore the types are wrong' },
      { file: 'src/a.ts', line: 5, text: '++counter;' },
      { file: 'src/a.ts', line: 11, text: 'y();' },
      { file: 'new.py', line: 1, text: 'import os  # noqa: F401' },
      { file: 'new.py', line: 2, text: '--- not a header' },
    ]);
  });

  test('a path with a space: git ends it with a tab', () => {
    expect(addedLines(['+++ b/a b.ts\t', '@@ -0,0 +1 @@', '+x', ''].join('\n'))).toEqual([
      { file: 'a b.ts', line: 1, text: 'x' },
    ]);
  });

  test('a quoted path', () => {
    expect(addedLines(['+++ "b/a \\"q\\".ts"', '@@ -0,0 +1 @@', '+x', ''].join('\n'))).toEqual([
      { file: 'a "q".ts', line: 1, text: 'x' },
    ]);
  });

  test.each<[string, string | null]>([
    ['// @ts-ignore', '@ts-ignore'],
    ['  // @ts-expect-error: wrong lib types', '@ts-expect-error'],
    ['/* eslint-disable */', 'eslint-disable'],
    ['// eslint-disable-next-line no-console', 'eslint-disable'],
    ['// biome-ignore lint/style: x', 'biome-ignore'],
    ['import os  # noqa', '# noqa'],
    ["test.only('cart', () => {", '.only('],
    ["describe.skip('cart', () => {", '.skip('],
    ["it('skips nothing', () => {", null],
    ['const ignore = true;', null],
  ])('%s: %p', (text, marker) => {
    expect(addedSuppressions([{ file: 'a.ts', line: 1, text }])).toEqual(
      marker === null ? [] : [{ file: 'a.ts', line: 1, text, marker }],
    );
  });
});

describe('the built-in checks on a diff', () => {
  const diff = (o: Partial<Extract<BaseDiff, { ok: true }>>): BaseDiff => ({
    ok: true,
    base: 'main',
    mergeBase: '0123456789abcdef0123',
    nameStatus: '',
    patch: '',
    ...o,
  });

  test.each<[string, Parameters<typeof builtInCheck>[0], BaseDiff, CheckStatus, string]>([
    [
      'no deleted tests, green',
      'no-deleted-tests',
      diff({ nameStatus: 'M\0src/a.ts\0' }),
      'green',
      'no test file deleted against the merge base 0123456789ab with main\n',
    ],
    [
      'a test deleted, red',
      'no-deleted-tests',
      diff({ nameStatus: 'D\0src/a.test.ts\0' }),
      'red',
      'test files gone against the merge base 0123456789ab with main:\ndeleted: src/a.test.ts\n',
    ],
    [
      'a suppression added, red',
      'no-new-suppressions',
      diff({ patch: '+++ b/a.ts\n@@ -0,0 +1 @@\n+  // @ts-ignore\n' }),
      'red',
      'suppressions added against the merge base 0123456789ab with main:\na.ts:1: @ts-ignore: // @ts-ignore\n',
    ],
    [
      'no merge base, red',
      'no-new-suppressions',
      { ok: false, message: 'no merge base with main' },
      'red',
      'no diff against the merge base: no merge base with main',
    ],
  ])('%s', (_, name, d, status, output) => {
    expect(builtInCheck(name, d, TEST_FILES)).toEqual({ status, output });
  });
});

describe('what checks write and say', () => {
  const report: FactoryChecksData = {
    card: 4,
    session: 's1',
    worktree: '/r-wt/4-sign-in',
    green: false,
    cause: 'checks',
    none: false,
    file: '/r-wt/4-sign-in/.scratch/4/checks.md',
    settings: [],
    results: [
      {
        name: 'tests',
        kind: 'command',
        run: 'bun test',
        status: 'red',
        exit: 1,
        durationMs: 1200,
        output: 'cart.test.ts:\n(fail) adds an item\n```\n',
      },
      {
        name: 'types',
        kind: 'command',
        run: null,
        status: 'not-configured',
        exit: null,
        durationMs: 0,
        output: 'not configured: no Layer gives types a command, so it was not run\n',
      },
      {
        name: 'no-new-suppressions',
        kind: 'built-in',
        run: null,
        status: 'green',
        exit: null,
        durationMs: 30,
        output: 'no suppression added\n',
      },
    ],
  };

  test('checks.md: each result, its command and its output in a fence it cannot close', () => {
    expect(checksMarkdown(report, '2026-10-01T09:00:00.000Z')).toBe(
      [
        '# Checks · AB#4',
        '',
        'Red at 2026-10-01T09:00:00.000Z (after build), in /r-wt/4-sign-in.',
        '',
        '## tests · red (exit 1, 1.2s)',
        '',
        '`bun test`',
        '',
        '````text',
        'cart.test.ts:',
        '(fail) adds an item',
        '```',
        '````',
        '',
        '## types · not configured',
        '',
        '```text',
        'not configured: no Layer gives types a command, so it was not run',
        '```',
        '',
        '## no-new-suppressions · green',
        '',
        '```text',
        'no suppression added',
        '```',
        '',
      ].join('\n'),
    );
  });

  test('a repo with no pack (#159): "no checks configured: nothing was run", never green', () => {
    const [, types, suppressions] = report.results;

    if (types === undefined || suppressions === undefined) throw new Error('the report has three');
    const none: FactoryChecksData = {
      ...report,
      none: true,
      results: [{ ...types, name: 'tests', output: 'not configured\n' }, suppressions],
    };

    expect(factoryChecksText(none)).toBe(
      [
        'AB#4 checks no checks configured: nothing was run  /r-wt/4-sign-in/.scratch/4/checks.md',
        '  tests                 not configured',
        '  no-new-suppressions   green',
        '',
      ].join('\n'),
    );
    const md = checksMarkdown(none, '2026-10-01T09:00:00.000Z');

    expect(md).toStartWith(
      '# Checks · AB#4\n\nNo checks configured, nothing was run, at 2026-10-01T09:00:00.000Z (after build), in /r-wt/4-sign-in.\n\nNo check in force has a command',
    );
    expect(md).toContain('## tests · not configured');
  });

  test('typed into the session: the red ones and the end of their output', () => {
    expect(checksSaid(report)).toBe(
      [
        'Checks failed, so the run is back in build: tests. Fix what they say, then run abe factory stage-done build again. All of it is in .scratch/4/checks.md.',
        '',
        '## tests (bun test): exit 1',
        'cart.test.ts:\n(fail) adds an item\n```',
      ].join('\n'),
    );
  });

  test.each([
    ['a\nb\nc\n', 2, 100, 'b\nc'],
    ['abcdef', 5, 3, '…def'],
  ])('tail(%p, %p, %p)', (text, lines, chars, out) => {
    expect(tail(text, lines, chars)).toBe(out);
  });

  test("a command gets the person's HOME, PATH and locale, CI, no profile of ~/.aws, and nothing else", () => {
    expect(
      checksEnv({
        HOME: '/h',
        PATH: '/bin',
        USER: 'me',
        LANG: 'sv_SE.UTF-8',
        GITHUB_TOKEN: 'ghp_x',
        ABE_SOCKET: '/s',
        TMPDIR: '',
      }),
    ).toEqual({
      CI: 'true',
      ...CHECKS_NO_AWS_PROFILE,
      HOME: '/h',
      PATH: '/bin',
      USER: 'me',
      LANG: 'sv_SE.UTF-8',
    });
  });

  test("serve's own DATABASE_URL never: a check gets its session's database or its env file's", () => {
    expect(
      checksEnv({ HOME: '/h', PATH: '/bin', DATABASE_URL: 'postgres://shop:shop@127.0.0.1/shop' }),
    ).toEqual({ CI: 'true', ...CHECKS_NO_AWS_PROFILE, HOME: '/h', PATH: '/bin' });
  });
});
