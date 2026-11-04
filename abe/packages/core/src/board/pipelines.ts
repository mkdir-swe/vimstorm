/**
 * Pipelines (2.2; 1.0's Pipelines tab, spec stories 78–85): one run shape over GitHub Actions and
 * Azure Pipelines, which the `Pipelines` port answers for the provider the `pipelines` setting
 * names (Azure's organization and project are the `board` setting's). A run has its pipeline,
 * branch, trigger, revision, attempt, times, status and, read in full, its stages; a stage waiting
 * for an approval carries its gate, and a gate on a prod environment is the deploy that asks an
 * explicit yes before its approval goes out. Inspected, a run is its jobs as a graph (`needs` /
 * `dependsOn` from the run's own revision), each job's steps and log, and its artifacts.
 *
 * Pure, zod only: `ui` imports it as values (`@abe/core/pipelines`), `serve` and `ports` through
 * the index.
 */
import { z } from 'zod';
import { screenClock } from '../command';

// ── the shape ────────────────────────────────────────────────────────────────────────────────

export const PIPELINE_PROVIDERS = ['github-actions', 'azure-pipelines'] as const;
export const PipelineProvider = z.enum(PIPELINE_PROVIDERS);
export type PipelineProvider = z.infer<typeof PipelineProvider>;

/** The provider as a person names it. */
export const PROVIDER_TITLE: Readonly<Record<PipelineProvider, string>> = {
  'github-actions': 'GitHub Actions',
  'azure-pipelines': 'Azure Pipelines',
};

/** How a run, a stage, a job or a step stands. `waiting`: at an approval gate. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'passed',
  'failed',
  'cancelled',
  'skipped',
] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

/** Over: it will not change by itself any more. */
export const isOver = (s: RunStatus): boolean =>
  s === 'passed' || s === 'failed' || s === 'cancelled' || s === 'skipped';

/**
 * What a stage waits on: an approval to deploy to an environment. `environment` (GitHub): the
 * run's pending deployment, `id` its environment id; `approval` (Azure): the approval's id.
 */
export const Gate = z.object({
  id: z.string(),
  kind: z.enum(['environment', 'approval']),
  /** The environment (GitHub) or the stage (Azure) it guards. */
  environment: z.string(),
  since: z.string().nullable(),
  /** Whether you may approve it, as the provider says. */
  canApprove: z.boolean(),
});
export type Gate = z.infer<typeof Gate>;

/** A stage of a run: a GitHub job, an Azure stage. */
export const RunStage = z.object({
  name: z.string(),
  status: RunStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  gate: Gate.nullable(),
});
export type RunStage = z.infer<typeof RunStage>;

/** One run of a pipeline, GitHub's or Azure's. */
export const PipelineRun = z.object({
  /** The provider's id (GitHub's run id, Azure's build id): for commands and links only. */
  id: z.string(),
  /** What the provider's page names the run by (`103`); empty where it gives none. */
  number: z.string(),
  /** The workflow or pipeline definition. */
  pipeline: z.string(),
  /** Its own name beside its number, where it has one: an RC tag. */
  name: z.string().nullable(),
  /** What it is about: the run's title, the commit's subject. */
  title: z.string(),
  branch: z.string(),
  /** What started it, in words: `push`, `pull request`, `manual`, `schedule`, else the provider's. */
  trigger: z.string(),
  actor: z.string().nullable(),
  status: RunStatus,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  url: z.string(),
  /** None until read in full (`pipeline show`). */
  stages: z.array(RunStage),
  /** The revision it ran (empty where the provider says none). */
  sha: z.string(),
  /** Goes up each time the run is run again (1 where the provider has no attempts). */
  attempt: z.number().int().nonnegative(),
  /** The pull request it ran for, where the provider names one. */
  pr: z.number().int().nullable(),
});
export type PipelineRun = z.infer<typeof PipelineRun>;

export const JobStep = z.object({
  name: z.string(),
  status: RunStatus,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JobStep = z.infer<typeof JobStep>;

/** A job of the inspected attempt: its box in the run's graph. */
export const JobBox = z.object({
  id: z.string(),
  name: z.string(),
  status: RunStatus,
  url: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** The runner's label (`ubuntu-latest`), where the provider says. */
  runner: z.string().nullable(),
  /** What it belongs to: a matrix's job key, a reusable workflow's caller, an Azure stage. */
  group: z.string().nullable(),
  steps: z.array(JobStep),
});
export type JobBox = z.infer<typeof JobBox>;

/** An artifact of the run: evidence a fix may take along. */
export const Artifact = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  expired: z.boolean(),
  sha: z.string(),
  /** The job whose log names its exact upload (else unknown: never guessed from names or times). */
  job: z.string().nullable(),
  attempt: z.number().int().nullable(),
});
export type Artifact = z.infer<typeof Artifact>;

/** A run's attempt as inspected: its jobs, the graph's edges from its own revision, its artifacts. */
export const Inspection = z.object({
  repo: z.string(),
  run: z.string(),
  attempt: z.number().int().nonnegative(),
  sha: z.string(),
  branch: z.string(),
  workflow: z.string(),
  jobs: z.array(JobBox),
  /**
   * The `needs` / `dependsOn` edges `[from, to]`; null: unknown for this revision, so the graph
   * orders the jobs by their start times and says so. Never inferred from times.
   */
  edges: z.array(z.tuple([z.string(), z.string()])).nullable(),
  /** Some links could not be read (an expression, a job the workflow does not name). */
  partial: z.boolean(),
  artifacts: z.array(Artifact),
  /** Why the artifacts are not listed, where they are not. */
  artifactsNote: z.string().nullable(),
});
export type Inspection = z.infer<typeof Inspection>;

// ── the commands' answers ────────────────────────────────────────────────────────────────────

/**
 * A workflow that deploys (the Pipelines overview's Deploys) and its newest run, however old: null
 * where it never ran.
 */
export const PipelineDeploy = z.object({
  workflow: z.string(),
  /** The environments it deploys to, in order (`dev, test, prod`); null where none is named. */
  environment: z.string().nullable(),
  run: PipelineRun.nullable(),
});
export type PipelineDeploy = z.infer<typeof PipelineDeploy>;

