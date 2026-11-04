import { describe, expect, test } from 'bun:test';
import {
  type AskCard,
  type HookPayload,
  INTERRUPTED,
  SessionMeta,
  type SessionState,
} from '../session';
import { type SubagentRun } from '../skills';
import {
  type HookInput,
  type SessionEvent,
  type SessionInput,
  sessionStep,
  SUBAGENT_RUNS_KEPT,
  tidyAgents,
} from '.';

const T0 = '2026-10-31T10:00:00.000Z';
const T1 = '2026-10-31T10:01:00.000Z';
const T2 = '2026-10-31T10:02:00.000Z';

/** A card's session, as serve keeps it, in `state` since `T0`. */
const session = (o: Partial<SessionMeta> = {}): SessionMeta =>
  SessionMeta.parse({
    v: 1,
    id: '4-a1b2',
    card: 4,
    title: 'Sign in',
    repo: '/src/shop',
    worktree: '/src/shop/.worktrees/4',
    branch: 'card/4',
    state: 'working',
    since: T0,
    startedAt: T0,
    transcriptPath: '/t/4.jsonl',
    lastAssistantMessage: null,
    claudeSession: 'c-1',
    socket: '/state/sessions/4-a1b2/session.sock',
    ...o,
  });

const hook = (event: string, payload: HookPayload = {}, o: Partial<HookInput> = {}): HookInput => ({
  kind: 'hook',
  event,
  payload,
  at: T1,
  launching: false,
  answered: false,
  quiet: false,
  holding: [],
  ...o,
});

const running = (id: string, at = T0): SubagentRun => ({
  id,
  name: 'abe:writer',
  task: null,
  model: 'opus',
  state: 'running',
  startedAt: at,
  endedAt: null,
  result: null,
});

const card = (id: string, kind: AskCard['kind'], o: Partial<AskCard> = {}): AskCard => ({
  id,
  session: '4-a1b2',
  kind,
  title: `card ${id}`,
  question: `question ${id}`,
  why: null,
  options: [],
  own: 'Own words',
  round: null,
  at: T0,
  expired: null,
  ...o,
});

const bash = (command: string) => ({ tool: 'Bash', input: command });
const permission = (id: string, o: Partial<AskCard> = {}) =>
  card(id, 'permission', { prompt: bash('rm -rf dist'), ...o });

/** A state left as it came: waiting on its turn unless it says otherwise. */
const at = (state: SessionState, o: Partial<SessionMeta> = {}) =>
  session({ state, ...(state === 'waiting' ? { waitingOn: 'turn' } : {}), ...o });

const step = (meta: SessionMeta, input: SessionInput) => sessionStep(meta, input);
const types = (events: readonly SessionEvent[]) => events.map((e) => e.type);

