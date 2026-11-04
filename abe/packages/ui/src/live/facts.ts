/**
 * Live facts: the one copy of what serve holds that every screen shows (the sessions, the runs,
 * the launches heard, the boxes, the prototypes). The bridge mounts it once: it asks the reads the
 * open screens follow, keeps them current from `abe watch` in place, decides which event means a
 * read again, and hands each screen the same `Facts` as a `live` input. A screen never reads these
 * itself, so two screens never disagree.
 *
 * Pure as a screen is: `(state, input) → { state, commands }`, its commands only `run` reads.
 */
import type {
  BoardChangedEvent,
  BoxIdleData,
  BoxListData,
  CardData,
  CardListData,
  Event,
  EventData,
  FactoryRunData,
  PrototypeData,
  RepoHere,
  SessionData,
} from '@abe/core';
import { BOXES_OFF } from '@abe/core/box-text';
import { hereOf } from '@abe/core/here';
import type { Answer, Command, Input, Refused } from '../runtime/runtime';
import {
  type BoxMoveAt,
  boxesBooting,
  boxesIdled,
  boxesMoved,
  REREAD_MS,
  replayMoves,
} from './box-feed';
import {
  endUnsaid,
  freshSessions,
  type Heard,
  hearing,
  movedSince,
  prUnsaid,
  runMoved,
  runsRead,
  sessionMoved,
  sessionStepped,
  subagentMoved,
} from './live';

/** The whole reads live keeps, each one `abe` command. */
export const LIVE_READS = [
  'sessions',
  'runs',
  'boxes',
  'prototypes',
  'cards:mine',
  'cards:team',
] as const;
export type LiveRead = (typeof LIVE_READS)[number];

/** Each box's last `box.state` move by its name, as the boxes' look names them. */
type BoxMoves = Readonly<Record<string, EventData<'box.state'>['state']>>;

const ARGV: Readonly<Record<LiveRead, readonly string[]>> = {
  sessions: ['session', 'list'],
  runs: ['factory', 'status'],
  boxes: ['box', 'list'],
  prototypes: ['prototype', 'list'],
  // the sprint's done cards too (the Board's Closed column, your closed card stays yours)
  'cards:mine': ['card', 'list', '--mine', '--closed'],
  'cards:team': ['card', 'list', '--closed'],
};

/** The card lists: a write to a card reads them again, and an answer from before it is dropped. */
const CARD_LISTS = ['cards:mine', 'cards:team'] as const satisfies readonly LiveRead[];
type CardList = (typeof CARD_LISTS)[number];
const isCardList = (id: string): id is CardList => CARD_LISTS.some((c) => c === id);

/** One card's runs, read in place of what is held of them. */
const RUN = 'run:';
/** One session, read by its id. */
const SESSION = 'session:';

/** Where a whole read stands. */
export type ReadState = {
  /** A read is out. */
  reading: boolean;
  /** Why the last answer failed, kept until one succeeds; with its code. */
  failed?: { message: string; code: string } | undefined;
  /** The folder the held value was read in; absent: never answered. */
  root?: string | undefined;
  /** How many answers came, so a screen can tell a new one landed. */
  answers: number;
};

/** A launch heard going (`launch.started`), and its session once it answered. */
export type LaunchHeard = { repo: string; session: string | null };

