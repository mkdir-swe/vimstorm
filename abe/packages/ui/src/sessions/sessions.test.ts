/**
 * The Sessions tab (#107 S4, board F-Sessions) as the bridge drives it in the pane slot: its reads,
 * the Table's columns and order, the keys and what they ask of the other slots, the live events
 * with no whole reads, the empty and unread states.
 */
import { describe, expect, test } from 'bun:test';
import * as core from '@abe/core';
import type { FactoryRunData, LaunchProgress, SessionData } from '@abe/core';
import {
  cardsAnswer,
  DEMO_HERE,
  type EventBody,
  eventInput,
  F_SESSIONS,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
} from '@abe/testing';
import { type Node, type Table } from '../runtime/components';
import { commandMode } from '../command/command';
import { type Answer, type Command, type Input, mount, mountLayer, step } from '../runtime/runtime';
import { screenOf } from '../runtime/screens';
import { boxStoppedHead } from '../board/card-actions';
import { BOX_SLEPT_WAITING, sessionsScreen, type SessionsState } from './sessions';
import { HUB_WHERE } from '../board/session-rows';
import { withLive } from '../live';

/** Sessions with its live facts, as the bridge feeds them. */
const LIVE_SESSIONS = withLive(sessionsScreen);

const SIZE = { width: 1020, height: 280 };

/** The team's cards (live's): the sprint's stories, its done ones too. */
const cards = (c = F_SESSIONS.cards, sprint: string | null = 'Sprint 1'): Answer =>
  cardsAnswer(c, false, sprint);

const drive = (params: Record<string, string> = {}, size = SIZE) => {
  let held = step(LIVE_SESSIONS, LIVE_SESSIONS.init, { kind: 'open', params, size });
  let commands: Command[] = held.commands;
  const d = {
    get state(): SessionsState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return commands;
    },
    get table(): Table {
      const t = held.tree.kind === 'Island' ? held.tree.children[0] : undefined;

      if (t?.kind !== 'Table') throw new Error(`no Table: ${JSON.stringify(held.tree)}`);

      return t;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(LIVE_SESSIONS, held.state, input);
        commands = held.commands;
      }

      return d;
    },
    keys: (...keys: string[]) => d.send(...keys.map((key): Input => ({ kind: 'key', key }))),
    read(
      sessions: SessionData[] = F_SESSIONS.sessions,
      runs: FactoryRunData[] = F_SESSIONS.runs,
      board: Answer = cards(),
    ) {
      return d.send(sessionsAnswer(sessions), runsAnswer(runs), board, {
        kind: 'tick',
        at: F_SESSIONS.now,
      });
    },
    /** Each row's cells as words: `#2 The cart…`, `▮ Build`, `● Running`, … */
    rows: () =>
      d.table.props.rows.map((r) =>
        r.cells.map((c) =>
          [
            c.accent,
            c.rail?.join(','),
            c.cloud === undefined ? undefined : `☁${c.cloud}`,
            c.mark,
            c.text,
          ]
            .filter((x) => x !== undefined)
            .join(' '),
        ),
      ),
    ids: () => d.table.props.rows.map((r) => r.id),
  };

  return d;
};

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

const event = (e: EventBody & { at?: string }): Input => eventInput(e, minutes(91));

