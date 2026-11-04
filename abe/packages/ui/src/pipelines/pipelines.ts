/**
 * The Pipelines tab (2.2, ⌘7; 1.0 tickets 16–19, artboards L-01 … L-21): the bottom pane's
 * `pipelines` screen over `abe pipeline …` (GitHub Actions, or Azure Pipelines as the `pipelines`
 * setting says). Its home is the overview: the runs in scope (This workspace · All · Mine, Tab /
 * ⇧Tab; All until another is picked, on any branch) grouped Deploys · Needs approval · Running ·
 * Failed · Recent, the agent on each run's branch (the session there), the selected run's summary
 * and its actions beside them. Deploys is pinned first: each workflow that deploys (dev → test →
 * prod) with its newest run however old, or Never run; a run it shows is not shown again in another
 * group. Deploys are the repo's: All and Mine show every one, This workspace those whose run is on
 * its branch. `w` (or the Workflow chip) narrows it to one workflow's history, newest first: serve
 * is asked again for that workflow's runs (`pipeline list --workflow`), not the newest runs overall
 * filtered down, the overview's runs of it shown meanwhile under `Reading runs…`. `m` (or the Older
 * runs… row) reads the next page of what is shown, older; the bar counts the pages. ⏎ inspects the
 * run's graph (its jobs as dependency-connected boxes from the run's own revision), ⏎ again the
 * job's log with its evidence; Esc steps back log → graph → overview, keeping filter and selection.
 *
 * ⌘⏎ is the run's Action menu (Command mode's): Inspect · Fix with agent… (Approve… on a run at a
 * gate) · Rerun failed · Rerun · Cancel run… · Open in browser · Run workflow…. A rerun acts at
 * once on the attempt inspected; Cancel run… asks; Approve… asks with who acts, a prod
 * environment's in red with No the default. Fix with agent… says what goes where and asks, then
 * `abe pipeline fix`: the card's live session gets it as a message, else a new Claude Code session
 * on the card's branch or a fix branch. Run workflow… picks a workflow that runs by hand
 * (`pipeline workflows` at the shown branch; the selected run's first), asks the branch (the shown
 * one preset) and each of its inputs (a choice as a pick, a boolean as yes/no, the rest as a field
 * on its default; each with its description), then `pipeline run`; the run it started is selected
 * once listed, the Workflow filter kept. GitHub Actions only for now, said so on Azure.
 * Inspecting never writes or launches.
 *
 * Reads: `pipeline list` on open and every 15 s while shown (the shown workflow's, its first
 * page), the selected run's `pipeline show` and `pipeline inspect` (again while it runs), its
 * failed job's log (the summary's Evidence) and the shown job's in the log view; a write's
 * `command.ran` reads the runs again. The agents on the branches (the sessions) and their runs are
 * the live facts it follows, handed as they move; `r` reads them again too. The tree's root id says where
 * Esc goes: `pipelines` (home: the pane's), `pipelines-history` and `pipelines-run` (the screen's,
 * a step back).
 */
import type {
  DispatchWorkflow,
  Event,
  FactoryRunData,
  Inspection,
  JobBox,
  PipelineDeploy,
  PipelineListData,
  PipelineRun,
  PipelineScope,
  PipelineWorkflowsData,
  RunGroup,
  SessionData,
  StateWord,
  WorkflowInput,
} from '@abe/core';
import {
  artifactRows,
  cardOfRunBranch,
  deployMatches,
  failureEvidence,
  fixBranch,
  fixJobs,
  gatesOf,
  graphNeighbor,
  graphNote,
  graphPlaces,
  groupHeading,
  groupRuns,
  isOver,
  isProd,
  LEGEND,
  logView,
  newestFirst,
  pipelineState,
  PIPELINE_SCOPES,
  PROVIDER_TITLE,
  RECENT,
  runMatches,
  runNamed,
  runStateWord,
  runTook,
  SCOPE_TIP,
  SCOPE_TITLE,
  scopeDeploys,
  scopeHolds,
  shortSha,
  shownJob,
  startedText,
  stepAt,
  tookMs,
  tookText,
  triggerText,
  waits,
  type EvidenceRow,
  type GraphMove,
} from '@abe/core/pipelines';
import {
  type ColumnWidth,
  type Hue,
  type Node,
  type Table,
  type TableCell,
  island,
  stack,
} from '../runtime/components';
import { lookOf, sessionLook, shownState } from '../board/flow';
import {
  type JobLog,
  type JobPanel,
  type PipelineAction,
  type PipelinesBar,
  type RunGraph,
  type RunHead,
  type RunSummary,
  type StateMark,
} from './pipeline-components';
import { type ShellEffect, type ViewSize } from '../runtime/protocol';
import {
  type Command,
  type Input,
  type Menu,
  type MenuAsk,
  type MenuRow,
  type Screen,
} from '../runtime/runtime';
import { type Facts, type LiveRead } from '../live';
import { pipelinesDot } from '../shell/stripe';
import {
  filterNote,
  fits,
  listClick,
  listKey,
  listScroll,
  type ListOf,
  type ListPlace,
  listText,
  released,
  reopened,
  selectOn,
  settle as settleList,
  windowed,
} from '../runtime/table-list';
import { shortTitle } from '../board/workspaces';
import { screenClock } from '@abe/core/when';

export type PipelinesLevel = 'list' | 'graph' | 'log';

export type PipelinesState = ListPlace & {
  opened: boolean;
  size?: ViewSize | undefined;
  /** The clock (`tick`): durations and the 15 s reads go by it. */
  now?: string | undefined;
  /** The shown folder (where the commands run), and its branch (This workspace's runs). */
  root?: string | undefined;
  branch?: string | undefined;
  /** All until the person picks another (Tab, a click): kept then, whatever the branch. */
  scope: PipelineScope;
  /** One workflow's history (the Workflow chip set): its runs read with `--workflow`. */
  workflow?: string | undefined;
  /** The overview's pages of runs read (`list.runs` holds them all), and whether an older may follow. */
  pages: number;
  more: boolean;
  /**
   * The shown workflow's runs as serve answered them, their pages and whether an older may
   * follow; none, or another workflow's: being read, the overview's runs of it shown meanwhile.
   */
  history?: { workflow: string; runs: PipelineRun[]; pages: number; more: boolean } | undefined;
  /** The workflows run by hand, as last read (`pipeline workflows`); `failed`: why not read. */
  dispatchable?: PipelineWorkflowsData | { failed: string } | undefined;
  /** Run workflow… was chosen while the workflows are read: the pick opens once they come. */
  dispatchAsked?: boolean | undefined;
  level: PipelinesLevel;
  /** The job asked for in the graph and the log (none: the first failed, else the first). */
  job?: string | undefined;
  /** The log's first line shown (0-based); none: opened at its first error. */
  scroll?: number | undefined;
  /** The evidence row the log view's keys are on. */
  evidenceAt: number;
  list?: PipelineListData | undefined;
  /** Why the runs were not read (`pipeline list` refused). */
  failed?: string | undefined;
  /** Each run read in full (`pipeline show`), by id. */
  full: Readonly<Record<string, PipelineRun>>;
  /** Each run's latest attempt inspected, by id; why one was not. */
  inspected: Readonly<Record<string, Inspection>>;
  unread: Readonly<Record<string, string>>;
  /** Each job's log by `<run>:<job>` (null: none yet). */
  logs: Readonly<Record<string, string | null>>;
  /** When the runs were last read (the clock's time then): the table's note says it. */
  readDone?: string | undefined;
  /** The reads out now, by their run id, and when each read was last asked (ms). */
  asking: readonly string[];
  askedAt: Readonly<Record<string, number>>;
  /**
   * The reads' generation: a read's id ends `#<gen>`, and another project (or a reopen) starts a
   * new one, so a read still out for the one before is dropped when it answers.
   */
  gen: number;
  /** The live sessions: the agent on each run's branch. */
  sessions?: readonly SessionData[] | undefined;
  /** The live runs: the run an agent is of, which says its state (Ready for review). */
  runs?: readonly FactoryRunData[] | undefined;
  /** `prodEnvironments` in force (besides prod's own words). */
  prod: readonly string[];
  /**
   * The run the open params named (Linked's Pipelines row): selected once the runs come, read by
   * its id (`pipeline show`) when the latest runs read hold none of it.
   */
  want?: { run?: string | undefined; branch?: string | undefined } | undefined;
  /** The run Linked named, read by its id though older than the latest runs: listed with them. */
  named?: string | undefined;
};

type Out = { state: PipelinesState; commands: Command[] };

const INIT: PipelinesState = {
  opened: false,
  top: 0,
  g: false,
  scope: 'all',
  pages: 1,
  more: false,
  level: 'list',
  evidenceAt: 0,
  full: {},
  inspected: {},
  unread: {},
  logs: {},
  asking: [],
  askedAt: {},
  gen: 0,
  prod: [],
};

/** How often what is shown is read again while it can change. */
export const REREAD_MS = 15_000;
/** How many runs the list reads. */
export const LIMIT = 30;

const RUN = 'run:';
/** A deploy's row while it never ran: `deploy:<workflow>`. */
const NEVER = 'deploy:';
const LIST = 'pipelines';
/** A later page's or a workflow's list read: `pipelines:list:<page>:<workflow>`. */
const LIST_PAGE = 'pipelines:list:';
/** The `pipeline workflows` read (Run workflow…). */
const DISPATCHABLE = 'pipelines:dispatchable';
/** The Run workflow… pick (Command mode's menu). */
const DISPATCH = 'pipelines:dispatch';
/** The Older runs… row at the table's end, and the key line's `m`. */
const PAGE_OLDER = 'page:older';
const PROD = 'pipelines:prod';
const SHOW = 'pipelines:show:';
const INSPECT = 'pipelines:inspect:';
const LOG = 'pipelines:log:';

/** The bar over the table and the run head: px (L-01's scope row, L-05's head). */
const BAR_H = 30;
/** Under this width the summary leaves the overview to the runs (#207). */
const SUMMARY_FROM = 900;
const SUMMARY_W = 380;
/** The graph's job panel and the log view's left side. */
const PANEL_W = 380;

const none = (s: PipelinesState): Out => ({ state: s, commands: [] });

const nowOf = (s: PipelinesState): number | undefined =>
  s.now === undefined ? undefined : Date.parse(s.now);

// ── what is listed ──────────────────────────────────────────────────────────────────────────

/**
 * The runs serve listed for what is shown: the overview's, or the shown workflow's as read with
 * `--workflow`; while those are being read, the overview's runs of that workflow.
 */
const loadedRuns = (s: PipelinesState): PipelineRun[] => {
  if (s.workflow === undefined) return s.list?.runs ?? [];
  if (s.history?.workflow === s.workflow) return s.history.runs;

  return (s.list?.runs ?? []).filter((r) => r.pipeline === s.workflow);
};

/** The pages read of what is shown, and whether an older one may follow. */
const shownPages = (s: PipelinesState): { pages: number; more: boolean } => {
  if (s.workflow === undefined) return { pages: s.pages, more: s.more };

  return s.history?.workflow === s.workflow
    ? { pages: s.history.pages, more: s.history.more }
    : { pages: 0, more: false };
};

