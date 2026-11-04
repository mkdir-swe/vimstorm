/**
 * A unified diff patch's hunks: each line numbered on its sides, the lines a patch adds and
 * removes, and the head line a change opens at.
 */

/** A line's side of a PR's diff, as GitHub names it: LEFT the base, RIGHT the head. */
export type Side = 'LEFT' | 'RIGHT';

export type RowKind = 'context' | 'removed' | 'added';

/** A line of a hunk with its number on each side it is on. */
export type DiffRow = { kind: RowKind; left?: number | undefined; right?: number | undefined };

/** A hunk: where it starts on each side, what follows its `@@`, and its lines. */
export type Hunk = { left: number; right: number; heading: string; rows: DiffRow[] };

/** A line a patch adds (`+`) or removes (`-`). */
export type ChangedLine = { sign: '+' | '-'; text: string };

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/** The hunks of a unified diff patch, each line numbered on its sides. */
export const parsePatch = (patch: string): Hunk[] => {
  const hunks: Hunk[] = [];
  let left = 0;
  let right = 0;

  for (const text of patch.split('\n')) {
    const header = HEADER.exec(text);

    if (header !== null) {
      left = Number(header[1]);
      right = Number(header[2]);
      hunks.push({ left, right, heading: header[3] ?? '', rows: [] });
      continue;
    }
    const hunk = hunks.at(-1);

    if (hunk === undefined || text === '' || text.startsWith('\\')) continue;
    if (text.startsWith('+')) {
      hunk.rows.push({ kind: 'added', right });
      right += 1;
    } else if (text.startsWith('-')) {
      hunk.rows.push({ kind: 'removed', left });
      left += 1;
    } else {
      hunk.rows.push({ kind: 'context', left, right });
      left += 1;
      right += 1;
    }
  }

  return hunks;
};

/** The lines a patch adds and removes, in order. */
export const changedLines = (patch: string): ChangedLine[] =>
  patch.split('\n').flatMap((line): ChangedLine[] => {
    if (line.startsWith('+')) return [{ sign: '+', text: line.slice(1) }];
    if (line.startsWith('-')) return [{ sign: '-', text: line.slice(1) }];

    return [];
  });

/** The head line to show a hunk at: its first change, or where a removal was. */
export const headLine = (hunk: Hunk): number => {
  let next = hunk.right;

  for (const row of hunk.rows) {
    if (row.kind !== 'context') return Math.max(1, row.right ?? next);
    if (row.right !== undefined) next = row.right + 1;
  }

  return Math.max(1, hunk.right);
};

/** Each hunk's head line, in order: what ⏎ steps through. */
export const headLines = (patch: string): number[] => parsePatch(patch).map(headLine);
