/**
 * `scripts/version.sh`: the version a build carries (#188), `packages/serve`'s and the commit,
 * `-dirty` for a tree with changes, or `ABE_VERSION` when named.
 */
import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'version.sh');

let work: string | undefined;

afterEach(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
  work = undefined;
});

const ENV = { HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin' };

/** An abe workspace of its own in a git repo: the script and serve's package.json, committed. */
const checkout = () => {
  work = mkdtempSync(join(tmpdir(), 'version-'));
  const abe = join(work, 'abe');
  const git = (...argv: string[]) => {
    const out = Bun.spawnSync(['git', '-C', work ?? '', ...argv], { env: ENV });

    if (out.exitCode !== 0) throw new Error(out.stderr.toString());

    return out.stdout.toString().trim();
  };

  mkdirSync(join(abe, 'scripts'), { recursive: true });
  mkdirSync(join(abe, 'packages', 'serve'), { recursive: true });
  copyFileSync(SCRIPT, join(abe, 'scripts', 'version.sh'));
  writeFileSync(
    join(abe, 'packages', 'serve', 'package.json'),
    `${JSON.stringify({ name: '@abe/serve', version: '9.8.7', private: true }, null, 2)}\n`,
  );
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');

  return { abe, sha: git('rev-parse', '--short=8', 'HEAD') };
};

const run = (abe: string, env: Record<string, string> = {}) => {
  const out = Bun.spawnSync(['bash', join(abe, 'scripts', 'version.sh')], {
    env: { ...ENV, ...env },
  });

  return { exit: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};

test("serve's version and the commit; -dirty once the tree has changes", () => {
  const { abe, sha } = checkout();

  expect(run(abe)).toEqual({ exit: 0, stdout: `9.8.7-${sha}\n`, stderr: '' });
  writeFileSync(join(abe, 'packages', 'serve', 'more.ts'), 'export {};\n');
  expect(run(abe).stdout).toBe(`9.8.7-${sha}-dirty\n`);
});

test('ABE_VERSION named is the version; one with other characters is refused', () => {
  const { abe } = checkout();

  expect(run(abe, { ABE_VERSION: '2.2.0-rc.1' }).stdout).toBe('2.2.0-rc.1\n');
  const bad = run(abe, { ABE_VERSION: '2.2.0"; rm -rf /' });

  expect(bad.exit).toBe(1);
  expect(bad.stderr).toContain('a version is letters, digits');
});

test("outside git: the package's version alone", () => {
  const { abe } = checkout();

  rmSync(join(work ?? '', '.git'), { recursive: true, force: true });
  expect(run(abe).stdout).toBe('9.8.7\n');
});
