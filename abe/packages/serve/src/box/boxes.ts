/**
 * Your boxes from the Mac (#56, #90; spec #37, ADR 0021: one Workspace, one box, an EC2 instance
 * of your own): the local `serve` fronts them. It lists them through the `Boxes` port (each
 * running one's workspace from its own `abe status`), makes, starts and stops them, forwards
 * `abe --on <box> …` to a box's `serve` over the link (waking a sleeping box first, `box.state`
 * events `starting` then `running` once its `serve` answers), and fans `session list` out to
 * every running box. A box holding an open session has its events followed and merged into this
 * `serve`'s stream, each tagged with its box; a dropped link reconnects with `--since`, so no
 * event is lost. A box is followed only while it holds an open session: an open connection is
 * someone there to its idle stop (#92), so an idle one still sleeps. `box list` says each box's
 * release, uptime and today's cost from the uptime log (`box-uptime.ts`), and `box keep` /
 * `box sleep` set the awake keep on the box's own `serve` (#104); `box terminate` deletes one.
 */
import { z } from 'zod';
import {
  abeSkewed,
  type BoxAws,
  abeSkewText,
  abeWokeText,
  type Answered,
  type Box,
  BOX_COUNTED,
  boxCostToday,
  type BoxData,
  type BoxReach,
  boxReachOfState,
  boxReachText,
  BoxKeepData,
  boxLimitMessage,
  boxStopRefusal,
  boxUp,
  BOXES_OFF,
  type Boxes,
  type BoxLink,
  type BoxListData,
  type BoxSpec,
  type Clock,
  envelope,
  type ErrorBody,
  EXIT,
  Event,
  EventLine,
  type EventData,
  boxName,
  repoBox,
  repoBoxName,
  boxSpec,
  coreDefaults,
  parseCardId,
  parseRepo,
  type ExitCode,
  type Handlers,
  isEventType,
  parse,
  type Journal,
  type Outcome,
  type Printed,
  type QueuedBoxData,
  printFailure,
  type Ran,
  readEnvelope,
  refused,
  type SessionData,
  SessionListData,
  type SessionState,
  minutesUp,
  boxBusy,
  nextBoxSize,
  StatusData,
} from '@abe/core';
import { type SettleDeps, settleBox, startBox } from './box-settle';
import { repoHere } from '../contract/here';
import { type IdleStop } from './idle';
import { localModeBoxRefusal } from './box-place';
import { openUptimeLog } from './box-uptime';
import { type CloudSessions } from './cloud';
import { type SettingsCtx } from '../layer/settings';

/** A followed box: why, its open sessions as it said, its last event's number, its stream. */
type Held = {
  reasons: Set<FollowReason>;
  open: Set<string>;
  /** The last event number the box sent; none before its first. */
  seq: number | undefined;
  stop?: (() => void) | undefined;
};

/** How often a box coming up or going down is looked at. */
export const BOX_POLL_MS = 2000;

/** Booted this recently, a box's boot may still be installing the boxes' release (#244). */
const WOKE_MS = 5 * 60_000;

/** How long a box may take to come up: a new one installs its tools on its first boot. */
export const BOX_BOOT_MS = 15 * 60_000;

/** How often `session list` asks every running box, not only the followed ones (a minute). */
const SCAN_MS = 60_000;

/** How long the first `session list`, nothing heard from the boxes yet, waits for them (#213 C7). */
const FIRST_MS = 500;

/** `session list`'s note while the boxes' first fan-out is out. */
const BOXES_ASKED_TEXT = 'your boxes are being asked: their sessions show once they answer';

export type BoxFrontOptions = {
  /** The person's boxes on EC2. */
  boxes: Boxes;
  link: BoxLink;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  emit: Journal['emit'];
  /**
   * The list `session list` and `watch` read your boxes with (default `boxes.list`): on a short
   * timeout, so an EC2 that does not answer keeps them waiting only that long.
   */
  scanList?: Boxes['list'];
  /** How often a box coming up or going down is looked at (default 2 s). */
  pollMs?: number;
  /** How long a box may take to start or stop, and its serve to answer (default 15 min). */
  bootMs?: number;
  /** Before following a box's events again after its stream ended (default 1 s). */
  followRetryMs?: number;
  /** The uptime log (`<state>/box-uptime.jsonl`); none: kept in memory only. */
  uptimeFile?: string;
  /** The local midnight before `ms`, from which today's cost counts (default this Mac's). */
  dayStart?: (ms: number) => number;
  /** This serve's abe version: a box whose `status` says another is shown with it (#188). */
  version?: string;
  /**
   * Whether your boxes are off where `cwd` is: `true` when `serve.target` is local there and no
   * box profile is named (#344). Off, `box list` asks EC2 nothing (a scan never runs off cloud).
   */
  off?: (cwd: string) => boolean;
};

/** The local midnight before `ms`. */
export const localDayStart = (ms: number): number => {
  const day = new Date(ms);

  day.setHours(0, 0, 0, 0);

  return day.getTime();
};

/** Why this `serve` follows a box: a cloud session it launched there, or one the box itself said is open. */
export type FollowReason = 'cloud' | 'open' | 'forward';

/**
 * Room for a wake of `box` (asleep or stopping) under `limits.maxBoxesPerPerson` (#191), asked by
 * a wake by name before EC2 is: refused (`box-limit`) at the limit, else held, its `release`
 * called once the start is over.
 */
export type WakeRoom = (box: Box) => Promise<Outcome<() => void>>;

/** `BoxFront.sessions`' answer. */
export type BoxSessions = { sessions: SessionData[]; unread: ErrorBody | null; notes: string[] };

/** What `box list` adds to EC2's boxes (the cloud's `listing`), read as EC2 answers. */
export type BoxListing = () => { queued: QueuedBoxData[]; made: Box[] };