describe('the sessions screen', () => {
  test('it declares that it opens on the main screen’s card, so the bridge names none (#137)', () => {
    expect(screenOf('sessions')?.opensOnMainCard).toBe(true);
    expect(screenOf('boxes')?.opensOnMainCard).toBe(false);
    expect(screenOf('factory')?.opensOnMainCard).toBe(false);
  });

  test('reads your sessions, the runs and the Board once on open, asking meanwhile', () => {
    const d = drive({ root: '/p/demo-shop' });

    expect(argvs(d.commands)).toEqual(['session list', 'factory status', 'card list --closed']);
    expect(d.table.props.empty).toEqual({
      title: 'Asking abe serve',
      line: 'Your sessions, a moment',
    });
    // opened again (the Board's card, the view): no reads
    expect(argvs(d.send({ kind: 'open', params: { card: '2' }, size: SIZE }).commands)).toEqual([]);
  });

  test('the rows wait for the runs (#315): no `—` stages that move under the keys once they come', () => {
    const d = drive().send(sessionsAnswer(F_SESSIONS.sessions), cards());

    expect(d.table.props.rows).toEqual([]);
    expect(d.table.props.empty).toEqual({
      title: 'Asking abe serve',
      line: 'Your sessions, a moment',
    });
    // a move meanwhile selects nothing that the runs would put elsewhere
    d.keys('ö');
    d.send(runsAnswer(F_SESSIONS.runs), { kind: 'tick', at: F_SESSIONS.now });
    expect(d.table.props.selected).toBe(d.table.props.rows[0]?.id);
    expect(d.rows().length).toBeGreaterThan(1);
  });

  test('another project shown: the old rows go until its sessions and runs are in (#315)', () => {
    const d = drive().read();

    d.send({ kind: 'root', root: '/p/demo-api' });
    expect(d.table.props.rows).toEqual([]);
  });

  test('a runs read that failed: the rows as the sessions say, the Board not read noted', () => {
    const d = drive().send(sessionsAnswer(F_SESSIONS.sessions), cards(), {
      kind: 'result',
      id: 'runs',
      command: 'factory status',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'abe serve is not up' } },
    });

    expect(d.rows().length).toBeGreaterThan(0);
    expect(d.table.props.note).toBe('Board not read · abe serve is not up');
  });

  test("F-Sessions' columns and rows: needs you first, the selected one the first row", () => {
    const d = drive().read();

    expect(d.table.props.columns.map((c) => c.label)).toEqual([
      'Story',
      'Stage',
      'State',
      'Where',
      'Time',
      'Subagents',
    ]);
    expect(d.table.props.columns.map((c) => c.width)).toEqual([
      { flex: 1 },
      { fixed: 230 },
      { fixed: 160 },
      { fixed: 90 },
      { fixed: 100 },
      { fixed: 100 },
    ]);
    // Time left-aligned like its cells (#294)
    expect(d.table.props.columns[4]?.align).toBeUndefined();
    expect(d.rows()).toEqual([
      [
        '#1 Show stock on a product card',
        'need,todo,todo,todo,todo Spec',
        '◆ Needs you',
        '☁running',
        '1 h 8 min',
        '1',
      ],
      [
        '#2 The cart total ignores quantity',
        'done,now,todo,todo,todo Build',
        '● Running',
        'Local sandbox',
        '21 min',
        '2',
      ],
      ['#3 Pin the Node version', 'done,done,done,done,done Done', '✓ On test', '—', '31 min', '—'],
    ]);
    expect(d.table.props.rows[0]?.cells[2]?.hue).toBe('needs-you');
    expect(d.table.props.rows[0]?.cells[3]?.tooltip).toBe('Box demo-shop-1 · running');
    expect(d.table.props.rows[1]?.cells[2]?.hue).toBe('warn');
    expect(d.table.props.rows[2]?.cells[2]?.hue).toBe('good');
    expect(d.table.props.selected).toBe('session:s1');
    expect(d.table.props.foot?.map((f) => `${f.keys} ${f.label}`)).toEqual([
      '⏎ chat',
      '⌘⏎ actions',
    ]);
  });

  test('order: needs you, failed, starting / running, idle, done; the longest in its state first', () => {
    const at = (n: number, s: SessionData): SessionData => ({ ...s, since: minutes(n) });
    const sessions = [
      at(5, session('done', 'ended', 1)),
      at(5, session('idle', 'waiting', 2)),
      at(5, session('run-new', 'working', 3)),
      at(5, session('run-old', 'working', 4)),
      at(5, session('failed', 'ended', 5)),
      at(30, session('needs-new', 'waiting', 6)),
      at(10, session('needs-old', 'waiting', 7)),
      at(5, session('starting', 'starting', 8)),
    ];
    const runs = [
      factoryRun(1, 'Done', 'done', 'done', { session: 'done' }),
      // a quiet session with nothing asked between its `session.state` and its `factory.stage`
      factoryRun(2, 'Idle', 'build', 'running', { session: 'idle' }),
      factoryRun(3, 'Run new', 'build', 'running', { session: 'run-new', since: minutes(40) }),
      factoryRun(4, 'Run old', 'review', 'running', { session: 'run-old', since: minutes(20) }),
      factoryRun(5, 'Failed', 'build', 'needs-you', { session: 'failed' }),
      factoryRun(6, 'Needs new', 'spec', 'needs-you', { session: 'needs-new' }),
      factoryRun(7, 'Needs old', 'build', 'needs-you', { session: 'needs-old' }),
      factoryRun(8, 'Starting', 'spec', 'running', { session: 'starting', since: minutes(1) }),
    ];
    const board = cards([1, 2, 3, 4, 5, 6, 7, 8].map((n) => listCard(n, `Card ${n}`, 'Active')));

    expect(drive({}, { width: 1020, height: 600 }).read(sessions, runs, board).ids()).toEqual([
      'session:needs-old',
      'session:needs-new',
      'session:failed',
      'session:starting',
      'session:run-old',
      'session:run-new',
      'session:idle',
      'session:done',
    ]);
  });

  test('an abandoned run: the stage it was given up in and ○ Abandoned, dim, never ✓ or Done (#229)', () => {
    const runs = F_SESSIONS.runs.map((r) =>
      r.card === 3
        ? {
            ...r,
            outcome: 'abandoned' as const,
            ended: {
              as: 'abandoned' as const,
              reason: 'not needed',
              at: r.since,
              from: 'pr' as const,
            },
          }
        : r,
    );
    const row = drive()
      .read(F_SESSIONS.sessions, runs)
      .rows()
      .find((r) => r[0]?.startsWith('#3') === true);

    expect(row?.slice(0, 3)).toEqual([
      '#3 Pin the Node version',
      'done,done,done,wait,todo PR',
      '○ Abandoned',
    ]);
  });

  test("only your card sessions on the sprint's stories: no other sprint, no ended chat, no cleared run", () => {
    const sessions = [
      ...F_SESSIONS.sessions,
      session('other-sprint', 'working', 9),
      { ...session('hub', 'ended', 1), card: null, kind: 'abe' as const, abe: { repo: '/r' } },
      // ended, its run cleared: gone
      session('cleared', 'ended', 2),
      // live with no run (`session launch`): shown, no stage yet
      session('plain', 'working', 2),
    ];
    const d = drive().read(sessions);

    // the plain one has run longer than #2's Build
    expect(d.ids()).toEqual(['session:s1', 'session:plain', 'session:s2', 'session:s3']);
    expect(d.rows()[1]).toEqual([
      '#2 The cart total ignores quantity',
      '—',
      '● Running',
      'Local sandbox',
      '1 h 29 min',
      '—',
    ]);
  });

  test('a new session on a card the sprint read has not (one just made): the cards read again, its row shown', () => {
    const d = drive().read();

    d.send(
      event({
        type: 'session.state',
        data: { id: 's9', card: 9, state: 'starting', since: minutes(90), cause: 'launch' },
      }),
      {
        kind: 'result',
        id: 'session:s9',
        command: 'session show',
        reply: { ok: true, data: session('s9', 'starting', 9) },
      },
    );
    expect(argvs(d.commands)).toEqual(['card list --closed']);
    expect(d.ids()).not.toContain('session:s9');
    d.send(cards([...F_SESSIONS.cards, listCard(9, 'Made just now', 'New', null)]));
    expect(d.ids()).toContain('session:s9');
  });

  test('a Queued run: no stage yet, its Where says the boxes that count, the words on hover (#321)', () => {
    const queued: SessionData = {
      ...session('q1', 'queued', 1),
      box: 'demo-shop-1',
      queuedFor: { boxes: ['demo-shop-2', 'demo-shop-3'], limit: 2 },
    };
    const d = drive().read(
      [queued],
      [factoryRun(1, 'Show stock', 'spec', 'queued', { session: 'q1' })],
    );
    const row = d.table.props.rows.find((r) => r.id === 'session:q1');

    expect(
      d
        .rows()
        .find((r) => r[0]?.startsWith('#1') === true)
        ?.slice(1, 4),
    ).toEqual(['—', '○ Queued', '2/2 boxes']);
    expect(row?.cells[3]?.tooltip).toBe(
      'Queued: 2 of 2 boxes running or starting (demo-shop-2, demo-shop-3; limits.maxBoxesPerPerson) · starts when one stops',
    );
  });

  test('a session whose box went to sleep while it waited on you (#192): on top as Box slept, ⏎ reopens it on its box (#343), gone once a newer one runs', () => {
    const slept: SessionData = {
      ...session('slept', 'ended', 2),
      box: 'demo-shop-2',
      reason: `${BOX_SLEPT_WAITING} (demo-shop-2, idle) · abe session reopen slept wakes it`,
    };
    const d = drive({ root: '/p/demo-shop' }).read([...F_SESSIONS.sessions, slept]);

    expect(d.ids()[0]).toBe('session:slept');
    expect(d.rows()[0]?.[2]).toBe('◆ Box slept');
    expect(argvs(d.keys('<CR>').commands)).toEqual(['session reopen slept']);
    const again = { ...session('again', 'starting', 2), startedAt: minutes(95) };

    expect(
      drive()
        .read([...F_SESSIONS.sessions, slept, again])
        .ids(),
    ).not.toContain('session:slept');
  });

  test('a plain session you stopped (#332): its row stays as ○ Stopped, ⌘⏎ Reopen goes back into it (#343); a newer one on its card takes its place', () => {
    const board = cards([...F_SESSIONS.cards, listCard(4, 'Saved carts survive sign-out', 'New')]);
    const read = (more: SessionData[], params: Record<string, string> = {}) =>
      drive(params).read([...F_SESSIONS.sessions, ...more], F_SESSIONS.runs, board);
    const stopped: SessionData = { ...session('stop', 'ended', 4), stopped: true };
    const d = read([stopped], { root: '/p/demo-shop' });
    const row = d.rows()[d.ids().indexOf('session:stop')];

    expect(row?.slice(0, 3)).toEqual(['#4 Saved carts survive sign-out', '—', '○ Stopped']);
    const m = d
      .send({ kind: 'click', id: 'session:stop' })
      .keys('<D-CR>')
      .commands.find((c) => c.kind === 'menu');

    expect(m?.kind === 'menu' ? [m.rows[0]?.text, m.rows[0]?.key] : []).toEqual(['Reopen', '⏎']);
    // chosen: that session reopened (not a new one), Chat on it
    const chosen = d.send({ kind: 'choice', menu: 'session:stop', row: 'reopen' }).commands;

    expect(chosen[0]).toEqual({
      kind: 'run',
      id: 'reopen:4',
      argv: ['session', 'reopen', 'stop'],
    });
    expect(chosen).toContainEqual({
      kind: 'open',
      screen: 'chat',
      params: { card: '4', session: 'stop' },
      slot: 'chat',
    });
    // refused (a newer one of the card runs): its one line, never a read that failed
    d.send({
      kind: 'result',
      id: 'reopen:4',
      command: 'session reopen',
      reply: {
        ok: false,
        error: {
          code: 'card-has-session',
          message: 'AB#4 has a running session 4-c3d4: stop it first',
        },
      },
    });
    expect(d.commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'balloon',
          tone: 'error',
          text: 'AB#4 has a running session 4-c3d4: stop it first (card-has-session)',
        },
      },
    ]);
    expect(d.state.failed).toEqual({});
    // a Factory run's, its run cleared (clearing stops it first): gone, as before
    const cleared = { ...session('cleared', 'ended', 4), stopped: true, factory: true as const };

    expect(read([cleared]).ids()).not.toContain('session:cleared');
    // ended on its own, no run: gone, as before
    expect(read([session('own', 'ended', 4)]).ids()).not.toContain('session:own');
    // a newer one on its card takes its place, and an older live one stands for it (as the Board)
    const again = { ...session('again', 'ended', 4), startedAt: minutes(95) };
    const live = { ...session('live', 'working', 4), startedAt: minutes(1) };

    expect(read([stopped, again]).ids()).not.toContain('session:stop');
    expect(read([stopped, live]).ids()).not.toContain('session:stop');
  });

  test('a done run and a newer plain session on its card (#335): the rows as the card reads it', () => {
    const board = cards([...F_SESSIONS.cards, listCard(4, 'Saved carts survive sign-out', 'New')]);
    const over = factoryRun(4, 'Saved carts survive sign-out', 'done', 'done', {
      session: 'ran',
      outcome: 'not-reproduced',
    });
    const ran = { ...session('ran', 'ended', 4), stopped: true, factory: true as const };
    const read = (newer: SessionData) =>
      drive()
        .read([...F_SESSIONS.sessions, ran, newer], [...F_SESSIONS.runs, over], board)
        .ids();
    const later = (state: SessionData['state'], stopped = false) => ({
      ...session('later', state, 4),
      startedAt: minutes(95),
      stopped,
    });

    // stopped or live, it stands for the card: its row, beside its run's
    const stopped = read(later('ended', true));

    expect(stopped).toContain('session:later');
    expect(stopped).toContain('session:ran');
    expect(read(later('working'))).toContain('session:later');
    // ended on its own: the card reads the run again, the plain one has no row
    expect(read(later('ended'))).not.toContain('session:later');
  });

  test("ui's slept words match core's (#37 keeps ui to core's types)", () => {
    expect(BOX_SLEPT_WAITING).toBe(core.BOX_SLEPT_WAITING);
    expect(boxStoppedHead('demo-shop-4')).toBe(core.boxStoppedHead('demo-shop-4'));
  });

  test('moving browses the window to the row (its workspace on its page, Chat on it), never the same row twice', () => {
    const d = drive().read();
    const browsed = () =>
      d.commands.flatMap((c) =>
        c.kind === 'shell' && c.effect.kind === 'workspace-page' ? [c.effect] : [],
      );

    d.keys('ö');
    expect(d.table.props.selected).toBe('session:s2');
    expect(d.commands).toEqual([
      {
        kind: 'shell',
        effect: {
          kind: 'workspace-page',
          path: '/p/demo-shop-wt/2-cart-total',
          card: 2,
          session: 's2',
          browse: true,
        },
      },
    ]);
    d.keys('G');
    expect(d.table.props.selected).toBe('session:s3');
    d.keys('g', 'g');
    expect(d.table.props.selected).toBe('session:s1');
    expect(browsed()).toEqual([
      { kind: 'workspace-page', path: '/wt/s1', card: 1, session: 's1', browse: true },
    ]);
    // already at the top: nothing moves, nothing is told
    expect(d.keys('l').commands).toEqual([]);
    d.send({ kind: 'click', id: 'session:s3' });
    expect(d.table.props.selected).toBe('session:s3');
    expect(browsed()).toMatchObject([{ card: 3, session: 's3', browse: true }]);
    // the arrows move too
    expect(d.keys('<Up>').table.props.selected).toBe('session:s2');
  });

  test('on the Editor moving browses too; the Board’s own open keeps the host’s view and tells nothing', () => {
    expect(drive({ view: 'editor' }).read().keys('ö').commands).toMatchObject([
      { kind: 'shell', effect: { kind: 'workspace-page', session: 's2', browse: true } },
    ]);
    // the Board's own open (`ifOpen`, its card only) keeps the host's view (#137)
    const d = drive({ view: 'editor' }).read();

    expect(d.send({ kind: 'open', params: { card: '3' }, size: SIZE }).commands).toEqual([]);
    expect(d.state.view).toBe('editor');
  });

  test('another checkout of the same repo keeps the rows while they are read again', () => {
    const d = drive({ root: '/p/demo-shop' }).read();
    const ids = d.ids();

    d.send({ kind: 'root', root: '/p/demo-shop-wt/2-cart-total' });
    expect(d.ids()).toEqual(ids);
  });

  test('under the Editor the list follows the shown workspace: its row, the Abe chat in the main checkout, as the chat header places it', () => {
    const hub: SessionData = {
      ...session('hub', 'working', 0),
      card: null,
      kind: 'abe',
      title: 'Abe · demo-shop',
      worktree: '/p/demo-shop',
      abe: { repo: '/p/demo-shop' },
    };
    const d = drive({ root: '/p/demo-shop', view: 'editor' }).read([...F_SESSIONS.sessions, hub]);

    expect(d.table.props.selected).toBe('session:hub');
    expect(d.rows()[0]?.[3]).toBe(HUB_WHERE);
    // another workspace shown: its row; a row of it you are on stays when opened again
    d.send({ kind: 'root', root: '/wt/s3' });
    expect(d.table.props.selected).toBe('session:s3');
    expect(argvs(d.commands)).toEqual(['session list', 'factory status', 'card list --closed']);
    d.send({ kind: 'open', params: { view: 'editor', root: '/wt/s3' }, size: SIZE });
    expect(d.table.props.selected).toBe('session:s3');
    // the main checkout again: the Abe chat
    d.send({ kind: 'open', params: { view: 'editor', root: '/p/demo-shop' }, size: SIZE });
    expect(d.table.props.selected).toBe('session:hub');
    // several Abe chat conversations: the newest
    const older = { ...hub, id: 'hub-old', startedAt: '2026-10-01T08:00:00.000Z' };
    const newer = { ...hub, id: 'hub-new', startedAt: '2026-10-01T10:00:00.000Z' };
    const e = drive({ root: '/p/demo-shop', view: 'editor' }).read([
      ...F_SESSIONS.sessions,
      older,
      newer,
    ]);

    e.send({ kind: 'root', root: '/wt/s3' });
    expect(e.table.props.selected).toBe('session:s3');
    e.send({ kind: 'open', params: { view: 'editor', root: '/p/demo-shop' }, size: SIZE });
    expect(e.table.props.selected).toBe('session:hub-new');
  });

  test("the Board's card selects its row, without telling the Board back", () => {
    // before the rows come, and after
    expect(drive({ card: '2' }).read().table.props.selected).toBe('session:s2');
    const d = drive().read();

    d.send({ kind: 'open', params: { card: '3' }, size: SIZE });
    expect(d.table.props.selected).toBe('session:s3');
    expect(d.commands).toEqual([]);
    // once placed, a later read keeps the row you moved to
    d.keys('l').send(sessionsAnswer(F_SESSIONS.sessions));
    expect(d.table.props.selected).toBe('session:s2');
    // a card with no session here: the selection stays
    d.send({ kind: 'open', params: { card: '9' }, size: SIZE });
    expect(d.table.props.selected).toBe('session:s2');
  });

  test('the Board telling of the card of the row you are on keeps that row; the jumps go along it', () => {
    const [s2] = F_SESSIONS.sessions;

    if (s2 === undefined) throw new Error('no session');
    // a second session on #2
    const d = drive().read([...F_SESSIONS.sessions, { ...s2, id: 's2b', since: minutes(85) }]);
    const rows = d.ids().filter((id) => id === 'session:s2' || id === 'session:s2b');

    d.send({ kind: 'click', id: rows[1] ?? '' });
    d.send({ kind: 'open', params: { card: '2' }, size: SIZE });
    expect(d.table.props.selected).toBe(rows[1]);
    expect(sessionsScreen.linked?.(d.state)).toBe(2);
    expect(sessionsScreen.typing?.(d.keys('/').state)).toBe(true);
  });

  test('`/` filters as you type, ⏎ keeps it, Esc clears it', () => {
    const d = drive().read().keys('/', 'c', 'a', 'r', 't');

    expect(d.ids()).toEqual(['session:s2']);
    expect(d.table.props.note).toBe('/cart▏ · 1 of 3');
    // the selection went to the only row left: the window browses to it
    expect(d.commands).toMatchObject([
      { kind: 'shell', effect: { kind: 'workspace-page', card: 2, session: 's2', browse: true } },
    ]);
    d.keys('<CR>');
    expect(d.table.props.note).toBe('/cart · 1 of 3');
    expect(d.ids()).toEqual(['session:s2']);
    d.keys('<Esc>');
    expect(d.table.props.note).toBeUndefined();
    expect(d.ids()).toHaveLength(3);
    expect(d.table.props.selected).toBe('session:s2');
    d.keys('/', 'z', 'z');
    expect(d.table.props.empty).toEqual({
      title: 'No sessions match “zz”',
      line: 'Esc clears the filter',
    });
    d.keys('<BS>', '<BS>', 'p', 'i', 'n');
    expect(d.ids()).toEqual(['session:s3']);
  });

  test("⏎: its workspace's page (the shell's; else the Factory view on its card), Chat on this session with the keys", () => {
    const page = (card: number, path: string): Command => ({
      kind: 'shell',
      effect: { kind: 'workspace-page', path, card },
    });

    // on either view: the shell knows the page the workspace last had
    for (const view of ['factory', 'editor'] as const) {
      const d = drive({ view, root: '/p/demo-shop-wt/2-cart-total/' }).read();

      expect(d.keys('ö', '<CR>').commands).toEqual([
        page(2, '/p/demo-shop-wt/2-cart-total'),
        { kind: 'open', screen: 'chat', params: { card: '2', session: 's2' }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
      ]);
      expect(d.keys('l', '<CR>').commands).toEqual([
        page(1, '/wt/s1'),
        { kind: 'open', screen: 'chat', params: { card: '1', session: 's1' }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
      ]);
    }
  });

  test("⌘⏎ is the session's actions: Open Chat first (#278), Stop…, End run…, the jumps", () => {
    const d = drive({ root: '/p/demo-shop' }).read().keys('<D-CR>');
    const menu = d.commands[0];

    expect(menu).toMatchObject({
      kind: 'menu',
      id: 'session:s1',
      title: '#1 Show stock on a product card',
    });
    if (menu?.kind !== 'menu') throw new Error('no menu');
    expect(menu.rows.map((r) => [r.text, r.key ?? '', r.reason ?? ''])).toEqual([
      ['Open Chat', '⏎', ''],
      ['Stop…', '', ''],
      ['End run…', '', ''],
      ['Open workspace', '', ''],
      ['Open card', '', ''],
      ['Linked', '⌃L', ''],
    ]);
    // the card actions' Stop…, in words (#204): what stops, what stays, what it says once stopped
    expect(d.send({ kind: 'choice', menu: 'session:s1', row: 'stop' }).commands).toEqual([
      {
        kind: 'confirm',
        argv: ['session', 'stop', 's1'],
        question: "Stop #1's session?",
        details: ['Its Claude Code stops; its worktree and its branch stay: card/1-x'],
        yes: 'Stop',
        done: "Stopped #1's session",
      },
    ]);
    // the jumps come back as choices and do what the shell's jumps do
    for (const to of ['workspace', 'story', 'linked'] as const)
      expect(d.send({ kind: 'choice', menu: 'session:s1', row: to }).commands).toEqual([
        { kind: 'jump', to, story: 1 },
      ]);
    expect(d.send({ kind: 'choice', menu: 'session:s1', row: 'resume' }).commands).toContainEqual({
      kind: 'shell',
      effect: { kind: 'focus', slot: 'chat' },
    });

    // an ended session: no Stop, Reopen first (#343), its run over so no Retry run
    const ended = d.keys('G', '<D-CR>').commands.find((c) => c.kind === 'menu');

    if (ended?.kind !== 'menu') throw new Error('no menu');
    expect(ended.rows[0]).toMatchObject({ id: 'reopen', text: 'Reopen', key: '⏎' });
    expect(ended.rows[1]?.reason).toBe('no session running');
    // Command mode rests on neither Stop… (#278) nor Reopen, which spends (#313)
    const layer = mountLayer(commandMode([]));

    layer.send(ended);
    const p = layer.tree?.props;
    const rested = p !== undefined && 'selected' in p ? p.selected : undefined;

    expect(rested).toBeDefined();
    expect(['stop', 'reopen', 'retry']).not.toContain(rested);
  });

  test('⌘⏎ on a run you stopped or that failed: Reopen, then Retry run, as Chat’s menu (#219, #343)', () => {
    const opened = (x: SessionData, run: FactoryRunData) =>
      drive({ root: '/p/demo-shop' }).read([x], [run]).keys('<D-CR>');
    const menuOf = (x: SessionData, run: FactoryRunData) => {
      const m = opened(x, run).commands.find((c) => c.kind === 'menu');

      if (m?.kind !== 'menu') throw new Error('no menu');

      return m.rows;
    };
    /** Retry run chosen: the card actions' `factory run` again. */
    const retried = (x: SessionData, run: FactoryRunData) =>
      opened(x, run)
        .send({ kind: 'choice', menu: `session:${x.id}`, row: 'retry' })
        .commands.flatMap((c) => (c.kind === 'run' ? [c.argv] : []));
    const run = factoryRun(2, 'The cart total ignores quantity', 'build', 'needs-you', {
      session: 's2',
    });
    const stopped = { ...session('s2', 'ended', 2), stopped: true };

    for (const x of [stopped, session('s2', 'ended', 2)]) {
      const rows = menuOf(x, run);

      expect(rows.map((r) => [r.text, r.reason ?? ''])).toEqual([
        ['Reopen', ''],
        ['Retry run', ''],
        ['Stop…', 'no session running'],
        ['End run…', ''],
        ['Open workspace', ''],
        ['Open card', ''],
        ['Linked', ''],
      ]);
      expect(retried(x, run)).toEqual([['factory', 'run', '2', '--repo', '/p/demo-shop']]);
      expect(rows[3]?.does).toMatchObject({ kind: 'run', argv: ['factory', 'end', '2'] });
    }

    // its box slept while it waited on you (#192): Retry goes on in the cloud, as ⏎ does
    const slept = retried(
      { ...session('s2', 'ended', 2), box: 'demo-shop-2', reason: `${BOX_SLEPT_WAITING} · x` },
      run,
    );

    expect(slept).toEqual([['factory', 'run', '2', '--repo', '/p/demo-shop', '--target', 'cloud']]);

    // a session with no run: no End rows
    const plain = menuOf(session('s2', 'working', 2), { ...run, card: 9, session: 's9' });

    expect(plain.map((r) => r.text)).not.toContain('End run…');

    // a done run's ended session: Reopen (a plain conversation), no Retry run, End run… grey
    const done = menuOf(
      session('s3', 'ended', 3),
      factoryRun(3, 'Pin the Node version', 'done', 'done', { session: 's3' }),
    );

    expect(done.map((r) => [r.text, r.reason ?? ''])).toContainEqual(['Reopen', '']);
    expect(done.map((r) => r.text)).not.toContain('Retry run');
    expect(done.map((r) => [r.text, r.reason ?? ''])).toContainEqual([
      'End run…',
      'its run is done',
    ]);
  });

  test('events change rows in place with no whole read; an unknown session or run is read by itself', () => {
    const d = drive().read();

    // #2 starts needing you, nothing read: after #1, whose wait began earlier (#2's clock is its
    // stage's, which began after its session's wait: #147's one clock)
    d.send(
      event({
        type: 'session.state',
        data: { id: 's2', card: 2, state: 'waiting', since: minutes(10), cause: 'Notification' },
      }),
    );
    expect(d.commands).toEqual([]);
    d.send(
      event({
        type: 'factory.stage',
        data: {
          card: 2,
          session: 's2',
          stage: 'build',
          from: null,
          state: 'needs-you',
          reason: 'a question',
          since: minutes(69),
          cause: 'needs-you',
          outcome: null,
        },
      }),
    );
    expect(d.commands).toEqual([]);
    expect(d.ids()).toEqual(['session:s1', 'session:s2', 'session:s3']);
    expect(d.rows()[1]?.[2]).toBe('◆ Needs you');
    // the selection stays on its session as rows move
    expect(d.table.props.selected).toBe('session:s1');

    // #1 moves on to Build: its rail and time in place
    d.send(
      event({
        type: 'factory.stage',
        data: {
          card: 1,
          session: 's1',
          stage: 'build',
          from: 'spec',
          state: 'running',
          reason: null,
          since: minutes(88),
          cause: 'stage-done',
          outcome: null,
        },
      }),
      event({
        type: 'session.state',
        data: { id: 's1', card: 1, state: 'working', since: minutes(88), cause: 'hook' },
      }),
      event({
        type: 'session.subagent',
        data: {
          id: 's1',
          card: 1,
          agent: 'a1',
          name: 'abe:reader',
          task: null,
          model: null,
          state: 'done',
          result: 'read it',
        },
      }),
      event({ type: 'box.state', data: { box: 'demo-shop-1', state: 'stopped', cause: 'idle' } }),
    );
    expect(d.commands).toEqual([]);
    expect(d.rows()[1]).toEqual([
      '#1 Show stock on a product card',
      'done,now,todo,todo,todo Build',
      '● Running',
      '☁asleep',
      '2 min',
      '—',
    ]);
    // Queued for room (#137): the outline and `queued`, as the Board's box mark, never starting
    d.send(
      event({ type: 'box.state', data: { box: 'demo-shop-1', state: 'queued', cause: 'limit' } }),
    );
    expect(d.rows()[1]?.[3]).toBe('☁asleep');
    expect(d.table.props.rows[1]?.cells[3]?.tooltip).toBe('Box demo-shop-1 · queued');

    // a session or a run not known yet: read by its id, by its card
    d.send(
      event({
        type: 'session.state',
        data: { id: 's4', card: 3, state: 'starting', since: minutes(90), cause: 'launch' },
      }),
    );
    // (starting with no run held: its card's runs too, as on every screen)
    expect(argvs(d.commands)).toEqual(['session show s4', 'factory status 3']);
    d.send(
      event({
        type: 'factory.stage',
        data: {
          card: 3,
          session: 's4',
          stage: 'spec',
          from: null,
          state: 'running',
          reason: null,
          since: minutes(90),
          cause: 'run',
          outcome: null,
        },
      }),
    );
    // (its card's runs, asked as its session started, are out already)
    expect(argvs(d.commands)).toEqual([]);
    d.send(
      {
        kind: 'result',
        id: 'session:s4',
        command: 'session show',
        reply: { ok: true, data: { ...session('s4', 'starting', 3), box: 'demo-shop-3' } },
      },
      runsAnswer(
        [
          F_SESSIONS.runs[2] ?? factoryRun(3, 'x', 'done'),
          factoryRun(3, 'Pin the Node version', 'spec', 'running', { session: 's4' }),
        ],
        'run:3',
      ),
    );
    expect(d.ids()).toContain('session:s4');
    expect(d.rows().find((r) => r[2] === '● Starting')?.[3]).toBe('☁starting');

    // #3's run cleared: its ended session goes
    d.send(
      event({
        type: 'factory.stage',
        data: {
          card: 3,
          session: 's3',
          stage: 'done',
          from: null,
          state: 'done',
          reason: null,
          since: minutes(91),
          cause: 'cleared',
          outcome: 'done',
        },
      }),
    );
    expect(d.ids()).not.toContain('session:s3');
    expect(d.commands).toEqual([]);
  });

  // #228: the run opens its pull request (autoMerge off: a person merges); serve calls it
  // needs-you (`merge waits for a person`), every screen says Ready for review (5-states.md)
  const opened = (pr?: core.FactoryPrData) =>
    event({
      type: 'factory.stage',
      data: {
        card: 2,
        session: 's2',
        stage: 'pr',
        from: 'review',
        state: 'needs-you',
        reason: 'merge waits for a person',
        since: minutes(89),
        cause: 'pr',
        outcome: null,
        ...(pr === undefined ? {} : { pr }),
      },
    });
  const PR: core.FactoryPrData = {
    repo: 'mkdir-swe/demo-shop',
    number: 18,
    url: 'https://github.com/mkdir-swe/demo-shop/pull/18',
    state: 'open',
    merge: 'person',
    checks: 'success',
    mergeCommit: null,
    deploy: null,
    branch: null,
  };

  test('a run opening its pull request reads Ready for review from the event, as the Board and Chat (#228)', () => {
    const d = drive().read().send(opened(PR));

    expect(d.commands).toEqual([]);
    expect(d.rows().find((r) => r[0]?.startsWith('#2 '))?.[2]).toBe('● Ready for review');
  });

  test('a read asked before the event and answered after keeps the event’s pull request (#228)', () => {
    // the runs read again (a gap) while the run opens its pull request; the read is older
    const d = drive()
      .read()
      .send(eventInput({ type: 'watch.gap', data: { since: 1, first: 3 }, seq: 3 }, minutes(91)))
      .send(opened(PR))
      .send(runsAnswer(F_SESSIONS.runs));

    expect(d.rows().find((r) => r[0]?.startsWith('#2 '))?.[2]).toBe('● Ready for review');
  });

  test('an older box’s event with no pull request: its run read by its card, never Needs you after (#228)', () => {
    const d = drive().read().send(opened());

    expect(argvs(d.commands)).toEqual(['factory status 2']);
    d.send(
      runsAnswer(
        [
          factoryRun(2, 'The cart total ignores quantity', 'pr', 'needs-you', {
            session: 's2',
            since: minutes(89),
            reason: 'merge waits for a person',
            pr: PR,
          }),
        ],
        'run:2',
      ),
    );
    expect(d.rows().find((r) => r[0]?.startsWith('#2 '))?.[2]).toBe('● Ready for review');
  });

  // #230: End run… › Abandoned on the run at PR; serve moves it to done with `ended`
  const abandoned = (o: { ended?: boolean } = {}) =>
    event({
      type: 'factory.stage',
      data: {
        card: 2,
        session: 's2',
        stage: 'done',
        from: 'pr',
        state: 'done',
        reason: null,
        since: minutes(92),
        cause: 'end',
        outcome: 'abandoned',
        pr: PR,
        ...(o.ended === false
          ? {}
          : {
              ended: {
                as: 'abandoned' as const,
                reason: 'not needed',
                at: minutes(92),
                from: 'pr' as const,
              },
            }),
      },
    });

  test('a run abandoned in place: the stage it was given up in and ○ Abandoned, never Done or ✓, a read after too (#230)', () => {
    const d = drive().read().send(opened(PR), abandoned());

    expect(d.commands).toEqual([]);
    expect(
      d
        .rows()
        .find((r) => r[0]?.startsWith('#2 '))
        ?.slice(1, 3),
    ).toEqual(['done,done,done,wait,todo PR', '○ Abandoned']);
    // a read asked before the end and answered after it keeps the end
    d.send(eventInput({ type: 'watch.gap', data: { since: 1, first: 3 }, seq: 3 }, minutes(93)))
      .send(abandoned())
      .send(runsAnswer(F_SESSIONS.runs));
    expect(
      d
        .rows()
        .find((r) => r[0]?.startsWith('#2 '))
        ?.slice(1, 3),
    ).toEqual(['done,done,done,wait,todo PR', '○ Abandoned']);
  });

  test('an older box’s end with no `ended`: its run read by its card (#230)', () => {
    const d = drive()
      .read()
      .send(opened(PR), abandoned({ ended: false }));

    expect(argvs(d.commands)).toEqual(['factory status 2']);
  });

  test('the clock moves the times', () => {
    const d = drive()
      .read()
      .send({ kind: 'tick', at: minutes(100) });

    expect(d.rows().map((r) => r[4])).toEqual(['1 h 18 min', '31 min', '41 min']);
  });

  test('opened again once another tab had the pane (#156): its last rows at once, read anew', () => {
    const tableOf = (node: Node): Table => {
      const t = node.kind === 'Island' ? node.children[0] : undefined;

      if (t?.kind !== 'Table') throw new Error(`no Table: ${JSON.stringify(node)}`);

      return t;
    };
    const { mounted } = mount(LIVE_SESSIONS, { root: '/p/demo-shop' }, SIZE);

    for (const input of [
      sessionsAnswer(F_SESSIONS.sessions),
      runsAnswer(F_SESSIONS.runs),
      cards(),
      { kind: 'tick' as const, at: F_SESSIONS.now },
    ])
      mounted.send(input);
    const shown = tableOf(mounted.tree).props.rows.map((r) => r.id);
    const again = mounted.reopen({ root: '/p/demo-shop' }, SIZE);

    expect(shown.length).toBeGreaterThan(0);
    // (the live sessions, runs and cards held are current: nothing read again)
    expect(argvs(again?.commands ?? [])).toEqual([]);
    const first = tableOf(again?.mounted.tree ?? mounted.tree);

    expect(first.props.rows.map((r) => r.id)).toEqual(shown);
    expect(first.props.empty).toBeUndefined();
    // the read's answer is what it shows then
    again?.mounted.send(sessionsAnswer([]));
    expect(tableOf(again?.mounted.tree ?? mounted.tree).props.empty?.title).toBe(
      'No sessions in Sprint 1',
    );
  });

  test('a cloud launch says its step and its clock by the second; none once it runs (#142)', () => {
    const t0 = minutes(89);
    const sec = (n: number) => new Date(Date.parse(t0) + n * 1000).toISOString();
    const launch: LaunchProgress = {
      step: 'box-starting',
      since: t0,
      startedAt: t0,
      box: 'demo-shop-1',
      how: 'new',
      detail: null,
      told: false,
      done: [],
    };
    const s4: SessionData = {
      ...session('s4', 'starting', 1),
      box: 'demo-shop-1',
      since: t0,
      startedAt: t0,
      launch,
    };
    const d = drive().read([s4], []);
    const row = () => d.rows().find((r) => r[0]?.startsWith('#1') === true);

    expect(sessionsScreen.seconds?.(d.state)).toBe(true);
    expect(row()?.[2]).toBe('● Box starting');
    expect(row()?.[4]).toBe('1:00');
    d.send(
      event({
        type: 'session.step',
        data: {
          id: 's4',
          card: 1,
          launch: {
            ...launch,
            step: 'box-booting',
            since: sec(7),
            done: [{ step: 'box-starting', ms: 7000 }],
          },
        },
      }),
      { kind: 'tick', at: sec(61) },
    );
    expect(row()?.[2]).toBe('● Box booting');
    expect(row()?.[4]).toBe('1:01');
    // a read asked before the step answers with the one before: the step heard stays
    d.send(sessionsAnswer([s4]));
    expect(row()?.[2]).toBe('● Box booting');
    d.send(
      event({
        type: 'session.state',
        data: { id: 's4', card: 1, state: 'working', since: sec(70), cause: 'launch' },
      }),
    );
    expect(d.state.sessions?.[0]?.launch).toBeNull();
    expect(sessionsScreen.seconds?.(d.state)).toBe(false);
  });

  test('a launch near its give-up: a red ● among the starting, never ✗ Failed; a stale step read never wins (#142)', () => {
    const t0 = minutes(70);
    const sec = (n: number) => new Date(Date.parse(t0) + n * 1000).toISOString();
    const launch: LaunchProgress = {
      step: 'base-image',
      since: sec(90),
      startedAt: t0,
      box: 'demo-shop-1',
      how: 'new',
      detail: 'step 14/27',
      told: true,
      done: [
        { step: 'box-starting', ms: 30_000 },
        { step: 'box-booting', ms: 60_000 },
      ],
    };
    const s4: SessionData = {
      ...session('s4', 'starting', 1),
      box: 'demo-shop-1',
      since: t0,
      startedAt: t0,
      launch,
    };
    const d = drive()
      .read([s4], [])
      .send({ kind: 'tick', at: sec(13 * 60) });
    const cell = () => d.table.props.rows.find((r) => r.id === 'session:s4')?.cells[2];

    expect([cell()?.mark, cell()?.hue]).toEqual(['●', 'bad']);
    d.send(
      event({
        type: 'session.step',
        data: { id: 's4', card: 1, launch: { ...launch, detail: 'step 15/27' } },
      }),
      sessionsAnswer([s4]),
    );
    expect(d.state.sessions?.[0]?.launch?.detail).toBe('step 15/27');
  });

  test('no sessions: says so for the sprint, and how to start one', () => {
    expect(drive().read([]).table.props.empty).toEqual({
      title: 'No sessions in Sprint 1',
      line: '⌘⏎ on a card: Launch agent',
    });
    // no row for ⏎ or ⌘⏎ to act on: no footer (#294)
    expect(drive().read([]).table.props.foot).toBeUndefined();
  });

  test("boxes unread: this Mac's rows and one dim row saying why", () => {
    const d = drive().send(
      {
        kind: 'result',
        id: 'sessions',
        command: 'session list',
        reply: {
          ok: true,
          data: {
            sessions: F_SESSIONS.sessions.filter((x) => x.box === undefined),
            boxes: 'AWS login expired · aws sso login --profile abe-tooling',
          },
        },
      },
      runsAnswer(F_SESSIONS.runs),
      cards(),
    );
    const last = d.table.props.rows.at(-1);

    expect(d.ids()).toEqual(['session:s2', 'session:s3', undefined]);
    expect(last?.cells).toEqual([
      {
        text: 'Box sessions not read: AWS login expired · aws sso login --profile abe-tooling',
        hue: 'dim',
      },
    ]);
    // a later read that reached the boxes takes it away
    d.send(sessionsAnswer(F_SESSIONS.sessions));
    expect(d.ids()).toHaveLength(3);
  });

  test("serve not answering; the Board not read is the header's note", () => {
    const refused: Input = {
      kind: 'result',
      id: 'sessions',
      command: null,
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'no abe serve answers' } },
    };

    expect(drive().send(refused).table.props.empty).toEqual({
      title: 'abe serve not answering',
      line: 'no abe serve answers',
    });
    const d = drive().send(sessionsAnswer(F_SESSIONS.sessions), runsAnswer(F_SESSIONS.runs), {
      kind: 'result',
      id: 'cards:team',
      command: null,
      reply: { ok: false, error: { code: 'azure', message: 'Azure DevOps not answering' } },
    });

    expect(d.table.props.note).toBe('Board not read · Azure DevOps not answering');
    // every card's session shows meanwhile
    expect(d.ids()).toHaveLength(3);
  });

  test('the board set in the settings (an install wrote it): the Board read again, its note gone (M3)', () => {
    const d = drive().send(sessionsAnswer(F_SESSIONS.sessions), runsAnswer(F_SESSIONS.runs), {
      kind: 'result',
      id: 'cards:team',
      command: null,
      reply: { ok: false, error: { code: 'no-board', message: 'no board in the settings' } },
    });

    expect(d.table.props.note).toBe('Board not read · no board in the settings');
    d.send(event({ type: 'settings.changed', data: { keys: ['board'], repo: '/p/shop' } }));
    expect(argvs(d.commands)).toEqual(['card list --closed', 'factory status']);
    d.send(cards());
    expect(d.table.props.note).toBeUndefined();
    // a theme's change with the Board read: nothing read again
    d.send(event({ type: 'settings.changed', data: { keys: [], repo: null, files: ['t.json'] } }));
    expect(d.commands).toEqual([]);
  });

  test('the rows are windowed to the height, the selection kept in view', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...session(`m${i}`, 'working', i + 1),
      since: minutes(i),
    }));
    const board = cards(many.map((_, i) => listCard(i + 1, `Card ${i + 1}`, 'Active')));
    // (280 - 28 - 24) / 30: 7 rows fit
    const d = drive().read(many, [], board);

    expect(d.ids()).toHaveLength(7);
    d.keys('G');
    expect(d.ids()[6]).toBe('session:m11');
    expect(d.table.props.selected).toBe('session:m11');
    d.keys('g', 'g');
    expect(d.ids()[0]).toBe('session:m0');
    d.send({ kind: 'resize', size: { width: 1020, height: 400 } });
    expect(d.ids()).toHaveLength(11);
  });

  test('a run moving while you work the list changes its row in place, not under you (#264)', () => {
    const d = drive().read().keys('ö');
    const order = ['session:s1', 'session:s2', 'session:s3'];

    expect([d.ids(), d.table.props.selected]).toEqual([order, 'session:s2']);
    // #3's run moved (its session ended: Failed): it would sort first; held, it stays put
    d.send(
      event({
        type: 'factory.stage',
        data: {
          card: 3,
          session: 's3',
          stage: 'pr',
          from: 'build',
          state: 'needs-you',
          reason: 'a review',
          since: minutes(89),
          cause: 'needs-you',
          outcome: null,
        },
      }),
    );
    expect([d.ids(), d.table.props.selected]).toEqual([order, 'session:s2']);
    expect(d.rows()[2]?.[2]).toBe('✗ Failed');
    expect(d.keys('ö').table.props.selected).toBe('session:s3');
    // a layer opened from the list (⌘⏎'s menu) and closed: still held
    d.send({ kind: 'focus', focused: false, layer: true }, { kind: 'focus', focused: true });
    expect([d.ids(), d.table.props.selected]).toEqual([order, 'session:s3']);
    // the keys gone: sorted afresh
    d.send({ kind: 'focus', focused: false });
    expect(d.ids()[2]).not.toBe('session:s3');
  });
});