describe('sessionStep: a hook moves the state', () => {
  const rows: [SessionState, string, HookPayload, SessionState][] = [
    ['working', 'Stop', {}, 'waiting'],
    ['working', 'StopFailure', {}, 'waiting'],
    ['working', 'PermissionRequest', {}, 'waiting'],
    ['working', 'Elicitation', {}, 'waiting'],
    ['working', 'Notification', { notification_type: 'permission_prompt' }, 'waiting'],
    ['working', 'Notification', { notification_type: 'idle_prompt' }, 'waiting'],
    ['working', 'Notification', { notification_type: 'elicitation_dialog' }, 'waiting'],
    ['working', 'Notification', { notification_type: 'auth_success' }, 'working'],
    ['waiting', 'Notification', { notification_type: 'auth_success' }, 'waiting'],
    ['waiting', 'Notification', {}, 'waiting'],
    ['working', 'SessionEnd', { reason: 'prompt_input_exit' }, 'ended'],
    ['waiting', 'SessionEnd', { reason: 'logout' }, 'ended'],
    ['waiting', 'SessionEnd', { reason: 'other' }, 'ended'],
    ['waiting', 'SessionEnd', {}, 'ended'],
    ['waiting', 'SessionEnd', { reason: 'clear' }, 'waiting'],
    ['waiting', 'SessionEnd', { reason: 'resume' }, 'waiting'],
    ['waiting', 'UserPromptSubmit', {}, 'working'],
    ['waiting', 'PreToolUse', {}, 'working'],
    ['waiting', 'PostToolUse', {}, 'working'],
    ['waiting', 'PostToolUseFailure', {}, 'working'],
    ['waiting', 'PermissionDenied', {}, 'working'],
    ['waiting', 'SubagentStart', {}, 'working'],
    ['waiting', 'SubagentStop', {}, 'waiting'],
    ['working', 'SubagentStop', {}, 'working'],
    ['waiting', 'PreCompact', {}, 'working'],
    ['waiting', 'ElicitationResult', {}, 'working'],
    ['waiting', 'AnEventFromANewerClaude', {}, 'working'],
    ['waiting', 'SessionStart', {}, 'waiting'],
    ['working', 'SessionStart', {}, 'working'],
    ['waiting', 'FileChanged', {}, 'waiting'],
    ['waiting', 'ConfigChange', {}, 'waiting'],
    ['waiting', 'InstructionsLoaded', {}, 'waiting'],
    ['waiting', 'PostModelSwitch', {}, 'waiting'],
    ['waiting', 'PreCompact', { trigger: 'manual' }, 'waiting'],
    ['waiting', 'PostCompact', { trigger: 'manual' }, 'waiting'],
    ['working', 'PreCompact', { trigger: 'auto' }, 'working'],
    ['ended', 'UserPromptSubmit', {}, 'ended'],
    ['ended', 'Stop', {}, 'ended'],
    // a launch is starting until its claude runs a hook; any hook means it is up
    ['starting', 'SessionStart', {}, 'working'],
    ['starting', 'InstructionsLoaded', {}, 'working'],
    ['starting', 'UserPromptSubmit', {}, 'working'],
    ['starting', 'Notification', { notification_type: 'idle_prompt' }, 'waiting'],
    ['starting', 'Notification', { notification_type: 'auth_success' }, 'working'],
    ['starting', 'SessionEnd', {}, 'ended'],
  ];

  test.each(rows)('%s + %s %o → %s', (from, event, payload, to) => {
    expect(step(at(from), hook(event, payload)).meta.state).toBe(to);
  });

  // The coordinator ends its turn while a background writer runs: Claude Code wakes it when the
  // writer is done, so nobody is asked anything yet.
  const background: [SessionState, string, HookPayload, SessionState][] = [
    ['working', 'Stop', {}, 'working'],
    ['working', 'Notification', { notification_type: 'idle_prompt' }, 'working'],
    // a prompt still open: its idle notice does not take it out of waiting
    ['waiting', 'Notification', { notification_type: 'idle_prompt' }, 'waiting'],
    ['working', 'StopFailure', {}, 'waiting'],
    ['working', 'PermissionRequest', {}, 'waiting'],
    ['working', 'Notification', { notification_type: 'permission_prompt' }, 'waiting'],
  ];

  test.each(background)('with a subagent running: %s + %s %o → %s', (from, event, payload, to) => {
    expect(step(at(from, { subagents: [running('w1')] }), hook(event, payload)).meta.state).toBe(
      to,
    );
  });

  test.each([
    [
      'a subagent started a minute ago runs: the Stop keeps it working',
      running('w1', T0),
      'working',
    ],
    [
      'one started two hours ago with no stop counts no more',
      running('w1', '2026-10-31T08:00:00.000Z'),
      'waiting',
    ],
  ] as const)('%s', (_, run, to) => {
    expect(step(at('working', { subagents: [run] }), hook('Stop')).meta.state).toBe(to);
  });

  test('a question card open: its Stop waits on you, whatever runs in the background', () => {
    const meta = at('working', { subagents: [running('w1')], asks: [card('q-1', 'question')] });

    expect(step(meta, hook('Stop')).meta).toMatchObject({
      state: 'waiting',
      waitingOn: 'question',
    });
  });

  test('answered here (an unattended run, a prompt allowed for the session): it keeps working', () => {
    expect(step(at('working'), hook('PermissionRequest', {}, { answered: true })).meta.state).toBe(
      'working',
    );
  });

  test('a quiet reopen waits on its turn at its start, and works at its first prompt', () => {
    const opened = step(at('starting'), hook('SessionStart', {}, { quiet: true })).meta;

    expect(opened).toMatchObject({ state: 'waiting', waitingOn: 'turn', since: T1 });
    expect(step(opened, hook('UserPromptSubmit', {}, { quiet: true })).meta.state).toBe('working');
  });
});