export type BoxFront = {
  /** `also`: Queued rows, and boxes made here that EC2 lists not yet (said `pending`). */
  list: (also?: BoxListing) => Promise<Outcome<BoxListData>>;
  /** Whether your boxes are off where `cwd` is (`BoxFrontOptions.off`): `box list` says so. */
  off: (cwd: string) => boolean;
  /**
   * The card's workspace on `box` seen busy (its session working) or not now: its minutes busy
   * today, which its share of the box's cost is split by (ADR 0022).
   */
  busy: (box: string, card: string, busy: boolean) => number;
  /** One box as `box list` shows it (`no-box` when you have none by the name). */
  status: (name: string) => Promise<Outcome<BoxData>>;
  /**
   * The card's box made (or woken) and its `serve` answering: `box.state` `starting`, then
   * `running` once it answers (`failed` when it did not).
   */
  up: (spec: BoxSpec) => Promise<Outcome<BoxData>>;
  /** `room`: a wake by name counts as a launch's (#191); none, the start is not counted here. */
  start: (name: string, room?: WakeRoom) => Promise<Outcome<BoxData>>;
  /** The box stopped, its awake keep taken off first (#104). */
  stop: (name: string) => Promise<Outcome<BoxData>>;
  /**
   * The awake keep set (`box keep`: a sleeping box woken first) or taken off (`box sleep`) on
   * the box's own `serve`; `box.idle` said here when the box is not followed (else its own is
   * merged).
   */
  keepAwake: (name: string, awake: boolean, room?: WakeRoom) => Promise<Outcome<BoxKeepData>>;
  /** The box deleted (EC2 TerminateInstances as you): `box.state` `terminated`. */
  terminate: (name: string) => Promise<Outcome<BoxData>>;
  /** The box running and its `serve` answering, woken first if it sleeps: EC2's view of it. */
  wake: (name: string, room?: WakeRoom) => Promise<Outcome<Box>>;
  /**
   * A box just made (`Boxes.up` answered `made`) followed up: `box.state` `starting`, then
   * `running` once its `serve` answers. Never makes one again: EC2's list may not show it yet.
   */
  made: (made: Box, cause: string) => Promise<Outcome<BoxData>>;
  /** A `box.state` event for `box` (the queue's `queued`, a held place that failed). */
  said: (box: string, state: EventData<'box.state'>['state'], cause: string) => void;
  /**
   * `wait` (its `serve` waited for in its boot, as a launch does), the box listed booting
   * meanwhile whatever the link says yet (#213 B4): Linked and the Boxes tab say what the launch says.
   */
  booting: <T>(name: string, wait: () => Promise<T>) => Promise<T>;
  /** Whether EC2 says the box runs now (never wakes it). */
  runs: (name: string) => Promise<boolean>;
  /**
   * Whether this `serve` stopped or terminated the box (`box stop`, `box terminate`) since it
   * last started it: a box down otherwise went to sleep on its own (#192).
   */
  stoppedHere: (name: string) => boolean;
  /** `abe <argv>` on the box's `serve`, woken first: what its `abe` printed and exited with. */
  forward: (
    name: string,
    argv: readonly string[],
    json: boolean,
    room?: WakeRoom,
  ) => Promise<Printed>;
  /**
   * Every running box's `session list`, each session tagged with its box; open ones followed.
   * `unread`: why your boxes could not be listed (then none are asked); `notes`: each running box
   * asked that did not answer, where it stands (`boxReachText`). Never waits on a box (#213 C7):
   * the last fan-out at once (kept up with the followed boxes' events) while the next one runs
   * behind; the first waits for its boxes `FIRST_MS` at most. A session a fan-out finds new or
   * moved since the last answer is said (`session.state`, cause `listed`).
   */
  sessions: () => Promise<BoxSessions>;
  /** Looks at every running box once for open sessions, and follows those that hold one. */
  discover: () => Promise<void>;
  /** Follows the box's events while any reason holds; `release` drops one. */
  keep: (box: string, reason: FollowReason) => void;
  release: (box: string, reason: FollowReason) => void;
  /**
   * Each event a followed box sends, as it sent it, before it is merged into this stream; `false`
   * keeps it out (this `serve` said the same already).
   */
  onEvent: (see: (box: string, event: Event) => boolean) => void;
  close: () => void;
};

/**
 * A box's own events not merged: its command log (`command.ran`). Its `watch.gap` is: events of
 * that box are gone (its ring moved on during a long drop, or its serve started again), so the
 * Mac's watchers read again, as for a gap of the Mac's own.
 */
const UNMERGED = new Set(['command.ran']);

const exitOf = (exit: number): ExitCode | undefined =>
  exit === 0 || exit === 1 || exit === 2 || exit === 3 ? exit : undefined;

/** A box's answer to `abe … --json`, read with `schema`; anything else is why not. */
export const answerOf = <T extends z.ZodType>(schema: T, ran: Ran): Outcome<z.output<T>> => {
  try {
    const doc = readEnvelope(schema, JSON.parse(ran.stdout));

    return doc.ok ? { ok: true, data: doc.data } : refused(doc.error.code, doc.error.message);
  } catch {
    const said = ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exit}`;

    // 255 with nothing on stdout: the link never reached the box (an AWS login, ssh), #194.
    return refused(
      'box-unreachable',
      ran.exit === 255 && ran.stdout.trim() === ''
        ? said
        : `the box answered no abe reply: ${said}`,
    );
  }
};

/** One line of a box's `watch --json`, or `undefined` for anything else. */
export const eventLineOf = (text: string): EventLine | undefined => {
  try {
    const line = EventLine.safeParse(JSON.parse(text));

    return line.success ? line.data : undefined;
  } catch {
    return undefined;
  }
};

/** Whether `stdout` is one `--json` document, as every abe answer with `--json` is. */
const isEnvelope = (stdout: string): boolean => {
  try {
    return Envelope.safeParse(JSON.parse(stdout)).success;
  } catch {
    return false;
  }
};

const Envelope = envelope(z.unknown());

/** What a run printed, as the reason it was no abe answer. */
const whyOf = (ran: Ran): string => ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.exit}`;

/**
 * The endpoint got to the box's subnet but nothing listens on its port 22 yet (the tunnel's close
 * reason, `eice-tunnel.ts`): its sshd is not up, as in every boot's first half minute (#244).
 * Said as its `serve` not answering, never the tunnel's words.
 */
const SSHD_DOWN = 'open-tunnel: closed: Unable to connect to target';

/** Whether a running box's `serve` answered its `status` (null: not asked, it does not run). */
const serveOf = (status: Outcome<unknown> | undefined): BoxData['serve'] => {
  if (status === undefined) return null;

  return status.ok ? 'answers' : 'silent';
};

/** EC2's state a box listed running went to, by its `BoxReach` read again; undefined: still up. */
const wentDownTo = (r: BoxReach | undefined): BoxData['state'] | undefined => {
  switch (r?.kind) {
    case 'asleep':
      return r.state;
    case 'gone':
      return 'shutting-down';
    default:
      return undefined;
  }
};

/** A session's key across your boxes. */
const keyOf = (s: { id: string; box?: string | undefined }) => `${s.box ?? ''} ${s.id}`;

/** `p`'s answer if it comes within `ms`, else undefined. */
const within = async <T>(p: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });

  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A box's answer over what was held of it: a row held with a later `since` (its stream said a
 * move after the box was asked) stays.
 */
