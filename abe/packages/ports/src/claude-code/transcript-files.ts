/**
 * `TranscriptFiles` (#113): a session's transcript files and its worktree's snapshots, read with
 * `sh` and `git` where the session runs. One set of scripts for both places: on this machine
 * through `localExec`, on a box inside the workspace container through `docker exec`
 * (`containerExec`). IO only: what the lines and the diff mean is core's.
 */
import { type Answered, type FileTail, type TranscriptFiles, type TreeDiff } from '@abe/core';
import { type Env } from '../mac/locations';
import { failed, runProcess } from '../mac/process';
import { type ContainerExec } from '../docker/workspace-runner';

/** A turn's patch text is cut beyond this many bytes (its files are still all named). */
export const PATCH_BYTES_MAX = 2_000_000;
/** A read of a transcript file goes this far at once; the reader reads on from where it got. */
export const TAIL_BYTES_MAX = 4_000_000;
const TIMEOUT_MS = 60_000;
/** `git add -A` hashes every changed file: a large worktree takes a while (as run-tree's diff). */
const GIT_TIMEOUT_MS = 5 * 60_000;
/** serve's own git in the agent's worktree: none of its hooks or fsmonitor run (as run-tree's). */
const SAFE_GIT = 'git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }';

/**
 * `$1`'s bytes from offset `$2` on (at most `$4`) as base64, after its size and a newline; only when it is no
 * link and, links in its folders resolved, inside `$3`; opened first and what was opened checked
 * (`/proc/self/fd`), so no link swapped in between is followed. Exit 2: not there; 3: a link;
 * 4: outside `$3`; 5: no regular file, or not readable.
 */
const TAIL = `[ -e "$1" ] || [ -L "$1" ] || exit 2
[ -L "$1" ] && exit 3
w=$(realpath -- "$3") || exit 2
[ -f "$1" ] && [ -r "$1" ] || exit 5
exec 3< "$1" || exit 5
if [ -e /proc/self/fd/3 ]; then p=$(readlink /proc/self/fd/3) || exit 4
else p=$(realpath -- "$1") || exit 4; fi
case "$p" in "$w"/*) ;; *) exit 4 ;; esac
wc -c < "$1" | tr -d ' '
tail -c +$(($2 + 1)) <&3 | head -c "$4" | base64 | tr -d '\\n'`;

/** The regular files directly in `$1`, NUL-ended; only when `$1` is no link and inside `$2`. */
const LIST = `[ -d "$1" ] || exit 2
[ -L "$1" ] && exit 3
w=$(realpath -- "$2") || exit 2
d=$(realpath -- "$1") || exit 4
case "$d" in "$w"/*) ;; *) exit 4 ;; esac
cd -- "$d" || exit 4
find . -mindepth 1 -maxdepth 1 -type f -print0`;

/**
 * The worktree `$1`'s files as a tree: its index copied to a temporary one, everything added to
 * that one (untracked too, ignored ones and writers' worktrees not), written as a tree. The
 * worktree's own index and files are never written.
 */
const SNAPSHOT = `cd "$1" || exit 3
${SAFE_GIT}
top=$(git rev-parse --show-toplevel) || exit 3
cd "$top" || exit 3
dir=$(mktemp -d) || exit 4
trap 'rm -rf "$dir"' EXIT
index=$(git rev-parse --path-format=absolute --git-path index) || exit 3
if [ -f "$index" ]; then cp "$index" "$dir/index" || exit 4; fi
export GIT_INDEX_FILE="$dir/index"
git add -A -- . ':(exclude).claude/worktrees' || exit 5
git write-tree || exit 5`;

/**
 * What differs between trees `$2` and `$3` in `$1` (only the paths after them, when given): the
 * names NUL-ended as base64, a newline, the patch (3 lines of context, cut at `$4` bytes) as base64.
 */
const DIFF = `cd "$1" || exit 3
${SAFE_GIT}
from=$2; to=$3; max=$4; shift 4
dir=$(mktemp -d) || exit 4
trap 'rm -rf "$dir"' EXIT
git -c core.quotePath=false diff --no-renames --no-ext-diff --name-only -z "$from" "$to" -- "$@" > "$dir/names" || exit 6
git -c core.quotePath=false diff --no-color --no-ext-diff --no-textconv --no-renames --src-prefix=a/ --dst-prefix=b/ -U3 "$from" "$to" -- "$@" > "$dir/patch" || exit 6
base64 < "$dir/names" | tr -d '\\n'; echo
head -c "$max" < "$dir/patch" | base64 | tr -d '\\n'`;

/**
 * The paths after `$2` in the worktree `$1` put back as tree `$2` has them: through a temporary
 * index (git writes no file beyond a link); one the tree lacks removed, only inside the worktree,
 * and named NUL-ended.
 */
