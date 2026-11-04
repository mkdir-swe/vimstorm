/**
 * The Boxes tab (#104 S2, board X-Boxes): the bottom pane's `boxes` screen, a Table of your boxes
 * (`abe box list`: EC2 only lists the ones tagged with your login) and your placements Queued for
 * one, a 30 px row each. It reads `box list` once on open; after that `box.state` and `box.idle`
 * change rows in place (a box it does not know is read with the list again), a `box.step`
 * `booting` says a waking box runs with its `serve` not answering yet, a `box.state` `running`
 * (its serve answers) reads the list again for its idle stop and abe (#217), `r` reads it now, and
 * while it is the pane's screen it reads the list again quietly every 5 minutes for what changed
 * outside Abe. Up, Cost and how long a box has been starting tick from the clock without reads.
 *
 * Problems first (stuck starting over 5 minutes, running with its `serve` not answering or not
 * reached past its boot: core's `boxReachWords`, the tooltip its `boxReachText`; a normal boot is
 * starting, #244), then running, starting,
 * Queued, stopping, asleep; by name within each. ⏎ attaches: a bottom-pane Terminal tab on the
 * box's own shell, `abe box attach <box> -- bash -l` (a sleeping box is woken by the attach
 * itself); on a workspace row, its card's workspace's shell. Open card is the jump (#106) along
 * the selected row's story (`linked`): its card. ⌘⏎ opens the box's menu (#104 S3, board X-BoxMenu):
 * its rows by state (`boxMenu`), Keep awake / Let it sleep / Stop now / Wake run in Command mode,
 * the rest come back here: Attach, Forward port… (its port asked), Resize… (a pick of the sizes up
 * to the team's `limits.maxBoxSize`, asked `y` when sessions run on it) and
 * Terminate… (red, `t` as the menu's first key, asked `y`; IAM's refusal said in a red balloon).
 *
 * A dev server's ports (#16): `port list` is read with `box list`; under each workspace row, one
 * row per port of that (box, card), forwarded (`:3000 → localhost:3000 · ● open`) or offered
 * (`:3000 listening`, dim); `port.forward` and `workspace.ports` change them in place. ⏎ opens it
 * in the browser, forwarding it first (`port open`); ⌘⏎ Open in browser · Stop forwarding.
 */
import {
  type BoxData,
  type BoxSize,
  type CardListData,
  type Event,
  type IdleKeep,
  type PortForward,
  type PortOffer,
  type QueuedBoxData,
  type RepoHere,
} from '@abe/core';
import { forwardKey, forwardUrl, portForwardText } from '@abe/core/box-ports';
import { isHere } from '@abe/core/here';
import { clock } from '../board/card-actions';
import {
  BOX_BOOTING_WORD,
  BOXES_OFF,
  boxBooting,
  boxBootingText,
  boxCostText,
  boxReachText,
  boxReachWords,
  boxUpMinutes,
  boxUpText,
  byBoxName,
  shareText,
  workspaceShares,
} from '@abe/core/box-text';
import {
  type BoxMoveAt,
  boxesBooting,
  boxesIdled,
  boxesMoved,
  boxProblem,
  costAt,
  isGone,
  REREAD_MS,
  replayMoves,
} from '../live/box-feed';
import {
  type ColumnWidth,
  type Hue,
  type Node,
  type Table,
  type TableCell,
  island,
} from '../runtime/components';
import { jumpCommands } from '../board/jumps';
import { type ViewSize } from '../runtime/protocol';
import {
  type Command,
  type Input,
  type Menu,
  type MenuRow,
  type Screen,
  type Word,
  type Here,
} from '../runtime/runtime';
import {
  filterNote,
  fits,
  listClick,
  listKey,
  listScroll,
  selectOn,
  type ListOf,
  type ListPlace,
  listText,
  released,
  reopened,
  selectedRow as listSelected,
  settle as settleList,
  shownRows as listShown,
  windowed,
} from '../runtime/table-list';
import { shortTitle } from '../board/workspaces';

import type { Facts } from '../live';
export { costAt } from '../live/box-feed';

export type BoxesState = ListPlace & {
  opened: boolean;
  size?: ViewSize | undefined;
  /** The clock (`tick`): Up, Cost and the stuck time are worked out from it. */
  now?: string | undefined;
  boxes?: BoxData[] | undefined;
  queued?: QueuedBoxData[] | undefined;
  /** The repo `box list` was asked in (its `here`): its boxes first (#262); none: not known. */
  here?: RepoHere | undefined;
  /** Why the boxes were not read (`box list` refused, `boxes.unread`); cleared by a list read. */
  /**
   * Why the list was not read; an `aws-auth`'s `profile` is the profile to log in with, `keys`
   * when it signs in with an IAM user's keys.
   */
  failed?:
    | { code: string; message: string; profile?: string | undefined; keys?: boolean | undefined }
    | undefined;
  /** When `box list` was last asked (ms), and whether its answer is still to come. */
  readAt?: number | undefined;
  reading: boolean;
  /** When the last `box list` answered (the clock's time then): the key line says it (#287). */
  readDone?: string | undefined;
  /** The `box.state` moves said while `box list` is out: put back on its answer. */
  since?: readonly BoxMoveAt[] | undefined;
  /** A box's `serve` answered while `box list` was out (#217): read again once it answers. */
  again?: boolean | undefined;
  /**
   * The board's card titles (`card list`), read once a box tagged with a card has no `abe:title`:
   * its Story column says the card's title then; read again when such a card is not among the
   * cards it was last read for (`titlesFor`).
   */
  titles?: Readonly<Record<number, string>> | undefined;
  titlesFor?: readonly number[] | undefined;
  /** The team's card list last handed (live's): what `titles` took from. */
  team?: CardListData | undefined;
  /** The box the `open` param names (Linked's box row): selected once its row comes. */
  want?: string | undefined;
  /** The box whose Resize… waits on the team's `limits.maxBoxSize` being read. */
  resizing?: string | undefined;
  /** `port list` (#16): the forwards this Mac holds and the ports offered, kept by events. */
  ports?: BoxPorts | undefined;
};

/** The workspaces' ports (#16): forwarded, or listening and offered. */
export type BoxPorts = { forwards: PortForward[]; offered: PortOffer[] };

type Out = { state: BoxesState; commands: Command[] };

const INIT: BoxesState = { opened: false, reading: false, top: 0, g: false };

/**
 * The columns. X-Boxes draws Story 220, State 100 and Until taking the rest; here Story takes what
 * the others leave, so the Editor's narrower pane (~960 px beside the Chat column) keeps the
 * story's short title whole: the others are as narrow as their usual words (`demo-shop-102`,
 * `m8g.large`, `1 h 12 min`, `$0.84 today`, `stops at 10:30`), State 180 for `starting · 6 min`
 * (a longer problem or keep is elided and says itself in full on hover).
 */
const COLUMNS: { label: string; width: ColumnWidth }[] = [
  { label: 'Box', width: { fixed: 100 } },
  { label: 'Story', width: { flex: 1 } },
  { label: 'State', width: { fixed: 180 } },
  { label: 'Size', width: { fixed: 72 } },
  { label: 'Disk', width: { fixed: 76 } },
  { label: 'Release', width: { fixed: 52 } },
  { label: 'Up', width: { fixed: 70 } },
  { label: 'Cost', width: { fixed: 80 } },
  { label: 'Until', width: { fixed: 92 } },
];

/** A row's place in the order. */
const GROUP = { problem: 0, running: 1, starting: 2, queued: 3, stopping: 4, asleep: 5 } as const;

type Look = keyof typeof GROUP;

