/**
 * What `serve` does with what you send from Chat (#115): queued messages while a session works and sent as one
 * prompt when its turn ends, the implicit context built into the prompt, and `/model` / `/effort`.
 * `startSessions` with a fake runner (what it types in, which sessions run) and real `meta.json`
 * files in a temporary state directory; hooks come as Claude Code's payloads. Then once through
 * the CLI seam: the real `abe` and its `serve`, a fake `claude` in a real `tmux`, a fake board.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  askCards,
  type ClaudeSettings,
  type EventData,
  SessionData,
  SessionModelData,
  SessionSendData,
  SessionTranscriptData,
  SessionUnqueueData,
  type TranscriptEntry,
  permissionCard,
  SETTINGS,
  type SessionRunner,
} from '@abe/core';
import {
  claudeOutput,
  cli,
  type Cli,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  scriptClaude,
  tmuxPath,
  until,
  installDone,
} from '@abe/testing';
import { type Sessions, startSessions } from './sessions';

type Fake = {
  root: string;
  worktree: string;
  typed: { id: string; text: string }[];
  /** The next `send`s fail with this. */
  failing: { code: string; message: string } | null;
  /** While set, a `send` waits for it before it types (tmux being slow). */
  gate: Promise<void> | null;
  /** `send`s begun, typed or not yet. */
  sends: number;
  queued: EventData<'session.queued'>[];
  models: EventData<'session.model'>[];
  /** Cards answered outside Chat (`emitAnswered`). */
  answered: EventData<'session.answered'>[];
  running: Set<string>;
  /** The Claude Code settings each launch was given. */
  settings: ClaudeSettings[];
  /** The keys pressed in the session's terminal (`runner.keys`). */
  keys: string[];
  /**
   * Claude Code's `/model` picker (#180): whether `/model` opens it (`opens`), whether it is open,
   * its focused row (the model in use when it opens) and effort level, what Claude Code said.
   */
  picker: { opens: boolean; open: boolean; focus: number; effort: number; said: string[] };
  /** Claude Code's own permission dialog on the screen while set; its Esc closes it. */
  dialog: string | null;
  /** The clock's time now. */
  now: number;
};

/** Claude Code's permission dialog, as its terminal shows it. */
const DIALOG = [
  ' Bash command',
  '   ls; echo hi',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel',
].join('\n');

/** Claude Code 2.1.310's effort levels, as its picker's ←/→ step through them. */
const LEVELS = ['Low', 'Medium', 'High', 'xHigh', 'Max'];

/** The picker's rows: Default, then the launch's `modelPicker` rows (`sessionModelPicker`). */
const pickerRows = (f: Fake) => [
  'Default (recommended)',
  ...(f.settings.at(-1)?.modelPicker?.options.map((o) => o.label) ?? []),
];

/** What the terminal shows: what Claude Code said so far, the picker under it while open. */
const pickerScreen = (f: Fake) => {
  const p = f.picker;

  if (!p.open) return p.said.join('\n');
  const rows = pickerRows(f).map(
    (label, i) =>
      `  ${i === p.focus ? '❯' : ' '} ${i + 1}. ${label}${' '.repeat(24 - label.length)}Custom model`,
  );

  return [
    ...p.said,
    '❯ /model',
    '────',
    '  Select model',
    '  Switch between Claude models. Your pick becomes the default for new sessions.',
    '',
    ...rows,
    '',
    `  ◐ ${LEVELS[p.effort] ?? ''} effort ←/→ to adjust`,
    '',
    '  Enter to set as default · s to use this session only · Esc to cancel',
  ].join('\n');
};

/** One key in the picker, as Claude Code takes it: Down wraps, ←/→ stop at the ends, `s` picks. */
const press = (f: Fake, key: string) => {
  const p = f.picker;

  f.keys.push(key);
  if (key === 'Escape' && f.dialog !== null) {
    f.dialog = null;

    return;
  }
  if (!p.open) return;
  const rows = pickerRows(f);

  if (key === 'Down') p.focus = (p.focus + 1) % rows.length;
  else if (key === 'Left') p.effort = Math.max(0, p.effort - 1);
  else if (key === 'Right') p.effort = Math.min(LEVELS.length - 1, p.effort + 1);
  else if (key === 's' || key === 'Escape') {
    p.open = false;
    p.said.push(
      '❯ /model',
      key === 's'
        ? `  ⎿  Set model to ${rows[p.focus] ?? ''} for this session only with ${(LEVELS[p.effort] ?? '').toLowerCase()} effort`
        : '  ⎿  Kept model as opus',
    );
  }
};

const CARD = {
  id: 2,
  title: 'The cart total ignores quantity',
  description: '',
  acceptanceCriteria: '',
};
const AT = {
  allowedModels: ['opus', 'sonnet'],
  skillsOnTop: false,
  sessionMcp: 'yours',
  setup: null,
  effort: 'medium',
} as const;

const fake = (): Fake => {
  const root = mkdtempSync(join(tmpdir(), 'abe-queue-'));
  const worktree = join(root, 'wt');

  mkdirSync(join(worktree, 'api', 'src'), { recursive: true });
  writeFileSync(
    join(worktree, 'api', 'src', 'cart.ts'),
    Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'),
  );

  return {
    root,
    worktree,
    typed: [],
    failing: null,
    gate: null,
    sends: 0,
    queued: [],
    models: [],
    answered: [],
    running: new Set(),
    settings: [],
    keys: [],
    // on opus (row 2 of Default, opus, sonnet) at medium effort, as launched
    picker: { opens: true, open: false, focus: 1, effort: 1, said: [] },
    dialog: null,
    now: Date.parse('2026-10-25T03:00:00.000Z'),
  };
};

