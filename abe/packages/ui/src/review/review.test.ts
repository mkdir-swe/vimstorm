/**
 * The PR review's screen in the `review` slot (1.x's `crates/abe-core/tests/changes_pane.rs` and
 * `changes.rs`' heat and stepping tables): the pane read with `abe review show`, the files by size
 * (no ranking: heat falls back to size order), ⏎ stepping change by change into VimStorm's diff,
 * Space marking at once, the diff's `,i` keys as `abe review …` writes with their answer as a
 * balloon there, the Log's scope, the strip, the menu, the lifecycle rows and the PR pick.
 */
import { describe, expect, test } from 'bun:test';
import type { ChangedFile, Drafts, RangeCommit, ReviewShowData, Thread } from '@abe/core';
import { changed, reviewPr, reviewShow } from '@abe/testing';
import type { ReviewAsk } from './review-asks';
import type { ReviewPaneProps } from './review-components';
import { type Answer, type Command, type Input, step } from '../runtime/runtime';

/** A command's answer as a test gives it: the run's id is the one it asked. */
type Reply = Answer extends infer A ? (A extends Answer ? Omit<A, 'id' | 'kind'> : never) : never;
import { lifecycleRows, reviewScreen, type ReviewState } from './review';

const TREE = '/work/shop-pr-7';
const BASE = 'base000';
const HEAD = 'c0ffee1234';
const SIZE = { width: 600, height: 400 };

const sized = (path: string, lines: number): ChangedFile =>
  changed(
    path,
    `@@ -3,${lines} +3,${lines} @@\n${Array.from({ length: lines }, (_, i) => `-a${i}\n+b${i}\n`).join('')}`,
    { additions: lines, deletions: lines },
  );

const FILES = (): ChangedFile[] => [
  sized('src/big.ts', 9),
  sized('src/small.ts', 1),
  changed('package-lock.json', '@@ -1 +1 @@\n-a\n+b'),
];

const commitFile = (path: string, adds: number, line: number) => ({
  path,
  additions: adds,
  deletions: 0,
  binary: false,
  patch: `@@ -${line},0 +${line},${adds} @@\n${Array.from({ length: adds }, (_, i) => `+n${i}\n`).join('')}`,
});

/** Three commits, oldest first: big.ts; small.ts; big.ts again. */
const THREE: RangeCommit[] = [
  {
    sha: 'aaaa1111',
    subject: 'Add the client',
    author: 'Ada',
    date: '2026-10-20T09:00:00Z',
    files: [commitFile('src/big.ts', 4, 3)],
  },
  {
    sha: 'bbbb2222',
    subject: 'Guard the flag',
    author: 'Ada',
    date: '2026-10-20T09:00:00Z',
    files: [commitFile('src/small.ts', 1, 3)],
  },
  {
    sha: 'cccc3333',
    subject: 'Tests',
    author: 'Ada',
    date: '2026-10-20T09:00:00Z',
    files: [commitFile('src/big.ts', 2, 9)],
  },
];

type Driven = {
  state: ReviewState;
  commands: Command[];
  props: () => ReviewPaneProps;
  send: (...inputs: Input[]) => Driven;
  ask: (ask: ReviewAsk) => Driven;
  keys: (...keys: string[]) => Driven;
  /** The run asked last whose argv starts `abe review <verb>` (or `<noun> <verb>`). */
  ran: (...lead: string[]) => { id: string; argv: string[] };
  answer: (reply: Reply, lead?: string[]) => Driven;
  refuse: (lead: string[], code: string, message: string) => Driven;
  effects: () => { kind: string; [k: string]: unknown }[];
};

const drive = (
  show: ReviewShowData = reviewShow({ files: FILES() }),
  params: Record<string, string> = {},
): Driven => {
  let state: ReviewState = reviewScreen.init;
  let commands: Command[] = [];
  let all: Command[] = [];
  const d: Driven = {
    get state() {
      return state;
    },
    get commands() {
      return commands;
    },
    props: () => {
      const tree = reviewScreen.view(state);

      if (tree.kind !== 'ReviewPane') throw new Error(`no ReviewPane: ${tree.kind}`);

      return tree.props;
    },
    send: (...inputs) => {
      for (const input of inputs) {
        const next = step(reviewScreen, state, input);

        state = next.state;
        commands = next.commands;
        all = [...all, ...next.commands];
      }

      return d;
    },
    ask: (ask) => d.send({ kind: 'review', ask }),
    keys: (...keys) => d.send(...keys.map((key): Input => ({ kind: 'key', key }))),
    ran: (...lead) => {
      const found = [...all]
        .reverse()
        .find((c) => c.kind === 'run' && lead.every((w, i) => c.argv[i] === w));

      if (found?.kind !== 'run')
        throw new Error(`no run ${lead.join(' ')}: ${JSON.stringify(all)}`);

      return found;
    },
    answer: (reply, lead) => {
      const r = d.ran(...(lead ?? reply.command.split(' ')));

      return d.send({ ...reply, kind: 'result', id: r.id });
    },
    refuse: (lead, code, message) => {
      const r = d.ran(...lead);

      return d.send({
        kind: 'result',
        id: r.id,
        command: null,
        reply: { ok: false, error: { code, message } },
      });
    },
    effects: () => commands.flatMap((c) => (c.kind === 'shell' ? [{ ...c.effect }] : [])),
  };

  d.send({ kind: 'open', params: { pr: '7', path: TREE, list: 'folder', ...params }, size: SIZE });
  d.answer({ command: 'review show', reply: { ok: true, data: show } });

  return d;
};

