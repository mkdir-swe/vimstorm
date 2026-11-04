/**
 * Download locally and Move to cloud (#88). The Mac's serve runs in this test as `abe serve` builds
 * it (`macServed`); its EC2 the fake `aws`; the box a real `serve` in this test (the second serve
 * standing in for the Workspace's box, as #63's tests) with the fake Docker port and the stand-in
 * workspace (the fake `claude` in a real `tmux`); `abe box attach <box> -- …` the fake
 * (`$ABE_BOX_ATTACH`), which runs the copy's commands in the stand-in's clone, a real git repo
 * here. A session launched into your environment is downloaded to this Mac, worked on, and moved
 * back.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answered,
  boxName,
  claudeSessionFile,
  claudeSessionOf,
  EventLine,
  type LoginSet,
  readEnvelope,
  type Secrets,
  SessionData,
  SessionListData,
  SessionMoveData,
  worktreePath,
} from '@abe/core';
import {
  claudeOutput,
  fakeAdo,
  type FakeAdo,
  fakeAws,
  type FakeAws,
  fakeAz,
  type FakeAz,
  fakeBoxAttach,
  fakeClaude,
  type FakeClaude,
  fakeEc2,
  type FakeEc2,
  fakeDocker,
  fakeGh,
  type FakeGh,
  fakeMirrors,
  macServed,
  scenario,
  secretText,
  type ServedCli,
  type ServeScenario,
  type StandIn,
  standInWorkspace,
  type Watching,
  tempState,
  tmuxPath,
} from '@abe/testing';
import { z } from 'zod';
import { moveLocks } from './move';

setDefaultTimeout(60_000);

const REPO = 'mkdir-swe/demo-shop';
const BOX = boxName(REPO);
const BRANCH = 'card/4-as-a-visitor-i-can';
const READ_URL = 'postgres://reader:r3ad@test-db:5432/shop';

/** The repo's settings after its board and `move.leave`: its environments. */
const REPO_SETTINGS = [
  'environments:',
  '  test:',
  '    account: "111111111111"',
  '    region: eu-west-1',
  '    db:',
  '      read: { secret: abe/test/db-read }',
  '',
].join('\n');

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
    Promise.resolve({ ok: true, data: { claude: 'fake-claude-login', github: 'fake-gh-login' } }),
};

const sh = (cwd: string, script: string) => {
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

  if (out.exitCode !== 0) throw new Error(`${script}: ${out.stderr.toString()}`);

  return out.stdout.toString();
};

