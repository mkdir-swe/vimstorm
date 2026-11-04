/**
 * Improve's files (#84). In `serve`'s state directory, `<state>/improve/`: `proposals/<id>.json`
 * (each proposal, rewritten whole), `undo.json` (the applied states, oldest first),
 * `suggested.json` (when Improve last suggested) and `unreadable-<time>-<random>.txt` (an answer
 * that was no proposal, as it came). In your personal Layer's folder: its files read, written
 * (through a rename) and deleted, never through a link. IO only; which paths are allowed is core's.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { keepUnreadableIn, readJsonFile, writeJsonFile } from './state-files';

const dirOf = (stateDir: string) => join(stateDir, 'improve');

/** A new proposal id: `imp-` and six random hex digits. */
export const newProposalId = (): string => `imp-${randomBytes(3).toString('hex')}`;

const proposalFile = (stateDir: string, id: string) =>
  join(dirOf(stateDir), 'proposals', `${id}.json`);

/** A kept proposal as read (unchecked); `undefined` when there is none. `id` is checked by the caller. */
export const readProposal = (stateDir: string, id: string): unknown =>
  readJsonFile(proposalFile(stateDir, id));

export const writeProposal = (stateDir: string, id: string, doc: unknown): void => {
  writeJsonFile(proposalFile(stateDir, id), doc);
};

/** The undo stack as read (unchecked); `undefined` when there is none. */
export const readUndo = (stateDir: string): unknown =>
  readJsonFile(join(dirOf(stateDir), 'undo.json'));

export const writeUndo = (stateDir: string, doc: unknown): void => {
  writeJsonFile(join(dirOf(stateDir), 'undo.json'), doc);
};

/** When Improve last suggested, as read (unchecked). */
export const readSuggested = (stateDir: string): unknown =>
  readJsonFile(join(dirOf(stateDir), 'suggested.json'));

export const writeSuggested = (stateDir: string, doc: unknown): void => {
  writeJsonFile(join(dirOf(stateDir), 'suggested.json'), doc);
};

/** Keeps an unreadable answer's raw text (`at`: epoch ms); its path. */
export const keepUnreadableImprove = (stateDir: string, text: string, at: number): string =>
  keepUnreadableIn(dirOf(stateDir), text, at);

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Whether `path` (relative, checked by core) stays in the folder on disk: no part of it that
 * exists is a link, so a write never lands elsewhere. The folder itself may be one.
 */
export const staysInLayer = (dir: string, path: string): boolean => {
  const parts = path.split('/');

  return parts.every((_, i) => !isLink(join(dir, ...parts.slice(0, i + 1))));
};

/** A personal Layer file's text; null when there is none. */
export const readLayerFile = (dir: string, path: string): string | null => {
  try {
    return readFileSync(join(dir, path), 'utf8');
  } catch {
    return null;
  }
};

/**
 * Writes a personal Layer file whole through a rename, making its folders; null deletes it and
 * the folders it leaves empty (up to the Layer's folder).
 */
export const writeLayerFile = (dir: string, path: string, text: string | null): void => {
  const file = join(dir, path);

  if (text === null) {
    rmSync(file, { force: true });
    for (
      let parent = dirname(file);
      parent !== dir && parent.startsWith(dir);
      parent = dirname(parent)
    ) {
      try {
        if (readdirSync(parent).length > 0) break;
        rmdirSync(parent);
      } catch {
        break;
      }
    }

    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;

  writeFileSync(temp, text);
  renameSync(temp, file);
};

/** At most this many Neovim config files are shown to the agent. */
const NVIM_MAX = 40;

/** The personal Layer's files as they are (`names`, core's): the top files, each skill, and the Neovim folder's (no hidden ones, no links). */
export const listLayerFiles = (
  dir: string,
  names: { top: readonly string[]; skills: string; nvim: string },
): { files: string[]; nvim: string[] } => {
  const top = names.top.filter((f) => existsSync(join(dir, f)) && !isLink(join(dir, f)));
  const skills = (() => {
    try {
      return readdirSync(join(dir, names.skills))
        .filter((name) => !name.startsWith('.'))
        .map((name) => `${names.skills}/${name}/SKILL.md`)
        .filter((f) => existsSync(join(dir, f)) && staysInLayer(dir, f));
    } catch {
      return [];
    }
  })();
  const nvim: string[] = [];
  const walk = (rel: string) => {
    let names: string[];

    try {
      names = readdirSync(join(dir, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = `${rel}/${name}`;

      if (name.startsWith('.') || isLink(join(dir, path)) || nvim.length >= NVIM_MAX) continue;
      if (lstatSync(join(dir, path)).isDirectory()) walk(path);
      else nvim.push(path);
    }
  };

  if (!isLink(join(dir, names.nvim))) walk(names.nvim);

  return { files: [...top, ...skills], nvim };
};
