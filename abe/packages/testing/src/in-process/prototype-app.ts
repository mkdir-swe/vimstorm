/**
 * A small app for prototypes in a temporary git repo. A Bun server has one HTML page,
 * `Shop <release>`, and one API route, `GET /api/products`. It has a live-reload socket at `/hmr`
 * like Vite's, with the `vite-hmr` protocol and a `?token=t`. The socket says `connected`, then
 * echoes `<release>: <message>`. A Verification pack's `.claude/skills/run-app/scripts/start` starts the server in
 * the background on a free port and prints its URL, as demo-shop's does. `releaseShop(repo, name)`
 * moves `main` on with a new commit.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Git with a fixed author and no machine config, so commits read the same on every machine. */
export const GIT_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** Runs `git -C cwd …` to its end. Returns its stdout trimmed, or throws with its stderr. */
export const git = (cwd: string, ...args: string[]): string => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const server = (release: string) => `const [portFile = 'port', want = '0'] = process.argv.slice(2);
const page = \`<!doctype html>
<html><head><title>Shop</title></head>
<body><h1>Shop ${release}</h1><script src="/app.js"></script></body></html>\`;
const app = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(want),
  fetch: (req) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/hmr') {
      const ok = req.headers.get('sec-websocket-protocol') === 'vite-hmr' && url.searchParams.get('token') === 't';

      return ok && app.upgrade(req, { headers: { 'sec-websocket-protocol': 'vite-hmr' } }) ? undefined : new Response('no', { status: 400 });
    }

    if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/account') return new Response(null, { status: 302, headers: { location: '/login' } });
    if (path === '/login') return new Response('<form><input type="password" name="p"></form>', { headers: { 'content-type': 'text/html' } });
    if (path === '/app.js') return new Response('console.log("shop")', { headers: { 'content-type': 'text/javascript' } });
    if (path === '/api/products') return Response.json([{ id: 1, name: 'Assam', release: '${release}' }]);
    if (path === '/old') return new Response(null, { status: 302, headers: { location: \`http://127.0.0.1:\${app.port}/\` } });

    return new Response('not found', { status: 404 });
  },
  websocket: {
    open: (ws) => ws.send('connected'),
    message: (ws, m) => ws.send(\`${release}: \${String(m)}\`),
  },
});
await Bun.write(portFile, String(app.port));
`;

/**
 * The pack's start script. It starts the server in the background and prints its URL once it
 * answers.
 */
const START = `#!/bin/sh
set -eu
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
run="$root/.scratch/run"
mkdir -p "$run"
rm -f "$run/port"
echo "start: starting the shop" >&2
printf 'DATABASE_URL=%s\nABE_PORT_BASE=%s\n' "\${DATABASE_URL:-}" "\${ABE_PORT_BASE:-}" >"$run/start.env"
nohup bun "$root/server.ts" "$run/port" </dev/null >"$run/app.log" 2>&1 &
echo $! >"$run/app.pid"
i=0
while [ ! -s "$run/port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "start: the shop did not start" >&2; tail -n 20 "$run/app.log" >&2; exit 1; fi
  sleep 0.1
done
echo "http://127.0.0.1:$(cat "$run/port")"
`;

/**
 * The install's `abe/scripts/prototype-start` for the shop: on `$ABE_PORT_BASE` (or `port`, the
 * one it is told to take instead), waiting until it answers, then its URL (`path` on it) last.
 * `# abe-login:` names `login`'s keys when given. It writes the `SHOP_DEMO_USER` it got (none:
 * `-`) to `.scratch/run/login`.
 */
export const shopPrototypeStart = (
  o: { port?: number; path?: string; login?: string } = {},
) => `#!/bin/sh
# abe-env: dev
${o.login === undefined ? '' : `# abe-login: ${o.login}\n`}set -eu
root="$(cd "$(dirname "$0")/../.." && pwd)"
run="$root/.scratch/run"
port="${o.port === undefined ? '$ABE_PORT_BASE' : String(o.port)}"
mkdir -p "$run"
rm -f "$run/port"
echo "\${SHOP_DEMO_USER:--}" >"$run/login"
nohup bun "$root/server.ts" "$run/port" "$port" </dev/null >"$run/app.log" 2>&1 &
i=0
while [ ! -s "$run/port" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then echo "the shop did not start" >&2; exit 1; fi
  sleep 0.1
done
echo "http://127.0.0.1:$(cat "$run/port")${o.path ?? '/'}"
`;

const STOP = `#!/bin/sh
run="$(cd "$(dirname "$0")/../../../.." && pwd)/.scratch/run"
[ -f "$run/app.pid" ] && kill "$(cat "$run/app.pid")" 2>/dev/null
rm -f "$run/app.pid"
exit 0
`;

/** A start script that fails the way a real one does, with some output, then exit 1. */
export const FAILING_START = `#!/bin/sh
echo "start: installing packages" >&2
echo "start: applying migrations" >&2
echo "error: DATABASE_URL is not set" >&2
exit 1
`;

const put = (repo: string, path: string, text: string, mode?: number) => {
  const file = join(repo, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode !== undefined) chmodSync(file, mode);
};

/**
 * The shop at release `one` on `main` in a new repo at `repo`, with an `origin` remote that is
 * never fetched. `start` replaces the pack's start script, and `executable: false` commits it
 * without +x. `stop: false` leaves the stop script out. `files` adds more files, and a script under
 * `.claude/skills/run-app/scripts/` gets +x. Its start writes the `DATABASE_URL` and `ABE_PORT_BASE` it got to
 * `.scratch/run/start.env`.
 */
export const prototypeRepo = (
  repo: string,
  o: {
    start?: string;
    executable?: boolean;
    stop?: boolean;
    files?: Readonly<Record<string, string>>;
  } = {},
): string => {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/shop.git');
  put(repo, '.gitignore', '.scratch/\n');
  put(repo, 'server.ts', server('one'));
  put(
    repo,
    '.claude/skills/run-app/scripts/start',
    o.start ?? START,
    o.executable === false ? 0o644 : 0o755,
  );
  if (o.stop !== false) put(repo, '.claude/skills/run-app/scripts/stop', STOP, 0o755);
  for (const [path, text] of Object.entries(o.files ?? {}))
    put(repo, path, text, path.startsWith('.claude/skills/run-app/scripts/') ? 0o755 : undefined);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'the shop');

  return git(repo, 'rev-parse', 'HEAD');
};

/** Moves `main` on to the shop at release `name`, and returns the new commit. */
export const releaseShop = (repo: string, name: string): string => {
  put(repo, 'server.ts', server(name));
  git(repo, 'commit', '-q', '-am', `release ${name}`);

  return git(repo, 'rev-parse', 'HEAD');
};

/** What a prototype must leave as it was: status, branches, remotes, worktrees and HEAD. */
export const repoState = (repo: string) => ({
  status: git(repo, 'status', '--porcelain', '--untracked-files=all'),
  branches: git(repo, 'branch', '-a', '-v', '--no-abbrev'),
  remotes: git(repo, 'remote', '-v'),
  worktrees: git(repo, 'worktree', 'list', '--porcelain'),
  head: git(repo, 'rev-parse', 'HEAD'),
  refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
});
