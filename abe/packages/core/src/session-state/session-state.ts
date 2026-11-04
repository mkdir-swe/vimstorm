/**
 * Where an agent session stands, as one step: its meta and one input in, the meta after it and
 * the events that say so out. The inputs are Claude Code's hooks (with the cards serve made of
 * the hook's payload), its own agent stopped mid-turn (Esc, read from its transcript), its dialog
 * gone with no hook, and a change to its cards. Serve keeps the meta once per input and sends the
 * events in order; nothing here reads a clock, a file or a terminal.
 */
import {
  type AskCard,
  asksRound,
  type HookPayload,
  INTERRUPTED,
  promptInput,
  type SessionMeta,
  type SessionState,
} from '../session';
import { type SubagentRun, subagentRunning, subagentsAfter } from '../skills';
import { type EventData } from '../contract';

/** What a step says, in the order serve sends it. */
export type SessionEvent =
  | { type: 'session.state'; data: EventData<'session.state'> }
  | { type: 'session.subagent'; data: EventData<'session.subagent'> }
  | { type: 'session.ask'; data: EventData<'session.ask'> }
  | { type: 'session.answered'; data: EventData<'session.answered'> };

/**
 * One hook as serve heard it, its payload parsed once. `launching`: serve's launch of it has not
 * returned yet (its launch event says where it stands then, so no move is said). `answered`: serve
 * answers it for the person (an unattended run's prompt, one allowed for the session), so no
 * dialog shows and the state stays. `quiet`: reopened with no prompt, its start's hooks mean it
 * waits at its prompt for you. The cards are the ones serve made of the payload: `asked`
 * (AskUserQuestion's questions, `fresh` when not open already), `dialog` (Claude Code's own
 * dialog's card, for a prompt nobody answers here), `held` (one held for its card under an
 * Override); `holding` the cards serve holds a hook for now.
 */
export type HookInput = {
  kind: 'hook';
  event: string;
  payload: HookPayload;
  at: string;
  launching: boolean;
  answered: boolean;
  quiet: boolean;
  asked?: { cards: readonly AskCard[]; fresh: boolean };
  dialog?: AskCard;
  held?: AskCard;
  holding: readonly string[];
};

/**
 * Its own agent stopped at `at` (Esc in its Claude Code), read from its transcript at `now`: no
 * hook comes for it.
 */
export type InterruptInput = { kind: 'interrupt'; at: string; now: string; launching: boolean };

/** Claude Code's dialog gone from its screen at `at` with no hook (answered by its Esc). */
export type DialogGoneInput = { kind: 'dialog-gone'; at: string };

/**
 * Its cards changed outside a hook: `asked` added, or in place of the card with the same id (a
 * pick, a hold that ran out), said as `session.ask`; `closed` taken out, said as
 * `session.answered` with `answer` when one is given (left out: said once the answer is typed in);
 * `back` put back first, unsaid (an answer not typed in); `allow` a prompt allowed for the rest of
 * the session.
 */
export type AskInput = {
  kind: 'ask';
  asked?: readonly AskCard[];
  closed?: readonly string[];
  answer?: string | null;
  back?: readonly AskCard[];
  allow?: { tool: string; input: string };
};

export type SessionInput = HookInput | InterruptInput | DialogGoneInput | AskInput;

export type SessionStep = { meta: SessionMeta; events: SessionEvent[] };

/** Notifications that mean Claude Code waits for you. */
const WAITING_NOTICES = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog']);

/** The turn ended, or a dialog asks you something. */
const WAITING = new Set(['Stop', 'StopFailure', 'PermissionRequest', 'Elicitation']);

/**
 * Events that also fire while Claude Code sits idle (a file it watches changed, settings were
 * reloaded, `/model`, `/clear`'s new session): they say nothing about work, so the state stays.
 */