/** The pane's lines as 1.x's frame said them: `>` the cursor, `▾ src/ (2)`, `· big.ts +9 −9 ✓`. */
const listed = (d: Driven) =>
  d.props().lines.map((l, i) => {
    const cursor = d.props().at === i ? '>' : ' ';

    if (l.kind === 'node')
      return `${cursor}${'  '.repeat(l.depth)}${l.open ? '▾' : '▸'} ${l.label} (${l.count})${l.reviewed ? ' ✓' : ''}`;
    if (l.kind === 'file')
      return `${cursor}${'  '.repeat(l.depth)}${l.heat} ${l.label} +${l.additions} −${l.deletions}${l.reviewed ? ' ✓' : ''}`;

    return l.kind === 'band' ? ' ──' : '';
  });

const diffs = (d: Driven) => d.effects().filter((e) => e.kind === 'show-diff');

describe('the files and their order', () => {
  test('without ranks the files go by size, the cursor on the biggest not reviewed', () => {
    const d = drive();

    // by folder: every file in its folder, the lockfile too (it is left out of ⏎'s walk)
    expect(listed(d)).toEqual([
      ' ▾ src/ (2 files)',
      '>  · big.ts +9 −9',
      '   · small.ts +1 −1',
      ' 1 package-lock.json +1 −1',
    ]);
    expect(d.props().said).toBe(`3 files · ${TREE}`);
    d.ask({ kind: 'order', heat: true });
    expect(listed(d)).toEqual([
      '>· src/big.ts +9 −9',
      ' · src/small.ts +1 −1',
      '',
      ' ▸ lockfile (1 file · not ranked)',
    ]);
    expect(d.props().heat).toBe(true);
    // a review opened after starts by heat
    d.send({ kind: 'open', params: { pr: '8', path: TREE }, size: SIZE });
    expect(d.state.panes[`${TREE}#8`]?.view.list).toBe('ranked');
  });

  test('a mechanical change and a copy show heat 1; a file reviewed starts the cursor on the next', () => {
    const show = reviewShow({
      files: FILES(),
      marks: { head: HEAD, paths: [], marks: {} },
    });
    const big = show.read.files.find((f) => f.path === 'src/big.ts');
    const d = drive({
      ...show,
      marks: {
        head: HEAD,
        paths: [],
        marks: { 'src/big.ts': { hash: big?.hash ?? '', head: HEAD } },
      },
    });

    expect(listed(d)).toContain('>  · small.ts +1 −1');
    expect(listed(d)).toContain('   · big.ts +9 −9 ✓');
    d.ask({ kind: 'order', heat: true });
    d.keys('ö', 'ö', '<CR>');
    // the lockfile's group opened on ⏎: heat 1 for a mechanical change
    expect(listed(d).at(-1)).toBe('   1 package-lock.json +1 −1');
  });
});

