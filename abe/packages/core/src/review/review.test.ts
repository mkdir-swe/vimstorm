/**
 * PR review's data rules (1.x's `crates/abe-core/tests/changes.rs`, from TS Abe's
 * `domain/review/review.test.ts`): the local prepass, a patch's hunks and the head line a change
 * opens at, marks that follow content hashes and what changed since your review.
 */
import { describe, expect, test } from 'bun:test';
import { type ChangedFile } from './changes';
import { hash, stableJson } from './hash';
import { headLine, parsePatch } from './hunks';
import { marked, reviewedPaths, sinceReview } from './marks';
import { areaOf, readChanges } from './read';

const file = (path: string, patch: string, more: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'M',
  additions: 1,
  deletions: 1,
  binary: false,
  patch,
  ...more,
});

const renamed = (path: string, previous: string, similarity: number, patch: string) =>
  file(path, patch, { previous, status: 'R', similarity });

const binary = (path: string, more: Partial<ChangedFile> = {}) =>
  file(path, '', { binary: true, ...more });

const read = (files: ChangedFile[]) =>
  readChanges({
    head: 'h',
    base: null,
    worktree: null,
    files,
    commits: [],
    fresh: [],
    marks: null,
    packages: [],
  });

describe('the prepass', () => {
  test('names the changes nobody reads line by line', () => {
    const cases: [ChangedFile, string | undefined][] = [
      [
        file(
          'imports.ts',
          "@@ -1,2 +1,2 @@\n-import { a } from './a';\n+import { a } from './b';\n const x = 1;",
        ),
        'imports',
      ],
      [
        file(
          'block.ts',
          '@@ -11,7 +11,7 @@ import {\n   Stack,\n-  Bucket,\n+  BlockPublicAccess, Bucket,\n } from "aws";',
        ),
        'imports',
      ],
      [
        file(
          'class.ts',
          '@@ -92,4 +92,4 @@ export class Stack extends Base {\n-    bucket.grantPut(fn);\n+    bucket.grantReadWrite(fn);',
        ),
        undefined,
      ],
      [file('format.ts', '@@ -1 +1 @@\n-if (a) {\n+  if (a) {\n'), 'format'],
      [
        renamed(
          'src/new/moved.ts',
          'src/moved.ts',
          92,
          "@@ -1 +1 @@\n-import x from '../x';\n+import x from '../../x';",
        ),
        'rename',
      ],
      [renamed('src/same.ts', 'same.ts', 100, ''), 'rename'],
      [renamed('src/edited.ts', 'edited.ts', 95, '@@ -1 +1 @@\n-return 1;\n+return 2;'), undefined],
      [file('far.ts', '@@ -1 +1 @@\n-a\n+b', { status: 'R', similarity: 60 }), undefined],
      [file('package-lock.json', '@@ -1 +1 @@\n-a\n+b'), 'lockfile'],
      [file('web/yarn.lock', '@@ -1 +1 @@\n-a\n+b'), 'lockfile'],
      [file('src/__snapshots__/a.test.ts.snap', '@@ -1 +1 @@\n-a\n+b'), 'snapshot'],
      [file('src/api/generated/client.ts', '@@ -1 +1 @@\n-a\n+b'), 'generated'],
      [file('src/schema.gen.ts', '@@ -1 +1 @@\n-a\n+b'), 'generated'],
      [file('backend/cdk.out/stack.json', '@@ -1 +1 @@\n-a\n+b'), 'build'],
      [binary('dist/logo.png'), 'build'],
      [binary('logo.png', { status: 'R', similarity: 100 }), undefined],
      [
        file(
          'mixed.ts',
          "@@ -1,2 +1,2 @@\n-import a from './a';\n+import a from './b';\n-a();\n+b();",
        ),
        undefined,
      ],
      [file('exports.ts', "@@ -1 +1 @@\n-export { a } from './a';\n+export { a, b };"), 'imports'],
      [
        file('star.ts', "@@ -1 +1 @@\n-export * from './a';\n+export type * from './b';"),
        'imports',
      ],
      [
        file(
          'require.ts',
          "@@ -1 +1 @@\n-const { a } = require('a');\n+const { a, b } = require('a');",
        ),
        'imports',
      ],
    ];
    const changes = read(cases.map(([f]) => f));

    expect(cases.map(([f]) => [f.path, changes.mechanical[f.path]])).toEqual(
      cases.map(([f, want]) => [f.path, want]),
    );
  });

  test('a file whose every hunk an earlier file has is a copy of the first original', () => {
    const grant = '@@ -9 +9 @@ x\n-    bucket.grantPut(fn);\n+    bucket.grantReadWrite(fn);';
    const block = '@@ -1 +1 @@\n-  publicReadAccess: true,\n+  blockPublicAccess: ALL,';
    const changes = read([
      file('reports/stack.ts', `${grant}\n${block}`),
      file('co2/stack.ts', `${block}\n${grant}\n@@ -40 +40 @@\n-old();\n+fresh();`, {
        additions: 3,
        deletions: 3,
      }),
      file('statistics/stack.ts', grant.replace('    bucket', '\tbucket')),
      file('other.ts', '@@ -1 +1 @@\n-a\n+b'),
      file('more.ts', '@@ -1 +1 @@\n-c\n+d'),
    ]);

    expect(changes.copies).toEqual({
      'reports/stack.ts': 'co2/stack.ts',
      'statistics/stack.ts': 'co2/stack.ts',
    });
  });
});

