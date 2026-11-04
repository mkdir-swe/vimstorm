/**
 * Docker compose for a local session's pack scripts, on the local Docker only. `abe run` hands a
 * script that may run compose its card's project (`COMPOSE_PROJECT_NAME`, `composeProject`), so
 * what its own `docker compose up` starts is that card's and no other's: its own containers and
 * volumes, its own data. Two cards verify side by side in their own projects; the ports inside
 * each stay as the compose file has them (Abe moves none). A Docker that is not a socket on this
 * machine (a `DOCKER_HOST` or a context on another host) is refused `compose-not-local` before
 * anything runs; the project goes down when the card's session ends. Rules only: Docker is the
 * `Compose` port's.
 */
import { COMPOSE_FILES, composePaths, parseEnvFile } from '../install/install-gate';
import { type DockerEndpoint } from '../ports';

/** The refusal code of compose aimed at a Docker that is not local. */
export const COMPOSE_NOT_LOCAL = 'compose-not-local';

/** The variable docker compose takes its project's name from. */
export const COMPOSE_PROJECT = 'COMPOSE_PROJECT_NAME';

/** The variables that point docker at a daemon: compose takes them from a `.env` beside it too. */
export const DOCKER_KEYS = ['DOCKER_HOST', 'DOCKER_CONTEXT'] as const;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

/**
 * The compose project of a card in a repo (`abe-shop-4`), or of a session with no card by its id:
 * lowercase letters, digits, dashes and underscores, as Docker takes it.
 */
export const composeProject = (repo: string, card: number | string): string => {
  const name = slug(repo.replace(/\/+$/, '').split('/').at(-1) ?? '');

  return ['abe', name, slug(String(card))]
    .filter((p) => p !== '')
    .join('-')
    .slice(0, 63);
};

/** Before's project beside a card's own: the merge base runs in its own containers too. */
export const baseComposeProject = (own: string): string => `${own.slice(0, 58)}-base`;

/**
 * The compose files a pack script may start, by path in its folder: those at the top, and those
 * where a script that runs docker compose changes into.
 */
export const composeFilesOf = (script: string): string[] => [
  ...new Set([...COMPOSE_FILES, ...composePaths(script).map((c) => c.path)]),
];

/** Whether a pack script may run compose: it runs docker compose, or a compose file is there. */
export const mayRunCompose = (script: string, found: readonly string[]): boolean =>
  composePaths(script).length > 0 || found.length > 0;

/** The `DOCKER_*` a compose `.env` sets that the script's own environment does not. */
export const dotEnvDocker = (
  env: Readonly<Record<string, string>>,
  dotEnv: string | undefined,
): Record<string, string> => {
  if (dotEnv === undefined) return {};
  const values = parseEnvFile(dotEnv);

  return Object.fromEntries(
    DOCKER_KEYS.flatMap((k) => {
      const v = values.get(k);

      return v === undefined || v === '' || (env[k] ?? '') !== '' ? [] : [[k, v]];
    }),
  );
};

/** A daemon's address with any user or password taken out (`ssh://host`). */
const shown = (host: string) => host.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');

const isLocal = (host: string) => /^unix:\/\/\/./.test(host);

/**
 * Why docker compose with `env` would not run locally, or null when it would: its `DOCKER_HOST`
 * when set (docker takes it over any context), else the context it names or the current one
 * (`context`; none: no Docker here, nothing remote). Only a unix socket is local.
 */
export const composeNotLocal = (
  env: Readonly<Record<string, string>>,
  context: DockerEndpoint | null,
): string | null => {
  const host = env.DOCKER_HOST ?? '';
  const fix = 'unset it, or use the local Docker (`docker context use default`)';

  if (host !== '')
    return isLocal(host)
      ? null
      : `docker compose runs locally only: DOCKER_HOST is ${shown(host)}, not a local socket; ${fix}`;
  if (context === null || isLocal(context.host)) return null;

  return `docker compose runs locally only: the docker context ${context.name} reaches ${shown(context.host)}, not a local socket; ${fix}`;
};

