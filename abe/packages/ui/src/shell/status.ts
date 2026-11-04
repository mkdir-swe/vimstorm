/**
 * The `status` screen: what this `serve` holds, from `abe status` and the live sessions. It reads
 * its status again on `r` (or a click on its key hint, the sessions too), when a session's state
 * moves, and when `serve` answered any other command (`command.ran`; its own reads do not count,
 * or it would loop).
 */
import type { Event, SessionData, StatusData } from '@abe/core';
import type { Facts } from '../live';
import { waitsOnYou } from '@abe/core/waits-on';
import {
  agentStatus,
  type AgentState,
  empty,
  island,
  type Node,
  stack,
} from '../runtime/components';
import {
  type Answer,
  type Command,
  type Input,
  type Refused,
  type Screen,
} from '../runtime/runtime';

export type StatusState = {
  status?: StatusData;
  /** The live sessions, shown while serve answers. */
  sessions?: SessionData[];
  /** The live facts last handed. */
  facts?: Facts;
  /** The last command `serve` answered for anyone (`command.ran`), but the screen's own reads. */
  last?: string;
  /** Why the last read failed; kept until one succeeds. */
  failed?: string;
  /** Reads asked and not answered yet. */
  reading: number;
  /** A reason to read again came while reading: once the reads are in, read again. */
  again: boolean;
};

const READS: readonly Command[] = [{ kind: 'run', id: 'status', argv: ['status'] }];

/** The commands whose `command.ran` the screen ignores: its own reads. */
const OWN = new Set(['status', 'session list']);

/** `r`: its status, and the live sessions, read again. */
const rereadAll = (state: StatusState): { state: StatusState; commands: Command[] } => {
  const asked = reread(state);

  return {
    state: asked.state,
    commands: [...asked.commands, { kind: 'live', reads: ['sessions'] }],
  };
};

const reread = (state: StatusState): { state: StatusState; commands: Command[] } =>
  state.reading > 0
    ? { state: { ...state, again: true }, commands: [] }
    : { state: { ...state, reading: READS.length, again: false }, commands: [...READS] };

/** Whether an event may have changed what the screen shows. */
export const moves = (event: Event): boolean => {
  if (event.type === 'command.ran') {
    const { noun, verb } = event.data;

    return !OWN.has(verb === null ? noun : `${noun} ${verb}`);
  }

  return event.type === 'session.state' || event.type === 'serve.started';
};

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A session's state as AgentStatus says it (5-states.md: Queued is a dim word of its own). */
const AGENT: Readonly<Record<SessionData['state'], { state: AgentState; word?: string }>> = {
  starting: { state: 'starting' },
  queued: { state: 'idle', word: 'Queued' },
  working: { state: 'running' },
  waiting: { state: 'needs-you' },
  ended: { state: 'ended' },
};

/** Waiting on its turn alone: idle, your turn (`waitsOnYou`), never Needs you. */
const IDLE_TURN = { state: 'idle', word: 'Idle' } as const;

const sessionStatus = (s: Pick<SessionData, 'state' | 'waitingOn'>): Node => {
  const a = s.state === 'waiting' && !waitsOnYou(s) ? IDLE_TURN : AGENT[s.state];
  const shown = agentStatus(a.state);

  return { ...shown, props: { ...shown.props, word: a.word ?? shown.props.word } };
};

/** The live sessions, while serve answers (what one that no longer answers held is not shown). */
const withSessions = (state: StatusState, f: Facts): StatusState => {
  const next: StatusState = { ...state, facts: f };

  if (state.status === undefined || f.sessions === undefined) delete next.sessions;
  else next.sessions = f.sessions;

  return next;
};

const answered = (state: StatusState, input: Answer | Refused): StatusState => {
  const reading = Math.max(0, state.reading - 1);

  if (!input.reply.ok) {
    const next: StatusState = { ...state, reading, failed: input.reply.error.message };

    // What a serve that no longer answers held is not shown as if it still did.
    if (input.command === 'status') {
      delete next.status;
      delete next.sessions;
    }

    return next;
  }
  if (input.command === 'status') {
    const next: StatusState = { ...state, reading, status: input.reply.data };

    delete next.failed;

    return next.facts === undefined ? next : withSessions(next, next.facts);
  }
  return { ...state, reading };
};

