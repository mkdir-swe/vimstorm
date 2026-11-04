/**
 * The review's git: a checkout's files against the merge base with their patches (three readings
 * with the same options, which list the files in the same order), a range's commits with theirs,
 * the folders holding a `package.json`, and the PR's worktree. git runs with serve's environment
 * less a parent git's variables and tokens, and never prompts; a fetch asks `gh` for the login.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ChangedFile,
  type CommitFile,
  type FileStatus,
  type RangeCommit,
  type ReviewAnswer,
  type ReviewErrorCode,
  type ReviewWorktree,
} from '@abe/core';
import { FETCH_TIMEOUT_MS, fetchEnv } from './git';
import { type Env } from '../mac/locations';
import { gitEnv, runProcess, said } from '../mac/process';
import { retryLocked } from './repo-lock';
import { copyLocalFiles, linkModules } from './worktree-files';

const PATCH = ['-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
const RECORD = '\u001e';
const FIELD = '\u001f';

type Counted = { path: string; previous?: string; added: string; removed: string };

/** `git diff --numstat -z`: counts and path; a rename's two paths follow an empty one. */
const numstatEntries = (numstat: string): Counted[] => {
  const tokens = numstat.split('\0');
  const out: Counted[] = [];

  for (let i = 0; i < tokens.length;) {
    const [added = '', removed = '', path = ''] = (tokens[i] ?? '').split('\t');

    if (added === '') {
      i += 1;
      continue;
    }
    if (path !== '') {
      out.push({ path, added, removed });
      i += 1;
    } else {
      out.push({ path: tokens[i + 2] ?? '', previous: tokens[i + 1] ?? '', added, removed });
      i += 3;
    }
  }

  return out;
};

/** `git diff --name-status -z`: each path's status letter, a rename's similarity. */
const nameStatuses = (names: string): Map<string, { status: FileStatus; similarity?: number }> => {
  const tokens = names.split('\0');
  const out = new Map<string, { status: FileStatus; similarity?: number }>();

  for (let i = 0; i < tokens.length;) {
    const code = tokens[i] ?? '';

    if (code === '') {
      i += 1;
      continue;
    }
    if (code.startsWith('R') || code.startsWith('C')) {
      const similarity = Number.parseInt(code.slice(1), 10);

      out.set(tokens[i + 2] ?? '', {
        status: code.startsWith('R') ? 'R' : 'A',
        ...(Number.isNaN(similarity) ? {} : { similarity }),
      });
      i += 3;
      continue;
    }
    out.set(tokens[i + 1] ?? '', { status: code === 'A' || code === 'D' ? code : 'M' });
    i += 2;
  }

  return out;
};

/** One file's part of a unified diff, from its first `@@`; empty without one. */
const hunksOf = (part: string): string => {
  const lines = part.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));

  return first < 0 ? '' : lines.slice(first).join('\n').trimEnd();
};

/** The path a `diff --git` part is about: its new name, else (deleted) its old one. */
const partPath = (part: string): string => {
  const lines = part.split('\n');
  const after = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const first = lines[0] ?? '';
  const b = first.indexOf(' b/');

  return (
    after('rename to ') ?? after('+++ b/') ?? after('--- a/') ?? (b < 0 ? '' : first.slice(b + 3))
  );
};

/** A diff of many files, each file's part (what follows `diff --git `). */
const diffParts = (diff: string): string[] => {
  const parts: string[] = [];
  let start: number | undefined;
  let at = 0;

  for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith('diff --git ')) {
      if (start !== undefined) parts.push(diff.slice(start, at));
      start = at + 'diff --git '.length;
    }
    at += line.length;
  }
  if (start !== undefined) parts.push(diff.slice(start));

  return parts;
};