/** How many runs Recent lists: `RECENT` a page read. */
const recentOf = (s: PipelinesState): number => RECENT * Math.max(1, shownPages(s).pages);

/** The shown workflow's runs are being read (none of serve's for it yet), or the first read is. */
const readingShown = (s: PipelinesState): boolean =>
  s.list === undefined || (s.workflow !== undefined && s.history?.workflow !== s.workflow);

/** Every run read, newest first, each in full where it was read so; Linked's by its id too. */
const allRuns = (s: PipelinesState): PipelineRun[] => {
  const listed = loadedRuns(s);
  const byId = [...new Set([s.named, s.want?.run])].flatMap((id) => {
    const r = id === undefined ? undefined : s.full[id];

    return r === undefined || listed.some((x) => x.id === r.id) ? [] : [r];
  });

  return [...listed.map((r) => s.full[r.id] ?? r), ...byId].sort(newestFirst);
};

/** The runs in `scope` (and the workflow), before the filter. */
const scoped = (s: PipelinesState, scope: PipelineScope): PipelineRun[] =>
  allRuns(s)
    .filter((r) => scopeHolds(scope, r, s.branch, s.list?.me))
    .filter((r) => s.workflow === undefined || r.pipeline === s.workflow);

/** A row of the list: a run, or a deploy that never ran. */
type Row = PipelineRun | PipelineDeploy;

const isRun = (r: Row): r is PipelineRun => 'pipeline' in r;

const keyOf = (r: Row): string => (isRun(r) ? `${RUN}${r.id}` : `${NEVER}${r.workflow}`);

/** The deploys the overview shows in `scope` (none in a workflow's history), runs read in full. */
const shownDeploys = (s: PipelinesState, scope: PipelineScope): PipelineDeploy[] =>
  s.workflow !== undefined
    ? []
    : scopeDeploys(scope, s.list?.deploys ?? [], s.branch).map((d) =>
        d.run === null ? d : { ...d, run: s.full[d.run.id] ?? d.run },
      );

/** The overview's groups: Deploys pinned first, then the runs in scope. */
const groupsOf = (s: PipelinesState) =>
  groupRuns(scoped(s, s.scope), recentOf(s), shownDeploys(s, s.scope));

/** A group's rows: Deploys' each deploy's run, or the deploy where it never ran. */
const rowsIn = (g: RunGroup): Row[] =>
  g.group === 'deploys' ? g.deploys.map((d) => d.run ?? d) : g.runs;

/** The rows in the list's order: the overview's groups, or one workflow's history newest first. */
const rowsInOrder = (s: PipelinesState): Row[] =>
  s.workflow === undefined ? groupsOf(s).flatMap(rowsIn) : scoped(s, s.scope);

/** The runs in the list's order. */
const ordered = (s: PipelinesState): PipelineRun[] => rowsInOrder(s).filter(isRun);

const rowsOf = (s: PipelinesState): ListOf<Row> => {
  const deploys = shownDeploys(s, s.scope);

  return {
    all: rowsInOrder(s),
    keyOf,
    // a deploy's run (or one never run) by its workflow and environment too
    matches: (r, f) => {
      const d = isRun(r) ? deploys.find((x) => x.run?.id === r.id) : r;

      return d === undefined ? isRun(r) && runMatches(r, f) : deployMatches(d, f);
    },
    room: roomOf(s),
  };
};

/**
 * How many runs fit: the table's rows under the bar, less the Older runs… row while an older
 * page may follow, less the group headings drawn among the runs in view from `top` (each
 * group's heading over its first run in view).
 */
const roomOf = (s: PipelinesState): number => {
  const size = s.size === undefined ? undefined : { ...s.size, height: s.size.height - BAR_H };
  const fit = Math.max(1, fits(size) - (shownPages(s).more ? 1 : 0));

  if (s.workflow !== undefined) return fit;
  const groups = groupsOf(s);
  const groupOf = new Map(
    groups.flatMap((g) => rowsIn(g).map((r) => [keyOf(r), g.group] as const)),
  );
  const rows = groups.flatMap(rowsIn);

  for (let room = fit; room > 1; room -= 1) {
    const heads = new Set(rows.slice(s.top, s.top + room).map((r) => groupOf.get(keyOf(r)))).size;

    if (room + heads <= fit) return room;
  }

  return 1;
};

/** The selected run: the list's selection while it shows, else the first. */
const selectedRun = (s: PipelinesState): PipelineRun | undefined => {
  const picked = windowed(s, rowsOf(s)).selected;

  // a deploy that never ran: no run to sum up or act on
  if (picked !== undefined) return isRun(picked) ? picked : undefined;
  // a run the list does not show now (Linked's, a scope's other): as read, if read
  const id = s.selected?.startsWith(RUN) === true ? s.selected.slice(RUN.length) : undefined;

  return id === undefined ? undefined : allRuns(s).find((r) => r.id === id);
};

/** The selection settled; the run the open params named once its row comes. */
const settle = (s0: PipelinesState): PipelinesState => {
  const want = s0.want;
  let s = s0;

  if (want !== undefined && s0.list !== undefined) {
    const runs = allRuns(s0);
    const run =
      want.run === undefined
        ? runs.find((r) => r.branch === want.branch)
        : runs.find((r) => r.id === want.run);

    if (run !== undefined) {
      // a run the scope does not hold is shown in All
      const shown = scopeHolds(s0.scope, run, s0.branch, s0.list.me);
      const listed = s0.list.runs.some((r) => r.id === run.id);
      const next: PipelinesState = {
        ...selectOn(s0, `${RUN}${run.id}`),
        ...(shown ? {} : { scope: 'all' as const }),
        ...(listed ? {} : { named: run.id }),
      };

      delete next.want;
      // the shown workflow's own run (one run by hand) keeps it shown
      if (run.pipeline !== s0.workflow) delete next.workflow;
      s = next;
    } else if (want.run === undefined) {
      // a branch's newest, not among the latest runs read: the overview as it is, the ask let go
      const next = { ...s0 };

      delete next.want;
      s = next;
    }
    // a run named by its id, not among them: kept asked until `pipeline show` answers (`readNamed`)
  }

  return settleList(s, rowsOf(s));
};

const moved = (s: PipelinesState): Out => none(settle(s));

// ── reads ───────────────────────────────────────────────────────────────────────────────────

const run = (id: string, argv: string[], keep = false): Command => ({
  kind: 'run',
  id,
  argv,
  ...(keep ? { keep: true as const } : {}),
});

/**
 * Read `id` (one of the read ids) unless it is out already; noted as asked at `now`. The first
 * page of runs is kept by the host: another project and back draws its last runs at once.
 */
const ask = (s: PipelinesState, id: string, argv: string[]): Out =>
  s.asking.includes(id)
    ? none(s)
    : {
        state: {
          ...s,
          asking: [...s.asking, id],
          askedAt: { ...s.askedAt, [id]: nowOf(s) ?? 0 },
        },
        commands: [run(`${id}#${s.gen}`, argv, id === LIST)],
      };

const chain = (s: PipelinesState, ...steps: ((s: PipelinesState) => Out)[]): Out =>
  steps.reduce<Out>(
    (out, step) => {
      const next = step(out.state);

      return { state: next.state, commands: [...out.commands, ...next.commands] };
    },
    { state: s, commands: [] },
  );

/** A list read's id: the overview's first page is `pipelines`; else the page and the workflow. */
const listId = (workflow: string | undefined, page: number): string =>
  workflow === undefined && page === 1 ? LIST : `${LIST_PAGE}${page}:${workflow ?? ''}`;

const isListId = (id: string): boolean => id === LIST || id.startsWith(LIST_PAGE);

/** What a list read's id asked for. */
const listQuery = (id: string): { workflow: string | undefined; page: number } => {
  if (!id.startsWith(LIST_PAGE)) return { workflow: undefined, page: 1 };
  const rest = id.slice(LIST_PAGE.length);
  const at = rest.indexOf(':');
  const workflow = rest.slice(at + 1);

  return { workflow: workflow === '' ? undefined : workflow, page: Number(rest.slice(0, at)) };
};

const listArgv = (workflow: string | undefined, page: number): string[] => [
  'pipeline',
  'list',
  '--limit',
  String(LIMIT),
  ...(workflow === undefined ? [] : ['--workflow', workflow]),
  ...(page > 1 ? ['--page', String(page)] : []),
];

/** The first page of what is shown: the overview's runs, or the shown workflow's. */
const readList = (s: PipelinesState) => ask(s, listId(s.workflow, 1), listArgv(s.workflow, 1));

/** The next older page of what is shown, while one may follow. */
const readMore = (s: PipelinesState): Out => {
  const { pages, more } = shownPages(s);

  return more ? ask(s, listId(s.workflow, pages + 1), listArgv(s.workflow, pages + 1)) : none(s);
};

/** The workflows run by hand at the shown branch (none: the repository's default branch). */
const readDispatchable = (s: PipelinesState) =>
  ask(s, DISPATCHABLE, [
    'pipeline',
    'workflows',
    ...(s.branch === undefined ? [] : ['--ref', s.branch]),
  ]);
const readProd = (s: PipelinesState) => ask(s, PROD, ['settings', 'get', 'prodEnvironments']);

/** Whether `id` was read less than `REREAD_MS` ago (or is out). */
const fresh = (s: PipelinesState, id: string): boolean => {
  const at = s.askedAt[id];
  const now = nowOf(s);

  return s.asking.includes(id) || (at !== undefined && now !== undefined && now - at < REREAD_MS);
};

/** A job's log key. */
const logKey = (runId: string, job: string) => `${runId}:${job}`;

/** The job the graph and the log show. */
const jobShown = (s: PipelinesState, i: Inspection | undefined): JobBox | undefined => {
  if (i === undefined) return undefined;
  const id = shownJob(i, s.job);

  return i.jobs.find((j) => j.id === id);
};

/** Linked's run by its id (`pipeline show`) once the latest runs read hold none of it. */
const readNamed = (s: PipelinesState): Out => {
  const id = s.want?.run;

  if (id === undefined || s.list === undefined || allRuns(s).some((r) => r.id === id))
    return none(s);

  return fresh(s, `${SHOW}${id}`) ? none(s) : ask(s, `${SHOW}${id}`, ['pipeline', 'show', id]);
};

/**
 * What the selected run needs read: in full, inspected, its failed job's log (the summary's
 * Evidence) or the shown job's (the log view); each again while it can change, never while out.
 */
const readSelected = (s0: PipelinesState): Out => {
  const named = readNamed(s0);
  const s = named.state;
  const r = selectedRun(s);

  if (r === undefined || named.commands.length > 0) return named;
  const over = isOver(r.status) && !waits(r);
  const showId = `${SHOW}${r.id}`;
  const inspectId = `${INSPECT}${r.id}`;
  const steps: ((s: PipelinesState) => Out)[] = [];

  // a failed read too waits `REREAD_MS` before it is asked again
  if ((s.full[r.id] === undefined || !over) && !fresh(s, showId))
    steps.push((x) => ask(x, showId, ['pipeline', 'show', r.id]));
  if ((s.inspected[r.id] === undefined || !over) && !fresh(s, inspectId))
    steps.push((x) => ask(x, inspectId, ['pipeline', 'inspect', r.id]));
  const i = s.inspected[r.id];
  const job = s.level === 'log' ? jobShown(s, i) : i?.jobs.find((j) => j.status === 'failed');

  if (job !== undefined) {
    const key = logKey(r.id, job.id);
    const id = `${LOG}${key}`;

    if ((!Object.hasOwn(s.logs, key) || !isOver(job.status)) && !fresh(s, id))
      steps.push((x) => ask(x, id, ['pipeline', 'log', r.id, '--job', job.id]));
  }

  return chain(s, ...steps);
};

