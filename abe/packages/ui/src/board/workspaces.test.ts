/** The header's feed as tables: states → dot, hue, rail, cloud; words; the Factory line. */
import { describe, expect, test } from 'bun:test';
import type { FactoryRunData, SessionData } from '@abe/core';
import { factoryRun, HEADER_NOW, headerDemo, session } from '@abe/testing';
import type { CloudState } from '../live';
import type { Hue } from '../runtime/runtime';
import { standing } from './index';
import {
  LINE_NEEDS_YOU,
  briefTitle,
  cloudOf,
  factoryLine,
  projectName,
  shortTitle,
  workspacesOf,
  workspaceLook,
  type WorkspaceState,
} from './index';

const NO_COUNTS = { running: 0, needsYou: 0, failed: 0, ready: 0 };

const demo = () => {
  const d = headerDemo();

  return workspacesOf({
    runs: d.runs,
    sessions: d.sessions,
    now: HEADER_NOW,
    root: '/home/me/projects/demo-shop-wt/2-cart-total',
    sprint: 'Sprint 1',
    counts: { running: 1, needsYou: 1, failed: 0, ready: 0 },
    answering: true,
  });
};

const look = (s: SessionData, run?: FactoryRunData) => {
  if (s.card === null) throw new Error('a card’s session');

  return workspaceLook({ ...s, card: s.card }, run, HEADER_NOW);
};

