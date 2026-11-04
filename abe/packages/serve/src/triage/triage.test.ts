/**
 * `abe triage` on an in-process `serve` (`served`): the fake Azure DevOps for the board, a fake
 * `gh` for the repo's open issues, the fake `claude` answering the one-shot with scripted verdicts
 * (and, for the launched runs, running in a real `tmux`), and a real git checkout whose `origin`
 * is on GitHub. Launching in your environment (the fake EC2) is the real `abe` and its `serve`,
 * which also checks triage's exit codes and `--json` documents through the process.
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
  CardCommentData,
  CardShowData,
  EventLine,
  TRIAGE_SKILL,
  TriageApplyData,
  TriageData,
  TriageLaunchData,
} from '@abe/core';
import { adoBoardFrom, claudeOneShot, ghTrackingFrom } from '@abe/ports';
import {
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  fakeEc2,
  type FakeEc2,
  fakeGh,
  type FakeGh,
  ghIssue,
  oneShotCalls,
  scriptOneShot,
  served,
  type ServedCli,
  tempState,
  tmuxPath,
  watching,
  type Watching,
  installDone,
} from '@abe/testing';
import { z } from 'zod';

// A real serve, tmux and claude per launch: past 5 s on a busy Mac (as box-version's).
setDefaultTimeout(30_000);

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

type Answer = { id: string; verdict: string; reason: string; question?: string };
const verdicts = (...v: Answer[]) => JSON.stringify({ verdicts: v });

const MINE = verdicts(
  { id: 'AB#4', verdict: 'ready', reason: 'the criteria name the error and the header' },
  { id: 'o/shop#12', verdict: 'ready', reason: 'clear steps' },
  { id: 'o/shop#14', verdict: 'not-for-agent', reason: 'a decision for people' },
);
const TEAM = verdicts(
  { id: 'AB#4', verdict: 'too-big', reason: 'sign-in and remember me in one card' },
  { id: 'AB#5', verdict: 'ready', reason: 'one form, clear criteria' },
  { id: 'AB#6', verdict: 'ready', reason: 'one list' },
  { id: 'AB#7', verdict: 'ready', reason: 'one filter' },
  {
    id: 'AB#8',
    verdict: 'needs-info',
    reason: 'no width named',
    question: 'At which screen width should the button move below the logo?',
  },
  { id: 'AB#13', verdict: 'ready', reason: 'one payment method' },
  { id: 'o/shop#12', verdict: 'ready', reason: 'clear steps' },
  { id: 'o/shop#14', verdict: 'not-for-agent', reason: 'a decision for people' },
);
/** After the launch: 5, 6, 7 and 13 run, so only these are asked about. */
const AFTER = verdicts(
  { id: 'AB#4', verdict: 'too-big', reason: 'still two features' },
  {
    id: 'AB#8',
    verdict: 'needs-info',
    reason: 'no width named',
    question: 'At which screen width should the button move below the logo?',
  },
  { id: 'o/shop#12', verdict: 'ready', reason: 'clear steps' },
  { id: 'o/shop#14', verdict: 'not-for-agent', reason: 'a decision for people' },
);

/** After the product owner answered #8 and took its tag off: it may be ready now (#77). */
const ANSWERED = verdicts(
  { id: 'AB#4', verdict: 'too-big', reason: 'still two features' },
  { id: 'AB#8', verdict: 'ready', reason: 'the answer names 600 px' },
  { id: 'o/shop#12', verdict: 'ready', reason: 'clear steps' },
  { id: 'o/shop#14', verdict: 'not-for-agent', reason: 'a decision for people' },
);

type World = {
  root: string;
  repo: string;
  ado: FakeAdo;
  az: FakeAz;
  gh: FakeGh;
  claude: FakeClaude;
  abe: Reads;
};

/** What a test reads through: in process or the real `abe`. */
type Reads = Pick<Cli, 'state' | 'run' | 'json' | 'jsonWith' | 'close'>;

/**
 * `mine`: yours on this Mac; `local`: yours for the shop (`.abe/settings.local.yaml`). `ec2`: their
 * boxes on the fake EC2 (its `aws` on the PATH, the boxes tagged with `ABE_OWNER`), through the
 * real `abe` and its `serve`; without, in process. Commands are typed in the shop.
 */
