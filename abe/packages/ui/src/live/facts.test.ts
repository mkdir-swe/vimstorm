/**
 * Live facts at their interface, as a host mounts them: the reads the open screens follow, the
 * watch's events moving the facts in place or reading again, a burst of breaks read once more,
 * never a move taken back by a late read, a card list that failed read again on a backoff. One
 * row per rule; a fix adds a row.
 */
import { describe, expect, test } from 'bun:test';
import {
  boxesAnswer,
  cardsAnswer,
  type EventBody,
  eventInput,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
  X_BOXES,
} from '@abe/testing';
import type { Answer, Input } from '../runtime/runtime';
import { type Facts, type LiveInput, type LiveRead, mountLive } from '.';

const ev = (seq: number, e: EventBody, at = minutes(seq)): Input => eventInput({ ...e, seq }, at);
const follow = (...reads: LiveRead[]): LiveInput => ({ kind: 'follow', reads });
const gap = (seq: number) => ev(seq, { type: 'watch.gap', data: { since: 1, first: seq } });
const as = (a: Answer, id: string): Answer => ({ ...a, id });

const RUN = factoryRun(4, 'Cart total', 'build', 'running', { session: 's4', since: minutes(1) });
const S4 = { ...session('s4', 'working', 4), since: minutes(1) };
const C4 = listCard(4, 'Cart total', 'New');
const C5 = listCard(5, 'Wishlist', 'New');
/** The board `cardsAnswer` lists. */
const BOARD = {
  organization: 'https://dev.azure.com/demo-org',
  project: 'Sandbox',
  team: 'Sandbox',
};
const ran = (seq: number, noun: string, verb: string, exit: 0 | 1 = 0) =>
  ev(seq, { type: 'command.ran', data: { noun, verb, exit } });
/** The clock `n` s after `minutes(0)`: a read it asks shows as `<argv> @<n>s`. */
const at = (n: number): Input => ({ kind: 'tick', at: secondsAt(n) });
const secondsAt = (n: number) => new Date(Date.parse(minutes(0)) + n * 1000).toISOString();
/** Mine's list refused: the board did not answer. */
const CUT: Input = {
  kind: 'result',
  id: 'cards:mine',
  command: 'card list',
  reply: {
    ok: false,
    error: { code: 'board-unreachable', message: 'Azure DevOps cannot be reached' },
  },
};
/** A tick each 15 s from `from` to `to`, each refused at once (a refusal with none out changes nothing). */
const clock = (from: number, to: number): Input[] =>
  Array.from({ length: (to - from) / 15 + 1 }, (_, i) => [at(from + i * 15), CUT]).flat();

type Row = {
  inputs: readonly LiveInput[];
  /** Every read asked, in order, as `abe <argv>`. */
  asked: readonly string[];
  facts?: (f: Facts) => unknown;
  want?: unknown;
};

