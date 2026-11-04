/**
 * Your boxes as the Mac's `serve` shows them (#56; ADR 0016 as amended: one workspace, one box):
 * `abe box list|start|stop`'s answers, and `--on <box>`, which sends a command to that box's own
 * `serve` instead of this one.
 */
import { z } from 'zod';
import { BOX_STATES } from '../ports';
import { BoxIdleData, boxIdleText } from './box-idle';
import { RepoHere } from '../board/here';
import { BOX_ROOT_GB, diskHourlyPrice, hourlyPrice } from './box-sizes';
import { SESSION_STATES, type SessionState, stateWords } from '../session/session';
import { localWhen, type TextAt } from '../command';
import { WorkspaceData } from './workspace';
import { BoxLoad } from './box-load';
import {
  boxCostText,
  boxReachOf,
  boxReachText,
  boxUp,
  boxReleaseText,
  minutesUp,
  type UptimeMove,
} from './box-text';

export * from './box-text';

/**
 * Today's cost of a box, an on-demand estimate (#104): its minutes up since local midnight (the
 * Mac's uptime log) times its size's hourly price (`BOX_HOURLY_USD`), plus its root disk's since
 * midnight, up or asleep (`diskHourly`, ADR 0022), as of `at`. A running box's grows from `at` at
 * `hourly` + `diskHourly` (`boxCostAt`); a stopped one's at `diskHourly` alone.
 */
export const BoxCost = z.object({
  usd: z.number().nonnegative(),
  minutes: z.number().int().nonnegative(),
  hourly: z.number().positive(),
  /** Its root disk's hourly price; absent: a read from before disks were priced. */
  diskHourly: z.number().nonnegative().optional(),
  at: z.iso.datetime(),
});
export type BoxCost = z.infer<typeof BoxCost>;

/** Whether a running box's own `serve` answered `abe status` when it was listed. */
export const BOX_SERVE = ['answers', 'silent'] as const;

/**
 * Why a command cannot get through to a box's `serve` now (#143): EC2's state, or, while it runs,
 * its `serve` not answering or the link not getting there. One set of words for `box status`,
 * `--on`, `session list`'s box note and the Boxes tab (`boxReachWords`, `boxReachText`).
 */
export const BoxReach = z.discriminatedUnion('kind', [
  /** EC2 says it sleeps, or is on its way there. */
  z.object({ kind: z.literal('asleep'), state: z.enum(['stopped', 'stopping']) }),
  /** EC2 says `pending`: starting since `since` (its LaunchTime). */
  z.object({ kind: z.literal('starting'), since: z.iso.datetime().nullable() }),
  /**
   * EC2 says it runs, but its abe serve does not answer since `since`: its LaunchTime while it
   * never answered since its boot, else when this serve first found it silent after an answer
   * (`stopped`: its serve went, so it is not booting).
   */
  z.object({
    kind: z.literal('silent'),
    since: z.iso.datetime().nullable(),
    stopped: z.literal(true).optional(),
  }),
  /** EC2 says it runs, but the link (SSH through the endpoint) does not get there: why. */
  z.object({ kind: z.literal('unreachable'), why: z.string() }),
  /** Being terminated, or gone. */
  z.object({ kind: z.literal('gone') }),
]);
export type BoxReach = z.infer<typeof BoxReach>;

