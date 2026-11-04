/**
 * The composer in the `chat` screen (#115 t115b): docked under the transcript, the keys' order
 * (the transcript's `l ö gg G ⏎ u` until the field has the keys, then the field's), the caret's
 * chip and `no-caret`, Esc (the menu's own, else the column's), focus lost, the queue and model
 * events, `/override` opening the Override card.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionData, TranscriptEntry } from '@abe/core';
import { runsAnswer, session, sessionsAnswer, theirsAnswers } from '@abe/testing';
import { type Node } from '../runtime/components';
import { type PinnedState, pinnedScreen } from './pinned';
import { type Command, type Input, step } from '../runtime/runtime';
import { withLive } from '../live';

/** Chat with its live facts, as the bridge feeds them. */
const CHAT = withLive(pinnedScreen);

const SIZE = { width: 420, height: 800 };
const W = '/wt/s4';
const AT = '2026-10-25T03:00:00.000Z';

const ENTRIES: TranscriptEntry[] = [
  { kind: 'user', id: 'u1', at: AT, agent: null, text: 'fix the cart', context: null },
  { kind: 'assistant-text', id: 'a1', at: AT, agent: null, text: 'Fixed.' },
];

const SESSION: SessionData = {
  ...session('s4', 'working', 4),
  worktree: W,
  model: 'opus',
  effort: 'medium',
};

const drive = (s: SessionData = SESSION, params: Record<string, string> = { root: W }) => {
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
    keys(keys: string) {
      return d.send(...keys.split(' ').map((key): Input => ({ kind: 'key', key })));
    },
  };

  return d.send(sessionsAnswer([s]), runsAnswer([]), {
    kind: 'result',
    id: 'transcript',
    command: 'session transcript',
    reply: { ok: true, data: { session: s.id, from: 0, entries: ENTRIES } },
  });
};

const find = (n: Node, kind: string): Node[] => [
  ...(n.kind === kind ? [n] : []),
  ...(('children' in n ? n.children : undefined) ?? []).flatMap((c) => find(c, kind)),
];

const composer = (n: Node) => {
  const [c] = find(n, 'Composer');

  return c?.kind === 'Composer' ? c : undefined;
};

const chip = (n: Node) => {
  const [c] = find(n, 'ContextChip');

  return c?.kind === 'ContextChip' ? c.props.text : undefined;
};

const argvs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

const CARET: Input = { kind: 'caret', file: 'api/src/cart.ts', line: 16 };

