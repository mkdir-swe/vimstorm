/**
 * Local mode (#24) in a real `serve`: the fake `claude` in a real `tmux`, the fake `gh` (any call
 * is a write or read GitHub would see), an in-memory board and real git with a bare remote. A
 * card's whole run (decide, build, checks, review, pr, merge) with local mode on calls no writing
 * port: each write is held, the pull request is a local one, a person merges it into the local
 * main and the card is Done.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BoardDiscardData,
  BoardReadOnlyData,
  CardData,
  CardListData,
  CardShowData,
  FactoryRunData,
  FactoryStatusData,
  LOCAL_MODE_ENV,
  LocalModeView,
  LocalPrData,
  LocalSetData,
  localNumber,
  newInstall,
  NOT_COMMENTED,
  ReadFindings,
  type Reply,
  SessionData,
  SheetAttachData,
  SheetSaveData,
} from '@abe/core';
import { fileInstallStore, fileOrgStore, ghTrackingFrom } from '@abe/ports';
import {
  card,
  claudeOutput,
  fakeBoard,
  type FakeBoard,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  heldEvents,
  scenario,
  scriptClaude,
  type ServeScenario,
  until,
} from '@abe/testing';
import { z } from 'zod';

const REPO = 'acme/demo';
const ORIGIN = `https://github.com/${REPO}.git`;
const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { ...GIT_ENV, HOME: cwd } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

const BOARD = { organization: 'https://dev.azure.com/demo-org', project: 'Shop', team: 'Web' };
/** The repo's `abe.yaml`: its board and checks. */
const REPO_SETTINGS = `board: ${JSON.stringify(BOARD)}\nenvironments: {}\nchecks:\n  - name: tests\n    run: "true"\n`;
const GOOD = [
  'Sign in with email.',
  '',
  '**Verified:** signed in on a local run (After).',
  '',
  '## Notes',
  '',
  '- The session cookie is now SameSite=Lax.',
  '',
].join('\n');

/** A session's own outward command in local mode, and the deny rule that refuses it. */
const SESSION_REFUSED: [string, string][] = [
  ['git push origin card/8', 'Bash(git push:*)'],
  ['git -C . push', 'Bash(git * push *)'],
  ['gh pr create', 'Bash(gh pr create:*)'],
  ['gh pr comment', 'Bash(gh pr comment:*)'],
  ['gh pr merge', 'Bash(gh pr merge:*)'],
  ['gh issue create', 'Bash(gh issue create:*)'],
  ['gh issue comment', 'Bash(gh issue comment:*)'],
  ['gh issue edit --add-label', 'Bash(gh issue edit:*)'],
  ['gh label create', 'Bash(gh label create:*)'],
  ['gh api -X POST', 'Bash(gh api -X:*)'],
  ['gh api repos/x/issues -f title=t', 'Bash(gh api * -f *)'],
  ['gh workflow run', 'Bash(gh workflow run:*)'],
  ['az boards work-item update', 'Bash(az boards work-item update:*)'],
  ['az boards work-item create', 'Bash(az boards work-item create:*)'],
  ['az repos pr create', 'Bash(az repos pr create:*)'],
];

