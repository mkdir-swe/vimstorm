/**
 * Card actions at their interface. The rules first: `nextStep` and the card menu's rows are rule
 * tables over the card's facts. Then the Board driven as the bridge drives it, Command mode over
 * it: ⌘⏎ is the card's Action menu, its next step first; Launch agent launches once, however often
 * it is pressed; a teammate's card greys the launch rows with whose it is; Assign and Move say what
 * changed; Download locally and Move to cloud carry a session across; New card opens the dialog
 * with the board's words. Last, each screen that embeds the machine (the Board, the Card page,
 * Chat, Sessions) pressed on the same card with the same facts: they say and ask the same. A fix
 * adds a row.
 */
import { describe, expect, test } from 'bun:test';
import type { AttachSpec, CardData, FactoryRunData, SessionData, SessionMoveData } from '@abe/core';
import { parse } from '@abe/core';
import {
  type Answer,
  BOARD_MINE,
  BOARD_SIZE,
  boardReplies,
  type BoardWorld,
  cardShowAnswer,
  cardsAnswer,
  chatCommands,
  chatOpened,
  type Command,
  type Drive,
  driveBoard,
  driveChat,
  driveScreen,
  driveSessions,
  eventInput,
  factoryRun,
  type Input,
  listCard,
  minutes,
  type Node,
  nodeById,
  nodesOf,
  type Replies,
  repliesBy,
  runsAnswer,
  session,
  sessionsAnswer,
  type ShellEffect,
} from '@abe/testing';
import {
  cardMenu,
  type CardFacts,
  cardScreen,
  factoryScreen,
  launchArgv,
  nextStep,
  type NextStep,
} from './index';

const ROOT = '/home/me/projects/demo-shop';

// ---------------------------------------------------------------- the card's facts

const PR = {
  repo: 'mkdir-swe/demo-shop',
  number: 10,
  url: 'https://github.com/mkdir-swe/demo-shop/pull/10',
  state: 'open' as const,
  merge: 'person' as const,
  checks: 'success' as const,
  mergeCommit: null,
  deploy: null,
  branch: null,
};
const CART = listCard(2, 'The cart total ignores quantity', 'Active', 'Alex Example');
const runOn = (stage: FactoryRunData['stage'], state: FactoryRunData['state'] = 'running') =>
  factoryRun(2, CART.title, stage, state, { since: minutes(1) });
/** Card 2's facts: yours, its run and session as given. */
const facts = (
  run?: FactoryRunData,
  s?: SessionData['state'],
  more: Partial<CardFacts> = {},
): CardFacts => ({
  card: CART,
  mine: true,
  root: ROOT,
  ...(run === undefined ? {} : { run }),
  ...(s === undefined ? {} : { session: session('s2', s, 2) }),
  ...more,
});
const onBox = (f: CardFacts, box = 'demo-shop-2'): CardFacts =>
  f.session === undefined ? f : { ...f, session: { ...f.session, box } };
/** Card 2 with its session stopped by you. */
const stoppedFacts = (): CardFacts => {
  const f = facts(runOn('build', 'needs-you'), 'ended');

  return f.session === undefined ? f : { ...f, session: { ...f.session, stopped: true } };
};
/** Card 2's run Queued for demo-shop-2 at the limit, then taken out of the queue by you. */
const neverPlaced = (): CardFacts => {
  const f = onBox(facts(runOn('spec', 'needs-you'), 'ended'));

  return f.session === undefined
    ? f
    : { ...f, session: { ...f.session, stopped: true, neverPlaced: true } };
};
const SAMS = { ...CART, assignee: { name: 'Sam Sample', email: 'sam@example.test' } };
const NO_ONES = { ...CART, assignee: null };
const CLOSED = { ...CART, state: 'Closed' };
/** `card members`: you first, then the team A to Z. */
const TEAM_MEMBERS = [
  { name: 'Alex Example', email: 'alex@example.test', you: true },
  { name: 'Robin Placeholder', email: 'robin@example.test', you: false },
  { name: 'Sam Sample', email: 'sam@example.test', you: false },
];
const IDLE = {
  minutes: 30,
  activeAt: minutes(0),
  stopsAt: new Date(2026, 9, 25, 1, 30).toISOString(),
  keptBy: [],
};
/** Abandoned, the card back in New for anyone. */
const GIVEN_UP = facts(
  {
    ...runOn('done', 'done'),
    outcome: 'abandoned',
    pr: PR,
    ended: { as: 'abandoned', reason: 'not needed', at: minutes(9), from: 'pr' },
  },
  'ended',
  { card: NO_ONES, mine: false },
);
/** No one's card launched from Chat, which needs no assignee: its run is yours. */
const LAUNCHED_NO_ONES = onBox(
  facts(runOn('build'), 'working', { card: NO_ONES, mine: false }),
  'demo-shop-102',
);
const DEPLOY_FAILED = facts(
  {
    ...runOn('pr', 'needs-you'),
    reason: 'the deploy to test failed: https://github.com/o/r/actions/runs/9',
    pr: { ...PR, state: 'merged', deploy: 'failure' },
  },
  'ended',
);
const NOT_REPRODUCED = facts(
  { ...runOn('build', 'needs-you'), reason: 'Not reproduced on main (939433b)' },
  'waiting',
);

describe('nextStep: the one next step of a card', () => {
  test.each<[string, CardFacts, NextStep | undefined]>([
    ['your card, no session', facts(), 'launch'],
    ['starting', facts(runOn('spec'), 'starting'), 'workspace'],
    ['running', facts(runOn('build'), 'working'), 'workspace'],
    ['needs you', facts(runOn('build', 'needs-you'), 'waiting'), 'workspace'],
    // ⏎ on any ended session of yours reopens it: failed and stopped runs too
    ['ended before Done', facts(runOn('review'), 'ended'), 'reopen'],
    ['its run failed', facts(runOn('build', 'needs-you'), 'ended'), 'reopen'],
    ['you stopped it', stoppedFacts(), 'reopen'],
    [
      'Done with a pull request',
      facts({ ...runOn('done', 'done'), pr: PR }, 'ended'),
      'pull-request',
    ],
    // Done without one: its session reopens as a plain conversation
    ['Done without one', facts(runOn('done', 'done'), 'ended'), 'reopen'],
    ['queued: no workspace yet', facts(runOn('spec', 'queued'), 'queued'), undefined],
    // a done card, the Board's Closed column: nothing to launch, resume or retry
    ['closed, no session', facts(undefined, undefined, { card: CLOSED }), undefined],
    ['closed, ended before Done', facts(runOn('review'), 'ended', { card: CLOSED }), undefined],
    [
      'closed, its run failed',
      facts(runOn('build', 'needs-you'), 'ended', { card: CLOSED }),
      undefined,
    ],
    ['closed, still running', facts(runOn('build'), 'working', { card: CLOSED }), 'workspace'],
    ['a teammate’s', facts(undefined, undefined, { card: SAMS, mine: false }), undefined],
    ['no one’s', facts(undefined, undefined, { card: NO_ONES, mine: false }), undefined],
    ['no one’s card launched from Chat: its workspace', LAUNCHED_NO_ONES, 'workspace'],
    ['abandoned, no one’s again: no Open pull request', GIVEN_UP, undefined],
  ])('%s', (_, f, step) => {
    expect(nextStep(f)).toBe(step);
  });
});

type MenuRow = ReturnType<typeof cardMenu>['rows'][number];

/** How a menu is read: its rows' ids, their words, the separator, the first or the recovery row. */
const VIEWS = {
  title: (_rows: readonly MenuRow[], title: string) => title,
  ids: (rows: readonly MenuRow[]) => rows.map((r) => r.id),
  texts: (rows: readonly MenuRow[]) =>
    rows.map((r) => [r.text, r.reason ?? r.dim, r.separator ?? false]),
  separated: (rows: readonly MenuRow[]) =>
    rows.filter((r) => r.separator === true).map((r) => r.id),
  lead: (rows: readonly MenuRow[]) => rows.slice(0, 2).map((r) => r.id),
  twice: (rows: readonly MenuRow[]) =>
    rows.filter((r, i) => rows.findIndex((o) => o.id === r.id) !== i).map((r) => r.id),
  /** The recovery row: the one after Launch in Local sandbox, the separator's first. */
  recovery: (rows: readonly MenuRow[]) =>
    rows[rows.findIndex((r) => r.id === 'launch-local-sandbox') + 1]?.id,
};

describe('the card menu’s order: the next step lifted to the top, the recovery rows below the separator', () => {
  test.each<[string, CardFacts, keyof typeof VIEWS, unknown]>([
    ['its title', facts(runOn('build'), 'working'), 'title', '#2 The cart total ignores quantity'],
    [
      'a running local card: Open workspace first, Launch agent in its place',
      facts(runOn('build'), 'working'),
      'ids',
      [
        'workspace',
        'worktree',
        'reopen',
        'retry',
        'stop',
        'end',
        'assign',
        'move',
        'comment',
        // Launch new agent…: the Launch box itself
        'launch',
        'launch-local-sandbox',
        'move-to-cloud',
        'prototype',
        'browser',
      ],
    ],
    [
      'one separator, above the recovery rows',
      facts(runOn('build'), 'working'),
      'separated',
      ['launch-local-sandbox'],
    ],
    [
      'a card with no session: Launch agent first, the rest dim with why',
      facts(),
      'texts',
      [
        ['Launch agent', 'where serve.target says · its workflow, a note', false],
        ['Open worktree', 'from origin', false],
        ['Open workspace', 'no workspace yet', false],
        ['Reopen', 'no session yet', false],
        ['Stop…', 'no session running', false],
        ['End run…', 'no run yet', false],
        ['Assign…', 'already yours', false],
        ['Move…', 'now Active', false],
        ['Comment…', 'markdown, on the card', false],
        ['Keep box awake', 'no box yet', false],
        ['Launch in Local sandbox', 'this machine · no cloud writes', true],
        ['Prototype…', 'real code in a throwaway worktree, never shipped: its own chat', false],
        ['Open in browser', 'Azure Boards', false],
      ],
    ],
    [
      // one launch row
      'a local target: Launch agent on this machine, the separator above Prototype…',
      facts(undefined, undefined, { target: 'local' }),
      'texts',
      [
        ['Launch agent', 'Local sandbox · this machine · its workflow, a note', false],
        ['Open worktree', 'from origin', false],
        ['Open workspace', 'no workspace yet', false],
        ['Reopen', 'no session yet', false],
        ['Stop…', 'no session running', false],
        ['End run…', 'no run yet', false],
        ['Assign…', 'already yours', false],
        ['Move…', 'now Active', false],
        ['Comment…', 'markdown, on the card', false],
        ['Prototype…', 'real code in a throwaway worktree, never shipped: its own chat', true],
        ['Open in browser', 'Azure Boards', false],
      ],
    ],
    [
      'an ended session: Reopen first',
      facts(runOn('review'), 'ended'),
      'lead',
      ['reopen', 'worktree'],
    ],
    [
      'its run failed: Reopen first',
      facts(runOn('build', 'needs-you'), 'ended'),
      'lead',
      ['reopen', 'worktree'],
    ],
    ['you stopped it: Reopen first', stoppedFacts(), 'lead', ['reopen', 'worktree']],
    [
      'Done with a pull request: Open pull request first',
      facts({ ...runOn('done', 'done'), pr: PR }, 'ended'),
      'lead',
      ['pull-request', 'worktree'],
    ],
    [
      'Done with a pull request: no row twice',
      facts({ ...runOn('done', 'done'), pr: PR }, 'ended'),
      'twice',
      [],
    ],
    [
      'a teammate’s card: Launch agent first, grey',
      facts(undefined, undefined, { card: SAMS, mine: false }),
      'lead',
      ['launch', 'worktree'],
    ],
    [
      'a teammate’s card with a session: Open worktree first, nothing lifted',
      facts(runOn('build'), 'working', { card: SAMS, mine: false }),
      'lead',
      ['worktree', 'workspace'],
    ],
    [
      'no one’s card: Assign to me and launch first',
      facts(undefined, undefined, { card: NO_ONES, mine: false }),
      'lead',
      ['launch', 'worktree'],
    ],
    [
      'a bug that does not reproduce: End: can’t reproduce right after the next step',
      NOT_REPRODUCED,
      'lead',
      ['workspace', 'end-not-reproduced'],
    ],
    [
      'a cloud session: Download locally under the separator',
      onBox(facts(runOn('build'), 'working')),
      'recovery',
      'download',
    ],
    [
      'a local session: Move to cloud under the separator',
      facts(runOn('build'), 'waiting'),
      'recovery',
      'move-to-cloud',
    ],
    ['no session: no recovery row', facts(), 'recovery', 'prototype'],
  ])('%s', (_, f, view, want) => {
    const m = cardMenu(f);

    const got: unknown = VIEWS[view](m.rows, m.title);

    expect(got).toEqual(want);
  });
});

