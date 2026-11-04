/**
 * The Run place (design C, every step the same way): a card's run in the main area, the shown
 * workspace's run only (`open run {card}` in the `main` slot). Built from `abe factory record
 * <card>` (core's `runRecordOf`): live while the run goes (read again as its events come, a step's
 * summary landing too, one read out at a time), afterwards the record from the org log store.
 *
 * The bar: `Run #2 · demo-shop · Bug run · Local sandbox · 19 min so far`, `#2` the card (a click,
 * or ⏎ with the keys on it, opens the full card), Linked ▾ (⌃L: Command mode's Linked popup on the
 * card, a jump) and expand (⌥⌘⏎, the shell's: the main area maximized, Chat hidden). On the left
 * the run in time order, a quiet row per step run (a loop's rounds each their own row, a step its
 * gate skipped too, the report an `ends:` ended the run with last): its mark, its name, at most one
 * muted word (`1 finding ↩`, `skipped`, `needs you`); the steps not reached dim at its foot. On the
 * right the step the keys are on: `build · implement · 09:18 · 3 min · subagent`, then `✓ done ·
 * ⟲ fresh · round 2 of 3 · sent back from checks`; its state (the question it waits on, its last
 * words while it runs, the loop it sent the run back by, what it was sent back with), what it did,
 * then what it read on the left and what it made on the right (`run-columns.ts`), its details
 * folded under (commands, scratch files, the skills it pulled in). `l ö` (↑ ↓) step, `l` on the
 * first row onto `#2`, `gg` `G`, ⏎ its details, ⌃S the spec beside it; `:`'s Go to Needs you the
 * step that needs you.
 */
import {
  type Event,
  type Judgement,
  type PlaybookKept,
  type RunRecordData,
  type RunRecordStep,
  type Stage,
  type VerifyShot,
} from '@abe/core';
import { FEATURE_FLOW, judgeKindOf, type RunFlowStep } from '@abe/core/run-flow';
import { screenClock } from '@abe/core/when';
import { empty, type Hue, type Node, stack } from '../runtime/components';
import { cardOfBranch } from '../board/branch';
import { timeIn } from '../board/flow';
import type {
  RunBar,
  RunDetail,
  RunFocus,
  RunSpecPane,
  RunStepRow,
  RunSteps,
} from './run-components';
import {
  type Columns,
  type ColumnsStep,
  carriedOf,
  columnsOf,
  inScratch,
  loopOf,
  nowOf,
  reportedColumns,
  skippedColumns,
} from './run-columns';
import { type Command, type Here, type Input, type Screen } from '../runtime/runtime';

/** `4 steps · 2 for you`. */
export const playbookLine = (pb: PlaybookKept): string => {
  const yours = pb.steps.filter((s) => s.by === 'you').length;
  const n = pb.steps.length;

  return `${n} ${n === 1 ? 'step' : 'steps'} · ${yours} for you`;
};

/** The record's run: `run:record:<card>`. */
export const RUN_RECORD = 'run:record:';

/** Below this width the steps' column is narrower. */
export const RUN_NARROW_W = 1000;

/** The steps' column beside the focus pane; narrower in a narrow window. */
export const STEPS_W = 240;
export const STEPS_NARROW_W = 220;

/** The spec pane's width beside the focus pane (⌃S). */
export const SPEC_PANE_W = 420;

/**
 * The focus pane's least width beside the steps: a Run pane narrower than the steps and this
 * (Chat docked in a narrow window) has the steps over the focus pane, the spec pane under it.
 */
export const FOCUS_LEAST_W = 360;

/** `review open` for Review changes: `run:review:<card>`. */
const REVIEW_OPEN = 'run:review:';

export type RunState = {
  card?: number | undefined;
  /** The project's name (`demo-shop`), from the open's `root`. */
  project?: string | undefined;
  /** The shown workspace's folder (the card's worktree), where its Playbook is opened. */
  root?: string | undefined;
  record?: RunRecordData | undefined;
  /** Why the record could not be read (no run of yours, serve down). */
  error?: string | undefined;
  /** A read is out; `again`: an event came meanwhile, read once more after. */
  reading: boolean;
  again: boolean;
  /**
   * When the first transcript entry of a burst came, its record not read again yet: one read per
   * `ENTRIES_READ_MS` of a live run's words, never one per entry.
   */
  entries?: number | undefined;
  spec: boolean;
  /** Linked ▾ was clicked and its popup is up: until the keys come back to the run. */
  linked: boolean;
  /** The step the keys are on; none: the one the run is at. */
  selected?: string | undefined;
  /** The keys are on the bar's `#2`: ⏎ opens the card. */
  onCard: boolean;
  /** The files whose diff is shown: `<step>:<n>`. */
  open: readonly string[];
  /** The details unfolded: `<step>:<kind>`. */
  details: readonly string[];
  /** The tickets open on a to-tickets step: `<step>:<ticket>`. */
  tickets: readonly string[];
  /** The kit's recordings paused (their control's id); a GIF plays in place till then. */
  paused: readonly string[];
  width: number;
  now?: string | undefined;
  /** A `g` waits for its second. */
  g: boolean;
};

export const RUN_INIT: RunState = {
  reading: false,
  again: false,
  spec: false,
  linked: false,
  onCard: false,
  open: [],
  details: [],
  tickets: [],
  paused: [],
  width: 1400,
  g: false,
};

type Out = { state: RunState; commands: Command[] };

const none = (state: RunState): Out => ({ state, commands: [] });

const read = (s: RunState): Out => {
  if (s.card === undefined) return none(s);
  if (s.reading) return none({ ...s, again: true });

  return {
    state: { ...s, reading: true, again: false },
    commands: [
      {
        kind: 'run',
        id: `${RUN_RECORD}${s.card}`,
        argv: ['factory', 'record', String(s.card)],
        // kept by the host: another workspace's run and back draws its last record at once
        keep: true,
      },
    ],
  };
};

/** A step of the run's workflow, as the run carries it. */
type FlowStep = RunFlowStep;