describe('sessionStep: what a waiting session waits on', () => {
  test.each([
    ['Stop', {}, 'turn'],
    ['StopFailure', {}, 'turn'],
    ['Notification', { notification_type: 'idle_prompt' }, 'turn'],
    ['PermissionRequest', {}, 'dialog'],
    ['Elicitation', {}, 'dialog'],
    ['Notification', { notification_type: 'permission_prompt' }, 'dialog'],
    ['Notification', { notification_type: 'elicitation_dialog' }, 'dialog'],
  ] as const)('working, then %s %o: waits on its %s', (event, payload, on) => {
    expect(step(at('working'), hook(event, payload)).meta.waitingOn).toBe(on);
  });

  test.each([
    [
      'a question open, its idle notice: still the question',
      'question',
      'Notification',
      { notification_type: 'idle_prompt' },
      'question',
    ],
    [
      'a notice that asks nothing keeps what it waits on',
      'turn',
      'Notification',
      { notification_type: 'auth_success' },
      'turn',
    ],
    ['an event leaving it waiting keeps what it waits on', 'turn', 'MessageDisplay', {}, 'turn'],
    [
      'a dialog open a minute stays a dialog at the idle notice',
      'dialog',
      'Notification',
      { notification_type: 'idle_prompt' },
      'dialog',
    ],
    ['a dialog asked while it waits on its turn', 'turn', 'PermissionRequest', {}, 'dialog'],
    ['working again waits on nothing', 'turn', 'UserPromptSubmit', {}, null],
  ] as const)('%s', (_, was, event, payload, on) => {
    expect(step(at('waiting', { waitingOn: was }), hook(event, payload)).meta.waitingOn).toBe(on);
  });
});

describe('sessionStep: its own turn over while a background subagent works', () => {
  const sub = { agent_id: 'w1' };
  const ended = at('working', { subagents: [running('w1')], turnEnded: true });

  test.each([
    [
      "the coordinator's Stop held working by a subagent ends its turn",
      at('working', { subagents: [running('w1')] }),
      hook('Stop'),
      true,
    ],
    ["a subagent's own hook keeps it ended", ended, hook('PreToolUse', sub), true],
    [
      'the idle notice keeps it ended',
      ended,
      hook('Notification', { notification_type: 'idle_prompt' }),
      true,
    ],
    ['an idle event keeps it ended', ended, hook('FileChanged'), true],
    [
      "the subagent's hand-back wakes the coordinator: its own turn again",
      ended,
      hook('UserPromptSubmit'),
      false,
    ],
    [
      'a Stop with no subagent running waits on you, nothing held',
      at('working'),
      hook('Stop'),
      false,
    ],
    [
      'a launch starting holds no turn',
      at('starting', { turnEnded: true }),
      hook('SessionStart'),
      false,
    ],
  ] as const)('%s', (_, meta, input, turnEnded) => {
    expect(step(meta, input).meta.turnEnded === true).toBe(turnEnded);
  });
});