/** What every screen is handed: the same facts at the same moment. */
export type Facts = {
  /** Moves on each change: a screen compares it, never the facts. */
  rev: number;
  /** `session list`, moved in place by the session events. */
  sessions?: SessionData[] | undefined;
  /** `factory status`, moved in place by `factory.stage`. */
  runs?: FactoryRunData[] | undefined;
  /** The repo the last session or run list was read in. */
  here?: RepoHere | undefined;
  /** Why the boxes' sessions were not listed (`session list`'s `boxes`, `boxes.unread`). */
  boxesUnread?: string | undefined;
  /** Launches heard going by card, until their session is listed or they end refused. */
  launches: Readonly<Record<number, LaunchHeard>>;
  /** `box list`, moved in place by `box.state`, `box.step` and `box.idle`. */
  boxList?: BoxListData | undefined;
  /** Each box's last `box.state` since `box list` last named it. */
  boxMoves: BoxMoves;
  /** Each box's idle stop from its last `box.idle`. */
  idles: Readonly<Record<string, BoxIdleData>>;
  /** `box list` refused as boxes off (`serve.target` local, no box profile). */
  boxesOff?: boolean | undefined;
  /** `prototype list`. */
  prototypes?: PrototypeData[] | undefined;
  /**
   * `card list --mine --closed` and `card list --closed`, moved in place by `board.changed` and
   * `factory.card`, read again after a card write: newest change first, as the board lists them.
   */
  mine?: CardListData | undefined;
  team?: CardListData | undefined;
  read: Readonly<Record<LiveRead, ReadState>>;
};

const UNREAD: ReadState = { reading: false, answers: 0 };

export const NO_FACTS: Facts = {
  rev: 0,
  launches: {},
  boxMoves: {},
  idles: {},
  read: {
    sessions: UNREAD,
    runs: UNREAD,
    boxes: UNREAD,
    prototypes: UNREAD,
    'cards:mine': UNREAD,
    'cards:team': UNREAD,
  },
};

export type LiveState = {
  facts: Facts;
  heard?: Heard | undefined;
  /** The shown folder: where the reads run, what `root` in `ReadState` names. */
  root?: string | undefined;
  /** The reads an open screen follows: only these are read, and read again. */
  follows: readonly LiveRead[];
  /** Each read id out, the folders it was asked in, oldest first. */
  out: Readonly<Record<string, readonly (string | undefined)[]>>;
  /** Whole reads to ask again once the one out answers (a burst coalesced into one). */
  again: readonly LiveRead[];
  /** Card lists out from before a card write: their answer is dropped, the one after counts. */
  stale?: readonly CardList[] | undefined;
  /** The `box.state` moves said while `box list` is out: put back on its answer. */
  boxMovesSince?: readonly BoxMoveAt[] | undefined;
  /** When `box list` was last asked (ms): read again quietly every `REREAD_MS`. */
  boxesReadAt?: number | undefined;
  /**
   * A card list that failed is read again by the clock: when (ms), and the wait after that. Let
   * go by the first tick that sees no card list failed, by a read again of a card list, and by
   * another folder shown.
   */
  cardsRetry?: { at: number; wait: number } | undefined;
};

/** What live takes: the watch, its reads' answers, the shown folder, the clock, the screens' asks. */
export type LiveInput =
  /** The watch, its reads' answers, the shown folder, the clock; any other input is not live's. */
  | Input
  /** The reads the open screens follow now. */
  | { kind: 'follow'; reads: readonly LiveRead[] }
  /**
   * Read again: these (all followed when absent). `anew`: a break, so nothing held is kept (what
   * was read may be another serve's).
   */
  | {
      kind: 'reread';
      reads?: readonly LiveRead[] | undefined;
      anew?: boolean | undefined;
      /** The run a launch just answered with: held at once, until the read brings it. */
      ran?: FactoryRunData | undefined;
    };

export const LIVE_INIT: LiveState = { facts: NO_FACTS, follows: [], out: {}, again: [] };

type Out = { state: LiveState; commands: Command[] };

const isWhole = (id: string): id is LiveRead => LIVE_READS.some((r) => r === id);

/** Whether a read with this id is one of live's: a whole list, one card's runs, one session. */
export const isLiveRead = (id: string): boolean =>
  isWhole(id) || /^run:\d+$/.test(id) || (id.startsWith(SESSION) && id.length > SESSION.length);