const world = async (o: { mine?: string; local?: string; ec2?: FakeEc2 } = {}): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-t-'));
  const repo = join(root, 'shop');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();
  const gh = fakeGh([
    [
      'repos/o/shop/issues?state=open',
      {
        json: [
          ghIssue('o/shop', 14, { title: 'Pick a brand colour', labels: ['question'] }),
          { ...ghIssue('o/shop', 13, { title: 'A pull request' }), pull_request: { url: 'x' } },
          ghIssue('o/shop', 12, { title: 'Cart badge shows 0 after a reload', labels: ['bug'] }),
        ],
      },
    ],
  ]);

  for (const dir of ['mine', 'shop/.abe']) mkdirSync(join(root, dir), { recursive: true });
  // The repo lowers the models: the reader's Sonnet is not allowed, so it falls to Haiku.
  writeFileSync(
    join(repo, 'abe.yaml'),
    `board: ${JSON.stringify(ado.board)}\nenvironments: {}\nallowedModels: [opus, haiku]\n`,
  );
  writeFileSync(join(root, 'mine', 'settings.yaml'), o.mine ?? 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# shop\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/shop.git');
  // yours for the shop, never committed
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  writeFileSync(join(repo, '.abe', 'settings.local.yaml'), o.local ?? '');
  const layers = { ABE_CONFIG_DIR: join(root, 'mine') };
  const PATH = [
    claude.dir,
    az.dir,
    gh.dir,
    ...(o.ec2 === undefined ? [] : [o.ec2.dir]),
    '/usr/bin:/bin',
  ].join(':');
  const abe =
    o.ec2 === undefined
      ? await inProcess(layers, { PATH, ...ado.env }, repo)
      : cli({
          env: { PATH, ...layers, ABE_TMUX: tmuxPath(), ABE_OWNER: o.ec2.owner, ...ado.env },
          cwd: repo,
        });

  // the Mac's serve starts a card only where the install is done
  await installDone(abe.state.dir, repo);

  return { root, repo, ado, az, gh, claude, abe };
};

/** A serve in this process, its board, GitHub and one-shot as the real serve wires them. */
const inProcess = async (
  layers: Record<string, string>,
  own: Record<string, string>,
  cwd?: string,
): Promise<ServedCli> => {
  const state = tempState();
  const env = { ...state.env, ...layers, ...own };

  return served({
    state,
    ...(cwd === undefined ? {} : { cwd }),
    env: layers,
    sessions: { env: own },
    board: adoBoardFrom(env, join(state.dir, 'images')),
    tracking: ghTrackingFrom(env),
    oneShot: claudeOneShot(),
  });
};

const done = async (w: World) => {
  await w.abe.close();
  await w.ado.stop();
  w.az.remove();
  w.gh.remove();
  w.claude.remove();
  rmSync(w.root, { recursive: true, force: true });
};

const TriageDone = z.object({
  type: z.literal('triage.done'),
  data: z.record(z.string(), z.unknown()),
});

/** The next `triage.done` event's data a watch reads. */
const nextTriageDone = async (watch: Watching) => {
  for (;;) {
    const event = TriageDone.safeParse(EventLine.parse(JSON.parse(await watch.next(20_000))));

    if (event.success) return event.data.data;
  }
};

const verdictsOf = (t: TriageData) =>
  Object.fromEntries(t.items.map((i) => [i.id, i.verdict] as const));

