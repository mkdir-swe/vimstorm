/**
 * The fake EC2 Instance Connect path. It is a fake endpoint with a box behind it (`fakeEice`)
 * and a fake `ssh` (`fakeSsh`) that runs abe's real tunnel as its ProxyCommand.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export * from './server';
export * from './wire';

export type FakeSsh = {
  /** The script `$ABE_SSH` names. */
  bin: string;
  /** Every call's argv, in order. */
  calls: () => string[][];
};

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const fakeSsh = (): FakeSsh => {
  const home = mkdtempSync(join(tmpdir(), 'fake-ssh-'));
  const bin = join(home, 'ssh');
  const log = join(home, 'calls.jsonl');

  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `FAKE_SSH_LOG=${quote(log)} exec ${quote(process.execPath)} ${quote(join(import.meta.dir, 'ssh-main.ts'))} "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return {
    bin,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => z.array(z.string()).parse(JSON.parse(l)))
        : [],
  };
};
