/**
 * A PR's changes as git reads them in its checkout: each file against the merge base with its
 * patch, and the commits of a range with theirs. The ports' readings; the rules' input.
 */

/** How a file changed against the base (git's letter). */
export type FileStatus = 'A' | 'M' | 'D' | 'R';

/** A file changed against the merge base. */
export type ChangedFile = {
  path: string;
  /** Its path in the base when renamed. */
  previous?: string | undefined;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** git's rename similarity in percent; none when not renamed. */
  similarity?: number | undefined;
  binary: boolean;
  /** Its hunks from the first `@@`; empty for a binary file. */
  patch: string;
};

/** What the changes were read against: the merge base and the head read. */
export type Changes = { base: string; head: string; files: ChangedFile[] };

/** A file one commit changed: its path then, and before when it renamed it. */
export type CommitFile = {
  path: string;
  previous?: string | undefined;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
};

/** One commit of a range with the files it changed. */
export type RangeCommit = {
  sha: string;
  subject: string;
  author: string;
  /** ISO date authored. */
  date: string;
  files: CommitFile[];
};

/** Byte order, as Rust's `str::cmp` sorts. */
export const byBytes = (a: string, b: string): number => {
  if (a < b) return -1;

  return a > b ? 1 : 0;
};

export const baseName = (path: string): string => path.split('/').at(-1) ?? path;
