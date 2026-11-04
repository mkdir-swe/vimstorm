/**
 * Download locally and Move to cloud's copy (#88): a session's worktree read and written where it
 * is, through `exec` (nothing locally; `abe box attach <box> --` for a Workspace on its box, which
 * runs the rest on the box, waking it first, and `docker exec` into its workspace container, stdio
 * passed through: `inWorkspace`).
 * Everything crosses as one tar on stdio: the branch's commits as a git bundle to its head, the
 * staged and the unstaged diff (`git diff --binary`), the listed files (the untracked ones and
 * `.scratch/`'s that core's rules let go) and the transcript. IO only: what is copied is core's
 * `movePlan`. The other side's pack is data, not trusted: of its files only the plan's land, by
 * name; its head is checked for the shape of a commit; nothing of it reaches `.git`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Answered, type Mover, worktreePath } from '@abe/core';
import { type Env } from '../mac/locations';
import { failed, gitEnv, runProcess, said } from '../mac/process';

/** A copy may be big (a whole branch's history): minutes, not the default 30 s. */
const COPY_MS = 10 * 60_000;
/** A box waking first (an EC2 start, then SSH). */
const REACH_MS = 3 * 60_000;

/**
 * `git diff` as git itself prints it, whatever the person's config: `a/` `b/` prefixes (a patch
 * `git apply` reads), no colour, no external diff tool.
 */
const DIFF =
  'git -c diff.noprefix=false -c diff.mnemonicPrefix=false -c color.ui=never diff --no-ext-diff --no-color --binary';

/**
 * `<head> <staged 0|1> <unstaged 0|1> <real path>`, then the untracked and `.scratch/` files,
 * NUL-separated.
 */
const LIST = `cd -- "$1" 2>/dev/null || exit 3
head=$(git rev-parse --verify HEAD) || exit 4
staged=0; unstaged=0
git diff --cached --quiet || staged=1
git diff --quiet || unstaged=1
printf '%s %s %s %s\\n' "$head" "$staged" "$unstaged" "$(pwd -P)"
git ls-files --others --exclude-standard -z || exit 4
if [ -d .scratch ]; then find .scratch \\( -type f -o -type l \\) -print0; fi`;

/**
 * The pack on stdout: args root, transcript ('' for none); the files to copy on stdin,
 * NUL-separated. `COPYFILE_DISABLE`: macOS's tar would add a `._<name>` AppleDouble entry for a
 * file with extended attributes, which the box's GNU tar extracts as a file of that name.
 */
export const PACK = `set -eu
cd -- "$1" 2>/dev/null || exit 3
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
cat > "$t/files.list"
git rev-parse --verify HEAD > "$t/head" || exit 4
git bundle create "$t/commits.bundle" HEAD 2>"$t/err" || { cat "$t/err" >&2; exit 4; }
${DIFF} --cached > "$t/staged.patch"
${DIFF} > "$t/unstaged.patch"
COPYFILE_DISABLE=1 tar -cf "$t/files.tar" --null -T "$t/files.list"
if [ -n "$2" ] && [ -f "$2" ]; then cp -- "$2" "$t/transcript.jsonl"; fi
rm -f "$t/err" "$t/files.list"
COPYFILE_DISABLE=1 tar -cf - -C "$t" .`;

/** The pack from stdin kept in a folder of its own on the unpacking side; the folder on stdout. */
const STAGE = `set -eu
t=$(mktemp -d) || exit 4
cat > "$t/pack.tar" || { rm -rf "$t"; exit 4; }
printf '%s' "$t"`;

/**
 * The staged pack into the worktree at root: args root, branch, the log's path ('' for none),
 * the stash message, the staging folder; the plan's files on stdin, NUL-separated. The checks
 * first (the head's shape, a branch here with its own commits), then changes already there are
 * stashed (kept, never lost), the branch at the moved head, the diffs, the plan's files by name
 * from the pack's files (unpacked into the staging folder first: tar's own refusals of `..` and
 * absolute names hold there, and only a listed name goes on), the transcript's log.
 */
export const UNPACK = `set -eu
t=$5
trap 'rm -rf "$t"' EXIT
cd -- "$1" 2>/dev/null || exit 3
cat > "$t/files.list"
mkdir "$t/in" "$t/files"
tar -xf "$t/pack.tar" -C "$t/in"
head=$(cat "$t/in/head")
case "$head" in *[!0-9a-f]*|'') exit 7;; esac
git fetch -q "$t/in/commits.bundle" HEAD || exit 4
git rev-parse --verify -q "$head^{commit}" >/dev/null || exit 7
if git show-ref --verify -q "refs/heads/$2" && ! git merge-base --is-ancestor "refs/heads/$2" "$head"; then
  echo "$2 here has commits the moved head $head has not" >&2
  exit 6
fi
if [ -n "$(git status --porcelain)" ]; then git stash push -q --include-untracked -m "$4" || exit 4; fi
git checkout -q -f -B "$2" "$head" || exit 4
if [ -s "$t/in/staged.patch" ]; then git apply --index --binary "$t/in/staged.patch" || exit 5; fi
if [ -s "$t/in/unstaged.patch" ]; then git apply --binary "$t/in/unstaged.patch" || exit 5; fi
if [ -s "$t/files.list" ]; then
  tar -xf "$t/in/files.tar" -C "$t/files"
  tar -cf "$t/planned.tar" -C "$t/files" --null -T "$t/files.list"
  tar -xf "$t/planned.tar" -C .
fi
if [ -n "$3" ] && [ -f "$t/in/transcript.jsonl" ]; then
  mkdir -p "$(dirname -- "$3")"
  cp -- "$t/in/transcript.jsonl" "$3"
fi`;