describe('⏎ walks the changes in the diff', () => {
  test('the next change at its line, file after file, the folded group left out', () => {
    const d = drive();

    d.keys('<CR>');
    expect(diffs(d)).toEqual([
      {
        kind: 'show-diff',
        root: TREE,
        files: [
          { path: 'src/big.ts', status: 'M' },
          { path: 'src/small.ts', status: 'M' },
        ],
        index: 1,
        base: BASE,
        head: HEAD,
        line: 3,
        pr: { number: 7, head: HEAD },
      },
    ]);
    d.keys('<CR>');
    expect(diffs(d)).toMatchObject([{ index: 2, line: 3 }]);
    d.keys('<CR>');
    expect(d.effects()).toEqual([{ kind: 'status', text: 'The last change of the last file' }]);
  });

  test('a node folds on ⏎; ←→ fold and go up; a click puts the cursor there, a double click steps in', () => {
    const d = drive();

    d.keys('l', '<CR>');
    expect(listed(d)).toEqual(['>▸ src/ (2 files)', ' 1 package-lock.json +1 −1']);
    d.keys('ä', 'ö', 'ö', 'k');
    expect(listed(d)[0]).toBe('>▾ src/ (2 files)');
    d.ask({ kind: 'at', line: 2 });
    expect(listed(d)[2]).toBe('>  · small.ts +1 −1');
    d.ask({ kind: 'at', line: 99 });
    expect(listed(d)[2]).toBe('>  · small.ts +1 −1');
    d.ask({ kind: 'at', line: 1, open: true });
    expect(diffs(d)).toMatchObject([{ index: 1, line: 3 }]);
  });

  test('`,in`: the next file by heat not reviewed, said in the diff when none is left', () => {
    const d = drive();

    d.ask({ kind: 'next' });
    expect(diffs(d)).toMatchObject([{ index: 2, line: 3 }]);
  });

  test('not checked out: the files from GitHub, ⏎ cannot open them', () => {
    const d = drive(
      reviewShow({ files: FILES(), unchecked: 'worktree locked', path: '/work/shop' }),
      {
        path: '/work/shop',
        unchecked: 'worktree locked',
      },
    );

    expect(d.props().said).toBe(
      '3 files · not checked out (worktree locked): files from GitHub, ⏎ cannot open them',
    );
    d.keys('<CR>');
    expect(diffs(d)).toEqual([]);
    expect(d.effects()).toEqual([
      { kind: 'status', text: 'Not checked out here: ⏎ cannot open the diff' },
    ]);
  });
});

describe('marks', () => {
  test('Space marks the cursor reviewed at once; a failed write takes it back', () => {
    const d = drive();

    d.keys('<Space>');
    // marked at once; the cursor goes on to the next file not reviewed
    expect(listed(d)).toContain('   · big.ts +9 −9 ✓');
    expect(d.ran('review', 'mark').argv).toEqual([
      'review',
      'mark',
      '7',
      `--path=${TREE}`,
      '--file=src/big.ts',
    ]);
    expect(d.effects()).toEqual([{ kind: 'status', text: '✓ big.ts' }]);
    d.refuse(['review', 'mark'], 'review-failed', 'disk full');
    expect(listed(d)).toContain('>  · big.ts +9 −9');
    expect(d.effects()).toEqual([{ kind: 'status', text: '✗ disk full' }]);
    // the diff's Reviewed tick marks its file
    d.ask({ kind: 'mark', path: 'src/small.ts' });
    expect(d.ran('review', 'mark').argv.at(-1)).toBe('--file=src/small.ts');
  });

  test('an earlier mark failing late leaves the later one shown', () => {
    const d = drive();

    d.keys('<Space>');
    const first = d.ran('review', 'mark');

    d.ask({ kind: 'mark', path: 'src/small.ts' });
    d.send({
      kind: 'result',
      id: first.id,
      command: null,
      reply: { ok: false, error: { code: 'review-failed', message: 'disk full' } },
    });
    expect(listed(d)).toContain('   · big.ts +9 −9 ✓');
    expect(listed(d).some((l) => l.includes('small.ts') && l.endsWith('✓'))).toBe(true);
  });

  test('on a node: all its files reviewed, then back to review', () => {
    const d = drive();

    d.keys('l', '<Space>');
    expect(d.effects()).toEqual([{ kind: 'status', text: '✓ 2 files in src/ reviewed' }]);
    expect(listed(d)[0]).toBe('>▾ src/ (2 files) ✓');
  });
});

const drafted = (): Drafts => ({
  at: 1,
  drafts: [
    {
      seq: 1,
      path: 'src/small.ts',
      line: { side: 'RIGHT', line: 3 },
      body: 'Guard this?',
      head: HEAD,
    },
  ],
});

