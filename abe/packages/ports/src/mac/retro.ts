/**
 * Where `serve` keeps Improve retro: `<state>/retro/<id>/retro.json` (each retro, what `make`
 * acts on, rewritten as findings are made), `<state>/retro/<id>/sources/<session>/<file>` (the
 * retro's own sources: pull request comments, the Overrides, so their moments stay resolvable),
 * `last.json` (the newest retro's id), `scopes.json` (each scope's last retro time), `ran.json`
 * and `reminded.json` (the chat's stamps, #87) and
 * `unreadable-<time>-<random>.txt` (an answer that was no findings, as it came). Also the Layers'
 * files as they are now, read from the checkout.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepUnreadableIn, readJsonFile, writeJsonFile, writeWhole } from './state-files';

const retroRoot = (stateDir: string) => join(stateDir, 'retro');

/** A retro's id: its time to the minute and a random suffix. */
export const newRetroId = (at: number): string =>
  `retro-${new Date(at).toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;

/** A retro as kept (unchecked), or `undefined`. `id` undefined: the newest. */
export const readRetroRecord = (stateDir: string, id?: string): unknown => {
  const last = readJsonFile(join(retroRoot(stateDir), 'last.json'));
  const named =
    id ??
    (typeof last === 'object' && last !== null && 'id' in last && typeof last.id === 'string'
      ? last.id
      : undefined);

  if (named === undefined || !/^[A-Za-z0-9-]+$/.test(named)) return undefined;

  return readJsonFile(join(retroRoot(stateDir), named, 'retro.json'));
};

/** Writes a retro whole; `last` makes it the newest. */
export const writeRetroRecord = (
  stateDir: string,
  doc: { id: string },
  o: { last: boolean },
): void => {
  writeJsonFile(join(retroRoot(stateDir), doc.id, 'retro.json'), doc);
  if (o.last)
    writeWhole(join(retroRoot(stateDir), 'last.json'), `${JSON.stringify({ id: doc.id })}\n`);
};

/** Keeps one of the retro's own sources, so a moment in it resolves later too. */
export const keepRetroSource = (
  stateDir: string,
  id: string,
  source: { session: string; name: string; text: string },
): void => {
  writeWhole(join(retroRoot(stateDir), id, 'sources', source.session, source.name), source.text);
};

/** Each scope's last retro time (`retroScopeKey` → RFC 3339). */
export const readRetroScopes = (stateDir: string): Record<string, string> => {
  const doc = readJsonFile(join(retroRoot(stateDir), 'scopes.json'));

  if (typeof doc !== 'object' || doc === null) return {};

  return Object.fromEntries(
    Object.entries(doc).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
};

export const writeRetroScope = (stateDir: string, key: string, at: string): void => {
  const scopes = { ...readRetroScopes(stateDir), [key]: at };

  writeJsonFile(join(retroRoot(stateDir), 'scopes.json'), scopes);
};

/** Keeps an unreadable answer's raw text; its path. */
export const keepUnreadableRetro = (stateDir: string, text: string, at: number): string =>
  keepUnreadableIn(retroRoot(stateDir), text, at);

/** A Layer file is read whole up to this; a bigger one is not a fix's to rewrite. */
const LAYER_FILE_MAX = 32_000;
/** At most this many files of one Layer go to the prompt. */
const LAYER_FILES_MAX = 60;

const isText = (bytes: Buffer) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);

    return !bytes.includes(0);
  } catch {
    return false;
  }
};

/**
 * A Layer's text files as they are now, by their path from `dir` (links not followed; folders
 * named in `skip` and dot-folders such as `.git` left out). A missing folder has none.
 */
export const readLayerFiles = (
  dir: string,
  skip: readonly string[] = [],
): { path: string; text: string }[] => {
  if (!existsSync(dir)) return [];
  const found: { path: string; text: string }[] = [];
  const walk = (rel: string) => {
    if (found.length >= LAYER_FILES_MAX) return;
    let entries;

    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;

      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !skip.includes(path)) walk(path);
      } else if (e.isFile() && found.length < LAYER_FILES_MAX) {
        try {
          const bytes = readFileSync(join(dir, path));

          if (bytes.byteLength <= LAYER_FILE_MAX && isText(bytes))
            found.push({ path, text: bytes.toString('utf8') });
        } catch {
          // Unreadable: not a fix's to rewrite.
        }
      }
    }
  };

  walk('');

  return found;
};