/** One row, worked out at `now`. */
export type BoxRow = {
  id: string;
  name: string;
  /** Undefined: a Queued placement. */
  box?: BoxData | undefined;
  card: number | null;
  title: string | null;
  /** The repo it works on (`owner/name`), null when it does not say. */
  repo: string | null;
  /**
   * Another repo's box (#262): that repo, named on its row; every repo's while the one it was
   * asked in is not known and the boxes are of more than one.
   */
  elsewhere?: string | undefined;
  look: Look;
  /**
   * A box workspace's row (ADR 0022), under its box's: its card and its container's state, its
   * clone's disk as the box's load last said.
   */
  workspace?: { card: string; state: string; diskGb: number | undefined } | undefined;
  /** An old box (a 2.2 box made for one card): listed with ⚠, never launched on. */
  old?: boolean | undefined;
  /** A problem's words in the State column (`starting · 6 min`, core's `boxReachWords`). */
  problem?: string | undefined;
  /**
   * Its sentence with the next step (`boxReachText`, as `--on` says it; a booting box's
   * `boxBootingText`): the State cell's tooltip.
   */
  why?: string | undefined;
  /** Starting as a booting box (#244), its State `booting` (core's word, #213 B4). */
  booting?: true;
  /** A port row (#16), under its workspace's: forwarded (`forward`), else offered. */
  port?: PortRow | undefined;
};

type PortRow = { card: string; port: number; fixed: boolean; forward?: PortForward | undefined };

const BOX_ROW = 'box:';
/** A workspace row's id after its box's: `box:demo-shop:ws:101`. */
const WS_ROW = ':ws:';
/** A port row's id after its workspace's: `box:demo-shop:ws:101:port:3000`. */
const PORT_ROW = ':port:';
const LOGIN_ROW = 'boxes:aws-login';

const lookOf = (b: BoxData): Look => {
  switch (b.state) {
    case 'running':
      return 'running';
    case 'pending':
      return 'starting';
    case 'stopping':
      return 'stopping';
    default:
      return 'asleep';
  }
};

/** A box's story title: its `abe:title` tag, else the board's title of its card. */
const titleOf = (b: BoxData, titles: BoxesState['titles']): string | null => {
  if (b.title !== null && b.title !== '') return b.title;

  return b.card === null ? null : (titles?.[b.card] ?? null);
};

const boxRow = (b: BoxData, now: number, titles: BoxesState['titles']): BoxRow => {
  const base = {
    id: `${BOX_ROW}${b.name}`,
    name: b.name,
    box: b,
    card: b.card,
    title: titleOf(b, titles),
    repo: b.repo,
    // ADR 0022: a box made for one card (its card tag) is an old box.
    ...(b.card === null ? {} : { old: true }),
  };
  const problem = boxProblem(b, now);

  if (problem !== undefined)
    return {
      ...base,
      look: 'problem',
      problem: boxReachWords(problem, now),
      why: boxReachText(b.name, problem, now),
    };

  // a normal boot (#244): with the starting ones, `booting`, its tooltip when it answers
  if (boxBooting(b, now))
    return { ...base, look: 'starting', booting: true, why: boxBootingText(b.name) };

  return { ...base, look: lookOf(b) };
};

/** The clock's last `tick` (the bridge sends one as a screen opens; before it, the epoch). */
const nowOf = (s: BoxesState): number => (s.now === undefined ? 0 : Date.parse(s.now));

/** A workspace's ports (#16), by port: each forward of it, then each port offered there. */
const portsOf = (ports: BoxPorts | undefined, box: string, card: string): PortRow[] => {
  const forwards = (ports?.forwards ?? []).filter((f) => f.box === box && f.card === card);
  const held = new Set(forwards.map((f) => f.port));

  return [
    ...forwards.map((f): PortRow => ({ card, port: f.port, fixed: f.fixed, forward: f })),
    ...(ports?.offered ?? [])
      .filter((o) => o.box === box && o.card === card && !held.has(o.port))
      .map((o): PortRow => ({ card, port: o.port, fixed: o.fixed })),
  ].sort((a, b) => a.port - b.port);
};

/** A box's workspace rows (ADR 0022), by card, under its own row; each one's ports under it. */
const workspaceRows = (
  r: BoxRow,
  titles: BoxesState['titles'],
  ports: BoxPorts | undefined,
): BoxRow[] => {
  const b = r.box;

  // an old box (ADR 0022) is never launched on: its one workspace is not offered as one
  if (b === undefined || r.old === true) return [];
  const disk = new Map((b.load?.workspaces ?? []).map((w) => [w.card, w.diskGb]));

  return [...(b.workspaces ?? [])]
    .sort((x, y) => x.card.localeCompare(y.card, 'en', { numeric: true }))
    .flatMap((w): BoxRow[] => {
      const card = Number(w.card);
      const known = Number.isInteger(card) && card > 0 ? card : null;
      const ws: BoxRow = {
        ...r,
        id: `${r.id}${WS_ROW}${w.card}`,
        card: known,
        title: known === null ? null : (titles?.[known] ?? null),
        workspace: { card: w.card, state: w.state, diskGb: disk.get(w.card) },
      };

      return [
        ws,
        ...portsOf(ports, b.name, w.card).map((port): BoxRow => ({
          ...ws,
          id: `${ws.id}${PORT_ROW}${String(port.port)}`,
          workspace: undefined,
          port,
        })),
      ];
    });
};

/**
 * Your boxes and Queued placements in order: problems, running, starting, Queued, stopping,
 * asleep; each box's workspaces under it.
 */
export const boxRows = (s: BoxesState): BoxRow[] => {
  const now = nowOf(s);
  const named = new Set((s.boxes ?? []).map((b) => b.name));

  return [
    ...(s.boxes ?? []).filter((b) => !isGone(b)).map((b) => boxRow(b, now, s.titles)),
    // a placement whose box is listed is that box's row (woken once there is room)
    ...(s.queued ?? [])
      .filter((q) => !named.has(q.box))
      .map((q): BoxRow => ({
        id: `${BOX_ROW}${q.box}`,
        name: q.box,
        card: q.card,
        title: q.title,
        repo: q.repo,
        look: 'queued',
      })),
  ]
    .sort(
      (a, b) =>
        repoOrder(s.here, a.repo, b.repo) || GROUP[a.look] - GROUP[b.look] || byBoxName(a, b),
    )
    .map((r, _, all) => withRepo(s.here, r, all))
    .flatMap((r) => [r, ...workspaceRows(r, s.titles, s.ports)]);
};

/** This repo's boxes first (and one that names none), then each other repo's by its name (#262). */
const repoOrder = (here: RepoHere | undefined, a: string | null, b: string | null): number => {
  const rank = (r: string | null) =>
    r === null || (here !== undefined && isHere(here, r)) ? '' : r.toLowerCase();

  return rank(a).localeCompare(rank(b));
};

/**
 * A row named with its repo when it is another's (#262): never the repo it was asked in; every
 * repo while that is not known (no checkout there, an older serve) and the boxes are of more
 * than one; none while they are all of one.
 */
const withRepo = (here: RepoHere | undefined, r: BoxRow, all: readonly BoxRow[]): BoxRow => {
  if (r.repo === null) return r;
  const many = new Set(all.map((x) => x.repo?.toLowerCase())).size > 1;
  const other = here === undefined ? many : !isHere(here, r.repo);

  return other ? { ...r, elsewhere: r.repo } : r;
};

const filterText = (s: BoxesState): string => s.filter?.text ?? '';

const matches = (r: BoxRow, f: string): boolean =>
  r.port !== undefined ? `:${String(r.port.port)}`.includes(f) : matchesBox(r, f);

const matchesBox = (r: BoxRow, f: string): boolean =>
  (r.workspace !== undefined && `#${r.workspace.card}`.includes(f)) ||
  r.name.toLowerCase().includes(f) ||
  (r.elsewhere ?? '').toLowerCase().includes(f) ||
  (r.title ?? '').toLowerCase().includes(f) ||
  (r.card !== null && `#${r.card}`.includes(f));

/** The AWS login expired: one row, ⏎ logs in again. */
const loginOf = (s: BoxesState): { profile: string | null; keys: boolean } | undefined => {
  if (s.failed?.code !== 'aws-auth') return undefined;

  return { profile: s.failed.profile ?? null, keys: s.failed.keys ?? false };
};

/** The sign-in for `login`: Identity Center's `aws sso login`, an IAM user's `aws configure`. */
const loginArgv = (login: { profile: string | null; keys: boolean }): string[] => [
  'aws',
  ...(login.keys ? ['configure'] : ['sso', 'login']),
  ...(login.profile === null ? [] : ['--profile', login.profile]),
];

