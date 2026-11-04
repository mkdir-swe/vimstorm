/**
 * Chat's composer (#115 t115b): the field's keys (⏎ send, ⇧⏎ a line, ⌘V, typed text), a draft
 * per session, the implicit context chip and ⌫'s drop, the queued rows and ×, the `/` menu
 * (filter, ↑ ↓ ⌃P ⌃N, ⏎, Esc twice, the routing) and the model pick. Commands are what `serve` runs;
 * answers and events come back in the CLI contract's shapes.
 */
import { describe, expect, test } from 'bun:test';
import { session as aSession } from '@abe/testing';
import type { Event, SessionData, SessionSkill } from '@abe/core';
import { Node } from '../runtime/components';
import {
  COMPOSER_PLACEHOLDER,
  composerActive,
  composerCaret,
  composerClick,
  composerDock,
  composerEvent,
  composerFocus,
  type ComposerFacts,
  composerKey,
  composerMenuOpen,
  composerNode,
  composerResult,
  composerSession,
  type ComposerState,
  composerAttach,
  composerDraft,
  composerInput,
  composerText,
  DROPPED_TEXT,
  MENU_ROWS,
  NO_COMPOSER,
  queuedNodes,
} from './composer';
import { type Command, type Input } from '../runtime/runtime';

const SESSION = 'demo-shop-2-1';
const FACTS: ComposerFacts = { session: SESSION, focused: true };
const AT = '2026-10-25T03:00:00.000Z';

const CARET = { file: 'api/src/cart.ts', line: 16 };
const SELECTION = { file: 'api/src/cart.ts', line: 18, selection: { from: 12, to: 18 } };

const session = (over: Partial<SessionData> = {}): SessionData => ({
  ...aSession(SESSION, 'working', 2),
  model: 'opus',
  effort: 'medium',
  ...over,
});

const start = composerSession(composerCaret(NO_COMPOSER, CARET), session());

/** Keys as the app sends them, space-separated (`<Space>` for a space). */
const keys = (
  c: ComposerState,
  ks: string,
  f: ComposerFacts = FACTS,
): { composer: ComposerState; commands: Command[] } => {
  let commands: Command[] = [];
  let at = c;

  for (const k of ks.split(' ')) {
    const o = composerKey(at, k, f);

    at = o.composer;
    commands = [...commands, ...o.commands.map(numberless)];
  }

  return { composer: at, commands };
};

/** Each send's run id is its own (`composer:send:<n>`); the tests name them `composer:send:n`. */
const numberless = (cmd: Command): Command =>
  cmd.kind === 'run'
    ? { ...cmd, id: cmd.id.replace(/^composer:send:\d+$/, 'composer:send:n') }
    : cmd;

const typeWords = (c: ComposerState, words: string, f: ComposerFacts = FACTS) =>
  keys(
    c,
    Array.from(words)
      .map((ch) => (ch === ' ' ? '<Space>' : ch))
      .join(' '),
    f,
  );

const field = (c: ComposerState, f: ComposerFacts = FACTS) => composerNode(c, f);

const chip = (c: ComposerState, f: ComposerFacts = FACTS) =>
  field(c, f)?.children?.find((n) => n.kind === 'ContextChip');

const menu = (c: ComposerState, f: ComposerFacts = FACTS) => {
  const m = field(c, f)?.children?.find((n) => n.kind === 'SlashMenu');

  return m?.kind === 'SlashMenu'
    ? { cmds: m.props.items.map((r) => r.cmd), selected: m.props.selected, items: m.props.items }
    : undefined;
};

const sent = (text: string, context?: unknown): Command => ({
  kind: 'run',
  id: 'composer:send:n',
  argv: [
    'session',
    'send',
    SESSION,
    text,
    ...(context === undefined ? [] : ['--context', JSON.stringify(context)]),
  ],
});

const queuedEvent = (queue: { n: number; text: string }[]): Event => ({
  seq: 1,
  at: AT,
  type: 'session.queued',
  data: { session: SESSION, queue },
});
const modelEvent = (
  model: string,
  effort: 'low' | 'medium' | 'high',
  effortPending: boolean,
): Event => ({
  seq: 2,
  at: AT,
  type: 'session.model',
  data: { session: SESSION, model, effort, effortPending },
});

