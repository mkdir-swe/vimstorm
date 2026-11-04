/** A file the caller names on argv (`--body-file`), read relative to where the command was typed. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Outcome, refused } from '@abe/core';

/** The file's text, or the refusal saying why it could not be read. */
export const readBodyFile = async (cwd: string, file: string): Promise<Outcome<string>> => {
  const path = resolve(cwd, file);

  try {
    return { ok: true, data: await readFile(path, 'utf8') };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);

    return refused('unreadable-body-file', `cannot read the body file ${path}: ${why}`);
  }
};