const UNCHANGED = new Set([
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
  'ConfigChange',
  'CwdChanged',
  'FileChanged',
  'DirectoryAdded',
  'MessageDisplay',
  'PreModelSwitch',
  'PostModelSwitch',
  'TeammateIdle',
  // A background subagent may end while the coordinator waits on you.
  'SubagentStop',
  'WorktreeCreate',
  'WorktreeRemove',
]);

/** `/clear` and `/resume` end one Claude session and start the next in the same `claude`. */
const ENDS_BUT_GOES_ON = new Set(['clear', 'resume']);

/** What a `claude` runs as it starts, before it takes its launch's prompt. */
export const STARTING_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'Setup',
  'InstructionsLoaded',
]);

/** The events whose payload carries the main agent's last message. */
const LAST_MESSAGE_FROM = new Set(['Stop', 'StopFailure']);

/** Events that end a turn: Claude Code waits at its prompt for your next message. */
const TURN_ENDS = new Set(['Stop', 'StopFailure']);
/** What opens a dialog of Claude Code's: keys typed then answer it. */
const DIALOGS = new Set(['PermissionRequest', 'Elicitation']);
const DIALOG_NOTICES = new Set(['permission_prompt', 'elicitation_dialog']);

/** The events after a tool's prompt was decided, in Claude Code's own dialog when no card was. */
const DECIDED = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);

/** The ended subagent runs a session keeps, newest first, besides every running one. */
export const SUBAGENT_RUNS_KEPT = 30;

/**
 * Where a session stands after a hook: `Stop` and the asking `Notification`s mean waiting on you,
 * `SessionEnd` means ended, anything else means working. Ended is final. While a subagent of the
 * session runs (a background writer), the coordinator's `Stop` asks nobody anything (Claude Code
 * wakes it when the subagent is done) and its idle notice changes nothing. A card asked in Chat
 * makes the turn's `Stop` wait on you whatever runs in the background.
 */
const stateAfter = (
  current: SessionState,
  event: string,
  payload: HookPayload,
  o: { subagentsRunning: boolean; asking: boolean },
): SessionState => {
  if (current === 'ended') return 'ended';
  if (event === 'SessionEnd') return ENDS_BUT_GOES_ON.has(payload.reason ?? '') ? current : 'ended';
  // a launch stays starting until its claude runs a hook; any hook means it is up
  if (current === 'starting') return stateAfter('working', event, payload, o);
  if (o.asking && event === 'Stop') return 'waiting';
  if (o.subagentsRunning && event === 'Stop') return 'working';
  if (o.subagentsRunning && payload.notification_type === 'idle_prompt') return current;
  if (event === 'Notification')
    return WAITING_NOTICES.has(payload.notification_type ?? '') ? 'waiting' : current;
  if (WAITING.has(event)) return 'waiting';
  // `/compact` typed while waiting: no Stop follows it.
  if ((event === 'PreCompact' || event === 'PostCompact') && payload.trigger === 'manual')
    return current;
  if (UNCHANGED.has(event)) return current;

  return 'working';
};

/**
 * Whether the session's own turn has ended while it still works (`working` held by a background
 * subagent at its `Stop`): idle at its prompt, only its subagents at work. A subagent's hook, or
 * one that fires while it idles, leaves it as it was; anything else of its own agent ends it.
 */
const turnEndedAfter = (
  was: Pick<SessionMeta, 'state' | 'turnEnded'>,
  state: SessionState,
  event: string,
  payload: HookPayload,
  subagentsRunning: boolean,
): boolean => {
  if (state === 'ended' || (was.state !== 'working' && was.state !== 'waiting')) return false;
  if (event === 'Stop') return state === 'working' && subagentsRunning;
  if (payload.agent_id !== undefined || UNCHANGED.has(event) || event === 'Notification')
    return was.turnEnded === true;

  return false;
};

/**
 * What a session waiting after `event` waits on: its turn ended (`Stop`, Claude Code's idle
 * notice), on a question card of Chat's when one is open (`asking`), or a dialog asks (a
 * permission prompt, an elicitation). An event that leaves it waiting as it was keeps what it
 * waited on (the idle notice too: a dialog open a minute stays a dialog); one that moved it to
 * waiting and is not known to end a turn counts as a dialog.
 */
