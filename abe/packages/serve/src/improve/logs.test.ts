/**
 * `abe log` on a real `serve` in this process (its requests as the client sends them): a fake
 * `claude` session (real `tmux`) whose transcript and hooks carry one secret of each kind, the
 * card's checks output and reports planted in its worktree, shipped to a `file://` log store: on
 * its own (every interval, and at the end) and by `abe log ship`. Only a store `ABE_LOG_STORE`
 * names wrong goes through the real `abe`, whose app reads it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogListData, LogShipData, readEnvelope, type Reply, SessionData } from '@abe/core';
import {
  adoBoardFrom,
  awsFrom,
  boxTracking,
  fileLogStore,
  ghTrackingFrom,
  logStoreFrom,
} from '@abe/ports';
import {
  card,
  cli,
  fakeAdo,
  type FakeAdo,
  fakeAws,
  type FakeAws,
  fakeAz,
  type FakeAz,
  fakeBoard,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  ghUser,
  heldEvents,
  refusingTracking,
  scenario,
  type ScenarioOptions,
  scriptClaude,
  secretText,
  served,
  type ServedCli,
  tempState,
  tmuxPath,
  until,
} from '@abe/testing';
import { z } from 'zod';

const READ_URL = 'postgres://reader:r3ad@test-db:5432/shop';
/** The local workspace's database serve hands its sessions; its password is used bare below. */
const WORKSPACE_PASS = 'w0rksp4ce';
const WORKSPACE_DB = `postgres://shop:${WORKSPACE_PASS}@127.0.0.1:5432/shop`;

// One secret of each kind, built from fragments: no scanner takes this file for a real one.
const X = (n: number) => 'x'.repeat(n);
const SECRETS = {
  abe: READ_URL,
  'aws-access-key': `AKIA${'Q'.repeat(16)}`,
  'aws-secret-key': `${'wJalr'.repeat(4)}${'K7MDENG'.repeat(2)}bPxRfi`,
  'github-token': `ghp_${X(36)}`,
  'github-pat': `github_pat_${'1'.repeat(22)}_${X(59)}`,
  'claude-token': `sk-ant-oat01-${X(40)}`,
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NSJ9', 's'.repeat(43)].join('.'),
  'private-key': `MIIEow${'IBAAKCAQEA'.repeat(3)}`,
  'db-password': `p4ss${X(8)}`,
  'aws-temporary-key': `ASIA${'Z'.repeat(16)}`,
  'aws-bare-secret': `${'Tq9'.repeat(13)}z`,
  'aws-session-token': `IQoJb3JpZ2luX2Vj${'A'.repeat(100)}`,
  workspace: WORKSPACE_DB,
  'workspace-password': WORKSPACE_PASS,
} as const;
const PEM = [
  ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
  SECRETS['private-key'],
  ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' '),
].join('\n');

/** Text carrying every secret, as a tool's output or an answer would. */
const leaky = (where: string) =>
  [
    `${where}: psql ${READ_URL}`,
    `aws_access_key_id = ${SECRETS['aws-access-key']}`,
    `aws_secret_access_key = ${SECRETS['aws-secret-key']}`,
    `CREDENTIALS\t${SECRETS['aws-temporary-key']}\t2026-10-23T10:00:00Z\t${SECRETS['aws-bare-secret']}\t${SECRETS['aws-session-token']}`,
    `GH_TOKEN=${SECRETS['github-token']} GITHUB_PAT=${SECRETS['github-pat']}`,
    `ANTHROPIC_API_KEY=${SECRETS['claude-token']}`,
    `Authorization: Bearer ${SECRETS.jwt}`,
    PEM,
    `DATABASE_URL=mysql://app:${SECRETS['db-password']}@db.internal:3306/shop`,
    `echo $DATABASE_URL → ${WORKSPACE_DB}`,
    `PGPASSWORD=${WORKSPACE_PASS} psql -h 127.0.0.1 shop`,
  ].join('\n');

const MARKS = [
  '[redacted:ABE_DB_READ_URL_TEST]',
  '[redacted:aws-access-key]',
  '[redacted:aws-secret-key]',
  '[redacted:aws-session-token]',
  '[redacted:github-token]',
  '[redacted:claude-token]',
  '[redacted:jwt]',
  '[redacted:private-key]',
  '[redacted:db-password]',
  '[redacted:DATABASE_URL]',
];

/** The repo's settings after its board: its environments. */
const REPO_SETTINGS = [
  'environments:',
  '  test:',
  '    account: "111111111111"',
  '    region: eu-west-1',
  '    db:',
  '      read: { secret: abe/test/db-read }',
  '',
].join('\n');

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

