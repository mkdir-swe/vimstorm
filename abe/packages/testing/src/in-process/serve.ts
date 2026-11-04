/**
 * A real `serve` in this test's process, on a temporary socket and state directory, with fake
 * ports. `request` speaks the socket protocol, so a test reads exactly what a client reads.
 */
import { createConnection } from 'node:net';
import {
  type Aws,
  type Compose,
  type Envelope,
  readEnvelope,
  type MacDatabase,
  type Board,
  type Git,
  type OrgStore,
  type RunTree,
  PROTOCOL,
  type ReachTarget,
  type SessionRunner,
  type EventLine,
  Reply,
  WatchFrame,
  type Secrets,
  type Pipelines,
  type CardCheckout,
  type Tracking,
  type ReviewPort,
} from '@abe/core';
import {
  adoBoardFrom,
  boardsByKind,
  githubBoardFrom,
  localBoard,
  ask,
  awsFrom,
  awsRunner,
  boxAwsEnv,
  boxLinkFrom,
  cardGit,
  localMerge,
  containerExec,
  containerRunTree,
  ec2BoxesFrom,
  ghTrackingFrom,
  githubLoginsFrom,
  type GithubLogins,
  localRunTree,
  localSessionApps,
  macDatabase,
  pipelinesFrom,
  profileStoreFrom,
  reviewPort,
  localSheetHost,
  sessionSocket,
  settingsPlaces,
  tmuxRunner,
} from '@abe/ports';
import {
  byContainer,
  type Serve,
  type ServeOptions,
  startServe,
  type StoredLoginsOptions,
  VERSION,
  workspaceDirectory,
} from '@abe/serve';
import { join } from 'node:path';
import { type z } from 'zod';
import { type Cli, type Ran, type RunOptions } from './cli';
import { refusingBoard } from './board';
import { fakeBrowser, type FakeBrowser } from './browser';
import { fakeClock, type FakeClock, wallClock } from './clock';
import {
  echoRelays,
  fakeDocker,
  type FakeDocker,
  fakeMirrors,
  type FakeMirrors,
  type FakeRelays,
} from './docker';
import { refusingAws, refusingSecrets } from './reach';
import { killTmux, tmuxPath } from '../tools/claude';
import { refusingTracking } from './tracking';
import { tempState, type TempState } from './state';
import { installFakes } from './install';