/** Everything of its own read anew (open, `r`, a write's `command.ran`, `serve.started`). */
const readAll = (s: PipelinesState): Out => {
  const again = { ...s, askedAt: {} };

  return chain(again, readList, readSelected);
};

/** The live facts it follows: the agents on the runs' branches, and their runs. */
const FOLLOWS: readonly LiveRead[] = ['sessions', 'runs'];

/** `r`: its own reads anew, and the live facts it follows read again. */
const readAgain = (s: PipelinesState): Out => {
  const own = readAll(s);

  return { state: own.state, commands: [...own.commands, { kind: 'live', reads: FOLLOWS }] };
};

/** The live facts handed: the sessions and runs the agents' words go by. */
const onFacts = (s: PipelinesState, f: Facts): Out =>
  f.sessions === s.sessions && f.runs === s.runs
    ? none(s)
    : moved({ ...s, sessions: f.sessions, runs: f.runs });

const done = (s: PipelinesState, id: string): PipelinesState => ({
  ...s,
  asking: s.asking.filter((x) => x !== id),
});

const onResult = (s0: PipelinesState, tagged: Extract<Input, { kind: 'result' }>): Out => {
  if (tagged.id.startsWith('pipelines:act:')) return onActed(s0, tagged);
  const at = tagged.id.lastIndexOf('#');

  // a read for the project shown before, or before a reopen: not this one's
  if (at < 0 || tagged.id.slice(at + 1) !== String(s0.gen)) return none(s0);
  const input = { ...tagged, id: tagged.id.slice(0, at) };

  // the runs last read, drawn on an empty list while they are read anew: still asked, their
  // answer comes after; a list shown stays
  if (tagged.cached === true && s0.list !== undefined) return none(s0);
  const s = tagged.cached === true ? s0 : done(s0, input.id);
  const why = input.reply.ok ? undefined : input.reply.error.message;

  if (isListId(input.id)) {
    if (why !== undefined) return moved({ ...s, failed: why });
    if (input.command !== 'pipeline list' || !input.reply.ok) return none(s);
    const next = withPage(s, listQuery(input.id), input.reply.data);
    const read = chain(settle(next), readSelected);

    if (input.id !== LIST) return read;
    // the stripe's Pipelines dot (#20): to approve, failed on your branches
    const badge: Command = {
      kind: 'shell',
      effect: pipelinesDot(input.reply.data.runs, input.reply.data.me),
    };

    return { state: read.state, commands: [...read.commands, badge] };
  }
  if (input.id === DISPATCHABLE) {
    if (why !== undefined) {
      const next = { ...s, dispatchable: { failed: why } };

      delete next.dispatchAsked;

      return {
        state: next,
        commands: s.dispatchAsked
          ? [shell({ kind: 'balloon', tone: 'error', text: `Workflows not read: ${why}` })]
          : [],
      };
    }
    if (input.command !== 'pipeline workflows' || !input.reply.ok) return none(s);
    const next = { ...s, dispatchable: input.reply.data };

    delete next.dispatchAsked;

    return { state: next, commands: s.dispatchAsked ? [dispatchMenu(next)] : [] };
  }
  if (input.id === PROD) {
    if (input.command !== 'settings get' || !input.reply.ok) return none(s);
    const v = input.reply.data.value;

    return moved({
      ...s,
      prod: Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [],
    });
  }
  if (input.id.startsWith(SHOW)) {
    const id = input.id.slice(SHOW.length);

    if (why !== undefined && s.want?.run === id) {
      // Linked's run the provider does not give: the overview as it is, and why
      const next = { ...s };

      delete next.want;

      return {
        state: settle(next),
        commands: [shell({ kind: 'balloon', tone: 'error', text: `Run ${id} not read: ${why}` })],
      };
    }

    // Linked's run once read by its id is selected: what it needs read follows
    return input.command === 'pipeline show' && input.reply.ok
      ? chain(
          settle({ ...s, full: { ...s.full, [input.reply.data.id]: input.reply.data } }),
          readSelected,
        )
      : none(s);
  }
  if (input.id.startsWith(INSPECT)) {
    const id = input.id.slice(INSPECT.length);

    if (why !== undefined) return moved({ ...s, unread: { ...s.unread, [id]: why } });
    if (input.command !== 'pipeline inspect' || !input.reply.ok) return none(s);
    const unread = Object.fromEntries(Object.entries(s.unread).filter(([k]) => k !== id));

    return chain(
      settle({ ...s, inspected: { ...s.inspected, [id]: input.reply.data }, unread }),
      readSelected,
    );
  }
  if (input.id.startsWith(LOG)) {
    const key = input.id.slice(LOG.length);

    if (why !== undefined) return moved({ ...s, logs: { ...s.logs, [key]: null } });
    if (input.command !== 'pipeline log' || !input.reply.ok) return none(s);

    return moved({ ...s, logs: { ...s.logs, [key]: input.reply.data.log } });
  }

  return none(s);
};

/** Runs by their id, the first of each kept. */
const uniqueRuns = (runs: readonly PipelineRun[]): PipelineRun[] => {
  const seen = new Set<string>();
  const out: PipelineRun[] = [];

  for (const r of runs)
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }

  return out;
};

/** Runs read page by page: all of them, the pages read, whether an older may follow. */
type Paged = { runs: PipelineRun[]; pages: number; more: boolean };

/**
 * A page read joins the pages `had`: the first page takes the place of what was read before,
 * keeping the older pages read; a later page comes after them; `more` while the page was full.
 */
const paged = (had: Paged | undefined, page: number, runs: PipelineRun[]): Paged => {
  const full = runs.length >= LIMIT;

  if (page === 1)
    return had === undefined || had.pages === 1
      ? { runs, pages: 1, more: full }
      : { runs: uniqueRuns([...runs, ...had.runs]), pages: had.pages, more: had.more };

  return {
    runs: uniqueRuns([...(had?.runs ?? []), ...runs]),
    pages: Math.max(had?.pages ?? 1, page),
    more: full,
  };
};

/**
 * A page of runs read for `q`: the overview's pages are the state's, a workflow's its history's;
 * the catalog and your login come with either.
 */
const withPage = (
  s: PipelinesState,
  q: { workflow: string | undefined; page: number },
  data: PipelineListData,
): PipelinesState => {
  const readDone = s.now === undefined ? {} : { readDone: s.now };
  let next: PipelinesState;

  if (q.workflow === undefined) {
    const had =
      s.list === undefined ? undefined : { runs: s.list.runs, pages: s.pages, more: s.more };
    const p = paged(had, q.page, data.runs);

    // the deploys come with the first page; an older page keeps them
    const deploys = q.page === 1 ? data.deploys : (s.list?.deploys ?? []);

    next = {
      ...s,
      list: { ...data, runs: p.runs, deploys },
      pages: p.pages,
      more: p.more,
      ...readDone,
    };
  } else {
    const had = s.history?.workflow === q.workflow ? s.history : undefined;

    next = {
      ...s,
      history: { workflow: q.workflow, ...paged(had, q.page, data.runs) },
      // the overview keeps its runs; the catalog and your login are the latest read
      list:
        s.list === undefined
          ? { ...data, runs: [] }
          : { ...s.list, workflows: data.workflows, me: data.me },
      ...readDone,
    };
  }
  delete next.failed;

  return next;
};

/** A write run from here (the head's and the summary's buttons): its words, the runs again. */
const onActed = (s0: PipelinesState, input: Extract<Input, { kind: 'result' }>): Out => {
  if (!input.reply.ok)
    return {
      state: s0,
      commands: [shell({ kind: 'balloon', tone: 'error', text: input.reply.error.message })],
    };
  const said = input.text?.split('\n').find((l) => l.trim() !== '');
  // a workflow run by hand: its run selected once the list holds it
  const started =
    input.command === 'pipeline run' && input.reply.data.run !== null
      ? input.reply.data.run
      : undefined;
  const s: PipelinesState =
    started === undefined
      ? s0
      : { ...s0, want: { run: started.id }, full: { ...s0.full, [started.id]: started } };
  const again = readAll(s);

  return {
    state: again.state,
    commands: [
      ...again.commands,
      ...(said === undefined ? [] : [shell({ kind: 'status', text: said })]),
    ],
  };
};

/** A write's answer (Command mode ran it): what it touched read again. */
const WRITES = new Set(['rerun', 'cancel', 'approve', 'fix', 'run']);

const onEvent = (s: PipelinesState, event: Event): Out => {
  if (!s.opened) return none(s);
  switch (event.type) {
    case 'serve.started':
    case 'watch.gap':
      return readAll(s);
    case 'command.ran':
      return event.data.noun === 'pipeline' &&
        event.data.verb !== null &&
        WRITES.has(event.data.verb) &&
        event.data.exit === 0
        ? readAll(s)
        : none(s);
    case 'settings.changed':
      return readProd(s);
    default:
      return none(s);
  }
};

// ── words for a run ─────────────────────────────────────────────────────────────────────────

const shell = (effect: ShellEffect): Command => ({ kind: 'shell', effect });

const markOf = (w: StateWord): StateMark => ({ glyph: w.glyph, word: w.word, hue: w.hue });

const AGENT_HUE: Readonly<Record<ReturnType<typeof shownState>, Hue>> = {
  starting: 'dim',
  running: 'warn',
  'needs-you': 'needs-you',
  idle: 'dim',
  ready: 'good',
  failed: 'bad',
  ended: 'dim',
  merged: 'good',
  'on-test': 'good',
};

/** The live card session on a branch, if one is (the run's agent). */
const sessionOn = (s: PipelinesState, branch: string): SessionData | undefined =>
  (s.sessions ?? []).find((x) => x.branch === branch && x.state !== 'ended' && x.kind === 'card');

/** A workspace's name as its tab says it: `#12 cart total`, else the branch. */
const workspaceName = (branch: string, session: SessionData | undefined): string => {
  const card = session?.card ?? cardOfRunBranch(branch);

  if (card === undefined) return branch;

  return session === undefined || session.title === ''
    ? `#${card}`
    : `#${card} ${shortTitle(session.title)}`;
};

type Agent = { word: string; hue: Hue; workspace: string; env: string };

const agentOf = (s: PipelinesState, branch: string): Agent | undefined => {
  const x = sessionOn(s, branch);

  if (x === undefined) return undefined;
  // a Factory run's agent as its run stands: Ready for review, not its session's Needs you
  const run = s.runs?.find((r) => r.session === x.id);
  const look = run === undefined ? sessionLook(x, s.now) : lookOf(run, x, s.now);

  return {
    word: look.word,
    hue: AGENT_HUE[shownState(look)],
    workspace: workspaceName(branch, x),
    env: x.box === undefined ? 'Local sandbox' : 'Cloud',
  };
};

