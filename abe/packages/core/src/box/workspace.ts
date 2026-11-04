/**
 * A card's box workspace on its repo's box (ADR 0022: one box per repo, a workspace per card on
 * it). On the box, `abe workspace up` makes it from these rules: the repo's workspace image, the
 * clone on the card's branch in a volume of its own on the box's disk, a database of its own in
 * the box's one Postgres, and the box's `serve` reached through a socket folder of its own mounted
 * at `/run/abe`. `serve` runs them through the Docker and Mirrors ports.
 */
import { z } from 'zod';
import { BoxLoad, boxLoadText } from './box-load';
import { type ContainerSpec, type Image } from '../ports';
import { ABE_ENVS, abeEnvFile } from '../install/credentials';
import { REPO_PATH } from '../layer/settings/places';
import { REPO_SKILLS_DIR } from '../repo-hooks';

/** The core base image every workspace image builds on (`abe/images/build.sh`). */
export const BASE_IMAGE = 'abe-base:latest';

/** The base image's user (the node image's uid 1000, renamed). */
export const SESSION_USER = 'abe';

export const POSTGRES_IMAGE = 'postgres:17-alpine';

/** Where a repo keeps its workspace image's Dockerfile (#60). */
export const IMAGE_DIR = '.abe/session';

/** Where the workspace's socket directory is mounted, as the base image's `ABE_SOCKET` says. */
export const SOCKET_MOUNT = '/run/abe';

/** Where the workspace volume (the clone at `repo/`, its `.scratch`) is mounted. */
export const WORKSPACE_MOUNT = '/workspace';

/** The box's own containers, volumes and network: one each, however many workspaces it holds. */
export const NAMES = {
  /** Postgres' network (a 2.2 workspace reaches it there over TCP); each workspace has its own. */
  network: 'abe-net',
  postgres: 'abe-pg',
  postgresVolume: 'abe-pg-data',
  /** Postgres' socket folder, shared with every workspace (#67). */
  postgresSocket: 'abe-pg-socket',
} as const;

/** What one box workspace is made of on its box, by name. */
export type WorkspaceNames = {
  container: string;
  /** The clone's volume, mounted at `WORKSPACE_MOUNT`. */
  volume: string;
  /** Its database in the box's Postgres, and the role of the same name that alone reaches it. */
  database: string;
  /** Its socket folder under the box's state directory (mounted at `SOCKET_MOUNT`). */
  socketDir: string;
  /**
   * Its own bridge network: no other card's container is reached on it (ports, dev servers);
   * Postgres is reached over its socket, outside it.
   */
  network: string;
};

/** Every card's workspace's names start with it (container, volume, network). */
export const WORKSPACE_PREFIX = 'abe-ws-';

/** The card a workspace's container or volume names (`abe-ws-<card>`), else undefined. */
export const cardOfWorkspace = (name: string): string | undefined =>
  name.startsWith(WORKSPACE_PREFIX) ? parseCard(name.slice(WORKSPACE_PREFIX.length)) : undefined;

/**
 * A card's workspace on its repo's box (ADR 0022): container and volume `abe-ws-<card>`, database
 * and role `ws_<card>` (lowercase, `-` as `_`: a Postgres name unquoted), socket folder
 * `workspaces/<card>`. `card` is a parsed card id (`parseCard`).
 */
export const workspaceNames = (card: string): WorkspaceNames => ({
  container: `${WORKSPACE_PREFIX}${card}`,
  volume: `${WORKSPACE_PREFIX}${card}`,
  database: `ws_${card.toLowerCase().replaceAll('-', '_')}`,
  socketDir: `workspaces/${card}`,
  network: `${WORKSPACE_PREFIX}${card}`,
});

/**
 * The one workspace of a 2.2 box (an old box, made for one card): its fixed names, still
 * recognised by `workspace up` and the sessions there, never given to a new workspace.
 */
export const LEGACY_NAMES: WorkspaceNames = {
  container: 'abe-workspace',
  volume: 'abe-workspace',
  database: 'workspace',
  socketDir: 'workspace',
  network: 'abe-net',
};