type World = {
  root: string;
  repo: string;
  store: string;
  ado: FakeAdo;
  az: FakeAz;
  aws: FakeAws;
  gh: FakeGh;
  claude: FakeClaude;
  abe: ServedCli;
};

/** `every`: how often serve ships a running session; `env`: more of serve's own; `profiles`: other profiles' AWS. */
const world = async (
  every: number,
  env: Record<string, string> = {},
  profiles: Pick<ScenarioOptions, 'awsAs' | 'boxProfile'> = {},
): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-log-'));
  const repo = join(root, 'demo');
  const store = join(root, 'store');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const aws = fakeAws([['--secret-id abe/test/db-read ', secretText(READ_URL)]]);
  const gh = fakeGh([['api user', { json: ghUser('octocat') }]]);
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
  // Launches in this world run on this machine: the tests drive a fake claude here.
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\n${REPO_SETTINGS}`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // its GitHub repo names the logs' folder in the store
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/demo.git');
  // yours for the repo, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
  const state = tempState();
  const layers = { ABE_CONFIG_DIR: join(root, 'mine') };
  // serve's environment as the app's: the tools on its PATH, its HOME the state's.
  const own = {
    ...state.env,
    PATH: `${claude.dir}:${gh.dir}:${az.dir}:${aws.dir}:/usr/bin:/bin`,
    ...layers,
    ...ado.env,
  };
  const logs = logStoreFrom({ ABE_LOG_STORE: `file://${store}` });

  if (logs === undefined) throw new Error('no log store');
  // The Mac's ports, from that environment as the app builds them: the board on the fake Azure
  // DevOps, GitHub through the fake gh (whose login names the folder), AWS through the fake aws.
  const abe = await served({
    state,
    env: layers,
    board: adoBoardFrom(own, join(state.dir, 'images')),
    tracking: ghTrackingFrom(own),
    ...awsFrom(own),
    logs: { store: logs, every },
    sessions: { env: { ...own, ABE_TMUX: tmuxPath(), ...env } },
    ...profiles,
  });

  return { root, repo, store, ado, az, aws, gh, claude, abe };
};

const done = async (w: World) => {
  await w.abe.close();
  await w.ado.stop();
  for (const tool of [w.az, w.aws, w.gh, w.claude]) tool.remove();
  rmSync(w.root, { recursive: true, force: true });
};

/** Every file in the store: key → text. */
const stored = (store: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(store, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const path = join(d.parentPath, d.name);

        return [path.slice(store.length + 1), readFileSync(path, 'utf8')];
      }),
  );

const Shipped = z.object({
  type: z.literal('log.shipped'),
  data: z.object({ session: z.string(), reason: z.string(), files: z.number() }),
});

/** How far `shipped` has read each serve's events, as a watch reads them one after another. */
const readTo = new Map<string, number>();

/** The next `log.shipped` of `id` for `reason` after the last one read, once serve holds it. */
const shipped = async (abe: ServedCli, id: string, reason: string) => {
  const after = readTo.get(abe.state.socket) ?? 0;
  const [seq, data] = await until(
    () => `${id} shipped (${reason})`,
    async () =>
      (await heldEvents(abe.state.socket))
        .filter((line) => line.seq > after)
        .map((line) => [line.seq, Shipped.safeParse(line).data?.data] as const)
        .find(([, d]) => d?.session === id && d.reason === reason),
  );

  readTo.set(abe.state.socket, seq);

  return data;
};

