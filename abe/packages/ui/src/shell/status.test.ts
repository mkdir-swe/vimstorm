import { describe, expect, test } from 'bun:test';
import type { Event, SessionData } from '@abe/core';
import { session, sessionsAnswer, STATUS, statusAnswer } from '@abe/testing';
import { type Node } from '../runtime/components';
import { type Command, type Input, step } from '../runtime/runtime';
import { moves, statusScreen, viewStatus } from './status';
import { withLive } from '../live';

/** The status screen with its live facts, as the bridge feeds them. */
const STATUS_LIVE = withLive(statusScreen);

const OPEN: Input = { kind: 'open', params: {}, size: { width: 800, height: 600 } };
const READS: Command[] = [
  { kind: 'run', id: 'status', argv: ['status'] },
  { kind: 'run', id: 'sessions', argv: ['session', 'list'] },
];
const AT = STATUS.startedAt;
const ran = (noun: string, verb: string | null, exit: 0 | 1 = 0): Event => ({
  seq: 2,
  at: AT,
  type: 'command.ran',
  data: { noun, verb, exit },
});

/** Runs inputs from the start; the last step's output. */
const run = (...inputs: Input[]) => {
  let state = STATUS_LIVE.init;
  let last = step(STATUS_LIVE, state, OPEN);

  state = last.state;
  for (const input of inputs) {
    last = step(STATUS_LIVE, state, input);
    state = last.state;
  }

  return last;
};

const kinds = (node: Node): string[] => [
  node.kind,
  ...('children' in node && node.children !== undefined ? node.children.flatMap(kinds) : []),
];

describe('the status screen', () => {
  test('opening it reads status and the sessions', () => {
    expect(run().commands).toEqual(READS);
  });

  test.each<[string, Input, Command[]]>([
    ['r reads again', { kind: 'key', key: 'r' }, READS],
    ['a click on the reload hint reads again', { kind: 'click', id: 'reload' }, READS],
    ['another key does nothing', { kind: 'key', key: '<CR>' }, []],
    ['a click elsewhere does nothing', { kind: 'click', id: 'session:s1' }, []],
  ])('%s', (_, input, commands) => {
    expect(run(statusAnswer(), sessionsAnswer([]), input).commands).toEqual(commands);
  });

  test.each<[string, Event, boolean]>([
    ['another command ran', ran('session', 'launch'), true],
    ['its own status read', ran('status', null), false],
    ['its own session list', ran('session', 'list'), false],
    [
      'serve started',
      { seq: 1, at: AT, type: 'serve.started', data: { version: '2', pid: 1, socket: '/s' } },
      true,
    ],
    [
      'a browser started',
      {
        seq: 3,
        at: AT,
        type: 'browser.started',
        data: { pid: 7, endpoint: 'http://127.0.0.1:9222' },
      },
      false,
    ],
  ])('an event moves it: %s → %p', (_, event, moved) => {
    expect(moves(event)).toBe(moved);
  });

  test("another command's run shows as the last command, its own reads do not", () => {
    const event = (e: Event): Input => ({ kind: 'event', event: e });
    const tree = (...inputs: Input[]) =>
      JSON.stringify(run(statusAnswer(), sessionsAnswer([]), ...inputs).tree);

    expect(tree(event(ran('sheet', 'list', 1)))).toContain(
      '"text":"Last command","note":"abe sheet list, exit 1"',
    );
    expect(tree(event(ran('status', null)))).not.toContain('Last command');
  });

  test('a reason to read while reading reads once more after, not twice at once', () => {
    const during = run({ kind: 'key', key: 'r' });

    expect(during.commands).toEqual([]);
    expect(during.state.screen.again).toBe(true);
    // each read once more as it answers: the status, then the live sessions
    expect(run({ kind: 'key', key: 'r' }, statusAnswer()).commands).toEqual(READS.slice(0, 1));
    expect(run({ kind: 'key', key: 'r' }, statusAnswer(), sessionsAnswer([])).commands).toEqual(
      READS.slice(1),
    );
  });

  test('the reads in, it sets no status bar widgets: those counts are the ear’s (#240)', () => {
    const done = run(
      statusAnswer(),
      sessionsAnswer([session('a', 'waiting'), session('b', 'working'), session('c', 'working')]),
    );

    expect(done.commands).toEqual([]);
  });

  test.each<[string, Input[], string[]]>([
    ['asking: an Empty and the reload hint', [], ['Island', 'Stack', 'Empty', 'KeyHint']],
    [
      'not answering: an Empty with why',
      [
        {
          kind: 'result',
          id: 'status',
          command: 'status',
          reply: {
            ok: false,
            error: { code: 'serve-unreachable', message: 'no abe serve answers' },
          },
        },
      ],
      ['Island', 'Stack', 'Empty', 'KeyHint'],
    ],
    [
      'no sessions',
      [statusAnswer({ ...STATUS, sessions: 0 }), sessionsAnswer([])],
      [
        'Stack',
        'Island',
        'Stack',
        'ToolWindowHeader',
        'ListRow',
        'Badge',
        'ListRow',
        'ListRow',
        'ListRow',
        'ListRow',
        'Island',
        'Stack',
        'ToolWindowHeader',
        'Empty',
        'KeyHint',
      ],
    ],
  ])('the tree, %s', (_, inputs, tree) => {
    expect(kinds(run(...inputs).tree)).toEqual(tree);
  });

  test('a failed status read after a good one drops what serve held: no answering badge, no widgets', () => {
    const down: Input = {
      kind: 'result',
      id: 'status',
      command: 'status',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'gone' } },
    };
    const after = run(
      statusAnswer(),
      sessionsAnswer([session('a', 'waiting')]),
      { kind: 'key', key: 'r' },
      down,
      sessionsAnswer([]),
    );

    expect(JSON.stringify(after.tree)).toContain(
      '"title":"abe serve is not answering","line":"gone"',
    );
    expect(after.commands).toEqual([]);
  });

  test("a failure's words are the Empty's line", () => {
    const tree = run({
      kind: 'result',
      id: 'status',
      command: 'status',
      reply: { ok: false, error: { code: 'serve-unreachable', message: 'no abe serve answers' } },
    }).tree;

    expect(JSON.stringify(tree)).toContain(
      '"title":"abe serve is not answering","line":"no abe serve answers"',
    );
  });

  test.each<[SessionData['state'], string, string]>([
    ['working', 'running', 'Running'],
    ['waiting', 'needs-you', 'Needs you'],
    ['ended', 'ended', 'Ended'],
    ['starting', 'starting', 'Starting'],
    ['queued', 'idle', 'Queued'],
  ])('a %s session is a row with AgentStatus %s (%s)', (state, agent, word) => {
    const tree = viewStatus({
      reading: 0,
      again: false,
      status: STATUS,
      sessions: [session('s1', state, 7)],
    });

    expect(JSON.stringify(tree)).toContain(
      JSON.stringify({
        kind: 'ListRow',
        id: 'session:s1',
        props: { text: '#7 Card 7', dim: 'mkdir-swe/demo-shop', note: 'card/7-x' },
        children: [{ kind: 'AgentStatus', props: { state: agent, word } }],
      }),
    );
  });

  test('the serve island lists version, process, start, what it holds and the socket', () => {
    expect(
      JSON.stringify(viewStatus({ reading: 0, again: false, status: STATUS, sessions: [] })),
    ).toContain('"note":"2 sessions, 0 workspaces"');
  });
});