const waitingOnAfter = (
  was: Pick<SessionMeta, 'state' | 'waitingOn'>,
  state: SessionState,
  event: string,
  payload: HookPayload,
  asking: boolean,
): SessionMeta['waitingOn'] => {
  if (state !== 'waiting') return null;
  if (TURN_ENDS.has(event)) return asking ? 'question' : 'turn';
  if (DIALOGS.has(event) || DIALOG_NOTICES.has(payload.notification_type ?? '')) return 'dialog';
  if (was.state === 'waiting' && was.waitingOn !== null) return was.waitingOn;

  return payload.notification_type === 'idle_prompt' ? 'turn' : 'dialog';
};

/** Where Claude Code puts a subagent's own git worktree (`isolation: worktree`). */
const WORKTREES = '/.claude/worktrees/';

/** Its writers after a hook: the subagent's added when the hook ran in a worktree of its own. */
const writersAfter = (meta: SessionMeta, p: HookPayload): string[] | undefined => {
  const id = p.agent_id;
  const was = meta.writers;

  if (id === undefined || p.cwd?.includes(WORKTREES) !== true || was?.includes(id) === true)
    return was;

  return [...(was ?? []), id];
};

/**
 * The subagents whose writer worktrees and branches a tidy of the session looks for: every kept
 * run's, and every writer's, its run kept or not.
 */
export const tidyAgents = (meta: Pick<SessionMeta, 'subagents' | 'writers'>): string[] => [
  ...new Set([...meta.subagents.map((r) => r.id), ...(meta.writers ?? [])]),
];

/** Every running run, and the newest `SUBAGENT_RUNS_KEPT` ended ones, in their order. */
const keptRuns = (runs: readonly SubagentRun[]): SubagentRun[] => {
  const ended = runs.filter((r) => r.state !== 'running');
  const dropped = new Set(ended.slice(0, Math.max(0, ended.length - SUBAGENT_RUNS_KEPT)));

  return runs.filter((r) => !dropped.has(r));
};

/** A question or grill card waits for its answer (a permission card is a dialog's, not a turn's). */
const asking = (meta: SessionMeta): boolean => meta.asks.some((c) => c.kind !== 'permission');

/** Its move (or its own turn's end) said: what it waits on with a move, its own turn unless left out. */
const stateEvent = (
  meta: SessionMeta,
  cause: string,
  o: { moved: boolean; turnEnded: boolean },
): SessionEvent => ({
  type: 'session.state',
  data: {
    id: meta.id,
    card: meta.card,
    state: meta.state,
    since: meta.since,
    cause,
    ...(o.moved && meta.state === 'waiting' ? { waitingOn: meta.waitingOn } : {}),
    ...(o.turnEnded && meta.turnEnded === true ? { turnEnded: true as const } : {}),
  },
});

const askEvent = (meta: SessionMeta, cards: readonly AskCard[]): SessionEvent => ({
  type: 'session.ask',
  data: { id: meta.id, card: meta.card, cards: [...cards] },
});

const answeredEvent = (
  meta: SessionMeta,
  cards: readonly string[],
  answer: string | null,
): SessionEvent => ({
  type: 'session.answered',
  data: { id: meta.id, card: meta.card, cards: [...cards], answer },
});

/**
 * The cards a hook leaves answered outside Chat: all of them once the session ends; a question
 * once a prompt is typed in Terminal mode; a held one once its tool ran or was denied (its dialog
 * answered first); one no longer held (it ran out, or an earlier serve held it) the same way, or
 * once a prompt is typed or the turn stops. Any other hook (its dialog's own `permission_prompt`
 * Notification) keeps it: the dialog still waits.
 */