/** A compose file's published host port written as a number: where, and the item as written. */
export type FixedHostPort = { path: string; line: number; item: string };

/**
 * Whether a `ports:` item publishes a fixed host port: `"5432:5432"`, `127.0.0.1:8080:80`,
 * `8000-8010:8000-8010`. One from a variable (`${DB_PORT:-5432}:5432`), with no host side
 * (`"5432"`) or an empty one (`127.0.0.1::5432`) is not.
 */
const fixedShort = (item: string): boolean => {
  const text = item
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/(?:tcp|udp|sctp)$/, '');
  const rest = text.replace(/^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]*\]):/, '');

  if (rest.startsWith('$')) return false;
  const parts = rest.split(':');

  return parts.length >= 2 && /^\d+(?:-\d+)?$/.test(parts[0] ?? '');
};

/**
 * The published host ports a compose file at `path` writes as numbers (short `ports:` items and
 * long ones' `published:`): two cards verifying at once would both take them, so a pack publishes
 * from `ABE_PORT_BASE` (through a variable its start script sets) or not at all.
 */
export const fixedHostPorts = (path: string, text: string): FixedHostPort[] => {
  const out: FixedHostPort[] = [];
  const lines = text.split('\n');

  for (const [n, line] of lines.entries()) {
    const key = /^(\s*)ports\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);

    if (key === null) continue;
    const indent = (key[1] ?? '').length;
    const inline = key[2] ?? '';

    if (inline.startsWith('[')) {
      for (const item of inline.replace(/^\[|\]$/g, '').split(','))
        if (fixedShort(item))
          out.push({ path, line: n + 1, item: item.trim().replace(/^["']|["']$/g, '') });
      continue;
    }
    for (const [m, next] of lines.slice(n + 1).entries()) {
      if (next.trim() === '' || next.trim().startsWith('#')) continue;
      const at = next.length - next.trimStart().length;

      if (at < indent || (at === indent && !next.trimStart().startsWith('-'))) break;
      const item = /^\s*-\s*(.+?)\s*(?:#.*)?$/.exec(next)?.[1];
      const published = /^\s*(?:-\s*)?published\s*:\s*["']?(\d+(?:-\d+)?)["']?\s*(?:#.*)?$/.exec(
        next,
      )?.[1];

      if (published !== undefined)
        out.push({ path, line: n + m + 2, item: `published: ${published}` });
      else if (item !== undefined && fixedShort(item))
        out.push({ path, line: n + m + 2, item: item.replace(/^["']|["']$/g, '') });
    }
  }

  return out;
};

/** The warning for fixed published host ports, each by file and line; null: none. */
export const fixedHostPortsWarning = (found: readonly FixedHostPort[]): string | null =>
  found.length === 0
    ? null
    : `compose publishes fixed host ports (${found.map((f) => `${f.path}:${f.line} ${f.item}`).join(', ')}): two cards verifying at once clash on them; publish each from ABE_PORT_BASE (a variable start sets from it, "\${DB_PORT}:5432") or not at all`;

/**
 * Compose on a box (no Docker in a workspace, and never the box's socket in one): the box's serve
 * runs a workspace's `docker compose` on the box, in its card's own project, from the compose file
 * read in the workspace, and joins the workspace to the project's network so the app reaches its
 * services by name. A pack script in a workspace gets `docker` as this shim on its `PATH`: compose
 * goes through `abe compose`, anything else is said to be not there.
 */
export const DOCKER_SHIM = `#!/bin/sh
# docker in a box's workspace: docker compose runs on the box, in this card's own project (abe compose)
if [ "$1" = compose ]; then shift; exec abe compose --cwd "$PWD" -- "$@"; fi
echo "docker $1: no Docker in this workspace; docker compose runs on the box through abe compose" >&2
exit 127
`;

/** The network compose makes for a project's services: the workspace joins it. */
export const composeNetwork = (project: string): string => `${project}_default`;

/** The flags that would aim compose at another project, file or daemon: the box picks those. */
const OWN_FLAGS =
  /^(?:-p|--project-name|-f|--file|--project-directory|--env-file|-H|--host|--context|-c)(?:=|$)/;

/** A compose subcommand that starts services (the workspace joins its network after it). */
const STARTS = new Set(['up', 'start', 'restart', 'run', 'create']);

/**
 * The compose command a workspace asked for, as the box runs it: its subcommand (`up`, `down`),
 * or why not (a flag that picks the project, the file or the daemon, which are the box's).
 */
export const boxComposeArgs = (
  args: readonly string[],
): { ok: true; command: string; starts: boolean; stops: boolean } | { ok: false; why: string } => {
  const own = args.find((a) => OWN_FLAGS.test(a));

  if (own !== undefined)
    return {
      ok: false,
      why: `docker compose ${own} is the box's to set: it runs each card in its own project, from the workspace's compose file, on the box's Docker`,
    };
  const command = args.find((a) => !a.startsWith('-')) ?? '';

  return command === ''
    ? { ok: false, why: 'docker compose with no command: name one (up -d, down, ps, logs)' }
    : { ok: true, command, starts: STARTS.has(command), stops: command === 'down' };
};

/** A host path a compose file names that cannot be the clone's: where, and why. */
export type ComposePathOutside = { path: string; line: number; item: string; why: string };

/** Whether `rel` from folder `at` (both from the clone's top) stays in the clone. */
const staysIn = (at: string, rel: string): boolean => {
  const stack: string[] = [];

  for (const part of [...at.split('/'), ...rel.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part !== '..') stack.push(part);
    else if (stack.pop() === undefined) return false;
  }

  return true;
};

const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, '');

/** Why a host path from compose folder `at` is no clone path; null: it is one (or a name). */
const outsideWhy = (at: string, value: string, named: boolean): string | null => {
  const v = unquote(value);

  if (v === '' || v.startsWith('$')) return null;
  if (v.startsWith('/') || v.startsWith('~'))
    return "an absolute host path: on a box it is the box host's, not the clone's";
  // in a volume's short form a source with no `.` or `/` before it is a named volume
  if (named && !v.startsWith('.')) return null;

  return staysIn(at, v) ? null : 'up out of the clone: the box has only the clone';
};

/**
 * The host paths a compose file at `path` (from the clone's top) names that a box cannot give it
 * from the clone: a bind mount's source, a build context or an env file that is absolute or goes
 * up out of the clone. Relative ones in the clone are fine: the box runs compose in the clone.
 */
export const composePathsOutside = (path: string, text: string): ComposePathOutside[] => {
  const at = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const out: ComposePathOutside[] = [];
  const lines = text.split('\n');
  const say = (n: number, item: string, why: string | null) => {
    if (why !== null) out.push({ path, line: n + 1, item: unquote(item), why });
  };
  let volumesAt = -1;

  for (const [n, line] of lines.entries()) {
    const indent = line.length - line.trimStart().length;
    const body = line.trim().replace(/\s+#.*$/, '');

    if (body === '' || body.startsWith('#')) continue;
    if (volumesAt >= 0 && indent <= volumesAt && !body.startsWith('-')) volumesAt = -1;
    if (/^volumes\s*:\s*$/.test(body) && indent > 0) {
      volumesAt = indent;
      continue;
    }
    const scalar = /^(?:-\s*)?(source|build|context|env_file)\s*:\s*(\S.*)$/.exec(body);

    if (scalar !== null) {
      say(n, scalar[2] ?? '', outsideWhy(at, scalar[2] ?? '', false));
      continue;
    }
    const item = volumesAt >= 0 && indent > volumesAt ? /^-\s*(\S.*)$/.exec(body)?.[1] : undefined;

    if (item === undefined || /^[a-z_]+\s*:/.test(item)) continue;
    const short = unquote(item);
    const colon = short.indexOf(':');

    // `- /var/lib/data` alone is a path in the container: an anonymous volume
    if (colon > 0) say(n, short.slice(0, colon), outsideWhy(at, short.slice(0, colon), true));
  }

  return out;
};
