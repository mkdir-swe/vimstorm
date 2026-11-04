/**
 * Your Sheets on disk, in `serve`'s state directory: `<dir>/<id>/meta.json` beside each version's
 * `v<n>.html`. IO only; what a save means is core's (`planSave`). Read with no port interface,
 * as the Layers' files are: tests use a real temporary folder.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SheetMeta } from '@abe/core';
import { readMetas, replaceFile } from './state-files';

export type LocalSheets = {
  dir: string;
  /** Every Sheet whose `meta.json` reads; a broken one is left out. */
  all: () => Promise<SheetMeta[]>;
  /** A version's file. */
  path: (id: string, version: number) => string;
  read: (id: string, version: number) => Promise<Uint8Array | undefined>;
  /** Writes the version's page, then the meta that names it. */
  write: (meta: SheetMeta, version: number, html: Uint8Array) => Promise<void>;
  /** Writes the meta alone (an attach). */
  update: (meta: SheetMeta) => Promise<void>;
};

export const localSheets = (dir: string): LocalSheets => {
  const path = (id: string, version: number) => join(dir, id, `v${version}.html`);
  const metaOf = (id: string) => join(dir, id, 'meta.json');
  const update = (meta: SheetMeta) =>
    replaceFile(metaOf(meta.id), `${JSON.stringify(meta, null, 2)}\n`);

  return {
    dir,
    all: () => readMetas(dir, SheetMeta),
    path,
    read: async (id, version) => {
      try {
        return new Uint8Array(await readFile(path(id, version)));
      } catch {
        return undefined;
      }
    },
    write: async (meta, version, html) => {
      await mkdir(join(dir, meta.id), { recursive: true });
      await replaceFile(path(meta.id, version), html);
      await update(meta);
    },
    update,
  };
};
