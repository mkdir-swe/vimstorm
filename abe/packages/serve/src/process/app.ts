/**
 * The composition root, the one place every port is made. The `abe` command past `abe hook`: the
 * client, `abe serve` in the foreground, `abe watch`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import {
  AWS_LOGIN_HOME,
  COMMANDS,
  textOf,
  EXIT,
  LOCAL_BROWSER,
  type AzLoginFolder,
  type LoginTool,
  type Docker,
  printFailure,
  type ServeData,
  SOCKET_MOUNT,
  PERSONAL_ENV_NAMES,
  withPersonalEnv,
} from '@abe/core';
import { basename, dirname, join } from 'node:path';
import {
  awsRunner,
  repoRoot,
  boxLinkFrom,
  boxSyncPort,
  boxAwsEnv,
  boxAwsReach,
  boxProfileOf,
  boxAwsEnvAs,
  ec2BoxesFrom,
  containerExec,
  containerRunTree,
  boxTracking,
  boxHost,
  dockerCli,
  workspaceRelays,
  awsFrom,
  adoBoardFrom,
  boardsByKind,
  githubBoardFrom,
  localBoard,
  chromiumBrowser,
  claudeOneShot,
  dockerDevtools,
  directDevtools,
  localExec,
  macChrome,
  profileStoreFrom,
  execIn,
  ghLayerPullsFrom,
  ghRetroPullsFrom,
  ghTracking,
  githubLoginsFrom,
  ghTrackingFrom,
  reviewPort,
  pipelinesFrom,
  workspaceGh,
  workspaceGit,
  gitMirrors,
  cardGit,
  localMerge,
  cliLoginTools,
  locate,
  localSheetHost,
  loginStoreFrom,
  macAwsLogin,
  macLogin,
  macToolLogin,
  terminalLogin,
  fileLogStore,
  logStoreFrom,
  chromePageShot,
  localPrototypeApps,
  localSessionApps,
  macDatabase,
  dockerCompose,
  findDocker,
  protoWorktrees,
  gitWorktrees,
  localPrototypeProxy,
  orgStoreFrom,
  pathToolProbe,
  demoShopFrom,
  resolveServePath,
  selfArgv,
  serveEnv,
  settingsPlaces,
  SocketInUse,
  holderOf,
  lockPathOf,
  startDetached,
  systemClock,
  tmuxRunner,
  secretLogins,
  workspaceRunner,
  localRunTree,
  fileInstallStore,
  localInstallRepo,
} from '@abe/ports';
import { createInterface } from 'node:readline';
import { runBridge, runRender } from './bridge';
import { personalCommandsIn, runClient } from './client';
import { type AwsAs, type ServeOptions, startServe, VERSION } from './server';
import { runWatch } from './watch-client';
import {
  anyWorkspaceExec,
  type BoxOptions,
  byContainer,
  routedRunner,
  runBoxAttach,
  runBoxForward,
  type WorkspaceDirectory,
  workspaceDirectory,
} from '../box';
import { type StoredLoginsOptions } from '../logins';
import { azureFolderAt, loadSettings, yourOwnSettings } from '../layer';
import { alive, ownerOf, watchOwner } from './owner';

const env = process.env;
const where = locate(env, homedir());

/** Inside a workspace container: `serve` is the box's, reached through the mounted socket. */
const inWorkspace = (env.ABE_WORKSPACE ?? '') !== '';

/**
 * On a box (`ABE_BOX` set by its units) `serve` is the `abe-serve` unit: a client there never
 * starts one of its own, which would run without the unit's environment.
 */
const onBoxHost = (env.ABE_BOX ?? '') !== '';

/**
 * `env` with your environment from the Layers: the box profile, region and owner,
 * the stores and your az folder that `env` leaves unset, read from your Layers (no repo's: these
 * are the org's and yours). On a box or in a workspace `env` as it is: its unit sets them.
 */