describe('sessionStep: what a hook says', () => {
  const states = (events: readonly SessionEvent[]) =>
    events.flatMap((e) => (e.type === 'session.state' ? [e.data] : []));

  test('a move: one session.state with its cause, since and what it waits on', () => {
    const { meta, events } = step(at('working'), hook('Stop', { last_assistant_message: 'Done.' }));

    expect(meta).toMatchObject({ since: T1, lastAssistantMessage: 'Done.', startBy: null });
    expect(states(events)).toEqual([
      { id: '4-a1b2', card: 4, state: 'waiting', since: T1, cause: 'Stop', waitingOn: 'turn' },
    ]);
  });

  test('no move: nothing said, its since kept', () => {
    const { meta, events } = step(at('working'), hook('PreToolUse', { tool_name: 'Read' }));

    expect(meta.since).toBe(T0);
    expect(events).toEqual([]);
  });

  test('its own turn ended with no move: said as its state, turnEnded', () => {
    const meta = at('working', { subagents: [running('w1')] });

    expect(states(step(meta, hook('Stop')).events)).toEqual([
      { id: '4-a1b2', card: 4, state: 'working', since: T0, cause: 'Stop', turnEnded: true },
    ]);
  });

  test('while its launch has not returned: no move said (its launch says it)', () => {
    const { meta, events } = step(at('starting'), hook('SessionStart', {}, { launching: true }));

    expect(meta.state).toBe('working');
    expect(events).toEqual([]);
  });

  test('a subagent started: said as session.subagent, its run kept', () => {
    const { meta, events } = step(
      at('working'),
      hook('SubagentStart', { agent_id: 'w1', agent_type: 'abe:writer' }),
    );

    expect(meta.subagents.map((r) => [r.id, r.state])).toEqual([['w1', 'running']]);
    expect(events).toEqual([
      {
        type: 'session.subagent',
        data: {
          id: '4-a1b2',
          card: 4,
          agent: 'w1',
          name: 'abe:writer',
          task: null,
          model: null,
          state: 'running',
          result: null,
          tool: null,
          tools: 0,
          call: null,
          transcript: null,
        },
      },
    ]);
  });

  test(`its ended subagent runs: the newest ${SUBAGENT_RUNS_KEPT} kept, every running one too`, () => {
    const done = (n: number): SubagentRun => ({ ...running(`d${n}`), state: 'done', endedAt: T0 });
    const runs = [running('r0'), ...Array.from({ length: 40 }, (_, n) => done(n))];
    const { meta } = step(at('working', { subagents: runs }), hook('PostToolUse'));

    expect(meta.subagents.map((r) => r.id)).toEqual([
      'r0',
      ...Array.from({ length: SUBAGENT_RUNS_KEPT }, (_, n) => `d${n + 40 - SUBAGENT_RUNS_KEPT}`),
    ]);
  });

  test.each<[string, HookPayload, boolean]>([
    [
      'a writer in a worktree of its own: looked for long after its run is dropped',
      { agent_id: 'd0', cwd: '/src/shop/.claude/worktrees/agent-d0' },
      true,
    ],
    [
      "a reader in the session's own worktree: only while its run is kept",
      { agent_id: 'd0', cwd: '/src/shop/.worktrees/4' },
      false,
    ],
  ])("what the session's tidy looks for: %s", (_, payload, found) => {
    const done = (n: number): SubagentRun => ({ ...running(`d${n}`), state: 'done', endedAt: T0 });
    const heard = step(at('working', { subagents: [done(0)] }), hook('PreToolUse', payload)).meta;
    const later = Array.from({ length: SUBAGENT_RUNS_KEPT }, (_, n) => done(n + 1));
    const { meta } = step({ ...heard, subagents: [...heard.subagents, ...later] }, hook('Stop'));

    expect(meta.subagents.map((r) => r.id)).not.toContain('d0');
    expect(tidyAgents(meta).includes('d0')).toBe(found);
  });

  test('a long Factory run keeps a small meta: a thousand subagents, its size bounded', () => {
    let meta = at('working');
    let peak = 0;

    for (let n = 0; n < 1000; n += 1) {
      const agent = { agent_id: `a${n}`, agent_type: 'abe:reader', transcript_path: '/t/4.jsonl' };

      meta = step(
        meta,
        hook('PreToolUse', {
          tool_name: 'Agent',
          tool_input: { subagent_type: 'abe:reader', description: `look ${n}` },
        }),
      ).meta;
      meta = step(meta, hook('SubagentStart', agent)).meta;
      meta = step(
        meta,
        hook('PreToolUse', {
          ...agent,
          tool_name: 'Read',
          tool_input: { file_path: `/src/f${n}.ts` },
        }),
      ).meta;
      meta = step(
        meta,
        hook('SubagentStop', { ...agent, last_assistant_message: `Read f${n}.` }),
      ).meta;
      peak = Math.max(peak, JSON.stringify(meta).length);
    }

    expect(meta.subagents).toHaveLength(SUBAGENT_RUNS_KEPT);
    expect(peak).toBeLessThan(20_000);
  });
});

