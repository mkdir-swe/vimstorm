/**
 * A cloud launch's steps (#142): what a session in your environment is waiting on while it is
 * `starting`, from the Mac's own view of EC2 and the box's `workspace.step` events. Pure: the
 * steps and how a launch moves through them; what a client says of one, second by second, is
 * ui's (`launch.ts` there), so a launch is never a bare `starting` for minutes.
 */
import { z } from 'zod';

/**
 * In order: EC2 making or starting the box; the box up, its `abe serve` not answering yet (boot,
 * the first boot's tools); the base image built (a new box, a release's first wake); the repo's
 * image; the workspace (the mirror, Postgres, the clone, the container); its `claude` starting.
 */
export const LAUNCH_STEPS = [
  'box-starting',
  'box-booting',
  'base-image',
  'repo-image',
  'workspace',
  'claude-starting',
] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];

/** A box made for the launch (`new`), woken (`wake`) or running already (`use`). */
export const LAUNCH_HOWS = ['new', 'wake', 'use'] as const;
export type LaunchHow = (typeof LAUNCH_HOWS)[number];

/** What the box's `abe workspace up` is doing (its `workspace.step` events). */
export const WORKSPACE_STEPS = [
  'mirror',
  'base-image',
  'image',
  'database',
  'clone',
  'container',
] as const;
export type WorkspaceStep = (typeof WORKSPACE_STEPS)[number];

export const WorkspaceStepData = z.object({
  step: z.enum(WORKSPACE_STEPS),
  /** A build's `step 14/27` (Docker's own count), else null. */
  detail: z.string().nullable(),
  /** The card whose workspace is coming up (ADR 0022: a box holds several); none from a 2.2 box. */
  card: z.string().optional(),
});
export type WorkspaceStepData = z.infer<typeof WorkspaceStepData>;

export const LaunchProgress = z.object({
  step: z.enum(LAUNCH_STEPS),
  /** When it entered this step. */
  since: z.iso.datetime(),
  /** When its box was asked for (its dequeue, for a Queued one): the launch's clock. */
  startedAt: z.iso.datetime(),
  box: z.string(),
  how: z.enum(LAUNCH_HOWS),
  /** What the box said of the step (`step 14/27`, `cloning`), else null. */
  detail: z.string().nullable(),
  /** The box said steps of its own (an abe from before #142 says none). */
  told: z.boolean().default(false),
  /** The steps it went through, oldest first, each with how long it took. */
  done: z.array(z.object({ step: z.enum(LAUNCH_STEPS), ms: z.number().int().nonnegative() })),
});
export type LaunchProgress = z.infer<typeof LaunchProgress>;

/** A launch's first step: where its box is asked for. */
export const launchBegun = (box: string, how: LaunchHow, at: string): LaunchProgress => ({
  step: how === 'use' ? 'workspace' : 'box-starting',
  since: at,
  startedAt: at,
  box,
  how,
  detail: null,
  told: false,
  done: [],
});

/**
 * Where a step stands in the launch: the box, then its workspace (the images built inside it, in
 * whatever order the box says them), then `claude`. A launch never goes back a phase.
 */
const PHASE: Readonly<Record<LaunchStep, number>> = {
  'box-starting': 0,
  'box-booting': 1,
  'base-image': 2,
  'repo-image': 2,
  workspace: 2,
  'claude-starting': 3,
};

/** A session as far as its box goes: its state and, while it starts, its launch. */
type OnBox = { state: string; launch: LaunchProgress | null };

/**
 * Its box is known to run (#339): its session works or waits, or its launch is past the box's
 * start and boot (building the workspace there, then starting claude). Else it may sleep: an
 * attach to it wakes it first.
 */
export const boxRuns = (s: OnBox): boolean =>
  s.state === 'working' ||
  s.state === 'waiting' ||
  (s.state === 'starting' && s.launch !== null && PHASE[s.launch.step] >= PHASE['base-image']);

/**
 * Its box runs and its workspace is being built there (#339: the images, `abe workspace up`):
 * no workspace container to attach to yet.
 */
