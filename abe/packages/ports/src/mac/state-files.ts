/**
 * The state directory's files as Sheets, prototypes, triage, Improve and Improve retro keep them
 * (not exported from the package): folders only the person reads, documents rewritten whole
 * through a rename, each `<id>/meta.json` of a folder read, and a one-shot's answer that did not
 * read kept as it came. IO only.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type z } from 'zod';

const ensure = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
};

/** A JSON file as read (unchecked); `undefined` when there is none or it is no JSON. */
export const readJsonFile = (file: string): unknown => {
  if (!existsSync(file)) return undefined;
  try {
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));

    return doc;
  } catch {
    return undefined;
  }
};

/** Writes `text` whole through a rename, its folder made first. */
export const writeWhole = (file: string, text: string): void => {
  ensure(dirname(file));
  writeFileSync(`${file}.new`, text, { mode: 0o600 });
  renameSync(`${file}.new`, file);
};

/** Writes `doc` as indented JSON, whole. */
export const writeJsonFile = (file: string, doc: unknown): void => {
  writeWhole(file, `${JSON.stringify(doc, null, 2)}\n`);
};

/** Keeps an unreadable answer's raw text in `dir` as `unreadable-<time>-<random>.txt` (`at`: epoch ms); its path. */
export const keepUnreadableIn = (dir: string, text: string, at: number): string => {
  ensure(dir);
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `unreadable-${stamp}-${randomBytes(2).toString('hex')}.txt`);

  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });

  return file;
};

/**
 * Writes `body` whole through a rename, async (its folder must exist): Sheets' and prototypes'
 * files, which `serve` writes while it answers other requests. The temporary file is per process.
 */
export const replaceFile = async (path: string, body: Uint8Array | string): Promise<void> => {
  const temp = `${path}.tmp-${process.pid}`;

  await writeFile(temp, body);
  await rename(temp, path);
};

/** Every `<dir>/<id>/meta.json` that reads as `schema` with its own folder's id; a broken one is left out. */
export const readMetas = async <T extends { id: string }>(
  dir: string,
  schema: z.ZodType<T>,
): Promise<T[]> => {
  let ids: string[];

  try {
    ids = await readdir(dir);
  } catch {
    return [];
  }
  const read = await Promise.all(
    ids.map(async (id) => {
      try {
        const meta = schema.safeParse(
          JSON.parse(await readFile(join(dir, id, 'meta.json'), 'utf8')),
        );

        return meta.success && meta.data.id === id ? [meta.data] : [];
      } catch {
        return [];
      }
    }),
  );

  return read.flat();
};
