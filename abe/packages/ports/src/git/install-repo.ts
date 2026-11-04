/**
 * Factory install's local reads (#22, `InstallRepo`): the checkout through `git`, its files from
 * disk, and whether the app's URL answers. IO only; the rules are core's `install*.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CHECK_SAYS,
  checksEnv,
  type InstallRepo,
  type InstallStore,
  awsRegionEnv,
  awsSessionEnv,
  type McpState,
  mcpAuthenticateLine,
  mcpStateOfStatus,
  mcpStatusLine,
  readControlLine,
  readSourceProbe,
  SIGN_IN_FALLBACK,
  type SignInResult,
  signInArgv,
  SOURCE_ACCOUNT_TIMEOUT_MS,
  SOURCE_SIGN_IN_POLL_MS,
  SOURCE_SIGN_IN_TIMEOUT_MS,
  sourceAccountArgv,
  sourceAccountPrompt,
  claudeServers,
  repoFile,
  repoSourcesOf,
  type SourceEntry,
  sourceName,
  sourceServers,
  sourceServersConfig,
  SOURCE_VALUES_PATH,
  parseEnvFile,
  withSourceValues,
} from '@abe/core';
import { blockText, INSTALL_EXCLUDE, startOf } from './exclude-block';
import { claudeConfigFile, mcpServersHere } from '../claude-code/claude-trust';
import { type Env } from '../mac/locations';
import { readYamlFile } from '../mac/settings';
import { runClaudeOnce } from '../claude-code/one-shot';
import { failed, gitEnv, runProcess, selfArgv } from '../mac/process';
import { runShell } from '../mac/checks';
import { prepareBaseWorktree } from '../mac/worktree-setup';

/** Only paths inside `top`: a `..` in a path is never read. */
const inside = (top: string, path: string): string | undefined => {
  const full = join(top, path);
  const rel = relative(top, full);

  return rel.startsWith('..') || isAbsolute(rel) ? undefined : full;
};

/** `text` without the install's exclude block, then with `paths` in it (none: no block). */
export const excludeText = (text: string, paths: readonly string[]): string =>
  blockText(text, INSTALL_EXCLUDE, paths);

/** The paths in the install's exclude block. */
const excludedIn = (text: string): string[] => {
  const lines = text.split('\n');
  const start = startOf(lines, INSTALL_EXCLUDE);
  const end = lines.indexOf(INSTALL_EXCLUDE.end, start);

  return start < 0 || end < 0 ? [] : lines.slice(start + 1, end);
};

/**
 * The paths `git status --porcelain -z` names: `XY path`, a rename or copy's source after it as
 * its own entry (both changed).
 */
const changedIn = (out: string): string[] => {
  const entries = out.split('\0');
  const paths: string[] = [];

  for (let n = 0; n < entries.length; n++) {
    const e = entries[n] ?? '';

    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2))) paths.push(entries[++n] ?? '');
  }

  return paths.filter((p) => p !== '');
};

/** `git grep -n`'s `path:line:text` lines, the first `max`. */
export const grepLines = (
  out: string,
  max: number,
): { path: string; line: number; text: string }[] =>
  out
    .split('\n')
    .flatMap((l) => {
      const m = /^(.+?):(\d+):(.*)$/.exec(l);

      return m === null ? [] : [{ path: m[1] ?? '', line: Number(m[2]), text: m[3] ?? '' }];
    })
    .slice(0, max);

const MCP_NAME = /^[\w.@-]+$/;
/** An aws profile's name, as the `box.profile` setting takes one. */
const AWS_PROFILE_NAME = /^[\w.+@-]+$/;

/** `claude mcp get`'s status line, and only it (the rest may name a header or env value). */
export const mcpStateOf = (exit: number, out: string): McpState => {
  const status = /^\s*Status:\s*(.*)$/im.exec(out)?.[1] ?? '';

  // a repo's own server (its .mcp.json) never loads in a session: none of yours
  if (/^\s*Scope:\s*Project/im.test(out)) return 'none';
  if (/connected/i.test(status)) return 'connected';
  if (/auth/i.test(status)) return 'needs-auth';
  if (exit !== 0 || /no mcp server/i.test(out)) return 'none';

  return 'failed';
};