describe("a session's logs, redacted, in the log store", () => {
  let w: World;
  let s: SessionData;

  beforeAll(async () => {
    // Five minutes in a test is 400 ms.
    w = await world(400, { DATABASE_URL: WORKSPACE_DB });
    scriptClaude(w.abe.state.dir, [
      {
        hook: 'PostToolUse',
        payload: { tool_response: { stdout: leaky('hook'), stderr: '', interrupted: false } },
      },
      { say: leaky('answer') },
    ]);
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    s = out.doc.data;
    await until('waiting', async () => {
      const shown = await w.abe.json(SessionData, 'session', 'show', s.id);

      return shown.doc.ok && shown.doc.data.state === 'waiting' ? true : undefined;
    });
    // What #46 and #47 write in the worktree, planted.
    const scratch = join(s.worktree, '.scratch', '4');

    mkdirSync(join(scratch, 'review'), { recursive: true });
    mkdirSync(join(scratch, 'verify'), { recursive: true });
    writeFileSync(join(scratch, 'checks.md'), `# Checks\n\n\`\`\`\n${leaky('checks')}\n\`\`\`\n`);
    writeFileSync(join(scratch, 'review', 'round-1.md'), '# Review\n\nNo findings.\n');
    writeFileSync(join(scratch, 'verify', 'report.md'), `# Verify\n\n${leaky('verify')}\n`);
    writeFileSync(join(scratch, 'verify', 'shot.png'), new Uint8Array([0x89, 0x50, 0xff, 0xfe]));
  });
  afterAll(async () => {
    await done(w);
  });

  test('abe log ship: every file under <repo>/<login>/<session>/, no secret value left', async () => {
    const out = await w.abe.json(LogShipData, 'log', 'ship', s.id);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    const prefix = `o_demo/octocat/${s.id}/`;

    expect(out.doc.data).toMatchObject({
      session: s.id,
      card: 4,
      prefix,
      reason: 'now',
      // A screenshot cannot be redacted, so it stays.
      skipped: [{ name: 'verify/shot.png', why: 'not UTF-8 text' }],
    });
    expect(out.doc.data.files.map((f) => f.name)).toEqual([
      'meta.json',
      'hooks.jsonl',
      'transcript.jsonl',
      'checks.md',
      'review/round-1.md',
      'verify/report.md',
    ]);
    const files = stored(w.store);

    expect(Object.keys(files).sort()).toEqual(
      out.doc.data.files.map((f) => `${prefix}${f.name}`).sort(),
    );
    const all = Object.values(files).join('\n');

    for (const secret of Object.values(SECRETS)) expect(all).not.toContain(secret);
    for (const file of ['hooks.jsonl', 'transcript.jsonl', 'checks.md', 'verify/report.md'])
      for (const mark of MARKS) expect(files[`${prefix}${file}`]).toContain(mark);
    // The JSON lines are still JSON lines; meta.json still one document.
    for (const file of ['hooks.jsonl', 'transcript.jsonl'])
      for (const line of (files[`${prefix}${file}`] ?? '').split('\n').filter((l) => l !== ''))
        expect(() => z.unknown().parse(JSON.parse(line))).not.toThrow();
    expect(JSON.parse(files[`${prefix}meta.json`] ?? '')).toMatchObject({ id: s.id, card: 4 });
    expect(await shipped(w.abe, s.id, 'now')).toMatchObject({ files: 6 });
  });

  test('serve ships a running session on its own, every interval', async () => {
    expect(await shipped(w.abe, s.id, 'interval')).toMatchObject({ files: 6 });
  });

  test('shipping again replaces each object with the whole file', async () => {
    await w.abe.run('session', 'send', s.id, 'hello');
    await until('the answer in the transcript', async () => {
      const shown = await w.abe.json(SessionData, 'session', 'show', s.id);

      return shown.doc.ok && shown.doc.data.lastAssistantMessage === 'You said: hello'
        ? true
        : undefined;
    });
    const out = await w.abe.json(LogShipData, 'log', 'ship', s.id);

    expect(out.doc.ok).toBe(true);
    const transcript = stored(w.store)[`o_demo/octocat/${s.id}/transcript.jsonl`] ?? '';
    const lines = transcript.split('\n').filter((l) => l !== '');

    // The first turn (redacted) and the second, whole, in one object.
    expect(lines.length).toBe(4);
    expect(transcript).toContain('[redacted:github-token]');
    expect(transcript).toContain('You said: hello');
  });

  test('abe log list: the sessions in the store, by repo and user', async () => {
    const row = {
      repo: 'o_demo',
      user: 'octocat',
      session: s.id,
      files: [
        'checks.md',
        'hooks.jsonl',
        'meta.json',
        'review/round-1.md',
        'transcript.jsonl',
        'verify/report.md',
      ],
    };
    const all = await w.abe.json(LogListData, 'log', 'list');

    expect(all.doc).toMatchObject({ ok: true, data: { sessions: [row] } });
    const mine = await w.abe.json(
      LogListData,
      'log',
      'list',
      '--repo',
      'o/demo',
      '--user',
      'octocat',
    );

    expect(mine.doc).toMatchObject({ ok: true, data: { sessions: [row] } });
    for (const filter of [
      ['--repo', 'o/api'],
      ['--user', 'hubot'],
    ]) {
      const none = await w.abe.json(LogListData, 'log', 'list', ...filter);

      expect(none.doc).toEqual({ ok: true, data: { sessions: [] } });
    }
  });

  test('once more when it ends: its last state in the store', async () => {
    await w.abe.run('session', 'send', s.id, '/exit');
    expect(await shipped(w.abe, s.id, 'end')).toMatchObject({ files: 6 });
    const meta = z
      .object({ state: z.string() })
      .parse(JSON.parse(stored(w.store)[`o_demo/octocat/${s.id}/meta.json`] ?? ''));

    expect(meta.state).toBe('ended');
  });

  test('an id no session has: no-session', async () => {
    const out = await w.abe.json(LogShipData, 'log', 'ship', '9-ffff');

    expect([out.exit, out.doc]).toEqual([
      1,
      { ok: false, error: { code: 'no-session', message: 'no session 9-ffff' } },
    ]);
  });
});