const stepStatus = (
  state: StatusState,
  input: Input,
): { state: StatusState; commands: Command[] } => {
  switch (input.kind) {
    case 'open':
      return reread(state);
    case 'key':
      return input.key === 'r' ? rereadAll(state) : { state, commands: [] };
    case 'click':
      return input.id === 'reload' ? rereadAll(state) : { state, commands: [] };
    case 'live':
      return { state: withSessions(state, input.facts), commands: [] };
    case 'event': {
      if (!moves(input.event)) return { state, commands: [] };
      const event = input.event;
      const last =
        event.type === 'command.ran'
          ? `abe ${event.data.verb === null ? event.data.noun : `${event.data.noun} ${event.data.verb}`}, exit ${event.data.exit}`
          : state.last;

      return reread(last === undefined ? state : { ...state, last });
    }
    case 'result': {
      const next = answered(state, input);

      // (who needs you and what runs are the ear's, #240: this screen sets no widgets)
      if (next.reading > 0 || !next.again) return { state: next, commands: [] };

      return reread({ ...next, again: false });
    }
    default:
      return { state, commands: [] };
  }
};

const reload: Node = {
  kind: 'KeyHint',
  id: 'reload',
  props: { keys: 'r', label: 'reload', context: 'footer' },
};

const serveIsland = (status: StatusData, last: string | undefined): Node =>
  island(
    [
      stack('column', [
        { kind: 'ToolWindowHeader', props: { title: 'abe serve' } },
        {
          kind: 'ListRow',
          props: { text: 'Version', note: status.version },
          children: [{ kind: 'Badge', props: { text: '✓ answering', hue: 'good' } }],
        },
        { kind: 'ListRow', props: { text: 'Process', note: `pid ${status.pid}` } },
        { kind: 'ListRow', props: { text: 'Started', note: status.startedAt } },
        {
          kind: 'ListRow',
          props: {
            text: 'Holds',
            note: `${count(status.sessions, 'session')}, ${count(status.workspaces, 'workspace')}`,
          },
        },
        { kind: 'ListRow', props: { text: 'Socket', dim: status.socket } },
        ...(last === undefined
          ? []
          : [{ kind: 'ListRow' as const, props: { text: 'Last command', note: last } }]),
      ]),
    ],
    'serve',
  );

const sessionRow = (s: SessionData): Node => ({
  kind: 'ListRow',
  id: `session:${s.id}`,
  // an Improve retro chat (#87) has no card: its title says what it is
  props: { text: s.card === null ? s.title : `#${s.card} ${s.title}`, dim: s.repo, note: s.branch },
  children: [sessionStatus(s)],
});

const sessionsIsland = (sessions: readonly SessionData[]): Node =>
  island(
    [
      stack(
        'column',
        [
          { kind: 'ToolWindowHeader', props: { title: 'Sessions', count: sessions.length } },
          ...(sessions.length === 0
            ? [empty('No sessions', 'abe session launch starts one.')]
            : sessions.map(sessionRow)),
        ],
        { sizes: ['auto', ...(sessions.length === 0 ? [{ flex: 1 }] : [])] },
      ),
    ],
    'sessions',
  );

export const viewStatus = (state: StatusState): Node => {
  if (state.status === undefined)
    return island(
      [
        stack(
          'column',
          [
            state.failed === undefined
              ? empty('Asking abe serve', 'Its status and sessions show once it answers.')
              : empty('abe serve is not answering', state.failed),
            reload,
          ],
          { sizes: [{ flex: 1 }, 'auto'] },
        ),
      ],
      'status',
    );

  return stack(
    'column',
    [serveIsland(state.status, state.last), sessionsIsland(state.sessions ?? []), reload],
    { sizes: ['auto', { flex: 1 }, 'auto'], gap: 3 },
  );
};

/** The watch's events it takes: serve's and the sessions' moves; any other never re-views it. */
const STATUS_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'command.ran',
  'session.state',
]);

export const statusScreen: Screen<StatusState> = {
  events: STATUS_EVENTS,
  name: 'status',
  init: { reading: 0, again: false },
  step: stepStatus,
  view: viewStatus,
  follows: () => ['sessions'],
};