describe('sessionStep: the cards a hook asks and clears', () => {
  const asks = (meta: SessionMeta) => meta.asks.map((c) => c.id);

  test.each([
    [
      "AskUserQuestion's questions, fresh: open, said, a round counted",
      at('working'),
      hook(
        'PreToolUse',
        { tool_name: 'AskUserQuestion' },
        { asked: { cards: [card('q-1', 'question')], fresh: true } },
      ),
      ['q-1'],
      ['session.ask'],
    ],
    [
      'the same question heard again: nothing new',
      at('working', { asks: [card('q-1', 'question')], rounds: 1 }),
      hook(
        'PreToolUse',
        { tool_name: 'AskUserQuestion' },
        { asked: { cards: [card('q-1', 'question')], fresh: false } },
      ),
      ['q-1'],
      [],
    ],
    [
      "a prompt nobody answers here: its dialog's card",
      at('working'),
      hook(
        'PermissionRequest',
        { tool_name: 'Bash' },
        { dialog: permission('p-1', { dialog: true }) },
      ),
      ['p-1'],
      ['session.state', 'session.ask'],
    ],
    [
      "a dialog's card for a prompt open already: kept as it was",
      at('waiting', { waitingOn: 'dialog', asks: [permission('p-1', { dialog: true })] }),
      hook(
        'PermissionRequest',
        { tool_name: 'Bash' },
        { dialog: permission('p-2', { dialog: true }) },
      ),
      ['p-1'],
      [],
    ],
    [
      'a prompt answered here shows no dialog: no card',
      at('working'),
      hook(
        'PermissionRequest',
        { tool_name: 'Bash' },
        { answered: true, dialog: permission('p-1', { dialog: true }) },
      ),
      [],
      [],
    ],
    [
      'a prompt held under an Override: its card',
      at('working'),
      hook('PermissionRequest', { tool_name: 'Bash' }, { held: permission('p-1') }),
      ['p-1'],
      ['session.state', 'session.ask'],
    ],
    [
      'a prompt typed in Terminal mode: the question goes, answered outside Chat',
      at('waiting', { waitingOn: 'question', asks: [card('q-1', 'question')] }),
      hook('UserPromptSubmit'),
      [],
      ['session.state', 'session.answered'],
    ],
    [
      'the turn stops: a permission card no longer held goes',
      at('working', { asks: [permission('p-1')] }),
      hook('Stop'),
      [],
      ['session.state', 'session.answered'],
    ],
    [
      'the turn stops: one still held stays',
      at('working', { asks: [permission('p-1')] }),
      hook('Stop', {}, { holding: ['p-1'] }),
      ['p-1'],
      ['session.state'],
    ],
    [
      'its tool ran: the held prompt was answered in its dialog, its card goes',
      at('working', { asks: [permission('p-1')] }),
      hook(
        'PostToolUse',
        { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } },
        { holding: ['p-1'] },
      ),
      [],
      ['session.answered'],
    ],
    [
      "its dialog's own notice keeps the card: the dialog still waits",
      at('waiting', { waitingOn: 'dialog', asks: [permission('p-1', { dialog: true })] }),
      hook('Notification', { notification_type: 'permission_prompt' }),
      ['p-1'],
      [],
    ],
    [
      'the session ended: every card goes',
      at('waiting', { waitingOn: 'question', asks: [card('q-1', 'question'), permission('p-1')] }),
      hook('SessionEnd', { reason: 'other' }, { holding: ['p-1'] }),
      [],
      ['session.state', 'session.answered'],
    ],
    [
      'while its launch has not returned its cards are left as they are',
      at('starting', { asks: [card('q-1', 'question')] }),
      hook('UserPromptSubmit', {}, { launching: true }),
      ['q-1'],
      [],
    ],
  ] as const)('%s', (_, meta, input, open, said) => {
    const next = step(meta, input);

    expect(asks(next.meta)).toEqual([...open]);
    expect(types(next.events)).toEqual([...said]);
  });

  test('a question round counts once, said with its cards', () => {
    const q = card('q-1', 'question');
    const { meta, events } = step(
      at('working'),
      hook('PreToolUse', { tool_name: 'AskUserQuestion' }, { asked: { cards: [q], fresh: true } }),
    );

    expect(meta.rounds).toBe(1);
    expect(events).toEqual([{ type: 'session.ask', data: { id: '4-a1b2', card: 4, cards: [q] } }]);
  });
});

