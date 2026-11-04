/**
 * The header's one feed (B Signal): the `workspaces` shell effect. Per story workspace (a
 * session's local worktree, or its box) every word and hue the shell draws of it: the strip's tab
 * (state dot, `#id short title`, the cloud, the StageRail), the toolbar's context line as badges,
 * the tree's root row, the status bar's crumb and the empty editor's caption; and the Factory
 * view's own line and crumb. Rust only draws them and matches its open projects to them (a local
 * one by `root`, a cloud one by `box`); a project no entry names is the main checkout (or a
 * workspace whose session is not known yet), which the shell draws plainly. Pure, a table in
 * `workspaces.test.ts`; the Factory overview (`factory.ts`) sends it whenever it changes.
 */
import { z } from 'zod';
import type { FactoryRunData, SessionData } from '@abe/core';
import { building } from '@abe/core/launch';
import { waitsOnYou } from '@abe/core/waits-on';
import { sameCard } from '@abe/core/here';
import { RAIL_SEGMENTS, type RailSegment } from './board';
import { CLOUD_STATES, type CloudState } from '../live';
import { Hue, NodeId } from '../runtime/runtime';
import { stepLine } from './launch';
import {
  clockSince,
  type Counts,
  RAIL_STAGES,
  type RailStage,
  type Look,
  lookOf,
  onNoStage,
  railSegments,
  railStageOf,
  minutesIn,
  placedBox,
  readyText,
  sessionLook,
  shownState,
  standing,
} from './flow';

/** Where a workspace's story stands, as its tab's dot says it. */
export const WORKSPACE_STATES = [
  'idle',
  'running',
  'needs-you',
  'done',
  'failed',
  'starting',
] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/** One badge of a context line: its words in its hue (a wash at 16 %), a box's cloud before them. */
export const Chip = z.strictObject({
  text: z.string().min(1),
  hue: Hue,
  cloud: z.enum(CLOUD_STATES).optional(),
  /** A click on this badge is a `click` on this id (else the line's: Linked, as ⌃L). */
  id: NodeId.optional(),
  /** Local mode's badge: dashed in the path hue with the house mark, its `hue` unused. */
  local: z.boolean().optional(),
});
export type Chip = z.infer<typeof Chip>;

/** A run of words in a line; a state mark's in its hue (else dim). */
export const Span = z.strictObject({ text: z.string(), hue: Hue.optional() });
export type Span = z.infer<typeof Span>;

/** One story workspace as the header draws it. */
export const WorkspaceLook = z.strictObject({
  /** The session's worktree: a local workspace's project folder. */
  root: z.string().min(1),
  /** The box a cloud workspace runs on: the shell matches its attached project by it. */
  box: z.string().min(1).optional(),
  story: z.strictObject({
    id: z.number().int().positive(),
    /** `cart total ignores quantity`: the title without its article, lower case first. */
    short: z.string(),
    title: z.string(),
  }),
  state: z.enum(WORKSPACE_STATES),
  /** The tab's dot (`○ ● ◆ ✓ ✗`) and its hue, also the selected tab's tint. */
  dot: z.strictObject({ mark: z.string().min(1), hue: Hue }),
  /** The run's stage; null for a session with no Factory run. */
  stage: z.enum(RAIL_STAGES).nullable(),
  /** The StageRail's five segments (Spec · Build · Review · PR · Done). */
  rail: z.array(z.enum(RAIL_SEGMENTS)).length(RAIL_STAGES.length),
  /** Its clock's start (`clockSince`): the same on the Board, Chat, Sessions and Linked. */
  since: z.iso.datetime(),
  /** Its box's cloud; null for a local one (no mark). */
  cloud: z.enum(CLOUD_STATES).nullable(),
  /** The cloud's hue: the accent while its box runs or starts, dim asleep; null for a local one. */
  cloudHue: Hue.nullable(),
  pr: z
    .strictObject({
      n: z.number().int().positive(),
      checks: z.enum(['none', 'pending', 'success', 'failure']),
    })
    .nullable(),
  branch: z.string(),
  /** The strip tab's words (`#2 cart total ignores quantity`), its hover. */
  tab: z.string().min(1),
  tooltip: z.string().min(1),
  /** The toolbar's context line on the Editor, and how it reads whole (its accessible label). */
  line: z.array(Chip),
  label: z.string().min(1),
  /** The status bar's first crumb, the tree root's name: `#2 cart total ignores quantity`. */
  crumb: z.string().min(1),
  /** The empty editor's line under Abe's face: `cart total ignores quantity · Build ● Running`. */
  caption: z.array(Span),
  /**
   * Its box runs and its workspace is being built there: the launch's step as Chat says it
   * (`Building the workspace image (…) · step 14/27`). RemoteState waits on it, no attach try
   * spent, until it is gone. Absent otherwise.
   */
  building: z.string().min(1).optional(),
});
export type WorkspaceLook = z.infer<typeof WorkspaceLook>;