const until = async <T>(what: string, check: () => Promise<T | undefined> | T | undefined) => {
  const deadline = Date.now() + 20_000;

  for (;;) {
    const value = await check();

    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

type World = {
  root: string;
  /** This Mac's checkout of the repo. */
  checkout: string;
  ado: FakeAdo;
  az: FakeAz;
  aws: FakeAws;
  gh: FakeGh;
  claude: FakeClaude;
  ec2: FakeEc2;
  standIn: StandIn;
  box: ServeScenario;
  mac: ServedCli;
};

/** What a test puts in the Mac's state before its serve starts (a session that ended here). */
type Seed = (w: Omit<World, 'mac'>, macDir: string) => void;

/** `local`: yours for the repo (`.abe/settings.local.yaml`). */
const world = async (local = '', seed?: Seed): Promise<World> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-m-')));
  const checkout = join(root, 'shop');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const aws = fakeAws([['--secret-id abe/test/db-read ', secretText(READ_URL)]]);
  const gh = fakeGh([
    ['api user', { json: { login: 'octocat', id: 583231, name: 'The Octocat' } }],
    ['auth', { stdout: '' }],
  ]);
  const claude = fakeClaude();
  const ec2 = fakeEc2({ owner: 'octocat', bootMs: 300, stopMs: 300 });
  const docker = fakeDocker();
  const mirrors = fakeMirrors();

  mirrors.trees.set(REPO, 'tree1');
  for (const dir of ['mine', 'shop/.abe']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
  // This Mac's checkout: the repo's first commit, its origin on GitHub (never fetched here). Its
  // settings: the board, the environments, and the fixtures' dumps the repo pack leaves behind.
  writeFileSync(
    join(checkout, 'abe.yaml'),
    `board: ${JSON.stringify(ado.board)}\nmove.leave: ["*.sql"]\n${REPO_SETTINGS}`,
  );
  sh(
    checkout,
    [
      'git init -q -b main',
      'printf "# shop\\n" > README.md',
      'printf "export const total = 1;\\n" > cart.ts',
      'git add . && git commit -q -m first',
      'git remote add origin https://github.com/mkdir-swe/demo-shop.git',
      // yours for the repo, never committed
      'printf ".abe/settings.local.yaml\\n" >> .git/info/exclude',
    ].join('\n'),
  );
  writeFileSync(join(checkout, '.abe', 'settings.local.yaml'), local);
  const state = tempState();

  const standIn = standInWorkspace({
    docker,
    stateDir: state.dir,
    path: [gh.dir],
  });
  // The Workspace's clone, as `workspace up` makes it: the repo, its git identity the person's.
  sh(
    standIn.workdir,
    [
      `git clone -q ${checkout} .`,
      'git config user.name "The Octocat"',
      'git config user.email octocat@users.noreply.github.com',
      'printf ".scratch/\\n.abe/settings.local.yaml\\n" >> .git/info/exclude',
      'mkdir -p .abe',
      ': > .abe/settings.local.yaml',
    ].join('\n'),
  );
  // The box's checkout of the repo's default branch: the repo's settings there.
  const boxCheckout = join(root, 'box-checkout');

  sh(root, `git clone -q ${checkout} ${boxCheckout}`);
  mirrors.checkouts.set(REPO, boxCheckout);
  const box = await scenario({
    state,
    box: { docker, mirrors },
    boxWorkdir: standIn.workdir,
    sessions: { runner: standIn.runner },
    logins,
    secrets,
    reachTarget: 'cloud',
  });
  const attach = fakeBoxAttach({ root: '/workspace/repo', dir: standIn.workdir });
  // One `aws` on the Mac's PATH: Secrets Manager answered by the secrets fake, EC2 by the boxes'.
  const bin = join(root, 'bin');

  mkdirSync(bin);
  writeFileSync(
    join(bin, 'aws'),
    `#!/bin/sh\ncase "$1" in secretsmanager) exec ${JSON.stringify(join(aws.dir, 'aws'))} "$@";; esac\nexec ${JSON.stringify(join(ec2.dir, 'aws'))} "$@"\n`,
    { mode: 0o755 },
  );
  const macState = tempState();

  seed?.({ root, checkout, ado, az, aws, gh, claude, ec2, standIn, box }, macState.dir);
  const mac = await macServed(
    {
      PATH: `${claude.dir}:${az.dir}:${bin}:/usr/bin:/bin`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_OWNER: ec2.owner,
      ABE_BOX_LINK: `socket:${state.socket}`,
      ABE_BOX_ATTACH: attach.bin,
      ABE_CLOUD_POLL_MS: '40',
      ABE_TMUX: tmuxPath(),
      ...ado.env,
    },
    { state: macState, cwd: checkout },
  );

  return { root, checkout, ado, az, aws, gh, claude, ec2, standIn, box, mac };
};

const done = async (w: World) => {
  await w.mac.close();
  await w.box.close();
  await w.standIn.remove();
  w.ec2.remove();
  await w.ado.stop();
  w.az.remove();
  w.aws.remove();
  w.gh.remove();
  w.claude.remove();
  rmSync(w.root, { recursive: true, force: true });
};

const Moved = z.object({
  type: z.literal('session.moved'),
  data: z.object({
    id: z.string(),
    card: z.number(),
    from: z.string(),
    to: z.string(),
    box: z.string(),
    worktree: z.string(),
  }),
});

const movedEvent = async (watch: Watching) => {
  for (;;) {
    const event = Moved.safeParse(EventLine.parse(JSON.parse(await watch.next(20_000))));

    if (event.success) return event.data.data;
  }
};

const listed = async (mac: ServedCli) => {
  const out = await mac.json(SessionListData, 'session', 'list');

  if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

  return out.doc.data.sessions;
};

describe('Download locally, then Move to cloud: the same session both ways', () => {
  let w: World;
  let s: SessionData;
  let watch: Watching;
  let down: SessionMoveData;
  let local: string;
  let boxHead: string;
  let staged: string;
  let unstaged: string;
  let claudeSession: string;

  beforeAll(async () => {
    w = await world();
    await w.mac.run('status');
    watch = w.mac.watch('--json');
    const launched = await w.mac.json(
      SessionData,
      'session',
      'launch',
      '--card',
      '4',
      '--repo',
      REPO,
    );

    if (!launched.doc.ok) throw new Error(JSON.stringify(launched.doc.error));
    s = launched.doc.data;
    // The session's work in the box's clone: a commit, staged and unstaged changes, new files.
    sh(
      w.standIn.workdir,
      [
        `git checkout -q -b ${BRANCH}`,
        'printf "export const total = 2;\\n" > cart.ts',
        'git commit -q -am "box work"',
        'printf "export const sign = 1;\\n" > sign.ts && git add sign.ts',
        'printf "# shop, signed in\\n" > README.md',
        'printf "notes\\n" > notes.md',
        'mkdir -p node_modules/x && printf "x\\n" > node_modules/x/index.js',
        'printf "SECRET=1\\n" > .env',
        'printf "dump\\n" > seed.sql',
        'mkdir -p .scratch/4 && printf "# checks\\n" > .scratch/4/checks.md',
      ].join('\n'),
    );
    boxHead = sh(w.standIn.workdir, 'git rev-parse HEAD').trim();
    staged = sh(w.standIn.workdir, 'git diff --cached');
    unstaged = sh(w.standIn.workdir, 'git diff');
    // Its transcript is known on the Mac once a hook named it.
    claudeSession = await until('the transcript', async () => {
      const out = await w.mac.json(SessionData, 'session', 'show', s.id);

      return out.doc.ok ? claudeSessionOf(out.doc.data.transcriptPath) : undefined;
    });
    const out = await w.mac.json(
      SessionMoveData,
      'session',
      'download',
      s.id,
      '--repo',
      w.checkout,
    );

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    down = out.doc.data;
    local = worktreePath(w.checkout, BRANCH);
  });
  afterAll(async () => {
    watch.close();
    await done(w);
  });

  test('the local worktree has the same HEAD, the same staged and unstaged diff, the untracked files and .scratch', () => {
    expect(down).toMatchObject({
      id: s.id,
      from: 'cloud',
      to: 'local',
      worktree: local,
      head: boxHead,
    });
    expect(sh(local, 'git rev-parse HEAD').trim()).toBe(boxHead);
    expect(sh(local, 'git symbolic-ref --short HEAD').trim()).toBe(BRANCH);
    expect(sh(local, 'git diff --cached')).toBe(staged);
    expect(sh(local, 'git diff')).toBe(unstaged);
    expect(readFileSync(join(local, 'notes.md'), 'utf8')).toBe('notes\n');
    expect(readFileSync(join(local, '.scratch', '4', 'checks.md'), 'utf8')).toBe('# checks\n');
  });

  test('left behind: packages, credentials and the repo pack’s globs', () => {
    expect(existsSync(join(local, 'node_modules'))).toBe(false);
    expect(existsSync(join(local, '.env'))).toBe(false);
    expect(existsSync(join(local, 'seed.sql'))).toBe(false);
    expect(down.left).toEqual([
      { path: '.env', why: 'credentials' },
      { path: 'node_modules/x/index.js', why: 'packages' },
      { path: 'seed.sql', why: 'repo' },
    ]);
  });

  test('claude --resume goes on with the copied transcript: a log in .scratch and Claude Code’s own file', async () => {
    const log = join(local, '.scratch', '4', 'sessions', `${s.id}.jsonl`);

    expect(down.copied.transcript).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('"sessionId"');
    const argv = await until('the local claude', () => {
      const a = z.array(z.string()).safeParse(claudeOutput(local).argv);

      return a.success ? a.data : undefined;
    });

    expect(argv[argv.indexOf('--resume') + 1]).toBe(claudeSession);
    expect(argv).not.toContain('--session-id');
    const home = z.object({ HOME: z.string() }).parse(claudeOutput(local).env).HOME;

    expect(existsSync(claudeSessionFile(home, sh(local, 'pwd -P').trim(), claudeSession))).toBe(
      true,
    );
  });

  test('a local session with read names only, its state from hooks; listed once, here', async () => {
    const env = z.record(z.string(), z.string()).parse(claudeOutput(local).env);

    expect(env.ABE_DB_READ_URL_TEST).toBe(READ_URL);
    expect(Object.keys(env).filter((k) => k.includes('WRITE'))).toEqual([]);
    const shown = await until('a hook-driven state', async () => {
      const mine = (await listed(w.mac)).filter((x) => x.id === s.id);

      return mine.length === 1 && mine[0]?.state === 'waiting' ? mine : undefined;
    });

    expect(shown[0]?.box).toBeUndefined();
    expect(shown[0]?.worktree).toBe(local);
  });

  test('the box is stopped, not deleted; session.moved said it', async () => {
    expect(down.boxStopped).toBe(true);
    expect(
      w.ec2.instances().map((i) => i.Tags.find((t) => t.Key === 'abe:box')?.Value ?? ''),
    ).toEqual([BOX]);
    await until('the box stopped', () =>
      w.ec2.instance(BOX)?.State === 'stopped' ? true : undefined,
    );
    expect(await movedEvent(watch)).toEqual({
      id: s.id,
      card: 4,
      from: 'cloud',
      to: 'local',
      box: BOX,
      worktree: local,
    });
  });

  test('a second download is refused: it runs on this Mac', async () => {
    const again = await w.mac.json(
      SessionMoveData,
      'session',
      'download',
      s.id,
      '--repo',
      w.checkout,
    );

    expect(again.doc).toMatchObject({ ok: false, error: { code: 'not-cloud' } });
  });

  test('a serve that fronts no boxes refuses a download: no-boxes', async () => {
    const out = readEnvelope(
      z.unknown(),
      JSON.parse((await w.box.request('session', 'download', s.id, '--json')).stdout),
    );

    expect(out).toMatchObject({ ok: false, error: { code: 'no-boxes' } });
  });

  describe('what the box’s session run --resume takes', () => {
    const text = JSON.stringify({ title: 'Sign in', description: '', acceptanceCriteria: '' });
    const run = async (...more: string[]) =>
      readEnvelope(
        z.unknown(),
        JSON.parse(
          (
            await w.box.request(
              'session',
              'run',
              '--repo',
              REPO,
              '--card',
              '4',
              '--text',
              text,
              ...more,
              '--json',
            )
          ).stdout,
        ),
      );

    test.each([
      [
        ['--resume', 'not-a-uuid', '--transcript', '.scratch/4/s.jsonl', '--from', '/w'],
        'Claude session id',
      ],
      [
        [
          '--resume',
          '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
          '--transcript',
          '/etc/passwd',
          '--from',
          '/w',
        ],
        'under .scratch/',
      ],
      [
        [
          '--resume',
          '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
          '--transcript',
          '.scratch/../x',
          '--from',
          '/w',
        ],
        'under .scratch/',
      ],
      [['--resume', '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6'], '--transcript and --from'],
    ])('%j is usage: %s', async (more, said) => {
      const reply = await run(...more);

      expect(reply).toMatchObject({ ok: false, error: { code: 'usage' } });
      expect(reply.ok ? '' : reply.error.message).toContain(said);
    });
  });

  describe('Move to cloud: the same session back into its Workspace', () => {
    let up: SessionMoveData;
    let localHead: string;

    beforeAll(async () => {
      // Work done here meanwhile: a commit and an untracked file.
      sh(
        local,
        'printf "export const total = 3;\\n" > cart.ts && git add cart.ts && git commit -q -m local',
      );
      writeFileSync(join(local, 'here.md'), 'from the local machine\n');
      localHead = sh(local, 'git rev-parse HEAD').trim();
      const out = await w.mac.json(SessionMoveData, 'session', 'move-to-cloud', s.id);

      if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
      up = out.doc.data;
    });

    test('the clone is at the local head with its changes and files; the clone’s own changes stashed, kept', () => {
      expect(up).toMatchObject({ id: s.id, from: 'local', to: 'cloud', box: BOX, head: localHead });
      const clone = w.standIn.workdir;

      expect(sh(clone, 'git rev-parse HEAD').trim()).toBe(localHead);
      expect(readFileSync(join(clone, 'here.md'), 'utf8')).toBe('from the local machine\n');
      expect(sh(clone, 'git diff --cached')).toBe(sh(local, 'git diff --cached'));
      expect(sh(clone, 'git stash list')).toContain(`before ${s.id} moved in`);
    });

    test('the box’s claude resumes the same Claude session; the local worktree stays as it was', async () => {
      const argv = await until('the box claude resumed', () => {
        const a = z.array(z.string()).safeParse(claudeOutput(w.standIn.workdir).argv);

        return a.success && a.data.includes('--resume') ? a.data : undefined;
      });

      expect(argv[argv.indexOf('--resume') + 1]).toBe(claudeSession);
      expect(readFileSync(join(local, 'here.md'), 'utf8')).toBe('from the local machine\n');
      expect(sh(local, 'git rev-parse HEAD').trim()).toBe(localHead);
    });

    test('listed once, in your environment again', async () => {
      const mine = (await listed(w.mac)).filter((x) => x.id === s.id);

      expect(mine).toHaveLength(1);
      expect(mine[0]?.box).toBe(BOX);
      expect(await movedEvent(watch)).toMatchObject({ id: s.id, from: 'local', to: 'cloud' });
    });
  });
});

describe('download with the Workspace’s box unreachable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abe-u-'));
  let mac: ServedCli;
  const ec2 = fakeEc2();

  beforeAll(async () => {
    const attach = join(dir, 'attach');

    // the box answers nothing until the test lets it, then not at all: a move meanwhile is busy
    writeFileSync(
      attach,
      `#!/bin/sh\nwhile [ ! -f ${JSON.stringify(join(dir, 'go'))} ]; do sleep 0.1; done\necho "ssh: connect to host via eice: Connection timed out" >&2\nexit 255\n`,
      { mode: 0o755 },
    );
    const macState = tempState();
    mkdirSync(join(macState.dir, 'cloud'), { recursive: true });
    writeFileSync(
      join(macState.dir, 'cloud', '4-ab12.json'),
      JSON.stringify({
        v: 1,
        id: '4-ab12',
        card: 4,
        title: 'Sign in',
        description: '',
        criteria: '',
        repo: REPO,
        worktree: '/workspace/repo',
        branch: BRANCH,
        box: BOX,
        state: 'working',
        since: '2026-10-24T10:00:00.000Z',
        startedAt: '2026-10-24T10:00:00.000Z',
        transcriptPath: null,
        lastAssistantMessage: null,
        models: null,
        subagents: [],
        limit: 3,
      }),
    );
    // The same card's earlier session, ended on this Mac and never moved: its id is taken here.
    const cloud = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(join(macState.dir, 'cloud', '4-ab12.json'), 'utf8')));

    writeFileSync(
      join(macState.dir, 'cloud', '4-ef56.json'),
      JSON.stringify({ ...cloud, id: '4-ef56', branch: 'card/4-other' }),
    );
    const local = join(macState.dir, 'sessions', '4-ef56');

    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, 'meta.json'),
      JSON.stringify({
        v: 1,
        id: '4-ef56',
        card: 4,
        title: 'Sign in',
        repo: dir,
        worktree: join(dir, 'wt'),
        branch: 'card/4-other',
        state: 'ended',
        since: '2026-10-24T10:00:00.000Z',
        startedAt: '2026-10-24T10:00:00.000Z',
        transcriptPath: null,
        lastAssistantMessage: null,
        claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
        socket: join(local, 'session.sock'),
      }),
    );
    sh(
      dir,
      'git init -q -b main && git commit -q --allow-empty -m first && git remote add origin https://github.com/mkdir-swe/demo-shop.git',
    );
    // a serve started on what an earlier one left
    mac = await macServed(
      {
        PATH: ec2.path,
        ABE_OWNER: ec2.owner,
        ABE_BOX_LINK: 'socket:/nonexistent.sock',
        ABE_BOX_ATTACH: attach,
      },
      { state: macState },
    );
  });
  afterAll(async () => {
    await mac.close();
    ec2.remove();
    rmSync(dir, { recursive: true, force: true });
  });

  test('box-unreachable, with the way out; a second download meanwhile is move-busy; the worktree made is gone', async () => {
    const download = () =>
      mac.json(SessionMoveData, 'session', 'download', '4-ab12', '--repo', dir);
    const first = download();

    await until('the first download at the box', () =>
      existsSync(worktreePath(dir, BRANCH)) ? true : undefined,
    );
    const again = await download();

    expect(again.doc).toMatchObject({ ok: false, error: { code: 'move-busy' } });
    writeFileSync(join(dir, 'go'), '');
    const unreachable = await first;

    expect(unreachable.doc).toMatchObject({ ok: false, error: { code: 'box-unreachable' } });
    expect(unreachable.exit).toBe(1);
    expect(unreachable.doc.ok ? '' : unreachable.doc.error.message).toContain(
      `abe box up ${REPO} 4`,
    );
    expect(unreachable.doc.ok ? '' : unreachable.doc.error.message).toContain(
      'Connection timed out',
    );
    expect(existsSync(worktreePath(dir, BRANCH))).toBe(false);
    expect(sh(dir, 'git worktree list')).not.toContain(BRANCH);
  });

  test('a session this Mac has a record of already is session-exists before the box is asked', async () => {
    const out = await mac.json(SessionMoveData, 'session', 'download', '4-ef56', '--repo', dir);

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'session-exists' } });
    expect(existsSync(worktreePath(dir, 'card/4-other'))).toBe(false);
  });

  test('another checkout than the session’s repo is refused before the box is asked', async () => {
    const other = mkdtempSync(join(tmpdir(), 'abe-o-'));

    sh(other, 'git init -q -b main && git remote add origin https://github.com/someone/else.git');
    const out = await mac.json(SessionMoveData, 'session', 'download', '4-ab12', '--repo', other);

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'wrong-repo' } });
    rmSync(other, { recursive: true, force: true });
  });
});

