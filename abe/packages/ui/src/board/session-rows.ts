/**
 * A session's row as the Sessions tab and the Board's Sessions tab draw it: your sessions on the
 * sprint's stories in their order, each one's state, word and clock as the Board's card and Chat's
 * header say them, its cells in the columns' order, and the rows that need you.
 */
import type { CardData, FactoryRunData, RepoHere, SessionData } from '@abe/core';
import { queuedForText } from '@abe/core/box-text';
import { isHere } from '@abe/core/here';
import { BOX_MARK_WORDS, type BoxMoves, CLOUD_OF } from '../live';
import type { ColumnWidth, Hue, TableCell } from '../runtime/runtime';
import { sleptWhileWaiting } from './card-actions';
import {
  boxMarkOf,
  clockSince,
  type Counted,
  launchClock,
  lookOf,
  type Look,
  minutesIn,
  onNoStage,
  railSegments,
  railWord,
  sessionLook,
  standing,
  subagentsWorking,
} from './flow';
import { type LaunchTone } from './launch';

/**
 * Where the Abe chat runs: unjailed on this machine. Said beside a card's `Local sandbox` (the same
 * machine, its session jailed), so it names the place the same way.
 */
export const HUB_WHERE = 'Local · no sandbox';

const bare = (path: string) => path.replace(/\/+$/, '');

/** The columns, as F-Sessions draws them: Story takes what the others leave. */
export const SESSION_COLUMNS: { label: string; width: ColumnWidth }[] = [
  { label: 'Story', width: { flex: 1 } },
  { label: 'Stage', width: { fixed: 230 } },
  { label: 'State', width: { fixed: 160 } },
  { label: 'Where', width: { fixed: 90 } },
  { label: 'Time', width: { fixed: 100 } },
  { label: 'Subagents', width: { fixed: 100 } },
];

/** A row's place in the order: needs you, failed, starting / running, idle, done. */
const GROUP = {
  'needs-you': 0,
  failed: 1,
  starting: 2,
  running: 2,
  ready: 2,
  idle: 3,
  'on-test': 4,
  merged: 4,
  ended: 4,
} as const;

/** A state's glyph and hue in the State column. */
const MARKS: Readonly<Record<keyof typeof GROUP, { mark: string; hue: Hue }>> = {
  'needs-you': { mark: '◆', hue: 'needs-you' },
  failed: { mark: '✗', hue: 'bad' },
  starting: { mark: '●', hue: 'dim' },
  running: { mark: '●', hue: 'warn' },
  ready: { mark: '●', hue: 'good' },
  idle: { mark: '○', hue: 'dim' },
  'on-test': { mark: '✓', hue: 'good' },
  merged: { mark: '✓', hue: 'good' },
  ended: { mark: '✓', hue: 'dim' },
};

/** How long a session whose box slept while it waited on you stays on the tab. */
const SLEPT_SHOWN_MS = 24 * 60 * 60_000;

/** One session's row, worked out. */
export type SessionRow = {
  session: SessionData;
  run?: FactoryRunData | undefined;
  card: number;
  title: string;
  state: keyof typeof GROUP;
  word: string;
  /** What the toolbar pill and the status bar count it as: `Look.counted`. */
  counted: Counted;
  /** Its clock starts here (`clockSince`, the Board's and Chat's too). */
  since: string;
  /** Its place within its group: the longest in its state first. */
  waited: string;
  /** A starting launch's hue past its budget: amber slow, red near the give-up. */
  hue?: Hue;
  /** Its run ended without shipping (`Look.givenUp`): dim `○` in the State column, never ✓. */
  givenUp?: true;
  /**
   * A chat of no card's run: the Abe chat (`Abe · <repo>`) or a prototype session (`card` its
   * card's, else 0); ⏎ is Chat on it, ⌘⏎ Open Chat and Stop… (its story's rows only with a card).
   */
  chat?: true;
};

