/**
 * One run, one stage, one clock on every screen that shows it (#147): the Board's card, Chat's
 * header, the Sessions tab, Linked's run facts and the header feed (toolbar line, strip tab). Each
 * screen through the runtime, as the bridge drives it, with the same reads and `abe watch` events.
 */
import { describe, expect, test } from 'bun:test';
import { type FactoryPrData, type FactoryRunData, type SessionData, STAGES } from '@abe/core';
import {
  cardsAnswer,
  type EventBody,
  eventInput,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
} from '@abe/testing';
import { type Node } from './runtime/components';
import { factoryScreen } from './board/factory';
import { clockSince } from './board/flow';
import { linkedOf } from './linked/linked-rows';
import { pinnedScreen } from './chat/pinned';
import { type Command, type Input, type Screen, step } from './runtime/runtime';
import { sessionsScreen } from './sessions/sessions';
import { withLive } from './live';
import { workspaceLook } from './board/workspaces';

const CARD = 2;
const TITLE = 'The cart total ignores quantity';
const ID = '2-9bde';

const walk = (n: Node, out: Node[] = []): Node[] => {
  out.push(n);
  if ('children' in n) for (const c of n.children ?? []) walk(c, out);

  return out;
};

const drive = <S>(bare: Screen<S>, params: Record<string, string>, width: number) => {
  // the screen with its live facts, as the bridge feeds them
  const screen = withLive(bare);
  let held = step(screen, screen.init, { kind: 'open', params, size: { width, height: 800 } });
  let commands: Command[] = held.commands;
  const d = {
    get tree(): Node {
      return held.tree;
    },
    get commands(): Command[] {
      return commands;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(screen, held.state, input);
        commands = held.commands;
      }

      return d;
    },
  };

  return d;
};

const tick = (at: string): Input => ({ kind: 'tick', at });

const event = (seq: number, at: string, e: EventBody): Input => eventInput({ ...e, seq }, at);

const moved = (
  seq: number,
  from: FactoryRunData['stage'] | null,
  to: FactoryRunData['stage'],
  at: string,
  cause: string,
  state: FactoryRunData['state'] = 'running',
  since = at,
): Input =>
  event(seq, at, {
    type: 'factory.stage',
    data: {
      card: CARD,
      session: ID,
      stage: to,
      from,
      state,
      reason: state === 'needs-you' ? 'waiting on you in Chat' : null,
      since,
      cause,
      outcome: null,
    },
  });

const sessionOf = (state: SessionData['state'], since: string): SessionData => ({
  ...session(ID, state, CARD),
  title: TITLE,
  since,
  startedAt: minutes(0),
  box: 'demo-shop-1',
  worktree: '/workspace/repo',
});

/** Every screen that shows the run, read the same way. */
const screens = (run: FactoryRunData, s: SessionData) => {
  const reads = [sessionsAnswer([s]), runsAnswer([run])];
  const board = drive(factoryScreen, {}, 1440).send(
    cardsAnswer([listCard(CARD, TITLE, 'Active')], true),
    cardsAnswer([listCard(CARD, TITLE, 'Active')], false),
    ...reads,
  );
  const chat = drive(pinnedScreen, { session: ID }, 420).send(...reads);
  const sessions = drive(sessionsScreen, {}, 1020).send(...reads, {
    ...cardsAnswer([listCard(CARD, TITLE, 'Active')], false, 'Sprint 1'),
    id: 'cards',
  });
  const all = {
    board,
    chat,
    sessions,
    send: (...inputs: Input[]) => {
      for (const x of [board, chat, sessions]) x.send(...inputs);

      return all;
    },
    /** What each screen says of the run: `[stage, word, time]`. */
    said: () => {
      const props = (tree: Node, match: (n: Node) => boolean): Record<string, unknown> =>
        walk(tree).find(match)?.props ?? {};
      const card = record(props(board.tree, (n) => n.id === `card:${CARD}`).rail);
      const header = record(props(chat.tree, (n) => n.kind === 'ChatHeader').rail);
      const rows = props(sessions.tree, (n) => n.kind === 'Table').rows;
      const first = Array.isArray(rows) ? record(rows[0]).cells : undefined;
      const cells = Array.isArray(first) ? first.map((c) => record(c).text) : [];

      return {
        board: [card.stage, card.word, card.time],
        chat: [header.stage, header.word, header.elapsed],
        sessions: [cells[1], cells[2], cells[4]],
      };
    },
  };

  return all;
};

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v)) : {};

