/**
 * The rendered Chat in the `chat` screen (#113 S4 + S5): its first read and the events after it,
 * the header B, the keys over the parts (`l ö gg G ⏎ u`), the changes bar's buttons, the sticky
 * scroll and `↓ N new`, and the states (ended, unreadable, a teammate's).
 */
import { describe, expect, test } from 'bun:test';
import type {
  Event,
  FactoryPrData,
  FactoryRunData,
  FilePatch,
  LaunchProgress,
  SessionData,
  TranscriptEntry,
} from '@abe/core';
import {
  factoryRun,
  factsInput,
  runsAnswer,
  session,
  sessionsAnswer,
  theirsAnswers,
} from '@abe/testing';
import { BOX_SLEPT_WAITING } from '../board/card-actions';
import { type Node } from '../runtime/components';
import { type PinnedState, pinnedScreen } from './pinned';
import { lookOf } from '../board/flow';
import { headerOf, renderedView, sessionMenu } from './rendered';
import { commandMode } from '../command/command';
import { type Command, type Input, mount, mountLayer, step } from '../runtime/runtime';
import { ids } from './transcript';
import type { ChatStatus } from './composer';
import { withLive } from '../live';
import { patchOf } from '../runtime/patch';

/** Chat with its live facts, as the bridge feeds them. */
const CHAT = withLive(pinnedScreen);

const SIZE = { width: 420, height: 800 };
const W = '/wt/s4';
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 9, 0, s)).toISOString();

const patch = (file: string, n: number): FilePatch => ({
  path: `${W}/${file}`,
  created: false,
  added: n,
  removed: 1,
  hunks: [
    {
      oldStart: 10,
      oldLines: 2,
      newStart: 10,
      newLines: n + 1,
      lines: [' keep', '-old', ...Array.from({ length: n }, (_, i) => `+new ${i}`)],
    },
  ],
  cut: 0,
});

const ENTRIES: TranscriptEntry[] = [
  { kind: 'user', id: 'u1', at: at(0), agent: null, text: 'first', context: null },
  { kind: 'assistant-text', id: 'a1', at: at(1), agent: null, text: 'Looked.' },
  { kind: 'user', id: 'u2', at: at(2), agent: null, text: 'fix the cart', context: null },
  {
    kind: 'tool-use',
    id: 't1',
    at: at(3),
    agent: null,
    tool: 'Bash',
    input: { command: 'npm test' },
  },
  {
    kind: 'tool-result',
    id: 't1',
    at: at(4),
    agent: null,
    ok: false,
    text: 'Exit code 1\nℹ pass 2\nℹ fail 1\n✖ cart total ignores quantity (1ms)',
    cut: 0,
    patch: null,
  },
  {
    kind: 'changes',
    id: 'u2',
    at: at(5),
    agent: null,
    turn: 'u2',
    files: [patch('api/src/cart.ts', 20), patch('api/test/cart.test.ts', 1)],
    cut: 0,
  },
  { kind: 'assistant-text', id: 'a2', at: at(6), agent: null, text: 'Fixed.' },
];

const SESSION: SessionData = { ...session('s4', 'working', 4), worktree: W };
const RUN = factoryRun(4, 'The cart total ignores quantity', 'build', 'running');
const PR_OPEN: FactoryPrData = {
  repo: 'mkdir-swe/demo-shop',
  number: 61,
  url: 'https://github.com/mkdir-swe/demo-shop/pull/61',
  state: 'open',
  merge: 'person',
  checks: 'success',
  mergeCommit: null,
  deploy: null,
  branch: null,
};

const transcript = (from: number, entries: TranscriptEntry[], id = 's4'): Input => ({
  kind: 'result',
  id: 'transcript',
  command: 'session transcript',
  reply: { ok: true, data: { session: id, from, entries } },
});

const event = (from: number, entries: TranscriptEntry[]): Input => ({
  kind: 'event',
  event: { seq: 1, at: at(9), type: 'session.transcript', data: { session: 's4', from, entries } },
});

const drive = (params: Record<string, string> = { root: W }, s: SessionData = SESSION) => {
  let held = step(CHAT, CHAT.init, { kind: 'open', params, size: SIZE });
  let commands: Command[] = held.commands;
  const d = {
    get tree(): Node {
      return held.tree;
    },
    get state(): PinnedState {
      return held.state.screen;
    },
    get commands(): Command[] {
      return commands;
    },
    send(...inputs: Input[]) {
      for (const input of inputs) {
        held = step(CHAT, held.state, input);
        commands = held.commands;
      }

      return d;
    },
    keys(...keys: string[]) {
      return d.send(...keys.map((key): Input => ({ kind: 'key', key })));
    },
    text: () => JSON.stringify(held.tree),
    cursor: () => held.state.screen.rendered?.folds.cursor,
  };

  return d.send(sessionsAnswer([s]), runsAnswer([RUN]), { kind: 'tick', at: at(30) });
};

const read = () => drive().send(transcript(0, ENTRIES));

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

const find = (n: Node, kind: string): Node[] => [
  ...(n.kind === kind ? [n] : []),
  ...(('children' in n ? n.children : undefined) ?? []).flatMap((c) => find(c, kind)),
];

describe('a cloud launch while it starts (#142)', () => {
  const launch: LaunchProgress = {
    step: 'base-image',
    since: at(10),
    startedAt: at(0),
    box: 'demo-shop-4',
    how: 'new',
    detail: 'step 14/27',
    told: true,
    done: [
      { step: 'box-starting', ms: 3000 },
      { step: 'box-booting', ms: 5000 },
      { step: 'workspace', ms: 2000 },
    ],
  };
  const starting: SessionData = {
    ...SESSION,
    state: 'starting',
    box: 'demo-shop-4',
    since: at(0),
    startedAt: at(0),
    launch,
  };

  test('Chat shows each step gone through with its time and the one now, the header its clock', () => {
    const d = drive({ root: W }, starting);
    const rows = find(d.tree, 'ListRow').map((n) =>
      n.kind === 'ListRow' ? [n.props.text, n.props.note] : [],
    );

    expect(rows).toEqual([
      ['✓ Box starting', '0:03'],
      ['✓ Box booting', '0:05'],
      ['✓ Workspace', '0:02'],
      ['● Building the workspace image (first time on this box, ~3 min) · step 14/27', '0:20'],
    ]);
    expect(d.text()).not.toContain('Reading the transcript');
    const header = find(d.tree, 'ChatHeader')[0];

    expect(header?.kind === 'ChatHeader' && header.props.rail?.elapsed).toBe('0:30');
    expect(header?.kind === 'ChatHeader' && header.props.rail?.word).toBe('Building image');
    expect(pinnedScreen.seconds?.(d.state)).toBe(true);
  });

  test('a reopen waking its box (#343): its steps below the conversation it goes on with', () => {
    const waking: SessionData = { ...starting, reopened: [at(0)] };
    const d = drive({ root: W }, waking).send(transcript(0, ENTRIES));
    const kinds = find(d.tree, 'ListRow').map((n) => (n.kind === 'ListRow' ? n.props.text : ''));

    expect(kinds).toContain('✓ Box starting');
    expect(d.text()).toContain('Reopened');
    // the old transcript is there, above the steps
    const text = d.text();

    expect(text.indexOf('Reopened')).toBeLessThan(text.indexOf('✓ Box starting'));
  });

  test('stuck near the give-up it is still starting: ⌘⏎ offers Stop…, no Retry', () => {
    const ids = sessionMenu({ session: starting, run: RUN, now: at(10 + 13 * 60) }).rows.map(
      (r) => r.id,
    );

    expect(ids).toContain('stop');
    expect(ids).not.toContain('retry');
  });

  test('late: what is late, a Slow badge and what to run', () => {
    const d = drive({ root: W }, starting).send({ kind: 'tick', at: at(10 + 370) });
    const text = d.text();

    expect(text).toContain('Slower than usual · building the workspace image 6:10 (usually 3 min)');
    expect(text).toContain(
      'abe box attach demo-shop-4 -- journalctl -u abe-serve -u abe-workspace -n 40',
    );
    expect(text).toContain('"text":"Slow","hue":"warn"');
  });
});