const doc = <T extends z.ZodType>(schema: T, reply: Reply) =>
  z
    .union([
      z.object({ ok: z.literal(true), data: schema }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ])
    .parse(JSON.parse(reply.stdout));

const readUntil = async <T>(what: string, read: () => Promise<T>, ok: (t: T) => boolean) => {
  let last: T | undefined;

  return until(
    () => `${what}: still ${JSON.stringify(last)}`,
    async () => {
      last = await read();

      return ok(last) ? last : undefined;
    },
    { ms: 15_000, every: 25 },
  );
};

describe('local mode', () => {
  let root: string;
  let remote: string;
  let repo: string;
  let gh: FakeGh;
  let board: FakeBoard;
  let claude: FakeClaude;
  let s: ServeScenario;
  let org: string;

  const runOf = async (id: number) => {
    const read = doc(FactoryStatusData, await s.request('factory', 'status', String(id), '--json'));

    if (!read.ok) throw new Error(JSON.stringify(read.error));

    return read.data.runs[0];
  };
  /**
   * What reached GitHub: nothing but who you are, read for the session logs kept here
   * (`<state>/local/logs/<repo>/<login>/`).
   */
  const sent = () => gh.calls().filter((c) => c.argv.join(' ') !== 'api user');
  const status = async () => {
    const read = doc(LocalModeView, await s.requestIn(repo, 'local', 'status', '--json'));

    if (!read.ok) throw new Error(JSON.stringify(read.error));

    return read.data;
  };

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-local-')));
    remote = join(root, 'remote.git');
    repo = join(root, 'demo');
    mkdirSync(join(root, 'mine'), { recursive: true });
    // serve.target cloud: local mode keeps the run on this Mac all the same.
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: cloud\n');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'init', '-q', '-b', 'main', repo);
    mkdirSync(join(repo, '.abe'));
    // yours for the repo is never committed
    writeFileSync(join(repo, '.gitignore'), '.fake-claude/\n.scratch/\n.abe/settings.local.yaml\n');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    writeFileSync(join(repo, 'abe.yaml'), REPO_SETTINGS);
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'remote', 'add', 'origin', ORIGIN);
    git(repo, 'config', `url.${remote}.insteadOf`, ORIGIN);
    git(repo, 'push', '-q', 'origin', 'main');
    gh = fakeGh();
    claude = fakeClaude();
    board = fakeBoard([card(7, 'Sign in with email'), card(8, 'Sign out')]);
    org = join(root, 'org-store');
    mkdirSync(org);
    s = await scenario({
      org: fileOrgStore(org),
      tracking: ghTrackingFrom({ PATH: gh.path }),
      board,
      factoryPollMs: 20,
      cwd: repo,
      sessions: {
        env: {
          ...GIT_ENV,
          PATH: claude.path,
          ABE_CONFIG_DIR: join(root, 'mine'),
        },
      },
    });
  }, 30_000);
  afterAll(async () => {
    await s.close();
    gh.remove();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test('the setting: yours, per checkout, and off by default', async () => {
    expect(await status()).toEqual({
      checkout: repo,
      on: false,
      readOnlyBoard: false,
      held: [],
      prs: [],
      cards: [],
    });
    const on = doc(LocalSetData, await s.requestIn(repo, 'local', 'on', '--json'));

    expect(on).toEqual({ ok: true, data: { checkout: repo, on: true } });
    expect(readFileSync(join(root, 'mine', 'settings.yaml'), 'utf8')).toContain(repo);
    expect((await status()).on).toBe(true);
    // The repo's file cannot turn it on: the entry is dropped as yours on this Mac.
    const repoFile = join(repo, 'abe.yaml');

    writeFileSync(repoFile, `${REPO_SETTINGS}localMode: [${JSON.stringify(root)}]\n`);
    const problems = await s.request('settings', 'check', repo, '--json');

    expect(problems.stdout).toContain('not-in-repo');
    writeFileSync(repoFile, REPO_SETTINGS);
  });

  test('agents run on this Mac only: a cloud run is refused', async () => {
    const out = doc(
      FactoryRunData,
      await s.request('factory', 'run', '7', '--repo', repo, '--target', 'cloud', '--json'),
    );

    expect(out.ok ? 'launched' : out.error.code).toBe('local-mode');
  });

  test('no box for it: abe box place, up, start and resize are refused', async () => {
    for (const argv of [
      ['box', 'place', '7', '--repo', repo, '--json'],
      ['box', 'up', 'mkdir-swe/demo-shop', '7', '--json'],
      ['box', 'start', 'demo-shop', '--json'],
      ['box', 'resize', 'demo-shop', 'm8g.xlarge', '--yes', '--json'],
    ]) {
      const out = await s.requestIn(repo, ...argv);

      const code = z.object({ error: z.object({ code: z.string() }) }).parse(JSON.parse(out.stdout))
        .error.code;

      expect([argv[1], code]).toEqual([argv[1], 'local-mode']);
    }
  });

  test(
    'a full run holds every write: a local pull request, merged here, is Done',
    { timeout: 45_000 },
    async () => {
      scriptClaude(s.state.dir, [
        {
          abe: ['factory', 'stage-done', 'create-specification', '--json'],
        },
        { abe: ['factory', 'stage-done', 'to-tickets', '--json'] },
        { abe: ['factory', 'stage-done', 'build', '--json'] },
        { abe: ['factory', 'review', '--findings', '0', '--json'] },
        { write: { path: '.scratch/7/verify-after.md', text: '# Verify after\n' } },
        {
          abe: [
            ...['factory', 'verify', '--phase', 'after', '--result', 'pass'],
            ...['--report', '.scratch/7/verify-after.md', '--json'],
          ],
        },
        { abe: ['factory', 'judge', '--answer', 'no', '--reason', 'nothing by hand', '--json'] },
      ]);
      const launched = doc(
        FactoryRunData,
        await s.request('factory', 'run', '7', '--repo', repo, '--json'),
      );

      if (!launched.ok) throw new Error(JSON.stringify(launched.error));
      await readUntil(
        'AB#7 in pr',
        () => runOf(7),
        (r) => r?.stage === 'pr',
      );
      const session = doc(
        SessionData,
        await s.request('session', 'show', launched.data.session, '--json'),
      );

      if (!session.ok) throw new Error(JSON.stringify(session.error));
      const { worktree } = launched.data;
      const branch = session.data.branch;

      writeFileSync(join(worktree, 'signin.txt'), 'email\n');
      git(worktree, 'add', 'signin.txt');
      git(worktree, 'commit', '-q', '-m', 'sign in');
      const file = join(worktree, '.scratch', 'body.md');

      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, GOOD);
      const opened = doc(
        FactoryRunData,
        await s.requestAs(
          launched.data.session,
          worktree,
          'factory',
          'pr',
          '--title',
          'Sign in',
          '--body-file',
          file,
          '--json',
        ),
      );

      expect(opened).toMatchObject({
        ok: true,
        data: { stage: 'pr', pr: { repo: REPO, number: 900_000_001, merge: 'person' } },
      });
      const held = await status();

      expect(held.prs).toMatchObject([
        {
          name: 'L1',
          state: 'open',
          head: branch,
          base: 'main',
          card: 7,
          title: 'Sign in',
          // what it changes, as git says: its files with lines added and removed, its commits
          baseSha: git(repo, 'rev-parse', 'main'),
          files: [{ path: 'signin.txt', status: 'A', added: 1, removed: 0 }],
          commits: [{ sha: git(worktree, 'rev-parse', 'HEAD'), subject: 'sign in' }],
        },
      ]);
      expect(held.held.map((w) => w.kind).sort()).toEqual(['card-move', 'pr-create', 'push']);
      expect(held.cards).toMatchObject([{ card: 7, state: 'Active' }]);
      // A person merges it into the local main; the run is Done, its card's move to Closed held.
      const merged = doc(LocalPrData, await s.requestIn(repo, 'local', 'merge', 'L1', '--json'));

      expect(merged).toMatchObject({ ok: true, data: { pr: { name: 'L1', state: 'merged' } } });
      expect(git(repo, 'show', 'main:signin.txt')).toBe('email');
      expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      await readUntil(
        'AB#7 done',
        () => runOf(7),
        (r) => r?.stage === 'done',
      );
      await readUntil(
        'AB#7 Closed here',
        () => status(),
        (v) => v.cards[0]?.state === 'Closed',
      );
      // Nothing reached GitHub or the board: no gh call, no pushed branch, the card as it was.
      expect(sent()).toEqual([]);
      expect(git(remote, 'branch', '--list', branch)).toBe('');
      expect(board.cards().find((c) => c.id === 7)).toMatchObject({ state: 'New', comments: [] });
    },
  );

  test(
    "ended by a person from anywhere: its run's checkout decides, the card not commented",
    { timeout: 30_000 },
    async () => {
      scriptClaude(s.state.dir, []);
      // its checkout's install: Just this Mac, aws skipped, a script that deploys
      await fileInstallStore(join(s.state.dir, 'installs')).write(repo, {
        ...newInstall(repo, new Date(0).toISOString()),
        finishedAt: new Date(0).toISOString(),
        read: ReadFindings.parse({
          files: [],
          ci: [],
          scripts: {},
          envExample: null,
          envKeys: [],
          logins: [],
          board: null,
          fixedPorts: [],
          outward: [
            {
              name: 'deploy:platform',
              dir: '.',
              file: null,
              seen: 'package.json:3',
              why: 'deploy',
            },
          ],
          kind: {
            kind: 'web-app',
            parts: [],
            runs: true,
            deployTools: [],
            systems: [],
            ports: [],
            templates: [],
            mappings: [],
            checks: [],
            neverRead: ['.env', 'backend/.env.prod'],
          },
        }),
      });
      const launched = doc(
        FactoryRunData,
        await s.request('factory', 'run', '8', '--repo', repo, '--json'),
      );

      expect(launched.ok).toBe(true);
      // Its own tools: every outward write refused, no telemetry (reads pass).
      const worktree = launched.ok ? launched.data.worktree : '';
      const out = await readUntil(
        'AB#8 claude started',
        () => Promise.resolve(claudeOutput(worktree)),
        (o) => o.argv !== undefined && o.env !== undefined,
      );
      const argv = z.array(z.string()).parse(out.argv);
      const settings = z
        .object({
          permissions: z.object({ deny: z.array(z.string()) }),
        })
        .parse(JSON.parse(readFileSync(argv[argv.indexOf('--settings') + 1] ?? '', 'utf8')));
      const deny = settings.permissions.deny;
      // its commands' jail (ADR 0029), beside its settings
      const profile = readFileSync(
        join(dirname(argv[argv.indexOf('--settings') + 1] ?? ''), 'jail.sb'),
        'utf8',
      );

      for (const [what, rule] of SESSION_REFUSED)
        expect([what, deny.includes(rule)]).toEqual([what, true]);
      for (const rule of ['Bash(gh pr view:*)', 'Bash(git fetch:*)'])
        expect([rule, deny.includes(rule)]).toEqual([rule, false]);
      // its install's: aws off (never checked); the scripts that write real systems not refused,
      // the enabled environments are reached in full (ADR 0029)
      expect([deny.includes('Read(~/.aws/**)'), deny.includes('Bash(aws:*)')]).toEqual([
        true,
        true,
      ]);
      for (const rule of ['Bash(npm run deploy:platform:*)', 'Bash(a0deploy:*)', 'Bash(npx cdk:*)'])
        expect([rule, deny.includes(rule)]).toEqual([rule, false]);
      // its jail keeps ~/.aws from its commands too
      expect(profile).toMatch(/\(literal "[^"]*\/\.aws"\)/);
      // what its install's Read marked never read is read all the same (ADR 0028): no Read deny
      for (const tree of [realpathSync(repo), realpathSync(worktree)])
        for (const path of ['.env', 'backend/.env.prod'])
          expect([
            path,
            deny.includes(`Read(/${tree}/${path})`),
            profile.includes(`(literal "${tree}/${path}")`),
          ]).toEqual([path, false, false]);
      const env = z.record(z.string(), z.string()).parse(out.env);

      expect(env).toMatchObject(LOCAL_MODE_ENV);
      expect([
        env.AWS_CONFIG_FILE?.endsWith('/aws-off/empty'),
        env.AWS_EC2_METADATA_DISABLED,
      ]).toEqual([true, 'true']);
      // typed outside the checkout: the run's own checkout decides
      const ended = await s.request(
        'factory',
        'end',
        '8',
        '--as',
        'abandoned',
        '--reason',
        'not now',
        '--json',
      );

      expect(JSON.parse(ended.stdout)).toMatchObject({
        ok: true,
        data: { comment: NOT_COMMENTED },
      });
      expect((await status()).held.filter((w) => w.kind === 'card-comment')).toEqual([]);
      expect(board.cards().find((c) => c.id === 8)).toMatchObject({ state: 'New', comments: [] });
    },
  );

  test(
    'a new card is held here (LC1): on the Board, launched on this machine, its writes held',
    { timeout: 30_000 },
    async () => {
      const made = doc(
        CardData,
        await s.requestIn(repo, 'card', 'create', '--title', 'Gift wrap', '--json'),
      );

      expect(made).toMatchObject({ ok: true, data: { id: localNumber(1), url: 'local:LC1' } });
      const listed = doc(CardListData, await s.requestIn(repo, 'card', 'list', '--json'));

      expect(listed.ok && listed.data.cards.map((c) => c.id)).toContain(localNumber(1));
      scriptClaude(s.state.dir, []);
      const launched = doc(
        FactoryRunData,
        await s.requestIn(repo, 'factory', 'run', 'LC1', '--repo', repo, '--json'),
      );

      expect(launched).toMatchObject({ ok: true, data: { card: localNumber(1) } });
      // ended by a person: no comment on it
      await s.request('factory', 'end', 'LC1', '--as', 'abandoned', '--reason', 'x', '--json');
      const shown = doc(CardShowData, await s.requestIn(repo, 'card', 'show', 'LC1', '--json'));

      expect(shown.ok && shown.data.comments).toEqual([]);
      await s.requestIn(repo, 'card', 'move', 'LC1', 'Active', '--json');
      expect(
        doc(CardShowData, await s.requestIn(repo, 'card', 'show', '#LC1', '--json')),
      ).toMatchObject({ ok: true, data: { state: 'Active' } });
      // no board has it: nothing was sent
      expect(board.cards().map((c) => c.id)).toEqual([7, 8]);
      expect(sent()).toEqual([]);
    },
  );

  test("a Sheet attached: kept in this Mac's store, never the org's", async () => {
    const page = join(root, 'p.html');

    writeFileSync(page, '<!doctype html><title>P</title><p>hi</p>\n');
    const saved = doc(
      SheetSaveData,
      await s.requestIn(repo, 'sheet', 'save', '--title', 'P', '--file', page, '--json'),
    );

    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    const attached = doc(
      SheetAttachData,
      await s.requestIn(repo, 'sheet', 'attach', saved.data.id, '--card', '7', '--json'),
    );

    if (!attached.ok) throw new Error(JSON.stringify(attached.error));
    expect(existsSync(join(s.state.dir, 'local', 'store', ...attached.data.key.split('/')))).toBe(
      true,
    );
    expect(readdirSync(org)).toEqual([]);
    expect(board.cards().find((c) => c.id === 7)).toMatchObject({ comments: [] });
  });

  test('turned off: nothing held is sent, the records stay', async () => {
    const off = doc(LocalSetData, await s.requestIn(repo, 'local', 'off', '--json'));

    expect(off).toEqual({ ok: true, data: { checkout: repo, on: false } });
    // the last checkout off: the key goes, not an empty list
    expect(readFileSync(join(root, 'mine', 'settings.yaml'), 'utf8')).not.toContain('localMode');
    const after = await status();

    expect(after.on).toBe(false);
    expect(after.held.length).toBeGreaterThan(0);
    expect(sent()).toEqual([]);
  });

  test('the board read-only alone: its changes held and drawn over its cards; Discard local changes drops them', async () => {
    const on = doc(
      BoardReadOnlyData,
      await s.requestIn(repo, 'board', 'read-only', 'on', '--json'),
    );

    expect(on).toEqual({ ok: true, data: { checkout: repo, on: true, localMode: false } });
    expect(readFileSync(join(root, 'mine', 'settings.yaml'), 'utf8')).toContain('boardReadOnly');
    expect([(await status()).on, (await status()).readOnlyBoard]).toEqual([false, true]);
    const moved = doc(CardData, await s.requestIn(repo, 'card', 'move', '8', 'Active', '--json'));

    expect(moved.ok && moved.data.state).toBe('Active');
    // an assignment held would change nothing anyone reads: refused, saying read-only is why
    const assigned = doc(CardData, await s.requestIn(repo, 'card', 'assign', '8', 'me', '--json'));

    expect(assigned).toMatchObject({ ok: false, error: { code: 'board-read-only' } });
    await s.requestIn(repo, 'card', 'comment', '8', '--text', 'seen it', '--json');
    const shown = doc(CardShowData, await s.requestIn(repo, 'card', 'show', '8', '--json'));

    // over the board's card: the comment, said as held here; the board has none
    expect(shown.ok && shown.data.comments.map((c) => [c.text, c.by]).at(-1)).toEqual([
      'seen it',
      'you (held here)',
    ]);
    expect(board.cards().find((c) => c.id === 8)).toMatchObject({ state: 'New', comments: [] });
    expect((await status()).cards.find((c) => c.card === 8)).toMatchObject({
      state: 'Active',
      comments: 1,
    });
    // Discard local changes: every held write on a card, and the cards made here, dropped
    const before = (await status()).held;
    const discarded = doc(BoardDiscardData, await s.requestIn(repo, 'board', 'discard', '--json'));

    expect(discarded).toEqual({
      ok: true,
      data: {
        checkout: repo,
        writes: before.filter((w) => w.kind.startsWith('card-')).length,
        cards: 1,
      },
    });
    const left = await status();

    expect([left.held.filter((w) => w.kind.startsWith('card-')), left.cards]).toEqual([[], []]);
    expect(left.held.length).toBe(before.length - (discarded.ok ? discarded.data.writes : 0));
    const plain = doc(CardShowData, await s.requestIn(repo, 'card', 'show', '8', '--json'));

    expect(plain.ok && plain.data.comments).toEqual([]);
    expect(
      (await heldEvents(s.state.socket))
        .filter((e) => e.type === 'local.discarded')
        .map((e) => e.data),
    ).toEqual([discarded.ok && discarded.data]);
    const off = doc(
      BoardReadOnlyData,
      await s.requestIn(repo, 'board', 'read-only', 'off', '--json'),
    );

    expect([off.ok && off.data.on, (await status()).readOnlyBoard]).toEqual([false, false]);
    // the last checkout off: the key goes, not an empty list
    expect(readFileSync(join(root, 'mine', 'settings.yaml'), 'utf8')).not.toContain(
      'boardReadOnly',
    );
    expect(sent()).toEqual([]);
  });
});