describe('one clock for a run (#147)', () => {
  test('Needs you: every screen counts from when the session began to wait, not the stage (F9)', () => {
    // in Build since 09:00, waiting on you since 20:37; now 20:45
    const run = factoryRun(CARD, TITLE, 'build', 'needs-you', { session: ID, since: minutes(0) });
    const s = sessionOf('waiting', minutes(697));
    const all = screens(run, s).send(tick(minutes(705)));
    const said = all.said();

    expect(said.board).toEqual(['Build', 'Needs you', '8 min']);
    expect(said.chat).toEqual(['Build', 'Needs you', '8 min']);
    expect(said.sessions).toEqual(['Build', 'Needs you', '8 min']);
    // the toolbar's line and Linked's run facts: the same since
    expect(workspaceLook({ ...s, card: CARD }, run, minutes(705)).since).toBe(minutes(697));
    const linked = linkedOf(
      {
        story: CARD,
        card: { ok: false, error: 'not read here' },
        run: { ok: true, data: run },
        sessions: { ok: true, data: [s] },
        sheets: { ok: true, data: [] },
      },
      { now: minutes(705), home: '/h' },
    );

    expect(linked.run?.since).toBe(minutes(697));
  });

  test("Build's checks and a red check back into build are one stay: the clock goes on (F29)", () => {
    const run = factoryRun(CARD, TITLE, 'build', 'running', { session: ID, since: minutes(0) });
    const all = screens(run, sessionOf('working', minutes(0))).send(
      moved(20, 'build', 'checks', minutes(3), 'stage-done'),
      moved(21, 'checks', 'build', '2026-10-01T09:03:05.000Z', 'checks'),
      tick(minutes(5)),
    );
    const said = all.said();

    expect(said.board).toEqual(['Build', 'Running', '5 min']);
    expect(said.chat).toEqual(['Build', 'Running', '5 min']);
    expect(said.sessions).toEqual(['Build', 'Running', '5 min']);
  });

  test('a new rail stage starts its own clock; every screen says the same words in it (F33)', () => {
    const run = factoryRun(CARD, TITLE, 'build', 'running', { session: ID, since: minutes(0) });
    const all = screens(run, sessionOf('working', minutes(0))).send(
      moved(20, 'build', 'checks', minutes(3), 'stage-done'),
      moved(21, 'checks', 'review', minutes(4), 'checks'),
      tick(minutes(6)),
    );
    const said = all.said();

    expect(said.board).toEqual(['Review', 'Reviewing', '2 min']);
    expect(said.chat).toEqual(['Review', 'Reviewing', '2 min']);
    expect(said.sessions).toEqual(['Review', 'Reviewing', '2 min']);
  });

  test("a read answered after a newer move never takes the run back (F33, a cloud run's slow reads)", () => {
    const run = factoryRun(CARD, TITLE, 'build', 'running', { session: ID, since: minutes(0) });
    const s = sessionOf('working', minutes(0));
    const all = screens(run, s);

    // A gap in the stream: every screen reads again; the box answers slowly, and the run moves on
    // to Review before the answer, read on the box before the move, lands.
    all.send(event(19, minutes(3), { type: 'watch.gap', data: { since: 5, first: 18 } }));
    all.send(moved(21, 'checks', 'review', minutes(4), 'checks'));
    all.send(sessionsAnswer([s]), runsAnswer([run]), tick(minutes(6)));
    const said = all.said();

    expect(said.board).toEqual(['Review', 'Reviewing', '2 min']);
    expect(said.chat).toEqual(['Review', 'Reviewing', '2 min']);
    expect(said.sessions).toEqual(['Review', 'Reviewing', '2 min']);
  });

  test('a session read answered after a newer state change never takes it back', () => {
    const run = factoryRun(CARD, TITLE, 'build', 'running', { session: ID, since: minutes(0) });
    const working = sessionOf('working', minutes(0));
    const all = screens(run, working);

    all.send(event(19, minutes(3), { type: 'watch.gap', data: { since: 5, first: 18 } }));
    all.send(
      event(20, minutes(4), {
        type: 'session.state',
        data: { id: ID, card: CARD, state: 'waiting', since: minutes(4), cause: 'Stop' },
      }),
      moved(21, null, 'build', minutes(4), 'Stop', 'needs-you', minutes(0)),
    );
    all.send(sessionsAnswer([working]), runsAnswer([run]), tick(minutes(6)));
    const said = all.said();

    expect(said.board).toEqual(['Build', 'Needs you', '2 min']);
    expect(said.chat).toEqual(['Build', 'Needs you', '2 min']);
    expect(said.sessions).toEqual(['Build', 'Needs you', '2 min']);
  });

  test('two gaps in a row: one read out, once more after its answer; it takes nothing back', () => {
    const run = factoryRun(CARD, TITLE, 'build', 'running', { session: ID, since: minutes(0) });
    const working = sessionOf('working', minutes(0));
    const waiting = sessionOf('waiting', minutes(4));
    const all = screens(run, working);
    const lists = (cs: readonly Command[]) =>
      cs.filter((c) => c.kind === 'run' && c.argv.join(' ') === 'session list').length;

    all.send(event(19, minutes(3), { type: 'watch.gap', data: { since: 5, first: 18 } }));
    expect(lists(all.chat.commands)).toBe(1);
    all.send(event(20, minutes(3), { type: 'watch.gap', data: { since: 18, first: 20 } }));
    expect(lists(all.chat.commands)).toBe(0);
    all.send(
      event(21, minutes(4), {
        type: 'session.state',
        data: { id: ID, card: CARD, state: 'waiting', since: minutes(4), cause: 'Stop' },
      }),
      moved(22, null, 'build', minutes(4), 'Stop', 'needs-you', minutes(0)),
    );
    const now: FactoryRunData = { ...run, state: 'needs-you' };

    // the read asked before the move answers from before it: the move stays; asked once more
    all.send(sessionsAnswer([working]), runsAnswer([run]));
    expect(lists(all.chat.commands)).toBe(0);
    all.send(sessionsAnswer([waiting]), runsAnswer([now]), tick(minutes(6)));

    expect(all.said().board).toEqual(['Build', 'Needs you', '2 min']);
    expect(all.said().chat).toEqual(['Build', 'Needs you', '2 min']);
    expect(all.said().sessions).toEqual(['Build', 'Needs you', '2 min']);
  });

  test("an event older than what a read brought (a box's event merged late) changes nothing", () => {
    const run = factoryRun(CARD, TITLE, 'review', 'running', {
      session: ID,
      since: minutes(4),
      stages: [
        { stage: 'build', startedAt: minutes(0), endedAt: minutes(3), durationMs: 0, report: null },
        {
          stage: 'checks',
          startedAt: minutes(3),
          endedAt: minutes(4),
          durationMs: 0,
          report: null,
        },
      ],
    });
    const all = screens(run, sessionOf('working', minutes(0))).send(
      moved(20, 'build', 'checks', minutes(3), 'stage-done'),
      tick(minutes(6)),
    );

    expect(all.said().board).toEqual(['Review', 'Reviewing', '2 min']);
    expect(all.said().chat).toEqual(['Review', 'Reviewing', '2 min']);
    expect(all.said().sessions).toEqual(['Review', 'Reviewing', '2 min']);
  });

  test('a run cleared while a read was out stays gone', () => {
    const run = factoryRun(CARD, TITLE, 'done', 'done', { session: ID, since: minutes(0) });
    const all = screens(run, sessionOf('ended', minutes(0)));

    all.send(event(19, minutes(3), { type: 'watch.gap', data: { since: 5, first: 18 } }));
    all.send(moved(20, 'done', 'done', minutes(4), 'cleared', 'done', minutes(0)));
    all.send(runsAnswer([run]));

    expect(all.said().board).toEqual([undefined, undefined, undefined]);
  });

  test("subagents heard of while a read was out stay: Chat's header keeps its count", () => {
    const run = factoryRun(CARD, TITLE, 'review', 'running', { session: ID, since: minutes(0) });
    const s = sessionOf('working', minutes(0));
    const all = screens(run, s);

    all.send(event(19, minutes(3), { type: 'watch.gap', data: { since: 5, first: 18 } }));
    all.send(
      event(20, minutes(4), {
        type: 'session.subagent',
        data: {
          id: ID,
          card: CARD,
          agent: 'a1',
          name: 'abe:reviewer',
          task: null,
          model: null,
          state: 'running',
          result: null,
        },
      }),
    );
    all.send(sessionsAnswer([s]), runsAnswer([run]));
    const header = walk(all.chat.tree).find((n) => n.kind === 'ChatHeader');

    expect(header?.props).toMatchObject({ subagents: 1 });
  });
});