const titleOf = (r: PipelineRun): string =>
  r.title.trim() === '' ? (r.name ?? r.branch) : r.title;

/** The selected run's inline actions (L-01 §5): Approve…, Fix with agent…, Cancel run…, Rerun. */
const inlineOf = (s: PipelinesState, r: PipelineRun): PipelineAction[] => {
  if (waits(r)) return [{ id: 'act:approve', label: 'Approve…', primary: true }];
  if (r.status === 'failed')
    return [
      { id: 'act:fix', label: 'Fix with agent…', primary: true },
      ...(agentOf(s, r.branch) === undefined
        ? [{ id: 'act:rerun-failed', label: 'Rerun failed' }]
        : []),
    ];
  if (r.status === 'queued' || r.status === 'running')
    return [{ id: 'act:cancel', label: 'Cancel run…' }];

  return [{ id: 'act:rerun', label: 'Rerun' }];
};

// ── the overview ────────────────────────────────────────────────────────────────────────────

/** A column of the runs; a share's `least`: narrower, the column goes ([`fitColumns`]). */
type RunColumn = { label: string; width: ColumnWidth; align?: 'end'; least?: number };

const COLUMNS: readonly RunColumn[] = [
  { label: 'State', width: { fixed: 128 } },
  { label: 'Workflow', width: { fixed: 112 } },
  { label: 'Run', width: { flex: 3 }, least: 160 },
  { label: 'Branch · trigger', width: { flex: 2 }, least: 120 },
  { label: 'Agent', width: { fixed: 200 } },
  { label: 'Started', width: { fixed: 72 }, align: 'end' },
  { label: 'Duration', width: { fixed: 72 }, align: 'end' },
];

/** The columns that go when the runs are too narrow for all, the least read first. */
const DROPPED_FIRST = ['Agent', 'Duration', 'Branch · trigger', 'Workflow'];

/** The Table's row sides and the gap between its cells (`factory/table.rs`), its island's edges. */
const TABLE_SIDES = 2 * 16 + 16;
const CELL_GAP = 12;

const widthNeeded = (cs: readonly RunColumn[]): number =>
  cs.reduce((n, c) => n + ('fixed' in c.width ? c.width.fixed : (c.least ?? 0)), 0) +
  CELL_GAP * (cs.length - 1);

/**
 * The columns the runs' `width` holds whole (their indexes, in order): the least read go first,
 * never the state, the run or when it started (Chat docked beside the list and the summary).
 */
const fitColumns = (width: number | undefined): number[] => {
  const kept = COLUMNS.map((_, i) => i);

  if (width === undefined) return kept;
  for (const label of DROPPED_FIRST) {
    if (widthNeeded(kept.flatMap((i) => COLUMNS[i] ?? [])) <= width - TABLE_SIDES) break;
    kept.splice(kept.indexOf(COLUMNS.findIndex((c) => c.label === label)), 1);
  }

  return kept;
};

const DASH: TableCell = { text: '—', hue: 'dim' };

/** Where a deploy goes, in words: `deploys dev, test`. */
const deploysTo = (d: PipelineDeploy): string =>
  d.environment === null ? 'deploys' : `deploys ${d.environment}`;

/** A run's cells; a deploy's run (Deploys) says its revision and who ran it beside its branch. */
const cellsOf = (s: PipelinesState, r: PipelineRun, deploy?: PipelineDeploy): TableCell[] => {
  const w = runStateWord(r);
  const agent = agentOf(s, r.branch);
  const now = nowOf(s);
  const took = tookText(runTook(r, now));
  const started = startedText(r.startedAt ?? r.createdAt, now);
  const where =
    deploy === undefined
      ? `${r.branch} · ${triggerText(r)}`
      : [r.branch, ...(r.sha === '' ? [] : [shortSha(r.sha)]), r.actor ?? triggerText(r)].join(
          ' · ',
        );

  return [
    { mark: w.glyph, text: w.word, hue: w.hue },
    {
      text: r.pipeline,
      hue: 'dim',
      tooltip: deploy === undefined ? r.pipeline : `${r.pipeline} · ${deploysTo(deploy)}`,
    },
    { accent: runNamed(r), text: titleOf(r), tooltip: `${r.pipeline} · ${titleOf(r)}` },
    { text: where, hue: 'dim', tooltip: r.branch },
    agent === undefined
      ? DASH
      : {
          mark: '●',
          text: `${agent.word} · ${agent.workspace}`,
          hue: agent.hue,
          tooltip: `${agent.word} · ${agent.workspace} · ${agent.env}`,
        },
    started === '' ? DASH : { text: started, hue: 'dim' },
    took === '' ? DASH : { text: took, hue: 'dim' },
  ];
};

/** A deploy's cells while it never ran. */
const neverCells = (d: PipelineDeploy): TableCell[] => [
  { mark: '·', text: 'Never run', hue: 'dim' },
  { text: d.workflow, hue: 'dim', tooltip: `${d.workflow} · ${deploysTo(d)}` },
  { text: deploysTo(d), hue: 'dim' },
  DASH,
  DASH,
  DASH,
  DASH,
];

/** The key line: `m older` while an older page may follow. */
const footOf = (s: PipelinesState) => [
  { keys: '⏎', label: 'inspect' },
  { keys: '⌘⏎', label: 'actions' },
  { keys: 'Tab', label: 'scope' },
  { keys: 'w', label: 'workflow' },
  ...(shownPages(s).more ? [{ keys: 'm', label: 'older' }] : []),
  { keys: 'r', label: 'read again' },
];

/** `14 runs`, `abe/x · 2 runs · All shows 7`, `PR checks · 5 runs`; `· pages 1–2` once more were read. */
const countOf = (s: PipelinesState): string => {
  const n = ordered(s).length;
  const words = (k: number) => `${k} run${k === 1 ? '' : 's'}`;
  const { pages } = shownPages(s);
  const paged = pages > 1 ? ` · pages 1–${pages}` : '';

  if (s.workflow !== undefined) return `${s.workflow} · ${words(n)}${paged}`;
  if (s.scope !== 'workspace') return `${words(n)}${paged}`;
  const all = scoped(s, 'all').length;

  return `${s.branch ?? 'detached'} · ${words(n)}${all === n ? '' : ` · All shows ${all}`}${paged}`;
};

const emptyOf = (s: PipelinesState): { title: string; line: string } => {
  if (s.list === undefined && s.failed !== undefined)
    return { title: 'Runs not read', line: s.failed };
  if (s.list === undefined)
    return { title: 'Reading runs…', line: 'The repository’s pipelines, a moment' };
  // the workflow's runs asked of serve, none of them here yet
  if (readingShown(s) && s.workflow !== undefined)
    return { title: 'Reading runs…', line: `${s.workflow}’s runs, a moment` };
  const f = s.filter?.text.trim() ?? '';

  if (f !== '') return { title: `No runs match “${f}”`, line: 'Esc clears the filter' };
  if (s.scope === 'workspace' && s.workflow === undefined) {
    const all = scoped(s, 'all').length;

    return {
      title: `No runs for this workspace yet · All shows ${all}`,
      line: `A run appears here once ${s.branch ?? 'its branch'} is pushed${all > 0 ? ' · ⏎ Show All' : ''}`,
    };
  }

  return { title: 'No runs', line: `${s.list.source} has none yet` };
};

const noteOf = (s: PipelinesState): string | undefined => {
  const filter = filterNote(s, rowsOf(s));

  if (filter !== undefined) return filter;
  if (s.list !== undefined && s.failed !== undefined) return `Runs not read again · ${s.failed}`;
  if (s.asking.some(isListId) && s.list !== undefined) return 'Reading runs…';
  return s.readDone === undefined || s.list === undefined
    ? undefined
    : `Read ${screenClock(s.readDone)}`;
};

/** The selected run's summary beside the runs: the pane wide enough, a run to sum up. */
const withSummary = (s: PipelinesState): boolean =>
  (s.size?.width ?? SUMMARY_FROM) >= SUMMARY_FROM &&
  selectedRun(s) !== undefined &&
  ordered(s).length > 0;

/** The table: the runs that fit with their group headings, the selected one marked. */
export const runsTable = (s: PipelinesState): Table => {
  const { rows, selected } = windowed(s, rowsOf(s));
  const kept = fitColumns(
    s.size === undefined ? undefined : s.size.width - (withSummary(s) ? SUMMARY_W : 0),
  );
  const recent = recentOf(s);
  const groups = s.workflow === undefined ? groupsOf(s) : [];
  const deployOf = new Map(
    groups.flatMap((g) =>
      g.deploys.flatMap((d) => (d.run === null ? [] : [[d.run.id, d] as const])),
    ),
  );
  const cells = (r: Row): TableCell[] => {
    const every = isRun(r) ? cellsOf(s, r, deployOf.get(r.id)) : neverCells(r);

    return kept.flatMap((i) => every[i] ?? []);
  };
  const headings = new Map(
    groups.flatMap((g) => {
      const h = groupHeading(
        g.group,
        g.group === 'deploys' ? g.deploys.length : g.runs.length,
        recent,
      );

      return rowsIn(g).map((r) => [keyOf(r), h] as const);
    }),
  );
  const drawn: Table['props']['rows'] = [];
  let heading: string | undefined;

  for (const r of rows) {
    const h = headings.get(keyOf(r));

    if (h !== undefined && h !== heading) drawn.push({ cells: [{ text: h, hue: 'dim' }] });
    heading = h;
    drawn.push({ id: keyOf(r), cells: cells(r) });
  }
  // an older page may follow: its row, a click or `m`
  const { pages, more } = shownPages(s);

  if (more && rows.length > 0)
    drawn.push({
      id: PAGE_OLDER,
      cells: [
        {
          text: s.asking.includes(listId(s.workflow, pages + 1))
            ? 'Reading older runs…'
            : `Older runs… · the next ${LIMIT}`,
          hue: 'dim',
        },
      ],
    });
  const note = noteOf(s);
  const empty = rows.length === 0;

  return {
    kind: 'Table',
    id: 'pipelines-table',
    props: {
      columns: kept.flatMap((i) => {
        const c = COLUMNS[i];

        return c === undefined
          ? []
          : [
              {
                label: c.label,
                width: c.width,
                ...(c.align === undefined ? {} : { align: c.align }),
              },
            ];
      }),
      rows: empty ? [] : drawn,
      ...(selected === undefined ? {} : { selected: keyOf(selected) }),
      ...(note === undefined ? {} : { note }),
      ...(s.filter === undefined ? {} : { filter: s.filter.text }),
      ...(empty ? { empty: emptyOf(s) } : {}),
      foot: footOf(s),
    },
  };
};

