/**
 * A box in words and numbers (#104, #143, #135): how long it is up, today's cost, the Up and Cost
 * columns, stuck starting, where it stands for a command. Pure, with only types from core's own
 * modules, so `ui` imports it as values (`@abe/core/box-text`, #37's one-module exception): every
 * screen and the CLI say a box the same way.
 */
import type { BoxCost, BoxData, BoxReach } from './box';
import type { BoxLoad } from './box-load';

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/** Box names compared with their numbers as numbers (#272): `demo-shop-2` before `demo-shop-10`. */
const NAMES = new Intl.Collator('en', { numeric: true });

/** Boxes by name, numbers in number order (#272): the Boxes tab's and `box list`'s order. */
export const byBoxName = (a: { name: string }, b: { name: string }): number =>
  NAMES.compare(a.name, b.name);

/**
 * Why your boxes are not read at all (#344): `serve.target: local` with no box profile named (by a
 * Layer's `box.profile` or the environment), so EC2 is never asked and no raw `aws` line is shown.
 */
export const BOXES_OFF = {
  code: 'boxes-off',
  message:
    'boxes are off: serve.target is local, so launches run on this machine · abe settings set serve.target cloud uses your boxes',
  /** The Boxes tab's empty state. */
  title: 'Boxes are off',
  line: 'serve.target is local, so launches run on this machine · abe settings set serve.target cloud uses your boxes',
} as const;

/** Over this long `pending`, a box is stuck starting (#104). */
export const BOX_STUCK_MS = 5 * MIN_MS;

/** Whether EC2 bills a box in this state (and the uptime log counts it up). */
export const boxUp = (state: BoxData['state']): boolean =>
  state === 'pending' || state === 'running';

/** One line of the uptime log: the box came up (`up`) or went down at `at` (ms). */
export type UptimeMove = { up: boolean; at: number };

/**
 * Minutes up between `from` and `now` (whole minutes), from a box's moves oldest first: down
 * before the first; a move to where it already is changes nothing.
 */
export const minutesUp = (moves: readonly UptimeMove[], from: number, now: number): number => {
  let upAt: number | undefined;
  let ms = 0;

  for (const m of moves) {
    if (m.up && upAt === undefined) upAt = m.at;
    else if (!m.up && upAt !== undefined) {
      ms += Math.max(0, Math.min(m.at, now) - Math.max(upAt, from));
      upAt = undefined;
    }
  }
  if (upAt !== undefined) ms += Math.max(0, now - Math.max(upAt, from));

  return Math.floor(ms / MIN_MS);
};

/**
 * Today's cost at `now` from the clock, no read (#104: it ticks every minute): a running box's
 * grows from `cost.at`, a stopped one's holds; past `dayStart` (a later midnight) only what ran
 * since. Null: nothing today.
 */
export const boxCostAt = (
  cost: BoxCost,
  running: boolean,
  now: number,
  dayStart: number,
): number | null => {
  const at = Date.parse(cost.at);
  const today = at >= dayStart;
  const since = today ? at : dayStart;
  const hours = Math.max(0, now - since) / HOUR_MS;
  const disk = cost.diskHourly ?? 0;

  if (running) return (today ? cost.usd : 0) + hours * (cost.hourly + disk);
  // asleep its disk still costs (ADR 0022)
  if (disk > 0) return (today ? cost.usd : 0) + hours * disk;

  return today && cost.minutes > 0 ? cost.usd : null;
};

/**
 * Each workspace's rough share of its box's cost (ADR 0022): `usd` split by its busy minutes
 * today (its session working); none while no workspace was busy.
 */
export const workspaceShares = (
  usd: number | null,
  busy: readonly { card: string; minutes: number }[],
): Map<string, number> => {
  const total = busy.reduce((n, b) => n + b.minutes, 0);

  return usd === null || total <= 0
    ? new Map<string, number>()
    : new Map<string, number>(
        busy.map((b) => [b.card, Math.round(((usd * b.minutes) / total) * 10_000) / 10_000]),
      );
};

/** A box this full, memory used or CPU, at a load read (10 min of it) is busy (ADR 0022). */
export const BOX_BUSY_PERCENT = 85;

/** Whether the box's load read says it is busy: memory used or CPU at `BOX_BUSY_PERCENT` or more. */
export const boxBusy = (load: Pick<BoxLoad, 'memory' | 'cpuPercent'>): boolean => {
  const { availableMb, totalMb } = load.memory;
  const used = totalMb <= 0 ? 0 : ((totalMb - availableMb) / totalMb) * 100;

  return used >= BOX_BUSY_PERCENT || load.cpuPercent >= BOX_BUSY_PERCENT;
};