const Failed = z.object({
  type: z.literal('log.failed'),
  data: z.object({ session: z.string(), reason: z.string(), code: z.string() }),
});

describe("a session's Reach, to redact, on the AWS of its checkout's box.profile (ADR 0025)", () => {
  const work = fakeAws([['--secret-id abe/test/db-read ', secretText(READ_URL)]]);
  let w: World;
  let s: SessionData;

  beforeAll(async () => {
    w = await world(
      60_000,
      {},
      {
        boxProfile: { own: null, pinned: false },
        awsAs: (profile) => ({
          ...awsFrom({ PATH: `${work.dir}:/usr/bin:/bin`, AWS_PROFILE: profile }),
          reach: () => ({ profile, region: null }),
        }),
      },
    );
    writeFileSync(join(w.repo, '.abe', 'settings.local.yaml'), 'box.profile: abe-work\n');
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    s = out.doc.data;
  });
  afterAll(async () => {
    await done(w);
    work.remove();
  });

  test("abe log ship reads its secrets on that profile, never on serve's own", async () => {
    const [mine, theirs] = [w.aws.calls().length, work.calls().length];
    const out = await w.abe.json(LogShipData, 'log', 'ship', s.id);
    const read = (calls: { argv: string[] }[]) =>
      calls.filter((c) => c.argv.includes('get-secret-value'));

    expect(out.doc.ok).toBe(true);
    expect(read(work.calls().slice(theirs)).length).toBeGreaterThan(0);
    expect(read(w.aws.calls().slice(mine))).toEqual([]);
  });
});

describe('what a session cannot ship, and a store that fails', () => {
  let w: World;
  let s: SessionData;

  beforeAll(async () => {
    w = await world(300);
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    s = out.doc.data;
    await until('waiting', async () => {
      const shown = await w.abe.json(SessionData, 'session', 'show', s.id);

      return shown.doc.ok && shown.doc.data.state === 'waiting' ? true : undefined;
    });
  });
  afterAll(async () => {
    chmodSync(join(w.store, 'o_demo', 'octocat', s.id), 0o700);
    await done(w);
  });

  test('a link out of the worktree is not followed: skipped, its file never read', async () => {
    const netrc = join(w.root, 'netrc');

    writeFileSync(netrc, `machine example.test password hunter2-${X(8)}\n`);
    mkdirSync(join(s.worktree, '.scratch', '4'), { recursive: true });
    symlinkSync(netrc, join(s.worktree, '.scratch', '4', 'checks.md'));
    const out = await w.abe.json(LogShipData, 'log', 'ship', s.id);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    expect(out.doc.data.skipped).toEqual([{ name: 'checks.md', why: 'a link' }]);
    expect(out.doc.data.files.map((f) => f.name)).toEqual([
      'meta.json',
      'hooks.jsonl',
      'transcript.jsonl',
    ]);
    expect(Object.values(stored(w.store)).join('\n')).not.toContain('hunter2');
  });

  test('a store that cannot be written: log.failed on its own, refused on ship', async () => {
    chmodSync(join(w.store, 'o_demo', 'octocat', s.id), 0o500);
    const failed = await until('log.failed', async () =>
      (await heldEvents(w.abe.state.socket))
        .map((line) => Failed.safeParse(line).data?.data)
        .find((d) => d?.session === s.id),
    );

    expect(failed).toMatchObject({ reason: 'interval', code: 'store-failed' });
    const out = await w.abe.json(LogShipData, 'log', 'ship', s.id);

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'store-failed' } });
  });
});