describe('reading the transcript', () => {
  test('on pinning a session it reads its transcript, saying so meanwhile', () => {
    const d = drive().send(sessionsAnswer([SESSION]));

    expect(d.text()).toContain('Reading the transcript');
    expect(read().text()).not.toContain('Reading the transcript');
    expect(find(read().tree, 'Transcript')).toHaveLength(1);
  });

  test('events put entries at their numbers; a gap reads on from the last held', () => {
    const d = read();

    d.send(event(7, [{ kind: 'assistant-text', id: 'a3', at: at(7), agent: null, text: 'More.' }]));
    expect(d.text()).toContain('More.');
    expect(d.commands).toEqual([]);
    d.send(event(12, [{ kind: 'assistant-text', id: 'a9', at: at(9), agent: null, text: 'x' }]));
    expect(argvs(d.commands)).toEqual(['session transcript s4 --since 8']);
  });

  test('a watch gap reads on with --since; a serve started again reads it all', () => {
    const d = read();
    const gap: Event = { seq: 2, at: at(9), type: 'watch.gap', data: { since: 1, first: 5 } };
    const started: Event = {
      seq: 1,
      at: at(9),
      type: 'serve.started',
      data: { pid: 1, socket: '/s', version: '2.1.0' },
    };

    d.send({ kind: 'event', event: gap });
    expect(argvs(d.commands)).toContain('session transcript s4 --since 7');
    d.send({ kind: 'event', event: started });
    expect(argvs(d.commands)).toContain('session transcript s4');
  });

  test('another session’s batch is not this one’s', () => {
    const d = read();
    const before = d.text();

    d.send({
      kind: 'event',
      event: {
        seq: 3,
        at: at(9),
        type: 'session.transcript',
        data: {
          session: 's9',
          from: 7,
          entries: [{ kind: 'assistant-text', id: 'z', at: at(9), agent: null, text: 'Nope.' }],
        },
      },
    });
    expect(d.text()).toBe(before);
  });
});

describe('the header B', () => {
  test('#4 and the title, Local sandbox, ⌘⏎; the rail, Running, time in state', () => {
    const header = find(read().tree, 'ChatHeader')[0];

    expect(header?.props).toMatchObject({
      story: { id: '#4', title: 'The cart total ignores quantity' },
      env: 'Local sandbox',
      hint: '⌘⏎',
      rail: {
        segments: ['done', 'now', 'todo', 'todo', 'todo'],
        stage: 'Build',
        state: 'running',
        word: 'Running',
        elapsed: '<1 min',
      },
    });
    expect(header?.props).not.toHaveProperty('modes');
  });

  test('a box session shows its cloud; the state word follows session.state', () => {
    const boxed = { ...SESSION, box: 'shop-4', worktree: '/workspace/repo' };
    const d = drive({ root: '/workspace/repo', box: 'shop-4' }, boxed);

    d.send({ kind: 'root', root: '/workspace/repo', box: 'shop-4' });
    expect(find(d.tree, 'ChatHeader')[0]?.props).toMatchObject({
      box: { name: 'shop-4', state: 'running' },
    });
    d.send(runsAnswer([{ ...RUN, state: 'needs-you' }]), {
      kind: 'event',
      event: {
        seq: 4,
        at: at(20),
        type: 'session.state',
        data: { id: 's4', card: 4, state: 'waiting', since: at(20), cause: 'Stop' },
      },
    });
    expect(find(d.tree, 'ChatHeader')[0]?.props).toMatchObject({
      rail: {
        state: 'needs-you',
        word: 'Needs you',
        segments: ['done', 'need', 'todo', 'todo', 'todo'],
      },
    });
  });
});