describe('hunks', () => {
  test("a patch's hunks open at their first change on the head", () => {
    const two = '@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -20,3 +21,2 @@ tail\n x\n-y\n z';
    const hunks = parsePatch(two);

    expect(hunks.length).toBe(2);
    expect([hunks[0]?.left, hunks[0]?.right, hunks[0]?.heading]).toEqual([1, 1, '']);
    expect(hunks[1]?.heading).toBe('tail');
    expect(hunks.map(headLine)).toEqual([2, 22]);
    expect(parsePatch('')).toEqual([]);
    expect(read([file('a.ts', two)]).files[0]?.heads).toEqual([2, 22]);
  });
});

describe('marks', () => {
  test("follow the change's content, not its place, and say what changed since", () => {
    const a = file('a.ts', '@@ -1 +1 @@\n-x\n+y');
    const b = file('b.ts', '@@ -5 +5 @@\n-p\n+q');
    const files = [a, b];
    const marks = marked(null, files, ['a.ts'], true, 'h1');

    expect(marks.head).toBe('h1');
    expect(marks.paths).toEqual(['a.ts', 'b.ts']);
    expect(Object.keys(marks.marks)).toEqual(['a.ts']);
    expect(marks.marks['a.ts']?.head).toBe('h1');
    expect([...reviewedPaths(marks, files)]).toEqual(['a.ts']);
    // the base moving on keeps the mark: the same lines at another place
    const moved = file('a.ts', '@@ -7 +7 @@\n-x\n+y');

    expect(reviewedPaths(marks, [moved, b]).size).toBe(1);
    expect(sinceReview(marks, [moved, b], 'h2')).toBeNull();
    // a line changed anew drops it, and names the file as changed since the review
    const edited = file('a.ts', '@@ -1 +1 @@\n-x\n+z');

    expect(reviewedPaths(marks, [edited, b]).size).toBe(0);
    expect(sinceReview(marks, [edited, b], 'h2')).toEqual({ from: 'h1', paths: ['a.ts'] });
    // the head moved: a file the PR did not have then counts too
    const c = file('c.ts', '@@ -1 +1 @@\n-1\n+2');

    expect(sinceReview(marks, [a, b, c], 'h2')?.paths).toEqual(['c.ts']);
    // off again: the mark goes, the others stay
    expect(marked(marks, files, ['a.ts'], false, 'h1').marks).toEqual({});
    expect(sinceReview(null, files, 'h1')).toBeNull();
  });

  test("a mark written by 1.x reads the same: the change's hash is cyrb53 of its lines", () => {
    // the values 1.x's Rust `text::hash` gives (cyrb53 over UTF-16 units)
    expect([hash(''), hash('M\n\n-x\n+y'), hash('å✓')]).toEqual([
      '0bdcb81aee8d83',
      '1e457e55ba4e65',
      '144a0f3a66bacd',
    ]);
    // serde_json's json! maps: keys in byte order, nulls kept
    expect(stableJson({ b: 1, a: [{ d: null, c: 'x' }], u: undefined })).toBe(
      '{"a":[{"c":"x","d":null}],"b":1}',
    );
  });
});

describe('areas', () => {
  test("a path's area: its package's folder, a container's child, its top folder", () => {
    const packages = new Set(['web', 'services/api']);

    expect(
      [
        'web/src/a.ts',
        'services/api/src/b.ts',
        'services/billing/c.ts',
        'docs/d.md',
        'README.md',
      ].map((p) => areaOf(p, packages)),
    ).toEqual(['web', 'services/api', 'services/billing', 'docs', '']);
  });
});