const barOf = (s: PipelinesState): PipelinesBar => ({
  kind: 'PipelinesBar',
  id: 'pipelines-bar',
  props: {
    scopes: PIPELINE_SCOPES.map((k) => ({
      id: `scope:${k}`,
      label: SCOPE_TITLE[k],
      tooltip: SCOPE_TIP[k],
    })),
    selected: `scope:${s.scope}`,
    workflow:
      s.workflow === undefined
        ? { label: 'Workflow ▾', on: false }
        : { label: `Workflow: ${s.workflow}`, on: true },
    count: countOf(s),
    ...(s.list === undefined
      ? {}
      : { source: `${s.list.source} · ${PROVIDER_TITLE[s.list.provider]}` }),
  },
});

/** The selected run at a glance (L-01's right pane). */
export const summaryOf = (s: PipelinesState, r: PipelineRun): RunSummary => {
  const now = nowOf(s);
  const i = s.inspected[r.id];
  const took = tookText(runTook(r, now));
  const meta = [
    r.branch,
    ...(r.pr === null ? [] : [`PR #${r.pr}`]),
    ...(r.sha === '' ? [] : [shortSha(r.sha)]),
    startedText(r.startedAt ?? r.createdAt, now),
    ...(took === '' ? [] : [isOver(r.status) ? took : `${took} so far`]),
  ].join(' · ');
  const skipped: string[] = [];
  const jobs: RunSummary['props']['jobs'] = [];

  if (i !== undefined)
    for (const j of i.jobs) {
      if (j.status === 'skipped') {
        skipped.push(j.name);
        continue;
      }
      const w = pipelineState(j.status);

      jobs.push({
        mark: w.glyph,
        name: j.name,
        duration: tookText(tookMs(j.startedAt, j.finishedAt, now)),
        hue: w.hue,
      });
    }
  else
    for (const st of r.stages) {
      if (st.status === 'skipped') {
        skipped.push(st.name);
        continue;
      }
      const prod = st.gate !== null && isProd(st.gate.environment, s.prod);
      const w = pipelineState(st.status);

      jobs.push({
        mark: prod ? '◇' : w.glyph,
        name: st.name,
        duration: '',
        hue: w.hue,
        ...(prod ? { prod: true } : {}),
      });
    }
  const facts: RunSummary['props']['facts'] = [];
  const failedJob = i?.jobs.find((j) => j.status === 'failed');
  const log = failedJob === undefined ? undefined : s.logs[logKey(r.id, failedJob.id)];
  const evidence = log === undefined || log === null ? undefined : failureEvidence(log);

  if (evidence !== undefined) facts.push({ label: 'Evidence', value: evidence });
  const agent = agentOf(s, r.branch);

  if (agent === undefined) facts.push({ label: 'Agent', value: `none on ${r.branch}` });
  if (r.name !== null) facts.push({ label: 'Brings', value: r.name });

  return {
    kind: 'RunSummary',
    id: 'pipelines-summary',
    props: {
      identity: `${r.pipeline} · run ${runNamed(r)}${r.attempt > 0 ? ` · attempt ${r.attempt}` : ''}`,
      state: markOf(runStateWord(r)),
      title: r.title.trim() === '' ? r.branch : r.title,
      meta,
      jobs,
      ...(skipped.length === 0 ? {} : { skipped: `${skipped.join(', ')} · Skipped` }),
      facts,
      ...(agent === undefined ? {} : { agent }),
      actions: inlineOf(s, r),
    },
  };
};

// ── a run entered: its graph, a job's log ───────────────────────────────────────────────────

const headOf = (s: PipelinesState, r: PipelineRun, i: Inspection | undefined): RunHead => {
  const now = nowOf(s);
  const job = jobShown(s, i);
  const took = tookText(runTook(r, now));
  const failed = (i?.jobs ?? []).some((j) => j.status === 'failed') || r.status === 'failed';
  const over = isOver(r.status);
  const meta = [
    `run ${runNamed(r)}`,
    `attempt ${i?.attempt ?? r.attempt}`,
    i?.branch ?? r.branch,
    ...(r.pr === null ? [] : [`PR #${r.pr}`]),
    shortSha(i?.sha ?? r.sha),
    `started ${startedText(r.startedAt ?? r.createdAt, now)}`,
    ...(took === '' ? [] : [took]),
  ].join(' · ');
  const actions: PipelineAction[] = waits(r)
    ? [{ id: 'act:approve', label: 'Approve…', primary: true }]
    : [
        ...(failed ? [{ id: 'act:fix', label: 'Fix with agent…', primary: true }] : []),
        { id: 'act:rerun-failed', label: 'Rerun failed', disabled: !(failed && over) },
        { id: 'act:rerun', label: 'Rerun', disabled: !over },
        ...(over ? [] : [{ id: 'act:cancel', label: 'Cancel run…' }]),
      ];

  return {
    kind: 'RunHead',
    id: 'pipelines-head',
    props: {
      crumbs: [
        { id: 'crumb:workflow', text: r.pipeline },
        { id: 'crumb:graph', text: `Run ${runNamed(r)} · ${titleOf(r)}` },
        ...(job === undefined ? [] : [{ id: 'crumb:log', text: job.name }]),
      ],
      title: titleOf(r),
      state: markOf(runStateWord(r)),
      meta,
      actions,
    },
  };
};

const graphOf = (s: PipelinesState, i: Inspection, narrow: boolean): RunGraph => {
  const now = nowOf(s);
  const byId = new Map(i.jobs.map((j) => [j.id, j]));
  const note = graphNote(i);
  const selected = shownJob(i, s.job);

  return {
    kind: 'RunGraph',
    id: 'pipelines-graph',
    props: {
      jobs: graphPlaces(i).flatMap((p) => {
        const j = byId.get(p.id);

        return j === undefined
          ? []
          : [
              {
                id: `job:${j.id}`,
                name: j.name,
                ...(j.group === null ? {} : { group: j.group }),
                state: markOf(pipelineState(j.status)),
                duration: tookText(tookMs(j.startedAt, j.finishedAt, now)),
                column: p.column,
                row: p.row,
              },
            ];
      }),
      ...(i.edges === null
        ? {}
        : { edges: i.edges.map(([a, b]): [string, string] => [`job:${a}`, `job:${b}`]) }),
      ...(selected === undefined ? {} : { selected: `job:${selected}` }),
      ...(note === null ? {} : { note }),
      ...(narrow ? { narrow: true } : { legend: LEGEND.map((x) => markOf(pipelineState(x))) }),
    },
  };
};

/** The job's evidence: its log's error lines (once read), then its artifacts. */
const evidenceOf = (
  s: PipelinesState,
  r: PipelineRun,
  i: Inspection,
  j: JobBox,
): { rows: EvidenceRow[]; log: string | null | undefined } => {
  const log = s.logs[logKey(r.id, j.id)];
  const artifacts = artifactRows(i, runNamed(r), j.id);

  return {
    rows:
      log === undefined || log === null ? artifacts : logView(log, s.scroll, artifacts).evidence,
    log,
  };
};

const panelOf = (
  s: PipelinesState,
  r: PipelineRun,
  i: Inspection,
  j: JobBox,
  inLog: boolean,
): JobPanel => {
  const now = nowOf(s);
  const took = tookText(tookMs(j.startedAt, j.finishedAt, now));
  const at = stepAt(j);
  const words = [
    ...(took === '' ? [] : [isOver(j.status) ? `after ${took}` : `${took} so far`]),
    `job ${j.id}`,
    ...(j.runner === null ? [] : [j.runner]),
    ...(at === undefined ? [] : [`step ${at.name}`]),
  ].join(' · ');
  const count = (st: JobBox['status']) => j.steps.filter((x) => x.status === st).length;
  const { rows } = evidenceOf(s, r, i, j);
  const failed = j.status === 'failed';

  return {
    kind: 'JobPanel',
    id: 'pipelines-job',
    props: {
      name: j.name,
      state: markOf(pipelineState(j.status)),
      words,
      counters:
        j.steps.length === 0
          ? []
          : [
              { text: `✗ ${count('failed')} failed`, hue: 'bad' },
              { text: `✓ ${count('passed')} passed`, hue: 'good' },
              { text: `· ${count('skipped')} skipped`, hue: 'dim' },
            ],
      actions: [
        ...(failed ? [{ id: 'act:fix', label: 'Fix with agent…', primary: true }] : []),
        ...(inLog ? [] : [{ id: 'act:log', label: 'Open log' }]),
      ],
      steps: j.steps.map((x) => ({
        state: markOf(pipelineState(x.status)),
        name: x.name,
        duration: tookText(tookMs(x.startedAt, x.finishedAt, now)) || '–',
        ...(at?.name === x.name ? { current: true } : {}),
      })),
      evidenceTitle: `${inLog ? 'EVIDENCE' : 'ANNOTATIONS'} · ${rows.length}`,
      evidence: rows.map((e) => ({
        title: e.title,
        detail: e.detail,
        ...(e.unavailable === undefined ? {} : { unavailable: e.unavailable }),
        ...(e.file === undefined ? {} : { file: `${e.file.path}:${e.file.line}` }),
        ...(e.artifact === undefined ? {} : { artifact: true }),
      })),
      ...(inLog && rows.length > 0 ? { selected: Math.min(s.evidenceAt, rows.length - 1) } : {}),
    },
  };
};

const logOf = (s: PipelinesState, r: PipelineRun, i: Inspection, j: JobBox): JobLog => {
  const log = s.logs[logKey(r.id, j.id)];
  const at = stepAt(j);
  const title = at === undefined ? 'LOG' : `LOG · ${at.name.toUpperCase()}`;

  if (log === undefined || log === null)
    return {
      kind: 'JobLog',
      id: 'pipelines-log',
      props: {
        title,
        range: log === null ? 'No log for this job yet' : 'Reading the log…',
        lines: [],
      },
    };
  const view = logView(log, s.scroll, artifactRows(i, runNamed(r), j.id));

  return {
    kind: 'JobLog',
    id: 'pipelines-log',
    props: {
      title,
      range: view.range,
      lines: view.lines.map((l) => ({
        n: l.n,
        time: l.time,
        text: l.text,
        ...(l.error ? { error: true } : {}),
        ...(l.evidence ? { evidence: true } : {}),
      })),
    },
  };
};

const runView = (s: PipelinesState, r: PipelineRun): Node => {
  const i = s.inspected[r.id];
  const head = headOf(s, r, i);
  const j = jobShown(s, i);

  if (i === undefined || j === undefined) {
    const why = s.unread[r.id];

    return island(
      [
        stack(
          'column',
          [
            head,
            {
              kind: 'Empty',
              props:
                why === undefined
                  ? { title: `Reading run ${runNamed(r)}…`, line: 'Its jobs and the graph of them' }
                  : { title: 'Inspection unavailable', line: why },
            },
          ],
          { sizes: [{ fixed: 64 }, { flex: 1 }] },
        ),
      ],
      'pipelines-run',
    );
  }
  const body =
    s.level === 'log'
      ? stack('row', [panelOf(s, r, i, j, true), logOf(s, r, i, j)], {
          sizes: [{ fixed: PANEL_W }, { flex: 1 }],
          align: 'stretch',
        })
      : stack('row', [graphOf(s, i, false), panelOf(s, r, i, j, false)], {
          sizes: [{ flex: 1 }, { fixed: PANEL_W }],
          align: 'stretch',
        });

  return island(
    [stack('column', [head, body], { sizes: [{ fixed: 64 }, { flex: 1 }], align: 'stretch' })],
    'pipelines-run',
  );
};