/** The whole read a read of live's goes with: one card's runs with the runs, one session with the sessions. */
const wholeOf = (id: string): LiveRead | undefined => {
  if (isWhole(id)) return id;
  if (!isLiveRead(id)) return undefined;

  return id.startsWith(RUN) ? 'runs' : 'sessions';
};

/**
 * Whether an answer with this id is live's: one it asked and waits for, or one of its reads it
 * follows (an answer a test hands in unasked). Any other is a screen's own, with the same id.
 */
export const answersLive = (s: LiveState, id: string): boolean => {
  const whole = wholeOf(id);

  return (s.out[id] ?? []).length > 0 || (whole !== undefined && s.follows.includes(whole));
};

const argvOf = (id: string): string[] => {
  if (isWhole(id)) return [...ARGV[id]];
  if (id.startsWith(RUN)) return ['factory', 'status', id.slice(RUN.length)];

  return ['session', 'show', id.slice(SESSION.length)];
};

/** The facts changed: `rev` moves with them. */
const moved = (s: LiveState, f: Partial<Facts>): LiveState => ({
  ...s,
  facts: { ...s.facts, ...f, rev: s.facts.rev + 1 },
});

const withRead = (s: LiveState, id: LiveRead, r: Partial<ReadState>): LiveState =>
  moved(s, { read: { ...s.facts.read, [id]: { ...s.facts.read[id], ...r } } });

const followed = (s: LiveState, id: string): boolean => !isWhole(id) || s.follows.includes(id);

/**
 * Asks `ids`: a whole one already out is asked again once it answers (one more, however many
 * asked meanwhile), so a burst of events reads each list at most twice. `written`: a card was
 * written, so a card list out answers from before it and is dropped for the one asked after.
 */
const ask = (s: LiveState, ids: readonly string[], o: { written?: boolean } = {}): Out => {
  let next = s;
  const commands: Command[] = [];

  for (const id of new Set(ids)) {
    if (!followed(next, id)) continue;
    if ((next.out[id] ?? []).length > 0) {
      if (isWhole(id) && !next.again.includes(id)) next = { ...next, again: [...next.again, id] };
      // a card written meanwhile: what it answers is from before
      if (o.written === true && isCardList(id) && !(next.stale ?? []).includes(id))
        next = { ...next, stale: [...(next.stale ?? []), id] };
      continue;
    }
    next = { ...next, out: { ...next.out, [id]: [next.root] } };
    if (isWhole(id)) {
      next = withRead(next, id, { reading: true });
      if (id === 'boxes') next = { ...next, boxMovesSince: [] };
    }
    commands.push({ kind: 'run', id, argv: argvOf(id) });
  }

  return { state: next, commands };
};

/** Asked again in another folder while out: asked there too, its older answer let go. */
const askAgainHere = (s: LiveState, id: LiveRead): Out => {
  if (!followed(s, id)) return { state: s, commands: [] };
  const out = s.out[id] ?? [];

  if (out.length === 0) return ask(s, [id]);
  if (out.at(-1) === s.root) return { state: s, commands: [] };

  return {
    state: withRead({ ...s, out: { ...s.out, [id]: [...out, s.root] } }, id, { reading: true }),
    commands: [{ kind: 'run', id, argv: argvOf(id) }],
  };
};

/** A launch heard whose session is listed now: no longer Launching. */
const launchesListed = (
  launches: Facts['launches'],
  sessions: readonly SessionData[],
): Facts['launches'] => {
  const listed = new Set(sessions.map((x) => x.id));
  const left = Object.entries(launches).filter(
    ([, l]) => l.session === null || !listed.has(l.session),
  );

  return left.length === Object.keys(launches).length ? launches : Object.fromEntries(left);
};

/** The answer of a read out: let go, and whether it was asked in the folder shown now. */
const answeredOut = (s: LiveState, id: string): { state: LiveState; here: boolean } => {
  const [first, ...rest] = s.out[id] ?? [];
  const out = Object.fromEntries(Object.entries(s.out).filter(([k]) => k !== id));

  if (rest.length > 0) out[id] = rest;

  return { state: { ...s, out }, here: first === s.root };
};

