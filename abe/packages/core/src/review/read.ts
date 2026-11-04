/**
 * A PR's changes as read for the review: the files against the merge base, the commits with each
 * file's path in the PR's diff, the pre-pass, the areas, and what changed since your review
 * (worked out once, from the marks read with the files). What `abe review show` answers: the
 * patches stay in serve; each file carries its change's hash and its hunks' head lines.
 */
import { type ChangedFile, type RangeCommit } from './changes';
import { headLines } from './hunks';
import { type ReadCommit, type ReviewRead } from './contract';
import { changeHash, type Marks, sinceReview } from './marks';
import { prepass } from './prepass';

export type ReadInput = {
  head: string;
  base: string | null;
  worktree: string | null;
  files: readonly ChangedFile[];
  /** Oldest first, as git gives them from the merge base. */
  commits: readonly RangeCommit[];
  /** The commits since your review: from the head your marks were made at. */
  fresh: readonly string[];
  /** The marks as read with the files. */
  marks: Marks | null;
  /** The checkout's folders that hold a `package.json`. */
  packages: readonly string[];
};

/**
 * The commits, oldest first, each file given its path in the PR's diff: renames are followed
 * back from the newest commit, so a file a later commit moved keeps its PR path in the commits
 * before.
 */
const prCommits = (oldestFirst: readonly RangeCommit[], files: readonly ChangedFile[]) => {
  const finalOf = new Map(files.map((f) => [f.path, f.path]));
  const traced: ReadCommit[] = [...oldestFirst].reverse().map((commit) => ({
    sha: commit.sha,
    subject: commit.subject,
    author: commit.author,
    date: commit.date,
    files: commit.files.map((file) => {
      const finalPath = finalOf.get(file.path) ?? null;

      if (file.previous !== undefined && finalPath !== null) {
        finalOf.delete(file.path);
        finalOf.set(file.previous, finalPath);
      }

      return {
        path: file.path,
        ...(file.previous === undefined ? {} : { previous: file.previous }),
        finalPath,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
        heads: headLines(file.patch),
      };
    }),
  }));

  return traced.reverse();
};

const CONTAINERS = ['services', 'apps', 'packages', 'libs', 'modules', 'projects'];

/**
 * The area a path is in: the deepest folder over it holding a package, else the folder after a
 * `services`/`apps`/`packages`… folder in the top three, else its top folder; '' at the root.
 */
export const areaOf = (path: string, packages: ReadonlySet<string>): string => {
  const dirs = path.split('/').slice(0, -1);

  for (let depth = dirs.length; depth >= 1; depth -= 1) {
    const dir = dirs.slice(0, depth).join('/');

    if (packages.has(dir)) return dir;
  }
  const container = dirs.slice(0, 3).findIndex((d) => CONTAINERS.includes(d));

  if (container >= 0 && dirs.length > container + 1) return dirs.slice(0, container + 2).join('/');

  return dirs[0] ?? '';
};

/** A PR's changes read: the pre-pass run, areas found, since your review worked out. */
export const readChanges = (input: ReadInput): ReviewRead => {
  const packages = new Set(input.packages);
  const pre = prepass(input.files);

  return {
    head: input.head,
    base: input.base,
    worktree: input.worktree,
    files: input.files.map((f) => ({
      path: f.path,
      ...(f.previous === undefined ? {} : { previous: f.previous }),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
      hash: changeHash(f),
      heads: headLines(f.patch),
    })),
    commits: prCommits(input.commits, input.files),
    fresh: [...input.fresh],
    mechanical: pre.mechanical,
    copies: pre.copies,
    areas: Object.fromEntries(input.files.map((f) => [f.path, areaOf(f.path, packages)])),
    since: sinceReview(input.marks, input.files, input.head),
  };
};
