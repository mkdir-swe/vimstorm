/**
 * Your environment from the Mac (spec #37; ADR 0016 as amended, ADR 0021: one Workspace, one
 * box, an EC2 instance of our own): the box's name and what it is made with; which box a card's
 * session goes to, and when it is Queued at the team's limit, is `box-place.ts`'s.
 */
import { z } from 'zod';
import { BOX_SIZES, boxSizeRank } from './box-sizes';
import { BOX_STATES, type BoxSpec, type BoxState } from '../ports';
import { type SessionState } from '../session/session';

export * from './box-sizes';

/** The EC2 launch template every box is made from (the org Terraform's `terraform/box`). */
export const BOX_LAUNCH_TEMPLATE = 'abe-box';

/**
 * The instance profile (and role) a box of `owner` runs as: the org Terraform's `terraform/box` makes
 * one per person from `teams/<team>/people.yaml`, at `/abe/box/` (the box contract #54, #55, #58 read).
 */
export const boxRoleName = (owner: string): string => `abe-box-${owner}-boxes`;

/** `serve.target`'s value for "this Mac". */
export const LOCAL_TARGET = 'local';

/** `serve.target`'s value for your environment (not the default: ADR 0042). */
export const CLOUD_TARGET = 'cloud';

/** Your environment only when `serve.target` says `cloud`: anything else stays on this Mac (#166). */
export const isCloudTarget = (target: string): boolean => target === CLOUD_TARGET;

/** A box's name is its host name too: lowercase letters, digits and single `-`, at most 32. */
const MAX_NAME = 32;

/** The repo's name (not its owner) as a host name's letters: lowercase, digits and single `-`. */
const repoSlug = (repo: string) =>
  (repo.split('/').at(-1) ?? repo)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Four hex of the repo (`owner/repo`, FNV-1a): what tells two repos of one name apart. */
const repoHex = (repo: string) => {
  let h = 0x811c9dc5;

  for (const ch of repo) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h.toString(16).padStart(8, '0').slice(0, 4);
};

/**
 * The repo's box (ADR 0022: one box per repo): its name (`demo-shop`), cut to 32 characters;
 * with `clash` (another of your boxes has that name for another repo) 4 hex of the repo after it
 * (`web-3fa2`). Found again by its `abe:box` and `abe:repo` tags.
 */
export const boxName = (repo: string, clash = false): string => {
  const slug = repoSlug(repo);
  const tail = clash ? `-${repoHex(repo)}` : '';
  const head = slug.slice(0, MAX_NAME - tail.length).replace(/-+$/, '');

  return `${head === '' ? 'repo' : head}${tail}`;
};

const rank = boxSizeRank;

/**
 * Why `abe box resize` may not take a box to `size` (or `undefined` when it may): a size Abe
 * does not know, one over the team's `limits.maxBoxSize` (`max`; even with `--yes`), or sessions
 * running on it (`running`) without `yes`, since the resize stops the box.
 */
export const resizeRefusal = (o: {
  size: string;
  max: string;
  running: number;
  yes: boolean;
}): { code: string; message: string } | undefined => {
  if (rank(o.size) < 0)
    return {
      code: 'size-unknown',
      message: `${o.size} is not a box size: ${BOX_SIZES.join(', ')}`,
    };
  // In words a new user acts on (#244): the setting's key only when it must be fixed.
  if (rank(o.max) < 0)
    return {
      code: 'size-over-team-max',
      message: `the repo's largest box size (limits.maxBoxSize) is ${o.max}, not a box size: set one of ${BOX_SIZES.join(', ')}`,
    };
  if (rank(o.size) > rank(o.max))
    return {
      code: 'size-over-team-max',
      message: `${o.size} is bigger than the repo allows: its largest box size is ${o.max} · pick ${o.max} or smaller, or raise it in abe.yaml`,
    };
  if (o.running > 0 && !o.yes)
    return {
      code: 'sessions-running',
      message: `${o.running === 1 ? '1 session runs' : `${o.running} sessions run`} on the box; resizing stops it: --yes to resize anyway`,
    };

  return undefined;
};

/**
 * What `Boxes.up` makes the repo's box with: the name its placement chose (`boxName`), its repo
 * and its start size (`box.size`, never past `limits.maxBoxSize`).
 */
export const boxSpec = (b: {
  name: string;
  repo: string;
  size?: string;
  maxSize?: string;
  profile?: string | null;
}): BoxSpec => ({
  name: b.name,
  repo: b.repo,
  ...(b.size === undefined ? {} : { size: startSize(b.size, b.maxSize) }),
  ...(b.profile === undefined || b.profile === null ? {} : { profile: b.profile }),
});