describe('the field', () => {
  test('empty: the placeholder, the caret line chip with ⌫ drop, the model line (R-Anatomy)', () => {
    const n = field(start);

    expect(n).toEqual({
      kind: 'Composer',
      id: 'composer:composer',
      props: {
        text: '',
        placeholder: COMPOSER_PLACEHOLDER,
        model: { label: 'opus · medium', id: 'composer:model' },
      },
      children: [
        {
          kind: 'ContextChip',
          id: 'composer:chip',
          props: { text: '@api/src/cart.ts:16 · caret line', drop: '⌫ drop' },
        },
      ],
    });
    expect(Node.safeParse(n).success).toBe(true);
  });

  test('a printable key in the transcript gives the field the keys and types', () => {
    expect(composerActive(start)).toBe(false);
    expect(composerKey(start, '<CR>', FACTS).handled).toBe(false);
    const o = composerKey(start, 'K', FACTS);

    expect(o.handled).toBe(true);
    expect(composerActive(o.composer)).toBe(true);
    expect(field(o.composer)?.props).toMatchObject({ text: 'K', focused: true });
  });

  test('a click on the composer gives the field the keys', () => {
    expect(composerClick(start, 'composer:composer', FACTS)?.composer.active).toBe(true);
  });

  test('focused only while the Chat slot has the keyboard too', () => {
    const typing = keys(start, 'a').composer;

    expect(field(typing, { ...FACTS, focused: false })?.props.focused).toBeUndefined();
  });

  test('⏎ sends the text with the caret line as its context; the field empties', () => {
    const { composer, commands } = keys(typeWords(start, 'why not here').composer, '<CR>');

    expect(commands).toEqual([sent('why not here', { path: 'api/src/cart.ts', line: 16 })]);
    expect(field(composer)?.props.text).toBe('');
  });

  test('a selection goes as its lines, path and span (C-Context)', () => {
    const c = composerCaret(start, SELECTION);

    expect(chip(c)?.props).toEqual({ text: '@api/src/cart.ts#L12-18 · selected', drop: '⌫ drop' });
    expect(keys(typeWords(c, 'why').composer, '<CR>').commands).toEqual([
      sent('why', { path: 'api/src/cart.ts', from: 12, to: 18 }),
    ]);
  });

  test('a one-line selection says its line; a selection made upwards still runs from its top', () => {
    expect(
      chip(composerCaret(start, { ...SELECTION, selection: { from: 7, to: 7 } }))?.props.text,
    ).toBe('@api/src/cart.ts#L7 · selected');
    expect(
      chip(composerCaret(start, { ...SELECTION, selection: { from: 18, to: 12 } }))?.props.text,
    ).toBe('@api/src/cart.ts#L12-18 · selected');
  });

  test('no file open: no chip, and the message goes alone', () => {
    const c = composerCaret(start, null);

    expect(chip(c)).toBeUndefined();
    expect(keys(typeWords(c, 'hi').composer, '<CR>').commands).toEqual([sent('hi')]);
  });

  test('on the Factory view the selected card is the context', () => {
    const f = { ...FACTS, card: { id: 2, title: 'The cart total ignores quantity' } };

    expect(chip(start, f)?.props.text).toBe('#2 The cart total ignores quantity · selected card');
    expect(keys(typeWords(start, 'go', f).composer, '<CR>', f).commands).toEqual([
      sent('go', { card: 2, title: 'The cart total ignores quantity' }),
    ]);
  });

  test('⇧⏎ adds a line; ⌫ takes the last character; an empty or blank field sends nothing', () => {
    const c = keys(start, 'a <S-CR> b c <BS>').composer;

    expect(field(c)?.props.text).toBe('a\nb');
    expect(keys(c, '<CR>').commands).toEqual([sent('a\nb', { path: 'api/src/cart.ts', line: 16 })]);
    expect(keys(start, 'a <BS> <CR>').commands).toEqual([]);
    expect(keys(start, '<Space> <Space> <CR>').commands).toEqual([]);
  });

  test('the caret moves and edits as a macOS field: ← ⌥← ⌘← on its line, ⌫ ⌥⌫ and text at it (#314)', () => {
    const c = typeWords(start, 'fix cart').composer;
    const moved = keys(c, '<M-Left> <Left>').composer;

    expect(field(moved)?.props).toMatchObject({ text: 'fix cart', caret: 3 });
    const edited = composerText(typeWords(moved, ' the').composer, ' old', FACTS).composer;

    expect(field(edited)?.props).toMatchObject({ text: 'fix the old cart', caret: 11 });
    const lines = keys(edited, '<D-Right> <S-CR> n e w <D-Left> <BS>').composer;

    expect(field(lines)?.props).toMatchObject({ text: 'fix the old cartnew', caret: 16 });
    const word = keys(lines, '<M-BS>').composer;

    expect(field(word)?.props).toMatchObject({ text: 'fix the old new', caret: 12 });
    expect(keys(word, '<CR>').commands).toEqual([
      sent('fix the old new', { path: 'api/src/cart.ts', line: 16 }),
    ]);
  });

  test('⌘V and composed text land in the field, lines kept', () => {
    const o = composerText(start, 'line one\r\nline two', FACTS);

    expect(o.handled).toBe(true);
    expect(field(o.composer)?.props.text).toBe('line one\nline two');
    expect(field(composerText(o.composer, 'é', FACTS).composer)?.props.text).toBe(
      'line one\nline twoé',
    );
  });

  test('a draft is kept per session: another session has its own, back again it is there', () => {
    const typed = typeWords(start, 'half a thought').composer;
    const other = { ...FACTS, session: 'demo-shop-3-1' };

    expect(field(typed, other)?.props.text).toBe('');
    const there = typeWords(typed, 'x', other).composer;

    expect(field(there, other)?.props.text).toBe('x');
    expect(field(there)?.props.text).toBe('half a thought');
  });

  test('Esc gives the keys to the transcript and keeps the draft', () => {
    const o = composerKey(typeWords(start, 'draft').composer, '<Esc>', FACTS);

    expect(o.handled).toBe(true);
    expect(composerActive(o.composer)).toBe(false);
    expect(field(o.composer)?.props).toMatchObject({ text: 'draft' });
  });

  test('two sends before serve answers: each answer is its own send', () => {
    const one = composerKey(typeWords(start, 'x').composer, '<CR>', FACTS);
    const two = composerKey(typeWords(one.composer, 'y').composer, '<CR>', FACTS);
    const ids = [...one.commands, ...two.commands].map((cmd) => (cmd.kind === 'run' ? cmd.id : ''));

    expect(ids).toEqual(['composer:send:1', 'composer:send:2']);
    const queuedX = composerResult(two.composer, {
      kind: 'result',
      id: 'composer:send:1',
      command: 'session send',
      reply: { ok: true, data: { id: SESSION, sent: 'x', queued: 1 } },
    }).composer;
    const refusedY = composerResult(queuedX, {
      kind: 'result',
      id: 'composer:send:2',
      command: 'session send',
      reply: { ok: false, error: { code: 'session-ended', message: 'ended' } },
    }).composer;

    expect(queuedNodes(refusedY, FACTS).map((n) => n.props.text)).toEqual(['x']);
    expect(field(refusedY)?.props.text).toBe('y');
  });

  test('refused by serve: the text comes back to the field and the balloon says why', () => {
    const { composer } = keys(typeWords(start, 'hello').composer, '<CR>');
    const back = composerResult(composer, {
      kind: 'result',
      id: 'composer:send:1',
      command: 'session send',
      reply: { ok: false, error: { code: 'session-ended', message: 'the session ended' } },
    });

    expect(field(back.composer)?.props.text).toBe('hello');
    expect(back.commands).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'balloon', tone: 'error', text: 'the session ended (session-ended)' },
      },
    ]);
  });
});

