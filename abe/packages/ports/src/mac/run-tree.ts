/**
 * A Factory run's worktree (`RunTree`, #67): on this machine's disk (a local run), or inside the
 * box's workspace container through `exec` (a run on a box: the clone lives on the workspace's
 * volume, which the box's own disk does not show). IO only: what a report, a check or a diff
 * means is core's.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type Answered,
  type BaseDiff,
  checksEnv,
  CONTAINER,
  DEFAULT_BRANCH_REFS,
  type LogSources,
  type LogsRead,
  type RunTree,
} from '@abe/core';
import { baseCommits, baseDiff, commitsOf, keptTail, runShell } from './checks';
import { readLogSources } from '../aws/log-store';
import { type Env } from './locations';
import { failed } from './process';
import { type ContainerExec } from '../docker/workspace-runner';
import { localExec, transcriptFiles } from '../claude-code/transcript-files';

const noReport = (file: string) => failed('no-report', `no report file at ${file}`);

/** The run's worktree on this machine: a check gets `serve`'s allowlisted environment (`checksEnv`). */
export const localRunTree = (env: Env): RunTree => ({
  exists: (worktree) => Promise.resolve(worktree !== '' && existsSync(worktree)),
  report: (worktree, path) => {
    const file = resolve(worktree, path);

    return Promise.resolve(
      statSync(file, { throwIfNoEntry: false })?.isFile() === true
        ? { ok: true, data: readFileSync(file, 'utf8') }
        : noReport(file),
    );
  },
  write: (_worktree, path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.new`, text);
    renameSync(`${path}.new`, path);

    return Promise.resolve({ ok: true, data: null });
  },
  count: (dir) =>
    Promise.resolve(
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).length
        : 0,
    ),
  folders: (dir) =>
    Promise.resolve(
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
        : [],
    ),
  logs: readLogSources,
  shell: async ({ env: own, ...o }) => {
    const given = { ...checksEnv(env), ...own };
    const ran = await runShell({ ...o, env: given });

    // the names it got, never a value: what the run keeps of its env
    return { ...ran, keys: Object.keys(given).sort() };
  },
  diff: (worktree) => baseDiff(env, worktree),
  commits: (worktree) => baseCommits(env, worktree),
  transcript: transcriptFiles(localExec(env)),
});

/**
 * A report the agent named: resolved in the worktree (`$1`), and only a regular file inside it
 * once every link is followed. `serve` reads it outside the session's sandbox, so a path out of
 * the worktree (`/proc/<pid>/environ`, a link to `~/.claude`) is never read. The file is opened
 * first and what was opened is checked (Linux's `/proc/self/fd`), so no link swapped in between
 * is followed. Exit 3: not one.
 */
const READ_REPORT = `cd "$1" || exit 3
w=$(realpath -- "$1") || exit 3
[ -f "$2" ] || exit 3
exec 3< "$2" || exit 3
if [ -e /proc/self/fd/3 ]; then p=$(readlink /proc/self/fd/3) || exit 3
else p=$(realpath -- "$2" 2>/dev/null) || exit 3; fi
case "$p" in "$w"/*) ;; *) exit 3 ;; esac
[ -f "$p" ] || exit 3
exec cat <&3`;

/**
 * Writes stdin to `$2` whole, its folder made, only when that folder is inside the worktree `$1`
 * once links are followed: through a new `$2.new` (never a link left there) and a rename, which
 * replaces a link at `$2` rather than writing through it, group-writable for the script user.
 * Exit 3: outside the worktree.
 */
const WRITE = `umask 002
w=$(realpath -- "$1") || exit 3
d=$(dirname -- "$2")
mkdir -p -- "$d" || exit 4
r=$(realpath -- "$d") || exit 3
case "$r/" in "$w"/*) ;; *) exit 3 ;; esac
rm -f -- "$2.new"
set -C
cat > "$2.new" || exit 4
mv -f -- "$2.new" "$2"`;

/**
 * A check's command `$3` in `$1` with `CI=true` and stdout and stderr together, its process group
 * sent TERM after `$2` seconds and KILL 5 s later (`timeout`: 124 when it did). The base image has
 * coreutils' `timeout`; without one (a test's stand-in) only `docker exec`'s own time bounds it.
 * Its files stay writable for the session's user, who shares the script user's group (umask 002).
 */
const SHELL = `umask 002
cd "$1" || exit 126
if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$2" env CI=true sh -c "exec 2>&1; $3"; fi
exec env CI=true sh -c "exec 2>&1; $3"`;

/**
 * The worktree `$1` against its merge base with the default branch (the first of `$2…` that
 * exists, as Before's worktree takes it), through a copy of its index, so its own is never touched:
 * the base's short name, the merge base, then the name-status and the patch, each base64 on a line.
 * Exit 3: no default branch; 4: no merge base; 5: `git add` failed; 6: `git diff` failed.
 */
const DIFF = `cd "$1" || exit 6
shift
# serve's own git in the agent's clone: none of its hooks or fsmonitor run.
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
base=
for ref in "$@"; do
  if found=$(git rev-parse --verify --quiet --symbolic-full-name "$ref") && [ -n "$found" ]; then
    base=\${found#refs/heads/}; base=\${base#refs/remotes/}; break
  fi
done
[ -n "$base" ] || exit 3
at=$(git merge-base HEAD "$base") || exit 4
dir=$(mktemp -d) || exit 6
trap 'rm -rf "$dir"' EXIT
index=$(git rev-parse --path-format=absolute --git-path index)
if [ -f "$index" ]; then cp "$index" "$dir/index"; fi
export GIT_INDEX_FILE="$dir/index"
[ -f "$dir/index" ] || git read-tree HEAD || exit 5
git add -A || exit 5
git diff --cached -M --name-status -z "$at" > "$dir/names" || exit 6
git -c core.quotePath=false diff --cached -M -U0 --no-color --no-ext-diff "$at" > "$dir/patch" || exit 6
printf '%s\\n%s\\n' "$base" "$at"
base64 < "$dir/names" | tr -d '\\n'; echo
base64 < "$dir/patch" | tr -d '\\n'; echo`;

/**
 * A log file `$1` as base64, read only when it is no link and, links in its folders resolved,
 * inside `$2`, as `readLogSources` reads one on this machine; opened first, and what was opened
 * checked (`/proc/self/fd`), so no link swapped in between is followed. Exit 2: not there;
 * 3: a link; 4: outside `$2`; 5: no regular file, or not readable.
 */
const READ_LOG = `[ -e "$1" ] || [ -L "$1" ] || exit 2
[ -L "$1" ] && exit 3
w=$(realpath -- "$2") || exit 2
# Readable first: a failed redirect of the special builtin exec leaves dash before \`||\`.
[ -f "$1" ] && [ -r "$1" ] || exit 5
exec 3< "$1" || exit 5
if [ -e /proc/self/fd/3 ]; then p=$(readlink /proc/self/fd/3) || exit 4
else p=$(realpath -- "$1") || exit 4; fi
case "$p" in "$w"/*) ;; *) exit 4 ;; esac
# Read whole first: a read failing part-way is a failure, never text cut short.
b=$(base64 <&3) || exit 5
printf '%s' "$b" | tr -d '\\n'`;

/**
 * Every regular file under the folder `$1` (no link followed), relative to it, each ended by a
 * NUL; only when `$1` is no link and inside `$2`. Exit 2: not there; 3: a link; 4: outside `$2`.
 */
const LOG_FILES = `[ -e "$1" ] || [ -L "$1" ] || exit 2
[ -L "$1" ] && exit 3
w=$(realpath -- "$2") || exit 2
d=$(realpath -- "$1") || exit 4
case "$d" in "$w"/*) ;; *) exit 4 ;; esac
cd -- "$d" || exit 4
find . -type f -print0`;

/**
 * The branch's commits in `$1` since its merge base with the default branch (the first of `$2…`
 * that exists, as `DIFF` takes it), oldest first, one `<short sha> <subject>` a line. Exit 3: no
 * default branch; 4: no merge base; 6: `git log` failed.
 */
const COMMITS = `cd "$1" || exit 6
shift
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
base=
for ref in "$@"; do
  if found=$(git rev-parse --verify --quiet --symbolic-full-name "$ref") && [ -n "$found" ]; then
    base=\${found#refs/heads/}; base=\${base#refs/remotes/}; break
  fi
done
[ -n "$base" ] || exit 3
at=$(git merge-base HEAD "$base") || exit 4
git log --reverse --no-color --format='%h %s' "$at..HEAD" || exit 6`;

/** List the folder's regular files only (a report's Evidence folder is no report). */
const COUNT = 'find "$1" -mindepth 1 -maxdepth 1 -type f 2>/dev/null | wc -l';

/** The folders directly in `$1`, one name a line (links not followed). */
const FOLDERS = 'find -P "$1" -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; 2>/dev/null';

const LOG_SKIPPED = (within: string): Readonly<Record<number, string>> => ({
  3: 'a link',
  4: `outside ${within}`,
  5: 'not a regular file',
});

/** A log source's text read in the container: `undefined` when it is not there. */
const readLogIn = async (
  exec: ContainerExec,
  path: string,
  within: string,
): Promise<{ text: string } | { skipped: string } | undefined> => {
  const read = await exec(['sh', '-c', READ_LOG, 'sh', path, within]);

  if (read.exit === 2) return undefined;
  if (read.exit !== 0)
    return {
      skipped: LOG_SKIPPED(within)[read.exit] ?? (read.stderr.trim() || `exit ${read.exit}`),
    };
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(read.stdout, 'base64')),
    };
  } catch {
    return { skipped: 'not UTF-8 text' };
  }
};