/** A new box's size: `size` (`box.size`), else the largest allowed when that is smaller. */
export const startSize = (size: string, max: string | undefined): string =>
  max !== undefined && rank(max) >= 0 && rank(size) > rank(max) ? max : size;

/** Whether a box can be started again (it is stopped: its disk kept). */
export const canStart = (state: BoxState): boolean => state === 'stopped';

/** How the reason of a session its sleeping box ended begins (#192): what the Sessions tab keys on. */
export const BOX_SLEPT_WAITING = 'its box went to sleep while it waited on you';

/** How the reason of a session whose box stopped (not slept) begins (#243): what Resume keys on. */
export const boxStoppedHead = (box: string): string => `its box ${box} stopped`;

/**
 * Why a cloud session ended with its box, and the way on (#192): a box that slept (or stopped)
 * is woken by a Reopen of the session (#343), which goes on in the same workspace and Claude Code
 * conversation; a terminated one took them with it, so Launch new agent… starts fresh.
 */
export const boxStoppedReason = (o: {
  id: string;
  box: string;
  waiting: boolean;
  /** Its box was terminated (#316): no disk to go on from, a launch makes a new box. */
  gone?: boolean;
}): string =>
  o.gone === true
    ? `its box ${o.box} was terminated · Launch new agent… starts a new session on a new box: work not pushed went with it`
    : `${o.waiting ? `${BOX_SLEPT_WAITING} (${o.box}, idle)` : boxStoppedHead(o.box)} · abe session reopen ${o.id} wakes it and goes on: the same workspace and conversation`;

/** Whether its box went to sleep while it waited on you: ended, with the way on in its reason. */
export const sleptWhileWaiting = (s: { state: SessionState; reason: string | null }): boolean =>
  s.state === 'ended' && s.reason?.startsWith(BOX_SLEPT_WAITING) === true;

/** A session in one of these holds its box: the box's stop ends it (Queued holds none yet). */
export const holdsBox = (state: SessionState): boolean =>
  state === 'starting' || state === 'working' || state === 'waiting';

/**
 * A Factory run past its session that its box still carries (#67): its pull request open and no
 * outcome yet, so the box's serve reads it on (merge, deploy, Done). The box keeps itself awake
 * for it, and the Mac follows the box's events for it.
 */
export const waitsOnPr = (run: { pr: unknown; outcome: unknown }): boolean =>
  run.pr !== null && run.outcome === null;

/**
 * A Factory run carried to Done past its session (#304): its pull request merged (and deployed
 * where Done waits for that), not ended by a person (`abe factory end` stops its session itself).
 * Its session, idle at its prompt since the pull request, asks nothing more: Abe stops it, so
 * nothing reads it as waiting on you and its box sleeps as any idle box does.
 */
export const doneByItsPr = (run: {
  pr: unknown;
  outcome: string | null;
  ended: unknown;
}): boolean => run.pr !== null && run.outcome === 'done' && run.ended === null;

/** Where a box is on its way up: running, coming (pending), or down (stopped, stopping, gone). */
export const bootState = (state: BoxState): 'running' | 'coming' | 'down' => {
  if (state === 'running') return 'running';

  return state === 'pending' ? 'coming' : 'down';
};

/** One look at a box waited for: there, still on its way, or never getting there (`why`). */
export type BoxSettling = { kind: 'there' } | { kind: 'wait' } | { kind: 'failed'; why: string };

/**
 * The one rule every wait for a box uses (a launch, a wake, `box up`, a stop, a resize): one look
 * at it until EC2 says it is `want`. `state` null: EC2 lists no such box; `fresh`: just made, so
 * not listed yet is not gone. A box just asked up may still read stopped (or stopping) for a
 * moment, one just asked down running or pending; only one going away never gets there.
 */
export const boxSettling = (
  want: 'running' | 'stopped',
  state: BoxState | null,
  fresh: boolean,
): BoxSettling => {
  if (state === want) return { kind: 'there' };
  if (state === null)
    return fresh && want === 'running' ? { kind: 'wait' } : { kind: 'failed', why: 'is gone' };
  if (state === 'shutting-down' || state === 'terminated')
    return { kind: 'failed', why: `is ${state}` };
  return { kind: 'wait' };
};

/** `abe box resize`'s answer: the box, its size before and now, and its state after. */
export const BoxResizeData = z.object({
  box: z.string(),
  from: z.string(),
  to: z.string(),
  /** False when it was that size already: nothing was changed. */
  changed: z.boolean(),
  status: z.enum(BOX_STATES),
});
export type BoxResizeData = z.infer<typeof BoxResizeData>;

export const boxResizeText = (d: BoxResizeData): string =>
  d.changed
    ? `box ${d.box}: ${d.from} → ${d.to} (${d.status})\n`
    : `box ${d.box} is ${d.to} already (${d.status})\n`;
