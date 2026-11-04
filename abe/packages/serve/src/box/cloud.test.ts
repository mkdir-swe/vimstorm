/**
 * A session in your environment, launched from the Mac (#63, #90): the Mac's serve runs in this
 * test as `abe serve` builds it (`macServed`), its boxes are on the fake EC2 (a fake `aws` on disk,
 * reached by the real `ec2Boxes` port as the person), its link reaches the box's `serve` on its
 * socket (`ABE_BOX_LINK=socket:…`).
 * The box is a real `serve` in this test with the fake Docker port, whose workspace container is a
 * stand-in on this machine (`standInWorkspace`): the workspace runner starts the fake `claude` in a
 * real `tmux` there, and its hooks reach the box's `serve` through `abe hook` on the session's
 * socket.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type Answered,
  type Board,
  type Compose,
  type BoxHost,
  boxGoneText,
  boxName,
  type Envelope,
  BoxListData,
  BrowserData,
  CardData,
  type ProfileStore,
  readEnvelope,
  EventLine,
  FactoryChecksData,
  FactoryEndData,
  FactoryRunData,
  FactoryStatusData,
  HOOK_EVENTS,
  OrgPrototypeVersion,
  MakeCardData,
  NOT_COMMENTED,
  PrototypeData,
  type OrgStore,
  LaunchProgress,
  type Git,
  type LoginSet,
  type Secrets,
  type Tracking,
  SessionAttachData,
  SessionData,
  SessionListData,
  SessionUnqueueData,
  SessionSendData,
  SessionTranscriptData,
  SettingExplainData,
  sleptWhileWaiting,
  versionPrefix,
} from '@abe/core';
import { fileOrgStore, localPrototypeApps, localPrototypeProxy, protoWorktrees } from '@abe/ports';
import {
  claudeOutput,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeBoxAttach,
  fakeCompose,
  fakeDocker,
  fakeEc2,
  type FakeEc2,
  fakeGh,
  type FakeGh,
  fakeMirrors,
  fakeProfileStore,
  macServed,
  refusingBoard,
  refusingTracking,
  requestAt,
  scenario,
  type ServedCli,
  type ServeScenario,
  type StandIn,
  standInWorkspace,
  tempState,
  type Watching,
} from '@abe/testing';
import { z } from 'zod';
import { putVersion } from '../sheets/org';

// A box coming up, a workspace and a session: seconds, not the default 5.
setDefaultTimeout(30_000);

const REPO = 'mkdir-swe/demo-shop';
const BOX = boxName(REPO);
const READ_URL = 'postgres://reader:r3ad@test-db:5432/shop';
const CLAUDE_LOGIN = 'fake-claude-login';
const GITHUB_LOGIN = 'fake-github-login';

/**
 * The repo's settings (`abe.yaml`), the Mac's checkout and the box's alike: the board,
 * the environments, and one write granted: only a box's session gets it.
 */
const repoSettings = (board: unknown) =>
  [
    `board: ${JSON.stringify(board)}`,
    'environments:',
    '  test:',
    '    account: "111111111111"',
    '    region: eu-west-1',
    '    db:',
    '      read: { secret: abe/test/db-read }',
    'overrides:',
    '  reach:',
    '    value: [ABE_AWS_WRITE_TEST]',
    '    reason: the web team deploys test from its sessions',
    '',
  ].join('\n');

/** A checkout at `dir` with the repo's settings, and yours for it (`local`), kept out of git. */
const checkoutAt = (dir: string, repo: string, local = '') => {
  mkdirSync(join(dir, '.abe'), { recursive: true });
  shell(dir, 'git init -q -b main');
  writeFileSync(join(dir, 'abe.yaml'), repo);
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(dir, '.abe', 'settings.local.yaml'), local);
};

const secrets: Secrets = {
  read: ({ secret }) =>
    Promise.resolve(
      secret === 'abe/test/db-read'
        ? { ok: true, data: READ_URL }
        : { ok: false, error: { code: 'secret-unreadable', message: `${secret}: not found` } },
    ),
};

const logins = {
  read: (): Promise<Answered<LoginSet>> =>
    Promise.resolve({ ok: true, data: { claude: CLAUDE_LOGIN, github: GITHUB_LOGIN } }),
};

type World = {
  root: string;
  /** The Mac's checkout of the repo: where its commands are typed. */
  shop: string;
  /** The box's checkout of the repo's default branch, unless a test gives its own. */
  boxCheckout: string;
  ado: FakeAdo;
  az: FakeAz;
  gh: FakeGh;
  ec2: FakeEc2;
  standIn: StandIn;
  box: ServeScenario;
  mac: ServedCli;
};

/** The person's GitHub user, as `gh api user` answers on the box with their token. */
const ME = { login: 'octocat', id: 583231, name: 'The Octocat' };

/** What a box's pr stage reaches: GitHub and the push, when a test carries a run that far. */
type BoxExtra = {
  tracking?: Tracking;
  /** Docker compose on the box, for its workspaces' scripts. */
  compose?: Compose;
  /** The box's board: a card's comments from its session. */
  board?: Board;
  git?: Git;
  factoryPollMs?: number;
  /** More of the Mac's environment (its sign-ins' store, #103). */
  macEnv?: Record<string, string>;
  /** The box's stored sign-ins (#103). */
  profiles?: ProfileStore;
  /** How long EC2's `run-instances` takes to answer (#243). */
  createMs?: number;
  /** The Mac's org store (#351): where a prototype's card's reference is read. */
  org?: OrgStore;
  /** `abe box attach` the fake, into the stand-in's clone (a copy into the workspace). */
  attach?: true;
  /** The box's own machine, for its load (ADR 0022); none: the box says no load. */
  boxHost?: BoxHost;
  /** More of yours on the Mac (`settings.yaml`), after its `serve.target`. */
  mine?: string;
  /** The Mac's prototypes (`abe prototype start`), kept in the state's own folder. */
  prototypes?: true;
};

/** `local`: yours for the repo on the Mac (`.abe/settings.local.yaml`), before its Override. */
const world = async (local: string, extra: BoxExtra = {}): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-c-'));
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const gh = fakeGh([
    ['api user', { json: ME }],
    ['auth', { stdout: '' }],
  ]);
  // The person's EC2: each fake aws call is a process, so a box takes a moment to come up.
  const ec2 = fakeEc2({
    owner: ME.login,
    bootMs: 300,
    stopMs: 300,
    ...(extra.createMs === undefined ? {} : { createMs: extra.createMs }),
  });
  const docker = fakeDocker();
  const mirrors = fakeMirrors();

  const shop = join(root, 'shop');
  const boxCheckout = join(root, 'box-checkout');

  mirrors.trees.set(REPO, 'tree1');
  mirrors.checkouts.set(REPO, boxCheckout);
  mkdirSync(join(root, 'mine'), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), `serve.target: cloud\n${extra.mine ?? ''}`);
  // Yours for the repo: each launch hands it to the box (#222), so its Override is in force there too.
  checkoutAt(
    shop,
    repoSettings(ado.board),
    [
      `${local}overrides:`,
      '  allowedModels: { value: [sonnet, haiku], reason: no Opus seats here }',
      '',
    ].join('\n'),
  );
  // the Mac's checkout is the repo's on GitHub
  shell(shop, `git remote add origin https://github.com/${REPO}.git`);
  checkoutAt(boxCheckout, repoSettings(ado.board));
  const state = tempState();

  const standIn = standInWorkspace({
    docker,
    stateDir: state.dir,
    path: [gh.dir],
  });
  const box = await scenario({
    state,
    box: { docker, mirrors },
    boxWorkdir: standIn.workdir,
    sessions: { runner: standIn.runner, ...(extra.git === undefined ? {} : { git: extra.git }) },
    ...(extra.tracking === undefined ? {} : { tracking: extra.tracking }),
    ...(extra.compose === undefined ? {} : { compose: extra.compose }),
    ...(extra.board === undefined ? {} : { board: extra.board }),
    ...(extra.factoryPollMs === undefined ? {} : { factoryPollMs: extra.factoryPollMs }),
    ...(extra.profiles === undefined ? {} : { browserProfiles: { store: extra.profiles } }),
    logins,
    secrets,
    reachTarget: 'cloud',
    ...(extra.boxHost === undefined ? {} : { boxHost: extra.boxHost }),
  });
  const attach =
    extra.attach === undefined
      ? undefined
      : fakeBoxAttach({ root: '/workspace/repo', dir: standIn.workdir });
  const mac = await macServed(
    {
      PATH: `${ec2.dir}:${az.dir}:/usr/bin:/bin`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_OWNER: ec2.owner,
      ABE_BOX_LINK: `socket:${state.socket}`,
      ABE_CLOUD_POLL_MS: '100',
      ...(attach === undefined ? {} : { ABE_BOX_ATTACH: attach.bin }),
      ...ado.env,
      ...extra.macEnv,
    },
    {
      cwd: shop,
      ...(extra.org === undefined ? {} : { org: extra.org }),
      ...(extra.prototypes === undefined
        ? {}
        : {
            prototypes: {
              dir: join(root, 'prototypes'),
              apps: localPrototypeApps({ dir: join(root, 'prototypes'), env: process.env }),
              proxy: localPrototypeProxy(),
              worktrees: protoWorktrees({ PATH: '/usr/bin:/bin', HOME: root }),
            },
          }),
    },
  );

  return { root, shop, boxCheckout, ado, az, gh, ec2, standIn, box, mac };
};

const done = async (w: World) => {
  await w.mac.close();
  await w.box.close();
  await w.standIn.remove();
  w.ec2.remove();
  await w.ado.stop();
  w.az.remove();
  w.gh.remove();
  rmSync(w.root, { recursive: true, force: true });
};

const until = async <T>(
  what: string,
  check: () => Promise<T | undefined> | T | undefined,
  ms = 10_000,
) => {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = await check();

    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(40);
  }
};

/** The boxes on the fake EC2 that are not gone, by name. */
const boxNames = (ec2: FakeEc2) =>
  ec2
    .instances()
    .filter((i) => i.State !== 'terminated')
    .map((i) => i.Tags.find((t) => t.Key === 'abe:box')?.Value ?? '');

const StateEvent = z.object({
  type: z.literal('session.state'),
  data: z.object({ id: z.string(), state: z.string(), cause: z.string() }),
});

const BoxStepEvent = z.object({
  type: z.literal('box.step'),
  data: z.object({ step: z.string() }),
});

const StepEvent = z.object({
  type: z.literal('session.step'),
  data: z.object({ id: z.string(), launch: LaunchProgress }),
});

/**
 * `[cause, state]` of every `session.state` event on the Mac's watch until `last` says stop;
 * the `box.step`s seen meanwhile (#193), when given, and each `session.step`'s launch into
 * `launches` (#142).
 */
const statesUntil = async (
  w: Watching,
  last: (cause: string, state: string) => boolean,
  steps?: string[],
  launches: LaunchProgress[] = [],
) => {
  const seen: [string, string][] = [];

  for (;;) {
    const line = EventLine.parse(JSON.parse(await w.next(15_000)));
    const event = StateEvent.safeParse(line);
    const step = BoxStepEvent.safeParse(line);
    const launch = StepEvent.safeParse(line);

    if (launch.success) launches.push(launch.data.data.launch);

    if (step.success) steps?.push(step.data.data.step);
    if (!event.success) continue;
    seen.push([event.data.data.cause, event.data.data.state]);
    if (last(event.data.data.cause, event.data.data.state)) return seen;
  }
};