const MARK: Readonly<Record<RunRecordStep['mark'], { glyph: string; hue: Hue }>> = {
  ok: { glyph: '✓', hue: 'good' },
  // a step that sent the run back did its job: the loop's hue, not a failure's
  failed: { glyph: '●', hue: 'warn' },
  running: { glyph: '●', hue: 'warn' },
  'needs-you': { glyph: '◆', hue: 'needs-you' },
};
const STATE: Readonly<Record<RunRecordStep['mark'], { text: string; hue: Hue }>> = {
  ok: { text: '✓ done', hue: 'good' },
  failed: { text: '● sent back', hue: 'warn' },
  running: { text: '● running', hue: 'warn' },
  'needs-you': { text: '◆ needs you', hue: 'needs-you' },
};
/** What a Before found, as its row says it. */
const BEFORE_WORD: Readonly<Record<string, string>> = {
  pass: 'reproduced',
  'not-reproduced': 'not reproduced',
  fail: 'could not run',
};
/** Ready for review: a person to merge it, nothing asked of you. */
const READY_MARK: { glyph: string; hue: Hue } = { glyph: '●', hue: 'good' };
const READY_STATE: { text: string; hue: Hue } = { text: '● ready for review', hue: 'good' };
/** Its pull request's checks running: the Board's Checks running, nothing asked of you. */
const CHECKS_STATE: { text: string; hue: Hue } = { text: '● checks running', hue: 'warn' };
/** A step skipped by its gate: a dim dash. */
const SKIPPED_MARK: { glyph: string; hue: Hue } = { glyph: '–', hue: 'dim' };
const CRITERION: Readonly<Record<string, { glyph: string; hue: Hue }>> = {
  todo: { glyph: '○', hue: 'dim' },
  checking: { glyph: '●', hue: 'warn' },
  pass: { glyph: '✓', hue: 'good' },
  fail: { glyph: '✗', hue: 'bad' },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const goesOn = (r: RunRecordData) => r.run.outcome === null && r.run.stage !== 'done';

/**
 * Its pull request open and green, a person to merge it: Ready for review, as the Board's and
 * Chat's header say it, whatever state serve keeps the run in meanwhile.
 */
const forReview = (r: RunRecordData): boolean => {
  const pr = r.run.pr;

  return (
    goesOn(r) &&
    r.run.stage === 'pr' &&
    pr !== null &&
    pr.state === 'open' &&
    pr.merge === 'person' &&
    pr.checks !== 'failure' &&
    pr.checks !== 'pending'
  );
};

/** Its workflow's steps in order; one from an older serve names none: Feature's. */
const flowOf = (r: RunRecordData): readonly FlowStep[] => r.run.workflow?.steps ?? FEATURE_FLOW;

/** The step the run is in now: by its name, else (an older serve) the first of its kind. */
const nowStep = (r: RunRecordData): string | undefined =>
  goesOn(r) ? (r.run.step ?? flowOf(r).find((x) => x.kind === r.run.stage)?.name) : undefined;

/**
 * A stage visit's workflow step: its kind's; a plain step's by the name its visit kept (the live
 * one's is the run's), one naming none the workflow's first plain step.
 */
const flowStepOf = (r: RunRecordData, x: RunRecordStep): FlowStep | undefined => {
  if (x.kind !== 'stage') return undefined;
  const flow = flowOf(r);

  if (x.stage !== 'step') return flow.find((y) => y.kind === x.stage);
  const names = r.run.stages.filter((v) => v.stage === 'step').map((v) => v.step);
  const name = names[x.visit - 1] ?? (x.endedAt === null ? r.run.step : null);

  return flow.find((y) => y.kind === 'step' && (name === null || y.name === name));
};

// ── The run as rows ────────────────────────────────────────────────────────────────────────

/** A row of the run: a step run (a stage's visit, the person's end, the merge), or a gate's skip. */
type Entry =
  | { kind: 'step'; id: string; at: string; x: RunRecordStep; flow: FlowStep | undefined }
  | { kind: 'skipped'; id: string; at: string; flow: FlowStep; call: Judgement }
  // a step's `ends:` ended the run with its report: the run's last row
  | { kind: 'reported'; id: string; at: string; flow: undefined };

/**
 * The run in time order. A step that waits on you is its stage's live visit (the record's own
 * Needs you step folds into it); a gated step its gate skipped is a row at the gate's call.
 */
const entriesOf = (r: RunRecordData): Entry[] => {
  const waits = r.steps.some((x) => x.kind === 'stage' && x.mark === 'needs-you');
  const steps: Entry[] = r.steps
    .filter((x) => !(x.kind === 'needs-you' && waits))
    .map((x) => ({ kind: 'step', id: x.id, at: x.at, x, flow: flowStepOf(r, x) }));
  const skipped: Entry[] = r.run.judgements.flatMap((call, n) => {
    const flow = flowOf(r).find((y) => y.name === call.step);

    return judgeKindOf(call) === 'gate' && !call.answer && flow !== undefined
      ? [{ kind: 'skipped' as const, id: `skipped:${call.step}:${n}`, at: call.at, flow, call }]
      : [];
  });

  const reported: Entry[] =
    r.run.reported === null
      ? []
      : [{ kind: 'reported', id: 'reported', at: r.run.reported.at, flow: undefined }];
  // a gate's skip is called as the step after it starts: at the same time, the skip first
  const ORDER = { skipped: 0, step: 1, reported: 2 } as const;
  const first = (e: Entry) => ORDER[e.kind];

  return [...steps, ...skipped, ...reported].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || first(a) - first(b),
  );
};

/** An entry's name: its workflow step's, else the person's moment's. */
const nameOf = (e: Entry): string => {
  if (e.kind === 'reported') return 'report';
  if (e.kind === 'skipped') return e.flow.name;
  if (e.flow !== undefined) return e.flow.name;

  switch (e.x.kind) {
    case 'needs-you':
      return 'needs you';
    case 'ended':
      return 'ended';
    case 'merge':
      return 'merge';
    case 'stage':
      return e.x.stage;
  }
};

/** Its round of its workflow step: which, of how many so far. */
const roundOf = (entries: readonly Entry[], e: Entry): { n: number; of: number } => {
  const same = entries.filter(
    (y) => y.kind === 'step' && y.flow !== undefined && nameOf(y) === nameOf(e),
  );
  const at = same.findIndex((y) => y.id === e.id);

  return { n: at + 1, of: same.length };
};

/**
 * Its pull request open, its checks still running: Checks running, as the Board's and Chat's
 * header say it, whatever state serve keeps the run in meanwhile (nothing is asked of you yet).
 */
const checksRunning = (r: RunRecordData): boolean =>
  goesOn(r) &&
  r.run.stage === 'pr' &&
  r.run.pr !== null &&
  r.run.pr.state === 'open' &&
  r.run.pr.checks === 'pending';

/**
 * The waiting step while the run waits on its pull request (ready for review, its checks
 * running): its state, not Needs you.
 */
const ready = (r: RunRecordData, x: RunRecordStep): boolean =>
  x.mark === 'needs-you' && (forReview(r) || checksRunning(r));

/** A step `ready` says: the Board's word for it, its mark and its state line. */
const waitOf = (r: RunRecordData) =>
  checksRunning(r)
    ? { word: 'checks running', mark: MARK.running, state: CHECKS_STATE }
    : { word: 'ready for review', mark: READY_MARK, state: READY_STATE };

const markOf = (r: RunRecordData, e: Entry) => {
  if (e.kind === 'skipped') return SKIPPED_MARK;
  if (e.kind === 'reported') return MARK.ok;

  return ready(r, e.x) ? waitOf(r).mark : MARK[e.x.mark];
};

/** A window's last item of `list` (a review, a verification): at or after its start, by its end. */
const within = <T extends { at: string }>(list: readonly T[], x: RunRecordStep): T | undefined =>
  list.findLast(
    (y) =>
      Date.parse(y.at) >= Date.parse(x.at) &&
      (x.endedAt === null || Date.parse(y.at) <= Date.parse(x.endedAt)),
  );

const verifiedOf = (r: RunRecordData) => r.criteria.filter((c) => c.mark === 'pass').length;