const newerOf = (held: readonly SessionData[], answer: readonly SessionData[]): SessionData[] => {
  const was = new Map(held.map((s) => [s.id, s]));

  return answer.map((s) => {
    const h = was.get(s.id);

    return h !== undefined && Date.parse(h.since) > Date.parse(s.since) ? h : s;
  });
};

/** The port's answer as an outcome, its error whole (an `aws-auth`'s `profile` too). */
const outcome = <T>(a: Answered<T>): Outcome<T> => (a.ok ? a : { ok: false, error: a.error });

export const startBoxFront = (o: BoxFrontOptions): BoxFront => {
  const uptime = openUptimeLog(o.uptimeFile ?? null, o.clock.now());
  const dayStart = o.dayStart ?? localDayStart;
  /** Each box's root disk as its load last said (ADR 0022): priced asleep too. */
  const diskGb = new Map<string, number>();
  const pollMs = o.pollMs ?? BOX_POLL_MS;
  const bootMs = o.bootMs ?? BOX_BOOT_MS;
  const followRetryMs = o.followRetryMs ?? 1000;
  const listeners: ((box: string, event: Event) => boolean)[] = [];
  /** When `session list` last asked every running box. */
  let scanned = Number.NEGATIVE_INFINITY;
  /** Each running box's sessions as it last answered, kept up with its stream (#213 C7). */
  const rows = new Map<string, SessionData[]>();
  /** Each running box asked that did not answer: where it stands (`boxReachText`). */
  const boxNotes = new Map<string, string>();
  /** Each box's `session list` out now: joined, never asked twice at once. */
  const asking = new Map<string, Promise<void>>();
  /** The running boxes in the last scan's order; the last scan's failure. */
  let running: string[] | undefined;
  let unreadNow: ErrorBody | null = null;
  /** The first `session list` waited for its boxes already: none waits again. */
  let waited = false;
  /** Each session's state as a list or an event last told the watchers (none before a list). */
  const told = new Map<string, SessionData['state']>();
  let handedOnce = false;
  /** Per followed box: why, its open sessions as it said, the last event number, the stream. */
  const followed = new Map<string, Held>();
  /** Closed: nothing is followed again (a function, so a check after an `await` reads it anew). */
  const life = { closed: false };
  const isClosed = () => life.closed;
  const streaming = (held: Held) => held.stop !== undefined;
  /** When each box's `serve` last answered here, and since when it has not after that. */
  const heard = new Map<string, number>();
  const silentFrom = new Map<string, number>();
  const heardFrom = (name: string) => {
    heard.set(name, o.clock.now());
    silentFrom.delete(name);
  };
  /**
   * A running box's `serve` not answering: since its LaunchTime while it has not answered here
   * since its boot (booting, or never up); else since it was first found silent after its last
   * answer (`stopped`: its serve went).
   */
  const silentOf = (box: Box): BoxReach => {
    const launched = Date.parse(box.launchedAt ?? '');
    const last = heard.get(box.name);

    if (last === undefined || (!Number.isNaN(launched) && last < launched))
      return { kind: 'silent', since: box.launchedAt ?? null };
    const from = silentFrom.get(box.name) ?? o.clock.now();

    silentFrom.set(box.name, from);

    return { kind: 'silent', since: new Date(from).toISOString(), stopped: true };
  };

  /** A box's abe version as its `status` said it, and, when it is another release, the skew. */
  const abeOf = (box: string, theirs: string): Pick<BoxData, 'abe' | 'skew'> =>
    o.version === undefined || !abeSkewed(theirs, o.version)
      ? { abe: theirs }
      : { abe: theirs, skew: abeSkewText(box, theirs, o.version) };

  /**
   * A box just woken or made, as `box start` / `box up` answer it: booted under `WOKE_MS` ago on
   * another abe than this serve's, its boot may still put the boxes' release on it (#244), said.
   * One that ran already is not told.
   */
  const woken = (b: BoxData): BoxData =>
    o.version === undefined ||
    b.abe === undefined ||
    b.abe === o.version ||
    b.launchedAt === null ||
    o.clock.now() - Date.parse(b.launchedAt) > WOKE_MS
      ? b
      : { ...b, woke: abeWokeText(b.name, b.abe, o.version) };

  /** The last scan's list that failed, and when: kept for a `SCAN_MS`, so EC2 is not asked again. */
  let unread: { at: number; error: ErrorBody } | undefined;
  /** A scan's list on its way: a second one meanwhile shares it (one EC2 read, said once). */
  let scanning: Promise<Outcome<Box[]>> | undefined;
  const boxes = async (): Promise<Outcome<Box[]>> => {
    const listed = outcome(await o.boxes.list());

    // Any list that worked (`box list` after `aws sso login`) ends a kept failure.
    if (listed.ok) unread = undefined;

    return listed;
  };

  /**
   * Your boxes as `session list` and `watch` read them (`scanList`). A failure is kept for a
   * `SCAN_MS` and said once (`boxes.unread`), again only after a read worked.
   */
  const scan = (): Promise<Outcome<Box[]>> => {
    if (unread !== undefined && o.clock.now() - unread.at < SCAN_MS)
      return Promise.resolve({ ok: false, error: unread.error });
    scanning ??= (async () => {
      const listed = outcome(await (o.scanList ?? o.boxes.list)());

      if (listed.ok) unread = undefined;
      else {
        if (unread === undefined) o.emit('boxes.unread', listed.error);
        unread = { at: o.clock.now(), error: listed.error };
      }

      return listed;
    })().finally(() => {
      scanning = undefined;
    });

    return scanning;
  };

  const find = async (name: string): Promise<Outcome<Box>> => {
    const read = await o.boxes.status(name);

    if (!read.ok) return outcome(read);

    return read.data === null
      ? refused('no-box', `you have no box ${name}: abe box list names yours`)
      : { ok: true, data: read.data };
  };

  /** A box's move as the uptime log counts it: `running` up, `stopping` on down. */
  const logMove = (box: string, state: EventData<'box.state'>['state']) => {
    if (state === 'running') uptime.seen(box, true, o.clock.now());
    else if (state === 'stopping' || state === 'stopped' || state === 'terminated')
      uptime.seen(box, false, o.clock.now());
  };

  /** Boxes this `serve` stopped or terminated, until it starts them again. */
  const downHere = new Set<string>();
  const said = (box: string, state: EventData<'box.state'>['state'], cause: string) => {
    logMove(box, state);
    if (state === 'starting') downHere.delete(box);
    if ((state === 'stopping' && cause === 'stop') || state === 'terminated') downHere.add(box);
    o.emit('box.state', { box, state, cause });
  };

  /** EC2 read again for a box on its way up or down (core's `boxSettling`). */
  const settling: SettleDeps = {
    boxes: o.boxes,
    now: () => o.clock.now(),
    sleep: (ms) => o.sleep(ms),
    pollMs,
  };
  const settled = (name: string, want: 'running' | 'stopped', fresh = false) =>
    settleBox(settling, name, want, o.clock.now() + bootMs, fresh);

  /**
   * Boxes whose `serve` this one waits for in their boot (`answering`, the launch's `Box booting`):
   * listed booting whatever the link says yet, so Linked, the Boxes tab and Chat agree; the end
   * of the wait says why it never answered.
   */
  const inBoot = new Set<string>();
  const booting = async <T>(name: string, wait: () => Promise<T>): Promise<T> => {
    inBoot.add(name);
    try {
      return await wait();
    } finally {
      inBoot.delete(name);
    }
  };

  /** Its `serve` answering `status`, a moment after EC2 says the box runs. */
  const answering = (box: Box): Promise<Outcome<null>> => booting(box.name, () => answered(box));

  const answered = async (box: Box): Promise<Outcome<null>> => {
    const until = o.clock.now() + bootMs;

    for (;;) {
      const ran = await o.link.run(box.name, ['status', '--json']);
      const status = answerOf(StatusData, ran);

      if (status.ok) {
        heardFrom(box.name);

        return { ok: true, data: null };
      }
      if (o.clock.now() > until) {
        inBoot.delete(box.name);
        const reach = await reachNow(box, ran, status.error.message);

        return refused('box-unreachable', boxReachText(box.name, reach, o.clock.now()));
      }
      await o.sleep(pollMs);
    }
  };

  /**
   * The box running: started when it sleeps, `box.state` `starting` then `running` (or `failed`),
   * and with `serve` its `serve` waited for.
   */
  const up = async (
    name: string,
    cause: string,
    serve: boolean,
    spec?: BoxSpec,
    room?: WakeRoom,
  ): Promise<Outcome<Box>> => {
    const found = await o.boxes.status(name);

    if (!found.ok) return outcome(found);
    const box = found.data;

    if (box?.state === 'running') return { ok: true, data: box };
    if (box?.state === 'shutting-down')
      return refused('box-deleted', `box ${name} is being terminated`);
    if (box === null && spec === undefined)
      return refused('no-box', `you have no box ${name}: abe box list names yours`);
    // Asleep: woken only with room, held while it starts (#191). Starting: it counts already.
    const held = box !== null && !BOX_COUNTED.has(box.state) ? await room?.(box) : undefined;

    if (held !== undefined && !held.ok) return held;
    try {
      return await upNow(name, box, cause, serve, spec);
    } finally {
      held?.data();
    }
  };

  /** `up` once its room is held: started (or made), then its serve waited for. */
  const upNow = async (
    name: string,
    box: Box | null,
    cause: string,
    serve: boolean,
    spec: BoxSpec | undefined,
  ): Promise<Outcome<Box>> => {
    said(name, 'starting', cause);
    let at: Outcome<Box>;

    if (box !== null) at = await startBox(settling, name, o.clock.now() + bootMs, box);
    else if (spec === undefined) at = refused('no-box', name);
    else {
      // None yet: made from the launch template, then waited for.
      const made = outcome(await o.boxes.up(spec));

      at = made.ok ? await settled(name, 'running', true) : made;
    }
    // EC2 runs it; its serve is not answering yet (#193's progress line says so).
    if (at.ok && serve) o.emit('box.step', { box: name, step: 'booting' });
    const ready = at.ok && serve ? await answering(at.data) : undefined;

    said(name, at.ok && ready?.ok !== false ? 'running' : 'failed', cause);
    if (ready !== undefined && !ready.ok) return ready;

    return at;
  };

  /** EC2's state of `name` now in `BoxReach` words; undefined while it runs (or not read). */
  const downNow = async (name: string): Promise<BoxReach | undefined> => {
    const now = await o.boxes.status(name);

    return now.ok && now.data !== null
      ? boxReachOfState(now.data.state, now.data.launchedAt ?? null)
      : undefined;
  };

  /**
   * Where `box`, which EC2 said runs, stands after `abe <argv>` on it gave no abe answer (#143):
   * EC2 is read again first, so a box that went down meanwhile (a stop under way stops its serve
   * before its link, #235) is said so and one that runs is never told to wake; else exit 3 is the
   * box's own `abe` finding no `serve` there (silent; its sshd not up yet too, `SSHD_DOWN`), any
   * other the link failing (its words, or
   * `fallback` for an answer that was no abe document).
   */
  const reachNow = async (box: Box, ran: Ran, fallback?: string): Promise<BoxReach> => {
    const went = await downNow(box.name);

    if (went !== undefined) return went;
    if (ran.exit === EXIT.unreachable) return silentOf(box);
    if (ran.exit === 255 && ran.stderr.includes(SSHD_DOWN)) return silentOf(box);
    // waited for here in its boot: booting, as the launch says it (#213 B4)
    if (inBoot.has(box.name)) return silentOf(box);

    return {
      kind: 'unreachable',
      why: exitOf(ran.exit) === undefined ? whyOf(ran) : (fallback ?? whyOf(ran)),
    };
  };

  const down = async (name: string): Promise<Outcome<Box>> => {
    const box = await find(name);

    if (!box.ok || box.data.state === 'stopped') return box;
    // Stop now takes the awake keep off first, so waking it later does not keep it awake. Its
    // serve not answering is no reason not to stop: a new boot drops the keep anyway.
    if (box.data.state === 'running') await o.link.run(name, ['box', 'sleep', name, '--json']);
    said(name, 'stopping', 'stop');
    const asked = await o.boxes.stop(name);
    const stopped = asked.ok
      ? await settled(name, 'stopped')
      : refused(asked.error.code, asked.error.message);

    said(name, stopped.ok ? 'stopped' : 'failed', 'stop');

    return stopped;
  };

  /**
   * One box as `box list` shows it: its size, release, uptime, today's cost and, while it runs,
   * its workspace and idle stop from its `status` (`serve` `silent` when that did not answer).
   */
  const shown = async (box: Box): Promise<BoxData> => {
    const ran = box.state === 'running' ? await o.link.run(box.name, ['status', '--json']) : null;
    const status = ran === null ? undefined : answerOf(StatusData, ran);

    if (status?.ok === true) heardFrom(box.name);
    const found =
      ran === null || status?.ok !== false
        ? undefined
        : await reachNow(box, ran, status.error.message);
    // EC2 read again says it went down meanwhile (a stop or a terminate under way, #235): that
    // state, never a problem.
    const wentTo = wentDownTo(found);
    const state = wentTo ?? box.state;
    const reach = wentTo === undefined ? found : undefined;
    const now = o.clock.now();

    // listed up, gone down since: its time up counted first (a box first seen from its LaunchTime)
    if (state !== box.state) uptime.seen(box.name, boxUp(box.state), now, box.launchedAt);
    uptime.seen(box.name, boxUp(state), now, box.launchedAt);
    const load = status?.ok === true ? status.data.load : undefined;

    if (load !== undefined && load.disk.totalGb > 0) diskGb.set(box.name, load.disk.totalGb);
    const disk = diskGb.get(box.name);

    return {
      name: box.name,
      state,
      size: box.size,
      launchedAt: box.launchedAt ?? null,
      release: box.release ?? null,
      repo: box.repo,
      card: box.card,
      title: box.title ?? null,
      costToday: boxCostToday({
        moves: uptime.moves(box.name),
        size: box.size,
        dayStart: dayStart(now),
        now,
        ...(disk === undefined ? {} : { diskGb: disk }),
      }),
      serve: wentTo === undefined ? serveOf(status) : null,
      workspace: status?.ok === true ? (status.data.workspace ?? null) : null,
      // A box per repo (ADR 0022): every workspace on it; a box from before says its one.
      workspaces:
        status?.ok === true
          ? (status.data.boxWorkspaces ??
            (status.data.workspace === undefined ? [] : [status.data.workspace]))
          : [],
      ...(status?.ok === true && status.data.load !== undefined ? { load: status.data.load } : {}),
      ...(status?.ok === true && status.data.idle !== undefined ? { idle: status.data.idle } : {}),
      ...(reach === undefined ? {} : { reach }),
      readAt: new Date(now).toISOString(),
      ...(status?.ok === true ? abeOf(box.name, status.data.version) : {}),
    };
  };

  /** The box's events, merged here; for a box nothing holds any more, the stream ends. */
  const follow = (name: string) => {
    const held = followed.get(name);

    if (isClosed() || held === undefined || streaming(held)) return;
    const stream = o.link.follow(
      name,
      ['watch', '--json', ...(held.seq === undefined ? [] : ['--since', String(held.seq)])],
      (text) => {
        seen(name, held, text);
      },
    );

    held.stop = stream.stop;
    void stream.ended.then(async () => {
      if (followed.get(name) !== held) return;
      held.stop = undefined;
      if (isClosed() || held.reasons.size === 0) {
        followed.delete(name);

        return;
      }
      await o.sleep(followRetryMs);
      // Again only to a box EC2 says runs: following must never wake a sleeping one.
      const listed = await boxes();
      const running =
        listed.ok && listed.data.some((b) => b.name === name && b.state === 'running');

      if (followed.get(name) !== held || streaming(held)) return;
      if (running && !isClosed()) {
        // What it holds open now: an `ended` missed while the tunnel was down lets it sleep.
        await look(name);
        if (followed.get(name) === held && held.reasons.size > 0) follow(name);
      } else if (listed.ok) followed.delete(name);
      else {
        // EC2 not answering: try again later rather than drop the box.
        await o.sleep(followRetryMs);
        if (followed.get(name) === held && !streaming(held)) follow(name);
      }
    });
  };

  const keep = (box: string, reason: FollowReason) => {
    if (isClosed()) return;
    const held: Held = followed.get(box) ?? {
      reasons: new Set(),
      open: new Set(),
      seq: undefined,
    };

    held.reasons.add(reason);
    followed.set(box, held);
    follow(box);
  };

  const release = (box: string, reason: FollowReason) => {
    const held = followed.get(box);

    if (held === undefined) return;
    held.reasons.delete(reason);
    if (held.reasons.size > 0) return;
    held.stop?.();
    followed.delete(box);
  };

  /** What the box itself says is open there, and so whether it is followed for it. */
  const opened = (box: string, ids: readonly string[]) => {
    if (ids.length === 0) {
      followed.get(box)?.open.clear();
      release(box, 'open');

      return;
    }
    keep(box, 'open');
    const held = followed.get(box);

    if (held !== undefined) held.open = new Set(ids);
  };

  /**
   * One box's own `session list`: the sessions it holds open, or what it printed when that was
   * no list (`ran`).
   */
  const listOn = async (box: string): Promise<{ sessions: SessionData[] } | { ran: Ran }> => {
    const ran = await o.link.run(box, ['session', 'list', '--json']);
    const list = answerOf(SessionListData, ran);

    if (!list.ok) return { ran };
    heardFrom(box);
    const tagged = list.data.sessions.map((s) => ({ ...s, box }));

    opened(
      box,
      tagged.filter((s) => s.state !== 'ended').map((s) => s.id),
    );

    return { sessions: tagged };
  };

  /** A box asked now (a session just started there): its rows held, the session followed. */
  const look = async (box: string) => {
    const streamed = followed.has(box);
    const answer = await listOn(box);

    if ('sessions' in answer) heardRows(box, answer.sessions, streamed);
  };

  /** One line of a box's `watch --json`: numbered, merged (tagged with the box), handed on. */
  const seen = (box: string, held: Held, text: string) => {
    const line = eventLineOf(text);

    // A line of a stream let go of (the box released, then kept again) is not this one's.
    if (followed.get(box) !== held || line === undefined) return;
    held.seq = line.seq;
    const { type } = line;

    // A newer box's event this build does not know is not merged; nor are its own numbering and log.
    if (UNMERGED.has(type) || !isEventType(type)) return;
    const event = Event.safeParse({ ...line, box: undefined });

    if (!event.success) return;
    if (event.data.type === 'session.state') {
      const state: EventData<'session.state'> = event.data.data;

      if (state.state === 'ended') held.open.delete(state.id);
      else held.open.add(state.id);
      rows.set(
        box,
        (rows.get(box) ?? []).map((s) =>
          s.id === state.id && Date.parse(state.since) >= Date.parse(s.since)
            ? {
                ...s,
                state: state.state,
                since: state.since,
                waitingOn: state.waitingOn ?? null,
                turnEnded: state.turnEnded,
              }
            : s,
        ),
      );
      told.set(keyOf({ id: state.id, box }), state.state);
    }
    // Its own idle stop's `stopping`: counted down from now.
    if (event.data.type === 'box.state') logMove(box, event.data.data.state);
    const kept = listeners.map((see) => see(box, event.data)).every(Boolean);

    if (kept) o.emit(event.data.type, event.data.data, box);
    if (held.open.size === 0 && held.reasons.has('open')) release(box, 'open');
  };

  /**
   * A box's sessions answered: held (a row its stream moved since kept, `newerOf`) and, once a
   * list was answered, each one new or moved since said (`session.state`, cause `listed`; a new
   * one already ended is not news). Not for a box followed when it was asked: its stream
   * (reconnected with `--since` after a drop) says each move itself, in order.
   */
  const heardRows = (box: string, answer: readonly SessionData[], streamed: boolean) => {
    const got = newerOf(rows.get(box) ?? [], answer);

    rows.set(box, got);
    if (!handedOnce || streamed) return;
    for (const s of got) {
      const was = told.get(keyOf(s));

      if (was === s.state || (was === undefined && s.state === 'ended')) continue;
      told.set(keyOf(s), s.state);
      o.emit(
        'session.state',
        {
          id: s.id,
          card: s.card,
          state: s.state,
          since: s.since,
          cause: 'listed',
          ...(s.reason === null ? {} : { reason: s.reason }),
          ...(s.state === 'waiting' ? { waitingOn: s.waitingOn } : {}),
        },
        box,
      );
    }
  };

  /** One running box's `session list` asked, or the one out joined. */
  const ask = (box: Box): Promise<void> => {
    const out = asking.get(box.name);

    if (out !== undefined) return out;
    const asked = (async () => {
      const streamed = followed.has(box.name);
      const answer = await listOn(box.name);

      if ('sessions' in answer) {
        boxNotes.delete(box.name);
        heardRows(box.name, answer.sessions, streamed);
      } else if (answer.ran.exit === EXIT.unreachable || exitOf(answer.ran.exit) === undefined) {
        // Not answering: its rows stay as last heard, and the note says where it stands.
        const reach = await reachNow(box, answer.ran);

        boxNotes.set(box.name, boxReachText(box.name, reach, o.clock.now()));
      } else boxNotes.delete(box.name);
    })()
      .catch(() => undefined)
      .finally(() => {
        asking.delete(box.name);
      });

    asking.set(box.name, asked);

    return asked;
  };

  /**
   * Running boxes' own `session list`s, each box on its own (one that hangs holds back no other).
   * Every running box at most once a `SCAN_MS` (or when `all`), else only the followed ones:
   * asking is a connection to the box, someone there, which an idle box must not get on every
   * read. A box no longer running is let go of.
   */
  const fanOut = async (all: boolean): Promise<void> => {
    const listed = await scan();

    if (!listed.ok) {
      unreadNow = listed.error;

      return;
    }
    unreadNow = null;
    const every = all || o.clock.now() - scanned >= SCAN_MS;

    if (every) scanned = o.clock.now();
    const up = listed.data.filter((b) => b.state === 'running');
    const names = new Set(up.map((b) => b.name));

    running = up.map((b) => b.name);
    for (const box of [...rows.keys()]) if (!names.has(box)) rows.delete(box);
    for (const box of [...boxNotes.keys()]) if (!names.has(box)) boxNotes.delete(box);
    await Promise.all(up.filter((b) => every || followed.has(b.name)).map(ask));
  };

  /** What the boxes said last, as `session list` shows it. */
  const shownNow = (): BoxSessions => {
    if (unreadNow !== null) return { sessions: [], unread: unreadNow, notes: [] };
    const up = running ?? [];
    // A box asked that never answered yet (or no scan yet): said, so its rows are not missed.
    const pending = running === undefined || up.some((box) => asking.has(box) && !rows.has(box));

    return {
      sessions: up.flatMap((box) => rows.get(box) ?? []),
      unread: null,
      notes: [
        ...up.flatMap((box) => {
          const note = boxNotes.get(box);

          return note === undefined ? [] : [note];
        }),
        ...(pending ? [BOXES_ASKED_TEXT] : []),
      ],
    };
  };

  const sessions = async (): Promise<BoxSessions> => {
    const behind = fanOut(false).catch(() => undefined);

    if (!waited) {
      waited = true;
      await within(behind, FIRST_MS);
    }
    const shown = shownNow();

    handedOnce = true;
    for (const s of shown.sessions) told.set(keyOf(s), s.state);

    return shown;
  };

  const keepAwake = async (
    name: string,
    awake: boolean,
    room?: WakeRoom,
  ): Promise<Outcome<BoxKeepData>> => {
    // Kept: woken first. Let sleep: a box not running sleeps already (its keep went with its boot).
    const box = awake ? await up(name, 'keep', true, undefined, room) : await find(name);

    if (!box.ok) return box;
    if (box.data.state === 'stopped' || box.data.state === 'stopping')
      return refused('box-asleep', `box ${name} is ${box.data.state}: it sleeps already`);
    if (box.data.state !== 'running')
      return refused('box-busy', `box ${name} is ${box.data.state}: let it sleep once it runs`);
    const verb = awake ? 'keep' : 'sleep';
    const kept = answerOf(BoxKeepData, await o.link.run(name, ['box', verb, name, '--json']));

    if (!kept.ok) return kept;
    // A followed box's own `box.idle` is merged; else it is said here.
    if (!followed.has(name)) o.emit('box.idle', kept.data);

    return kept;
  };

  return {
    off: (cwd) => o.off?.(cwd) === true,
    busy: (box, card, busy) => {
      // the uptime log's lines, by `<box> #<card>`: up while its session works
      const key = `${box} #${card}`;
      const now = o.clock.now();

      uptime.seen(key, busy, now);

      return minutesUp(uptime.moves(key), dayStart(now), now);
    },
    list: async (also) => {
      const listed = await boxes();

      if (!listed.ok) return listed;
      // Read with EC2's answer, so a place taken off the queue since is listed as its box.
      const more = also?.() ?? { queued: [], made: [] };
      const unlisted = more.made
        .filter((m) => !listed.data.some((b) => b.name === m.name))
        .map((m) => ({ ...m, state: 'pending' as const }));
      // Being deleted is gone already, as the table shows it.
      const live = [...listed.data, ...unlisted].filter((b) => b.state !== 'shutting-down');

      return { ok: true, data: { boxes: await Promise.all(live.map(shown)), queued: more.queued } };
    },
    status: async (name) => {
      const box = await find(name);

      return box.ok ? { ok: true, data: await shown(box.data) } : box;
    },
    up: async (spec) => {
      const box = await up(spec.name, 'up', true, spec);

      return box.ok ? { ok: true, data: woken(await shown(box.data)) } : box;
    },
    start: async (name, room) => {
      const box = await up(name, 'start', true, undefined, room);

      return box.ok ? { ok: true, data: woken(await shown(box.data)) } : box;
    },
    stop: async (name) => {
      const box = await down(name);

      return box.ok ? { ok: true, data: await shown(box.data) } : box;
    },
    keepAwake,
    terminate: async (name) => {
      const ended = outcome(await o.boxes.terminate(name));

      if (!ended.ok) return ended;
      // Nothing to follow there any more.
      const held = followed.get(name);

      held?.stop?.();
      followed.delete(name);
      said(name, 'terminated', 'terminate');

      return { ok: true, data: await shown(ended.data) };
    },
    wake: (name, room) => up(name, 'wake', true, undefined, room),
    made: async (made, cause) => {
      said(made.name, 'starting', cause);
      const at = await settled(made.name, 'running', true);

      // EC2 runs it; its serve is not answering yet: the progress line says so (#320, as `upNow`)
      if (at.ok) o.emit('box.step', { box: made.name, step: 'booting' });
      const ready = at.ok ? await answering(at.data) : undefined;

      said(made.name, at.ok && ready?.ok !== false ? 'running' : 'failed', cause);
      if (!at.ok) return at;
      if (ready !== undefined && !ready.ok) return ready;

      return { ok: true, data: await shown(at.data) };
    },
    said,
    booting,
    runs: async (name) => {
      const box = await find(name);

      return box.ok && box.data.state === 'running';
    },
    forward: async (name, argv, json, room) => {
      const box = await up(name, 'wake', true, undefined, room);

      if (!box.ok) {
        // Stuck starting, or being terminated: said as EC2 has it now, in the same words.
        const down =
          box.error.code === 'box-timeout' || box.error.code === 'box-deleted'
            ? await downNow(name)
            : undefined;

        return printFailure(
          down === undefined
            ? box.error
            : { code: box.error.code, message: boxReachText(name, down, o.clock.now()) },
          box.error.code === 'box-unreachable' ? EXIT.unreachable : EXIT.failed,
          json,
        );
      }
      const ran = await o.link.run(name, argv);
      const exit = exitOf(ran.exit);
      const { id } = parse(argv);

      // A session started there: followed from now on, so the watch here carries it.
      if (exit === 0 && (id === 'session launch' || id === 'session run')) await look(name);
      // Its abe's answer as it printed it. Its own `serve` not answering (exit 3), an exit no abe
      // gives, or no JSON document where one was asked for, is where the box stands (#143).
      if (exit !== undefined && exit !== EXIT.unreachable && (!json || isEnvelope(ran.stdout))) {
        heardFrom(name);

        return { exit, stdout: ran.stdout, stderr: ran.stderr };
      }
      const reach = await reachNow(box.data, ran);

      return printFailure(
        { code: 'box-unreachable', message: boxReachText(name, reach, o.clock.now()) },
        EXIT.unreachable,
        json,
      );
    },
    sessions,
    discover: () => fanOut(true),
    keep,
    release,
    stoppedHere: (name) => downHere.has(name),
    onEvent: (see) => {
      listeners.push(see);
    },
    close: () => {
      life.closed = true;
      for (const held of followed.values()) held.stop?.();
      followed.clear();
    },
  };
};