/** The rows as the list sees them (none while the login row stands in their place). */
const listOf = (s: BoxesState): ListOf<BoxRow> => ({
  all: loginOf(s) === undefined ? boxRows(s) : [],
  keyOf: (r) => r.id,
  matches,
  room: fits(s.size),
});

/** The rows the filter leaves, in the list's order (`table-list.ts`). */
const shownRows = (s: BoxesState): BoxRow[] => listShown(s, listOf(s));

const selectedRow = (s: BoxesState): BoxRow | undefined => listSelected(s, listOf(s));

/** The selection settled (`table-list.ts`); the box the `open` param named once its row comes. */
const settle = (s0: BoxesState): BoxesState => {
  const wanted = s0.want !== undefined && shownRows(s0).some((r) => r.id === s0.want);
  const next = settleList(wanted ? selectOn(s0, s0.want ?? '') : s0, listOf(s0));

  // kept until its row shows (a port row comes with `port list`, after `box list`)
  if (wanted && next.want === next.selected) delete next.want;

  return next;
};

const shell = (effect: Extract<Command, { kind: 'shell' }>['effect']): Command => ({
  kind: 'shell',
  effect,
});

/**
 * ⏎ on a box: a bottom-pane Terminal tab on the box's own shell (`-- bash -l`, never a
 * workspace's; `abe box attach` wakes a sleeping one first); on a workspace row, that card's
 * workspace's shell (`--card`, ADR 0022).
 */
export const attachCommand = (box: string, card?: string): Command =>
  shell({
    kind: 'terminal-tab',
    argv: [
      'abe',
      'box',
      'attach',
      box,
      ...(card === undefined ? ['--', 'bash', '-l'] : ['--card', card]),
    ],
    title: card === undefined ? box : `${box} #${card}`,
  });

/** What ⏎ attaches a row to: a workspace row's card's workspace, else the box's own shell. */
const attachOf = (row: BoxRow): Command[] =>
  row.box === undefined ? [] : [attachCommand(row.name, row.workspace?.card)];

/** The story a row's jumps go along: its own (a workspace's, an old box's), else its box's only one. */
const storyOf = (row: BoxRow): number | undefined => {
  if (row.card !== null) return row.card;
  const only = attachCard(row);
  const card = only === undefined ? NaN : Number(only);

  return Number.isInteger(card) && card > 0 ? card : undefined;
};

/** The session Download locally copies: a workspace row's card's own, else the box's. */
const downloadSession = (row: BoxRow): string | undefined => {
  const b = row.box;

  if (row.workspace === undefined) return b?.session?.id;
  const card = row.workspace.card;

  return b?.cardSessions?.find((c) => c.card === card)?.id;
};

/** The row's card: its workspace's, else the box's only workspace's. */
const attachCard = (row: BoxRow): string | undefined => {
  if (row.workspace !== undefined) return row.workspace.card;
  const held = row.box?.workspaces ?? [];

  return held.length === 1 ? held[0]?.card : undefined;
};

/** ⏎ on the login row: the profile's sign-in in a Terminal mode tab. */
const loginCommand = (login: { profile: string | null; keys: boolean }): Command =>
  shell({
    kind: 'terminal-tab',
    argv: loginArgv(login),
    title: loginArgv({ ...login, profile: null }).join(' '),
  });

/**
 * Each box size's place, smallest first: core's `BOX_SIZES` (ui may import only types from core;
 * a record over `BoxSize`, so the compiler holds this copy to it).
 */
const SIZE_RANK: Readonly<Record<BoxSize, number>> = {
  'm8g.large': 0,
  'm8g.xlarge': 1,
  'm8g.2xlarge': 2,
  'm8g.4xlarge': 3,
  'm8g.8xlarge': 4,
  'm8g.12xlarge': 5,
  'm8g.16xlarge': 6,
};

const SIZES = Object.entries(SIZE_RANK)
  .sort((a, b) => a[1] - b[1])
  .map(([size]) => size);

/** The sizes Resize… offers: up to the team's `limits.maxBoxSize` (all when it is no size). */
export const sizesUpTo = (max: string): string[] => {
  const at = SIZES.findIndex((s) => s === max);

  return at < 0 ? [...SIZES] : SIZES.slice(0, at + 1);
};

/** The workspace's folder on a box (core's `box-session` workdir). */
const WORKDIR = '/workspace/repo';

const SIZE_MENU = 'box-size:';

/** A Remove workspace…'s run id: `boxes:remove-workspace:<box> <card>`. */
const REMOVE_WS = 'boxes:remove-workspace:';

const run = (argv: string[]): MenuRow['does'] => ({ kind: 'run', argv });

/** The menu's header: `demo-shop-102 · #2 cart total ignores quantity`. */
const menuTitle = (row: BoxRow): string =>
  row.card === null
    ? row.name
    : `${row.name} · #${row.card}${row.title === null ? '' : ` ${shortTitle(row.title)}`}`;

/** The Until column's words for a running box, why Let it sleep has nothing to do. */
const notKeptWhy = (b: BoxData, now?: number): string => {
  const until = untilCell(b, now).text;

  return until === undefined || until === '—' ? 'not kept awake' : until;
};

/** Why a box not up cannot stop or forward a port: it is stopping, or asleep. */
const asleepWhy = (b: BoxData): string => (b.state === 'stopping' ? 'stopping' : 'asleep');

/**
 * ⌘⏎: the box's menu (Command mode's Action menu, board X-BoxMenu), rows by state. Running:
 * Keep awake first (Let it sleep first once kept); asleep: Wake first, what needs it awake says
 * `wakes it`, Stop now and Forward port… grey; starting: as running, Attach and Open workspace
 * `when it answers`; Queued: Open story and why it waits. Terminate… is the one risky row.
 */
export const boxMenu = (row: BoxRow): Menu => {
  const b = row.box;
  const card = storyOf(row);
  const story: MenuRow = {
    id: 'story',
    text: 'Open card',
    ...(card === undefined ? { reason: 'no story' } : {}),
    does: { kind: 'back' },
  };
  const base = { kind: 'menu' as const, id: row.id, title: menuTitle(row) };

  if (b !== undefined && row.port !== undefined) return portMenu(row.name, row.port, base);
  if (b !== undefined && row.workspace !== undefined) return workspaceMenu(row, b, base, story);
  if (b !== undefined && row.old === true) return oldBoxMenu(row, b, base, story);
  if (b === undefined)
    return {
      ...base,
      rows: [
        { ...story, ...(row.card === null ? {} : { dim: `#${row.card}` }) },
        {
          id: 'queued',
          text: 'Queued',
          reason: 'starts when a box stops or the limit rises',
          does: { kind: 'back' },
        },
      ],
    };
  const awake = b.state === 'running' || b.state === 'pending';
  const kept = b.idle?.keptBy.includes('awake') === true;
  // starting, or booting with its serve not up yet (#244: its row says starting)
  const later = b.state === 'pending' || row.look === 'starting' ? 'when it answers' : undefined;
  // why what needs it awake cannot run (else, wakes it)
  const asleep = awake ? undefined : asleepWhy(b);
  const detail = (dim: string | undefined) => (dim === undefined ? {} : { dim });
  const wakes = (dim: string | undefined) => detail(asleep === undefined ? dim : 'wakes it');
  const keep: MenuRow = {
    id: 'keep',
    text: 'Keep awake',
    ...(kept ? { reason: 'already kept' } : wakes('until you say')),
    does: run(['box', 'keep', row.name]),
  };
  const sleep: MenuRow = {
    id: 'sleep',
    text: 'Let it sleep',
    ...(kept ? { dim: 'kept awake' } : { reason: notKeptWhy(b) }),
    does: run(['box', 'sleep', row.name]),
  };
  const wake: MenuRow = {
    id: 'wake',
    text: 'Wake',
    key: '⏎',
    does: run(['box', 'start', row.name]),
  };
  const awakeFirst = kept ? [{ ...sleep, key: '⏎' }, keep] : [{ ...keep, key: '⏎' }, sleep];
  const first: MenuRow[] = awake ? awakeFirst : [wake, keep];
  // `box forward` never waits for a box to come up
  const unforwarded = asleep ?? later;
  const rows: MenuRow[] = [
    ...first,
    {
      id: 'stop',
      text: 'Stop now',
      ...(asleep === undefined ? {} : { reason: asleep }),
      // a session working there ends mid-turn: asked first, as `box stop` asks --yes (#316)
      does:
        b.session?.state === 'working' || b.session?.state === 'starting'
          ? {
              kind: 'back',
              confirm: {
                question: `Stop ${row.name}?`,
                details: [
                  `Session ${b.session.id} is ${b.session.state} there: it ends mid-turn. Its branch and files stay on the box; Retry starts a new session there.`,
                ],
                yes: 'Stop',
              },
            }
          : // answered here: a session that began working since the list was read asks then
            { kind: 'back' },
    },
    { id: 'attach', text: 'Attach', ...wakes(later), does: { kind: 'back' } },
    {
      id: 'forward',
      text: 'Forward port…',
      ...(unforwarded === undefined ? {} : { reason: unforwarded }),
      does: {
        kind: 'back',
        ask: [
          {
            name: 'port',
            kind: 'positional',
            type: 'number',
            required: true,
            repeats: false,
            summary: `abe box forward ${row.name} <port>: 127.0.0.1 on this machine reaches it`,
            title: 'Port on the box',
          },
        ],
      },
    },
    {
      id: 'resize',
      text: 'Resize…',
      ...(awake && b.size !== null ? { dim: `now ${b.size}` } : {}),
      does: { kind: 'back' },
    },
    {
      id: 'terminate',
      text: 'Terminate…',
      key: 't',
      letter: 't',
      risky: true,
      does: {
        kind: 'back',
        confirm: {
          question: `Terminate ${row.name}?`,
          details: ['Its disk and every workspace on it are deleted; work not pushed is lost.'],
          yes: 'Terminate',
        },
      },
    },
    { ...story, ...(awake && card !== undefined ? { dim: `#${card}` } : {}) },
    {
      id: 'workspace',
      text: 'Open workspace',
      ...(card === undefined ? { reason: 'no workspace' } : wakes(later ?? WORKDIR)),
      does: { kind: 'back' },
    },
  ];

  return { ...base, rows };
};