/**
 * The card a session on a box belongs to, from its id (`<card>-<4 hex>`, as serve's and the
 * Mac's launches make them): which workspace's container its terminal, files and git are in.
 */
export const cardOfSession = (id: string): string | undefined =>
  /^([A-Za-z0-9][A-Za-z0-9-]{0,39})-[0-9a-f]{4}$/.exec(id)?.[1];

/** Docker labels on what `workspace up` makes. */
export const LABEL = {
  role: 'abe.role',
  repo: 'abe.repo',
  card: 'abe.card',
  branch: 'abe.branch',
  /** On the workspace container: the id of the image it was made from. */
  imageId: 'abe.image.id',
  /** On a workspace image: the tree of the repo's `.abe/session` it was built from. */
  imageTree: 'abe.image.tree',
  /** On a workspace image: the id of the base image it was built on. */
  baseId: 'abe.base.id',
  /** On the box's Postgres and the workspace: made with the shared socket (one from before is made again). */
  pgSocket: 'abe.pg.socket',
  /** On the workspace: the AppArmor profile it was made under (one under another is made again). */
  apparmor: 'abe.apparmor',
  /** On the workspace: its system paths unmasked (one with Docker's masks is made again). */
  systemPaths: 'abe.systempaths',
  /** On the base image: the abe release it was built with (`images/build.sh`, `workspace up`). */
  abeVersion: 'abe.version',
  /** On the base image: the sha256 of the abe binary in it. */
  abeHash: 'abe.hash',
} as const;

/**
 * The abe installed on a box: its release's version (`/opt/abe/version`) and its binary's
 * sha256. The base image carries both as labels, so an upgrade is seen and the base built anew.
 */
export type AbeRelease = { version: string; hash: string };

/** The base image's labels for `release`. */
export const baseLabels = (release: AbeRelease): Record<string, string> => ({
  [LABEL.abeVersion]: release.version,
  [LABEL.abeHash]: release.hash,
});

const labelOf = (image: Image, key: string) =>
  Object.hasOwn(image.labels, key) ? image.labels[key] : undefined;

/**
 * What `workspace up` does with the base image (#62): `reuse` the one labelled with the installed
 * release, `build` it when missing or built by another abe (one from before the labels has no
 * `abe-run` user); a serve that knows no release (none installed on this machine) uses the one
 * there is, or has none (`missing`).
 */
export const basePlan = (
  have: Image | undefined,
  release: AbeRelease | undefined,
): 'reuse' | 'build' | 'missing' => {
  if (release === undefined) return have === undefined ? 'missing' : 'reuse';
  if (have === undefined) return 'build';

  return labelOf(have, LABEL.abeVersion) === release.version &&
    labelOf(have, LABEL.abeHash) === release.hash
    ? 'reuse'
    : 'build';
};

/**
 * Whether the repo's workspace image is current: built from this `.abe/session` tree on this
 * base image (a base built anew means the workspace image is built again after it).
 */
export const workspaceImageCurrent = (
  have: Image | undefined,
  tree: string,
  baseId: string,
): boolean =>
  have !== undefined &&
  labelOf(have, LABEL.imageTree) === tree &&
  labelOf(have, LABEL.baseId) === baseId;

/** Where Postgres puts its socket, and where the workspace sees it (libpq's own default folder). */
export const PG_SOCKET_DIR = {
  postgres: '/var/run/postgresql',
  workspace: '/run/postgresql',
} as const;

export const WorkspaceState = z.enum(['running', 'stopped', 'failed']);
export type WorkspaceState = z.infer<typeof WorkspaceState>;

/** A box workspace, as `abe workspace up|status` and its box's own `abe status` show it. */
export const WorkspaceData = z.object({
  repo: z.string(),
  card: z.string(),
  branch: z.string(),
  state: WorkspaceState,
  container: z.string(),
  image: z.string(),
  /** Its database in the box's Postgres (`DATABASE_URL` inside, password never shown). */
  database: z.string(),
  /**
   * Whether the container runs the newest workspace image. A newer one waits while someone is
   * attached or a session runs; the next `up` with nobody there switches to it.
   */
  imageCurrent: z.boolean(),
  /** Who the clone's commits are authored as (`up` sets it from the person's GitHub login, #67). */
  author: z.string().optional(),
});
export type WorkspaceData = z.infer<typeof WorkspaceData>;