/** `abe pipeline list`: the repo's latest runs, newest first, and who you are there. */
export const PipelineListData = z.object({
  provider: PipelineProvider,
  /** Where the runs live: `owner/name`, or `<org>/<project>` on Azure DevOps. */
  source: z.string(),
  /** Your login on the provider (GitHub's), null where not known. */
  me: z.string().nullable(),
  runs: z.array(PipelineRun),
  /** Every workflow the repo has (GitHub's catalog), beside the ones the runs name. */
  workflows: z.array(z.string()),
  /**
   * Each workflow that deploys with its newest run, dev → test → prod (the overview's first page
   * only: none with `--workflow` or `--page`).
   */
  deploys: z.array(PipelineDeploy).default([]),
});
export type PipelineListData = z.infer<typeof PipelineListData>;

export const PipelineLogData = z.object({
  run: z.string(),
  job: z.string(),
  /** Null while the job has no log yet. */
  log: z.string().nullable(),
});
export type PipelineLogData = z.infer<typeof PipelineLogData>;

export const PIPELINE_ACTS = ['rerun', 'rerun-failed', 'cancel', 'approve'] as const;
export const PipelineActData = z.object({
  run: z.string(),
  /** As the run is named (`#103`). */
  named: z.string(),
  did: z.enum(PIPELINE_ACTS),
  attempt: z.number().int().nullable(),
  environment: z.string().nullable(),
});
export type PipelineActData = z.infer<typeof PipelineActData>;

/**
 * A workflow of the repo as its provider holds it: its name, its file (`deploy.yml`; Azure: none)
 * and the file's text on the default branch (null where not read: Azure's pipelines).
 */
export type CiWorkflowFile = { name: string; file: string; text: string | null };

/** An input a workflow takes when run by hand (`workflow_dispatch`): never a secret. */
export const WORKFLOW_INPUT_TYPES = [
  'string',
  'choice',
  'boolean',
  'number',
  'environment',
] as const;
export const WorkflowInput = z.object({
  name: z.string(),
  description: z.string(),
  type: z.enum(WORKFLOW_INPUT_TYPES),
  required: z.boolean(),
  /** Its default, as text; null where it has none. */
  default: z.string().nullable(),
  /** A choice's options (empty for the other types). */
  options: z.array(z.string()),
});
export type WorkflowInput = z.infer<typeof WorkflowInput>;

/** A workflow of the catalog: whether a person may run it by hand, and with which inputs. */
export const DispatchWorkflow = z.object({
  name: z.string(),
  /** Its file's name (`deploy.yml`): what `pipeline run` takes. */
  file: z.string(),
  /** It has `on: workflow_dispatch` at the ref read. */
  dispatch: z.boolean(),
  inputs: z.array(WorkflowInput),
});
export type DispatchWorkflow = z.infer<typeof DispatchWorkflow>;

/** `abe pipeline workflows`: the workflows and which a person may run, at a ref. */
export const PipelineWorkflowsData = z.object({
  provider: PipelineProvider,
  source: z.string(),
  /** The ref their files were read at; null: the repository's default branch. */
  ref: z.string().nullable(),
  workflows: z.array(DispatchWorkflow),
  /** Why none can be run from here (Azure Pipelines, for now). */
  note: z.string().nullable(),
});
export type PipelineWorkflowsData = z.infer<typeof PipelineWorkflowsData>;

/** `abe pipeline run`: the workflow run by hand, and its run once it was listed. */
export const PipelineRunData = z.object({
  workflow: z.string(),
  file: z.string(),
  ref: z.string(),
  inputs: z.record(z.string(), z.string()),
  /** The run it started, once the provider listed it; null when it was not listed in time. */
  run: PipelineRun.nullable(),
});
export type PipelineRunData = z.infer<typeof PipelineRunData>;

/** `abe pipeline fix`: where the fix went, a new session's launch or a live one's message. */
export const PipelineFixData = z.object({
  run: z.string(),
  named: z.string(),
  card: z.number().int().positive(),
  session: z.string(),
  branch: z.string(),
  sent: z.enum(['launched', 'sent']),
});
export type PipelineFixData = z.infer<typeof PipelineFixData>;

// ── the providers' words ─────────────────────────────────────────────────────────────────────

/** GitHub's status and conclusion of a run, a job or a step as one status. */
export const githubStatus = (status: string | null, conclusion: string | null): RunStatus => {
  switch (status) {
    case 'completed':
      switch (conclusion) {
        case 'success':
        case 'neutral':
          return 'passed';
        case 'skipped':
          return 'skipped';
        case 'cancelled':
          return 'cancelled';
        default:
          return 'failed';
      }
    case 'waiting':
      return 'waiting';
    case 'in_progress':
      return 'running';
    default:
      return 'queued';
  }
};

/** What started a GitHub run, from its event. */
export const githubTrigger = (event: string): string => {
  switch (event) {
    case 'push':
      return 'push';
    case 'pull_request':
    case 'pull_request_target':
    case 'merge_group':
      return 'pull request';
    case 'workflow_dispatch':
    case 'repository_dispatch':
      return 'manual';
    case 'schedule':
      return 'schedule';
    default:
      return event.replaceAll('_', ' ');
  }
};

/** Azure's state (or status) and result of a build, a stage, a job or a task as one status. */
export const azureStatus = (state: string, result: string): RunStatus => {
  switch (state) {
    case 'completed':
      switch (result) {
        case 'failed':
          return 'failed';
        case 'canceled':
        case 'abandoned':
          return 'cancelled';
        case 'skipped':
          return 'skipped';
        default:
          return 'passed';
      }
    case 'inProgress':
    case 'cancelling':
      return 'running';
    default:
      return 'queued';
  }
};

/** What started an Azure build, from its reason. */
export const azureTrigger = (reason: string): string => {
  switch (reason) {
    case 'manual':
      return 'manual';
    case 'individualCI':
    case 'batchedCI':
      return 'push';
    case 'pullRequest':
      return 'pull request';
    case 'schedule':
      return 'schedule';
    default:
      return reason.toLowerCase();
  }
};

/**
 * A run's title and the RC tag it is named by: `rc-12: Release` gives `Release` named `rc-12`;
 * a prod workflow's run (`Deploy Prod`) is named by the first `rc-N` its title holds.
 */