const personalEnv = (cwd?: string): Record<string, string | undefined> => {
  if (onBoxHost || inWorkspace) return env;
  const places = settingsPlaces(env, homedir());
  // in a checkout (`cwd`), your block for it too (ADR 0025)
  const repo = cwd === undefined ? undefined : repoRoot(cwd);

  // `board`'s az folder from yours alone (ADR 0030): the repo's is never yours.
  return withPersonalEnv(
    env,
    loadSettings(places, repo).values,
    home,
    yourOwnSettings(places, repo).board.azureConfigDir ?? null,
  );
};

/**
 * The box profile your boxes are reached on from `cwd`: `$ABE_BOX_PROFILE`, else `box.profile`
 * in the Layers (a shell's `$AWS_PROFILE` is none); null: none named, so no boxes.
 */
const boxProfileIn = (cwd: string): string | null => {
  const pinned = env.ABE_BOX_PROFILE ?? '';

  return pinned !== ''
    ? pinned
    : loadSettings(settingsPlaces(env, homedir()), repoRoot(cwd)).values['box.profile'];
};

/**
 * The az folder in force in `cwd` (ADR 0025), `~` under your home: `$AZURE_CONFIG_DIR`, else
 * this checkout's `board.azureConfigDir`, else yours; none: `abe login az` keeps a private one.
 */
const azFolderIn = (cwd: string): AzLoginFolder | undefined => {
  const places = settingsPlaces(env, homedir());
  const at = azureFolderAt(
    { environment: env, at: (dir) => loadSettings(places, repoRoot(dir)) },
    cwd,
  );

  if (at.from === 'none') return undefined;

  return { dir: personalEnv(cwd).AZURE_CONFIG_DIR ?? at.dir, from: at.from };
};

/**
 * `$ABE_LOG_STORE`'s store (`stores.logs`); none set on the Mac: a folder in Abe's state, so
 * `abe improve retro me` reads this machine's sessions on a local install. `$ABE_LOG_EVERY_MS`
 * shortens the five minutes (tests).
 */
const logs = (): Pick<ServeOptions, 'logs'> => {
  const store =
    logStoreFrom(env) ?? (onBoxHost ? undefined : fileLogStore(join(where.stateDir, 'logs')));
  const every = Number(env.ABE_LOG_EVERY_MS ?? '');

  if (store === undefined) return {};

  return { logs: Number.isInteger(every) && every > 0 ? { store, every } : { store } };
};

/** Where the login tools keep their logins: the person's `HOME`. */
const home = env.HOME ?? homedir();

/**
 * The person's logins: `$ABE_LOGINS_SECRET` names their secret (the box's service sets it;
 * on the Mac none, so nothing is restored over the Mac's own logins); `$ABE_LOGINS_STORE` a
 * `file://` folder in its place; `$ABE_LOGINS_EVERY_MS` shortens the look for refreshes (tests).
 */
const storedLogins = (): StoredLoginsOptions => {
  const every = Number(env.ABE_LOGINS_EVERY_MS ?? '');
  const secret = (env.ABE_LOGINS_SECRET ?? '') === '' ? null : (env.ABE_LOGINS_SECRET ?? null);
  // A box's aws login in a HOME of its own, apart from Reach's ~/.aws; the Mac's is your own.
  const awsHome = secret === null ? undefined : join(home, AWS_LOGIN_HOME);

  return {
    secret,
    store: loginStoreFrom(env),
    tools: cliLoginTools({ env, home, ...(awsHome === undefined ? {} : { awsHome }) }),
    home,
    ...(awsHome === undefined ? {} : { awsHome }),
    // serve's env holds your Layer's az folder by now: the login is kept where az keeps it
    ...(env.AZURE_CONFIG_DIR === undefined ? {} : { azureConfigDir: env.AZURE_CONFIG_DIR }),
    ...(Number.isInteger(every) && every > 0 ? { every } : {}),
  };
};

/**
 * The abe installed on a box: its image build (`$ABE_IMAGES_DIR`, else `/opt/abe/images`,
 * where the box's boot unpacks the release), the release's version and VimStorm's nvim config
 * beside it (`version`, else this binary's; `nvim`) and this binary with its sha256: what
 * `workspace up` builds the base image from when the one there is labelled otherwise. None from
 * source (bun runs it: no binary to bake in).
 */