export const workspaceText = (w: WorkspaceData): string =>
  `${w.repo} card ${w.card} on ${w.branch}: ${w.state} (${w.container}, database ${w.database})\n`;

/**
 * Every workspace on the box (`abe workspace status`, `abe workspace up --all`), by card; with
 * `status`, the box's load too (none when it could not be read).
 */
export const WorkspaceList = z.object({
  workspaces: z.array(WorkspaceData),
  load: BoxLoad.optional(),
});
export type WorkspaceList = z.infer<typeof WorkspaceList>;

export const workspaceListText = (l: WorkspaceList): string =>
  [
    l.workspaces.length === 0
      ? 'no workspaces on this box\n'
      : l.workspaces.map(workspaceText).join(''),
    l.load === undefined ? '' : boxLoadText(l.load),
  ].join('');

/** `abe workspace up`: the card's workspace, or with `--all` every one on the box. */
export const WorkspaceUp = z.union([WorkspaceData, WorkspaceList]);
export type WorkspaceUp = z.infer<typeof WorkspaceUp>;

export const workspaceUpText = (u: WorkspaceUp): string =>
  'workspaces' in u ? workspaceListText(u) : workspaceText(u);

/** `abe workspace rm <card>`: the workspace's container, volume and database gone. */
export const WorkspaceRemoved = z.object({ card: z.string(), removed: z.literal(true) });
export type WorkspaceRemoved = z.infer<typeof WorkspaceRemoved>;

export const workspaceRemovedText = (r: WorkspaceRemoved): string =>
  `removed the workspace of card ${r.card}: its container, clone and database\n`;

const CARD = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;

/** A card's id as a branch and a label carry it: letters, digits and `-`. */
export const parseCard = (text: string): string | undefined => (CARD.test(text) ? text : undefined);

/** Up to 5 lowercase ascii words of a title, joined by `-` (old Abe's `slugOf`). */
export const slugOf = (title: string): string =>
  title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((part) => part !== '')
    .slice(0, 5)
    .join('-');

/** `card/<id>-<slug>`, or `card/<id>` for a title with no words (or none given). */
export const cardBranch = (card: string, title?: string): string => {
  const slug = title === undefined ? '' : slugOf(title);

  return slug === '' ? `card/${card}` : `card/${card}-${slug}`;
};

/** The repo's workspace image on the box. */
export const workspaceImage = (repo: string): string =>
  `abe-workspace-${repo.replace('/', '-').toLowerCase()}:latest`;

/** Docker's container state as the workspace's. */
export const stateOf = (docker: string): WorkspaceState => {
  if (docker === 'running' || docker === 'restarting') return 'running';
  if (docker === 'created' || docker === 'exited') return 'stopped';

  return 'failed';
};

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** What the clone script's exit 3 means: no clone in the volume and no mirror to make one. */
export const NO_CLONE = 3;

/**
 * The workspace container's AppArmor profile (`images/box/apparmor/abe-workspace`, loaded on the
 * box host by `images/box/apparmor.sh` at boot): Docker's docker-default, whose `deny mount`
 * keeps Claude Code's sandbox (bubblewrap) from building its root, with only bubblewrap's mounts
 * allowed (#67).
 */
export const WORKSPACE_APPARMOR = 'abe-workspace';

/**
 * The workspace container's system paths (`--security-opt systempaths=unconfined`): Docker's masks
 * over /proc (`/proc/kcore`, `/proc/sys`, …) stop a fresh /proc being mounted in a user namespace,
 * so a box session's jail (bwrap's `--proc`, its own pid namespace) would start no command. The
 * container's user still has no capability and abe-workspace's /proc rules.
 */
export const WORKSPACE_SYSTEM_PATHS = 'unconfined';

/** Claude Code's folder for its settings writes in a project's `.claude` (2.1.309). */
const CLAUDE_WRITES = '.cc-writes';

