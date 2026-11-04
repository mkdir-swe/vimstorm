/**
 * Where `serve` keeps triage: `<state>/triage/last.json` (the last triage, rewritten whole, what
 * `apply` and `launch` act on) and `unreadable-<time>-<random>.txt` (a one-shot's answer that was no
 * verdicts, as it came).
 */
import { join } from 'node:path';
import { keepUnreadableIn, readJsonFile, writeJsonFile } from './state-files';

const triageDir = (stateDir: string) => join(stateDir, 'triage');

/** The last triage as read (unchecked), or `undefined` when there is none. */
export const readLastTriage = (stateDir: string): unknown =>
  readJsonFile(join(triageDir(stateDir), 'last.json'));

/** Writes the last triage whole, through a rename. */
export const writeLastTriage = (stateDir: string, doc: unknown): void => {
  writeJsonFile(join(triageDir(stateDir), 'last.json'), doc);
};

/** Keeps an unreadable answer's raw text as `unreadable-<time>-<random>.txt` (`at`: epoch ms); its path. */
export const keepUnreadable = (stateDir: string, text: string, at: number): string =>
  keepUnreadableIn(triageDir(stateDir), text, at);