const installedBase = (): BoxOptions['base'] => {
  const images = env.ABE_IMAGES_DIR ?? '/opt/abe/images';
  const dir = join(images, 'base');
  const bin = env.ABE_BIN ?? process.execPath;

  if (!existsSync(join(dir, 'Dockerfile')) || basename(bin).startsWith('bun')) return undefined;
  const file = join(dirname(images), 'version');
  const version = existsSync(file) ? readFileSync(file, 'utf8').trim() : VERSION;
  const hash = createHash('sha256').update(readFileSync(bin)).digest('hex');
  const nvim = join(dirname(images), 'nvim');

  return {
    dir,
    bin,
    ...(existsSync(join(nvim, 'init.lua')) ? { nvim } : {}),
    release: { version: version === '' ? VERSION : version, hash },
  };
};

/**
 * On a box (`ABE_BOX=1`, set by the box's service): this `serve` runs the box's workspaces, one
 * per card (ADR 0022), each card's container named by `directory`.
 */
const box = (): (BoxOptions & { directory: WorkspaceDirectory }) | undefined => {
  if ((env.ABE_BOX ?? '') === '') return undefined;
  const docker = dockerCli({ env });
  const base = installedBase();

  return {
    dir: where.stateDir,
    docker,
    directory: workspaceDirectory(docker),
    // The box's machine: its load and its root disk grown as the workspaces fill it.
    host: boxHost({ env }),
    mirrors: gitMirrors({ dir: join(where.stateDir, 'mirrors'), env }),
    sleep: (ms) => Bun.sleep(ms),
    // Each workspace's Chromium runs in its container, started there through docker exec.
    browserOf: (container) =>
      chromiumBrowser(execIn(docker, container), dockerDevtools({ env, container })),
    // A dev server in a workspace reached from the box's own loopback.
    relays: workspaceRelays({ env }),
    // a workspace's docker compose, run on the box's own Docker (never its socket in a workspace)
    compose: {
      compose: dockerCompose({
        bin:
          env.ABE_DOCKER === undefined || env.ABE_DOCKER === '' ? findDocker(env) : env.ABE_DOCKER,
      }),
      env: Object.fromEntries(
        Object.entries(env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
      ),
    },
    ...(base === undefined ? {} : { base }),
  };
};

/** `$ABE_TMUX`, else `tmux` on `PATH` or where Homebrew puts it. */
const findTmux = () =>
  env.ABE_TMUX ??
  Bun.which('tmux', { PATH: `${env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin` }) ??
  null;

/**
 * Who this serve runs as, for a session's `USER` (how claude finds its login): `$USER`, else
 * `$LOGNAME`, else `id -un` (Bun's `userInfo()` answers "unknown" without `$USER`).
 */
const loginName = () =>
  env.USER ??
  env.LOGNAME ??
  (Bun.spawnSync(['/usr/bin/id', '-un']).stdout.toString().trim() || undefined);

/** `abe session attach`: the terminal handed to `tmux attach` until it detaches. */
const attach = async (argv: readonly string[]) => {
  const child = Bun.spawn([...argv], { stdio: ['inherit', 'inherit', 'inherit'], env });

  return child.exited;
};

const write = (stdout: string, stderr: string) => {
  if (stdout !== '') process.stdout.write(stdout);
  if (stderr !== '') process.stderr.write(stderr);
};

/**
 * On a box, each session runs in its card's workspace container (ADR 0022): its tmux, the
 * session sockets under that workspace's socket folder, attached with `docker exec -it` (its
 * client ended in there too when the terminal hangs up).
 */
const workspaceSessions = (docker: Docker, directory: WorkspaceDirectory) =>
  routedRunner({
    docker,
    runnerOf: (card) => {
      const names = directory.namesOf(card);

      return workspaceRunner({
        exec: containerExec(docker, names.container),
        socketDir: join(where.stateDir, names.socketDir),
        socketMount: SOCKET_MOUNT,
        attachVia: ['docker', 'exec', '-it', names.container],
        execVia: ['docker', 'exec', names.container],
      });
    },
  });

/**
 * How often the Mac's serve looks at a box coming up, a Queued launch and a box's event stream:
 * `$ABE_CLOUD_POLL_MS` for all three (tests), else the defaults.
 */
const cloudTimes = () => {
  const ms = Number(env.ABE_CLOUD_POLL_MS ?? '');
  const every = Number.isFinite(ms) && ms > 0 ? ms : undefined;

  return {
    sleep: (wait: number) => Bun.sleep(wait),
    ...(every === undefined ? {} : { pollMs: every, queuePollMs: every, followRetryMs: every }),
  };
};

/** `$ABE_IDLE_EVERY_MS` on a box (a proof's short look), else a minute. */
const idleTimes = () => {
  const every = Number(env.ABE_IDLE_EVERY_MS ?? '');

  return Number.isFinite(every) && every > 0 ? { everyMs: every } : {};
};

/** `$ABE_FRESH_MS` shortens fresh data's 2 min between looks (tests), else the default. */
const freshTimes = () => {
  const every = Number(env.ABE_FRESH_MS ?? '');

  return Number.isFinite(every) && every > 0 ? { freshMs: every } : {};
};

/** How long `session list` and `watch` wait on EC2 for your boxes. */
const SCAN_TIMEOUT_MS = 5_000;

/** `abe serve`: listens until `abe serve stop`, SIGINT or SIGTERM. */
const foreground = async (json: boolean): Promise<number> => {
  let serve: Awaited<ReturnType<typeof startServe>> | undefined;

  // from the first line: a serve whose start hangs is watched too
  watchedOwner(() => serve?.stop());
  // The Mac's serve takes its person's login shell's PATH before anything reads `env`, so
  // its tools check, sessions and checks find node where a terminal does (Volta, nvm, fnm, asdf,
  // mise), whoever started it (the app from the Dock: launchd's PATH). The login shell's order
  // wins over the PATH serve was started with (a terminal's `nvm use` there does not carry).
  // `$ABE_LOGIN_PATH=off` keeps the PATH it was started with (tests). A box's PATH is its unit's.
  if (process.platform === 'darwin' && !onBoxHost && env.ABE_LOGIN_PATH !== 'off') {
    const resolved = await resolveServePath({ env, home });

    env.PATH = resolved.path;
    process.stderr.write(`${resolved.said}\n`);
  }
  // Your environment from the Layers, before anything reads `env`: VimStorm opened from
  // the Dock has none of it. What the environment itself set is kept, for `settings explain`.
  const startedEnv = Object.fromEntries(PERSONAL_ENV_NAMES.map((name) => [name, env[name]]));
  // A box profile named by your Layer or $ABE_BOX_PROFILE (a shell's $AWS_PROFILE is not one):
  // boxes are read even with serve.target local.
  const profileNamed =
    !onBoxHost &&
    ((env.ABE_BOX_PROFILE ?? '') !== '' ||
      loadSettings(settingsPlaces(env, homedir()), undefined).values['box.profile'] !== null);

  for (const [name, value] of Object.entries(personalEnv()))
    if (value !== undefined && env[name] !== value) env[name] = value;
  const onBox = box();
  // A box's runs are in their card's workspace container (ADR 0022): their worktree is the
  // clone on its volume, their transcripts under the container's home, pushed from inside it.
  const boxPorts =
    onBox === undefined
      ? undefined
      : {
          git: byContainer(onBox.directory, (c) => workspaceGit(containerExec(onBox.docker, c))),
          tree: byContainer(onBox.directory, (c) =>
            containerRunTree(containerExec(onBox.docker, c)),
          ),
        };
  const aws = awsFrom(env);
  // The box's owner (its boot sets it from its abe:owner tag): whose logins its sessions get.
  const owner = env.ABE_OWNER ?? '';
  const region =
    [env.AWS_REGION, env.AWS_DEFAULT_REGION].find((r) => r !== undefined && r !== '') ?? null;
  // On a box, GitHub is the workspace's: its gh has the person's login (the pr stage).
  // Who you are there is the box's owner, never that gh's (SourceIdentity, the log store).
  const tracking =
    onBox === undefined
      ? ghTrackingFrom(env)
      : boxTracking(env, ghTracking(workspaceGh(anyWorkspaceExec(onBox.docker))));
  // A card's own (ADR 0022): its session's and run's GitHub through its workspace's `gh` only.
  const trackingOf =
    onBox === undefined
      ? undefined
      : byContainer(onBox.directory, (c) =>
          boxTracking(env, ghTracking(workspaceGh(containerExec(onBox.docker, c)))),
        );
  // Your gh logins on the Mac (`logins.gh`, ADR 0025): never switched, tokens in-process.
  const github = onBox === undefined ? githubLoginsFrom(env) : undefined;
  // A box's own name (the launch template's user data sets it): its idle stop's.
  const boxName = env.ABE_BOX_NAME ?? '';
  // The Mac's boxes (ADR 0021): EC2 as the person, on their SSO profile ($ABE_BOX_PROFILE, else
  // AWS_PROFILE); theirs are the ones tagged with their GitHub login ($ABE_OWNER, else gh's).
  const boxEnv = boxAwsEnv(env);
  const boxes = onBox === undefined ? ec2BoxesFrom(env) : undefined;
  // Your AWS on another profile a checkout names (`box.profile`, ADR 0025): the same, on it.
  const awsAs = (profile: string): AwsAs => {
    const as = { ...env, AWS_PROFILE: profile };
    const asBoxes = ec2BoxesFrom(as);

    return {
      ...awsFrom(as),
      reach: () => boxAwsReach(as, home),
      cloud: {
        boxes: asBoxes,
        scanList: ec2BoxesFrom(as, awsRunner(as, SCAN_TIMEOUT_MS)).list,
        link: boxLinkFrom(as, selfArgv([]), { aws: awsRunner(as, 60_000), boxes: asBoxes, region }),
      },
    };
  };

  try {
    serve = await startServe({
      socket: where.socket,
      clock: systemClock,
      pid: process.pid,
      tracking,
      ...(trackingOf === undefined ? {} : { trackingOf }),
      ...github,
      // the Mac's PR review in the Git Log (a box has no checkout of the person's)
      ...(onBox === undefined ? { review: reviewPort(env) } : {}),
      ...aws,
      // Set by the box's service; the environment accounts' roles trust only box roles anyway.
      reachTarget: env.ABE_REACH_TARGET === 'cloud' ? 'cloud' : 'local',
      // a card's images, read for the story dialog
      board: boardsByKind({
        // your az folder per checkout, unless serve's own environment set $AZURE_CONFIG_DIR
        azure: adoBoardFrom(env, join(where.stateDir, 'images'), {
          pinned: (startedEnv.AZURE_CONFIG_DIR ?? '') !== '',
        }),
        // a board On this Mac: its cards stay in this state folder
        local: localBoard({
          dir: join(where.stateDir, 'local', 'board'),
          clock: systemClock,
          me: { name: loginName() ?? userInfo().username, email: '' },
        }),
        // the repo's GitHub Issues, as the checkout's gh login
        github: githubBoardFrom(env),
      }),
      // Local mode's pull requests, merged on the Mac only.
      ...(onBox === undefined ? { localMerge: localMerge({ env }) } : {}),
      // `card checkout`: a card's branch from origin, checked out on the Mac only.
      ...(onBox === undefined ? { checkout: gitWorktrees(env).fromOrigin } : {}),
      ...freshTimes(),
      // The Pipelines tab's runs, the Mac's alone (a box has no Pipelines tab of its own).
      ...(onBox === undefined ? { pipelines: pipelinesFrom(env) } : {}),
      settings: settingsPlaces(env, homedir()),
      ...(onBoxHost ? {} : { environment: startedEnv }),
      // Your environment: this serve's state directory (on a box, the box's).
      sheets: {
        dir: join(where.stateDir, 'sheets'),
        host: localSheetHost(),
        org: orgStoreFrom(env),
      },
      ...(onBox === undefined
        ? {
            // Your environment on this Mac: a detached worktree per prototype. On a box the
            // workspace runs the app, behind the same port.
            prototypes: {
              dir: join(where.stateDir, 'prototypes'),
              apps: localPrototypeApps({ dir: join(where.stateDir, 'prototypes'), env }),
              proxy: localPrototypeProxy(),
              worktrees: protoWorktrees(env),
              // the install's Prototype check's screenshot: this Mac's headless Chrome
              shot: chromePageShot({
                executable: LOCAL_BROWSER.executables(home).find((p) => existsSync(p)) ?? null,
                env,
              }),
            },
            // Abe's Mac database: a database per local session and prototype.
            mac: macDatabase({
              dir: join(where.stateDir, 'mac-db'),
              env,
              ...(env.ABE_DOCKER === undefined || env.ABE_DOCKER === ''
                ? {}
                : { bin: env.ABE_DOCKER }),
            }),
            // A local session's `abe run`, database hook and leftovers.
            local: {
              apps: localSessionApps({ stateDir: where.stateDir }),
              // Docker compose for its scripts: the local Docker only.
              compose: dockerCompose({
                bin:
                  env.ABE_DOCKER === undefined || env.ABE_DOCKER === ''
                    ? findDocker(env)
                    : env.ABE_DOCKER,
              }),
              // A local Factory run's own headless Chrome, started outside its sandbox.
              browser: {
                browser: chromiumBrowser(localExec(env), directDevtools),
                executable: LOCAL_BROWSER.executables(home).find((p) => existsSync(p)) ?? null,
              },
            },
          }
        : { box: onBox }),
      ...logs(),
      storedLogins: storedLogins(),
      toolProbe: pathToolProbe({ env, home }),
      // `abe demo new`: the demo this abe bundles, on the Mac only.
      ...(onBox === undefined ? { demo: demoShopFrom(env) } : {}),
      // A card starts only in a checkout whose install is done: the Mac's serve.
      cardsNeedInstall: onBox === undefined,
      // Factory install: the checkout's local files, its records in the state.
      install: {
        repo: localInstallRepo({ env }),
        store: fileInstallStore(join(where.stateDir, 'installs')),
      },
      // The Mac's boxes' AWS profile and region, for Settings' Problems.
      ...(onBox === undefined
        ? {
            awsReach: () => boxAwsReach(env, home),
            awsAs,
            // serve's own box profile; $ABE_BOX_PROFILE pins it over the Layers
            boxProfile: {
              own: boxProfileOf(env),
              pinned: (startedEnv.ABE_BOX_PROFILE ?? '') !== '',
            },
          }
        : {}),
      // Browser profiles' sign-ins: your secrets beside the logins; Chrome on the Mac only.
      browserProfiles: {
        store: profileStoreFrom(env),
        ...(onBox === undefined ? { chrome: macChrome() } : {}),
      },
      oneShot: claudeOneShot(),
      layerPulls: ghLayerPullsFrom(env),
      retroPulls: ghRetroPullsFrom(env),
      sessions: {
        stateDir: where.stateDir,
        defaultStates: where.defaultStates,
        configDir: settingsPlaces(env, homedir()).configDir,
        env: { ...env, USER: loginName() },
        runner:
          onBox === undefined
            ? tmuxRunner({
                stateDir: where.stateDir,
                tmux: findTmux(),
                env,
                self: selfArgv([]),
                plugins: where.plugins,
              })
            : workspaceSessions(onBox.docker, onBox.directory),
        // A box's run worktree is the workspace's clone: pushed from inside the container.
        git: boxPorts === undefined ? cardGit({ env }) : boxPorts.git(null),
        // A box's runs are in its workspace container: their worktree is the clone on its
        // volume, their transcripts under the container's home.
        tree:
          boxPorts === undefined
            ? localRunTree({ ...env, USER: loginName() })
            : boxPorts.tree(null),
        // Each card's own on a box (ADR 0022): its workspace's container.
        ...(boxPorts === undefined ? {} : { byCard: boxPorts }),
      },
      // The Mac's serve: your environment, your boxes (serve.target says when it is used).
      ...(boxes !== undefined
        ? {
            cloud: {
              boxes,
              // A session list or watch waits on EC2 only this long (offline: not 30 s each).
              scanList: ec2BoxesFrom(env, awsRunner(boxEnv, SCAN_TIMEOUT_MS)).list,
              link: boxLinkFrom(env, selfArgv([]), {
                aws: awsRunner(boxEnv, 60_000),
                boxes,
                region,
              }),
              self: selfArgv([]),
              // a fake `abe box attach` in tests
              ...(env.ABE_BOX_ATTACH === undefined || env.ABE_BOX_ATTACH === ''
                ? {}
                : { boxAttach: [env.ABE_BOX_ATTACH] }),
              region,
              // Named by a Layer or the environment: read even with serve.target local.
              profileNamed,
              // box parity (3.2.1): Claude Code's store here, a sync into a workspace on stdin
              boxSync: boxSyncPort(env),
              ...cloudTimes(),
            },
          }
        : {}),
      // Without $ABE_LOGINS_SECRET, a box's sessions read the seeds directly; with it,
      // serve hands them the stored logins restored on this box.
      ...(onBox !== undefined && owner !== ''
        ? {
            logins: secretLogins({
              secrets: aws.secrets,
              owner,
              region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null,
            }),
          }
        : {}),
      // The box stops itself when idle (ADR 0021): its settings read in its home.
      ...(onBox !== undefined && boxName !== ''
        ? { idle: { name: boxName, host: boxHost({ env }), cwd: home, ...idleTimes() } }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SocketInUse ? 'serve-running' : 'failed';
    const out = printFailure({ code, message }, EXIT.failed, json);

    write(out.stdout, out.stderr);

    return out.exit;
  }
  const started = serve;
  const data: ServeData = { version: VERSION, pid: process.pid, socket: started.socket };

  write(json ? `${JSON.stringify({ ok: true, data })}\n` : textOf(COMMANDS.serve, data), '');
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => void started.stop());
  await started.stopped;

  return EXIT.ok;
};

/** A test's serve ends its sessions' tmux server, then itself, once its owner is gone. */
const watchedOwner = (stopServe: () => Promise<void> | undefined) => {
  const pid = ownerOf(env);

  if (pid === undefined) return;
  watchOwner({
    pid,
    alive,
    gone: async () => {
      const tmux = findTmux();
      const socket = join(where.stateDir, 'tmux.sock');

      if (tmux !== null && existsSync(socket))
        Bun.spawnSync([tmux, '-S', socket, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' });
      await stopServe();
    },
    exit: () => process.exit(EXIT.ok),
  });
};

/** Resolves on the first SIGINT or SIGTERM, which then no longer kill the process. */
const interrupted = () =>
  new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        resolve();
      });
  });

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  const options = {
    cwd: process.cwd(),
    where,
    ...(inWorkspace || onBoxHost
      ? {}
      : {
          // on an allowlist: never the cloud keys or a checkout's env file a shell carries
          startServe: () => {
            startDetached(selfArgv(['serve']), serveEnv(env), where.log);
          },
          serveHeld: () => {
            const holder = holderOf(lockPathOf(where.socket));

            return holder !== undefined && alive(holder.pid);
          },
        }),
    sleep: (ms: number) => Bun.sleep(ms),
    now: () => Date.now(),
    personalCommands: () => personalCommandsIn(settingsPlaces(env, homedir()).configDir),
    // The logins on your environment from the Layers, as serve's own: az in your Layer's folder
    // (never az's default one), the box profile and region for your secret.
    ...(inWorkspace
      ? {}
      : {
          login: (tool: LoginTool, tenant?: string, profile?: string) =>
            // run only where serve keeps a secret (a box): aws there signs in to its own HOME;
            // on the Mac, az in this checkout's folder (yours for the repo, ADR 0030)
            terminalLogin({
              env: personalEnv(process.cwd()),
              home,
              now: () => Date.now(),
              awsHome: join(home, AWS_LOGIN_HOME),
            })(tool, tenant, profile),
        }),
    ...(inWorkspace || onBoxHost
      ? {}
      : {
          // in a checkout, its az folder and box profile (ADR 0025)
          macLogin: (tenant?: string) => {
            const folder = azFolderIn(process.cwd());

            return macLogin({
              env: personalEnv(process.cwd()),
              now: () => Date.now(),
              ...(folder === undefined ? {} : { azureConfigDir: folder }),
              boxProfile: boxProfileIn(process.cwd()),
            })(tenant);
          },
          macAwsLogin: (profile: string) =>
            macAwsLogin({
              env: personalEnv(),
              now: () => Date.now(),
              boxProfile: boxProfileIn(process.cwd()),
            })(profile),
          macToolLogin: (tool: 'github' | 'claude') =>
            macToolLogin({ env: personalEnv(), boxProfile: boxProfileIn(process.cwd()) })(tool),
        }),
    // a person at a terminal is told what a slow answer waits on; a script or an agent is not
    ...(process.stderr.isTTY ? { slow: (line: string) => void process.stderr.write(line) } : {}),
    // A waiting box or session command says what it waits for; a session's own never,
    // nor a box's `abe` the Mac's serve runs (`--on`): the Mac draws that line itself.
    ...(inWorkspace || onBoxHost
      ? {}
      : {
          progress: {
            write: (text: string) => process.stderr.write(text),
            tty: process.stderr.isTTY,
          },
        }),
  };
  const client = await runClient(argv, options);

  if (client.kind === 'serve' && inWorkspace) {
    const why = 'abe serve cannot be run from inside a workspace: its serve is the box';
    const out = printFailure({ code: 'not-in-session', message: why }, EXIT.failed, client.json);

    write(out.stdout, out.stderr);

    return out.exit;
  }
  // A stopped serve exits: a timer or handle something left open keeps no process running.
  // Its last line written first: a piped caller reads why it failed (serve-running).
  if (client.kind === 'serve') {
    const exit = await foreground(client.json);

    await Promise.all(
      [process.stdout, process.stderr].map(
        (out) =>
          new Promise<void>((resolve) => {
            out.write('', () => {
              resolve();
            });
          }),
      ),
    );
    process.exit(exit);
  }
  if (client.kind === 'attach') return attach(client.argv);
  // Its stdin may still be read when the box's end comes: exit now, as ui-bridge does.
  // On the running serve's box profile and region when it said them, not this env's.
  if (client.kind === 'box-attach')
    process.exit(
      await runBoxAttach(
        client.box,
        client.what,
        client.aws === undefined ? personalEnv() : boxAwsEnvAs(personalEnv(), client.aws),
        selfArgv([]),
        { write },
      ),
    );
  if (client.kind === 'box-forward')
    return runBoxForward(
      client.box,
      client.port,
      client.json,
      client.aws === undefined ? personalEnv() : boxAwsEnvAs(personalEnv(), client.aws),
      selfArgv([]),
      { write },
    );
  if (client.kind === 'ui-render') {
    const printed = await runRender(client.screen, client.page, client.json, client.start, options);

    write(printed.stdout, printed.stderr);

    return printed.exit;
  }
  // The app closed stdin: exit now, not once a read still in flight gives up.
  if (client.kind === 'ui-bridge')
    process.exit(
      await runBridge(client.start, options, {
        lines: createInterface({ input: process.stdin, crlfDelay: Infinity }),
        write: (line) => process.stdout.write(line),
        log: (message) => process.stderr.write(`${message}\n`),
        sleep: (ms) => Bun.sleep(ms),
      }),
    );
  if (client.kind === 'watch')
    return runWatch(argv, client.json, client.start, options, {
      write,
      interrupted: interrupted(),
    });
  write(client.printed.stdout, client.printed.stderr);

  return client.printed.exit;
};

process.exitCode = await main();
