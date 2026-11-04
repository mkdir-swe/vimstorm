/**
 * `abe improve retro`: a real `serve` in this process, wired as the real one is (a file log store
 * of fixture sessions, three people in two repos; GitHub through a fake `gh`: your login, a run's
 * pull request comments, earlier retro fixes by their label, the Git Data API a fix's pull request
 * is made with; the fake `claude` answering the one-shot), its clock at 2026-10-26 so the
 * fixtures' sessions (since 2026-10-20) are in the past. The checkout is a real git repo whose
 * `origin` is on GitHub. One run of the real `abe` checks `improve retro`'s
 * and `improve retro chat`'s exit code and `--json` document.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { dirname, join } from 'node:path';
import {
  EventLine,
  ImproveApplyData,
  LocalSetData,
  RETRO_SKILL,
  RetroData,
  RetroMakeData,
  RetroRecord,
} from '@abe/core';
import {
  claudeOneShot,
  ghLayerPullsFrom,
  ghRetroPullsFrom,
  ghTrackingFrom,
  githubLoginsFrom,
  logStoreFrom,
} from '@abe/ports';
import {
  cli,
  FAKE_GITHUB_TOKEN,
  fakeClaude,
  type FakeClaude,
  fakeClock,
  fakeGh,
  type FakeGh,
  type GhAnswer,
  ghUser,
  oneShotCalls,
  scriptOneShot,
  served,
  type ServedCli,
  watching,
  type Watching,
} from '@abe/testing';
import { z } from 'zod';

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

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const CHECKS = '# Checks\n\n- types: red\n  src/cart.ts(3): error TS2322\n';
const REVIEW = '# Review round 1\n\n1. Round once, on the total, not per line.\n';

/** A session as the log store holds it: `<repo>/<user>/<session>/…`. */
const session = (
  store: string,
  o: {
    repo: string;
    user: string;
    id: string;
    card: number;
    since: string;
    files: Record<string, string>;
  },
) => {
  const at = join(store, o.repo, o.user, o.id);
  const meta = {
    v: 1,
    id: o.id,
    card: o.card,
    title: `Card ${o.card}`,
    state: 'ended',
    since: o.since,
  };

  write(join(at, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  for (const [name, text] of Object.entries(o.files)) write(join(at, name), text);
};

type Said = { fix?: Record<string, unknown> } & Record<string, unknown>;
const said = ({ fix, ...o }: Said) => ({
  severity: 'medium',
  whatHappened: 'It happened.',
  layer: 'repo',
  recurringOf: null,
  removes: null,
  ...o,
  fix: { summary: 'the fix', diff: '', ...fix },
});

const ME = JSON.stringify({
  findings: [
    said({
      severity: 'medium',
      title: 'autoMerge lowered for want of checks',
      moments: ['layers/overrides.md#3'],
      layer: 'individual',
      fix: { files: [{ path: 'skills/merge-note/SKILL.md', content: '# Merge note\n' }] },
    }),
    said({
      severity: 'high',
      title: 'Type errors reach Review',
      whatHappened: 'Build never ran tsc; Review caught it and a person asked for it.',
      moments: ['4-a1b2/checks.md#3', '4-a1b2/pr-comments.md#4'],
      fix: {
        summary: 'run types in Build',
        files: [{ path: 'settings.yaml', content: 'checks: [tests, types]\n' }],
        diff: '+checks: [tests, types]',
      },
      recurringOf: 'o/shop#12',
    }),
    said({
      severity: 'critical',
      title: 'A line that is not there',
      moments: ['4-a1b2/checks.md#99'],
      fix: { files: [{ path: 'x.md', content: 'x' }] },
    }),
    // Sam's session is not yours: a me retro never read it.
    said({
      severity: 'high',
      title: 'Someone else’s session',
      moments: ['5-c3d4/checks.md#1'],
      fix: { files: [{ path: 'x.md', content: 'x' }] },
    }),
    said({
      severity: 'low',
      title: 'Take out the old types script',
      moments: ['4-a1b2/checks.md#4'],
      fix: { summary: 'remove it', files: [{ path: 'scripts/old-types.sh', content: null }] },
      removes: 'o/shop#12',
    }),
  ],
  earlier: [{ pr: 'o/shop#12', verdict: 'helping', why: 'looks fine' }],
});

const NONE = JSON.stringify({ findings: [], earlier: [] });

const PULL_COMMENTS: GhAnswer = {
  json: [
    {
      user: { login: 'sam' },
      created_at: '2026-10-20T11:00:00Z',
      body: 'Please run tsc before pushing.',
    },
  ],
};

/** The Git Data API and the pull request a fix is made with, in `repo`, answering pull `n`. */
const proposeAnswers = (repo: string, n: number): [string, GhAnswer][] => [
  [`-X POST repos/${repo}/git/trees`, { json: { sha: 'tree-new' } }],
  [`-X POST repos/${repo}/git/commits`, { json: { sha: 'commit-new' } }],
  [
    `-X POST repos/${repo}/git/refs`,
    { json: { ref: 'refs/heads/x', object: { sha: 'commit-new' } } },
  ],
  [`-X POST repos/${repo}/labels`, { json: { name: 'abe-retro' } }],
  [`-X POST repos/${repo}/issues/${n}/labels`, { json: [{ name: 'abe-retro' }] }],
  [
    `-X POST repos/${repo}/pulls`,
    { json: { number: n, html_url: `https://github.com/${repo}/pull/${n}` } },
  ],
  [`repos/${repo}/pulls -f head=`, { json: [] }],
  [`repos/${repo}/git/ref/heads/main`, { json: { object: { sha: 'base-sha' } } }],
  [`repos/${repo}/git/commits/base-sha`, { json: { sha: 'base-sha', tree: { sha: 'base-tree' } } }],
];

const answers = (o: { shopPull: number }): [string, GhAnswer][] => [
  ['auth token --hostname github.com --user me-work', { stdout: `${FAKE_GITHUB_TOKEN}\n` }],
  ['api user', { json: ghUser('octocat') }],
  ['repos/o/shop/issues/21/comments', PULL_COMMENTS],
  [
    'repos/o/shop/pulls/21/reviews',
    {
      json: [
        { user: { login: 'sam' }, submitted_at: null, state: 'PENDING', body: '' },
        {
          user: { login: 'sam' },
          submitted_at: '2026-10-20T12:00:00Z',
          state: 'CHANGES_REQUESTED',
          body: 'Types fail.',
        },
      ],
    },
  ],
  ['repos/o/shop/pulls/21/comments', { json: [] }],
  [
    'repos/o/shop/issues?labels=abe-retro',
    {
      json: [
        {
          number: 14,
          title: 'Open still',
          html_url: 'https://github.com/o/shop/pull/14',
          state: 'open',
          pull_request: { merged_at: null },
        },
        {
          number: 12,
          title: 'Run types in Build (improve retro 2026-10-01, finding 1)',
          html_url: 'https://github.com/o/shop/pull/12',
          state: 'closed',
          pull_request: { merged_at: '2026-10-02T09:00:00Z' },
        },
      ],
    },
  ],
  ...proposeAnswers('o/shop', o.shopPull),
  ['api repos/o/shop', { json: { default_branch: 'main' } }],
];

type World = {
  root: string;
  repo: string;
  store: string;
  gh: FakeGh;
  claude: FakeClaude;
  abe: ServedCli;
};

/** Now, for the in-process serve: after every fixture session. */
const NOW = Date.parse('2026-10-26T09:00:00.000Z');

const world = async (): Promise<World> => {
  // Real, as a process's cwd is: the one-shot runs there.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'abe-r-')));
  const repo = join(root, 'shop');
  const store = join(root, 'logs');
  const claude = fakeClaude();
  const gh = fakeGh(answers({ shopPull: 71 }));

  write(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  write(
    join(repo, 'abe.yaml'),
    'overrides:\n  autoMerge: { value: true, reason: no checks yet }\n',
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/shop.git');
  // the shop's gh login is your work one, yours for the repo (ADR 0025, 0030), never committed
  write(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
  write(join(repo, '.abe', 'settings.local.yaml'), 'logins.gh: me-work\n');
  session(store, {
    repo: 'o_shop',
    user: 'octocat',
    id: '4-a1b2',
    card: 4,
    since: '2026-10-20T10:00:00.000Z',
    files: {
      'checks.md': CHECKS,
      'review/1.md': REVIEW,
      'hooks.jsonl': '{"hook_event_name":"Stop"}\n',
      'run.json': `${JSON.stringify({ v: 1, session: '4-a1b2', card: 4, pr: { repo: 'o/shop', number: 21, url: 'https://github.com/o/shop/pull/21' } }, null, 2)}\n`,
    },
  });
  session(store, {
    repo: 'o_shop',
    user: 'sam',
    id: '5-c3d4',
    card: 5,
    since: '2026-10-21T10:00:00.000Z',
    files: { 'checks.md': CHECKS },
  });
  session(store, {
    repo: 'o_other',
    user: 'carol',
    id: '6-e5f6',
    card: 6,
    since: '2026-10-21T12:00:00.000Z',
    files: { 'checks.md': CHECKS },
  });
  const env = {
    PATH: `${claude.dir}:${gh.dir}:/usr/bin:/bin`,
    ABE_CONFIG_DIR: join(root, 'mine'),
  };
  const logs = logStoreFrom({ ABE_LOG_STORE: `file://${store}` });

  if (logs === undefined) throw new Error('no log store');
  // As the real serve: GitHub through `gh`, one-shots through `claude -p`, both on this PATH.
  const abe = await served({
    clock: fakeClock(NOW),
    env,
    sessions: { env },
    tracking: ghTrackingFrom(env),
    oneShot: claudeOneShot(),
    layerPulls: ghLayerPullsFrom(env),
    retroPulls: ghRetroPullsFrom(env),
    github: githubLoginsFrom(env),
    logs: { store: logs },
  });

  return { root, repo, store, gh, claude, abe };
};

const RetroEvent = z.object({
  type: z.literal('improve.retro'),
  data: z.record(z.string(), z.unknown()),
});

const nextRetroEvent = async (watch: Watching) => {
  for (;;) {
    const event = RetroEvent.safeParse(EventLine.parse(JSON.parse(await watch.next(20_000))));

    if (event.success) return event.data.data;
  }
};

/** Each `gh` call's argv joined, and the JSON it was sent. */
const ghCalls = (gh: FakeGh) =>
  gh.calls().map((c) => ({
    args: c.argv.join(' '),
    input: c.stdin === '' ? undefined : z.unknown().parse(JSON.parse(c.stdin)),
  }));

describe('abe improve retro on a file log store, fake gh and claude -p', () => {
  let w: World;
  let watch: Watching;
  const retro = async (...argv: string[]) => {
    const out = await w.abe.jsonWith({ cwd: w.repo }, RetroData, 'improve', 'retro', ...argv);

    if (!out.doc.ok) throw new Error(`retro refused: ${JSON.stringify(out.doc.error)}`);

    return out.doc.data;
  };
  // as a pull request: written into the checkout is the default
  const make = async (n: string) => {
    const out = await w.abe.jsonWith(
      { cwd: w.repo },
      RetroMakeData,
      'improve',
      'retro',
      'make',
      n,
      '--pr',
    );

    if (!out.doc.ok) throw new Error(`make refused: ${JSON.stringify(out.doc.error)}`);

    return out.doc.data;
  };

  beforeAll(async () => {
    w = await world();
    scriptOneShot(w.abe.state.dir, {
      answers: [ME, NONE, 'Nothing stood out to me.', ME],
    });
    watch = watching(w.abe.state.socket);
  });

  afterAll(async () => {
    watch.close();
    await w.abe.close();
    w.gh.remove();
    w.claude.remove();
    rmSync(w.root, { recursive: true, force: true });
  });

  test('me: only your own prefix; findings most severe first, each traced to real lines', async () => {
    const r = await retro('me');

    expect(r).toMatchObject({
      scope: 'me',
      repo: 'o/shop',
      login: 'octocat',
      since: null,
      prefixes: ['o_shop/octocat/'],
      model: 'opus',
    });
    expect(r.sessions.map((s) => s.session)).toEqual(['4-a1b2']);
    expect(r.findings.map((f) => [f.n, f.severity, f.layer, f.title])).toEqual([
      [1, 'high', 'repo', 'Type errors reach Review'],
      [2, 'medium', 'individual', 'autoMerge lowered for want of checks'],
      [3, 'low', 'repo', 'Take out the old types script'],
    ]);
    expect(r.findings[0]?.moments).toEqual([
      {
        ref: '4-a1b2/checks.md#3',
        session: '4-a1b2',
        file: 'checks.md',
        line: 3,
        text: '- types: red',
      },
      {
        ref: '4-a1b2/pr-comments.md#4',
        session: '4-a1b2',
        file: 'pr-comments.md',
        line: 4,
        text: 'Please run tsc before pushing.',
      },
    ]);
    expect(r.findings[1]?.moments[0]?.text).toContain(
      '- repo · autoMerge = true · reason: no checks yet · in force',
    );
    // Dropped and counted: a line past the file's end, and a session this scope did not read.
    expect(r.dropped).toEqual([
      { title: 'A line that is not there', why: '4-a1b2/checks.md#99: checks.md has 4 lines' },
      { title: 'Someone else’s session', why: '5-c3d4/checks.md#1: no file checks.md in 5-c3d4' },
    ]);
    // The earlier fix recurs: proposed for removal, by finding 3. The open pull request is no fix yet.
    expect(r.earlier).toHaveLength(1);
    expect(r.earlier[0]).toMatchObject({
      pr: 'o/shop#12',
      verdict: 'recurring',
      removal: true,
      removedBy: 3,
    });
    expect(await nextRetroEvent(watch)).toEqual({
      step: 'found',
      retro: r.id,
      scope: 'me',
      repo: 'o/shop',
      sessions: 1,
      findings: 3,
      dropped: 2,
      removals: 1,
    });
  });

  test("its pull requests' comments and reviews read as the checkout's logins.gh", () => {
    const read = w.gh
      .calls()
      .filter((c) => /issues\/21\/comments|pulls\/21\/reviews/.test(c.argv.join(' ')));

    expect(read.length).toBeGreaterThan(0);
    for (const c of read) expect(c.env.GH_TOKEN).toBe(FAKE_GITHUB_TOKEN);
  });

  test('the one-shot: the retro skill, a writer’s model, only the scope’s sessions in the prompt', () => {
    const [call] = oneShotCalls(w.abe.state.dir);

    if (call === undefined) throw new Error('no one-shot');
    expect(call.argv.slice(0, 3)).toEqual(['-p', '--model', 'opus']);
    expect(call.argv.at(-1)).toBe(RETRO_SKILL);
    expect(call.cwd).toBe(realpathSync(w.repo));
    expect(call.prompt).toContain('### 4-a1b2/checks.md (4 lines)\n\n    1  # Checks');
    expect(call.prompt).toContain(
      '    4    Please run tsc before pushing.\n    5  - 2026-10-20T12:00:00Z sam review CHANGES_REQUESTED:\n    6    Types fail.',
    );
    expect(call.prompt).toContain('- o/shop#12 merged 2026-10-02T09:00:00.000Z');
    expect(call.prompt).toContain('### settings.yaml\n\n```\noverrides:');
    expect(call.prompt).not.toContain('5-c3d4');
    expect(call.prompt).not.toContain('6-e5f6');
  });

  test('make: the repo finding is one pull request on o/shop under .abe/, naming the retro and its sessions', async () => {
    const before = w.gh.calls().length;
    const made = await make('1');

    expect(made).toMatchObject({
      finding: 1,
      layer: 'repo',
      result: 'opened',
      made: {
        kind: 'pr',
        pr: 'o/shop#71',
        url: 'https://github.com/o/shop/pull/71',
        files: ['abe.yaml'],
      },
    });
    if (made.made?.kind !== 'pr') throw new Error('no pull request');
    expect(made.made.branch).toMatch(/^abe\/retro-\d{12}-[0-9a-f]{4}-1$/);
    const calls = ghCalls(w.gh).slice(before);
    const tree = calls.find((c) => c.args.includes('-X POST repos/o/shop/git/trees'));
    const pull = calls.find((c) => c.args.includes('-X POST repos/o/shop/pulls'));

    expect(tree?.input).toEqual({
      base_tree: 'base-tree',
      tree: [
        {
          path: 'abe.yaml',
          mode: '100644',
          type: 'blob',
          content: 'checks: [tests, types]\n',
        },
      ],
    });
    expect(pull?.input).toMatchObject({ head: made.made.branch, base: 'main' });
    const body = z.object({ title: z.string(), body: z.string() }).parse(pull?.input);

    expect(body.title).toMatch(
      /^Type errors reach Review \(improve retro \d{4}-\d\d-\d\d, finding 1\)$/,
    );
    expect(body.body).toContain(`Improve retro ${made.retro} (me (octocat in o/shop)`);
    expect(body.body).toContain('Sessions: 4-a1b2');
    expect(body.body).toContain('- `4-a1b2/checks.md#3`: - types: red');
    expect(body.body).toContain('Recurring of o/shop#12.');
    expect(calls.filter((c) => c.args.includes('-X POST repos/o/shop/pulls'))).toHaveLength(1);
    expect(
      calls.find((c) => c.args.includes('-X POST repos/o/shop/issues/71/labels'))?.input,
    ).toEqual({
      labels: ['abe-retro'],
    });
    expect(await nextRetroEvent(watch)).toEqual({
      step: 'made',
      retro: made.retro,
      finding: 1,
      layer: 'repo',
      made: 'o/shop#71',
    });
  });

  test('make again: the same pull request, nothing opened', async () => {
    const before = w.gh.calls().length;

    expect(await make('1')).toMatchObject({ result: 'already-made', made: { pr: 'o/shop#71' } });
    expect(w.gh.calls().length).toBe(before);
  });

  test('the removal of a recurring fix is a pull request too: its file removed', async () => {
    w.gh.answer(answers({ shopPull: 72 }));
    const before = w.gh.calls().length;

    expect(await make('3')).toMatchObject({
      result: 'opened',
      made: { pr: 'o/shop#72', files: ['.claude/skills/run-app/scripts/old-types.sh'] },
    });
    const tree = ghCalls(w.gh)
      .slice(before)
      .find((c) => c.args.includes('-X POST repos/o/shop/git/trees'));

    expect(tree?.input).toMatchObject({
      tree: [
        {
          path: '.claude/skills/run-app/scripts/old-types.sh',
          mode: '100644',
          type: 'blob',
          sha: null,
        },
      ],
    });
  });

  test('a personal finding becomes an abe improve proposal, no pull request; apply writes it', async () => {
    const before = w.gh.calls().length;
    const made = await make('2');

    expect(made).toMatchObject({
      layer: 'individual',
      result: 'proposed',
      made: { kind: 'proposal', files: ['skills/merge-note/SKILL.md'] },
    });
    expect(w.gh.calls().length).toBe(before);
    if (made.made?.kind !== 'proposal') throw new Error('no proposal');
    expect(made.made.id).toMatch(/^imp-[0-9a-f]{6}$/);
    // Nothing written yet: your Layer changes only by abe improve apply.
    expect(existsSync(join(w.root, 'mine', 'skills', 'merge-note', 'SKILL.md'))).toBe(false);
    const applied = await w.abe.jsonWith(
      { cwd: w.repo },
      ImproveApplyData,
      'improve',
      'apply',
      made.made.id,
    );

    expect(applied.doc.ok).toBe(true);
    expect(readFileSync(join(w.root, 'mine', 'skills', 'merge-note', 'SKILL.md'), 'utf8')).toBe(
      '# Merge note\n',
    );
    expect(await make('2')).toMatchObject({ result: 'already-made', made: { id: made.made.id } });
  });

  test('make refuses a finding the last retro does not have', async () => {
    const out = await w.abe.jsonWith(
      { cwd: w.repo },
      RetroMakeData,
      'improve',
      'retro',
      'make',
      '9',
    );

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-finding' } });
  });

  test('again: nothing moved since the last me retro, so nothing is asked and the last retro stands', async () => {
    const r = await retro('me');

    expect(r.sessions).toEqual([]);
    expect(r.since).not.toBeNull();
    expect(oneShotCalls(w.abe.state.dir)).toHaveLength(1);
    const last = await w.abe.jsonWith({ cwd: w.repo }, RetroRecord, 'improve', 'retro', 'last');

    expect(last.doc).toMatchObject({
      ok: true,
      data: { scope: 'me', checkout: realpathSync(w.repo) },
    });
    if (!last.doc.ok) throw new Error('no last retro');
    expect(last.doc.data.findings.map((f) => f.made?.kind ?? null)).toEqual([
      'pr',
      'proposal',
      'pr',
    ]);
  });

  test('a pull request gh cannot read: its comments unread, the rest read', async () => {
    session(w.store, {
      repo: 'o_shop',
      user: 'octocat',
      id: '7-a7b8',
      card: 7,
      since: '2026-10-22T10:00:00.000Z',
      // Another org's repo, which this person cannot read.
      files: {
        'checks.md': CHECKS,
        'run.json': `${JSON.stringify({ pr: { repo: 'o/secret', number: 3 } }, null, 2)}\n`,
      },
    });
    const r = await retro('me', '--since', '2026-10-21T00:00:00.000Z');

    expect(r.sessions.map((s) => s.session)).toEqual(['7-a7b8']);
    expect(r.findings).toEqual([]);
    expect(r.unread.map((u) => u.source)).toEqual(['7-a7b8/pr-comments.md']);
    expect(r.unread[0]?.why).toContain('o/secret#3');
  });

  test('org is no scope any more (ADR 0030): refused as a value it does not take', async () => {
    const out = await w.abe.jsonWith({ cwd: w.repo }, RetroData, 'improve', 'retro', 'org');

    expect(out.doc.ok).toBe(false);
  });

  test('an answer that is no findings is retro-unreadable, its text kept', async () => {
    const out = await w.abe.jsonWith(
      { cwd: w.repo },
      RetroData,
      'improve',
      'retro',
      'me',
      '--since',
      '2026-01-01T00:00:00Z',
    );

    expect(out.exit).toBe(1);
    expect(out.doc).toMatchObject({ ok: false, error: { code: 'retro-unreadable' } });
  });

  test('local mode: the sessions kept on this Mac (<state>/local/logs), never the log store', async () => {
    const on = await w.abe.jsonWith({ cwd: w.repo }, LocalSetData, 'local', 'on');

    expect(on.doc.ok).toBe(true);
    session(join(w.abe.state.dir, 'local', 'logs'), {
      repo: 'o_shop',
      user: 'octocat',
      id: '9-l0c4',
      card: 9,
      since: '2026-10-25T10:00:00.000Z',
      files: { 'checks.md': CHECKS },
    });
    const r = await retro('me', '--since', '2026-10-01T00:00:00.000Z');

    expect(r.sessions.map((x) => x.session)).toEqual(['9-l0c4']);
    await w.abe.jsonWith({ cwd: w.repo }, LocalSetData, 'local', 'off');
  });
});

describe('abe improve retro on a bare state, the real abe', () => {
  // no stores.logs: the Mac's own folder in Abe's state is the store, so only the checkout stops it
  test('retro: a log store by default; outside a GitHub checkout, exit 1, no-origin', async () => {
    const abe = cli();

    try {
      const out = await abe.json(RetroData, 'improve', 'retro', 'me');

      expect(out.exit).toBe(1);
      expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-origin' } });
    } finally {
      await abe.close();
    }
  });
});