describe("the app's own field (a native text area): drafts by number, files as chips", () => {
  const draft = (c: ComposerState, text: string, seq: number) =>
    composerDraft(c, text, seq, FACTS).composer;
  const chips = (c: ComposerState) =>
    (field(c)?.children ?? []).flatMap((n) =>
      n.kind === 'AttachChip' ? [[n.id, n.props.name, n.props.image === true]] : [],
    );
  const SHOT = '/tmp/vimstorm-paste/Screenshot 1.png';

  test.each<
    [
      string,
      (c: ComposerState) => ComposerState,
      string,
      number | undefined,
      (string | boolean | undefined)[][],
    ]
  >([
    [
      'a draft is the text, its number echoed as seq',
      (c) => draft(c, 'why\nnot', 3),
      'why\nnot',
      3,
      [],
    ],
    [
      'an older draft than one taken changes nothing',
      (c) => draft(draft(c, 'abc', 5), 'ab', 4),
      'abc',
      5,
      [],
    ],
    [
      'a pasted image and a dropped file: chips in order, each once',
      (c) =>
        composerAttach(composerAttach(c, [SHOT, '/w/a.ts'], FACTS).composer, [SHOT], FACTS)
          .composer,
      '',
      undefined,
      [
        ['composer:detach:0', 'Screenshot 1.png', true],
        ['composer:detach:1', 'a.ts', false],
      ],
    ],
    [
      '× on a chip drops it',
      (c) =>
        (
          composerClick(
            composerAttach(c, [SHOT, '/w/a.ts'], FACTS).composer,
            'composer:detach:0',
            FACTS,
          ) ?? { composer: c }
        ).composer,
      '',
      undefined,
      [['composer:detach:0', 'a.ts', false]],
    ],
  ])('%s', (_, act, text, seq, files) => {
    const c = act(start);

    expect(field(c)?.props.text).toBe(text);
    expect(field(c)?.props.seq).toBe(seq);
    expect(chips(c)).toEqual(files);
  });

  test('⏎ sends the text with its files as @paths after it (a spaced path quoted); files alone go too', () => {
    const typed = composerAttach(draft(start, 'look', 1), [SHOT, '/w/a.ts'], FACTS).composer;
    const { composer, commands } = keys(typed, '<CR>');

    expect(commands).toEqual([
      sent(`look\n\n@"${SHOT}" @/w/a.ts`, { path: 'api/src/cart.ts', line: 16 }),
    ]);
    expect(chips(composer)).toEqual([]);
    expect(keys(composerAttach(start, ['/w/a.png'], FACTS).composer, '<CR>').commands).toEqual([
      sent('@/w/a.png', { path: 'api/src/cart.ts', line: 16 }),
    ]);
  });

  test("a teammate's session takes no draft and no file", () => {
    const theirs = { ...FACTS, whose: 'Ada' };

    expect(composerDraft(start, 'x', 1, theirs).handled).toBe(false);
    expect(composerAttach(start, [SHOT], theirs).handled).toBe(false);
  });
});