/** `readLogSources` inside the workspace container, through `exec`. */
const readLogsIn = async (exec: ContainerExec, sources: LogSources): Promise<LogsRead> => {
  const out: LogsRead = { files: [], skipped: [] };
  const take = async (name: string, path: string, within: string) => {
    const read = await readLogIn(exec, path, within);

    if (read === undefined) return;
    if ('text' in read) out.files.push({ name, text: read.text });
    else out.skipped.push({ name, why: read.skipped });
  };

  for (const f of sources.files) await take(f.name, f.path, f.within);
  for (const d of sources.dirs) {
    const listed = await exec(['sh', '-c', LOG_FILES, 'sh', d.path, d.within]);

    if (listed.exit === 2) continue;
    if (listed.exit !== 0) {
      out.skipped.push({
        name: d.name,
        why: LOG_SKIPPED(d.within)[listed.exit] ?? (listed.stderr.trim() || `exit ${listed.exit}`),
      });
      continue;
    }
    const rels = listed.stdout
      .split('\0')
      .filter((r) => r !== '')
      .map((r) => r.replace(/^\.\//, ''))
      .sort();

    for (const rel of rels) await take(`${d.name}/${rel}`, `${d.path}/${rel}`, d.within);
  }

  return out;
};

const DIFF_FAILED: Readonly<Record<number, string>> = {
  3: `no default branch (${DEFAULT_BRANCH_REFS.join(', ')})`,
  4: 'no merge base with the default branch',
  5: 'git add failed',
  6: 'git diff failed',
};

/**
 * A Verification pack script `$2` in worktree `$1` with the arguments after `$5`, its time in
 * seconds `$3` (`abe run`, #67): as `timeout` bounds a check, its files group-writable for the
 * session. `$5` 1: its environment's values first, exported from stdin (`exportLines`), never an
 * argv. Exit 127: no such script.
 */
const PACK = `umask 002
cd "$1" || exit 126
s=$2 t=$3 p=$4 e=$5
shift 5
if [ "$e" = 1 ]; then set -a; . /dev/stdin; set +a; fi
if [ -n "$p" ]; then PATH="$p:$PATH"; export PATH; fi
[ -f "$s" ] || { echo "no script $s in $(pwd)" >&2; exit 127; }
if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$t" "$s" "$@"; fi
exec "$s" "$@"`;

/**
 * Before a check in worktree `$1` (#67), as the session's user: the agent's writer worktrees in
 * Claude Code's `.claude/worktrees` whose commits the card's branch already holds are removed
 * (git refuses one with changes, which then stays); one still at work stays, its Claude Code
 * write folders (0700) made readable, so a check walking the tree as the script user (`eslint .`)
 * does not stop on them. Outside the sandbox, whose mounts keep the agent's own remove from
 * finishing. Never fails the check.
 */
const TIDY_WRITERS = `cd "$1" 2>/dev/null || exit 0
[ -d .claude/worktrees ] || exit 0
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
head=$(g rev-parse -q --verify HEAD) || exit 0
g worktree list --porcelain | sed -n 's/^worktree //p' | while IFS= read -r w; do
  case "$w" in "$(pwd -P)"/.claude/worktrees/*|"$1"/.claude/worktrees/*) ;; *) continue ;; esac
  h=$(g -C "$w" rev-parse -q --verify HEAD 2>/dev/null) || continue
  if g merge-base --is-ancestor "$h" "$head" 2>/dev/null; then g worktree remove "$w" >/dev/null 2>&1 || true; fi
done
find .claude/worktrees -type d -name .cc-writes ! -perm -o+rx -exec chmod go+rx {} + 2>/dev/null
exit 0`;

/** Leaves headroom over a check's own time for `docker exec` itself. */
const EXEC_SLACK_MS = 30_000;

/** `git add -A` hashes every changed file: a large worktree takes a while. */
const DIFF_TIMEOUT_MS = 5 * 60_000;

const COMMITS_FAILED: Readonly<Record<number, string>> = {
  ...DIFF_FAILED,
  6: 'git log failed',
};

const unbase = (line: string | undefined) => Buffer.from(line ?? '', 'base64').toString('utf8');

/**
 * The run's worktree inside the box's workspace container (#67). serve's own reads and writes run
 * as the container's own user; a check (code the agent wrote, run outside the sandbox) runs as
 * the script user (`CONTAINER.runUser`), which cannot read the session's login, with the
 * workspace's environment (its `DATABASE_URL`, its tools on `PATH`).
 */
export const containerRunTree = (exec: ContainerExec, o: { runUser?: string } = {}): RunTree => ({
  exists: async (worktree) => worktree !== '' && (await exec(['test', '-d', worktree])).exit === 0,
  report: async (worktree, path): Promise<Answered<string>> => {
    const read = await exec(['sh', '-c', READ_REPORT, 'sh', worktree, path]);

    return read.exit === 0
      ? { ok: true, data: read.stdout }
      : noReport(path.startsWith('/') ? path : `${worktree}/${path}`);
  },
  write: async (worktree, path, text) => {
    const wrote = await exec(['sh', '-c', WRITE, 'sh', worktree, path], { stdin: text });

    return wrote.exit === 0
      ? { ok: true, data: null }
      : failed('write-failed', `${path}: ${wrote.stderr.trim() || `exit ${wrote.exit}`}`);
  },
  count: async (dir) => {
    const listed = await exec(['sh', '-c', COUNT, 'sh', dir]);
    const n = Number(listed.stdout.trim());

    return listed.exit === 0 && Number.isInteger(n) ? n : 0;
  },
  folders: async (dir) => {
    const listed = await exec(['sh', '-c', FOLDERS, 'sh', dir]);

    return listed.exit === 0
      ? listed.stdout
          .split('\n')
          .filter((n) => n !== '')
          .sort()
      : [];
  },
  logs: (sources) => readLogsIn(exec, sources),
  shell: async (c) => {
    const seconds = Math.max(1, Math.ceil(c.timeoutMs / 1000));

    await exec(['sh', '-c', TIDY_WRITERS, 'sh', c.cwd]);
    const ran = await exec(['sh', '-c', SHELL, 'sh', c.cwd, String(seconds), c.run], {
      user: o.runUser ?? CONTAINER.runUser,
      timeoutMs: c.timeoutMs + EXEC_SLACK_MS,
    });
    const output = keptTail(`${ran.stdout}${ran.stderr}`);

    // 124: TERM at its time; 137: KILL, 5 s after a TERM it ignored.
    return ran.exit === 124 || ran.exit === 137
      ? { exit: null, output: `${output}\n[killed after ${seconds}s]\n`, timedOut: true }
      : { exit: ran.exit, output, timedOut: false };
  },
  diff: async (worktree): Promise<BaseDiff> => {
    const ran = await exec(['sh', '-c', DIFF, 'sh', worktree, ...DEFAULT_BRANCH_REFS], {
      timeoutMs: DIFF_TIMEOUT_MS,
    });

    if (ran.exit !== 0)
      return {
        ok: false,
        message: [DIFF_FAILED[ran.exit] ?? `exit ${ran.exit}`, ran.stderr.trim()]
          .filter((l) => l !== '')
          .join(': '),
      };
    const [base = '', mergeBase = '', names, patch] = ran.stdout.split('\n');

    return { ok: true, base, mergeBase, nameStatus: unbase(names), patch: unbase(patch) };
  },
  commits: async (worktree) => {
    const ran = await exec(['sh', '-c', COMMITS, 'sh', worktree, ...DEFAULT_BRANCH_REFS]);

    return ran.exit === 0
      ? { ok: true, data: commitsOf(ran.stdout) }
      : failed(
          'git-failed',
          [COMMITS_FAILED[ran.exit] ?? `exit ${ran.exit}`, ran.stderr.trim()]
            .filter((l) => l !== '')
            .join(': '),
        );
  },
  transcript: transcriptFiles(exec),
});

/** `env` as shell assignments, each value single-quoted; a name that is none is left out. */
export const exportLines = (env: Readonly<Record<string, string>>): string =>
  Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}='${v.replaceAll("'", `'\\''`)}'\n`)
    .join('');

/**
 * `abe run`'s script in the workspace container as the script user (#67): the app it starts runs
 * in the container (its browser reaches it, it outlives the call), and nothing it runs reads the
 * session's login. Exit null: killed at its time.
 */
export const runPackScript = async (
  exec: ContainerExec,
  o: {
    cwd: string;
    script: string;
    args: readonly string[];
    timeoutMs: number;
    runUser?: string;
    /** A folder put first on its `PATH` (a box workspace's `docker` shim). */
    pathFirst?: string;
    /** Its environment's values (a box's synced Abe env file and aws keys, 3.2.1): on stdin. */
    env?: Readonly<Record<string, string>>;
  },
): Promise<{ exit: number | null; stdout: string; stderr: string }> => {
  const seconds = Math.max(1, Math.ceil(o.timeoutMs / 1000));
  const ran = await exec(
    [
      'sh',
      '-c',
      PACK,
      'sh',
      o.cwd,
      o.script,
      String(seconds),
      o.pathFirst ?? '',
      o.env === undefined ? '' : '1',
      ...o.args,
    ],
    {
      ...(o.env === undefined ? {} : { stdin: exportLines(o.env) }),
      user: o.runUser ?? CONTAINER.runUser,
      timeoutMs: o.timeoutMs + EXEC_SLACK_MS,
    },
  );

  return {
    exit: ran.exit === 124 || ran.exit === 137 ? null : ran.exit,
    stdout: keptTail(ran.stdout),
    stderr: keptTail(ran.stderr),
  };
};