describe('keys over the parts', () => {
  test('l ö walk the parts from the last; gg first, G last', () => {
    const d = read();

    d.keys('l');
    expect(d.cursor()).toBe(ids.step('t1'));
    d.keys('l');
    expect(d.cursor()).toBe(ids.diff('u2', 'api/test/cart.test.ts'));
    d.keys('g', 'g');
    expect(d.cursor()).toBe(ids.bar('u2'));
    d.keys('ö');
    expect(d.cursor()).toBe(ids.diff('u2', 'api/src/cart.ts'));
    d.keys('G');
    expect(d.cursor()).toBe(ids.step('t1'));
  });

  test('⏎ on a diff card opens its file at the change; on the bar every file', () => {
    const d = read().keys('g', 'g', 'ö');

    d.keys('<CR>');
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'open-file', path: `${W}/api/src/cart.ts`, line: 11 } },
    ]);
    d.keys('g', 'g', '<CR>');
    expect(d.commands.map((c) => (c.kind === 'shell' ? c.effect : null))).toEqual([
      { kind: 'open-file', path: `${W}/api/src/cart.ts`, line: 11 },
      { kind: 'open-file', path: `${W}/api/test/cart.test.ts`, line: 11 },
    ]);
  });

  test("a box's session: ⏎ opens the file in the shown local checkout, or on its box (#113 B8)", () => {
    // the box's worktree stands at W; the shown workspace is the local checkout of the story
    const onBox: SessionData = { ...SESSION, box: 'shop-4' };
    const effects = (d: { commands: readonly Command[] }) =>
      d.commands.map((c) => (c.kind === 'shell' ? c.effect : null));
    const local = drive({ root: '/p/shop', card: '4' }, onBox)
      .send(transcript(0, ENTRIES))
      .keys('g', 'g', 'ö', '<CR>');

    expect(effects(local)).toEqual([
      { kind: 'open-file', path: '/p/shop/api/src/cart.ts', line: 11 },
    ]);
    local.keys('g', 'g', '<CR>');
    expect(effects(local)).toEqual([
      { kind: 'open-file', path: '/p/shop/api/src/cart.ts', line: 11 },
      { kind: 'open-file', path: '/p/shop/api/test/cart.test.ts', line: 11 },
    ]);
    // its own cloud workspace shown: the box's path, opened through the workspace's attach
    const there = drive({ root: '/p/shop', box: 'shop-4' }, onBox)
      .send(transcript(0, ENTRIES))
      .keys('g', 'g', 'ö', '<CR>');

    expect(effects(there)).toEqual([{ kind: 'open-file', path: `${W}/api/src/cart.ts`, line: 11 }]);
    // the bar's Open all, clicked, the same way
    local.send({ kind: 'click', id: `${ids.bar('u2')}:open-all` });
    expect(effects(local).length).toBe(2);
    expect(JSON.stringify(effects(local))).not.toContain(W);
    // another box shown: no checkout of it here, said so
    const other = drive({ root: '/p/shop', box: 'shop-9', session: 's4' }, onBox)
      .send(transcript(0, ENTRIES))
      .keys('g', 'g', 'ö', '<CR>');

    expect(effects(other)).toEqual([
      {
        kind: 'balloon',
        tone: 'warning',
        text: 'api/src/cart.ts is on box shop-4: open its workspace from the Board, ⏎ on the card or ⌘→',
      },
    ]);
  });

  test("the transcript names its session: the shell keeps each session's scroll apart", () => {
    expect(find(read().tree, 'Transcript')[0]?.props).toMatchObject({ session: 's4' });
  });

  test('⏎ on show N more shows every line, on a step its output, on N steps the rows', () => {
    const d = read().keys('g', 'g', 'ö', 'ö');

    expect(d.cursor()).toBe(ids.more('u2', 'api/src/cart.ts'));
    d.keys('<CR>');
    expect(d.cursor()).toBe(ids.diff('u2', 'api/src/cart.ts'));
    expect(JSON.stringify(find(d.tree, 'DiffCard')[0])).not.toContain('"more"');
    d.keys('G', '<CR>');
    const row = find(d.tree, 'StepRow')[0];

    expect(row?.props).toMatchObject({ unfolded: true, mark: 'bad' });
    expect(JSON.stringify(row)).toContain('ℹ fail 1');
  });

  test('u on a diff card asks to revert that file; on the bar the turn', () => {
    const d = read().keys('g', 'g', 'ö', 'u');

    expect(d.commands).toEqual([
      {
        kind: 'confirm',
        argv: ['session', 'revert', 's4', '--turn', 'u2', '--file', 'api/src/cart.ts'],
        question: 'Revert api/src/cart.ts?',
        details: ['Puts back its text from before this turn. Refused when it changed since.'],
        yes: 'Revert',
        done: 'Reverted api/src/cart.ts',
      },
    ]);
    d.keys('g', 'g', 'u');
    expect(d.commands[0]).toMatchObject({
      kind: 'confirm',
      argv: ['session', 'revert', 's4', '--turn', 'u2'],
      question: 'Revert 2 files?',
      done: 'Reverted 2 files',
    });
  });

  test('the bar’s Keep dims it (nothing written); Revert asks; Open all opens them', () => {
    const d = read().send({ kind: 'click', id: `${ids.bar('u2')}:keep` });

    expect(d.commands).toEqual([]);
    expect(find(d.tree, 'ChangesBar')[0]?.props).toMatchObject({ kept: true });
    d.send({ kind: 'click', id: `${ids.bar('u2')}:revert` });
    expect(d.commands[0]).toMatchObject({ kind: 'confirm', question: 'Revert 2 files?' });
    d.send({ kind: 'click', id: `${ids.bar('u2')}:open-all` });
    expect(d.commands).toHaveLength(2);
  });

  test('a click on a diff card’s header folds it the other way', () => {
    const d = read().send({ kind: 'click', id: ids.diff('u2', 'api/test/cart.test.ts') });

    expect(find(d.tree, 'DiffCard')[1]?.props).not.toHaveProperty('folded');
    expect(d.cursor()).toBe(ids.diff('u2', 'api/test/cart.test.ts'));
  });

  test('y copies the cursor’s part: a diff card its path, a step its output; no cursor, it types', () => {
    const clipboard = (d: ReturnType<typeof read>) =>
      d.commands.flatMap((c) =>
        c.kind === 'shell' && c.effect.kind === 'clipboard' ? [c.effect.text] : [],
      );
    const d = read().keys('g', 'g', 'ö', 'y');

    expect(clipboard(d)).toEqual(['api/src/cart.ts']);
    expect(d.commands[1]).toEqual({
      kind: 'shell',
      effect: { kind: 'status', text: 'Copied api/src/cart.ts' },
    });
    d.keys('G', 'y');
    expect(clipboard(d)[0]).toContain('ℹ fail 1');
    expect(read().keys('y').commands).toEqual([]);
  });

  test('a printable key it has no use for does nothing (the composer takes it, #115)', () => {
    const d = read().keys('x');

    expect(d.commands).toEqual([]);
  });
});

