/**
 * Where a card's box workspace goes (#57; ADR 0022: one box per repo, a workspace per card on
 * it), over your boxes as the `Boxes` port lists them: the repo's box used when it runs or comes
 * up; asleep, woken; none, one made (named for the repo, `boxName`), while your running and
 * starting boxes and the requests Queued ahead stay under the team's `limits.maxBoxesPerPerson`;
 * at it, Queued. A stopped box never counts: a wake counts once it starts. An old box (a 2.2 box
 * made for one card: its `abe:card` tag) is never placed on, though it counts while it runs. A
 * launch and `abe box place` both place by this.
 */
import { z } from 'zod';
import { boxName } from './cloud';
import { type Box, type BoxState } from '../ports';

/** The boxes `limits.maxBoxesPerPerson` counts: running or starting; a stopped one never. */
export const BOX_COUNTED: ReadonlySet<BoxState> = new Set<BoxState>(['pending', 'running']);

/** What placing a card does: `abe box place`'s `action`. */
export const PLACE_ACTIONS = ['use', 'wake', 'create', 'queue'] as const;
export type PlaceAction = (typeof PLACE_ACTIONS)[number];

export type Placement =
  | {
      kind: PlaceAction;
      /** The repo's box: its own, else the one a create makes (`boxName`, `repoBoxName`). */
      box: string;
      /** Your boxes that count now: running or starting (`BOX_COUNTED`). */
      count: number;
      limit: number;
    }
  /** The repo's box is being terminated: say so. */
  | { kind: 'refused'; code: string; message: string };

/** An old box (ADR 0022): a 2.2 box made for one card, listed but never placed on. */
export const isOldBox = (b: Pick<Box, 'card'>): boolean => b.card !== null;

/**
 * The repo's box among yours: one tagged with the repo, else one with its name and no repo tag;
 * never an old box, never a terminated one.
 */
export const repoBox = <B extends Pick<Box, 'name' | 'state' | 'repo' | 'card'>>(
  boxes: readonly B[],
  repo: string,
): B | undefined => {
  const live = boxes.filter((b) => b.state !== 'terminated' && !isOldBox(b));

  return (
    live.find((b) => b.repo === repo) ??
    // an untagged box of the repo's name (no owner in it): taken as the repo's, any owner's alike
    live.find((b) => b.repo === null && b.name === boxName(repo))
  );
};

/**
 * The name a new box for `repo` gets: the repo's (`demo-shop`), with 4 hex of the repo when
 * another of your boxes already has that name (`web-3fa2`).
 */
export const repoBoxName = (
  boxes: readonly Pick<Box, 'name' | 'state'>[],
  repo: string,
): string => {
  const plain = boxName(repo);
  const taken = boxes.some((b) => b.state !== 'terminated' && b.name === plain);

  return taken ? boxName(repo, true) : plain;
};

/**
 * `ahead`: requests already Queued, which a new one never overtakes (the queue's head is placed
 * with none).
 */
export const placeRepo = (o: {
  boxes: readonly Box[];
  repo: string;
  limit: number;
  ahead: number;
}): Placement => {
  // A terminated box is as none.
  const boxes = o.boxes.filter((b) => b.state !== 'terminated');
  const count = boxes.filter((b) => BOX_COUNTED.has(b.state)).length;
  const own = repoBox(boxes, o.repo);
  const at = (kind: PlaceAction): Placement => ({
    kind,
    box: own?.name ?? repoBoxName(boxes, o.repo),
    count,
    limit: o.limit,
  });

  if (own?.state === 'shutting-down')
    return { kind: 'refused', code: 'box-deleted', message: `box ${own.name} is being terminated` };
  if (own !== undefined && BOX_COUNTED.has(own.state)) return at('use');
  // Woken or made, it starts and counts: only with room past those Queued ahead.
  if (count + o.ahead >= o.limit) return at('queue');

  return at(own === undefined ? 'create' : 'wake');
};

/**
 * A box woken by its name or instance id (`box start`, the Boxes tab's Wake, `--on`, `box keep`;
 * #191), placed as a launch's wake is: running or starting, `use` (it counts already); asleep or
 * stopping, `wake` only with room past those Queued ahead, else `queue` (the caller refuses:
 * `box-limit`, as `box up` does). Undefined: no such box (a terminated one is none).
 */
export const placeWake = (o: {
  boxes: readonly Box[];
  box: string;
  limit: number;
  ahead: number;
}): Placement | undefined => {
  const boxes = o.boxes.filter((b) => b.state !== 'terminated');
  const own = boxes.find((b) => b.name === o.box || b.id === o.box);

  if (own === undefined) return undefined;
  if (own.state === 'shutting-down')
    return { kind: 'refused', code: 'box-deleted', message: `box ${own.name} is being terminated` };
  const count = boxes.filter((b) => BOX_COUNTED.has(b.state)).length;
  const at = (kind: PlaceAction): Placement => ({ kind, box: own.name, count, limit: o.limit });

  if (BOX_COUNTED.has(own.state)) return at('use');

  return at(count + o.ahead >= o.limit ? 'queue' : 'wake');
};

/**
 * `box-limit`'s words (`box up`, a wake by name): the count, the limit, and the way on: the
 * card's `abe box place --apply` queues it; a box without a card waits for one to stop.
 */
export const boxLimitMessage = (
  at: { count: number; limit: number },
  card?: { card: number; repo?: string },
): string =>
  `no room under limits.maxBoxesPerPerson ${at.limit}: you have ${at.count} running or starting (stopped ones do not count) and Queued requests go first; ${
    card === undefined
      ? 'stop one first, then start it'
      : `abe box place ${card.card}${card.repo === undefined ? '' : ` --repo ${card.repo}`} --apply queues it`
  }`;

/** `abe box place`'s answer: the card's box, what placing it does, your boxes and the limit. */
export const BoxPlaceData = z.object({
  box: z.string(),
  action: z.enum(PLACE_ACTIONS),
  /** Your running and starting boxes. */
  boxes: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** Done (`--apply`); absent or false: a dry run that only says what it would do (#194). */
  applied: z.boolean().optional(),
});
export type BoxPlaceData = z.infer<typeof BoxPlaceData>;

const DOES: Record<PlaceAction, string> = {
  use: 'it runs: used',
  wake: 'woken',
  create: 'made',
  queue: 'Queued until a box stops or is deleted, or the limit rises',
};

const WOULD: Record<PlaceAction, string> = {
  use: 'would use it (it runs)',
  wake: 'would wake it',
  create: 'would make it',
  queue: 'would queue it until a box stops or is deleted, or the limit rises',
};

/** `box demo-shop-102: would queue it … (3 of 3 running or starting, …) · --apply queues it`. */
export const boxPlaceText = (d: BoxPlaceData): string => {
  const room = `(${d.boxes} of ${d.limit} running or starting, limits.maxBoxesPerPerson)`;

  return d.applied === true
    ? `box ${d.box}: ${DOES[d.action]} ${room}\n`
    : `box ${d.box}: ${WOULD[d.action]} ${room} · --apply ${d.action === 'queue' ? 'queues it' : 'does it'}\n`;
};