/** The Factory view's context line, its accessible label, the status bar's crumb. */
export const FactoryLine = z.strictObject({
  line: z.array(Chip),
  label: z.string().min(1),
  crumb: z.string(),
});
export type FactoryLine = z.infer<typeof FactoryLine>;

/** The effect's body (`protocol.ts` adds its `kind`). */
export type Workspaces = {
  workspaces: WorkspaceLook[];
  factory: FactoryLine;
  /** `serve` answers the reads: false, the toolbar says `abe serve not answering`. */
  answering: boolean;
  /** The main checkouts whose Abe chat waits on you (its rail tile's teal dot); absent: none. */
  abeNeedsYou?: string[];
};

/** The id a click on the Factory line's Needs you badge names: it lands on the oldest waiting. */
export const LINE_NEEDS_YOU = 'toolbar:needs-you';

/** A run's look as a tab's state: done once the agent's part is (Ready for review, On test). */
export const STATE_OF: Readonly<Record<Look['state'], WorkspaceState>> = {
  starting: 'starting',
  running: 'running',
  'needs-you': 'needs-you',
  idle: 'idle',
  ready: 'done',
  failed: 'failed',
  ended: 'done',
  merged: 'done',
  'on-test': 'done',
};

/** A run's look as a tab's state (`STATE_OF`); one given up is dim `○`, never ✓. */
export const stateOfLook = (l: Look): WorkspaceState =>
  l.givenUp === true ? 'idle' : STATE_OF[shownState(l)];

/** A session with no Factory run: its state alone. */
const SESSION_LOOK: Readonly<
  Record<SessionData['state'], { state: WorkspaceState; word: string }>
> = {
  starting: { state: 'starting', word: 'Starting' },
  queued: { state: 'idle', word: 'Queued' },
  working: { state: 'running', word: 'Running' },
  waiting: { state: 'needs-you', word: 'Needs you' },
  ended: { state: 'idle', word: 'Ended' },
};

/** A session with no Factory run: its state, idle while it waits on its turn alone. */
const sessionState = (session: CardSession): WorkspaceState =>
  session.state === 'waiting' && !waitsOnYou(session) ? 'idle' : SESSION_LOOK[session.state].state;

/** The dot and its hue, per state (H-States, B rows). */
export const MARK: Readonly<Record<WorkspaceState, string>> = {
  idle: '○',
  running: '●',
  'needs-you': '◆',
  done: '✓',
  failed: '✗',
  starting: '●',
};
export const HUE: Readonly<Record<WorkspaceState, Hue>> = {
  idle: 'dim',
  running: 'warn',
  'needs-you': 'needs-you',
  done: 'good',
  failed: 'bad',
  starting: 'dim',
};

/**
 * No stage yet (a plain session, a queued run): the first segment in its state (done: all), as its
 * rail tile draws it.
 */