/** The last visit of a stage: where the run's criteria, report and pull request are shown. */
const lastOf = (r: RunRecordData, stage: Stage): RunRecordStep | undefined =>
  r.steps.findLast((x) => x.kind === 'stage' && x.stage === stage);

/** The pr step's last visit, and the person's end or merge after it: where the result is shown. */
const showsResult = (r: RunRecordData, x: RunRecordStep): boolean =>
  (x.kind === 'stage' && x.stage === 'pr' && x.id === lastOf(r, 'pr')?.id) ||
  x.kind === 'merge' ||
  x.kind === 'ended';

/** A row's one muted word: what came of it, else its round. */
const outcomeOf = (
  r: RunRecordData,
  entries: readonly Entry[],
  e: Entry,
): { text: string; back: boolean } => {
  if (e.kind === 'skipped') return { text: 'skipped', back: false };
  if (e.kind === 'reported') return { text: 'reported', back: false };
  const x = e.x;

  if (x.mark === 'needs-you')
    return { text: ready(r, x) ? waitOf(r).word : 'needs you', back: false };
  if (x.kind === 'ended') return { text: r.run.ended?.as.replace('-', ' ') ?? '', back: false };
  if (x.kind === 'merge') return { text: r.run.pr?.merge === 'auto' ? 'by Abe' : '', back: false };
  const review = x.stage === 'review' ? within(r.run.reviews, x) : undefined;
  const before = x.stage === 'reproduce' ? within(r.run.verifications, x) : undefined;

  // a Before: what it found, never a loop back
  if (before !== undefined && x.mark !== 'running')
    return { text: BEFORE_WORD[before.result] ?? before.result, back: false };
  if (x.stage === 'step' && x.made?.kind === 'tickets')
    return { text: plural(x.made.tickets.length, 'ticket'), back: false };

  if (x.mark === 'failed')
    return {
      text:
        review !== undefined && review.findings > 0 ? plural(review.findings, 'finding') : 'failed',
      back: true,
    };
  if (x.mark === 'running') return { text: '', back: false };
  if (x.stage === 'review' && review !== undefined)
    return {
      text: review.findings === 0 ? 'no findings' : plural(review.findings, 'finding'),
      back: false,
    };
  if (
    x.stage === 'verify' &&
    x.id === lastOf(r, 'verify')?.id &&
    r.criteria.length > 0 &&
    r.run.verifications.length > 0
  )
    return { text: `${verifiedOf(r)} of ${r.criteria.length}`, back: false };
  if (x.stage === 'pr' && r.run.pr !== null)
    return { text: `#${r.run.pr.number} ${r.run.pr.state}`, back: false };
  const round = roundOf(entries, e);

  return { text: round.n > 1 ? `round ${round.n}` : '', back: false };
};

/** The steps not reached yet while the run goes: the workflow's after the one it is in. */
const todoOf = (r: RunRecordData): FlowStep[] => {
  const flow = flowOf(r);
  const at = flow.findIndex((x) => x.name === nowStep(r));

  return at === -1 ? [] : flow.slice(at + 1);
};

/** The step the keys land on first: the one waiting on you, else the live one, else the last. */
const homeOf = (entries: readonly Entry[]): string | undefined =>
  (
    entries.find((e) => e.kind === 'step' && e.x.mark === 'needs-you') ??
    entries.find((e) => e.kind === 'step' && e.x.live) ??
    entries.at(-1)
  )?.id;

const selectedOf = (s: RunState, entries: readonly Entry[]): Entry | undefined =>
  entries.find((e) => e.id === s.selected) ?? entries.find((e) => e.id === homeOf(entries));

// ── The view ───────────────────────────────────────────────────────────────────────────────

const stepsOf = (s: RunState, r: RunRecordData, entries: readonly Entry[]): RunSteps => {
  const rows: RunStepRow[] = entries.map((e) => {
    const outcome = outcomeOf(r, entries, e);

    return {
      id: e.id,
      mark: markOf(r, e),
      name: nameOf(e),
      outcome: outcome.text,
      back: outcome.back,
      dim: e.kind === 'skipped',
      todo: false,
      needsYou: e.kind === 'step' && e.x.mark === 'needs-you' && !ready(r, e.x),
    };
  });
  const todo: RunStepRow[] = todoOf(r).map((x) => ({
    id: `todo:${x.name}`,
    mark: { glyph: '', hue: 'dim' },
    name: x.name,
    outcome: '',
    back: false,
    dim: true,
    todo: true,
    needsYou: false,
  }));
  const selected = s.onCard ? undefined : selectedOf(s, entries)?.id;

  return {
    kind: 'RunSteps',
    id: 'run-steps',
    props: {
      rows: [...rows, ...todo],
      ...(selected === undefined ? {} : { selected }),
      ...(rows.length === 0 ? { empty: 'No steps yet' } : {}),
    },
  };
};

/** A step's time: to its end, waiting on you, or so far while it goes. */
const durationOf = (r: RunRecordData, x: RunRecordStep, now: string | undefined): string => {
  if (x.mark === 'needs-you' && !ready(r, x))
    return `waiting ${timeIn(r.run.needsYouSince ?? x.at, now)}`.trim();
  if (x.endedAt === null) return x.live ? `${timeIn(x.at, now)} so far`.trim() : '';
  if (x.kind !== 'stage') return '';

  return timeIn(x.at, x.endedAt);
};

/** The entry before `e` that sent the run back to it, when one did. */
const senderOf = (entries: readonly Entry[], e: Entry): Entry | undefined => {
  const before = entries.slice(
    0,
    entries.findIndex((y) => y.id === e.id),
  );
  const last = before.findLast((y) => y.kind === 'step' && y.x.kind === 'stage');

  return last?.kind === 'step' && last.x.mark === 'failed' ? last : undefined;
};

/** `sent back from checks`, `… review · round 2`. */
const backWords = (entries: readonly Entry[], from: Entry): string => {
  const round = roundOf(entries, from);

  return `sent back from ${nameOf(from)}${round.of > 1 ? ` · round ${round.n}` : ''}`;
};

/** A step's scratch files: its Evidence, then the scratch files its tools wrote, each once. */
const scratchOf = (x: RunRecordStep): string[] => [
  ...new Set([...x.evidence, ...x.files.filter((f) => inScratch(f.path)).map((f) => f.path)]),
];

/**
 * `4 files · +37 −9`: what the pull request carries, the worktree against its merge base; where
 * that was not read (a stored or merged run), each file once, its lines over every step.
 */
const changedOf = (r: RunRecordData): string => {
  const c = r.changed;

  if (c !== null)
    return c.files === 0 ? 'nothing yet' : `${plural(c.files, 'file')} · +${c.added} −${c.removed}`;
  const files = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const x of r.steps)
    for (const f of x.files.filter((y) => !inScratch(y.path))) {
      files.add(f.path);
      added += f.added;
      removed += f.removed;
    }

  return files.size === 0 ? 'nothing yet' : `${plural(files.size, 'file')} · +${added} −${removed}`;
};

/** `Workflow run`: the workflow's name and run; an older serve's, Feature's. */
const runWords = (r: RunRecordData): string =>
  `${r.run.workflow?.name ?? r.run.workflow?.id ?? 'Feature'} run`;