describe('abe triage on the fake board, gh and claude -p', () => {
  let w: World;
  let watch: Watching;
  const triage = async (...argv: string[]) => {
    const out = await w.abe.jsonWith({ cwd: w.repo }, TriageData, 'triage', ...argv);

    if (!out.doc.ok) throw new Error(`triage refused: ${JSON.stringify(out.doc.error)}`);

    return out.doc.data;
  };
  const comments = async (card: number) => {
    const out = await w.abe.json(CardShowData, 'card', 'show', String(card));

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));

    return out.doc.data;
  };

  beforeAll(async () => {
    w = await world();
    scriptOneShot(w.abe.state.dir, {
      answers: [MINE, TEAM, 'I think they all look fine!', AFTER, ANSWERED],
    });
    watch = watching(w.abe.state.socket);
  });

  afterAll(async () => {
    watch.close();
    await done(w);
  });

  test('Mine this sprint: your cards in the current sprint and the repo’s open issues, one verdict each', async () => {
    const t = await triage();

    expect(t).toMatchObject({
      scope: 'mine',
      sprint: 'Sprint 1',
      repo: 'o/shop',
      model: 'haiku',
      skipped: [],
      counts: { ready: 2, needsInfo: 0, tooBig: 0, notForAgent: 1, skipped: 0 },
    });
    expect(t.items.map((i) => [i.id, i.source, i.title])).toEqual([
      ['AB#4', 'azure', 'As a visitor I can sign in with email'],
      ['o/shop#14', 'github', 'Pick a brand colour'],
      ['o/shop#12', 'github', 'Cart badge shows 0 after a reload'],
    ]);
    expect(t.items[0]).toMatchObject({
      verdict: 'ready',
      reason: 'the criteria name the error and the header',
      question: null,
    });
    expect(await nextTriageDone(watch)).toEqual({
      scope: 'mine',
      items: 3,
      ready: 2,
      needsInfo: 0,
      tooBig: 0,
      notForAgent: 1,
      skipped: 0,
    });
  });

  test('the one-shot: claude -p on the lowered model, no tools, the skill, a clean environment', () => {
    const [call] = oneShotCalls(w.abe.state.dir);

    if (call === undefined) throw new Error('no one-shot');
    expect(call.argv.slice(0, 5)).toEqual(['-p', '--model', 'haiku', '--tools', '']);
    expect(call.argv).toContain('--no-session-persistence');
    expect(call.argv.at(-2)).toBe('--append-system-prompt');
    expect(call.argv.at(-1)).toBe(TRIAGE_SKILL);
    expect(call.cwd).toBe(realpathSync(w.repo));
    expect(call.prompt).toContain('## AB#4\n');
    expect(call.prompt).toContain('## o/shop#12\n');
    expect(call.prompt).not.toContain('A pull request');
    // A session's environment without its socket: nothing of serve's own (no ABE_*, no tokens).
    const names = Object.keys(call.env).filter((n) => n !== '__CF_USER_TEXT_ENCODING');

    expect(names.sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM', 'USER']);
    expect(call.env.HOME).toBe(w.abe.state.dir);
    expect(call.env.PATH?.startsWith(`${join(w.abe.state.dir, 'bin')}:`)).toBe(true);
  });

  test('--team: the whole backlog; nothing is written to the board', async () => {
    const t = await triage('--team');

    expect(t).toMatchObject({ scope: 'team', sprint: null });
    expect(verdictsOf(t)).toEqual({
      'AB#4': 'too-big',
      'AB#5': 'ready',
      'AB#6': 'ready',
      'AB#7': 'ready',
      'AB#8': 'needs-info',
      'AB#13': 'ready',
      'o/shop#12': 'ready',
      'o/shop#14': 'not-for-agent',
    });
    expect(t.items.find((i) => i.id === 'AB#8')?.question).toBe(
      'At which screen width should the button move below the logo?',
    );
    expect(t.counts).toEqual({ ready: 5, needsInfo: 1, tooBig: 1, notForAgent: 1, skipped: 0 });
    expect(await nextTriageDone(watch)).toMatchObject({ scope: 'team', items: 8, ready: 5 });
    // Only reads: no comment posted, no card patched.
    expect(
      w.ado.requests().filter((r) => r.startsWith('PATCH') || r.includes('/comments')),
    ).toEqual([]);
  });

  test('a malformed answer is triage-unreadable, its text kept; the last triage stands', async () => {
    const out = await w.abe.jsonWith({ cwd: w.repo }, TriageData, 'triage', '--team');

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'triage-unreadable' } });
    if (out.doc.ok) throw new Error('not refused');
    const kept = /kept as it came in (\S+\.txt)$/.exec(out.doc.error.message)?.[1] ?? '';

    expect(kept.startsWith(join(w.abe.state.dir, 'triage', 'unreadable-'))).toBe(true);
    expect(readFileSync(kept, 'utf8')).toBe('I think they all look fine!\n');
  });

  test('apply: the needs-info card gets one comment and the tag; again, nothing new', async () => {
    const first = await w.abe.json(TriageApplyData, 'triage', 'apply', '8', 'AB#5', 'o/shop#14');

    expect(first.exit).toBe(0);
    expect(first.doc).toMatchObject({
      ok: true,
      data: {
        items: [
          { id: 'AB#8', result: 'asked', tagged: true, code: null },
          { id: 'AB#5', result: 'refused', code: 'not-needs-info', comment: null },
          { id: 'o/shop#14', result: 'refused', code: 'not-a-card' },
        ],
      },
    });
    const again = await w.abe.json(TriageApplyData, 'triage', 'apply', 'AB#8');

    expect(again.doc).toMatchObject({
      ok: true,
      data: { items: [{ id: 'AB#8', result: 'already-asked', comment: null, tagged: true }] },
    });
    const card = await comments(8);
    const triaged = card.comments.filter((c) => c.text.includes('generated by AI during triage'));

    expect(triaged).toHaveLength(1);
    expect(triaged[0]?.text).toContain(
      'At which screen width should the button move below the logo?',
    );
    expect(card.tags).toContain('needs-info');
    expect(
      w.ado.requests().filter((r) => r.startsWith('POST') && r.includes('/8/comments')),
    ).toHaveLength(1);
  });

  test('launch on this Mac: one run each, past the box limit too (a local session holds no box); only ready cards', async () => {
    const out = await w.abe.json(
      TriageLaunchData,
      'triage',
      'launch',
      '5',
      'AB#7',
      '13',
      '6',
      '8',
      'o/shop#12',
    );

    expect(out.exit).toBe(0);
    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    const l = out.doc.data;

    // on this Mac no box is held: its text names none (#187)
    expect({ limit: l.limit, inUse: l.inUse, local: l.local }).toEqual({
      limit: 3,
      inUse: 0,
      local: true,
    });
    expect(l.items.map((i) => [i.id, i.result, i.code])).toEqual([
      ['AB#5', 'started', null],
      ['AB#7', 'started', null],
      ['AB#13', 'started', null],
      ['AB#6', 'started', null],
      ['AB#8', 'refused', 'not-ready'],
      ['o/shop#12', 'refused', 'not-a-card'],
    ]);
    const sessions = l.items.flatMap((i) => (i.session === null ? [] : [i.session]));

    expect(sessions.map((s) => s.split('-')[0])).toEqual(['5', '7', '13', '6']);
    for (const s of sessions)
      expect(existsSync(join(w.abe.state.dir, 'sessions', s, 'run.json'))).toBe(true);
  });

  test('launching a running card again is refused', async () => {
    const out = await w.abe.json(TriageLaunchData, 'triage', 'launch', '5');

    expect(out.doc).toMatchObject({
      ok: true,
      data: { inUse: 0, items: [{ id: 'AB#5', result: 'refused', code: 'running' }] },
    });
  });

  test('a triage after the launch skips the running cards', async () => {
    const t = await triage('--team');

    expect(t.skipped.map((s) => [s.id, s.why]).sort()).toEqual([
      ['AB#13', 'running'],
      ['AB#5', 'running'],
      ['AB#6', 'running'],
      ['AB#7', 'running'],
    ]);
    expect(t.items.map((i) => i.id).sort()).toEqual(['AB#4', 'AB#8', 'o/shop#12', 'o/shop#14']);
    expect(t.counts.skipped).toBe(4);
    const last = oneShotCalls(w.abe.state.dir).at(-1);

    expect(last?.prompt).not.toContain('## AB#5\n');
  });

  test('answered and its tag taken off, the next triage reads the answer and may call it ready', async () => {
    const answer = await w.abe.json(
      CardCommentData,
      'card',
      'comment',
      '8',
      '--text',
      'Below 600 px it moves under the logo.',
    );

    expect(answer.exit).toBe(0);
    expect((await w.abe.run('card', 'tag', '8', '--remove', 'needs-info')).exit).toBe(0);
    const t = await triage('--team');

    expect(verdictsOf(t)['AB#8']).toBe('ready');
    const prompt = oneShotCalls(w.abe.state.dir).at(-1)?.prompt ?? '';
    const of8 = prompt.slice(prompt.indexOf('## AB#8\n'), prompt.indexOf('## o/shop#'));

    expect(of8).toContain('### Since triage asked');
    expect(of8).toContain('At which screen width should the button move below the logo?');
    expect(of8).toContain(': Below 600 px it moves under the logo.');
    expect(prompt.slice(0, prompt.indexOf('## AB#8\n'))).not.toContain('Since triage asked');
    // ready now: launched, not refused not-ready
    const launch = await w.abe.json(TriageLaunchData, 'triage', 'launch', '8');

    expect(launch.doc).toMatchObject({
      ok: true,
      data: { items: [{ id: 'AB#8', result: 'started' }] },
    });
  });
});