type MenuBase = { kind: 'menu'; id: string; title: string };

/** Whether a port row's forward is open: ⏎ opens the browser on it at once. */
const isOpen = (p: PortRow): p is PortRow & { forward: PortForward } => p.forward?.state === 'open';

/**
 * ⌘⏎ on a port row (#16): Open in browser (forwarding it first), Stop forwarding while this Mac
 * holds a forward of it (`port close`, run in Command mode: `port.forward` says it closed).
 */
const portMenu = (box: string, p: PortRow, base: MenuBase): Menu => {
  const f = p.forward;

  return {
    ...base,
    title: `${box} · #${p.card} :${String(p.port)}`,
    rows: [
      {
        id: 'open',
        text: 'Open in browser',
        dim: isOpen(p) ? `localhost:${String(p.forward.local)}` : 'forwards it first',
        key: '⏎',
        does: { kind: 'back' },
      },
      ...(f === undefined
        ? []
        : [
            {
              id: 'stop-forward',
              text: 'Stop forwarding',
              does: run(['port', 'close', f.box, f.card, String(f.port)]),
            },
          ]),
    ],
  };
};

const terminateRow = (row: BoxRow): MenuRow => ({
  id: 'terminate',
  text: 'Terminate…',
  key: 't',
  letter: 't',
  risky: true,
  does: {
    kind: 'back',
    confirm: {
      question: `Terminate ${row.name}?`,
      details: ['Its disk and every workspace on it are deleted; work not pushed is lost.'],
      yes: 'Terminate',
    },
  },
});

/**
 * ⌘⏎ on a workspace row (ADR 0022): Open workspace, Open story, Forward port…, Download locally,
 * Remove workspace… (red, asked: its container, clone and database go; the box stays).
 */
const workspaceMenu = (row: BoxRow, b: BoxData, base: MenuBase, story: MenuRow): Menu => {
  const awake = b.state === 'running' || b.state === 'pending';
  const asleep = awake ? undefined : asleepWhy(b);
  const card = row.workspace?.card ?? '';

  return {
    ...base,
    rows: [
      {
        id: 'workspace',
        text: 'Open workspace',
        ...(asleep === undefined ? { dim: WORKDIR } : { dim: 'wakes it' }),
        does: { kind: 'back' },
      },
      { ...story, dim: `#${card}` },
      { id: 'attach', text: 'Attach', key: '⏎', does: { kind: 'back' } },
      {
        id: 'forward',
        text: 'Forward port…',
        ...(asleep === undefined ? {} : { reason: asleep }),
        does: {
          kind: 'back',
          ask: [
            {
              name: 'port',
              kind: 'positional',
              type: 'number',
              required: true,
              repeats: false,
              summary: `abe port open ${row.name} ${card} <port>: localhost on this machine reaches it`,
              title: 'Port in the workspace',
            },
          ],
        },
      },
      {
        id: 'download',
        text: 'Download locally',
        ...(downloadSession(row) === undefined
          ? { reason: 'no session of it on this machine' }
          : {}),
        dim: 'recovery · go on on this machine',
        does: { kind: 'back' },
      },
      {
        id: 'remove-workspace',
        text: 'Remove workspace…',
        risky: true,
        ...(asleep === undefined ? {} : { reason: asleep }),
        does: {
          kind: 'back',
          confirm: {
            question: `Remove #${card}'s workspace on ${row.name}?`,
            details: [
              'Its container, clone and database go; the box stays. Refused while anything in it is unpushed or someone is in it.',
            ],
            yes: 'Remove',
          },
        },
      },
    ],
  };
};

/** ⌘⏎ on an old box (ADR 0022: never launched on): Download locally, Terminate…, the story. */
const oldBoxMenu = (row: BoxRow, b: BoxData, base: MenuBase, story: MenuRow): Menu => ({
  ...base,
  rows: [
    {
      id: 'download',
      text: 'Download locally',
      ...(b.session?.id === undefined ? { reason: 'no session of it on this machine' } : {}),
      dim: "its card's work to this machine",
      does: { kind: 'back' },
    },
    terminateRow(row),
    { ...story, ...(row.card === null ? {} : { dim: `#${row.card}` }) },
  ],
});

/** Resize…'s pick: the sizes up to the team's limit, the one it is now marked and grey. */
export const sizeMenu = (b: BoxData, max: string): Menu => ({
  kind: 'menu',
  id: `${SIZE_MENU}${b.name}`,
  title: `Resize ${b.name}${b.size === null ? '' : ` · now ${b.size}`}`,
  rows: sizesUpTo(max).map((size) => ({
    id: size,
    text: size,
    ...(size === b.size ? { reason: 'now' } : {}),
    does: { kind: 'back' },
  })),
});

const balloon = (text: string): Command => shell({ kind: 'balloon', tone: 'error', text });
const status = (text: string): Command => shell({ kind: 'status', text });

const none = (s: BoxesState): Out => ({ state: s, commands: [] });
const moved = (s: BoxesState): Out => none(settle(s));

const onKey = (s0: BoxesState, raw: string): Out => {
  // the moves and the `/` filter are the list's (`table-list.ts`), its order held from here
  const { state: s, key } = listKey(s0, raw, listOf(s0));
  const row = selectedRow(s);
  const login = loginOf(s);

  if (key === undefined) return none(s);
  // read again now (#217), as the 5-minute read does; sorted afresh
  if (key === 'r') return reading(settle(released(s)));
  if (key === '<CR>' && login !== undefined) return { state: s, commands: [loginCommand(login)] };
  if (row === undefined) return none(s);
  // a Queued row has no box to attach to yet
  if (key === '<CR>' && row.port !== undefined) return openPort(s, row.name, row.port);
  if (key === '<CR>') return { state: s, commands: attachOf(row) };
  if (key === '<D-CR>') return { state: s, commands: [boxMenu(row)] };

  return none(s);
};

/** A `port open` run's id: `boxes:port-open:<box> <card> <port>`; its answer opens the browser. */
const PORT_OPEN = 'boxes:port-open:';