describe('the context chip', () => {
  test('⌫ in an empty field drops it for this message; ⌫ again brings it back', () => {
    const dropped = keys(start, 'a <BS> <BS>').composer;

    expect(chip(dropped)?.props).toEqual({ text: DROPPED_TEXT, dropped: true });
    expect(chip(keys(dropped, '<BS>').composer)?.props.text).toBe(
      '@api/src/cart.ts:16 · caret line',
    );
  });

  test('a dropped chip sends the message alone; after the send it is back', () => {
    const { composer, commands } = keys(
      typeWords(keys(start, 'a <BS> <BS>').composer, 'hi').composer,
      '<CR>',
    );

    expect(commands).toEqual([sent('hi')]);
    expect(chip(composer)?.props.text).toBe('@api/src/cart.ts:16 · caret line');
  });

  test('no chip: ⌫ in the empty field drops nothing, so a caret coming later still goes', () => {
    const c = keys(composerCaret(start, null), 'a <BS> <BS>').composer;

    expect(chip(composerCaret(c, CARET))?.props.text).toBe('@api/src/cart.ts:16 · caret line');
  });

  test('a click on the chip drops it too', () => {
    const o = composerClick(start, 'composer:chip', FACTS);

    expect(o === undefined ? undefined : chip(o.composer)?.props.dropped).toBe(true);
  });

  test('shell input (`!`) takes none: no chip, the command goes alone', () => {
    const c = typeWords(start, '!git status').composer;

    expect(chip(c)).toBeUndefined();
    expect(keys(c, '<CR>').commands).toEqual([sent('!git status')]);
  });

  test('follows the caret live', () => {
    expect(chip(composerCaret(start, { file: 'web/src/app.ts', line: 3 }))?.props.text).toBe(
      '@web/src/app.ts:3 · caret line',
    );
  });
});

describe('queued messages', () => {
  const queued = (c: ComposerState) => queuedNodes(c, FACTS).map((n) => n.props);

  test('⏎ while the session works: serve answers queued, a dim row with × shows', () => {
    const { composer } = keys(typeWords(start, 'also zero').composer, '<CR>');
    const answered = composerResult(composer, {
      kind: 'result',
      id: 'composer:send:1',
      command: 'session send',
      reply: { ok: true, data: { id: SESSION, sent: 'also zero', queued: 1 } },
    });

    expect(queued(answered.composer)).toEqual([
      { text: 'also zero', remove: 'composer:unqueue:1' },
    ]);
  });

  test('session.queued is the queue; × takes one back with session unqueue', () => {
    const c = composerEvent(
      start,
      queuedEvent([
        { n: 1, text: 'also handle a zero quantity' },
        { n: 2, text: 'then open the PR' },
      ]),
    );

    expect(queued(c).map((q) => q.text)).toEqual([
      'also handle a zero quantity',
      'then open the PR',
    ]);
    expect(composerClick(c, 'composer:unqueue:2', FACTS)?.commands).toEqual([
      {
        kind: 'run',
        id: `composer:unqueue:${SESSION}`,
        argv: ['session', 'unqueue', SESSION, '2'],
      },
    ]);
    const sentAll = composerEvent(c, queuedEvent([]));

    expect(queued(sentAll)).toEqual([]);
  });

  test('the session read brings its queue; the dock holds the rows above the field', () => {
    const c = composerSession(start, session({ queue: [{ n: 4, text: 'later' }] }));
    const dock = composerDock(c, FACTS);

    expect(dock).toMatchObject({
      kind: 'Stack',
      props: { direction: 'column', pad: [4, 12, 12, 12] },
      children: [
        { kind: 'Stack', children: [{ kind: 'QueuedMessage', props: { text: 'later' } }] },
        { kind: 'Composer' },
      ],
    });
    expect(Node.safeParse(dock).success).toBe(true);
  });
});

