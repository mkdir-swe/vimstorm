/**
 * The fake `aws` for S3, `fake-s3/aws.ts`, as an executable first on `PATH`. It keeps a bucket in
 * a folder that `s3LogStore` reads and writes through the real `awsRunner`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const IMPL = join(import.meta.dir, 'fake-s3', 'aws.ts');

export type FakeS3 = {
  dir: string;
  /** `PATH` with the fake first and only the system's tools after it. */
  path: string;
  /** From now on, puts under any of `prefixes` get AccessDenied, as from a bucket policy's deny. */
  deny: (prefixes: readonly string[]) => void;
  remove: () => void;
};

/** An `aws` whose shebang is this Bun, so nothing on the `PATH` it is given needs to find Bun. */
export const fakeS3 = (): FakeS3 => {
  const dir = mkdtempSync(join(tmpdir(), 's3-'));

  writeFileSync(join(dir, 'aws'), `#!${process.execPath}\nimport ${JSON.stringify(IMPL)};\n`, {
    mode: 0o755,
  });

  return {
    dir,
    path: `${dir}:/usr/bin:/bin`,
    deny: (prefixes) => {
      writeFileSync(join(dir, 'deny'), prefixes.map((p) => `${p}\n`).join(''));
    },
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
