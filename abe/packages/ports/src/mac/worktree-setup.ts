/**
 * A card's new worktree made ready by `serve`, outside the session's sandbox, before its `claude`
 * starts (`prepareWorktree`): the files the checks need copied in from the main checkout, then its
 * packages. With the main checkout's lockfile and its packages installed there, the worktree's
 * `node_modules` folders mirror the checkout's entry by entry: a third-party package links to the
 * checkout's (never written: the sandbox keeps the session from it), the repo's own packages
 * (`node_modules/@acme/ui` → `../../packages/ui`) link into the worktree, so a change to a shared
 * package is the one its checks test, and `.bin` is rebuilt from the checkout's links, so `npx` and
 * a package script find each tool. Else the repo pack's setup or the lockfile's own install runs
 * there with its network held to the package registries: `sandbox-exec` lets it reach only a proxy
 * of serve's, which tunnels to a registry host and refuses every other. Last, the repo's worktree
 * recipe's script (`hooks.worktree-setup`), the main checkout's, run as serve with its network open. IO
 * only: the rules are core's (`core/src/session/setup.ts`, `worktree-recipe.ts`).
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isAbeEnvFile,
  ciCommand,
  CI_FILES,
  type Lockfile,
  LOCKFILES,
  REGISTRY_CONFIGS,
  registryAllows,
  registryHosts,
  type SetupRan,
  setupAfterLink,
  shellWord,
  type WorktreeCopy,
  WORKTREE_SCRIPT_TIMEOUT_MS,
} from '@abe/core';
import { runShell } from './checks';
import { type PackagesReady, readyPackages } from './clone-packages';
import { executable } from './process-group';
import { runOwn } from './process';
import { mainCheckout } from './settings';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The entries of a `node_modules` a worktree never shares: tools write their caches there. */
const SHARED_DOT = new Set(['.pnpm']);

const lstatOf = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/** Whether `path` lies in `top` and in no `node_modules`: one of the repo's own folders. */
const ownFolder = (top: string, path: string) => {
  const rel = relative(top, path);

  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !isAbsolute(rel) &&
    !rel.split(sep).includes('node_modules')
  );
};

/**
 * `wtPath` for the checkout's entry `mainPath`: a link into the worktree for one of the repo's own
 * packages (relative, as the package manager wrote it), else a link to the checkout's entry.
 */
const linkEntry = (main: string, wt: string, mainPath: string, wtPath: string) => {
  const st = lstatOf(mainPath);

  if (st === undefined) return;
  if (st.isSymbolicLink()) {
    const target = resolve(dirname(mainPath), readlinkSync(mainPath));

    if (ownFolder(main, target)) {
      symlinkSync(relative(dirname(wtPath), join(wt, relative(main, target))), wtPath);

      return;
    }
  }
  symlinkSync(mainPath, wtPath);
};

/** The checkout's `.bin` links read again in the worktree's mirror: each tool found there. */
const mirrorBin = (main: string, wt: string, mainBin: string, wtBin: string) => {
  mkdirSync(wtBin, { recursive: true });
  for (const name of readdirSync(mainBin)) {
    const from = join(mainBin, name);
    const st = lstatOf(from);

    if (st === undefined) continue;
    if (!st.isSymbolicLink()) {
      symlinkSync(from, join(wtBin, name));
      continue;
    }
    const text = readlinkSync(from);
    const target = resolve(mainBin, text);

    // relative into the mirror (`../vitest/vitest.mjs`); one into the repo's own folders by its place there
    const own = isAbsolute(text) && ownFolder(main, target);

    symlinkSync(own ? join(wt, relative(main, target)) : text, join(wtBin, name));
  }
};

/** One `node_modules` mirrored: scopes and `.bin` as folders, every other entry a link. */
const mirror = (main: string, wt: string, mainNm: string, wtNm: string) => {
  mkdirSync(wtNm, { recursive: true });
  for (const name of readdirSync(mainNm)) {
    const from = join(mainNm, name);
    const to = join(wtNm, name);

    if (name === '.bin') mirrorBin(main, wt, from, to);
    else if (name.startsWith('.') && !SHARED_DOT.has(name)) continue;
    else if (name.startsWith('@') && lstatOf(from)?.isDirectory() === true) {
      mkdirSync(to, { recursive: true });
      for (const pkg of readdirSync(from)) linkEntry(main, wt, join(from, pkg), join(to, pkg));
    } else linkEntry(main, wt, from, to);
  }
};