const answered = (s0: LiveState, input: Answer | Refused): Out => {
  const id = input.id;
  const { state: s, here } = answeredOut(s0, id);
  const whole = isWhole(id) ? id : undefined;
  const still = (s.out[id] ?? []).length > 0;
  const read = (n: LiveState, r: Partial<ReadState>) =>
    whole === undefined ? n : withRead(n, whole, { reading: still, ...r });

  // asked in a folder shown before, another ask out: that newer one's answer counts
  if (!here && still) return { state: s, commands: [] };
  // a card list from before a card write: the one asked after it counts
  if (isCardList(id) && (s.stale ?? []).includes(id))
    return again({ ...s, stale: (s.stale ?? []).filter((x) => x !== id) }, id);
  if (!input.reply.ok) {
    const failed = { message: input.reply.error.message, code: input.reply.error.code };
    let next = read(s, { failed });

    if (whole === 'boxes')
      next = moved(next, { boxesOff: input.reply.error.code === BOXES_OFF.code });
    // a session not shown by its id (one found on a followed box): the whole list
    if (id.startsWith(SESSION)) return ask(next, ['sessions']);

    return again(next, whole);
  }
  const answers = whole === undefined ? 0 : s.facts.read[whole].answers + 1;
  const ok = read(s, { failed: undefined, root: s.root, answers });
  const f = ok.facts;
  const newer = movedSince(s0.heard, id);
  if (input.command === null) return again(ok, whole);
  switch (input.command) {
    case 'session list': {
      const sessions = freshSessions(f.sessions, input.reply.data.sessions, newer);

      return again(
        moved(ok, {
          sessions,
          ...hereOf(input.reply.data),
          boxesUnread: input.reply.data.boxes,
          launches: launchesListed(f.launches, sessions),
        }),
        whole,
      );
    }
    case 'session show': {
      const one = input.reply.data;
      const fresh = freshSessions(f.sessions, [one], newer);
      const sessions = [...(f.sessions ?? []).filter((x) => x.id !== one.id), ...fresh];

      return {
        state: moved(ok, { sessions, launches: launchesListed(f.launches, sessions) }),
        commands: [],
      };
    }
    case 'factory status':
      return again(
        moved(ok, {
          runs: runsRead(f.runs, id, input.reply.data.runs, s0.heard),
          ...hereOf(input.reply.data),
        }),
        whole,
      );
    case 'box list': {
      // the list is newer than the moves of the boxes it names, but for those said while out
      const since = s.boxMovesSince ?? [];
      const later = new Set(since.map((m) => m.box));
      const named = new Set([
        ...input.reply.data.boxes.map((b) => b.name),
        ...input.reply.data.queued.map((q) => q.box),
      ]);
      const boxMoves = Object.fromEntries(
        Object.entries(f.boxMoves).filter(([name]) => !named.has(name) || later.has(name)),
      );
      const boxList = { ...input.reply.data, boxes: replayMoves(input.reply.data.boxes, since) };

      return again(
        { ...moved(ok, { boxList, boxMoves, boxesOff: undefined }), boxMovesSince: undefined },
        whole,
      );
    }
    case 'prototype list':
      return again(moved(ok, { prototypes: input.reply.data.prototypes }), whole);
    case 'card list':
      return again(
        moved(ok, id === 'cards:mine' ? { mine: input.reply.data } : { team: input.reply.data }),
        whole,
      );
    default:
      return again(ok, whole);
  }
};

/** A whole read asked again while it was out: asked now. */
const again = (s: LiveState, id: LiveRead | undefined): Out => {
  if (id === undefined || !s.again.includes(id) || (s.out[id] ?? []).length > 0)
    return { state: s, commands: [] };

  return ask({ ...s, again: s.again.filter((x) => x !== id) }, [id]);
};