/** The files of a diff from its three readings with the same options. */
export const changedFiles = (numstat: string, names: string, patch: string): ChangedFile[] => {
  const statuses = nameStatuses(names);
  const parts = diffParts(patch).map(hunksOf);

  return numstatEntries(numstat).map((c, index): ChangedFile => {
    const binary = c.added === '-';
    const named = statuses.get(c.path);

    return {
      path: c.path,
      ...(c.previous === undefined ? {} : { previous: c.previous }),
      status: named?.status ?? (c.previous === undefined ? 'M' : 'R'),
      additions: binary ? 0 : Number.parseInt(c.added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(c.removed, 10) || 0,
      ...(named?.similarity === undefined ? {} : { similarity: named.similarity }),
      binary,
      patch: binary ? '' : (parts[index] ?? ''),
    };
  });
};

/** A numstat path that renames: `a => b`, or `dir/{a => b}/x`. */
export const renamedPath = (text: string): { path: string; previous?: string } => {
  const tidy = (p: string) => p.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');

  if (open >= 0 && open < close) {
    const inner = text.slice(open + 1, close);
    const arrow = inner.indexOf(' => ');

    if (arrow >= 0) {
      const head = text.slice(0, open);
      const tail = text.slice(close + 1);

      return {
        path: tidy(`${head}${inner.slice(arrow + 4)}${tail}`),
        previous: tidy(`${head}${inner.slice(0, arrow)}${tail}`),
      };
    }
  }
  const arrow = text.indexOf(' => ');

  return arrow < 0
    ? { path: text }
    : { path: text.slice(arrow + 4), previous: text.slice(0, arrow) };
};

/** `git log` with the record format and `--numstat`, newest first as git prints it; no patches. */
export const parseLog = (log: string): RangeCommit[] =>
  log
    .split(RECORD)
    .slice(1)
    .map((record) => {
      const [head = '', ...lines] = record.split('\n');
      const fields = head.split(FIELD);
      const files = lines.flatMap((line): CommitFile[] => {
        const [added = '', removed = '', ...rest] = line.split('\t');

        if (rest.length === 0 || added === '') return [];
        const binary = added === '-';
        const named = renamedPath(rest.join('\t'));

        return [
          {
            ...named,
            additions: binary ? 0 : Number.parseInt(added, 10) || 0,
            deletions: binary ? 0 : Number.parseInt(removed, 10) || 0,
            binary,
            patch: '',
          },
        ];
      });

      return {
        sha: fields[0] ?? '',
        subject: fields[1] ?? '',
        author: fields[2] ?? '',
        date: fields[3] ?? '',
        files,
      };
    });

/** Each commit's patches by path, from `git log --format=<RECORD>%H -p`. */
export const parsePatches = (log: string): Map<string, Map<string, string>> =>
  new Map(
    log
      .split(RECORD)
      .slice(1)
      .map((record) => {
        const nl = record.indexOf('\n');
        const sha = nl < 0 ? record : record.slice(0, nl);
        const rest = nl < 0 ? '' : record.slice(nl + 1);

        return [
          sha.trim(),
          new Map(diffParts(rest).map((part) => [partPath(part), hunksOf(part)] as const)),
        ] as const;
      }),
  );

/** Only `gh` answers for credentials: the person's keyring login. */
const CREDENTIALS = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];

export type ReviewGit = {
  mainOf: (path: string) => Promise<ReviewAnswer<string>>;
  originUrl: (path: string) => Promise<string | null>;
  changes: (
    path: string,
    base: string,
  ) => Promise<ReviewAnswer<{ base: string; head: string; files: ChangedFile[] }>>;
  commits: (path: string, from: string, to: string) => Promise<ReviewAnswer<RangeCommit[]>>;
  packages: (path: string) => Promise<ReviewAnswer<string[]>>;
  worktrees: (main: string) => Promise<ReviewAnswer<ReviewWorktree[]>>;
  checkoutPr: (input: {
    main: string;
    path: string;
    number: number;
    branch: string;
    base: string;
    reuse: boolean;
    upstream?: { ref: string; fork?: { owner: string; repo: string } | undefined } | undefined;
  }) => Promise<ReviewAnswer<{ path: string; head: string }>>;
  /** `git <args>` in `cwd`: its stdout, or why not. */
  run: (cwd: string, args: readonly string[], timeoutMs?: number) => Promise<ReviewAnswer<string>>;
};

const gitFailed = (code: ReviewErrorCode, message: string) =>
  ({ ok: false, error: { code, message } }) as const;