const plainEnv = (env: Env): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const])),
  );

export const localInstallRepo = (o: {
  env: Env;
  answerMs?: number;
  accountMs?: number;
  /** How long the person has to sign in to a source (core's `SOURCE_SIGN_IN_TIMEOUT_MS`). */
  signInMs?: number;
}): InstallRepo => {
  const git = (cwd: string, args: readonly string[]) =>
    runProcess(['git', ...args], gitEnv(o.env), cwd, 10_000);
  const excludeFile = async (top: string) => {
    const r = await git(top, ['rev-parse', '--git-path', 'info/exclude']).catch(() => undefined);
    const path = r?.exit === 0 ? r.stdout.trim() : '';

    return path === '' ? undefined : resolve(top, path);
  };

  return {
    checkout: async (dir) => {
      const r = await git(dir, [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
      ]).catch(() => undefined);

      if (r?.exit !== 0) return undefined;
      const [top = '', gitDir = '', common = ''] = r.stdout.trim().split('\n');

      // the main checkout holds git's common dir as its `.git` (a card worktree's too)
      const mainTop = basename(common) === '.git' ? dirname(common) : undefined;

      return top === '' ? undefined : { top, main: gitDir === common, mainTop };
    },
    read: async (top, path) => {
      const full = inside(top, path);

      return full === undefined ? undefined : readFile(full, 'utf8').catch(() => undefined);
    },
    list: async (top, dir) => {
      const full = inside(top, dir);

      return full === undefined ? [] : readdir(full).catch(() => []);
    },
    grep: async (top, pattern, max) => {
      const r = await git(top, ['grep', '-n', '-I', '-i', '-E', '-e', pattern, '--']).catch(
        () => undefined,
      );

      return r?.exit === 0 ? grepLines(r.stdout, max) : [];
    },
    removeEmpty: async (top, dir) => {
      const full = inside(top, dir);

      // rmdir refuses a folder with anything in it; the checkout itself is never taken away
      return full === undefined || full === top
        ? false
        : rmdir(full).then(
            () => true,
            () => false,
          );
    },
    ignored: async (top, path) => {
      const r = await git(top, ['check-ignore', '-q', '--', path]).catch(() => undefined);

      return r?.exit === 0;
    },
    answers: async (url) => {
      try {
        await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(o.answerMs ?? 5_000) });

        return true;
      } catch {
        return false;
      }
    },
    origin: async (top) => {
      const r = await git(top, ['remote', 'get-url', 'origin']).catch(() => undefined);
      const url = r?.exit === 0 ? r.stdout.trim() : '';

      return url === '' ? undefined : url;
    },
    tracked: async (top, path) => {
      const r = await git(top, ['ls-files', '--error-unmatch', '--', path]).catch(() => undefined);

      return r?.exit === 0;
    },
    originOnly: async (top, path) => {
      const object = async (rev: string) => {
        const r = await git(top, ['rev-parse', '-q', '--verify', rev]).catch(() => undefined);

        return r?.exit === 0 ? r.stdout.trim() : undefined;
      };
      const head = await git(top, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
        .then((r) => (r.exit === 0 ? r.stdout.trim() : undefined))
        .catch(() => undefined);
      // no origin/HEAD (a remote added by hand): its main, else its master
      const candidates = head === undefined ? ['origin/main', 'origin/master'] : [head];

      for (const branch of candidates) {
        const there = await object(`refs/remotes/${branch}:${path}`);

        if (there === undefined) continue;

        return there === (await object(`HEAD:${path}`)) ? undefined : branch;
      }

      return undefined;
    },
    // in the checkout itself, outside every sandbox: serve's own allowlisted environment, `env` over it
    runCheck: (top, c) =>
      runShell({
        run: c.run,
        cwd: top,
        timeoutMs: c.timeoutMs,
        env: { ...checksEnv(o.env), ...c.env },
      }),
    runChecks: async (top, commands) => {
      const dir = await mkdtemp(join(tmpdir(), 'abe-checks-'));
      const tree = join(dir, 'tree');
      const shim = join(dir, 'bin');

      try {
        const head = await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => undefined);

        if (head?.exit !== 0) return undefined;
        await mkdir(tree);
        await mkdir(shim);
        // HEAD's files only: the working tree's edits and untracked files (an env file) stay out
        const made = await runProcess(
          ['sh', '-c', 'git archive HEAD | tar -x -C "$1"', 'sh', tree],
          gitEnv(o.env),
          top,
          60_000,
        ).catch(() => undefined);

        if (made?.exit !== 0) return undefined;
        // `git ls-files` in a check needs a repository: a fresh one over the same files
        const init = await git(tree, ['init', '-q']).catch(() => undefined);
        const added =
          init?.exit === 0 ? await git(tree, ['add', '-A']).catch(() => undefined) : undefined;

        if (added?.exit !== 0) return undefined;
        // `abe check json|yaml` in a check is this very program
        await writeFile(
          join(shim, 'abe'),
          `#!/bin/sh\nexec ${selfArgv([])
            .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
            .join(' ')} "$@"\n`,
        );
        await chmod(join(shim, 'abe'), 0o755);
        // nothing of the person's environment: the tools' path, and a home that is empty
        const env = {
          PATH: `${shim}:${o.env.PATH ?? '/usr/bin:/bin'}`,
          HOME: dir,
          TMPDIR: dir,
          CI: '1',
        };
        const out: { ok: boolean; says: string }[] = [];

        for (const command of commands) {
          const r = await runProcess(['sh', '-c', command], env, tree, 60_000).catch(
            () => undefined,
          );
          const says =
            r === undefined
              ? 'could not run'
              : (r.stderr.trim() || r.stdout.trim()).slice(-CHECK_SAYS);

          out.push({ ok: r?.exit === 0, says: r?.exit === 0 ? '' : says });
        }

        return out;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    tryWorktree: async (top, r) => {
      const dir = await mkdtemp(join(tmpdir(), 'abe-worktree-'));
      const tree = join(dir, 'tree');
      const made = await git(top, ['worktree', 'add', '--detach', '--quiet', tree, 'HEAD']).catch(
        () => undefined,
      );

      try {
        if (made?.exit !== 0)
          return failed(
            'worktree-failed',
            `git worktree add: ${(made?.stderr ?? '').trim() || 'could not run'}`,
          );
        const tracked = await git(tree, ['ls-files', '--', 'package.json', '*/package.json']);
        const ran = await prepareBaseWorktree({
          checkout: top,
          worktree: tree,
          copy: r.copy,
          tracked: tracked.exit === 0 ? tracked.stdout.split('\n').filter((l) => l !== '') : [],
          run: r.run,
          card: null,
          env: plainEnv(o.env),
        });
        const missing = ran.missing ?? [];
        const absent = r.copy
          .filter(
            (c) =>
              c.listed === true &&
              c.skip === undefined &&
              !missing.includes(c.path) &&
              !existsSync(join(tree, c.path)),
          )
          .map((c) => c.path);

        return { ok: true, data: { ran, absent } };
      } finally {
        await git(top, ['worktree', 'remove', '--force', tree]).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
        await git(top, ['worktree', 'prune']).catch(() => undefined);
      }
    },
    changed: async (top) => {
      const r = await git(top, ['status', '--porcelain', '-z', '--untracked-files=no']).catch(
        () => undefined,
      );

      return r?.exit === 0 ? changedIn(r.stdout) : [];
    },
    exclude: async (top, paths, on) => {
      const file = await excludeFile(top);

      if (file === undefined) return [];
      const text = await readFile(file, 'utf8').catch(() => '');
      const want = on ? [...new Set([...excludedIn(text), ...paths])] : [];

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, excludeText(text, want));

      return want;
    },
    awsAccount: async (profile) => {
      // a profile's name alone (the cloud check asks only an abe-* one, Credentials any), read
      // only, and only its account id is printed: never a key
      if (!AWS_PROFILE_NAME.test(profile)) return { cannot: `${profile} is no aws profile name` };
      if (Bun.which('aws', { PATH: o.env.PATH ?? '' }) === null)
        return { cannot: "aws not found on serve's PATH" };
      const argv = ['aws', 'sts', 'get-caller-identity', '--profile', profile];
      const r = await runProcess(
        [...argv, '--query', 'Account', '--output', 'text'],
        plainEnv(o.env),
        undefined,
        20_000,
      ).catch(() => undefined);
      const account = r?.exit === 0 ? r.stdout.trim() : '';

      return /^\d{12}$/.test(account)
        ? { account }
        : { cannot: `aws could not say who ${profile} is: abe login aws --profile ${profile}` };
    },
    awsProfiles: async () => {
      if (Bun.which('aws', { PATH: o.env.PATH ?? '' }) === null) return [];
      const r = await runProcess(
        ['aws', 'configure', 'list-profiles'],
        plainEnv(o.env),
        undefined,
        20_000,
      ).catch(() => undefined);

      // names only: a line that is no profile name is never said
      return r?.exit === 0
        ? r.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => AWS_PROFILE_NAME.test(l))
        : [];
    },
    mcp: async (top, name) => {
      if (!MCP_NAME.test(name)) return 'none';
      const claude = Bun.which('claude', { PATH: o.env.PATH ?? '' });

      if (claude === null) return 'failed';
      // a source the repo defines (ADR 0031): its state as a session here gets it, from the
      // config Abe generates, since Claude Code's own config may not have it
      if (repoSources(top).some((s) => typeof s !== 'string' && s.name === name)) {
        const config = await oneServerConfig(o.env.HOME, top, name);

        if (config === undefined) return 'none';
        try {
          const state = await statusThrough(signInArgv({ claude, config: config.file }), {
            cwd: top,
            env: plainEnv(o.env),
            name,
            timeoutMs: MCP_STATUS_TIMEOUT_MS,
          });

          if (state !== 'unsupported') return state;
        } finally {
          await rm(config.dir, { recursive: true, force: true });
        }
      }
      const r = await runProcess(
        ['claude', 'mcp', 'get', name],
        plainEnv(o.env),
        top,
        30_000,
      ).catch(() => undefined);

      return r === undefined ? 'failed' : mcpStateOf(r.exit, `${r.stdout}\n${r.stderr}`);
    },
    ownMcpServers: (top) =>
      Promise.resolve(o.env.HOME === undefined ? [] : mcpServersHere(o.env.HOME, top)),
    mcpFound: async (top) => {
      if (o.env.HOME === undefined) return [];
      try {
        const config: unknown = JSON.parse(await readFile(claudeConfigFile(o.env.HOME), 'utf8'));

        return claudeServers({ config, mains: [...new Set([top, resolve(top)])] });
      } catch {
        return [];
      }
    },
    addMcp: async (top, server) => {
      if (!MCP_NAME.test(server.name))
        return { ok: false, why: `${server.name}: not a server name` };
      if (Bun.which('claude', { PATH: o.env.PATH ?? '' }) === null)
        return { ok: false, why: 'claude is not on the PATH' };
      const r = await runProcess(
        [
          'claude',
          'mcp',
          'add',
          '--scope',
          'local',
          '--transport',
          server.transport,
          server.name,
          server.url,
        ],
        plainEnv(o.env),
        top,
        30_000,
      ).catch(() => undefined);

      if (r === undefined) return { ok: false, why: 'claude mcp add did not finish' };

      return r.exit === 0
        ? { ok: true }
        : { ok: false, why: `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-3).join(' ') };
    },
    sourceAccount: async (top, name, model) => {
      const none = { read: 'timeout' as const, account: {} };

      if (!MCP_NAME.test(name)) return none;
      const claude = Bun.which('claude', { PATH: o.env.PATH ?? '' });
      // that one server as a session here gets it: never a repo's .mcp.json
      const config = await oneServerConfig(o.env.HOME, top, name);

      if (claude === null || config === undefined) return none;
      try {
        const r = await runClaudeOnce(
          sourceAccountArgv({ claude, model, mcp: name, config: config.file }),
          {
            prompt: sourceAccountPrompt(name),
            cwd: top,
            env: plainEnv(o.env),
            timeoutMs: o.accountMs ?? SOURCE_ACCOUNT_TIMEOUT_MS,
          },
        );

        if (r.ok) return readSourceProbe(r.data.text);

        return {
          read: r.error.code === 'one-shot-timeout' ? 'timeout' : 'tool-error',
          account: {},
        };
      } finally {
        await rm(config.dir, { recursive: true, force: true });
      }
    },
    awsCredentials: async (profile) => {
      const login = `abe login aws --profile ${profile}`;

      if (!AWS_PROFILE_NAME.test(profile))
        return { ok: false, why: `${profile}: no aws profile name` };
      if (Bun.which('aws', { PATH: o.env.PATH ?? '' }) === null)
        return { ok: false, why: "aws not found on serve's PATH" };
      const r = await runProcess(
        ['aws', 'configure', 'export-credentials', '--profile', profile, '--format', 'process'],
        plainEnv(o.env),
        undefined,
        30_000,
      ).catch(() => undefined);
      // its answer is the keys themselves: read here, never said
      const env = r?.exit === 0 ? awsSessionEnv(r.stdout) : null;

      if (env === null)
        return { ok: false, why: `${profile} gave no credentials (its login expired?): ${login}` };
      // its region too: the process reads no profile of ~/.aws (ADR 0029)
      const region = await runProcess(
        ['aws', 'configure', 'get', 'region', '--profile', profile],
        plainEnv(o.env),
        undefined,
        10_000,
      ).catch(() => undefined);

      return {
        ok: true,
        env: { ...env, ...(region?.exit === 0 ? awsRegionEnv(region.stdout) : {}) },
      };
    },
    signInMcp: async (top, name) => {
      if (!MCP_NAME.test(name))
        return { signedIn: false, why: `${name}: not a server name`, fallback: false };
      const claude = Bun.which('claude', { PATH: o.env.PATH ?? '' });

      if (claude === null)
        return { signedIn: false, why: 'claude is not on the PATH', fallback: false };
      const config = await oneServerConfig(o.env.HOME, top, name);

      if (config === undefined)
        return {
          signedIn: false,
          why: `no MCP server ${name} a session here loads (or its definition holds a value)`,
          fallback: false,
        };
      try {
        return await signInThrough(signInArgv({ claude, config: config.file }), {
          cwd: top,
          env: plainEnv(o.env),
          name,
          timeoutMs: o.signInMs ?? SOURCE_SIGN_IN_TIMEOUT_MS,
        });
      } finally {
        await rm(config.dir, { recursive: true, force: true });
      }
    },
  };
};

/** The `sources:` of the repo's `abe.yaml` in the main checkout `top` (ADR 0031). */
const repoSources = (top: string): SourceEntry[] => {
  const read = readYamlFile(repoFile(top));

  return 'doc' in read ? repoSourcesOf(read.doc) : [];
};

/**
 * A generated MCP config of the one source server `name` as a session in `top` gets it (ADR
 * 0031): the repo's `sources:` entry of that name, a bare name's from the person's Claude Code;
 * in a folder of its own (mode 700, the file 600) the caller removes. None when `sources:` does
 * not name it, no scope has a bare name's, or its definition holds a value.
 */
const oneServerConfig = async (
  home: string | undefined,
  top: string,
  name: string,
): Promise<{ dir: string; file: string } | undefined> => {
  const sources = repoSources(top).filter((s) => sourceName(s) === name);
  let config: unknown = {};

  if (sources.some((s) => typeof s === 'string')) {
    if (home === undefined) return undefined;
    try {
      config = JSON.parse(await readFile(claudeConfigFile(home), 'utf8'));
    } catch {
      return undefined;
    }
  }
  const found = sourceServers({ config, mains: [top, resolve(top)], sources });
  const def = found.servers[name];

  if (def === undefined) return undefined;
  // each `${VAR}` filled from the person's values, as a session's config gets them
  const values = await readFile(join(top, SOURCE_VALUES_PATH), 'utf8').then(
    parseEnvFile,
    () => new Map<string, string>(),
  );
  const dir = await mkdtemp(join(tmpdir(), 'abe-source-'));
  const file = join(dir, 'mcp.json');

  await chmod(dir, 0o700);
  await writeFile(file, sourceServersConfig(withSourceValues({ [name]: def }, values)), {
    mode: 0o600,
  });

  return { dir, file };
};

/**
 * The headless sign-in (core's `source-sign-in.ts`): `mcp_authenticate`, the URL it answers
 * opened in the person's browser (never logged), then `mcp_status` until `connected`, then the
 * process killed. A Claude Code that does not know the request: the person updates it first.
 */
const signInThrough = async (
  argv: readonly string[],
  o: { cwd: string; env: Record<string, string>; name: string; timeoutMs: number },
): Promise<SignInResult> => {
  const child = Bun.spawn([...argv], {
    cwd: o.cwd,
    env: o.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const lines: string[] = [];
  let waiting: (() => void) | undefined;
  const reading = (async () => {
    const decoder = new TextDecoder();
    let rest = '';

    for await (const chunk of child.stdout) {
      rest += decoder.decode(chunk);
      const parts = rest.split('\n');

      rest = parts.pop() ?? '';
      lines.push(...parts);
      waiting?.();
    }
  })();
  const answer = async (id: string, until: number) => {
    for (;;) {
      for (const [n, line] of lines.entries()) {
        const read = readControlLine(line);

        if (read?.id === id) {
          lines.splice(n, 1);

          return read;
        }
      }
      if (Date.now() > until) return null;
      await Promise.race([
        new Promise<void>((done) => {
          waiting = done;
        }),
        Bun.sleep(500),
      ]);
    }
  };
  const until = Date.now() + o.timeoutMs;

  try {
    await child.stdin.write(mcpAuthenticateLine('auth', o.name));
    await child.stdin.flush();
    const auth = await answer('auth', until);

    if (auth === null)
      return { signedIn: false, why: 'Claude Code gave no sign-in URL', fallback: true };
    if (auth.kind === 'unsupported')
      return { signedIn: false, why: SIGN_IN_FALLBACK, fallback: true };
    if (auth.kind === 'error') return { signedIn: false, why: auth.message, fallback: false };
    if (auth.kind === 'auth')
      Bun.spawn(['open', auth.authUrl], { stdout: 'ignore', stderr: 'ignore' });
    for (let n = 0; Date.now() < until; n += 1) {
      await Bun.sleep(SOURCE_SIGN_IN_POLL_MS);
      await child.stdin.write(mcpStatusLine(`status-${n}`));
      await child.stdin.flush();
      const status = await answer(`status-${n}`, until);

      if (status?.kind === 'unsupported')
        return { signedIn: false, why: SIGN_IN_FALLBACK, fallback: true };
      const state =
        status?.kind === 'status'
          ? mcpStateOfStatus(status.servers.find((s) => s.name === o.name)?.status)
          : 'needs-auth';

      if (state === 'connected') return { signedIn: true };
      if (state === 'failed')
        return { signedIn: false, why: `${o.name} does not answer`, fallback: false };
    }

    return {
      signedIn: false,
      why: `not signed in within ${o.timeoutMs / 60_000} min`,
      fallback: false,
    };
  } finally {
    child.kill('SIGKILL');
    await reading.catch(() => undefined);
  }
};

/** How long a source's state is waited for while its server connects. */
const MCP_STATUS_TIMEOUT_MS = 30_000;

/**
 * A source's state as a session gets it (ADR 0031): `mcp_status` asked of the headless `claude`
 * on its generated config until the server is past `pending`; `unsupported` when Claude Code here
 * does not know the request, `failed` when it is still pending at the end.
 */
const statusThrough = async (
  argv: readonly string[],
  o: { cwd: string; env: Record<string, string>; name: string; timeoutMs: number },
): Promise<McpState | 'unsupported'> => {
  const child = Bun.spawn([...argv], {
    cwd: o.cwd,
    env: o.env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const lines: string[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    let rest = '';

    for await (const chunk of child.stdout) {
      rest += decoder.decode(chunk);
      const parts = rest.split('\n');

      rest = parts.pop() ?? '';
      lines.push(...parts);
    }
  })();
  const until = Date.now() + o.timeoutMs;

  try {
    for (let n = 0; Date.now() < until; n += 1) {
      const id = `status-${n}`;

      await child.stdin.write(mcpStatusLine(id));
      await child.stdin.flush();
      for (let waited = 0; waited < SOURCE_SIGN_IN_POLL_MS; waited += 250) {
        const at = lines.findIndex((l) => readControlLine(l)?.id === id);

        if (at >= 0) break;
        await Bun.sleep(250);
      }
      const at = lines.findIndex((l) => readControlLine(l)?.id === id);
      const read = at < 0 ? null : readControlLine(lines.splice(at, 1)[0] ?? '');

      if (read?.kind === 'unsupported') return 'unsupported';
      if (read?.kind === 'status') {
        const status = read.servers.find((s) => s.name === o.name)?.status;

        if (status !== 'pending') return mcpStateOfStatus(status);
      }
    }

    return 'failed';
  } finally {
    child.kill('SIGKILL');
    await reading.catch(() => undefined);
  }
};

/** `from` renamed to `to`, copied then removed when they are on different disks: whether it moved. */
const moved = async (from: string, to: string): Promise<boolean> => {
  try {
    await rename(from, to);

    return true;
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'EXDEV')) return false;
    await cp(from, to, { recursive: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });

    return true;
  }
};

/** The install records in `dir`, one folder per checkout (its path's hash), written whole. */
export const fileInstallStore = (dir: string): InstallStore => {
  const folder = (repo: string) =>
    join(dir, createHash('sha256').update(repo).digest('hex').slice(0, 16));

  return {
    read: async (repo) => {
      const text = await readFile(join(folder(repo), 'install.json'), 'utf8').catch(
        () => undefined,
      );

      if (text === undefined) return undefined;
      const doc: unknown = JSON.parse(text);

      return doc;
    },
    write: async (repo, doc) => {
      const at = folder(repo);

      await mkdir(at, { recursive: true });
      await writeFile(join(at, 'install.json.tmp'), `${JSON.stringify(doc, null, 2)}\n`);
      await rename(join(at, 'install.json.tmp'), join(at, 'install.json'));
    },
    aside: async (repo, at, also = []) => {
      const from = join(folder(repo), 'install.json');
      const into = join(folder(repo), `aside.${at.replace(/[:.]/g, '-')}`);
      const to = join(into, 'install.json');

      await mkdir(into, { recursive: true });
      if (!(await moved(from, to))) return undefined;
      const went: string[] = [];

      for (const path of also) {
        const there = join(into, basename(path));

        if (await moved(path, there)) went.push(there);
      }

      return { record: to, also: went };
    },
    move: async (from, to) => {
      if (!existsSync(folder(from)) || existsSync(folder(to))) return false;

      return moved(folder(from), folder(to));
    },
  };
};