describe('the / menu', () => {
  test('/ as the first character opens it over the field: the four rows, the first selected', () => {
    const c = keys(start, '/').composer;

    expect(menu(c)).toMatchObject({
      cmds: ['/override', '/compact', '/clear', '/model'],
      selected: 0,
    });
    expect(menu(c)?.items.map((r) => r.desc)).toEqual([
      'lower a limit for this session',
      'shorten the conversation, keep the gist',
      'start a fresh conversation',
      'opus · medium',
    ]);
    expect(composerMenuOpen(c, FACTS)).toBe(true);
  });

  test('the menu folds while the field does not have the keys, and opens again with them', () => {
    const c = keys(start, '/').composer;
    const away = composerFocus(c, false);

    expect(menu(away)).toBeUndefined();
    expect(field(away)?.props.text).toBe('/');
    expect(menu(composerFocus(away, true))?.cmds).toHaveLength(4);
  });

  test('typing filters at once: co leaves /compact; ⏎ runs it, without context', () => {
    const c = keys(start, '/ c o').composer;

    expect(menu(c)?.cmds).toEqual(['/compact']);
    const ran = keys(c, '<CR>');

    expect(ran.commands).toEqual([sent('/compact')]);
    expect(field(ran.composer)?.props.text).toBe('');
  });

  test('↑ ↓ and ⌃P ⌃N move, every letter types; ⏎ runs the selected row', () => {
    const c = keys(start, '/ <Down> <C-n>').composer;

    expect(menu(c)?.selected).toBe(2);
    expect(field(c)?.props.text).toBe('/');
    expect(menu(keys(c, '<Up>').composer)?.selected).toBe(1);
    expect(menu(keys(c, '<C-p>').composer)?.selected).toBe(1);
    expect(menu(keys(c, '<Down>').composer)?.selected).toBe(3);
    expect(field(keys(c, 'ö').composer)?.props.text).toBe('/ö');
  });

  test('Esc closes it and leaves / in the field; a second Esc clears it', () => {
    const shut = keys(start, '/ <Esc>').composer;

    expect(menu(shut)).toBeUndefined();
    expect(field(shut)?.props.text).toBe('/');
    const second = composerKey(shut, '<Esc>', FACTS);

    expect(second.handled).toBe(true);
    expect(field(second.composer)?.props.text).toBe('');
    expect(menu(keys(second.composer, '/').composer)?.cmds).toHaveLength(4);
  });

  test('after Esc, emptying the field and typing / opens the menu again', () => {
    expect(menu(keys(start, '/ <Esc> <BS> /').composer)?.cmds).toHaveLength(4);
  });

  test('letters type: /cl leaves /clear', () => {
    const c = keys(start, '/ c l').composer;

    expect(field(c)?.props.text).toBe('/cl');
    expect(menu(c)?.cmds).toEqual(['/clear']);
    expect(menu(keys(start, '/ m o d e l').composer)?.cmds).toEqual(['/model']);
  });

  test('a /word after Esc: the menu shut, it goes as typed', () => {
    expect(
      keys(typeWords(keys(start, '/ <Esc>').composer, 'login').composer, '<CR>').commands,
    ).toEqual([sent('/login')]);
  });

  test('/clear asks y first (/c, then ↓ to it)', () => {
    expect(keys(start, '/ c <Down> <CR>').commands).toEqual([
      {
        kind: 'confirm',
        argv: ['session', 'send', SESSION, '/clear'],
        question: 'Start a fresh conversation?',
        details: ["Claude Code's /clear drops this conversation's context; the worktree stays."],
        yes: 'Clear',
        done: 'Started a fresh conversation',
      },
    ]);
  });

  test('a /word not in the menu goes to Claude Code as typed', () => {
    const c = keys(start, '/ f o o').composer;

    expect(menu(c)).toBeUndefined();
    expect(keys(c, '<CR>').commands).toEqual([sent('/foo')]);
    expect(keys(typeWords(start, '/review the diff').composer, '<CR>').commands).toEqual([
      sent('/review the diff'),
    ]);
  });

  test('/override takes its area as words; ⏎ asks the screen for the Override card', () => {
    const row = keys(start, '/ <CR>').composer;

    expect(field(row)?.props.text).toBe('/override ');
    expect(menu(row)).toBeUndefined();
    const o = keys(typeWords(row, 'db write test').composer, '<CR>');
    const last = composerKey(typeWords(row, 'db write test').composer, '<CR>', FACTS);

    expect(o.commands).toEqual([]);
    expect(last.override).toBe('db write test');
    expect(field(last.composer)?.props.text).toBe('');
  });

  test('a click on a row runs it', () => {
    const c = keys(start, '/').composer;

    expect(composerClick(c, 'composer:menu:1', FACTS)?.commands.map(numberless)).toEqual([
      sent('/compact'),
    ]);
  });
});