describe('a story workspace', () => {
  test('a local one running: dot, tab, rail, no cloud, the context line as badges', () => {
    const two = demo().workspaces.find((w) => w.story.id === 2);

    expect(two).toEqual({
      root: '/home/me/projects/demo-shop-wt/2-cart-total',
      story: {
        id: 2,
        short: 'cart total ignores quantity',
        title: 'The cart total ignores quantity',
      },
      state: 'running',
      dot: { mark: '●', hue: 'warn' },
      stage: 'Build',
      rail: ['done', 'now', 'todo', 'todo', 'todo'],
      since: '2026-10-01T09:00:00.000Z',
      cloud: null,
      cloudHue: null,
      pr: null,
      branch: 'card/2-the-cart-total-ignores-quantity',
      tab: '#2 cart total ignores quantity',
      tooltip: '#2 The cart total ignores quantity · Build · Running 21 min · Local sandbox',
      line: [
        { text: '#2 cart total ignores…', hue: 'accent' },
        { text: 'Build ● Running 21 min', hue: 'warn' },
        { text: 'Local', hue: 'dim' },
        { text: 'PR —', hue: 'dim' },
      ],
      label: 'Linked: #2 cart total ignores…, Build, Running 21 min, local, no pull request',
      crumb: '#2 cart total ignores quantity',
      caption: [
        { text: 'cart total ignores quantity · Build ' },
        { text: '● Running', hue: 'warn' },
      ],
    });
  });

  test('a box asleep, done: ✓ good, a full rail, the outline cloud dim', () => {
    const three = demo().workspaces.find((w) => w.story.id === 3);

    expect(three).toMatchObject({
      box: 'demo-shop-3',
      state: 'done',
      dot: { mark: '✓', hue: 'good' },
      stage: 'Done',
      rail: ['done', 'done', 'done', 'done', 'done'],
      cloud: 'asleep',
      cloudHue: 'dim',
      tab: '#3 pin the Node version',
      tooltip: '#3 Pin the Node version · Done · On test 31 min · box demo-shop-3 asleep',
      line: [
        { text: '#3 pin the Node version', hue: 'accent' },
        { text: 'Done ✓ On test 31 min', hue: 'good' },
        { text: 'demo-shop-3', hue: 'dim', cloud: 'asleep' },
        { text: 'PR —', hue: 'dim' },
      ],
    });
  });

  test('abandoned: the stage it was given up in and ○ Abandoned, never Done', () => {
    const run = factoryRun(4, 'Saved carts survive sign-out', 'done', 'done', {
      outcome: 'abandoned',
      ended: { as: 'abandoned', reason: 'not needed', at: HEADER_NOW, from: 'pr' },
    });
    const w = look(session('s4', 'ended', 4), run);

    expect(w.stage).toBe('PR');
    expect(w.rail).toEqual(['done', 'done', 'done', 'wait', 'todo']);
    expect(w.caption).toEqual([
      { text: 'saved carts survive sign-out · PR ' },
      { text: '○ Abandoned', hue: 'dim' },
    ]);
  });

  test('a box that needs you: ◆ purple everywhere, waiting since its session asked', () => {
    const one = demo().workspaces.find((w) => w.story.id === 1);

    expect(one).toMatchObject({
      box: 'demo-shop-102',
      state: 'needs-you',
      dot: { mark: '◆', hue: 'needs-you' },
      rail: ['need', 'todo', 'todo', 'todo', 'todo'],
      cloud: 'running',
      cloudHue: 'accent',
      since: '2026-10-01T09:13:00.000Z',
      line: [
        { text: '#1 show stock…', hue: 'accent' },
        { text: 'Spec ◆ Needs you 8 min', hue: 'needs-you' },
        { text: 'demo-shop-102', hue: 'accent', cloud: 'running' },
        { text: 'PR —', hue: 'dim' },
      ],
      label: 'Linked: #1 show stock…, Spec, Needs you 8 min, box demo-shop-102, no pull request',
      caption: [
        { text: 'show stock on a product card · Spec ' },
        { text: '◆ Needs you', hue: 'needs-you' },
      ],
    });
  });

  test.each<[string, FactoryRunData, SessionData, WorkspaceState, string, Hue]>([
    [
      'idle: ○ dim',
      factoryRun(4, 'Idle story', 'build', 'running'),
      session('s4', 'waiting', 4),
      'idle',
      '○',
      'dim',
    ],
    [
      'failed: ✗ bad',
      factoryRun(4, 'Failed story', 'build', 'needs-you'),
      session('s4', 'ended', 4),
      'failed',
      '✗',
      'bad',
    ],
    [
      'stopped by you: ○ dim, not failed (#205)',
      factoryRun(4, 'Stopped story', 'build', 'needs-you'),
      { ...session('s4', 'ended', 4), stopped: true },
      'idle',
      '○',
      'dim',
    ],
    [
      'starting: ● dim',
      factoryRun(4, 'Starting story', 'build', 'running'),
      session('s4', 'starting', 4),
      'starting',
      '●',
      'dim',
    ],
  ])('%s', (_, run, s, state, mark, hue) => {
    const l = look(s, run);

    expect(l.state).toBe(state);
    expect(l.dot).toEqual({ mark, hue });
    expect(l.line[1]?.hue).toBe(hue);
    expect(l.line[1]?.text).toContain(` ${mark} `);
  });

  test('a box starting: the dashed cloud in the accent', () => {
    const l = look({ ...session('s5', 'starting', 5), box: 'demo-shop-5' });

    expect(l.cloud).toBe('starting');
    expect(l.line[2]).toEqual({ text: 'demo-shop-5', hue: 'accent', cloud: 'starting' });
  });

  test('its box up, its workspace being built: the launch as Chat says it, for RemoteState', () => {
    const launch = {
      step: 'base-image' as const,
      since: HEADER_NOW,
      startedAt: HEADER_NOW,
      box: 'demo-shop-3',
      how: 'new' as const,
      detail: 'step 14/27',
      told: true,
      done: [],
    };
    const on3 = (state: SessionData['state'], l: SessionData['launch']) =>
      look({ ...session('s3', state, 3), box: 'demo-shop-3', launch: l }).building;

    expect(on3('starting', launch)).toBe(
      'Building the workspace image (first time on this box, ~3 min) · step 14/27',
    );
    expect(on3('starting', { ...launch, step: 'workspace', detail: 'cloning the repo' })).toBe(
      'Workspace · cloning the repo',
    );
    // the box not up yet, claude starting in its container, or running: nothing being built
    expect(on3('starting', { ...launch, step: 'box-booting', detail: null })).toBeUndefined();
    expect(on3('starting', { ...launch, step: 'claude-starting', detail: null })).toBeUndefined();
    expect(on3('working', null)).toBeUndefined();
    // a local session has no box to build on
    expect(look({ ...session('s4', 'starting', 4), launch }).building).toBeUndefined();
  });

  test('a session with no Factory run: its state alone, no stage, the state on the first segment as its tile', () => {
    const l = look(session('s6', 'working', 6));

    expect(l).toMatchObject({
      state: 'running',
      stage: null,
      rail: ['now', 'todo', 'todo', 'todo', 'todo'],
    });
    expect(l.line[1]).toEqual({ text: '● Running 20 min', hue: 'warn' });
  });

  test('a plain session after its abandoned run: what the card stands for, as Chat and the Board read it', () => {
    const run = factoryRun(4, 'Sign in with email', 'spec', 'done', {
      outcome: 'abandoned',
      ended: { as: 'abandoned', reason: 'not needed', at: HEADER_NOW, from: 'spec' },
    });
    const ran: SessionData = { ...session('s4', 'ended', 4), factory: true };
    const plain = (state: SessionData['state']) => ({
      ...session('p4', state, 4),
      worktree: '/wt/s4',
      startedAt: '2026-10-01T09:30:00.000Z',
    });
    const feed = (p: SessionData) =>
      workspacesOf({
        runs: [run],
        sessions: [ran, p],
        now: HEADER_NOW,
        root: undefined,
        sprint: null,
        counts: NO_COUNTS,
        answering: true,
      }).workspaces;
    const live = plain('working');

    // it stands for the card (Chat's pin, the Board's card): the tile and page header say it too
    expect(standing([run], [ran, live]).get(4)).toEqual({ session: live });
    expect(feed(live)).toEqual([look(live)]);
    expect(feed(live)[0]).toMatchObject({
      state: 'running',
      stage: null,
      rail: ['now', 'todo', 'todo', 'todo', 'todo'],
    });
    // ended on its own it stands for nothing: the run again, Abandoned in its stage
    const over = plain('ended');

    expect(standing([run], [ran, over]).get(4)).toMatchObject({ run });
    expect(feed(over)[0]).toMatchObject({ stage: 'Spec', caption: [{}, { text: '○ Abandoned' }] });
  });

  test('a pull request: its number and checks in their hue', () => {
    const pr = {
      repo: 'mkdir-swe/demo-shop',
      number: 10,
      url: 'https://github.com/mkdir-swe/demo-shop/pull/10',
      state: 'open' as const,
      merge: 'person' as const,
      checks: 'pending' as const,
      mergeCommit: null,
      deploy: null,
      branch: null,
    };
    const l = look(session('s2', 'working', 2), factoryRun(2, 'X', 'pr', 'running', { pr }));

    expect(l.pr).toEqual({ n: 10, checks: 'pending' });
    expect(l.line[3]).toEqual({ text: 'PR #10 ●', hue: 'warn' });
    expect(l.label).toEndWith('pull request #10, checks running');
  });

  test('before the clock is known no time is said', () => {
    const d = headerDemo();
    const [s2] = d.sessions;

    if (s2?.card !== 2) throw new Error('the demo has #2');
    const two = workspaceLook({ ...s2, card: 2 }, d.runs[0], undefined);

    expect(two.line[1]).toEqual({ text: 'Build ● Running', hue: 'warn' });
  });

  test('the newest session per workspace counts; an Improve chat (no card) is none', () => {
    const old = {
      ...session('old', 'ended', 2),
      worktree: '/wt/2',
      startedAt: '2026-10-01T08:00:00.000Z',
    };
    const now = { ...session('new', 'working', 2), worktree: '/wt/2' };
    const retro = { ...session('r', 'working', 2), card: null, worktree: '/wt/r' };
    const f = workspacesOf({
      runs: [],
      sessions: [old, now, retro],
      now: HEADER_NOW,
      root: undefined,
      sprint: null,
      counts: NO_COUNTS,
      answering: true,
    });

    expect(f.workspaces.map((w) => [w.root, w.state])).toEqual([['/wt/2', 'running']]);
  });

  test("two cards' workspaces on one box (ADR 0022): one each, never one for the box", () => {
    const on = (id: string, card: number) => ({
      ...session(id, 'working', card),
      worktree: '/workspace/repo',
      box: 'demo-shop',
    });
    const f = workspacesOf({
      runs: [],
      sessions: [on('a', 101), on('b', 102)],
      now: HEADER_NOW,
      root: undefined,
      sprint: null,
      counts: NO_COUNTS,
      answering: true,
    });

    expect(f.workspaces.map((w) => [w.box, w.story.id])).toEqual([
      ['demo-shop', 101],
      ['demo-shop', 102],
    ]);
  });
});