/** Claude Code's files in `.claude` the script user never reads (the local settings, a login). */
const CLAUDE_PRIVATE = '\\( -name settings.local.json -o -name .credentials.json \\)';

/**
 * Claude Code's project settings folder for the script user (#67): readable, so a check that walks
 * the tree (`eslint .`) reads it, and never writable but by the session's user (its hooks,
 * `apiKeyHelper` and status line would run outside the sandbox as that user); its own group, not
 * the shared one; the local settings file and any login the session's user's alone, made so
 * before anything is widened. A link in its place is taken away and nothing is followed (`find`,
 * never `chmod -R`, which follows a link it is given), so no mode reaches past it. `dir` is a
 * shell word (quoted by the caller, or a variable's). Files Claude Code writes there later get
 * the session's umask: readable until the next `up`.
 */
export const claudeFolderShell = (dir: string): string =>
  [
    `{ [ ! -L ${dir} ] || rm -f ${dir}; }`,
    `mkdir -p ${dir}`,
    `[ ! -L ${dir} ]`,
    // Made ahead: Claude Code makes its settings writes' folder 0700 (an existing one keeps its
    // mode), and a check walking the tree as the script user stops on it (eslint ., EACCES).
    `{ [ -L ${dir}/${CLAUDE_WRITES} ] || mkdir -p ${dir}/${CLAUDE_WRITES}; }`,
    `find ${dir} -type f ${CLAUDE_PRIVATE} -exec chmod 600 {} +`,
    `find ${dir} ! -type l -exec chgrp "$(id -g)" {} +`,
    `find ${dir} -type d -exec chmod u+rwx,go-w,go+rx,g-s {} +`,
    `find ${dir} -type f ! ${CLAUDE_PRIVATE} -exec chmod u+rw,go-w,go+r {} +`,
  ].join(' && ');

/** The group the session's user shares the workspace volume with its script user in (#67). */
export const RUN_GROUP = 'abe-work';

/** What the script user may never write or enter: git's own files and Claude Code's settings. */
const PRUNED =
  '\\( -path /workspace/repo/.git -o -path /workspace/repo/.claude -o -path /workspace/repo-base \\) -prune';

/**
 * The volume shared with the workspace's script user (#67, `CONTAINER.runUser`), on every `up`:
 * - git's files the session user's alone (`core.sharedRepository 0644`: git writes them so
 *   whatever the umask), so the script user never sets a config, hook or fsmonitor that the
 *   session's or serve's own git would run;
 * - Claude Code's project settings (`.claude`) readable but never writable for the script user
 *   (`claudeFolderShell`);
 * - `/workspace` and the clone sticky, so the script user renames or replaces none of the session
 *   user's entries there (the clone, Before's worktree, the setup mark, `.git`, `.claude`);
 * - once per volume (a mark), what the session's user owns from before given to the group,
 *   group-writable, folders setgid; links are not followed and the pruned folders kept out.
 * Only on an image that has the group (an older base has none).
 */
const shareScript = [
  `if getent group ${RUN_GROUP} >/dev/null 2>&1; then`,
  `  [ -e /workspace/.abe-shared ] || { find /workspace -xdev ${PRUNED} -o ! -type l -user "$(id -u)" \\( ! -group ${RUN_GROUP} -o ! -perm -g=rw \\) -exec chgrp -h ${RUN_GROUP} {} + -exec chmod g+rwX {} + ; find /workspace -xdev ${PRUNED} -o -type d -user "$(id -u)" ! -perm -g+s -exec chmod g+s {} + ; : > /workspace/.abe-shared; } || true`,
  '  git -C /workspace/repo config core.sharedRepository 0644',
  '  chmod -R go-w /workspace/repo/.git',
  // Sticky first: the script user replaces no entry of the session user's while .claude is made.
  '  chmod +t /workspace /workspace/repo',
  `  ${claudeFolderShell('/workspace/repo/.claude')}`,
  'fi',
];

/**
 * Run once per `up` in the workspace image, the volume at `/workspace` and (with `mirror`) the
 * box's mirror at `/src.git`. A clone already there is kept as it is; otherwise one is made aside
 * on the card's branch (the remote's when it has one), `origin` pointed at GitHub and `.scratch`
 * kept out of git, then moved into place, so a box stopped half way leaves no half clone; then
 * shared with the script user (`shareScript`). Its last line is the clone's branch.
 */