export type ServeScenario = {
  state: TempState;
  clock: FakeClock;
  serve: Serve;
  /** `abe <argv…>` through the socket: the reply frame. */
  request: (...argv: string[]) => Promise<Reply>;
  /** `abe <argv…>` typed in `cwd`, so it runs in that checkout's own repo. */
  requestIn: (cwd: string, ...argv: string[]) => Promise<Reply>;
  /** The fakes of a box's `serve` (`scenario({ box })`). */
  box: { docker: FakeDocker; mirrors: FakeMirrors; browser: FakeBrowser; relays: FakeRelays };
  /** `abe <argv…>` on card 101's workspace socket, as from inside a box's container. */
  requestInside: (...argv: string[]) => Promise<Reply>;
  /** A request on `card`'s workspace socket. */
  requestInsideOf: (card: string, ...argv: string[]) => Promise<Reply>;
  /** `abe <argv…>` through a session's own socket, typed in `cwd`, as its agent runs it. */
  requestAs: (session: string, cwd: string, ...argv: string[]) => Promise<Reply>;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export type ScenarioOptions = {
  clock?: FakeClock;
  /** Beside the state's own variables, where your files are (`ABE_CONFIG_DIR`). */
  env?: Record<string, string>;
  /** Where `served()`'s requests are typed unless one says (a checkout); defaults to the state folder. */
  cwd?: string;
  version?: string;
  /** The abe installed on this Mac now, as serve reads it; none: not known. */
  installed?: () => string | undefined;
  tracking?: Tracking;
  /** Your gh logins (`githubLoginsFrom` over a fake gh): `logins.gh`'s ports and tokens. */
  github?: GithubLogins;
  /** VimStorm's PR review (`fakeReview()`). None by default, so serve refuses it. */
  review?: ReviewPort;
  /** GitHub Actions and Azure Pipelines. Without them serve refuses `abe pipeline`. */
  pipelines?: Pipelines;
  /** `card checkout`'s port (`gitWorktrees(env).fromOrigin`). None refuses it, as on a box. */
  checkout?: CardCheckout;
  aws?: Aws;
  secrets?: Secrets;
  board?: Board;
  /** The org store Sheets attach into (`fileOrgStore(dir)`). None by default. */
  org?: OrgStore;
  ring?: number;
  /** Runs it as a box's `serve` with these fakes (or fresh ones). */
  box?: true | Partial<ServeScenario['box']>;
  /** How often the box's `serve` reads its browser for activity (default: an hour, so never). */
  browserPollMs?: number;
  /** Where the box's workspace clone is, as a stand-in's `workdir` (default: the container's). */
  boxWorkdir?: string;
  /** The box's own machine for its load and disk (default: none, so no load). */
  boxHost?: NonNullable<ServeOptions['box']>['host'];
  /** How often the box reads its load (default: an hour, so on the first ask only). */
  loadEveryMs?: number;
  /** How often the box looks at what listens in its workspaces (default: an hour, so never). */
  portsEveryMs?: number;
  /** The abe installed on the box, which its base image is built from (default: none known). */
  boxBase?: NonNullable<ServeOptions['box']>['base'];
  /** A state directory from before: a `serve` started again on the same box. */
  state?: TempState;
  /**
   * Sessions in a real `tmux` (`tmuxPath()`), whose `abe` is this checkout's. `env` is serve's own,
   * beside the state's. It puts the fake `claude` first on `PATH` and says where your files are
   * (`ABE_CONFIG_DIR`). `runner` replaces the runner, as a box's
   * `standInWorkspace().runner` does. `tree` replaces the run tree. By default that is this
   * machine's disk, or a box's workspace container through its fake Docker.
   */
  sessions?: {
    env?: Record<string, string>;
    runner?: SessionRunner;
    git?: Git;
    tree?: RunTree;
    /** A session's `abe run` for real beside a fake `runner` (always so with the real one). */
    local?: boolean;
  };
  /** How often serve reads a Factory run's pull request (default: an hour, so only on `poll`). */
  factoryPollMs?: number;
  /** On a box: its owner's logins. */
  logins?: ServeOptions['logins'];
  /** On a box, its idle stop. By default it reads its settings in the state directory. */
  idle?: Omit<NonNullable<ServeOptions['idle']>, 'cwd'> & { cwd?: string };
  /** `cloud` for a box's serve, so it gets write names. */
  reachTarget?: ReachTarget;
  /** The Mac's AWS profile and region for boxes, which Problems checks. Not checked by default. */
  awsReach?: ServeOptions['awsReach'];
  /** When a Done run done at `ms` clears (default: the next local midnight). */
  midnightAfter?: (ms: number) => number;
  /** The person's logins: their secret, a fake store and tools, a home. */
  storedLogins?: StoredLoginsOptions;
  /** Where session logs are shipped; none by default. */
  logs?: ServeOptions['logs'];
  /** Starts serve without the Layers' files, so it refuses `abe settings`. */
  noSettings?: true;
  /**
   * How `abe tools check` runs a tool's check (`fakeToolProbe`). None by default, so serve refuses
   * it.
   */
  toolProbe?: ServeOptions['toolProbe'];
  /** `abe demo new`'s world; none: refused. */
  demo?: ServeOptions['demo'];
  /** Factory install. By default it uses the checkout's real files and git, and no URL answers. */
  install?: ServeOptions['install'];
  /** Cards start only in a checkout whose install is done, as on the Mac. Off by default. */
  cardsNeedInstall?: true;
  /** What serve says in serve.log (default: nothing). */
  log?: (message: string) => void;
  /** Abe's Mac database. By default the real one, over a `docker` that is not there. */
  mac?: MacDatabase;
  /** A local Factory run's own browser, a fake Chrome. None by default. */
  localBrowser?: NonNullable<NonNullable<ServeOptions['local']>['browser']>;
  /**
   * Docker compose for a local session's scripts, or on a box for its workspaces' (`fakeCompose`).
   * None by default.
   */
  compose?: Compose;
  /** Browser profiles' stored sign-ins and the Mac's Chrome. None by default. */
  browserProfiles?: ServeOptions['browserProfiles'];
  /** The Mac's boxes on EC2 and its link to them, as fakes. None by default. */
  cloud?: ServeOptions['cloud'];
  /** Your AWS on another profile a checkout names, and serve's own profile. None by default. */
  awsAs?: ServeOptions['awsAs'];
  boxProfile?: ServeOptions['boxProfile'];
  /**
   * One-shots (`claude -p`, from `claudeOneShot()`), run in `sessions.env`. None by default, so
   * serve refuses them.
   */
  oneShot?: ServeOptions['oneShot'];
  /** A Layer's repo on GitHub (`ghLayerPullsFrom(env)`). None by default, so serve refuses it. */
  layerPulls?: ServeOptions['layerPulls'];
  /** Improve retro's GitHub reads (`ghRetroPullsFrom(env)`). None by default. */
  retroPulls?: ServeOptions['retroPulls'];
  /** Prototypes' apps, proxy and folder (`localPrototypeApps`…). None by default (refused). */
  prototypes?: ServeOptions['prototypes'];
};

const ENTRY = join(import.meta.dir, '..', '..', '..', 'serve', 'src', 'main.ts');

/** How this checkout's `abe` runs in a test, the client run as the Mac's serve runs itself. */
export const SELF: readonly string[] = [process.execPath, ENTRY];

/**
 * The Mac's boxes as `abe serve` builds them from `env` (app.ts): EC2 through the `aws` on its
 * `PATH`, the link `$ABE_BOX_LINK` names, `$ABE_BOX_ATTACH`, `$ABE_CLOUD_POLL_MS`.
 */
export const macCloudFrom = (env: Record<string, string>): NonNullable<ServeOptions['cloud']> => {
  const boxEnv = boxAwsEnv(env);
  const boxes = ec2BoxesFrom(env);
  const region =
    [env.AWS_REGION, env.AWS_DEFAULT_REGION].find((r) => r !== undefined && r !== '') ?? null;
  const ms = Number(env.ABE_CLOUD_POLL_MS ?? '');
  const every = Number.isFinite(ms) && ms > 0 ? ms : undefined;
  const attach = env.ABE_BOX_ATTACH ?? '';

  return {
    boxes,
    scanList: ec2BoxesFrom(env, awsRunner(boxEnv, 5_000)).list,
    // The box's `abe` runs in a home, never in this test's checkout. A forwarded command's repo is
    // the one it names. A real link's shell starts in the box's home, a detached serve in its own
    // cwd.
    link: boxLinkFrom(env, ['/bin/sh', '-c', 'cd "$0" && exec "$@"', env.HOME ?? '/', ...SELF], {
      aws: awsRunner(boxEnv, 60_000),
      boxes,
      region,
    }),
    self: SELF,
    ...(attach === '' ? {} : { boxAttach: [attach] }),
    region,
    profileNamed: (env.ABE_BOX_PROFILE ?? '') !== '',
    sleep: (wait: number) => Bun.sleep(wait),
    ...(every === undefined ? {} : { pollMs: every, queuePollMs: every, followRetryMs: every }),
  };
};

const askAt = async (socket: string, cwd: string, argv: string[]) => {
  const asked = await ask(socket, JSON.stringify({ v: PROTOCOL, argv, cwd }));

  if (!asked.ok) throw new Error(asked.message);

  return Reply.parse(JSON.parse(asked.line));
};

/** `abe <argv…>` typed in `cwd` on another `serve`'s socket (a session's own, a box's). */
export const requestAt = (socket: string, cwd: string, ...argv: string[]) =>
  askAt(socket, cwd, argv);

/** `abe watch --json` over the socket, in-process: each event a JSON line, as the client prints it. */
export type Watching = {
  /** The next event's line; fails after `ms`. */
  next: (ms?: number) => Promise<string>;
  close: () => void;
};

export const watching = (socket: string, argv: string[] = ['watch', '--json']): Watching => {
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  const conn = createConnection(socket);
  let rest = '';

  conn.setEncoding('utf8');
  conn.on('connect', () => conn.write(`${JSON.stringify({ v: PROTOCOL, argv, cwd: '/' })}\n`));
  conn.on('data', (chunk: string) => {
    rest += chunk;
    for (let nl = rest.indexOf('\n'); nl !== -1; nl = rest.indexOf('\n')) {
      const frame = WatchFrame.safeParse(JSON.parse(rest.slice(0, nl)));

      rest = rest.slice(nl + 1);
      if (!frame.success) continue;
      const line = JSON.stringify(frame.data.event);
      const waiter = waiting.shift();

      if (waiter === undefined) queue.push(line);
      else waiter(line);
    }
  });
  const next = (ms = 5000) => {
    const ready = queue.shift();

    if (ready !== undefined) return Promise.resolve(ready);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = waiting.indexOf(got);

        if (at !== -1) waiting.splice(at, 1);
        reject(new Error(`no watch line in ${ms} ms`));
      }, ms);
      const got = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };

      waiting.push(got);
    });
  };

  return { next, close: () => conn.destroy() };
};