/** The folders holding a `package.json` git tracks in the worktree, from the top. */
const packageDirs = (tracked: readonly string[]) =>
  [
    ...new Set(
      tracked
        .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
        .map((p) => dirname(p)),
    ),
  ].filter((d) => !d.split('/').includes('node_modules'));

/**
 * The worktree's packages linked from the main checkout: each `node_modules` of the checkout's
 * (the top's and each workspace's, `tracked` naming the package.json files) mirrored. False, and
 * nothing made, when the worktree has a `node_modules` of its own already.
 */
export const linkPackages = (main: string, wt: string, tracked: readonly string[]): boolean => {
  const dirs = packageDirs(tracked).filter((d) =>
    lstatOf(join(main, d, 'node_modules'))?.isDirectory(),
  );

  if (dirs.some((d) => lstatOf(join(wt, d, 'node_modules')) !== undefined)) return false;
  for (const d of dirs) {
    if (!existsSync(join(wt, d))) continue;
    mirror(main, wt, join(main, d, 'node_modules'), join(wt, d, 'node_modules'));
  }

  return dirs.length > 0;
};

/** The lockfile at the worktree's top, the first of `LOCKFILES` there. */
export const lockfileIn = (dir: string): Lockfile | undefined =>
  LOCKFILES.find((f) => existsSync(join(dir, f)));

const sameFile = (a: string, b: string) => {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
};

/** The registry configs of the main checkout and of `home` (the person's), never the worktree's. */
export const registryConfigs = (checkout: string, home: string) =>
  [checkout, home].flatMap((dir) =>
    REGISTRY_CONFIGS.flatMap((file) => {
      const path = join(dir, file);

      try {
        return statSync(path).isFile() ? [{ file, text: readFileSync(path, 'utf8') }] : [];
      } catch {
        return [];
      }
    }),
  );

export type RegistryProxy = {
  /** The proxy's port on 127.0.0.1. */
  port: number;
  /** Each host it refused, in order. */
  refused: string[];
  close: () => Promise<void>;
};

const HEAD_END = '\r\n\r\n';

/**
 * A proxy on 127.0.0.1 that tunnels (`CONNECT host:port`) and forwards plain HTTP only to the hosts
 * `allowed` names (`registryAllows`); any other is answered 403 and kept in `refused`.
 */
export const registryProxy = (allowed: readonly string[]): Promise<RegistryProxy> => {
  const refused: string[] = [];
  const open = new Set<Socket>();
  const server = createServer((client) => {
    open.add(client);
    client.on('close', () => open.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(HEAD_END);

      if (end === -1) {
        if (head.length > 64 * 1024) client.destroy();

        return;
      }
      client.off('data', onData);
      const text = head.subarray(0, end).toString('latin1');
      const [line = ''] = text.split('\r\n');
      const [method = '', target = ''] = line.split(' ');
      const tunnel = method.toUpperCase() === 'CONNECT';
      let host = '';
      let port = 0;

      try {
        const url = tunnel ? new URL(`http://${target}`) : new URL(target);

        host = url.hostname.replace(/^\[|\]$/g, '');
        port = Number(url.port || (tunnel ? 443 : 80));
      } catch {
        // no URL: refused below, by what it said
      }
      if (host === '' || !registryAllows(allowed, host)) {
        refused.push(host === '' ? target : host);
        client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');

        return;
      }
      const upstream = createConnection({ host, port });

      open.add(upstream);
      upstream.on('close', () => open.delete(upstream));
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('connect', () => {
        if (tunnel) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else {
          // origin-form on to the host, the rest of the request as it came
          const url = new URL(target);
          const rewritten = text.replace(
            line,
            `${method} ${url.pathname}${url.search} ${line.split(' ')[2] ?? 'HTTP/1.1'}`,
          );

          upstream.write(Buffer.from(`${rewritten}${HEAD_END}`, 'latin1'));
        }
        const rest = head.subarray(end + HEAD_END.length);

        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };

    client.on('data', onData);
  });

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const at = server.address();

      done({
        port: typeof at === 'object' && at !== null ? at.port : 0,
        refused,
        close: () =>
          new Promise((closed) => {
            for (const s of open) s.destroy();
            server.close(() => {
              closed();
            });
          }),
      });
    });
  });
};