describe("on a box the logs are its owner's: <repo>/$ABE_OWNER/<session>/, never gh's login", () => {
  const read = <T extends z.ZodType>(schema: T, reply: Reply) =>
    readEnvelope(schema, JSON.parse(reply.stdout));

  /** A serve in this process with a box's Tracking: its owner from `env`, its gh refusing every call. */
  const box = async (env: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'abe-lb-'));
    const repo = join(root, 'demo');
    const store = join(root, 'store');
    const claude = fakeClaude();

    for (const dir of ['mine', 'demo/.abe', 'store'])
      mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.scratch/\n.abe/settings.local.yaml\n');
    writeFileSync(
      join(repo, 'abe.yaml'),
      'board: { organization: "https://dev.azure.com/demo-org", project: Shop, team: Web }\nenvironments: {}\n',
    );
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/demo.git');
    const s = await scenario({
      tracking: boxTracking({ ABE_BOX: '1', ...env }, refusingTracking()),
      board: fakeBoard([card(4, 'Sign in with email')]),
      logs: { store: fileLogStore(store), every: 3_600_000 },
      sessions: {
        env: {
          PATH: `${claude.dir}:/usr/bin:/bin`,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
    const launched = read(
      SessionData,
      await s.request('session', 'launch', '--card', '4', '--repo', repo, '--json'),
    );

    if (!launched.ok) throw new Error(JSON.stringify(launched.error));
    const close = async () => {
      await s.close();
      claude.remove();
      rmSync(root, { recursive: true, force: true });
    };

    return { s, store, id: launched.data.id, close };
  };

  test('abe log ship: under o_demo/ada/<session>/', async () => {
    const b = await box({ ABE_OWNER: 'ada' });

    try {
      const out = read(LogShipData, await b.s.request('log', 'ship', b.id, '--json'));

      if (!out.ok) throw new Error(JSON.stringify(out.error));
      expect(out.data.prefix).toBe(`o_demo/ada/${b.id}/`);
      expect(Object.keys(stored(b.store)).every((k) => k.startsWith(`o_demo/ada/${b.id}/`))).toBe(
        true,
      );
    } finally {
      await b.close();
    }
  });

  test('a box not told its owner: no-login naming ABE_OWNER, nothing stored', async () => {
    const b = await box({});

    try {
      expect(read(LogShipData, await b.s.request('log', 'ship', b.id, '--json'))).toEqual({
        ok: false,
        error: {
          code: 'no-login',
          message:
            'your GitHub login, for the log store: this box was not told whose it is (ABE_OWNER, from its abe:owner tag)',
        },
      });
      expect(stored(b.store)).toEqual({});
    } finally {
      await b.close();
    }
  });
});

describe("local mode (#24): a session's logs stay on this Mac, never shipped", () => {
  let w: World;

  beforeAll(async () => {
    w = await world(3_600_000);
    const on = await w.abe.scenario.requestIn(w.repo, 'local', 'on', '--json');

    if (on.exit !== 0) throw new Error(on.stdout);
  });
  afterAll(async () => {
    await done(w);
  });

  test('abe log ship: under <state>/local/logs/, the log store untouched', async () => {
    scriptClaude(w.abe.state.dir, [{ say: 'hi' }]);
    const out = await w.abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    const s = out.doc.data;
    const ship = await w.abe.json(LogShipData, 'log', 'ship', s.id);

    if (!ship.doc.ok) throw new Error(JSON.stringify(ship.doc.error));
    const here = stored(join(w.abe.state.dir, 'local', 'logs'));

    expect(Object.keys(here)).toContain(`o_demo/octocat/${s.id}/meta.json`);
    expect(existsSync(w.store) ? stored(w.store) : {}).toEqual({});
  });
});

describe('without a log store', () => {
  let abe: ServedCli;

  beforeAll(async () => {
    abe = await served();
  });
  afterAll(() => abe.close());

  test('abe log ship and list are refused: no-log-store', async () => {
    for (const argv of [
      ['log', 'ship', '4-a1b2'],
      ['log', 'list'],
    ]) {
      const out = await abe.json(z.unknown(), ...argv);

      expect(out.exit).toBe(1);
      expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-log-store' } });
      expect(JSON.stringify(out.doc)).toContain('abe settings set stores.logs file://');
    }
  });

  // The app reads $ABE_LOG_STORE: the real `abe`.
  test('a store that is neither file:// nor s3:// is refused, naming it', async () => {
    const other = cli({ env: { ABE_LOG_STORE: 'gs://abe-logs' } });

    try {
      const out = await other.json(LogListData, 'log', 'list');

      expect(out.doc).toMatchObject({ ok: false, error: { code: 'bad-log-store' } });
    } finally {
      await other.close();
    }
  });
});