describe('clockSince', () => {
  const PR: FactoryPrData = {
    repo: 'mkdir-swe/demo-shop',
    number: 10,
    url: 'https://github.com/mkdir-swe/demo-shop/pull/10',
    state: 'open',
    merge: 'person',
    checks: 'success',
    mergeCommit: null,
    deploy: null,
    branch: null,
  };
  const visit = (stage: FactoryRunData['stage'], from: number, to: number) => ({
    stage,
    startedAt: minutes(from),
    endedAt: minutes(to),
    durationMs: (to - from) * 60_000,
    report: null,
  });

  test.each([
    ['in its first stage', 'build', [], 'working', 0, 0],
    [
      'decide, build, checks, build: one Build stay',
      'build',
      ['decide:0:1', 'build:1:3', 'checks:3:4'],
      'working',
      4,
      0,
    ],
    [
      'back in build after a review: a new stay',
      'build',
      ['build:0:3', 'checks:3:4', 'review:4:6'],
      'working',
      6,
      6,
    ],
    [
      'verify after review: one Review stay',
      'verify',
      ['build:0:3', 'checks:3:4', 'review:4:6'],
      'working',
      6,
      4,
    ],
    ['waiting on you: since the session waits', 'build', ['decide:0:1'], 'waiting', 1, 9],
    [
      'waiting on its pull request: the stage, not the turns',
      'pr',
      ['verify:0:1'],
      'waiting',
      1,
      1,
    ],
  ] as const)('%s', (_, stage, visits, state, since, expected) => {
    const run = factoryRun(CARD, TITLE, stage, state === 'waiting' ? 'needs-you' : 'running', {
      since: minutes(since),
      ...(stage === 'pr' ? { pr: PR } : {}),
      stages: visits.map((v) => {
        const [st = '', a, b] = v.split(':');
        const stage = STAGES.find((x) => x === st) ?? 'build';

        return visit(stage, Number(a), Number(b));
      }),
    });

    expect(clockSince(run, { state, since: minutes(9) })).toBe(minutes(expected));
  });
});