export const runNameOf = (
  workflow: string,
  displayTitle: string,
): { title: string; name: string | null } => {
  const first = displayTitle.split('\n')[0]?.trim() ?? '';
  const prefixed = /^(rc-\d+):\s*(.*)$/.exec(first);

  if (prefixed !== null) return { title: prefixed[2] ?? '', name: prefixed[1] ?? null };
  const tag = isProd(workflow) ? /\brc-\d+/.exec(first)?.[0] : undefined;

  return { title: first, name: tag ?? null };
};

// ── state words ──────────────────────────────────────────────────────────────────────────────

/** A status hue (5-states.md), the ui's `Hue` words. */
export type PipelineHue = 'good' | 'warn' | 'needs-you' | 'bad' | 'accent' | 'dim';

/** A state as drawn: its glyph, its word, its colour. */
export type StateWord = { glyph: string; word: string; hue: PipelineHue };

const STATE_WORDS: Readonly<Record<RunStatus, StateWord>> = {
  queued: { glyph: '○', word: 'Queued', hue: 'dim' },
  running: { glyph: '●', word: 'Running', hue: 'warn' },
  waiting: { glyph: '◆', word: 'Needs approval', hue: 'warn' },
  passed: { glyph: '✓', word: 'Passed', hue: 'good' },
  failed: { glyph: '✗', word: 'Failed', hue: 'bad' },
  cancelled: { glyph: '·', word: 'Cancelled', hue: 'dim' },
  skipped: { glyph: '·', word: 'Skipped', hue: 'dim' },
};

/** A run's, a job's or a step's status in words: `✗ Failed`. */
export const pipelineState = (s: RunStatus): StateWord => STATE_WORDS[s];

/** `✗ Failed`. */
export const stateWordText = (w: StateWord): string => `${w.glyph} ${w.word}`;

/** The legend's seven words, in order. */
export const LEGEND: readonly RunStatus[] = [
  'passed',
  'failed',
  'running',
  'waiting',
  'queued',
  'cancelled',
  'skipped',
];

/** The stages waiting at a gate, each with its gate. */
export const gatesOf = (r: Pick<PipelineRun, 'stages'>): { stage: RunStage; gate: Gate }[] =>
  r.stages.flatMap((stage) =>
    stage.status === 'waiting' && stage.gate !== null ? [{ stage, gate: stage.gate }] : [],
  );

/** Whether a run waits at an approval gate. */
export const waits = (r: Pick<PipelineRun, 'status' | 'stages'>): boolean =>
  r.status === 'waiting' || gatesOf(r).length > 0;

/** A run's state: waiting at a gate is Needs approval whatever its status says. */
export const runStateWord = (r: Pick<PipelineRun, 'status' | 'stages'>): StateWord =>
  waits(r) ? pipelineState('waiting') : pipelineState(r.status);

/** The run as a person names it: `#103` as the provider's page shows it, its id where it has no number. */
export const runNamed = (r: Pick<PipelineRun, 'id' | 'number'>): string =>
  r.number === '' ? r.id : `#${r.number}`;

/** `PR #61` where it ran for a pull request, else its trigger's words. */
export const triggerText = (r: Pick<PipelineRun, 'pr' | 'trigger'>): string =>
  r.pr === null ? r.trigger : `PR #${r.pr}`;

/** The first 7 of a revision. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

// ── the overview: scopes, groups, the filter ─────────────────────────────────────────────────

/** Whose runs the overview lists: this workspace's branch, the repo's, the ones you started. */
export const PIPELINE_SCOPES = ['workspace', 'all', 'mine'] as const;
export type PipelineScope = (typeof PIPELINE_SCOPES)[number];

export const SCOPE_TITLE: Readonly<Record<PipelineScope, string>> = {
  workspace: 'This workspace',
  all: 'All',
  mine: 'Mine',
};

export const SCOPE_TIP: Readonly<Record<PipelineScope, string>> = {
  workspace: "Runs on this workspace's branch",
  all: "The repository's runs",
  mine: 'Runs I started',
};

/** Whether `r` is in the scope: on `branch` (this workspace's), or started by `me`. */
export const scopeHolds = (
  scope: PipelineScope,
  r: Pick<PipelineRun, 'branch' | 'actor'>,
  branch: string | undefined,
  me: string | null | undefined,
): boolean => {
  switch (scope) {
    case 'workspace':
      return branch !== undefined && branch === r.branch;
    case 'all':
      return true;
    case 'mine':
      return me !== null && me !== undefined && r.actor === me;
  }
};

/**
 * Whether a run says `filter` in its pipeline, name, branch, title, number, id or revision, any
 * case; `#103` as the run is shown finds it by its number.
 */