/** The run's result in one line, the pr step's first fact; none while it is not in sight. */
const resultOf = (r: RunRecordData): string => {
  const run = r.run;
  const n = r.criteria.length;
  const verified =
    n === 0 || run.verifications.length === 0 ? '' : `${verifiedOf(r)} of ${n} criteria verified`;
  const with_ = (head: string) => (verified === '' ? `${head}.` : `${head}: ${verified}.`);

  if (run.ended?.as === 'abandoned') return `Abandoned: ${run.ended.reason}`;
  if (run.pr?.state === 'merged')
    return with_(run.pr.deploy === 'success' ? 'Merged, on test' : 'Merged');
  if (run.reported !== null) return `${runWords(r)} ended with its report.`;
  if (!goesOn(r)) return with_('Done');
  if (forReview(r))
    return run.reason === null ? with_('Ready for review') : `Ready for review: ${run.reason}.`;
  if (checksRunning(r)) return with_('Checks running');
  if (run.pr !== null) return with_('Ready for review');

  return '';
};

/** The PR is still to review: neither merged nor closed. */
const reviewable = (r: RunRecordData) =>
  r.run.pr !== null && r.run.pr.state !== 'merged' && r.run.pr.state !== 'closed';

const commandMark = (ok: boolean | null) => {
  if (ok === null) return { glyph: '●', hue: 'warn' as const };

  return ok ? { glyph: '✓', hue: 'good' as const } : { glyph: '✗', hue: 'bad' as const };
};

/** What the pane offers on this step: the pr's Review and Open PR, the Playbook, the spec. */
const actionsOf = (r: RunRecordData, e: Entry): RunFocus['props']['actions'] => {
  if (e.kind !== 'step') return [];
  const x = e.x;
  const pr = r.run.pr;
  const answer =
    x.mark === 'needs-you' && !ready(r, x)
      ? [{ id: `run:chat:${x.id}`, label: 'Answer in Chat', primary: true }]
      : [];
  const onPr = showsResult(r, x);
  const review = onPr && pr !== null && reviewable(r);
  const prs =
    onPr && pr !== null
      ? [
          ...(review ? [{ id: 'run:review', label: 'Review changes', primary: true }] : []),
          { id: 'run:pr', label: `Open PR #${pr.number}`, primary: !review && answer.length === 0 },
        ]
      : [];
  // on its playbook step; one that ran none in sight, on the pr step
  const ranPlaybook = r.steps.some((y) => flowStepOf(r, y)?.name === 'playbook');
  const playbook =
    r.run.playbook !== null && (ranPlaybook ? e.flow?.name === 'playbook' : onPr)
      ? [
          {
            id: 'run:playbook',
            label: `Playbook · ${playbookLine(r.run.playbook)}`,
            primary: false,
          },
        ]
      : [];
  const spec =
    x.kind === 'stage' && x.stage === 'spec' && r.spec !== null
      ? [{ id: 'run:spec', label: 'Spec  ⌃S', primary: false }]
      : [];

  return [...answer, ...prs, ...playbook, ...spec];
};

/** A step's details, folded under the columns: the commands it ran, its scratch files, skills. */
const detailsOf = (s: RunState, x: RunRecordStep, skill: string): RunDetail[] => {
  const head = (kind: string, label: string, note: string) => ({
    id: `run:detail:${x.id}:${kind}`,
    label,
    note,
    open: s.details.includes(`${x.id}:${kind}`),
  });
  const failed = x.commands.filter((c) => c.ok === false).length;
  const scratch = scratchOf(x);
  const skills = x.skills.filter((k) => k !== skill);

  return [
    ...(x.commands.length === 0
      ? []
      : [
          {
            kind: 'commands' as const,
            ...head(
              'commands',
              'Commands run',
              [String(x.commands.length), ...(failed === 0 ? [] : [`${failed} failed`])].join(
                ' · ',
              ),
            ),
            rows: x.commands.map((c) => ({
              mark: commandMark(c.ok),
              command: c.command,
              result: c.result ?? '',
            })),
          },
        ]),
    ...(scratch.length === 0
      ? []
      : [
          {
            kind: 'paths' as const,
            ...head('scratch', 'Scratch files', String(scratch.length)),
            rows: scratch.map((path, n) => ({ id: `run:scratch:${x.id}:${n}`, path })),
          },
        ]),
    ...(skills.length === 0
      ? []
      : [
          {
            kind: 'skills' as const,
            ...head('skills', 'Skills it pulled in', String(skills.length)),
            names: skills,
          },
        ]),
  ];
};

/** The question a step waiting on you asks, the answers its agent offered, where to answer. */
const askOf = (r: RunRecordData, x: RunRecordStep): RunFocus['props']['ask'] =>
  x.mark !== 'needs-you' || ready(r, x)
    ? undefined
    : {
        question: r.run.reason ?? x.headline,
        options: r.run.options,
        hint: 'The run waits here until you answer in Chat.',
      };

/** A focus's props with nothing yet: the state block, the columns and details each step fills. */
const bare = (
  o: Pick<RunFocus['props'], 'step' | 'name' | 'skill' | 'meta' | 'state' | 'did'>,
  columns: Columns,
): RunFocus['props'] => ({
  ...o,
  fresh: false,
  round: '',
  back: '',
  chat: false,
  pending: false,
  actions: [],
  ...columns,
  details: [],
});

const skippedFocus = (
  s: RunState,
  r: RunRecordData,
  e: Extract<Entry, { kind: 'skipped' }>,
): RunFocus['props'] =>
  bare(
    {
      step: e.id,
      name: e.call.step,
      skill: e.flow.skill ?? '',
      meta: screenClock(e.at, s.now),
      state: { text: '– skipped', hue: 'dim' },
      did: 'Its gate said no: the run went on without it.',
    },
    skippedColumns(r, e.call, s.now),
  );

const reportedFocus = (s: RunState, r: RunRecordData, e: Entry): RunFocus['props'] => {
  const rep = r.run.reported;
  const how =
    rep?.done === false
      ? `${runWords(r)} ended: not reproduced. The card stays in its column for a person to decide; nothing was built, no branch pushed.`
      : `${runWords(r)} ended: done; the card moved to Done.`;

  return bare(
    {
      step: e.id,
      name: 'report',
      skill: 'ends',
      meta: screenClock(e.at, s.now),
      state: { text: '✓ done', hue: 'good' },
      did: `The ${rep?.step ?? 'step'} step reported${rep?.spike === null || rep?.spike === undefined ? '' : ` and its spike branch ${rep.spike.branch} was ${rep.spike.pushed ? 'pushed' : 'kept, not pushed'}`}. ${how}`,
    },
    reportedColumns(r, s.now),
  );
};

/** Its state's words: a Before's finding, ready for review, else its mark's. */
const stateOf = (r: RunRecordData, x: RunRecordStep): { text: string; hue: Hue } => {
  const before = x.stage === 'reproduce' ? within(r.run.verifications, x) : undefined;

  if (ready(r, x)) return waitOf(r).state;
  if (before?.result === 'not-reproduced' && x.mark === 'failed')
    return { text: '● not reproduced', hue: 'warn' };

  return STATE[x.mark];
};