/** A `sandbox-exec` profile: all but the network, which reaches the proxy's port alone. */
const proxyOnly = (port: number) =>
  [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
  ].join(' ');

/** What every package manager reads for its proxy: npm's, pnpm's, yarn's, bun's. */
const proxyEnv = (url: string): Record<string, string> => ({
  HTTPS_PROXY: url,
  HTTP_PROXY: url,
  https_proxy: url,
  http_proxy: url,
  npm_config_https_proxy: url,
  npm_config_proxy: url,
  YARN_HTTPS_PROXY: url,
  YARN_HTTP_PROXY: url,
});

/**
 * The test browsers' postinstall downloads skipped (Cypress, Puppeteer, Playwright): their hosts
 * are no package registry, and their binaries are in the person's cache, shared with the main
 * checkout.
 */
const SKIP_DOWNLOADS: Readonly<Record<string, string>> = {
  CYPRESS_INSTALL_BINARY: '0',
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  // Puppeteer before 19
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: 'true',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
};

/**
 * `run` in `cwd` with `env`, its network the hosts `allowed` names alone (through
 * `registryProxy`), the test browsers' downloads skipped: what it ran, and the hosts it was
 * refused.
 */
export const runRegistryOnly = async (o: {
  run: string;
  cwd: string;
  env: Record<string, string>;
  allowed: readonly string[];
  timeoutMs: number;
}): Promise<{ exit: number | null; output: string; refused: string[] }> => {
  const proxy = await registryProxy(o.allowed);

  try {
    const env = { ...o.env, ...SKIP_DOWNLOADS, ...proxyEnv(`http://127.0.0.1:${proxy.port}`) };

    delete env.NO_PROXY;
    delete env.no_proxy;
    const ran = await runShell({
      run: o.run,
      cwd: o.cwd,
      env,
      timeoutMs: o.timeoutMs,
      wrap: [SANDBOX_EXEC, '-p', proxyOnly(proxy.port)],
    });

    return { exit: ran.exit, output: ran.output, refused: [...proxy.refused] };
  } finally {
    await proxy.close();
  }
};

/**
 * Each of `paths` (from the top) the worktree lacks, copied from the checkout: those copied. An
 * Abe env file (ADR 0028) is linked, never copied: one edit in the main checkout reaches every
 * card; a folder's copy leaves them out, each linked when listed.
 */
export const copyAbsent = (main: string, wt: string, paths: readonly string[]): string[] =>
  paths.filter((p) => {
    const from = join(main, p);
    const to = join(wt, p);
    const st = lstatOf(from);

    if (st === undefined || lstatOf(to) !== undefined) return false;
    // `.abe/` tracked or not, the card gets its Abe env files
    if (isAbeEnvFile(p)) mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(dirname(to))) return false;
    if (isAbeEnvFile(p)) symlinkSync(from, to);
    else if (st.isDirectory())
      cpSync(from, to, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !isAbeEnvFile(relative(main, src)),
      });
    else if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);

    return true;
  });

/** Two paths' bytes the same (both regular files). */
const sameBytes = (x: string, y: string): boolean => {
  try {
    return readFileSync(x).equals(readFileSync(y));
  } catch {
    return false;
  }
};

/** The person's own excludes git reads (its global `core.excludesFile`, else XDG's `git/ignore`). */
const globalExcludes = async (wt: string): Promise<string> => {
  const set = (
    await runOwn(['git', '-C', wt, 'config', '--global', '--get', 'core.excludesFile'])
  ).stdout.trim();
  const home = process.env.HOME ?? '';
  const file =
    set !== ''
      ? set.replace(/^~(?=\/)/, home)
      : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'git', 'ignore');

  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** The line that opens Abe's part of a worktree's own excludes file: each path under it Abe's. */
