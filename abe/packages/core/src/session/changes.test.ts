/** `git diff` output read into a turn's patches: changed, new, deleted, binary and quoted files. */
import { describe, expect, test } from 'bun:test';
import { patchesOfDiff, sameChanges } from './changes';
import { CHANGES_FILES_MAX, PATCH_LINES_MAX } from './transcript';

const DIFF = [
  'diff --git a/api/src/cart.ts b/api/src/cart.ts',
  'index 53a4e01..8ac0fc9 100644',
  '--- a/api/src/cart.ts',
  '+++ b/api/src/cart.ts',
  '@@ -14,7 +14,7 @@ export interface Cart {',
  ' export function cartTotal(cart: Cart): number {',
  '   const vat = marketFor(cart.market).vat;',
  '   const subtotal = cart.lines.reduce(',
  '-    (sum, line) => sum + line.price,',
  '+    (sum, line) => sum + line.price * line.quantity,',
  '     0,',
  '   );',
  '   return Math.round(subtotal * (1 + vat));',
  'diff --git a/api/test/zero.test.ts b/api/test/zero.test.ts',
  'new file mode 100644',
  'index 0000000..1b2c3d4',
  '--- /dev/null',
  '+++ b/api/test/zero.test.ts',
  '@@ -0,0 +1,2 @@',
  '+import { test } from "node:test";',
  '+test("zero", () => {});',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 1111111..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  '\\ No newline at end of file',
  'diff --git a/logo.png b/logo.png',
  'index 2222222..3333333 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git "a/sp\\303\\244c b/x.txt" "b/sp\\303\\244c b/x.txt"',
  'index 4444444..5555555 100644',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n');

describe('patchesOfDiff', () => {
  const { files, cut } = patchesOfDiff(DIFF, '/work/wt/');

  test('one patch per file in order, paths under the root', () => {
    expect(files.map((f) => f.path)).toEqual([
      '/work/wt/api/src/cart.ts',
      '/work/wt/api/test/zero.test.ts',
      '/work/wt/old.txt',
      '/work/wt/logo.png',
      '/work/wt/späc b/x.txt',
    ]);
    expect(cut).toBe(0);
  });

  test('hunks with line numbers and 3 lines of context, counts', () => {
    expect(files[0]).toMatchObject({ created: false, added: 1, removed: 1, cut: 0 });
    expect(files[0]?.hunks[0]).toMatchObject({
      oldStart: 14,
      oldLines: 7,
      newStart: 14,
      newLines: 7,
    });
    expect(files[0]?.hunks[0]?.lines).toHaveLength(8);
  });

  test('a new file is created; a deleted one only removes; a binary one has no hunks', () => {
    expect(files[1]).toMatchObject({ created: true, added: 2, removed: 0 });
    expect(files[2]).toMatchObject({ created: false, added: 0, removed: 1 });
    expect(files[2]?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
    });
    expect(files[3]).toMatchObject({ hunks: [], added: 0, removed: 0 });
  });

  test('lines and files capped', () => {
    const many = Array.from({ length: CHANGES_FILES_MAX + 2 }, (_, i) =>
      [`diff --git a/f${i} b/f${i}`, '@@ -1 +1 @@', '-a', '+b'].join('\n'),
    ).join('\n');

    expect(patchesOfDiff(many, '/w').cut).toBe(2);
    expect(patchesOfDiff(many, '/w').files).toHaveLength(CHANGES_FILES_MAX);
    const long = [
      'diff --git a/big b/big',
      `@@ -0,0 +1,${PATCH_LINES_MAX + 5} @@`,
      ...Array.from({ length: PATCH_LINES_MAX + 5 }, () => '+x'),
    ].join('\n');

    expect(patchesOfDiff(long, '/w').files[0]).toMatchObject({
      added: PATCH_LINES_MAX + 5,
      cut: 5,
    });
  });

  test('nothing changed is no files', () => {
    expect(patchesOfDiff('', '/w')).toEqual({ files: [], cut: 0 });
    expect(sameChanges({ files: [], cut: 0 }, patchesOfDiff('', '/w'))).toBe(true);
    expect(sameChanges({ files: [], cut: 0 }, { files, cut: 0 })).toBe(false);
  });
});