describe('sessionStep: an Esc, a dialog gone, a card changed', () => {
  test.each([
    [
      'working since before the Esc: waits on its turn, interrupted',
      at('working'),
      { at: T1 },
      'waiting',
      INTERRUPTED,
    ],
    [
      'a message sent after the Esc moved it on already: it stays',
      at('working', { since: T2 }),
      { at: T1 },
      'working',
      null,
    ],
    [
      'a background subagent wakes it: it stays',
      at('working', { subagents: [running('w1')] }),
      { at: T1 },
      'working',
      null,
    ],
    [
      'while its launch has not returned: it stays',
      at('working'),
      { at: T1, launching: true },
      'working',
      null,
    ],
    [
      'Esc on a dialog: it waits on its turn',
      at('waiting', { waitingOn: 'dialog' }),
      { at: T1 },
      'waiting',
      INTERRUPTED,
    ],
    [
      'an Esc from before the dialog: it stays',
      at('waiting', { waitingOn: 'dialog', since: T2 }),
      { at: T1 },
      'waiting',
      null,
    ],
    ['waiting on its turn already: nothing', at('waiting'), { at: T1 }, 'waiting', null],
  ] as const)('%s', (_, meta, o, state, cause) => {
    const next = step(meta, { kind: 'interrupt', now: T2, launching: false, ...o });

    expect(next.meta.state).toBe(state);
    expect(next.events.map((e) => (e.type === 'session.state' ? e.data.cause : e.type))).toEqual(
      cause === null ? [] : [cause],
    );
    if (cause !== null) expect(next.meta).toMatchObject({ waitingOn: 'turn', since: T2 });
  });

  test("its dialog gone with no hook: its turn, the dialog's card answered outside Chat", () => {
    const meta = at('waiting', {
      waitingOn: 'dialog',
      asks: [permission('p-1', { dialog: true }), permission('p-2')],
    });
    const { meta: next, events } = step(meta, { kind: 'dialog-gone', at: T2 });

    expect(next).toMatchObject({ state: 'waiting', waitingOn: 'turn', since: T2 });
    expect(next.asks.map((c) => c.id)).toEqual(['p-2']);
    expect(events).toEqual([
      {
        type: 'session.state',
        data: {
          id: '4-a1b2',
          card: 4,
          state: 'waiting',
          since: T2,
          cause: INTERRUPTED,
          waitingOn: 'turn',
        },
      },
      { type: 'session.answered', data: { id: '4-a1b2', card: 4, cards: ['p-1'], answer: null } },
    ]);
    expect(step(at('working'), { kind: 'dialog-gone', at: T2 }).events).toEqual([]);
  });

  test.each([
    [
      'a pick or a hold run out: the card in its place, said',
      { kind: 'ask', asked: [permission('p-1', { expired: 'gone' })] },
      ['q-1', 'p-1'],
      ['session.ask'],
    ],
    [
      'answered: closed and said with the answer',
      { kind: 'ask', closed: ['q-1'], answer: 'Yes' },
      ['p-1'],
      ['session.answered'],
    ],
    ['closed before its answer is typed in: unsaid', { kind: 'ask', closed: ['q-1'] }, ['p-1'], []],
    [
      'an answer not typed in: its cards back first, unsaid',
      { kind: 'ask', back: [card('q-0', 'question')] },
      ['q-0', 'q-1', 'p-1'],
      [],
    ],
  ] as const)('%s', (_, input, open, said) => {
    const meta = at('waiting', {
      waitingOn: 'question',
      asks: [card('q-1', 'question'), permission('p-1')],
    });
    const next = step(meta, input);

    expect(next.meta.asks.map((c) => c.id)).toEqual([...open]);
    expect(types(next.events)).toEqual([...said]);
  });

  test('allowed for the session: the prompt kept with the card closed', () => {
    const meta = at('waiting', { waitingOn: 'dialog', asks: [permission('p-1')] });
    const next = step(meta, {
      kind: 'ask',
      closed: ['p-1'],
      answer: 'Allow',
      allow: bash('rm -rf dist'),
    });

    expect(next.meta.allowed).toEqual([bash('rm -rf dist')]);
    expect(next.meta.asks).toEqual([]);
  });
});