/** The events a `serve` holds now, read through `abe watch --since 0` for `ms`. */
export const heldEvents = (socket: string, ms = 150): Promise<EventLine[]> =>
  new Promise((resolve) => {
    const got: EventLine[] = [];
    const conn = createConnection(socket);
    let rest = '';

    conn.setEncoding('utf8');
    conn.on('connect', () =>
      conn.write(
        `${JSON.stringify({ v: PROTOCOL, argv: ['watch', '--since', '0', '--json'], cwd: '/' })}\n`,
      ),
    );
    conn.on('data', (chunk: string) => {
      rest += chunk;
      for (let nl = rest.indexOf('\n'); nl !== -1; nl = rest.indexOf('\n')) {
        const frame = WatchFrame.safeParse(JSON.parse(rest.slice(0, nl)));

        if (frame.success) got.push(frame.data.event);
        rest = rest.slice(nl + 1);
      }
    });
    setTimeout(() => {
      conn.destroy();
      resolve(got);
    }, ms);
  });

export const scenario = async (o: ScenarioOptions = {}): Promise<ServeScenario> => {
  const state = o.state ?? tempState();
  const clock = o.clock ?? fakeClock();
  const given = o.box === true ? {} : o.box;
  const box = {
    docker: given?.docker ?? fakeDocker(),
    mirrors: given?.mirrors ?? fakeMirrors(),
    browser: given?.browser ?? fakeBrowser(),
    relays: given?.relays ?? echoRelays(),
  };
  const env = { ...state.env, ...o.env, ...o.sessions?.env };
  // A box's workspaces, one per card (ADR 0022). Each card's run tree is in its own container.
  const directory = workspaceDirectory(box.docker);
  const boxTree = byContainer(directory, (c) => containerRunTree(containerExec(box.docker, c)));
  const serve = await startServe({
    socket: state.socket,
    clock,
    pid: process.pid,
    // This checkout's version, as the Mac's `abe` in a test says. A box on another sets `version`.
    version: o.version ?? VERSION,
    ...(o.installed === undefined ? {} : { installed: o.installed }),
    tracking: o.tracking ?? refusingTracking(),
    ...o.github,
    ...(o.review === undefined ? {} : { review: o.review }),
    ...(o.pipelines === undefined ? {} : { pipelines: o.pipelines }),
    ...(o.checkout === undefined ? {} : { checkout: o.checkout }),
    aws: o.aws ?? refusingAws(),
    secrets: o.secrets ?? refusingSecrets(),
    board: o.board ?? refusingBoard(),
    // Local mode's merges use real git in the test's own repos.
    localMerge: localMerge({ env }),
    ...(o.ring === undefined ? {} : { ring: o.ring }),
    ...(o.noSettings === true ? {} : { settings: settingsPlaces(env, state.dir) }),
    ...(o.sessions === undefined
      ? {}
      : {
          sessions: {
            stateDir: state.dir,
            env: { USER: 'tester', ...env },
            runner:
              o.sessions.runner ??
              tmuxRunner({
                stateDir: state.dir,
                tmux: tmuxPath(),
                env,
                self: [process.execPath, ENTRY],
                plugins: join(state.dir, 'plugins'),
              }),
            git: o.sessions.git ?? cardGit({ env }),
            tree:
              o.sessions.tree ??
              (given === undefined ? localRunTree({ USER: 'tester', ...env }) : boxTree(null)),
            ...(given === undefined || o.sessions.tree !== undefined
              ? {}
              : {
                  byCard: {
                    git: () => o.sessions?.git ?? cardGit({ env }),
                    tree: boxTree,
                  },
                }),
          },
          factoryPollMs: o.factoryPollMs ?? 3_600_000,
          // On the Mac, a local session's `abe run` and database hook run for real.
          ...(given === undefined && (o.sessions.runner === undefined || o.sessions.local === true)
            ? {
                local: {
                  apps: localSessionApps({ stateDir: state.dir }),
                  ...(o.localBrowser === undefined ? {} : { browser: o.localBrowser }),
                  ...(o.compose === undefined ? {} : { compose: o.compose }),
                },
              }
            : {}),
        }),
    // The Mac's database never uses this machine's Docker. There is none unless a test gives one.
    ...(given === undefined
      ? {
          mac:
            o.mac ??
            macDatabase({
              dir: join(state.dir, 'mac-db'),
              env,
              bin: env.ABE_DOCKER ?? join(state.dir, 'no-docker'),
            }),
        }
      : {}),
    ...(o.midnightAfter === undefined ? {} : { midnightAfter: o.midnightAfter }),
    ...(o.storedLogins === undefined ? {} : { storedLogins: o.storedLogins }),
    ...(o.logs === undefined ? {} : { logs: o.logs }),
    ...(o.toolProbe === undefined ? {} : { toolProbe: o.toolProbe }),
    ...(o.demo === undefined ? {} : { demo: o.demo }),
    install: o.install ?? installFakes({ env, dir: state.dir }),
    ...(o.cardsNeedInstall === undefined ? {} : { cardsNeedInstall: true }),
    ...(o.browserProfiles === undefined ? {} : { browserProfiles: o.browserProfiles }),
    ...(o.cloud === undefined ? {} : { cloud: o.cloud }),
    ...(o.awsAs === undefined ? {} : { awsAs: o.awsAs }),
    ...(o.boxProfile === undefined ? {} : { boxProfile: o.boxProfile }),
    ...(o.oneShot === undefined ? {} : { oneShot: o.oneShot }),
    ...(o.layerPulls === undefined ? {} : { layerPulls: o.layerPulls }),
    ...(o.retroPulls === undefined ? {} : { retroPulls: o.retroPulls }),
    ...(o.prototypes === undefined ? {} : { prototypes: o.prototypes }),
    log: o.log ?? (() => undefined),
    sheets: { dir: join(state.dir, 'sheets'), host: localSheetHost(), org: o.org },
    ...(o.logins === undefined ? {} : { logins: o.logins }),
    ...(o.idle === undefined ? {} : { idle: { cwd: state.dir, ...o.idle } }),
    ...(o.reachTarget === undefined ? {} : { reachTarget: o.reachTarget }),
    ...(o.awsReach === undefined ? {} : { awsReach: o.awsReach }),
    ...(given === undefined
      ? {}
      : {
          box: {
            docker: box.docker,
            mirrors: box.mirrors,
            browserOf: () => box.browser,
            directory,
            dir: state.dir,
            sleep: () => Promise.resolve(),
            browserPollMs: o.browserPollMs ?? 3_600_000,
            ...(o.boxWorkdir === undefined ? {} : { workdir: o.boxWorkdir }),
            ...(o.boxBase === undefined ? {} : { base: o.boxBase }),
            ...(o.boxHost === undefined ? {} : { host: o.boxHost }),
            loadEveryMs: o.loadEveryMs ?? 3_600_000,
            relays: box.relays,
            portsEveryMs: o.portsEveryMs ?? 3_600_000,
            ...(o.compose === undefined ? {} : { compose: { compose: o.compose, env: {} } }),
          },
        }),
  });
  // a settings file the test wrote by hand is in force for its next request, as after a poll
  const polled = (socket: string, cwd: string, argv: string[]) => {
    serve.pollSettings();

    return askAt(socket, cwd, argv);
  };
  const request = (...argv: string[]) => polled(state.socket, state.dir, argv);
  const requestIn = (cwd: string, ...argv: string[]) => polled(state.socket, cwd, argv);
  const requestInside = (...argv: string[]) => requestInsideOf('101', ...argv);
  const requestInsideOf = (card: string, ...argv: string[]) =>
    polled(join(state.dir, 'workspaces', card, 'serve.sock'), '/workspace/repo', argv);
  const requestAs = (session: string, cwd: string, ...argv: string[]) =>
    polled(sessionSocket(state.dir, session), cwd, argv);
  const close = async () => {
    await serve.stop();
    // Sessions outlive their serve, so end the tmux server it started, if any.
    await killTmux(state.dir);
    state.remove();
  };

  return {
    state,
    clock,
    serve,
    request,
    requestIn,
    box,
    requestInside,
    requestInsideOf,
    requestAs,
    close,
    [Symbol.asyncDispose]: close,
  };
};

