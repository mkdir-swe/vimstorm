/**
 * A PR's reviewed files: each mark follows the change's content (how it changed and the lines it
 * adds and removes, not where they sit), so the base moving on keeps a mark and a line changed
 * anew drops it. Kept as `marks/<pr>` in the main checkout's `.scratch/abe`, 1.x's shape.
 */
import { z } from 'zod';
import { type ChangedFile } from './changes';
import { hash } from './hash';
import { changedLines } from './hunks';

/** A reviewed file's change as it was marked, with the head it was marked at. */
export const FileMark = z.looseObject({ hash: z.string(), head: z.string() });
export type FileMark = z.infer<typeof FileMark>;

/**
 * A PR's reviewed files, kept between runs: when written (ms, the version a read brings), the
 * head at the last mark, the PR's files then, and each reviewed file's mark. Fields another
 * writer added are kept.
 */
export const Marks = z.looseObject({
  at: z.number().optional(),
  head: z.string(),
  paths: z.array(z.string()).default([]),
  marks: z.record(z.string(), FileMark).default({}),
});
export type Marks = z.infer<typeof Marks>;

/** A file's change in one hash. */
export const changeHash = (file: ChangedFile): string => {
  const lines = file.binary
    ? [`binary ${file.additions} ${file.deletions}`]
    : changedLines(file.patch).map((l) => `${l.sign}${l.text}`);

  return hash([file.status, file.previous ?? '', ...lines].join('\n'));
};

const markOf = (marks: Marks, path: string): FileMark | undefined =>
  Object.hasOwn(marks.marks, path) ? marks.marks[path] : undefined;

/** `paths` marked reviewed (or not) at `head`, as their changes are now; other marks kept. */
export const marked = (
  marks: Marks | null,
  files: readonly ChangedFile[],
  paths: readonly string[],
  on: boolean,
  head: string,
): Marks => {
  const kept: Record<string, FileMark> = {};

  for (const [path, mark] of Object.entries(marks?.marks ?? {}))
    if (!paths.includes(path)) kept[path] = mark;
  if (on)
    for (const file of files)
      if (paths.includes(file.path)) kept[file.path] = { hash: changeHash(file), head };

  return { ...marks, at: undefined, head, paths: files.map((f) => f.path), marks: kept };
};

/** The files reviewed as they are now: marked, and changed no further since. */
export const reviewedPaths = (marks: Marks | null, files: readonly ChangedFile[]): Set<string> =>
  new Set(
    marks === null
      ? []
      : files.filter((f) => markOf(marks, f.path)?.hash === changeHash(f)).map((f) => f.path),
  );

/** What changed since your review: from which head, and the files that did. */
export type SinceReview = { from: string; paths: string[] };

/**
 * The files that changed since you reviewed them: a marked file whose change is no longer what
 * was marked, and, when the head moved on since the last mark, a file the PR did not have then.
 * `from` is the head those marks were made at. Null when nothing changed.
 */
export const sinceReview = (
  marks: Marks | null,
  files: readonly ChangedFile[],
  head: string,
): SinceReview | null => {
  if (marks === null) return null;
  const moved = marks.head !== head;
  let from: string | undefined = moved ? marks.head : undefined;
  const paths: string[] = [];

  for (const file of files) {
    const mark = markOf(marks, file.path);

    if (mark !== undefined) {
      if (mark.hash !== changeHash(file)) {
        paths.push(file.path);
        from ??= mark.head;
      }
    } else if (moved && !marks.paths.includes(file.path)) paths.push(file.path);
  }

  return from === undefined || paths.length === 0 ? null : { from, paths };
};