describe('the status line over the composer', () => {
  const run = (id: string, state: 'running' | 'done', call: string | null = null) => ({
    id,
    name: 'abe:reader',
    task: `read ${id}`,
    model: 'sonnet',
    state,
    startedAt: at(10),
    endedAt: state === 'done' ? at(20) : null,
    result: state === 'done' ? 'Found it.' : null,
    tool: state === 'running' ? 'Read cart.ts' : null,
    tools: 3,
    call,
  });
  const running: TranscriptEntry[] = [
    ...ENTRIES,
    { kind: 'user', id: 'u3', at: at(7), agent: null, text: 'look around', context: null },
    {
      kind: 'tool-use',
      id: 'k1',
      at: at(8),
      agent: null,
      tool: 'Agent',
      input: { description: 'read a1', subagent_type: 'abe:reader' },
    },
    {
      kind: 'tool-use',
      id: 'k2',
      at: at(8),
      agent: null,
      tool: 'Agent',
      input: { description: 'read a2', subagent_type: 'abe:reader' },
    },
  ];
  const status = (s: SessionData, entries = ENTRIES) => {
    const d = drive({ root: W }, s).send(transcript(0, entries));

    return { d, node: find(d.tree, 'ChatStatus')[0] };
  };

  test.each<[string, SessionData, TranscriptEntry[], ChatStatus['props'] | undefined]>([
    [
      'working, no tool running: Thinking, timed from the state',
      SESSION,
      ENTRIES,
      { tone: 'working', words: 'Thinking', since: Date.parse(SESSION.since) },
    ],
    [
      'its turn over: Idle, no time',
      { ...SESSION, state: 'waiting' },
      ENTRIES,
      { tone: 'idle', words: 'Idle · your turn' },
    ],
    [
      'two subagents running: the coordinator waits on them, the count at the right',
      {
        ...SESSION,
        subagents: [run('a1', 'running', 'k1'), run('a2', 'running', 'k2'), run('a0', 'done')],
      },
      running,
      {
        tone: 'working',
        words: 'Waiting on 2 subagents',
        since: Date.parse(SESSION.since),
        agents: { text: '2 subagents', id: 'chat:agents', running: 2, open: false },
      },
    ],
    [
      'its turn ended, a background subagent on: your turn, still working, the running one counted, the done not',
      {
        ...SESSION,
        turnEnded: true,
        subagents: [run('a1', 'running', 'k1'), run('a0', 'done')],
      },
      running,
      {
        tone: 'working',
        words: 'Your turn · 1 subagent working',
        since: Date.parse(SESSION.since),
        agents: { text: '1 subagent', id: 'chat:agents', running: 1, open: false },
      },
    ],
    [
      'waiting with a background subagent on: not Idle',
      { ...SESSION, state: 'waiting', subagents: [run('a1', 'running', 'k1')] },
      running,
      {
        tone: 'working',
        words: 'Your turn · 1 subagent working',
        since: Date.parse(SESSION.since),
        agents: { text: '1 subagent', id: 'chat:agents', running: 1, open: false },
      },
    ],
    [
      'its subagents all done: no count',
      { ...SESSION, state: 'waiting', subagents: [run('a0', 'done')] },
      ENTRIES,
      { tone: 'idle', words: 'Idle · your turn' },
    ],
    ['ended: no status line', { ...SESSION, state: 'ended' }, ENTRIES, undefined],
  ])('%s', (_, s, entries, props) => {
    expect(status(s, entries).node?.props).toEqual(props);
  });

  test('Tab unfolds the running subagents only; ⏎ goes to its Agent call in the transcript', () => {
    const s = {
      ...SESSION,
      subagents: [run('a1', 'running', 'k1'), run('a2', 'running', 'k2'), run('a0', 'done')],
    };
    const { d } = status(s, running);

    d.keys('<Tab>');
    const list = find(d.tree, 'ChatStatus')[0];

    expect(
      list?.kind === 'ChatStatus' ? list.props.list?.map((r) => [r.id, r.state, r.last]) : [],
    ).toEqual([
      ['chat:agent:a2', 'running', 'Read cart.ts'],
      ['chat:agent:a1', 'running', 'Read cart.ts'],
    ]);
    d.keys('ö', '<CR>');
    // both Agent calls fold to one row under the first call's id
    expect(d.cursor()).toBe(ids.step('k1'));
    d.keys('<Esc>');
    expect(find(d.tree, 'ChatStatus')[0]?.props).not.toHaveProperty('list');
    d.send({ kind: 'click', id: 'chat:agent:a2' });
    expect(d.cursor()).toBe(ids.step('k1'));
  });
});

describe('scrolling', () => {
  test('at the bottom new entries scroll in: no ↓ N new', () => {
    const d = read().send(
      event(7, [{ kind: 'assistant-text', id: 'a3', at: at(7), agent: null, text: 'More.' }]),
    );

    expect(find(d.tree, 'NewBelow')).toEqual([]);
  });

  test('scrolled up, new entries count in ↓ N new; ⏎ on it jumps down', () => {
    const d = read().send({ kind: 'click', id: `${ids.transcript}:up` });

    d.send(
      event(7, [
        {
          kind: 'tool-use',
          id: 't2',
          at: at(7),
          agent: null,
          tool: 'Bash',
          input: { command: 'ls' },
        },
        { kind: 'assistant-text', id: 'a3', at: at(8), agent: null, text: 'More.' },
      ]),
    );
    expect(find(d.tree, 'NewBelow')[0]?.props).toEqual({ count: 2 });
    // a replacement of an entry already held is not new
    d.send(
      event(7, [
        {
          kind: 'tool-use',
          id: 't2',
          at: at(7),
          agent: null,
          tool: 'Bash',
          input: { command: 'ls' },
        },
      ]),
    );
    expect(find(d.tree, 'NewBelow')[0]?.props).toEqual({ count: 2 });
    d.keys('G');
    expect(find(d.tree, 'NewBelow')).toEqual([]);
    expect(find(d.tree, 'Transcript')[0]?.props).toMatchObject({ bottom: 1 });
  });

  test('the shell scrolled back down by itself: no ↓ N new', () => {
    const d = read().send({ kind: 'click', id: `${ids.transcript}:up` });

    d.send(event(7, [{ kind: 'assistant-text', id: 'a3', at: at(7), agent: null, text: 'More.' }]));
    d.send({ kind: 'click', id: `${ids.transcript}:bottom` });
    expect(find(d.tree, 'NewBelow')).toEqual([]);
  });

  test('the cursor reveals its part', () => {
    const d = read().keys('g', 'g');

    expect(find(d.tree, 'Transcript')[0]?.props).toMatchObject({ reveal: ids.bar('u2') });
  });

  // the Run page's Open in Chat (3.0 #21): an entry's turn, before or after it is read
  test.each([
    ['an entry read after the open', 't1', 'u2', false],
    ['your own message', 'u1', 'u1', false],
    ['an entry read already', 'a2', 'u2', true],
  ])('Open in Chat at %s: its turn shown', (_, entry, turn, before) => {
    const params = { root: W, card: '4', session: 's4', at: entry };
    const d = before
      ? read().send({ kind: 'open', params, size: SIZE })
      : drive(params).send(transcript(0, ENTRIES));

    expect(find(d.tree, 'Transcript')[0]?.props).toMatchObject({ reveal: ids.turn(turn) });
  });
});