/** `port list`'s run id, read beside `box list`. */
const PORTS_READ = 'boxes:ports';

const browse = (f: { local: number }): Command => shell({ kind: 'open-url', url: forwardUrl(f) });

/** ⏎ on a port row (#16): an open forward in the browser; else forwarded first (`port open`). */
const openPort = (s: BoxesState, box: string, p: PortRow): Out =>
  isOpen(p)
    ? { state: s, commands: [browse(p.forward)] }
    : {
        state: s,
        commands: [
          {
            kind: 'run',
            id: `${PORT_OPEN}${box} ${p.card} ${String(p.port)}`,
            argv: ['port', 'open', box, p.card, String(p.port)],
          },
        ],
      };

const onClick = (s: BoxesState, id: string): Out =>
  id.startsWith(BOX_ROW) || id === LOGIN_ROW ? none(listClick(s, id, listOf(s))) : none(s);

/** Stop now's run, `boxes:stop:<box>` (#316): a refusal asks, then stops with --yes. */
const STOP = 'boxes:stop:';

/** A `box resize` run's id: `boxes:resize:<box> <size>` (a refusal names neither). */
const RESIZE = 'boxes:resize:';

/** The repo's largest box size, read for Resize…. */
const MAX_SIZE = ['settings', 'get', 'limits.maxBoxSize'];

/** A row of the box's menu (or Resize…'s pick) handed back by Command mode. */
const onChoice = (s: BoxesState, input: Extract<Input, { kind: 'choice' }>): Out => {
  if (input.menu.startsWith(SIZE_MENU)) {
    const box = input.menu.slice(SIZE_MENU.length);

    return {
      state: s,
      commands: [
        {
          kind: 'run',
          id: `${RESIZE}${box} ${input.row}`,
          argv: ['box', 'resize', box, input.row],
        },
      ],
    };
  }
  const row = boxRows(s).find((r) => r.id === input.menu);

  if (row === undefined) return none(s);
  switch (input.row) {
    case 'attach':
      return { state: s, commands: attachOf(row) };
    // A workspace's (ADR 0022): its container, clone and database go, on its box; asked first.
    case 'remove-workspace':
      return row.workspace === undefined
        ? none(s)
        : {
            state: s,
            commands: [
              {
                kind: 'run',
                id: `${REMOVE_WS}${row.name} ${row.workspace.card}`,
                argv: ['--on', row.name, 'workspace', 'rm', row.workspace.card],
              },
            ],
          };
    case 'download': {
      const session = downloadSession(row);

      return session === undefined
        ? none(s)
        : {
            state: s,
            commands: [
              { kind: 'run', id: 'boxes:download', argv: ['session', 'download', session] },
            ],
          };
    }
    case 'open':
      return row.port === undefined ? none(s) : openPort(s, row.name, row.port);
    // a workspace's port (#16): forwarded by serve, then opened; the box's own in a terminal tab
    case 'forward': {
      const port = input.values?.[0];

      if (port === undefined || row.box === undefined) return none(s);
      if (row.workspace !== undefined)
        return openPort(s, row.name, {
          card: row.workspace.card,
          port: Number(port),
          fixed: false,
        });

      return {
        state: s,
        commands: [
          shell({
            kind: 'terminal-tab',
            argv: ['abe', 'box', 'forward', row.name, port],
            title: `forward ${port}`,
          }),
        ],
      };
    }
    case 'resize':
      return row.box === undefined
        ? none(s)
        : {
            state: { ...s, resizing: row.name },
            commands: [{ kind: 'run', id: 'boxes:max', argv: MAX_SIZE }],
          };
    case 'terminate':
      return {
        state: s,
        commands: [
          { kind: 'run', id: 'boxes:terminate', argv: ['box', 'terminate', row.name, '--yes'] },
        ],
      };
    // asked first when a session works there (#316): then with --yes
    case 'stop': {
      const works = row.box?.session?.state === 'working' || row.box?.session?.state === 'starting';

      return {
        state: s,
        commands: [
          {
            kind: 'run',
            id: `${STOP}${row.name}`,
            argv: ['box', 'stop', row.name, ...(works ? ['--yes'] : [])],
          },
        ],
      };
    }
    case 'story':
      return { state: s, commands: jumpCommands('story', storyOf(row)) };
    case 'workspace':
      return { state: s, commands: jumpCommands('workspace', storyOf(row)) };
    default:
      return none(s);
  }
};

/** `box list`, asked now (a first read, an event naming a box not known, the 5-minute read). */
const reading = (s: BoxesState): Out =>
  s.reading
    ? none(s)
    : {
        state: {
          ...s,
          reading: true,
          since: [],
          readAt: s.now === undefined ? undefined : Date.parse(s.now),
        },
        commands: [
          { kind: 'run', id: 'boxes', argv: ['box', 'list'] },
          { kind: 'run', id: PORTS_READ, argv: ['port', 'list'] },
        ],
      };

/**
 * The board's titles, followed (live's team list) once a box names a card without a title of its
 * own; each list handed adds its titles.
 */
const onCards = (s: BoxesState, f: Facts): Out => {
  if (f.team === undefined || f.team === s.team) return none(s);

  return moved({
    ...s,
    team: f.team,
    titles: { ...s.titles, ...Object.fromEntries(f.team.cards.map((c) => [c.id, c.title])) },
  });
};

/** The cards of old boxes with no `abe:title`, and of every box's workspaces, by id. */
const untitledCards = (boxes: readonly BoxData[]): number[] => [
  ...new Set(
    boxes.flatMap((b) => [
      ...(b.card !== null && (b.title ?? '') === '' ? [b.card] : []),
      ...(b.workspaces ?? []).flatMap((w) => {
        const card = Number(w.card);

        return Number.isInteger(card) && card > 0 ? [card] : [];
      }),
    ]),
  ),
];

/** What a box action's answer does: the menu's Resize…, Terminate… and an asked Stop now, run from here. */
const onActed = (s: BoxesState, input: Extract<Input, { kind: 'result' }>): Out => {
  const firstLine = input.text?.split('\n').find((l) => l.trim() !== '');

  if (!input.reply.ok) {
    const { code, message } = input.reply.error;

    // sessions run on the box: asked `y`, then resized anyway (the stop ends them)
    if (input.id.startsWith(RESIZE) && code === 'sessions-running') {
      const [box, size] = input.id.slice(RESIZE.length).split(' ');

      if (box !== undefined && size !== undefined)
        return {
          // its answer is Command mode's: the list is read again once it runs again (`box.state`)
          state: s,
          commands: [
            {
              kind: 'confirm',
              argv: ['box', 'resize', box, size, '--yes'],
              question: `Resize ${box} to ${size}?`,
              details: [message],
              yes: 'Resize',
              done: `Resized ${box} to ${size}`,
            },
          ],
        };
    }

    // a session began working there since the list was read (#316): asked, then with --yes
    if (input.id.startsWith(STOP) && code === 'confirm') {
      const box = input.id.slice(STOP.length);

      return {
        state: s,
        commands: [
          {
            kind: 'confirm',
            argv: ['box', 'stop', box, '--yes'],
            question: `Stop ${box}?`,
            details: [message],
            yes: 'Stop',
            done: `Stopped ${box}`,
          },
        ],
      };
    }

    return { state: { ...s, resizing: undefined }, commands: [balloon(message)] };
  }
  if (input.command === 'settings get') {
    const box = (s.boxes ?? []).find((b) => b.name === s.resizing);
    const max = input.reply.data.value;
    const next = { ...s, resizing: undefined };

    return box === undefined
      ? none(next)
      : { state: next, commands: [sizeMenu(box, typeof max === 'string' ? max : '')] };
  }
  if (input.command === 'box resize') {
    const d = input.reply.data;

    return {
      state: { ...s, boxes: s.boxes?.map((b) => (b.name === d.box ? { ...b, size: d.to } : b)) },
      commands: [status(firstLine ?? `${d.box}: ${d.to}`)],
    };
  }
  // Stop now, asked first (#316): its state comes as `box.state`, the answer on the status line
  if (input.command === 'box stop')
    return { state: s, commands: [status(firstLine ?? `${input.reply.data.name} stopped`)] };
  if (input.command === 'box terminate') {
    const gone = input.reply.data.name;

    const out = moved({ ...s, boxes: s.boxes?.filter((b) => b.name !== gone) });

    return { ...out, commands: [status(firstLine ?? `${gone} terminated`)] };
  }
  // a workspace removed (ADR 0022): gone from its box's row at once, said on the status line
  if (input.id.startsWith(REMOVE_WS)) {
    const [box, card] = input.id.slice(REMOVE_WS.length).split(' ');
    const boxes = s.boxes?.map((b) =>
      b.name === box ? { ...b, workspaces: b.workspaces?.filter((w) => w.card !== card) } : b,
    );

    return {
      ...moved({ ...s, boxes }),
      commands: [status(firstLine ?? `#${card ?? ''}'s workspace on ${box ?? ''} removed`)],
    };
  }
  if (input.id === 'boxes:download')
    return { state: s, commands: [status(firstLine ?? 'Downloaded')] };
  // forwarded (#16): opened in the browser, a failure said as a refusal is
  if (input.command === 'port open') {
    const f = input.reply.data;
    const out = forwardMoved(s, f);

    return f.state === 'failed'
      ? { state: out.state, commands: [balloon(portForwardText(f).trimEnd())] }
      : { state: out.state, commands: [...out.commands, browse(f)] };
  }

  return none(s);
};