export const reviewGit = (env: Env): ReviewGit => {
  const plain = gitEnv(env);
  const fetching = fetchEnv(plain);
  const bin = Bun.which('git', { PATH: plain.PATH ?? '/usr/bin:/bin' }) ?? 'git';
  // never a prompt nobody sees: a push or fetch asks gh, ssh in batch mode
  const raw = (cwd: string, args: readonly string[], timeoutMs?: number) =>
    runProcess([bin, '-C', cwd, ...args], fetching, undefined, timeoutMs);
  const run = async (
    cwd: string,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<ReviewAnswer<string>> => {
    const r = await raw(cwd, args, timeoutMs);

    return r.exit === 0
      ? { ok: true, data: r.stdout }
      : gitFailed('failed', `git: ${said(r, 'git')}`);
  };
  const line = async (cwd: string, args: readonly string[]) => {
    const r = await run(cwd, args);

    return r.ok ? { ok: true as const, data: r.data.trim() } : r;
  };
  /** A fetch of `refspec` from origin, asking `gh` for the login. */
  const fetch = async (cwd: string, ...refspec: string[]): Promise<ReviewAnswer<string>> => {
    const r = await raw(
      cwd,
      [...CREDENTIALS, 'fetch', '--quiet', 'origin', ...refspec],
      FETCH_TIMEOUT_MS * 4,
    );

    return r.exit === 0
      ? { ok: true, data: r.stdout }
      : gitFailed('offline', `git fetch: ${said(r, 'git fetch')}`);
  };

  const mainOf = async (path: string): Promise<ReviewAnswer<string>> => {
    const top = await line(path, ['rev-parse', '--show-toplevel']);

    if (!top.ok) return gitFailed('not-found', `${path} is not a git checkout`);
    const common = await line(top.data, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);

    return { ok: true, data: common.ok ? dirname(common.data) : top.data };
  };

  const worktrees = async (main: string): Promise<ReviewAnswer<ReviewWorktree[]>> => {
    const list = await run(main, ['worktree', 'list', '--porcelain']);

    if (!list.ok) return list;

    return {
      ok: true,
      data: list.data
        .split('\n\n')
        .map((block) => {
          const lines = block.split('\n');
          const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
          const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);

          return path === undefined
            ? undefined
            : { path, branch: branch?.replace(/^refs\/heads\//, '') ?? null };
        })
        .filter((w): w is ReviewWorktree => w !== undefined),
    };
  };

  /**
   * `branch` tracks the PR's head branch as `gh pr checkout` sets it: origin's `<ref>` (fetched
   * to `origin/<ref>`), or a fork's by its URL (origin's protocol) with `<ref>` merged. A push
   * from it then goes to the pull request, never to a new branch of its own.
   */
  const track = async (
    main: string,
    path: string,
    branch: string,
    upstream: { ref: string; fork?: { owner: string; repo: string } | undefined } | undefined,
  ): Promise<ReviewAnswer<null>> => {
    if (upstream === undefined) return { ok: true, data: null };
    const { ref, fork } = upstream;
    let remote = 'origin';

    if (fork === undefined) {
      const got = await fetch(main, `+refs/heads/${ref}:refs/remotes/origin/${ref}`);

      if (!got.ok) return got;
    } else {
      const origin = await line(main, ['config', '--get', 'remote.origin.url']);
      const ssh = origin.ok && /^(git@|ssh:)/.test(origin.data);

      remote = ssh
        ? `git@github.com:${fork.owner}/${fork.repo}.git`
        : `https://github.com/${fork.owner}/${fork.repo}.git`;
    }
    for (const [key, value] of [
      [`branch.${branch}.remote`, remote],
      [`branch.${branch}.merge`, `refs/heads/${ref}`],
    ] as const) {
      const set = await raw(path, ['config', key, value]);

      if (set.exit !== 0) return gitFailed('failed', `git config ${key}: ${said(set, 'git')}`);
    }

    return { ok: true, data: null };
  };

  /** PR `number`'s head from origin: GitHub's `refs/pull/<n>/head`. */
  const fetchPr = async (cwd: string, main: string, number: number, base: string) => {
    await fetch(main, base);
    const got = await fetch(cwd, `refs/pull/${number}/head`);

    if (!got.ok) return got;

    return line(cwd, ['rev-parse', 'FETCH_HEAD']);
  };

  const checkoutPr: ReviewGit['checkoutPr'] = async ({
    main,
    path,
    number,
    branch,
    base,
    reuse,
    upstream,
  }) => {
    if (reuse) {
      const tip = await fetchPr(path, main, number, base);

      if (!tip.ok) return tip;
      // the checked-out branch moves on to the PR's head when it fast-forwards, else stays put
      await raw(path, ['merge', '--ff-only', '--quiet', tip.data]);
      const on = await line(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

      if (on.ok && on.data === branch) {
        const tracked = await track(main, path, branch, upstream);

        if (!tracked.ok) return tracked;
      }
      const head = await line(path, ['rev-parse', 'HEAD']);

      return head.ok ? { ok: true, data: { path, head: head.data } } : head;
    }
    if (existsSync(path)) return gitFailed('conflict', `${path} exists already`);
    // a worktree whose folder was deleted holds its branch until pruned
    await retryLocked(() => raw(main, ['worktree', 'prune']));
    const tip = await fetchPr(main, main, number, base);

    if (!tip.ok) return tip;
    const has = await raw(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    const added = await retryLocked(() =>
      raw(
        main,
        has.exit === 0
          ? ['worktree', 'add', '--quiet', path, branch]
          : ['worktree', 'add', '--quiet', '-b', branch, path, tip.data],
      ),
    );

    if (added.exit !== 0) return gitFailed('failed', `git worktree add: ${said(added, 'git')}`);
    if (has.exit === 0) await raw(path, ['merge', '--ff-only', '--quiet', tip.data]);
    const tracked = await track(main, path, branch, upstream);

    if (!tracked.ok) return tracked;
    // the main checkout's local-only files and its install, as every worktree of 1.x's got them
    try {
      await copyLocalFiles(
        async (cwd, args) => {
          const r = await raw(cwd, args);

          return r.exit === 0 ? r.stdout : null;
        },
        main,
        path,
      );
    } catch (e) {
      return gitFailed(
        'failed',
        `copying local files: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    linkModules(main, path);
    const head = await line(path, ['rev-parse', 'HEAD']);

    return head.ok ? { ok: true, data: { path, head: head.data } } : head;
  };

  return {
    mainOf,
    originUrl: async (path) => {
      const r = await line(path, ['config', '--get', 'remote.origin.url']);

      return r.ok && r.data !== '' ? r.data : null;
    },
    changes: async (path, base) => {
      const tip = await line(path, ['rev-parse', 'HEAD^{commit}']);

      if (!tip.ok) return tip;
      const from = await line(path, ['merge-base', base, tip.data]);

      if (!from.ok) return from;
      const range = [from.data, tip.data];
      const [numstat, names, patch] = await Promise.all([
        run(path, ['diff', '-M', '--numstat', '-z', ...range]),
        run(path, ['diff', '-M', '--name-status', '-z', ...range]),
        run(path, ['diff', ...PATCH, ...range]),
      ]);

      if (!numstat.ok) return numstat;
      if (!names.ok) return names;
      if (!patch.ok) return patch;

      return {
        ok: true,
        data: {
          base: from.data,
          head: tip.data,
          files: changedFiles(numstat.data, names.data, patch.data),
        },
      };
    },
    commits: async (path, from, to) => {
      const there = await raw(path, ['cat-file', '-e', `${from}^{commit}`]);

      if (there.exit !== 0)
        return gitFailed('not-found', `git: ${from.slice(0, 7)} is not in ${path}`);
      const range = `${from}..${to}`;
      const [log, patches] = await Promise.all([
        run(path, [
          'log',
          '--no-merges',
          `--format=${RECORD}%H${FIELD}%s${FIELD}%an${FIELD}%aI`,
          '--numstat',
          '-M',
          range,
        ]),
        run(path, ['log', '--no-merges', `--format=${RECORD}%H`, '-p', ...PATCH, range]),
      ]);

      if (!log.ok) return log;
      if (!patches.ok) return patches;
      const byCommit = parsePatches(patches.data);
      const commits = parseLog(log.data).map((c) => ({
        ...c,
        files: c.files.map((f) =>
          f.binary ? f : { ...f, patch: byCommit.get(c.sha)?.get(f.path) ?? '' },
        ),
      }));

      return { ok: true, data: commits.reverse() };
    },
    packages: async (path) => {
      const out = await run(path, ['ls-files', '--', 'package.json', '*/package.json']);

      if (!out.ok) return out;

      return {
        ok: true,
        data: out.data
          .split('\n')
          .filter((l) => l !== '')
          .map((file) => {
            const slash = file.lastIndexOf('/');

            return slash < 0 ? '' : file.slice(0, slash);
          }),
      };
    },
    worktrees,
    checkoutPr,
    run,
  };
};