describe('the composer in Chat', () => {
  test('docked under the transcript: the placeholder says whom, the session’s model line', () => {
    const d = drive();
    const text = JSON.stringify(d.tree);

    expect(text.indexOf('"Transcript"')).toBeLessThan(text.indexOf('"Composer"'));
    expect(composer(d.tree)?.props).toMatchObject({
      text: '',
      placeholder: 'Message #4 Card 4…',
      model: { label: 'opus · medium' },
    });
    // a long title cut to fit the column
    const long = { ...SESSION, title: 'The cart total ignores the quantity of every line it adds' };

    expect(composer(drive(long).tree)?.props.placeholder).toBe(
      'Message #4 The cart total ignores the…',
    );
  });

  test('the transcript keeps its keys until a printable key gives the field them', () => {
    const d = drive().keys('ö');

    expect(composer(d.tree)?.props.text).toBe('');
    d.send({ kind: 'focus', focused: true }).keys('w h y <Space> l ö');
    expect(composer(d.tree)?.props).toMatchObject({ text: 'why lö', focused: true });
  });

  test('while the field has the keys the screen types: `:` and `?` are text, not layers', () => {
    const d = drive();

    expect(pinnedScreen.typing?.(d.state)).toBe(false);
    d.keys('a');
    expect(pinnedScreen.typing?.(d.state)).toBe(true);
    d.keys('<Esc>');
    expect(pinnedScreen.typing?.(d.state)).toBe(false);
  });

  test('the session ending while the field has the keys: they go; a key typed after is the Reopen field’s (#343)', () => {
    const d = drive().keys('a');

    d.send({
      kind: 'event',
      event: {
        seq: 1,
        at: AT,
        type: 'session.state',
        data: { id: 's4', card: 4, state: 'ended', since: AT, cause: 'stop' },
      },
    });
    expect(pinnedScreen.typing?.(d.state)).toBe(false);
    // the ended session's field is live (⏎ reopens with what is typed): a key gives it the keys
    d.keys('b');
    expect(d.state.composer.active).toBe(true);
    expect(composer(d.tree)?.props.text).toBe('ab');
  });

  test('no session pinned: focus, the caret and events still reach the composer', () => {
    const d = drive().keys('a').send({ kind: 'root', root: '/elsewhere' });

    expect(pinnedScreen.typing?.(d.state)).toBe(false);
    d.send({ kind: 'focus', focused: false }, CARET);
    expect(d.state.composer.active).toBe(false);
    expect(d.state.composer.caret).toEqual({ file: 'api/src/cart.ts', line: 16 });
  });

  test('`g` then a key the transcript does not take: the `g` is spent, a later `g` waits again', () => {
    const d = drive().keys('G');
    const last = d.state.rendered?.folds.cursor;

    d.keys('g x g');
    expect(d.state.rendered?.folds.cursor).toBe(last);
    expect(composer(d.tree)?.props.text).toBe('');
  });

  test('the caret is the chip and goes with ⏎; no-caret takes it away', () => {
    const d = drive().send(CARET).keys('h i');

    expect(chip(d.tree)).toBe('@api/src/cart.ts:16 · caret line');
    d.keys('<CR>');
    expect(argvs(d.commands)).toEqual([
      'session send s4 hi --context {"path":"api/src/cart.ts","line":16}',
    ]);
    d.send({ kind: 'no-caret' });
    expect(chip(d.tree)).toBeUndefined();
  });

  test('Esc: the menu takes it first, a second clears the /, the transcript, then the column', () => {
    const d = drive().send({ kind: 'focus', focused: true }).keys('/');

    expect(find(d.tree, 'SlashMenu')).toHaveLength(1);
    d.keys('<Esc>');
    expect(d.commands).toEqual([]);
    expect(find(d.tree, 'SlashMenu')).toHaveLength(0);
    d.keys('<Esc>');
    expect(d.commands).toEqual([]);
    expect(composer(d.tree)?.props.text).toBe('');
    d.keys('<Esc>');
    expect(d.commands).toEqual([]);
    expect(d.state.composer.active).toBe(false);
    d.keys('<Esc>');
    expect(d.commands).toEqual([
      { kind: 'shell', effect: { kind: 'unhandled', slot: 'chat', key: '<Esc>' } },
    ]);
  });

  test('Chat getting the keys gives them to the field; back from a layer, where they were', () => {
    const d = drive().send({ kind: 'focus', focused: true });

    expect(composer(d.tree)?.props.focused).toBe(true);
    d.keys('<Esc>');
    expect(d.state.composer.active).toBe(false);
    // a menu over it and closed: the transcript keeps them
    d.send({ kind: 'focus', focused: false, layer: true }, { kind: 'focus', focused: true });
    expect(d.state.composer.active).toBe(false);
    // the keys elsewhere and back (⌘2): the field
    d.send({ kind: 'focus', focused: false }, { kind: 'focus', focused: true });
    expect(composer(d.tree)?.props.focused).toBe(true);
  });

  test('the slot losing the keyboard folds the menu; the draft stays', () => {
    const d = drive()
      .send({ kind: 'focus', focused: true })
      .keys('/')
      .send({ kind: 'focus', focused: false });

    expect(find(d.tree, 'SlashMenu')).toHaveLength(0);
    expect(composer(d.tree)?.props.text).toBe('/');
  });

  test('session.queued shows the rows; × takes one back', () => {
    const d = drive().send({
      kind: 'event',
      event: {
        seq: 1,
        at: AT,
        type: 'session.queued',
        data: { session: 's4', queue: [{ n: 1, text: 'also zero' }] },
      },
    });

    expect(find(d.tree, 'QueuedMessage')).toHaveLength(1);
    d.send({ kind: 'click', id: 'composer:unqueue:1' });
    expect(argvs(d.commands)).toEqual(['session unqueue s4 1']);
  });

  test('session.model changes the line', () => {
    const d = drive().send({
      kind: 'event',
      event: {
        seq: 1,
        at: AT,
        type: 'session.model',
        data: { session: 's4', model: 'sonnet', effort: 'high', effortPending: false },
      },
    });

    expect(composer(d.tree)?.props.model?.label).toBe('sonnet · high');
  });

  test('/override <what> opens the Override card', () => {
    const d = drive().send({ kind: 'text', text: '/override db write test' }).keys('<CR>');

    expect(d.state.cards?.cards.override?.what).toBe('db write test');
    expect(composer(d.tree)?.props.text).toBe('');
  });

  test('an ended session has its line; yours on a teammate’s card its field (#306)', () => {
    expect(composer(drive({ ...SESSION, state: 'ended' }).tree)?.props).toMatchObject({
      placeholder: 'Type a message…',
      model: { note: '· ⏎ Reopen · ⌘⏎ more' },
    });
    expect(composer(drive().send(...theirsAnswers(4, 'Ada Example')).tree)).toBeDefined();
  });
});