/** What it did: `Summing up…` until its summary lands; nothing while its last words are Now. */
const didOf = (x: RunRecordStep, pending: boolean, live: boolean): string => {
  if (pending) return 'Summing up…';
  if (live) return '';

  return x.summary ?? (x.kind === 'stage' ? '' : x.headline);
};

/** On the pr step (or the merge, an end): the run's result and what it changed, first. */
const withResult = (r: RunRecordData, x: RunRecordStep, c: Columns): Columns => {
  if (!showsResult(r, x)) return c;
  const result = resultOf(r);

  return {
    ...c,
    made: {
      ...c.made,
      blocks: [
        {
          title: '',
          boxed: false,
          parts: [
            {
              kind: 'facts',
              rows: [
                ...(result === '' ? [] : [{ label: 'Result', value: result }]),
                { label: 'Changed', value: changedOf(r) },
              ],
            },
          ],
        },
        ...c.made.blocks,
      ],
    },
  };
};

/** The step after `e` in time: where a loop it fired went. */
const nextOf = (entries: readonly Entry[], e: Entry): string | undefined => {
  const at = entries.findIndex((y) => y.id === e.id);
  const next = entries.slice(at + 1).find((y) => y.kind === 'step' && y.x.kind === 'stage');

  return next === undefined ? undefined : nameOf(next);
};

const focusOf = (s: RunState, r: RunRecordData, entries: readonly Entry[], e: Entry): RunFocus => {
  if (e.kind === 'skipped')
    return { kind: 'RunFocus', id: 'run-focus', props: skippedFocus(s, r, e) };
  if (e.kind === 'reported')
    return { kind: 'RunFocus', id: 'run-focus', props: reportedFocus(s, r, e) };
  const x = e.x;
  const skill = e.flow?.skill ?? '';
  const round = roundOf(entries, e);
  const from = senderOf(entries, e);
  const fresh =
    e.flow !== undefined &&
    (e.flow.fresh === 'always' || (e.flow.fresh === 'loop' && from !== undefined));
  // a finished step's summary is written after it: until it lands, a quiet placeholder
  const pending = r.source === 'live' && x.kind === 'stage' && x.endedAt !== null && !x.summarised;
  const onVerify = x.kind === 'stage' && x.stage === 'verify' && x.id === lastOf(r, 'verify')?.id;
  const ask = askOf(r, x);
  const step: ColumnsStep = {
    r,
    x,
    flow: e.flow,
    name: nameOf(e),
    round,
    sender:
      from?.kind === 'step'
        ? { x: from.x, name: nameOf(from), round: roundOf(entries, from) }
        : undefined,
    next: nextOf(entries, e),
    now: s.now,
    open: s.open,
    tickets: s.tickets,
    paused: s.paused,
  };
  const now = ask === undefined ? nowOf(x, s.now) : undefined;
  const loop = loopOf(step);
  const carried = carriedOf(step);

  return {
    kind: 'RunFocus',
    id: 'run-focus',
    props: {
      step: x.id,
      name: nameOf(e),
      skill,
      meta: [screenClock(x.at, s.now), durationOf(r, x, s.now), x.subagent ? 'subagent' : '']
        .filter((w) => w !== '')
        .join(' · '),
      state: stateOf(r, x),
      fresh,
      round: round.of > 1 ? `round ${round.n} of ${round.of}` : '',
      back: from === undefined ? '' : backWords(entries, from),
      chat: x.chat !== null,
      ...(ask === undefined ? {} : { ask }),
      ...(now === undefined ? {} : { now }),
      ...(loop === undefined ? {} : { loop }),
      ...(carried === undefined ? {} : { carried }),
      did: didOf(x, pending, now !== undefined),
      pending,
      actions: actionsOf(r, e),
      ...withResult(r, x, columnsOf(step, { lastVerify: onVerify })),
      details: detailsOf(s, x, skill),
    },
  };
};

const noSpecWords = (r: RunRecordData): string =>
  r.run.workflow?.steps.some((x) => x.kind === 'spec') === false
    ? `${r.run.workflow.name ?? r.run.workflow.id} writes no spec`
    : 'not written yet';

const criteriaOf = (r: RunRecordData) =>
  r.criteria.map((c) => ({
    n: c.n,
    mark: CRITERION[c.mark] ?? { glyph: '○', hue: 'dim' as const },
    text: c.text,
    proof: c.how !== null,
  }));

const specOf = (r: RunRecordData): RunSpecPane => {
  const spec = r.spec;
  const issue = spec?.ref?.slice(spec.ref.lastIndexOf('#')) ?? null;

  return {
    kind: 'RunSpecPane',
    id: 'run-spec',
    props:
      spec === null
        ? {
            head: 'Spec',
            title: 'No spec',
            meta: noSpecWords(r),
            body: '',
            criteria: criteriaOf(r),
            page: false,
          }
        : {
            head: spec.url === null ? 'Spec' : `Spec ${issue ?? ''} on GitHub ↗`.replace('  ', ' '),
            title: spec.title,
            meta: [
              issue === null ? 'Spec · the run’s report' : `Spec · issue ${issue}`,
              `from AB#${r.card}`,
            ].join(' · '),
            body: withoutCriteria(spec.body),
            criteria: criteriaOf(r),
            page: spec.url !== null,
          },
  };
};

/** The spec's markdown without its criteria section: the pane draws those as a checklist. */
const withoutCriteria = (body: string): string => {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => /^#{1,6}\s+acceptance criteria\s*$/i.test(l.trim()));

  if (at === -1) return body;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l.trim()));

  return [...lines.slice(0, at), ...(end === -1 ? [] : rest.slice(end))].join('\n').trim();
};

/** `demo-shop · Bug run · Local sandbox · 19 min so far`: the run in a line, no chips. */
const contextOf = (s: RunState, r: RunRecordData | undefined): string => {
  const project = s.project ?? r?.run.repo.split('/').at(-1);

  if (r === undefined) return project ?? '';
  const live = goesOn(r);
  const took = live
    ? `${timeIn(r.run.startedAt, s.now)} so far`.trim()
    : timeIn(r.run.startedAt, r.run.stages.at(-1)?.endedAt ?? r.run.since);

  return [project, runWords(r), live ? r.where : null, took === 'so far' ? '' : took]
    .filter((p): p is string => p !== undefined && p !== null && p !== '')
    .join(' · ');
};

const barOf = (s: RunState, r: RunRecordData | undefined): RunBar => ({
  kind: 'RunBar',
  id: 'run-bar',
  props: {
    card: s.card === undefined ? '' : `#${s.card}`,
    title: r?.title ?? '',
    on: s.onCard,
    context: contextOf(s, r),
    linked: s.linked,
  },
});

