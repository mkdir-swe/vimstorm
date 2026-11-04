/**
 * `scripts/release.sh`: one `abe` linux-arm64 build into the artifacts bucket by version, with
 * its checksum and the box's image build (`abe/images`), against the fake `aws`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeS3, type FakeS3 } from '../packages/testing/src/tools/s3';

const SCRIPT = join(import.meta.dir, 'release.sh');
const BUCKET = 'abe-artifacts-test';

let s3: FakeS3 | undefined;
let work: string | undefined;

afterEach(() => {
  s3?.remove();
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
  s3 = undefined;
  work = undefined;
});

const setUp = () => {
  s3 = fakeS3();
  work = mkdtempSync(join(tmpdir(), 'release-'));
  const bin = join(work, 'abe-linux-arm64');

  writeFileSync(bin, 'the abe binary\n', { mode: 0o755 });

  return { s3, work, bin };
};

const run = (args: readonly string[], env: Record<string, string>, script = SCRIPT) => {
  const out = Bun.spawnSync(['bash', script, ...args], {
    env: { HOME: work ?? '/tmp', ...env },
  });

  return { exit: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};

/** The objects in the fake bucket, by key. */
const objects = (fake: FakeS3) =>
  Object.fromEntries(
    readdirSync(join(fake.dir, 'objects'))
      .map((name) => decodeURIComponent(name))
      .filter((name) => name.startsWith(`${BUCKET}/`))
      .map((name) => [
        name.slice(BUCKET.length + 1),
        join(fake.dir, 'objects', encodeURIComponent(name)),
      ]),
  );

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('release.sh', () => {
  test('puts the binary, its checksum and the image build under abe/<version>/', () => {
    const { s3: fake, work: dir, bin } = setUp();
    const out = run([], {
      PATH: fake.path,
      ABE_ARTIFACTS_BUCKET: BUCKET,
      ABE_RELEASE_VERSION: '2.0.0-test.1',
      ABE_BIN: bin,
    });

    expect(out.stderr).toBe('');
    expect(out.exit).toBe(0);
    expect(out.stdout).toContain('abe 2.0.0-test.1');
    const got = objects(fake);

    expect(Object.keys(got).sort()).toEqual([
      'abe/2.0.0-test.1/abe-linux-arm64',
      'abe/2.0.0-test.1/abe-linux-arm64.sha256',
      'abe/2.0.0-test.1/images.tar.gz',
      'abe/current',
    ]);
    // The pin every box's boot reads (abe-org terraform/modules/box-boot): this release.
    expect(readFileSync(got['abe/current'] ?? '', 'utf8')).toBe('2.0.0-test.1\n');
    expect(readFileSync(got['abe/2.0.0-test.1/abe-linux-arm64'] ?? '', 'utf8')).toBe(
      'the abe binary\n',
    );
    // `sha256sum -c` on the box reads this line.
    expect(readFileSync(got['abe/2.0.0-test.1/abe-linux-arm64.sha256'] ?? '', 'utf8')).toBe(
      `${sha256(bin)}  abe-linux-arm64\n`,
    );
    const listed = Bun.spawnSync(['tar', '-tzf', got['abe/2.0.0-test.1/images.tar.gz'] ?? ''], {
      cwd: dir,
    });
    const files = listed.stdout.toString().split('\n');

    // The box runs /opt/abe/images/build.sh, which reads /opt/abe/packages/serve/package.json.
    expect(files).toContain('images/build.sh');
    expect(files).toContain('images/box/imds-block.sh');
    expect(files).toContain('images/base/Dockerfile');
    expect(files).toContain('packages/serve/package.json');
    // VimStorm's nvim config beside it: /opt/abe/nvim, the workspace image's editor (#89).
    expect(files).toContain('nvim/init.lua');
    expect(files).toContain('nvim/lazy-lock.json');
    expect(files.filter((f) => f.split('/').some((p) => p.startsWith('._')))).toEqual([]);
  });

  test('a version already in the bucket is refused, and --force puts it again', () => {
    const { s3: fake, work: dir, bin } = setUp();
    const env = {
      PATH: fake.path,
      ABE_ARTIFACTS_BUCKET: BUCKET,
      ABE_RELEASE_VERSION: '2.0.0-test.2',
      ABE_BIN: bin,
    };

    expect(run([], env).exit).toBe(0);
    writeFileSync(join(dir, 'abe-linux-arm64'), 'a newer build\n');
    const again = run([], env);

    expect(again.exit).toBe(1);
    expect(again.stderr).toContain('abe 2.0.0-test.2 is already in s3://abe-artifacts-test');
    expect(readFileSync(objects(fake)['abe/2.0.0-test.2/abe-linux-arm64'] ?? '', 'utf8')).toBe(
      'the abe binary\n',
    );
    expect(run(['--force'], env).exit).toBe(0);
    expect(readFileSync(objects(fake)['abe/2.0.0-test.2/abe-linux-arm64'] ?? '', 'utf8')).toBe(
      'a newer build\n',
    );
  });

  test('--no-current puts the version without moving the boxes to it', () => {
    const { s3: fake, bin } = setUp();
    const env = { PATH: fake.path, ABE_ARTIFACTS_BUCKET: BUCKET, ABE_BIN: bin };

    expect(run([], { ...env, ABE_RELEASE_VERSION: '2.0.0-test.5' }).exit).toBe(0);
    const staged = run(['--no-current'], { ...env, ABE_RELEASE_VERSION: '2.0.0-test.6' });

    expect(staged.exit).toBe(0);
    expect(staged.stdout).toContain('abe/current still names');
    const got = objects(fake);

    expect(got['abe/2.0.0-test.6/abe-linux-arm64']).toBeDefined();
    expect(readFileSync(got['abe/current'] ?? '', 'utf8')).toBe('2.0.0-test.5\n');
  });

  test('a release whose build is not all put leaves abe/current alone', () => {
    const { s3: fake, bin } = setUp();
    const env = { PATH: fake.path, ABE_ARTIFACTS_BUCKET: BUCKET, ABE_BIN: bin };

    expect(run([], { ...env, ABE_RELEASE_VERSION: '2.0.0-test.7' }).exit).toBe(0);
    fake.deny(['abe/2.0.0-test.8/abe-linux-arm64']);
    const out = run([], { ...env, ABE_RELEASE_VERSION: '2.0.0-test.8' });

    expect(out.exit).toBe(1);
    expect(readFileSync(objects(fake)['abe/current'] ?? '', 'utf8')).toBe('2.0.0-test.7\n');
  });

  test('a refused abe/current write fails the release, naming it', () => {
    const { s3: fake, bin } = setUp();

    fake.deny(['abe/current']);
    const out = run([], {
      PATH: fake.path,
      ABE_ARTIFACTS_BUCKET: BUCKET,
      ABE_RELEASE_VERSION: '2.0.0-test.9',
      ABE_BIN: bin,
    });

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain('abe/current');
    expect(objects(fake)['abe/2.0.0-test.9/abe-linux-arm64']).toBeDefined();
  });

  test('no bucket named is a usage failure', () => {
    const { s3: fake, bin } = setUp();
    const out = run([], { PATH: fake.path, ABE_RELEASE_VERSION: '1.0.0', ABE_BIN: bin });

    expect(out.exit).toBe(2);
    expect(out.stderr).toContain('ABE_ARTIFACTS_BUCKET');
  });

  test('an upload refused by the bucket fails the release', () => {
    const { s3: fake, bin } = setUp();

    fake.deny(['abe/']);
    const out = run([], {
      PATH: fake.path,
      ABE_ARTIFACTS_BUCKET: BUCKET,
      ABE_RELEASE_VERSION: '2.0.0-test.3',
      ABE_BIN: bin,
    });

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain('AccessDenied');
  });

  /**
   * An abe workspace of its own in a git repo (the script, its images, serve's package.json)
   * and a `bun` whose `run build:linux` writes the binary, so the default version is this
   * repo's commit.
   */
  const checkout = (dir: string) => {
    const abe = join(dir, 'repo', 'abe');
    const bin = join(dir, 'bin');
    const git = (...argv: string[]) => {
      const out = Bun.spawnSync(['git', '-C', join(dir, 'repo'), ...argv], {
        env: { HOME: dir, GIT_CONFIG_NOSYSTEM: '1', PATH: '/usr/bin:/bin' },
      });

      if (out.exitCode !== 0) throw new Error(out.stderr.toString());

      return out.stdout.toString().trim();
    };

    for (const d of ['scripts', 'images/box', 'images/base', 'packages/serve'])
      mkdirSync(join(abe, d), { recursive: true });
    copyFileSync(SCRIPT, join(abe, 'scripts', 'release.sh'));
    copyFileSync(join(import.meta.dir, 'version.sh'), join(abe, 'scripts', 'version.sh'));
    writeFileSync(join(abe, 'images', 'build.sh'), '#!/bin/sh\n');
    writeFileSync(join(abe, 'images', 'box', 'imds-block.sh'), '#!/bin/sh\n');
    writeFileSync(join(abe, 'images', 'base', 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(
      join(abe, 'packages', 'serve', 'package.json'),
      `${JSON.stringify({ name: '@abe/serve', version: '9.8.7-alpha.1' }, null, 2)}\n`,
    );
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'bun'),
      '#!/bin/sh\n[ "$1 $2" = "run build:linux" ] || exit 9\nmkdir -p dist && echo "built $ABE_VERSION" > dist/abe-linux-arm64\n',
      { mode: 0o755 },
    );
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');

    return {
      abe,
      script: join(abe, 'scripts', 'release.sh'),
      bin,
      sha: git('rev-parse', '--short=8', 'HEAD'),
    };
  };

  test("the default version is serve's version and the commit, built with bun carrying it", () => {
    const { s3: fake, work: dir } = setUp();
    const repo = checkout(dir);
    const out = run(
      [],
      { PATH: `${fake.dir}:${repo.bin}:/usr/bin:/bin`, ABE_ARTIFACTS_BUCKET: BUCKET },
      repo.script,
    );

    expect(out.stderr).toBe('');
    expect(out.exit).toBe(0);
    const version = `9.8.7-alpha.1-${repo.sha}`;

    expect(out.stdout).toContain(`abe ${version} in s3://${BUCKET}/abe/${version}/`);
    // The binary carries the release's version (`abe status` says it, #188).
    expect(readFileSync(objects(fake)[`abe/${version}/abe-linux-arm64`] ?? '', 'utf8')).toBe(
      `built ${version}\n`,
    );
  });

  test('a tree with changes needs a version named', () => {
    const { s3: fake, work: dir } = setUp();
    const repo = checkout(dir);

    writeFileSync(join(repo.abe, 'images', 'build.sh'), '#!/bin/sh\necho changed\n');
    const out = run(
      [],
      { PATH: `${fake.dir}:${repo.bin}:/usr/bin:/bin`, ABE_ARTIFACTS_BUCKET: BUCKET },
      repo.script,
    );

    expect(out.exit).toBe(1);
    expect(out.stderr).toContain('commit them or name ABE_RELEASE_VERSION');
  });

  test('a binary given (ABE_BIN) needs a version named; a version is letters, digits, . _ -', () => {
    const { s3: fake, bin } = setUp();
    const unnamed = run([], { PATH: fake.path, ABE_ARTIFACTS_BUCKET: BUCKET, ABE_BIN: bin });

    expect(unnamed.exit).toBe(1);
    expect(unnamed.stderr).toContain('ABE_BIN needs ABE_RELEASE_VERSION');
    const bad = run([], {
      PATH: fake.path,
      ABE_ARTIFACTS_BUCKET: BUCKET,
      ABE_BIN: bin,
      ABE_RELEASE_VERSION: '1.0/../x',
    });

    expect(bad.exit).toBe(1);
    expect(bad.stderr).toContain('a version is letters, digits');
  });
});
