/**
 * Linked's rows (#109 S1) from the story's parts: the nine rows in order, their words and dim
 * rules, each failed read on its own row, and the live rules (which `abe watch` events change
 * them, the run's facts moved in place).
 */
import { describe, expect, test } from 'bun:test';
import {
  type BoxData,
  type CardShowData,
  Event,
  type FactoryRunData,
  LINKED_KEYS,
  LINKED_PARTS,
  linkedRowText,
  type PrData,
  type SessionData,
  StoryLinkedData,
  storyLinkedText,
  type PipelineRun,
} from '@abe/core';
import {
  cardSheet,
  factoryRun,
  listCard,
  minutes,
  pipelineRun,
  session,
  sheetSummary,
} from '@abe/testing';
import { type LinkedParts, linkedOf, linkedOnEvent } from './linked-rows';

/** What a listed box says beside its name, state, size and workspace (#104), none known here. */
const UNSAID = {
  launchedAt: null,
  release: null,
  repo: null,
  card: null,
  title: null,
  costToday: null,
  serve: null,
} as const;

const STORY = 2;
const TITLE = 'The cart total ignores quantity';
const BRANCH = 'card/2-the-cart-total-ignores-quantity';
const WORKTREE = '/home/ada/projects/demo-shop-wt/2-the-cart-total-ignores-quantity';
const NOW = minutes(21);
const ENV = { now: NOW, home: '/home/ada' };

const ok = <T>(data: T) => ({ ok: true as const, data });
const failed = (error: string) => ({ ok: false as const, error });

const CARD: CardShowData = {
  ...listCard(STORY, TITLE, 'Active', 'Ada Example', { type: 'Bug' }),
  comments: [],
  sheets: [],
};

const RUN: FactoryRunData = factoryRun(STORY, TITLE, 'build', 'needs-you', {
  session: '2-a1b2',
  worktree: WORKTREE,
  since: minutes(0),
});

const SESSION: SessionData = {
  ...session('2-a1b2', 'working', STORY),
  worktree: WORKTREE,
  branch: BRANCH,
  subagents: [0, 1].map((i) => ({
    id: `a${i}`,
    name: 'abe:reader',
    task: null,
    model: null,
    state: 'running' as const,
    startedAt: minutes(1),
    endedAt: null,
    result: null,
  })),
};

const PIPELINE: PipelineRun = {
  ...pipelineRun('7001', 'ci', TITLE, BRANCH, '00:05', 4),
  url: 'https://github.com/mkdir-swe/demo-shop/actions/runs/7001',
  createdAt: minutes(5),
  startedAt: minutes(5),
  finishedAt: minutes(9),
};

/** #2 as the board 3.2 draws it: a local bug in Build, no spec decided, no pull request yet. */
const DEMO: LinkedParts = {
  story: STORY,
  card: ok(CARD),
  run: ok(RUN),
  sessions: ok([SESSION, session('9-c3d4', 'working', 9)]),
  pr: ok(null),
  pipeline: ok(PIPELINE),
  sheets: ok([]),
};

const rows = (parts: LinkedParts) => {
  const data = linkedOf(parts, ENV);

  return Object.fromEntries(data.rows.map((r) => [r.key, r]));
};
const words = (parts: LinkedParts) =>
  Object.fromEntries(
    linkedOf(parts, ENV).rows.map((r) => [
      r.key,
      `${r.dim ? '(dim) ' : ''}${linkedRowText(r, NOW)}`,
    ]),
  );

