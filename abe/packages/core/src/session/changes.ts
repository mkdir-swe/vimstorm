/**
 * A turn's changes as Chat draws them (#113 Behaviour 3, as its M1 comment changed it): serve
 * snapshots the worktree's files with git at the turn's start and again later, and this reads
 * `git diff --no-renames -U3 <start> <now>` into the transcript's `FilePatch` shape, so a file a
 * Bash `sed` or a merged subagent wrote shows as an Edit's would. Pure: the git is serve's.
 */
import {
  CHANGES_FILES_MAX,
  type FilePatch,
  filePatch,
  type PatchHunk,
  type TranscriptEntry,
} from './transcript';

/** A turn's `changes` entry: its files under `root`, the turn's user entry's id as its own. */
export type ChangesEntry = Extract<TranscriptEntry, { kind: 'changes' }>;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** C-style quoting git uses for an unusual path (`"a/sp\303\244c"`), undone. */
const unquoted = (text: string): string => {
  if (!text.startsWith('"') || !text.endsWith('"')) return text;
  const body = Array.from(text.slice(1, -1));
  const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', a: '\x07', b: '\b' };
  // Each byte as `%XX` (an octal escape is one byte of UTF-8), read back as UTF-8 at the end.
  let encoded = '';

  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    const octal = c === '\\' ? /^[0-7]{3}/.exec(body.slice(i + 1, i + 4).join('')) : null;

    if (octal !== null) {
      encoded += `%${parseInt(octal[0], 8).toString(16).padStart(2, '0')}`;
      i += 3;
    } else if (c === '\\') {
      const next = body[i + 1] ?? '';

      encoded += encodeURIComponent(ESCAPES[next] ?? next);
      i += 1;
    } else encoded += encodeURIComponent(c);
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return body.join('');
  }
};

/**
 * The path of a `diff --git a/<p> b/<p>` line. Without renames both sides are the same path, so
 * it is the first half of what follows `a/` (a path holding ` b/` still splits right).
 */
const pathOfHeader = (rest: string): string => {
  if (rest.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0] ?? rest;

    return unquoted(end).replace(/^a\//, '');
  }
  const half = (rest.length - 5) / 2;

  return Number.isInteger(half) && half > 0 ? rest.slice(2, 2 + half) : rest.replace(/^a\//, '');
};

type Open = { path: string; created: boolean; hunks: PatchHunk[] };

/**
 * `git diff` output as one patch per file, in git's order (by path), paths joined to `root`;
 * past `CHANGES_FILES_MAX` files the rest only counted. A binary file is a patch without hunks.
 */
export const patchesOfDiff = (diff: string, root: string): { files: FilePatch[]; cut: number } => {
  const opened: Open[] = [];
  let file: Open | undefined;
  let hunk: PatchHunk | undefined;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { path: pathOfHeader(line.slice('diff --git '.length)), created: false, hunks: [] };
      hunk = undefined;
      opened.push(file);
      continue;
    }
    if (file === undefined) continue;
    const at = HUNK.exec(line);

    if (at !== null) {
      hunk = {
        oldStart: Number(at[1]),
        oldLines: at[2] === undefined ? 1 : Number(at[2]),
        newStart: Number(at[3]),
        newLines: at[4] === undefined ? 1 : Number(at[4]),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk === undefined) {
      if (line.startsWith('new file mode')) file.created = true;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) hunk.lines.push(line);
  }
  const base = root.replace(/\/+$/, '');

  return {
    files: opened
      .slice(0, CHANGES_FILES_MAX)
      .map((f) => filePatch(`${base}/${f.path}`, f.created, f.hunks)),
    cut: Math.max(0, opened.length - CHANGES_FILES_MAX),
  };
};

/** Whether two turns' changes say the same: a `changes` entry is sent again only when not. */
export const sameChanges = (
  a: Pick<ChangesEntry, 'files' | 'cut'>,
  b: Pick<ChangesEntry, 'files' | 'cut'>,
): boolean => JSON.stringify([a.files, a.cut]) === JSON.stringify([b.files, b.cut]);