describe('the words', () => {
  test.each([
    ['The cart total ignores quantity', 'cart total ignores quantity'],
    ['Pin the Node version', 'pin the Node version'],
    ['An API for carts', 'API for carts'],
    ['API keys rotate', 'API keys rotate'],
  ])('%s → %s', (title, short) => {
    expect(shortTitle(title)).toBe(short);
  });

  test.each([
    ['cart total ignores quantity', 'cart total ignores…'],
    ['pin the Node version', 'pin the Node version'],
    ['localisation', 'localisation'],
    ['as a customer I can filter orders by date', 'as a customer I can…'],
    ['order totals round to whole numbers', 'order totals round…'],
    ['make it work with a bigger cart', 'make it work…'],
    ['internationalisation-of-everything', 'internationalisatio…'],
  ])('brief %s → %s', (short, brief) => {
    expect(briefTitle(short)).toBe(brief);
  });

  test.each<[SessionData['state'], string | undefined, CloudState | null]>([
    ['working', 'b', 'running'],
    ['waiting', 'b', 'running'],
    ['starting', 'b', 'starting'],
    ['queued', 'b', 'starting'],
    ['ended', 'b', 'asleep'],
    ['working', undefined, null],
  ])('cloud: %s on %s → %s', (state, box, cloud) => {
    expect(cloudOf({ state, ...(box === undefined ? {} : { box }) })).toBe(cloud);
  });
});