const answeredBy = (meta: SessionMeta, h: HookInput): AskCard[] => {
  const ran = DECIDED.has(h.event) ? promptInput(h.payload) : undefined;
  const typed = h.event === 'UserPromptSubmit';

  return meta.asks.filter((c) => {
    if (meta.state === 'ended') return true;
    if (c.kind !== 'permission') return typed;
    if (!h.holding.includes(c.id) && (typed || h.event === 'Stop')) return true;

    return ran !== undefined && c.prompt?.tool === ran.tool && c.prompt.input === ran.input;
  });
};

/** The cards a hook asks: its questions when fresh, a held prompt's, else its dialog's. */
const askedBy = (meta: SessionMeta, h: HookInput): { cards: AskCard[]; rounds: number } => {
  if (h.asked !== undefined) {
    if (!h.asked.fresh) return { cards: [], rounds: 0 };
    return { cards: [...h.asked.cards], rounds: asksRound(h.asked.cards) ? 1 : 0 };
  }
  if (h.held !== undefined) return { cards: [h.held], rounds: 0 };
  const card = h.dialog;
  // a prompt answered here shows no dialog; one with its card open already has it
  const open =
    card === undefined ||
    h.answered ||
    meta.asks.some(
      (c) =>
        c.kind === 'permission' &&
        c.prompt?.tool === card.prompt?.tool &&
        c.prompt?.input === card.prompt?.input,
    );

  return { cards: open ? [] : [card], rounds: 0 };
};

const hookStep = (meta: SessionMeta, h: HookInput): SessionStep => {
  const { event, payload: p, at } = h;
  // a quiet reopen's start: it waits at its prompt for you
  const opened = h.quiet && STARTING_EVENTS.has(event) && meta.state !== 'ended';
  const subagents = subagentsAfter({ calls: meta.agentCalls, runs: meta.subagents }, event, p, {
    at,
    models: meta.models,
    allowed: meta.allowedModels,
  });
  const running = subagentRunning(subagents.book.runs, at);
  const writers = writersAfter(meta, p);
  const questions = asking(meta);
  const heard = h.answered
    ? meta.state
    : stateAfter(meta.state, event, p, { subagentsRunning: running, asking: questions });
  const state = opened ? 'waiting' : heard;
  const turnEnded = !opened && turnEndedAfter(meta, state, event, p, running);
  const moved = state !== meta.state;
  const heardMeta: SessionMeta = {
    ...meta,
    // its claude runs: no start timeout any more
    startBy: null,
    transcriptPath: p.transcript_path ?? meta.transcriptPath,
    lastAssistantMessage:
      LAST_MESSAGE_FROM.has(event) && p.last_assistant_message !== undefined
        ? p.last_assistant_message
        : meta.lastAssistantMessage,
    agentCalls: subagents.book.calls,
    subagents: keptRuns(subagents.book.runs),
    ...(writers === meta.writers ? {} : { writers }),
    waitingOn: opened ? 'turn' : waitingOnAfter(meta, state, event, p, questions),
    turnEnded: turnEnded ? true : undefined,
    ...(moved ? { state, since: at } : {}),
  };
  const events: SessionEvent[] = [];

  // its own turn ended (or went on) while it still works: said with no move
  if (!h.launching && (moved || turnEnded !== (meta.turnEnded === true)))
    events.push(stateEvent(heardMeta, event, { moved, turnEnded: true }));
  const run = subagents.changed;

  if (run !== undefined)
    events.push({
      type: 'session.subagent',
      data: {
        id: meta.id,
        card: meta.card,
        agent: run.id,
        name: run.name,
        task: run.task,
        model: run.model,
        state: run.state,
        result: run.result,
        tool: run.tool,
        tools: run.tools ?? 0,
        call: run.call,
        transcript: run.transcript,
      },
    });
  // its cards are not looked at before its launch returns
  if (h.launching) return { meta: heardMeta, events };
  const gone = answeredBy(heardMeta, h);
  const left =
    gone.length === 0
      ? heardMeta
      : without(
          heardMeta,
          gone.map((c) => c.id),
        );

  if (gone.length > 0)
    events.push(
      answeredEvent(
        meta,
        gone.map((c) => c.id),
        null,
      ),
    );
  const asked = askedBy(left, h);

  if (asked.cards.length === 0) return { meta: left, events };
  events.push(askEvent(meta, asked.cards));

  return {
    meta: { ...left, asks: [...left.asks, ...asked.cards], rounds: left.rounds + asked.rounds },
    events,
  };
};