describe("the diff's `,i` keys", () => {
  test('a comment kept as a draft: its answer in the diff, the file and strip count it', () => {
    const d = drive();

    d.ask({
      kind: 'comment',
      path: 'src/small.ts',
      side: 'RIGHT',
      line: 3,
      body: 'Guard this?',
      base: BASE,
      head: HEAD,
    });
    expect(d.ran('review', 'draft').argv).toEqual([
      'review',
      'draft',
      '7',
      `--path=${TREE}`,
      '--file=src/small.ts',
      '--side',
      'RIGHT',
      '--line',
      '3',
      '--body=Guard this?',
      '--base',
      BASE,
      '--head',
      HEAD,
    ]);
    const said = '✎ Draft on small.ts:3 · ,is submits 1 draft in one review';

    d.answer({ command: 'review draft', reply: { ok: true, data: { drafts: drafted(), said } } });
    expect(d.effects()).toEqual([
      { kind: 'status', text: said },
      { kind: 'review-said', root: TREE, text: said, tone: 'ok' },
    ]);
    expect(d.props().drafted).toEqual([
      {
        seq: 1,
        path: 'src/small.ts',
        side: 'RIGHT',
        line: 3,
        body: 'Guard this?',
        head: HEAD,
        outdated: false,
      },
    ]);
    expect(
      d.props().lines.find((l) => l.kind === 'file' && l.path === 'src/small.ts'),
    ).toMatchObject({ drafts: 1, outdated: false });
    expect(d.props().strip?.filesLabel).toBe('3 files · 0 reviewed · 1 draft');
    expect(d.props().said).toBe(`3 files · ${TREE} · ✎ 1 draft`);
  });

  test('a refusal is said in the diff in its tone, the drafts read again; the same twice said twice', () => {
    const d = drive();
    const off: ReviewAsk = {
      kind: 'comment',
      path: 'src/small.ts',
      side: 'RIGHT',
      line: 40,
      body: 'x',
      base: BASE,
      head: HEAD,
    };
    const why =
      "Line 40 of small.ts is not in the PR's diff: GitHub takes comments on its lines only";

    d.ask(off).refuse(['review', 'draft'], 'review-refused', why);
    expect(d.effects()).toEqual([
      { kind: 'status', text: why },
      { kind: 'review-said', root: TREE, text: why, tone: 'warn' },
    ]);
    expect(d.ran('review', 'drafts').argv).toEqual(['review', 'drafts', '7', `--path=${TREE}`]);
    d.ask(off).refuse(['review', 'draft'], 'review-refused', why);
    expect(d.effects()).toContainEqual({
      kind: 'review-said',
      root: TREE,
      text: why,
      tone: 'warn',
    });
  });

  test('the verdict goes on the head read; the PR read again once sent', () => {
    const d = drive(reviewShow({ files: FILES(), drafts: drafted() }));

    d.ask({ kind: 'verdict', verdict: 'APPROVE', body: '' });
    expect(d.effects()).toEqual([{ kind: 'status', text: "Reading PR #7's head…" }]);
    expect(d.ran('review', 'submit').argv).toEqual([
      'review',
      'submit',
      '7',
      `--path=${TREE}`,
      '--verdict',
      'approve',
      '--body=',
      '--read',
      HEAD,
    ]);
    const sent: Drafts = {
      ...drafted(),
      drafts: drafted().drafts.map((x) => ({ ...x, sent: HEAD })),
    };

    d.answer({
      command: 'review submit',
      reply: {
        ok: true,
        data: {
          drafts: sent,
          said: '✓ Approve sent to PR #7, 1 comment in one review',
        },
      },
    });
    expect(d.effects()).toContainEqual({
      kind: 'review-said',
      root: TREE,
      text: '✓ Approve sent to PR #7, 1 comment in one review',
      tone: 'ok',
    });
    expect(d.commands.some((c) => c.kind === 'run' && c.argv[1] === 'show')).toBe(true);
    expect(d.props().drafted).toEqual([]);
  });

  test('an outdated draft blocks Submit review; a rewrite deletes it once the new one is kept', () => {
    const old: Drafts = {
      at: 1,
      drafts: [
        {
          ...(drafted().drafts[0] ?? {
            seq: 1,
            path: '',
            line: { side: 'RIGHT', line: 1 },
            body: '',
          }),
          head: 'old0000',
        },
      ],
    };
    const d = drive(reviewShow({ files: FILES(), drafts: old }));

    expect(d.props().strip).toMatchObject({
      outdated: 1,
      canSubmit: false,
      filesLabel: '✗ 1 outdated draft blocks Submit review',
    });
    expect(d.props().said).toBe(`3 files · ${TREE} · 1 outdated draft comments kept · ✎ 1 draft`);
    d.ask({
      kind: 'comment',
      path: 'src/small.ts',
      side: 'RIGHT',
      line: 3,
      body: 'Again',
      base: BASE,
      head: HEAD,
      replaces: 1,
    });
    d.answer({
      command: 'review draft',
      reply: {
        ok: true,
        data: {
          drafts: {
            at: 2,
            drafts: [
              ...old.drafts,
              {
                seq: 2,
                path: 'src/small.ts',
                line: { side: 'RIGHT', line: 3 },
                body: 'Again',
                head: HEAD,
              },
            ],
          },
          said: 'kept',
        },
      },
    });
    expect(d.ran('review', 'drop-draft').argv).toEqual([
      'review',
      'drop-draft',
      '7',
      `--path=${TREE}`,
      '--seq',
      '1',
    ]);
  });

  test('reply, resolve, edit and delete are writes; a reply kept with why says so over the files', () => {
    const thread: Thread = {
      id: 'T1',
      path: 'src/small.ts',
      side: 'LEFT',
      line: 3,
      start: 2,
      head: HEAD,
      outdated: false,
      resolved: false,
      canReply: true,
      canResolve: false,
      comments: [{ id: 90, author: 'bob', body: 'Why?', url: 'u' }],
    };
    const d = drive(
      reviewShow({
        files: FILES(),
        threads: [thread],
        drafts: {
          drafts: [],
          reply: {
            id: 'r1',
            thread: 'T1',
            comment_id: 90,
            body: 'Because',
            attempted: true,
            confirmed: false,
            error: 'Connection lost',
          },
        },
      }),
    );

    expect(d.props().said).toBe('Reply retained in Discussions: Connection lost');
    expect(d.props().threads[0]?.reply).toEqual({
      body: 'Because',
      unconfirmed: true,
      error: 'Connection lost',
    });
    expect(d.props().strip?.threads).toEqual({ label: '1 thread · 1 open', open: true });
    d.ask({ kind: 'reply', thread: 'T1', body: 'Because' });
    expect(d.ran('review', 'reply').argv.slice(4)).toEqual(['--thread', 'T1', '--body=Because']);
    d.ask({ kind: 'resolve', thread: 'T1', resolved: false });
    expect(d.ran('review', 'resolve').argv.slice(4)).toEqual(['--thread', 'T1', '--reopen']);
    d.ask({ kind: 'edit', seq: 3, body: 'Sharper' });
    expect(d.ran('review', 'edit-draft').argv.slice(4)).toEqual(['--seq', '3', '--body=Sharper']);
    d.ask({ kind: 'delete', seq: 3 });
    expect(d.ran('review', 'drop-draft').argv.slice(4)).toEqual(['--seq', '3']);
  });

  test('unavailable discussions are said over the files', () => {
    const d = drive(reviewShow({ files: FILES(), threads: null }));

    expect(d.props().threadsNote).toBe('Discussions unavailable: Review permission denied');
  });
});