const known = (s: LiveState, session: string) =>
  s.facts.sessions?.some((x) => x.id === session) === true;

/** The session list moved by `f`, or that one session read when it is not held. */
const sessionEvent = (
  s: LiveState,
  id: string,
  f: (sessions: SessionData[]) => SessionData[],
  also: readonly string[] = [],
): Out => {
  const sessions = s.facts.sessions;

  if (sessions === undefined) return { state: s, commands: [] };
  if (!known(s, id)) return ask(s, [`${SESSION}${id}`, ...also]);

  return { state: moved(s, { sessions: f(sessions) }), commands: [] };
};

/** The watch's events live moves its facts on or reads again after: `onEvent`'s. */
export const LIVE_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'launch.started',
  'launch.ended',
  'factory.stage',
  'factory.card',
  'session.state',
  'session.step',
  'session.subagent',
  'session.moved',
  'session.titled',
  'session.override',
  'boxes.unread',
  'box.state',
  'box.step',
  'box.idle',
  'prototype.state',
  'prototype.saved',
  'command.ran',
  'settings.changed',
  'board.changed',
]);

/** The verbs of `abe card` that change what a card list shows. */
const CARD_WRITES = new Set(['create', 'move', 'tag', 'assign']);

/**
 * A command that changed a card list: a card made, moved, tagged, assigned, or triage applied; a
 * refused one changed nothing.
 */
const cardWritten = (d: { noun: string; verb: string | null; exit: number }): boolean =>
  d.exit === 0 &&
  ((d.noun === 'card' && d.verb !== null && CARD_WRITES.has(d.verb)) ||
    (d.noun === 'triage' && d.verb === 'apply'));

/**
 * A card list with a `board.changed` in: each changed card first in its new place (Mine's only
 * when it is yours now), those the board lists no more taken off; another board's: as it was.
 */
const boardMoved = (
  l: CardListData | undefined,
  d: BoardChangedEvent,
  mine: boolean,
): CardListData | undefined => {
  const b = l?.board;

  if (l === undefined || b === undefined) return l;
  if (b.organization !== d.board.organization || b.project !== d.board.project) return l;
  if (b.team !== d.board.team) return l;
  const ids = new Set([...d.cards.map((c) => c.card.id), ...d.gone]);
  const now: CardData[] = d.cards.flatMap((c) => (!mine || c.mine ? [c.card] : []));

  return { ...l, cards: [...now, ...l.cards.filter((c) => !ids.has(c.id))] };
};

/** A command that moved a prototype (`prototype start`, `stop`, …): the list again. */
const prototypeRan = (d: { noun: string; verb: string | null }): boolean =>
  d.noun === 'prototype' && d.verb !== null && d.verb !== 'list' && d.verb !== 'show';