/**
 * A `Cli`'s reads over an in-process `scenario`. `run` and `json` (typed in `cwd` with `runWith`
 * and `jsonWith`) go through the socket as the client sends them, with no `abe` process. It covers
 * only what serve answers. `stdin`, more environment, `spawn` (`abe watch`) and client-only
 * commands (`ui bridge`, `serve stop`, `login`) need `cli()`.
 */
export type ServedCli = Pick<Cli, 'state' | 'run' | 'runWith' | 'json' | 'jsonWith' | 'close'> & {
  scenario: ServeScenario;
  /** `abe watch <argv…>` (`--json`) streaming over the socket, as `cli().spawn` reads it. */
  watch: (...argv: string[]) => Watching;
};

/**
 * The Mac's serve as `abe serve` builds it from `env` (app.ts), on this machine's time. It has its
 * boxes (`macCloudFrom`), its AWS and secrets (`awsFrom`), GitHub, PR review and Pipelines from
 * `env`, its board (`adoBoardFrom`), its browser profiles' store and its own session runner. `env`
 * sits beside the state's, and `o` adds to or overrides it.
 */
export const macServed = (env: Record<string, string>, o: ScenarioOptions = {}) => {
  const state = o.state ?? tempState();
  const all = { ...state.env, ...env };

  return served({
    clock: wallClock(),
    ...awsFrom(all),
    tracking: ghTrackingFrom(all),
    github: githubLoginsFrom(all),
    review: reviewPort(all),
    pipelines: pipelinesFrom(all),
    cloud: macCloudFrom(all),
    board: boardsByKind({
      azure: adoBoardFrom(all, join(state.dir, 'images')),
      local: localBoard({
        dir: join(state.dir, 'local', 'board'),
        clock: wallClock(),
        me: { name: 'tester', email: '' },
      }),
      github: githubBoardFrom(all),
    }),
    browserProfiles: { store: profileStoreFrom(all) },
    sessions: {},
    ...o,
    state,
    env: { ...env, ...o.env },
  });
};

