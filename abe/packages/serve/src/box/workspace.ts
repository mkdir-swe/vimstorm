/**
 * The box's workspaces (ADR 0022: the repo's box, one workspace per card on it), run by the
 * box's `serve` through the Docker and Mirrors ports: `abe workspace up` (idempotent; `--all` at
 * the box's start and every wake), `abe workspace status`, `abe workspace rm`, and each
 * workspace's own socket folder it reaches `serve` on. A 2.2 box's one workspace (`abe-workspace`,
 * an old box) is still recognised under its fixed names.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  PRE_PUSH_HOOK,
  PROTOTYPE_BRANCH_PREFIX,
  type AbeRelease,
  SETTINGS,
  ACTIVITY_PROBE,
  type BoxHost,
  type BoxLoad,
  boxLoadOf,
  type CpuTimes,
  diskGrowth,
  LOAD_READ_EVERY_MS,
  BASE_IMAGE,
  baseLabels,
  basePlan,
  type Browser,
  browserMcpConfig,
  branchOf,
  cardBranch,
  cloneScript,
  cardOfSession,
  cardOfWorkspace,
  CONTAINER,
  type Container,
  databaseSql,
  databaseUrl,
  type Docker,
  dropDatabaseSql,
  gitAuthor,
  type Logins,
  type Handlers,
  type Image,
  IMAGE_DIR,
  isBusy,
  LABEL,
  LEGACY_NAMES,
  WORKSPACE_APPARMOR,
  WORKSPACE_SYSTEM_PATHS,
  SESSION_SOCKETS,
  type Mirrors,
  NAMES,
  NO_CLONE,
  type Outcome,
  PACK_SCRIPT_TIMEOUT_MS,
  packScript,
  parseCard,
  parseRepo,
  PG_HBA,
  postgresSpec,
  refused,
  type RunData,
  SESSION_USER,
  stateOf,
  type WorkspaceData,
  type WorkspaceList,
  type WorkspaceNames,
  type WorkspaceRelays,
  type WorkspaceRemoved,
  type WorkspaceStep,
  type WorkspaceStepData,
  buildStepOf,
  workspaceImage,
  workspaceImageCurrent,
  workspaceNames,
  workspaceSpec,
  baseComposeProject,
  boxComposeArgs,
  type Compose,
  COMPOSE_FILES,
  COMPOSE_NOT_LOCAL,
  composeNetwork,
  composeNotLocal,
  composePathsOutside,
  composeProject,
  DOCKER_SHIM,
  DEFAULT_HOOKS,
  RepoHooks,
  runScriptsWords,
  AbeEnv,
  ABE_ENVS,
  abeEnvFile,
  envNotEnabled,
  injectedSecrets,
  parseEnvFile,
  redactText,
  SYNC_DIR,
} from '@abe/core';
import {
  type ContainerExec,
  containerExec,
  type Listener,
  runPackScript,
  workspaceGhLogin,
  workspaceGit,
} from '@abe/ports';
import { type LocalApps } from '../local-mode/local-apps';
import { type Sessions } from '../session/sessions';
import seccompProfile from './seccomp-chromium.json';

/**
 * The namespace flags Docker's default profile masks clone / unshare with (CLONE_NEWNS |
 * CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET):
 * named in the JSON, the number written into the profile Docker reads.
 */
const CLONE_NAMESPACE_FLAGS = 0x7e020000;

/** The seccomp profile as Docker reads it. */
const seccompText = (): string =>
  JSON.stringify(seccompProfile).replaceAll(
    '"CLONE_NAMESPACE_FLAGS"',
    String(CLONE_NAMESPACE_FLAGS),
  );

export type BoxOptions = {
  /**
   * Where the box keeps its seccomp profile and each workspace's socket folder
   * (`workspaces/<card>/serve.sock`; an old box's `workspace/serve.sock`).
   */
  dir: string;
  docker: Docker;
  mirrors: Mirrors;
  /** Waits between Postgres readiness checks. */
  sleep: (ms: number) => Promise<void>;
  /** A workspace container's headless Chromium (#66); without it `abe browser` is refused. */
  browserOf?: (container: string) => Browser;
  /** How often its DevTools is read for activity (default `BROWSER.pollMs`). */
  browserPollMs?: number;
  /** What serve says in serve.log: a mirror that could not be fetched. */
  log?: (message: string) => void;
  /** `up` at its next step (#142): said as `workspace.step`, which the Mac's launch follows. */
  step?: (data: WorkspaceStepData) => void;
  /** Where the clone is inside the container (the base image's; a test's stand-in names its own). */
  workdir?: string;
  /**
   * The box owner's logins: a serve started again on a box with a workspace logs the
   * container's `gh` in with their GitHub login (no launch needed for the pr stage's `gh`).
   */
  logins?: Logins;
  /**
   * The abe installed on the box, which `up` builds the base image from when it is missing or
   * labelled with another release (#62): `dir` holds its Dockerfile (`/opt/abe/images/base`),
   * `bin` the linux abe baked in as its last layer, `nvim` VimStorm's config the release ships
   * (`/opt/abe/nvim`, #89; none: the image gets Neovim alone). Without it the base is what is there.
   */
  base?: { dir: string; bin: string; nvim?: string; release: AbeRelease };
  /** Which container each card's workspace is, shared with the box serve's routers; kept fresh here. */
  directory?: WorkspaceDirectory;
  /** A card's workspace removed: what serve keeps for it goes too (its browser). */
  removed?: (card: string) => void;
  /**
   * Docker compose on the box for its workspaces' pack scripts, with the environment it runs in;
   * none: a workspace's compose is refused `no-compose`.
   */
  compose?: { compose: Compose; env: Readonly<Record<string, string>> };
  /**
   * The box's own machine: its load read at most every `LOAD_READ_EVERY_MS` (`loadEveryMs`), and
   * its root disk grown when the workspaces fill it, up to `maxDiskGb()` (`limits.maxBoxDisk`).
   * Without it the box says no load.
   */
  host?: BoxHost;
  maxDiskGb?: () => number;
  loadEveryMs?: number;
  /** Now, in ms (the load's time, the growth's 6 h). */
  now?: () => number;
  /**
   * Serve's relays into the workspaces (#16, `abe workspace relay`) and how often it looks at
   * what listens in them (default `PORTS_EVERY_MS`); without relays `abe workspace relay` is refused.
   */
  relays?: WorkspaceRelays;
  portsEveryMs?: number;
};