const onEvent = (s: LiveState, event: Event): Out => {
  const f = s.facts;

  switch (event.type) {
    case 'serve.started':
    case 'watch.gap':
      // the launches heard: serve's own gone with it, or their end among the events gone
      return ask(moved(s, { launches: {} }), s.follows);
    case 'launch.started': {
      const d = event.data;

      return {
        state: moved(s, { launches: { ...f.launches, [d.card]: { repo: d.repo, session: null } } }),
        commands: [],
      };
    }
    case 'launch.ended': {
      const d = event.data;
      const others = Object.fromEntries(
        Object.entries(f.launches).filter(([c]) => Number(c) !== d.card),
      );

      if (d.refused !== null || d.session === null)
        return { state: moved(s, { launches: others }), commands: [] };
      // launched: Launching until its session is listed
      const launches = { ...others, [d.card]: { repo: d.repo, session: d.session } };
      const next = moved(s, { launches: launchesListed(launches, f.sessions ?? []) });

      return f.sessions === undefined || known(s, d.session)
        ? { state: next, commands: [] }
        : ask(next, [`${SESSION}${d.session}`]);
    }
    case 'factory.stage': {
      const d = event.data;
      const runs = f.runs;

      if (runs === undefined) return { state: s, commands: [] };
      if (d.cause === 'cleared')
        return {
          state: moved(s, { runs: runs.filter((r) => r.session !== d.session) }),
          commands: [],
        };
      const had = runs.find((r) => r.session === d.session);

      if (had === undefined) return ask(s, [`${RUN}${d.card}`]);
      const next = moved(s, { runs: runs.map((r) => (r === had ? runMoved(had, d) : r)) });

      return prUnsaid(d) || endUnsaid(d)
        ? ask(next, [`${RUN}${d.card}`])
        : { state: next, commands: [] };
    }
    case 'session.state': {
      const d = event.data;
      // a launch's session starting before its run is held: that card's runs too
      const run =
        (d.state === 'starting' || d.state === 'queued') &&
        d.card !== null &&
        !(f.runs ?? []).some((r) => r.session === d.id)
          ? [`${RUN}${d.card}`]
          : [];

      return sessionEvent(s, d.id, (x) => sessionMoved(x, d), run);
    }
    case 'session.step': {
      const d = event.data;

      return known(s, d.id)
        ? sessionEvent(s, d.id, (x) => sessionStepped(x, d))
        : { state: s, commands: [] };
    }
    case 'session.subagent': {
      const d = event.data;

      return sessionEvent(s, d.id, (x) => subagentMoved(x, d, event.at));
    }
    case 'session.moved': {
      // downloaded or moved to cloud: Local or Cloud from now on, in its new worktree
      const d = event.data;

      return sessionEvent(s, d.id, (x) =>
        x.map((one) => {
          if (one.id !== d.id) return one;
          const next = { ...one, worktree: d.worktree };

          if (d.to === 'cloud') return { ...next, box: d.box };
          delete next.box;

          return next;
        }),
      );
    }
    case 'session.titled': {
      // an Abe chat conversation named
      const d = event.data;

      return known(s, d.id)
        ? sessionEvent(s, d.id, (x) =>
            x.map((one) =>
              one.id === d.id && one.abe !== undefined && one.abe !== null
                ? { ...one, abe: { ...one.abe, name: d.title } }
                : one,
            ),
          )
        : { state: s, commands: [] };
    }
    case 'session.override':
      // its override rows: the session as serve has it now
      return f.sessions === undefined
        ? { state: s, commands: [] }
        : ask(s, [`${SESSION}${event.data.id}`]);
    case 'boxes.unread':
      return { state: moved(s, { boxesUnread: event.data.message }), commands: [] };
    case 'box.state': {
      const at = Date.parse(event.at);
      const reading = (s.out.boxes ?? []).length > 0;
      const base: LiveState = {
        ...moved(s, { boxMoves: { ...f.boxMoves, [event.data.box]: event.data.state } }),
        ...(reading ? { boxMovesSince: [...(s.boxMovesSince ?? []), { ...event.data, at }] } : {}),
      };

      if (f.boxList === undefined) return { state: base, commands: [] };
      const boxes = boxesMoved(f.boxList.boxes, event.data, at);

      return boxes === 'read'
        ? ask(base, ['boxes'])
        : { state: moved(base, { boxList: { ...f.boxList, boxes } }), commands: [] };
    }
    case 'box.step': {
      // EC2 runs it, its serve not answering yet: booting
      if (event.data.step !== 'booting') return { state: s, commands: [] };
      const reading = (s.out.boxes ?? []).length > 0;

      // no list yet: the one out is asked again, its answer may be from before the boot
      if (f.boxList === undefined) return reading ? ask(s, ['boxes']) : { state: s, commands: [] };
      const boxes = boxesBooting(f.boxList.boxes, event.data.box, Date.parse(event.at));

      if (boxes === undefined) return { state: s, commands: [] };
      const next = moved(s, { boxList: { ...f.boxList, boxes } });

      return reading ? ask(next, ['boxes']) : { state: next, commands: [] };
    }
    case 'box.idle': {
      const boxes = f.boxList === undefined ? undefined : boxesIdled(f.boxList.boxes, event.data);

      return {
        state: moved(s, {
          idles: { ...f.idles, [event.data.box]: event.data.idle },
          ...(f.boxList === undefined || boxes === undefined
            ? {}
            : { boxList: { ...f.boxList, boxes } }),
        }),
        commands: [],
      };
    }
    case 'prototype.state':
    case 'prototype.saved':
      return ask(s, ['prototypes']);
    case 'command.ran': {
      // written (`triage apply` tags its cards needs-info) // a prototype started, stopped, discarded (the Abe chat's `/abe:prototype` too); a card
      const protos = ask(s, prototypeRan(event.data) ? ['prototypes'] : []);
      const cards = ask(protos.state, cardWritten(event.data) ? CARD_LISTS : [], {
        written: true,
      });

      return { state: cards.state, commands: [...protos.commands, ...cards.commands] };
    }
    case 'settings.changed':
      // the board in the settings (an install wrote it to abe.yaml): its cards
      return event.data.keys.includes('board') ? ask(s, CARD_LISTS) : { state: s, commands: [] };
    case 'board.changed': {
      // a teammate's change on Azure DevOps: only the changed cards, as serve read them
      const mine = boardMoved(f.mine, event.data, true);
      const team = boardMoved(f.team, event.data, false);

      return mine === f.mine && team === f.team
        ? { state: s, commands: [] }
        : { state: moved(s, { mine, team }), commands: [] };
    }
    case 'factory.card': {
      // serve moved a run's card on the board: on top of its new column, as the board lists it
      const d = event.data;

      if (d.error !== null || (f.mine === undefined && f.team === undefined))
        return { state: s, commands: [] };
      const to = (l: CardListData | undefined) =>
        l === undefined
          ? undefined
          : {
              ...l,
              cards: [
                ...l.cards.filter((c) => c.id === d.card).map((c) => ({ ...c, state: d.state })),
                ...l.cards.filter((c) => c.id !== d.card),
              ],
            };

      return { state: moved(s, { mine: to(f.mine), team: to(f.team) }), commands: [] };
    }
    default:
      return { state: s, commands: [] };
  }
};