describe('Move to cloud past your box limit: Queued, the pack kept until a box frees', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'abe-q-')));
  const checkout = join(dir, 'shop');
  const worktree = join(dir, 'shop-wt', '4-as-a-visitor-i-can');
  let mac: ServedCli;
  const ec2 = fakeEc2();
  let ado: FakeAdo | undefined;
  const az = fakeAz({ tokens: ['token-one'] });
  let out: SessionMoveData;

  beforeAll(async () => {
    ado = await fakeAdo();
    for (const d of ['mine', 'shop/.abe']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
    writeFileSync(join(checkout, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\n`);
    sh(
      checkout,
      [
        'git init -q -b main',
        'printf "# shop\\n" > README.md && git add . && git commit -q -m first',
        'git remote add origin https://github.com/mkdir-swe/demo-shop.git',
        // yours for the repo, never committed: one box at a time
        'printf ".abe/settings.local.yaml\\n" >> .git/info/exclude',
        'printf "limits.maxBoxesPerPerson: 1\\n" > .abe/settings.local.yaml',
        `git worktree add -q -b ${BRANCH} ${worktree}`,
      ].join('\n'),
    );
    writeFileSync(join(worktree, 'wip.md'), 'wip\n');
    const macState = tempState();
    // A local session of card 4 that ended here, and a launch already waiting for a box.
    const at = '2026-10-24T10:00:00.000Z';
    const local = join(macState.dir, 'sessions', '4-ab12');

    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, 'meta.json'),
      JSON.stringify({
        v: 1,
        id: '4-ab12',
        card: 4,
        title: 'As a visitor I can sign in with email',
        repo: checkout,
        worktree,
        branch: BRANCH,
        state: 'ended',
        since: at,
        startedAt: at,
        transcriptPath: null,
        lastAssistantMessage: null,
        claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
        socket: join(local, 'session.sock'),
      }),
    );
    // The Abe chat here: on no card, never moved.
    const hub = join(macState.dir, 'sessions', 'abe-ab12');

    mkdirSync(hub, { recursive: true });
    writeFileSync(
      join(hub, 'meta.json'),
      JSON.stringify({
        v: 1,
        id: 'abe-ab12',
        card: null,
        abe: { repo: checkout },
        title: 'Abe',
        repo: checkout,
        worktree: '',
        branch: '',
        state: 'ended',
        since: at,
        startedAt: at,
        transcriptPath: null,
        lastAssistantMessage: null,
        claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f7',
        socket: join(hub, 'session.sock'),
      }),
    );
    mkdirSync(join(macState.dir, 'cloud'), { recursive: true });
    writeFileSync(
      join(macState.dir, 'cloud', '5-cd34.json'),
      JSON.stringify({
        v: 1,
        id: '5-cd34',
        card: 5,
        title: 'Saved carts',
        description: '',
        criteria: '',
        // Another repo's (ADR 0022: a card of the same repo would share its box).
        repo: 'mkdir-swe/basket',
        worktree: '/workspace/repo',
        branch: 'card/5-saved-carts',
        box: boxName('mkdir-swe/basket'),
        state: 'queued',
        since: at,
        startedAt: at,
        transcriptPath: null,
        lastAssistantMessage: null,
        models: null,
        subagents: [],
        limit: 3,
      }),
    );
    mac = await macServed(
      {
        ...ado.env,
        ABE_CONFIG_DIR: join(dir, 'mine'),
        ABE_OWNER: ec2.owner,
        ABE_BOX_LINK: 'socket:/nonexistent.sock',
        ABE_CLOUD_POLL_MS: '40',
        PATH: `${az.dir}:${ec2.dir}:/usr/bin:/bin`,
      },
      { state: macState, cwd: checkout },
    );
    const moved = await mac.json(SessionMoveData, 'session', 'move-to-cloud', '4-ab12');

    if (!moved.doc.ok) throw new Error(JSON.stringify(moved.doc.error));
    out = moved.doc.data;
  });
  afterAll(async () => {
    await mac.close();
    ec2.remove();
    await ado?.stop();
    az.remove();
    rmSync(dir, { recursive: true, force: true });
  });

  test("queued behind the waiting launch, on the repo's box; the pack waits", () => {
    expect(out).toMatchObject({ id: '4-ab12', to: 'cloud', box: BOX, state: 'queued' });
    expect(out.copied.files).toEqual(['wip.md']);
    expect(existsSync(join(mac.state.dir, 'moves', '4-ab12.tar'))).toBe(true);
  });

  test.each([
    ['5-cd34', 'not-local'],
    ['9-zzzz', 'no-session'],
    ['abe-ab12', 'not-a-card'],
  ])('move-to-cloud %s is refused: %s', async (id, code) => {
    const out = await mac.json(SessionMoveData, 'session', 'move-to-cloud', id);

    expect(out.doc).toMatchObject({ ok: false, error: { code } });
  });

  test('the local worktree stays as it was; the session is listed once, in your environment', async () => {
    expect(readFileSync(join(worktree, 'wip.md'), 'utf8')).toBe('wip\n');
    const mine = (await listed(mac)).filter((x) => x.id === '4-ab12');

    expect(mine.map((x) => [x.box, x.state])).toEqual([[BOX, 'queued']]);
    expect(
      z
        .object({ moved: z.object({ to: z.string(), where: z.string() }) })
        .parse(
          JSON.parse(readFileSync(join(mac.state.dir, 'sessions', '4-ab12', 'meta.json'), 'utf8')),
        ).moved,
    ).toEqual({ to: 'cloud', where: BOX });
  });
});

describe('Move to cloud queued, then a box frees: unpacked into the clone, resumed there', () => {
  const uuid = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
  let w: World;
  let worktree: string;
  let localHead: string;
  let queued: SessionMoveData;

  beforeAll(async () => {
    w = await world('limits.maxBoxesPerPerson: 1\n', (p, dir) => {
      // Another card's box of mine runs already: the limit is reached.
      p.ec2.put({ name: 'other-9', repo: 'mkdir-swe/abe-org', card: 9 });
      // A local session of card 4 that ended here: a commit, an untracked file, its transcript.
      worktree = join(p.root, 'shop-wt', '4-as-a-visitor-i-can');
      sh(p.checkout, `git worktree add -q -b ${BRANCH} ${worktree}`);
      sh(worktree, 'printf "export const total = 3;\\n" > cart.ts && git commit -q -am local');
      writeFileSync(join(worktree, 'here.md'), 'from the local machine\n');
      localHead = sh(worktree, 'git rev-parse HEAD').trim();
      const projects = join(p.root, 'home', '.claude', 'projects', 'x');

      mkdirSync(projects, { recursive: true });
      writeFileSync(
        join(projects, `${uuid}.jsonl`),
        `${JSON.stringify({ type: 'user', cwd: worktree, sessionId: uuid })}\n`,
      );
      const at = '2026-10-24T10:00:00.000Z';
      const local = join(dir, 'sessions', '4-ab12');

      mkdirSync(local, { recursive: true });
      writeFileSync(
        join(local, 'meta.json'),
        JSON.stringify({
          v: 1,
          id: '4-ab12',
          card: 4,
          title: 'As a visitor I can sign in with email',
          repo: p.checkout,
          worktree,
          branch: BRANCH,
          state: 'ended',
          since: at,
          startedAt: at,
          transcriptPath: join(projects, `${uuid}.jsonl`),
          lastAssistantMessage: null,
          // the session it was started as: after /clear its transcript names another
          claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
          socket: join(local, 'session.sock'),
        }),
      );
    });
    const out = await w.mac.json(SessionMoveData, 'session', 'move-to-cloud', '4-ab12');

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    queued = out.doc.data;
  });
  afterAll(async () => {
    await done(w);
  });

  test('queued, the pack waiting; once the other box is deleted, the clone gets the work and claude resumes the transcript’s session', async () => {
    expect(queued).toMatchObject({ id: '4-ab12', to: 'cloud', box: BOX, state: 'queued' });
    expect(queued.copied).toMatchObject({ files: ['here.md'], transcript: true });
    expect(existsSync(join(w.mac.state.dir, 'moves', '4-ab12.tar'))).toBe(true);
    // The other box runs, so it counts (#57); its deletion makes room.
    w.ec2.set('other-9', 'terminated');
    const shown = await until('the moved session running on its box', async () => {
      const out = await w.mac.json(SessionData, 'session', 'show', '4-ab12');

      return out.doc.ok && !['queued', 'starting'].includes(out.doc.data.state)
        ? out.doc.data
        : undefined;
    });

    expect(shown.box).toBe(BOX);
    const clone = w.standIn.workdir;
    const argv = await until('the box claude resumed', () => {
      const a = z.array(z.string()).safeParse(claudeOutput(clone).argv);

      return a.success && a.data.includes('--resume') ? a.data : undefined;
    });

    expect(sh(clone, 'git rev-parse HEAD').trim()).toBe(localHead);
    expect(sh(clone, 'git symbolic-ref --short HEAD').trim()).toBe(BRANCH);
    expect(readFileSync(join(clone, 'here.md'), 'utf8')).toBe('from the local machine\n');
    expect(
      readFileSync(join(clone, '.scratch', '4', 'sessions', '4-ab12.jsonl'), 'utf8'),
    ).toContain(uuid);
    expect(argv[argv.indexOf('--resume') + 1]).toBe(uuid);
    const home = z.object({ HOME: z.string() }).parse(claudeOutput(clone).env).HOME;
    const file = claudeSessionFile(home, sh(clone, 'pwd -P').trim(), uuid);

    expect(existsSync(file)).toBe(true);
    // its cwd is the clone's now, as the transcript named the worktree before
    expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0] ?? '')).toMatchObject({
      cwd: sh(clone, 'pwd -P').trim(),
    });
    expect(existsSync(join(w.mac.state.dir, 'moves', '4-ab12.tar'))).toBe(false);
  });

  test('stopped, then reopened (#343): it goes on on its box, never moved back nor its pack asked for again', async () => {
    await until('it waits or works', async () => {
      const out = await w.mac.json(SessionData, 'session', 'show', '4-ab12');

      return out.doc.ok && ['waiting', 'working'].includes(out.doc.data.state) ? true : undefined;
    });
    // its claude's own hooks named the transcript on the box
    await until('its transcript named', async () => {
      const out = await w.mac.json(SessionData, 'session', 'show', '4-ab12');

      return out.doc.ok && out.doc.data.transcriptPath !== null ? true : undefined;
    });
    await w.mac.run('session', 'stop', '4-ab12');
    await until('it ended', async () => {
      const out = await w.mac.json(SessionData, 'session', 'show', '4-ab12');

      return out.doc.ok && out.doc.data.state === 'ended' ? true : undefined;
    });
    const opened = await w.mac.json(SessionData, 'session', 'reopen', '4-ab12');

    expect(opened.doc).toMatchObject({ ok: true, data: { id: '4-ab12', box: BOX } });
    const back = await until('it goes on', async () => {
      const out = await w.mac.json(SessionData, 'session', 'show', '4-ab12');

      return out.doc.ok && ['waiting', 'working'].includes(out.doc.data.state)
        ? out.doc.data
        : undefined;
    });

    expect(back).toMatchObject({ box: BOX, reopened: [expect.any(String)] });
    // listed once, in your environment: no local record came back to life
    const listed = await w.mac.json(SessionListData, 'session', 'list');

    expect(
      listed.doc.ok && listed.doc.data.sessions.filter((x) => x.id === '4-ab12').map((x) => x.box),
    ).toEqual([BOX]);
  });
});

describe('Move to cloud that the box cannot take (#189): one line, the box it woke stopped again', () => {
  let w: World;
  let worktree: string;
  let failed: { code: string; message: string };

  beforeAll(async () => {
    w = await world('', (p, dir) => {
      // The card's box asleep: the move wakes it.
      p.ec2.put({ name: BOX, repo: REPO, state: 'stopped' });
      // The clone has the branch with a commit of its own: the moved head cannot go on it.
      sh(
        p.standIn.workdir,
        `git checkout -q -b ${BRANCH} && git commit -q --allow-empty -m "box only" && git checkout -q -`,
      );
      worktree = join(p.root, 'shop-wt', '4-as-a-visitor-i-can');
      sh(p.checkout, `git worktree add -q -b ${BRANCH} ${worktree}`);
      writeFileSync(join(worktree, 'here.md'), 'from the local machine\n');
      const at = '2026-10-24T10:00:00.000Z';
      const local = join(dir, 'sessions', '4-ab12');

      mkdirSync(local, { recursive: true });
      // Its claude never started: no transcript, so the unpack is told no log ('').
      writeFileSync(
        join(local, 'meta.json'),
        JSON.stringify({
          v: 1,
          id: '4-ab12',
          card: 4,
          title: 'As a visitor I can sign in with email',
          repo: p.checkout,
          worktree,
          branch: BRANCH,
          state: 'ended',
          since: at,
          startedAt: at,
          transcriptPath: null,
          lastAssistantMessage: null,
          claudeSession: '0f8c2a3e-1b2c-4d5e-8f90-a1b2c3d4e5f6',
          socket: join(local, 'session.sock'),
        }),
      );
    });
    const out = await w.mac.json(SessionMoveData, 'session', 'move-to-cloud', '4-ab12');

    if (out.doc.ok) throw new Error('the move went through');
    failed = out.doc.error;
  });
  afterAll(async () => {
    await done(w);
  });

  test('refused in one line: what failed, and that the worktree stays as it was', () => {
    expect(failed.code).toBe('branch-diverged');
    expect(failed.message).not.toContain('\n');
    const said = `the box could not take the pack: unpacking into /workspace/repo: ${BRANCH} here has commits the moved head `;

    expect(failed.message.startsWith(said)).toBe(true);
    expect(failed.message.slice(said.length)).toMatch(/^[0-9a-f]{40} has not · /);
    expect(failed.message.endsWith(` · ${worktree} stays as it was`)).toBe(true);
    expect(readFileSync(join(worktree, 'here.md'), 'utf8')).toBe('from the local machine\n');
  });

  test('the box it woke is stopped again, not deleted', async () => {
    await until('the box stopped', () =>
      w.ec2.instance(BOX)?.State === 'stopped' ? true : undefined,
    );
  });

  test('the session is this Mac’s again', async () => {
    const mine = (await listed(w.mac)).filter((x) => x.id === '4-ab12');

    expect(mine.map((x) => x.box ?? null)).toEqual([null]);
  });
});

describe('one move of a session at a time, per serve', () => {
  test('a second move of the same session in the same serve is move-busy; another serve is not held up', async () => {
    const mac = moveLocks();
    const box = moveLocks();
    const held = Promise.withResolvers<undefined>();
    const first = mac.once('4-ab12', async () => {
      await held.promise;

      return { ok: true as const, data: 'moved' };
    });

    expect(
      await mac.once('4-ab12', () => Promise.resolve({ ok: true as const, data: 'again' })),
    ).toMatchObject({
      ok: false,
      error: { code: 'move-busy' },
    });
    expect(
      await box.once('4-ab12', () => Promise.resolve({ ok: true as const, data: 'box' })),
    ).toEqual({
      ok: true,
      data: 'box',
    });
    held.resolve(undefined);
    expect(await first).toEqual({ ok: true, data: 'moved' });
    // once done, the session moves again
    expect(
      await mac.once('4-ab12', () => Promise.resolve({ ok: true as const, data: 'later' })),
    ).toEqual({
      ok: true,
      data: 'later',
    });
  });
});