const without = (meta: SessionMeta, ids: readonly string[]): SessionMeta => ({
  ...meta,
  asks: meta.asks.filter((c) => !ids.includes(c.id)),
});

/**
 * Its dialog gone with no hook: a session waiting on it waits on your turn, said as a move (it
 * stays waiting) for Chat and the Board. Its card goes, answered outside Chat: no dialog is left
 * for its keys to answer.
 */
const dialogGone = (meta: SessionMeta, at: string): SessionStep => {
  if (meta.state !== 'waiting' || meta.waitingOn !== 'dialog') return { meta, events: [] };
  const gone = meta.asks.filter((c) => c.kind === 'permission' && c.dialog === true);
  const next: SessionMeta = {
    ...without(
      meta,
      gone.map((c) => c.id),
    ),
    since: at,
    waitingOn: 'turn',
  };

  return {
    meta: next,
    events: [
      stateEvent(next, INTERRUPTED, { moved: true, turnEnded: false }),
      ...(gone.length === 0
        ? []
        : [
            answeredEvent(
              meta,
              gone.map((c) => c.id),
              null,
            ),
          ]),
    ],
  };
};

/**
 * Its own agent stopped mid-turn: a session working since before then waits on your turn, as
 * after a Stop, unless a background subagent wakes it; one waiting on a dialog then (Esc on it)
 * waits on your turn. One moved on after the Esc (a message sent since) stays.
 */
const interrupted = (meta: SessionMeta, i: InterruptInput): SessionStep => {
  const after = Date.parse(i.at) >= Date.parse(meta.since);

  if (meta.state === 'waiting' && meta.waitingOn === 'dialog')
    return after ? dialogGone(meta, i.now) : { meta, events: [] };
  if (meta.state !== 'working' || i.launching || !after || subagentRunning(meta.subagents, i.now))
    return { meta, events: [] };
  const next: SessionMeta = { ...meta, state: 'waiting', since: i.now, waitingOn: 'turn' };

  return {
    meta: next,
    events: [stateEvent(next, INTERRUPTED, { moved: true, turnEnded: true })],
  };
};

const askStep = (meta: SessionMeta, a: AskInput): SessionStep => {
  const asked = a.asked ?? [];
  const closed = a.closed ?? [];
  const replaced = new Set(asked.map((c) => c.id));
  const kept = meta.asks.filter((c) => !closed.includes(c.id));
  const asks = [
    ...(a.back ?? []),
    ...kept.map((c) => asked.find((x) => x.id === c.id) ?? c),
    ...asked.filter((c) => !kept.some((k) => k.id === c.id)),
  ];
  const next: SessionMeta = {
    ...meta,
    asks,
    allowed: a.allow === undefined ? meta.allowed : [...meta.allowed, a.allow],
  };

  return {
    meta: next,
    events: [
      ...(closed.length > 0 && a.answer !== undefined
        ? [answeredEvent(meta, closed, a.answer)]
        : []),
      ...(replaced.size > 0 ? [askEvent(meta, asked)] : []),
    ],
  };
};

/**
 * The session after one input, and what it says: a hook moves its state (and what it waits on,
 * its own turn, its subagents, its cards), an Esc or a dialog gone moves a waiting one to your
 * turn, a card change opens or closes cards. An input that changes nothing says nothing.
 */
export const sessionStep = (meta: SessionMeta, input: SessionInput): SessionStep => {
  switch (input.kind) {
    case 'hook':
      return hookStep(meta, input);
    case 'interrupt':
      return interrupted(meta, input);
    case 'dialog-gone':
      return dialogGone(meta, input.at);
    case 'ask':
      return askStep(meta, input);
  }
};