const HELD_MARK =
  "# Abe: the team's files the person has not committed (held out of this card's commits)";

/**
 * The paths (from the top) git leaves out of the worktree `wt` alone, never the main checkout or
 * another worktree: its own excludes file (the person's own excludes first, then these and those
 * it held out before: a repair adds to them), named by its `config.worktree`'s `core.excludesFile`
 * (`extensions.worktreeConfig` on, as the session hooks' `core.hooksPath` has it). The shared
 * `info/exclude` never: the main checkout keeps showing them.
 */
const excludeInWorktree = async (main: string, wt: string, paths: readonly string[]) => {
  const gitDir = (await runOwn(['git', '-C', wt, 'rev-parse', '--absolute-git-dir'])).stdout.trim();

  if (gitDir === '') return;
  const file = join(gitDir, 'abe-exclude');
  let had: string[] = [];

  try {
    const text = readFileSync(file, 'utf8');
    const at = text.indexOf(HELD_MARK);

    had =
      at === -1
        ? []
        : text
            .slice(at + HELD_MARK.length)
            .split('\n')
            .filter((l) => l.startsWith('/'));
  } catch {
    // none yet
  }
  const own = await globalExcludes(wt);
  const held = [...new Set([...had, ...paths.map((p) => `/${p}`)])];

  writeFileSync(
    file,
    `${own}${own === '' || own.endsWith('\n') ? '' : '\n'}${HELD_MARK}\n${held.map((p) => `${p}\n`).join('')}`,
  );
  const on = (
    await runOwn(['git', '-C', main, 'config', '--type=bool', '--get', 'extensions.worktreeConfig'])
  ).stdout.trim();

  if (on !== 'true')
    await runOwn(['git', '-C', main, 'config', 'extensions.worktreeConfig', 'true']);
  await runOwn(['git', '-C', wt, 'config', '--worktree', 'core.excludesFile', file]);
};

/** Why a step on a path failed, in a few words: a system error's code and words, no path. */
const whyFailed = (e: unknown): string => {
  const said = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

  return /^(E[A-Z]+: [^,]+),/.exec(said)?.[1] ?? said;
};

/** What `copyOver` did: the paths with a file put in or held out, and those it could not put in. */
export type CopiedOver = { done: string[]; notCopied: Record<string, string> };

/**
 * The team's files under each of `paths` (`WorktreeCopy.over`: a file, or a folder) the person
 * changed in the main checkout and has not committed (box parity, 3.2.1), put in the worktree as
 * the working copy has them and held out of the card's commits: one its branch tracks that differs
 * (or that the checkout no longer has, removed) `--skip-worktree`, one untracked there by the
 * worktree's own exclude (`excludeInWorktree`). One the same as the branch's stays the card's
 * own, writable and committed as usual (a card keeps its Verification pack on its branch). Abe
 * env files never. A path the checkout has that git's excludes hide there (the person's own
 * excludes name `.claude/`) is put in whole when the worktree has none of it. `fresh` false (a
 * worktree made before: a repair) only puts in what the worktree lacks, never over the branch's.
 * Each path on its own: one that fails is said with why (`notCopied`), the rest still go in, and
 * one the checkout has that the worktree still lacks is said too.
 */