/** The busy balloon (once a day a box): `demo-shop is busy · Resize to m8g.2xlarge…`. */
export const boxBusyText = (box: string, next: string | null): string =>
  next === null ? `${box} is busy` : `${box} is busy · Resize to ${next}…`;

/** What says the busy balloon once a day: the box and the local day at `at` (ms). */
export const boxBusyKey = (box: string, at: number): string => {
  const d = new Date(at);

  return `box-busy:${box}:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** A workspace's share in the Cost column: `≈$0.14`, dim (ADR 0022). */
export const shareText = (usd: number): string => `≈$${(Math.floor(usd * 100) / 100).toFixed(2)}`;

/** The Cost column: `$0.21 today`, running or not (#194: one wording); `—` nothing yet. */
export const boxCostText = (usd: number | null): string =>
  usd === null ? '—' : `$${(Math.floor(usd * 100) / 100).toFixed(2)} today`;

/** Minutes since its LaunchTime while it is up (`pending`, `running`); null asleep or unknown. */
export const boxUpMinutes = (
  b: Pick<BoxData, 'state' | 'launchedAt'>,
  now: number,
): number | null =>
  !boxUp(b.state) || b.launchedAt === null
    ? null
    : Math.max(0, Math.floor((now - Date.parse(b.launchedAt)) / MIN_MS));

/** The Up column: `1 h 12 min`, `2 h`, `0 min`; `—` for none. */
export const boxUpText = (minutes: number | null): string => {
  if (minutes === null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  if (h === 0) return `${m} min`;

  return m === 0 ? `${h} h` : `${h} h ${m} min`;
};

/** The Release column: `v11`; `—` unknown. */
export const boxReleaseText = (release: number | null): string =>
  release === null ? '—' : `v${release}`;

/** How long a box has been starting, in minutes, once that is over `BOX_STUCK_MS`; else null. */
export const boxStuckMinutes = (
  b: Pick<BoxData, 'state' | 'launchedAt'>,
  now: number,
): number | null => {
  if (b.state !== 'pending' || b.launchedAt === null) return null;
  const ms = now - Date.parse(b.launchedAt);

  return ms > BOX_STUCK_MS ? Math.floor(ms / MIN_MS) : null;
};

/**
 * Up this long with its `serve` silent, a box is past booting (a first boot installs its tools):
 * its `serve` is down, not late (the serve's `BOX_BOOT_MS`).
 */
export const BOX_SERVE_LATE_MS = 15 * MIN_MS;

/** Where a box EC2 says is `state` stands for a command: undefined while it runs (ask its serve). */
export const boxReachOfState = (
  state: BoxData['state'],
  launchedAt: string | null,
): BoxReach | undefined => {
  switch (state) {
    case 'running':
      return undefined;
    case 'pending':
      return { kind: 'starting', since: launchedAt };
    case 'stopped':
    case 'stopping':
      return { kind: 'asleep', state };
    default:
      return { kind: 'gone' };
  }
};

/** Where a listed box stands for a command; undefined: it runs and its `serve` answers. */
export const boxReachOf = (
  b: Pick<BoxData, 'state' | 'launchedAt' | 'serve' | 'reach'>,
): BoxReach | undefined => {
  if (b.state !== 'running') return boxReachOfState(b.state, b.launchedAt);
  if (b.reach !== undefined) return b.reach;

  return b.serve === 'silent' ? { kind: 'silent', since: b.launchedAt } : undefined;
};

const minutesSince = (since: string | null, now: number): number | null =>
  since === null ? null : Math.max(0, Math.floor((now - Date.parse(since)) / MIN_MS));

const forWords = (since: string | null, now: number) => {
  const m = minutesSince(since, now);

  return m === null ? '' : ` · ${boxUpText(m)}`;
};

/**
 * Silent this briefly after it had answered, a box still in its boot is restarting its `serve`:
 * its boot installs the boxes' release and restarts it (#244).
 */
const BOX_RESTART_MS = 2 * MIN_MS;

/**
 * A box EC2 runs that is still booting (#244): up under `BOX_SERVE_LATE_MS` with its `serve` not
 * answering since its boot (serve says a box whose sshd is not up yet so too), or silent under
 * `BOX_RESTART_MS` after it answered (the boot's release install restarts it). A normal boot,
 * said as `booting` (#213 B4), never as a problem; a link refused (the login, the rights) stays one.
 */
export const boxBooting = (
  b: Pick<BoxData, 'state' | 'launchedAt' | 'serve' | 'reach'>,
  now: number,
): boolean => {
  if (b.state !== 'running' || b.launchedAt === null) return false;
  if (now - Date.parse(b.launchedAt) > BOX_SERVE_LATE_MS) return false;
  const r = boxReachOf(b);

  if (r?.kind !== 'silent') return false;

  return r.stopped !== true || (r.since !== null && now - Date.parse(r.since) < BOX_RESTART_MS);
};

/**
 * A box's state in words, wherever a screen names it (#137: the widget's tooltip, Linked's Box
 * row, the Boxes tab's State; #213 B4): EC2's state, a booting one (`boxBooting`) `booting`. One
 * table, so no two screens say a box differently.
 */
export const BOX_STATE_WORDS: Readonly<Record<BoxData['state'], string>> = {
  pending: 'starting',
  running: 'running',
  stopping: 'stopping',
  stopped: 'asleep',
  'shutting-down': 'going away',
  terminated: 'gone',
};

/** A box EC2 runs whose `serve` does not answer yet in its boot (`boxBooting`), in words. */
export const BOX_BOOTING_WORD = 'booting';

/** A box's state in words at `now` (ms): `booting` while it boots, else `BOX_STATE_WORDS` (the screens'; the CLI's
 * `box list` says its own, core's `boxStateWords`). */
export const boxScreenWords = (
  b: Pick<BoxData, 'state' | 'launchedAt' | 'serve' | 'reach'>,
  now: number,
): string => (boxBooting(b, now) ? BOX_BOOTING_WORD : BOX_STATE_WORDS[b.state]);

/** A booting box (`boxBooting`) in words, with when to look again. */
export const boxBootingText = (box: string): string =>
  `box ${box} is booting: its abe serve answers in a minute or two · abe box status ${box} says when`;

/** The State column's words: `starting · 6 min`, `running · serve not answering · 2 min`. */
export const boxReachWords = (r: BoxReach, now: number): string => {
  switch (r.kind) {
    case 'asleep':
      return r.state;
    case 'starting':
      return `starting${forWords(r.since, now)}`;
    case 'silent':
      return `running · serve not answering${forWords(r.since, now)}`;
    case 'unreachable':
      return 'running · cannot be reached';
    case 'gone':
      return 'terminated';
  }
};

/** A silent serve's next step: still booting, or down (it answered before, or past `BOX_SERVE_LATE_MS`). */
const silentStep = (box: string, r: Extract<BoxReach, { kind: 'silent' }>, now: number) =>
  r.stopped === true || (r.since !== null && now - Date.parse(r.since) > BOX_SERVE_LATE_MS)
    ? `abe box attach ${box} -- journalctl -u abe-serve says why; abe box stop ${box}, then abe box start ${box} boots it again`
    : `still booting? try again in a minute; abe box status ${box} says when it answers`;

/**
 * Why a command does not get through to `box`, and the next step (#143): never to wake a box
 * that runs. `box demo-shop-1 is running · serve not answering · 2 min · still booting? …`.
 */
export const boxReachText = (box: string, r: BoxReach, now: number): string => {
  const is = `box ${box} is ${boxReachWords(r, now)}`;

  switch (r.kind) {
    case 'asleep':
      return r.state === 'stopped'
        ? `${is} · abe box start ${box} wakes it`
        : `${is} · abe box start ${box} wakes it once it has stopped`;
    case 'starting':
      return `${is} · try again in a minute; abe box status ${box} says when it runs`;
    case 'silent':
      return `${is} · ${silentStep(box, r, now)}`;
    case 'unreachable':
      return `${is}: ${r.why} · try again; abe box status ${box} says whether it answers`;
    case 'gone':
      return `${is} · abe box list names yours`;
  }
};

/**
 * Why a cloud launch waits (#194): `3 of 3 boxes running or starting (demo-shop-1, demo-shop-3,
 * demo-shop-901; limits.maxBoxesPerPerson) · starts when one stops`. A session's `queuedFor`.
 */
export const queuedForText = (q: { boxes: readonly string[]; limit: number }): string =>
  `${q.boxes.length} of ${q.limit} boxes running or starting (${q.boxes.join(', ')}; limits.maxBoxesPerPerson) · starts when one stops`;