describe('find in the transcript', () => {
  // an earlier turn whose rows fold to `1 step`, then the newest
  const FIND: TranscriptEntry[] = [
    {
      kind: 'user',
      id: 'u1',
      at: at(0),
      agent: null,
      text: 'make the cart total right',
      context: null,
    },
    {
      kind: 'tool-use',
      id: 'r1',
      at: at(1),
      agent: null,
      tool: 'Read',
      input: { file_path: `${W}/api/src/cart.ts` },
    },
    {
      kind: 'tool-result',
      id: 'r1',
      at: at(2),
      agent: null,
      ok: true,
      text: '',
      cut: 0,
      patch: null,
    },
    {
      kind: 'assistant-text',
      id: 'a1',
      at: at(3),
      agent: null,
      text: 'The cart total ignores quantity.',
    },
    { kind: 'user', id: 'u2', at: at(4), agent: null, text: 'and the Cart page?', context: null },
    { kind: 'assistant-text', id: 'a2', at: at(5), agent: null, text: 'Done.' },
  ];
  const bar = (d: { tree: Node }) => {
    const [t] = find(d.tree, 'Transcript');

    return t?.kind === 'Transcript' ? t.props : undefined;
  };

  test('`/` finds as you type, ignoring case: the newest current; ⏎ ↓ next, ⇧⏎ ↑ back, wrapping', () => {
    const d = drive().send(transcript(0, FIND)).keys('/', 'c', 'a', 'r', 't');

    expect(bar(d)).toMatchObject({
      find: { text: 'cart', typing: true, count: '4 of 4', at: { part: 'msg:u2', n: 0 } },
    });
    expect(pinnedScreen.typing?.(d.state)).toBe(true);
    d.keys('<CR>');
    expect(bar(d)).toMatchObject({ find: { count: '1 of 4', at: { part: 'msg:u1' } } });
    // a folded turn's row: counted, and the jump there opens its rows
    expect(find(d.tree, 'StepRow')).toHaveLength(0);
    d.keys('<Down>');
    expect(bar(d)).toMatchObject({ find: { count: '2 of 4', at: { part: 'step:r1' } } });
    expect(find(d.tree, 'StepRow')).toHaveLength(1);
    d.keys('<S-CR>', '<Up>');
    expect(bar(d)).toMatchObject({ find: { count: '4 of 4', at: { part: 'msg:u2' } } });
    d.keys('x');
    expect(bar(d)).toMatchObject({ find: { text: 'cartx', count: 'No matches', none: true } });
  });

  test('⌘F from the composer: Esc gives it the keys back; `n` `N` go on in the transcript', () => {
    const d = drive().send(transcript(0, FIND), { kind: 'focus', focused: true });

    expect(d.state.composer.active).toBe(true);
    d.keys('<D-f>', 'c', 'a', 'r', 't');
    expect(d.state.composer.active).toBe(false);
    expect(bar(d)).toMatchObject({ find: { text: 'cart', count: '4 of 4' } });
    d.keys('<Esc>');
    expect(bar(d)?.find).toBeUndefined();
    expect(d.state.composer.active).toBe(true);
    // Esc to the transcript: `n` the next after where it was, `N` back, Esc closes it again
    d.keys('<Esc>', 'n');
    expect(bar(d)).toMatchObject({ find: { text: 'cart', count: '1 of 4' } });
    expect(bar(d)?.find?.typing).toBeUndefined();
    d.keys('N', 'N');
    expect(bar(d)).toMatchObject({ find: { count: '3 of 4', at: { part: 'prose:u1' } } });
    d.keys('<Esc>');
    expect(bar(d)?.find).toBeUndefined();
    expect(d.state.composer.active).toBe(false);
  });
});

describe('states', () => {
  test('ended: the transcript stays, ○ Ended', () => {
    const ended = { ...SESSION, state: 'ended' as const };
    const d = drive({ root: W }, ended).send(transcript(0, ENTRIES));

    expect(d.text()).toContain('Fixed.');
    expect(find(d.tree, 'ChatHeader')[0]?.props).toMatchObject({
      rail: { state: 'ended', word: 'Ended' },
    });
  });

  test('unreadable: one dim row pointing to Terminal mode, the header still live', () => {
    const d = drive().send({
      kind: 'result',
      id: 'transcript',
      command: 'session transcript',
      reply: {
        ok: false,
        error: {
          code: 'transcript-unreadable',
          message: 'the transcript of s4 is not readable here',
        },
      },
    });

    expect(d.text()).toContain('Transcript not readable here · ⌃⌘→ Terminal mode');
    expect(find(d.tree, 'ChatHeader')[0]?.props).toMatchObject({ rail: { word: 'Running' } });
    // serve's events bring the entries after all: the transcript shows
    d.send(event(0, ENTRIES));
    expect(d.text()).not.toContain('Transcript not readable here');
    expect(d.text()).toContain('Fixed.');
  });

  test('an ended session: no ⌘4 Terminal mode, which attaches only a live one (#258)', () => {
    const d = drive(undefined, { ...SESSION, state: 'ended' }).send({
      kind: 'result',
      id: 'transcript',
      command: 'session transcript',
      reply: {
        ok: false,
        error: {
          code: 'transcript-unreadable',
          message: 'the transcript of s4 is not readable here',
        },
      },
    });

    expect(d.text()).toContain('Transcript not readable here');
    expect(d.text()).not.toContain('⌘4');
  });

  test("a cloud session on a box with another abe (#154, #188): the box's words, not 'here'", () => {
    const why =
      "demo-shop-1 runs abe 2.0.0-alpha.0, this machine 2.2.0-1a2b3c4d: `session transcript` needs this machine's abe on the box · update the box release (docs/cloud.md › A new abe on your box)";
    const d = drive().send({
      kind: 'result',
      id: 'transcript',
      command: 'session transcript',
      reply: { ok: false, error: { code: 'box-version', message: why } },
    });

    expect(d.text()).toContain(`Transcript not readable: ${why} · ⌃⌘→ Terminal mode`);
    expect(d.text()).not.toContain('not readable here');
  });

  test("your session on a teammate's card: ⌘⏎ stops it (#306); a teammate's stops nothing", () => {
    const d = drive().send(...theirsAnswers(4, 'Ada Example'), transcript(0, ENTRIES));

    d.keys('<D-CR>');
    const menu = d.commands.find((c) => c.kind === 'menu');

    expect(menu?.kind === 'menu' ? menu.rows.map((r) => r.id) : []).toContain('stop');
    expect(
      sessionMenu({ session: SESSION, run: RUN, whose: 'Ada Example' }).rows.map((r) => r.id),
    ).not.toContain('stop');
    const own = read()
      .keys('<D-CR>')
      .commands.find((c) => c.kind === 'menu');

    expect(own?.kind === 'menu' ? own.rows.map((r) => r.id) : []).toContain('stop');
  });

  test('⌘⏎ on an ended session: Retry is offered, but the menu never rests on it (#313)', () => {
    const failed = factoryRun(4, 'x', 'build', 'needs-you', { session: SESSION.id });
    const menu = sessionMenu({ session: { ...SESSION, state: 'ended' }, run: failed, now: at(30) });
    const layer = mountLayer(commandMode([]));

    expect(menu.rows.map((r) => r.id)).toContain('retry');
    layer.send(menu);
    const p = layer.tree?.props;

    expect(p !== undefined && 'selected' in p ? p.selected : undefined).not.toBe('retry');
  });

  test('a Factory run: End run… and, on a bug that does not reproduce, End: can’t reproduce (#184)', () => {
    const rowsOf = (run: typeof RUN, whose?: string) => {
      const m = sessionMenu({ session: SESSION, run, now: at(30), whose });

      return m.rows.map((r) => r.id);
    };
    const stuck = factoryRun(4, 'x', 'build', 'needs-you', {
      reason: 'not reproduced: no bug on main',
    });
    const menu = sessionMenu({ session: SESSION, run: stuck, now: at(30) });

    expect(rowsOf(RUN)).toContain('end');
    expect(rowsOf(RUN)).not.toContain('end-not-reproduced');
    expect(menu.rows.map((r) => r.id).slice(1, 3)).toEqual(['end-not-reproduced', 'end']);
    expect(menu.rows.find((r) => r.id === 'end-not-reproduced')?.does).toMatchObject({
      kind: 'run',
      argv: ['factory', 'end', '4', '--as', 'not-reproduced'],
    });
    expect(rowsOf(stuck, 'Ada Example')).not.toContain('end');
  });

  test("your session on a teammate's card: no one else's name, Keep and Revert yours (#306)", () => {
    const d = drive().send(...theirsAnswers(4, 'Ada Example'), transcript(0, ENTRIES));

    expect(find(d.tree, 'ChatHeader')[0]?.props).toMatchObject({ env: 'Local sandbox' });
    expect(JSON.stringify(find(d.tree, 'ChangesBar')[0])).toContain('Revert');
    d.send({ kind: 'click', id: `${ids.bar('u2')}:keep` });
    expect(find(d.tree, 'ChangesBar')[0]?.props).toHaveProperty('kept');
    // a teammate's session, told whose: the header names them
    expect(headerOf({ session: SESSION, whose: 'Ada Example' }).props).toMatchObject({
      env: "Ada Example's session · Local sandbox",
    });
  });

  // a session of no card (the install's): no card stages to draw, so no segments on its rail
  test('a session of no card: its rail has no card stages', () => {
    expect(headerOf({ session: { ...SESSION, card: null } }).props.rail?.segments).toEqual([]);
    expect(headerOf({ session: SESSION }).props.rail?.segments).toHaveLength(5);
  });

  test('no session: the launch look stays M2’s', () => {
    const d = drive(
      { root: '/p/x', branch: 'card/1' },
      { ...SESSION, worktree: '/elsewhere', card: 9 },
    );

    expect(d.text()).toContain('No session on #1 yet');
    expect(d.text()).toContain('Launch agent');
  });
});