const ROWS: readonly (readonly [string, Row])[] = [
  [
    'what the screens follow is read once, however many follow it',
    {
      inputs: [follow('sessions', 'runs'), follow('sessions', 'runs'), follow('runs', 'sessions')],
      asked: ['session list', 'factory status'],
    },
  ],
  [
    'nothing followed: nothing read, an event reads nothing',
    { inputs: [gap(2), ev(3, { type: 'prototype.state', data: protoMove() })], asked: [] },
  ],
  [
    'a burst of breaks while a read is out: one read more once it answers',
    {
      inputs: [follow('sessions'), gap(2), gap(3), gap(4), sessionsAnswer([])],
      asked: ['session list', 'session list'],
    },
  ],
  [
    'a reconnect: each fact followed read once, nothing of the serve before kept',
    {
      inputs: [follow('sessions', 'runs'), sessionsAnswer([S4]), runsAnswer([RUN])].concat([
        { kind: 'reread', anew: true },
      ]),
      asked: ['session list', 'factory status', 'session list', 'factory status'],
      facts: (f) => [f.sessions, f.runs, f.read.sessions.reading],
      want: [undefined, undefined, true],
    },
  ],
  [
    'a launch heard: Launching until its session is listed, on every screen at once',
    {
      inputs: [
        follow('sessions'),
        sessionsAnswer([]),
        ev(2, { type: 'launch.started', data: { card: 4, repo: '/p/shop' } }),
        ev(3, {
          type: 'launch.ended',
          data: { card: 4, repo: '/p/shop', session: 's4', refused: null },
        }),
      ],
      asked: ['session list', 'session show s4'],
      facts: (f) => f.launches,
      want: { 4: { repo: '/p/shop', session: 's4' } },
    },
  ],
  [
    'its session listed: no longer Launching',
    {
      inputs: [
        follow('sessions'),
        ev(2, { type: 'launch.started', data: { card: 4, repo: '/p/shop' } }),
        ev(3, {
          type: 'launch.ended',
          data: { card: 4, repo: '/p/shop', session: 's4', refused: null },
        }),
        sessionsAnswer([S4]),
      ],
      asked: ['session list'],
      facts: (f) => f.launches,
      want: {},
    },
  ],
  [
    'a launch refused: no longer Launching',
    {
      inputs: [
        ev(2, { type: 'launch.started', data: { card: 4, repo: '/p/shop' } }),
        ev(3, {
          type: 'launch.ended',
          data: {
            card: 4,
            repo: '/p/shop',
            session: null,
            refused: { code: 'aws-auth', message: 'expired' },
          },
        }),
      ],
      asked: [],
      facts: (f) => f.launches,
      want: {},
    },
  ],
  [
    'a break forgets the launches heard',
    {
      inputs: [ev(2, { type: 'launch.started', data: { card: 4, repo: '/p/shop' } }), gap(3)],
      asked: [],
      facts: (f) => f.launches,
      want: {},
    },
  ],
  [
    'a known session moves in place, no read',
    {
      inputs: [
        follow('sessions'),
        sessionsAnswer([S4]),
        ev(5, {
          type: 'session.state',
          data: { id: 's4', card: 4, state: 'waiting', since: minutes(5), cause: 'Stop' },
        }),
      ],
      asked: ['session list'],
      facts: (f) => f.sessions?.map((x) => x.state),
      want: ['waiting'],
    },
  ],
  [
    'an unknown session is read by its id; one not shown by its id, the whole list',
    {
      inputs: [
        follow('sessions'),
        sessionsAnswer([]),
        ev(5, {
          type: 'session.state',
          data: { id: 's9', card: null, state: 'working', since: minutes(5), cause: 'hook' },
        }),
        {
          kind: 'result',
          id: 'session:s9',
          command: null,
          reply: { ok: false, error: { code: 'no-session', message: 'none' } },
        },
      ],
      asked: ['session list', 'session show s9', 'session list'],
    },
  ],
  [
    'a launch starting before its run is held: its card’s runs too',
    {
      inputs: [
        follow('sessions', 'runs'),
        sessionsAnswer([]),
        runsAnswer([]),
        ev(5, {
          type: 'session.state',
          data: { id: 's4', card: 4, state: 'starting', since: minutes(5), cause: 'launch' },
        }),
      ],
      asked: ['session list', 'factory status', 'session show s4', 'factory status 4'],
    },
  ],
  [
    'a known run moves in place; an unknown one is read by its card',
    {
      inputs: [
        follow('runs'),
        runsAnswer([RUN]),
        stage(5, 's4', 4, 'checks'),
        stage(6, 's7', 7, 'build'),
      ],
      asked: ['factory status', 'factory status 7'],
      facts: (f) => f.runs?.map((r) => r.stage),
      want: ['checks'],
    },
  ],
  [
    'a run cleared is let go',
    {
      inputs: [follow('runs'), runsAnswer([RUN]), stage(5, 's4', 4, 'done', 'cleared')],
      asked: ['factory status'],
      facts: (f) => f.runs,
      want: [],
    },
  ],
  [
    'a read answered after a newer move never takes it back',
    {
      inputs: [
        follow('runs'),
        runsAnswer([RUN]),
        { kind: 'reread', reads: ['runs'] },
        stage(5, 's4', 4, 'checks'),
        runsAnswer([RUN]),
      ],
      asked: ['factory status', 'factory status'],
      facts: (f) => f.runs?.map((r) => r.stage),
      want: ['checks'],
    },
  ],
  [
    'another folder shown while a read is out: asked there, the older answer counts for nothing',
    {
      inputs: [follow('sessions'), { kind: 'root', root: '/p/api' }, sessionsAnswer([S4])],
      asked: ['session list', 'session list'],
      facts: (f) => [f.sessions, f.read.sessions.reading],
      want: [undefined, true],
    },
  ],
  [
    'a launch’s answer holds its run at once',
    {
      inputs: [follow('runs'), runsAnswer([]), { kind: 'reread', reads: ['runs'], ran: RUN }],
      asked: ['factory status', 'factory status'],
      facts: (f) => f.runs?.map((r) => r.session),
      want: ['s4'],
    },
  ],
  [
    'a box not listed moves the list read again; a known one moves in place',
    {
      inputs: [
        follow('boxes'),
        boxesAnswer([X_BOXES.box('shop-5', { state: 'stopped' })]),
        ev(5, { type: 'box.state', data: { box: 'shop-5', state: 'running', cause: 'start' } }),
        ev(6, { type: 'box.state', data: { box: 'shop-9', state: 'running', cause: 'start' } }),
      ],
      asked: ['box list', 'box list'],
      facts: (f) => f.boxList?.boxes.map((b) => b.state),
      want: ['running'],
    },
  ],
  [
    'a prototype moved: the list again, only while followed',
    {
      inputs: [
        follow('prototypes'),
        as(protoAnswer(), 'prototypes'),
        ev(5, { type: 'prototype.state', data: protoMove() }),
      ],
      asked: ['prototype list', 'prototype list'],
    },
  ],
  [
    'a fact no screen follows any more is let go: followed again, it is read anew',
    {
      inputs: [follow('sessions'), sessionsAnswer([S4]), follow(), follow('sessions')],
      asked: ['session list', 'session list'],
      facts: (f) => f.sessions,
      want: undefined,
    },
  ],
  [
    'the card lists: Mine and the team’s, the sprint’s done cards too',
    {
      inputs: [
        follow('cards:mine', 'cards:team'),
        cardsAnswer([C4], true),
        cardsAnswer([C4], false),
      ],
      asked: ['card list --mine --closed', 'card list --closed'],
      facts: (f) => [f.mine?.cards.map((c) => c.id), f.team?.cards.map((c) => c.id)],
      want: [[4], [4]],
    },
  ],
  [
    'a card written (made, moved, tagged, assigned) or triage applied: both read again',
    {
      inputs: [
        follow('cards:mine', 'cards:team'),
        cardsAnswer([C4], true),
        cardsAnswer([C4], false),
        ran(2, 'card', 'assign'),
        cardsAnswer([C4], true),
        cardsAnswer([C4], false),
        ran(3, 'triage', 'apply'),
      ],
      asked: [
        ...['card list --mine --closed', 'card list --closed'],
        ...['card list --mine --closed', 'card list --closed'],
        ...['card list --mine --closed', 'card list --closed'],
      ],
    },
  ],
  [
    'the board set in the settings: both read again; another setting: nothing',
    {
      inputs: [
        follow('cards:mine', 'cards:team'),
        cardsAnswer([C4], true),
        cardsAnswer([C4], false),
        ev(2, { type: 'settings.changed', data: { keys: ['serve.target'], repo: '/p/shop' } }),
        ev(3, { type: 'settings.changed', data: { keys: ['board'], repo: '/p/shop' } }),
      ],
      asked: [
        ...['card list --mine --closed', 'card list --closed'],
        ...['card list --mine --closed', 'card list --closed'],
      ],
    },
  ],
  [
    'a write refused, or a read of a card: nothing read again',
    {
      inputs: [
        follow('cards:mine'),
        cardsAnswer([C4], true),
        ran(2, 'card', 'assign', 1),
        ran(3, 'card', 'show'),
      ],
      asked: ['card list --mine --closed'],
    },
  ],
  [
    'a read out at a card write answers from before it: dropped, the one asked after counts',
    {
      inputs: [
        follow('cards:mine'),
        ran(2, 'card', 'assign'),
        cardsAnswer([C4], true),
        cardsAnswer([], true),
      ],
      asked: ['card list --mine --closed', 'card list --mine --closed'],
      facts: (f) => [f.mine?.cards.length, f.read['cards:mine'].answers],
      want: [0, 1],
    },
  ],
  [
    'board.changed on the board read: each changed card first, Mine’s only when yours; another board’s: nothing',
    {
      inputs: [
        follow('cards:mine', 'cards:team'),
        cardsAnswer([C4, C5], true),
        cardsAnswer([C4, C5], false),
        ev(2, {
          type: 'board.changed',
          data: {
            board: BOARD,
            cards: [{ card: { ...C5, state: 'Resolved' }, mine: false }],
            gone: [4],
          },
        }),
        ev(3, {
          type: 'board.changed',
          data: { board: { ...BOARD, team: 'Other' }, cards: [], gone: [5] },
        }),
      ],
      asked: ['card list --mine --closed', 'card list --closed'],
      facts: (f) => [
        f.mine?.cards.map((c) => c.id),
        f.team?.cards.map((c) => `${c.id} ${c.state}`),
      ],
      want: [[], ['5 Resolved']],
    },
  ],
  [
    'factory.card: the card on top of its new column',
    {
      inputs: [
        follow('cards:team'),
        cardsAnswer([C4, C5], false),
        ev(2, {
          type: 'factory.card',
          data: { card: 5, session: 's5', column: 'active', state: 'Active', error: null },
        }),
      ],
      asked: ['card list --closed'],
      facts: (f) => f.team?.cards.map((c) => `${c.id} ${c.state}`),
      want: ['5 Active', '4 New'],
    },
  ],
  [
    'a card list that failed: read again by the clock, waiting longer each time, at most 2 min',
    {
      inputs: [follow('cards:mine'), CUT, ...clock(15, 360)],
      asked: ['card list --mine --closed', ...[30, 60, 120, 240, 360].map(mineAt)],
    },
  ],
  [
    'one read again still out is not asked again; once it answers, the clock goes on; answered, no more',
    {
      inputs: [
        follow('cards:mine'),
        CUT,
        ...[at(15), at(30), at(60), at(90)],
        CUT,
        at(105),
        cardsAnswer([C4], true),
        ...[at(180), at(600), at(1200)],
      ],
      asked: ['card list --mine --closed', mineAt(30), mineAt(105)],
      facts: (f) => [f.mine?.cards.map((c) => c.id), f.read['cards:mine'].failed],
      want: [[4], undefined],
    },
  ],
  [
    'read again (`r`, a view shown again) or another folder shown: the wait starts anew',
    {
      inputs: [
        follow('cards:mine'),
        CUT,
        ...clock(15, 60),
        { kind: 'reread', reads: ['cards:mine'] },
        CUT,
        ...clock(75, 180),
        { kind: 'root', root: '/p/api' },
        CUT,
        ...clock(195, 300),
      ],
      asked: [
        'card list --mine --closed',
        ...[30, 60].map(mineAt),
        'card list --mine --closed',
        ...[90, 120, 180].map(mineAt),
        'card list --mine --closed',
        ...[210, 240, 300].map(mineAt),
      ],
    },
  ],
];