describe('where ⌘⏎ opens: the top row, the launch where there is one, its cursor there', () => {
  // [top row's text, why it is grey, the row the menu opens on, grey]
  type Opens = readonly [string, string | undefined, string | undefined, boolean];

  test.each<[string, CardFacts, Opens]>([
    ['your card, no session: Launch agent', facts(), ['Launch agent', undefined, 'launch', false]],
    [
      'no one’s card: Assign to me and launch, open',
      facts(undefined, undefined, { card: NO_ONES, mine: false }),
      ['Assign to me and launch', undefined, 'launch', false],
    ],
    [
      'a teammate’s card: Launch agent grey, opened on anyway',
      facts(undefined, undefined, { card: SAMS, mine: false }),
      ['Launch agent', 'assigned to Sam Sample', 'launch', true],
    ],
    [
      'no one’s card on a read-only board: grey, opened on anyway',
      facts(undefined, undefined, { card: NO_ONES, mine: false, readOnly: true }),
      [
        'Launch agent',
        'assigned to no one · the board is read-only: assign it on the board, or abe board read-only off',
        'launch',
        true,
      ],
    ],
    [
      'running: Open workspace',
      facts(runOn('build'), 'working'),
      ['Open workspace', undefined, 'workspace', false],
    ],
    [
      'Done with a pull request: Open pull request',
      facts({ ...runOn('done', 'done'), pr: PR }, 'ended'),
      ['Open pull request', undefined, 'pull-request', false],
    ],
    // Reopen spends at once: the menu rests where it would without it
    [
      'an ended session: Reopen on top, not opened on',
      facts(runOn('review'), 'ended'),
      ['Reopen', undefined, undefined, false],
    ],
    [
      'a teammate’s card with a session: nothing lifted, resting as ever',
      facts(runOn('build'), 'working', { card: SAMS, mine: false }),
      ['Open worktree', undefined, undefined, false],
    ],
  ])('%s', (_, f, want) => {
    const m = cardMenu(f);
    const top = m.rows[0];

    expect([top?.text, top?.reason, m.preselect, m.greyPreselect === true]).toEqual([...want]);
  });
});

/** A row's reason, or `no row` when the menu has none of that id. */
const reasonOf = (row: { reason?: string | undefined } | undefined) =>
  row === undefined ? 'no row' : row.reason;

describe('why a card menu row is grey, or that it is not there', () => {
  test.each<[string, CardFacts, Readonly<Record<string, string | undefined>>]>([
    [
      'a done card launches too (its investigation closed it, its fix comes next)',
      facts(undefined, undefined, { card: CLOSED }),
      { launch: undefined },
    ],
    [
      'running: a launch stops it first, no retry; a local one has no box, so no Keep box awake',
      facts(runOn('build'), 'working'),
      { launch: undefined, retry: 'already running', keep: 'no row' },
    ],
    ['Assign… on your own card', facts(), { assign: 'already yours' }],
    [
      'Assign… on no one’s card',
      facts(undefined, undefined, { card: NO_ONES, mine: false }),
      { assign: undefined },
    ],
    // an unassigned prototype card you made is on Mine but no one's
    [
      'Assign… on no one’s card on Mine',
      facts(undefined, undefined, { card: NO_ONES, mine: true }),
      { assign: undefined },
    ],
    [
      // it would wake the box ahead of the queue
      'a queued box session: Keep box awake grey',
      onBox(facts(runOn('spec', 'queued'), 'queued')),
      { keep: 'queued: no box yet' },
    ],
    [
      'an ended session: nothing to stop, a new launch open',
      facts(runOn('review'), 'ended'),
      { stop: 'no session running', launch: undefined },
    ],
    [
      'its run failed: Retry run open',
      facts(runOn('build', 'needs-you'), 'ended'),
      { retry: undefined },
    ],
    ['you stopped it: Retry run open', stoppedFacts(), { retry: undefined }],
    [
      'a run over: Retry run grey, Reopen still offered as a plain conversation',
      facts({ ...runOn('done', 'done'), outcome: 'done' }, 'ended'),
      { retry: 'its run is over: Launch new agent… starts fresh', reopen: undefined },
    ],
    [
      'a plain session with no run: no Retry run row',
      facts(undefined, 'ended'),
      { retry: 'no row' },
    ],
    [
      'a teammate’s failed card: Retry run and Reopen grey with whose',
      facts(runOn('build', 'needs-you'), 'ended', { card: SAMS, mine: false }),
      { retry: 'assigned to Sam Sample', reopen: 'assigned to Sam Sample' },
    ],
    [
      'a teammate’s card: the launch rows grey with whose; Assign, Move, Comment work',
      facts(undefined, undefined, { card: SAMS, mine: false }),
      {
        launch: 'assigned to Sam Sample',
        reopen: 'assigned to Sam Sample',
        stop: 'assigned to Sam Sample',
        end: 'assigned to Sam Sample',
        keep: 'assigned to Sam Sample',
        'launch-local-sandbox': 'assigned to Sam Sample',
        workspace: 'Sam Sample’s workspace',
        assign: undefined,
        move: undefined,
        comment: undefined,
        prototype: undefined,
        browser: undefined,
      },
    ],
    [
      'no one’s card: Assign to me and launch open, the other launch rows say to assign it first',
      facts(undefined, undefined, { card: NO_ONES, mine: false }),
      {
        launch: undefined,
        'launch-local-sandbox': 'assigned to no one · Assign… › Me first',
        reopen: 'assigned to no one · Assign… › Me first',
        stop: 'assigned to no one · Assign… › Me first',
        keep: 'assigned to no one · Assign… › Me first',
      },
    ],
    [
      'no one’s card on a read-only board: Launch agent grey, why',
      facts(undefined, undefined, { card: NO_ONES, mine: false, readOnly: true }),
      {
        launch:
          'assigned to no one · the board is read-only: assign it on the board, or abe board read-only off',
      },
    ],
    [
      'no one’s card launched from Chat: its run is yours, nothing greyed for whose',
      LAUNCHED_NO_ONES,
      { stop: undefined, end: undefined, keep: undefined, workspace: undefined },
    ],
    [
      'a teammate’s card with a session stays theirs',
      facts(runOn('build'), 'working', { card: SAMS, mine: false }),
      { stop: 'assigned to Sam Sample' },
    ],
    ['abandoned: no one’s again', GIVEN_UP, { stop: 'assigned to no one · Assign… › Me first' }],
    [
      'abandoned on your card: End run… says it was abandoned, not done',
      { ...GIVEN_UP, card: CART, mine: true },
      { end: 'its run was abandoned' },
    ],
    ['End run… with no run', facts(), { end: 'no run yet' }],
    ['End run… on a run done', facts(runOn('done', 'done'), 'ended'), { end: 'its run is done' }],
    [
      'End run… on a running run: it can be ended too',
      facts(runOn('build'), 'working'),
      { end: undefined },
    ],
    [
      'End run… on a prototype: it never ships',
      facts({ ...runOn('build'), prototype: true }, 'working'),
      { end: 'a prototype: Stop… ends it' },
    ],
    [
      'End: can’t reproduce is not offered while the run goes on',
      facts(runOn('build'), 'working'),
      { 'end-not-reproduced': 'no row' },
    ],
    [
      'a run that never got a box: no Workspace to open, keep awake or download',
      neverPlaced(),
      {
        workspace: 'never got a box',
        keep: 'never got a box',
        download: 'never got a box',
        worktree: 'never got a box',
      },
    ],
    ['Open in browser: a card on Azure Boards', facts(), { browser: undefined }],
    [
      'Open in browser: a held card made here has no page',
      facts(undefined, undefined, { card: { ...CART, url: 'local:LC1' } }),
      { browser: 'no row' },
    ],
    [
      'Open in browser: a card of a board On this machine has none',
      facts(undefined, undefined, { card: { ...CART, url: 'local:2' } }),
      { browser: 'no row' },
    ],
    [
      'a queued cloud session: Download locally grey',
      onBox(facts(runOn('spec', 'queued'), 'queued')),
      { download: 'queued: no Workspace yet' },
    ],
    [
      'no session: no Download locally or Move to cloud',
      facts(),
      { download: 'no row', 'move-to-cloud': 'no row' },
    ],
    [
      'a local session, your boxes off: no cloud to Move to',
      { ...facts(runOn('build'), 'waiting'), boxesOff: true },
      { 'move-to-cloud': 'no row' },
    ],
  ])('%s', (_, f, want) => {
    const rows = cardMenu(f).rows;
    const got = Object.fromEntries(
      Object.keys(want).map((id) => [id, reasonOf(rows.find((r) => r.id === id))]),
    );

    expect(got).toEqual(want);
  });
});

/** Only `keys` of `o`, so a want names what it checks and an undefined one checks it is absent. */
const subset = (o: object | undefined, keys: readonly string[]) =>
  o === undefined ? undefined : Object.fromEntries(keys.map((k) => [k, Reflect.get(o, k)]));

const END_REASON = {
  name: 'reason',
  kind: 'flag',
  type: 'string',
  title: 'Why (kept with the run, on the pull request)',
  required: true,
  repeats: false,
  summary: 'why it ended',
};