const view = (s: PipelinesState): Node => {
  const r = selectedRun(s);

  if (s.level !== 'list' && r !== undefined) return runView(s, r);
  const table = runsTable(s);
  const body =
    withSummary(s) && r !== undefined
      ? stack('row', [table, summaryOf(s, r)], {
          sizes: [{ flex: 1 }, { fixed: SUMMARY_W }],
          align: 'stretch',
        })
      : table;

  return island(
    [
      stack('column', [barOf(s), body], {
        sizes: [{ fixed: BAR_H }, { flex: 1 }],
        align: 'stretch',
      }),
    ],
    s.workflow === undefined ? 'pipelines' : 'pipelines-history',
  );
};

// ── the Action menu and the writes ──────────────────────────────────────────────────────────

/** Who acts: the provider identity the write goes out as. */
const identityOf = (s: PipelinesState): string => {
  if (s.list?.provider === 'azure-pipelines')
    return 'As your Azure CLI login · Azure DevOps checks who may approve';

  return s.list?.me === null || s.list?.me === undefined
    ? 'GitHub identity unknown: sign in to gh before acting'
    : `As ${s.list.me} · GitHub checks the repository's permissions`;
};

const azure = (s: PipelinesState) => s.list?.provider === 'azure-pipelines';

/** Fix with agent's row: what goes where, asked; the card asked first when the branch names none. */
const fixDoes = (s: PipelinesState, r: PipelineRun, i: Inspection): MenuRow['does'] => {
  const asked = s.job === undefined ? undefined : i.jobs.find((j) => j.id === s.job);
  const job = asked?.status === 'failed' ? asked : undefined;
  const jobs = fixJobs(i, job?.id);
  const card = cardOfRunBranch(r.branch);
  // serve's rule: the card's live session, whatever branch it is on
  const live =
    card === undefined
      ? undefined
      : (s.sessions ?? []).find((x) => x.card === card && x.state !== 'ended' && x.kind === 'card');
  const target = (() => {
    if (live !== undefined)
      return `#${card ?? ''}'s session ${live.id} (${sessionLook(live, s.now).word}): the fix goes as a message`;
    if (card !== undefined)
      return `a new Claude Code session on #${card} · Local sandbox · on ${r.branch}, the run's branch`;

    return `the card you name: its live session as a message, else a new Claude Code session · Local sandbox · on ${fixBranch(
      0,
      r,
    ).branch.replace('fix/0-', 'fix/<card>-')} from ${shortSha(r.sha)}`;
  })();
  const log = jobs[0] === undefined ? undefined : s.logs[logKey(r.id, jobs[0].id)];
  const evidence = log === undefined || log === null ? undefined : failureEvidence(log);

  return {
    kind: 'run',
    argv: ['pipeline', 'fix', r.id, ...(job === undefined ? [] : ['--job', job.id])],
    ...(card === undefined
      ? {
          ask: [
            {
              name: 'card',
              kind: 'flag' as const,
              type: 'string' as const,
              required: true,
              repeats: false,
              summary: 'the card the fix is for: its id (4, AB#4)',
              title: `Fix run ${runNamed(r)} for which card?`,
            },
          ],
        }
      : {}),
    confirm: {
      question: `Fix run ${runNamed(r)} with an agent?`,
      details: [
        `To ${target}`,
        `Run: ${r.pipeline} · run ${runNamed(r)} · attempt ${i.attempt}${r.pr === null ? '' : ` · PR #${r.pr}`}`,
        `Job: ${jobs.map((j) => j.name).join(', ')} ✗ Failed`,
        ...(evidence === undefined ? [] : [`Evidence: ${evidence}`]),
        `Revision: ${shortSha(i.sha)} · ${i.branch}`,
      ],
      yes: 'Fix with agent',
    },
  };
};

/** Approve…'s row: who acts, a prod environment's the red yes, always asked. */
const approveDoes = (s: PipelinesState, r: PipelineRun): MenuRow['does'] | undefined => {
  const at = gatesOf(r)[0];

  if (at === undefined) return undefined;
  const env = at.gate.environment;
  const prod = isProd(env, s.prod);
  const name = r.name ?? `run ${runNamed(r)}`;
  const sha = r.sha === '' ? '' : ` at ${shortSha(r.sha)}`;

  return {
    kind: 'run',
    argv: ['pipeline', 'approve', r.id, '--environment', env, ...(prod ? ['--yes'] : [])],
    confirm: prod
      ? {
          question: `Deploy ${name} to ${env}?`,
          details: [
            `${r.pipeline} · run ${runNamed(r)} · ${r.branch}${sha}`,
            ...(r.title === '' ? [] : [`Brings ${r.title}`]),
            identityOf(s),
          ],
          yes: 'Yes, deploy to prod',
          danger: true,
        }
      : {
          question: `Approve deployment to ${env}?`,
          details: [
            `${r.pipeline} · run ${runNamed(r)} · ${r.branch}${sha} · ${at.stage.name}`,
            identityOf(s),
          ],
          yes: 'Approve',
        },
    done: `${name}: ${env} approved`,
  };
};

/** A row's grey reason (the provider's, then the run's), else its detail. */
const whyNot = (
  provider: string | undefined,
  run: string | undefined,
  dim: string,
): { reason: string } | { dim: string } => {
  const reason = provider ?? run;

  return reason === undefined ? { dim } : { reason };
};

/** The run's six rows (L-09): Approve… takes Fix with agent's place at a gate. */
export const runMenu = (s: PipelinesState, r: PipelineRun): Menu => {
  const i = s.inspected[r.id];
  const failed = (i?.jobs ?? []).filter((j) => j.status === 'failed');
  const skippedJobs = (i?.jobs ?? []).filter((j) => j.status === 'skipped').length;
  const jobs = i?.jobs.length ?? r.stages.length;
  const over = isOver(r.status);
  const attempt = i?.attempt ?? r.attempt;
  const controls = azure(s) ? 'Run controls are unavailable for Azure Pipelines' : undefined;
  const rows: MenuRow[] = [
    {
      id: 'inspect',
      text: 'Inspect',
      dim: 'the graph and the job log',
      key: '⏎',
      does: { kind: 'back' },
    },
  ];
  const approve = approveDoes(s, r);
  const gate = gatesOf(r)[0];

  if (approve !== undefined && gate !== undefined)
    rows.push({
      id: 'approve',
      text: 'Approve…',
      dim: `${gate.gate.environment} · ${isProd(gate.gate.environment, s.prod) ? 'waits for your yes' : 'waits for an approval'}`,
      ...(gate.gate.canApprove ? {} : { reason: `you may not approve ${gate.gate.environment}` }),
      ...(isProd(gate.gate.environment, s.prod) ? { risky: true } : {}),
      does: approve,
    });
  else {
    let reason: string | undefined;

    if (r.status !== 'failed' && failed.length === 0) reason = 'the run has no failed jobs';
    else if (i === undefined) reason = 'the run is not read yet';
    rows.push({
      id: 'fix',
      text: 'Fix with agent…',
      ...(reason === undefined
        ? {
            dim: `${failed.map((j) => j.name).join(', ')} failed · ${workspaceName(r.branch, sessionOn(s, r.branch))}`,
          }
        : { reason }),
      costly: true,
      does: i === undefined ? { kind: 'back' } : fixDoes(s, r, i),
    });
  }
  const rerunFailed = (() => {
    if (controls !== undefined) return { reason: controls };
    if (!over) return { reason: 'the run is still running' };
    if (failed.length === 0) return { reason: 'This run has no failed jobs to rerun' };

    return {
      dim:
        skippedJobs > 0
          ? `${failed.map((j) => j.name).join(', ')} and the ${skippedJobs} jobs it skipped`
          : failed.map((j) => j.name).join(', '),
    };
  })();

  rows.push({
    id: 'rerun-failed',
    text: 'Rerun failed',
    ...rerunFailed,
    does: {
      kind: 'run',
      argv: ['pipeline', 'rerun', r.id, '--attempt', String(attempt), '--failed'],
      done: `Run ${runNamed(r)}: failed jobs rerun`,
    },
  });
  rows.push({
    id: 'rerun',
    text: 'Rerun',
    ...whyNot(controls, over ? undefined : 'the run is still running', `all ${jobs} jobs`),
    does: {
      kind: 'run',
      argv: ['pipeline', 'rerun', r.id, '--attempt', String(attempt)],
      done: `Run ${runNamed(r)}: rerun`,
    },
  });
  rows.push({
    id: 'cancel',
    text: 'Cancel run…',
    ...whyNot(controls, over ? 'the run has ended' : undefined, 'stops its running jobs'),
    does: {
      kind: 'run',
      argv: ['pipeline', 'cancel', r.id, '--attempt', String(attempt)],
      confirm: {
        question: `Cancel run ${runNamed(r)}?`,
        details: [
          `${r.pipeline} · ${titleOf(r)} · attempt ${attempt} · ${r.branch}`,
          identityOf(s),
        ],
        yes: 'Cancel run',
        no: 'Keep running',
      },
      done: `Run ${runNamed(r)}: cancelled`,
    },
  });
  rows.push({
    id: 'browser',
    text: 'Open in browser',
    dim: s.list === undefined ? '' : PROVIDER_TITLE[s.list.provider],
    ...(r.url === '' ? { reason: 'the provider names no page' } : {}),
    does:
      r.url === '' ? { kind: 'back' } : { kind: 'shell', effect: { kind: 'open-url', url: r.url } },
  });
  rows.push({ ...dispatchRow(s), separator: true });

  return {
    kind: 'menu',
    id: `${RUN}${r.id}`,
    title: `${r.pipeline} · run ${runNamed(r)} · ${titleOf(r)}`,
    rows,
  };
};

// ── Run workflow… ───────────────────────────────────────────────────────────────────────────

/** Why no workflow is run by hand from here (Azure Pipelines, for now); none on GitHub. */
const dispatchWhyNot = (s: PipelinesState): string | undefined =>
  azure(s) ? 'Run workflow is GitHub Actions only for now' : undefined;

/** The Run workflow… row: handed back here, which reads the workflows and opens the pick. */
const dispatchRow = (s: PipelinesState): MenuRow => {
  const reason = dispatchWhyNot(s);

  return {
    id: 'dispatch',
    text: 'Run workflow…',
    ...(reason === undefined
      ? { dim: `a workflow run by hand on ${s.branch ?? 'a branch'}, with its inputs` }
      : { reason }),
    does: { kind: 'back' },
  };
};

/** ⌘⏎ with no run selected: the tab's own actions, Run workflow… alone. */
const tabMenu = (s: PipelinesState): Menu => ({
  kind: 'menu',
  id: DISPATCH,
  title: 'Pipelines',
  rows: [dispatchRow(s)],
});

/** Run workflow… chosen: the workflows read at the shown branch, the pick once they come. */
const askDispatch = (s: PipelinesState): Out => {
  const reason = dispatchWhyNot(s);

  if (reason !== undefined)
    return { state: s, commands: [shell({ kind: 'status', text: reason })] };

  return readDispatchable({ ...s, dispatchAsked: true });
};

