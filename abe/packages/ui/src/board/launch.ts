/**
 * What a client says of a cloud launch while it starts, second by second: its step's
 * word and sentence, the time since it began, and, once a step is past its budget, what is late
 * and what to run. Core's `launch.ts` moves a launch through its steps; this reads one.
 */
import type { LaunchHow, LaunchProgress, LaunchStep } from '@abe/core';

const SEC = 1000;
const MIN = 60 * SEC;

/** How long a step usually takes and past when it is slow (QA F's measures). */
type Budget = { usual: number; slow: number };

const BUDGETS: Readonly<Record<LaunchStep, Readonly<Record<LaunchHow, Budget>>>> = {
  'box-starting': {
    new: { usual: 10 * SEC, slow: MIN },
    wake: { usual: 20 * SEC, slow: 2 * MIN },
    use: { usual: 0, slow: MIN },
  },
  // A new box's first boot installs its tools (boot.sh) before its serve answers.
  'box-booting': {
    new: { usual: 75 * SEC, slow: 3 * MIN },
    wake: { usual: 10 * SEC, slow: 2 * MIN },
    use: { usual: 0, slow: MIN },
  },
  'base-image': {
    new: { usual: 3 * MIN, slow: 6 * MIN },
    wake: { usual: 3 * MIN, slow: 6 * MIN },
    use: { usual: 3 * MIN, slow: 6 * MIN },
  },
  'repo-image': {
    new: { usual: 30 * SEC, slow: 3 * MIN },
    wake: { usual: 30 * SEC, slow: 3 * MIN },
    use: { usual: 30 * SEC, slow: 3 * MIN },
  },
  workspace: {
    new: { usual: 30 * SEC, slow: MIN },
    wake: { usual: 10 * SEC, slow: MIN },
    use: { usual: 5 * SEC, slow: MIN },
  },
  'claude-starting': {
    new: { usual: 10 * SEC, slow: MIN },
    wake: { usual: 10 * SEC, slow: MIN },
    use: { usual: 10 * SEC, slow: MIN },
  },
};

/** A new box whose abe says no steps (an older abe) builds its images inside the workspace step. */
const SILENT_NEW_WORKSPACE: Budget = { usual: 4 * MIN, slow: 7 * MIN };

/** When serve gives a launch up (core's `LAUNCH_GIVE_UP_MS`); red from 80 % of it. */
export const GIVE_UP_MS = 15 * MIN;
const STUCK_MS = GIVE_UP_MS * 0.8;

const budgetOf = (l: LaunchProgress): Budget =>
  l.step === 'workspace' && l.how === 'new' && !l.told
    ? SILENT_NEW_WORKSPACE
    : BUDGETS[l.step][l.how];

/** A clock's `0:07`, `5:18`, `1:02:03` (core's `clockText`). */
export const clockText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / SEC));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

/** `3 min`, `30 s`. */
const aboutText = (ms: number) => (ms >= MIN ? `${Math.round(ms / MIN)} min` : `${ms / SEC} s`);

/** On time, past its usual budget (amber), or about to be given up (red). */
export type LaunchTone = 'on-time' | 'slow' | 'stuck';

export type LaunchLook = {
  /** Short, for a card's rail and a Sessions row: `Box booting`. */
  word: string;
  /** The whole step, for Chat: `Building the workspace image (…) · step 14/27`. */
  line: string;
  /** Since the launch began: `2:10`. */
  elapsed: string;
  tone: LaunchTone;
  /** Slow or stuck: what is late and by how much. */
  note?: string;
  /** Slow or stuck: what to run, its label and the command. */
  fix?: { label: string; argv: string }[];
};

const WORDS: Readonly<Record<LaunchStep, string>> = {
  'box-starting': 'Box starting',
  'box-booting': 'Box booting',
  'base-image': 'Building image',
  'repo-image': 'Repo image',
  workspace: 'Workspace',
  'claude-starting': 'Starting Claude',
};

