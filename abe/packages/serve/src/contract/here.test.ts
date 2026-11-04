/** Folders resolved once where they come in: a symlinked checkout is named by its real path. */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRealRoot } from '../process/bridge';
import { checkoutAt, realPathAt } from './here';

// macOS: tmpdir's /var is a link to /private/var, as /tmp is to /private/tmp
const dir = mkdtempSync(join(tmpdir(), 'abe-here-'));
const real = join(realpathSync(dir), 'shop');
const link = join(dir, 'link');

mkdirSync(real);
symlinkSync(real, link);
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a --repo or a cwd through a symlink: its real path; one not there: as resolved', () => {
  expect(realPathAt(link)).toBe(real);
  expect(realPathAt('/', link)).toBe(real);
  expect(realPathAt(dir, 'link')).toBe(real);
  expect(realPathAt(dir, 'gone/../link')).toBe(real);
  expect(realPathAt('/nowhere', 'repo')).toBe('/nowhere/repo');
  // not there yet: its folder's real path, the rest as named
  expect(realPathAt(link, 'new/dir')).toBe(join(real, 'new', 'dir'));
});

test("the app's folder comes in as its real path, so Chat and the Board match its sessions", () => {
  expect(withRealRoot({ v: 2, type: 'project', root: link })).toEqual({
    v: 2,
    type: 'project',
    root: real,
  });
  expect(
    withRealRoot({
      v: 2,
      type: 'hello',
      size: { width: 1, height: 1 },
      version: 'x',
      root: link,
    }),
  ).toMatchObject({ root: real });
  // a box's folder is no folder on this Mac: as it came
  expect(withRealRoot({ v: 2, type: 'project', root: '/workspace/repo', box: 'b' })).toEqual({
    v: 2,
    type: 'project',
    root: '/workspace/repo',
    box: 'b',
  });
});

test.each<[string, (top: string) => void, ReturnType<typeof checkoutAt>]>([
  // what, how the folder is made, what `:` is told (Install the Factory…)
  ['no repo top', () => undefined, undefined],
  [
    'a main checkout, not installed',
    (t) => {
      mkdirSync(join(t, '.git'));
    },
    { main: true, installed: false },
  ],
  [
    'a main checkout, installed',
    (t) => {
      mkdirSync(join(t, '.git'));
      mkdirSync(join(t, '.abe'));
      writeFileSync(join(t, 'abe.yaml'), 'checks: []\n');
    },
    { main: true, installed: true },
  ],
  [
    'a worktree',
    (t) => {
      writeFileSync(join(t, '.git'), 'gitdir: ../.git/worktrees/x\n');
    },
    { main: false, installed: false },
  ],
])("the shown folder's checkout: %s", (what, make, said) => {
  const top = join(dir, what.replaceAll(' ', '-').replaceAll(',', ''));

  mkdirSync(top);
  make(top);
  expect(checkoutAt(top)).toEqual(said);
});