describe('a card menu row’s words and what it does', () => {
  const working = facts(runOn('build'), 'working');
  const onBoxWorking = onBox(working);

  test.each<[string, CardFacts, string, Readonly<Record<string, unknown>>]>([
    [
      'running: Open workspace, no key of its own (⌃W is gone)',
      working,
      'workspace',
      { text: 'Open workspace', dim: 'local worktree', key: undefined },
    ],
    [
      'a live session: Reopen is Chat on it',
      working,
      'reopen',
      { dim: 'Chat on it', costly: false },
    ],
    [
      'the cloud target: Launch in Local sandbox stays, below the separator',
      facts(undefined, undefined, { target: 'cloud' }),
      'launch-local-sandbox',
      { separator: true },
    ],
    [
      'the team not read: Assign… says so',
      facts(undefined, undefined, { membersFailed: true }),
      'assign',
      { dim: 'Alex Example · team not read' },
    ],
    [
      'a box session: Open workspace names the box',
      onBoxWorking,
      'workspace',
      { dim: 'demo-shop-2', key: undefined },
    ],
    [
      'a box session: Open worktree from origin, open',
      onBoxWorking,
      'worktree',
      { dim: 'from origin', costly: true, reason: undefined },
    ],
    [
      'a box session: Keep box awake, its idle stop waits',
      onBoxWorking,
      'keep',
      {
        text: 'Keep box awake',
        dim: 'its idle stop waits',
        does: { kind: 'run', argv: ['box', 'keep', 'demo-shop-2'] },
      },
    ],
    [
      'a box session: Keep box awake · stops at its time',
      { ...onBoxWorking, idle: IDLE },
      'keep',
      { dim: 'stops at 01:30' },
    ],
    [
      'kept awake: the row lets it sleep',
      { ...onBoxWorking, idle: { ...IDLE, stopsAt: null, keptBy: ['awake' as const] } },
      'keep',
      {
        text: 'Let box sleep',
        dim: 'kept awake',
        does: { kind: 'run', argv: ['box', 'sleep', 'demo-shop-2'] },
      },
    ],
    [
      'a queued box session: Reopen is Chat on it',
      onBox(facts(runOn('spec', 'queued'), 'queued')),
      'reopen',
      { dim: 'Chat on it' },
    ],
    [
      'a local session: Open worktree · local',
      working,
      'worktree',
      { text: 'Open worktree', dim: 'local' },
    ],
    [
      'an ended session: Reopen says when it ended',
      facts(runOn('review'), 'ended'),
      'reopen',
      {
        text: 'Reopen',
        dim: expect.stringMatching(/^same worktree and conversation · ended \d{2}:\d{2}$/),
      },
    ],
    // a new session on a card that had one says so
    [
      'an ended session: Launch new agent…',
      facts(runOn('review'), 'ended'),
      'launch',
      { text: 'Launch new agent…' },
    ],
    [
      'Retry run on a run not over',
      facts(runOn('build', 'needs-you'), 'ended'),
      'retry',
      { text: 'Retry run', dim: 'a new session from decide, same worktree' },
    ],
    [
      'Done with a pull request: Open pull request opens it',
      facts({ ...runOn('done', 'done'), pr: PR }, 'ended'),
      'pull-request',
      {
        text: 'Open pull request',
        dim: '#10',
        does: { kind: 'shell', effect: { kind: 'open-url', url: PR.url } },
      },
    ],
    [
      'no one’s card: Assign… says no one',
      facts(undefined, undefined, { card: NO_ONES, mine: false }),
      'assign',
      { dim: 'no one' },
    ],
    [
      'End run… asks how and why, then runs abe factory end on the card',
      DEPLOY_FAILED,
      'end',
      {
        text: 'End run…',
        costly: true,
        dim: 'done, not reproduced or abandoned, with why',
        reason: undefined,
        does: {
          kind: 'run',
          argv: ['factory', 'end', '2'],
          ask: [
            {
              name: 'as',
              kind: 'flag',
              type: 'enum',
              values: ['done', 'not-reproduced', 'abandoned'],
              labels: {
                done: 'Done',
                'not-reproduced': 'Not reproduced',
                abandoned: 'Abandoned',
              },
              title: 'End the run as',
              required: true,
              repeats: false,
              summary: 'how it ended',
              // the neutral way first: a failed deploy is no ship
              preselect: 'abandoned',
            },
            END_REASON,
          ],
        },
      },
    ],
    [
      'End: can’t reproduce, with the evidence',
      NOT_REPRODUCED,
      'end-not-reproduced',
      {
        text: 'End: can’t reproduce',
        costly: true,
        dim: 'Not reproduced on main (939433b)',
        reason: undefined,
        does: {
          kind: 'run',
          argv: ['factory', 'end', '2', '--as', 'not-reproduced'],
          ask: [END_REASON],
        },
      },
    ],
    [
      'a run that never got a box: Open workspace names no box',
      neverPlaced(),
      'workspace',
      { dim: undefined },
    ],
    [
      'a box tagged with the card (an earlier run’s, asleep): Keep box awake keeps that one',
      { ...neverPlaced(), box: 'demo-shop-2' },
      'keep',
      { does: { kind: 'run', argv: ['box', 'keep', 'demo-shop-2'] } },
    ],
    [
      'a cloud session: Download locally, from the shown project',
      onBoxWorking,
      'download',
      {
        text: 'Download locally',
        costly: true,
        dim: 'recovery · go on on this machine',
        reason: undefined,
        does: { kind: 'run', argv: ['session', 'download', 's2', '--repo', ROOT] },
      },
    ],
    [
      'a local session: Move to cloud',
      facts(runOn('build'), 'waiting'),
      'move-to-cloud',
      {
        text: 'Move to cloud',
        costly: true,
        dim: 'recovery · go on in the cloud',
        reason: undefined,
        does: { kind: 'run', argv: ['session', 'move-to-cloud', 's2'] },
      },
    ],
  ])('%s', (_, f, id, want) => {
    const row = cardMenu(f).rows.find((r) => r.id === id);

    expect(subset(row, Object.keys(want))).toEqual(want);
  });
});

describe('Assign… asks whom: Me while not yours, then the team A to Z, its assignee left out', () => {
  const members = TEAM_MEMBERS;
  const twins = [...members, { name: 'Sam Sample', email: 'sam2@example.test', you: false }];
  const EVERYONE = {
    reason: undefined,
    values: ['me', 'robin@example.test', 'sam@example.test'],
    labels: ['Me', 'Robin Placeholder', 'Sam Sample'],
  };

  test.each<[string, CardFacts, unknown]>([
    [
      'yours: the teammates only',
      facts(undefined, undefined, { members }),
      {
        reason: undefined,
        values: ['robin@example.test', 'sam@example.test'],
        labels: ['Robin Placeholder', 'Sam Sample'],
      },
    ],
    [
      'Sam’s: Me, then Robin; Sam is who it is now',
      facts(undefined, undefined, { card: SAMS, mine: false, members }),
      {
        reason: undefined,
        values: ['me', 'robin@example.test'],
        labels: ['Me', 'Robin Placeholder'],
      },
    ],
    [
      'no one’s: Me and everyone',
      facts(undefined, undefined, { card: NO_ONES, mine: false, members }),
      EVERYONE,
    ],
    [
      'no one’s on Mine (an unassigned prototype card you made): Me and everyone',
      facts(undefined, undefined, { card: NO_ONES, mine: true, members }),
      EVERYONE,
    ],
    [
      'two of one name told apart by their emails',
      facts(undefined, undefined, { members: twins }),
      {
        reason: undefined,
        values: ['robin@example.test', 'sam@example.test', 'sam2@example.test'],
        labels: [
          'Robin Placeholder',
          'Sam Sample <sam@example.test>',
          'Sam Sample <sam2@example.test>',
        ],
      },
    ],
    [
      'a team of you alone: nothing to pick on your own card',
      facts(undefined, undefined, { members: members.slice(0, 1) }),
      { reason: 'already yours', values: [], labels: [] },
    ],
  ])('%s', (_, f, want) => {
    const row = cardMenu(f).rows.find((r) => r.id === 'assign');
    const does = row?.does;
    const [who] = does?.kind === 'back' ? (does.ask ?? []) : [];

    const got: unknown = {
      reason: row?.reason,
      values: who?.values,
      labels: who?.values?.map((v) => who.labels?.[v] ?? v),
    };

    expect(got).toEqual(want);
  });
});

describe('launchArgv: each value one argument, never read as a flag', () => {
  test.each<[string, Parameters<typeof launchArgv>[2], Readonly<Record<string, unknown>>]>([
    [
      'a note that is a markdown list (a leading `-`), with a workflow',
      { note: '- use the price helper\n- no new dependency', workflow: 'bug' },
      { note: '- use the price helper\n- no new dependency', workflow: 'bug' },
    ],
    [
      'a note that starts like a flag',
      { note: '--force is not wanted' },
      { note: '--force is not wanted' },
    ],
  ])('%s', (_, how, want) => {
    const parsed = parse(launchArgv({ card: { id: 4 }, root: ROOT }, undefined, how));

    expect(parsed.ok && parsed.args).toMatchObject(want);
  });
});

// ---------------------------------------------------------------- the Board, Command mode over it

const MINE = [
  listCard(4, 'Cart total includes shipping', 'Active', 'Alex Example', {
    description:
      '## Why\n\nShoppers pay more than the cart said.\n\n## What\n\nShipping in the total.',
    acceptanceCriteria: '- Total = items + shipping',
    tags: ['cart'],
  }),
  listCard(5, 'Saved carts survive sign-out', 'New'),
];
const SAM = listCard(9, 'Coupon field accepts spaces', 'New', 'Sam Sample');
const TEAM = [...MINE, SAM];
const RUNS = [
  factoryRun(5, 'Saved carts survive sign-out', 'build', 'running', { since: minutes(1) }),
];
const SESSIONS = [session('s5', 'working', 5)];
const WORLD: BoardWorld = {
  mine: MINE,
  team: TEAM,
  runs: RUNS,
  sessions: SESSIONS,
  settings: { 'serve.target': 'cloud' },
};

/** A jump (Open card, ⌃L, Open workspace), on whatever story the window would hand on with it. */
type Jump = { readonly jump: Parameters<Drive<Node>['jump']>[0] };

/** A key by its name, an input, a jump key, or the reads asked answered by these replies. */
type Act = string | Input | Jump | Replies;

const click = (id: string): Input => ({ kind: 'click', id });
const jump = (to: Jump['jump']): Jump => ({ jump: to });
const text = (t: string): Input => ({ kind: 'text', text: t });
/** Each character a key, a space `<Space>`. */
const typed = (t: string): string[] => Array.from(t, (c) => (c === ' ' ? '<Space>' : c));

type Reply<K extends Answer['command']> = Extract<Answer, { command: K }>['reply'];
type DataOf<K extends Answer['command']> = Extract<Reply<K>, { ok: true }>['data'];
/** Why a command was refused: the same body for every command. */
type Refusal = Extract<Answer['reply'], { ok: false }>['error'];
type Said<K extends Answer['command']> =
  { ok: true; data: DataOf<K> } | { ok: false; error: Refusal };

const result = <K extends Answer['command']>(command: K, reply: Said<K>, text?: string): Answer =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- `K`'s answer: a type parameter does not pick the union's member
  ({ kind: 'result', id: '', command, reply, ...(text === undefined ? {} : { text }) }) as Answer;

/** Reads of `command` (or of the argv `at` names) answered with `data`. */
const ok = <K extends Answer['command']>(
  command: K,
  data: DataOf<K>,
  o: { text?: string; at?: string } = {},
): Replies => repliesBy({ [o.at ?? command]: result(command, { ok: true, data }, o.text) });

/** Reads of `command` refused with `error`. */
const no = (command: Answer['command'], error: Refusal, at?: string): Replies =>
  repliesBy({ [at ?? command]: result(command, { ok: false, error }) });

/** `abe card <verb>` ran: the Board reads both lists again. */
const ran = (verb: string): Input => ({
  kind: 'event',
  event: {
    seq: 30,
    at: minutes(7),
    type: 'command.ran',
    data: { noun: 'card', verb, exit: 0 },
  },
});

/** serve came up again: the Board reads everything again. */
const SERVE_STARTED: Input = {
  kind: 'event',
  event: {
    seq: 40,
    at: minutes(9),
    type: 'serve.started',
    data: { version: '0.0.0', pid: 1, socket: '/tmp/abe.sock' },
  },
};

/**
 * A minute on: a primary button takes no ⏎ too soon after its layer opened, so a held ⏎ never
 * also launches.
 */
const LATER: Input = { kind: 'tick', at: minutes(7) };

/** ⌘⏎ ⇞ ⏎: the menu's first row, not where it rests: Launch agent, the Launch box. */
const OPEN_BOX = ['<D-CR>', '<PageUp>', '<CR>'];
/** Launch agent, then the Launch box's ⏎. */
const LAUNCH = [...OPEN_BOX, LATER, '<CR>'];
/** LAUNCH once more, its box's ⏎ a minute after LAUNCH's. */
const AGAIN = [...OPEN_BOX, { kind: 'tick', at: minutes(8) } satisfies Input, '<CR>'];

const MEMBERS = ok('card members', { members: TEAM_MEMBERS });