export const copyOver = async (
  main: string,
  wt: string,
  paths: readonly string[],
  fresh = true,
): Promise<CopiedOver> => {
  const untracked: string[] = [];
  const done: string[] = [];
  const notCopied: Record<string, string> = {};

  for (const p of paths) {
    try {
      const listed = async (dir: string, ...flags: string[]) => {
        const r = await runOwn(['git', '-C', dir, 'ls-files', '-z', ...flags, '--', p]);

        return (r.exit === 0 ? r.stdout.split('\0') : []).filter(
          (f) => f !== '' && !isAbeEnvFile(f),
        );
      };
      const tracked = await listed(wt);
      const held: string[] = [];

      for (const f of fresh ? tracked : []) {
        const from = join(main, f);
        const to = join(wt, f);
        const st = lstatOf(from);

        if (st?.isFile() === true && sameBytes(from, to)) continue;
        rmSync(to, { force: true });
        held.push(f);
        if (st === undefined) continue;
        mkdirSync(dirname(to), { recursive: true });
        if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
        else if (st.isFile()) copyFileSync(from, to);
      }
      if (held.length > 0)
        await runOwn(
          ['git', '-C', wt, 'update-index', '--skip-worktree', '-z', '--stdin'],
          held.map((f) => `${f}\0`).join(''),
        );
      const added = (await listed(main, '--others', '--exclude-standard')).filter(
        (f) => !tracked.includes(f) && lstatOf(join(wt, f)) === undefined,
      );

      for (const f of added) {
        const from = join(main, f);
        const st = lstatOf(from);

        if (st === undefined) continue;
        mkdirSync(dirname(join(wt, f)), { recursive: true });
        if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), join(wt, f));
        else if (st.isFile()) copyFileSync(from, join(wt, f));
        untracked.push(f);
      }
      const absent = lstatOf(join(main, p)) !== undefined && lstatOf(join(wt, p)) === undefined;

      if (absent) mkdirSync(dirname(join(wt, p)), { recursive: true });
      const whole = absent ? copyAbsent(main, wt, [p]) : [];

      untracked.push(...whole);
      if (held.length > 0 || added.length > 0 || whole.length > 0) done.push(p);
      if (lstatOf(join(main, p)) !== undefined && lstatOf(join(wt, p)) === undefined)
        notCopied[p] = 'not put in';
    } catch (e) {
      notCopied[p] = whyFailed(e);
    }
  }
  if (untracked.length > 0) await excludeInWorktree(main, wt, untracked);

  return { done, notCopied };
};

/**
 * Each of `paths` (from the top) the worktree lacks linked to the checkout's (the recipe's
 * `worktree.link`: one edit there reaches every worktree), its folders made: those linked.
 */
export const linkAbsent = (main: string, wt: string, paths: readonly string[]): string[] =>
  paths.filter((p) => {
    const from = join(main, p);
    const to = join(wt, p);

    if (lstatOf(from) === undefined || lstatOf(to) !== undefined) return false;
    mkdirSync(dirname(to), { recursive: true });
    symlinkSync(from, to);

    return true;
  });

/**
 * Each of `paths` (from the top) copied from the checkout where the worktree lacks it (the
 * recipe's `worktree.copy`), its folders made: a folder's files the worktree has stay its own, the
 * rest copied in. Abe env files never. Those with anything put in.
 */
export const copyListed = (main: string, wt: string, paths: readonly string[]): string[] =>
  paths.filter((p) => {
    const from = join(main, p);
    const to = join(wt, p);
    const st = lstatOf(from);
    const absent = lstatOf(to) === undefined;

    if (st === undefined || isAbeEnvFile(p) || (!absent && !st.isDirectory())) return false;
    mkdirSync(dirname(to), { recursive: true });
    if (st.isDirectory())
      cpSync(from, to, {
        recursive: true,
        force: false,
        errorOnExist: false,
        verbatimSymlinks: true,
        filter: (src) => !isAbeEnvFile(relative(main, src)),
      });
    else if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);

    return true;
  });

/** What `putFiles` did: from the top, each path once. */
export type FilesPut = {
  copied: string[];
  links: string[];
  skipped: Record<string, string>;
  missing: string[];
  /** Those the checkout has that could not be put in, each with why. */
  notCopied: Record<string, string>;
};

/** `put` run on each of `paths` on its own: those it put in, and each one that threw, with why. */
const eachPath = (
  paths: readonly string[],
  put: (paths: readonly string[]) => string[],
  notCopied: Record<string, string>,
): string[] =>
  paths.flatMap((p) => {
    try {
      return put([p]);
    } catch (e) {
      notCopied[p] = whyFailed(e);

      return [];
    }
  });

/**
 * `copy`'s files put in the worktree from the main checkout (`main`; a card's worktree given
 * stands for its main checkout, whose untracked team files that worktree holds out of git's
 * sight): the team's over the branch's (`over`, `copyOver`), the recipe's linked (`link`) or
 * copied (`copyListed`), the rest copied when absent (`copyAbsent`); one with `skip` left out,
 * said with why; one the recipe names (`listed`) that the checkout lacks, said as missing; one
 * that could not be put in said with why (`notCopied`), the others put in all the same. `fresh`
 * false (a worktree made before, `repairTeamFiles`): the team's only where the worktree lacks them.
 */