const onResult = (s: BoxesState, input: Extract<Input, { kind: 'result' }>): Out => {
  // an older serve, or local mode, has none to say: no port rows
  if (input.id === PORTS_READ)
    return input.reply.ok && input.command === 'port list'
      ? moved({
          ...s,
          ports: { forwards: input.reply.data.forwards, offered: input.reply.data.offered },
        })
      : none(s);
  if (input.id.startsWith('boxes:')) return onActed(s, input);
  if (input.id !== 'boxes') return none(s);
  const done = { ...s, reading: false };

  if (!input.reply.ok) return moved({ ...done, failed: input.reply.error });
  if (input.command !== 'box list') return none(done);
  const next: BoxesState = {
    ...done,
    ...(s.now === undefined ? {} : { readDone: s.now }),
    // the moves said while the read was out are newer than it
    boxes: replayMoves(input.reply.data.boxes, s.since ?? []),
    queued: input.reply.data.queued,
    here: input.reply.data.here,
  };

  delete next.failed;
  delete next.since;
  delete next.again;
  // a box's serve answered after this read was asked: what its status says is read again
  if (s.again === true) return reading(settle(next));
  const untitled = untitledCards(next.boxes ?? []);
  const asked = new Set(s.titlesFor ?? []);

  if (!untitled.some((c) => s.titles?.[c] === undefined && !asked.has(c))) return moved(next);
  const titled = moved({ ...next, titlesFor: untitled });

  // followed from now on, so live reads the board's cards; followed already: read again
  return (s.titlesFor ?? []).length === 0
    ? titled
    : { ...titled, commands: [...titled.commands, { kind: 'live', reads: ['cards:team'] }] };
};

const portsOfState = (s: BoxesState): BoxPorts => s.ports ?? { forwards: [], offered: [] };

const samePort =
  (k: { box: string; card: string; port: number }) =>
  (x: { box: string; card: string; port: number }): boolean =>
    forwardKey(x) === forwardKey(k);

/**
 * A forward moved (#16: `port open`'s answer, `port.forward`): its row in place, offered no more;
 * a local port not the box's said on the status line once, as it opens.
 */
const forwardMoved = (s: BoxesState, f: PortForward): Out => {
  const p = portsOfState(s);
  const was = p.forwards.find(samePort(f));
  const next = moved({
    ...s,
    ports: {
      forwards: [...p.forwards.filter((x) => !samePort(f)(x)), f],
      offered: p.offered.filter((x) => !samePort(f)(x)),
    },
  });
  const opened = f.state === 'open' && was?.state !== 'open' && f.note !== undefined;

  return opened ? { ...next, commands: [status(portForwardText(f).trimEnd())] } : next;
};

/** A forward let go of: its port offered again (`workspace.ports` says when it stops listening). */
const forwardClosed = (s: BoxesState, f: PortForward): BoxesState => {
  const p = portsOfState(s);

  return {
    ...s,
    ports: {
      forwards: p.forwards.filter((x) => !samePort(f)(x)),
      offered: [
        ...p.offered.filter((x) => !samePort(f)(x)),
        { box: f.box, card: f.card, port: f.port, fixed: f.fixed },
      ],
    },
  };
};

/** What listens in a workspace now (`workspace.ports`): its offered ports, the forwards kept. */
const portsListening = (
  s: BoxesState,
  box: string,
  w: { card: string; ports: number[]; fixed: number[] },
): BoxesState => {
  const p = portsOfState(s);
  const held = new Set(
    p.forwards.filter((f) => f.box === box && f.card === w.card).map((f) => f.port),
  );

  return {
    ...s,
    ports: {
      forwards: p.forwards,
      offered: [
        ...p.offered.filter((o) => o.box !== box || o.card !== w.card),
        ...w.ports
          .filter((port) => !held.has(port))
          .map((port) => ({ box, card: w.card, port, fixed: w.fixed.includes(port) })),
      ],
    },
  };
};

const onEvent = (s: BoxesState, event: Event): Out => {
  switch (event.type) {
    case 'serve.started':
    case 'watch.gap':
      return s.opened ? reading(s) : none(s);
    case 'box.state': {
      const at = Date.parse(event.at);
      const running = event.data.state === 'running';
      // said while the list is read: put back on its answer; its serve answering (#217): that
      // answer, asked before, says no idle stop or abe yet, so the list is read once more after it
      const kept: BoxesState = s.reading
        ? {
            ...s,
            since: [...(s.since ?? []), { ...event.data, at }],
            ...(running ? { again: true } : {}),
          }
        : s;

      if (kept.boxes === undefined) return none(kept);
      // a box not known (made, or Queued) or a move that says too little: the list again
      const boxes = boxesMoved(kept.boxes, event.data, at);

      if (boxes === 'read') return reading(kept);
      const next = settle({ ...kept, boxes });

      // its serve answers (#217): read again for what only its status says (the idle stop, its
      // abe; a box resized in Command mode its new size)
      return running && !next.reading ? reading(next) : none(next);
    }
    case 'box.step': {
      if (event.data.step !== 'booting') return none(s);
      // said while the list is read: that answer, asked before, is read again
      const kept: BoxesState = s.reading ? { ...s, again: true } : s;
      const boxes = boxesBooting(kept.boxes ?? [], event.data.box, Date.parse(event.at));

      return boxes === undefined ? none(kept) : moved({ ...kept, boxes });
    }
    case 'box.idle': {
      const boxes = boxesIdled(s.boxes ?? [], event.data);

      return boxes === undefined ? none(s) : moved({ ...s, boxes });
    }
    case 'boxes.unread':
      return moved({ ...s, failed: event.data });
    case 'port.forward': {
      const { closed, ...f } = event.data;

      return closed === true ? moved(forwardClosed(s, f)) : forwardMoved(s, f);
    }
    case 'workspace.ports':
      return event.box === undefined ? none(s) : moved(portsListening(s, event.box, event.data));
    default:
      return none(s);
  }
};

const onOpen = (s: BoxesState, input: Extract<Input, { kind: 'open' }>): Out => {
  const box = input.params.box;
  const card = input.params.card;
  const opened: BoxesState = { ...s, opened: true, size: input.size };
  // Linked's Box row: the card's workspace row on its box (ADR 0022), else the box's
  const row =
    box === undefined
      ? undefined
      : `${BOX_ROW}${box}${card === undefined ? '' : `${WS_ROW}${card}`}`;
  const next: BoxesState = row === undefined ? opened : { ...selectOn(opened, row), want: row };

  // opened again (the tab picked anew, Linked's box row): what it holds stays, events keep it
  return s.opened ? moved(next) : reading(next);
};