export type Box = {
  /** `github`: the person's GitHub token, for the clone's commit author (`gitAuthor`). */
  up: (a: {
    repo: string;
    card: string;
    title?: string;
    /** In place of the title's: the clone's branch (a prototype's `proto/…`, its pushes refused). */
    branch?: string;
    github?: string;
  }) => Promise<Outcome<WorkspaceData>>;
  /**
   * Every workspace on the box brought back (`abe workspace up --all`, the box's start): each
   * one up again as its labels say. One that fails is said and the rest still come back; the
   * answer is then that refusal.
   */
  upAll: (a: { github?: string }) => Promise<Outcome<WorkspaceList>>;
  /** Every workspace on the box, by card; none before the first `up`. */
  list: () => Promise<WorkspaceData[]>;
  /** The card's workspace, or `undefined` before its first `up`. */
  get: (card: string) => Promise<WorkspaceData | undefined>;
  /** Each running workspace's card, container (an old box's `abe-workspace` too) and clone (#16). */
  running: () => Promise<{ card: string; container: string; workdir: string }[]>;
  /**
   * What the box has left (ADR 0022), read at most every `loadEveryMs`; a read that finds the
   * root disk under 20 % free grows it first. None without a host, or when it cannot be read.
   */
  load: () => Promise<BoxLoad | undefined>;
  /**
   * The card's workspace removed (Done's clear, Remove workspace…): its container, clone volume,
   * database and socket folder. Refused while anything in the clone is uncommitted or unpushed,
   * or while someone is in it (a session runs, a terminal attached).
   */
  rm: (card: string, how?: { workChecked?: boolean }) => Promise<Outcome<WorkspaceRemoved>>;
  /** The card's workspace container's own values of `names` (its `DATABASE_URL`), as it runs now. */
  inherited: (card: string, names: readonly string[]) => Promise<Record<string, string>>;
  /**
   * The box's checkout of `repo` at its default branch (fetched first when GitHub answers): where
   * a run's settings are read, never the workspace's clone, which the agent writes (#67).
   */
  checkout: (repo: string) => Promise<Outcome<string>>;
  /**
   * `abe run`: a Verification pack script in the card's workspace as its script user (#67), with
   * `env`'s values the Mac synced there (3.2.1: its Abe env file and aws keys; dev's when none is
   * asked and dev's are there), redacted from what it says. One asked that is not there (off for
   * agents, or nothing on the Mac) is refused.
   */
  script: (
    card: string,
    path: string,
    args: readonly string[],
    env?: string,
  ) => Promise<Outcome<RunData>>;
  /**
   * The repo's hook points the Mac handed with its sync (`SessionSync.hooks`, its committed
   * `abe.yaml`'s), kept beside the box's workspaces: what `script` takes, never the clone's.
   */
  handHooks: (repo: string, hooks: RepoHooks) => Promise<void>;
  /**
   * The workspace's `docker compose <args>` (its shim's, from `cwd` in the clone or Before's) run
   * on the box: the card's own project from the compose file there, the workspace joined to its
   * network after a start and taken off before a `down`. Refused on a Docker that is not local.
   */
  compose: (card: string, cwd: string, args: readonly string[]) => Promise<Outcome<RunData>>;
  /**
   * The clone's worktrees git lost track of pruned, outside the sandbox (`docker exec` as the
   * container's user): a subagent's `git worktree remove` in the sandbox that hits a busy mount
   * point leaves its `.git/worktrees` entry behind, prunable. Run when a session ends.
   */
  prune: (card: string) => Promise<void>;
  close: () => Promise<void>;
};

/** Listens on a workspace's socket, answering as that card's workspace. */
export type ListenInside = (socket: string, card: string) => Promise<Listener>;

const PG_READY_TRIES = 120;
const PG_READY_WAIT_MS = 500;

const secret = () => randomBytes(16).toString('hex');

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const tail = (text: string) => text.trim().split('\n').slice(-5).join('\n');

/** A refusal from deep in a step, answered as the command's outcome. */
class Refusal extends Error {
  constructor(
    readonly code: string,
    why: string,
    readonly exit?: 2,
  ) {
    super(why);
  }
}

const or = async <T>(code: string, step: Promise<T>): Promise<T> => {
  try {
    return await step;
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal(code, message(err));
  }
};

/** `box-disk.json`: when the box's root disk last grew. */
const GrownFile = z.object({ lastGrownAt: z.iso.datetime().nullable() });

/**
 * The values the Mac synced into a card's workspace for `env` (3.2.1, `box-sync.ts`): its Abe env
 * file in the clone (`clone`) and its aws keys in the session user's `SYNC_DIR`; none when neither
 * is there (off for agents, or nothing on the Mac) or neither holds a value. Read as the session
 * user, never said.
 */
const syncedValues = async (
  exec: ContainerExec,
  clone: string,
  env: AbeEnv,
): Promise<Record<string, string> | undefined> => {
  const as = { user: CONTAINER.user };
  const file = await exec(['cat', '--', `${clone}/${abeEnvFile(env)}`], as);
  const aws = await exec(['sh', '-c', 'cat -- "$HOME/$1/aws/$2.json"', 'sh', SYNC_DIR, env], as);
  const keys = (() => {
    try {
      return z.record(z.string(), z.string()).safeParse(JSON.parse(aws.stdout)).data;
    } catch {
      return undefined;
    }
  })();

  const values = {
    ...(file.exit === 0 ? Object.fromEntries(parseEnvFile(file.stdout)) : {}),
    ...(aws.exit === 0 ? (keys ?? {}) : {}),
  };

  // an empty file read is no sync: the sandbox's mount point over an env file it denies (prod's)
  return Object.keys(values).length === 0 ? undefined : values;
};

/** The labels `up` puts on the workspace container; one without them is not the workspace. */
const Labels = z.object({
  [LABEL.repo]: z.string().min(1),
  [LABEL.card]: z.string().min(1),
  [LABEL.branch]: z.string().min(1),
  [LABEL.imageId]: z.string().min(1),
});

type Labelled = {
  container: Container;
  repo: string;
  card: string;
  branch: string;
  imageId: string;
};

const labelled = (c: Container | undefined): Labelled | undefined => {
  const read = Labels.safeParse(c?.labels);

  return c === undefined || !read.success
    ? undefined
    : {
        container: c,
        repo: read.data[LABEL.repo],
        card: read.data[LABEL.card],
        branch: read.data[LABEL.branch],
        imageId: read.data[LABEL.imageId],
      };
};

/** A workspace's names: its 2.2 ones when it is an old box's `abe-workspace`, else the card's. */
const namesOf = (w: Labelled | undefined, card: string): WorkspaceNames =>
  w?.container.name === LEGACY_NAMES.container ? LEGACY_NAMES : workspaceNames(card);

/**
 * Which container each card's workspace is, as Docker's labels last said (the box serve's
 * routers read it: sessions, git, the run tree, the browser): `abe-ws-<card>`, or an old box's
 * `abe-workspace` for the card it was made for.
 */
export type WorkspaceDirectory = {
  /** The card's names; a card with no workspace yet gets the ones its `up` will make. */
  namesOf: (card: string) => WorkspaceNames;
  /** Read again from Docker (after an `up` or `rm`; at serve's start). */
  refresh: () => Promise<void>;
};

export const workspaceDirectory = (docker: Docker): WorkspaceDirectory => {
  let held: Labelled[] = [];

  return {
    namesOf: (card) =>
      namesOf(
        held.find((w) => w.card === card),
        card,
      ),
    refresh: async () => {
      held = (await docker.containers(LABEL.role, 'workspace')).flatMap((c) => labelled(c) ?? []);
    },
  };
};