describe('a Queued run in Chat (#321): what it waits for and the ways on, no stage yet', () => {
  test('the body says the boxes that count and the limit, how to make room or leave the queue', () => {
    const d = read();
    const r = d.state.rendered;

    expect(r).toBeDefined();
    if (r === undefined) return;
    const queued: SessionData = {
      ...SESSION,
      state: 'queued',
      box: 'demo-shop-4',
      queuedFor: { boxes: ['demo-shop-1', 'demo-shop-2'], limit: 2 },
    };
    const run = factoryRun(4, 'The cart total ignores quantity', 'spec', 'queued');
    const tree = renderedView({ ...r, log: [] }, { session: queued, run, now: at(30) });
    const text = JSON.stringify(tree);

    expect(text).toContain(
      'Queued: 2 of 2 boxes running or starting (demo-shop-1, demo-shop-2; limits.maxBoxesPerPerson) · starts when one stops',
    );
    expect(text).toContain('Make room: stop one of those boxes (Boxes, on the rail)');
    expect(text).toContain('Or ⌘⏎ Stop… takes it out of the queue');
    // nothing ran yet: no stage on its rail, every segment still to do
    expect(find(tree, 'ChatHeader')[0]?.props).toMatchObject({
      rail: { stage: '', segments: ['todo', 'todo', 'todo', 'todo', 'todo'], word: 'Queued' },
    });
  });
});

describe("the slots other parts of Chat fill (#114's cards, #115's composer)", () => {
  test('the foot sits under the transcript, in order; the tail closes the transcript', () => {
    const d = read();
    const r = d.state.rendered;

    expect(r).toBeDefined();
    if (r === undefined) return;
    const part = (id: string): Node => ({
      kind: 'StageDivider',
      id,
      props: { from: id, to: id, at: '' },
    });
    const tree = renderedView(
      r,
      { session: SESSION, run: RUN, now: at(30) },
      { tail: [part('card')], foot: [part('pill'), part('composer')] },
    );
    const column = tree.kind === 'Island' ? tree.children[0] : undefined;

    expect(column?.kind).toBe('Stack');
    if (column?.kind !== 'Stack') return;
    expect(column.children.map((n) => n.kind)).toEqual([
      'ChatHeader',
      'Transcript',
      'StageDivider',
      'StageDivider',
    ]);
    expect(column.children.slice(2).map((n) => n.id)).toEqual(['pill', 'composer']);
    expect(column.props.sizes).toEqual(['auto', { flex: 1 }, 'auto', 'auto']);
    const shown = find(tree, 'Transcript')[0];

    expect(shown?.kind === 'Transcript' ? shown.children.at(-1)?.id : undefined).toBe('card');
  });
});

describe('folds and counts as the transcript moves on', () => {
  const next: TranscriptEntry[] = [
    { kind: 'user', id: 'u3', at: at(20), agent: null, text: 'and the tests', context: null },
  ];

  test('a card folded by hand stays folded when a newer turn comes', () => {
    const d = read();
    const card = ids.diff('u2', 'api/src/cart.ts');
    const folded = () => find(d.tree, 'DiffCard').find((n) => n.id === card)?.props;

    expect(folded()).not.toHaveProperty('folded');
    d.send({ kind: 'click', id: card });
    expect(folded()).toMatchObject({ folded: true });
    d.send(event(7, next));
    expect(folded()).toMatchObject({ folded: true });
    d.send({ kind: 'click', id: card });
    expect(folded()).not.toHaveProperty('folded');
  });

  test('scrolled up, ↓ N new counts what draws: not a changes entry', () => {
    const d = read().send({ kind: 'click', id: `${ids.transcript}:up` });

    d.send(
      event(7, [
        ...next,
        { kind: 'changes', id: 'u3', at: at(21), agent: null, turn: 'u3', files: [], cut: 0 },
      ]),
    );
    expect(find(d.tree, 'NewBelow')[0]?.props).toMatchObject({ count: 1 });
  });
});