/**
 * What a workflow asks before it runs: the branch (the shown one preset), then each input: a
 * choice as a pick on its default, a boolean as yes/no, the rest a field on its default; one not
 * required may be left empty.
 */
const dispatchAsks = (s: PipelinesState, w: DispatchWorkflow): MenuAsk[] => {
  const ref: MenuAsk = {
    name: 'ref',
    kind: 'flag',
    type: 'string',
    required: true,
    repeats: false,
    summary: 'the branch or tag it runs on',
    title: `Run ${w.name} on which branch?`,
    ...(s.branch === undefined ? {} : { preselect: s.branch }),
  };
  const inputs = w.inputs.map((i): MenuAsk => {
    const base = {
      name: i.name,
      kind: 'flag' as const,
      repeats: false,
      required: i.required,
      summary: i.description === '' ? `${i.name} · ${i.type}` : i.description,
      // a pick says it too, as a field does
      ...(i.description === '' ? {} : { hint: i.description }),
      title: `${w.name} · ${i.name}${i.required ? '' : ' (optional)'}`,
    };

    if (i.type === 'choice')
      return {
        ...base,
        type: 'string',
        values: [i.options[0] ?? '', ...i.options.slice(1)],
        preselect: i.default ?? i.options[0] ?? '',
      };
    if (i.type === 'boolean')
      return {
        ...base,
        type: 'boolean',
        labels: { true: 'Yes', false: 'No' },
        preselect: i.default === 'true' ? 'true' : 'false',
      };

    return { ...base, type: 'string', ...(i.default === null ? {} : { preselect: i.default }) };
  });

  return [ref, ...inputs];
};

/** An input's words in a row: `environment: dev · test`, `dry-run`, `version`. */
const inputWords = (i: WorkflowInput): string =>
  i.type === 'choice' ? `${i.name}: ${i.options.join(' · ')}` : i.name;

/**
 * The pick of the workflows run by hand (Command mode's menu): each asks its branch and inputs.
 * It opens on the selected run's workflow, else the shown one's.
 */
const dispatchMenu = (s: PipelinesState): Menu => {
  const d = s.dispatchable;
  const at = s.branch ?? 'the default branch';
  const named = selectedRun(s)?.pipeline ?? s.workflow;
  const on = dispatchables(s)?.find((w) => w.dispatch && w.name === named)?.file;
  const rows: MenuRow[] = (() => {
    if (d === undefined || 'failed' in d)
      return [
        {
          id: 'none',
          text: 'Workflows not read',
          reason: d === undefined ? 'try again' : d.failed,
          does: { kind: 'back' as const },
        },
      ];
    if (d.note !== null)
      return [{ id: 'none', text: d.note, reason: d.note, does: { kind: 'back' } }];
    if (d.workflows.length === 0)
      return [
        {
          id: 'none',
          text: 'No workflows',
          reason: `${d.source} has none at ${at}`,
          does: { kind: 'back' },
        },
      ];

    return d.workflows.map((w): MenuRow => ({
      id: w.file,
      text: w.name,
      ...(w.dispatch
        ? {
            dim:
              w.inputs.length === 0
                ? `${w.file} · no inputs`
                : `${w.file} · ${w.inputs.map(inputWords).join(', ')}`,
          }
        : { reason: `${w.file} has no workflow_dispatch: it is not run by hand` }),
      does: { kind: 'back', ask: dispatchAsks(s, w) },
    }));
  })();

  return {
    kind: 'menu',
    id: DISPATCH,
    title: `Run workflow · at ${at}`,
    rows,
    ...(on === undefined ? {} : { preselect: on }),
  };
};

/**
 * A workflow picked with its branch and inputs answered (in `dispatchAsks`'s order): `pipeline
 * run <file> --ref <ref> --input k=v…`, an input left empty not given.
 */
export const dispatchArgv = (w: DispatchWorkflow, values: readonly string[]): string[] => [
  'pipeline',
  'run',
  w.file,
  '--ref',
  values[0] ?? '',
  ...w.inputs.flatMap((i, n) => {
    const v = values[n + 1] ?? '';

    return v === '' ? [] : ['--input', `${i.name}=${v}`];
  }),
];

/** The workflows as last read, if they were. */
const dispatchables = (s: PipelinesState): DispatchWorkflow[] | undefined => {
  const d = s.dispatchable;

  return d === undefined || 'failed' in d ? undefined : d.workflows;
};

const onDispatchChoice = (s: PipelinesState, row: string, values: readonly string[]): Out => {
  const w = dispatchables(s)?.find((x) => x.file === row);

  if (w?.dispatch !== true) return none(s);

  return { state: s, commands: [run('pipelines:act:dispatch', dispatchArgv(w, values))] };
};

/**
 * A row of the run's menu chosen here (a head's or summary's button, the menu's `back` rows): the
 * same as the menu's, a write that asks handed to Command mode as its own menu of one row.
 */
const act = (s: PipelinesState, r: PipelineRun, row: string): Out => {
  switch (row) {
    case 'inspect':
      return enter(s, 'graph');
    case 'log':
      return enter(s, 'log');
    default: {
      const found = runMenu(s, r).rows.find((x) => x.id === row);

      if (found === undefined) return none(s);
      if (found.reason !== undefined)
        return {
          state: s,
          commands: [
            shell({ kind: 'status', text: `${found.text.replace('…', '')}: ${found.reason}` }),
          ],
        };
      const does = found.does;

      if (does.kind === 'shell') return { state: s, commands: [shell(does.effect)] };
      if (does.kind !== 'run') return none(s);
      // asked first (a card, a yes): Command mode asks, then runs it
      if (does.ask !== undefined || does.confirm !== undefined)
        return {
          state: s,
          commands: [
            { kind: 'menu', id: `${RUN}${r.id}`, title: runMenu(s, r).title, rows: [found] },
          ],
        };

      return { state: s, commands: [run(`pipelines:act:${row}`, does.argv)] };
    }
  }
};

/** In the run: its graph (or a job's log), the filter put away; out of it: the list. */
const enter = (s: PipelinesState, level: PipelinesLevel): Out => {
  const next: PipelinesState = { ...s, level };

  if (level === 'log') {
    delete next.scroll;
    next.evidenceAt = 0;
  }
  if (level === 'list') delete next.job;

  return chain(next, readSelected);
};

// ── keys and clicks ─────────────────────────────────────────────────────────────────────────

const MOVES: Readonly<Record<string, GraphMove>> = {
  k: 'left',
  '<Left>': 'left',
  ä: 'right',
  '<Right>': 'right',
  l: 'up',
  '<Up>': 'up',
  ö: 'down',
  '<Down>': 'down',
};

/** Job `to` shown: its log's place and evidence forgotten. */
const showJob = (s: PipelinesState, to: string): Out => {
  if (s.job === to) return none(s);
  const next: PipelinesState = { ...s, job: to, evidenceAt: 0 };

  delete next.scroll;

  return chain(next, readSelected);
};

/** ⏎ on an evidence row in the log view: Fix with agent with that evidence, asked first. */
const evidenceFix = (s: PipelinesState, r: PipelineRun, i: Inspection, j: JobBox): Out => {
  const { rows } = evidenceOf(s, r, i, j);
  const e = rows[Math.min(s.evidenceAt, rows.length - 1)];

  if (e === undefined) return none(s);
  if (e.unavailable !== undefined)
    return {
      state: s,
      commands: [shell({ kind: 'status', text: `${e.title}: ${e.unavailable}` })],
    };
  const base = fixDoes(s, r, i);

  if (base.kind !== 'run') return none(s);
  const extra =
    e.artifact === undefined
      ? ['--evidence', `${e.title} · ${e.detail}`]
      : ['--artifact', e.artifact];
  const row: MenuRow = {
    id: 'fix',
    text: 'Fix with agent…',
    costly: true,
    does: {
      ...base,
      argv: [...base.argv, ...extra],
      ...(base.confirm === undefined
        ? {}
        : {
            confirm: {
              ...base.confirm,
              details: [...(base.confirm.details ?? []), `With: ${e.title} · ${e.detail}`],
            },
          }),
    },
  };

  return {
    state: s,
    commands: [{ kind: 'menu', id: `${RUN}${r.id}`, title: runMenu(s, r).title, rows: [row] }],
  };
};

/** `o` on an evidence row: the file a test failure names, in the Editor at its line. */
const openFile = (s: PipelinesState, r: PipelineRun, i: Inspection, j: JobBox, n: number): Out => {
  const e = evidenceOf(s, r, i, j).rows[n];

  if (e?.file === undefined) return none(s);
  const live = sessionOn(s, r.branch);
  const folder = live?.worktree !== undefined && live.worktree !== '' ? live.worktree : s.root;

  return folder === undefined
    ? none(s)
    : {
        state: s,
        commands: [
          shell({ kind: 'open-file', path: `${folder}/${e.file.path}`, line: e.file.line }),
        ],
      };
};

const onRunKey = (s: PipelinesState, r: PipelineRun, key: string): Out => {
  const i = s.inspected[r.id];
  const j = jobShown(s, i);

  if (key === '<Esc>') return enter(s, s.level === 'log' ? 'graph' : 'list');
  if (key === '<D-CR>') return { state: s, commands: [runMenu(s, r)] };
  if (key === 'r') return readAgain(s);
  if (i === undefined || j === undefined) return none(s);
  if (s.level === 'graph') {
    const m = MOVES[key];

    if (m !== undefined) return showJob(s, graphNeighbor(i, j.id, m));
    if (key === '<CR>') return enter(s, 'log');

    return none(s);
  }
  // the log: k ä the jobs beside, l ö its evidence (the log follows), the pages its lines
  if (key === 'k' || key === 'ä' || key === '<Left>' || key === '<Right>')
    return showJob(s, graphNeighbor(i, j.id, MOVES[key] ?? 'left'));
  const { rows, log } = evidenceOf(s, r, i, j);

  if (key === 'l' || key === 'ö' || key === '<Up>' || key === '<Down>') {
    const at = Math.max(
      0,
      Math.min(rows.length - 1, s.evidenceAt + (key === 'l' || key === '<Up>' ? -1 : 1)),
    );
    const line = rows[at]?.line;

    return none({
      ...s,
      evidenceAt: at,
      ...(line === undefined ? {} : { scroll: Math.max(1, line - 9) - 1 }),
    });
  }
  const total = log === undefined || log === null ? 0 : log.split('\n').length;
  const first =
    log === undefined || log === null ? 0 : (logView(log, s.scroll).lines[0]?.n ?? 1) - 1;

  if (key === '<PageUp>' || key === '<C-u>') return none({ ...s, scroll: Math.max(0, first - 20) });
  if (key === '<PageDown>' || key === '<C-d>')
    return none({ ...s, scroll: Math.min(Math.max(0, total - 1), first + 20) });
  if (key === 'gg' || key === '<Home>') return none({ ...s, scroll: 0 });
  if (key === 'G' || key === '<End>') return none({ ...s, scroll: Math.max(0, total - 20) });
  if (key === '<CR>') return evidenceFix(s, r, i, j);
  if (key === 'o') return openFile(s, r, i, j, Math.min(s.evidenceAt, rows.length - 1));

  return none(s);
};