export const openBox = async (o: BoxOptions, listenInside: ListenInside): Promise<Box> => {
  const { docker, mirrors } = o;
  const directory = o.directory ?? workspaceDirectory(docker);
  /** A wake with GitHub down goes on from the mirror already on the box: said, never refused. */
  const sync = (repo: string) =>
    mirrors.sync(repo).catch((err: unknown) => {
      o.log?.(`the mirror of ${repo} was not fetched: ${message(err)}`);

      return undefined;
    });
  const workdir = o.workdir ?? CONTAINER.workdir;
  /** A step said once, then again only when its detail (a build's `step n/m`) moves. */
  let said: WorkspaceStepData | undefined;
  /** The card whose `up` runs now (one at a time): its steps say so. */
  let upFor: string | undefined;
  const step = (name: WorkspaceStep, detail: string | null = null) => {
    if (said?.step === name && said.detail === detail && said.card === upFor) return;
    said = { step: name, detail, ...(upFor === undefined ? {} : { card: upFor }) };
    o.step?.(said);
  };
  /** A build's progress: its output's Docker step count, said as it moves. */
  const building = (name: WorkspaceStep) => (line: string) => {
    const at = buildStepOf(line);

    if (at !== undefined) step(name, at);
  };
  const seccomp = join(o.dir, 'seccomp-chromium.json');
  /** Each workspace's own socket, by its card: only its container mounts its folder. */
  /** Each workspace's own socket (its listen, made once), by card. */
  const sockets = new Map<string, Promise<Listener>>();
  // The cards with an `abe run` running: one runner per run, never two.
  const runners = new Set<string>();
  let closed = false;

  // One `up` (or `rm`) at a time: the box's start and a wake, or two launches, may both run it.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);

    queue = next.catch(() => undefined);

    return next;
  };

  const own = async (role: string): Promise<Container | undefined> =>
    (await docker.containers(LABEL.role, role))[0];

  /** Every workspace container on the box, labelled. */
  const workspaces = async (): Promise<Labelled[]> =>
    (await docker.containers(LABEL.role, 'workspace')).flatMap((c) => labelled(c) ?? []);

  const find = async (card: string) => (await workspaces()).find((w) => w.card === card);

  const inside = (names: WorkspaceNames) => containerExec(docker, names.container);

  const socketDirOf = (names: WorkspaceNames) => join(o.dir, names.socketDir);

  const listen = async (card: string, names: WorkspaceNames) => {
    const had = sockets.get(card);

    if (had !== undefined) {
      await had;

      return;
    }
    if (closed) return;
    const dir = socketDirOf(names);
    // Held at once: a second listen meanwhile (a `list` beside a `get`) waits on this one.
    const made = (async () => {
      await mkdir(dir, { recursive: true });
      // The container's user (uid 1000) must reach the socket; only this workspace mounts it.
      await chmod(dir, 0o755);
      // The sessions' socket folder, before any session: their jail mounts a tmpfs over it, and
      // `/run/abe` is read-only inside, so bwrap cannot make it.
      await mkdir(join(dir, SESSION_SOCKETS), { recursive: true });
      await chmod(join(dir, SESSION_SOCKETS), 0o755);
      // The session's MCP config (`/run/abe/mcp.json` inside): chrome-devtools-mcp on its browser.
      await writeFile(join(dir, 'mcp.json'), `${JSON.stringify(browserMcpConfig(), null, 2)}\n`, {
        mode: 0o644,
      });

      return listenInside(join(dir, 'serve.sock'), card);
    })();

    sockets.set(card, made);
    try {
      await made;
    } catch (err) {
      sockets.delete(card);
      throw err;
    }
  };

  const dataOf = async (w: Labelled): Promise<WorkspaceData> => {
    const tag = workspaceImage(w.repo);

    return {
      repo: w.repo,
      card: w.card,
      branch: w.branch,
      state: stateOf(w.container.state),
      container: w.container.name,
      image: tag,
      database: namesOf(w, w.card).database,
      imageCurrent: (await docker.image(tag))?.id === w.imageId,
    };
  };

  /** `psql` as Postgres' superuser, by peer over its own socket. */
  const psql = (sql: string) =>
    docker.exec(NAMES.postgres, ['psql', '-v', 'ON_ERROR_STOP=1', '-qtA', '-U', 'postgres'], sql, {
      user: 'postgres',
    });

  const postgres = async () => {
    await docker.network(NAMES.network);
    const pg = await own('postgres');

    const current = pg?.labels[LABEL.pgSocket] === '1';

    // One from before the shared socket: made again on its data volume (its roles kept).
    if (pg !== undefined && !current) await docker.remove(pg.name);
    if (!current) await docker.run(postgresSpec(secret()));
    else if (pg.state !== 'running') await docker.start(pg.name);
    for (let i = 0; i < PG_READY_TRIES; i += 1) {
      // Over TCP: the image's first-start server (initdb's) listens on its socket only.
      const ready = await docker.exec(
        NAMES.postgres,
        ['pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'],
        undefined,
        {
          user: 'postgres',
        },
      );

      if (ready.exit === 0) {
        // Who may connect, as core says, on every up: a box made earlier had the image's trust.
        const hba = await docker.exec(
          NAMES.postgres,
          ['sh', '-c', 'cat > "$PGDATA/pg_hba.conf"'],
          PG_HBA,
          { user: 'postgres' },
        );
        const reloaded = hba.exit === 0 ? await psql('SELECT pg_reload_conf();') : hba;

        if (reloaded.exit !== 0)
          throw new Error(`the box's Postgres access rules: ${tail(reloaded.stderr)}`);

        return;
      }
      await o.sleep(PG_READY_WAIT_MS);
    }
    throw new Error(`the box's Postgres did not get ready`);
  };

  /**
   * The base image, built when missing or built by another abe than the one installed (#62): an
   * upgrade's base has what the new abe needs (its `abe-run` user), and every workspace image
   * built on the old one is built again on it.
   */
  const baseImage = async (): Promise<Image> => {
    const have = await docker.image(BASE_IMAGE);
    const plan = basePlan(have, o.base?.release);

    if (plan === 'reuse' && have !== undefined) return have;
    if (plan === 'missing' || o.base === undefined)
      throw new Refusal('no-base-image', `the box has no ${BASE_IMAGE}: run abe/images/build.sh`);
    const { dir, bin, nvim, release } = o.base;
    // The `abe-bin` context: the installed binary under the name the Dockerfile copies.
    const context = join(o.dir, 'base-bin');
    // The `vimstorm-nvim` context: the release's config, else an empty folder.
    const noNvim = join(o.dir, 'base-nvim');

    await rm(context, { recursive: true, force: true });
    await mkdir(context, { recursive: true, mode: 0o700 });
    await rm(noNvim, { recursive: true, force: true });
    if (nvim === undefined) await mkdir(noNvim, { recursive: true, mode: 0o700 });
    try {
      await copyFile(bin, join(context, 'abe-linux-arm64'));
      step('base-image');
      const ran = await or(
        'build-failed',
        docker.build({
          tag: BASE_IMAGE,
          context: dir,
          dockerfile: join(dir, 'Dockerfile'),
          contexts: { 'abe-bin': context, 'vimstorm-nvim': nvim ?? noNvim },
          args: { ABE_VERSION: release.version, ABE_HASH: release.hash },
          labels: baseLabels(release),
          progress: building('base-image'),
        }),
      );

      if (ran.exit !== 0) {
        // #302: another build of this release made it meanwhile (the box's boot builds a missing
        // base outside serve), and this one lost the race to the tag: that one serves.
        const theirs = await docker.image(BASE_IMAGE);

        if (theirs === undefined || basePlan(theirs, release) !== 'reuse')
          throw new Refusal('build-failed', `${BASE_IMAGE}: ${tail(ran.stderr)}`);
        o.log?.(`${BASE_IMAGE} was built meanwhile by another build: used (${tail(ran.stderr)})`);

        return theirs;
      }
    } finally {
      await rm(context, { recursive: true, force: true });
      await rm(noNvim, { recursive: true, force: true });
    }
    const made = await docker.image(BASE_IMAGE);

    if (made === undefined)
      throw new Refusal('build-failed', `${BASE_IMAGE} is missing after its build`);

    return made;
  };

  /** The repo's workspace image and its id, built from the mirror when missing or out of date. */
  const image = async (repo: string, fetched: boolean): Promise<{ tag: string; id: string }> => {
    const tag = workspaceImage(repo);
    const tree = await or('build-failed', mirrors.tree(repo, IMAGE_DIR));
    const have = await docker.image(tag);

    if (tree === undefined) {
      // No mirror (GitHub down on a box's first start): an image built before still serves.
      if (!fetched && have !== undefined) return { tag, id: have.id };
      if (!fetched)
        throw new Refusal('clone-failed', `${repo} could not be fetched and the box has no copy`);
      throw new Refusal('no-workspace-image', `${repo} has no ${IMAGE_DIR}/Dockerfile`);
    }
    const base = await baseImage();

    if (have !== undefined && workspaceImageCurrent(have, tree, base.id))
      return { tag, id: have.id };
    const context = await or('build-failed', mirrors.snapshot(repo));

    step('image');
    const ran = await or(
      'build-failed',
      docker.build({
        tag,
        context,
        dockerfile: join(context, IMAGE_DIR, 'Dockerfile'),
        args: { BASE_IMAGE, SESSION_USER },
        labels: { [LABEL.imageTree]: tree, [LABEL.baseId]: base.id },
        progress: building('image'),
      }),
    );

    if (ran.exit !== 0) throw new Refusal('build-failed', tail(ran.stderr));
    const made = await docker.image(tag);

    if (made === undefined) throw new Refusal('build-failed', `${tag} is missing after its build`);

    return { tag, id: made.id };
  };

  /**
   * The clone's commits authored as the person (#67): their GitHub user read with their token
   * (on stdin, in `gh`'s environment only, never on a command line), then git's identity in the
   * clone, which Claude Code commits with. GitHub not answering leaves the clone's as it was.
   */
  const author = async (names: WorkspaceNames, token: string): Promise<string | undefined> => {
    const exec = inside(names);
    const asked = await exec(
      [
        'sh',
        '-c',
        'IFS= read -r t && GH_TOKEN=$t GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 exec gh api user',
      ],
      { stdin: `${token}\n`, timeoutMs: 30_000 },
    );
    let doc: unknown;

    try {
      doc = asked.exit === 0 ? JSON.parse(asked.stdout) : undefined;
    } catch {
      return undefined;
    }
    const who = gitAuthor(doc);

    if (who === undefined) return undefined;
    const set = await exec([
      'sh',
      '-c',
      'git -C "$1" config user.name "$2" && git -C "$1" config user.email "$3"',
      'sh',
      workdir,
      who.name,
      who.email,
    ]);

    return set.exit === 0 ? `${who.name} <${who.email}>` : undefined;
  };

  /**
   * The container's `gh` as the person (#62), the token on stdin: what the pr stage's push and
   * `gh` and the deploy poll use there, without waiting for a session's launch. A failure is
   * said in serve.log; the next `up` or launch tries again.
   */
  const ghLogin = async (names: WorkspaceNames, token: string) => {
    const refusal = await workspaceGhLogin(inside(names), token);

    if (refusal?.ok === false)
      o.log?.(`the workspace's gh was not logged in: ${refusal.error.message}`);
  };

  /** Someone attached or a session running: the container is not replaced under them. */
  const busy = async (w: Labelled) => {
    if (stateOf(w.container.state) !== 'running') return false;
    const probe = await docker.exec(w.container.name, ACTIVITY_PROBE).catch(() => undefined);

    // A container that does not answer is left as it is.
    return probe === undefined || isBusy(probe.stdout);
  };

  /** Refuses unless a container of `tag` under the workspace's profile runs in it, enforced. */
  const confined = async (tag: string) => {
    const want = `${WORKSPACE_APPARMOR} (enforce)`;
    const got = await or('no-apparmor', docker.confinement(tag, WORKSPACE_APPARMOR));

    if (got !== want)
      throw new Refusal(
        'no-apparmor',
        `the AppArmor profile ${WORKSPACE_APPARMOR} is not in force on this box (a container under it runs ${got}): the box's abe-apparmor unit loads it`,
      );
  };

  const up = async (
    repo: string,
    card: string,
    title: string | undefined,
    github: string | undefined,
    named?: string,
  ) => {
    if (closed) throw new Refusal('serve-stopping', 'this abe serve is stopping');
    const all = await workspaces();
    const was = all.find((w) => w.card === card);

    if (was !== undefined && was.repo !== repo)
      throw new Refusal(
        'other-workspace',
        `card ${card}'s workspace on this box holds ${was.repo}`,
      );
    // Postgres folds names to lowercase: `AB-1` and `ab-1` would share one database.
    const twin = all.find((w) => w.card !== card && w.card.toLowerCase() === card.toLowerCase());

    if (twin !== undefined)
      throw new Refusal(
        'other-workspace',
        `card ${twin.card}'s workspace on this box has the same database as card ${card}`,
      );
    const names = namesOf(was, card);

    said = undefined;
    upFor = card;
    // A wake with GitHub down still comes back from the clone and image on the box.
    step('mirror');
    const mirror = await sync(repo);
    const { tag, id } = await image(repo, mirror !== undefined);

    // Before any workspace container runs or starts again: on a host whose AppArmor is off Docker
    // applies no profile at all, and the workspace would run unconfined.
    await confined(tag);

    step('database');
    await or('database-failed', postgres());
    step('clone');
    const clone = await or(
      'clone-failed',
      docker.once({
        image: tag,
        argv: [
          'sh',
          '-ec',
          cloneScript(
            repo,
            was?.branch ?? named ?? cardBranch(card, title),
            mirror !== undefined,
            named?.startsWith(PROTOTYPE_BRANCH_PREFIX) === true ? PRE_PUSH_HOOK : undefined,
          ),
        ],
        labels: { [LABEL.role]: 'clone', [LABEL.card]: card },
        env: {},
        mounts: [
          { type: 'volume', source: names.volume, target: '/workspace' },
          ...(mirror === undefined
            ? []
            : [{ type: 'bind' as const, source: mirror, target: '/src.git', readOnly: true }]),
        ],
        network: 'none',
        limits: { memory: '1g', pids: 256, shm: '64m' },
        hardened: true,
      }),
    );

    if (clone.exit === NO_CLONE)
      throw new Refusal('clone-failed', `no clone on the box and ${repo} could not be fetched`);
    if (clone.exit !== 0) throw new Refusal('clone-failed', tail(clone.stderr));
    // The clone's own branch: what the container is labelled with, whatever the title said.
    const branch = branchOf(clone.stdout) ?? was?.branch ?? named ?? cardBranch(card, title);

    step('container');
    await or('socket-failed', listen(card, names));
    // Its own network: no other card's container is reached on it.
    await or(
      'docker-failed',
      docker.network(names.network).catch((err: unknown) => {
        throw new Error(
          `card ${card}'s network ${names.network}: ${message(err)} (are Docker's address pools full? the box's daemon.json sets them)`,
        );
      }),
    );
    // One made before Postgres' socket (#67) has a TCP DATABASE_URL a sandboxed command cannot
    // reach, and one under another AppArmor profile (Docker's, where no sandbox starts, or
    // unconfined) is not under abe-workspace, and one with Docker's masked /proc starts no jailed
    // command: made again like one on an old image, once nobody is in it.
    const current =
      was?.imageId === id &&
      was.container.labels[LABEL.pgSocket] === '1' &&
      was.container.labels[LABEL.apparmor] === WORKSPACE_APPARMOR &&
      was.container.labels[LABEL.systemPaths] === WORKSPACE_SYSTEM_PATHS;
    const keep = was !== undefined && (current || (await busy(was)));

    if (keep) {
      if (stateOf(was.container.state) !== 'running')
        await or('docker-failed', docker.start(was.container.name));
    } else {
      // A new image (or none yet), nobody there: a new container on the same volume, with a new
      // password, told to the role before the old container goes.
      const password = secret();
      const sql = await or('database-failed', psql(databaseSql(password, names.database)));

      if (sql.exit !== 0) throw new Refusal('database-failed', tail(sql.stderr));
      if (was !== undefined) await or('docker-failed', docker.remove(was.container.name));
      await or(
        'docker-failed',
        docker.run(
          workspaceSpec({
            names,
            repo,
            card,
            branch,
            image: tag,
            imageId: id,
            socketDir: socketDirOf(names),
            seccomp,
            databaseUrl: databaseUrl(password, names.database),
          }),
        ),
      );
    }
    const now = await find(card);

    await directory.refresh().catch(() => undefined);
    if (now === undefined) throw new Refusal('docker-failed', 'the workspace did not appear');
    if (github !== undefined) await ghLogin(names, github);
    const by = github === undefined ? undefined : await author(names, github);

    return { ...(await dataOf(now)), ...(by === undefined ? {} : { author: by }) };
  };

  /** A refusal as the command's outcome. */
  const outcome = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
    try {
      return { ok: true, data: await run() };
    } catch (err) {
      if (err instanceof Refusal) return refused(err.code, err.message, err.exit);

      return refused('docker-failed', message(err));
    }
  };

  const list = async () => {
    const all = await workspaces();

    // A serve that started before Docker answered listens once it does.
    for (const w of all) await listen(w.card, namesOf(w, w.card));

    return Promise.all(all.map(dataOf));
  };

  /**
   * Refuses when removing the card's workspace would lose work (`Git.work` in its clone): its
   * container started for the look when it was stopped.
   */
  const lose = async (w: Labelled, names: WorkspaceNames) => {
    const stopped = stateOf(w.container.state) !== 'running';

    if (stopped) await or('docker-failed', docker.start(w.container.name));
    const work = await workspaceGit(inside(names)).work(workdir);

    if (!work.ok)
      throw new Refusal('work-unknown', `card ${w.card}'s clone: ${work.error.message}`);
    const lost =
      work.data === null
        ? []
        : [
            ...(work.data.unpushed === 0
              ? []
              : [`${work.data.unpushed} unpushed commit${work.data.unpushed === 1 ? '' : 's'}`]),
            ...(work.data.uncommitted === 0
              ? []
              : [
                  `${work.data.uncommitted} uncommitted file${work.data.uncommitted === 1 ? '' : 's'}`,
                ]),
          ];

    if (lost.length > 0)
      throw new Refusal(
        'unpushed',
        `card ${w.card}'s workspace holds ${lost.join(' and ')}: push them, or Download locally, first`,
      );
  };

  /**
   * The card's workspace removed, idempotent by card (a removal cut off half way is finished by
   * the next): refused while someone is in it or (unless `workChecked`, its work looked at by the
   * caller) while its clone holds work; then its database first (Postgres the likeliest to fail,
   * while the container is still there to try again), its socket, container, volume and network.
   */
  const remove = async (card: string, workChecked: boolean): Promise<WorkspaceRemoved> => {
    const w = await find(card);
    const names = namesOf(w, card);
    // No container: only its volume (a removal cut off half way, an `up` that failed to run it).
    if (w === undefined) {
      const volumes = await or('docker-failed', docker.volumeSizes());

      if (!Object.hasOwn(volumes, names.volume))
        throw new Refusal('no-workspace', `this box has no workspace for card ${card}`);
      // Its work cannot be looked at with no container: never dropped unseen.
      if (!workChecked)
        throw new Refusal(
          'work-unknown',
          `card ${card}'s workspace has no container to look at its work in: abe workspace up --repo <owner/repo> --card ${card} first, then remove it`,
        );
    }
    if (w !== undefined && (await busy(w)))
      throw new Refusal(
        'workspace-busy',
        `someone is in card ${card}'s workspace (a session runs or a terminal is attached): stop it first`,
      );
    if (w !== undefined && !workChecked) await lose(w, names);
    // The box's Postgres may be down (stopped with the box): up again to drop the database.
    await or('database-failed', postgres());
    const dropped = await or('database-failed', psql(dropDatabaseSql(names.database)));

    if (dropped.exit !== 0) throw new Refusal('database-failed', tail(dropped.stderr));
    await (await sockets.get(card)?.catch(() => undefined))?.close();
    sockets.delete(card);
    await rm(socketDirOf(names), { recursive: true, force: true });
    // the card ends: its compose projects (its own and Before's) go down, off their networks first
    if (w !== undefined) await composeDown(w, names);
    if (w !== undefined) await or('docker-failed', docker.remove(w.container.name));
    await or('docker-failed', docker.removeVolume(names.volume));
    // An old box's network is Postgres' too: it stays.
    if (names.network !== NAMES.network)
      await or('docker-failed', docker.removeNetwork(names.network));
    await directory.refresh().catch(() => undefined);
    o.removed?.(card);

    return { card, removed: true };
  };

  /** The last load read, and the CPU counters it was read at (the next one's CPU is since then). */
  let loaded: { load: BoxLoad; cpu: CpuTimes; at: number } | undefined;
  let reading: Promise<BoxLoad | undefined> | undefined;
  const now = o.now ?? (() => Date.now());
  /** When the root disk last grew (AWS allows one change per 6 h), kept across serve starts. */
  const grownFile = join(o.dir, 'box-disk.json');
  const lastGrown = async () => {
    try {
      const doc: unknown = JSON.parse(await readFile(grownFile, 'utf8'));

      return GrownFile.parse(doc).lastGrownAt;
    } catch {
      return null;
    }
  };

  /** A growth of the root disk going on (at most one): reads meanwhile do not wait for it. */
  let growing: Promise<void> | undefined;

  /**
   * The root disk grown in the background (EC2's change takes minutes): said in serve.log, the
   * next read sees its new size. Marked once tried, so a failing growth waits its 6 h too.
   */
  const grow = (host: BoxHost, load: BoxLoad, at: number, maxGb: number) => {
    const growRoot = host.growRoot;

    if (growRoot === undefined || growing !== undefined) return;
    o.log?.(
      `the box's disk is ${load.disk.freeGb} GB free of ${load.disk.totalGb}: growing it (at most ${maxGb} GB)`,
    );
    growing = (async () => {
      try {
        // A full disk may refuse even this: the growth is then tried all the same.
        await writeFile(
          grownFile,
          `${JSON.stringify({ lastGrownAt: new Date(at).toISOString() })}\n`,
        ).catch((err: unknown) => {
          o.log?.(`the box's disk growth was not noted: ${message(err)}`);
        });
        const grown = await growRoot(maxGb);

        if (!grown.ok) o.log?.(`the box's disk did not grow: ${grown.error.message}`);
        else if (grown.data.toGb === null)
          o.log?.(`the box's disk is at its largest, ${maxGb} GB (limits.maxBoxDisk)`);
        else o.log?.(`the box's disk grew to ${grown.data.toGb} GB`);
      } catch (err) {
        o.log?.(`the box's disk did not grow: ${message(err)}`);
      }
      // Read anew next time: its new size.
      loaded = loaded === undefined ? undefined : { ...loaded, at: 0 };
    })().finally(() => {
      growing = undefined;
    });
  };

  /** The load read now: the host's and each workspace volume's; a filling disk grows behind it. */
  const readLoad = async (host: BoxHost): Promise<BoxLoad | undefined> => {
    if (host.load === undefined) return undefined;
    const [raw, volumes, all] = await Promise.all([
      host.load(),
      docker.volumeSizes(),
      workspaces(),
    ]);
    // An old box's one volume is its card's.
    const old = all.find((w) => namesOf(w, w.card) === LEGACY_NAMES)?.card;
    const cardOf = (volume: string) =>
      volume === LEGACY_NAMES.volume ? old : cardOfWorkspace(volume);
    const at = now();
    const load = boxLoadOf({ ...raw, volumes }, loaded?.cpu, new Date(at).toISOString(), cardOf);
    const maxGb = o.maxDiskGb?.() ?? SETTINGS['limits.maxBoxDisk'].default;

    if (diskGrowth(load, { maxGb, lastGrownAt: await lastGrown(), now: at }) !== undefined)
      grow(host, load, at, maxGb);
    loaded = { load, cpu: raw.cpu, at };

    return load;
  };

  const load = async (): Promise<BoxLoad | undefined> => {
    const host = o.host;

    if (host === undefined) return undefined;
    if (loaded !== undefined && now() - loaded.at < (o.loadEveryMs ?? LOAD_READ_EVERY_MS))
      return loaded.load;
    // One read at a time: a status asked while one runs gets that one.
    reading ??= readLoad(host)
      .catch((err: unknown) => {
        o.log?.(`the box's load was not read: ${message(err)}`);

        return loaded?.load;
      })
      .finally(() => {
        reading = undefined;
      });

    return reading;
  };
  // Read on its own every so often, so the disk grows while nobody asks.
  const loadTimer =
    o.host === undefined
      ? undefined
      : setInterval(() => void load(), o.loadEveryMs ?? LOAD_READ_EVERY_MS);

  loadTimer?.unref();

  await mkdir(o.dir, { recursive: true, mode: 0o700 });
  await writeFile(seccomp, seccompText(), { mode: 0o644 });
  // Docker may not answer yet when the box starts; `list` and `up` listen once it does.
  const was = await list().catch(() => []);

  await directory.refresh().catch(() => undefined);
  // A serve started again (an upgrade, a crash) with workspaces running: their gh logged in
  // before serve answers, as `up` and a launch do (#62).
  // Best effort: a login not read now leaves serve starting all the same.
  const running = was.filter((w) => w.state === 'running');

  if (running.length > 0 && o.logins !== undefined) {
    const logins = await o.logins.read().catch((err: unknown) => refused('no-login', message(err)));

    if (logins.ok)
      for (const w of running)
        await ghLogin(namesOf(await find(w.card), w.card), logins.data.github);
    else o.log?.(`the workspace's gh was not logged in: ${logins.error.message}`);
  }

  /** The card's workspace, running, or why not. */
  /** Where a workspace's pack script finds `docker`: the shim, beside the clone. */
  const shimDir = join(dirname(workdir), '.abe-bin');
  /** The card's compose project for a folder in its clone, or Before's beside it. */
  const projectOf = (w: Labelled, cwd: string): string | undefined => {
    const own = composeProject(w.repo, w.card);
    const under = (top: string) => cwd === top || cwd.startsWith(`${top}/`);

    if (cwd.split('/').includes('..')) return undefined;
    if (under(`${workdir}-base`)) return baseComposeProject(own);

    return under(workdir) ? own : undefined;
  };
  const composeDown = async (w: Labelled, names: WorkspaceNames) => {
    const c = o.compose;

    if (c === undefined) return;
    const own = composeProject(w.repo, w.card);

    for (const project of [own, baseComposeProject(own)]) {
      await c.compose.network({
        network: composeNetwork(project),
        container: names.container,
        leave: true,
        env: c.env,
      });
      const down = await c.compose.down({ project, env: c.env });

      if (down.exit !== 0) o.log?.(`compose ${project} not taken down: ${tail(down.stderr)}`);
    }
  };
  /** The compose file in `cwd` of the workspace, read there as its script user. */
  const composeFileIn = async (names: WorkspaceNames, cwd: string) => {
    const read = await inside(names)(
      [
        'sh',
        '-c',
        `cd "$1" || exit 3; for f in ${COMPOSE_FILES.join(' ')}; do [ -f "$f" ] && { echo "$f"; exec cat "$f"; }; done; exit 3`,
        'sh',
        cwd,
      ],
      { user: CONTAINER.runUser },
    );

    const at = read.stdout.indexOf('\n');

    return read.exit === 0 && at > 0
      ? { name: read.stdout.slice(0, at), text: read.stdout.slice(at + 1) }
      : undefined;
  };
  /**
   * The folder compose runs in on the box, for `cwd` in the workspace: the clone itself where the
   * box host sees the workspace's volume (its mountpoint, readable here), so build contexts and
   * relative mounts are the clone's; else a copy of it synced into the project's own folder
   * (no `.git`, no `node_modules`), said in `synced`.
   */
  const composeDirOf = async (
    w: Labelled,
    names: WorkspaceNames,
    cwd: string,
    project: string,
    sync: boolean,
  ): Promise<{ dir: string; synced?: string }> => {
    const mount = dirname(workdir);
    const host = await docker.volumePath(names.volume).catch(() => undefined);
    const inHost = host === undefined ? undefined : `${host}${cwd.slice(mount.length)}`;

    if (
      inHost !== undefined &&
      (await access(inHost, constants.R_OK).then(
        () => true,
        () => false,
      ))
    )
      return { dir: inHost };
    const dir = join(o.dir, 'compose', project);

    await mkdir(dir, { recursive: true });
    if (!sync) return { dir };
    const copied = await docker.once({
      image: w.imageId,
      argv: [
        'sh',
        '-c',
        'find /dst -mindepth 1 -delete && cd "/src$1" && tar --exclude=./.git --exclude=./node_modules -cf - . | tar -xf - -C /dst',
        'sh',
        cwd.slice(mount.length),
      ],
      labels: {},
      env: {},
      mounts: [
        { type: 'volume', source: names.volume, target: '/src', readOnly: true },
        { type: 'bind', source: dir, target: '/dst' },
      ],
      network: 'none',
    });

    if (copied.exit !== 0)
      throw new Refusal(
        'compose-sync-failed',
        `the clone was not synced to ${dir}: ${tail(copied.stderr)}`,
      );

    return {
      dir,
      synced: `the clone is not readable on the box: synced to ${dir} (no .git, no node_modules); a change in the workspace needs docker compose again`,
    };
  };

  /** The hook points the Mac handed for `repo`, kept where no workspace reaches; none: today's. */
  const hooksFile = (repo: string) => join(o.dir, 'hooks', `${repo}.json`);
  const handedHooks = async (repo: string | undefined): Promise<RepoHooks> => {
    if (repo === undefined) return DEFAULT_HOOKS;
    try {
      return RepoHooks.parse(JSON.parse(await readFile(hooksFile(repo), 'utf8')));
    } catch {
      return DEFAULT_HOOKS;
    }
  };

  const runningOf = async (card: string): Promise<Outcome<Labelled>> => {
    const w = await find(card).catch(() => undefined);

    if (w === undefined)
      return refused(
        'no-workspace',
        `this box has no workspace for card ${card}: abe workspace up`,
      );
    if (stateOf(w.container.state) !== 'running')
      return refused(
        'workspace-stopped',
        `card ${card}'s workspace is ${stateOf(w.container.state)}`,
      );

    return { ok: true, data: w };
  };

  return {
    up: (a) => {
      const repo = parseRepo(a.repo);
      const card = parseCard(a.card);

      if (repo === undefined)
        return Promise.resolve(refused('usage', `not <owner>/<repo>: ${a.repo}`, 2));
      if (card === undefined)
        return Promise.resolve(refused('usage', `not a card id: ${a.card}`, 2));

      return outcome(() => serial(() => up(repo, card, a.title, a.github, a.branch)));
    },
    upAll: (a) =>
      outcome(async () => {
        const all = await or('docker-failed', workspaces());
        const failed: string[] = [];

        for (const w of all) {
          // Checked again in its turn: one removed meanwhile (a Done sweep) is not made anew.
          const brought = await outcome(() =>
            serial(async () =>
              (await find(w.card)) === undefined
                ? undefined
                : up(w.repo, w.card, undefined, a.github),
            ),
          );

          if (!brought.ok) {
            failed.push(`card ${w.card}: ${brought.error.message}`);
            o.log?.(`card ${w.card}'s workspace did not come back: ${brought.error.message}`);
          }
        }
        if (failed.length > 0)
          throw new Refusal(
            'workspace-failed',
            `not every workspace came back: ${failed.join('; ')}`,
          );

        return { workspaces: await list() };
      }),
    list,
    get: async (card) => {
      const w = await find(card);

      if (w === undefined) return undefined;
      await listen(card, namesOf(w, card));

      return dataOf(w);
    },
    running: async () =>
      (await workspaces())
        .filter((w) => stateOf(w.container.state) === 'running')
        .map((w) => ({ card: w.card, container: w.container.name, workdir })),
    rm: (card, how) => {
      const parsed = parseCard(card);

      if (parsed === undefined)
        return Promise.resolve(refused('usage', `not a card id: ${card}`, 2));

      return outcome(() => serial(() => remove(parsed, how?.workChecked === true)));
    },
    inherited: async (card, names) => {
      const ran = await docker
        .exec(directory.namesOf(card).container, ['env'])
        .catch(() => undefined);
      const wanted = new Set(names);

      return Object.fromEntries(
        (ran?.exit === 0 ? ran.stdout.split('\n') : []).flatMap((line) => {
          const eq = line.indexOf('=');
          const name = line.slice(0, eq);

          return eq > 0 && wanted.has(name) ? [[name, line.slice(eq + 1)]] : [];
        }),
      );
    },
    checkout: async (repo) => {
      try {
        // A wake with GitHub down reads the checkout from the mirror already on the box.
        await sync(repo);

        return { ok: true, data: await mirrors.checkout(repo) };
      } catch (err) {
        return refused('checkout-failed', message(err));
      }
    },
    handHooks: async (repo, hooks) => {
      const file = hooksFile(repo);

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(hooks)}\n`);
    },
    script: async (card, path, args, env) => {
      const hooks = await handedHooks((await find(card).catch(() => undefined))?.repo);
      const at = packScript(hooks, path);
      const asked = env === undefined ? undefined : AbeEnv.safeParse(env);

      if (asked !== undefined && !asked.success)
        return refused(
          'unknown-env',
          `${env} is none of the environments: ${ABE_ENVS.join(', ')}`,
          2,
        );

      if (at === undefined)
        return refused(
          'not-a-pack-script',
          `${path} is no Verification pack script: ${runScriptsWords(hooks)}, in ${CONTAINER.workdir} or ${CONTAINER.baseWorktree}`,
          2,
        );
      // one runner per run: a script beside one still running is refused (stop always runs)
      const mine = at.role !== 'stop';

      if (mine && runners.has(card))
        return refused(
          'one-runner',
          `${at.script} not run: another abe run of this card is still running; one runner drives at a time, so wait for it to end`,
        );
      if (mine) runners.add(card);
      try {
        const w = await runningOf(card);

        if (!w.ok) return w;
        const cwd = at.cwd === CONTAINER.baseWorktree ? `${workdir}-base` : workdir;
        const exec = inside(namesOf(w.data, card));

        // `docker` for it: compose through abe compose, run on the box (no Docker in a workspace)
        await exec(
          [
            'sh',
            '-c',
            'mkdir -p "$1" && cat > "$1/docker" && chmod 755 "$1/docker"',
            'sh',
            shimDir,
          ],
          { user: CONTAINER.runUser, stdin: DOCKER_SHIM },
        );
        const values = await syncedValues(exec, workdir, asked?.data ?? 'dev');

        if (asked !== undefined && values === undefined)
          return refused(
            'env-not-here',
            `--env ${asked.data}: its Abe env file and aws keys are not on this box: ${envNotEnabled(asked.data)}, or the Mac has none for it (the Mac syncs them at launch and before each turn)`,
          );
        const ran = await runPackScript(exec, {
          cwd,
          script: at.script,
          args,
          timeoutMs: PACK_SCRIPT_TIMEOUT_MS,
          pathFirst: shimDir,
          ...(values === undefined ? {} : { env: values }),
        });
        // what it says never carries a value it was handed
        const known = injectedSecrets(values ?? {});
        const said =
          known.length === 0
            ? ran
            : {
                ...ran,
                stdout: redactText(ran.stdout, known),
                stderr: redactText(ran.stderr, known),
              };

        return { ok: true, data: { script: at.script, cwd, ...said } };
      } finally {
        if (mine) runners.delete(card);
      }
    },
    compose: async (card, cwd, args) => {
      const c = o.compose;

      if (c === undefined) return refused('no-compose', 'this box runs no docker compose');
      const asked = boxComposeArgs(args);

      if (!asked.ok) return refused('compose-args', asked.why, 2);
      const w = await runningOf(card);

      if (!w.ok) return w;
      const names = namesOf(w.data, card);
      const project = projectOf(w.data, cwd);

      if (project === undefined)
        return refused(
          'compose-outside',
          `${cwd} is not in card ${card}'s clone (${workdir}) or Before's (${workdir}-base)`,
          2,
        );
      const why = composeNotLocal(
        c.env,
        (c.env.DOCKER_HOST ?? '') !== '' ? null : await c.compose.endpoint(c.env),
      );

      if (why !== null) return refused(COMPOSE_NOT_LOCAL, `docker compose not run: ${why}`);
      const file = await composeFileIn(names, cwd);

      if (file === undefined)
        return refused('no-compose-file', `no ${COMPOSE_FILES.join(', ')} in ${cwd}`);
      // a host path that is not the clone's (absolute, or up out of it) can't be had on a box
      const top =
        cwd === `${workdir}-base` || cwd.startsWith(`${workdir}-base/`)
          ? `${workdir}-base`
          : workdir;
      const rel = `${cwd.slice(top.length + 1)}${cwd === top ? '' : '/'}${file.name}`;
      const outside = composePathsOutside(rel, file.text);

      if (outside.length > 0)
        return refused(
          'compose-path-outside',
          `${outside.map((x) => `${x.path}:${x.line} ${x.item}: ${x.why}`).join('; ')}. Name a path in the clone (relative to the compose file), or a named volume`,
        );
      const network = { network: composeNetwork(project), container: names.container, env: c.env };

      if (asked.stops) await c.compose.network({ ...network, leave: true });
      // compose runs in the clone as the box sees it, so relative paths and build contexts are its
      let at: { dir: string; synced?: string };

      try {
        at = await composeDirOf(
          w.data,
          names,
          cwd,
          project,
          asked.starts || asked.command === 'build',
        );
      } catch (err) {
        return err instanceof Refusal
          ? refused(err.code, err.message)
          : refused('docker-failed', message(err));
      }
      const { dir } = at;
      const ran = await c.compose.run({
        project,
        args: ['--project-directory', dir, '-f', '-', ...args],
        env: c.env,
        cwd: dir,
        stdin: file.text,
      });
      const joined = ran.exit === 0 && asked.starts ? await c.compose.network(network) : undefined;

      return {
        ok: true,
        data: {
          script: 'docker compose',
          cwd,
          exit: ran.exit,
          stdout: ran.stdout,
          stderr: `${at.synced === undefined ? '' : `${at.synced}\n`}${
            joined === undefined || joined.exit === 0
              ? ran.stderr
              : `${ran.stderr}the workspace did not join ${network.network}: ${tail(joined.stderr)}\n`
          }`,
        },
      };
    },
    prune: async (card) => {
      // serve's own git in the agent's clone: none of its hooks or fsmonitor run.
      const argv = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
      const ran = await docker
        .exec(directory.namesOf(card).container, [...argv, '-C', workdir, 'worktree', 'prune'])
        .catch((err: unknown) => ({ exit: 1, stdout: '', stderr: message(err) }));

      if (ran.exit !== 0) o.log?.(`the clone's worktrees were not pruned: ${tail(ran.stderr)}`);
    },
    load,
    close: async () => {
      closed = true;
      // A growth going on (EC2 takes minutes) is not waited for: it goes on, or the next start notes it.
      if (loadTimer !== undefined) clearInterval(loadTimer);
      await queue;
      for (const s of sockets.values()) await (await s.catch(() => undefined))?.close();
      sockets.clear();
    },
  };
};

