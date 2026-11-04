/**
 * What a card stands for (#335) as every surface reads it: the Board card and its menu (`standing`),
 * Chat's pin (`pinOf`), the workspace jump (`workspaceSession`) and Linked's Worktree and Box rows (`linkedOf`)
 * name the same session, in the cases where they used to pick their own.
 */
import { describe, expect, test } from 'bun:test';
import type { FactoryRunData, SessionData } from '@abe/core';
import { factoryRun, listCard, session } from '@abe/testing';
import { lookOf, standing } from '../board/flow';
import { workspaceSession } from '../board/jumps';
import { linkedOf } from './linked-rows';
import { pinnedScreen, pinOf } from '../chat/pinned';
import { sessionRows } from '../board/session-rows';

const CARD = 6;
const at = (minute: number) => `2026-10-01T09:${String(minute).padStart(2, '0')}:00.000Z`;
const run = (id: string, minute: number, state: 'needs-you' | 'done'): FactoryRunData =>
  factoryRun(CARD, 'Greeted by time of day', state === 'done' ? 'done' : 'build', state, {
    session: id,
    startedAt: at(minute),
    worktree: `/wt/${id}`,
    ...(state === 'done' ? { outcome: 'not-reproduced' as const } : {}),
  });
const ses = (
  id: string,
  minute: number,
  state: 'working' | 'ended',
  o: { stopped?: true; factory?: true; box?: string } = {},
): SessionData => ({
  ...session(id, state, CARD),
  startedAt: at(minute),
  stopped: o.stopped === true,
  ...o,
});

type Case = [
  name: string,
  runs: FactoryRunData[],
  sessions: SessionData[],
  id: string,
  box: string,
];

const CASES: Case[] = [
  [
    'a done run, a newer live plain session: the session',
    [run('r1', 1, 'done')],
    [
      ses('r1', 1, 'ended', { stopped: true, factory: true, box: 'shop-r1' }),
      ses('p2', 2, 'working'),
    ],
    'p2',
    '(dim) none · Local sandbox',
  ],
  [
    'a done run, a newer plain session you stopped: that session',
    [run('r1', 1, 'done')],
    [
      ses('r1', 1, 'ended', { stopped: true, factory: true }),
      ses('p2', 2, 'ended', { stopped: true, box: 'shop-p2' }),
    ],
    'p2',
    '☁ shop-p2 #6',
  ],
  [
    'a done run, a newer plain session ended on its own: the run again',
    [run('r1', 1, 'done')],
    [
      ses('r1', 1, 'ended', { stopped: true, factory: true, box: 'shop-r1' }),
      ses('p2', 2, 'ended'),
    ],
    'r1',
    '☁ shop-r1 #6',
  ],
  [
    'a failed run waiting on you, an older live plain session: the run',
    [run('r2', 2, 'needs-you')],
    [ses('p1', 1, 'working'), ses('r2', 2, 'ended', { factory: true, box: 'shop-r2' })],
    'r2',
    '☁ shop-r2 #6',
  ],
];

describe('every surface reads what the card stands for (#335)', () => {
  test.each(CASES)('%s', (_, runs, sessions, id, box) => {
    const stands = standing(runs, sessions).get(CARD);
    const linked = linkedOf(
      {
        story: CARD,
        card: {
          ok: true,
          data: { ...listCard(CARD, 'Greeted', 'Active'), comments: [], sheets: [] },
        },
        run: { ok: true, data: runs.at(-1) ?? null },
        sessions: { ok: true, data: sessions },
        sheets: { ok: true, data: [] },
      },
      { now: at(30), home: '/home/ada' },
    );
    const row = (key: string) => linked.rows.find((r) => r.key === key);
    const worktree = row('worktree')?.opens;

    // the Board card and its menu
    expect(stands?.session?.id ?? stands?.run?.session).toBe(id);
    // Chat's pin
    expect(pinOf({ ...pinnedScreen.init, card: CARD, runs, sessions }).session?.id).toBe(id);
    // the workspace jump
    expect(workspaceSession(runs, sessions, CARD)?.id).toBe(id);
    // Linked's Worktree row: the session's folder, opening that session
    expect(worktree).toEqual({ kind: 'workspace', session: id, path: `/wt/${id}` });
    // Linked's Box row: that session's box
    expect(`${row('box')?.dim === true ? '(dim) ' : ''}${row('box')?.words}`).toBe(box);
  });
});

describe('Linked on the session the card is on (#335)', () => {
  const parts = (runs: FactoryRunData[], sessions: SessionData[], cleared?: true) =>
    linkedOf(
      {
        story: CARD,
        card: {
          ok: true,
          data: { ...listCard(CARD, 'Greeted', 'Active'), comments: [], sheets: [] },
        },
        run: { ok: true, data: runs.at(-1) ?? null },
        ...(cleared === undefined ? {} : { cleared }),
        sessions: { ok: true, data: sessions },
        sheets: { ok: true, data: [] },
      },
      { now: at(30), home: '/home/ada' },
    ).rows;

  test('Sessions says stopped: a run you stopped stands over a newer plain session ended on its own', () => {
    const rows = parts(
      [run('r1', 1, 'done')],
      [ses('r1', 1, 'ended', { stopped: true, factory: true }), ses('p2', 2, 'ended')],
    );

    expect(rows.find((r) => r.key === 'sessions')?.words).toBe('2 · Local sandbox · stopped');
  });

  test('a run History keeps stands no more: the newest session’s worktree, as the workspace jump opens it', () => {
    const runs = [run('r1', 1, 'done')];
    const sessions = [ses('p2', 2, 'ended')];
    const worktree = parts(runs, sessions, true).find((r) => r.key === 'worktree')?.opens;

    // the Board reads only the shown runs: none
    expect(workspaceSession([], sessions, CARD)?.id).toBe('p2');
    expect(worktree).toEqual({ kind: 'workspace', session: 'p2', path: '/wt/p2' });
  });
});

describe('a run asking its spec questions reads the same on every surface', () => {
  const grilling = factoryRun(CARD, 'Greeted by time of day', 'spec', 'needs-you', {
    session: 'g1',
    startedAt: at(1),
    worktree: '/wt/g1',
  });
  const waiting: SessionData = { ...ses('g1', 1, 'working'), state: 'waiting', rounds: 2 };
  const word = '◆ Needs you · Question round 2';

  test('the Board card, Sessions and Linked’s run facts', () => {
    const stands = standing([grilling], [waiting]).get(CARD);
    const look = stands?.run === undefined ? undefined : lookOf(stands.run, stands.session);
    const row = sessionRows({ sessions: [waiting], runs: [grilling] })[0];
    const linked = linkedOf(
      {
        story: CARD,
        card: {
          ok: true,
          data: { ...listCard(CARD, 'Greeted', 'Active'), comments: [], sheets: [] },
        },
        run: { ok: true, data: grilling },
        sessions: { ok: true, data: [waiting] },
        sheets: { ok: true, data: [] },
      },
      { now: at(30), home: '/home/ada' },
    );
    // the Board card
    expect(`${look?.glyph} ${look?.word}`).toBe(word);
    // Sessions' row
    expect(`◆ ${row?.word}`).toBe(word);
    // Linked's run facts: the same run
    expect(linked.run).toMatchObject({ stage: 'spec', state: 'needs-you', session: 'g1' });
  });
});