export const runMatches = (r: PipelineRun, filter: string): boolean => {
  const f = filter.trim().replace(/^#/, '').toLowerCase();

  if (f === '') return true;

  return [r.pipeline, r.name ?? '', r.branch, r.title, r.number, r.id, r.sha].some((t) =>
    t.toLowerCase().includes(f),
  );
};

/** Whether a deploy says `filter` in its workflow or environment, else in its run. */
export const deployMatches = (d: PipelineDeploy, filter: string): boolean => {
  const f = filter.trim().replace(/^#/, '').toLowerCase();

  return (
    [d.workflow, d.environment ?? ''].some((t) => t.toLowerCase().includes(f)) ||
    (d.run !== null && runMatches(d.run, filter))
  );
};

/**
 * The deploys a scope shows: deploys are the repo's, so All and Mine show every one; This
 * workspace only those whose newest run is on its branch.
 */
export const scopeDeploys = (
  scope: PipelineScope,
  deploys: readonly PipelineDeploy[],
  branch: string | undefined,
): PipelineDeploy[] =>
  scope === 'workspace'
    ? deploys.filter((d) => d.run !== null && branch !== undefined && d.run.branch === branch)
    : [...deploys];

// ── deploys: dev → test → prod ───────────────────────────────────────────────────────────────

const DEV_WORDS = ['dev', 'development', 'develop'];
const TEST_WORDS = ['test', 'testing'];

/**
 * Where an environment stands on the way to prod: dev 0, test 1, another (staging, qa) 2, prod 3
 * (`also`: the `prodEnvironments` setting), none named 4.
 */
export const envRank = (env: string | null, also: readonly string[] = []): number => {
  if (env === null) return 4;
  if (isProd(env, also)) return 3;
  const words = env.toLowerCase().split(/[^\p{L}\p{N}]+/u);

  if (words.some((w) => DEV_WORDS.includes(w))) return 0;
  if (words.some((w) => TEST_WORDS.includes(w))) return 1;

  return 2;
};

/**
 * Deploys in order: dev → test → prod by the first environment each names, others between by
 * name, none named last; then by workflow.
 */
export const deployOrder =
  (also: readonly string[] = []) =>
  (
    a: Pick<PipelineDeploy, 'workflow' | 'environment'>,
    b: Pick<PipelineDeploy, 'workflow' | 'environment'>,
  ): number => {
    const first = (d: Pick<PipelineDeploy, 'environment'>) => d.environment?.split(', ')[0] ?? null;

    return (
      envRank(first(a), also) - envRank(first(b), also) ||
      (first(a) ?? '').localeCompare(first(b) ?? '') ||
      a.workflow.localeCompare(b.workflow)
    );
  };

// ── the groups ───────────────────────────────────────────────────────────────────────────────

/** The overview's groups, in order: Deploys pinned first. */
export const PIPELINE_GROUPS = [
  'deploys',
  'needs-approval',
  'running',
  'failed',
  'recent',
] as const;
export type PipelineGroup = (typeof PIPELINE_GROUPS)[number];

/** How many runs Recent lists: the last 20, not a time window. */
export const RECENT = 20;

/**
 * A group's heading: `DEPLOYS · 3`, `NEEDS APPROVAL · 1`, `RECENT · LAST 20` (`recent`: how many
 * it lists at most).
 */
export const groupHeading = (g: PipelineGroup, count: number, recent = RECENT): string => {
  switch (g) {
    case 'deploys':
      return `DEPLOYS · ${count}`;
    case 'needs-approval':
      return `NEEDS APPROVAL · ${count}`;
    case 'running':
      return `RUNNING · ${count}`;
    case 'failed':
      return `FAILED · ${count}`;
    case 'recent':
      return `RECENT · LAST ${recent}`;
  }
};

/** Newest first: by when it was made, then its id. */
export const newestFirst = (a: PipelineRun, b: PipelineRun): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** A group of the overview: its runs, and (Deploys) its deploys in order, never run ones too. */
export type RunGroup = { group: PipelineGroup; runs: PipelineRun[]; deploys: PipelineDeploy[] };

/**
 * `runs` (any order) grouped: Deploys (`deploys` as given, in their order: each deploy workflow's
 * newest run, or none), Needs approval (waiting at a gate), Running (queued or running), Failed
 * (a pipeline's newest run on its branch failed: a newer one resolves it), Recent (the rest, the
 * newest `recent`: `RECENT`, more once older pages were read); newest first inside each, empty
 * groups left out. A run Deploys shows is not shown again in another group.
 */
export const groupRuns = (
  runs: readonly PipelineRun[],
  recent = RECENT,
  deploys: readonly PipelineDeploy[] = [],
): RunGroup[] => {
  const shown = deploys.flatMap((d) => (d.run === null ? [] : [d.run]));
  const pinned = new Set(shown.map((r) => r.id));
  const sorted = [...runs].sort(newestFirst);
  const newest = new Map<string, string>();

  for (const r of [...sorted, ...shown].sort(newestFirst)) {
    const key = `${r.pipeline}\n${r.branch}`;

    if (!newest.has(key)) newest.set(key, r.id);
  }
  const out = new Map<PipelineGroup, PipelineRun[]>(PIPELINE_GROUPS.map((g) => [g, []]));

  out.set('deploys', shown);
  for (const r of sorted) {
    if (pinned.has(r.id)) continue;
    let g: PipelineGroup = 'recent';

    if (waits(r)) g = 'needs-approval';
    else if (r.status === 'queued' || r.status === 'running') g = 'running';
    else if (r.status === 'failed' && newest.get(`${r.pipeline}\n${r.branch}`) === r.id)
      g = 'failed';
    const list = out.get(g) ?? [];

    if (g !== 'recent' || list.length < recent) list.push(r);
    out.set(g, list);
  }

  return PIPELINE_GROUPS.flatMap((group): RunGroup[] => {
    const list = out.get(group) ?? [];

    if (group === 'deploys')
      return deploys.length === 0 ? [] : [{ group, runs: list, deploys: [...deploys] }];

    return list.length === 0 ? [] : [{ group, runs: list, deploys: [] }];
  });
};

// ── times ────────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `40s`, `6m 05s`, `1h 04m`. */
export const duration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));

  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;

  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

/** `5m`, `3h`, `9d` ago; `now` under a minute. */
export const pipelineAgo = (at: number, now: number): string => {
  const ms = Math.max(0, now - at);
  const round = (unit: number) => Math.floor((ms + unit / 2) / unit);

  if (ms < MINUTE) return 'now';
  if (ms < HOUR) return `${round(MINUTE)}m`;
  if (ms < DAY) return `${round(HOUR)}h`;

  return `${round(DAY)}d`;
};

const msOf = (iso: string | null | undefined): number | undefined => {
  if (iso === null || iso === undefined || iso === '') return undefined;
  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? undefined : ms;
};

/** How long from `start` to `end` (or `now` while it runs); undefined without a start. */
export const tookMs = (
  start: string | null,
  end: string | null,
  now: number | undefined,
): number | undefined => {
  const from = msOf(start);

  if (from === undefined) return undefined;
  const to = end === null ? now : msOf(end);

  return to === undefined ? undefined : Math.max(0, to - from);
};

/** How long a run ran, or has run by `now`: from its start (else when it was made). */
export const runTook = (
  r: Pick<PipelineRun, 'startedAt' | 'createdAt' | 'finishedAt' | 'status'>,
  now: number | undefined,
): number | undefined => {
  if (r.finishedAt === null && isOver(r.status)) return undefined;

  return tookMs(r.startedAt ?? r.createdAt, r.finishedAt, now);
};