describe('the model line and pick', () => {
  const allowed = (c: ComposerState, value: string[] = ['opus', 'sonnet', 'haiku']) =>
    composerResult(c, {
      kind: 'result',
      id: 'composer:models',
      command: 'settings get',
      reply: {
        ok: true,
        data: {
          key: 'allowedModels',
          value,
          layer: 'core',
          lowered: null,
          problems: [],
        },
      },
    }).composer;

  test('/model opens the pick: allowedModels read once, models × effort, the current one selected', () => {
    const opened = keys(start, '/ m <CR>');

    expect(opened.commands).toEqual([
      { kind: 'run', id: 'composer:models', argv: ['settings', 'get', 'allowedModels'] },
    ]);
    expect(menu(opened.composer)?.cmds).toEqual(['model']);
    const read = allowed(opened.composer);

    expect(menu(read)?.items.map((r) => `${r.cmd} ${r.desc}`)).toEqual([
      'opus low',
      'opus medium · now',
      'opus high',
      'sonnet low',
      'sonnet medium',
      'sonnet high',
      'haiku low',
      'haiku medium',
      'haiku high',
    ]);
    expect(menu(read)?.selected).toBe(1);
  });

  test('picking sends /model through session model; the line updates at once and on its event', () => {
    const read = allowed(keys(start, '/ m <CR>').composer);
    const picked = keys(read, '<Down> <CR>');

    expect(picked.commands).toEqual([
      {
        kind: 'run',
        id: `composer:model:${SESSION}`,
        argv: ['session', 'model', SESSION, '--model', 'opus', '--effort', 'high'],
      },
    ]);
    expect(field(picked.composer)?.props.model?.label).toBe('opus · high');
    expect(menu(picked.composer)).toBeUndefined();
    const moved = composerEvent(picked.composer, modelEvent('sonnet', 'low', false));

    expect(field(moved)?.props.model?.label).toBe('sonnet · low');
  });

  test("a prototype chat's full id says its family: haiku · low, the pick's haiku low now (#350)", () => {
    const c = composerEvent(start, modelEvent('claude-haiku-5-5', 'low', false));

    expect(field(c)?.props.model?.label).toBe('haiku · low');
    const read = allowed(keys(c, '/ m <CR>').composer);

    expect(menu(read)?.items.find((r) => r.desc.endsWith('now'))?.cmd).toBe('haiku');
    expect(menu(read)?.selected).toBe(6);
  });

  test('an effort waiting for a resume shows as such, dim', () => {
    const c = composerEvent(start, modelEvent('opus', 'high', true));

    expect(field(c)?.props.model).toEqual({
      label: 'opus',
      note: '· high · next resume',
      id: 'composer:model',
    });
  });

  test('a click on the line opens the pick; every letter filters it, Esc closes', () => {
    const o = composerClick(allowed(start), 'composer:model', FACTS);

    expect(o?.commands).toEqual([]);
    const filtered = keys(o?.composer ?? start, 's o n').composer;

    expect(menu(filtered)?.cmds).toEqual(['sonnet', 'sonnet', 'sonnet']);
    expect(menu(keys(o?.composer ?? start, 'h a i k u').composer)?.cmds).toEqual([
      'haiku',
      'haiku',
      'haiku',
    ]);
    expect(menu(keys(filtered, '<Esc>').composer)).toBeUndefined();
  });

  test('a click on a row of the pick picks that row, not the one selected (#219)', () => {
    const o = composerClick(allowed(start), 'composer:model', FACTS);
    const clicked = composerClick(o?.composer ?? start, 'composer:pick:4', FACTS);

    expect(clicked?.commands).toEqual([
      {
        kind: 'run',
        id: `composer:model:${SESSION}`,
        argv: ['session', 'model', SESSION, '--model', 'sonnet', '--effort', 'medium'],
      },
    ]);
    expect(menu(clicked?.composer ?? start)).toBeUndefined();
  });

  test('/model <name> switches straight away', () => {
    const pasted = composerText(start, '/model sonnet', FACTS).composer;

    expect(keys(pasted, '<CR>').commands).toEqual([
      {
        kind: 'run',
        id: `composer:model:${SESSION}`,
        argv: ['session', 'model', SESSION, '--model', 'sonnet', '--effort', 'medium'],
      },
    ]);
  });

  test('refused (not allowed): the balloon, and the line read again from serve', () => {
    const picked = keys(allowed(keys(start, '/ m <CR>').composer), 'ö <CR>').composer;
    const back = composerResult(picked, {
      kind: 'result',
      id: `composer:model:${SESSION}`,
      command: 'session model',
      reply: { ok: false, error: { code: 'model-not-allowed', message: 'gpt is not allowed' } },
    });

    expect(back.commands).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'balloon', tone: 'error', text: 'gpt is not allowed (model-not-allowed)' },
      },
      { kind: 'run', id: `composer:show:${SESSION}`, argv: ['session', 'show', SESSION] },
    ]);
  });
});