test('Esc in the transcript hands the keys back: unhandled, as the column asks (#119)', () => {
  const d = read().keys('ö', '<Esc>');

  expect(d.commands).toEqual([
    { kind: 'shell', effect: { kind: 'unhandled', slot: 'chat', key: '<Esc>' } },
  ]);
});

describe("the header's state glyph (ADR 0013: TS says what it is)", () => {
  const pr = (merge: 'person' | 'auto') => ({
    repo: 'mkdir-swe/demo-shop',
    number: 7,
    url: 'https://github.com/mkdir-swe/demo-shop/pull/7',
    state: 'open' as const,
    merge,
    checks: 'success' as const,
    mergeCommit: null,
    deploy: null,
    branch: null,
  });
  const runs = [
    RUN,
    factoryRun(4, 'x', 'done', 'done', { outcome: 'reported' }),
    factoryRun(4, 'x', 'pr', 'running', { pr: pr('person') }),
    factoryRun(4, 'x', 'build', 'needs-you', { reason: 'No stock source' }),
  ];

  test.each(runs.map((r) => [`${r.stage} ${r.state}`, r] as const))(
    "a run's glyph is the Board's: %s",
    (_, run) => {
      expect(headerOf({ session: SESSION, run }).props.rail?.glyph).toBe(
        lookOf(run, SESSION).glyph,
      );
    },
  );

  test('abandoned in pr: `PR ○ Abandoned`, dim, the rail stopped at PR, never Done (#229)', () => {
    const run = factoryRun(4, 'x', 'done', 'done', {
      outcome: 'abandoned',
      ended: { as: 'abandoned', reason: 'not needed', at: RUN.since, from: 'pr' },
    });
    const rail = headerOf({ session: { ...SESSION, state: 'ended' }, run }).props.rail;

    expect(rail).toMatchObject({
      stage: 'PR',
      glyph: '○',
      word: 'Abandoned',
      segments: ['done', 'done', 'done', 'wait', 'todo'],
    });
    expect(rail?.state).not.toBe('on-test');
  });

  test('your Override in force at launch (#168): a pill, why and since when in its tooltip', () => {
    const run = factoryRun(4, 'x', 'build', 'running', {
      personal: [
        {
          key: 'autoMerge',
          value: true,
          shown: 'on',
          reason: 'my sandbox',
          since: '2026-10-24T09:30:00.000Z',
        },
      ],
    });

    expect(headerOf({ session: SESSION, run }).props.pill).toEqual({
      text: 'Override · autoMerge on',
      tooltip: 'Your Override, for your runs only: autoMerge on — my sandbox (since 2026-10-24)',
    });
    expect(headerOf({ session: SESSION, run: RUN }).props.pill).toBeUndefined();
    expect(headerOf({ session: SESSION, run, whose: 'Alex Example' }).props.pill?.tooltip).toBe(
      "Alex Example's Override, for their runs only: autoMerge on — my sandbox (since 2026-10-24)",
    );
  });

  test('Answered ✓, Ready for review ●, an ended live run ○, no run the session’s own', () => {
    const glyph = (run: (typeof runs)[number] | undefined, s: SessionData = SESSION) =>
      headerOf({ session: s, ...(run === undefined ? {} : { run }) }).props.rail?.glyph;

    expect(glyph(runs[1])).toBe('✓');
    expect(glyph(runs[2])).toBe('●');
    expect(glyph(RUN, { ...SESSION, state: 'ended' })).toBe('○');
    expect(glyph(undefined, { ...SESSION, state: 'waiting' })).toBe('◆');
    expect(glyph(undefined, { ...SESSION, state: 'queued' })).toBe('○');
    expect(glyph(undefined)).toBe('●');
  });

  test('a run asking its spec questions: its round in the header; a teammate’s says whose answer it waits on', () => {
    const asking = factoryRun(4, 'x', 'spec', 'needs-you');
    const waiting = { ...SESSION, state: 'waiting' as const, rounds: 2 };

    expect(headerOf({ session: waiting, run: asking }).props.rail).toMatchObject({
      glyph: '◆',
      word: 'Needs you · Question round 2',
      stage: 'Spec',
    });
    expect(
      headerOf({ session: waiting, run: asking, whose: 'Ana Example' }).props.rail,
    ).toMatchObject({ word: 'Needs Ana · Question round 2' });
    expect(
      headerOf({ session: { ...waiting, state: 'working' }, run: factoryRun(4, 'x', 'spec') }).props
        .rail,
    ).toMatchObject({ glyph: '●', word: 'Writing spec' });
  });

  test('a run whose session you stopped: ○ Stopped, dim; on its own ✗ Failed (#205)', () => {
    const waits = factoryRun(4, 'x', 'build', 'needs-you');
    const rail = (s: SessionData) => headerOf({ session: s, run: waits }).props.rail;

    expect(rail({ ...SESSION, state: 'ended', stopped: true })).toMatchObject({
      state: 'idle',
      glyph: '○',
      word: 'Stopped',
    });
    expect(rail({ ...SESSION, state: 'ended' })).toMatchObject({ state: 'failed', word: 'Failed' });
  });

  test('one word per run (#258): a stopped session reads Stopped with its run or without', () => {
    const word = (s: SessionData, run?: FactoryRunData) =>
      headerOf({ session: s, ...(run === undefined ? {} : { run }) }).props.rail?.word;
    const stopped = { ...SESSION, state: 'ended' as const, stopped: true };

    expect(word(stopped)).toBe('Stopped');
    expect(word(stopped, factoryRun(4, 'x', 'spec', 'queued'))).toBe('Stopped');
    expect(word({ ...SESSION, state: 'ended' })).toBe('Ended');
  });

  test('⌘⏎ on a run you stopped offers Retry, as on a failed one; a running one Stop… (#205)', () => {
    const waits = factoryRun(4, 'x', 'build', 'needs-you');
    const ids = (s: SessionData) => sessionMenu({ session: s, run: waits }).rows.map((r) => r.id);

    expect(ids({ ...SESSION, state: 'ended', stopped: true })).toContain('retry');
    expect(ids({ ...SESSION, state: 'ended' })).toContain('retry');
    expect(ids(SESSION)).toContain('stop');
    expect(ids(SESSION)).not.toContain('retry');
  });

  test('Chat’s Retry goes to the cloud for a box that slept while it waited, as ⏎ does (#221)', () => {
    const waits = factoryRun(4, 'x', 'build', 'needs-you');
    const argv = (s: SessionData): string[] => {
      const does = sessionMenu({ session: s, run: waits }).rows.find((r) => r.id === 'retry')?.does;

      return does?.kind === 'run' ? does.argv : [];
    };
    const slept = { ...SESSION, state: 'ended' as const, reason: `${BOX_SLEPT_WAITING} · x` };

    expect(argv(slept).slice(-2)).toEqual(['--target', 'cloud']);
    expect(argv({ ...SESSION, state: 'ended' })).not.toContain('--target');
  });

  test('a stopped session whose pull request is open: as the pull request stands, no Retry run', () => {
    const inPr = { ...factoryRun(4, 'x', 'pr', 'needs-you'), pr: PR_OPEN };
    const s = { ...SESSION, state: 'ended' as const, stopped: true };

    expect(headerOf({ session: s, run: inPr }).props.rail?.word).not.toBe('Stopped');
    expect(sessionMenu({ session: s, run: inPr }).rows.map((r) => r.id)).not.toContain('retry');
  });

  test('⌘⏎ on an ended session: Reopen first (⏎ too), Retry run on a run not over (#343)', () => {
    const ended = { ...SESSION, state: 'ended' as const };
    const failed = factoryRun(4, 'x', 'build', 'needs-you');
    const rows = sessionMenu({ session: ended, run: failed }).rows;

    expect(rows.slice(0, 2).map((r) => [r.id, r.text, r.key])).toEqual([
      ['reopen', 'Reopen', '⏎'],
      ['retry', 'Retry run', undefined],
    ]);
    expect(rows[0]?.does).toMatchObject({ kind: 'run', argv: ['session', 'reopen', 's4'] });
    // a run over: Reopen only (a plain conversation)
    const done = factoryRun(4, 'x', 'done', 'done', { outcome: 'done' });

    expect(sessionMenu({ session: ended, run: done }).rows.map((r) => r.id)).toContain('reopen');
    expect(sessionMenu({ session: ended, run: done }).rows.map((r) => r.id)).not.toContain('retry');
    // a teammate's: neither
    const theirs = sessionMenu({ session: ended, run: failed, whose: 'Sam Sample' }).rows;

    expect(theirs.map((r) => r.id)).not.toContain('reopen');
  });

  test('a reopened session: `Reopened <when>` where its conversation went on (#343)', () => {
    const reopened = { ...SESSION, reopened: [at(30)] };
    const d = drive({ root: W }, reopened).send(transcript(0, ENTRIES));

    expect(
      find(d.tree, 'StageDivider').map((n) => (n.kind === 'StageDivider' ? n.props.from : '')),
    ).toContain('Reopened');
  });
});

