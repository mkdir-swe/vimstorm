/**
 * `abe story linked <id>` (#109 S1). Through the CLI seam: a real `serve` with a session and its
 * Factory run kept from before (its worktree a real git checkout with GitHub as origin), the
 * in-memory Board, Tracking through the real adapter on the fake `gh`. Then `readLinked` over
 * stand-in sources for what the seam does not reach: a box, a spec issue, a run History keeps.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type BoxData,
  type FactoryRunData,
  LINKED_KEYS,
  linkedRowText,
  type Outcome,
  type Reply,
  Run,
  SessionListData,
  SessionMeta,
  StoryLinkedData,
} from '@abe/core';
import {
  ghTrackingFrom,
  pipelinesFrom,
  sessionSocket,
  tmuxRunner,
  writeRun,
  writeSessionMeta,
} from '@abe/ports';
import {
  card,
  factoryRun,
  fakeBoard,
  fakeGh,
  type FakeGh,
  ghWorkflowRun,
  scenario,
  type ServeScenario,
  session,
  tempState,
  T0,
} from '@abe/testing';
import { z } from 'zod';
import {
  firstLine,
  type LinkedSources,
  oneAtATime,
  readLinked,
  sharedReads,
  sharing,
} from './linked';

const REPO = 'mkdir-swe/demo-shop';
const STORY = 2;
const TITLE = 'The cart total ignores quantity';
const BRANCH = 'card/2-the-cart-total-ignores-quantity';
const ID = '2-a1b2';
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const doc = (reply: Reply) =>
  z
    .union([
      z.object({ ok: z.literal(true), data: StoryLinkedData }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), message: z.string() }),
      }),
    ])
    .parse(JSON.parse(reply.stdout));

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: { PATH: '/usr/bin:/bin' } });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
};

const words = (d: StoryLinkedData) =>
  Object.fromEntries(
    d.rows.map((r) => [r.key, `${r.dim ? '(dim) ' : ''}${linkedRowText(r, d.at)}`]),
  );

describe('abe story linked through the CLI seam', () => {
  let s: ServeScenario;
  let gh: FakeGh;
  let worktree: string;
  const answers = () =>
    [
      [`head=mkdir-swe:${BRANCH}`, { json: [] }],
      [
        `actions/runs?per_page=1&branch=${encodeURIComponent(BRANCH)}`,
        {
          json: {
            total_count: 1,
            workflow_runs: [
              {
                ...ghWorkflowRun('ci', 'completed', 'success', {
                  id: 7001,
                  branch: BRANCH,
                  createdAt: iso(5),
                  updatedAt: iso(9),
                }),
                run_number: 12,
              },
            ],
          },
        },
      ],
    ] as const;

  beforeAll(async () => {
    const state = tempState();
    const root = join(state.dir, 'world');

    mkdirSync(join(root, 'mine'), { recursive: true });
    mkdirSync(join(root, 'demo-shop-wt', '2-the-cart-total-ignores-quantity', '.abe'), {
      recursive: true,
    });
    // its real path: commands are typed in it, and a request's folder is resolved (#337)
    worktree = realpathSync(join(root, 'demo-shop-wt', '2-the-cart-total-ignores-quantity'));
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(worktree, 'init', '-q', '-b', BRANCH);
    git(worktree, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`);
    writeFileSync(
      join(worktree, 'abe.yaml'),
      'board: {organization: "https://dev.azure.com/demo-org", project: Shop, team: Web}\n',
    );
    // yours for the repo, never committed
    writeFileSync(join(worktree, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
    writeFileSync(join(worktree, '.abe', 'settings.local.yaml'), '');
    // A local session waiting on you and its run in Build, kept by an earlier serve: in Build since
    // 0, waiting since 20, so at 21 the run says `1 min`, Chat's header's clock (#147).
    writeSessionMeta(
      state.dir,
      SessionMeta.parse({
        ...session(ID, 'waiting', STORY),
        title: TITLE,
        repo: worktree,
        worktree,
        branch: BRANCH,
        since: iso(20),
        startedAt: iso(0),
        v: 1,
        claudeSession: '00000000-0000-4000-8000-000000000002',
        socket: sessionSocket(state.dir, ID),
      }),
    );
    writeRun(
      state.dir,
      Run.parse({
        v: 1,
        session: ID,
        card: STORY,
        title: TITLE,
        repo: worktree,
        worktree,
        startedAt: iso(0),
        stage: 'build',
        since: iso(0),
        // a run before 3.3 kept its decision: read past, its workflow Feature's
        decision: { kind: 'bug', spec: false, level: 'after', repos: ['demo-shop'], risky: false },
        visits: [],
        needsYou: { reason: 'it asks which total', since: iso(20) },
        outcome: null,
      }),
    );
    gh = fakeGh([...answers()]);
    const runner = tmuxRunner({
      stateDir: state.dir,
      tmux: null,
      env: state.env,
      self: [],
      plugins: join(state.dir, 'plugins'),
    });

    s = await scenario({
      state,
      board: fakeBoard([
        card(STORY, TITLE, {
          state: 'Active',
          type: 'Bug',
          assignee: { name: 'Ada Example', email: 'ada@example.test' },
        }),
      ]),
      tracking: ghTrackingFrom({ PATH: gh.path }),
      pipelines: pipelinesFrom({ PATH: gh.path }),
      sessions: {
        env: { ABE_CONFIG_DIR: join(root, 'mine') },
        // Its claude still runs.
        runner: { ...runner, running: () => Promise.resolve({ ok: true, data: [ID] }) },
      },
    });
    s.clock.tick(21 * 60_000);
  });
  afterAll(async () => {
    await s.close();
    gh.remove();
  });

  test('#2: the nine rows with their states, as --json', async () => {
    const reply = await s.requestIn(worktree, 'story', 'linked', String(STORY), '--json');
    const answer = doc(reply);

    expect(reply.exit).toBe(0);
    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.data.title).toBe(TITLE);
    expect(words(answer.data)).toEqual({
      story: 'Active · Bug · AE',
      prototype: '(dim) none',
      spec: '(dim) none yet',
      sessions: '1 · Local sandbox',
      pr: '(dim) none yet',
      pipelines: 'ci ✓ passed on card/2-… · 12 min ago',
      worktree,
      box: '(dim) none · Local sandbox',
      sheets: '(dim) none',
    });
    // the run's facts, no row of their own (Run is on the stripe)
    expect(answer.data.run).toMatchObject({ session: ID, stage: 'build', state: 'needs-you' });
    expect(answer.data.rows[6]).toMatchObject({
      key: 'worktree',
      dim: false,
      opens: { kind: 'workspace', session: ID, path: worktree },
    });
  });

  test('the text form: the title, then each row with its words', async () => {
    const reply = await s.requestIn(worktree, 'story', 'linked', `AB#${STORY}`);

    expect(reply.exit).toBe(0);
    expect(reply.stdout.split('\n').slice(0, 5)).toEqual([
      `Linked · #2 ${TITLE}`,
      '  Story         Active · Bug · AE',
      '  Prototype     none',
      '  Spec          none yet',
      '  Sessions      1 · Local sandbox',
    ]);
  });

  test('gh refusing: Pull request and Pipelines say why, the rest still shows', async () => {
    gh.answer([
      ['api', { stderr: 'To get started with GitHub CLI, please run:  gh auth login', exit: 4 }],
    ]);
    try {
      const answer = doc(await s.requestIn(worktree, 'story', 'linked', String(STORY), '--json'));

      if (!answer.ok) throw new Error(answer.error.message);
      expect(words(answer.data)).toMatchObject({
        story: 'Active · Bug · AE',
        sessions: '1 · Local sandbox',
        pr: '(dim) not read · To get started with GitHub CLI, please run: gh auth login',
        pipelines: '(dim) not read · To get started with GitHub CLI, please run: gh auth login',
      });
    } finally {
      gh.answer([...answers()]);
    }
  });

  test('a story with nothing yet: every row there, dim; a story the board lacks says why', async () => {
    const answer = doc(await s.requestIn(worktree, 'story', 'linked', '9', '--json'));

    if (!answer.ok) throw new Error(answer.error.message);
    expect(answer.data.rows).toHaveLength(9);
    expect(answer.data.rows.every((r) => r.dim)).toBe(true);
    expect(answer.data.rows[0]?.words).toBe('not read · TF401232: Work item 9 does not exist.');
  });

  test('read in its checkout: the lists name the repo they were read in (#256)', async () => {
    const sessions = await s.requestIn(worktree, 'session', 'list', '--json');
    const runs = await s.requestIn(worktree, 'factory', 'status', '--json');

    for (const reply of [sessions, runs])
      expect(JSON.parse(reply.stdout)).toMatchObject({
        ok: true,
        // its real path: a request's folder is resolved as it comes in (#337)
        data: { here: { root: realpathSync(worktree), github: REPO } },
      });
    const listed = z.object({ data: SessionListData }).parse(JSON.parse(sessions.stdout));

    expect(listed.data.here?.checkouts).toEqual([realpathSync(worktree)]);
  });

  test('read in another repo: its #2 has none of this repo’s run or session (#256)', async () => {
    const other = join(worktree, '..', '..', 'other-shop');

    mkdirSync(other, { recursive: true });
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'remote', 'add', 'origin', 'https://github.com/mkdir-swe/other-shop.git');
    const answer = doc(await s.requestIn(other, 'story', 'linked', String(STORY), '--json'));

    if (!answer.ok) throw new Error(answer.error.message);
    expect(words(answer.data)).toMatchObject({ sessions: '(dim) none yet' });
    expect(answer.data.run).toBeNull();
  });

  test('--part: only that part read, the other rows Reading… and listed (#341)', async () => {
    const answer = doc(
      await s.requestIn(
        worktree,
        'story',
        'linked',
        String(STORY),
        '--part',
        'pipelines',
        '--json',
      ),
    );

    if (!answer.ok) throw new Error(answer.error.message);
    // its own row, and the run part's rows it read the runs and sessions for anyway
    expect(answer.data.reading).toEqual(['story', 'pr', 'sheets']);
    expect(words(answer.data)).toMatchObject({
      story: '(dim) Reading…',
      sessions: '1 · Local sandbox',
      pr: '(dim) Reading…',
      pipelines: 'ci ✓ passed on card/2-… · 12 min ago',
    });
    // the run part: its rows, the title the run's until the card part says it
    const run = doc(
      await s.requestIn(worktree, 'story', 'linked', String(STORY), '--part', 'run', '--json'),
    );

    if (!run.ok) throw new Error(run.error.message);
    expect(run.data.title).toBe(TITLE);
    expect(run.data.run).toMatchObject({ stage: 'build', state: 'needs-you' });
    expect(run.data.reading).toEqual(['story', 'pr', 'pipelines', 'sheets']);
    expect(words(run.data)).toMatchObject({
      sessions: '1 · Local sandbox',
      pr: '(dim) Reading…',
      box: '(dim) none · Local sandbox',
    });
  });

  test('not a story id: a usage refusal', async () => {
    const reply = await s.requestIn(worktree, 'story', 'linked', 'cart', '--json');

    expect(reply.exit).toBe(2);
    expect(doc(reply)).toMatchObject({ ok: false, error: { code: 'usage' } });
  });
});

describe('readLinked: which parts it reads, each on its own', () => {
  const ok = <T>(data: T): Outcome<T> => ({ ok: true, data });
  const no = (message: string): Outcome<never> => ({ ok: false, error: { code: 'x', message } });
  const run = factoryRun(STORY, TITLE, 'build', 'running', {
    session: ID,
    worktree: '/workspace/repo',
  });
  const boxed = {
    ...session(ID, 'working', STORY),
    box: 'demo-shop-102',
    repo: REPO,
    branch: BRANCH,
  };
  const asked: string[] = [];
  const sources = (o: Partial<LinkedSources> = {}): LinkedSources => ({
    card: () => Promise.resolve(ok({ ...card(STORY, TITLE), sheets: [] })),
    runs: (_, cleared) => Promise.resolve(ok(cleared ? [] : [run])),
    sessions: () => Promise.resolve(ok([boxed])),
    sheets: () => Promise.resolve(ok([])),
    boxes: () => {
      asked.push('boxes');

      return Promise.resolve(ok<BoxData[]>([]));
    },
    origin: () => {
      asked.push('origin');

      return Promise.resolve(no('no origin'));
    },
    tracking: {
      issueShow: () => Promise.resolve({ ok: false, error: { code: 'not-found', message: '404' } }),
      prShow: () => Promise.resolve({ ok: false, error: { code: 'not-found', message: '404' } }),
      prFind: (q) => {
        asked.push(`prFind ${q.repo} ${q.head}`);

        return Promise.resolve({ ok: true, data: null });
      },
      prReviews: () => Promise.resolve({ ok: true, data: [] }),
    },
    pipeline: ({ branch, github }) => {
      const repo = github?.ok === false ? `(${github.error})` : (github?.data ?? 'the origin here');

      asked.push(`pipeline ${branch} in ${repo}`);

      return Promise.resolve(github?.ok === false ? no(github.error) : ok(null));
    },
    report: () => Promise.resolve(null),
    prototype: () => {
      asked.push('prototype');

      return Promise.resolve(ok(null));
    },
    ...o,
  });

  test("a box's session: its boxes read, GitHub by the session's repo, never its box's origin", async () => {
    asked.length = 0;
    const parts = await readLinked(sources(), STORY);

    expect(asked.sort()).toEqual([
      'boxes',
      `pipeline ${BRANCH} in ${REPO}`,
      `prFind ${REPO} ${BRANCH}`,
    ]);
    expect(parts.boxes).toEqual({ ok: true, data: [] });
  });

  test('a local session: no boxes read; a failed origin is the GitHub rows’ failure', async () => {
    asked.length = 0;
    const plain = {
      ...session(ID, 'working', STORY),
      repo: '/home/me/demo-shop',
      worktree: '/wt',
    };
    const parts = await readLinked(
      sources({
        sessions: () => Promise.resolve(ok([plain])),
        runs: () => Promise.resolve(ok([])),
      }),
      STORY,
    );

    // no run: the store's prototype asked for too (#351: a card asking "can we do this?")
    expect(asked).toEqual(['origin', 'pipeline card/2-x in (no origin)', 'prototype']);
    expect(parts.boxes).toBeUndefined();
    expect(parts.pr).toEqual({ ok: false, error: 'no origin' });
    expect(parts.pipeline).toEqual({ ok: false, error: 'no origin' });
  });

  test('the session the card is on (#335): a failed run waiting on you, not an older live plain one', async () => {
    asked.length = 0;
    const waiting = {
      ...run,
      state: 'needs-you' as const,
      reason: 'build failed',
      startedAt: iso(3),
    };
    const plain = {
      ...session('2-p1', 'working', STORY),
      repo: '/home/me/demo-shop',
      worktree: '/wt/plain',
      branch: 'card/2-plain',
      startedAt: iso(1),
    };
    await readLinked(
      sources({
        runs: (_, cleared) => Promise.resolve(ok(cleared ? [] : [waiting])),
        sessions: () =>
          Promise.resolve(ok([plain, { ...boxed, state: 'ended' as const, startedAt: iso(3) }])),
      }),
      STORY,
    );

    // the run's session's box and branch, as its Board card and Linked's rows read them
    expect(asked.sort()).toEqual([
      'boxes',
      `pipeline ${BRANCH} in ${REPO}`,
      `prFind ${REPO} ${BRANCH}`,
    ]);
  });

  test('the spec: its issue read by its reference, the written one by its report', async () => {
    const referenced: FactoryRunData = {
      ...run,
      reference: {
        spec: `${REPO}#88`,
        prototype: { kind: 'store', url: 'prototype://demo-shop/2/v1' },
        dir: '/r',
      },
    };
    const written: FactoryRunData = {
      ...run,
      stages: [
        {
          stage: 'spec',
          startedAt: iso(0),
          endedAt: iso(4),
          durationMs: 1,
          report: '/r/1-spec.md',
        },
      ],
    };
    const issue = await readLinked(
      sources({ runs: () => Promise.resolve(ok([referenced])) }),
      STORY,
    );
    const report = await readLinked(
      sources({
        runs: () => Promise.resolve(ok([written])),
        report: (path) =>
          Promise.resolve(
            path === '/r/1-spec.md' ? '# Each line counts price × quantity\n\nmore' : null,
          ),
      }),
      STORY,
    );

    expect(issue.specIssue).toEqual({ ok: false, error: '404' });
    expect(report.specLine).toBe('Each line counts price × quantity');
    // a prototype's run since #351: no spec issue, its own Spec's report read, the store asked
    const prototyped = await readLinked(
      sources({
        runs: () =>
          Promise.resolve(
            ok([
              {
                ...written,
                reference: {
                  spec: null,
                  prototype: { kind: 'store', url: 'prototype://demo-shop/2/v1' },
                  dir: '/r',
                },
              },
            ]),
          ),
        report: () => Promise.resolve('# From the prototype'),
        prototype: () => Promise.resolve(ok(2)),
      }),
      STORY,
    );

    expect(prototyped.specLine).toBe('From the prototype');
    expect(prototyped.prototype).toEqual({ ok: true, data: 2 });
  });

  test('no run shown: the newest History keeps; a failed read stays its own', async () => {
    const parts = await readLinked(
      sources({
        runs: (_, cleared) =>
          Promise.resolve(ok(cleared ? [{ ...run, stage: 'done' as const }] : [])),
        sheets: () => Promise.resolve(no('this abe serve keeps no Sheets')),
      }),
      STORY,
    );

    expect(parts.run).toMatchObject({ ok: true, data: { stage: 'done' } });
    expect(parts.sheets).toEqual({ ok: false, error: 'this abe serve keeps no Sheets' });
    expect(parts.card.ok).toBe(true);
  });

  test('a read that throws is its own part’s failure; a run with no listed session uses its card’s branch', async () => {
    asked.length = 0;
    const parts = await readLinked(
      sources({
        sessions: () => Promise.reject(new Error('the box went away')),
        runs: () => Promise.resolve(ok([{ ...run, worktree: '/wt' }])),
        origin: (worktree) => {
          asked.push(`origin ${worktree}`);

          return Promise.resolve(ok(`https://github.com/${REPO}.git`));
        },
        boxes: () => Promise.reject(new Error('never asked')),
      }),
      STORY,
    );

    expect(parts.sessions).toEqual({ ok: false, error: 'the box went away' });
    expect(parts.card.ok).toBe(true);
    expect(asked.sort()).toEqual([
      'origin /wt',
      `pipeline card/2-the-cart-total-ignores-quantity in ${REPO}`,
      `prFind ${REPO} card/2-the-cart-total-ignores-quantity`,
    ]);
  });

  test('a part reads only its own: card asks the run alone, run no GitHub nor box (#341)', async () => {
    const reads: string[] = [];
    const noted = sources({
      runs: (_, cleared) => {
        reads.push('runs');

        return Promise.resolve(ok(cleared ? [] : [run]));
      },
      sessions: () => {
        reads.push('sessions');

        return Promise.resolve(ok([boxed]));
      },
      card: () => {
        reads.push('card');

        return Promise.resolve(ok({ ...card(STORY, TITLE), sheets: [] }));
      },
    });

    asked.length = 0;
    const cardPart = await readLinked(noted, STORY, 'card');

    // the run first: its checkout is where the card is read
    expect([...reads, ...asked]).toEqual(['runs', 'card']);
    expect(cardPart.reading).toEqual(LINKED_KEYS.filter((k) => k !== 'story' && k !== 'sheets'));
    reads.length = 0;
    const runPart = await readLinked(noted, STORY, 'run');

    expect([...reads, ...asked].sort()).toEqual(['runs', 'sessions']);
    expect(runPart.reading).toEqual(['story', 'pr', 'pipelines', 'box', 'sheets']);
    reads.length = 0;
    await readLinked(noted, STORY, 'pr');
    expect([...reads, ...asked].sort()).toEqual([`prFind ${REPO} ${BRANCH}`, 'runs', 'sessions']);
  });

  // a card worktree's own settings may name no board: the story is read in the run's checkout,
  // whole or as its part; no run, where Linked was asked
  test.each<[string, FactoryRunData[], (string | undefined)[]]>([
    [
      'a run here',
      [{ ...run, repo: '/home/me/demo-shop', worktree: '/wt/s2' }],
      ['/home/me/demo-shop', '/home/me/demo-shop'],
    ],
    ['no run', [], [undefined, undefined]],
  ])('the story read in the run’s checkout, %s', async (_, runs, where) => {
    const asked: (string | undefined)[] = [];
    const s = sources({
      runs: (__, cleared) => Promise.resolve(ok(cleared ? [] : runs)),
      card: (__, repo) => {
        asked.push(repo);

        return Promise.resolve(ok({ ...card(STORY, TITLE), sheets: [] }));
      },
    });

    await readLinked(s, STORY);
    await readLinked(s, STORY, 'card');
    expect(asked).toEqual(where);
  });

  test('a part always says its own row: no pull request to read now is the pr part’s none (#341)', async () => {
    const none = sources({
      runs: () => Promise.resolve(ok([])),
      sessions: () => Promise.resolve(ok([])),
    });
    const prPart = await readLinked(none, STORY, 'pr');
    const boxPart = await readLinked(none, STORY, 'box');

    expect(prPart.reading).toEqual(['story', 'sheets']);
    expect(boxPart.reading).toEqual(['story', 'sheets']);
  });

  test('a part never waits for another’s read: the pull request in while the boxes are not (#341)', async () => {
    const never = new Promise<never>(() => undefined);
    const slow = sources({ boxes: () => never, card: () => never });
    const pr = await readLinked(slow, STORY, 'pr');

    expect(pr.pr).toEqual({ ok: true, data: null });
    expect(pr.boxes).toBeUndefined();
  });

  test('oneAtATime: callers while a read is out share it, the next after gets a new one', async () => {
    const shared = oneAtATime<number>();
    let reads = 0;
    let done: (n: number) => void = () => undefined;
    const slow = () => {
      reads += 1;

      return new Promise<number>((r) => {
        done = r;
      });
    };
    const first = shared('k', slow);
    const second = shared('k', slow);

    expect(reads).toBe(1);
    done(7);
    expect(await Promise.all([first, second])).toEqual([7, 7]);
    const after = shared('k', () => Promise.resolve(8));

    expect(await after).toBe(8);
    expect(await shared('other', () => Promise.resolve(9))).toBe(9);
  });

  test('a part asked after an event never joins a runs read from before it (#341)', async () => {
    const pending: ((o: Outcome<FactoryRunData[]>) => void)[] = [];
    let seq = 4;
    const shared = sharing(
      sources({
        runs: (_, cleared) =>
          cleared
            ? Promise.resolve(ok([]))
            : new Promise((answer) => {
                pending.push(answer);
              }),
      }),
      sharedReads(),
      'here',
      () => seq,
    );
    // a subagent's event reads the run part again; its runs read is slow
    const runPart = readLinked(shared, STORY, 'run');

    // then the run moves (an event): every part read again, the pull request's after it
    seq = 5;
    const prPart = readLinked(shared, STORY, 'pr');
    // a part asked with no event since shares that newer read
    const pipelinesPart = readLinked(shared, STORY, 'pipelines');

    expect(pending).toHaveLength(2);
    const reviewing = { ...run, stage: 'review' as const };

    pending[0]?.(ok([run]));
    pending[1]?.(ok([reviewing]));
    expect((await runPart).run).toEqual({ ok: true, data: run });
    expect((await prPart).run).toEqual({ ok: true, data: reviewing });
    expect((await pipelinesPart).run).toEqual({ ok: true, data: reviewing });
  });

  test('the spec report is read only where the spec row is said from it (#341)', async () => {
    const reports: string[] = [];
    const written: FactoryRunData = {
      ...run,
      stages: [
        {
          stage: 'spec',
          startedAt: iso(0),
          endedAt: iso(4),
          durationMs: 1,
          report: '/r/1-spec.md',
        },
      ],
    };
    const referenced: FactoryRunData = {
      ...written,
      reference: {
        spec: `${REPO}#88`,
        prototype: { kind: 'store', url: 'prototype://demo-shop/2/v1' },
        dir: '/r',
      },
    };
    const reading = (r: FactoryRunData) =>
      sources({
        runs: (_, cleared) => Promise.resolve(ok(cleared ? [] : [r])),
        report: (path) => {
          reports.push(path);

          return Promise.resolve('# Spec');
        },
      });

    // a spec issue named: the row is the issue's, its report never read
    await readLinked(reading(referenced), STORY, 'spec');
    await readLinked(reading(referenced), STORY, 'pr');
    await readLinked(reading(referenced), STORY);
    expect(reports).toEqual([]);
    // none named: the written one's report, read by a part that says the row
    const said = await readLinked(reading(written), STORY, 'pr');

    expect(said.specLine).toBe('Spec');
    expect(reports).toEqual(['/r/1-spec.md']);
  });

  test("firstLine: a spec's first line of prose, cut", () => {
    expect(firstLine('\n## Spec\n\nbody')).toBe('Spec');
    expect(firstLine('   \n')).toBeNull();
    expect(firstLine('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`);
  });
});
