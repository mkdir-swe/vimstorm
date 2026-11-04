/**
 * `bun scripts/count.ts`: how many test files and test cases each suite holds, as a markdown
 * table. It is the baseline the suite is measured against while it shrinks, so the counting rule
 * is fixed and static (nothing runs). `cases` counts each table row, as `bun test` does; `tests`
 * counts each test written in the file once, a table included, as the 26 Oct audit counted:
 *
 * - TypeScript (bun:test), read from the AST. A call to `test` / `it` is one case, also with
 *   `.skip`, `.only`, `.todo`, `.failing`, `.if(c)` or `.skipIf(c)`. A table row is one case:
 *   `test.each(rows)` is one case per row, `describe.each(rows)` repeats the cases inside it per
 *   row, and a test inside `for (const x of rows)` or `rows.forEach(...)` repeats per row, loops
 *   multiplying when nested.
 * - `rows` is known when it is an array literal, or a name `const`-declared in the same file as
 *   one (through `as const`, `satisfies` and parentheses). A spread, a call (`Object.entries`),
 *   an import or any other loop is unknown: the test counts 1 and is added to `unresolved`, so
 *   the reader sees how exact a suite's count is.
 * - Rust: lines that are a `#[test]` style attribute (`#[tokio::test]`, `#[gpui::test(...)]`).
 *   `#[cfg(test)]` is not a case. Comment lines are skipped.
 * - Lua (nvim): each `H.check(` and `H.expect(` call is one case.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export type Row = {
  suite: string;
  files: number;
  tests: number;
  cases: number;
  unresolved: number;
};

type Counted = { tests: number; cases: number; unresolved: number };

/** Modifiers that keep a call a test call: `test.skip(...)`, `it.only(...)`. */
const MODIFIERS = new Set(['skip', 'only', 'todo', 'failing', 'concurrent', 'serial']);
/** Modifiers that are called with a condition first: `test.skipIf(c)(...)`. */
const CONDITIONS = new Set(['if', 'skipIf', 'todoIf', 'runIf']);
/** Array methods whose callback runs once per element. */
const ITERATORS = new Set(['forEach', 'map', 'flatMap']);

type Callee = { kind: 'test' | 'describe'; each: ts.Expression | undefined; isEach: boolean };

/** The expression under `as`, `satisfies`, `!` and parentheses. */
const unwrap = (node: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    return unwrap(node.expression);

  return node;
};

/** Every `const name = init` in the file, by name. A name declared twice is only known if every declaration agrees. */
const collectConsts = (file: ts.SourceFile): Map<string, ts.Expression[]> => {
  const found = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      node.parent.flags & ts.NodeFlags.Const
    )
      found.set(node.name.text, [...(found.get(node.name.text) ?? []), node.initializer]);
    ts.forEachChild(node, visit);
  };

  visit(file);

  return found;
};

/** The row count of `rows`, or `undefined` when it cannot be read from this file. */
const rowCount = (
  rows: ts.Expression,
  consts: Map<string, ts.Expression[]>,
  seen: readonly string[] = [],
): number | undefined => {
  const node = unwrap(rows);

  if (ts.isArrayLiteralExpression(node))
    return node.elements.some(ts.isSpreadElement) ? undefined : node.elements.length;

  if (!ts.isIdentifier(node) || seen.includes(node.text)) return undefined;

  const counts = (consts.get(node.text) ?? []).map((init) =>
    rowCount(init, consts, [...seen, node.text]),
  );
  const [first] = counts;

  return first !== undefined && counts.every((n) => n === first) ? first : undefined;
};

/** What a callee is when it is `test` / `it` / `describe` with any modifiers, `.each(rows)` and conditions. */
const parseCallee = (expr: ts.Expression): Callee | undefined => {
  const node = unwrap(expr);

  if (ts.isIdentifier(node)) {
    if (node.text === 'test' || node.text === 'it')
      return { kind: 'test', each: undefined, isEach: false };

    if (node.text === 'describe') return { kind: 'describe', each: undefined, isEach: false };

    return undefined;
  }

  if (ts.isPropertyAccessExpression(node) && MODIFIERS.has(node.name.text))
    return parseCallee(node.expression);

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const { name, expression } = node.expression;
    const inner = parseCallee(expression);

    if (inner === undefined) return undefined;

    if (name.text === 'each') return { ...inner, each: node.arguments[0], isEach: true };

    if (CONDITIONS.has(name.text)) return inner;
  }

  return undefined;
};

type Scope = {
  /** Times the code here runs, from the known loops and tables around it. */
  times: number;
  /** An unknown loop or table is around it, so `times` is a floor. */
  inexact: boolean;
};

