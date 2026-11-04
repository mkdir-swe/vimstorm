/**
 * `scripts/count.ts`: the counting rule, one planted source per line of it. The rule is the
 * baseline for measuring the suite, so a change to it has to show here first.
 */
import { expect, test } from 'bun:test';
import { countLua, countRust, countTs } from './count';

const TS_CASES: readonly (readonly [string, string, number, number])[] = [
  ['a plain test', `test('a', () => {});`, 1, 0],
  ['an it', `it('a', () => {});`, 1, 0],
  ['test.skip', `test.skip('a', () => {});`, 1, 0],
  ['test.only and test.todo', `test.only('a', () => {});\ntest.todo('b');`, 2, 0],
  ['test.skipIf(cond)', `test.skipIf(true)('a', () => {});`, 1, 0],
  ['an inline each of 3 rows', `test.each([1, 2, 3])('a %s', () => {});`, 3, 0],
  [
    'an each over a const array of 2',
    `const ROWS = [1, 2];\ntest.each(ROWS)('a', () => {});`,
    2,
    0,
  ],
  [
    'an each over a const array as const',
    `const ROWS = [[1], [2], [3]] as const;\ntest.each(ROWS)('a', () => {});`,
    3,
    0,
  ],
  [
    'an each over a const array satisfies',
    `const ROWS = [1, 2] satisfies number[];\ntest.each(ROWS)('a', () => {});`,
    2,
    0,
  ],
  [
    'a describe.each of 2 rows holding 2 tests',
    `describe.each([1, 2])('d %s', () => {\n  test('a', () => {});\n  test('b', () => {});\n});`,
    4,
    0,
  ],
  [
    'a describe.each of 2 rows holding an each of 3',
    `describe.each([1, 2])('d', () => {\n  test.each([1, 2, 3])('a', () => {});\n});`,
    6,
    0,
  ],
  [
    'a test in a for-of over a const array of 3',
    `const XS = ['a', 'b', 'c'];\nfor (const x of XS) {\n  test(x, () => {});\n}`,
    3,
    0,
  ],
  [
    'a test in nested for-of loops of 2 and 2',
    `const A = [1, 2];\nconst B = [3, 4];\nfor (const a of A) {\n  for (const b of B) {\n    test(\`\${a}\${b}\`, () => {});\n  }\n}`,
    4,
    0,
  ],
  [
    'a test in forEach over a const array',
    `const XS = [1, 2, 3];\nXS.forEach((x) => {\n  test(String(x), () => {});\n});`,
    3,
    0,
  ],
  ['a test in map over an inline array', `[1, 2].map((x) => test(String(x), () => {}));`, 2, 0],
  [
    'an each over Object.entries',
    `const x = { a: 1 };\ntest.each(Object.entries(x))('a', () => {});`,
    1,
    1,
  ],
  ['an each over a spread array', `const A = [1];\ntest.each([...A, 2])('a', () => {});`, 1, 1],
  [
    'an each over an imported table',
    `import { ROWS } from './rows';\ntest.each(ROWS)('a', () => {});`,
    1,
    1,
  ],
  [
    'a test in a for-of over a call',
    `for (const x of Object.keys({})) {\n  test(x, () => {});\n}`,
    1,
    1,
  ],
  [
    'an unknown loop around a known one keeps the known rows',
    `const A = [1, 2];\nfor (const x of make()) {\n  for (const a of A) test('t', () => {});\n}`,
    2,
    1,
  ],
  ['a file with no tests', `export const x = 1;\nconst r = /a/.test('a');`, 0, 0],
  ['a test word in a string or comment', `// test('a', () => {});\nconst s = "it('a')";`, 0, 0],
];

test.each(TS_CASES)('a table row is one case: %s', (_name, source, cases, unresolved) => {
  expect(countTs(source, 'a.test.ts')).toMatchObject({ cases, unresolved });
});

test.each([
  ['an each of 3 rows', `test.each([1, 2, 3])('a %s', () => {});`, 1],
  [
    'a describe.each of 2 rows holding 2 tests',
    `describe.each([1, 2])('d', () => {\n  test('a', () => {});\n  test('b', () => {});\n});`,
    2,
  ],
  ['a test in a for-of over 3', `for (const x of [1, 2, 3]) test(String(x), () => {});`, 1],
])('a test written once is one test, rows or not: %s', (_name, source, tests) => {
  expect(countTs(source, 'a.test.ts').tests).toBe(tests);
});

test('a tsx test file is read like a ts one', () => {
  const source = `test('a', () => { const x = <div />; });`;

  expect(countTs(source, 'a.test.tsx')).toEqual({ tests: 1, cases: 1, unresolved: 0 });
});

const RUST_CASES: readonly (readonly [string, string, number])[] = [
  ['#[test]', `#[test]\nfn a() {}`, 1],
  ['#[gpui::test]', `#[gpui::test]\nasync fn a(cx: &mut TestAppContext) {}`, 1],
  ['#[tokio::test(flavor)]', `#[tokio::test(flavor = "multi_thread")]\nasync fn a() {}`, 1],
  ['an indented #[test]', `mod t {\n    #[test]\n    fn a() {}\n    #[test]\n    fn b() {}\n}`, 2],
  ['#[cfg(test)] is not a case', `#[cfg(test)]\nmod tests {}`, 0],
  ['a commented #[test]', `// #[test]\n/// #[test]\nfn a() {}`, 0],
];

test.each(RUST_CASES)('a rust test attribute is one case: %s', (_name, source, cases) => {
  expect(countRust(source)).toBe(cases);
});

test('a lua check or expect call is one case, a comment is none', () => {
  const source = `H.expect("a", function()\n  H.check("b", true)\n  -- H.check("c", true)\nend)`;

  expect(countLua(source)).toBe(2);
});