const launch = async (mac: ServedCli) => {
  const out = await mac.json(SessionData, 'session', 'launch', '--card', '4', '--repo', REPO);

  if (!out.doc.ok) throw new Error(`launch refused: ${JSON.stringify(out.doc.error)}`);

  return out.doc.data;
};

describe('a launch naming a browser profile (#103): the box keeps it and restores it', () => {
  let w: World;
  let s: SessionData;
  let store: string;
  const STORED_AT = '2026-10-23T09:00:00.000Z';
  const profiles = fakeProfileStore('octocat');
  const STATE = JSON.stringify({
    v: 1,
    storedAt: STORED_AT,
    cookies: [
      {
        name: 'sid',
        value: 'cookie-value-never-in-the-workspace',
        domain: 'app.example.test',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        session: true,
      },
    ],
    origins: [],
  });

  beforeAll(async () => {
    store = mkdtempSync(join(tmpdir(), 'abe-signins-'));
    // The Mac's copy (`abe browser store` wrote it), and the box's read of the same secret.
    mkdirSync(join(store, 'abe', 'octocat', 'browser'), { recursive: true });
    writeFileSync(join(store, 'abe', 'octocat', 'browser', 'work-admin'), STATE);
    profiles.stored.set('work-admin', { text: STATE, storedAt: STORED_AT });
    w = await world('', {
      mine: 'browser:\n  profiles:\n    - { name: work-admin, purpose: admin }\n',
      macEnv: { ABE_LOGINS_STORE: `file://${store}` },
      profiles,
    });
    shell(w.standIn.workdir, 'git init -q -b main');
    const out = await w.mac.json(
      SessionData,
      'session',
      'launch',
      '--card',
      '4',
      '--repo',
      REPO,
      '--profile',
      'work-admin',
    );

    if (!out.doc.ok) throw new Error(`launch refused: ${JSON.stringify(out.doc.error)}`);
    s = out.doc.data;
    // claude starts in the box's tmux after the launch answers
    await until('claude started on the box', () => claudeOutput(w.standIn.workdir).env);
  });
  afterAll(async () => {
    await done(w);
    rmSync(store, { recursive: true, force: true });
  });

  test("the box's session holds the profile; its browser starts in it, signed in", async () => {
    expect(s.browserProfile).toBe('work-admin');
    const shown = readEnvelope(
      SessionData,
      JSON.parse((await w.box.request('session', 'show', s.id, '--json')).stdout),
    );

    expect(shown.ok && shown.data.browserProfile).toBe('work-admin');
    const started = readEnvelope(
      BrowserData,
      JSON.parse((await asSession(w, s.id)('browser', 'start')).stdout),
    );

    expect(started.ok && started.data.browserProfile).toBe('work-admin');
    expect(w.box.box.browser.restored).toHaveLength(1);
    // Into the browser through DevTools only: not in the session's env, no file in the workspace.
    expect(JSON.stringify(claudeOutput(w.standIn.workdir).env)).not.toContain('never-in-the');
    expect(JSON.stringify(w.box.box.docker.execs)).not.toContain('never-in-the');
    expect(JSON.stringify(w.box.box.docker.containersByName.get('abe-ws-4')?.spec)).not.toContain(
      'never-in-the',
    );
  });
});