/** A chat's row: its own look; it counts as nothing in the pill (no run waits on it). */
const chatRowOf = (session: SessionData, now: string | undefined): SessionRow => {
  const l = sessionLook(session, now);

  return {
    session,
    card: session.prototype?.card ?? session.card ?? 0,
    // an Abe chat's conversation by its name: `Abe · demo-shop · why the cart rounds`
    title:
      session.abe?.name === undefined ? session.title : `${session.title} · ${session.abe.name}`,
    state: l.state,
    word: l.word,
    counted: 'none',
    since: session.since,
    waited: session.since,
    chat: true,
  };
};

/** Whether a row's card is a story's (a chat's may be of none). */
export const hasCard = (row: SessionRow): boolean => row.card > 0;

/** A launch's tone as its row's hue; it stays in the starting group. */
const TONE_HUE: Readonly<Record<LaunchTone, { hue?: Hue }>> = {
  'on-time': {},
  slow: { hue: 'warn' },
  stuck: { hue: 'bad' },
};
const toneHue = (l: Look): { hue?: Hue } => (l.tone === undefined ? {} : TONE_HUE[l.tone]);

const rowOf = (
  session: SessionData,
  run: FactoryRunData | undefined,
  card: CardData | undefined,
  now: string | undefined,
): SessionRow | undefined => {
  if (session.card === null) return undefined;
  const base = {
    session,
    run,
    card: session.card,
    title: card?.title ?? run?.title ?? session.title,
  };

  // its question is still yours to answer: on top, ⏎ (Resume) starts it again on its box
  if (run === undefined && sleptWhileWaiting(session))
    return {
      ...base,
      state: 'needs-you',
      word: 'Box slept',
      counted: 'needs-you',
      since: session.since,
      waited: session.since,
    };
  if (run === undefined) {
    // its own look, as the Board's card and Chat's header say it: a cloud launch's
    // step, Stopped once you stopped it
    const l = sessionLook(session, now);

    return {
      ...base,
      state: l.state,
      word: l.word,
      counted: l.counted,
      ...toneHue(l),
      since: session.since,
      waited: session.since,
    };
  }
  const look = lookOf(run, session, now);
  const since = clockSince(run, session);

  return {
    ...base,
    state: look.state,
    word: look.word,
    counted: look.counted,
    ...(look.givenUp === true ? { givenUp: true as const } : {}),
    since,
    waited: since,
    ...toneHue(look),
  };
};

/**
 * Your sessions on the sprint's stories (the shown repo's), in order (the live Abe chat
 * first, the main checkout's, then by state): live ones and ended
 * ones whose run is not cleared (an ended session with no run is gone, but a plain one you
 * stopped while it stands for its card, `standing`); a card's session only (no retro
 * or prototype chat). Unread cards: every card's session shows.
 */
export const sessionRows = (s: {
  sessions?: SessionData[] | undefined;
  runs?: FactoryRunData[] | undefined;
  here?: RepoHere | undefined;
  cards?: CardData[] | undefined;
  now?: string | undefined;
}): SessionRow[] => {
  const runs = new Map((s.runs ?? []).map((r) => [r.session, r]));
  const sprint = s.cards === undefined ? undefined : new Map(s.cards.map((c) => [c.id, c]));

  const all = s.sessions ?? [];
  const now = s.now === undefined ? undefined : Date.parse(s.now);
  /** A slept one stays a day, or until a newer session on its card (its Resume) takes its place. */
  const superseded = (x: SessionData) =>
    (now !== undefined && now - Date.parse(x.since) > SLEPT_SHOWN_MS) ||
    all.some(
      (y) => y.id !== x.id && y.card === x.card && y.repo === x.repo && y.startedAt > x.startedAt,
    );
  const stands = standing(
    (s.runs ?? []).filter((r) => isHere(s.here, r.repo)),
    all.filter((x) => isHere(s.here, x.repo)),
  );

  // the live chats here (the Abe chat, prototype sessions), beside the cards' sessions
  const chats = all
    .filter((x) => x.kind !== 'card' && x.state !== 'ended' && isHere(s.here, x.repo))
    .map((x) => chatRowOf(x, s.now));

  return all
    .filter((x) => x.kind === 'card' && x.card !== null && isHere(s.here, x.repo))
    .filter((x) => sprint === undefined || (x.card !== null && sprint.has(x.card)))
    .filter(
      (x) =>
        x.state !== 'ended' ||
        runs.has(x.id) ||
        (sleptWhileWaiting(x) && !superseded(x)) ||
        // a plain one you stopped stands for its card as on the Board
        (x.card !== null && stands.get(x.card)?.session?.id === x.id),
    )
    .flatMap((x) => {
      const row = rowOf(
        x,
        runs.get(x.id),
        x.card === null ? undefined : sprint?.get(x.card),
        s.now,
      );

      return row === undefined ? [] : [row];
    })
    .concat(chats)
    .sort(
      (a, b) =>
        // the repo's Abe chat (its main checkout) always on top
        Number(b.session.kind === 'abe') - Number(a.session.kind === 'abe') ||
        GROUP[a.state] - GROUP[b.state] ||
        Date.parse(a.waited) - Date.parse(b.waited) ||
        a.card - b.card,
    );
};