export type WorkspaceCtx = {
  /** The session the request came in on (`abe run` from a local one runs in its worktree). */
  session: string | undefined;
  /** The Abe chat the request came from (it runs as the person): `abe run` in its main checkout. */
  hub?: string | undefined;
  /** The request came in on a workspace's socket. */
  inside: boolean;
  /** On a box, the card whose workspace's socket the request came in on. */
  insideCard: string | undefined;
  serve: {
    box: Box | undefined;
    /** The Mac's serve: a local session's `abe run` (#182). */
    localApps: LocalApps | undefined;
    sessions: Sessions | undefined;
    /** The box owner's logins: their GitHub login authors the clone's commits. */
    logins: Logins | undefined;
  };
};

const NOT_A_BOX = refused(
  'not-a-box',
  'this abe serve runs no workspace (a box starts it with ABE_BOX set)',
);

/**
 * The card a request on a box is about: its workspace's socket's, else its session's (`<card>-…`,
 * the card in its meta).
 */
export const requestCard = (ctx: {
  insideCard: string | undefined;
  session: string | undefined;
  serve: {
    sessions: Sessions | undefined;
  };
}): string | undefined => {
  if (ctx.insideCard !== undefined) return ctx.insideCard;
  if (ctx.session === undefined) return undefined;
  const card = ctx.serve.sessions?.metaOf(ctx.session)?.card;

  return card === undefined || card === null ? cardOfSession(ctx.session) : String(card);
};

