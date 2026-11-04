/**
 * Where the Mac's `serve` keeps its sessions in your environment: `<state>/cloud/<id>.json`, each
 * written whole through a rename. Unchecked documents in, as read; core's schema reads them.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const cloudDir = (stateDir: string): string => join(stateDir, 'cloud');

/** Every record as read (unchecked); a file that is not JSON is skipped and left on disk. */
export const readCloudRecords = (stateDir: string): unknown[] => {
  const dir = cloudDir(stateDir);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const doc: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));

        return [doc];
      } catch {
        return [];
      }
    });
};

export const writeCloudRecord = (stateDir: string, id: string, doc: unknown): void => {
  const file = join(cloudDir(stateDir), `${id}.json`);

  writeFileSync(`${file}.new`, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.new`, file);
};

/** A record gone (a held `box place` once answered); none by `id` is fine. */
export const removeCloudRecord = (stateDir: string, id: string): void => {
  rmSync(join(cloudDir(stateDir), `${id}.json`), { force: true });
};