/** What a step is doing, in a sentence's middle (core's `LAUNCH_STEP_WORDS`). */
export const LATE_WORDS: Readonly<Record<LaunchStep, string>> = {
  'box-starting': 'starting the box',
  'box-booting': 'booting the box',
  'base-image': 'building the workspace image',
  'repo-image': "building the repo's image",
  workspace: 'starting the workspace',
  'claude-starting': 'starting Claude Code',
};

/** The step as a sentence: `Building the workspace image (first time on this box, ~3 min) · step 14/27`. */
export const stepLine = (l: LaunchProgress): string => {
  const detail = l.detail === null ? '' : ` · ${l.detail}`;

  switch (l.step) {
    case 'box-starting':
      return l.how === 'new'
        ? `Making box ${l.box} · new box, first start takes about 5 min`
        : `Waking ${l.box}`;
    case 'box-booting':
      return l.how === 'new'
        ? 'Box booting, installing its tools (first boot only)'
        : 'Box booting';
    case 'base-image':
      return `Building the workspace image (first time on this box, ~3 min)${detail}`;
    case 'repo-image':
      return `Building the repo's image${detail}`;
    case 'workspace':
      if (l.detail !== null) return `Workspace · ${l.detail}`;

      return l.how === 'new' && !l.told
        ? 'Workspace · building its image, cloning, starting the database'
        : 'Starting the workspace';
    case 'claude-starting':
      return 'Starting Claude Code';
  }
};

/** What to run when a step is late: the box's log, and its serve restarted once the box is up. */
const fixesOf = (l: LaunchProgress) => {
  const log = {
    label: 'Box log',
    argv: `abe box attach ${l.box} -- journalctl -u abe-serve -u abe-workspace -n 40`,
  };

  // no box to attach to yet
  if (l.step === 'box-starting') return [];

  return [
    log,
    { label: 'Restart serve', argv: `abe box attach ${l.box} -- sudo systemctl restart abe-serve` },
  ];
};

/** What a client says of a launch at `now` (RFC 3339). */
export const launchLook = (l: LaunchProgress, now: string): LaunchLook => {
  const at = Date.parse(now);
  const inStep = Math.max(0, at - Date.parse(l.since));
  const total = Math.max(0, at - Date.parse(l.startedAt));
  const budget = budgetOf(l);
  const base = { word: WORDS[l.step], line: stepLine(l), elapsed: clockText(total) };
  const usually = budget.usual > 0 ? ` (usually ${aboutText(budget.usual)})` : '';
  // A box EC2 runs whose serve does not answer: not slow, broken (boot.sh failed, serve down).
  const silent = l.step === 'box-booting' && inStep > budget.slow;
  const late = silent
    ? `Box up but abe serve doesn't answer · ${clockText(inStep)}`
    : `${LATE_WORDS[l.step]} ${clockText(inStep)}${usually}`;

  if (total >= STUCK_MS)
    return {
      ...base,
      tone: 'stuck',
      note: `Stuck · ${late} · given up at ${clockText(GIVE_UP_MS)}`,
      fix: fixesOf(l),
    };
  if (inStep > budget.slow)
    return {
      ...base,
      tone: 'slow',
      note: silent ? late : `Slower than usual · ${late}`,
      fix: fixesOf(l),
    };

  return { ...base, tone: 'on-time' };
};

/** One step for Chat's body while it starts: gone through (`✓ Box starting`, its time), or the one now. */
export type LaunchStepRow = { text: string; time: string; done: boolean };

/** The steps gone through, each with how long it took, then the one now with its clock. */
export const launchSteps = (l: LaunchProgress, now: string): LaunchStepRow[] => [
  ...l.done.map((d) => ({ text: `✓ ${WORDS[d.step]}`, time: clockText(d.ms), done: true })),
  {
    text: `● ${stepLine(l)}`,
    time: clockText(Date.parse(now) - Date.parse(l.since)),
    done: false,
  },
];