export const workspaceHandlers = <C extends WorkspaceCtx>() =>
  ({
    'workspace up': async (args, ctx) => {
      if (ctx.serve.box === undefined) return NOT_A_BOX;
      if (args.all && (args.repo !== undefined || args.card !== undefined))
        return refused('usage', 'workspace up takes --all or --repo and --card, not both', 2);
      if (!args.all && (args.repo === undefined || args.card === undefined))
        return refused('usage', 'workspace up takes --repo and --card (or --all)', 2);
      // No logins (no owner) or none readable now: the workspace all the same, its author as was.
      const logins = await ctx.serve.logins?.read();
      const github = logins?.ok === true ? { github: logins.data.github } : {};

      if (args.all) return ctx.serve.box.upAll(github);

      return ctx.serve.box.up({
        repo: args.repo ?? '',
        card: args.card ?? '',
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.branch === undefined ? {} : { branch: args.branch }),
        ...github,
      });
    },
    // a prototype's workspace (`proto-…`) is a throwaway: removed whatever it holds
    'workspace rm': (args, ctx) =>
      ctx.serve.box === undefined
        ? Promise.resolve(NOT_A_BOX)
        : ctx.serve.box.rm(
            args.card,
            args.card.startsWith('proto-') ? { workChecked: true } : undefined,
          ),
    run: (args, ctx) => {
      if (ctx.serve.box !== undefined) {
        const card = requestCard(ctx);

        return card === undefined
          ? Promise.resolve(
              refused(
                'no-workspace',
                "abe run runs a pack script in a card's workspace: from its session's terminal",
              ),
            )
          : ctx.serve.box.script(card, args.script, args.args, args.env);
      }
      // A local session's (#182): in its worktree or Before's, outside its sandbox, as on a box.
      // The Abe chat's in its main checkout: the install's gate starts the app there.
      const id = ctx.session ?? ctx.hub;
      const meta = id === undefined ? undefined : ctx.serve.sessions?.metaOf(id);

      return meta === undefined || ctx.serve.localApps === undefined
        ? Promise.resolve(
            refused(
              'not-a-box',
              "abe run runs a pack script in a session's worktree (a box's workspace, or a local session's): from a session's terminal, or run the script itself",
            ),
          )
        : ctx.serve.localApps.run(meta, args.script, args.args, args.env);
    },
    compose: (args, ctx) => {
      const card = requestCard(ctx);

      if (ctx.serve.box === undefined)
        return Promise.resolve(
          refused('not-a-box', "abe compose is a box workspace's docker compose: from inside one"),
        );

      return card === undefined
        ? Promise.resolve(refused('no-workspace', "abe compose runs from a card's workspace"))
        : ctx.serve.box.compose(card, args.cwd, args.args);
    },
    'workspace status': async (_, ctx) => {
      if (ctx.serve.box === undefined) return NOT_A_BOX;
      try {
        const load = await ctx.serve.box.load();

        return {
          ok: true,
          data: { workspaces: await ctx.serve.box.list(), ...(load === undefined ? {} : { load }) },
        };
      } catch (err) {
        return refused('docker-failed', message(err));
      }
    },
  }) satisfies Partial<Handlers<C>>;