describe('the Log: the scope and the strip', () => {
  const log = () =>
    drive(
      reviewShow({
        files: FILES(),
        commits: THREE,
        pr: { checks: { total: 1, passed: 1, failed: 0, failing: [], running: false } },
      }),
    );

  test('the strip names the PR, its checks and scope', () => {
    const strip = log().props().strip;

    expect(strip).toMatchObject({
      number: 7,
      badge: 'open',
      checks: { label: '✓ 1 check', hue: 'good' },
      threads: null,
      scope: { kind: 'all' },
      scopeLabel: 'All changes',
      scopeSub: '3 commits',
      filesLabel: '3 files · 0 reviewed',
      baseSha: BASE,
      headSha: HEAD,
      canSubmit: true,
      own: false,
    });
    expect(drive(reviewShow({ files: FILES(), pr: { author: 'ada' } })).props().strip?.own).toBe(
      true,
    );
  });

  test('one commit picked scopes the files and the diff to it; a range sums them', () => {
    const d = log();

    d.ask({ kind: 'scope', commits: ['bbbb2222'] });
    expect(d.props().strip).toMatchObject({
      scope: { kind: 'commit', place: 2, sha: 'bbbb2222' },
      switchLabel: 'Commit 2/3 · bbbb2222',
    });
    expect(
      d
        .props()
        .lines.flatMap((l) =>
          l.kind === 'file' ? [`${l.path} +${l.additions} −${l.deletions}`] : [],
        ),
    ).toEqual(['src/small.ts +1 −0']);
    d.keys('<CR>');
    expect(diffs(d)).toMatchObject([{ base: 'bbbb2222^', head: 'bbbb2222' }]);
    d.ask({ kind: 'scope', commits: ['cccc3333', 'aaaa1111'] });
    expect(d.props().strip).toMatchObject({
      scope: { kind: 'range', from: 1, to: 3 },
      scopeLabel: 'Commits 1–3 of 3',
      scopeSub: 'aaaa1111…cccc3333',
      files: 2,
    });
    expect(
      d
        .props()
        .lines.flatMap((l) =>
          l.kind === 'file' ? [`${l.path} +${l.additions} −${l.deletions}`] : [],
        )
        .sort(),
    ).toEqual(['src/big.ts +6 −0', 'src/small.ts +1 −0']);
    d.keys('<CR>');
    expect(diffs(d)).toMatchObject([{ base: 'aaaa1111^', head: 'cccc3333' }]);
    d.ask({ kind: 'scope', commits: [] });
    expect(d.props().strip?.scope).toEqual({ kind: 'all' });
  });

  test("the strip's ‹ › step through the commits; the diff's switch rescopes and shows the file", () => {
    const d = log();

    d.ask({ kind: 'step', dir: 1 });
    expect(d.props().strip?.scope).toMatchObject({ kind: 'commit', place: 1 });
    d.ask({ kind: 'step', dir: -1 });
    expect(d.props().strip?.scope).toEqual({ kind: 'all' });
    d.ask({ kind: 'step', dir: -1 });
    expect(d.props().strip?.scope).toEqual({ kind: 'all' });
    d.ask({ kind: 'rescope', commits: ['cccc3333'], path: 'src/big.ts' });
    expect(diffs(d)).toMatchObject([{ base: 'cccc3333^', head: 'cccc3333', line: 9 }]);
  });
});