export type BoxesCtx = SettingsCtx & {
  ports?: {
    /** The box profile in force at `dir` where not serve's own (ADR 0025): a new box is made on it. */
    profileAt?: (dir: string) => string | null;
    /** The AWS profile and region box `name` is reached on, as last found (ADR 0025). */
    boxAwsOf?: (name: string) => BoxAws | undefined;
  };
  serve: {
    /** This serve is a box's own (ADR 0021): `serve.target` is the Mac's, so it launches here. */
    onBox: boolean;
    /** On a box: its idle stop, which holds the awake keep (#104). */
    idle: Pick<IdleStop, 'name' | 'keep'> | undefined;
    boxes: BoxFront | undefined;
    /** The launches' placement and queue (`box up` is placed by the same rules, #57). */
    cloud: CloudSessions | undefined;
    /** Each other profile the last list of your boxes could not read, said (ADR 0025). */
    unlisted?: () => readonly string[];
  };
};

/**
 * `front` whose wakes by name (`box start`, `box keep`, `--on`'s wake) ask `room` first (#191),
 * as a command typed in a checkout asks that checkout's limit; none: `front` as it is.
 */
export const withRoom = (front: BoxFront, room: WakeRoom | undefined): BoxFront =>
  room === undefined
    ? front
    : {
        ...front,
        start: (name) => front.start(name, room),
        wake: (name) => front.wake(name, room),
        keepAwake: (name, awake) => front.keepAwake(name, awake, room),
        forward: (name, argv, json) => front.forward(name, argv, json, room),
      };