describe('⌘⏎ on a run that never got a box (#246)', () => {
  test('Open workspace grey: never got a box', () => {
    const x: SessionData = {
      ...session('s2', 'ended', 2),
      stopped: true,
      box: 'demo-shop-2',
      neverPlaced: true,
    };
    const run = factoryRun(2, 'The cart total ignores quantity', 'spec', 'needs-you', {
      session: 's2',
    });
    const m = drive({ root: '/p/demo-shop' })
      .read([x], [run])
      .keys('<D-CR>')
      .commands.find((c) => c.kind === 'menu');

    if (m?.kind !== 'menu') throw new Error('no menu');
    expect(m.rows.find((r) => r.id === 'workspace')?.reason).toBe('never got a box');
  });
});

describe('the shown repo’s sessions only (#256)', () => {
  test('another repo’s session on a card number of this sprint is not a row, nor the Board’s card', () => {
    const [first] = F_SESSIONS.sessions;

    if (first?.card === null || first === undefined) throw new Error('no card session');
    const theirs: SessionData = {
      ...first,
      id: 'q-other',
      repo: 'mkdir-swe/qa2-e-85a7',
      box: 'qa2-e-85a7-1',
    };
    const d = drive({ card: String(first.card) }).send(
      sessionsAnswer([theirs, ...F_SESSIONS.sessions], DEMO_HERE),
      runsAnswer(F_SESSIONS.runs, 'runs', DEMO_HERE),
      cards(),
      { kind: 'tick', at: F_SESSIONS.now },
    );

    expect(d.ids()).not.toContain('q-other');
    expect(d.state.selected).not.toBe('q-other');
  });
});

describe('the wheel over the Sessions table (#323)', () => {
  test('scrolls the rows, the selection and the Board stay', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...session(`m${i}`, 'working', i + 1),
      since: minutes(i),
    }));
    const board = cards(many.map((_, i) => listCard(i + 1, `Card ${i + 1}`, 'Active')));
    const d = drive().read(many, [], board);

    d.send({ kind: 'scroll', id: 'sessions-table', x: 0, y: 2 });
    expect(d.ids()[0]).toBe('session:m2');
    expect(d.ids()).toHaveLength(7);
    expect(d.table.props.selected).toBe('session:m0');
    expect(d.commands).toEqual([]);
    d.send({ kind: 'scroll', id: 'sessions-table', x: 0, y: 40 });
    expect(d.ids().at(-1)).toBe('session:m11');
    // the Board's card off the wheeled view: its row comes into view
    d.send({ kind: 'open', params: { card: '1' }, size: SIZE });
    expect(d.table.props.selected).toBe('session:m0');
    expect(d.ids()[0]).toBe('session:m0');
  });
});
