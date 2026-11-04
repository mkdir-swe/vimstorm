/**
 * A three-way merge of text by lines, as `git merge-file` does it: the changes each side made to
 * the base, both kept where they touch different lines; where both changed the same lines
 * differently, a conflict with git's markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`).
 */

/** A text's lines, each with its newline (the last one may have none). */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Where a side replaced base lines `[b0, b1)` with its lines `[s0, s1)`. */
type Hunk = { b0: number; b1: number; s0: number; s1: number };

/** The hunks that turn `base` into `side`, in order, from their longest common subsequence. */
const hunksOf = (base: readonly string[], side: readonly string[]): Hunk[] => {
  const n = base.length;
  const m = side.length;
  const w = m + 1;
  // lcs[i * w + j]: the longest common subsequence of base[i..] and side[j..]
  const lcs = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;

  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        base[i] === side[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;

  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) {
      if (open !== null) out.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    open ??= { b0: i, b1: i, s0: j, s1: j };
    if (j < m && (i === n || at(i, j + 1) >= at(i + 1, j))) open.s1 = ++j;
    else open.b1 = ++i;
  }
  if (open !== null) out.push(open);

  return out;
};

/** The labels of a conflict's three parts. */
export type MergeLabels = { ours: string; base: string; theirs: string };

/** Lines as one text that ends with a newline (a conflict marker goes on its own line). */
const block = (lines: readonly string[]): string => {
  const text = lines.join('');

  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
};

/**
 * `base` merged with both `ours` and `theirs`: the text, and how many conflicts it holds. An empty
 * base (none known) makes any difference between the two sides one conflict.
 */
export const merge3 = (
  base: string,
  ours: string,
  theirs: string,
  labels: MergeLabels,
): { text: string; conflicts: number } => {
  const b = linesOf(base);
  const sides = { ours: linesOf(ours), theirs: linesOf(theirs) };
  const hunks = [
    ...hunksOf(b, sides.ours).map((h) => ({ ...h, side: 'ours' as const })),
    ...hunksOf(b, sides.theirs).map((h) => ({ ...h, side: 'theirs' as const })),
  ].sort((x, y) => x.b0 - y.b0 || x.b1 - y.b1);
  const out: string[] = [];
  let conflicts = 0;
  let done = 0;
  let k = 0;

  while (k < hunks.length) {
    const first = hunks[k];

    if (first === undefined) break;
    const group = [first];
    let r1 = first.b1;

    // hunks that overlap or touch the region are one region
    for (k++; k < hunks.length; k++) {
      const next = hunks[k];

      if (next === undefined || next.b0 > r1) break;
      group.push(next);
      r1 = Math.max(r1, next.b1);
    }
    const r0 = first.b0;
    const textOf = (side: 'ours' | 'theirs'): string[] | null => {
      const own = group.filter((h) => h.side === side);
      const f = own[0];
      const l = own.at(-1);

      if (f === undefined || l === undefined) return null;

      return sides[side].slice(f.s0 - (f.b0 - r0), l.s1 + (r1 - l.b1));
    };
    const o = textOf('ours');
    const t = textOf('theirs');

    out.push(...b.slice(done, r0));
    if (o === null) out.push(...(t ?? []));
    else if (t === null || o.join('') === t.join('')) out.push(...o);
    else {
      conflicts++;
      out.push(
        `<<<<<<< ${labels.ours}\n${block(o)}||||||| ${labels.base}\n${block(b.slice(r0, r1))}=======\n${block(t)}>>>>>>> ${labels.theirs}\n`,
      );
    }
    done = r1;
  }
  out.push(...b.slice(done));

  return { text: out.join(''), conflicts };
};