const noBoxes = () =>
  Promise.resolve(
    refused(
      'no-boxes',
      'this abe serve fronts no boxes: boxes are reached from your local machine',
    ),
  );

/**
 * `box keep` / `box sleep`: on a box its own idle stop's awake keep (its own name only), on the
 * Mac that box's, through its `serve`.
 */
const keepHandler =
  (awake: boolean) =>
  (args: { box: string }, ctx: BoxesCtx): Promise<Outcome<BoxKeepData>> => {
    const idle = ctx.serve.idle;

    if (idle !== undefined)
      return Promise.resolve(
        args.box === idle.name
          ? { ok: true, data: { box: idle.name, idle: idle.keep(awake) } }
          : refused('no-box', `this is box ${idle.name}, not ${args.box}`),
      );

    return ctx.serve.boxes?.keepAwake(args.box, awake) ?? noBoxes();
  };

/** A workspace's session states that count it busy, for its cost share (ADR 0022). */
const BUSY: ReadonlySet<SessionState> = new Set<SessionState>(['starting', 'working']);

/** A box with the session of yours on it as this Mac last heard (#194: its state, not the container's). */
const withSession = (b: BoxData, ctx: BoxesCtx): BoxData => {
  const cloud = ctx.serve.cloud;
  const s = cloud?.lastOn(b.name);
  const onCard = (w: { card: string }) => {
    const card = Number(w.card);

    return Number.isInteger(card) && card > 0 ? cloud?.lastOn(b.name, card) : undefined;
  };
  const cardSessions = (b.workspaces ?? []).flatMap((w) => {
    const on = onCard(w);

    return on === undefined ? [] : [{ card: w.card, id: on.id }];
  });
  // ADR 0022: each workspace's busy minutes today, its cost share's weight
  const front = ctx.serve.boxes;
  const busyToday =
    front === undefined || b.state !== 'running'
      ? []
      : (b.workspaces ?? []).map((w) => ({
          card: w.card,
          minutes: front.busy(b.name, w.card, BUSY.has(onCard(w)?.state ?? 'ended')),
        }));

  // ADR 0022: busy at its last load read, with the size a Resize… would take it to
  const busy =
    b.state === 'running' && b.load !== undefined && boxBusy(b.load)
      ? {
          next:
            b.size === null
              ? null
              : nextBoxSize(
                  b.size,
                  (ctx.settings?.at(ctx.cwd).values ?? coreDefaults())['limits.maxBoxSize'],
                ),
        }
      : undefined;

  return {
    ...b,
    ...(s === undefined ? {} : { session: { id: s.id, state: s.state, since: s.since } }),
    ...(cardSessions.length === 0 ? {} : { cardSessions }),
    ...(busyToday.length === 0 ? {} : { busyToday }),
    ...(busy === undefined ? {} : { busy }),
  };
};