/** The first wait before a card list that failed is read again; it doubles up to 2 min. */
const CARDS_RETRY_MS = 15_000;
const CARDS_RETRY_MAX_MS = 2 * 60_000;

/** Nothing waiting to be read again: the next failure starts the wait anew. */
const withoutRetry = (s: LiveState): LiveState => {
  if (s.cardsRetry === undefined) return s;
  const rest = { ...s };

  delete rest.cardsRetry;

  return rest;
};

/**
 * The card lists read again by the clock while one failed, so a board that did not answer comes
 * back by itself: the first tick that sees it waits `CARDS_RETRY_MS`, then each read again doubles
 * the wait, at most 2 min (timed from when it was asked; one still out is not asked again).
 */
const cardsRetried = (s: LiveState, t: number): Out => {
  const failed = CARD_LISTS.filter((id) => s.facts.read[id].failed !== undefined);

  if (failed.length === 0) return { state: withoutRetry(s), commands: [] };
  const retry = s.cardsRetry ?? { at: t + CARDS_RETRY_MS, wait: CARDS_RETRY_MS };
  const ids = t >= retry.at ? failed.filter((id) => (s.out[id] ?? []).length === 0) : [];

  if (ids.length === 0) return { state: { ...s, cardsRetry: retry }, commands: [] };
  const wait = Math.min(retry.wait * 2, CARDS_RETRY_MAX_MS);

  return ask({ ...s, cardsRetry: { at: t + wait, wait } }, ids);
};