const stepBoxes = (s: BoxesState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return onOpen(s, input);
    case 'resize':
      return moved({ ...s, size: input.size });
    case 'tick': {
      const t = Date.parse(input.at);
      // the first read's time is the first tick's when it went before the clock
      const next = { ...s, now: input.at, readAt: s.readAt ?? (s.opened ? t : undefined) };
      const due = next.readAt !== undefined && t - next.readAt >= REREAD_MS;

      return due ? reading(next) : moved(next);
    }
    case 'live':
      return onCards(s, input.facts);
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return onClick(s, input.id);
    // the wheel over the Table moves its rows, not the selection (#323)
    case 'scroll':
      return none(input.id === 'boxes-table' ? listScroll(s, input.y, listOf(s)) : s);
    case 'text':
      return none(listText(s, input.text, listOf(s)) ?? s);
    // the list lost the keyboard: its rows sorted afresh; not to a layer opened over it (#264)
    case 'focus':
      return input.focused || input.layer === true ? none(s) : moved(released(s));
    case 'choice':
      return onChoice(s, input);
    case 'result':
      return onResult(s, input);
    case 'event':
      return onEvent(s, input.event);
    default:
      return none(s);
  }
};

const DASH: TableCell = { text: '—', hue: 'dim' };

/** DS AgentStatus' hues: running warn, its moves (starting, stopping) and asleep dim. */
const STATE_CELL: Readonly<Record<Exclude<Look, 'problem'>, TableCell>> = {
  running: { mark: '●', text: 'running', hue: 'warn' },
  starting: { mark: '●', text: 'starting', hue: 'dim' },
  stopping: { mark: '●', text: 'stopping', hue: 'dim' },
  asleep: { mark: '○', text: 'asleep', hue: 'dim' },
  queued: { text: 'Queued', hue: 'dim' },
};

/** What keeps a box up, as the Until column says it after `kept up · `. */
const KEPT: Readonly<Record<Exclude<IdleKeep, 'awake'>, string>> = {
  attached: 'attached',
  working: 'session working',
  pr: 'pull request',
};

const COST_TIP = 'today since 00:00 · on-demand estimate';

const untilCell = (b: BoxData, now?: number): TableCell => {
  const idle = b.idle;

  if (b.state !== 'running' || idle === undefined) return DASH;
  if (idle.keptBy.includes('awake')) return { text: 'kept awake' };
  const other = idle.keptBy.find((k): k is Exclude<IdleKeep, 'awake'> => k !== 'awake');

  if (other !== undefined) {
    const text = `kept up · ${KEPT[other]}`;

    return { text, hue: 'dim', tooltip: text };
  }

  return idle.stopsAt === null
    ? DASH
    : { text: `stops at ${clock(idle.stopsAt, now)}`, hue: 'dim' };
};

/** Its launch template version and, while it runs, its abe: in warn when not this Mac's (#188). */
const releaseCell = (b: BoxData): TableCell => {
  const v = b.release === null ? undefined : `v${b.release}`;

  if (b.skew !== undefined && b.abe !== undefined)
    return {
      text: v === undefined ? `abe ${b.abe}` : `${v} · abe ${b.abe}`,
      hue: 'warn',
      tooltip: b.skew,
    };
  if (v === undefined) return DASH;

  return b.abe === undefined
    ? { text: v, hue: 'dim' }
    : { text: v, hue: 'dim', tooltip: `abe ${b.abe}` };
};

/** `31 / 60 GB`: a box's root disk used of its size, as its last load said. */
const diskCell = (b: BoxData): TableCell => {
  const disk = b.load?.disk;

  if (disk === undefined) return DASH;
  const used = Math.round(disk.totalGb - disk.freeGb);

  return {
    text: `${used} / ${Math.round(disk.totalGb)} GB`,
    hue: 'dim',
    tooltip: `${disk.freeGb} GB free · grows by itself under 20 % free`,
  };
};

/** A workspace's rough share of its box's cost today, split by busy minutes (ADR 0022). */
const shareCell = (r: BoxRow, card: string, now: number): TableCell => {
  const b = r.box;
  const usd =
    b === undefined ? undefined : workspaceShares(costAt(b, now), b.busyToday ?? []).get(card);

  return usd === undefined || usd <= 0
    ? DASH
    : { text: shareText(usd), hue: 'dim', tooltip: `${COST_TIP} · its share by busy minutes` };
};

/** A workspace row: its story, its container's state, its clone's disk, its cost share; the box's own columns blank. */
const workspaceCells = (
  r: BoxRow,
  w: NonNullable<BoxRow['workspace']>,
  now: number,
): TableCell[] => [
  { text: '' },
  r.card === null ? { accent: `#${w.card}` } : storyCell(r, r.card),
  w.state === 'running'
    ? { mark: '●', text: 'workspace up', hue: 'dim' }
    : { mark: '○', text: `workspace ${w.state}`, hue: 'dim' },
  DASH,
  w.diskGb === undefined ? DASH : { text: `${w.diskGb} GB`, hue: 'dim' },
  DASH,
  DASH,
  shareCell(r, w.card, now),
  DASH,
];

/** A repo's box with no card: the number of workspaces on it (another repo's, its name too). */
const repoBoxCell = (r: BoxRow): TableCell => {
  const n = r.box?.workspaces?.length;

  if (n === undefined || n === 0) return elsewhereCell(r);
  const held = `${n} workspace${n === 1 ? '' : 's'}`;

  return r.elsewhere === undefined
    ? { text: held, hue: 'dim' }
    : {
        text: `${repoName(r.elsewhere)} · ${held}`,
        hue: 'dim',
        tooltip: `${r.elsewhere} · another repo`,
      };
};

/** A fixed port's words on hover: the repo's auth callback names it. */
const fixedTip = (port: number): string =>
  `fixed: the repo's auth callback names it, only localhost:${String(port)} will do`;

/** A forward's state (#16): open in good, its moves and a sleeping box dim, failed bad. */
const FORWARD_CELL: Readonly<Record<PortForward['state'], TableCell>> = {
  open: { mark: '●', text: 'open', hue: 'good' },
  opening: { mark: '●', text: 'opening', hue: 'dim' },
  asleep: { mark: '○', text: 'box asleep', hue: 'dim', tooltip: 'box asleep: back when it wakes' },
  failed: { text: 'failed', hue: 'bad' },
};

/** A port row (#16): `:3000 → localhost:3000 · ● open`, or `:3000 listening` dim. */
const portCells = (p: PortRow): TableCell[] => {
  const f = p.forward;
  const tip = [
    ...(f?.note === undefined || f.state === 'failed' ? [] : [f.note]),
    ...(p.fixed ? [fixedTip(p.port)] : []),
  ].join(' · ');
  const hover = tip === '' ? {} : { tooltip: tip };
  const port: TableCell =
    f === undefined
      ? { text: `:${String(p.port)}`, hue: 'dim', ...hover }
      : { text: `:${String(p.port)} → localhost:${String(f.local)}`, ...hover };
  const state: TableCell =
    f === undefined
      ? { text: 'listening', hue: 'dim' }
      : {
          ...FORWARD_CELL[f.state],
          ...(f.state === 'failed' && f.note !== undefined ? { tooltip: f.note } : {}),
        };

  return [{ text: '' }, port, state, DASH, DASH, DASH, DASH, DASH, DASH];
};