/**
 * The rows that need you, oldest first, as the widgets' tooltip names them. What the toolbar pill
 * and the status bar count is `countsOf` these rows: the Sessions tab's own, so the two
 * never disagree (a session with no run counted too).
 */
export const waitingRows = (rows: readonly SessionRow[]): SessionRow[] =>
  rows
    .filter((r) => r.counted === 'needs-you')
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.card - b.card);

/** Whether `root` is a checkout of the repo the rows are of: one it names, or a session's worktree. */
export const sameRepo = (
  s: { here?: RepoHere | undefined; sessions?: readonly SessionData[] | undefined },
  root: string,
): boolean =>
  (s.here !== undefined &&
    [s.here.root, ...s.here.checkouts].some((f) => bare(f) === bare(root))) ||
  (s.sessions ?? []).some(
    (x) => isHere(s.here, x.repo) && [x.worktree, x.repo].some((f) => bare(f) === bare(root)),
  );

const DASH: TableCell = { text: '—', hue: 'dim' };

/**
 * The Where cell: a box session's cloud and mark, as the Board's rail row has it (`boxMarkOf`); a
 * local one says so.
 */
const whereCell = (s: { boxes: BoxMoves }, x: SessionData): TableCell => {
  if (x.state === 'ended') return DASH;
  // Queued: the boxes that count against the limit, in words on hover
  if (x.state === 'queued' && x.queuedFor !== undefined)
    return {
      text: `${x.queuedFor.boxes.length}/${x.queuedFor.limit} boxes`,
      hue: 'dim',
      tooltip: `Queued: ${queuedForText(x.queuedFor)}`,
    };
  const mark = boxMarkOf(x, s.boxes);

  // the repo's Abe chat runs unjailed, as its Chat header says
  if (x.kind === 'abe') return { text: HUB_WHERE, hue: 'dim' };
  if (x.box === undefined)
    return { text: 'Local sandbox', hue: 'dim', tooltip: 'Local sandbox · this machine' };
  if (mark === undefined) return { tooltip: `Box ${x.box}` };

  return { cloud: CLOUD_OF[mark], tooltip: `Box ${x.box} · ${BOX_MARK_WORDS[mark]}` };
};

/** A row's cells in the columns' order (the Board's Sessions tab draws them too). */
export const sessionCells = (
  s: { boxes: BoxMoves; now?: string | undefined },
  r: SessionRow,
): TableCell[] => {
  const mark = {
    ...(r.givenUp === true ? MARKS.idle : MARKS[r.state]),
    ...(r.hue === undefined ? {} : { hue: r.hue }),
  };
  const working = subagentsWorking(r.session);
  const stage: TableCell =
    r.run === undefined || onNoStage(r.run)
      ? DASH
      : {
          rail: railSegments(r.run, lookOf(r.run, r.session, s.now).segment),
          text: railWord(r.run),
        };

  return [
    // a chat names its card when it has one
    r.chat === true
      ? { ...(hasCard(r) ? { accent: `#${r.card}` } : {}), text: r.title }
      : { accent: `#${r.card}`, text: r.title },
    stage,
    { mark: mark.mark, text: r.word, hue: mark.hue },
    whereCell(s, r.session),
    // a cloud launch by the second
    { text: launchClock(r.session, s.now) ?? minutesIn(r.since, s.now) },
    working === 0 ? DASH : { text: String(working) },
  ];
};