/** `6m 02s`; empty when unknown. */
export const tookText = (ms: number | undefined): string => (ms === undefined ? '' : duration(ms));

/** When it started, on this Mac's clock: `08:52` today, `Tue 16:10` this week, else `9d` ago. */
export const startedText = (iso: string, now: number | undefined): string => {
  const at = msOf(iso);

  if (at === undefined) return '';
  if (now === undefined) return screenClock(at);
  const d = new Date(at);
  const n = new Date(now);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;

  if (day(d) === day(n)) return screenClock(at, now);
  if (now - at < 7 * DAY && now >= at)
    return `${WEEKDAYS[d.getDay()] ?? ''} ${screenClock(at, now)}`;

  return pipelineAgo(at, now);
};

// ── prod ─────────────────────────────────────────────────────────────────────────────────────

/** The words that name prod. */
export const PROD_WORDS = ['prod', 'production', 'prd', 'live'] as const;

/**
 * Whether an environment is prod's: one of its words is `prod`, `production`, `prd` or `live`
 * (any case), or it is one of `also` (the `prodEnvironments` setting).
 */
export const isProd = (name: string, also: readonly string[] = []): boolean =>
  name.split(/[^\p{L}\p{N}]+/u).some((w) => PROD_WORDS.some((p) => p === w.toLowerCase())) ||
  also.some((a) => a.trim().toLowerCase() === name.trim().toLowerCase());

// ── the graph ────────────────────────────────────────────────────────────────────────────────

/** A box's place: its column (dependency depth, or start wave) and its row in it. */
export type GraphPlace = { id: string; column: number; row: number };

/** Job ids in order: numbers by their value (GitHub's), the rest as text. */
export const idOrder = (a: string, b: string): number =>
  a.localeCompare(b, 'en', { numeric: true });

const byGroupThenId = (jobs: readonly JobBox[]) => {
  const group = new Map(jobs.map((j) => [j.id, j.group ?? '']));

  return (a: string, b: string) =>
    (group.get(a) ?? '').localeCompare(group.get(b) ?? '') || idOrder(a, b);
};

/** Columns of jobs started within 10 s of each other, in start order; never started last. */
const startWaves = (run: Pick<Inspection, 'jobs'>): GraphPlace[] => {
  const jobs = run.jobs
    .map((j) => ({ at: msOf(j.startedAt), id: j.id }))
    .sort((a, b) => {
      if (a.at !== undefined && b.at !== undefined) return a.at - b.at || idOrder(a.id, b.id);
      if (a.at !== undefined) return -1;
      if (b.at !== undefined) return 1;

      return idOrder(a.id, b.id);
    });
  const out: GraphPlace[] = [];
  let column = 0;
  let row = 0;
  let wave: { at: number | undefined } | undefined;

  for (const j of jobs) {
    if (wave === undefined) wave = { at: j.at };
    else {
      const w = wave.at;
      const together =
        w !== undefined && j.at !== undefined
          ? j.at - w <= 10_000
          : w === undefined && j.at === undefined;

      if (together) row += 1;
      else {
        column += 1;
        row = 0;
        wave = { at: j.at };
      }
    }
    out.push({ id: j.id, column, row });
  }

  return out;
};

/**
 * Stable graph places: dependency depth, then group and id within a column. Without dependency
 * data: waves of jobs that started together, in start order, so the graph is never empty. A
 * cycle (never from a provider) puts every box in the first column.
 */
export const graphPlaces = (run: Pick<Inspection, 'jobs' | 'edges'>): GraphPlace[] => {
  if (run.edges === null) return startWaves(run);
  const ids = run.jobs.map((j) => j.id).sort(byGroupThenId(run.jobs));
  const depth = new Map(ids.map((id) => [id, 0]));

  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false;

    for (const [a, b] of run.edges) {
      const da = depth.get(a);
      const db = depth.get(b);

      if (da !== undefined && db !== undefined && db <= da) {
        depth.set(b, da + 1);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass + 1 === ids.length) for (const id of ids) depth.set(id, 0);
  }
  const out: GraphPlace[] = [];

  for (const id of ids) {
    const column = depth.get(id) ?? 0;

    out.push({ id, column, row: out.filter((p) => p.column === column).length });
  }

  return out;
};

export type GraphMove = 'left' | 'right' | 'up' | 'down';

/** The box `move` goes to from `id`: the nearest that way; itself where none is. */
export const graphNeighbor = (
  run: Pick<Inspection, 'jobs' | 'edges'>,
  id: string,
  move: GraphMove,
): string => {
  const places = graphPlaces(run);
  const from = places.find((p) => p.id === id);

  if (from === undefined) return id;
  const ahead = places.filter((p) => {
    if (p.id === id) return false;
    switch (move) {
      case 'right':
        return p.column > from.column;
      case 'left':
        return p.column < from.column;
      case 'up':
        return p.column === from.column && p.row < from.row;
      case 'down':
        return p.column === from.column && p.row > from.row;
    }
  });
  const dist = (p: GraphPlace) =>
    Math.abs(p.column - from.column) * 10_000 + Math.abs(p.row - from.row);
  const best = ahead.sort((a, b) => dist(a) - dist(b))[0];

  return best?.id ?? id;
};

/** The job shown: the one asked for while the run has it, else the first failed, else the first. */
export const shownJob = (
  run: Pick<Inspection, 'jobs'>,
  asked: string | undefined,
): string | undefined =>
  (asked !== undefined && run.jobs.some((j) => j.id === asked) ? asked : undefined) ??
  run.jobs.find((j) => j.status === 'failed')?.id ??
  run.jobs[0]?.id;

/** The step a job failed in, else the one running. */
export const stepAt = (j: Pick<JobBox, 'steps'>): JobStep | undefined =>
  j.steps.find((s) => s.status === 'failed') ?? j.steps.find((s) => s.status === 'running');

/** The failed jobs a fix covers: `job` alone when it failed, else every failed one. */
export const fixJobs = (run: Pick<Inspection, 'jobs'>, job?: string): JobBox[] => {
  const failed = run.jobs.filter((j) => j.status === 'failed');
  const one = failed.filter((j) => j.id === job);

  return job !== undefined && one.length > 0 ? one : failed;
};