/** One box: its name, its EC2 state, its size, and the workspace it holds. */
export const BoxData = z.object({
  name: z.string(),
  state: z.enum(BOX_STATES),
  /** Its instance type; null when it is not known. */
  size: z.string().nullable(),
  /** EC2's `LaunchTime`: when it last started (reset on each start); null when EC2 said none. */
  launchedAt: z.iso.datetime().nullable(),
  /**
   * The box launch template version it was made from (EC2's own `aws:ec2launchtemplate:version`
   * tag), so known asleep too: `v11`'s 11. Null for a box made otherwise.
   */
  release: z.number().int().positive().nullable(),
  /** The repo its workspaces work in, from its `abe:repo` tag (asleep too). */
  repo: z.string().nullable(),
  /**
   * An old box's one card, from its `abe:card` and `abe:title` tags (ADR 0022: a 2.2 box made for
   * one card, never launched on); null for a repo's box.
   */
  card: z.number().int().positive().nullable(),
  title: z.string().nullable(),
  /** Today's compute so far (`BoxCost`); null when its size has no price. */
  costToday: BoxCost.nullable(),
  /** While EC2 says it runs: whether its `serve` answered (`silent`: it did not); else null. */
  serve: z.enum(BOX_SERVE).nullable(),
  /** Its first workspace, from its own `abe status`: null while it sleeps or holds none yet. */
  workspace: WorkspaceData.nullable(),
  /** Every workspace on it, one per card (ADR 0022), as its last `abe status` said; none asleep. */
  workspaces: z.array(WorkspaceData).optional(),
  /** What it has left (memory, CPU, disk), as its last `abe status` said. */
  load: BoxLoad.optional(),
  /** While it runs: when it stops itself if still idle, from its own `abe status` (#92). */
  idle: BoxIdleData.optional(),
  /** While it runs and its `serve` did not answer: whether the link got there (`BoxReach`). */
  reach: BoxReach.optional(),
  /** When this was read, which the reach's minutes count to. */
  readAt: z.iso.datetime().optional(),
  /**
   * The AWS profile and region it is reached on (`box status`: the profile it was found on, ADR
   * 0025), which `box attach` and `box forward` take; null: aws's own.
   */
  aws: z.object({ profile: z.string().nullable(), region: z.string().nullable() }).optional(),
  /** While it runs and its `serve` answered: its abe's version, from its own `abe status` (#188). */
  abe: z.string().optional(),
  /** Its abe is another release than this Mac's (#188, `abeSkewed`): what to do (`abeSkewText`). */
  skew: z.string().optional(),
  /**
   * `box start` / `box up` only: it woke on another abe than this Mac's, which its boot may still
   * replace with the boxes' release (#244, `abeWokeText`).
   */
  woke: z.string().optional(),
  /**
   * The session of yours this Mac launched there and last heard of, open or not (#194: the
   * session's state, not the workspace container's).
   */
  session: z
    .object({ id: z.string(), state: z.enum(SESSION_STATES), since: z.iso.datetime() })
    .optional(),
  /** Each workspace's (by card) newest session of yours this Mac launched there (ADR 0022). */
  cardSessions: z.array(z.object({ card: z.string(), id: z.string() })).optional(),
  /**
   * Each workspace's (by card) minutes busy today (its session working, as this Mac saw it): what
   * its cost share is split by (`workspaceShares`).
   */
  busyToday: z
    .array(z.object({ card: z.string(), minutes: z.number().int().nonnegative() }))
    .optional(),
  /**
   * Its last load read says it is busy (`boxBusy`, ADR 0022): the next size within the team's
   * `limits.maxBoxSize`, null when there is none. Absent: not busy, or not read.
   */
  busy: z.object({ next: z.string().nullable() }).optional(),
});
export type BoxData = z.infer<typeof BoxData>;

/**
 * Why `abe box stop` asks first (#316): a session of yours is starting or working on the box,
 * and stopping it ends that session mid-turn. Undefined: nothing works there (a session waiting
 * on you, ended, or none), the stop goes ahead.
 */
export const boxStopRefusal = (
  box: string,
  session: { id: string; state: SessionState } | undefined,
): string | undefined =>
  session === undefined || (session.state !== 'starting' && session.state !== 'working')
    ? undefined
    : `session ${session.id} is ${session.state} on box ${box}: stopping the box ends it mid-turn (its branch and files stay on the box; a Retry starts a new session there). abe box stop ${box} --yes stops it anyway`;

/** A placement Queued at `limits.maxBoxesPerPerson` (#57): the box it will be, once there is room. */
export const QueuedBoxData = z.object({
  /** The name the box gets (or has, asleep: it is woken then). */
  box: z.string(),
  repo: z.string(),
  card: z.number().int().positive(),
  title: z.string(),
  /** When it was Queued. */
  since: z.iso.datetime(),
});
export type QueuedBoxData = z.infer<typeof QueuedBoxData>;

/** `abe box list`: your boxes, and your placements Queued for one, oldest first. */
export const BoxListData = z.object({
  boxes: z.array(BoxData),
  queued: z.array(QueuedBoxData),
  /**
   * The repo it was asked in (as `session list` names it, #256): the Boxes tab puts that repo's
   * boxes first and names every other's (#262); none: asked in no checkout, or an older serve.
   */
  here: RepoHere.optional(),
  /**
   * Each other AWS profile your checkouts name whose boxes could not be listed, in one line:
   * `<profile>: its boxes not listed: <why>` (ADR 0025); none: every one was.
   */
  unlisted: z.array(z.string()).optional(),
});
export type BoxListData = z.infer<typeof BoxListData>;

/**
 * `abe box keep` / `abe box sleep`'s answer (#104), and the `box.idle` event's data: the box's
 * idle stop as its own `serve` holds it now.
 */
export const BoxKeepData = z.object({ box: z.string(), idle: BoxIdleData });
export type BoxKeepData = z.infer<typeof BoxKeepData>;

export const boxKeepText = (d: BoxKeepData, at?: TextAt): string =>
  `${d.box}  ${boxIdleText(d.idle, at)}\n`;