const bodyOf = (s: RunState, r: RunRecordData | undefined): Node => {
  if (s.card === undefined)
    return empty('Run', 'Only in a card’s workspace: its run, step by step');
  if (r === undefined)
    return s.error === undefined
      ? empty('Reading the run…', `#${s.card}`)
      : empty(`No run to show for #${s.card}`, s.error);
  const entries = entriesOf(r);
  const shown = selectedOf(s, entries);
  const focus = shown === undefined ? empty('No steps yet', '') : focusOf(s, r, entries, shown);
  const panes = [stepsOf(s, r, entries), focus, ...(s.spec ? [specOf(r)] : [])];
  const steps = s.width < RUN_NARROW_W ? STEPS_NARROW_W : STEPS_W;
  const spec = s.spec ? SPEC_PANE_W : 0;

  // the pane's own width (the window's less Chat's): too narrow to read the step beside them,
  // the steps go over it, each pane the whole width
  if (s.width - steps - spec < FOCUS_LEAST_W)
    return stack('column', panes, {
      sizes: [{ flex: 1 }, { flex: 2 }, ...(s.spec ? [{ flex: 2 }] : [])],
      gap: 0,
      align: 'stretch',
    });

  return stack('row', panes, {
    sizes: [{ fixed: steps }, { flex: 1 }, ...(s.spec ? [{ fixed: SPEC_PANE_W }] : [])],
    gap: 0,
    // every pane the row's height: a centred column draws its header above the window
    align: 'stretch',
  });
};

const viewRun = (s: RunState): Node => {
  const r = s.record;

  return stack('column', [barOf(s, r), bodyOf(s, r)], { sizes: [{ fixed: 34 }, { flex: 1 }] });
};

// ── The steps ──────────────────────────────────────────────────────────────────────────────

/** The Playbook opened in the Editor (Markdown: beside its preview), from the shown worktree. */
const openPlaybook = (s: RunState): Out => {
  const pb = s.record?.run.playbook;
  const top = s.root ?? s.record?.run.worktree;

  return pb === undefined || pb === null || top === undefined || top === ''
    ? none(s)
    : {
        state: s,
        commands: [
          {
            kind: 'shell',
            effect: { kind: 'open-file', path: `${top.replace(/\/+$/, '')}/${pb.path}` },
          },
        ],
      };
};

const projectOf = (root: string | undefined): string | undefined => {
  if (root === undefined) return undefined;
  // a story's worktree (`demo-shop-wt/2-…`) is its project's
  const parts = root.replace(/\/+$/, '').split('/');
  const wt = parts.findIndex((p) => p.endsWith('-wt'));

  return wt === -1 ? parts.at(-1) : parts[wt]?.slice(0, -3);
};

const cardOf = (text: string | undefined): number | undefined => {
  const n = Number(text);

  return text === undefined || !Number.isInteger(n) || n <= 0 ? undefined : n;
};