function mineAt(n: number) {
  return `card list --mine --closed @${n}s`;
}

function stage(seq: number, id: string, card: number, to: typeof RUN.stage, cause = 'run'): Input {
  return ev(seq, {
    type: 'factory.stage',
    data: {
      card,
      session: id,
      stage: to,
      from: null,
      state: 'running',
      reason: null,
      since: minutes(seq),
      cause,
      outcome: null,
    },
  });
}

function protoMove() {
  return { id: 'p1', card: null, state: 'live' as const, url: null, cause: 'start', reason: null };
}

function protoAnswer(): Answer {
  return {
    kind: 'result',
    id: 'prototypes',
    command: 'prototype list',
    reply: { ok: true, data: { prototypes: [] } },
  };
}

describe('live facts', () => {
  test.each(ROWS)('%s', (_, row) => {
    const live = mountLive();
    const asked = row.inputs.flatMap((input) => {
      const when =
        input.kind === 'tick' ? ` @${(Date.parse(input.at) - Date.parse(minutes(0))) / 1000}s` : '';

      return live
        .send(input)
        .flatMap((c) => (c.kind === 'run' ? [`${c.argv.join(' ')}${when}`] : []));
    });

    expect(asked).toEqual([...row.asked]);
    if (row.facts !== undefined) expect(row.facts(live.facts)).toEqual(row.want);
  });
});