/**
 * What Claude Code's sandbox (bubblewrap) keeps read-only in the session's folder, the clone's
 * root (its sandbox-runtime's dangerous files and folders, as Claude Code 2.1.309 has them; the
 * ones inside `.git` stay there). One that is missing gets an empty mount point the sandbox makes
 * itself (a file, read-only), which git sees as untracked: an agent cannot write any of them.
 */
export const SANDBOX_PLACEHOLDERS = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.vscode',
  '.idea',
  '.claude/commands',
  '.claude/agents',
] as const;

/**
 * What decides a box session's reach in each tree it works in (ADR 0029, 0030), from the tree's
 * top: the repo's settings, yours, the Abe env files. The jail (`boxJailScript`) holds each
 * read-only; one that is missing it binds over an empty mount point it makes itself (a file,
 * read-only, which git sees as untracked), so no command makes it.
 */
export const JAIL_PLACEHOLDERS: readonly string[] = [
  REPO_PATH,
  '.abe/settings.local.yaml',
  ...ABE_ENVS.map(abeEnvFile),
];

/**
 * Claude Code's own folder in the clone (its settings writes, writers' worktrees, the sandbox's
 * names there, #67): untracked files in it are never the card's work, so a `git status` shows the
 * agent nothing to ignore in the repo itself; a file the repo tracks there is still seen. Its
 * skills (`REPO_SKILLS_DIR`) are the team's: a card's new one is its work, seen and committed (one
 * the Mac has not committed is the sync's to keep out, `BOX_SYNC_SCRIPT`).
 */
const CLAUDE_FOLDER = ['/.claude/*', `!/${REPO_SKILLS_DIR}/`];

/** The whole folder, as a clone made before 3.2.2 has it: it hid a card's new skills too. */
const CLAUDE_FOLDER_WAS = '/.claude/';

/**
 * The sandbox's placeholders, the jail's (`JAIL_PLACEHOLDERS`) and Claude Code's folder in the
 * clone at `repo` kept out of git (its `info/exclude`, anchored at the root, so a repo's own nested
 * ones stay seen; Before's worktree shares it), so a `git add -A` never commits them; each line
 * once, however often it runs (the folder's earlier line, `CLAUDE_FOLDER_WAS`, taken out). A file
 * the repo tracks is still seen.
 */
export const excludePlaceholders = (repo: string): string[] => {
  const exclude = quoted(`${repo}/.git/info/exclude`);
  const aside = quoted(`${repo}/.git/info/exclude.abe`);
  const was = quoted(CLAUDE_FOLDER_WAS);

  return [
    `mkdir -p ${quoted(`${repo}/.git/info`)}`,
    `if grep -qxF ${was} ${exclude} 2>/dev/null; then grep -vxF ${was} ${exclude} > ${aside} || true; cat ${aside} > ${exclude}; rm -f ${aside}; fi`,
    `for p in ${[...[...SANDBOX_PLACEHOLDERS, ...JAIL_PLACEHOLDERS].map((name) => `/${name}`), ...CLAUDE_FOLDER].map(quoted).join(' ')}; do grep -qxF "$p" ${exclude} 2>/dev/null || printf '%s\\n' "$p" >> ${exclude}; done`,
  ];
};