export const building = (s: OnBox): boolean =>
  s.state === 'starting' && s.launch !== null && PHASE[s.launch.step] === PHASE.workspace;

/**
 * The launch at `step` from `at`: a new step closes the one before (its time kept in `done`); the
 * same step again keeps its clock and takes the new `detail`. Never back to an earlier phase
 * (`PHASE`): a late `box-booting` after the box said its workspace is kept out; and the Mac's own
 * step (`told` false) never takes the place of one the box said in the same phase.
 */
export const launchStepped = (
  l: LaunchProgress,
  step: LaunchStep,
  at: string,
  detail: string | null = null,
  told = false,
): LaunchProgress => {
  const fromBox = l.told || told;

  if (PHASE[step] < PHASE[l.step]) return l;
  if (!told && l.told && PHASE[step] === PHASE[l.step]) return l;
  if (step === l.step) return { ...l, detail, told: fromBox };

  return {
    ...l,
    step,
    since: at,
    detail,
    told: fromBox,
    done: [...l.done, { step: l.step, ms: Math.max(0, Date.parse(at) - Date.parse(l.since)) }],
  };
};

const WORKSPACE_WORDS: Readonly<Record<WorkspaceStep, string>> = {
  mirror: 'fetching the repo',
  'base-image': 'building the base image',
  image: "building the repo's image",
  database: 'starting the database',
  clone: 'cloning the repo',
  container: 'starting the container',
};

/** The launch moved by the box's `workspace.step`: an image build its own step, the rest the workspace's. */
export const launchFromBox = (
  l: LaunchProgress,
  w: WorkspaceStepData,
  at: string,
): LaunchProgress => {
  if (w.step === 'base-image') return launchStepped(l, 'base-image', at, w.detail, true);
  if (w.step === 'image') return launchStepped(l, 'repo-image', at, w.detail, true);
  return launchStepped(l, 'workspace', at, WORKSPACE_WORDS[w.step], true);
};

/** Docker's progress in a BuildKit build's output line (`#7 [stage 3/9] RUN …`, on its stderr). */
export const buildStepOf = (line: string): string | undefined => {
  const m = /^#\d+ \[(?:[^\]\s]+ )?(\d+)\/(\d+)\]/.exec(line);

  return m === null ? undefined : `step ${m[1] ?? ''}/${m[2] ?? ''}`;
};

/** Past this the Mac gives the launch up (serve's `bootMs`). */
export const LAUNCH_GIVE_UP_MS = 15 * 60_000;

/** A clock's `0:07`, `5:18`, `1:02:03` (ui's `clockText` says the same). */
export const clockText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/** What a step is doing, in a sentence's middle (ui's `LATE_WORDS` say the same). */
export const LAUNCH_STEP_WORDS: Readonly<Record<LaunchStep, string>> = {
  'box-starting': 'starting the box',
  'box-booting': 'booting the box',
  'base-image': 'building the workspace image',
  'repo-image': "building the repo's image",
  workspace: 'starting the workspace',
  'claude-starting': 'starting Claude Code',
};

/**
 * Why a launch was given up (its step timed out): the step it hung at and how long, and the box's
 * log to read once EC2 has a box to attach to.
 */
export const launchFailText = (l: LaunchProgress, now: string, why: string): string => {
  const inStep = Math.max(0, Date.parse(now) - Date.parse(l.since));
  const log =
    l.step === 'box-starting'
      ? ''
      : `; abe box attach ${l.box} -- journalctl -u abe-serve -u abe-workspace -n 40 says why`;

  return `${why} (hung ${LAUNCH_STEP_WORDS[l.step]} for ${clockText(inStep)}${log})`;
};

/** `abe watch`'s line: `building the workspace image · step 14/27 on demo-shop-901`. */
export const launchText = (l: LaunchProgress): string =>
  `${LAUNCH_STEP_WORDS[l.step]}${l.detail === null ? '' : ` · ${l.detail}`} on ${l.box}`;
