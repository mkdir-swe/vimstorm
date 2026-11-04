/**
 * The Board on the shared driver. A sprint of cards with their runs and sessions, and
 * `boardReplies` answering the Board's reads as serve would. A test lays its own replies over
 * these with `more`.
 */
import type { BoxData, CardData, FactoryRunData, LocalModeView, SessionData } from '@abe/core';
import { factoryScreen, type Node, pinnedScreen, sessionsScreen } from '@abe/ui';
import { localStatusAnswer } from './local-trees';
import {
  type Drive,
  type DriveOptions,
  driveScreen,
  type Replies,
  repliesBy,
} from './screen-driver';
import {
  boxesAnswer,
  cardsAnswer,
  factoryRun,
  listCard,
  minutes,
  runsAnswer,
  session,
  sessionsAnswer,
  settingAnswer,
} from './ui';

export const BOARD_SIZE = { width: 1440, height: 846 };

export const BOARD_MINE: CardData[] = [
  listCard(4, 'Cart total includes shipping', 'Active', 'Alex Example', {
    tags: ['cart'],
    points: 3,
  }),
  listCard(5, 'Saved carts survive sign-out', 'New'),
  listCard(6, 'Greeted by time of day', 'New', 'Alex Example', { type: 'Bug' }),
  listCard(7, 'Friendly greeting with no name', 'Resolved'),
];

export const BOARD_TEAM: CardData[] = [
  ...BOARD_MINE,
  listCard(9, 'Coupon field accepts spaces', 'New', 'Sam Sample'),
];

export const BOARD_RUNS: FactoryRunData[] = [
  factoryRun(4, 'Cart total includes shipping', 'build', 'running', { since: minutes(2) }),
  factoryRun(5, 'Saved carts survive sign-out', 'verify', 'needs-you', { since: minutes(1) }),
];

export const BOARD_SESSIONS: SessionData[] = [
  { ...session('s4', 'working', 4), box: 'alex-1', factory: true },
  { ...session('s5', 'waiting', 5), factory: true },
];

/** What serve holds for the Board's reads. Left out: the samples above. */
export type BoardWorld = {
  mine?: CardData[];
  team?: CardData[];
  sprint?: string | null;
  /** The board's organization (`this machine`: a board on this machine); default Azure's. */
  organization?: string;
  runs?: FactoryRunData[];
  sessions?: SessionData[];
  boxes?: BoxData[];
  /** `settings get <key>` by key. A key left out stays asked, as a setting not read yet. */
  settings?: Readonly<Record<string, string | string[] | boolean>>;
  /** `local status`. Left out, it stays asked. */
  local?: LocalModeView;
  /** Tried first, for the reads a test answers itself. */
  more?: Replies;
};

/**
 * The Board's reads answered from `w`: both card lists, the runs (one card's when the read names
 * it), the sessions, the boxes, the settings `w` names and local mode. Any other read stays asked.
 */
export const boardReplies = (w: BoardWorld = {}): Replies => {
  const runs = w.runs ?? BOARD_RUNS;
  const sprint = w.sprint === undefined ? undefined : w.sprint;
  const base = repliesBy({
    'card list --mine': cardsAnswer(w.mine ?? BOARD_MINE, true, sprint, w.organization),
    'card list --closed': cardsAnswer(w.team ?? BOARD_TEAM, false, sprint, w.organization),
    'factory status': ({ argv }) => {
      const card = argv[2] === undefined ? undefined : Number(argv[2]);

      return runsAnswer(card === undefined ? runs : runs.filter((r) => r.card === card));
    },
    'session list': sessionsAnswer(w.sessions ?? BOARD_SESSIONS),
    'box list': boxesAnswer(w.boxes ?? []),
    'settings get': ({ argv }) => {
      const key = argv[2] ?? '';
      const value = w.settings?.[key];

      return value === undefined ? undefined : settingAnswer(key, key, value);
    },
    ...(w.local === undefined ? {} : { 'local status': localStatusAnswer(w.local) }),
  });

  return (asked) => w.more?.(asked) ?? base(asked);
};

/** The Board opened, focused, at `BOARD_SIZE`, its reads answered from `o.world`. */
export const driveBoard = (o: DriveOptions & { world?: BoardWorld } = {}): Drive<Node> => {
  const { world, ...rest } = o;

  return driveScreen(factoryScreen, {
    size: BOARD_SIZE,
    focused: true,
    replies: boardReplies(world),
    ...rest,
  }).answer();
};

/**
 * Chat and the Sessions tab on the shared driver: the screens above the Board that embed its card
 * actions, for a Board's test that presses the same card there.
 */
export const driveChat = (o: DriveOptions = {}): Drive<Node> => driveScreen(pinnedScreen, o);
export const driveSessions = (o: DriveOptions = {}): Drive<Node> => driveScreen(sessionsScreen, o);