describe('a launch into your environment: box, workspace, claude in it', () => {
  let w: World;
  let s: SessionData;
  let watch: Watching;
  let seen: [string, string][];
  const steps: string[] = [];
  const launches: LaunchProgress[] = [];

  beforeAll(async () => {
    w = await world('');
    // The workspace's clone (`workspace up` makes it in the volume; here the stand-in's folder).
    shell(w.standIn.workdir, 'git init -q -b main');
    await w.mac.run('status');
    watch = w.mac.watch('--json');
    s = await launch(w.mac);
    seen = await statesUntil(watch, (cause) => cause === 'Stop', steps, launches);
  });
  afterAll(async () => {
    watch.close();
    await done(w);
  });

  test("the repo's box made on EC2 with its repo as a tag (no card, ADR 0022), then the session started there", () => {
    expect(s).toMatchObject({
      card: 4,
      repo: REPO,
      box: BOX,
      worktree: w.standIn.workdir,
      branch: 'card/4-as-a-visitor-i-can',
    });
    expect(['starting', 'working', 'waiting']).toContain(s.state);
    expect(boxNames(w.ec2)).toEqual([BOX]);
    const made = w.ec2.instance(BOX);

    expect(made?.State).toBe('running');
    expect(Object.fromEntries((made?.Tags ?? []).map((t) => [t.Key, t.Value]))).toMatchObject({
      'abe:owner': 'octocat',
      'abe:box': BOX,
      'abe:repo': REPO,
    });
    expect(made?.Tags.some((t) => ['abe:card', 'abe:title', 'abe:team'].includes(t.Key))).toBe(
      false,
    );
    // `abe workspace up` ran on the box before claude: its container runs.
    expect(w.box.box.docker.containersByName.get('abe-ws-4')?.state).toBe('running');
  });

  test("the box's files are the launching person's: what the Mac shows is in force in the box's checkout (#222)", async () => {
    const shown = (doc: Envelope<SettingExplainData>) => {
      if (!doc.ok) throw new Error(doc.error.message);

      return { value: doc.data.value, winner: doc.data.winner, lowered: doc.data.lowered };
    };
    const mac = shown(
      (await w.mac.json(SettingExplainData, 'settings', 'explain', 'allowedModels')).doc,
    );
    const box = shown(
      readEnvelope(
        SettingExplainData,
        JSON.parse(
          (await w.box.requestIn(w.boxCheckout, 'settings', 'explain', 'allowedModels', '--json'))
            .stdout,
        ),
      ),
    );

    expect(mac).toMatchObject({ value: ['sonnet', 'haiku'], winner: 'individual' });
    expect(box).toEqual(mac);
    expect(readFileSync(join(w.boxCheckout, '.abe', 'settings.local.yaml'), 'utf8')).toContain(
      'no Opus seats here',
    );
  });

  test("while it starts, each launch step reaches the Mac's watch with its time; none once it runs (#142)", async () => {
    // the Mac's own steps in order; the box's workspace steps between, as its stream caught them
    const own = launches
      .map((l) => l.step)
      .filter(
        (step, i, all) => step !== all[i - 1] && step !== 'base-image' && step !== 'repo-image',
      );

    expect(own[0]).toBe('box-starting');
    expect(own.at(-1)).toBe('claude-starting');
    expect(own).toContain('box-booting');
    expect(own).toContain('workspace');
    expect(launches.every((l) => l.box === BOX && l.how === 'new')).toBe(true);
    expect(
      launches
        .at(-1)
        ?.done.map((d) => d.step)
        .slice(0, 2),
    ).toEqual(['box-starting', 'box-booting']);
    // a running session carries no launch steps
    const shown = await w.mac.json(SessionData, 'session', 'show', s.id);

    expect(shown.doc.ok && shown.doc.data.launch).toBeNull();
  });

  test("the box's hook-driven states reach the Mac's abe watch", () => {
    expect(seen[0]).toEqual(['launch', 'starting']);
    expect(seen).toContainEqual(['Stop', 'waiting']);
    expect(seen.map(([, state]) => state)).not.toContain('ended');
    // The Mac's own `starting` and the box's are one event, not two (#56 merges the box's).
    expect(seen.filter(([, state]) => state === 'starting')).toEqual([['launch', 'starting']]);
    // How the new box came along, for the CLI's progress line (#193).
    expect(steps).toEqual(['booting', 'workspace', 'claude']);
  });

  test('the environment is the allowlist, DATABASE_URL, the read names and the granted write, and the login', () => {
    const env = z.record(z.string(), z.string()).parse(claudeOutput(w.standIn.workdir).env);
    const container = w.box.box.docker.containersByName.get('abe-ws-4')?.spec.env ?? {};

    expect(env).toEqual({
      HOME: w.standIn.home,
      USER: 'abe',
      PATH: `${w.standIn.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CHROME_PATH: '/usr/bin/chromium',
      DATABASE_URL: container.DATABASE_URL ?? 'missing',
      ABE_WORKSPACE: '4',
      ABE_AWS_READ_TEST: 'abe-read-test',
      ABE_AWS_WRITE_TEST: 'abe-write-test',
      ABE_DB_READ_URL_TEST: READ_URL,
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_LOGIN,
      ABE_SOCKET: join(w.box.state.dir, 'workspaces', '4', 's', s.id, 'session.sock'),
      // a stalling MCP server gives up in 15 s, inside serve's 60 s wait for the first hook
      MCP_TIMEOUT: '15000',
      // its servers are Abe's and the sources: a source's sign-in is Settings'
      SIGN_IN_ON_PAGE_BY_ABE: 'settings',
    });
    // The AWS names are profiles in the session's AWS config, credentials through `abe reach creds`.
    expect(readFileSync(join(w.standIn.home, '.aws', 'config'), 'utf8')).toContain(
      '[profile abe-write-test]\ncredential_process = abe reach creds test write',
    );
  });

  test('managed settings: the hooks, the sandbox, the deny rules, the coordinator model lowered', () => {
    const managed = z
      .object({
        hooks: z.record(z.string(), z.unknown()),
        model: z.string(),
        availableModels: z.array(z.string()),
        permissions: z.object({ deny: z.array(z.string()) }),
        sandbox: z.object({ enabled: z.boolean() }),
        env: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readFileSync(w.standIn.managed, 'utf8')));

    expect(Object.keys(managed.hooks)).toEqual([...HOOK_EVENTS]);
    expect(JSON.stringify(managed.hooks.Stop)).toContain(`${w.standIn.bin}/abe hook Stop`);
    // Opus is the coordinator's, not allowed on this box: the first allowed one.
    expect(managed.model).toBe('sonnet');
    expect(managed.availableModels).toEqual(['sonnet', 'haiku']);
    // Claude Code's sandbox off: each command in Abe's jail beside the managed settings, written
    // as root, the login unset there (ADR 0029)
    expect(managed.sandbox).toEqual({ enabled: false });
    expect(managed.env).toEqual({ CLAUDE_CODE_SHELL_PREFIX: '/etc/claude-code/abe-jail.sh' });
    expect(readFileSync(join(dirname(w.standIn.managed), 'abe-jail.sh'), 'utf8')).toContain(
      'unset CLAUDE_CODE_OAUTH_TOKEN\nexec bwrap',
    );
    for (const rule of ['Read(~/.claude/.credentials.json)', 'Read(//run/abe/serve.sock)'])
      expect(managed.permissions.deny).toContain(rule);
    // prod off (the default): its Abe env file denied by the container's paths, never the box's
    // checkout's (not there), and hidden by the jail; what decides reach written by no file tool
    for (const rule of [
      'Read(//workspace/repo/.abe/abe.prod.env)',
      'Read(//workspace/repo-base/.abe/abe.prod.env)',
      'Edit(//workspace/repo/.abe/settings.local.yaml)',
      'Edit(//workspace/repo/abe.yaml)',
    ])
      expect(managed.permissions.deny).toContain(rule);
    expect(
      managed.permissions.deny.filter(
        (r) => /\.abe\/(settings|abe\.)/.test(r) && !r.includes('(//workspace/'),
      ),
    ).toEqual([]);
    expect(readFileSync(join(dirname(w.standIn.managed), 'abe-jail.sh'), 'utf8')).toContain(
      "'/workspace/repo/.abe/abe.prod.env'",
    );
    // Its own socket opened again; the browser's MCP config and no other.
    const argv = z.array(z.string()).parse(claudeOutput(w.standIn.workdir).argv);
    const own = z
      .object({ sandbox: z.object({ filesystem: z.object({ allowRead: z.array(z.string()) }) }) })
      .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));

    expect(own.sandbox.filesystem.allowRead).toEqual([`/run/abe/s/${s.id}`]);
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('/run/abe/mcp.json');
    expect(argv.filter((a) => a === '--strict-mcp-config')).toEqual(['--strict-mcp-config']);
  });

  test("the clone's commits are the person's: workspace up set git's identity from their GitHub user", () => {
    // workspace up logs gh in first (so a restarted box has gh before any launch), then asks who.
    const asked = w.gh.calls().find((c) => c.argv[0] === 'api');

    expect(asked?.argv).toEqual(['api', 'user']);
    // Their token in gh's own environment only, never on a command line.
    expect(asked?.env.GH_TOKEN).toBe(GITHUB_LOGIN);
    expect(asked?.argv.join(' ')).not.toContain(GITHUB_LOGIN);
    const config = (key: string) =>
      Bun.spawnSync(['git', '-C', w.standIn.workdir, 'config', key]).stdout.toString().trim();

    expect([config('user.name'), config('user.email')]).toEqual([
      'The Octocat',
      '583231+octocat@users.noreply.github.com',
    ]);
  });

  test('logins restored: gh logged in with the token on stdin, the folder trusted for claude', () => {
    const calls = w.gh.calls();

    // Once, at workspace up (then who the person is); the launch right after does not log in again.
    expect(calls.map((c) => c.argv.slice(0, 2))).toEqual([
      ['auth', 'login'],
      ['auth', 'setup-git'],
      ['api', 'user'],
    ]);
    for (const login of calls.filter((c) => c.argv[1] === 'login'))
      expect(login.stdin).toBe(`${GITHUB_LOGIN}\n`);
    // Never on a command line.
    expect(calls.flatMap((c) => c.argv).join(' ')).not.toContain(GITHUB_LOGIN);
    const config = z
      .object({ projects: z.record(z.string(), z.object({ hasTrustDialogAccepted: z.boolean() })) })
      .parse(JSON.parse(readFileSync(join(w.standIn.home, '.claude.json'), 'utf8')));

    expect(config.projects[w.standIn.workdir]?.hasTrustDialogAccepted).toBe(true);
    // The variables' file is gone once claude read it.
    expect(existsSync(join(w.standIn.home, '.abe', 'sessions', s.id, 'env'))).toBe(false);
  });

  test('send from the Mac types into the box session; attach names the way in', async () => {
    const sent = await w.mac.json(SessionSendData, 'session', 'send', s.id, 'next', 'step');

    expect(sent.doc).toEqual({ ok: true, data: { id: s.id, sent: 'next step', queued: null } });
    await until('the typed line', () =>
      claudeOutput(w.standIn.workdir).typed.includes('next step') ? true : undefined,
    );
    const attach = await w.mac.json(SessionAttachData, 'session', 'attach', s.id);

    // From the Mac: `abe box attach` (ADR 0021), its SSH and tmux reconnect loop.
    expect(attach.doc.ok && attach.doc.data.argv.slice(-5)).toEqual([
      'box',
      'attach',
      BOX,
      '--session',
      s.id,
    ]);
    // On the box, attach is tmux in the workspace container.
    const onBox = SessionAttachData.parse(
      z
        .object({ data: z.unknown() })
        .parse(JSON.parse((await w.box.request('session', 'attach', s.id, '--json')).stdout)).data,
    );

    expect(onBox.argv.slice(-3)).toEqual(['attach-session', '-t', `=abe-${s.id}`]);
  });

  test("its transcript is read by the box's serve: tagged events on the Mac's watch, session transcript forwarded (#113)", async () => {
    const tagged = await until(
      'a transcript event from the box',
      async () => {
        const line = EventLine.parse(JSON.parse(await watch.next(15_000)));

        return line.type === 'session.transcript' && line.box === BOX ? line : undefined;
      },
      20_000,
    );

    expect(z.object({ session: z.string() }).parse(tagged.data).session).toBe(s.id);
    const read = await until('the sent turn in the transcript', async () => {
      const out = await w.mac.json(SessionTranscriptData, 'session', 'transcript', s.id);

      return out.doc.ok &&
        out.doc.data.entries.some(
          (e) => e.kind === 'assistant-text' && e.text === 'You said: next step',
        )
        ? out.doc.data
        : undefined;
    });

    expect(read.entries.flatMap((e) => (e.kind === 'user' ? [e.text.split('\n')[0]] : []))).toEqual(
      ['Work on card AB#4: As a visitor I can sign in with email', 'next step'],
    );
  });

  test("the session's own socket on the box: its in-session commands, on itself only", async () => {
    const socket = join(w.box.state.dir, 'workspaces', '4', 's', s.id, 'session.sock');
    const inSession = (...argv: string[]) => requestAt(socket, w.mac.state.dir, ...argv, '--json');
    const code = (out: { stdout: string }) =>
      z
        .object({ ok: z.boolean(), error: z.object({ code: z.string() }).optional() })
        .parse(JSON.parse(out.stdout));

    expect(code(await inSession('session', 'show', s.id))).toMatchObject({ ok: true });
    expect(code(await inSession('session', 'show', '4-0000')).error?.code).toBe('not-your-session');
    // Its card and issues are read there too (this box has no GitHub or board to answer).
    expect(code(await inSession('issue', 'show', `${REPO}#1`)).error?.code).toBe('gh-failed');
    expect(code(await inSession('card', 'show', '4')).error?.code).toBe('ado-failed');
    expect(
      code(await inSession('session', 'launch', '--card', '4', '--repo', REPO)).error?.code,
    ).toBe('not-in-session');
    // The workspace's own socket still answers only help, status and the browser.
    const inside = await w.box.requestInsideOf('4', 'session', 'list', '--json');

    expect(code(inside).error?.code).toBe('not-in-session');
  });

  test('stopped from the Mac: ended; the box is left to stop itself when idle (#92)', async () => {
    const stopped = await w.mac.json(SessionData, 'session', 'stop', s.id);

    expect(stopped.doc.ok && stopped.doc.data.state).toBe('ended');
    const listed = await w.mac.json(SessionListData, 'session', 'list');

    // Stopped by you (#205): it reads Stopped, not Failed.
    expect(
      listed.doc.ok && listed.doc.data.sessions.map((x) => [x.id, x.state, x.stopped]),
    ).toEqual([[s.id, 'ended', true]]);
    // Ended: nothing is asked of its box any more, a queued message taken back neither.
    const unqueued = await w.mac.json(SessionUnqueueData, 'session', 'unqueue', s.id, '1');

    expect(!unqueued.doc.ok && unqueued.doc.error.code).toBe('session-ended');
    // The Mac asked EC2 to stop nothing: the box runs on until its own idle stop.
    expect(w.ec2.calls().filter((c) => c.startsWith('ec2 stop-instances'))).toEqual([]);
    expect(w.ec2.instance(BOX)?.State).toBe('running');
  });

  test("a session on a box that went to sleep has ended, as the Mac's list says", async () => {
    // Another launch on the running box; then the box stops (idle, or a person in the console).
    const again = await launch(w.mac);

    expect(['starting', 'working', 'waiting']).toContain(again.state);
    // Its agent asked and waits on you (its Stop hook), nobody attached.
    await waitingOn(w, again.id);
    w.ec2.set(BOX, 'stopped');
    const listed = await w.mac.json(SessionListData, 'session', 'list');

    expect(listed.doc.ok && listed.doc.data.sessions.map((x) => [x.id, x.state])).toEqual([
      [s.id, 'ended'],
      [again.id, 'ended'],
    ]);
    // #192: it says its box slept while it waited on you, and how to go on.
    const ended = listed.doc.ok
      ? listed.doc.data.sessions.find((x) => x.id === again.id)
      : undefined;

    expect(ended !== undefined && sleptWhileWaiting(ended)).toBe(true);
    const shown = await w.mac.run('session', 'show', again.id);

    expect(shown.stdout).toContain(
      `  ended       its box went to sleep while it waited on you (${BOX}, idle) · abe session reopen ${again.id} wakes it and goes on: the same workspace and conversation`,
    );
  });

  test('a session on a box you stopped yourself says its box stopped, not that it slept', async () => {
    // The stand-in box's serve outlives its EC2 stop: the slept session ended there too.
    const listed = await w.mac.json(SessionListData, 'session', 'list');

    for (const x of listed.doc.ok ? listed.doc.data.sessions : [])
      if (x.id !== s.id) await w.box.request('session', 'stop', x.id);
    // The card launched again wakes the box; its agent waits on you; then `box stop` here.
    const again = await launch(w.mac);

    await waitingOn(w, again.id);
    const stop = await w.mac.run('box', 'stop', BOX);

    expect(stop.exit).toBe(0);
    const shown = await w.mac.json(SessionData, 'session', 'show', again.id);

    expect(shown.doc.ok && shown.doc.data.state).toBe('ended');
    expect(shown.doc.ok && sleptWhileWaiting(shown.doc.data)).toBe(false);
    expect(shown.doc.ok && shown.doc.data.reason).toStartWith(`its box ${BOX} stopped · `);
    // #316: the ended event carries the reason, so Chat and the card say why at once
    const watch = w.mac.watch('--json', '--since', '0');

    try {
      for (;;) {
        const line = z
          .object({
            type: z.string(),
            data: z
              .object({
                id: z.string().optional(),
                state: z.string().optional(),
                cause: z.string().optional(),
                reason: z.string().optional(),
              })
              .loose(),
          })
          .parse(JSON.parse(await watch.next(15_000)));

        if (line.type !== 'session.state' || line.data.id !== again.id) continue;
        if (line.data.state !== 'ended') continue;
        expect(line.data.cause).toBe('box-stopped');
        expect(line.data.reason ?? '').toStartWith(`its box ${BOX} stopped · `);
        break;
      }
    } finally {
      watch.close();
    }
  });

  /** The Mac's `session list` row of `id`, once `ok` holds of it. */
  const rowOf = async (id: string, ok: (x: SessionData) => boolean) =>
    until(
      `${id} as wanted`,
      async () => {
        const listed = await w.mac.json(SessionListData, 'session', 'list');
        const row = listed.doc.ok ? listed.doc.data.sessions.find((x) => x.id === id) : undefined;

        return row !== undefined && ok(row) ? row : undefined;
      },
      15_000,
    );

  /** The session the Reopen tests go on with. */
  let reopenedId = '';

  /** The newest session on the card as the Mac lists it (the one the last two tests left). */
  const lastEnded = async () => {
    const listed = await w.mac.json(SessionListData, 'session', 'list');
    const last = (listed.doc.ok ? listed.doc.data.sessions : [])
      .filter((x) => x.card === 4)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

    if (last?.state !== 'ended') throw new Error('no ended session');

    return last;
  };

  test('Reopen on a stopped box (#343): it wakes, and the same session goes on in its workspace and conversation', async () => {
    const was = await lastEnded();

    reopenedId = was.id;
    // the box's own serve ends it with its box (the stand-in's outlives the stop)
    await w.box.request('session', 'stop', was.id);
    expect(w.ec2.instance(BOX)?.State).toBe('stopped');
    const before = claudeOutput(w.standIn.workdir).argv;
    const opened = await w.mac.json(SessionData, 'session', 'reopen', was.id, '--message', 'why?');

    expect(opened.doc).toMatchObject({ ok: true, data: { id: was.id } });
    // woken as a launch wakes it, then claude resumed its own conversation with your message
    expect(w.ec2.calls().some((c) => c.startsWith('ec2 start-instances'))).toBe(true);
    const back = await rowOf(was.id, (x) => x.state === 'waiting' || x.state === 'working');

    expect(back.reopened).toHaveLength(1);
    const argv = z.array(z.string()).parse(claudeOutput(w.standIn.workdir).argv);

    expect(argv).not.toEqual(before);
    expect(argv[argv.indexOf('--resume') + 1]).toBe(
      /([0-9a-f-]{36})\.jsonl$/.exec(was.transcriptPath ?? '')?.[1] ?? '',
    );
    expect(argv.at(-1)).toBe('why?');
    // one row, the same id
    const listed = await w.mac.json(SessionListData, 'session', 'list');

    expect(listed.doc.ok && listed.doc.data.sessions.filter((x) => x.id === was.id)).toHaveLength(
      1,
    );
  });

  test('a new container (a release) keeps the conversation: it lives on the workspace volume (#343)', async () => {
    const was = await rowOf(reopenedId, () => true);

    await w.mac.run('session', 'stop', was.id);
    await rowOf(was.id, (x) => x.state === 'ended');
    // the new image's container: a home with no .claude of its own
    rmSync(join(w.standIn.home, '.claude'), { recursive: true, force: true });
    const opened = await w.mac.json(SessionData, 'session', 'reopen', was.id);

    expect(opened.doc).toMatchObject({ ok: true, data: { id: was.id } });
    await rowOf(was.id, (x) => x.state === 'waiting' || x.state === 'working');
    expect(z.array(z.string()).parse(claudeOutput(w.standIn.workdir).argv)).toContain('--resume');
  });

  test('a live one is not reopened; a terminated box is refused box-gone, the session left as it ended (#343)', async () => {
    const live = await rowOf(reopenedId, () => true);

    expect((await w.mac.json(SessionData, 'session', 'reopen', live.id)).doc).toMatchObject({
      ok: false,
      error: { code: 'not-ended' },
    });
    await w.mac.run('session', 'stop', live.id);
    const ended = await rowOf(live.id, (x) => x.state === 'ended');

    w.ec2.set(BOX, 'terminated');
    expect((await w.mac.json(SessionData, 'session', 'reopen', live.id)).doc).toEqual({
      ok: false,
      error: { code: 'box-gone', message: boxGoneText(BOX) },
    });
    expect(await rowOf(live.id, () => true)).toMatchObject({
      state: 'ended',
      reason: ended.reason,
    });
  });
});

describe("a prototype where cards run on boxes: its own workspace on the repo's box", () => {
  let w: World;
  let p: PrototypeData;
  const tmp = process.env.TMPDIR;
  const orgDir = mkdtempSync(join(tmpdir(), 'abe-c-org-'));

  beforeAll(async () => {
    // its session's socket names the prototype twice: a short state folder, as a box's is
    process.env.TMPDIR = '/tmp';
    w = await world('', { prototypes: true, attach: true, org: fileOrgStore(orgDir) });
    process.env.TMPDIR = tmp;
    // a prototype starts from the default branch's commit; the workspace's clone is at it too
    shell(w.shop, 'git -c user.name=t -c user.email=t@x commit -q --allow-empty -m init');
    shell(w.standIn.workdir, 'git init -q -b main');
    shell(w.standIn.workdir, `git fetch -q ${w.shop} main && git reset -q --hard FETCH_HEAD`);
  });
  afterAll(async () => {
    await done(w);
    rmSync(orgDir, { recursive: true, force: true });
  });

  test("prototype start: the repo's box, a workspace keyed by the prototype on its proto/ branch, a prototype session there; reopened the same", async () => {
    const started = await w.mac.json(PrototypeData, 'prototype', 'start', 'a', 'dark', 'header');

    if (!started.doc.ok) throw new Error(JSON.stringify(started.doc.error));
    p = started.doc.data;
    const hex = p.id.replace(/^proto-/, '');
    const id = p.code?.session ?? '';

    expect(p.code).toMatchObject({ box: BOX, branch: `proto/${hex}-a-dark-header` });
    expect(id).toMatch(new RegExp(`^${p.id}-[0-9a-f]{4}$`));
    // the repo's box (the one a card's launch makes), the prototype's own workspace on it
    expect(boxNames(w.ec2)).toEqual([BOX]);
    expect(w.box.box.docker.containersByName.get(`abe-ws-${p.id}`)?.state).toBe('running');
    const row = await until('its session on the box', async () => {
      const shown = await w.mac.json(SessionData, 'session', 'show', id);
      const x = shown.doc.ok ? shown.doc.data : undefined;

      // its turn over: the Mac has its conversation (a reopen resumes it)
      return x?.state === 'waiting' && x.transcriptPath !== null ? x : undefined;
    });

    expect(row).toMatchObject({
      kind: 'prototype',
      card: null,
      prototype: { id: p.id, card: null },
      box: BOX,
    });
    // its prompt the prototype skill on the words; its pushes refused by the session's rules
    const argv = z.array(z.string()).parse(claudeOutput(w.standIn.workdir).argv);

    expect(argv.at(-1)).toBe('/abe:prototype a dark header');
    // ended and reopened: the same session, its conversation resumed in the same workspace
    await w.mac.run('session', 'stop', id);
    await until('ended', async () => {
      const shown = await w.mac.json(SessionData, 'session', 'show', id);

      return shown.doc.ok && shown.doc.data.state === 'ended' ? true : undefined;
    });
    const opened = await w.mac.json(SessionData, 'session', 'reopen', id, '--message', 'go on');

    expect(opened.doc).toMatchObject({ ok: true, data: { id, kind: 'prototype' } });
    const again = await until('its claude resumed', () => {
      const now = z.array(z.string()).parse(claudeOutput(w.standIn.workdir).argv);

      return now.includes('--resume') ? now : undefined;
    });

    expect(again.at(-1)).toBe('go on');
  });

  test('make-card from the hub: its diff and PNGs read from the workspace, a plain card, both in the org store', async () => {
    // what its session left in the clone: a change, and a PNG under .scratch/prototype
    writeFileSync(join(w.standIn.workdir, 'dark.css'), 'header { background: #000 }\n');
    mkdirSync(join(w.standIn.workdir, '.scratch', 'prototype'), { recursive: true });
    writeFileSync(
      join(w.standIn.workdir, '.scratch', 'prototype', 'dark header.png'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
    );
    const made = await w.mac.json(
      MakeCardData,
      'prototype',
      'make-card',
      '--id',
      p.id,
      '--title',
      'Dark header',
      '--description',
      'Try a dark header.',
    );

    if (!made.doc.ok) throw new Error(JSON.stringify(made.doc.error));
    expect(made.doc.data).toMatchObject({ prototype: p.id, title: 'Dark header', version: 1 });
    const card = await w.mac.json(CardData, 'card', 'show', String(made.doc.data.card));

    expect(card.doc.ok ? card.doc.data.description : '').toContain('## Prototype');
    const kept = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((f) => join(dir, f));
    const files = kept(orgDir);

    expect(files.some((f) => f.endsWith(join('screenshots', '1.png')))).toBe(true);
    expect(
      files.some(
        (f) => f.endsWith('prototype.diff') && readFileSync(f, 'utf8').includes('dark.css'),
      ),
    ).toBe(true);
  });
});

describe("a launch on a card with no box (#243): the Mac follows it through EC2's slow create", () => {
  let w: World;

  beforeAll(async () => {
    // A real `run-instances` takes a second or two; the new box is in no listing until it answers.
    w = await world('', { createMs: 1_500 });
    shell(w.standIn.workdir, 'git init -q -b main');
    await w.mac.run('status');
  });
  afterAll(async () => {
    await done(w);
  });

  /** Card 4's session on the Mac's list now: its id and state. */
  const listed = async () => {
    const out = await w.mac.json(SessionListData, 'session', 'list');

    return out.doc.ok ? out.doc.data.sessions.map((x) => [x.id, x.state, x.reason]) : [];
  };
  /** The same, without the reasons. */
  const states = async () => (await listed()).map(([id, state]) => [id, state]);

  test('reads while EC2 makes the box do not end the launch: it runs through to the Mac', async () => {
    const answered = { now: false };
    const launching = launch(w.mac).finally(() => {
      answered.now = true;
    });
    const seen: unknown[][] = [];

    // The app reads the list all along (Chat, Board, Sessions): each read looks at EC2's boxes.
    while (!answered.now) {
      seen.push(...(await listed()));
      await Bun.sleep(100);
    }
    const s = await launching;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((x) => x[1] === 'ended')).toEqual([]);
    expect(['starting', 'working', 'waiting']).toContain(s.state);
    expect(boxNames(w.ec2)).toEqual([BOX]);
    await waitingOn(w, s.id);
    expect(await listed()).toEqual([[s.id, 'waiting', null]]);
  });

  test("a session the Mac had ended that its box runs still is picked up again by the next launch, not refused as the card's", async () => {
    const id = String((await listed())[0]?.[0]);

    // The box read stopped once: the Mac ended its session. Its serve (the stand-in) kept it.
    w.ec2.set(BOX, 'stopped');
    expect(await states()).toEqual([[id, 'ended']]);
    w.ec2.set(BOX, 'running');
    const watch = w.mac.watch('--json');

    try {
      const again = await launch(w.mac);

      // The card's session as its box has it, no new one beside it.
      expect(again.id).toBe(id);
      expect(['working', 'waiting']).toContain(again.state);
      expect(await states()).toEqual([[id, again.state]]);
      // Said on the Mac's watch, so Chat and the card follow it again.
      const seen = await statesUntil(watch, (cause) => cause === 'picked-up');

      expect(seen.at(-1)).toEqual(['picked-up', again.state]);
    } finally {
      watch.close();
    }
  });

  test('factory run on a card whose session its box still runs opens that one: no second session, no failed run (#213, #343)', async () => {
    const id = String((await listed())[0]?.[0]);

    w.ec2.set(BOX, 'stopped');
    expect(await states()).toEqual([[id, 'ended']]);
    w.ec2.set(BOX, 'running');
    const ran = await w.mac.json(FactoryRunData, 'factory', 'run', '4', '--repo', REPO);

    expect(ran.doc).toMatchObject({ ok: false, error: { code: 'card-has-session' } });
    expect(ran.doc.ok ? '' : ran.doc.error.message).toContain(`session ${id}`);
    // the running one is the card's again on the Mac; the launch that found it is gone
    expect((await states()).map(([x]) => x)).toEqual([id]);
    expect(['working', 'waiting']).toContain(String((await states())[0]?.[1]));
    const status = await w.mac.json(FactoryStatusData, 'factory', 'status', '4');

    // no run of a session that ended at once (the card's ✕ Failed)
    expect(status.doc.ok && status.doc.data.runs).toEqual([]);
  });
});

/** Until the box says the session waits on you (its Stop hook), nobody attached. */
const waitingOn = async (w: World, id: string) => {
  for (let i = 0; i < 300; i += 1) {
    const shown = await w.mac.json(SessionData, 'session', 'show', id);

    if (shown.doc.ok && shown.doc.data.state === 'waiting') return;
    await Bun.sleep(20);
  }
};

const StageEvent = z.object({
  type: z.literal('factory.stage'),
  data: z.object({ session: z.string(), stage: z.string(), state: z.string(), cause: z.string() }),
});

/** `[stage, cause]` of every `factory.stage` event on the Mac's watch until `last` says stop. */
const stagesUntil = async (w: Watching, last: (stage: string) => boolean) => {
  const seen: [string, string][] = [];

  for (;;) {
    const event = StageEvent.safeParse(EventLine.parse(JSON.parse(await w.next(15_000))));

    if (!event.success) continue;
    seen.push([event.data.data.stage, event.data.data.cause]);
    if (last(event.data.data.stage)) return seen;
  }
};

const shell = (cwd: string, script: string) => {
  const out = Bun.spawnSync(['sh', '-ec', script], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin:/opt/homebrew/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
};

/** The run's own commands, as its agent types them inside the box session. */
const asSession = (w: World, id: string) => {
  const socket = join(w.box.state.dir, 'workspaces', '4', 's', id, 'session.sock');

  return (...argv: string[]) => requestAt(socket, w.mac.state.dir, ...argv, '--json');
};

const Answer = z.object({
  ok: z.boolean(),
  data: z.object({ stage: z.string() }).loose().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

describe("a Factory run in your environment: it lives in the box's serve", () => {
  let w: World;
  let run: FactoryRunData;
  let watch: Watching;
  let say: ReturnType<typeof asSession>;
  // The spec stage's writes as GitHub and the board get them (the to-spec skill's commands).
  const issues: { repo: string; title: string; body: string; labels: readonly string[] }[] = [];
  const comments: { card: number; text: string }[] = [];
  const tracking: Tracking = {
    ...refusingTracking(),
    issueCreate: (i) => {
      issues.push({ repo: i.repo, title: i.title, body: i.body, labels: i.labels });

      return Promise.resolve({
        ok: true,
        data: {
          repo: i.repo,
          number: 12,
          title: i.title,
          body: i.body,
          state: 'open',
          url: `https://github.com/${i.repo}/issues/12`,
          labels: [...i.labels],
          parent: null,
          subIssues: [],
        },
      });
    },
  };
  const board: Board = {
    ...refusingBoard(),
    comment: (_, card, text) => {
      comments.push({ card, text });

      return Promise.resolve({ ok: true, data: { card, id: 1, text, by: 'me', at: '' } });
    },
  };

  const compose = fakeCompose();

  beforeAll(async () => {
    w = await world('', { tracking, board, compose });
    // The box's checkout of the repo (its default branch): the run's settings, its checks.
    const checkout = join(w.root, 'checkout');

    checkoutAt(
      checkout,
      [
        repoSettings(w.ado.board),
        'setup: printf "%s" "$ABE_WORKSPACE" > .setup-ran',
        'checks:',
        '  - name: tests',
        '    run: echo "workspace=$ABE_WORKSPACE ci=$CI"',
        '',
      ].join('\n'),
    );
    w.box.box.mirrors.checkouts.set(REPO, checkout);
    // The workspace's clone: on its card branch, ahead of main.
    shell(
      w.standIn.workdir,
      [
        'git init -q -b main',
        'echo one > a.txt',
        'git add a.txt',
        'git commit -qm one',
        'git checkout -qb card/4-as-a-visitor-i-can',
        'echo two >> a.txt',
        'git commit -qam two',
      ].join('\n'),
    );
    await w.mac.run('status');
    watch = w.mac.watch('--json');
    // Launched with a note: it goes to the box with the card's words.
    const out = await w.mac.json(
      FactoryRunData,
      'factory',
      'run',
      '4',
      '--repo',
      REPO,
      '--note',
      'keep the change small',
    );

    if (!out.doc.ok) throw new Error(`factory run refused: ${JSON.stringify(out.doc.error)}`);
    run = out.doc.data;
    say = asSession(w, run.session);
  });
  afterAll(async () => {
    watch.close();
    await done(w);
  });

  test("factory run from the Mac starts the session on the card's box, at its first step, with the run's prompt", async () => {
    expect(run).toMatchObject({
      card: 4,
      stage: 'spec',
      state: 'running',
      worktree: w.standIn.workdir,
    });
    expect(boxNames(w.ec2)).toEqual([BOX]);
    const argv = await until('claude started', () => {
      const a = claudeOutput(w.standIn.workdir).argv;

      return Array.isArray(a) ? z.array(z.string()).parse(a) : undefined;
    });

    expect(argv.at(-1)).toStartWith('/abe:factory Work on card AB#4');
    // the Launch note went with the card's words (#347)
    expect(argv.at(-1)).toEndWith('\nkeep the change small');
    // a Factory run's session says so (#332): once its run is cleared it no longer stands alone
    const listed = await w.mac.json(SessionListData, 'session', 'list');

    expect(
      listed.doc.ok ? listed.doc.data.sessions.find((x) => x.id === run.session)?.factory : null,
    ).toBe(true);
    // The repo pack's setup ran in the clone first, in the container, with the workspace's env,
    // as its script user: never the session's, whose home holds its logins.
    expect(readFileSync(join(w.standIn.workdir, '.setup-ran'), 'utf8')).toBe('4');
    const setup = w.box.box.docker.execs.filter((e) =>
      e.argv.some((a) => a.includes('.setup-ran')),
    );

    expect(setup.map((e) => e.user)).toEqual(['abe-run']);
    expect(await stagesUntil(watch, (stage) => stage === 'spec')).toEqual([['spec', 'run']]);
  });

  test("the session's own commands move the box's run; its factory.stage events reach the Mac", async () => {
    const specced = Answer.parse(
      JSON.parse((await say('factory', 'stage-done', 'create-specification')).stdout),
    );
    const ticketed = Answer.parse(
      JSON.parse((await say('factory', 'stage-done', 'to-tickets')).stdout),
    );

    expect([specced, ticketed]).toMatchObject([
      { ok: true, data: { stage: 'step' } },
      { ok: true, data: { stage: 'build' } },
    ]);
    expect(await stagesUntil(watch, (stage) => stage === 'build')).toContainEqual([
      'build',
      'stage-done',
    ]);
  });

  test('stage-done build: the checks run in the workspace container, with its environment', async () => {
    const built = Answer.parse(JSON.parse((await say('factory', 'stage-done', 'build')).stdout));

    expect(built).toMatchObject({ ok: true, data: { stage: 'review' } });
    const checks = readFileSync(join(w.standIn.workdir, '.scratch', '4', 'checks.md'), 'utf8');

    expect(checks).toContain('workspace=4 ci=true');
    // Through docker exec into the workspace, never on the box's own disk.
    const ran = w.box.box.docker.execs.filter(
      (e) => e.name === 'abe-ws-4' && e.argv.some((a) => a.includes('workspace=$ABE_WORKSPACE')),
    );

    expect(ran).toHaveLength(1);
    // As the workspace's script user: code the agent wrote, outside the sandbox, never as the
    // session's user (whose home holds Claude Code's and gh's logins).
    expect(ran[0]?.user).toBe('abe-run');
  });

  test('abe run: a pack script in the workspace as its script user, its output and exit back', async () => {
    const scripts = join(w.standIn.workdir, '.claude', 'skills', 'run-app', 'scripts');

    mkdirSync(scripts, { recursive: true });
    writeFileSync(
      join(scripts, 'start'),
      '#!/bin/sh\necho "start: up in $(pwd) with $*" >&2\necho http://127.0.0.1:5173\n',
      { mode: 0o755 },
    );
    const Ran = z.object({
      ok: z.boolean(),
      data: z
        .object({ script: z.string(), cwd: z.string(), exit: z.number().nullable() })
        .extend({ stdout: z.string(), stderr: z.string() })
        .optional(),
      error: z.object({ code: z.string() }).optional(),
    });
    const started = Ran.parse(
      JSON.parse(
        (await say('run', '.claude/skills/run-app/scripts/start', 'fresh', 'seed')).stdout,
      ),
    );

    expect(started.data).toEqual({
      script: '.claude/skills/run-app/scripts/start',
      cwd: w.standIn.workdir,
      exit: 0,
      stdout: 'http://127.0.0.1:5173\n',
      stderr: `start: up in ${w.standIn.workdir} with fresh seed\n`,
    });
    const execs = w.box.box.docker.execs.filter((e) =>
      e.argv.includes('.claude/skills/run-app/scripts/start'),
    );

    expect(execs.map((e) => [e.name, e.user])).toEqual([['abe-ws-4', 'abe-run']]);
    // Nothing but the pack's scripts, in the clone or Before's worktree.
    for (const path of [
      '/etc/passwd',
      '../x/.claude/skills/run-app/scripts/start',
      '.claude/skills/run-app/scripts/../../x',
    ])
      expect(Ran.parse(JSON.parse((await say('run', path)).stdout)).error?.code).toBe(
        'not-a-pack-script',
      );
    // Before's by its absolute path: it runs there (here none made yet: `cd` fails, 126).
    const before = Ran.parse(
      JSON.parse(
        (await say('run', '/workspace/repo-base/.claude/skills/run-app/scripts/start')).stdout,
      ),
    );

    expect(before.data).toMatchObject({ cwd: `${w.standIn.workdir}-base`, exit: 126 });

    // The Verification pack's own drive runs there too, one runner at a time: a second abe run
    // beside it is refused, stop still runs.
    const helpers = join(w.standIn.workdir, '.claude', 'skills', 'verify-demo-shop', 'scripts');
    const go = join(w.standIn.root, 'drive.go');

    mkdirSync(helpers, { recursive: true });
    writeFileSync(join(scripts, 'stop'), '#!/bin/sh\necho stopped\n', { mode: 0o755 });
    writeFileSync(
      join(helpers, 'drive'),
      `#!/bin/sh\nwhile [ ! -f ${go} ]; do sleep 0.05; done\necho driven "$@"\n`,
      { mode: 0o755 },
    );
    const driving = say('run', '.claude/skills/verify-demo-shop/scripts/drive', 'cart');

    await until('the drive runs in the workspace', () =>
      w.box.box.docker.execs.some((e) =>
        e.argv.includes('.claude/skills/verify-demo-shop/scripts/drive'),
      )
        ? true
        : undefined,
    );
    const beside = Ran.parse(JSON.parse((await say('run', 'start')).stdout));
    const stopped = Ran.parse(JSON.parse((await say('run', 'stop')).stdout));

    writeFileSync(go, '');
    const driven = Ran.parse(JSON.parse((await driving).stdout));

    expect([beside.error?.code, stopped.data?.stdout, driven.data?.stdout]).toEqual([
      'one-runner',
      'stopped\n',
      'driven cart\n',
    ]);

    // --env (3.2.1): the values the Mac synced for an environment on, handed on stdin, never said
    mkdirSync(join(w.standIn.workdir, '.abe'), { recursive: true });
    writeFileSync(join(w.standIn.workdir, '.abe', 'abe.test.env'), 'API_KEY=test-api-secret\n');
    mkdirSync(join(w.standIn.home, '.abe', 'sync', 'aws'), { recursive: true });
    writeFileSync(
      join(w.standIn.home, '.abe', 'sync', 'aws', 'test.json'),
      JSON.stringify({
        AWS_ACCESS_KEY_ID: 'AKIATESTSYNCED00001',
        AWS_SECRET_ACCESS_KEY: 'aws-test-secret',
      }),
    );
    writeFileSync(join(scripts, 'env-show'), '#!/bin/sh\necho "$API_KEY $AWS_ACCESS_KEY_ID"\n', {
      mode: 0o755,
    });
    const shown = Ran.parse(JSON.parse((await say('run', 'env-show', '--env', 'test')).stdout));

    expect(shown.data?.exit).toBe(0);
    expect(shown.data?.stdout).toContain('[redacted:');
    for (const secret of ['test-api-secret', 'AKIATESTSYNCED00001'])
      expect(shown.data?.stdout).not.toContain(secret);
    expect(
      w.box.box.docker.execs.filter((e) => e.argv.includes('env-show')).flatMap((e) => e.argv),
    ).not.toContain('test-api-secret');
    // prod not synced (off for agents): refused, never run without its values; its empty file
    // (the sandbox's mount point over a denied one) is no sync
    writeFileSync(join(w.standIn.workdir, '.abe', 'abe.prod.env'), '', { mode: 0o444 });
    expect(
      Ran.parse(JSON.parse((await say('run', 'env-show', '--env', 'prod')).stdout)).error?.code,
    ).toBe('env-not-here');

    // docker compose in a pack script: its shim hands it to the box, which runs it in the card's
    // own project from the workspace's compose file and joins the workspace to its network
    writeFileSync(
      join(w.standIn.workdir, 'compose.yaml'),
      'services:\n  db:\n    image: postgres\n',
    );
    writeFileSync(join(scripts, 'up'), '#!/bin/sh\ndocker compose up -d\n', { mode: 0o755 });
    // the workspace's volume as the box host sees it: compose runs in the clone itself
    w.box.box.docker.volumePaths.set('abe-ws-4', dirname(w.standIn.workdir));
    const composed = Ran.parse(JSON.parse((await say('run', 'up')).stdout));

    expect([
      composed.data?.exit,
      compose.runs.map((r) => [r.project, r.args.slice(-2), r.stdin]),
    ]).toEqual([0, [['abe-demo-shop-4', ['up', '-d'], 'services:\n  db:\n    image: postgres\n']]]);
    expect(compose.runs[0]?.args.slice(0, 2)).toEqual(['--project-directory', w.standIn.workdir]);
    expect(compose.networks).toEqual(['join abe-demo-shop-4_default abe-ws-4']);
  });

  test("a review's report is read from the worktree and kept in its .scratch, through the container", async () => {
    mkdirSync(join(w.standIn.workdir, '.scratch', '4'), { recursive: true });
    writeFileSync(join(w.standIn.workdir, '.scratch', '4', 'review.md'), '# Review\n\nclean\n');
    // A path out of the worktree is no report: serve reads it outside the session's sandbox.
    const outside = Answer.parse(
      JSON.parse(
        (await say('factory', 'review', '--findings', '0', '--report', '/etc/hosts')).stdout,
      ),
    );

    expect(outside.error?.code).toBe('no-report');
    // Nor a link in the worktree that leads out of it.
    symlinkSync('/etc/hosts', join(w.standIn.workdir, '.scratch', '4', 'hosts.md'));
    const linked = Answer.parse(
      JSON.parse(
        (await say('factory', 'review', '--findings', '0', '--report', '.scratch/4/hosts.md'))
          .stdout,
      ),
    );

    expect(linked.error?.code).toBe('no-report');
    const reviewed = Answer.parse(
      JSON.parse(
        (await say('factory', 'review', '--findings', '0', '--report', '.scratch/4/review.md'))
          .stdout,
      ),
    );

    expect(reviewed).toMatchObject({ ok: true, data: { stage: 'verify' } });
    expect(
      readFileSync(join(w.standIn.workdir, '.scratch', '4', 'review', '1.md'), 'utf8'),
    ).toContain('clean');
  });

  test.each([
    [
      "the spec's issue, on the run's repo",
      ['issue', 'create', '--repo', REPO, '--title', 'Sign in', '--label', 'spec'],
      'spec-body.md',
      true,
    ],
    [
      'an issue on another repo',
      ['issue', 'create', '--repo', 'mkdir-swe/other', '--title', 'Sign in'],
      'spec-body.md',
      'not-your-session',
    ],
    [
      'a body file out of the worktree',
      ['issue', 'create', '--repo', REPO, '--title', 'Sign in'],
      '/etc/hosts',
      'unreadable-body-file',
    ],
    ["the spec's link on its own card", ['card', 'comment', '4'], 'spec-comment.md', true],
    ['a comment on another card', ['card', 'comment', '5'], 'spec-comment.md', 'not-your-session'],
  ] as const)(
    "from the container, the to-spec skill's writes read their body in the worktree: %s",
    async (_, argv, file, answer) => {
      const scratch = join(w.standIn.workdir, '.scratch', '4');

      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'spec-body.md'), '## Problem\n\nNo sign in.\n');
      writeFileSync(join(scratch, 'spec-comment.md'), 'Spec: https://github.com/x/y/issues/12\n');
      const before = { issues: issues.length, comments: comments.length };
      const path = file.startsWith('/') ? file : `.scratch/4/${file}`;
      const out = z
        .object({ ok: z.boolean(), error: z.object({ code: z.string() }).optional() })
        .parse(JSON.parse((await say(...argv, '--body-file', path)).stdout));

      expect(out.ok ? true : out.error?.code).toBe(answer);
      if (answer !== true) {
        expect([issues.length, comments.length]).toEqual([before.issues, before.comments]);
      } else if (argv[0] === 'issue') {
        expect(issues.at(-1)).toEqual({
          repo: REPO,
          title: 'Sign in',
          body: '## Problem\n\nNo sign in.\n',
          labels: ['spec'],
        });
      } else {
        expect(comments.at(-1)?.card).toBe(4);
        expect(comments.at(-1)?.text).toContain('Spec: https://github.com/x/y/issues/12');
      }
    },
  );

  test("base-worktree: Before's worktree beside the clone in the workspace, at the merge base", async () => {
    const Base = z.object({
      ok: z.literal(true),
      data: z.object({
        path: z.string(),
        base: z.string(),
        branch: z.string(),
        against: z.string(),
      }),
    });
    const made = Base.parse(JSON.parse((await say('factory', 'base-worktree')).stdout));
    const head = (cwd: string, ref: string) =>
      Bun.spawnSync(['git', '-C', cwd, 'rev-parse', ref]).stdout.toString().trim();

    expect(made.data).toMatchObject({
      path: `${w.standIn.workdir}-base`,
      branch: 'card/4-as-a-visitor-i-can',
      against: 'main',
    });
    expect(made.data.base).toBe(head(w.standIn.workdir, 'main'));
    expect(head(made.data.path, 'HEAD')).toBe(made.data.base);
    // Again, it is moved back to the merge base, an earlier Before's edits gone.
    writeFileSync(join(made.data.path, 'a.txt'), 'edited\n');
    const again = Base.parse(JSON.parse((await say('factory', 'base-worktree')).stdout));

    expect(again.data.path).toBe(made.data.path);
    expect(readFileSync(join(made.data.path, 'a.txt'), 'utf8')).toBe('one\n');
  });

  test("factory status on the Mac answers the box's run: every stage and its time", async () => {
    const status = await w.mac.json(FactoryStatusData, 'factory', 'status', '4');

    expect(status.doc.ok).toBe(true);
    if (!status.doc.ok) return;
    const [shown] = status.doc.data.runs;

    expect(status.doc.data.runs).toHaveLength(1);
    expect(shown).toMatchObject({ session: run.session, stage: 'verify' });
    expect(shown?.stages.map((st) => st.stage)).toEqual([
      'spec',
      'step',
      'build',
      'checks',
      'review',
    ]);
    expect(shown?.workflow).toMatchObject({ id: 'feature', layer: 'built-in' });
  });

  test("factory checks on the Mac runs the card's checks again on its box", async () => {
    const checked = await w.mac.json(FactoryChecksData, 'factory', 'checks', '4');

    expect(checked.doc.ok && checked.doc.data).toMatchObject({
      card: 4,
      session: run.session,
      green: true,
      cause: 'on-demand',
    });
  });

  test('verify after, then the pr stage reads its body in the container: a body without a Verified line is refused', async () => {
    const scratch = join(w.standIn.workdir, '.scratch', '4');
    const map = join(w.standIn.workdir, '.claude', 'skills', 'verify-demo-shop', 'features');
    const evidence = join(scratch, 'verify', 'evidence', 'cart');
    const after = async () =>
      Answer.parse(
        JSON.parse(
          (
            await say(
              'factory',
              'verify',
              '--phase',
              'after',
              '--result',
              'pass',
              '--report',
              '.scratch/4/verify-after.md',
              '--html',
              '.scratch/4/verify-after.html',
            )
          ).stdout,
        ),
      );

    // the Feature map and the Evidence are read in the container: a driven feature's proof that
    // is not there refuses the pass
    mkdirSync(map, { recursive: true });
    writeFileSync(join(map, 'README.md'), '# Shop\n\n- [Cart](./cart.md)\n');
    writeFileSync(
      join(scratch, 'verify-after.md'),
      '# Verify after\n\nResult: pass\n\n## Features\n\n- `cart` pass. Judged by: the total counts the item. Evidence: verify/evidence/cart/total.png, verify/evidence/cart/drive.webm\n',
    );
    writeFileSync(
      join(scratch, 'verify-after.html'),
      '<section class="ab-verify-feature" data-feature="cart" data-verdict="pass"><h4 class="ab-verify-head">Cart</h4></section>',
    );
    expect((await after()).error?.code).toBe('feature-unproven');
    mkdirSync(evidence, { recursive: true });
    for (const f of ['total.png', 'drive.webm']) writeFileSync(join(evidence, f), '');
    const verified = await after();

    // on to the playbook's gate, then pr
    expect(verified).toMatchObject({ ok: true, data: { stage: 'step', step: 'playbook' } });
    expect(
      Answer.parse(
        JSON.parse(
          (await say('factory', 'judge', '--answer', 'no', '--reason', 'nothing by hand')).stdout,
        ),
      ),
    ).toMatchObject({ ok: true, data: { stage: 'pr' } });
    expect(readFileSync(join(scratch, 'verify', '1-after.md'), 'utf8')).toContain('Result: pass');
    writeFileSync(join(scratch, 'pr.md'), 'No verification line here.\n');
    const pr = Answer.parse(
      JSON.parse(
        (await say('factory', 'pr', '--title', 'Sign in', '--body-file', '.scratch/4/pr.md'))
          .stdout,
      ),
    );

    expect(pr.error?.code).toBe('bad-pr-body');
    const missing = Answer.parse(
      JSON.parse(
        (await say('factory', 'pr', '--title', 'Sign in', '--body-file', '/etc/hosts')).stdout,
      ),
    );

    expect(missing.error?.code).toBe('unreadable-body-file');
  });

  test("factory end on the Mac ends the box's run there (#184): done, its session stopped", async () => {
    const ended = await w.mac.json(
      FactoryEndData,
      'factory',
      'end',
      '4',
      '--as',
      'abandoned',
      '--reason',
      'tried in the cloud test',
    );

    expect(ended.doc.ok && ended.doc.data).toMatchObject({
      card: 4,
      as: 'abandoned',
      pr: null,
      session: `${run.session} stopped`,
      run: { session: run.session, state: 'done', outcome: 'abandoned' },
    });
    const status = await w.mac.json(FactoryStatusData, 'factory', 'status', '4');

    // on the stage it was given up in (#230)
    expect(
      status.doc.ok && status.doc.data.runs.map((r) => [r.state, r.outcome, r.ended?.from]),
    ).toEqual([['done', 'abandoned', 'pr']]);
  });
});

describe("a Factory run on a box whose clone's setup fails", () => {
  test("the run is at Needs you with the setup's output, as a local one", async () => {
    const w = await world('');

    try {
      const checkout = join(w.root, 'checkout');

      checkoutAt(checkout, `${repoSettings(w.ado.board)}setup: echo no packages; exit 3\n`);
      w.box.box.mirrors.checkouts.set(REPO, checkout);
      shell(w.standIn.workdir, 'git init -q -b main');
      const out = await w.mac.json(FactoryRunData, 'factory', 'run', '4', '--repo', REPO);

      expect(out.doc.ok && out.doc.data).toMatchObject({ card: 4, state: 'needs-you' });
      expect(out.doc.ok ? out.doc.data.reason : '').toContain('no packages');
    } finally {
      await done(w);
    }
  });
});

describe("a Factory run of a prototype's card on a box (#351): the Mac reads the reference, the box has no store", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  /** The card's newest version in the org store, as Make card puts it. */
  const seed = async (org: OrgStore) => {
    const base = versionPrefix('demo-shop', 4, 1);
    const at = '2026-10-25T10:00:00.000Z';
    const meta = OrgPrototypeVersion.parse({
      v: 1,
      prototype: 'proto-abc123',
      version: 1,
      at,
      card: 4,
      repo: 'demo-shop',
      remote: null,
      branch: 'main',
      commit: 'a'.repeat(40),
      changes: [],
      mocks: [],
      screenshots: [{ n: 1, what: 'the sign-in', at, file: 'screenshots/1.png' }],
    });
    const put = await putVersion(
      org,
      {
        meta,
        uploads: [
          { key: `${base}screenshots/1.png`, contentType: 'image/png', screenshot: '1.png' },
          { key: `${base}meta.json`, contentType: 'application/json', text: JSON.stringify(meta) },
        ],
      },
      () => Promise.resolve(PNG),
    );

    if (!put.ok) throw new Error(put.error.message);
  };

  test.each([
    [
      'with the org store: its files in the clone before claude, the run and its prompt name it',
      true,
    ],
    ['without one: refused no-org-store, no box asked for', false],
  ])('%s', async (_, store) => {
    const dir = mkdtempSync(join(tmpdir(), 'abe-c-org-'));
    const org = fileOrgStore(dir);
    const w = await world('', { attach: true, ...(store ? { org } : {}) });

    try {
      await seed(org);
      const checkout = join(w.root, 'checkout');

      checkoutAt(checkout, repoSettings(w.ado.board));
      w.box.box.mirrors.checkouts.set(REPO, checkout);
      shell(w.standIn.workdir, 'git init -q -b main');
      expect((await w.mac.json(CardData, 'card', 'tag', '4', '--add', 'prototype')).doc.ok).toBe(
        true,
      );
      const out = await w.mac.json(FactoryRunData, 'factory', 'run', '4', '--repo', REPO);

      if (!store) {
        expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-org-store' } });
        expect(boxNames(w.ec2)).toEqual([]);

        return;
      }
      if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
      const at = join(w.standIn.workdir, '.scratch', '4', 'prototype');

      expect(readFileSync(join(at, 'PROTOTYPE.md'), 'utf8')).toContain('A mock-up: question it');
      expect(readFileSync(join(at, 'screenshots', '1.png'))).toEqual(Buffer.from(PNG));
      expect(
        OrgPrototypeVersion.parse(JSON.parse(readFileSync(join(at, 'meta.json'), 'utf8'))).card,
      ).toBe(4);
      // the Mac kept its copy only until the clone had it
      expect(existsSync(join(w.mac.state.dir, 'cloud', `${out.doc.data.session}.reference`))).toBe(
        false,
      );
      const argv = await until('claude started', () => {
        const a = claudeOutput(w.standIn.workdir).argv;

        return Array.isArray(a) ? JSON.stringify(a) : undefined;
      });

      expect(argv).toContain('.scratch/4/prototype');
      const st = await w.mac.json(FactoryStatusData, 'factory', 'status', '4');

      expect(st.doc.ok ? st.doc.data.runs[0]?.reference : null).toEqual({
        spec: null,
        prototype: { kind: 'store', url: 'prototype://demo-shop/4/v1' },
        dir: '.scratch/4/prototype',
      });
    } finally {
      await done(w);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a Factory run past its session: the Mac follows its box to Done', () => {
  test.each([
    ['its merge, deploy and Done still reach abe watch', 'success'],
    // #361: Needs you with why, a run of the repo read in (the Board's card holds it, End run… ends it)
    ["its deploy failed: Needs you with why, listed as the shown repo's run", 'failure'],
  ] as const)('the session ends with the pull request open; %s', async (_, deployed) => {
    const MERGED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const pull = (state: 'open' | 'merged') => ({
      repo: REPO,
      number: 9,
      title: 'Sign in',
      body: '',
      url: `https://github.com/${REPO}/pull/9`,
      state,
      draft: false,
      head: { ref: 'card/4-as-a-visitor-i-can', sha: 'f'.repeat(40) },
      base: { ref: 'main' },
      mergeable: 'mergeable' as const,
      checks: { state: 'success' as const, runs: [] },
      mergeCommit: state === 'merged' ? MERGED : null,
    });
    // GitHub as the box's pr stage sees it: opened, then merged by a person, then deployed to test.
    const merged = { now: false };
    const tracking: Tracking = {
      ...refusingTracking(),
      prFind: () => Promise.resolve({ ok: true, data: null }),
      prCreate: () => Promise.resolve({ ok: true, data: pull('open') }),
      prShow: () => Promise.resolve({ ok: true, data: pull(merged.now ? 'merged' : 'open') }),
      deployStatus: () =>
        Promise.resolve({
          ok: true,
          data: {
            repo: REPO,
            sha: MERGED,
            environment: 'test',
            state: deployed,
            deployment: null,
          },
        }),
    };
    const git: Git = {
      origin: () =>
        Promise.resolve({
          ok: true,
          data: { url: `https://github.com/${REPO}.git`, defaultBranch: 'main' },
        }),
      push: () => Promise.resolve({ ok: true, data: null }),
      fetchOrigin: () => Promise.resolve({ ok: true, data: null }),
      onOrigin: () => Promise.resolve({ ok: true, data: true }),
      startAt: () => Promise.resolve({ ok: true, data: { moved: false } }),
      work: () => Promise.resolve({ ok: true, data: { uncommitted: 0, unpushed: 0, head: 'f' } }),
      remove: () => Promise.resolve({ ok: true, data: null }),
      tidyWriters: () => Promise.resolve({ ok: true, data: { removed: [], deleted: [] } }),
    };
    const w = await world('', { tracking, git, factoryPollMs: 40 });
    const watch = w.mac.watch('--json');

    try {
      const checkout = join(w.root, 'checkout');

      checkoutAt(
        checkout,
        `${repoSettings(w.ado.board)}checks:\n  - name: tests\n    run: "true"\n`,
      );
      w.box.box.mirrors.checkouts.set(REPO, checkout);
      shell(
        w.standIn.workdir,
        [
          'git init -q -b main',
          'echo one > a.txt',
          'git add a.txt',
          'git commit -qm one',
          'git checkout -qb card/4-as-a-visitor-i-can',
          'echo two >> a.txt',
          'git commit -qam two',
        ].join('\n'),
      );
      await w.mac.run('status');
      const out = await w.mac.json(FactoryRunData, 'factory', 'run', '4', '--repo', REPO);

      if (!out.doc.ok) throw new Error(`factory run refused: ${JSON.stringify(out.doc.error)}`);
      const say = asSession(w, out.doc.data.session);
      const ok = async (...argv: string[]) => {
        const said = Answer.parse(JSON.parse((await say(...argv)).stdout));

        if (!said.ok) throw new Error(`${argv.join(' ')}: ${JSON.stringify(said.error)}`);

        return said.data?.stage;
      };
      const scratch = join(w.standIn.workdir, '.scratch', '4');

      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, 'review.md'), '# Review\n\nclean\n');
      writeFileSync(
        join(scratch, 'pr.md'),
        'Sign in.\n\n**Verified:** by its tests.\n\n## Notes\n\n- None.\n',
      );
      await ok('factory', 'stage-done', 'create-specification');
      await ok('factory', 'stage-done', 'to-tickets');
      await ok('factory', 'stage-done', 'build');
      expect(
        await ok('factory', 'review', '--findings', '0', '--report', '.scratch/4/review.md'),
      ).toBe('verify');
      // verify picks None: nothing to observe beyond the checks; the playbook's gate says no
      expect(
        await ok(
          ...['factory', 'verify', '--phase', 'after', '--result', 'pass'],
          ...['--report', '.scratch/4/review.md'],
        ),
      ).toBe('step');
      expect(await ok('factory', 'judge', '--answer', 'no', '--reason', 'nothing by hand')).toBe(
        'pr',
      );
      // Opened (the box here has no board for the card's link comment: said, the pull request kept).
      const opened = Answer.parse(
        JSON.parse(
          (await say('factory', 'pr', '--title', 'Sign in', '--body-file', '.scratch/4/pr.md'))
            .stdout,
        ),
      );

      expect(
        opened.ok || opened.error?.message.startsWith(`opened https://github.com/${REPO}/pull/9`),
      ).toBe(true);
      // The agent is done; the person stops the session. The run waits on its pull request.
      const stopped = await w.mac.json(SessionData, 'session', 'stop', out.doc.data.session);

      expect(stopped.doc.ok && stopped.doc.data.state).toBe('ended');
      merged.now = true;
      if (deployed === 'success')
        expect(await stagesUntil(watch, (stage) => stage === 'done')).toContainEqual([
          'done',
          'deployed',
        ]);
      // the whole runs list, as the Board reads it in the repo: the box's run is this repo's
      const waiting = await until('the run at Needs you', async () => {
        const st = await w.mac.json(FactoryStatusData, 'factory', 'status');
        const r = st.doc.ok ? st.doc.data.runs.find((x) => x.card === 4) : undefined;

        return r !== undefined && (deployed === 'success' || r.state === 'needs-you')
          ? r
          : undefined;
      });

      expect(waiting.repo).toBe(REPO);
      if (deployed === 'failure') {
        expect(waiting).toMatchObject({ stage: 'pr', state: 'needs-you', outcome: null });
        expect(waiting.reason).toContain('the deploy to test failed');
        expect(waiting.pr?.state).toBe('merged');
      }
    } finally {
      watch.close();
      await done(w);
    }
  });
});

/** How many times EC2's instances were read so far (the queue reads them each look). */
const describes = (ec2: { calls: () => string[] }) =>
  ec2.calls().filter((c) => c.includes('describe-instances')).length;

describe('Queued at the limit (running and starting boxes count), started when a box stops', () => {
  let w: World;

  beforeAll(async () => {
    w = await world('limits.maxBoxesPerPerson: 1\n');
    // Another card's box of the person's, running already.
    w.ec2.put({ name: 'other-9', repo: 'mkdir-swe/abe-org', card: 9 });
  });
  afterAll(async () => {
    await done(w);
  });

  test('the launch answers Queued, then starts on its own once the other box stops', async () => {
    await w.mac.run('status');
    const watch = w.mac.watch('--json');
    const s = await launch(w.mac);

    expect(s).toMatchObject({ state: 'queued', box: BOX });
    expect(boxNames(w.ec2)).toEqual(['other-9']);
    // Its text says why it waits and until when (#194).
    expect((await w.mac.run('session', 'show', s.id)).stdout).toContain(
      ': 1 of 1 boxes running or starting (other-9; limits.maxBoxesPerPerson) · starts when one stops',
    );
    // The queue looked at EC2 twice more since: still no room while the other box runs.
    const looked = describes(w.ec2);

    await until('the queue looked again', () =>
      describes(w.ec2) >= looked + 2 ? true : undefined,
    );
    expect(boxNames(w.ec2)).toEqual(['other-9']);
    // A stopped box never counts: its stop makes room.
    w.ec2.set('other-9', 'stopped');
    const seen = await statesUntil(watch, (cause) => cause === 'Stop');

    watch.close();
    expect(seen.slice(0, 2)).toEqual([
      ['queued', 'queued'],
      ['dequeued', 'starting'],
    ]);
    expect(seen).toContainEqual(['Stop', 'waiting']);
    const shown = await w.mac.json(SessionData, 'session', 'show', s.id);

    expect(shown.doc.ok && shown.doc.data.state).toBe('waiting');
  });
});

describe("a launch onto its repo's running box short of memory asks first (ADR 0022)", () => {
  const GiB = 1024 ** 3;
  /** The box's machine: 1.4 GB of memory free, room on its disk. */
  const short: BoxHost = {
    shutdown: () => Promise.resolve({ ok: true, data: null }),
    attached: () => Promise.resolve(false),
    load: () =>
      Promise.resolve({
        memAvailableKb: 1_468_006,
        memTotalKb: 16_777_216,
        cpu: { busy: 100, total: 1000 },
        disk: { freeBytes: 30 * GiB, totalBytes: 60 * GiB },
      }),
  };
  const launchAs = (w: World, ...flags: string[]) =>
    w.mac.json(SessionData, 'session', 'launch', '--card', '4', '--repo', REPO, ...flags);
  const onShortBox = async () => {
    const w = await world('', { boxHost: short });

    shell(w.standIn.workdir, 'git init -q -b main');
    w.ec2.put({ name: BOX, repo: REPO });
    await w.mac.run('status');

    return w;
  };

  test('refused box-short with its choices, nothing launched; --short anyway launches on it as it is', async () => {
    const w = await onShortBox();

    try {
      const asked = await launchAs(w);

      expect(asked.doc.ok).toBe(false);
      if (asked.doc.ok) return;
      expect(asked.doc.error).toMatchObject({
        code: 'box-short',
        boxShort: {
          box: BOX,
          short: 'memory',
          line: `${BOX} is short of memory: 1.4 GB free, 0 workspaces`,
          resize: 'm8g.xlarge',
        },
      });
      expect(asked.doc.error.boxShort?.choices.map((c) => c.answer)).toEqual([
        'resize',
        'anyway',
        'cancel',
      ]);
      // never Queued, never a second box: nothing of it is kept
      expect((await w.mac.json(SessionListData, 'session', 'list')).doc).toMatchObject({
        ok: true,
        data: { sessions: [] },
      });
      const went = await launchAs(w, '--short', 'anyway');

      expect(went.doc).toMatchObject({ ok: true, data: { card: 4, box: BOX } });
      expect(boxNames(w.ec2)).toEqual([BOX]);
      expect(w.ec2.instance(BOX)?.InstanceType).toBe('m8g.large');
    } finally {
      await done(w);
    }
  });

  test('--short resize: the box resized to the next size first, then the launch goes on there', async () => {
    const w = await onShortBox();

    try {
      const went = await launchAs(w, '--short', 'resize');

      expect(went.doc).toMatchObject({ ok: true, data: { card: 4, box: BOX } });
      expect(boxNames(w.ec2)).toEqual([BOX]);
      expect(w.ec2.instance(BOX)).toMatchObject({ InstanceType: 'm8g.xlarge', State: 'running' });
    } finally {
      await done(w);
    }
  });
});

describe('a Factory run Queued at the limit, ended or stopped before its box has it (#234)', () => {
  let w: World;
  let watch: Watching;
  const seen: EventLine[] = [];

  beforeAll(async () => {
    w = await world('limits.maxBoxesPerPerson: 1\n');
    // Another card's box of the person's, running: card 4's run waits for room.
    w.ec2.put({ name: 'other-9', repo: 'mkdir-swe/abe-org', card: 9 });
    await w.mac.run('status');
    watch = w.mac.watch('--json');
    void (async () => {
      for (;;) {
        const line = await watch.next(60_000).catch(() => undefined);

        if (line === undefined) return;
        seen.push(EventLine.parse(JSON.parse(line)));
      }
    })();
  });
  afterAll(async () => {
    watch.close();
    await done(w);
  });

  const queuedRun = async () => {
    const out = await w.mac.json(FactoryRunData, 'factory', 'run', '4', '--repo', REPO);

    if (!out.doc.ok) throw new Error(`factory run refused: ${JSON.stringify(out.doc.error)}`);
    expect(out.doc.data.state).toBe('queued');

    return out.doc.data;
  };
  const Staged = z.object({
    session: z.string(),
    from: z.string().nullable(),
    state: z.string(),
    outcome: z.string().nullable(),
    cause: z.string(),
  });
  const stagedOf = (session: string) =>
    seen
      .filter((e) => e.type === 'factory.stage')
      .map((e) => Staged.parse(e.data))
      .filter((d) => d.session === session);
  const comments = () => w.ado.requests().filter((r) => r.includes('/comments'));
  const queuedCards = async () => {
    const listed = await w.mac.json(BoxListData, 'box', 'list');

    return listed.doc.ok ? listed.doc.data.queued.map((q) => q.card) : undefined;
  };

  test('End run… takes it out of the queue on the Mac: ended as asked, its card moved and not commented, no box woken', async () => {
    const run = await queuedRun();
    const before = comments().length;
    const ended = await w.mac.json(
      FactoryEndData,
      'factory',
      'end',
      '4',
      '--as',
      'abandoned',
      '--reason',
      'not this sprint',
    );

    expect(ended.doc.ok ? ended.doc.data : ended.doc.error).toMatchObject({
      card: 4,
      as: 'abandoned',
      pr: null,
      comment: NOT_COMMENTED,
      session: `${run.session} taken out of the queue for ${BOX}`,
      run: {
        session: run.session,
        state: 'done',
        outcome: 'abandoned',
        ended: { as: 'abandoned', reason: 'not this sprint', from: 'spec' },
      },
    });
    // Abe leaves the card's comments to you: none posted to Azure Boards.
    expect(comments().length).toBe(before);
    // Its card to New, as every abandoned run's: said on the watch too.
    expect(
      w.ado.requests().filter((r) => r.startsWith('PATCH') && r.includes('/workitems/4')),
    ).not.toEqual([]);
    await until('its factory.card', () =>
      seen.find((e) => e.type === 'factory.card' && JSON.stringify(e.data).includes(run.session)),
    );
    // Out of the queue: its session ended by your hand, no box made or woken for it.
    const shown = await w.mac.json(SessionData, 'session', 'show', run.session);

    expect(shown.doc.ok && [shown.doc.data.state, shown.doc.data.stopped]).toEqual(['ended', true]);
    expect(await queuedCards()).toEqual([]);
    expect(boxNames(w.ec2)).toEqual(['other-9']);
    // The card and Chat hear it at once, and a read says the same.
    expect(
      await until('its factory.stage', () =>
        stagedOf(run.session).find((d) => d.outcome === 'abandoned'),
      ),
    ).toMatchObject({ from: 'spec', state: 'done', cause: 'end' });
    const status = await w.mac.json(FactoryStatusData, 'factory', 'status', '4');

    expect(
      status.doc.ok &&
        status.doc.data.runs
          .filter((r) => r.session === run.session)
          .map((r) => [r.state, r.outcome, r.ended?.from]),
    ).toEqual([['done', 'abandoned', 'spec']]);
  });

  test('Stop… takes it out of the queue too: the run reads stopped, and End run… then ends it on the Mac', async () => {
    const run = await queuedRun();
    const stopped = await w.mac.json(SessionData, 'session', 'stop', run.session);

    expect(stopped.doc.ok && [stopped.doc.data.state, stopped.doc.data.stopped]).toEqual([
      'ended',
      true,
    ]);
    expect(await queuedCards()).toEqual([]);
    // No longer Queued: the card says its session ended, at once and on a read.
    await until('its factory.stage', () =>
      stagedOf(run.session).find((d) => d.state === 'needs-you'),
    );
    const status = await w.mac.json(FactoryStatusData, 'factory', 'status', '4');
    const runOf = () =>
      status.doc.ok ? status.doc.data.runs.find((r) => r.session === run.session) : undefined;

    expect([runOf()?.state, runOf()?.outcome]).toEqual(['needs-you', null]);
    // Ended afterwards: here, never asked of a box that never had it.
    const ended = await w.mac.json(
      FactoryEndData,
      'factory',
      'end',
      '4',
      '--as',
      'abandoned',
      '--reason',
      'stopped it first',
    );

    expect(ended.doc.ok ? ended.doc.data : ended.doc.error).toMatchObject({
      session: `${run.session} ended already`,
      run: { session: run.session, state: 'done', outcome: 'abandoned' },
    });
    expect(boxNames(w.ec2)).toEqual(['other-9']);
  });

  test('it never got a box (#246): its session says so, no Workspace to attach or download', async () => {
    const run = await queuedRun();

    await w.mac.json(SessionData, 'session', 'stop', run.session);
    const shown = await w.mac.json(SessionData, 'session', 'show', run.session);

    expect(shown.doc.ok && [shown.doc.data.box, shown.doc.data.neverPlaced]).toEqual([BOX, true]);
    const spec = await w.mac.json(z.unknown(), 'workspace', 'attach-spec', run.session);

    expect(spec.doc.ok ? spec.doc.data : spec.doc.error).toMatchObject({
      code: 'session-never-placed',
      message: `session ${run.session} never got a box: it has no Workspace`,
    });
    const down = await w.mac.json(z.unknown(), 'session', 'download', run.session, '--repo', REPO);

    expect(down.doc.ok ? down.doc.data : down.doc.error.code).toBe('session-never-placed');
    expect(boxNames(w.ec2)).toEqual(['other-9']);
  });
});

describe('a restarted serve', () => {
  test('a launch it was bringing up has ended, so the card is free again', async () => {
    const ec2 = fakeEc2();
    const state = tempState();
    const env = {
      PATH: ec2.path,
      ABE_OWNER: ec2.owner,
      ABE_BOX_LINK: 'socket:/nonexistent.sock',
    };
    const since = '2026-10-24T10:00:00.000Z';

    mkdirSync(join(state.dir, 'cloud'), { recursive: true });
    writeFileSync(
      join(state.dir, 'cloud', '4-abcd.json'),
      JSON.stringify({
        v: 1,
        id: '4-abcd',
        card: 4,
        title: 'As a visitor I can sign in with email',
        description: '',
        criteria: '',
        repo: REPO,
        worktree: '/workspace/repo',
        branch: 'card/4-as-a-visitor-i-can',
        box: BOX,
        state: 'starting',
        since,
        startedAt: since,
        transcriptPath: null,
        lastAssistantMessage: null,
        models: null,
        subagents: [],
        limit: 3,
      }),
    );
    // A serve started again on the state the last one left.
    const mac = await macServed(env, { state });

    try {
      const listed = await mac.json(SessionListData, 'session', 'list');

      expect(listed.doc.ok && listed.doc.data.sessions.map((x) => [x.id, x.state])).toEqual([
        ['4-abcd', 'ended'],
      ]);
    } finally {
      await mac.close();
      ec2.remove();
    }
  });
});