describe('sessions without a field', () => {
  test("a teammate's session: no composer, no keys, queued rows without ×", () => {
    const f = { ...FACTS, whose: 'Ada Example' };
    const c = composerSession(start, session({ queue: [{ n: 1, text: 'theirs' }] }));

    expect(composerNode(c, f)).toBeNull();
    expect(composerKey(c, 'a', f).handled).toBe(false);
    expect(queuedNodes(c, f).map((n) => n.props)).toEqual([{ text: 'theirs' }]);
  });

  test('an ended session: its word in its place, and only a way on that works (#258)', () => {
    const f = { ...FACTS, ended: true };
    const line = (more: Partial<ComposerFacts>) => composerNode(start, { ...f, ...more })?.props;

    // ⏎ does nothing on it: nothing offered
    expect(composerNode(start, f)?.props).toEqual({ text: '', line: 'Session ended' });
    expect(line({ stopped: true })).toEqual({ text: '', line: 'Session stopped' });
    // its box stopped under it (#316): why, in its place
    expect(line({ why: 'its box demo-6 stopped' })).toEqual({
      text: '',
      line: 'Session ended: its box demo-6 stopped',
    });
    expect(composerKey(start, 'a', f).handled).toBe(false);
    expect(composerClick(start, 'composer:composer', f)).toBeUndefined();
  });

  test('an ended session ⏎ reopens (#343): the field stays live, the foot says when and what ⏎ does', () => {
    const at = new Date(2026, 9, 25, 14, 2).toISOString();
    const f: ComposerFacts = { ...FACTS, ended: true, step: 'reopen', endedAt: at };

    expect(composerNode(start, f)?.props).toEqual({
      text: '',
      placeholder: 'Type a message…',
      model: { label: 'Session ended 14:02', note: '· ⏎ Reopen · ⌘⏎ more' },
    });
    expect(composerNode(start, { ...f, stopped: true })?.props.model?.label).toBe(
      'Session stopped 14:02',
    );
    // ⏎ with nothing typed is the screen's (Reopen with no prompt)
    const idle = composerKey(start, '<CR>', f);

    expect(idle.handled).toBe(false);
    expect(idle.commands).toEqual([]);
    // what you type is its first prompt
    let c = composerKey(start, 'w', f).composer;

    for (const k of ['h', 'y', '?']) c = composerKey(c, k, f).composer;
    expect(composerNode(c, f)?.props.text).toBe('why?');
    const sent = composerKey(c, '<CR>', f);

    expect(sent.handled).toBe(true);
    expect(sent.commands).toEqual([
      {
        kind: 'run',
        id: 'composer:send:1',
        argv: ['session', 'reopen', SESSION, '--message', 'why?'],
      },
    ]);
    expect(composerNode(sent.composer, f)?.props.text).toBe('');
    // refused: the text back in the field, the refusal said
    const back = composerResult(sent.composer, {
      kind: 'result',
      id: 'composer:send:1',
      command: 'session reopen',
      reply: {
        ok: false,
        error: { code: 'worktree-gone', message: 'its worktree and branch card/4-x are gone' },
      },
    });

    expect(composerNode(back.composer, f)?.props.text).toBe('why?');
    expect(back.commands).toHaveLength(1);
    // a click gives the field the keys
    expect(composerClick(start, 'composer:composer', f)?.composer.active).toBe(true);
  });
});