const NO_STAGE: Readonly<Record<WorkspaceState, RailSegment>> = {
  idle: 'todo',
  running: 'now',
  'needs-you': 'need',
  done: 'done',
  failed: 'fail',
  starting: 'todo',
};

/** A cloud's hue: the accent while its box runs or starts, dim asleep. */
export const CLOUD_HUE: Readonly<Record<CloudState, Hue>> = {
  running: 'accent',
  starting: 'accent',
  asleep: 'dim',
};

const ARTICLE = /^(the|a|an)\s+/i;

/** `The cart total ignores quantity` → `cart total ignores quantity`; `API keys` stays. */
export const shortTitle = (title: string): string => {
  const t = title.trim().replace(ARTICLE, '');
  const second = t.charAt(1);

  return second !== '' && second === second.toUpperCase() && second !== second.toLowerCase()
    ? t
    : t.charAt(0).toLowerCase() + t.slice(1);
};

/** The most of the short title the context line's story badge shows, its `…` counted. */
const BRIEF_MOST = 20;

/** Words a cut title never ends on before its `…` (`as a…`). */
const BRIEF_NOT_LAST = /^(a|an|the|as|to|of|in|on|at|by|for|with|and|or)$/i;

/**
 * The context line's story badge: the short title whole when it fits, else its first whole words
 * (never ending on `a`, `the`, `to`…) and `…`; a first word too long for it cut.
 */
export const briefTitle = (short: string): string => {
  const words = short.split(/\s+/).filter((w) => w !== '');
  const whole = words.join(' ');

  if (whole.length <= BRIEF_MOST) return whole;
  const kept: string[] = [];

  for (const w of words) {
    if ([...kept, w].join(' ').length > BRIEF_MOST - 1) break;
    kept.push(w);
  }
  while (kept.length > 1 && BRIEF_NOT_LAST.test(kept.at(-1) ?? '')) kept.pop();

  return kept.length === 0 ? `${whole.slice(0, BRIEF_MOST - 1)}…` : `${kept.join(' ')}…`;
};

/**
 * A box's cloud as its session stands: starting, asleep once it ended, else running; none for a
 * local one or one that never got its box.
 */
export const cloudOf = (
  s: Pick<SessionData, 'state' | 'box' | 'neverPlaced'>,
): CloudState | null => {
  if (placedBox(s) === undefined) return null;
  if (s.state === 'starting' || s.state === 'queued') return 'starting';

  return s.state === 'ended' ? 'asleep' : 'running';
};

const PR_MARK: Readonly<
  Record<'none' | 'pending' | 'success' | 'failure', { mark: string; hue: Hue; words: string }>
> = {
  none: { mark: '', hue: 'accent', words: '' },
  pending: { mark: ' ●', hue: 'warn', words: ', checks running' },
  success: { mark: ' ✓', hue: 'good', words: ', checks passed' },
  failure: { mark: ' ✗', hue: 'bad', words: ', checks failed' },
};

/** A card's session (an Improve retro chat or a prototype chat has none). */
export type CardSession = SessionData & { card: number };

const isCard = (s: SessionData): s is CardSession => s.card !== null;

/** The newest session per workspace (a box's card's, else a worktree's) of a card. */
const newestPerWorkspace = (sessions: readonly SessionData[]): CardSession[] => {
  const by = new Map<string, CardSession>();

  for (const s of sessions) {
    // one that never got a box has no workspace
    if (!isCard(s) || s.neverPlaced === true) continue;
    // A box holds a workspace per card (ADR 0022): a cloud one is its box's and its card's.
    const key = s.box === undefined ? `local:${s.worktree}` : `box:${s.box}:${s.card}`;
    const had = by.get(key);

    if (had === undefined || Date.parse(s.startedAt) > Date.parse(had.startedAt)) by.set(key, s);
  }

  return [...by.values()];
};