/** Chat at the step's point (its transcript entry, else the session's end), shown beside the run. */
const openInChat = (s: RunState, id: string): Out => {
  const r = s.record;
  const x = r?.steps.find((st) => st.id === id);

  if (r === undefined || x === undefined) return none(s);
  return {
    state: { ...s, selected: id, onCard: false },
    commands: [
      {
        kind: 'open',
        screen: 'chat',
        slot: 'chat',
        params: {
          card: String(r.card),
          session: r.run.session,
          ...(x.chat === null ? {} : { at: x.chat }),
        },
      },
      { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
    ],
  };
};

/** Review changes: the PR checked out to review (`abe review open`), then VimStorm's review. */
const reviewChanges = (s: RunState): Out => {
  const r = s.record;
  const pr = r?.run.pr;

  if (r === undefined || pr === undefined || pr === null || !reviewable(r)) return none(s);
  const at = s.root ?? r.run.worktree;

  return {
    state: s,
    commands: [
      {
        kind: 'run',
        id: `${REVIEW_OPEN}${r.card}`,
        argv: ['review', 'open', String(pr.number), `--path=${at}`],
      },
    ],
  };
};

const openPr = (s: RunState): Out => {
  const url = s.record?.run.pr?.url;

  return url === undefined || url === ''
    ? none(s)
    : { state: s, commands: [{ kind: 'shell', effect: { kind: 'open-url', url } }] };
};

/** A scratch file in the Editor: its path under the shown worktree. */
const openScratch = (s: RunState, key: string): Out => {
  const cut = key.lastIndexOf(':');
  const x = s.record?.steps.find((st) => st.id === key.slice(0, cut));
  const path = x === undefined ? undefined : scratchOf(x)[Number(key.slice(cut + 1))];
  const top = s.root ?? s.record?.run.worktree ?? '';

  if (path === undefined || (top === '' && !path.startsWith('/'))) return none(s);

  return {
    state: s,
    commands: [
      {
        kind: 'shell',
        effect: {
          kind: 'open-file',
          path: path.startsWith('/') ? path : `${top.replace(/\/+$/, '')}/${path}`,
        },
      },
    ],
  };
};

/** The full card: the story dialog over the run. */
const openCard = (s: RunState): Out =>
  s.card === undefined
    ? none(s)
    : { state: s, commands: [{ kind: 'jump', to: 'story', story: s.card }] };

/** The keys `by` rows on; above the first, onto the bar's `#2`. */
const move = (s: RunState, by: number | 'first' | 'last'): Out => {
  const r = s.record;

  if (r === undefined) return none(s);
  const entries = entriesOf(r);
  const ids = entries.map((e) => e.id);
  const at = s.onCard ? -1 : ids.indexOf(selectedOf(s, entries)?.id ?? '');

  if (by === 'first' || by === 'last') {
    const id = by === 'first' ? ids[0] : ids.at(-1);

    return none({ ...s, selected: id, onCard: false, g: false });
  }
  const to = at + by;

  if (to < 0) return none({ ...s, onCard: s.card !== undefined || s.onCard, g: false });

  return none({
    ...s,
    selected: ids[Math.min(ids.length - 1, to)],
    onCard: false,
    g: false,
  });
};

/** `:`'s Go to Needs you: the step that waits on you, when one does. */
const toNeedsYou = (s: RunState): Out => {
  const r = s.record;
  const e =
    r === undefined
      ? undefined
      : entriesOf(r).find((y) => y.kind === 'step' && y.x.mark === 'needs-you' && !ready(r, y.x));

  return none(e === undefined ? s : { ...s, selected: e.id, onCard: false });
};

/** ⏎ on a step: its details all open, or all shut when they are. */
const toggleDetails = (s: RunState): Out => {
  const r = s.record;
  const e = r === undefined ? undefined : selectedOf(s, entriesOf(r));

  if (r === undefined || e?.kind !== 'step') return none(s);
  const keys = detailsOf(s, e.x, e.flow?.skill ?? '').map((d) => d.id.slice('run:detail:'.length));
  const shut = keys.some((k) => !s.details.includes(k));

  return none({
    ...s,
    details: shut
      ? [...s.details.filter((k) => !keys.includes(k)), ...keys]
      : s.details.filter((k) => !keys.includes(k)),
  });
};

/** A criterion's `proof ↓`: the last Verify, its evidence in its Made side. */
const toProof = (s: RunState): Out => {
  const last = s.record === undefined ? undefined : lastOf(s.record, 'verify');

  return last === undefined ? none(s) : none({ ...s, selected: last.id, onCard: false });
};

const flip = (list: readonly string[], key: string): string[] =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

const onKey = (s: RunState, key: string): Out => {
  if (s.g) {
    const t = { ...s, g: false };

    return key === 'g' ? move(t, 'first') : onKey(t, key);
  }
  if (key === 'g') return none({ ...s, g: true });

  switch (key) {
    case 'l':
    case '<Up>':
      return move(s, -1);
    case 'ö':
    case '<Down>':
      return move(s, 1);
    case 'G':
      return move(s, 'last');
    case '<CR>':
      return s.onCard ? openCard(s) : toggleDetails(s);
    case '<C-s>':
      return none({ ...s, spec: !s.spec });
    case '<Esc>':
      if (s.spec) return none({ ...s, spec: false });

      return {
        state: s,
        commands: [{ kind: 'shell', effect: { kind: 'unhandled', slot: 'main', key } }],
      };
    default:
      return none(s);
  }
};

const onClick = (s0: RunState, id: string): Out => {
  const s = { ...s0, g: false };

  if (id === 'run:card') return openCard(s);
  if (id === 'run:linked')
    return s.card === undefined
      ? none(s)
      : {
          state: { ...s, linked: true },
          commands: [{ kind: 'jump', to: 'linked', story: s.card }],
        };
  // the shell's ⌥⌘⏎ on the main area: maximized (Chat hidden), or back
  if (id === 'run:expand')
    return { state: s, commands: [{ kind: 'shell', effect: { kind: 'expand' } }] };
  if (id === 'run:spec') return none({ ...s, spec: !s.spec });
  if (id === 'run:playbook') return openPlaybook(s);
  if (id === 'run:review') return reviewChanges(s);
  if (id === 'run:pr') return openPr(s);
  if (id.startsWith('run:detail:'))
    return none({ ...s, details: flip(s.details, id.slice('run:detail:'.length)) });
  if (id.startsWith('run:scratch:')) return openScratch(s, id.slice('run:scratch:'.length));
  if (id.startsWith('run:recording:')) return playRecording(s, id);
  if (id.startsWith('run:shot:') || id.startsWith('run:url:')) return openShot(s, id);
  if (id === 'run:spec:page') {
    const url = s.record?.spec?.url;

    return url === undefined || url === null
      ? none(s)
      : { state: s, commands: [{ kind: 'shell', effect: { kind: 'open-url', url } }] };
  }
  if (id.startsWith('run:proof:')) return toProof(s);
  if (id.startsWith('run:chat:')) return openInChat(s, id.slice('run:chat:'.length));
  if (id.startsWith('run:step:'))
    return none({ ...s, selected: id.slice('run:step:'.length), onCard: false });
  if (id.startsWith('run:file:'))
    return none({ ...s, open: flip(s.open, id.slice('run:file:'.length)) });
  if (id.startsWith('run:ticket:'))
    return none({ ...s, tickets: flip(s.tickets, id.slice('run:ticket:'.length)) });

  return none(s);
};

/**
 * The kit part a click names, `<step>:<feature>:<part>` after its prefix (`run:recording:`), the
 * step's id holding a colon itself (`verify:1`), with what is left after it (a shot's `<n>`).
 */
const kitPartAt = (s: RunState, keys: string[]) => {
  const r = s.record;
  const [fi = '', pi = ''] = keys.slice(-2);
  const step = keys.slice(0, -2).join(':');
  const x = r?.steps.find((st) => st.id === step);
  // a reproduce step's kit is its Before's; any other's the last After's
  const html = x?.stage === 'reproduce' ? r?.before?.report : r?.report;
  const p = html?.features[Number(fi)]?.parts[Number(pi)];

  return r === undefined || x === undefined || p === undefined ? undefined : { r, p };
};

const openUrl = (s: RunState, url: string): Out => ({
  state: s,
  commands: [{ kind: 'shell', effect: { kind: 'open-url', url } }],
});

/** An Evidence file of the run, as a `file://` URL. */
const evidenceUrl = (r: RunRecordData, src: string) =>
  fileUrl(`${r.run.worktree.replace(/\/+$/, '')}/.scratch/${r.card}/${src}`);

/** A Verify report recording's control: a GIF's play/pause in place, else the file in the player. */
const playRecording = (s: RunState, id: string): Out => {
  const at = kitPartAt(s, id.slice('run:recording:'.length).split(':'));

  if (at?.p.kind !== 'recording') return none(s);
  if (at.p.gif !== null) return none({ ...s, paused: flip(s.paused, id) });

  return openUrl(s, evidenceUrl(at.r, at.p.src));
};

/**
 * A kit shot's click (`run:shot:<step>:<feature>:<part>:<n>`): its image full size in the local
 * viewer, a recording's its video in the local player; its page's (`run:url:…`) the page in the
 * browser.
 */
const openShot = (s: RunState, id: string): Out => {
  const page = id.startsWith('run:url:');
  const keys = id.slice(page ? 'run:url:'.length : 'run:shot:'.length).split(':');
  const n = keys.pop();
  const at = kitPartAt(s, keys);
  const p = at?.p;
  let shot: VerifyShot | undefined;

  if (p?.kind === 'pair') shot = n === '1' ? p.after : p.before;
  else if (p?.kind === 'shot') shot = p.shot;
  const where = p?.kind === 'recording' ? p : shot;

  if (at === undefined) return none(s);
  if (page) return where?.url === undefined ? none(s) : openUrl(s, where.url);
  const src = p?.kind === 'recording' ? p.src : shot?.src;

  return src === undefined ? none(s) : openUrl(s, evidenceUrl(at.r, src));
};

/** `file:///…` for an absolute path, each segment encoded. */
const fileUrl = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

/** Whether an event moves the run shown: its card's stage or board move, its session's words. */
const moves = (s: RunState, e: Event): boolean => {
  switch (e.type) {
    case 'factory.stage':
    case 'factory.card':
    case 'factory.summary':
      return e.data.card === s.card;
    case 'session.state':
      return e.data.card === s.card;
    case 'session.transcript':
      return s.record !== undefined && goesOn(s.record) && e.data.session === s.record.run.session;
    case 'watch.gap':
    case 'serve.started':
      return true;
    default:
      return false;
  }
};

/**
 * On `card` (its project from the shown folder): read anew; the same card keeps what it drew,
 * another starts afresh, its last record handed at once by the host (`keep`) while it is read.
 */
const onCard = (s: RunState, card: number | undefined, root: string | undefined): Out => {
  const project = projectOf(root) ?? s.project;
  const top = root ?? s.root;

  if (card === s.card) return read({ ...s, project, root: top });

  return read({ ...RUN_INIT, card, project, root: top, width: s.width, now: s.now });
};

/** Run's own rows in `:` (#11): handed back to it as choices of this menu. */
export const RUN_VIEW_MENU = 'run:view';

/**
 * Where Run's keys are, for `:` (#11): its card the Subject (`Ask about #1234`), its own rows
 * (Open the card, Go to Needs you, Spec, Playbook, Review changes, Open PR, Linked, Expand).
 */
const runHere = (s: RunState): Here => {
  const r = s.record;
  const waits = r?.steps.some((x) => x.mark === 'needs-you' && !ready(r, x)) === true;

  return {
    ...(s.card === undefined
      ? {}
      : {
          subject: {
            caption: `#${s.card}${r === undefined ? '' : ` ${r.title}`}`,
            label: `#${s.card}`,
            ask: ['--card', String(s.card)],
          },
        }),
    view: {
      title: 'Run',
      menu: {
        kind: 'menu',
        id: RUN_VIEW_MENU,
        title: 'Run',
        rows: [
          ...(s.card === undefined
            ? []
            : [
                {
                  id: 'card',
                  text: `Open #${s.card}`,
                  dim: 'the full card',
                  does: { kind: 'back' as const },
                },
              ]),
          ...(waits
            ? [
                {
                  id: 'needs-you',
                  text: 'Go to Needs you',
                  dim: 'the step waiting on you',
                  does: { kind: 'back' as const },
                },
              ]
            : []),
          {
            id: 'spec',
            text: s.spec ? 'Close spec' : 'Spec',
            dim: 'the spec in a reader pane',
            key: '⌃S',
            does: { kind: 'back' },
          },
          ...(r === undefined || r.run.playbook === null
            ? []
            : [
                {
                  id: 'playbook',
                  text: 'Playbook',
                  dim: 'the steps a person does by hand, in the Editor',
                  does: { kind: 'back' as const },
                },
              ]),
          ...(r === undefined || !reviewable(r)
            ? []
            : [
                {
                  id: 'review',
                  text: 'Review changes',
                  dim: 'the PR in VimStorm’s review',
                  does: { kind: 'back' as const },
                },
              ]),
          ...(r?.run.pr === null || r === undefined
            ? []
            : [
                {
                  id: 'pr',
                  text: `Open PR #${r.run.pr.number}`,
                  dim: 'in the browser',
                  does: { kind: 'back' as const },
                },
              ]),
          ...(s.card === undefined
            ? []
            : [{ id: 'linked', text: 'Linked', key: '⌃L', does: { kind: 'back' as const } }]),
          { id: 'expand', text: 'Expand', dim: 'Chat hidden', key: '⌥⌘⏎', does: { kind: 'back' } },
        ],
      },
    },
  };
};

const RUN_VIEW_DOES: Readonly<Record<string, (s: RunState) => Out>> = {
  card: openCard,
  'needs-you': toNeedsYou,
  spec: (s) => onKey(s, '<C-s>'),
  linked: (s) => onClick(s, 'run:linked'),
  playbook: openPlaybook,
  review: reviewChanges,
  pr: openPr,
  expand: (s) => onClick(s, 'run:expand'),
};

/** `review open` answered: VimStorm's review on the checkout, or why it could not. */
const reviewOpened = (s: RunState, input: Extract<Input, { kind: 'result' }>): Out => {
  if (!input.reply.ok)
    return {
      state: s,
      commands: [
        {
          kind: 'shell',
          effect: { kind: 'balloon', tone: 'error', text: input.reply.error.message },
        },
      ],
    };
  if (input.command !== 'review open') return none(s);
  const o = input.reply.data;

  return {
    state: s,
    commands: [
      {
        kind: 'shell',
        effect: {
          kind: 'review-open',
          path: o.path,
          repo: o.repo,
          number: o.number,
          unchecked: o.unchecked,
        },
      },
    ],
  };
};

export const stepRun = (s: RunState, input: Input): Out => {
  switch (input.kind) {
    case 'choice':
      return input.menu === RUN_VIEW_MENU ? (RUN_VIEW_DOES[input.row]?.(s) ?? none(s)) : none(s);
    case 'open': {
      // the card named, else the shown workspace's (its branch `card/<n>-…`)
      const card = cardOf(input.params.card) ?? cardOfBranch(input.params.branch);

      return onCard({ ...s, width: input.size.width }, card, input.params.root);
    }
    case 'root':
      // another workspace shown: its card's run
      return input.branch === undefined
        ? none(s)
        : onCard(s, cardOfBranch(input.branch), input.root);
    case 'resize':
      return none({ ...s, width: input.size.width });
    case 'tick': {
      const ticked = { ...s, now: input.at };
      const at = Date.parse(input.at);
      const words = s.entries !== undefined && at - s.entries >= ENTRIES_READ_MS;

      return words || (!s.reading && stale(s.record, at))
        ? read({ ...ticked, entries: undefined })
        : none(ticked);
    }
    case 'focus':
      // the keys back from a layer (Linked's popup closed): Linked ▾ is up no more
      return input.focused && s.linked ? none({ ...s, linked: false }) : none(s);
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return onClick(s, input.id);
    case 'result': {
      if (input.id.startsWith(REVIEW_OPEN)) return reviewOpened(s, input);
      if (input.id !== `${RUN_RECORD}${s.card ?? ''}`) return none(s);
      // the last record held of it, drawn on an empty page while it is read anew (its own
      // answer comes after); a record shown stays
      if (input.cached === true)
        return s.record === undefined && input.command === 'factory record' && input.reply.ok
          ? none({ ...s, record: input.reply.data, error: undefined })
          : none(s);
      const done = { ...s, reading: false };
      const after = (o: RunState): Out => (o.again ? read(o) : none(o));

      if (!input.reply.ok) return after({ ...done, error: input.reply.error.message });
      if (input.command !== 'factory record') return none(done);

      return after({ ...done, record: input.reply.data, error: undefined });
    }
    case 'event': {
      const e = input.event;

      if (!moves(s, e)) return none(s);
      // its session's words: read once the burst's first entry is a moment old (the clock by the
      // second ticks meanwhile); any other move reads now, that read the words' too
      if (e.type === 'session.transcript')
        return none(s.entries === undefined ? { ...s, entries: Date.parse(e.at) } : s);

      return read({ ...s, entries: undefined });
    }
    default:
      return none(s);
  }
};

/** How long a live run's transcript entries gather before its record is read again. */
const ENTRIES_READ_MS = 1000;

/** A shown record is read again this long after it was read, whatever the watch said. */
export const RUN_POLL_MS = 30_000;

/** A record with parts not in yet (`unread`: the board's card, the spec) is read again this soon. */
const UNREAD_READ_MS = 1000;

/** Whether the shown record is old enough to read again at `at` (ms): polled, its parts not in. */
const stale = (r: RunRecordData | undefined, at: number): boolean => {
  if (r === undefined) return false;
  const age = at - Date.parse(r.at);

  return age >= (r.unread.length > 0 ? UNREAD_READ_MS : RUN_POLL_MS);
};

/** The watch's events it takes: its run's and its session's moves, its transcript; any other never re-views it. */
const RUN_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'session.state',
  'factory.stage',
  'factory.card',
  'factory.summary',
  'session.transcript',
]);

export const runScreen: Screen<RunState> = {
  events: RUN_EVENTS,
  name: 'run',
  init: RUN_INIT,
  step: stepRun,
  view: viewRun,
  linked: (s) => s.card,
  // opened again: the record drawn at once, read anew
  keep: (s) => ({
    ...s,
    reading: false,
    again: false,
    linked: false,
    g: false,
    entries: undefined,
  }),
  // entries waiting for their read, or parts of the record not in yet: the clock by the second
  seconds: (s) => s.entries !== undefined || (s.record?.unread.length ?? 0) > 0,
  words: [],
  here: runHere,
};