const runner = (f: Fake): SessionRunner => ({
  abe: 'abe',
  bin: join(f.root, 'bin'),
  socket: (id) => ({
    listen: join(f.root, 'state', 'sessions', id, 'session.sock'),
    session: join(f.root, 'state', 'sessions', id, 'session.sock'),
    mode: 0o600,
  }),
  launch: (spec) => {
    f.running.add(spec.id);
    f.settings.push(spec.settings);

    return Promise.resolve({
      ok: true,
      data: { worktree: f.worktree, setup: null, trusted: false },
    });
  },
  baseWorktree: () => Promise.resolve({ ok: false, error: { code: 'no', message: 'no' } }),
  send: async (id, text) => {
    f.sends += 1;
    await f.gate;
    if (f.failing !== null) return { ok: false, error: f.failing };
    f.typed.push({ id, text });
    if (text === '/model') f.picker.open = f.picker.opens;

    return { ok: true, data: null };
  },
  keys: (_, keys) => {
    for (const key of keys) press(f, key);

    return Promise.resolve({ ok: true, data: null });
  },
  screen: () => Promise.resolve({ ok: true, data: f.dialog ?? pickerScreen(f) }),
  attach: () => [],
  stop: () => Promise.resolve({ ok: true, data: null }),
  running: () => Promise.resolve({ ok: true, data: [...f.running] }),
});

const start = (f: Fake) =>
  startSessions({
    stateDir: join(f.root, 'state'),
    runner: runner(f),
    clock: { now: () => f.now },
    env: { HOME: f.root, PATH: '/usr/bin' },
    serveSocket: join(f.root, 'serve.sock'),
    emit: () => undefined,
    emitSubagent: () => undefined,
    emitQueued: (d) => f.queued.push(d),
    emitModel: (d) => f.models.push(d),
    emitAnswered: (d) => f.answered.push(d),
    log: () => undefined,
    listen: () => Promise.resolve({ close: () => Promise.resolve() }),
    pick: { everyMs: 5, forMs: 200 },
  });

const hook = (s: Sessions, id: string, event: string, payload: Record<string, unknown> = {}) => {
  const heard = s.hook(id, event, {
    hook_event_name: event,
    transcript_path: `/t/${id}.jsonl`,
    ...payload,
  });

  if (!heard.ok) throw new Error(heard.error.message);

  return heard.data.state;
};

/** Delivery runs once the hook is answered: the next turn of the event loop has it. */
const settled = () => new Promise((r) => setTimeout(r, 0));

const shown = async (s: Sessions, id: string) => {
  const got = await s.get(id);

  if (!got.ok) throw new Error(got.error.message);

  return got.data;
};