/** The other profiles whose boxes the list could not read, when any (ADR 0025). */
const unlistedOf = (ctx: BoxesCtx): { unlisted?: string[] } => {
  const said = ctx.serve.unlisted?.() ?? [];

  return said.length === 0 ? {} : { unlisted: [...said] };
};

const sessioned = <T extends BoxData>(o: Outcome<T>, ctx: BoxesCtx): Outcome<BoxData> =>
  o.ok ? { ok: true, data: withSession(o.data, ctx) } : o;

export const boxesHandlers = <Ctx extends BoxesCtx>() =>
  ({
    'box list': async (_, ctx) => {
      if (ctx.serve.boxes?.off(ctx.cwd) === true) return refused(BOXES_OFF.code, BOXES_OFF.message);
      const listed = await (ctx.serve.boxes?.list(ctx.serve.cloud?.listing) ?? noBoxes());

      if (!listed.ok) return listed;
      // the folder it was asked in: the Boxes tab puts that repo's boxes first (#262)

      return {
        ok: true,
        data: {
          boxes: listed.data.boxes.map((b) => withSession(b, ctx)),
          queued: listed.data.queued,
          ...(await repoHere(ctx.cwd)),
          ...unlistedOf(ctx),
        },
      };
    },
    'box status': async (args, ctx) => {
      const status = sessioned(await (ctx.serve.boxes?.status(args.box) ?? noBoxes()), ctx);
      // the profile it was found on, for an attach or forward to it (ADR 0025)
      const aws = ctx.ports?.boxAwsOf?.(args.box);

      return status.ok && aws !== undefined ? { ok: true, data: { ...status.data, aws } } : status;
    },
    'box up': async (args, ctx) => {
      const boxes = ctx.serve.boxes;
      const local = localModeBoxRefusal(ctx, ctx.cwd);

      if (local !== undefined) return local;
      if (boxes === undefined) return noBoxes();
      const repo = parseRepo(args.repo);
      const card = parseCardId(args.card);

      if (repo === undefined)
        return refused('usage', `not an <owner>/<repo> on GitHub: ${args.repo}`, 2);
      if (card === undefined) return refused('usage', `not a card id (4, AB#4): ${args.card}`, 2);
      const values = ctx.settings?.at(ctx.cwd).values ?? coreDefaults();
      const title = args.title ?? '';
      const spec = boxSpec({
        name: boxName(repo),
        repo,
        size: values['box.size'],
        maxSize: values['limits.maxBoxSize'],
        profile: ctx.ports?.profileAt?.(ctx.cwd) ?? null,
      });
      // The repo's box (ADR 0022), placed as a launch is (running and starting boxes count) and made
      // under the launches' one-at-a-time: at the limit refused, never queued here (`abe box place
      // --apply` queues).
      const claimed = await ctx.serve.cloud?.claim({
        repo,
        card,
        title,
        where: ctx.cwd,
      });

      // No cloud placement: the repo's box as listed, else a new one's name (with the repo's hex
      // when another repo's box has its name, never that box).
      if (claimed === undefined) {
        const listed = await boxes.list();

        if (!listed.ok) return listed;
        const all = listed.data.boxes;

        return boxes.up({ ...spec, name: repoBox(all, repo)?.name ?? repoBoxName(all, repo) });
      }
      if (!claimed.ok) return claimed;
      const { placed, made } = claimed.data;

      if (placed.action === 'queue')
        return refused(
          'box-limit',
          boxLimitMessage({ count: placed.boxes, limit: placed.limit }, { card }),
        );

      // Made just now: waited for, never made again. Else woken or used as it is.
      return made === undefined ? boxes.up({ ...spec, name: placed.box }) : boxes.made(made, 'up');
    },
    'box start': (args, ctx) =>
      Promise.resolve(localModeBoxRefusal(ctx, ctx.cwd)).then(
        (local) => local ?? ctx.serve.boxes?.start(args.box) ?? noBoxes(),
      ),
    'box stop': (args, ctx) => {
      // a session working there ends mid-turn: asked first (#316)
      const asks = args.yes
        ? undefined
        : boxStopRefusal(args.box, ctx.serve.cloud?.lastOn(args.box));

      if (asks !== undefined) return Promise.resolve(refused('confirm', asks));

      return ctx.serve.boxes?.stop(args.box) ?? noBoxes();
    },
    'box keep': keepHandler(true),
    'box sleep': keepHandler(false),
    'box terminate': async (args, ctx) => {
      const boxes = ctx.serve.boxes;

      if (boxes === undefined) return noBoxes();
      if (!args.yes)
        return refused(
          'confirm',
          `abe box terminate deletes box ${args.box}: its disk and workspace go, work not pushed is lost. --yes to delete it`,
        );
      const ended = await boxes.terminate(args.box);

      // A box gone may be room for one Queued.
      if (ended.ok) ctx.serve.cloud?.nudge();

      return ended;
    },
  }) satisfies Partial<Handlers<Ctx>>;