/** The graph's note: dependency data missing, or some of it. */
export const graphNote = (run: Pick<Inspection, 'jobs' | 'edges' | 'partial'>): string | null => {
  if (run.edges === null)
    return 'Order from start times · dependency data unavailable for this revision';
  if (run.partial) return 'Some dependency links cannot be drawn for this revision';
  const places = new Map(graphPlaces(run).map((p) => [p.id, p.column]));
  const backward = run.edges.some(([a, b]) => {
    const ca = places.get(a);
    const cb = places.get(b);

    return ca === undefined || cb === undefined || ca >= cb;
  });

  return backward ? 'Some dependency links cannot be drawn for this revision' : null;
};

// ── the log ──────────────────────────────────────────────────────────────────────────────────

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z? /;

/** A log line's time of day (`11:00:01`) and its text: GitHub's and Azure's timestamp split off. */
export const splitTime = (line: string): { time: string | null; text: string } => {
  const m = STAMP.exec(line);

  return m === null
    ? { time: null, text: line }
    : { time: line.slice(11, 19), text: line.slice(m[0].length) };
};

/** A log line without its timestamp. */
export const stripTime = (line: string): string => splitTime(line).text;

const isTestFail = (t: string) => t.startsWith('✗') || t.startsWith('×') || t.startsWith('FAIL ');

/** A failed job's first error line (1-based) and its words: `##[error]…`, a failed test, an `AssertionError`. */
export const firstError = (log: string): { line: number; text: string } | undefined => {
  const lines = log.split('\n');

  for (const [i, raw] of lines.entries()) {
    const t = stripTime(raw).trim();

    if (isTestFail(t) || t.includes('AssertionError') || t.includes('##[error]'))
      return {
        line: i + 1,
        text: t
          .replace('##[error]', '')
          .replace(/^[✗× ]+/u, '')
          .trim(),
      };
  }

  return undefined;
};

/** The source files a test failure may name (`node_modules` never counts). */
const SOURCE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'vue',
  'svelte',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'cs',
  'rb',
  'php',
  'swift',
  'scala',
  'css',
  'scss',
]);