describe('startSessions with a fake runner', () => {
  let f: Fake;
  let s: Sessions;
  let id: string;

  beforeEach(async () => {
    f = fake();
    s = await start(f);
    const launched = await s.launch(CARD, join(f.root, 'repo'), {}, AT);

    if (!launched.ok) throw new Error(launched.error.message);
    id = launched.data.id;
    // Its claude runs its launch's prompt: Claude Code takes keys.
    hook(s, id, 'SessionStart', { source: 'startup' });
    hook(s, id, 'UserPromptSubmit', { prompt: 'Work on card AB#2', prompt_id: 'p1' });
  });

  afterEach(async () => {
    await s.close();
    rmSync(f.root, { recursive: true, force: true });
  });

  describe("mid-turn, a message goes into Claude Code's own queue at once (#197)", () => {
    test('typed in now, nothing held: Claude Code takes it at the next step', async () => {
      expect(await s.message(id, 'Also handle a zero quantity', null)).toEqual({
        ok: true,
        data: { prompt: 'Also handle a zero quantity', queued: null, held: null },
      });
      expect(await s.message(id, 'Why?', { path: 'api/src/cart.ts', line: 16 })).toMatchObject({
        ok: true,
        data: { queued: null },
      });
      expect(f.typed).toEqual([
        { id, text: 'Also handle a zero quantity' },
        { id, text: 'Why?\n\nContext: api/src/cart.ts, caret on line 16' },
      ]);
      expect(f.queued).toEqual([]);
      expect((await shown(s, id)).queue).toEqual([]);
    });

    test('while a subagent keeps it working too: the Factory run hears it now', async () => {
      hook(s, id, 'SubagentStart', { agent_id: 'w1', agent_type: 'abe:writer' });

      expect(hook(s, id, 'Stop')).toBe('working');
      expect(await s.message(id, 'decide with --spec', null)).toMatchObject({
        data: { queued: null },
      });
      expect(f.typed).toEqual([{ id, text: 'decide with --spec' }]);
    });

    test('a slash command goes at once', async () => {
      expect(await s.message(id, '/compact', null)).toEqual({
        ok: true,
        data: { prompt: '/compact', queued: null, held: null },
      });
      expect(f.typed).toEqual([{ id, text: '/compact' }]);
    });

    test('one paste at a time: a second message waits for the first to be typed in', async () => {
      let open: () => void = () => undefined;

      f.gate = new Promise((r) => {
        open = r;
      });
      const one = s.message(id, 'one', null);
      const two = s.message(id, 'two', null);

      await settled();
      expect(f.sends).toBe(1);
      open();
      expect([await one, await two]).toMatchObject([
        { data: { queued: null } },
        { data: { queued: null } },
      ]);
      expect(f.typed).toEqual([
        { id, text: 'one' },
        { id, text: 'two' },
      ]);
    });

    test('not typed in (tmux failing): refused, nothing held', async () => {
      f.failing = { code: 'tmux-failed', message: 'no server' };

      expect(await s.message(id, 'one', null)).toMatchObject({
        ok: false,
        error: { code: 'tmux-failed' },
      });
      expect((await shown(s, id)).queue).toEqual([]);
    });
  });

  describe('held while its claude has not started: typed in once it runs (#197)', () => {
    let fresh: string;

    beforeEach(async () => {
      const launched = await s.launch({ ...CARD, id: 3 }, join(f.root, 'repo3'), {}, AT);

      if (!launched.ok) throw new Error(launched.error.message);
      fresh = launched.data.id;
    });

    test("held with its number and why; typed in once it takes its launch's prompt, as one prompt", async () => {
      expect(await s.message(fresh, 'one', null)).toEqual({
        ok: true,
        data: { prompt: 'one', queued: 1, held: 'starting' },
      });
      await s.message(fresh, 'two', { path: 'api/src/cart.ts', line: 16 });
      expect(f.typed).toEqual([]);
      expect(f.queued.at(-1)).toEqual({
        session: fresh,
        queue: [
          { n: 1, text: 'one' },
          { n: 2, text: 'two' },
        ],
      });
      // Started, its prompt not taken yet: Claude Code would keep these for after the whole turn.
      hook(s, fresh, 'SessionStart', { source: 'startup' });
      await settled();
      expect(f.typed).toEqual([]);
      hook(s, fresh, 'UserPromptSubmit', { prompt: 'Work on card AB#3', prompt_id: 'p3' });
      await settled();
      expect(f.typed).toEqual([
        { id: fresh, text: 'one\n\ntwo\n\nContext: api/src/cart.ts, caret on line 16' },
      ]);
      expect(f.queued.at(-1)).toEqual({ session: fresh, queue: [] });
      expect((await shown(s, fresh)).queue).toEqual([]);
    });

    test('unqueue takes one back before it goes; its number is never given again', async () => {
      await s.message(fresh, 'one', null);
      await s.message(fresh, 'two', null);

      expect(s.unqueue(fresh, 2)).toEqual({ ok: true, data: [{ n: 1, text: 'one' }] });
      expect(f.queued.at(-1)).toEqual({ session: fresh, queue: [{ n: 1, text: 'one' }] });
      expect(await s.message(fresh, 'three', null)).toMatchObject({ data: { queued: 3 } });
      expect(s.unqueue(fresh, 2)).toMatchObject({ ok: false, error: { code: 'not-queued' } });
      s.unqueue(fresh, 1);
      hook(s, fresh, 'UserPromptSubmit', { prompt: 'Work on card AB#3', prompt_id: 'p3' });
      await settled();
      expect(f.typed).toEqual([{ id: fresh, text: 'three' }]);
    });

    test('one launched with no prompt takes keys once it has started', async () => {
      const launched = await s.launch({ ...CARD, id: 5 }, join(f.root, 'repo5'), {}, AT, {
        prompt: '',
      });

      if (!launched.ok) throw new Error(launched.error.message);
      const chat = launched.data.id;

      expect(await s.message(chat, 'hello', null)).toMatchObject({
        data: { queued: 1, held: 'starting' },
      });
      hook(s, chat, 'SessionStart', { source: 'startup' });
      await settled();
      expect(f.typed).toEqual([{ id: chat, text: 'hello' }]);
    });

    test('its model is not switched before it runs', async () => {
      expect(await s.model(fresh, { model: 'sonnet', allowed: ['opus', 'sonnet'] })).toMatchObject({
        ok: false,
        error: { code: 'session-starting' },
      });
      expect(f.typed).toEqual([]);
    });
  });

  describe('held while a dialog asks in its terminal: keys would answer it (#197)', () => {
    test('a permission prompt: held, and said so; typed in once it is answered', async () => {
      expect(hook(s, id, 'PermissionRequest', { tool_name: 'Edit' })).toBe('waiting');

      expect(await s.message(id, 'later', null)).toEqual({
        ok: true,
        data: { prompt: 'later', queued: 1, held: 'dialog' },
      });
      hook(s, id, 'Notification', { notification_type: 'permission_prompt' });
      await settled();
      expect(f.typed).toEqual([]);
      expect((await shown(s, id)).queue).toEqual([{ n: 1, text: 'later' }]);
      // the person allowed it: the tool runs
      expect(hook(s, id, 'PostToolUse', { tool_name: 'Edit' })).toBe('working');
      await settled();
      expect(f.typed).toEqual([{ id, text: 'later' }]);
      expect((await shown(s, id)).queue).toEqual([]);
    });

    test("Claude Code's idle notice while a dialog is open: still a dialog, nothing typed", async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });
      await s.message(id, 'later', null);
      hook(s, id, 'Notification', { notification_type: 'idle_prompt' });
      await settled();
      expect(f.typed).toEqual([]);
    });

    test('a dialog opening while the paste waits for the one before it: held, not typed into it', async () => {
      let open: () => void = () => undefined;

      f.gate = new Promise((r) => {
        open = r;
      });
      const one = s.message(id, 'one', null);
      const two = s.message(id, 'two', null);

      await settled();
      hook(s, id, 'PermissionRequest', { tool_name: 'Bash' });
      open();
      expect([await one, await two]).toMatchObject([
        { data: { queued: null } },
        { data: { queued: 1, held: 'dialog' } },
      ]);
      expect(f.typed).toEqual([{ id, text: 'one' }]);
      hook(s, id, 'PostToolUse', { tool_name: 'Bash' });
      await settled();
      expect(f.typed).toEqual([
        { id, text: 'one' },
        { id, text: 'two' },
      ]);
    });

    test("a dialog's hook waits for a paste on its way in: its Enter goes in before the dialog shows", async () => {
      let open: () => void = () => undefined;

      f.gate = new Promise((r) => {
        open = r;
      });
      const one = s.message(id, 'one', null);
      let waited = false;
      const wait = s.typed(id, 2000).then(() => {
        waited = true;
      });

      await settled();
      expect(waited).toBe(false);
      open();
      await wait;
      expect(waited).toBe(true);
      expect(f.typed).toEqual([{ id, text: 'one' }]);
      expect(await one).toMatchObject({ data: { queued: null } });
    });

    test('a slash command is not typed into a dialog, nor before its claude runs', async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });

      expect(await s.message(id, '/compact', null)).toMatchObject({
        ok: false,
        error: { code: 'session-asking' },
      });
      const launched = await s.launch({ ...CARD, id: 3 }, join(f.root, 'repo3'), {}, AT);

      if (!launched.ok) throw new Error(launched.error.message);
      expect(await s.message(launched.data.id, '/compact', null)).toMatchObject({
        ok: false,
        error: { code: 'session-starting' },
      });
      expect(f.typed).toEqual([]);
    });

    test("a card's answer while a dialog waits: refused, saying why", async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });

      const answered = await s.answer(id, 'Answer: 1');

      expect(answered.ok ? '' : `${answered.error.code}: ${answered.error.message}`).toContain(
        'held: session',
      );
      expect(answered.ok ? '' : answered.error.message).toContain('a permission prompt waits');
      expect(f.typed).toEqual([]);
    });

    test('a message sent while the held ones are typed in goes after them', async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });
      await s.message(id, 'one', null);
      let open: () => void = () => undefined;

      f.gate = new Promise((r) => {
        open = r;
      });
      hook(s, id, 'PostToolUse', { tool_name: 'Edit' });
      await settled();
      const two = s.message(id, 'two', null);

      open();
      await two;
      await settled();
      expect(f.typed).toEqual([
        { id, text: 'one' },
        { id, text: 'two' },
      ]);
      expect((await shown(s, id)).queue).toEqual([]);
    });

    test("a run's checks typed in wait for the paste before them: one paste at a time", async () => {
      let open: () => void = () => undefined;

      hook(s, id, 'Stop');
      f.gate = new Promise((r) => {
        open = r;
      });
      const one = s.message(id, 'one', null);
      const checks = s.send(id, 'Checks failed: npm test');

      await settled();
      expect(f.sends).toBe(1);
      open();
      expect(await one).toMatchObject({ ok: true });
      expect(await checks).toEqual({ ok: true, data: null });
      expect(f.typed).toEqual([
        { id, text: 'one' },
        { id, text: 'Checks failed: npm test' },
      ]);
    });

    test('held ones not sent yet go first: a message after them joins them, in order', async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });
      await s.message(id, 'one', null);
      f.failing = { code: 'tmux-failed', message: 'no server' };
      hook(s, id, 'PostToolUse', { tool_name: 'Edit' });
      await settled();
      f.failing = null;

      expect(await s.message(id, 'two', null)).toMatchObject({
        data: { queued: 2, held: null },
      });
      expect(f.typed).toEqual([{ id, text: 'one\n\ntwo' }]);
    });

    test('not typed in (tmux failing): they come back, and go at the next hook', async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });
      await s.message(id, 'one', null);
      f.failing = { code: 'tmux-failed', message: 'no server' };
      hook(s, id, 'PostToolUse', { tool_name: 'Edit' });
      await settled();
      expect((await shown(s, id)).queue).toEqual([{ n: 1, text: 'one' }]);
      f.failing = null;
      hook(s, id, 'PreToolUse', { tool_name: 'Bash' });
      await settled();
      expect(f.typed).toEqual([{ id, text: 'one' }]);
    });
  });

  describe('a dialog answered by its Esc: no hook comes, its hold goes once it is gone', () => {
    const asked = () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Bash' });
      f.dialog = DIALOG;
    };

    test('Deny: the session waits on your turn, the queue goes', async () => {
      asked();
      expect(await s.message(id, 'later', null)).toMatchObject({ data: { held: 'dialog' } });
      await s.press(id, () => ['Escape']);

      expect(await s.escaped(id, null)).toEqual({ ok: true, data: null });
      expect(await shown(s, id)).toMatchObject({ state: 'waiting', waitingOn: 'turn', queue: [] });
      expect(f.typed).toEqual([{ id, text: 'later' }]);
    });

    test('own words: typed in right after the Esc, the queue after them', async () => {
      asked();
      await s.message(id, 'later', null);
      await s.press(id, () => ['Escape']);

      expect(await s.escaped(id, 'use ls -1 instead')).toEqual({ ok: true, data: null });
      expect(f.typed).toEqual([{ id, text: 'use ls -1 instead\n\nlater' }]);
    });

    test('the dialog still up: refused, the hold kept', async () => {
      asked();

      expect(await s.escaped(id, 'no')).toMatchObject({ ok: false, error: { code: 'dialog-up' } });
      expect(await shown(s, id)).toMatchObject({ waitingOn: 'dialog' });
      expect(f.typed).toEqual([]);
    });

    test('a hold with no dialog on the screen any more: let go when you send', async () => {
      asked();
      await s.message(id, 'one', null);
      // Esc pressed in the terminal: the dialog goes, no hook comes
      f.dialog = null;
      // one just asked may not be drawn yet: still held
      expect(await s.message(id, 'two', null)).toMatchObject({ data: { held: 'dialog' } });
      f.now += 5000;

      expect(await s.message(id, 'three', null)).toMatchObject({ data: { held: null } });
      expect(f.typed).toEqual([{ id, text: 'one\n\ntwo\n\nthree' }]);
      expect(await shown(s, id)).toMatchObject({ waitingOn: 'turn' });
    });

    test('a dialog still on the screen keeps its hold', async () => {
      asked();
      f.now += 5000;

      expect(await s.message(id, 'later', null)).toMatchObject({ data: { held: 'dialog' } });
      expect(f.typed).toEqual([]);
    });

    test('Esc on it read from the transcript: it waits on your turn, the queue goes', async () => {
      asked();
      await s.message(id, 'later', null);
      s.interrupted(id, new Date(f.now + 1000).toISOString());
      await settled();

      expect(await shown(s, id)).toMatchObject({ waitingOn: 'turn' });
      expect(f.typed).toEqual([{ id, text: 'later' }]);
    });

    test("its Esc in Terminal mode: the dialog's card goes, answered outside Chat", async () => {
      asked();
      const card = {
        ...permissionCard(
          { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
          {
            session: id,
            id: 'p-9',
            at: '2026-10-25T03:00:00.000Z',
            why: 'w',
            where: 'local',
            worktree: f.worktree,
          },
        ),
        dialog: true,
      };
      const question =
        askCards(
          {
            questions: [
              { question: 'Which?', header: 'h', options: [{ label: 'A', description: '' }] },
            ],
          },
          { session: id, base: 'q-9', at: '2026-10-25T03:00:00.000Z' },
        ) ?? [];

      s.amend(id, (m) => ({ ...m, asks: [card, ...question] }));
      s.interrupted(id, new Date(f.now + 1000).toISOString());
      await settled();

      expect(f.answered).toMatchObject([{ id, cards: ['p-9'], answer: null }]);
      expect(s.metaOf(id)?.asks.map((c) => c.id)).toEqual(question.map((c) => c.id));
    });
  });

  describe('waiting on you is not working', () => {
    test('Needs you: a message goes at once (that is answering)', async () => {
      hook(s, id, 'Stop');

      expect(await s.message(id, 'yes, go on', null)).toMatchObject({ data: { queued: null } });
      expect(f.typed).toEqual([{ id, text: 'yes, go on' }]);
    });

    test('ended: refused', async () => {
      hook(s, id, 'SessionEnd', { reason: 'prompt_input_exit' });

      expect(await s.message(id, 'hello', null)).toMatchObject({
        ok: false,
        error: { code: 'session-ended' },
      });
    });
  });

  describe('the prompt carries the implicit context', () => {
    test("a selection without its lines: read from the session's worktree", async () => {
      hook(s, id, 'Stop');

      expect(
        await s.message(id, 'Tidy', { path: 'api/src/cart.ts', from: 12, to: 14 }),
      ).toMatchObject({ ok: true, data: { queued: null } });
      expect(f.typed).toEqual([
        {
          id,
          text: [
            'Tidy',
            '',
            'Context: api/src/cart.ts lines 12–14',
            '```ts',
            'line 12',
            'line 13',
            'line 14',
            '```',
          ].join('\n'),
        },
      ]);
    });

    test('a selection past the end of the file: cut at its last line, and said so', async () => {
      hook(s, id, 'Stop');
      await s.message(id, 'End', { path: 'api/src/cart.ts', from: 19, to: 25 });

      expect(f.typed.map((t) => t.text.split('\n'))).toEqual([
        ['End', '', 'Context: api/src/cart.ts lines 19–20', '```ts', 'line 19', 'line 20', '```'],
      ]);
    });

    test('lines given that are not as many as the selection: refused', async () => {
      expect(
        await s.message(id, 'Hm', { path: 'a.ts', from: 1, to: 3, lines: ['x'] }),
      ).toMatchObject({ ok: false, error: { code: 'bad-context' } });
    });

    test.each([
      ['a slash command: its words are its arguments', '/compact'],
      ['shell input: a context after it would run as a command', '!git status'],
    ])('%s, so it takes no context', async (_, text) => {
      hook(s, id, 'Stop');

      expect(await s.message(id, text, { path: 'api/src/cart.ts', line: 16 })).toMatchObject({
        ok: true,
        data: { prompt: text, queued: null },
      });
      expect(f.typed).toEqual([{ id, text }]);
    });

    test('a file not in the worktree: refused, nothing typed or queued', async () => {
      expect(
        await s.message(id, 'Why?', { path: 'api/src/gone.ts', from: 1, to: 2 }),
      ).toMatchObject({
        ok: false,
        error: { code: 'bad-context' },
      });
      expect([f.typed, f.queued]).toEqual([[], []]);
    });
  });

  describe('an open question card holds the queue for its answer (#114)', () => {
    // Messages held while its claude starts; the card opens before they could go.
    beforeEach(async () => {
      const launched = await s.launch({ ...CARD, id: 3 }, join(f.root, 'repo3'), {}, AT);

      if (!launched.ok) throw new Error(launched.error.message);
      id = launched.data.id;
    });

    const ASKED = {
      questions: [
        {
          question: 'Which market table should the cart total read?',
          header: 'Market table',
          options: [
            { label: 'The existing market table (Recommended)', description: '' },
            { label: 'A new setting per market', description: '' },
          ],
        },
      ],
    };
    const ask = () => {
      const cards = askCards(ASKED, { session: id, base: 'q-1', at: '2026-10-25T03:00:00.000Z' });

      if (cards === null) throw new Error('no cards');
      s.amend(id, (m) => ({ ...m, asks: cards }));
    };

    test("the deny's Stop sends nothing; the answer goes first, the queue after it, as one prompt", async () => {
      await s.message(id, 'also handle a zero quantity', null);
      ask();
      hook(s, id, 'Stop');
      await settled();
      expect(f.typed).toEqual([]);
      expect((await shown(s, id)).queue).toEqual([{ n: 1, text: 'also handle a zero quantity' }]);
      // `session answer` takes the cards out, then types the answer
      s.amend(id, (m) => ({ ...m, asks: [] }));

      expect(await s.answer(id, 'Answer to "Which?": 1 The existing market table')).toEqual({
        ok: true,
        data: {
          prompt: 'Answer to "Which?": 1 The existing market table\n\nalso handle a zero quantity',
        },
      });
      expect(f.typed).toEqual([
        {
          id,
          text: 'Answer to "Which?": 1 The existing market table\n\nalso handle a zero quantity',
        },
      ]);
      expect(f.queued.at(-1)).toEqual({ session: id, queue: [] });
      // the next turn end has nothing left to send
      hook(s, id, 'UserPromptSubmit', { prompt: 'Answer' });
      hook(s, id, 'Stop');
      await settled();
      expect(f.typed).toHaveLength(1);
    });

    test('asked while it still works: a message is held for the answer, and said so', async () => {
      hook(s, id, 'UserPromptSubmit', { prompt: 'Work on card AB#3', prompt_id: 'p3' });
      ask();

      expect(await s.message(id, 'also the badge', null)).toMatchObject({
        data: { queued: 1, held: 'question' },
      });
      hook(s, id, 'Stop');
      await settled();
      expect(f.typed).toEqual([]);
      s.amend(id, (m) => ({ ...m, asks: [] }));
      await s.answer(id, 'Answer: 1');
      expect(f.typed).toEqual([{ id, text: 'Answer: 1\n\nalso the badge' }]);
    });

    test("another card's answer while it works and a card is still open: typed in now, never lost (#326)", async () => {
      const other = askCards(ASKED, { session: id, base: 'q-2', at: '2026-10-25T03:00:00.000Z' });

      if (other === null) throw new Error('no cards');
      ask();
      s.amend(id, (m) => ({ ...m, asks: [...m.asks, ...other] }));
      hook(s, id, 'Stop');
      // an earlier answer typed in: its turn runs while the other card still waits
      hook(s, id, 'UserPromptSubmit', { prompt: 'Answer', prompt_id: 'p4' });
      s.amend(id, (m) => ({ ...m, asks: other }));
      await s.message(id, 'later', null);

      expect(await s.answer(id, 'Not this.')).toEqual({
        ok: true,
        data: { prompt: 'Not this.\n\nlater' },
      });
      expect(f.typed).toEqual([{ id, text: 'Not this.\n\nlater' }]);
      // a message of yours is still held for the open card's answer
      expect(await s.message(id, 'also the badge', null)).toMatchObject({
        data: { queued: 2, held: 'question' },
      });
    });

    test('Claude Code idle notice while the card is open: still held', async () => {
      await s.message(id, 'later', null);
      ask();
      hook(s, id, 'Stop');
      hook(s, id, 'Notification', { notification_type: 'idle_prompt' });
      await settled();
      expect(f.typed).toEqual([]);
    });

    test('an answer with no queue is typed alone', async () => {
      ask();
      hook(s, id, 'Stop');
      s.amend(id, (m) => ({ ...m, asks: [] }));

      expect(await s.answer(id, 'Answer: 2')).toEqual({ ok: true, data: { prompt: 'Answer: 2' } });
      expect(f.typed).toEqual([{ id, text: 'Answer: 2' }]);
    });

    test('the answer not typed in (tmux failing): refused, the queue kept for the next try', async () => {
      await s.message(id, 'later', null);
      ask();
      hook(s, id, 'Stop');
      f.failing = { code: 'tmux-failed', message: 'no server' };

      expect(await s.answer(id, 'Answer: 1')).toMatchObject({
        ok: false,
        error: { code: 'tmux-failed' },
      });
      expect((await shown(s, id)).queue).toEqual([{ n: 1, text: 'later' }]);
      f.failing = null;
      expect(await s.answer(id, 'Answer: 1')).toMatchObject({ ok: true });
      expect(f.typed).toEqual([{ id, text: 'Answer: 1\n\nlater' }]);
    });

    test('a message you type while the card is open goes at once, the queue before it', async () => {
      await s.message(id, 'one', null);
      ask();
      hook(s, id, 'Stop');
      await settled();

      expect(await s.message(id, 'use the market table', null)).toMatchObject({ ok: true });
      expect(f.typed).toEqual([{ id, text: 'one\n\nuse the market table' }]);
    });

    test('a permission card is a dialog, not a question: it holds nothing back', async () => {
      await s.message(id, 'later', null);
      const card = permissionCard(
        { tool_name: 'Bash', tool_input: { command: 'npm ci' } },
        {
          session: id,
          id: 'p-1',
          at: '2026-10-25T03:00:00.000Z',
          why: 'w',
          where: 'local',
          worktree: f.worktree,
        },
      );

      s.amend(id, (m) => ({ ...m, asks: [card] }));
      hook(s, id, 'Stop');
      await settled();
      expect(f.typed).toEqual([{ id, text: 'later' }]);
    });

    test('ended: refused', async () => {
      hook(s, id, 'SessionEnd', { reason: 'prompt_input_exit' });

      expect(await s.answer(id, 'Answer: 1')).toMatchObject({
        ok: false,
        error: { code: 'session-ended' },
      });
    });
  });

  test('a restarted serve keeps what it held, and types it in once the dialog is answered', async () => {
    hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });
    await s.message(id, 'kept', null);
    await s.close();
    s = await start(f);
    await settled();

    expect((await shown(s, id)).queue).toEqual([{ n: 1, text: 'kept' }]);
    expect(f.typed).toEqual([]);
    hook(s, id, 'PostToolUse', { tool_name: 'Edit' });
    await settled();
    expect(f.typed).toEqual([{ id, text: 'kept' }]);
  });

  test("a Factory run's session says so, a restarted serve too; a plain one does not (#332)", async () => {
    const launched = await s.launch({ ...CARD, id: 3 }, join(f.root, 'repo3'), {}, AT, {
      factory: true,
    });

    if (!launched.ok) throw new Error(launched.error.message);
    const run = launched.data.id;

    expect((await shown(s, run)).factory).toBe(true);
    expect((await shown(s, id)).factory).toBeUndefined();
    await s.close();
    s = await start(f);
    expect((await shown(s, run)).factory).toBe(true);
    expect((await shown(s, id)).factory).toBeUndefined();
  });

  test('a restarted serve holds one whose claude it never heard from, until a hook', async () => {
    const launched = await s.launch({ ...CARD, id: 3 }, join(f.root, 'repo3'), {}, AT);

    if (!launched.ok) throw new Error(launched.error.message);
    const fresh = launched.data.id;

    await s.message(fresh, 'kept', null);
    await s.close();
    s = await start(f);
    await settled();
    expect(f.typed).toEqual([]);
    hook(s, fresh, 'UserPromptSubmit', { prompt: 'Work on card AB#3', prompt_id: 'p3' });
    await settled();
    expect(f.typed).toEqual([{ id: fresh, text: 'kept' }]);
  });

  test('a restarted serve types in what it held that could have gone already', async () => {
    hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });
    await s.message(id, 'kept', null);
    f.failing = { code: 'tmux-failed', message: 'no server' };
    hook(s, id, 'PostToolUse', { tool_name: 'Edit' });
    await settled();
    await s.close();
    f.failing = null;
    s = await start(f);
    await settled();

    expect(f.typed).toEqual([{ id, text: 'kept' }]);
    expect((await shown(s, id)).queue).toEqual([]);
  });

  describe('the model and effort (#115)', () => {
    test('launched on the coordinator model and the effort setting, shown and in its settings', async () => {
      expect(await shown(s, id)).toMatchObject({ model: 'opus', effort: 'medium' });
      expect(SETTINGS.effort.default).toBe('medium');
      expect(f.settings.map((x) => [x.model, x.effortLevel])).toEqual([['opus', 'medium']]);
    });

    test("a Layer's models.coordinator is the launch's model; one allowedModels leaves out falls to the first allowed (#350)", async () => {
      const models = { coordinator: 'sonnet', reader: 'sonnet', writer: 'haiku' };
      const launched = await s.launch(
        { ...CARD, id: 3 },
        join(f.root, 'repo3'),
        {},
        {
          ...AT,
          models,
        },
      );

      if (!launched.ok) throw new Error(launched.error.message);
      expect(launched.data.model).toBe('sonnet');
      expect(launched.data.models).toEqual({
        coordinator: 'sonnet',
        reader: 'sonnet',
        writer: 'opus',
      });
      expect(f.settings.at(-1)?.model).toBe('sonnet');
    });

    test("picked in /model's picker for this session only, even mid-turn: recorded and said as session.model", async () => {
      expect(
        await s.model(id, { model: 'sonnet', effort: 'high', allowed: ['opus', 'sonnet'] }),
      ).toEqual({
        ok: true,
        data: { id, model: 'sonnet', effort: 'high', effortPending: false },
      });
      // `/model sonnet` and `/effort high` would save both as the person's default (#180)
      expect(f.typed).toEqual([{ id, text: '/model' }]);
      expect(f.keys).toEqual(['Down', 'Left', 'Left', 'Left', 'Left', 'Right', 'Right', 's']);
      expect(f.picker.said.at(-1)).toBe(
        '  ⎿  Set model to sonnet for this session only with high effort',
      );
      expect(f.models).toEqual([
        { session: id, model: 'sonnet', effort: 'high', effortPending: false },
      ]);
      expect(await shown(s, id)).toMatchObject({ model: 'sonnet', effort: 'high' });
    });

    test('no effort given: only the row, the effort kept; the picker opens on the model in use', async () => {
      await s.model(id, { model: 'sonnet', allowed: ['opus', 'sonnet'] });

      expect(f.keys).toEqual(['Down', 's']);
      expect(await shown(s, id)).toMatchObject({ model: 'sonnet', effort: 'medium' });
      // on sonnet now (row 3): opus is two down, past Default
      await s.model(id, { model: 'opus', allowed: ['opus', 'sonnet'] });
      expect(f.keys.slice(2)).toEqual(['Down', 'Down', 's']);
      expect(await shown(s, id)).toMatchObject({ model: 'opus' });
    });

    test('a picker with no row for the model: closed with Esc, refused, nothing recorded', async () => {
      // launched before its rows were given: Default alone
      const before = { ...f.settings[0] };

      delete before.modelPicker;
      f.settings[0] = before;
      f.picker.focus = 0;

      const answer = await s.model(id, { model: 'sonnet', allowed: ['opus', 'sonnet'] });

      expect(answer).toMatchObject({ ok: false, error: { code: 'model-picker' } });
      expect(answer.ok ? '' : answer.error.message).toContain('no sonnet row');
      expect(f.keys).toEqual(['Escape']);
      expect(f.models).toEqual([]);
      expect(await shown(s, id)).toMatchObject({ model: 'opus' });
    });

    test('a picker that never opens: refused, no key pressed (Esc would stop the turn)', async () => {
      f.picker.opens = false;

      expect(await s.model(id, { model: 'sonnet', allowed: ['opus', 'sonnet'] })).toMatchObject({
        ok: false,
        error: { code: 'model-picker' },
      });
      expect(f.keys).toEqual([]);
      expect(f.models).toEqual([]);
    });

    test.each([
      ['not allowed now', 'haiku', ['opus', 'sonnet', 'haiku']],
      ['not in force any more', 'sonnet', ['opus']],
    ])('a model %s is refused', async (_, model, allowed) => {
      expect(await s.model(id, { model, allowed })).toMatchObject({
        ok: false,
        error: { code: 'model-not-allowed' },
      });
      expect(f.typed).toEqual([]);
    });

    test('a name that is no model name is refused before anything is typed', async () => {
      expect(await s.model(id, { model: 'opus\n/exit', allowed: ['opus\n/exit'] })).toMatchObject({
        ok: false,
        error: { code: 'usage' },
      });
      expect(f.typed).toEqual([]);
    });

    test("while a dialog of Claude Code's asks: refused, its keys would answer it", async () => {
      hook(s, id, 'PermissionRequest', { tool_name: 'Edit' });

      expect(await s.model(id, { model: 'sonnet', allowed: ['sonnet'] })).toMatchObject({
        ok: false,
        error: { code: 'session-asking' },
      });
    });
  });
});