describe("GitHub's changes", () => {
  test('the shown PR polls `review pr`; a change reads it all again, its new comments said till a key', () => {
    const T0 = Date.parse('2026-11-01T10:00:00Z');
    const at = (ms: number): Input => ({ kind: 'tick', at: new Date(T0 + ms).toISOString() });
    const comment = (id: number) => ({ id, author: 'bob', body: `c${id}`, url: 'u' });
    const thread = (ids: number[]): Thread => ({
      id: 'T1',
      path: 'src/small.ts',
      side: 'RIGHT',
      line: 3,
      start: null,
      head: HEAD,
      outdated: false,
      resolved: false,
      canReply: true,
      canResolve: false,
      comments: ids.map(comment),
    });
    const show = (updatedAt: string, ids: number[], running = false) =>
      reviewShow({
        files: FILES(),
        threads: [thread(ids)],
        pr: {
          updatedAt,
          checks: { total: 2, passed: 0, failed: 1, failing: ['lint'], running },
        },
      });
    const d = drive(show('u1', [90]));
    const polls = () => d.commands.flatMap((c) => (c.kind === 'run' ? [c.argv.slice(0, 3)] : []));

    // the first tick starts the count; none before POLL_MS (45 s)
    d.send(at(0));
    expect(polls()).toEqual([]);
    d.send(at(30_000));
    expect(polls()).toEqual([]);
    d.send(at(46_000));
    expect(d.ran('review', 'pr').argv).toEqual(['review', 'pr', '7', `--path=${TREE}`]);
    // nothing moved: no read, the checks as they are now (a running one said beside the failure)
    d.answer({
      command: 'review pr',
      reply: { ok: true, data: { pr: show('u1', [90], true).pr } },
    });
    expect(polls()).toEqual([]);
    expect(d.props().strip?.checks?.label).toBe('✗ 1 failed · ● 1 running');
    // moved: the whole PR read again; its new comments counted
    d.send(at(92_000));
    d.answer({ command: 'review pr', reply: { ok: true, data: { pr: show('u2', [90]).pr } } });
    expect(d.ran('review', 'show').argv[2]).toBe('7');
    d.answer({ command: 'review show', reply: { ok: true, data: show('u2', [90, 91, 92]) } });
    expect(d.props().strip?.fresh).toBe('2 new');
    // a key in the pane: seen
    d.keys('ö');
    expect(d.props().strip?.fresh).toBeNull();
    // `r` reads again at once; so does the same PR shown again
    d.keys('r');
    expect(polls()).toEqual([['review', 'show', '7']]);
    d.answer({ command: 'review show', reply: { ok: true, data: show('u2', [90, 91, 92]) } });
    d.send({ kind: 'open', params: { pr: '7', path: TREE, list: 'folder' }, size: SIZE });
    expect(polls()).toEqual([['review', 'show', '7']]);
  });
});

