/**
 * Where `serve` keeps each session: `<state>/sessions/<id>/` holding `meta.json` (what `serve`
 * knows of it, rewritten whole on every change), `hooks.jsonl` (every hook event as it came,
 * one line each, for the logs) and, for a Factory run, `run.json` (the run, rewritten whole) and
 * `reports/` (each `stage-done --report`). A restarted `serve` reads them back. Review and
 * verification reports go to the card's `.scratch` in the run's worktree instead.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type Run, type SessionMeta, SESSION_SOCKET } from '@abe/core';

export const sessionsDir = (stateDir: string): string => join(stateDir, 'sessions');

export const sessionDir = (stateDir: string, id: string): string => join(sessionsDir(stateDir), id);

/** The session's own socket: commands on it act on that session. */
export const sessionSocket = (stateDir: string, id: string): string =>
  join(sessionDir(stateDir, id), SESSION_SOCKET);

const ensure = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
};

/** Whether a session folder by that id is there already. */
export const sessionKnown = (stateDir: string, id: string): boolean =>
  existsSync(sessionDir(stateDir, id));

/** Every session's `name` file as read (unchecked); a folder without one is skipped. */
const readEach = (stateDir: string, name: string): unknown[] => {
  const root = sessionsDir(stateDir);

  if (!existsSync(root)) return [];

  return readdirSync(root).flatMap((id) => {
    try {
      const doc: unknown = JSON.parse(readFileSync(join(root, id, name), 'utf8'));

      return [doc];
    } catch {
      return [];
    }
  });
};

/** Writes the session's `name` file whole, through a rename, so a reader never sees half of one. */
const writeWhole = (stateDir: string, id: string, name: string, doc: unknown) => {
  const dir = sessionDir(stateDir, id);

  ensure(dir);
  const file = join(dir, name);

  writeFileSync(`${file}.new`, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.new`, file);
};

/** Every session's `meta.json` as read (unchecked); a folder without one is skipped. */
export const readSessionMetas = (stateDir: string): unknown[] => readEach(stateDir, 'meta.json');

export const writeSessionMeta = (stateDir: string, meta: SessionMeta): void => {
  writeWhole(stateDir, meta.id, 'meta.json', meta);
};

/** Every Factory run's `run.json` as read (unchecked). */
export const readRuns = (stateDir: string): unknown[] => readEach(stateDir, 'run.json');

export const writeRun = (stateDir: string, run: Run): void => {
  writeWhole(stateDir, run.session, 'run.json', run);
};

/** Keeps a `stage-done --report` in the session's `reports/` as `<n>-<stage>.md`; its path. */
export const keepReport = (stateDir: string, id: string, stage: string, text: string): string => {
  const dir = join(sessionDir(stateDir, id), 'reports');

  ensure(dir);
  const file = join(dir, `${readdirSync(dir).length + 1}-${stage}.md`);

  writeFileSync(file, text, { mode: 0o600 });

  return file;
};

/** One hook event appended to the session's `hooks.jsonl`. */
export const appendHookEvent = (stateDir: string, id: string, line: unknown): void => {
  const dir = sessionDir(stateDir, id);

  ensure(dir);
  appendFileSync(join(dir, 'hooks.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
};