const RESTORE = `cd "$1" || exit 3
${SAFE_GIT}
w=$(pwd -P)
tree=$2; shift 2
dir=$(mktemp -d) || exit 4
trap 'rm -rf "$dir"' EXIT
export GIT_INDEX_FILE="$dir/index"
git read-tree "$tree" || exit 5
for p in "$@"; do
  if git cat-file -e "$tree:$p" 2>/dev/null; then
    git checkout-index -f -- "$p" || exit 6
  else
    [ -e "$p" ] || [ -L "$p" ] || continue
    r=$(cd -- "$(dirname -- "$p")" && pwd -P) || exit 7
    case "$r/" in "$w"/*) ;; *) exit 7 ;; esac
    rm -f -- "$p" || exit 6
    printf '%s\\0' "$p"
  fi
done`;

const said = (exit: number, stderr: string, what: string) =>
  stderr.trim() === '' ? `${what} exited ${exit}` : `${what}: ${stderr.trim().split('\n')[0]}`;

const fromBase64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

/** `TranscriptFiles` through `exec`: a box's workspace container, or this machine (`localExec`). */
export const transcriptFiles = (exec: ContainerExec): TranscriptFiles => ({
  tail: async (path, offset, within): Promise<Answered<FileTail | undefined>> => {
    const ran = await exec(
      ['sh', '-c', TAIL, 'sh', path, String(offset), within, String(TAIL_BYTES_MAX)],
      {
        timeoutMs: TIMEOUT_MS,
      },
    );

    if (ran.exit === 2) return { ok: true, data: undefined };
    if (ran.exit === 3) return failed('transcript-link', `${path} is a link`);
    if (ran.exit === 4) return failed('transcript-outside', `${path} is outside ${within}`);
    if (ran.exit !== 0)
      return failed('transcript-unreadable', said(ran.exit, ran.stderr, `reading ${path}`));
    const [size = '', body = ''] = ran.stdout.split('\n');

    return { ok: true, data: { size: Number(size), bytes: fromBase64(body) } };
  },
  list: async (dir, within) => {
    const ran = await exec(['sh', '-c', LIST, 'sh', dir, within], { timeoutMs: TIMEOUT_MS });

    if (ran.exit !== 0) return [];

    return ran.stdout
      .split('\0')
      .filter((n) => n !== '')
      .map((n) => n.replace(/^\.\//, ''))
      .sort();
  },
  snapshot: async (worktree) => {
    const ran = await exec(['sh', '-c', SNAPSHOT, 'sh', worktree], { timeoutMs: GIT_TIMEOUT_MS });
    const tree = ran.stdout.trim();

    return ran.exit === 0 && /^[0-9a-f]{40,64}$/.test(tree)
      ? { ok: true, data: tree }
      : failed('snapshot-failed', said(ran.exit, ran.stderr, `git snapshot of ${worktree}`));
  },
  diff: async (worktree, from, to, paths = []): Promise<Answered<TreeDiff>> => {
    const ran = await exec(
      ['sh', '-c', DIFF, 'sh', worktree, from, to, String(PATCH_BYTES_MAX), ...paths],
      { timeoutMs: GIT_TIMEOUT_MS },
    );

    if (ran.exit !== 0)
      return failed('diff-failed', said(ran.exit, ran.stderr, `git diff in ${worktree}`));
    const [names = '', patch = ''] = ran.stdout.split('\n');
    const decode = (b64: string) => new TextDecoder().decode(fromBase64(b64));

    return {
      ok: true,
      data: {
        names: decode(names)
          .split('\0')
          .filter((n) => n !== ''),
        patch: decode(patch),
      },
    };
  },
  restore: async (worktree, tree, paths) => {
    if (paths.length === 0) return { ok: true, data: { removed: [] } };
    const ran = await exec(['sh', '-c', RESTORE, 'sh', worktree, tree, ...paths], {
      timeoutMs: GIT_TIMEOUT_MS,
    });

    if (ran.exit === 7)
      return failed('outside-worktree', `a file to remove is outside ${worktree}`);

    return ran.exit === 0
      ? { ok: true, data: { removed: ran.stdout.split('\0').filter((p) => p !== '') } }
      : failed('revert-failed', said(ran.exit, ran.stderr, `restoring files in ${worktree}`));
  },
});

/** `exec` on this machine: `sh` and `git` with `serve`'s `PATH` and `HOME` only. */
export const localExec =
  (env: Env): ContainerExec =>
  (argv, o) =>
    runProcess(
      argv,
      { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '/', LC_ALL: 'C' },
      undefined,
      o?.timeoutMs,
    );