describe('the nine rows', () => {
  test('#2 reads as board 3.2: every row, in order, Pull request none yet and dim', () => {
    const data = linkedOf(DEMO, ENV);

    expect(StoryLinkedData.parse(data)).toEqual(data);
    expect(data.rows.map((r) => r.key)).toEqual([...LINKED_KEYS]);
    expect(data.rows.map((r) => r.label)).toEqual([
      'Story',
      'Prototype',
      'Spec',
      'Sessions',
      'Pull request',
      'Pipelines',
      'Worktree',
      'Box',
      'Sheets',
    ]);
    expect(words(DEMO)).toEqual({
      story: 'Active · Bug · AE',
      prototype: '(dim) none',
      spec: '(dim) none yet',
      sessions: '1 · Local sandbox · 2 subagents',
      pr: '(dim) none yet',
      pipelines: 'ci ✓ passed on card/2-… · 12 min ago',
      worktree: '~/projects/demo-shop-wt/2-the-cart-total-ignores-quantity',
      box: '(dim) none · Local sandbox',
      sheets: '(dim) none',
    });
    expect(data.title).toBe(TITLE);
    expect(data.run).toMatchObject({ session: '2-a1b2', stage: 'build', sessionState: 'working' });
  });

  test('the text form: the title line, then each row', () => {
    expect(storyLinkedText(linkedOf(DEMO, ENV))).toBe(
      [
        `Linked · #2 ${TITLE}`,
        '  Story         Active · Bug · AE',
        '  Prototype     none',
        '  Spec          none yet',
        '  Sessions      1 · Local sandbox · 2 subagents',
        '  Pull request  none yet',
        '  Pipelines     ci ✓ passed on card/2-… · 12 min ago',
        '  Worktree      ~/projects/demo-shop-wt/2-the-cart-total-ignores-quantity',
        '  Box           none · Local sandbox',
        '  Sheets        none',
        '',
      ].join('\n'),
    );
  });

  test('what each row opens; a dim row opens nothing', () => {
    const r = rows(DEMO);

    expect(r.story?.opens).toEqual({ kind: 'story', card: 2 });
    expect(r.run).toBeUndefined();
    expect(r.sessions?.opens).toEqual({ kind: 'sessions', ids: ['2-a1b2'] });
    expect(r.pipelines?.opens).toEqual({ kind: 'pipeline', id: '7001', url: PIPELINE.url });
    expect(r.worktree?.opens).toEqual({ kind: 'workspace', session: '2-a1b2', path: WORKTREE });
    for (const key of ['spec', 'pr', 'box', 'sheets']) expect(r[key]?.opens).toBeNull();
  });

  test('its one session ended: ⏎ on the row reopens it (#343)', () => {
    const ended = { ...SESSION, state: 'ended' as const };

    expect(rows({ ...DEMO, sessions: ok([ended]) }).sessions?.opens).toEqual({
      kind: 'sessions',
      ids: ['2-a1b2'],
      reopen: '2-a1b2',
    });
    // one that never got a box has nothing to go back into (#246)
    expect(
      rows({ ...DEMO, sessions: ok([{ ...ended, neverPlaced: true }]) }).sessions?.opens,
    ).toEqual({ kind: 'sessions', ids: ['2-a1b2'] });
  });

  test('two ended sessions: ⏎ reopens the one the card is on (its run’s), not the newest (#343)', () => {
    const ended = { ...SESSION, state: 'ended' as const };
    const newer = {
      ...ended,
      id: '2-c3d4',
      startedAt: '2026-10-01T10:00:00.000Z',
      since: '2026-10-01T10:30:00.000Z',
    };

    expect(rows({ ...DEMO, sessions: ok([ended, newer]) }).sessions?.opens).toEqual({
      kind: 'sessions',
      ids: ['2-a1b2', '2-c3d4'],
      reopen: '2-a1b2',
    });
  });

  test('a newer session runs: the older ended one stays listed beside it, nothing reopens (#343)', () => {
    const older = { ...SESSION, id: '2-0001', state: 'ended' as const, subagents: [] };
    const parts = { ...DEMO, sessions: ok([older, SESSION]) };

    expect(rows(parts).sessions?.opens).toEqual({ kind: 'sessions', ids: ['2-a1b2', '2-0001'] });
    expect(words(parts).sessions).toBe('2 · Local sandbox · 2 subagents');
  });

  test('the Prototype row (#351): the version built from, a newer one saved since, one in code', () => {
    const built = (url: string) => ({
      ...DEMO,
      run: ok({
        ...RUN,
        reference: {
          spec: null,
          prototype: { kind: 'store' as const, url },
          dir: '.scratch/2/prototype',
        },
      }),
    });

    expect(rows({ ...built('prototype://shop/2/v2'), prototype: ok(3) }).prototype).toMatchObject({
      words: 'v2 · v3 is newer',
      opens: null,
    });
    expect(words({ ...built('prototype://shop/2/v2'), prototype: ok(2) }).prototype).toBe('v2');
    expect(words({ ...DEMO, run: ok(null), prototype: ok(1) }).prototype).toBe('v1');
    expect(
      rows({ ...built('prototype://shop/2/v2'), prototype: { ok: false, error: 'store down' } })
        .prototype,
    ).toMatchObject({ words: 'v2', error: 'store down' });
    expect(
      words({
        ...DEMO,
        run: ok({
          ...RUN,
          reference: {
            spec: null,
            prototype: { kind: 'code' as const, branch: 'proto/2-vat', sha: 'c0ffee0' },
            dir: '.scratch/2/prototype',
          },
        }),
      }).prototype,
    ).toBe('proto/2-vat at c0ffee0');
    expect(
      words({ ...DEMO, run: ok(null), prototype: { ok: false, error: 'store down' } }).prototype,
    ).toBe('(dim) not read · store down');
  });

  test('no run yet: Spec, Worktree none yet; nothing to look for on GitHub', () => {
    expect(
      words({
        story: STORY,
        card: ok({ ...CARD, assignee: null }),
        run: ok(null),
        sessions: ok([]),
        sheets: ok([]),
      }),
    ).toEqual({
      story: 'Active · Bug · unassigned',
      prototype: '(dim) none',
      spec: '(dim) none yet',
      sessions: '(dim) none yet',
      pr: '(dim) none yet',
      pipelines: '(dim) none yet',
      worktree: '(dim) none yet',
      box: '(dim) none yet',
      sheets: '(dim) none',
    });
  });

  test('a spec: written in the run with its first line, being written, or the spec issue', () => {
    const written = factoryRun(STORY, TITLE, 'build', 'running', {
      stages: [
        {
          stage: 'spec',
          startedAt: minutes(0),
          endedAt: minutes(4),
          durationMs: 240_000,
          report: '/state/sessions/2-a1b2/reports/1-spec.md',
        },
      ],
    });

    expect(
      rows({ ...DEMO, run: ok(written), specLine: 'each line counts price × quantity' }).spec,
    ).toMatchObject({
      words: 'written ✓ · each line counts price × quantity',
      dim: false,
      opens: { kind: 'file', path: '/state/sessions/2-a1b2/reports/1-spec.md' },
    });
    expect(words({ ...DEMO, run: ok(factoryRun(STORY, TITLE, 'spec')) }).spec).toBe('● writing');
    expect(
      words({
        ...DEMO,
        run: ok(
          factoryRun(STORY, TITLE, 'build', 'running', {
            workflow: {
              id: 'feature',
              name: 'Feature',
              layer: 'built-in',
              steps: [
                {
                  name: 'create-specification',
                  kind: 'spec',
                  skill: 'create-specification',
                  fresh: 'never',
                  gated: false,
                  ends: false,
                },
              ],
            },
          }),
        ),
      }).spec,
    ).toBe('(dim) none yet');

    const referenced = factoryRun(STORY, TITLE, 'build', 'running', {
      reference: {
        spec: 'mkdir-swe/demo-shop#88',
        prototype: { kind: 'store', url: 'prototype://demo-shop/2/v1' },
        dir: '/r',
      },
    });
    const issue = {
      repo: 'mkdir-swe/demo-shop',
      number: 88,
      title: 'Count each line',
      body: '',
      state: 'open' as const,
      url: 'https://github.com/mkdir-swe/demo-shop/issues/88',
      labels: [],
      parent: null,
      subIssues: [],
    };

    expect(rows({ ...DEMO, run: ok(referenced), specIssue: ok(issue) }).spec).toMatchObject({
      words: '#88 · open · Count each line',
      opens: { kind: 'url', url: issue.url },
    });
    expect(
      words({ ...DEMO, run: ok(referenced), specIssue: failed('gh: Not Found (HTTP 404)') }).spec,
    ).toBe('(dim) not read · gh: Not Found (HTTP 404)');
  });

  test('a pull request: its title, its checks passed of all and its reviewers; merged and draft say so', () => {
    const pr: PrData = {
      repo: 'mkdir-swe/demo-shop',
      number: 10,
      title: "AB#102 Count each line's quantity in the cart total",
      body: '',
      url: 'https://github.com/mkdir-swe/demo-shop/pull/10',
      state: 'open',
      draft: false,
      head: { ref: BRANCH, sha: 'abc' },
      base: { ref: 'main' },
      mergeable: 'mergeable',
      checks: {
        state: 'success',
        runs: ['ci', 'lint', 'e2e'].map((name) => ({ name, state: 'success' as const, url: null })),
      },
      mergeCommit: null,
    };
    const reviews = [
      { by: 'sam', state: 'COMMENTED' },
      { by: 'sam', state: 'APPROVED' },
    ];

    expect(rows({ ...DEMO, pr: ok({ pr, reviews }) }).pr).toMatchObject({
      words: "#10 AB#102 Count each line's quantity in th… · checks ✓ 3/3 · 1 review",
      dim: false,
      opens: { kind: 'url', url: pr.url },
    });
    const red: PrData = {
      ...pr,
      draft: true,
      checks: {
        state: 'failure',
        runs: [
          { name: 'ci', state: 'failure', url: null },
          { name: 'lint', state: 'success', url: null },
        ],
      },
    };

    expect(words({ ...DEMO, pr: ok({ pr: red, reviews: [] }) }).pr).toBe(
      "#10 AB#102 Count each line's quantity in th… · draft · checks ✗ 1/2",
    );
    expect(
      words({
        ...DEMO,
        pr: ok({
          pr: { ...pr, state: 'merged' },
          reviews: [...reviews, { by: 'kim', state: 'APPROVED' }],
        }),
      }).pr,
    ).toBe("#10 AB#102 Count each line's quantity in th… · merged · 2 reviews");
    expect(
      words({
        ...DEMO,
        pr: ok({ pr: { ...pr, checks: { state: 'none', runs: [] } }, reviews: [] }),
      }).pr,
    ).toBe("#10 AB#102 Count each line's quantity in th… · no checks");
  });

  test('a closed pull request says its title as an open one does (#224), a long one cut', () => {
    const pr: PrData = {
      repo: 'mkdir-swe/demo-shop',
      number: 16,
      title: 'AB#102 The cart total counts each line by its quantity',
      body: '',
      url: 'https://github.com/mkdir-swe/demo-shop/pull/16',
      state: 'closed',
      draft: false,
      head: { ref: BRANCH, sha: 'abc' },
      base: { ref: 'main' },
      mergeable: 'unknown',
      checks: { state: 'success', runs: [{ name: 'ci', state: 'success', url: null }] },
      mergeCommit: null,
    };

    expect(words({ ...DEMO, pr: ok({ pr, reviews: [] }) }).pr).toBe(
      '#16 AB#102 The cart total counts each line… · closed',
    );
    const long = `AB#102 ${'Count each line by its quantity '.repeat(3).trim()}`;
    const cut = words({ ...DEMO, pr: ok({ pr: { ...pr, title: long }, reviews: [] }) }).pr;

    expect(cut).toBe(`#16 ${long.slice(0, 39).trimEnd()}… · closed`);
    // no title read: the number and its state only
    expect(words({ ...DEMO, pr: ok({ pr: { ...pr, title: ' ' }, reviews: [] }) }).pr).toBe(
      '#16 · closed',
    );
  });

  test('two sessions: the count and where each runs; the box row names the box', () => {
    const boxed: SessionData = {
      ...SESSION,
      id: '2-e5f6',
      box: 'demo-shop',
      worktree: '/workspace/repo',
      subagents: [],
    };
    const box: BoxData = {
      ...UNSAID,
      name: 'demo-shop',
      state: 'running',
      size: 'm7g.large',
      workspace: null,
      // 01:30 on the Mac's clock, in whatever zone the tests run
      idle: {
        minutes: 30,
        activeAt: minutes(0),
        stopsAt: new Date(2026, 9, 2, 1, 30).toISOString(),
        keptBy: [],
      },
    };
    const r = rows({
      ...DEMO,
      sessions: ok([{ ...SESSION, subagents: [] }, boxed]),
      boxes: ok([box]),
    });

    expect(r.sessions?.words).toBe('2 · Local sandbox, demo-shop');
    expect(r.sessions?.opens).toEqual({ kind: 'sessions', ids: ['2-a1b2', '2-e5f6'] });
    expect(r.box).toMatchObject({
      words: '☁ demo-shop #2 · running · stops at 01:30',
      dim: false,
      opens: { kind: 'box', name: 'demo-shop', card: 2 },
    });
    // across a DST change (#260): its own instant's clock, never now's offset (an hour off)
    const zoneWas = process.env.TZ;

    process.env.TZ = 'Europe/Stockholm';
    try {
      const late = {
        ...box,
        idle: {
          minutes: 30,
          activeAt: minutes(0),
          stopsAt: '2026-10-25T01:08:00.000Z',
          keptBy: [],
        },
      };
      const across = linkedOf(
        { ...DEMO, sessions: ok([{ ...SESSION, subagents: [] }, boxed]), boxes: ok([late]) },
        { ...ENV, now: '2026-10-25T00:31:00.000Z' },
      ).rows.find((x) => x.key === 'box');

      expect(across?.words).toBe('☁ demo-shop #2 · running · stops at 02:08 CET');
    } finally {
      // bun test runs on UTC with no TZ set
      process.env.TZ = zoneWas ?? 'UTC';
    }
    expect(
      words({
        ...DEMO,
        sessions: ok([boxed]),
        boxes: ok([
          {
            ...box,
            idle: { minutes: 30, activeAt: minutes(0), stopsAt: null, keptBy: ['attached'] },
          },
        ]),
      }).box,
    ).toBe('☁ demo-shop #2 · running · kept awake');
  });

  test('a box asleep, a box gone, and the workspace on a box', () => {
    const boxed: SessionData = { ...SESSION, box: 'demo-shop', worktree: '/workspace/repo' };
    const asleep: BoxData = {
      ...UNSAID,
      name: 'demo-shop',
      state: 'stopped',
      size: null,
      workspace: null,
    };

    expect(
      words({ ...DEMO, run: ok(null), sessions: ok([boxed]), boxes: ok([asleep]) }),
    ).toMatchObject({
      box: '☁ demo-shop #2 · asleep',
      worktree: '/workspace/repo',
    });
    expect(words({ ...DEMO, sessions: ok([boxed]), boxes: ok([]) }).box).toBe(
      '(dim) ☁ demo-shop #2 · gone',
    );
    // an old box (2.2, made for this one card): its name alone
    const old: SessionData = { ...SESSION, box: 'demo-shop-2' };

    expect(
      words({
        ...DEMO,
        sessions: ok([old]),
        boxes: ok([{ ...asleep, name: 'demo-shop-2', card: STORY }]),
      }).box,
    ).toBe('demo-shop-2 · asleep');
  });

  test('ended sessions only: listed as ended', () => {
    expect(
      words({ ...DEMO, sessions: ok([{ ...SESSION, state: 'ended', subagents: [] }]) }).sessions,
    ).toBe('1 · Local sandbox · ended');
    expect(
      words({
        ...DEMO,
        sessions: ok([{ ...SESSION, state: 'ended', stopped: true, subagents: [] }]),
      }).sessions,
    ).toBe('1 · Local sandbox · stopped');
    // the newest's word, as the run's: an older one that ended on its own does not change it
    const older = {
      ...SESSION,
      id: '2-0000',
      state: 'ended' as const,
      startedAt: '2026-09-01T09:00:00.000Z',
      subagents: [],
    };

    expect(
      words({
        ...DEMO,
        sessions: ok([older, { ...SESSION, state: 'ended', stopped: true, subagents: [] }]),
      }).sessions,
    ).toBe('2 · Local sandbox · stopped');
  });

  test('Sheets: yours for the story and those attached to it, each once', () => {
    const r = rows({
      ...DEMO,
      card: ok({
        ...CARD,
        sheets: [
          cardSheet(STORY, 'sh-1', 'before-after'),
          cardSheet(STORY, 'sh-3', 'cart prototype'),
        ],
      }),
      sheets: ok([
        sheetSummary('sh-1', 'before-after', { card: STORY, attached: [STORY] }),
        sheetSummary('sh-2', 'another story', { card: 9 }),
      ]),
    });

    expect(r.sheets).toMatchObject({
      words: '2 · before-after, cart prototype',
      opens: { kind: 'sheets', refs: ['sh-1', '2/sh-3'] },
    });
  });

  test("the Pipelines row is the provider's run: an Azure build going, a run at its gate", () => {
    const build: PipelineRun = {
      ...PIPELINE,
      id: '512',
      number: '20261001.3',
      pipeline: 'Shop CI',
      status: 'running',
      finishedAt: null,
      url: 'https://dev.azure.com/contoso/Shop/_build/results?buildId=512',
    };
    const parts = { ...DEMO, pipeline: ok(build) };

    expect(words(parts).pipelines).toBe('Shop CI ● running on card/2-… · 16 min ago');
    expect(rows(parts).pipelines?.opens).toEqual({ kind: 'pipeline', id: '512', url: build.url });
    expect(words({ ...DEMO, pipeline: ok({ ...build, status: 'waiting' }) }).pipelines).toBe(
      'Shop CI ◆ waiting on card/2-… · 16 min ago',
    );
  });

  test('a failed read says why on its row; the rest still shows', () => {
    const w = words({
      ...DEMO,
      card: failed('TF400813: the token expired'),
      pipeline: failed('gh: To get started with GitHub CLI, please run:  gh auth login\nmore'),
      boxes: failed('never asked'),
    });

    expect(w).toMatchObject({
      story: '(dim) not read · TF400813: the token expired',
      pipelines: '(dim) not read · gh: To get started with GitHub CLI, please run: gh auth login',
      sessions: '1 · Local sandbox · 2 subagents',
      worktree: '~/projects/demo-shop-wt/2-the-cart-total-ignores-quantity',
    });
    // The story unread, the title is the run's.
    expect(linkedOf({ ...DEMO, card: failed('x') }, ENV).title).toBe(TITLE);
    expect(rows({ ...DEMO, card: failed('x') }).story?.error).toBe('x');

    const none = words({
      ...DEMO,
      run: failed('no session runner'),
      sessions: failed('no session runner'),
    });

    expect(none).toMatchObject({
      spec: '(dim) not read · no session runner',
      sessions: '(dim) not read · no session runner',
      worktree: '(dim) not read · no session runner',
      box: '(dim) not read · no session runner',
    });
  });
});