export const putFiles = async (
  given: string,
  wt: string,
  copy: readonly WorktreeCopy[],
  fresh = true,
): Promise<FilesPut> => {
  const main = mainCheckout(given) ?? given;
  const put = copy.filter((c) => c.skip === undefined);
  const over = await copyOver(
    main,
    wt,
    put.filter((c) => c.over === true).map((c) => c.path),
    fresh,
  );
  const notCopied: Record<string, string> = { ...over.notCopied };
  const links = eachPath(
    put.filter((c) => c.link === true).map((c) => c.path),
    (ps) => linkAbsent(main, wt, ps),
    notCopied,
  );
  const listed = eachPath(
    put.filter((c) => c.listed === true && c.link !== true).map((c) => c.path),
    (ps) => copyListed(main, wt, ps),
    notCopied,
  );
  // a team path the branch does not track is never copied in: it could not be held out
  const absent = eachPath(
    put.filter((c) => c.over !== true && c.listed !== true).map((c) => c.path),
    (ps) => copyAbsent(main, wt, ps),
    notCopied,
  );
  const copied = put
    .map((c) => c.path)
    .filter((p) => over.done.includes(p) || listed.includes(p) || absent.includes(p));

  return {
    copied: [...new Set(copied)],
    links,
    skipped: Object.fromEntries(
      copy.flatMap((c) => (c.skip === undefined ? [] : [[c.path, c.skip] as const])),
    ),
    missing: put
      .filter((c) => c.listed === true && lstatOf(join(main, c.path)) === undefined)
      .map((c) => c.path),
    notCopied,
  };
};

/**
 * A worktree made before (a session started again, resumed or reopened in it) given the team's
 * files of `copy` (`over`) the main checkout has and it lacks, held out of its commits as at its
 * launch; never over a file it has (the card's own). What it put in, and what it could not.
 */
export const repairTeamFiles = async (
  checkout: string,
  wt: string,
  copy: readonly WorktreeCopy[],
): Promise<Pick<FilesPut, 'copied' | 'notCopied'>> => {
  const put = await putFiles(
    checkout,
    wt,
    copy.filter((c) => c.over === true),
    false,
  );

  return { copied: put.copied, notCopied: put.notCopied };
};

/** What `put` says of the recipe beyond the copies, each part only when it has any (`SetupRan`). */
const recipeSaid = (
  put: FilesPut,
): Pick<SetupRan, 'links' | 'skipped' | 'missing' | 'notCopied'> => ({
  ...(put.links.length === 0 ? {} : { links: put.links }),
  ...(Object.keys(put.skipped).length === 0 ? {} : { skipped: put.skipped }),
  ...(put.missing.length === 0 ? {} : { missing: put.missing }),
  ...(Object.keys(put.notCopied).length === 0 ? {} : { notCopied: put.notCopied }),
});

/**
 * The recipe's script (`hooks.worktree-setup`, from the top) run in the new worktree `worktree` as serve,
 * outside every sandbox, the main checkout's copy of it (never the branch's, which an agent
 * writes): `MAIN_CHECKOUT`, `WORKTREE` and `CARD` (empty for none) in its environment, killed
 * after `WORKTREE_SCRIPT_TIMEOUT_MS`.
 */