describe('the Factory view', () => {
  test('its line: the project, the sprint, the counts in their hues', () => {
    expect(demo().factory).toEqual({
      line: [
        { text: 'demo-shop', hue: 'accent' },
        { text: 'Sprint 1', hue: 'dim' },
        { text: '◆ 1 needs you', hue: 'needs-you', id: LINE_NEEDS_YOU },
        { text: '● 1 running', hue: 'warn' },
      ],
      label: 'Abe, demo-shop, Sprint 1, 1 needs you, 1 running',
      crumb: 'demo-shop · Sprint 1',
    });
  });

  test('Ready for review is its own chip in the good hue, never `running`', () => {
    expect(factoryLine('demo-shop', null, { ...NO_COUNTS, ready: 1 })).toEqual({
      line: [
        { text: 'demo-shop', hue: 'accent' },
        { text: '● 1 ready for review', hue: 'good' },
      ],
      label: 'Abe, demo-shop, 1 ready for review',
      crumb: 'demo-shop',
    });
  });

  test('a zero count is left out, no sprint no badge', () => {
    expect(factoryLine('demo-shop', null, NO_COUNTS)).toEqual({
      line: [{ text: 'demo-shop', hue: 'accent' }],
      label: 'Abe, demo-shop',
      crumb: 'demo-shop',
    });
  });

  test('the project: the shown folder’s session’s repo, else the folder, no folder the one all share', () => {
    const a = { repo: 'o/demo-shop', worktree: '/wt/a' };
    const b = { repo: 'o/other', worktree: '/wt/b' };

    expect(projectName([a, b], '/wt/b')).toBe('other');
    // another repo shown, the sessions all the first one's: its own folder
    expect(projectName([a], '/home/me/projects/x')).toBe('x');
    expect(projectName([a, b], '/home/me/projects/demo-shop')).toBe('demo-shop');
    expect(projectName([a], undefined)).toBe('demo-shop');
    expect(projectName([], undefined)).toBeUndefined();
  });

  test('no reads yet: no workspaces, the line from the folder', () => {
    const f = workspacesOf({
      runs: undefined,
      sessions: undefined,
      now: undefined,
      root: '/home/me/projects/demo-shop',
      sprint: undefined,
      counts: NO_COUNTS,
      answering: false,
    });

    expect(f).toEqual({
      workspaces: [],
      factory: {
        line: [{ text: 'demo-shop', hue: 'accent' }],
        label: 'Abe, demo-shop',
        crumb: 'demo-shop',
      },
      answering: false,
    });
  });
});

describe('a run that never got a box', () => {
  const never: SessionData = {
    ...session('q', 'ended', 4),
    box: 'demo-shop-4',
    neverPlaced: true,
  };

  test('is no workspace: the header lists none for it', () => {
    const f = workspacesOf({
      runs: [],
      sessions: [never],
      now: HEADER_NOW,
      root: undefined,
      sprint: null,
      counts: NO_COUNTS,
      answering: true,
    });

    expect(f.workspaces).toEqual([]);
  });

  test('has no cloud', () => {
    expect(cloudOf(never)).toBeNull();
  });
});