/** The session's run: the one it is the session of, else its card's newest (its repo's). */
const runOf = (session: SessionData, runs: readonly FactoryRunData[]): FactoryRunData | undefined =>
  runs.find((r) => r.session === session.id) ??
  runs
    .filter((r) => sameCard(r, session))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

/**
 * The run a workspace's look reads: none while a plain session of its own stands for its card (a
 * live one after a run abandoned or ended: `standing`, the one rule the Board's card and Chat's
 * header read, so its tile, page header and Chat agree), else the session's run.
 */
const shownRun = (
  session: CardSession,
  runs: readonly FactoryRunData[],
  sessions: readonly SessionData[],
): FactoryRunData | undefined => {
  const stands = standing(
    runs.filter((r) => sameCard(r, session)),
    sessions.filter((x) => sameCard(x, session)),
  ).get(session.card);

  return stands?.run === undefined && stands?.session?.id === session.id
    ? undefined
    : runOf(session, runs);
};

/** One story workspace's look, every word of it. */
export const workspaceLook = (
  session: CardSession,
  run: FactoryRunData | undefined,
  now: string | undefined,
): WorkspaceLook => {
  const id = session.card;
  const title = run?.title ?? session.title;
  const short = shortTitle(title);
  const look = run === undefined ? undefined : lookOf(run, session, now);
  const state = look === undefined ? sessionState(session) : stateOfLook(look);
  // the session's own word, as the Board's card and Chat's header say it
  const word = look?.word ?? sessionLook(session, now).word;
  // Queued, nothing ran: no stage yet
  const stage: RailStage | null = run === undefined || onNoStage(run) ? null : railStageOf(run);
  const rail: RailSegment[] =
    run === undefined || look === undefined || stage === null
      ? RAIL_STAGES.map((_, i) => (i === 0 || state === 'done' ? NO_STAGE[state] : 'todo'))
      : railSegments(run, look.segment);
  const since = run === undefined ? session.since : clockSince(run, session);
  const time = minutesIn(since, now);
  const cloud = cloudOf(session);
  const box = placedBox(session);
  const pr =
    run?.pr === null || run?.pr === undefined ? null : { n: run.pr.number, checks: run.pr.checks };
  const mark = MARK[state];
  const hue = HUE[state];
  const stageWords = stage === null ? '' : `${stage} `;
  const where = box === undefined ? 'Local sandbox' : `box ${box} ${cloud ?? 'running'}`;
  const prMark = pr === null ? undefined : PR_MARK[pr.checks];
  const brief = `#${id} ${briefTitle(short)}`;

  return {
    root: session.worktree,
    ...(box === undefined ? {} : { box }),
    story: { id, short, title },
    state,
    dot: { mark, hue },
    stage,
    rail,
    since,
    cloud,
    cloudHue: cloud === null ? null : CLOUD_HUE[cloud],
    pr,
    branch: session.branch,
    tab: `#${id} ${short}`,
    tooltip: [
      `#${id} ${title}`,
      ...(stage === null ? [] : [stage]),
      time === '' ? word : `${word} ${time}`,
      where,
    ].join(' · '),
    line: [
      { text: brief, hue: 'accent' },
      { text: `${stageWords}${mark} ${word}${time === '' ? '' : ` ${time}`}`, hue },
      box === undefined
        ? { text: 'Local', hue: 'dim' }
        : {
            text: box,
            hue: cloud === 'asleep' ? 'dim' : 'accent',
            ...(cloud === null ? {} : { cloud }),
          },
      pr === null || prMark === undefined
        ? { text: 'PR —', hue: 'dim' }
        : { text: `PR #${pr.n}${prMark.mark}`, hue: prMark.hue },
    ],
    label: [
      `Linked: ${brief}`,
      ...(stage === null ? [] : [stage]),
      time === '' ? word : `${word} ${time}`,
      box === undefined ? 'local' : `box ${box}`,
      pr === null || prMark === undefined
        ? 'no pull request'
        : `pull request #${pr.n}${prMark.words}`,
    ].join(', '),
    crumb: `#${id} ${short}`,
    caption: [{ text: `${short} · ${stageWords}` }, { text: `${mark} ${word}`, hue }],
    ...(box !== undefined && session.launch !== null && building(session)
      ? { building: stepLine(session.launch) }
      : {}),
  };
};