describe('triage launch in your environment: placed as any launch, running and starting boxes counted', () => {
  test('two boxes running at a limit of 2 (an asleep one not counted): the ready card is Queued, no box made', async () => {
    const ec2 = fakeEc2({ owner: 'octocat' });

    ec2.put({ name: 'shop-9', repo: 'o/shop', card: 9 });
    ec2.put({ name: 'shop-10', repo: 'o/shop', card: 10, state: 'pending' });
    ec2.put({ name: 'shop-11', repo: 'o/shop', card: 11, state: 'stopped' });
    const w = await world({
      mine: 'serve.target: cloud\n',
      local: 'limits.maxBoxesPerPerson: 2\n',
      ec2,
    });

    try {
      scriptOneShot(w.abe.state.dir, { answers: [TEAM] });
      const triaged = await w.abe.jsonWith({ cwd: w.repo }, TriageData, 'triage', '--team');

      expect(triaged.exit).toBe(0);
      expect(triaged.doc.ok).toBe(true);
      const out = await w.abe.json(TriageLaunchData, 'triage', 'launch', '5');

      expect(out.exit).toBe(0);
      expect(out.doc).toMatchObject({
        ok: true,
        data: {
          limit: 2,
          inUse: 2,
          local: false,
          items: [
            { id: 'AB#5', result: 'queued', code: null, message: 'Queued: 2 of 2 boxes in use' },
          ],
        },
      });
      const queued = out.doc.ok ? out.doc.data.items[0]?.session : null;

      expect(queued?.split('-')[0]).toBe('5');
      expect(ec2.calls().filter((c) => c.startsWith('ec2 run-instances'))).toEqual([]);
      expect(existsSync(join(w.abe.state.dir, 'sessions'))).toBe(false);
    } finally {
      await done(w);
      ec2.remove();
    }
  });
});

describe('abe triage refusals', () => {
  let abe: ServedCli;
  let claude: FakeClaude;
  let root: string;

  beforeAll(async () => {
    claude = fakeClaude();
    root = mkdtempSync(join(tmpdir(), 'abe-tr-'));
    mkdirSync(join(root, 'mine'));
    writeFileSync(join(root, 'mine', 'settings.yaml'), '');
    abe = await inProcess(
      { ABE_CONFIG_DIR: join(root, 'mine') },
      { PATH: `${claude.dir}:/usr/bin:/bin` },
    );
  });

  afterAll(async () => {
    await abe.close();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test('apply and launch before any triage: no-triage', async () => {
    const out = await abe.json(TriageApplyData, 'triage', 'apply', '4');

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-triage' } });
    const launch = await abe.json(TriageLaunchData, 'triage', 'launch', '4');

    expect(launch.doc).toMatchObject({ ok: false, error: { code: 'no-triage' } });
  });

  test('triage without a board: no-board, and no one-shot', async () => {
    const out = await abe.json(TriageData, 'triage');

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-board' } });
    expect(oneShotCalls(abe.state.dir)).toEqual([]);
  });
});