export const cloneScript = (
  repo: string,
  branch: string,
  mirror: boolean,
  /** A prototype's clone (`proto/…`): this pre-push hook refuses every push from it. */
  prePush?: string,
): string =>
  [
    'set -e',
    // Shared with the script user (#67): what the clone makes is writable for its group too.
    'umask 002',
    'if [ ! -d /workspace/repo/.git ]; then',
    ...(mirror
      ? [
          'rm -rf /workspace/.clone',
          // The mirror is the box's (another uid). upload-pack heeds only global config; this
          // one-shot container's home goes with it.
          'git config --global --add safe.directory /src.git',
          'git clone -q /src.git /workspace/.clone',
          'cd /workspace/.clone',
          `if git rev-parse -q --verify ${quoted(`refs/remotes/origin/${branch}`)} >/dev/null; then git checkout -q ${quoted(branch)}; else git checkout -q -b ${quoted(branch)}; fi`,
          `git remote set-url origin ${quoted(`https://github.com/${repo}.git`)}`,
          'mkdir -p .scratch',
          "echo '.scratch/' >> .git/info/exclude",
          ...(prePush === undefined
            ? []
            : [
                `printf '%s' ${quoted(prePush)} > .git/hooks/pre-push`,
                'chmod 755 .git/hooks/pre-push',
              ]),
          'cd /',
          'mv /workspace/.clone /workspace/repo',
        ]
      : [`  echo 'no clone in the workspace and no mirror of ${repo}' >&2`, `  exit ${NO_CLONE}`]),
    'fi',
    ...excludePlaceholders('/workspace/repo'),
    ...shareScript,
    'git -C /workspace/repo branch --show-current',
  ].join('\n');

/** The clone's branch from the clone script's output. */
export const branchOf = (stdout: string): string | undefined =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);

const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

const databaseName = (db: string) => {
  if (!DATABASE_NAME.test(db)) throw new Error(`not a workspace database name: ${db}`);

  return db;
};

/**
 * The workspace's role and database `db` (its `WorkspaceNames.database`), made when missing
 * (psql's `\gexec`), the role's password set to `password`, the database closed to every other
 * role (another workspace's too) and `postgres` closed to it.
 */
export const databaseSql = (password: string, db: string): string => {
  if (!/^[0-9a-f]{16,}$/.test(password)) throw new Error('a database password is hex');
  databaseName(db);

  return [
    `SELECT 'CREATE ROLE ${db} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${db}')\\gexec`,
    `ALTER ROLE ${db} LOGIN PASSWORD '${password}';`,
    `SELECT 'CREATE DATABASE ${db} OWNER ${db}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\\gexec`,
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
    // The box's maintenance databases too: the workspace reaches its own database only.
    'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;',
    'REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;',
  ].join('\n');
};

/**
 * A removed workspace's database and role (`abe workspace rm`): its connections ended first,
 * nothing left of it in the box's Postgres.
 */
export const dropDatabaseSql = (db: string): string =>
  [`DROP DATABASE IF EXISTS ${databaseName(db)} WITH (FORCE);`, `DROP ROLE IF EXISTS ${db};`].join(
    '\n',
  );

/** Asked inside the container: one `c` line per attached tmux client, one `p <command>` per pane. */
export const ACTIVITY_PROBE = [
  'sh',
  '-c',
  "tmux list-clients -F c 2>/dev/null; tmux list-panes -a -F 'p #{pane_current_command}' 2>/dev/null; true",
];

/** Someone attached, or a session (`claude`) running: the container is not replaced under them. */
export const isBusy = (probe: string): boolean =>
  probe.split('\n').some((l) => l === 'c' || l === 'p claude');

/**
 * The workspace's database over Postgres' unix socket (#67): Claude Code's sandbox lets a command
 * reach no TCP host but its proxy's, and any unix socket (`allowAllUnixSockets`).
 */
export const databaseUrl = (password: string, db: string): string =>
  `postgresql://${databaseName(db)}:${password}@/${db}?host=${PG_SOCKET_DIR.workspace}`;

/**
 * Who reaches the box's Postgres (`pg_hba.conf`, written on every `up`): its superuser only by
 * peer, as `docker exec --user postgres` in its container (the workspace's uid is no `postgres`
 * there), each workspace's role only the database of its own name (`ws_<card>`: `sameuser`) with
 * its password over the socket, a 2.2 workspace made before the socket its own over TCP, no one
 * else: one card's database is never another's to reach (ADR 0022).
 */
export const PG_HBA = [
  '# Written by abe workspace up (#67, ADR 0022).',
  'local all postgres peer',
  'local sameuser all scram-sha-256',
  'local all all reject',
  // A 2.2 workspace made before the socket keeps its TCP URL until it is made again (nobody in it).
  `host ${LEGACY_NAMES.database} ${LEGACY_NAMES.database} all scram-sha-256`,
  'host all all all reject',
  '',
].join('\n');