describe('Chat on a run that never got a box (#246)', () => {
  const never: SessionData = {
    ...SESSION,
    state: 'ended',
    stopped: true,
    box: 'demo-shop-4',
    neverPlaced: true,
  };

  test('its header names no box: never got a box', () => {
    const p = headerOf({ session: never, run: RUN }).props;

    expect(p.box).toBeUndefined();
    expect(p.env).toBe('never got a box');
  });

  test('⌘⏎: Open workspace grey, never got a box', () => {
    const row = sessionMenu({ session: never, run: RUN }).rows.find((r) => r.id === 'workspace');

    expect(row?.reason).toBe('never got a box');
  });

  test('Stop… on it Queued: it leaves the queue', () => {
    const queued = { ...SESSION, state: 'queued' as const, box: 'demo-shop-4' };
    const row = sessionMenu({ session: queued, run: RUN }).rows.find((r) => r.id === 'stop');

    expect(row?.dim).toBe('takes it out of the queue');
  });
});

describe('a long Chat as the bridge holds it: one entry is cheap, an event of others costs nothing', () => {
  const W2 = '/p/shop-wt/4-cart-total';
  const S4 = { ...session('s4', 'working', 4), worktree: W2 };
  const when = (i: number) => new Date(Date.parse(at(0)) + i * 1000).toISOString();
  const entryAt = (i: number): TranscriptEntry => {
    if (i % 10 === 0)
      return { kind: 'user', id: `u${i}`, at: when(i), agent: null, text: `q ${i}`, context: null };
    if (i % 3 === 0)
      return {
        kind: 'tool-use',
        id: `t${i}`,
        at: when(i),
        agent: null,
        tool: 'Read',
        input: { file_path: `${W2}/f${i}.ts` },
      };
    if (i % 3 === 1)
      return {
        kind: 'tool-result',
        id: `t${i - 1}`,
        at: when(i),
        agent: null,
        ok: true,
        text: 'output line\n'.repeat(40),
        cut: 0,
        patch: null,
      };

    return {
      kind: 'assistant-text',
      id: `a${i}`,
      at: when(i),
      agent: null,
      text: `Some **markdown** for ${i}. `.repeat(8),
    };
  };
  const long = () => {
    const { mounted } = mount(pinnedScreen, { root: W2, session: 's4' }, SIZE);

    mounted.send(factsInput(sessionsAnswer([S4]), runsAnswer([])));
    mounted.send({
      kind: 'result',
      id: 'transcript',
      command: 'session transcript',
      reply: {
        ok: true,
        data: {
          session: 's4',
          from: 0,
          entries: Array.from({ length: 1000 }, (_, i) => entryAt(i)),
        },
      },
    });

    return mounted;
  };
  const entryEvent = (n: number): Input => ({
    kind: 'event',
    event: {
      seq: n,
      at: when(n),
      type: 'session.transcript',
      data: { session: 's4', from: n, entries: [entryAt(n)] },
    },
  });

  test('a 1000-entry Chat: one more entry viewed, patched and its frame written in well under 1 ms, never the tree', () => {
    const mounted = long();
    let held = mounted.tree;
    let line = '';
    const cost = (n: number) => {
      const a = performance.now();

      mounted.send(entryEvent(n));
      // as the bridge sends it: the keyed patch of the tree the app holds
      const ops = patchOf(held, mounted.tree);

      line = JSON.stringify({ v: 2, type: 'patch', screen: 'chat', rev: n, base: n - 1, ops });
      held = mounted.tree;

      return performance.now() - a;
    };

    for (let n = 1000; n < 1020; n += 1) cost(n);
    const costs = Array.from({ length: 51 }, (_, i) => cost(1020 + i)).sort((x, y) => x - y);

    expect(costs[25] ?? Infinity).toBeLessThan(1);
    // one entry's patch, not the tree: a sliver of it
    expect(line.length).toBeLessThan(2_000);
    expect(line.length * 20).toBeLessThan(JSON.stringify(held).length);
  });

  test('an event Chat does not take (a prototype the Board shows moved): its tree as it was', () => {
    const mounted = long();
    const tree = mounted.tree;

    mounted.send({
      kind: 'event',
      event: {
        seq: 5000,
        at: when(5000),
        type: 'prototype.state',
        data: { id: 'p1', card: null, state: 'live', url: null, cause: 'start', reason: null },
      },
    });
    expect(mounted.tree).toBe(tree);
  });
});