/** `mkdir-swe/demo-shop` → `demo-shop`. */
const repoName = (repo: string): string => repo.split('/').at(-1) ?? repo;

/**
 * The project the Factory view shows: the shown folder's session's repo, else its folder's name
 * (the sessions may all be another open repo's); no folder: the repo all sessions share.
 */
export const projectName = (
  sessions: readonly Pick<SessionData, 'repo' | 'worktree'>[],
  root: string | undefined,
): string | undefined => {
  const here = sessions.find((s) => s.worktree === root);

  if (here !== undefined) return repoName(here.repo);
  if (root !== undefined)
    return root
      .split('/')
      .filter((p) => p !== '')
      .at(-1);
  const repos = new Set(sessions.map((s) => repoName(s.repo)));

  return repos.size === 1 ? [...repos][0] : undefined;
};

/** The Factory view's line: `Factory · demo-shop · Sprint 1 · ◆ 1 needs you · ● 2 running`. */
export const factoryLine = (
  project: string | undefined,
  sprint: string | null | undefined,
  c: Counts,
): FactoryLine => {
  const sprintName = sprint ?? undefined;
  const line: Chip[] = [
    ...(project === undefined ? [] : [{ text: project, hue: 'accent' as const }]),
    ...(sprintName === undefined ? [] : [{ text: sprintName, hue: 'dim' as const }]),
    ...(c.needsYou > 0
      ? [{ text: `◆ ${c.needsYou} needs you`, hue: 'needs-you' as const, id: LINE_NEEDS_YOU }]
      : []),
    ...(c.running > 0 ? [{ text: `● ${c.running} running`, hue: 'warn' as const }] : []),
    ...(c.ready > 0 ? [{ text: readyText(c.ready), hue: 'good' as const }] : []),
  ];

  return {
    line,
    label: [
      'Abe',
      ...(project === undefined ? [] : [project]),
      ...(sprintName === undefined ? [] : [sprintName]),
      ...(c.needsYou > 0 ? [`${c.needsYou} needs you`] : []),
      ...(c.running > 0 ? [`${c.running} running`] : []),
      ...(c.ready > 0 ? [`${c.ready} ready for review`] : []),
    ].join(', '),
    crumb: [project, sprintName].filter((p) => p !== undefined).join(' · '),
  };
};

export type WorkspacesFacts = {
  runs: readonly FactoryRunData[] | undefined;
  sessions: readonly SessionData[] | undefined;
  now: string | undefined;
  root: string | undefined;
  sprint: string | null | undefined;
  counts: Counts;
  /** No read of the runs or the sessions failed last. */
  answering: boolean;
};

/** The whole feed, from what the Factory overview holds. */
export const workspacesOf = (f: WorkspacesFacts): Workspaces => {
  const sessions = f.sessions ?? [];
  const runs = f.runs ?? [];
  // an open Abe chat conversation asking you something, by the main checkout it runs in
  const abeNeedsYou = [
    ...new Set(sessions.filter((s) => s.kind === 'abe' && waitsOnYou(s)).map((s) => s.worktree)),
  ].sort();

  return {
    workspaces: newestPerWorkspace(sessions)
      .map((s) => workspaceLook(s, shownRun(s, runs, sessions), f.now))
      .sort((a, b) => a.story.id - b.story.id || a.root.localeCompare(b.root)),
    factory: factoryLine(projectName(sessions, f.root), f.sprint, f.counts),
    answering: f.answering,
    ...(abeNeedsYou.length === 0 ? {} : { abeNeedsYou }),
  };
};