/** `w`: a pick of the workflows (Command mode's menu), their runs and failures counted. */
const workflowMenu = (s: PipelinesState): Menu => {
  const every = allRuns(s);
  const names = [...new Set([...every.map((r) => r.pipeline), ...(s.list?.workflows ?? [])])].sort(
    (a, b) => a.localeCompare(b),
  );
  const failed = new Set(
    groupRuns(every)
      .filter((g) => g.group === 'failed')
      .flatMap((g) => g.runs.map((r) => r.id)),
  );

  return {
    kind: 'menu',
    id: WORKFLOWS,
    title: 'Workflow',
    rows: [
      {
        id: ALL_WORKFLOWS,
        text: 'All workflows',
        dim: `${every.length} runs · the overview`,
        ...(s.workflow === undefined ? { reason: 'shown' } : {}),
        does: { kind: 'back' },
      },
      ...names.map((name): MenuRow => {
        const of = every.filter((r) => r.pipeline === name);
        const f = of.filter((r) => failed.has(r.id)).length;

        return {
          id: name,
          text: name,
          dim: `${of.length} run${of.length === 1 ? '' : 's'}${f > 0 ? ` · ✗ ${f} failed` : ''}`,
          ...(s.workflow === name ? { reason: 'shown' } : {}),
          does: { kind: 'back' },
        };
      }),
    ],
  };
};

const WORKFLOWS = 'pipelines:workflows';
/** The Workflow menu's All workflows row: a row id is never empty, and no workflow is named `*`. */
const ALL_WORKFLOWS = '*';

/**
 * The workflow picked (none: the overview): serve is asked for its runs, the overview's of it
 * shown meanwhile; back to the overview its runs are as read, read again when stale.
 */
const withWorkflow = (s: PipelinesState, name: string | undefined): Out => {
  const next: PipelinesState = { ...s, level: 'list' };

  if (name === undefined || name === ALL_WORKFLOWS) delete next.workflow;
  else next.workflow = name;
  delete next.selected;

  return chain(
    settle(next),
    (x) => (fresh(x, listId(x.workflow, 1)) ? none(x) : readList(x)),
    readSelected,
  );
};

const cycleScope = (s: PipelinesState, by: number): Out => {
  const at = PIPELINE_SCOPES.indexOf(s.scope);
  const scope =
    PIPELINE_SCOPES[(at + by + PIPELINE_SCOPES.length) % PIPELINE_SCOPES.length] ?? 'all';

  return withScope(s, scope);
};

const withScope = (s: PipelinesState, scope: PipelineScope): Out => {
  const next: PipelinesState = { ...s, scope };

  delete next.selected;

  return chain(settle(next), readSelected);
};

const onListKey = (s0: PipelinesState, raw: string): Out => {
  const before = selectedRun(s0)?.id;
  const { state: s, key } = listKey(s0, raw, rowsOf(s0));
  const r = selectedRun(s);
  // a move: the run now selected read
  const after = (x: PipelinesState) => (r?.id === before ? none(x) : readSelected(x));

  if (key === undefined) return after(s);
  switch (key) {
    case '<Tab>':
      return cycleScope(s, 1);
    case '<S-Tab>':
      return cycleScope(s, -1);
    case 'r':
      return readAgain(settle(released(s)));
    case 'w':
      return { state: s, commands: [workflowMenu(s)] };
    case 'm':
      return readMore(s);
    case '<Esc>':
      return s.workflow === undefined
        ? { state: s, commands: [shell({ kind: 'unhandled', slot: 'pane', key: '<Esc>' })] }
        : withWorkflow(s, undefined);
    case '<CR>':
      // an empty This workspace: Show All (L-21)
      if (r === undefined)
        return s.scope === 'workspace' && scoped(s, 'all').length > 0
          ? withScope(s, 'all')
          : none(s);

      return enter(s, 'graph');
    case '<D-CR>':
      return { state: s, commands: [r === undefined ? tabMenu(s) : runMenu(s, r)] };
    default:
      return after(s);
  }
};

const onKey = (s: PipelinesState, key: string): Out => {
  const r = selectedRun(s);

  return s.level !== 'list' && r !== undefined ? onRunKey(s, r, key) : onListKey(s, key);
};

const onClick = (s: PipelinesState, id: string): Out => {
  const r = selectedRun(s);

  if (id.startsWith(RUN) || id.startsWith(NEVER)) {
    const next = listClick(s, id, rowsOf(s));

    return selectedRun(next)?.id === r?.id ? none(next) : chain(next, readSelected);
  }
  if (id.startsWith('scope:')) {
    const scope = PIPELINE_SCOPES.find((k) => `scope:${k}` === id);

    return scope === undefined ? none(s) : withScope(s, scope);
  }
  if (id === 'workflow') return { state: s, commands: [workflowMenu(s)] };
  if (id === 'workflow:clear') return withWorkflow(s, undefined);
  if (id === PAGE_OLDER) return readMore(s);
  if (r === undefined) return none(s);
  if (id.startsWith('act:')) return act(s, r, id.slice('act:'.length));
  if (id === 'crumb:workflow') return withWorkflow(s, r.pipeline);
  if (id === 'crumb:graph') return enter(s, 'graph');
  if (id === 'crumb:log') return enter(s, 'log');
  const i = s.inspected[r.id];

  if (id.startsWith('job:')) {
    const job = id.slice('job:'.length);
    const shown = showJob(s, job);

    return s.level === 'list' ? chain(shown.state, (x) => enter(x, 'graph')) : shown;
  }
  const j = jobShown(s, i);

  if (i === undefined || j === undefined) return none(s);
  if (id.startsWith('evidence:')) {
    const n = Number(id.slice('evidence:'.length));
    const line = evidenceOf(s, r, i, j).rows[n]?.line;

    return chain(
      {
        ...s,
        evidenceAt: n,
        ...(line === undefined ? {} : { scroll: Math.max(1, line - 9) - 1 }),
      },
      (x) => (x.level === 'log' ? none(x) : enter({ ...x, evidenceAt: n }, 'log')),
    );
  }
  if (id.startsWith('open-file:'))
    return openFile(s, r, i, j, Number(id.slice('open-file:'.length)));

  return none(s);
};

const onChoice = (s: PipelinesState, input: Extract<Input, { kind: 'choice' }>): Out => {
  if (input.menu === WORKFLOWS) return withWorkflow(s, input.row);
  if (input.menu === DISPATCH)
    return input.row === 'dispatch'
      ? askDispatch(s)
      : onDispatchChoice(s, input.row, input.values ?? []);
  const r = selectedRun(s);

  if (r === undefined || input.menu !== `${RUN}${r.id}`) return none(s);
  if (input.row === 'inspect') return enter(s, 'graph');
  if (input.row === 'dispatch') return askDispatch(s);

  return none(s);
};

const onOpen = (s: PipelinesState, input: Extract<Input, { kind: 'open' }>): Out => {
  const p = input.params;
  const branch = p.branch ?? s.branch;
  // Linked's Pipelines row names its run; `runBranch` a branch's newest run
  const want =
    p.run === undefined && p.runBranch === undefined
      ? undefined
      : {
          ...(p.run === undefined ? {} : { run: p.run }),
          ...(p.runBranch === undefined ? {} : { branch: p.runBranch }),
        };
  const root = p.root ?? s.root;
  const next: PipelinesState = {
    ...s,
    opened: true,
    size: input.size,
    ...(root === undefined ? {} : { root }),
    ...(branch === undefined ? {} : { branch }),
    ...(want === undefined ? {} : { want, level: 'list' as const }),
  };

  // another run named: the one named before goes back to being only as listed
  if (want !== undefined) delete next.named;

  // opened again (the tab picked anew, Linked's row): what it holds stays, read anew
  return s.opened ? chain(settle(next), readSelected) : chain(settle(next), readAll, readProd);
};

const stepPipelines = (s: PipelinesState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return onOpen(s, input);
    case 'resize':
      return moved({ ...s, size: input.size });
    case 'root': {
      if (input.branch === s.branch && input.root === s.root) return none(s);
      // another project: its runs, read anew
      const next: PipelinesState = {
        ...s,
        root: input.root,
        ...(input.root === s.root
          ? {}
          : {
              full: {},
              inspected: {},
              unread: {},
              logs: {},
              asking: [],
              gen: s.gen + 1,
              pages: 1,
              more: false,
            }),
      };

      if (input.root !== s.root) {
        delete next.list;
        delete next.history;
        delete next.dispatchable;
        delete next.named;
        // Linked's run is the project's it was asked in
        delete next.want;
      }

      if (input.branch === undefined) delete next.branch;
      else next.branch = input.branch;

      return s.opened ? readAll(settle(next)) : none(next);
    }
    case 'tick': {
      const t = Date.parse(input.at);
      // reads asked before the clock's first tick count from it
      const next = {
        ...s,
        now: input.at,
        askedAt: Object.fromEntries(
          Object.entries(s.askedAt).map(([k, v]) => [k, v === 0 ? t : v]),
        ),
        ...(s.readDone === undefined && s.list !== undefined ? { readDone: input.at } : {}),
      };

      if (!s.opened) return none(next);

      return chain(
        next,
        (x) => (fresh(x, listId(x.workflow, 1)) ? none(x) : readList(x)),
        readSelected,
      );
    }
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return onClick(s, input.id);
    // the wheel: the table's rows, the log's lines, three at a step
    case 'scroll':
      if (input.id === 'pipelines-table') return none(listScroll(s, input.y, rowsOf(s)));

      return input.id === 'pipelines-log'
        ? none({ ...s, scroll: Math.max(0, (s.scroll ?? 0) + input.y * 3) })
        : none(s);
    case 'text':
      return none(listText(s, input.text, rowsOf(s)) ?? s);
    case 'focus':
      return input.focused || input.layer === true ? none(s) : moved(released(s));
    case 'choice':
      return onChoice(s, input);
    case 'result':
      return onResult(s, input);
    case 'event':
      return onEvent(s, input.event);
    case 'live':
      return onFacts(s, input.facts);
    default:
      return none(s);
  }
};

/** Another tab took the pane: opened again it draws what it read at once and reads it anew. */
const keepPipelines = (s: PipelinesState): PipelinesState => ({
  ...reopened(s),
  opened: false,
  asking: [],
  askedAt: {},
  gen: s.gen + 1,
});

/** The watch's events it takes: its runs' writes, prod's settings (the agents and their runs are live's); any other never re-views it. */
const PIPELINES_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'command.ran',
  'settings.changed',
]);

export const pipelinesScreen: Screen<PipelinesState> = {
  events: PIPELINES_EVENTS,
  name: 'pipelines',
  // `?` lists the Pipelines tab's keys (#346)
  here: () => ({ keys: 'pipelines' }),
  init: INIT,
  step: stepPipelines,
  follows: () => FOLLOWS,
  keep: keepPipelines,
  view,
  linked: (s) => {
    const r = selectedRun(s);

    return r === undefined ? undefined : cardOfRunBranch(r.branch);
  },
  typing: (s) => s.filter?.typing === true,
  // a running run's durations count by the second
  seconds: (s) => s.opened && ordered(s).some((r) => !isOver(r.status)),
};