describe("the PR's conversation", () => {
  test('comments and verdicts under the description with how long ago; who decided in the strip; Comment posts and reads again', () => {
    const d = drive(
      reviewShow({
        files: FILES(),
        pr: {
          conversation: [
            { kind: 'approved', author: 'ada', body: '', at: '2026-11-01T07:00:00Z' },
            { kind: 'comment', author: 'bob', body: 'Ship it?', at: '2026-11-01T09:55:00Z' },
            { kind: 'changes', author: 'cy', body: 'One nit', at: '2026-11-01T09:59:30Z' },
          ],
        },
      }),
    );

    d.send({ kind: 'tick', at: '2026-11-01T10:00:00Z' });
    expect(d.props().conversation).toEqual([
      { kind: 'approved', author: 'ada', body: '', when: '3 h ago' },
      { kind: 'comment', author: 'bob', body: 'Ship it?', when: '5 min ago' },
      { kind: 'changes', author: 'cy', body: 'One nit', when: 'just now' },
    ]);
    expect(d.props().strip?.reviews).toEqual({
      label: '✓ ada approved · ✗ cy requested changes',
      hue: 'bad',
    });
    d.ask({ kind: 'say', body: '  ' });
    expect(d.commands).toEqual([]);
    d.ask({ kind: 'say', body: 'Thanks, fixed in the next push' });
    expect(d.ran('review', 'say').argv).toEqual([
      'review',
      'say',
      '7',
      `--path=${TREE}`,
      '--body=Thanks, fixed in the next push',
    ]);
    d.answer({
      command: 'review say',
      reply: { ok: true, data: { said: 'Comment posted on PR #7' } },
    });
    expect(d.ran('review', 'show').argv[2]).toBe('7');
    expect(d.effects()).toContainEqual({ kind: 'status', text: 'Comment posted on PR #7' });
  });

  test("the checks chip: the Pipelines tab on the PR branch's newest run", () => {
    const d = drive(reviewShow({ files: FILES(), pr: { branch: 'feature/cart' } }));

    d.ask({ kind: 'menu', run: 'checks' });
    expect(d.commands).toEqual([
      {
        kind: 'open',
        screen: 'pipelines',
        params: { runBranch: 'feature/cart' },
        slot: 'pane',
      },
      { kind: 'shell', effect: { kind: 'show', place: 'pipelines' } },
    ]);
  });
});

describe('the menus', () => {
  test("the files pane's right-click rows, grey where the row or the read can't take them", () => {
    const d = drive(reviewShow({ files: FILES(), drafts: drafted() }));

    d.ask({ kind: 'at', line: 2 });
    expect(
      d
        .props()
        .menu.map((r) => `${r.key === '' ? r.run : r.key} ${r.label}${r.enabled ? '' : ' (grey)'}`),
    ).toEqual([
      '⏎ Next Change',
      'step-back Previous Change',
      'next Next File by Heat',
      'previous Previous File by Heat',
      'select Mark Reviewed',
      'with-copies Mark Reviewed with Copies',
      'drop Drop Draft',
      'toggle Tree / Areas / Heat',
      'whole Show the Whole PR (grey)',
      'earlier Previous Commit (grey)',
      'later Next Commit (grey)',
      'browser Open on GitHub',
      'refresh Read Again',
    ]);
    d.ask({ kind: 'at', line: 1 });
    expect(d.props().menu.find((r) => r.run === 'drop')?.enabled).toBe(false);
    d.ask({ kind: 'menu', run: 'select' });
    expect(d.ran('review', 'mark').argv.at(-1)).toBe('--file=src/big.ts');
    d.ask({ kind: 'menu', run: 'browser' });
    expect(d.effects()).toEqual([{ kind: 'open-url', url: 'https://github.com/acme/shop/pull/7' }]);
  });

  test('the lifecycle rows are grey with why per state', () => {
    const rows = (pr: Parameters<typeof reviewPr>[0]) =>
      lifecycleRows(reviewPr(pr)).map(
        (r) => `${r.title}${r.reason === null ? '' : ` · ${r.reason}`}`,
      );

    expect(rows({ draft: true, decision: 'required' })).toEqual([
      'Mark ready for review',
      'Merge into main (squash) · needs approval',
      'Merge into main (merge commit) · needs approval',
      'Merge into main (rebase) · needs approval',
      'Close without merging',
    ]);
    expect(rows({ decision: 'approved' })).toEqual([
      'Mark ready for review · already ready for review',
      'Merge into main (squash)',
      'Merge into main (merge commit)',
      'Merge into main (rebase)',
      'Close without merging',
    ]);
    expect(
      rows({
        decision: 'approved',
        checks: { total: 1, passed: 0, failed: 1, failing: ['unit'], running: false },
      })[1],
    ).toBe('Merge into main (squash) · checks failing: unit');
    expect(rows({ state: 'merged' })).toEqual([
      'Mark ready for review · merged',
      'Merge into main (squash) · merged',
      'Merge into main (merge commit) · merged',
      'Merge into main (rebase) · merged',
      'Close without merging · merged',
    ]);
  });

  test('a merge is a risky confirm Command mode asks, on the head read; the PR read again after', () => {
    const d = drive(reviewShow({ files: FILES(), pr: { decision: 'approved' } }));

    d.ask({ kind: 'lifecycle', id: 'merge-squash' });
    expect(d.commands).toEqual([
      {
        kind: 'confirm',
        argv: ['pr', 'merge', 'acme/shop#7', '--method', 'squash', '--sha', HEAD],
        question: 'Merge into main (squash): merge PR #7?',
        details: [
          'Cart totals',
          'feature/cart → main',
          'On its head c0ffee1; repository rules apply.',
        ],
        yes: 'Merge',
        done: 'PR #7 merged into main',
      },
    ]);
    d.send({
      kind: 'event',
      event: {
        seq: 9,
        at: '2026-10-25T10:00:00Z',
        type: 'command.ran',
        data: { noun: 'pr', verb: 'merge', exit: 0 },
      },
    });
    expect(d.commands).toMatchObject([
      { kind: 'run', argv: ['review', 'show', '7', `--path=${TREE}`] },
    ]);
    d.ask({ kind: 'lifecycle', id: 'review-ready' });
    expect(d.effects()).toEqual([{ kind: 'status', text: 'already ready for review' }]);
  });
});