/** The box's one Postgres: only on the box network, back after a crash or the box's start. */
export const postgresSpec = (password: string): ContainerSpec => ({
  name: NAMES.postgres,
  image: POSTGRES_IMAGE,
  labels: { [LABEL.role]: 'postgres', [LABEL.pgSocket]: '1' },
  // Only for the image's first start; serve speaks to it as postgres over its own socket (peer).
  env: { POSTGRES_PASSWORD: password },
  mounts: [
    { type: 'volume', source: NAMES.postgresVolume, target: '/var/lib/postgresql/data' },
    { type: 'volume', source: NAMES.postgresSocket, target: PG_SOCKET_DIR.postgres },
  ],
  network: NAMES.network,
  // Every workspace's database (ADR 0022: 1 GB for the box's one Postgres).
  limits: { memory: '1g', pids: 512, shm: '128m' },
  restart: 'unless-stopped',
});

export type WorkspaceSpecInput = {
  /** Its container, volume and database (`workspaceNames`, or a 2.2 box's `LEGACY_NAMES`). */
  names: WorkspaceNames;
  repo: string;
  card: string;
  branch: string;
  image: string;
  imageId: string;
  /** The box's directory holding the socket the workspace reaches `serve` on (its own). */
  socketDir: string;
  /** The box's seccomp profile: Docker's default plus what Chromium's sandbox needs (#66). */
  seccomp: string;
  databaseUrl: string;
};

/**
 * The workspace container: hardened (no capabilities, no new privileges, Chromium's seccomp
 * profile; AppArmor's abe-workspace: docker-default with only the mounts Claude Code's sandbox makes;
 * its system paths unmasked, so the jail mounts its own /proc), bounded (3 GB hard: the 1.5 GB idle target is measured, LSP + Chrome + dev servers
 * must fit; CPU shared equally, Docker's default), on a bridge network of its own (no other card's
 * container reached on it; never the host's: the box's metadata rule covers bridged traffic
 * only), started again by `workspace up` on every box start, and a tmux server waiting at the clone.
 */
export const workspaceSpec = (w: WorkspaceSpecInput): ContainerSpec => ({
  name: w.names.container,
  hostname: 'workspace',
  image: w.image,
  argv: ['bash', '-c', 'tmux new-session -d -s main -c /workspace/repo; exec sleep infinity'],
  labels: {
    [LABEL.role]: 'workspace',
    [LABEL.repo]: w.repo,
    [LABEL.card]: w.card,
    [LABEL.branch]: w.branch,
    [LABEL.imageId]: w.imageId,
    [LABEL.pgSocket]: '1',
    [LABEL.apparmor]: WORKSPACE_APPARMOR,
    [LABEL.systemPaths]: WORKSPACE_SYSTEM_PATHS,
  },
  env: { DATABASE_URL: w.databaseUrl, ABE_WORKSPACE: w.card },
  mounts: [
    { type: 'volume', source: w.names.volume, target: WORKSPACE_MOUNT },
    // Read-only: connecting to a socket needs no write, and nothing inside plants a file for serve.
    { type: 'bind', source: w.socketDir, target: SOCKET_MOUNT, readOnly: true },
    {
      type: 'volume',
      source: NAMES.postgresSocket,
      target: PG_SOCKET_DIR.workspace,
      readOnly: true,
    },
  ],
  network: w.names.network,
  workdir: '/workspace/repo',
  limits: { memory: '3g', pids: 1024, shm: '256m' },
  hardened: true,
  seccomp: w.seccomp,
  // Claude Code's sandbox (bwrap) mounts in its own user namespace, which docker-default denies.
  apparmor: WORKSPACE_APPARMOR,
  // A box session's jail mounts its own /proc, which Docker's masked paths deny.
  systemPaths: WORKSPACE_SYSTEM_PATHS,
  // No restart policy: Docker would bring it back on a box start before abe-workspace is checked
  // (AppArmor off = no profile at all). `workspace up` runs on every start and starts it after.
});