/**
 * A folder into the worktree at root (a cloud run's prototype reference, #351): args root, the
 * folder's path in it (relative, never out of it), the folder's tar on stdin; what was there first
 * is replaced, so a launch tried again lands the same.
 */
export const PUT = `set -eu
cd -- "$1" 2>/dev/null || exit 3
case "$2" in ''|/*|..|../*|*/..|*/../*) exit 8;; esac
rm -rf -- "$2"
mkdir -p -- "$2"
tar -xf - -C "$2"`;

/** The worktree at `$1` against commit `$2`, untracked files too (only marked to add, never staged). */
export const WORK_DIFF = `set -eu
cd -- "$1" 2>/dev/null || exit 3
git add -A -N . >/dev/null 2>&1 || exit 4
git diff --binary "$2" || exit 4`;

/** The folder `$2` of the worktree at `$1` as a tar on stdout; an empty one when it is not there. */
export const GET = `set -eu
cd -- "$1" 2>/dev/null || exit 3
case "$2" in ''|/*|..|../*|*/..|*/../*) exit 8;; esac
if [ -d "$2" ]; then tar -cf - -C "$2" .; else tar -cf - -T /dev/null; fi`;

const sh = (exec: readonly string[], script: string, args: readonly string[]) => [
  ...exec,
  'sh',
  '-c',
  script,
  'sh',
  ...args,
];

const WHY: Readonly<Record<number, { code: string; why: string }>> = {
  3: { code: 'move-failed', why: 'no such folder' },
  4: { code: 'move-failed', why: 'git failed' },
  5: { code: 'move-failed', why: 'a diff did not apply' },
  6: { code: 'branch-diverged', why: 'the branch here has commits the moved head has not' },
  7: { code: 'move-failed', why: 'the pack names no commit as its head' },
  8: { code: 'move-failed', why: 'the folder is not inside the worktree' },
};