export const served = async (o: ScenarioOptions = {}): Promise<ServedCli> => {
  const s = await scenario(o);
  const runWith = async (w: RunOptions, ...argv: string[]): Promise<Ran> => {
    if (w.stdin !== undefined || w.env !== undefined)
      throw new Error('served(): stdin and env need cli()');
    const r = await s.requestIn(w.cwd ?? o.cwd ?? s.state.dir, ...argv);

    return { exit: r.exit, stdout: r.stdout, stderr: r.stderr };
  };
  const jsonWith = async <T extends z.ZodType>(
    w: RunOptions,
    data: T,
    ...argv: string[]
  ): Promise<{ exit: number; stderr: string; doc: Envelope<z.output<T>> }> => {
    const out = await runWith(w, ...argv, '--json');
    const lines = out.stdout.split('\n').filter((l) => l !== '');

    if (lines.length !== 1)
      throw new Error(`expected one JSON line, got: ${out.stdout}${out.stderr}`);

    return {
      exit: out.exit,
      stderr: out.stderr,
      doc: readEnvelope(data, JSON.parse(lines[0] ?? '')),
    };
  };

  return {
    scenario: s,
    state: s.state,
    run: (...argv) => runWith({}, ...argv),
    runWith,
    json: (data, ...argv) => jsonWith({}, data, ...argv),
    jsonWith,
    watch: (...argv) => watching(s.state.socket, ['watch', ...argv]),
    close: s.close,
  };
};