describe('through the CLI: abe, its serve, a fake claude in a real tmux', () => {
  let root: string;
  let ado: FakeAdo;
  let az: FakeAz;
  let claude: FakeClaude;
  let abe: Cli;
  let s: SessionData;

  const git = (cwd: string, ...args: string[]) => {
    const ran = Bun.spawnSync(['git', '-C', cwd, ...args], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: cwd,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.test',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.test',
      },
    });

    if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);
  };

  /** A hook the fake claude ran, as `hooks.jsonl` logs it: its event. */
  const hookName = (h: unknown) => z.object({ event: z.string() }).parse(h).event;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'abe-q-'));
    const repo = join(root, 'demo');

    ado = await fakeAdo();
    az = fakeAz({ tokens: ['token-one'] });
    claude = fakeClaude();
    for (const dir of ['mine', 'demo/.abe']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# demo\n\nThe cart.\n');
    writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    // yours for the repo, never committed
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '.abe/settings.local.yaml\n');
    writeFileSync(join(repo, '.abe', 'settings.local.yaml'), '');
    abe = cli({
      env: {
        PATH: `${claude.dir}:${az.dir}:/usr/bin:/bin`,
        ABE_CONFIG_DIR: join(root, 'mine'),
        ABE_TMUX: tmuxPath(),
        ...ado.env,
      },
      cwd: repo,
    });
    // The first turn works long enough for messages to be typed in while it runs.
    scriptClaude(abe.state.dir, [{ hook: 'PreToolUse' }, { sleep: 5000 }, { hook: 'PostToolUse' }]);
    await abe.run('status');
    await installDone(abe.state.dir, repo);
    const out = await abe.json(SessionData, 'session', 'launch', '--card', '4', '--repo', repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    s = out.doc.data;
  });
  afterAll(async () => {
    await abe.close();
    await ado.stop();
    az.remove();
    claude.remove();
    rmSync(root, { recursive: true, force: true });
  });

  test("typed in mid-turn: Claude Code's own queue takes it at the next step, shown once where it took it (#197)", async () => {
    // Its first turn runs (its launch's prompt taken): what you send now goes in at once.
    await until('the first turn', () =>
      claudeOutput(s.worktree).hooks.some((h) => hookName(h) === 'PreToolUse') ? true : undefined,
    );
    const one = await abe.json(SessionSendData, 'session', 'send', s.id, 'one');
    const two = await abe.json(
      SessionSendData,
      'session',
      'send',
      s.id,
      'two',
      '--context',
      JSON.stringify({ path: 'README.md', from: 3, to: 3 }),
    );
    const said = await abe.run('session', 'send', s.id, 'and three\non two lines');

    expect([one.doc, two.doc]).toMatchObject([
      { ok: true, data: { queued: null } },
      {
        ok: true,
        data: { queued: null, sent: 'two\n\nContext: README.md line 3\n```md\nThe cart.\n```' },
      },
    ]);
    expect(said.stdout).toBe(`sent to ${s.id}\n`);
    // Nothing held; taken by the running turn, before its Stop.
    const shownQueue = await abe.json(SessionData, 'session', 'show', s.id);

    expect(shownQueue.doc.ok && shownQueue.doc.data.queue).toEqual([]);
    const taken = await until('the messages taken mid-turn', () => {
      const out = claudeOutput(s.worktree);

      return out.typed.length === 3 && out.hooks.some((h) => hookName(h) === 'Stop')
        ? out
        : undefined;
    });

    expect(taken.typed).toEqual([
      'one',
      'two\n\nContext: README.md line 3\n```md\nThe cart.\n```',
      'and three\non two lines',
    ]);
    const names = taken.hooks.map(hookName);

    expect(names.lastIndexOf('UserPromptSubmit')).toBeLessThan(names.indexOf('Stop'));
    expect(names.filter((n) => n === 'UserPromptSubmit')).toHaveLength(4);
    const transcript = await until('the transcript with them', async () => {
      const read = await abe.json(SessionTranscriptData, 'session', 'transcript', s.id);

      return read.doc.ok &&
        read.doc.data.entries.filter((e) => e.kind === 'user').length === 4 &&
        read.doc.data.entries.some((e) => e.kind === 'assistant-text')
        ? read.doc.data.entries
        : undefined;
    });

    const words = (e: TranscriptEntry) => {
      if (e.kind === 'user') return [`you: ${e.text}`];

      return e.kind === 'assistant-text' ? ['agent'] : [];
    };

    const shownWords = transcript.flatMap(words);

    expect(shownWords[0]).toStartWith('you: Work on card AB#4');
    expect(shownWords.slice(1)).toEqual([
      'you: one',
      'you: two',
      'you: and three\non two lines',
      'agent',
    ]);
  }, 20_000);

  test('unqueue: nothing held, nothing to take back', async () => {
    const back = await abe.json(SessionUnqueueData, 'session', 'unqueue', s.id, '1');

    expect(back.doc).toMatchObject({ ok: false, error: { code: 'not-queued' } });
  });

  test("model: picked in /model's picker for this session only, shown as the session's model; the person's settings untouched (#180)", async () => {
    const out = await abe.json(
      SessionModelData,
      'session',
      'model',
      s.id,
      '--model',
      'sonnet',
      '--effort',
      'high',
    );

    expect(out.doc).toEqual({
      ok: true,
      data: { id: s.id, model: 'sonnet', effort: 'high', effortPending: false },
    });
    expect(claudeOutput(s.worktree).typed.at(-1)).toBe('/model');
    expect(claudeOutput(s.worktree).keys).toEqual([
      'Down',
      'Left',
      'Left',
      'Left',
      'Left',
      'Right',
      'Right',
      's',
    ]);
    // the session's HOME is the test's own: Claude Code's /model would have saved it there
    expect(existsSync(join(abe.state.dir, '.claude', 'settings.json'))).toBe(false);
    const shown = await abe.json(SessionData, 'session', 'show', s.id);

    expect(shown.doc).toMatchObject({ ok: true, data: { model: 'sonnet', effort: 'high' } });
    const refused = await abe.json(SessionModelData, 'session', 'model', s.id, '--model', 'gpt');

    expect(refused.doc).toMatchObject({ ok: false, error: { code: 'model-not-allowed' } });
  });
});