describe('live from abe watch', () => {
  const event = (seq: number, e: Pick<Event, 'type' | 'data'>): Event =>
    Event.parse({ seq, at: NOW, ...e });
  const data = linkedOf(DEMO, ENV);

  test('the run moving to Review changes its facts in place, and asks for a read', () => {
    const moved = linkedOnEvent(
      data,
      event(5, {
        type: 'factory.stage',
        data: {
          card: STORY,
          session: '2-a1b2',
          stage: 'review',
          from: 'build',
          state: 'running',
          reason: null,
          since: minutes(20),
          cause: 'checks',
          outcome: null,
        },
      }),
    );

    expect(moved.reread).toEqual(LINKED_PARTS);
    expect(moved.data.rows.map((r) => r.key)).toEqual([...LINKED_KEYS]);
    expect(moved.data.run).toMatchObject({ stage: 'review', state: 'running' });
    // No Run row (Run is on the stripe, 3.0 #21): the rows are as they were until read again.
    expect(moved.data.rows).toEqual(data.rows);
  });

  test('another session’s run on the story’s number (another repo’s, #256) is read, never put in its place', () => {
    const other = linkedOnEvent(
      data,
      event(5, {
        type: 'factory.stage',
        data: {
          card: STORY,
          session: '2-ffff',
          stage: 'pr',
          from: 'verify',
          state: 'needs-you',
          reason: 'which account?',
          since: minutes(20),
          cause: 'pr',
          outcome: null,
        },
      }),
    );

    expect(other.reread).toEqual(LINKED_PARTS);
    expect(other.data).toEqual(data);
  });

  test('ended as Abandoned: the run keeps the stage it was given up in (#230)', () => {
    const moved = linkedOnEvent(
      data,
      event(5, {
        type: 'factory.stage',
        data: {
          card: STORY,
          session: '2-a1b2',
          stage: 'done',
          from: 'build',
          state: 'done',
          reason: null,
          since: minutes(20),
          cause: 'end',
          outcome: 'abandoned',
          ended: { as: 'abandoned', reason: 'not needed', at: minutes(20), from: 'build' },
        },
      }),
    );

    expect(moved.data.run).toMatchObject({ stage: 'done', outcome: 'abandoned' });
    expect(moved.data.run?.ended?.from).toBe('build');
  });

  test("its session's state changes the run's facts in place: stopped by you, or failed (#205)", () => {
    const ended = (cause: string) =>
      linkedOnEvent(
        data,
        event(6, {
          type: 'session.state',
          data: { id: '2-a1b2', card: STORY, state: 'ended', since: minutes(20), cause },
        }),
      );

    expect(ended('stop').reread).toEqual(LINKED_PARTS);
    expect(ended('stop').data.run).toMatchObject({ sessionState: 'ended', sessionStopped: true });
    expect(ended('gone').data.run).toMatchObject({ sessionState: 'ended', sessionStopped: false });
  });

  test('which events ask for which parts again: the story’s own, a gap; never another story’s', () => {
    const rereads = (e: Pick<Event, 'type' | 'data'>) => linkedOnEvent(data, event(7, e)).reread;

    expect(
      rereads({
        type: 'session.subagent',
        data: {
          id: '2-a1b2',
          card: STORY,
          agent: 'x',
          name: 'abe:reader',
          task: null,
          model: null,
          state: 'done',
          result: null,
        },
      }),
    ).toEqual(['run']);
    expect(
      rereads({
        type: 'sheet.attached',
        data: { id: 'sh-1', title: 't', version: 1, card: STORY, key: 'k' },
      }),
    ).toEqual(['card']);
    expect(rereads({ type: 'watch.gap', data: { since: 1, first: 9 } })).toEqual(LINKED_PARTS);
    expect(
      rereads({
        type: 'factory.card',
        data: { card: STORY, session: '2-a1b2', column: 'active', state: 'Active', error: null },
      }),
    ).toEqual(LINKED_PARTS);
    expect(
      rereads({
        type: 'session.state',
        data: { id: '9-c3d4', card: 9, state: 'ended', since: NOW, cause: 'stop' },
      }),
    ).toEqual([]);
    expect(
      rereads({
        type: 'factory.stage',
        data: {
          card: 9,
          session: '9-c3d4',
          stage: 'pr',
          from: 'verify',
          state: 'running',
          reason: null,
          since: NOW,
          cause: 'pr',
          outcome: null,
        },
      }),
    ).toEqual([]);
    expect(
      rereads({ type: 'box.state', data: { box: 'demo-shop-9', state: 'running', cause: 'up' } }),
    ).toEqual([]);
  });

  test('fresh data (#236): the story changed on Azure DevOps, its pull request on GitHub, a run on its branch', () => {
    const rereads = (e: Pick<Event, 'type' | 'data'>) => linkedOnEvent(data, event(8, e)).reread;
    const board = { organization: 'https://dev.azure.com/o', project: 'P', team: 'T' };
    const pr = (number: number, branch: string) => ({
      number,
      title: 't',
      state: 'open' as const,
      branch,
      updatedAt: NOW,
    });
    const run = (branch: string) => pipelineRun('9001', 'ci', 'Cart total', branch, '10:00', 4);

    expect(
      rereads({
        type: 'board.changed',
        data: {
          board,
          cards: [{ card: listCard(STORY, TITLE, 'Resolved'), mine: true }],
          gone: [],
        },
      }),
    ).toEqual(['card']);
    expect(rereads({ type: 'board.changed', data: { board, cards: [], gone: [STORY] } })).toEqual([
      'card',
    ]);
    expect(
      rereads({
        type: 'board.changed',
        data: { board, cards: [{ card: listCard(9, 'x', 'New'), mine: false }], gone: [12] },
      }),
    ).toEqual([]);
    expect(
      rereads({
        type: 'github.changed',
        data: { repo: 'o/r', prs: [pr(41, `card/${STORY}-cart-total`)] },
      }),
    ).toEqual(['pr']);
    expect(
      rereads({
        type: 'pipelines.changed',
        data: { source: 'Shop/Web', runs: [run(`card/${STORY}-cart-total`)] },
      }),
    ).toEqual(['pipelines']);
    expect(
      rereads({
        type: 'pipelines.changed',
        data: { source: 'Shop/Web', runs: [run(`card/${STORY}0-other`), run('main')] },
      }),
    ).toEqual([]);
    // the branch Linked read the work on, whatever its name
    const onOwn = { ...data, branch: 'feature/cart' };

    expect(
      linkedOnEvent(
        onOwn,
        event(8, {
          type: 'pipelines.changed',
          data: { source: 'o/r', runs: [run('feature/cart')] },
        }),
      ).reread,
    ).toEqual(['pipelines']);
    expect(
      linkedOnEvent(
        onOwn,
        event(8, {
          type: 'pipelines.changed',
          data: { source: 'o/r', runs: [run(`card/${STORY}-cart-total`)] },
        }),
      ).reread,
    ).toEqual([]);
    expect(
      rereads({
        type: 'github.changed',
        data: { repo: 'o/r', prs: [pr(42, `card/${STORY}0-other`), pr(43, 'main')] },
      }),
    ).toEqual([]);
  });

  test('a box booting, its serve not answering yet (#213 B4): booting, as the Boxes tab says it', () => {
    const boxed: SessionData = { ...SESSION, box: 'demo-shop', subagents: [] };
    const booting: BoxData = {
      ...UNSAID,
      name: 'demo-shop',
      state: 'running',
      size: null,
      workspace: null,
      launchedAt: minutes(19),
      serve: 'silent',
    };

    expect(words({ ...DEMO, sessions: ok([boxed]), boxes: ok([booting]) }).box).toBe(
      '☁ demo-shop #2 · booting',
    );
    // up past its boot with its serve silent: running, as the list says
    expect(
      words({ ...DEMO, sessions: ok([boxed]), boxes: ok([{ ...booting, launchedAt: minutes(0) }]) })
        .box,
    ).toBe('☁ demo-shop #2 · running');
  });

  test('its box’s box.step asks for the box part; another box’s does not (#213 B4)', () => {
    const boxed = linkedOf(
      {
        ...DEMO,
        sessions: ok([{ ...SESSION, box: 'demo-shop' }]),
        boxes: ok([
          { ...UNSAID, name: 'demo-shop', state: 'pending', size: null, workspace: null },
        ]),
      },
      ENV,
    );
    const step = (box: string) =>
      linkedOnEvent(boxed, event(9, { type: 'box.step', data: { box, step: 'booting' } })).reread;

    expect(step('demo-shop')).toEqual(['box']);
    expect(step('demo-shop-9')).toEqual([]);
  });

  test('its box moving asks for the box part', () => {
    const boxed = linkedOf(
      {
        ...DEMO,
        sessions: ok([{ ...SESSION, box: 'demo-shop' }]),
        boxes: ok([
          { ...UNSAID, name: 'demo-shop', state: 'stopped', size: null, workspace: null },
        ]),
      },
      ENV,
    );

    expect(
      linkedOnEvent(
        boxed,
        event(8, {
          type: 'box.state',
          data: { box: 'demo-shop', state: 'starting', cause: 'wake' },
        }),
      ).reread,
    ).toEqual(['box']);
  });
});

describe('a run that never got a box (#246)', () => {
  const never: SessionData = {
    ...SESSION,
    state: 'ended',
    box: 'demo-shop-2',
    neverPlaced: true,
    subagents: [],
  };

  test('Sessions names no box; Box: none, it never got one', () => {
    const w = words({ ...DEMO, sessions: ok([never]), boxes: ok([]) });

    expect([w.sessions, w.box]).toEqual([
      '1 · never got a box · ended',
      '(dim) none · never got a box',
    ]);
  });
});