const cellsOf = (r: BoxRow, now: number): TableCell[] => {
  if (r.port !== undefined) return portCells(r.port);
  if (r.workspace !== undefined) return workspaceCells(r, r.workspace, now);
  const story: TableCell = r.card === null ? repoBoxCell(r) : storyCell(r, r.card);
  const b = r.box;

  if (b === undefined)
    return [
      { text: r.name, hue: 'dim' },
      story,
      STATE_CELL.queued,
      DASH,
      DASH,
      DASH,
      DASH,
      DASH,
      DASH,
    ];
  const plain: TableCell =
    r.problem === undefined
      ? {
          ...STATE_CELL[r.look === 'problem' ? 'running' : r.look],
          ...(r.booting === true ? { text: BOX_BOOTING_WORD } : {}),
          ...(r.why === undefined ? {} : { tooltip: r.why }),
        }
      : { mark: '●', text: r.problem, hue: 'bad', tooltip: r.why ?? `${r.name} ${r.problem}` };
  // ADR 0022: an old box says so first; a launch never uses it.
  const state: TableCell =
    r.old === true
      ? {
          mark: '⚠',
          text: `old box · ${plain.text ?? ''}`,
          hue: 'dim',
          tooltip: 'a 2.2 box made for one card: never launched on · Download locally or Terminate',
        }
      : plain;
  const minutes = boxUpMinutes(b, now);
  const usd = costAt(b, now);

  return [
    { text: r.name },
    story,
    state,
    b.size === null ? DASH : { text: b.size, hue: 'dim' },
    diskCell(b),
    releaseCell(b),
    // the Up and Cost columns in the CLI's words (core's `box-text`)
    minutes === null ? DASH : { text: boxUpText(minutes) },
    usd === null ? DASH : { text: boxCostText(usd), tooltip: COST_TIP },
    untilCell(b, now),
  ];
};

/** `qa2-e-85a7`: a repo's name without its owner, as a row names it (#262). */
const repoName = (repo: string): string => repo.slice(repo.indexOf('/') + 1);

/**
 * The Story cell: `#101 box check`; another repo's `qa2-e-85a7#101 box check`, its tooltip the
 * whole repo (#262: never read as this project's).
 */
const storyCell = (r: BoxRow, card: number): TableCell => {
  const tip = [
    ...(r.elsewhere === undefined ? [] : [`${r.elsewhere} · another repo`]),
    ...(r.title === null ? [] : [r.title]),
  ].join(' · ');

  return {
    accent: `${r.elsewhere === undefined ? '' : repoName(r.elsewhere)}#${card}`,
    ...(r.title === null ? {} : { text: shortTitle(r.title), hue: 'dim' }),
    ...(tip === '' ? {} : { tooltip: tip }),
  };
};

/** No card: a dash, or another repo's name (#262). */
const elsewhereCell = (r: BoxRow): TableCell =>
  r.elsewhere === undefined
    ? DASH
    : { text: repoName(r.elsewhere), hue: 'dim', tooltip: `${r.elsewhere} · another repo` };

const emptyOf = (s: BoxesState): { title: string; line: string } => {
  // only an unreachable serve is that; any other refusal says why the boxes were not read
  if (s.boxes === undefined && s.failed?.code === BOXES_OFF.code)
    return { title: BOXES_OFF.title, line: BOXES_OFF.line };
  if (s.boxes === undefined && s.failed !== undefined)
    return s.failed.code === 'serve-unreachable'
      ? { title: 'abe serve not answering', line: s.failed.message }
      : { title: 'Boxes not read', line: s.failed.message };
  if (s.boxes === undefined) return { title: 'Asking abe serve', line: 'Your boxes, a moment' };
  if (filterText(s) !== '')
    return { title: `No boxes match “${filterText(s)}”`, line: 'Esc clears the filter' };

  return { title: 'No boxes', line: 'a story launched on a box makes one' };
};

const noteOf = (s: BoxesState): string | undefined => {
  const filter = filterNote(s, listOf(s));

  if (filter !== undefined) return filter;
  if (s.boxes === undefined || loginOf(s) !== undefined) return undefined;
  // `r` and the quiet read say they read, then when the rows were read (#287)
  if (s.reading) return 'Reading box list…';
  if (s.failed !== undefined) return `Boxes not read · ${s.failed.message}`;

  return s.readDone === undefined ? undefined : `Read ${clock(s.readDone)}`;
};

const FOOT = [
  { keys: '⏎', label: 'box shell' },
  { keys: '⌘⏎', label: 'actions' },
  { keys: 'r', label: 'read again' },
];

/**
 * The key line: ⏎ on a box row is the box's shell, on a workspace row its workspace's; on a port
 * row it opens it in the browser (#16); the login row's, logging in.
 */
const footOf = (login: boolean, row: BoxRow | undefined) => {
  if (login) return [{ keys: '⏎', label: 'log in to AWS' }];
  if (row?.port !== undefined) return [{ keys: '⏎', label: 'open in browser' }, ...FOOT.slice(1)];
  if (row?.workspace !== undefined)
    return [{ keys: '⏎', label: 'workspace shell' }, ...FOOT.slice(1)];

  return FOOT;
};

/** The screen's Table: the rows that fit, from `top`; the login row while AWS wants a login. */
export const boxesTable = (s: BoxesState): Table => {
  const login = loginOf(s);
  const { rows, selected } = windowed(s, listOf(s));
  const note = noteOf(s);
  const now = nowOf(s);
  const hue: Hue = 'bad';
  const drawn =
    login === undefined
      ? rows.map((r) => ({
          id: r.id,
          cells: cellsOf(r, now),
          ...(r.look === 'problem' ? { hue } : {}),
        }))
      : [
          {
            id: LOGIN_ROW,
            cells: [
              {
                mark: '●',
                text: `AWS login expired · ${loginArgv(login).join(' ')}`,
                hue,
              },
            ],
          },
        ];

  const chosen = login === undefined ? selected?.id : LOGIN_ROW;

  return {
    kind: 'Table',
    id: 'boxes-table',
    props: {
      columns: COLUMNS,
      rows: drawn,
      ...(chosen === undefined ? {} : { selected: chosen }),
      ...(note === undefined ? {} : { note }),
      // Esc clears it before it gives the keys back (#263)
      ...(s.filter === undefined ? {} : { filter: s.filter.text }),
      ...(drawn.length === 0 ? { empty: emptyOf(s) } : {}),
      foot: footOf(login !== undefined, selected),
    },
  };
};

/** `:boxes`: the bottom pane on Boxes with the keyboard (never hides it). */
const WORDS: readonly Word[] = [
  {
    word: 'boxes',
    summary: 'the bottom pane on Boxes: your boxes, what they cost today and when they stop',
    commands: [shell({ kind: 'show', place: 'boxes' })],
  },
];

/**
 * Another tab took the pane (#156): opened again it draws the boxes it last read at once, and reads
 * them anew (`opened` false), the selection, scroll and card titles kept. The clock is not kept:
 * the next read's time is the first tick's, so the quiet 5-minute read counts from it.
 */
const keepBoxes = (s: BoxesState): BoxesState => {
  const kept: BoxesState = { ...reopened(s), opened: false, reading: false };

  delete kept.now;
  delete kept.readAt;
  delete kept.since;
  delete kept.again;
  delete kept.failed;
  delete kept.want;
  delete kept.resizing;

  return kept;
};

/** Where the Boxes list's keys are (#346): the selected box as the Subject, its ⌘⏎ rows. */
const boxesHere = (s: BoxesState): Here => {
  const row = selectedRow(s);

  if (row === undefined) return { keys: 'boxes' };
  // a workspace's card, an old box's, else the box's only workspace's
  const card = storyOf(row);
  const title = row.title ?? (card === undefined ? null : (s.titles?.[card] ?? null));

  return {
    keys: 'boxes',
    subject: {
      caption:
        card === undefined
          ? `box ${row.name}`
          : `box ${row.name} · #${card} ${title ?? ''}`.trimEnd(),
      label: `box ${row.name}`,
      ask: card === undefined ? [] : ['--card', String(card)],
      menu: boxMenu(row),
    },
  };
};

/** The watch's events it takes: the boxes and their workspaces' ports; any other never re-views it. */
const BOXES_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'box.state',
  'box.step',
  'box.idle',
  'workspace.ports',
  'port.forward',
  'boxes.unread',
]);

export const boxesScreen: Screen<BoxesState> = {
  events: BOXES_EVENTS,
  name: 'boxes',
  here: boxesHere,
  init: INIT,
  step: stepBoxes,
  keep: keepBoxes,
  view: (s): Node => island([boxesTable(s)], 'boxes'),
  words: WORDS,
  linked: (s) => {
    const row = selectedRow(s);

    return row === undefined ? undefined : storyOf(row);
  },
  typing: (s) => s.filter?.typing === true,
  // the board's cards once a box names one with no title of its own
  follows: (s) => ((s.titlesFor ?? []).length > 0 ? ['cards:team'] : []),
};