/** What a step looks at, only the parts it names. */
type Want = {
  /** The reads asked since the step before and not answered, by their first words: each argv. */
  asked?: Readonly<Record<string, readonly (readonly string[])[]>>;
  /** Command mode's top layer's kind, null with none up. */
  layer?: string | null;
  pick?: PickWant;
  /** Some props of the layer up. */
  props?: Readonly<Record<string, unknown>>;
  /** The status line's last words since the step before. */
  status?: string;
  balloons?: readonly string[];
  /** The effects since the step before of the kinds these name, in order. */
  effects?: readonly ShellEffect[];
  /** The Chat column's opens and focus. */
  chat?: readonly Command[];
  /** The card drawn selected, null with none. */
  selected?: string | null;
  /** Some props of these nodes. */
  nodes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Whether these nodes are in the tree. */
  has?: Readonly<Record<string, boolean>>;
  /** Whether a card's rail shows it on a box. */
  boxed?: Readonly<Record<string, boolean>>;
  /** The New card dialog asked for since, some of its fields; null with none. */
  newcard?: Readonly<Record<string, unknown>> | null;
  /** How many commands of these kinds came since. */
  sent?: Readonly<Partial<Record<Command['kind'], number>>>;
  /** The Board's tab. */
  tab?: string;
  /** What `:` starts from: whether a board is in force, some fields of its first row. */
  here?: { board?: boolean | undefined; first?: Readonly<Record<string, unknown>> };
};

type PickWant = {
  title?: string;
  selected?: string | undefined;
  /** The first row's id. */
  lead?: string | undefined;
  ids?: readonly string[];
  texts?: readonly string[];
  /** Each row as [text, dim, note, reason]. */
  rows?: readonly (readonly unknown[])[];
  /** The row with a separator, null with none. */
  separator?: string | null;
  /** By id: its reason, or `no row`. */
  reasons?: Readonly<Record<string, string | undefined>>;
  dims?: Readonly<Record<string, string | undefined>>;
};

type PickProps = Extract<Node, { kind: 'PickLayer' }>['props'];

const pickSeen = (p: PickProps, w: PickWant): PickWant => {
  const g: PickWant = {};
  const row = (id: string) => p.rows.find((r) => r.id === id);

  if ('title' in w) g.title = p.title;
  if ('selected' in w) g.selected = p.selected;
  if ('lead' in w) g.lead = p.rows[0]?.id;
  if ('ids' in w) g.ids = p.rows.map((r) => r.id);
  if ('texts' in w) g.texts = p.rows.map((r) => r.text);
  if ('rows' in w) g.rows = p.rows.map((r) => [r.text, r.dim, r.note, r.reason]);
  if ('separator' in w) g.separator = p.rows.find((r) => r.separator === true)?.id ?? null;
  if (w.reasons !== undefined)
    g.reasons = Object.fromEntries(Object.keys(w.reasons).map((id) => [id, reasonOf(row(id))]));
  if (w.dims !== undefined)
    g.dims = Object.fromEntries(Object.keys(w.dims).map((id) => [id, row(id)?.dim]));

  return g;
};

const selectedCard = (tree: Node): string | null =>
  nodesOf(tree).find(
    (n) =>
      n.kind === 'BoardCard' &&
      (n.props.selection === 'selected' || n.props.selection === 'selected-inactive'),
  )?.id ?? null;

const startsWith = (argv: readonly string[], words: string) =>
  words.split(' ').every((w, i) => argv[i] === w);

const wanted = (d: Drive<Node>, since: readonly Command[], w: Want): Want => {
  const g: Want = {};
  const effects = since.flatMap((c) => (c.kind === 'shell' ? [c.effect] : []));
  const held = new Set(d.commands);
  const asked = since.flatMap((c) => (c.kind === 'run' && held.has(c) ? [c.argv] : []));
  const layer = d.layer;

  if (w.asked !== undefined)
    g.asked = Object.fromEntries(
      Object.keys(w.asked).map((k) => [k, asked.filter((a) => startsWith(a, k))]),
    );
  if ('layer' in w) g.layer = layer?.kind ?? null;
  if (w.pick !== undefined)
    g.pick = layer?.kind === 'PickLayer' ? pickSeen(layer.props, w.pick) : { title: 'no pick up' };
  if (w.props !== undefined) g.props = subset(layer?.props, Object.keys(w.props)) ?? {};
  if ('status' in w) {
    const said = effects.flatMap((e) => (e.kind === 'status' ? [e.text] : [])).at(-1);

    if (said !== undefined) g.status = said;
  }
  if (w.balloons !== undefined)
    g.balloons = effects.flatMap((e) => (e.kind === 'balloon' ? [e.text] : []));
  if (w.effects !== undefined) {
    const kinds = new Set(w.effects.map((e) => e.kind));

    g.effects = effects.filter((e) => kinds.has(e.kind));
  }
  if (w.chat !== undefined) g.chat = chatCommands(since);
  if ('selected' in w) g.selected = selectedCard(d.tree);
  if (w.nodes !== undefined)
    g.nodes = Object.fromEntries(
      Object.entries(w.nodes).map(([id, p]) => [
        id,
        subset(nodeById(d.tree, id).props, Object.keys(p)) ?? {},
      ]),
    );
  if (w.has !== undefined)
    g.has = Object.fromEntries(
      Object.keys(w.has).map((id) => [id, nodesOf(d.tree).some((n) => n.id === id)]),
    );
  if (w.boxed !== undefined)
    g.boxed = Object.fromEntries(
      Object.keys(w.boxed).map((id) => {
        const n = nodeById(d.tree, id);

        return [id, n.kind === 'BoardCard' && n.props.rail?.box !== undefined];
      }),
    );
  if ('newcard' in w) {
    const opened = since.filter((c) => c.kind === 'newcard').at(-1);

    g.newcard =
      opened === undefined || w.newcard === null
        ? (opened ?? null)
        : (subset(opened, Object.keys(w.newcard)) ?? null);
  }
  if (w.sent !== undefined)
    g.sent = Object.fromEntries(
      Object.keys(w.sent).map((k) => [k, since.filter((c) => c.kind === k).length]),
    );
  if ('tab' in w) {
    const head: Record<string, unknown> = nodeById(d.tree, 'board-head').props;

    g.tab = String(head.selected);
  }
  if (w.here !== undefined) {
    const here: NonNullable<Want['here']> = {};

    if ('board' in w.here) here.board = d.here?.board;
    if (w.here.first !== undefined)
      here.first = subset(d.here?.view?.menu.rows[0], Object.keys(w.here.first)) ?? {};
    g.here = here;
  }

  return g;
};

/** The Board on a world over `WORLD`; `first` answers its first reads in place of the world. */
type Script = {
  world?: BoardWorld;
  first?: Replies;
  steps: readonly (readonly [readonly Act[], Want])[];
};

const board = (world: BoardWorld = {}, first?: Replies) =>
  driveBoard({
    params: { root: ROOT },
    now: minutes(6),
    world: { ...WORLD, ...world },
    ...(first === undefined ? {} : { replies: first }),
  });

/** Each step's acts, then what it wants. A step sees only what came since the step before. */
const play = ({ world, first, steps }: Script) => {
  const d = board(world, first);

  steps.forEach(([acts, want], i) => {
    const before = new Set(i === 0 ? [] : d.commands);

    for (const a of acts) {
      if (typeof a === 'string') d.keys(a);
      else if (typeof a === 'function') d.answer(a);
      else if ('jump' in a) d.jump(a.jump);
      else d.send(a);
    }
    expect([
      i,
      wanted(
        d,
        d.commands.filter((c) => !before.has(c)),
        want,
      ),
    ]).toEqual([i, want]);
  });
};

const run = (card: number, ...more: string[]) => [
  'factory',
  'run',
  String(card),
  '--repo',
  ROOT,
  ...more,
];

const launched4 = factoryRun(4, 'Cart total includes shipping', 'spec', 'running', {
  since: minutes(6),
});
/** Card 5's run failed and its session ended. */
const FAILED_5: BoardWorld = {
  runs: [factoryRun(5, 'Saved carts survive sign-out', 'build', 'needs-you', { session: 's5' })],
  sessions: [session('s5', 'ended', 5)],
};