/** To a hundredth of a cent. */
const round4 = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** Today's cost (`BoxCost`) from the box's moves since `dayStart` (local midnight); null: no price. */
export const boxCostToday = (o: {
  moves: readonly UptimeMove[];
  size: string | null;
  dayStart: number;
  now: number;
  /** Its root disk (the box's load said; default the launch template's `BOX_ROOT_GB`). */
  diskGb?: number;
}): BoxCost | null => {
  const hourly = o.size === null ? null : hourlyPrice(o.size);

  if (hourly === null) return null;
  const minutes = minutesUp(o.moves, o.dayStart, o.now);
  const diskHourly = diskHourlyPrice(o.diskGb ?? BOX_ROOT_GB);
  // its disk since midnight, or since it was first seen today
  const first = o.moves[0]?.at ?? o.now;
  const diskHours = Math.max(0, o.now - Math.max(o.dayStart, first)) / 3_600_000;

  return {
    usd: round4((minutes / 60) * hourly + diskHours * diskHourly),
    minutes,
    hourly,
    diskHourly,
    at: new Date(o.now).toISOString(),
  };
};

/** A box in trouble for a command (starting, its serve silent, the link not there): its own line. */
const reachLine = (b: BoxData): string => {
  const r = boxReachOf(b);

  if (r === undefined || r.kind === 'asleep' || r.kind === 'gone' || b.readAt === undefined)
    return '';

  return `\n  ${boxReachText(b.name, r, Date.parse(b.readAt))}`;
};

/**
 * Its state in one word set (#194): EC2's `pending` is `starting`, as everywhere; a running box
 * whose `serve` has not answered since its boot is `booting · serve not answering yet`.
 */
export const boxStateWords = (
  b: Pick<BoxData, 'state' | 'launchedAt' | 'serve' | 'reach'>,
): string => {
  const r = boxReachOf(b);

  if (b.state === 'pending') return 'starting';
  if (b.state === 'shutting-down') return 'terminating';
  if (r?.kind === 'silent')
    return r.stopped === true
      ? 'running · serve not answering'
      : 'booting · serve not answering yet';

  return b.state;
};

/** What runs there: the session's state (yours, as last heard), else the workspace's. */
const holdsText = (b: BoxData, now: number | undefined) => {
  if (b.workspace === null && b.session === undefined) return '';
  const where =
    b.workspace === null
      ? ''
      : `  ${b.workspace.repo} card ${b.workspace.card}${
          b.workspace.state === 'running' ? '' : ` (workspace ${b.workspace.state})`
        }`;
  const s = b.session;

  return s === undefined
    ? where
    : `${where}  session ${s.id} ${stateWords(s.state)} since ${localWhen(s.since, now)}`;
};

const boxLine = (b: BoxData, at?: TextAt) => {
  const now = b.readAt === undefined ? at?.now : Date.parse(b.readAt);
  const asOf = now === undefined ? undefined : { now };

  return `${b.name}  ${boxStateWords(b)}${b.size === null ? '' : `  ${b.size}`}${
    b.release === null ? '' : `  ${boxReleaseText(b.release)}`
  }${b.abe === undefined ? '' : `  abe ${b.abe}`}${
    b.costToday === null || (b.costToday.minutes === 0 && !boxUp(b.state))
      ? ''
      : `  ${boxCostText(b.costToday.usd)}`
  }${holdsText(b, now)}${b.idle === undefined ? '' : `  ${boxIdleText(b.idle, asOf, b.name)}`}${reachLine(b)}${
    b.skew === undefined ? '' : `\n  ${b.skew}`
  }${b.woke === undefined ? '' : `\n  ${b.woke}`}`;
};

const queuedLine = (q: QueuedBoxData, at?: TextAt) =>
  `${q.box}  queued since ${localWhen(q.since, at?.now)}  ${q.repo} card ${q.card}  (starts when one of yours stops)`;

export const boxText = (b: BoxData, at?: TextAt): string => `${boxLine(b, at)}\n`;

export const boxListText = (l: BoxListData, at?: TextAt): string =>
  `${
    l.boxes.length === 0 && l.queued.length === 0
      ? 'no boxes\n'
      : `${[...l.boxes.map((b) => boxLine(b, at)), ...l.queued.map((q) => queuedLine(q, at))].join('\n')}\n`
  }${(l.unlisted ?? []).map((line) => `${line}\n`).join('')}`;

/** argv with `--on <box>` taken out: the box it names, if any, and the rest unchanged. */
export type SplitOn =
  { ok: true; on: string | undefined; argv: string[] } | { ok: false; message: string };

/**
 * Takes `--on <box>` (or `--on=<box>`) out of argv, anywhere before a `--`: what is left is the
 * command for that box's `serve`, word for word. Given twice or without a box is a usage error.
 */
export const splitOn = (argv: readonly string[]): SplitOn => {
  const rest: string[] = [];
  let on: string | undefined;
  let literal = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';

    if (literal || (token !== '--on' && !token.startsWith('--on='))) {
      if (token === '--') literal = true;
      rest.push(token);
      continue;
    }
    const value = token === '--on' ? argv[i + 1] : token.slice('--on='.length);

    if (token === '--on') i += 1;
    if (value === undefined || value === '' || value.startsWith('-'))
      return { ok: false, message: '--on needs a box' };
    if (on !== undefined) return { ok: false, message: '--on is given twice' };
    on = value;
  }

  return { ok: true, on, argv: rest };
};
