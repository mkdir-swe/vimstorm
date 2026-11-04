/**
 * The empty file aws's config and credentials point at while aws is off (core's `awsOffEnv`):
 * Abe's own, in its state, emptied again each time it is handed on.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const awsOffFile = (stateDir: string): string => {
  const dir = join(stateDir, 'aws-off');
  const file = join(dir, 'empty');

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, '', { mode: 0o600 });

  return file;
};
