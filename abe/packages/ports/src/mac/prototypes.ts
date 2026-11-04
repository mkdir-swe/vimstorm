/**
 * Your prototypes on disk, in `serve`'s state directory: `<dir>/<id>/meta.json`, `refused.jsonl`
 * (every request the proxy refused), its screenshots in `screenshots/` (#82) and its app's output
 * (`start.out`, `start.err`: the start script's, and what the app it left running still writes). IO only; the
 * record's rules are core's (`prototype.ts`). Read with no port interface, as the Sheets are:
 * tests use a real temporary folder.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrototypeMeta, type RefusedRequest } from '@abe/core';
import { readMetas, replaceFile } from './state-files';

export type LocalPrototypes = {
  dir: string;
  /** Every prototype whose `meta.json` reads; a broken one is left out. */
  all: () => Promise<PrototypeMeta[]>;
  write: (meta: PrototypeMeta) => Promise<void>;
  /** One refused request appended to the prototype's `refused.jsonl`. */
  refused: (id: string, at: string, r: RefusedRequest) => Promise<void>;
  /** A screenshot's file in the prototype's `screenshots` folder. */
  screenshotPath: (id: string, file: string) => string;
  writeScreenshot: (id: string, file: string, png: Uint8Array) => Promise<string>;
  /** A screenshot's bytes; `undefined` when it is gone. */
  readScreenshot: (id: string, file: string) => Promise<Uint8Array | undefined>;
  /** Its app's output, stdout then stderr; '' when it has none. */
  appLog: (id: string) => Promise<string>;
  /** Its `refused.jsonl` as written; '' when nothing was refused. */
  refusedLog: (id: string) => Promise<string>;
};

const text = (path: string) => readFile(path, 'utf8').catch(() => '');

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const localPrototypes = (dir: string): LocalPrototypes => {
  const metaOf = (id: string) => join(dir, id, 'meta.json');

  return {
    dir,
    all: () => readMetas(dir, PrototypeMeta),
    write: async (meta) => {
      await mkdir(join(dir, meta.id), { recursive: true });
      await replaceFile(metaOf(meta.id), json(meta));
    },
    screenshotPath: (id, file) => join(dir, id, 'screenshots', file),
    writeScreenshot: async (id, file, png) => {
      const path = join(dir, id, 'screenshots', file);

      await mkdir(join(dir, id, 'screenshots'), { recursive: true });
      await replaceFile(path, png);

      return path;
    },
    readScreenshot: async (id, file) => {
      try {
        return new Uint8Array(await readFile(join(dir, id, 'screenshots', file)));
      } catch {
        return undefined;
      }
    },
    appLog: async (id) => {
      const [out, err] = await Promise.all([
        text(join(dir, id, 'start.out')),
        text(join(dir, id, 'start.err')),
      ]);

      return [out, err].filter((t) => t.trim() !== '').join('\n');
    },
    refusedLog: (id) => text(join(dir, id, 'refused.jsonl')),
    refused: async (id, at, r) => {
      await mkdir(join(dir, id), { recursive: true });
      await appendFile(join(dir, id, 'refused.jsonl'), `${JSON.stringify({ at, ...r })}\n`);
    },
  };
};