/** Runs `argv` with stdin from `input` (a file, or text), stdout to `out` (a file) or kept. */
const runIo = async (
  argv: readonly string[],
  env: Record<string, string>,
  io: { input?: { file: string } | { text: string }; out?: string },
  timeoutMs: number,
) => {
  if (io.out !== undefined) mkdirSync(dirname(io.out), { recursive: true });
  const input = io.input;
  const stdin = (() => {
    if (input === undefined) return 'ignore' as const;

    return 'file' in input ? Bun.file(input.file) : new TextEncoder().encode(input.text);
  })();
  const child = Bun.spawn([...argv], {
    env,
    stdin,
    stdout: io.out === undefined ? 'pipe' : Bun.file(io.out),
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);
  const [stdout, stderr, exit] = await Promise.all([
    child.stdout instanceof ReadableStream ? new Response(child.stdout).text() : '',
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => {
    clearTimeout(timer);
  });

  return { exit, stdout, stderr };
};

/** The first line with words on it; '' for none. */
const firstLine = (text: string) =>
  text
    .split('\n')
    .find((l) => l.trim() !== '')
    ?.trim() ?? '';

const nulList = (files: readonly string[]) => files.map((f) => `${f}\0`).join('');

export const shellMover = (envOf: Env): Mover => {
  const env = gitEnv(envOf);
  const gitBin = Bun.which('git', { PATH: env.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  const git = (cwd: string, ...args: string[]) => runProcess([gitBin, '-C', cwd, ...args], env);
  const tarBin = Bun.which('tar', { PATH: env.PATH ?? '/usr/bin:/bin' }) ?? 'tar';
  // One line (#189): the first the other side said (a usage dump or git's error has more), else
  // what its exit means; an exit no script gives with its number.
  const refusal = (r: { exit: number; stdout: string; stderr: string }, what: string) => {
    const why = WHY[r.exit];
    const line = firstLine(r.stderr);

    if (why !== undefined) return failed(why.code, `${what}: ${line || why.why}`);
    const other = line || firstLine(r.stdout);

    return failed('move-failed', `${what}: exit ${r.exit}${other === '' ? '' : `: ${other}`}`);
  };
  const mainOf = async (repo: string): Promise<Answered<string>> => {
    const top = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');

    return top.exit === 0
      ? { ok: true, data: dirname(top.stdout.trim()) }
      : failed('not-a-repo', `${repo} is not a git checkout: ${said(top, 'git')}`);
  };

  return {
    reach: async (exec) => {
      if (exec.length === 0) return { ok: true, data: null };
      const ran = await runIo([...exec, 'true'], env, {}, REACH_MS);

      return ran.exit === 0
        ? { ok: true, data: null }
        : failed('box-unreachable', said(ran, exec[0] ?? 'attach'));
    },
    diff: async (exec, root, from) => {
      const ran = await runIo(sh(exec, WORK_DIFF, [root, from]), env, {}, COPY_MS);

      return ran.exit === 0 ? { ok: true, data: ran.stdout } : refusal(ran, `the diff of ${root}`);
    },
    list: async (exec, root) => {
      const ran = await runIo(sh(exec, LIST, [root]), env, {}, COPY_MS);

      if (ran.exit !== 0) return refusal(ran, `reading ${root}`);
      const nl = ran.stdout.indexOf('\n');
      const [head = '', staged, unstaged, ...cwd] = ran.stdout.slice(0, nl).split(' ');

      return {
        ok: true,
        data: {
          head,
          cwd: cwd.join(' ') || root,
          staged: staged === '1',
          unstaged: unstaged === '1',
          files: ran.stdout
            .slice(nl + 1)
            .split('\0')
            .filter((f) => f !== ''),
        },
      };
    },
    pack: async ({ exec, root, files, transcript, out }) => {
      const ran = await runIo(
        sh(exec, PACK, [root, transcript ?? '']),
        env,
        { input: { text: nulList(files) }, out },
        COPY_MS,
      );

      return ran.exit === 0 ? { ok: true, data: null } : refusal(ran, `packing ${root}`);
    },
    unpack: async ({ exec, root, pack, files, branch, log, stash }) => {
      const staged = await runIo(sh(exec, STAGE, []), env, { input: { file: pack } }, COPY_MS);

      if (staged.exit !== 0) return refusal(staged, `copying the pack to ${root}'s side`);
      const ran = await runIo(
        sh(exec, UNPACK, [root, branch, log ?? '', stash, staged.stdout]),
        env,
        { input: { text: nulList(files) } },
        COPY_MS,
      );

      if (ran.exit === 0) return { ok: true, data: null };
      // The script's own exits ran its trap; any other (ssh never started it, killed at COPY_MS)
      // left the staged pack there: taken away, as far as the side still answers.
      if (!(ran.exit in WHY))
        await runIo(sh(exec, 'rm -rf -- "$1"', [staged.stdout]), env, {}, REACH_MS);

      return refusal(ran, `unpacking into ${root}`);
    },
    put: async ({ exec, root, dir, from }) => {
      const held = mkdtempSync(join(tmpdir(), 'abe-put-'));
      const tar = join(held, 'folder.tar');

      try {
        const packed = await runIo(
          [tarBin, '-cf', tar, '-C', from, '.'],
          { ...env, COPYFILE_DISABLE: '1' },
          {},
          COPY_MS,
        );

        if (packed.exit !== 0) return refusal(packed, `packing ${from}`);
        const ran = await runIo(sh(exec, PUT, [root, dir]), env, { input: { file: tar } }, COPY_MS);

        return ran.exit === 0 ? { ok: true, data: null } : refusal(ran, `copying into ${root}`);
      } finally {
        rmSync(held, { recursive: true, force: true });
      }
    },
    get: async ({ exec, root, dir, to }) => {
      const held = mkdtempSync(join(tmpdir(), 'abe-get-'));
      const tar = join(held, 'folder.tar');

      try {
        const ran = await runIo(sh(exec, GET, [root, dir]), env, { out: tar }, COPY_MS);

        if (ran.exit !== 0) return refusal(ran, `copying ${dir} from ${root}`);
        mkdirSync(to, { recursive: true });
        const unpacked = await runIo([tarBin, '-xf', tar, '-C', to], env, {}, COPY_MS);

        return unpacked.exit === 0
          ? { ok: true, data: null }
          : refusal(unpacked, `unpacking ${dir}`);
      } finally {
        rmSync(held, { recursive: true, force: true });
      }
    },
    worktree: async (repo, branch): Promise<Answered<string>> => {
      const main = await mainOf(repo);

      if (!main.ok) return main;
      const path = worktreePath(main.data, branch);
      const held = await git(main.data, 'worktree', 'list', '--porcelain');

      if (held.stdout.split('\n').includes(`branch refs/heads/${branch}`))
        return failed(
          'worktree-taken',
          `${branch} is checked out already: remove that worktree first`,
        );
      if (existsSync(path)) return failed('worktree-taken', `${path} exists: remove it first`);
      const added = await git(main.data, 'worktree', 'add', '--detach', path, 'HEAD');

      return added.exit === 0
        ? { ok: true, data: path }
        : failed('worktree-failed', `git worktree add: ${said(added, 'git')}`);
    },
    dropWorktree: async (repo, path) => {
      const main = await mainOf(repo);

      if (!main.ok) return main;
      const removed = await git(main.data, 'worktree', 'remove', '--force', path);

      return removed.exit === 0
        ? { ok: true, data: null }
        : failed('worktree-failed', `git worktree remove: ${said(removed, 'git')}`);
    },
  };
};