/**
 * The clock: `box list` again quietly once `REREAD_MS` passed since it was asked; a card list
 * that failed again on its backoff.
 */
const ticked = (s: LiveState, at: string): Out => {
  const t = Date.parse(at);
  const since = s.boxesReadAt ?? t;
  const boxes =
    !s.follows.includes('boxes') || t - since < REREAD_MS
      ? { state: s.boxesReadAt === undefined ? { ...s, boxesReadAt: t } : s, commands: [] }
      : ask({ ...s, boxesReadAt: t }, ['boxes']);
  const cards = cardsRetried(boxes.state, t);

  return { state: cards.state, commands: [...boxes.commands, ...cards.commands] };
};

/** The reads no open screen follows any more are let go: followed again, they are read anew. */
const unfollowed = (s: LiveState, reads: readonly LiveRead[]): LiveState => {
  const gone = s.follows.filter((r) => !reads.includes(r));

  if (gone.length === 0) return { ...s, follows: reads };
  const f: Partial<Facts> = {};

  for (const r of gone) {
    if (r === 'sessions') f.sessions = undefined;
    if (r === 'runs') f.runs = undefined;
    if (r === 'boxes') f.boxList = undefined;
    if (r === 'prototypes') f.prototypes = undefined;
    if (r === 'cards:mine') f.mine = undefined;
    if (r === 'cards:team') f.team = undefined;
  }
  const was = s.facts.read;
  const heldOf = (r: LiveRead): ReadState =>
    gone.includes(r) ? { ...UNREAD, reading: was[r].reading } : was[r];
  const read = {
    sessions: heldOf('sessions'),
    runs: heldOf('runs'),
    boxes: heldOf('boxes'),
    prototypes: heldOf('prototypes'),
    'cards:mine': heldOf('cards:mine'),
    'cards:team': heldOf('cards:team'),
  };

  return { ...moved(s, { ...f, read }), follows: reads };
};

const stepLive = (s: LiveState, input: LiveInput): Out => {
  switch (input.kind) {
    case 'follow': {
      const reads = LIVE_READS.filter((r) => input.reads.includes(r));
      const before = s.follows;
      const next = unfollowed(s, reads);

      return ask(
        next,
        reads.filter((r) => !before.includes(r) && !next.facts.read[r].reading),
      );
    }
    case 'reread': {
      const reads = (input.reads ?? s.follows).filter((r) => s.follows.includes(r));
      // a card list read again (`r`, a view shown again): a wait grown while it failed starts anew
      const asked = reads.some(isCardList) ? withoutRetry(s) : s;

      if (input.anew !== true) {
        const ran = input.ran;
        const held =
          ran === undefined
            ? asked
            : moved(asked, {
                runs: [...(asked.facts.runs ?? []).filter((r) => r.session !== ran.session), ran],
              });

        return ask(held, reads);
      }
      // a break: what was read may be another serve's
      const fresh: LiveState = {
        ...LIVE_INIT,
        root: s.root,
        follows: s.follows,
        facts: { ...NO_FACTS, rev: s.facts.rev + 1 },
      };

      return ask(fresh, reads);
    }
    case 'root': {
      if (input.root === s.root) return { state: s, commands: [] };
      // another folder: its card lists' wait starts anew

      return s.follows.reduce<Out>(
        (acc, r) => {
          const one = askAgainHere(acc.state, r);

          return { state: one.state, commands: [...acc.commands, ...one.commands] };
        },
        { state: { ...withoutRetry(s), root: input.root }, commands: [] },
      );
    }
    case 'tick':
      return ticked(s, input.at);
    case 'event':
      return onEvent(s, input.event);
    case 'result':
      return answersLive(s, input.id) ? answered(s, input) : { state: s, commands: [] };
    default:
      return { state: s, commands: [] };
  }
};

/** Live's step, with what it heard of the watch so a late read never takes a move back. */
export const liveStep = hearing(stepLive);
