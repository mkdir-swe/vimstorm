/**
 * The CLI's progress line while a command waits. Within a second of asking, one line on stderr
 * says what it waits for and for how long, moved on by the events `serve` streams beside the answer
 * (`Request.progress`). This holds what a command waits on and the words of each step; the `abe`
 * client draws the line.
 */
import { boxName, splitOn } from '../box';
import { parseCardId } from '../board';
import { elapsedText } from '../command';
import { BOX_STEP_WORDS, type Event } from './events';
import { parse } from './parse';

/** The events a progress line is moved on by: `serve` streams only these beside the answer. */
export const PROGRESS_EVENTS: ReadonlySet<Event['type']> = new Set([
  'box.state',
  'box.step',
  'session.state',
]);

/** What a waiting command is about: the line's name, its first words, and what moves it. */
export type ProgressSubject = {
  /** Before the colon: the box, the session, the card or the command. */
  name: string;
  /** What it does until an event says more. */
  words: string;
  /** The box its events name (exactly), or a card's box (`<repo>-<card>`, by its tail). */
  box?: { name: string } | { card: number };
  /** The session its `session.state` names, or the card's (a launch's id is not known before). */
  session?: { id: string } | { card: number };
};

const BOX_VERBS: Readonly<Record<string, string>> = {
  start: 'waking',
  stop: 'stopping',
  status: 'reading EC2 and its abe serve',
  keep: 'keeping it awake (a sleeping one is woken first)',
  sleep: 'letting it sleep',
  terminate: 'terminating',
  resize: 'resizing (stop, change, start)',
};

const SESSION_VERBS: Readonly<Record<string, string>> = {
  download: 'downloading to this machine',
  'move-to-cloud': 'moving to its box',
  stop: 'stopping',
  send: 'sending',
  show: 'reading',
};

/** The card a session id names (`901-a3b8`: 901). */
const cardOfSession = (id: string): number | undefined => {
  const head = /^(\d+)-/.exec(id)?.[1];

  return head === undefined ? undefined : Number(head);
};

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * What `argv` waits on, when it is a command that may wait past a second: box
 * commands, launches and moves, and anything sent `--on` a box; undefined for the rest.
 */
export const progressOf = (argv: readonly string[]): ProgressSubject | undefined => {
  const on = splitOn(argv);

  if (!on.ok) return undefined;
  if (on.on !== undefined)
    return {
      name: on.on,
      words: 'reaching its abe serve (a sleeping box is woken first)',
      box: { name: on.on },
    };
  const parsed = parse(argv);

  if (!parsed.ok || parsed.global.json || parsed.global.help) return undefined;
  const a = parsed.args;
  const [noun, verb] = parsed.id.split(' ');
  const box = str(a.box);

  if (noun === 'box' && verb === 'list')
    return { name: 'your boxes', words: 'reading EC2 and each running box' };
  if (noun === 'box' && verb !== undefined && box !== undefined && BOX_VERBS[verb] !== undefined)
    return { name: box, words: BOX_VERBS[verb], box: { name: box } };
  if (noun === 'box' && (verb === 'up' || verb === 'place')) {
    const card = parseCardId(str(a.card) ?? '');
    const repo = str(a.repo);

    if (card === undefined) return undefined;
    if (verb === 'place' && a.apply !== true) return { name: `AB#${card}`, words: 'placing' };

    return {
      // The repo's box (ADR 0022); one of another name (a clash's hex) is said by its own events.
      name: repo?.includes('/') === true ? boxName(repo) : `AB#${card}`,
      words: 'placing its box',
      box: repo?.includes('/') === true ? { name: boxName(repo) } : { card },
    };
  }
  if ((noun === 'session' && verb === 'launch') || (noun === 'factory' && verb === 'run')) {
    const card = parseCardId(str(a.card) ?? '');

    return card === undefined
      ? undefined
      : { name: `AB#${card}`, words: 'launching', box: { card }, session: { card } };
  }
  const id = str(a.id);

  if (
    noun === 'session' &&
    verb !== undefined &&
    id !== undefined &&
    SESSION_VERBS[verb] !== undefined
  ) {
    const card = cardOfSession(id);

    return {
      name: id,
      words: SESSION_VERBS[verb],
      session: { id },
      ...(card === undefined ? {} : { box: { card } }),
    };
  }

  return undefined;
};

const boxMatches = (want: ProgressSubject['box'], box: string) =>
  want !== undefined && ('name' in want ? want.name === box : box.endsWith(`-${want.card}`));

const BOX_MOVE_WORDS: Readonly<Record<string, string>> = {
  queued: 'queued: no room under limits.maxBoxesPerPerson',
  starting: 'starting (EC2 pending)',
  running: 'running, its abe serve answers',
  stopping: 'stopping (EC2)',
  stopped: 'stopped',
  failed: 'failed',
  terminated: 'terminated',
};

const SESSION_WORDS: Readonly<Record<string, string>> = {
  queued: 'queued: no room under limits.maxBoxesPerPerson, starts when a box of yours stops',
  starting: 'starting',
  working: 'Claude Code working',
  waiting: 'waiting on you',
  ended: 'ended',
};

const LAUNCH_CAUSES: ReadonlySet<string> = new Set(['launch', 'queued']);

/**
 * The subject once `event` names the launch's session: its later states are followed by
 * its id alone. Unchanged for any other event.
 */
export const progressNarrowed = (subject: ProgressSubject, event: Event): ProgressSubject =>
  event.type === 'session.state' &&
  subject.session !== undefined &&
  'card' in subject.session &&
  progressStep(subject, event) !== undefined
    ? { ...subject, session: { id: event.data.id } }
    : subject;

/** The line's next words after `event`; undefined: it is not this command's. */
export const progressStep = (subject: ProgressSubject, event: Event): string | undefined => {
  switch (event.type) {
    case 'box.state':
      return boxMatches(subject.box, event.data.box) ? BOX_MOVE_WORDS[event.data.state] : undefined;
    case 'box.step':
      return boxMatches(subject.box, event.data.box)
        ? `${event.data.box === subject.name ? '' : `${event.data.box} `}${BOX_STEP_WORDS[event.data.step]}`
        : undefined;
    case 'session.state': {
      const want = subject.session;

      if (want === undefined) return undefined;
      // Before its id is known, only a new session's first state on the card is the launch's:
      // another session on the card (an older one waiting) moves on its own.
      const mine =
        'id' in want
          ? event.data.id === want.id
          : event.data.card === want.card && LAUNCH_CAUSES.has(event.data.cause);

      return mine
        ? `${event.data.id} ${event.data.state === 'waiting' && event.data.waitingOn === 'turn' ? 'idle, your turn' : (SESSION_WORDS[event.data.state] ?? event.data.state)}`
        : undefined;
    }
    default:
      return undefined;
  }
};

/** The line as drawn: `demo-shop-3: starting (EC2 pending)… 0:04`. */
export const progressLine = (subject: ProgressSubject, words: string, elapsedMs: number): string =>
  `${subject.name}: ${words}… ${elapsedText(elapsedMs)}`;