/** Test cases in TypeScript source, by the rule at the top of this file. `path` picks `.ts` or `.tsx`. */
export const countTs = (text: string, path: string): Counted => {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const consts = collectConsts(file);
  const total: Counted = { tests: 0, cases: 0, unresolved: 0 };

  /** The scope inside a loop or table over `rows`. */
  const repeat = (scope: Scope, rows: ts.Expression | undefined): Scope => {
    const n = rows === undefined ? undefined : rowCount(rows, consts);

    return n === undefined
      ? { times: scope.times, inexact: true }
      : { times: scope.times * n, inexact: scope.inexact };
  };

  const visit = (node: ts.Node, scope: Scope) => {
    if (ts.isCallExpression(node)) {
      const callee = parseCallee(node.expression);

      if (callee?.kind === 'test') {
        const inner = callee.isEach ? repeat(scope, callee.each) : scope;

        total.tests += 1;
        total.cases += inner.times;

        if (inner.inexact) total.unresolved += 1;

        return;
      }

      if (callee?.kind === 'describe') {
        const inner = callee.isEach ? repeat(scope, callee.each) : scope;

        for (const arg of node.arguments) visit(arg, inner);

        return;
      }

      const target = unwrap(node.expression);

      if (ts.isPropertyAccessExpression(target) && ITERATORS.has(target.name.text)) {
        visit(target.expression, scope);

        for (const arg of node.arguments) visit(arg, repeat(scope, target.expression));

        return;
      }
    }

    if (ts.isForOfStatement(node)) {
      visit(node.expression, scope);
      visit(node.statement, repeat(scope, node.expression));

      return;
    }

    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      ts.forEachChild(node, (child) => {
        visit(child, { times: scope.times, inexact: true });
      });

      return;
    }

    ts.forEachChild(node, (child) => {
      visit(child, scope);
    });
  };

  visit(file, { times: 1, inexact: false });

  return total;
};

/** `#[test]`, `#[tokio::test]`, `#[gpui::test(iterations = 10)]`; not `#[cfg(test)]`. */
const RUST_TEST = /^\s*#\[(?:\w+::)*test(?:\(.*\))?\]/;

/** Test cases in Rust source: one per test attribute line. */
export const countRust = (text: string): number =>
  text.split('\n').filter((line) => RUST_TEST.test(line)).length;

/** Test cases in a Lua test: one per `H.check(` and `H.expect(` call, comment lines skipped. */
export const countLua = (text: string): number =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .reduce((sum, line) => sum + (line.match(/\bH\.(?:check|expect)\(/g)?.length ?? 0), 0);

/** Directories with no tests of ours in them. */
const SKIPPED_DIRS = new Set(['node_modules', 'target', '.git']);

/** Paths of the files under `dir` (recursively when `deep`) that `keep` accepts. Missing dir: none. */
const walk = (dir: string, keep: (name: string) => boolean, deep: boolean): string[] => {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory())
        return deep && !SKIPPED_DIRS.has(entry.name) ? walk(path, keep, deep) : [];

      return keep(entry.name) ? [path] : [];
    });
};

const isTsTest = (name: string) => /\.test\.tsx?$/.test(name);

const sumRows = (suite: string, rows: Row[]): Row => ({
  suite,
  files: rows.reduce((sum, row) => sum + row.files, 0),
  tests: rows.reduce((sum, row) => sum + row.tests, 0),
  cases: rows.reduce((sum, row) => sum + row.cases, 0),
  unresolved: rows.reduce((sum, row) => sum + row.unresolved, 0),
});

const tsSuite = (suite: string, dir: string, deep: boolean): Row => {
  const files = walk(dir, isTsTest, deep);
  const counted = files.map((path) => countTs(readFileSync(path, 'utf8'), path));

  return {
    suite,
    files: files.length,
    tests: counted.reduce((sum, c) => sum + c.tests, 0),
    cases: counted.reduce((sum, c) => sum + c.cases, 0),
    unresolved: counted.reduce((sum, c) => sum + c.unresolved, 0),
  };
};

/** Rust files with at least one test count as files; the rest are helpers. */
const rustSuite = (suite: string, dir: string): Row => {
  const perFile = walk(dir, (name) => name.endsWith('.rs'), true)
    .map((path) => countRust(readFileSync(path, 'utf8')))
    .filter((n) => n > 0);

  return {
    suite,
    files: perFile.length,
    tests: perFile.reduce((sum, n) => sum + n, 0),
    cases: perFile.reduce((sum, n) => sum + n, 0),
    unresolved: 0,
  };
};

const luaSuite = (suite: string, dir: string): Row => {
  const perFile = walk(dir, (name) => name.endsWith('_test.lua'), false).map((path) =>
    countLua(readFileSync(path, 'utf8')),
  );

  return {
    suite,
    files: perFile.length,
    tests: perFile.reduce((sum, n) => sum + n, 0),
    cases: perFile.reduce((sum, n) => sum + n, 0),
    unresolved: 0,
  };
};

export const PACKAGES = ['core', 'ports', 'serve', 'ui', 'hooks', 'testing'] as const;

/** One row per suite, with a total for abe (packages and scripts) and one for Rust. */
export const countSuites = (repo: string): Row[] => {
  const abe = [
    ...PACKAGES.map((name) => tsSuite(name, join(repo, 'abe', 'packages', name, 'src'), true)),
    tsSuite('scripts', join(repo, 'abe', 'scripts'), false),
  ];
  const rust = [
    rustSuite('window tests', join(repo, 'app', 'tests')),
    rustSuite('app source tests', join(repo, 'app', 'src')),
  ];

  return [
    ...abe,
    sumRows('abe total', abe),
    ...rust,
    sumRows('rust total', rust),
    luaSuite('nvim', join(repo, 'tests')),
  ];
};

/** The rows as a markdown table. */
export const renderTable = (rows: readonly Row[]): string =>
  [
    '| suite | files | tests | cases | unresolved |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows.map((r) => `| ${r.suite} | ${r.files} | ${r.tests} | ${r.cases} | ${r.unresolved} |`),
  ].join('\n');

if (import.meta.main) {
  // scripts/ sits in abe/, which sits in the repo root.
  console.log(renderTable(countSuites(join(import.meta.dir, '..', '..'))));
}