describe('a launch runs one factory run, from the shown project', () => {
  test.each<[string, Script]>([
    [
      'Launch agent on a card of yours: into the cloud; nothing to the board, no Chat of its own',
      {
        steps: [
          [
            [click('card:4'), ...LAUNCH],
            {
              asked: {
                'factory run': [run(4)],
                'card comment': [],
                'card move': [],
                'card assign': [],
              },
              layer: null,
              chat: [],
              has: { chat: false },
            },
          ],
        ],
      },
    ],
    [
      'launched: Launching… on its card and the status line until its run answers',
      {
        steps: [
          [
            [click('card:4'), ...LAUNCH],
            {
              status: 'Launching #4…',
              nodes: {
                'card:4': {
                  rail: {
                    segments: ['todo', 'todo', 'todo', 'todo', 'todo'],
                    glyph: '●',
                    word: 'Launching…',
                    state: 'starting',
                  },
                },
              },
            },
          ],
          [
            [ok('factory run', launched4)],
            {
              nodes: {
                'card:4': {
                  rail: {
                    segments: ['now', 'todo', 'todo', 'todo', 'todo'],
                    stage: 'Spec',
                    glyph: '●',
                    word: 'Writing spec',
                    state: 'running',
                    time: '1 min',
                  },
                },
              },
            },
          ],
        ],
      },
    ],
    [
      'a double launch launches once',
      {
        steps: [
          [[click('card:4'), ...LAUNCH], { asked: { 'factory run': [run(4)] } }],
          [['<Esc>', ...AGAIN], { asked: { 'factory run': [] } }],
        ],
      },
    ],
    [
      'launched elsewhere (Chat, the CLI): Launching… on its card, none launched here; refused, no session again',
      {
        steps: [
          [
            [eventInput({ type: 'launch.started', data: { card: 4, repo: ROOT } })],
            {
              nodes: {
                'card:4': {
                  rail: {
                    segments: ['todo', 'todo', 'todo', 'todo', 'todo'],
                    glyph: '●',
                    word: 'Launching…',
                    state: 'starting',
                  },
                },
              },
            },
          ],
          [[click('card:4'), ...LAUNCH], { asked: { 'factory run': [] } }],
          [
            [
              '<Esc>',
              eventInput({
                type: 'launch.ended',
                data: {
                  card: 4,
                  repo: ROOT,
                  session: null,
                  refused: { code: 'no-boxes', message: 'no environment' },
                },
              }),
            ],
            // no session, as before it
            { nodes: { 'card:4': { rail: undefined } } },
          ],
        ],
      },
    ],
    [
      'another project shown: its board read anew, then launched from its folder',
      {
        steps: [
          [
            [{ kind: 'root', root: '/home/me/projects/demo-api' }],
            {
              asked: {
                'card list': [
                  ['card', 'list', '--mine', '--closed'],
                  ['card', 'list', '--closed'],
                ],
                'settings get serve.target': [['settings', 'get', 'serve.target']],
              },
            },
          ],
          // its runs and sessions in: until then the menu waits for them
          [
            [boardReplies(WORLD), click('card:4'), ...LAUNCH],
            {
              asked: {
                'factory run': [['factory', 'run', '4', '--repo', '/home/me/projects/demo-api']],
              },
            },
          ],
        ],
      },
    ],
    [
      'Launch in Local sandbox with its target',
      {
        steps: [
          [
            [click('card:4'), '<D-CR>', ...typed('Local'), '<CR>'],
            { layer: 'LaunchBox', props: { ran: 'local-sandbox' }, asked: { 'factory run': [] } },
          ],
          [[LATER, '<CR>'], { asked: { 'factory run': [run(4, '--target', 'local-sandbox')] } }],
        ],
      },
    ],
    [
      'Launch new agent… on a stopped session opens the Launch box empty; its ⏎ is a new session with the note',
      {
        // a session you stopped stands for its card
        world: { runs: [], sessions: [{ ...session('s5', 'ended', 5), stopped: true }] },
        steps: [
          [
            [click('card:5'), '<D-CR>', ...typed('Launch new')],
            { pick: { texts: ['Launch new agent…'] } },
          ],
          [['<CR>'], { layer: 'LaunchBox', props: { draft: '' }, asked: { 'factory run': [] } }],
          [
            [text('start over'), LATER, '<CR>'],
            { asked: { 'factory run': [run(5, '--note=start over')] } },
          ],
        ],
      },
    ],
    [
      'Retry run carries the run’s Launch note and workflow',
      {
        world: {
          runs: [
            {
              ...factoryRun(5, 'Saved carts survive sign-out', 'build', 'needs-you', {
                since: minutes(1),
              }),
              workflow: { id: 'bug', name: 'Bug', layer: 'built-in', steps: [] },
              note: { by: 'Alex Example', text: 'use the price helper', at: minutes(0) },
            },
          ],
          sessions: [session('s5', 'ended', 5)],
        },
        steps: [
          [[click('card:5'), '<D-CR>', ...typed('retry')], { pick: { selected: 'retry' } }],
          [
            ['<CR>'],
            {
              asked: {
                'factory run': [run(5, '--workflow', 'bug', '--note=use the price helper')],
              },
            },
          ],
        ],
      },
    ],
    [
      'a teammate’s card: Assign › Me, then Launch agent launches',
      {
        steps: [
          [
            ['<Tab>', click('card:9'), '<D-CR>', ...typed('ass'), '<CR>'],
            { pick: { texts: ['Me'] } },
          ],
          [['<CR>'], { asked: { 'card assign': [['card', 'assign', '9', 'me']] } }],
          // the write's event reads both lists again
          [
            [ran('assign')],
            {
              asked: {
                'card list': [
                  ['card', 'list', '--mine', '--closed'],
                  ['card', 'list', '--closed'],
                ],
              },
            },
          ],
          [
            [
              boardReplies({
                ...WORLD,
                mine: [...MINE, { ...SAM, assignee: MINE[0]?.assignee ?? null }],
              }),
              click('card:9'),
              ...LAUNCH,
            ],
            { asked: { 'factory run': [run(9)] } },
          ],
        ],
      },
    ],
    [
      '⏎ on a card opens its Card page as the Board’s popup, its workspace here or not, launching nothing',
      {
        steps: [
          [[click('card:4')], {}],
          [['<CR>'], { layer: null, sent: { open: 1 }, asked: { 'factory run': [] } }],
          [[click('card:5')], {}],
          [
            ['<CR>'],
            {
              layer: null,
              sent: { open: 1 },
              asked: { 'factory run': [] },
            },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('a launch answered', () => {
  test.each<[string, Script]>([
    [
      'the run on its card, selected, Chat on its session with the keys; the runs and sessions read again',
      {
        steps: [
          [
            [click('card:4'), ...LAUNCH, ok('factory run', launched4)],
            {
              chat: chatOpened(4, 's4'),
              asked: {
                'factory status': [['factory', 'status']],
                'session list': [['session', 'list']],
              },
            },
          ],
          [
            [
              boardReplies({
                ...WORLD,
                runs: [...RUNS, launched4],
                sessions: [...SESSIONS, session('s4', 'starting', 4)],
              }),
            ],
            {
              selected: 'card:4',
              nodes: {
                'card:4': {
                  rail: expect.objectContaining({ state: 'starting', word: 'Starting' }),
                },
              },
            },
          ],
        ],
      },
    ],
    [
      'refused: a balloon in its words, and ⏎ launches again',
      {
        steps: [
          [
            [
              click('card:4'),
              ...LAUNCH,
              no('factory run', { code: 'no-github-repo', message: 'no GitHub repo here' }),
            ],
            { balloons: ['no GitHub repo here (no-github-repo)'] },
          ],
          [['<Esc>', ...AGAIN], { asked: { 'factory run': [run(4)] } }],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

/** `box-short` as serve refuses a launch onto a box short of memory. */
const SHORT = {
  code: 'box-short',
  message: 'demo-shop is short of memory …',
  boxShort: {
    box: 'demo-shop',
    short: 'memory' as const,
    line: 'demo-shop is short of memory: 1.4 GB free, 3 workspaces (#101 working)',
    resize: 'm8g.xlarge',
    choices: [
      {
        answer: 'resize' as const,
        label: 'Resize to m8g.xlarge',
        note: 'stops the box ~2 min: #101 ends mid-turn',
        recommended: true,
      },
      {
        answer: 'anyway' as const,
        label: 'Launch anyway',
        note: 'they share memory; a build may be killed',
      },
      { answer: 'cancel' as const, label: 'Cancel' },
    ],
  },
};

const SHORT_PICK: PickWant = {
  title: 'demo-shop is short of memory: 1.4 GB free, 3 workspaces (#101 working)',
  rows: [
    [
      'Resize to m8g.xlarge',
      'stops the box ~2 min: #101 ends mid-turn · recommended',
      undefined,
      undefined,
    ],
    ['Launch anyway', 'they share memory; a build may be killed', undefined, undefined],
    ['Cancel', undefined, undefined, undefined],
  ],
};

describe('its repo’s box short: asked Resize, Launch anyway or Cancel, resting off Resize; the answer runs it again with it', () => {
  const launchShort = [click('card:4'), ...LAUNCH, no('factory run', SHORT)];

  test.each<[string, Script]>([
    [
      'Launch agent, then Launch anyway',
      {
        steps: [
          // no balloon: it is a question
          [launchShort, { pick: SHORT_PICK, balloons: [] }],
          [['<CR>'], { asked: { 'factory run': [run(4, '--short', 'anyway')] } }],
        ],
      },
    ],
    [
      'Launch agent, then Resize',
      {
        steps: [
          [launchShort, { pick: SHORT_PICK }],
          [['<Up>', '<CR>'], { asked: { 'factory run': [run(4, '--short', 'resize')] } }],
        ],
      },
    ],
    [
      'Launch agent, then Cancel',
      {
        steps: [
          [launchShort, { pick: SHORT_PICK }],
          [['<Down>', '<CR>'], { asked: { 'factory run': [] } }],
        ],
      },
    ],
    [
      'Retry run, then Launch anyway',
      {
        world: FAILED_5,
        steps: [
          [
            [click('card:5'), '<D-CR>', ...typed('retry'), '<CR>', no('factory run', SHORT)],
            { pick: SHORT_PICK, balloons: [] },
          ],
          [['<CR>'], { asked: { 'factory run': [run(5, '--short', 'anyway')] } }],
        ],
      },
    ],
    [
      'Move to cloud (Command mode runs it), then Launch anyway',
      {
        world: FAILED_5,
        steps: [
          [
            [
              click('card:5'),
              '<D-CR>',
              text('to cloud'),
              '<CR>',
              no('session move-to-cloud', SHORT),
            ],
            { pick: SHORT_PICK, balloons: [] },
          ],
          [
            ['<CR>'],
            {
              asked: {
                'session move-to-cloud': [['session', 'move-to-cloud', 's5', '--short', 'anyway']],
              },
            },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('⌘⏎ is the card’s Action menu', () => {
  test.each<[string, Script]>([
    [
      'no session: Launch agent first, opened on; each row the abe command it runs; keys dim',
      {
        steps: [
          [
            [click('card:4'), '<D-CR>'],
            {
              pick: {
                title: '#4 Cart total includes shipping',
                rows: [
                  ['Launch agent', 'Cloud · its workflow, a note', undefined, undefined],
                  ['Open worktree', 'from origin', undefined, undefined],
                  ['Open workspace', 'local worktree', undefined, 'no workspace yet'],
                  ['Reopen', undefined, undefined, 'no session yet'],
                  ['Stop…', undefined, undefined, 'no session running'],
                  [
                    'End run…',
                    'done, not reproduced or abandoned, with why',
                    undefined,
                    'no run yet',
                  ],
                  ['Assign…', 'Alex Example', undefined, 'already yours'],
                  ['Move…', 'now Active', undefined, undefined],
                  ['Comment…', 'markdown, on the card', undefined, undefined],
                  ['Keep box awake', undefined, undefined, 'no box yet'],
                  [
                    'Launch in Local sandbox',
                    'this machine · no cloud writes',
                    undefined,
                    undefined,
                  ],
                  [
                    'Prototype…',
                    'real code in a throwaway worktree, never shipped: its own chat',
                    undefined,
                    undefined,
                  ],
                ],
                // twelve rows a window: Show prototype and Open in browser scroll in
                separator: 'launch-local-sandbox',
                selected: 'launch',
              },
            },
          ],
        ],
      },
    ],
    [
      'a running card: Open workspace first, resting on it; its ⏎ asks the workspace’s attach-spec',
      {
        steps: [
          [
            [click('card:5'), '<D-CR>'],
            {
              pick: {
                lead: 'workspace',
                dims: {
                  workspace: 'local worktree',
                  launch: 'Cloud · its workflow, a note · stops s5 first',
                },
                reasons: { launch: undefined },
                selected: 'workspace',
              },
            },
          ],
          [
            ['<CR>'],
            {
              layer: null,
              asked: { 'workspace attach-spec': [['workspace', 'attach-spec', 's5']] },
            },
          ],
        ],
      },
    ],
    [
      'Open workspace typed for: the same attach-spec',
      {
        steps: [
          [
            [click('card:5'), '<D-CR>', ...typed('wor'), '<CR>'],
            {
              layer: null,
              asked: { 'workspace attach-spec': [['workspace', 'attach-spec', 's5']] },
            },
          ],
        ],
      },
    ],
    [
      'typed: the separator parts the recovery rows only while the menu is unfiltered',
      { steps: [[[click('card:4'), '<D-CR>', 'L', 'a'], { pick: { separator: null } }]] },
    ],
    [
      'moves pass over grey rows; arrows move, every letter types at once; Esc closes',
      {
        steps: [
          [[click('card:4'), '<D-CR>', '<Down>'], { pick: { selected: 'worktree' } }],
          // Assign… is grey on a card already yours
          [['<Down>'], { pick: { selected: 'move' } }],
          [['<Up>', '<Up>'], { pick: { selected: 'launch' } }],
          [['<Up>'], { pick: { selected: 'launch' } }],
          [['m', 'o', 'v'], { pick: { ids: ['move'], selected: 'move' } }],
          [['<Esc>'], { layer: null }],
        ],
      },
    ],
    [
      '⌘⏎ ⏎ fast spends nothing: the ⏎ opens the Launch box, a held ⏎ launches nothing',
      {
        steps: [
          [
            [click('card:4'), '<D-CR>', '<CR>'],
            { layer: 'LaunchBox', asked: { 'factory run': [] } },
          ],
          [['<CR>', '<CR>'], { layer: 'LaunchBox', asked: { 'factory run': [] } }],
        ],
      },
    ],
    [
      'no one’s card: Assign to me and launch first, opened on; its ⏎ the Launch box, launched, then yours with u to undo',
      {
        world: { team: [...TEAM, listCard(7, 'Gift cards at checkout', 'New', null)] },
        steps: [
          [
            ['<Tab>', click('card:7'), '<D-CR>'],
            {
              pick: {
                lead: 'launch',
                selected: 'launch',
                dims: { launch: 'Cloud · its workflow, a note · yours once launched' },
                reasons: { launch: undefined },
              },
            },
          ],
          [['<CR>'], { layer: 'LaunchBox', asked: { 'factory run': [], 'card assign': [] } }],
          [[LATER, '<CR>'], { layer: null, asked: { 'factory run': [run(7)], 'card assign': [] } }],
          [[launched(7)], { asked: { 'card assign': [['card', 'assign', '7', 'me']] } }],
          [
            [assignAnswer(listCard(7, 'Gift cards at checkout', 'New', null))],
            { status: 'Assigned #7 to you · u undo' },
          ],
          [['u'], { asked: { 'card assign': [['card', 'assign', '7', 'none']] } }],
        ],
      },
    ],
    [
      'an ended session: Reopen first (it spends), the menu resting on a row that spends nothing',
      {
        world: { sessions: [session('s5', 'ended', 5)] },
        steps: [
          [[click('card:5'), '<D-CR>'], { pick: { lead: 'reopen', selected: 'worktree' } }],
          [['<CR>'], { asked: { 'factory run': [], 'session reopen': [] } }],
        ],
      },
    ],
    [
      'a teammate’s card: ⏎ launches nothing; the launch rows grey with whose, opened on the top one',
      {
        steps: [
          [['<Tab>', click('card:9'), '<CR>'], { asked: { 'factory run': [] } }],
          [
            ['<Esc>', '<D-CR>'],
            {
              pick: {
                reasons: {
                  launch: 'assigned to Sam Sample',
                  reopen: 'assigned to Sam Sample',
                  stop: 'assigned to Sam Sample',
                  keep: 'assigned to Sam Sample',
                  workspace: 'Sam Sample’s workspace',
                },
                lead: 'launch',
                selected: undefined,
              },
            },
          ],
          // the cursor on the grey top row: ⏎ nothing, a move the next row that can run
          [['<CR>'], { layer: 'PickLayer', asked: { 'factory run': [] } }],
          [['<Down>'], { pick: { selected: 'worktree' } }],
          [
            [...typed('Com'), '<CR>', text('Mine next?'), '<CR>'],
            { asked: { 'card comment': [['card', 'comment', '9', '--text', 'Mine next?']] } },
          ],
        ],
      },
    ],
    [
      'Open in browser opens the card on Azure Boards',
      {
        steps: [
          [
            [click('card:4'), '<D-CR>', ...typed('brow'), '<CR>'],
            { effects: [{ kind: 'open-url', url: MINE[0]?.url ?? '' }] },
          ],
        ],
      },
    ],
    [
      'Prototype… starts a prototype session on the card, Chat then on it',
      {
        steps: [
          [
            [click('card:4'), '<D-CR>', ...typed('Proto'), '<CR>'],
            {
              asked: {
                'prototype start': [
                  ['prototype', 'start', '--card', '4', '--repo', '/home/me/projects/demo-shop'],
                ],
              },
            },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('the menu before the runs and sessions are read', () => {
  // no one's card with a run launched from the CLI: yours to stop, end, keep awake
  const NO_ONE = listCard(8, 'Promo banner on the cart', 'Active', null);
  const RUN_8 = factoryRun(8, NO_ONE.title, 'verify', 'needs-you', { since: minutes(1) });
  const SESSION_8: SessionData = { ...session('s8', 'waiting', 8), box: 'demo-shop-8' };
  const world: BoardWorld = { team: [...TEAM, NO_ONE] };
  /** Every read but the runs and the sessions, which stay asked. */
  const factsHeld: Replies = (asked) =>
    asked.argv[0] === 'session' || asked.argv[0] === 'factory'
      ? undefined
      : boardReplies({ ...WORLD, ...world })(asked);
  const runsIn = repliesBy({ 'factory status': runsAnswer([...RUNS, RUN_8]) });
  const sessionsIn = repliesBy({ 'session list': sessionsAnswer([...SESSIONS, SESSION_8]) });
  const menu8 = ['<Tab>', click('card:8'), '<D-CR>'];

  test.each<[string, Script]>([
    [
      'it waits for them, then opens with Stop…, End run… and Keep box awake on',
      {
        steps: [
          // not built from what is not read: no rows greyed `assigned to no one`
          [menu8, { layer: null, status: "Reading #8's run and session…" }],
          [[runsIn], { layer: null }],
          [
            [sessionsIn],
            {
              pick: {
                title: '#8 Promo banner on the cart',
                reasons: { stop: undefined, end: undefined, keep: undefined, workspace: undefined },
              },
              status: '',
            },
          ],
        ],
      },
    ],
    [
      'typed `sto` once they are in: Stop…, never Keep box awake',
      { steps: [[[...menu8, runsIn, sessionsIn, 's', 't', 'o'], { pick: { selected: 'stop' } }]] },
    ],
    [
      'a key meanwhile: the menu is not opened under it',
      { steps: [[[...menu8, 'ö', runsIn, sessionsIn], { layer: null, status: '' }]] },
    ],
    [
      'the keyboard gone elsewhere: the menu is not opened later',
      { steps: [[[...menu8, { kind: 'blur' }, runsIn, sessionsIn], { layer: null }]] },
    ],
    [
      'a read that failed: the menu opens on what is known',
      {
        steps: [
          [
            [
              ...menu8,
              runsIn,
              no('session list', { code: 'serve-unreachable', message: 'abe serve is not up' }),
            ],
            { pick: { title: '#8 Promo banner on the cart' } },
          ],
        ],
      },
    ],
    [
      '⏎ meanwhile opens the card’s page at once: the page reads its own',
      {
        steps: [
          [['<Tab>', click('card:4')], {}],
          [['<CR>'], { layer: null, sent: { open: 1 } }],
          [[runsIn, sessionsIn], { sent: { open: 0 } }],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play({ ...script, world, first: factsHeld });
  });
});

describe('Comment… is the CommentBox', () => {
  const posted = ok('card comment', {
    card: 4,
    id: 1,
    text: 'hi',
    by: 'Alex Example',
    at: minutes(6),
  });
  const box = [click('card:4'), '<D-CR>', ...typed('Com'), '<CR>'];

  test.each<[string, Script]>([
    [
      'its thread read; ⇧⏎ and a paste keep their lines, ⏎ posts; posted, it says so',
      {
        steps: [
          [
            box,
            {
              layer: 'CommentBox',
              props: {
                title: 'Comment on #4 Cart total includes shipping',
                placeholder: 'Your comment, as markdown',
                hint: '⏎ post · ⇧⏎ new line · draft kept',
              },
              asked: { 'card show': [['card', 'show', '4']] },
            },
          ],
          [
            [
              ...['h', 'i', '<S-CR>', 't', 'w', 'o', '<S-CR>'],
              text('Quote is live\nin test 🚚'),
              '<BS>',
              '<CR>',
            ],
            {
              asked: {
                'card comment': [
                  ['card', 'comment', '4', '--text', 'hi\ntwo\nQuote is live\nin test '],
                ],
              },
            },
          ],
          [[posted], { layer: null, status: 'Comment posted on #4' }],
        ],
      },
    ],
    [
      'its caret: ← ⌥← ⌘← ⌘→ move it on its line, typing and ⌫ at it',
      {
        steps: [
          [
            [...box, text('one\nthe cart'), '<M-Left>', 'o', 'l', 'd', '<Space>'],
            { props: { draft: 'one\nthe old cart', caret: 12 } },
          ],
          [['<D-Left>', '<BS>', '<Space>'], { props: { draft: 'one the old cart', caret: 4 } }],
          [
            ['<D-Right>', '<Left>', '<Left>', '<Left>', '<Left>', '<D-BS>'],
            { props: { draft: 'cart', caret: 0 } },
          ],
          [['<End>'], { props: { caret: undefined } }],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('Move… and Assign… ask in words, say what changed, and u undoes an assign', () => {
  const assigned = (card: CardData, at?: string) =>
    ok('card assign', card, at === undefined ? {} : { at });
  const samsPick = [MEMBERS, '<Tab>', click('card:9'), '<D-CR>', ...typed('ass'), '<CR>'];
  const FREE = listCard(7, 'Gift cards at checkout', 'New', null);
  const MADE = listCard(8, 'Free shipping banner', 'New', null, { tags: ['prototype'] });

  test.each<[string, Script]>([
    [
      'Move…: the columns it can go to; the write; Moved',
      {
        steps: [
          [
            [click('card:4'), '<D-CR>', ...typed('Mov'), '<CR>'],
            { pick: { title: 'Move #4 to', texts: ['New', 'Resolved', 'Closed'] } },
          ],
          [['<Down>', '<CR>'], { asked: { 'card move': [['card', 'move', '4', 'Resolved']] } }],
          [
            [ok('card move', { ...(MINE[0] ?? SAM), state: 'Resolved' })],
            { status: 'Moved #4 to Resolved' },
          ],
        ],
      },
    ],
    [
      'the team unread: the pick is Me alone',
      {
        steps: [
          [
            ['<Tab>', click('card:9'), '<D-CR>', ...typed('ass'), '<CR>'],
            { pick: { title: 'Assign #9 to', texts: ['Me'] } },
          ],
          [['<CR>', assigned(SAM)], { status: 'Assigned #9 to you · u undo' }],
        ],
      },
    ],
    [
      'a teammate’s card: Me first, then the team A to Z, filtered as you type; the write; u undoes it once',
      {
        steps: [
          [samsPick, { pick: { title: 'Assign #9 to', texts: ['Me', 'Robin Placeholder'] } }],
          // Me found by its label and by your name
          [['<C-u>', text('Me')], { pick: { texts: ['Me'] } }],
          [['<C-u>', text('alex')], { pick: { texts: ['Me'] } }],
          [['<C-u>', text('rob')], { pick: { texts: ['Robin Placeholder'] } }],
          [
            ['<CR>'],
            {
              layer: null,
              asked: { 'card assign': [['card', 'assign', '9', 'robin@example.test']] },
            },
          ],
          [[assigned(SAM)], { status: 'Assigned #9 to Robin Placeholder · u undo' }],
          [['u'], { asked: { 'card assign': [['card', 'assign', '9', 'sam@example.test']] } }],
          [[assigned(SAM)], { status: 'Assigned #9 back to Sam Sample' }],
          [['u'], { asked: { 'card assign': [] } }],
        ],
      },
    ],
    [
      '`u` only as the next key: a move first drops the undo',
      {
        steps: [
          [[...samsPick, '<CR>', assigned(SAM)], {}],
          [['ö', 'u'], { asked: { 'card assign': [] } }],
        ],
      },
    ],
    [
      'a click first drops the undo too: `u` is for the assign just said',
      {
        steps: [
          [[...samsPick, '<CR>', assigned(SAM)], {}],
          [[click('card:4'), 'u'], { asked: { 'card assign': [] } }],
        ],
      },
    ],
    [
      'your card to Sam: undone back to you',
      {
        steps: [
          [
            [MEMBERS, click('card:4'), '<D-CR>', ...typed('ass'), '<CR>'],
            { pick: { texts: ['Robin Placeholder', 'Sam Sample'] } },
          ],
          [
            ['<Down>', '<CR>'],
            { asked: { 'card assign': [['card', 'assign', '4', 'sam@example.test']] } },
          ],
          [[assigned(SAM), 'u'], { asked: { 'card assign': [['card', 'assign', '4', 'me']] } }],
          [[assigned(SAM)], { status: 'Assigned #4 back to you' }],
        ],
      },
    ],
    [
      'no one’s card: assigned to you, undone to no one',
      {
        world: { team: [...TEAM, FREE] },
        steps: [
          [
            // Assign to me and launch first, then Assign…
            [
              MEMBERS,
              '<Tab>',
              click('card:7'),
              '<D-CR>',
              ...typed('ass'),
              '<Down>',
              '<CR>',
              '<CR>',
            ],
            { asked: { 'card assign': [['card', 'assign', '7', 'me']] } },
          ],
          [[assigned(FREE)], { status: 'Assigned #7 to you · u undo' }],
          [['u'], { asked: { 'card assign': [['card', 'assign', '7', 'none']] } }],
          [[assigned(FREE)], { status: 'Unassigned #7 again' }],
        ],
      },
    ],
    [
      'an unassigned prototype card you made, on Mine: Me offered, undone to no one',
      {
        world: { mine: [...MINE, MADE] },
        steps: [
          [
            [MEMBERS, click('card:8'), '<D-CR>', ...typed('ass'), '<CR>'],
            { pick: { texts: ['Me', 'Robin Placeholder', 'Sam Sample'] } },
          ],
          [[text('Me'), '<CR>'], { asked: { 'card assign': [['card', 'assign', '8', 'me']] } }],
          [[assigned(MADE), 'u'], { asked: { 'card assign': [['card', 'assign', '8', 'none']] } }],
        ],
      },
    ],
    [
      'an undo answered late keeps the assign asked again meanwhile',
      {
        steps: [
          [[...samsPick, '<CR>', assigned(SAM), 'u'], {}],
          // assigned again before the undo answered
          [
            [
              click('card:9'),
              '<D-CR>',
              ...typed('ass'),
              '<CR>',
              '<CR>',
              assigned(SAM, 'card assign 9 sam@example.test'),
              assigned(SAM, 'card assign 9 me'),
            ],
            { status: 'Assigned #9 to you · u undo' },
          ],
        ],
      },
    ],
    [
      'refused: a balloon in its words, no undo offered',
      {
        steps: [
          [
            [
              ...samsPick,
              '<CR>',
              no('card assign', { code: 'rejected', message: 'TF401320: not a valid identity' }),
            ],
            { balloons: ['TF401320: not a valid identity (rejected)'] },
          ],
          [['u'], { asked: { 'card assign': [] } }],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('Open workspace on the Board: the workspace of the selected card’s story, or why there is none', () => {
  test.each<[string, Script]>([
    [
      'a teammate’s story with no session: no workspace yet, no launch hint',
      {
        steps: [
          [
            ['<Tab>', click('card:9'), jump('workspace')],
            { balloons: ['No workspace for #9 yet'] },
          ],
        ],
      },
    ],
    [
      'a card of yours with no session: no workspace yet, ⌘⏎ Launch agent',
      {
        steps: [
          [
            [click('card:4'), jump('workspace')],
            {
              balloons: ['No workspace for #4 yet · ⌘⏎ Launch agent'],
              asked: { workspace: [] },
            },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('⌃L opens Linked on the story it is pressed on, in the place of what was up', () => {
  test.each<[string, Script]>([
    [
      'on a card: its story',
      {
        steps: [
          [
            [click('card:4'), jump('linked')],
            { layer: 'LinkedLayer', props: { story: '#4', keys: '⌃L' } },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

describe('the Launch box', () => {
  const PROTO = listCard(4, 'Cart total includes shipping', 'Active', 'Alex Example', {
    tags: ['cart', 'prototype'],
  });
  /** Make card's asking comment: its link line and the screenshots under it. */
  const ASKING = [
    '**Can we do this?** Shipping in the total.',
    'Prototype v3 · 5 changes · at 3f2a9c1 · prototype://demo-shop/4/v3',
    '![1. The cart](https://dev.azure.com/a/1.png)',
    '![2. The total](https://dev.azure.com/a/2.png)',
  ].join('\n\n');
  const shownProto = (): Replies => {
    const a = cardShowAnswer(PROTO, []);

    return repliesBy({
      'card show':
        a.reply.ok && a.command === 'card show'
          ? {
              ...a,
              reply: {
                ...a.reply,
                data: {
                  ...a.reply.data,
                  comments: [{ id: 1, text: ASKING, by: 'Pat', at: minutes(1) }],
                },
              },
            }
          : a,
    });
  };
  const opened = [click('card:4'), ...OPEN_BOX];

  test.each<[string, Script]>([
    [
      'Launch agent opens it on the card; its ⏎ launches with the note',
      {
        steps: [
          [[click('card:4'), '<D-CR>', '<PageUp>'], { pick: { selected: 'launch' } }],
          [
            ['<CR>'],
            { layer: 'LaunchBox', props: { where: 'Cloud' }, asked: { 'factory run': [] } },
          ],
          [
            [text('use the existing price helper'), LATER, '<CR>'],
            {
              layer: null,
              asked: {
                'factory run': [run(4, '--note=use the existing price helper')],
              },
            },
          ],
        ],
      },
    ],
    [
      'a prototype’s card: the box reads what goes along as reference from its comments',
      {
        world: { mine: [PROTO, ...MINE.slice(1)], team: [PROTO, ...TEAM.slice(1)] },
        steps: [
          // before the card is read: plain words, never a row that comes and goes
          [
            opened,
            {
              props: { along: ['+ reference · the card’s prototype'] },
              asked: { 'card show': [['card', 'show', '4']] },
            },
          ],
          [
            [shownProto()],
            { props: { along: ['+ reference · Prototype v3 · 5 changes, 2 screenshots'] } },
          ],
        ],
      },
    ],
    [
      'a session came meanwhile: the launch stops it first (--replace), the note kept',
      {
        steps: [
          [
            [
              ...opened,
              text('the note'),
              SERVE_STARTED,
              boardReplies({ ...WORLD, sessions: [...SESSIONS, session('s4', 'working', 4)] }),
            ],
            {},
          ],
          [
            [LATER, '<CR>'],
            {
              asked: {
                'factory run': [
                  [
                    'factory',
                    'run',
                    '4',
                    '--repo',
                    '/home/me/projects/demo-shop',
                    '--replace',
                    '--note=the note',
                  ],
                ],
              },
              status: 'Launching #4…',
            },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play(script);
  });
});

// ---------------------------------------------------------------- Download locally, Move to cloud

const CLOUD_4: SessionData = { ...session('s4', 'working', 4), box: 'shop-4' };
const ON_CLOUD: BoardWorld = {
  runs: [factoryRun(4, 'Cart total includes shipping', 'build', 'running', { since: minutes(2) })],
  sessions: [CLOUD_4],
};
const CLOUD: AttachSpec = {
  where: 'cloud',
  root: '/workspace/repo',
  nvim: ['abe', 'box', 'attach', 'shop-4', '--', 'nvim', '--embed'],
  shell: ['abe', 'box', 'attach', 'shop-4', '--', 'bash', '-l'],
  exec: ['abe', 'box', 'attach', 'shop-4', '--'],
  box: { name: 'shop-4', region: null },
  waking: false,
};
/** What the window attaches with: the spec but where it is and its folder, which the effect says. */
const ATTACH = {
  nvim: CLOUD.nvim,
  shell: CLOUD.shell,
  exec: CLOUD.exec,
  box: { name: 'shop-4', region: null },
  waking: CLOUD.waking,
};
const MOVED: SessionMoveData = {
  id: 's4',
  card: 4,
  from: 'cloud',
  to: 'local',
  box: 'shop-4',
  worktree: '/home/me/projects/demo-shop-wt/4-cart-total',
  branch: 'card/4-cart-total',
  head: 'abcdef1234567',
  state: 'working',
  copied: { staged: false, unstaged: true, files: [], transcript: true },
  left: [],
  boxStopped: true,
  note: null,
};
const moved = (to: 'local' | 'cloud'): Input => ({
  kind: 'event',
  event: {
    seq: 9,
    at: '2026-10-24T10:00:00.000Z',
    type: 'session.moved',
    data: {
      id: 's4',
      card: 4,
      from: to === 'local' ? 'cloud' : 'local',
      to,
      box: 'shop-4',
      worktree: to === 'local' ? MOVED.worktree : '/workspace/repo',
    },
  },
});

describe('Download locally from the cloud workspace', () => {
  /** Open workspace on card 4, its attach-spec answered: the window opens the cloud workspace. */
  const attached = [click('card:4'), '<D-CR>', '<CR>', ok('workspace attach-spec', CLOUD)];

  test.each<[string, Script]>([
    [
      'the cloud workspace’s open-project carries its click; the click downloads it',
      {
        steps: [
          [
            attached,
            {
              effects: [
                {
                  kind: 'open-project',
                  path: '/workspace/repo',
                  chat: true,
                  attach: { ...ATTACH, download: 'download:s4' },
                },
              ],
            },
          ],
          [
            [click('download:s4')],
            { asked: { 'session download': [['session', 'download', 's4', '--repo', ROOT]] } },
          ],
        ],
      },
    ],
    [
      'downloaded: the local worktree opens, the copy on the status line',
      {
        steps: [
          [[...attached, click('download:s4')], {}],
          [
            [
              ok('session download', MOVED, {
                text: 's4  AB#4 moved to this machine\n  worktree …\n',
              }),
            ],
            {
              effects: [
                { kind: 'open-project', path: MOVED.worktree },
                { kind: 'status', text: 's4  AB#4 moved to this machine' },
                {
                  kind: 'selected',
                  card: 4,
                  owner: null,
                  title: 'Cart total includes shipping',
                },
              ],
            },
          ],
        ],
      },
    ],
    [
      'refused: a balloon in its words',
      {
        steps: [
          [
            [
              ...attached,
              click('download:s4'),
              no('session download', { code: 'box-unreachable', message: 'shop-4 did not answer' }),
            ],
            { balloons: ['shop-4 did not answer (box-unreachable)'] },
          ],
        ],
      },
    ],
    [
      'session.moved: its card shows it Local once downloaded, Cloud once moved to cloud again',
      {
        steps: [
          [[], { boxed: { 'card:4': true } }],
          [[moved('local')], { boxed: { 'card:4': false } }],
          [[moved('cloud')], { boxed: { 'card:4': true } }],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play({ ...script, world: ON_CLOUD });
  });
});

// ---------------------------------------------------------------- New card

const NC_MINE = [listCard(4, 'Cart total includes shipping', 'Active', 'Alex Example')];
const NC_TEAM = [...NC_MINE, listCard(9, 'Coupon field accepts spaces', 'New', 'Sam Sample')];
const NC_WORLD: BoardWorld = { mine: NC_MINE, team: NC_TEAM, runs: [], sessions: [] };
const WISHLIST = 'Customers can save a wishlist';
/** Command mode's `New card “<words>”` on what was typed. */
const newCardOn = (title: string) => [':', ...typed(title), '<D-CR>'];
/** What Command mode hands the Board for a row of the New card menu. */
const newCardRow = (row: string, values?: string[]): Input => ({
  kind: 'choice',
  menu: 'newcard',
  row,
  ...(values === undefined ? {} : { values }),
});
const made = (id: number, who: string | null) => listCard(id, WISHLIST, 'New', who);

describe('New card on the Board opens the dialog with the board’s types and sprint; a card made is selected', () => {
  test.each<[string, Script]>([
    [
      'New card on the words typed in Command mode: its title, opened in New',
      {
        steps: [
          [
            newCardOn(WISHLIST),
            {
              layer: 'CardDialog',
              newcard: {
                kind: 'newcard',
                board: 'https://dev.azure.com/demo-org/Sandbox/Sandbox',
                types: ['User Story', 'Bug'],
                // a card is not made done: no Closed
                columns: ['New', 'Active', 'Resolved'],
                sprint: 'Sprint 14',
                title: WISHLIST,
                column: undefined,
                session: undefined,
              },
            },
          ],
        ],
      },
    ],
    [
      'an Ask’s New card from this chat: its question the title, its chat the draft’s',
      {
        steps: [
          [
            [newCardRow('chat:a1', ['why does the cart total ignore quantity'])],
            { newcard: { title: 'why does the cart total ignore quantity', session: 'a1' } },
          ],
        ],
      },
    ],
    [
      'before the board is read: said, no dialog, no New card in `:`',
      {
        first: () => undefined,
        steps: [
          [
            [newCardRow('open', ['x'])],
            { newcard: null, balloons: ['New card: reading the board'], here: { board: false } },
          ],
        ],
      },
    ],
    [
      'the Board’s rows in `:` start with New card…',
      {
        steps: [
          [[], { here: { board: true, first: { id: 'new-card', text: 'New card…' } } }],
          [
            [{ kind: 'choice', menu: 'board:view', row: 'new-card' }],
            { newcard: { kind: 'newcard' } },
          ],
        ],
      },
    ],
    [
      'an empty column: `＋ New card` in its body, none in a full or a done one; a click opens the dialog in it',
      {
        steps: [
          [
            [],
            {
              nodes: {
                'col:Resolved': { count: 0, add: '＋ New card' },
                'col:Active': { add: undefined },
                'col:Closed': { add: undefined },
              },
            },
          ],
          [[click('newcard:Resolved')], { newcard: { column: 'Resolved' } }],
        ],
      },
    ],
    [
      'a column the `/` filter empties is no empty column: ⏎ opens no New card',
      {
        steps: [
          // a filter matching nothing, ⏎ ends its typing: every column shows none
          [['/', 'z', 'z', '<CR>', 'ä', '<CR>'], { newcard: null }],
        ],
      },
    ],
    [
      'made and yours: both lists read again and the ring on it in Mine',
      {
        steps: [
          [
            [...newCardOn(WISHLIST), click('dialog:primary')],
            {
              asked: {
                'card create': [
                  [
                    'card',
                    'create',
                    `--title=${WISHLIST}`,
                    '--state=New',
                    '--assign=me',
                    '--sprint=current',
                  ],
                ],
              },
            },
          ],
          [
            [ok('card create', made(12, 'Alex Example'))],
            {
              asked: {
                'card list': [
                  ['card', 'list', '--mine', '--closed'],
                  ['card', 'list', '--closed'],
                ],
              },
              tab: 'tab:mine',
            },
          ],
          [
            [
              boardReplies({
                ...NC_WORLD,
                mine: [...NC_MINE, made(12, 'Alex Example')],
                team: [...NC_TEAM, made(12, 'Alex Example')],
              }),
            ],
            { nodes: { 'card:12': { selection: 'selected' } } },
          ],
        ],
      },
    ],
    [
      'made and no one’s: the ring on it in Team',
      {
        steps: [
          [
            [...newCardOn(WISHLIST), click('dialog:primary'), ok('card create', made(13, null))],
            { tab: 'tab:team' },
          ],
        ],
      },
    ],
  ])('%s', (_, script) => {
    play({ ...script, world: NC_WORLD });
  });
});

// ---------------------------------------------------------------- every screen alike

const SHOP = '/p/demo-shop';
const SIX: CardData = BOARD_MINE[2] ?? listCard(6, '', '');
const NOBODYS: CardData = listCard(8, 'Search finds partial words', 'New', null);

const YOU_ONLY = {
  kind: 'result' as const,
  id: '',
  command: 'card members' as const,
  reply: {
    ok: true as const,
    data: { members: [{ name: 'Alex Example', email: 'alex@example.test', you: true }] },
  },
};

const shown = (card: CardData) => ({
  kind: 'result' as const,
  id: '',
  command: 'card show' as const,
  reply: { ok: true as const, data: { ...card, comments: [], sheets: [] } },
});

/** Each screen on `card`, its reads in: no run, no session yet. */
const SCREENS: readonly (readonly [string, (card: CardData) => Drive<Node>])[] = [
  [
    'the Board',
    (card) =>
      driveScreen(factoryScreen, {
        params: { root: SHOP },
        size: BOARD_SIZE,
        replies: boardReplies({
          runs: [],
          sessions: [],
          mine: [...BOARD_MINE, ...(card === NOBODYS ? [] : [card])],
          team: [...BOARD_MINE, card],
          more: repliesBy({ 'card members': YOU_ONLY }),
        }),
      }).answer(),
  ],
  [
    'the Card page',
    (card) =>
      driveScreen(cardScreen, {
        params: { card: String(card.id), root: SHOP },
        replies: repliesBy({
          'card show': shown(card),
          'session list': sessionsAnswer([]),
          'factory status': runsAnswer([]),
          'card members': YOU_ONLY,
        }),
      }).answer(),
  ],
  [
    'Chat',
    (card) =>
      driveChat({
        params: { card: String(card.id), root: SHOP },
        replies: repliesBy({
          'card show': shown(card),
          'card list': cardsAnswer(card === NOBODYS ? BOARD_MINE : [...BOARD_MINE, card], true),
          'session list': sessionsAnswer([]),
          'factory status': runsAnswer([]),
        }),
      }).answer(),
  ],
];

const box = (card: CardData, note = ''): Input => ({
  kind: 'choice',
  menu: `launchbox:${card.id}`,
  row: 'launch',
  values: [note],
});

/** What a press said and asked: its status lines, its runs' argv, a balloon's words. */
const said = (cs: readonly Command[]): string[] =>
  cs.flatMap((c) => {
    if (c.kind === 'run') return [`abe ${c.argv.join(' ')}`];
    if (c.kind === 'shell' && c.effect.kind === 'status') return [`status: ${c.effect.text}`];
    if (c.kind === 'shell' && c.effect.kind === 'balloon') return [`balloon: ${c.effect.text}`];

    return [];
  });

const launched = (card: number): Input => ({
  kind: 'result',
  id: `launch:${card}`,
  command: 'factory run',
  reply: { ok: true, data: factoryRun(card, '', 'spec', 'running', { session: `${card}-new` }) },
});

type Row = {
  card: CardData;
  /** Pressed first, what they said dropped. */
  before?: readonly Input[];
  press: readonly Input[];
  /** What every screen says and asks of the press, the same. */
  want: readonly string[];
  /**
   * Where a screen differs only in what it offers: the Board says `u undo` and takes `u` (the
   * others' keys are the composer's and the page's). A screen named here says this instead;
   * `null`: the press is not that screen's.
   */
  on?: Readonly<Record<string, readonly string[] | null>>;
};

const assignAnswer = (card: CardData, id = `assign:${card.id}`): Input => ({
  kind: 'result',
  id,
  command: 'card assign',
  reply: {
    ok: true,
    data: { ...card, assignee: { name: 'Alex Example', email: 'alex@example.test' } },
  },
});

const ROWS: readonly (readonly [string, Row])[] = [
  [
    'the Launch box ⏎: launched once, said at once',
    {
      card: SIX,
      press: [box(SIX, 'use the clock')],
      want: [`abe factory run 6 --repo ${SHOP} --note=use the clock`, 'status: Launching #6…'],
    },
  ],
  [
    'pressed again while it launches: refused the same way, nothing launched twice',
    {
      card: SIX,
      before: [box(SIX)],
      press: [box(SIX)],
      want: ['status: #6 not launched: a launch is already going'],
    },
  ],
  [
    'a launch on it heard from elsewhere: refused the same way',
    {
      card: SIX,
      before: [
        eventInput({
          type: 'launch.started',
          seq: 4,
          data: { card: 6, repo: 'mkdir-swe/demo-shop' },
        }),
      ],
      press: [box(SIX)],
      want: ['status: #6 not launched: a launch is already going'],
    },
  ],
  [
    'its answer: Launching… cleared',
    { card: SIX, before: [box(SIX)], press: [launched(6)], want: ['status: '] },
  ],
  [
    'refused: why in a balloon, Launching… cleared',
    {
      card: SIX,
      before: [box(SIX)],
      press: [
        {
          kind: 'result',
          id: 'launch:6',
          command: null,
          reply: { ok: false, error: { code: 'aws-auth', message: 'the aws login is expired' } },
        },
      ],
      want: ['status: ', 'balloon: the aws login is expired (aws-auth)'],
    },
  ],
  [
    'no one’s card: launched first, assigned to you once launched',
    {
      card: NOBODYS,
      before: [box(NOBODYS)],
      press: [launched(8)],
      want: ['status: ', 'abe card assign 8 me'],
    },
  ],
  [
    'that assign answered: said; the Board offers u to put it back',
    {
      card: NOBODYS,
      before: [box(NOBODYS), launched(8)],
      press: [assignAnswer(NOBODYS)],
      want: ['status: Assigned #8 to you'],
      on: { 'the Board': ['status: Assigned #8 to you · u undo'] },
    },
  ],
  [
    'u as the next key: back to no one',
    {
      card: NOBODYS,
      before: [box(NOBODYS), launched(8), assignAnswer(NOBODYS)],
      press: [{ kind: 'key', key: 'u' }],
      want: ['abe card assign 8 none'],
      on: { 'the Card page': null, Chat: null },
    },
  ],
  [
    'its undo answered: said',
    {
      card: NOBODYS,
      before: [box(NOBODYS), launched(8), assignAnswer(NOBODYS), { kind: 'key', key: 'u' }],
      press: [assignAnswer(NOBODYS, 'assign-undo:8')],
      want: ['status: Unassigned #8 again'],
      on: { 'the Card page': null, Chat: null },
    },
  ],
];

describe('card actions: the same press, the same result from every screen', () => {
  test.each(
    ROWS.flatMap(([name, row]) =>
      SCREENS.flatMap(([on, open]) => {
        const want = row.on?.[on] === undefined ? row.want : row.on[on];

        return want === null ? [] : [[`${name}: ${on}`, row, want, open] as const];
      }),
    ),
  )('%s', (_, row, want, open) => {
    const d = open(row.card);

    d.send(...(row.before ?? [])).take();
    d.send(...row.press);
    // (a screen's own follow-up after, never before: Chat on the session, the reads again)
    const got = said(d.take());

    expect(got.slice(0, want.length)).toEqual([...want]);
  });
});

describe('⌘⏎ ⏎ on the Board and the Card page: the same top row, opened on, its ⏎ the Launch box', () => {
  test.each<[string, CardData, string]>([
    ['your card', SIX, 'Launch agent'],
    ['no one’s card', NOBODYS, 'Assign to me and launch'],
  ])('%s', (_, card, top) => {
    for (const [on, open] of SCREENS.slice(0, 2)) {
      const d = open(card);

      if (on === 'the Board') {
        if (card === NOBODYS) d.keys('<Tab>');
        d.send({ kind: 'click', id: `card:${card.id}` });
      }
      d.keys('<D-CR>');
      const p = d.layer?.kind === 'PickLayer' ? d.layer.props : undefined;

      d.keys('<CR>');
      expect([on, p?.rows[0]?.text, p?.selected, d.layer?.kind]).toEqual([
        on,
        top,
        'launch',
        'LaunchBox',
      ]);
    }
  });
});

/** Card 6 on a run not over, its session `state`: the Board and Sessions, read in. */
const RELAUNCH_ON: readonly (readonly [
  string,
  (state: SessionData['state']) => Drive<Node>,
  (row: string) => Input,
])[] = (() => {
  const run = factoryRun(6, SIX.title, 'build', 'needs-you', { session: 's6' });
  const x = (state: SessionData['state']) => session('s6', state, 6);

  return [
    [
      'the Board',
      (state) =>
        driveScreen(factoryScreen, {
          params: { root: SHOP },
          size: BOARD_SIZE,
          replies: boardReplies({ runs: [run], sessions: [x(state)], mine: BOARD_MINE }),
        }).answer(),
      (row) => ({ kind: 'choice', menu: 'card:6', row }),
    ],
    [
      'Sessions',
      (state) =>
        driveSessions({
          params: { root: SHOP },
          replies: repliesBy({
            'session list': sessionsAnswer([x(state)]),
            'factory status': runsAnswer([run]),
            'card list': cardsAnswer(BOARD_MINE, false),
          }),
        }).answer(),
      (row) => ({ kind: 'choice', menu: 'session:s6', row }),
    ],
  ];
})();

const asked = (cs: readonly Command[]): string[] =>
  cs.flatMap((c) => {
    if (c.kind === 'confirm') return [`confirm ${c.question}: abe ${c.argv.join(' ')}`];

    return said([c]);
  });

describe('Retry run, Reopen and Stop…: the Board and Sessions ask the same', () => {
  test.each<[string, SessionData['state'], string, readonly string[]]>([
    ['Retry run on its ended session', 'ended', 'retry', [`abe factory run 6 --repo ${SHOP}`]],
    ['Reopen its ended session', 'ended', 'reopen', ['abe session reopen s6']],
    [
      'Stop… its live session: asked first',
      'working',
      'stop',
      ["confirm Stop #6's session?: abe session stop s6"],
    ],
  ])('%s', (_, state, row, want) => {
    for (const [on, open, choice] of RELAUNCH_ON) {
      const d = open(state);

      d.take();
      expect([on, ...asked(d.send(choice(row)).take()).slice(0, want.length)]).toEqual([
        on,
        ...want,
      ]);
    }
  });
});