describe('the / menu’s skills', () => {
  const SKILLS: SessionSkill[] = [
    { name: '/abe:code-review', whose: 'abe', description: 'Reviews the diff.' },
    { name: '/abe:triage', whose: 'abe', description: 'Sorts the inbox.' },
    { name: '/seed-db', whose: 'repo', description: 'Seeds the demo DB.' },
    { name: '/standup', whose: 'yours', description: 'My standup notes.' },
  ];
  const opened = composerInput(composerFocus(start, true), { kind: 'key', key: '/' }, FACTS, true);
  const read = (c: ComposerState, skills: SessionSkill[] = SKILLS) =>
    composerResult(c, {
      kind: 'result',
      id: `composer:skills:${SESSION}`,
      command: 'session skills',
      reply: { ok: true, data: { id: SESSION, skills } },
    }).composer;

  test('the first / asks serve once; its skills follow the commands, whose each is', () => {
    expect(opened?.commands).toEqual([
      { kind: 'run', id: `composer:skills:${SESSION}`, argv: ['session', 'skills', SESSION] },
    ]);
    const c = read(opened?.composer ?? start);

    expect(
      menu(c)
        ?.items.slice(4)
        .map((r) => `${r.cmd} ${r.desc}`),
    ).toEqual([
      '/abe:code-review Abe’s · Reviews the diff.',
      '/abe:triage Abe’s · Sorts the inbox.',
      '/seed-db Repo’s · Seeds the demo DB.',
      '/standup Yours · My standup notes.',
    ]);
    expect(composerInput(c, { kind: 'key', key: 't' }, FACTS, true)?.commands).toEqual([]);
  });

  test('the menu opened again asks again: a skill the repo got meanwhile is in it, the last list shown till then', () => {
    const c = read(opened?.composer ?? start);
    const closed = keys(c, '<BS>').composer;
    const again = composerInput(closed, { kind: 'key', key: '/' }, FACTS, true);

    expect(again?.commands).toEqual([
      { kind: 'run', id: `composer:skills:${SESSION}`, argv: ['session', 'skills', SESSION] },
    ]);
    expect(menu(again?.composer ?? start)?.cmds).toContain('/seed-db');
    const added = { name: '/new-skill', whose: 'repo' as const, description: 'Added later.' };
    const now = read(again?.composer ?? start, [...SKILLS, added]);

    expect(menu(now)?.cmds).toContain('/new-skill');
  });

  test.each([
    ['/abe:', ['/abe:code-review', '/abe:triage']],
    ['/tri', ['/abe:triage']],
    ['/c', ['/compact', '/clear', '/abe:code-review']],
    ['/db', ['/seed-db']],
    ['/zz', []],
  ])('%s finds %p', (typed, rows) => {
    const c = typeWords(read(opened?.composer ?? start), typed.slice(1)).composer;

    expect(menu(c)?.cmds ?? []).toEqual(rows);
  });

  test('⏎ or Tab completes a skill into the field, sent as text on the next ⏎', () => {
    const c = typeWords(read(opened?.composer ?? start), 'tri').composer;
    const done = keys(c, '<Tab>').composer;

    expect(field(done)?.props.text).toBe('/abe:triage ');
    expect(menu(done)).toBeUndefined();
    expect(keys(done, 'x <CR>').commands).toEqual([sent('/abe:triage x')]);
  });

  /** Typed in the app's field: the text and its caret (absent: its end). */
  const typedIn = (text: string, caret?: number) =>
    composerDraft(read(start), text, 1, FACTS, caret).composer;
  const ALL = ['/abe:code-review', '/abe:triage', '/seed-db', '/standup'];

  test.each<[string, string, number | undefined, string[] | undefined, [string, number?] | null]>([
    ['at the start, as before', '/tri', undefined, ['/abe:triage'], ['/abe:triage ']],
    [
      'at the start with a space after: closed, as before',
      '/abe:triage x',
      undefined,
      undefined,
      null,
    ],
    [
      'after a space: the skills alone, filtered to the caret',
      'please run /abe:',
      undefined,
      ['/abe:code-review', '/abe:triage'],
      ['please run /abe:code-review '],
    ],
    [
      'a bare / after a space: every skill, no command',
      'run /',
      undefined,
      ALL,
      ['run /abe:code-review '],
    ],
    ['/c mid-message: no /compact, no /clear', 'run /c', undefined, ['/abe:code-review'], null],
    ['after a line', 'notes\n/stand', undefined, ['/standup'], ['notes\n/standup ']],
    [
      'the caret mid-text: the word up to it, the text after kept',
      'run /abe:tr and go',
      11,
      ['/abe:triage'],
      ['run /abe:triage and go', 16],
    ],
    [
      'the caret inside the word: the pick takes its whole word',
      'run /abe:trXage now',
      11,
      ['/abe:triage'],
      ['run /abe:triage now', 16],
    ],
    [
      'after an at-start skill, another',
      '/abe:triage then /se',
      undefined,
      ['/seed-db'],
      ['/abe:triage then /seed-db '],
    ],
    ['a path: nothing', 'see src/app', undefined, undefined, null],
    ['and/or: nothing', 'this and/or that', 9, undefined, null],
    ['a URL: nothing', 'go https://x.dev/abe', undefined, undefined, null],
    ['a path after a space finds no skill: nothing', 'cd /usr/bin', undefined, undefined, null],
    ['the caret before the /: nothing', 'run /abe:tr', 4, undefined, null],
    ['a space after the word: nothing', 'run /abe:tr ', undefined, undefined, null],
  ])('%s: %p', (_, text, caret, rows, picked) => {
    const c = typedIn(text, caret);

    expect(menu(c)?.cmds).toEqual(rows);
    if (picked === null) return;
    const done = keys(c, '<Tab>').composer;

    expect([field(done)?.props.text, field(done)?.props.caret]).toEqual([picked[0], picked[1]]);
    expect(menu(done)).toBeUndefined();
  });

  test('mid-message: Esc closes it and keeps the text; the caret out of the word and back opens it', () => {
    const c = typedIn('run /abe:tr');
    const shut = keys(c, '<Esc>').composer;

    expect(menu(shut)).toBeUndefined();
    expect(field(shut)?.props.text).toBe('run /abe:tr');
    expect(shut.active).toBe(true);
    // typing on in that word: still shut
    expect(menu(keys(shut, 'i').composer)).toBeUndefined();
    const out = composerDraft(shut, 'run /abe:tr', 2, FACTS, 2).composer;

    expect(menu(out)).toBeUndefined();
    expect(menu(composerDraft(out, 'run /abe:tr', 3, FACTS, 11).composer)?.cmds).toEqual([
      '/abe:triage',
    ]);
  });

  test('mid-message: a pick then ⏎ sends the text as typed, with its context', () => {
    const done = keys(typedIn('please run /abe:tr'), '<CR>').composer;

    expect(keys(done, 'x <CR>').commands).toEqual([
      sent('please run /abe:triage x', { path: 'api/src/cart.ts', line: 16 }),
    ]);
  });

  test("mid-message: the app's field opening it asks serve for the skills", () => {
    const draft: Input = { kind: 'draft', text: 'run /', seq: 1 };

    expect(composerInput(start, draft, FACTS, true)?.commands).toEqual([
      { kind: 'run', id: `composer:skills:${SESSION}`, argv: ['session', 'skills', SESSION] },
    ]);
  });

  test('at most MENU_ROWS shown, the selected one among them', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `/abe:s${String(i).padStart(2, '0')}`,
      whose: 'abe' as const,
      description: '',
    }));
    const c = read(opened?.composer ?? start, many);
    const down = keys(c, Array.from({ length: 12 }, () => '<Down>').join(' ')).composer;

    expect(menu(c)?.items).toHaveLength(MENU_ROWS);
    expect(menu(down)?.cmds.at(-1)).toBe('/abe:s08');
    expect(menu(down)?.selected).toBe(MENU_ROWS - 1);
  });
});