export const runWorktreeScript = async (o: {
  run: string;
  checkout: string;
  worktree: string;
  card: string | null;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ run: string; exit: number | null; output: string }> => {
  const path = join(o.checkout, o.run);

  if (!existsSync(path))
    return { run: o.run, exit: 127, output: `no ${o.run} in the main checkout ${o.checkout}\n` };
  if (!executable(path))
    return {
      run: o.run,
      exit: 126,
      output: `${o.run} is not executable (chmod +x, and git update-index --chmod=+x)\n`,
    };
  const ran = await runShell({
    run: `exec ${shellWord(path)}`,
    cwd: o.worktree,
    env: { ...o.env, MAIN_CHECKOUT: o.checkout, WORKTREE: o.worktree, CARD: o.card ?? '' },
    timeoutMs: o.timeoutMs ?? WORKTREE_SCRIPT_TIMEOUT_MS,
  });

  return { run: o.run, exit: ran.exit, output: ran.output };
};

/**
 * `run` (a package manager's install) in `cwd` with its network the package registries alone
 * (`runRegistryOnly`, the hosts of the checkout's and the person's registry configs): what ran,
 * its exit and output, the hosts refused said at its end.
 */
const registryInstall = async (o: {
  run: string;
  checkout: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => {
  const ran = await runRegistryOnly({
    run: o.run,
    cwd: o.cwd,
    env: o.env,
    allowed: registryHosts(registryConfigs(o.checkout, o.env.HOME ?? '/')),
    timeoutMs: o.timeoutMs,
  });
  const said =
    ran.refused.length === 0
      ? ''
      : `\n[network refused, not a package registry: ${[...new Set(ran.refused)].join(', ')}]\n`;

  return { run: o.run, exit: ran.exit, output: `${ran.output}${said}` };
};

/**
 * A prototype's worktree's packages (ADR 0039): the main checkout's `node_modules` cloned in and
 * the lockfile's install run when the manifests differ (`readyPackages`), its network the
 * registries alone. Null when the main checkout has none installed (its worktree is set up as a
 * card's is).
 */
export const prototypePackages = async (o: {
  checkout: string;
  worktree: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<PackagesReady | null> => {
  const checkout = mainCheckout(o.checkout) ?? o.checkout;

  if (lstatOf(join(checkout, 'node_modules'))?.isDirectory() !== true) return null;

  return readyPackages({
    checkout,
    worktree: o.worktree,
    env: o.env,
    install: (run) =>
      registryInstall({ run, checkout, cwd: o.worktree, env: o.env, timeoutMs: o.timeoutMs }),
  });
};

/**
 * The worktree made ready (`prepareWorktree`): `copy`'s files copied in from the main checkout (a
 * card's worktree given as `checkout` stands for its main checkout, in all of it), then its
 * packages linked when the checkout's lockfile is the same and its packages are installed, else `setup` or the
 * lockfile's install run with the registries alone reachable (`registries`: core's
 * `registryHosts`). Null: nothing to do.
 */
export const prepareWorktree = async (given: {
  checkout: string;
  worktree: string;
  /** The repo pack's setup (`setup`); null: the lockfile's install. */
  setup: string | null;
  env: Record<string, string>;
  /**
   * Files and folders from the top the checks need, the main checkout's, copied when absent; a test
   * env file's key names said with it.
   */
  copy: readonly WorktreeCopy[];
  /** The package.json files git tracks in the worktree, from its top. */
  tracked: readonly string[];
  timeoutMs: number;
  /** The recipe's script (`hooks.worktree-setup`), run last; none: none. */
  run?: string | null;
  /** The card the worktree is for (the script's `CARD`); none: no card. */
  card?: string | null;
  /** False: a worktree made before, given only the team's files it lacks (`putFiles`). */
  fresh?: boolean;
  /**
   * `clone`: a prototype's worktree (ADR 0039), its `node_modules` cloned from the main checkout
   * (`readyPackages`) and installed only when its manifests differ. None: linked as a card's.
   */
  packages?: 'link' | 'clone';
}): Promise<SetupRan | null> => {
  const o = { ...given, checkout: mainCheckout(given.checkout) ?? given.checkout };
  const put = await putFiles(o.checkout, o.worktree, o.copy, o.fresh ?? true);
  const { copied } = put;
  const keys = recipeSaid(put);
  // the recipe's script, last: once the packages are there, and only when they are
  const scripted = async <T extends SetupRan>(ran: T): Promise<T> =>
    o.run === undefined || o.run === null || ran.exit !== 0
      ? ran
      : {
          ...ran,
          script: await runWorktreeScript({
            run: o.run,
            checkout: o.checkout,
            worktree: o.worktree,
            card: o.card ?? null,
            env: o.env,
          }),
        };
  const lock = lockfileIn(o.worktree);
  const same = lock !== undefined && sameFile(join(o.checkout, lock), join(o.worktree, lock));
  const setUp = (run: string) =>
    registryInstall({
      run,
      checkout: o.checkout,
      cwd: o.worktree,
      env: o.env,
      timeoutMs: o.timeoutMs,
    });

  const ready =
    o.packages === 'clone' ? await prototypePackages({ ...o, timeoutMs: o.timeoutMs }) : null;

  if (ready !== null) {
    // the setup's other steps (codegen) still run when no install did: the clone stands for it
    const after = ready.installed !== null || o.setup === null ? null : setupAfterLink(o.setup);
    const ran =
      ready.installed ?? (after === null ? { run: '', exit: 0, output: '' } : await setUp(after));
    const notCloned =
      Object.keys(ready.notCloned).length === 0
        ? {}
        : { notCopied: { ...(keys.notCopied ?? {}), ...ready.notCloned } };

    return scripted({ ...ran, how: 'cloned', from: o.checkout, copied, ...keys, ...notCloned });
  }
  if (same && linkPackages(o.checkout, o.worktree, o.tracked)) {
    // the setup's other steps (codegen) still run: its install is what the links stand for
    const after = o.setup === null ? null : setupAfterLink(o.setup);
    const ran = after === null ? { run: '', exit: 0, output: '' } : await setUp(after);

    return scripted({ ...ran, how: 'linked', from: o.checkout, copied, ...keys });
  }
  const run =
    o.setup ??
    (lock === undefined ? null : ciCommand(lock, existsSync(join(o.checkout, '.yarnrc.yml'))));
  const none = { run: '', exit: 0, output: '', how: 'none' as const, copied, ...keys };
  const nothing =
    copied.length === 0 &&
    put.links.length === 0 &&
    put.missing.length === 0 &&
    Object.keys(put.skipped).length === 0 &&
    Object.keys(put.notCopied).length === 0 &&
    (o.run ?? null) === null;

  if (run === null) return nothing ? null : scripted(none);

  return scripted({ ...(await setUp(run)), how: 'ran', copied, ...keys });
};

/**
 * A Before worktree (at the merge base) made ready by the recipe as a card's is, without an
 * install: `copy`'s files put in, its packages linked when the checkout's lockfile is the same
 * and they are not there yet, then the recipe's script.
 */
export const prepareBaseWorktree = async (given: {
  checkout: string;
  worktree: string;
  copy: readonly WorktreeCopy[];
  tracked: readonly string[];
  run: string | null;
  card: string | null;
  env: Record<string, string>;
}): Promise<SetupRan> => {
  const o = { ...given, checkout: mainCheckout(given.checkout) ?? given.checkout };
  const put = await putFiles(o.checkout, o.worktree, o.copy);
  const lock = lockfileIn(o.worktree);
  const linked =
    lock !== undefined &&
    sameFile(join(o.checkout, lock), join(o.worktree, lock)) &&
    linkPackages(o.checkout, o.worktree, o.tracked);
  const script =
    o.run === null
      ? undefined
      : await runWorktreeScript({
          run: o.run,
          checkout: o.checkout,
          worktree: o.worktree,
          card: o.card,
          env: o.env,
        });

  return {
    run: '',
    exit: 0,
    output: '',
    how: linked ? 'linked' : 'none',
    ...(linked ? { from: o.checkout } : {}),
    copied: put.copied,
    ...recipeSaid(put),
    ...(script === undefined ? {} : { script }),
  };
};

/** The CI files of `checkout` whose `NODE_OPTIONS` the checks take (core's `CI_FILES`), each read. */
export const ciFiles = (checkout: string): { path: string; text: string }[] => {
  const read = (path: string) => {
    try {
      return [{ path, text: readFileSync(join(checkout, path), 'utf8') }];
    } catch {
      return [];
    }
  };
  const listed = (dir: string) => {
    try {
      return readdirSync(join(checkout, dir)).map((name) =>
        dir === '.' ? name : `${dir}/${name}`,
      );
    } catch {
      return [];
    }
  };

  return [...listed('.'), ...listed('.github/workflows'), ...listed('.circleci')]
    .filter((p) => CI_FILES.some((re) => re.test(p)))
    .flatMap(read);
};