/** The file and line a token names (`src/a.ts:14:5`, `(src/a.ts:3:1)`), and whether it named a line. */
const fileToken = (raw: string): { path: string; line: number; named: boolean } | undefined => {
  const token = raw.replace(/^[()[\]'"`<>,]+|[()[\]'"`<>,]+$/g, '').replace(/^file:\/\//, '');
  const [path = '', lineText] = token.split(':');
  const line = lineText !== undefined && /^\d+$/.test(lineText) ? Number(lineText) : undefined;
  const dot = path.lastIndexOf('.');

  if (dot < 0) return undefined;
  const ext = path.slice(dot + 1);

  if (!SOURCE_EXT.has(ext) || path.includes('node_modules') || path.includes('://'))
    return undefined;
  let rel: string;
  const work = path.indexOf('/work/');

  // GitHub's runner: /home/runner/work/<repo>/<repo>/<path>
  if (path.startsWith('/') && work >= 0) {
    const parts = path.slice(work + '/work/'.length).split('/');

    if (parts.length < 3) return undefined;
    rel = parts.slice(2).join('/');
  } else if (path.startsWith('/')) return undefined;
  else rel = path.replace(/^\.\//, '');

  return rel === ''
    ? undefined
    : { path: rel, line: Math.max(1, line ?? 1), named: line !== undefined };
};

/**
 * The source file and line a test failure points at, from its line and the few after it (a file
 * with a line wins over a bare file).
 */
export const failureFile = (
  lines: readonly string[],
): { path: string; line: number } | undefined => {
  let bare: { path: string; line: number } | undefined;

  for (const line of lines.slice(0, 8))
    for (const token of stripTime(line).split(/\s+/)) {
      const f = fileToken(token);

      if (f === undefined) continue;
      if (f.named) return { path: f.path, line: f.line };
      bare ??= { path: f.path, line: f.line };
    }

  return bare;
};

/** A row of a job's evidence: an error line of its log, or an artifact. */
export type EvidenceRow = {
  title: string;
  detail: string;
  /** The log line it points at (1-based). */
  line?: number | undefined;
  /** The artifact it is. */
  artifact?: string | undefined;
  /** Why it cannot go with a fix (expired, another revision). */
  unavailable?: string | undefined;
  /** The source file and line a test failure names (its Open file). */
  file?: { path: string; line: number } | undefined;
};

/** Whether an artifact can go with a fix: not expired, of this run's revision. */
export const artifactUsable = (a: Artifact, run: Pick<Inspection, 'sha'>): string | undefined => {
  if (a.expired) return 'expired';
  if (a.sha !== run.sha) return 'of another revision';

  return undefined;
};

/** The attempt's artifacts as evidence rows: `job`'s first, then the run-level ones. */
export const artifactRows = (
  run: Inspection,
  named: string,
  job: string | undefined,
): EvidenceRow[] =>
  run.artifacts
    .filter((a) => a.job === null || a.job === job)
    .sort((a, b) => Number(a.job === null) - Number(b.job === null))
    .map((a): EvidenceRow => {
      const why = artifactUsable(a, run);

      return {
        title: a.name,
        detail:
          a.job !== null && a.attempt !== null
            ? `run ${named} · job ${a.job} · attempt ${a.attempt} · ${shortSha(a.sha)}`
            : `run ${named} · attempt ${run.attempt} · ${shortSha(a.sha)} · job unknown`,
        artifact: a.id,
        ...(why === undefined ? {} : { unavailable: why }),
      };
    });

/** A line of a job log as shown. */
export type LogLine = {
  n: number;
  time: string;
  text: string;
  error: boolean;
  /** An evidence line (tinted). */
  evidence: boolean;
};

/** How many lines the log view holds from where it is. */
export const LOG_SHOWN = 400;

/**
 * A job's log as read: its evidence rows (each error and failed test with the file it names, then
 * `artifacts`), the lines shown from `scroll` (none: opened 8 lines above the first error) and
 * the range they cover (`lines 1–8 of 8`).
 */
export const logView = (
  raw: string,
  scroll: number | undefined,
  artifacts: readonly EvidenceRow[] = [],
): { evidence: EvidenceRow[]; lines: LogLine[]; range: string; total: number } => {
  const lines = raw.split('\n');
  const evidence: EvidenceRow[] = [];
  const marked = new Set<number>();

  for (const [i, l] of lines.entries()) {
    const text = stripTime(l).trim();
    const error = text.includes('##[error]');
    const test = isTestFail(text);

    if (!(error || test)) continue;
    marked.add(i + 1);
    const title = text
      .replace('##[error]', '')
      .replace(/^[✗×]+/u, '')
      .trim();
    let detail = `log line ${i + 1} · ##[error]`;

    if (test) {
      const next = lines
        .slice(i + 1)
        .map((x) => stripTime(x).trim())
        .find((x) => x !== '');

      if (next !== undefined) marked.add(i + 2);
      detail = `log line ${i + 1} · ${next ?? ''}`;
    }
    // the file it names: in the line or the few under it, up to the next failure
    let until = lines.length;

    for (let k = i + 1; k < lines.length; k += 1) {
      const t = stripTime(lines[k] ?? '').trim();

      if (t.includes('##[error]') || t.startsWith('✗') || t.startsWith('×')) {
        until = k;
        break;
      }
    }
    const file = failureFile(lines.slice(i, Math.min(until, i + 8)));

    evidence.push({ title, detail, line: i + 1, ...(file === undefined ? {} : { file }) });
  }
  evidence.push(...artifacts);
  const first = Math.min(...marked, Infinity);
  const opened = Number.isFinite(first) ? Math.max(1, first - 9) - 1 : 0;
  const start = Math.max(0, Math.min(scroll ?? opened, lines.length - 1));
  const shown = lines.slice(start, start + LOG_SHOWN).map((l, k): LogLine => {
    const { time, text } = splitTime(l);
    const n = start + k + 1;

    return {
      n,
      time: time ?? '',
      text,
      error:
        text.includes('##[error]') ||
        text.trimStart().startsWith('✗') ||
        text.includes('AssertionError'),
      evidence: marked.has(n),
    };
  });
  const a = shown[0];
  const b = shown.at(-1);
  const range =
    a === undefined || b === undefined
      ? `${lines.length} lines`
      : `lines ${a.n}–${b.n} of ${lines.length}`;

  return { evidence, lines: shown, range, total: lines.length };
};

/**
 * The summary's Evidence (PipelineRuns: the first failure and its file): the failing test's own
 * name and the file it names (`rounds to two decimals · cart.test.ts:14`), else the first failure
 * with its log line.
 */
export const failureEvidence = (log: string): string | undefined => {
  const first = firstError(log);

  if (first === undefined) return undefined;
  const lines = log.split('\n');
  const file = failureFile(lines.slice(first.line - 1, first.line + 7));

  if (file === undefined) return `${first.text} · log line ${first.line}`;
  const name = first.text.split(' > ').at(-1) ?? first.text;

  return `${name} · ${file.path.split('/').at(-1) ?? file.path}:${file.line}`;
};

// ── Fix with agent ───────────────────────────────────────────────────────────────────────────

/** The card a branch is the session branch of (`card/12-…`), if any. */
export const cardOfRunBranch = (branch: string): number | undefined => {
  const m = /^card\/(\d+)(?:-|$)/.exec(branch);

  return m?.[1] === undefined ? undefined : Number(m[1]);
};

/**
 * The branch a fix is made on: the run's own when it is the card's session branch (its pull
 * request gets the fix), else `fix/<card>-run-<number>` from the failed revision (a default-branch
 * failure, or one on a branch no card owns, gets a fix branch of its own).
 */
export const fixBranch = (
  card: number,
  r: Pick<PipelineRun, 'branch' | 'number' | 'id'>,
): { branch: string; from: 'branch' | 'revision' } =>
  cardOfRunBranch(r.branch) === card
    ? { branch: r.branch, from: 'branch' }
    : {
        branch: `fix/${card}-run-${(r.number === '' ? r.id : r.number).replace(/[^\w.-]+/g, '-')}`,
        from: 'revision',
      };

/** The message a fix goes with: what failed, where, what to do. */
export const fixMessage = (
  r: PipelineRun,
  run: Inspection,
  jobs: readonly JobBox[],
  evidence: string | undefined,
): string =>
  [
    `${r.pipeline} run ${runNamed(r)} (attempt ${run.attempt}) failed in ${
      jobs.length === 0 ? 'its jobs' : jobs.map((j) => j.name).join(', ')
    } on ${run.branch} at ${shortSha(run.sha)}.`,
    ...(evidence === undefined ? [] : [evidence]),
    'Find the cause, fix it, and run the failing checks before you push.',
  ].join('\n');

/**
 * What a fix session is told: the message, then the facts it needs (repository and base, run,
 * attempt, revision, the jobs and their logs, the evidence chosen, the artifacts that may go).
 */
export const fixPrompt = (
  r: PipelineRun,
  run: Inspection,
  o: {
    jobs: readonly JobBox[];
    evidence?: string | undefined;
    artifacts?: readonly string[] | undefined;
    base: string;
    branch: string;
    message?: string | undefined;
  },
): string => {
  const message = o.message?.trim() ?? '';
  const lines = [
    message === '' ? fixMessage(r, run, o.jobs, o.evidence) : message,
    '',
    `Fix with agent: ${r.pipeline} failed.`,
    `Repository: ${run.repo} · base ${o.base}`,
    `Run: ${r.number === '' ? run.run : `#${r.number} (id ${run.run})`} · attempt ${run.attempt} · revision ${run.sha}`,
    `Source branch: ${run.branch}`,
    `Fix branch: ${o.branch}`,
    ...o.jobs.map((j) => `Job ${j.id}: ${j.name} · log ${j.url}`),
    ...(o.evidence === undefined ? [] : [`Evidence: ${o.evidence}`]),
    ...run.artifacts
      .filter((a) => (o.artifacts ?? []).includes(a.id) && artifactUsable(a, run) === undefined)
      .map(
        (a) =>
          `Artifact ${a.id}: ${a.name} · ${a.url} · revision ${a.sha} · ${
            a.job !== null && a.attempt !== null
              ? `job ${a.job}, attempt ${a.attempt}`
              : 'run-level; job and attempt unknown'
          }`,
      ),
    '`abe pipeline log <run> --job <id>` reads a job log again; `abe pipeline inspect <run>` the run.',
  ];

  return lines.join('\n');
};

// ── the CLI's words ──────────────────────────────────────────────────────────────────────────

/** One run as a line: `✗ Failed  PR checks  #103 Fix cart rounding  fix/x · PR #61  08:00  7m 00s`. */
export const runLine = (r: PipelineRun, now: number | undefined): string =>
  [
    stateWordText(runStateWord(r)),
    r.pipeline,
    `${runNamed(r)} ${r.title === '' ? (r.name ?? r.branch) : r.title}`,
    `${r.branch} · ${triggerText(r)}`,
    startedText(r.startedAt ?? r.createdAt, now),
    tookText(runTook(r, now)),
  ]
    .filter((x) => x !== '')
    .join('  ');

/** A deploy as a line: `Deploy Prod → prod  ✓ Passed  …`, or `… never run`. */
const deployLine = (d: PipelineDeploy, now: number | undefined): string =>
  `${d.workflow}${d.environment === null ? '' : ` → ${d.environment}`}  ${
    d.run === null ? 'never run' : runLine(d.run, now)
  }`;

export const pipelineListText = (d: PipelineListData, at?: { now: number }): string => {
  const runs =
    d.runs.length === 0
      ? [`No runs on ${d.source} (${PROVIDER_TITLE[d.provider]})`]
      : [...d.runs].sort(newestFirst).map((r) => runLine(r, at?.now));

  return d.deploys.length === 0
    ? runs.join('\n')
    : ['Deploys', ...d.deploys.map((x) => `  ${deployLine(x, at?.now)}`), '', ...runs].join('\n');
};

export const pipelineShowText = (r: PipelineRun, at?: { now: number }): string =>
  [
    `${r.pipeline} · run ${runNamed(r)} · attempt ${r.attempt} · ${stateWordText(runStateWord(r))}`,
    r.title,
    [r.branch, ...(r.pr === null ? [] : [`PR #${r.pr}`]), shortSha(r.sha), r.url]
      .filter((x) => x !== '')
      .join(' · '),
    ...r.stages.map(
      (s) =>
        `  ${pipelineState(s.status).glyph} ${s.name}${
          s.gate === null
            ? ''
            : ` · waits for ${s.gate.environment}${s.gate.canApprove ? '' : ' (not yours to approve)'}`
        }${(() => {
          const took = tookText(tookMs(s.startedAt, s.finishedAt, at?.now));

          return took === '' ? '' : ` · ${took}`;
        })()}`,
    ),
  ].join('\n');

export const pipelineInspectText = (i: Inspection, at?: { now: number }): string => {
  const places = new Map(graphPlaces(i).map((p) => [p.id, p]));
  const note = graphNote(i);

  return [
    `run ${i.run} · attempt ${i.attempt} · ${i.branch} · ${shortSha(i.sha)} · ${i.workflow}`,
    ...i.jobs.map((j) => {
      const p = places.get(j.id);
      const took = tookText(tookMs(j.startedAt, j.finishedAt, at?.now));

      return `  ${pipelineState(j.status).glyph} ${j.name} · job ${j.id}${took === '' ? '' : ` · ${took}`}${
        p === undefined ? '' : ` · column ${p.column + 1}`
      }`;
    }),
    ...(note === null ? [] : [note]),
    ...i.artifacts.map(
      (a) =>
        `  artifact ${a.id} ${a.name}${a.expired ? ' · expired' : ''}${a.job === null ? '' : ` · job ${a.job}`}`,
    ),
    ...(i.artifactsNote === null ? [] : [i.artifactsNote]),
  ].join('\n');
};

export const pipelineLogText = (d: PipelineLogData): string =>
  d.log ?? `Job ${d.job} of run ${d.run} has no log yet`;

/** The status line once an act went through. */
export const pipelineActText = (d: PipelineActData): string => {
  switch (d.did) {
    case 'rerun':
      return `Run ${d.named}: rerun`;
    case 'rerun-failed':
      return `Run ${d.named}: failed jobs rerun`;
    case 'cancel':
      return `Run ${d.named}: cancelled`;
    case 'approve':
      return `Run ${d.named}: ${d.environment ?? 'deployment'} approved`;
  }
};

/** An input's words: `environment (choice: dev, test · default dev)`, `version (string, required)`. */
export const workflowInputText = (i: WorkflowInput): string => {
  const kind = i.type === 'choice' ? `choice: ${i.options.join(', ')}` : i.type;
  const parts = [kind, ...(i.required ? ['required'] : [])].join(', ');
  const def = i.default === null ? '' : ` · default ${i.default}`;

  return `${i.name} (${parts}${def})`;
};

/** A workflow as a line: `Deploy · deploy.yml · runs by hand: environment (choice: dev, test)`. */
const dispatchWorkflowLine = (w: DispatchWorkflow): string => {
  if (!w.dispatch) return `${w.name} · ${w.file} · not run by hand`;
  if (w.inputs.length === 0) return `${w.name} · ${w.file} · runs by hand, no inputs`;

  return `${w.name} · ${w.file} · runs by hand: ${w.inputs.map(workflowInputText).join(', ')}`;
};

export const pipelineWorkflowsText = (d: PipelineWorkflowsData): string => {
  if (d.note !== null) return d.note;
  if (d.workflows.length === 0) return `No workflows on ${d.source}`;

  return d.workflows.map(dispatchWorkflowLine).join('\n');
};

export const pipelineRunText = (d: PipelineRunData): string =>
  d.run === null
    ? `Started ${d.workflow} on ${d.ref} · its run is not listed yet`
    : `Started ${d.workflow} on ${d.ref} · run ${runNamed(d.run)}`;

export const pipelineFixText = (d: PipelineFixData): string =>
  d.sent === 'launched'
    ? `Fixing run ${d.named}: session ${d.session} on ${d.branch} (#${d.card})`
    : `Fix of run ${d.named} sent to #${d.card}'s session ${d.session}`;
