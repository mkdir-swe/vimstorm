/**
 * Chat as the window's Chat column draws it on the Factory view's card (2.1 #105 S3): the Chat
 * slot's `chat` screen opened with `{card}` (and `whose` for a teammate's card), as the bridge
 * drives it: the Show link, a teammate's card read-only, the start. The session's own Chat is the
 * rendered one (`rendered.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import type { FactoryRunData, SessionData } from '@abe/core';
import {
  cardShowAnswer,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
} from '@abe/testing';
import { type Node } from '../runtime/components';
import { pinnedScreen, type PinnedState } from './pinned';
import { type Command, type Input, step } from '../runtime/runtime';
import { type ChatHeader } from './terminal';
import { withLive } from '../live';

/** Chat with its live facts, as the bridge feeds them. */
const CHAT = withLive(pinnedScreen);

const SIZE = { width: 420, height: 846 };

const RUNS: FactoryRunData[] = [
  factoryRun(4, 'Cart total includes shipping', 'build', 'running', { since: minutes(2) }),
  factoryRun(5, 'Saved carts survive sign-out', 'verify', 'needs-you', { since: minutes(1) }),
];
const SESSIONS: SessionData[] = [
  { ...session('s4', 'working', 4), box: 'alex-1' },
  session('s5', 'waiting', 5),
];

/** The column on `card` from the Factory view, once the sessions and the runs are read. */
const drive = (
  card: number,
  runs: FactoryRunData[] = RUNS,
  sessions: SessionData[] = SESSIONS,
  more: Record<string, string> = {},
) => {
  let held = step(CHAT, CHAT.init, {
    kind: 'open',
    params: { card: String(card), ...more },
    size: SIZE,
  });
  let commands: Command[] = [];
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
    click(id: string) {
      return d.send({ kind: 'click', id });
    },
  };

  return d.send(sessionsAnswer(sessions), runsAnswer(runs));
};

const walk = (n: Node, out: Node[] = []): Node[] => {
  out.push(n);
  if ('children' in n) for (const c of n.children ?? []) walk(c, out);

  return out;
};

const find = (tree: Node, id: string): Node | undefined => walk(tree).find((n) => n.id === id);

const header = (tree: Node): ChatHeader['props'] => {
  const h = find(tree, 'chat-header');

  if (h?.kind !== 'ChatHeader') throw new Error('no Chat header in the tree');

  return h.props;
};

/** The Empty Chat shows in place of a terminal: its title and line. */
const chatEmpty = (tree: Node): string[] => {
  const e = walk(tree).find((n) => n.kind === 'Empty');

  return e?.kind === 'Empty' ? [e.props.title, e.props.line] : [];
};

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

/** The Launch box on `card`: its ⏎, nothing picked. */
const boxEnter = (card: number): Input => ({
  kind: 'choice',
  menu: `launchbox:${card}`,
  row: 'launch',
  values: ['', '', '', ''],
});

describe('a teammate’s card (#105 Behaviour 6)', () => {
  const coupon = listCard(9, 'Coupon field accepts spaces', 'New', 'Sam Sample');

  test('read-only: their name on line 1, why it is empty, no launch, no menu', () => {
    const d = drive(9, RUNS, SESSIONS, { whose: 'Sam Sample' });

    expect(argvs(d.commands)).toEqual(['card show 9']);
    d.send({ ...cardShowAnswer(coupon, []), id: 'card:9' });
    // the 2.1 header (#291): the card's title as written, whose, the empty rail; no ⌘⏎
    expect(header(d.tree)).toEqual({
      title: 'Chat',
      env: "Sam Sample's session",
      story: { id: '#9', title: 'Coupon field accepts spaces' },
      rail: {
        segments: ['todo', 'todo', 'todo', 'todo', 'todo'],
        stage: 'New',
        state: 'idle',
        glyph: '○',
        word: 'no session',
      },
    });
    expect(chatEmpty(d.tree)).toEqual([
      "Sam Sample's story",
      'Assigned to Sam Sample: Chat launches only your own cards.',
    ]);
    expect(JSON.stringify(d.tree)).not.toContain('Launch agent');
    d.keys('<CR>', '<D-CR>').click('chat:launch');
    expect(d.commands).toEqual([]);
  });

  test('the teammate holds while the card does; an open without it clears it', () => {
    const d = drive(9, RUNS, SESSIONS, { whose: 'Sam Sample' });

    expect(d.state.whose).toBe('Sam Sample');
    d.send({ kind: 'open', params: { card: '9', whose: 'Sam Sample' }, size: SIZE });
    expect(d.state.whose).toBe('Sam Sample');
    d.send({ kind: 'open', params: { card: '9' }, size: SIZE });
    expect(d.state.whose).toBeUndefined();
    d.keys('<CR>');
    expect(d.commands).toMatchObject([{ kind: 'launch', id: 'launchbox:9', card: 9 }]);
    d.send(boxEnter(9));
    expect(argvs(d.commands)).toEqual(['factory run 9']);
  });
});

describe('the start (#105 Behaviour 4)', () => {
  test('⏎ opens the Launch box, its ⏎ launches once: ● Launching… and its line, then the session as it comes', () => {
    const d = drive(7, RUNS, SESSIONS, { root: '/p/shop' });

    d.keys('<CR>');
    expect(d.commands).toMatchObject([{ kind: 'launch', id: 'launchbox:7', card: 7 }]);
    expect(argvs(d.commands)).toEqual([]);
    d.send(boxEnter(7));
    // the Factory view's card: where serve.target says, no --target
    expect(argvs(d.commands)).toEqual(['factory run 7 --repo /p/shop']);
    expect(header(d.tree).rail).toMatchObject({ state: 'starting', word: 'Launching…' });
    expect(chatEmpty(d.tree)).toEqual(['Launching…', 'Chat attaches once its Claude Code runs.']);
    expect(JSON.stringify(d.tree)).not.toContain('Launch agent');
    // a second ⏎ while it starts launches nothing, nor the box's ⏎
    d.keys('<CR>');
    expect(d.commands).toEqual([]);
    d.send(boxEnter(7));
    expect(argvs(d.commands)).toEqual([]);
    const run = factoryRun(7, 'Friendly greeting with no name', 'spec');

    d.send({
      kind: 'result',
      id: 'launch:1',
      command: 'factory run',
      reply: { ok: true, data: run },
    });
    // its session not listed yet: still launching
    expect(header(d.tree).rail).toMatchObject({ state: 'starting', word: 'Launching…' });
    expect(chatEmpty(d.tree)[0]).toBe('Launching…');
    d.send(sessionsAnswer([...SESSIONS, session('s7', 'working', 7)]));
    // its rendered Chat, its transcript read
    expect(d.state.rendered?.session).toBe('s7');
    expect(chatEmpty(d.tree)[0]).not.toBe('Launching…');
  });
});