describe("the Log's PR pick", () => {
  test('the open PRs, Mine then Others; a pick checked out and opened for review', () => {
    let state = reviewScreen.init;
    let commands: Command[] = [];
    const send = (input: Input) => {
      const next = step(reviewScreen, state, input);

      state = next.state;
      commands = next.commands;
    };

    send({ kind: 'open', params: { pick: '/work/shop' }, size: SIZE });
    const prs = commands[0];

    expect(prs).toMatchObject({ kind: 'run', argv: ['review', 'prs', '--path=/work/shop'] });
    if (prs?.kind !== 'run') throw new Error('no run');
    send({
      kind: 'result',
      id: prs.id,
      command: 'review prs',
      reply: {
        ok: true,
        data: {
          repo: 'acme/shop',
          me: 'ada',
          prs: [
            {
              number: 7,
              title: 'Cart',
              author: 'bob',
              branch: 'feature/cart',
              draft: false,
              requested: ['ada'],
            },
            {
              number: 9,
              title: 'Mine',
              author: 'ada',
              branch: 'feature/mine',
              draft: true,
              requested: [],
            },
          ],
        },
      },
    });
    expect(commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'pr-pick',
          root: '/work/shop',
          repo: 'acme/shop',
          rows: [
            { caption: 'Mine' },
            { number: 9, label: '#9 Mine   feature/mine', note: 'Draft' },
            { caption: 'Others' },
            { number: 7, label: '#7 Cart   bob', note: 'Review requested' },
          ],
        },
      },
    ]);
    send({ kind: 'review', ask: { kind: 'pick', number: 7 } });
    const open = commands[0];

    expect(open).toMatchObject({
      kind: 'run',
      argv: ['review', 'open', '7', '--path=/work/shop'],
    });
    if (open?.kind !== 'run') throw new Error('no run');
    send({
      kind: 'result',
      id: open.id,
      command: 'review open',
      reply: {
        ok: true,
        data: { repo: 'acme/shop', number: 7, path: '/work/shop-pr-7', unchecked: null },
      },
    });
    expect(commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'review-open',
          path: '/work/shop-pr-7',
          repo: 'acme/shop',
          number: 7,
          unchecked: null,
        },
      },
      { kind: 'shell', effect: { kind: 'status', text: 'PR #7 · VimStorm ← /work/shop-pr-7' } },
    ]);
  });
});

describe('the pane', () => {
  test('reading, then failed: said over the files; none under review draws no pane', () => {
    let state = reviewScreen.init;
    const open = step(reviewScreen, state, {
      kind: 'open',
      params: { pr: '7', path: TREE },
      size: SIZE,
    });

    state = open.state;
    const tree = reviewScreen.view(state);

    expect(tree.kind === 'ReviewPane' && [tree.props.said, tree.props.threadsNote]).toEqual([
      'Reading PR #7…',
      'Loading discussions…',
    ]);
    const run = open.commands[0];

    if (run?.kind !== 'run') throw new Error('no run');
    state = step(reviewScreen, state, {
      kind: 'result',
      id: run.id,
      command: null,
      reply: { ok: false, error: { code: 'review-failed', message: '✗ PR #7: HTTP 404' } },
    }).state;
    const failed = reviewScreen.view(state);

    expect(failed.kind === 'ReviewPane' && [failed.props.said, failed.props.tone]).toEqual([
      '✗ PR #7: HTTP 404',
      'error',
    ]);
    state = step(reviewScreen, state, { kind: 'open', params: {}, size: SIZE }).state;
    expect(reviewScreen.view(state).kind).toBe('Empty');
  });
});
