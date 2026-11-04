/**
 * The Pipelines tab's world. A prod release waits at its gate and two runs are going. Run 103
 * failed on fix/AB-7-rounding, and no session has it. AB-1234 has a passed and a cancelled check,
 * and a login-redirect run passed. Run 103's attempt 1 is inspected, with its failed job's log.
 * Its jobs run install, then lint, unit tests and build, then the skipped e2e and the skipped
 * preview. It has an E2E report of its revision and an expired trace. `pipelinesReplies` answers
 * `abe pipeline …` as the screen sends them. `fakePipelines` is the port in memory for `serve`.
 */
import type {
  Answered,
  CiWorkflowFile,
  DispatchWorkflow,
  Gate,
  Inspection,
  JobBox,
  PipelineDeploy,
  PipelineListData,
  PipelineRun,
  Pipelines,
  PipelineSource,
  RunControl,
} from '@abe/core';
import { type Answer, type Node, pipelinesScreen } from '@abe/ui';
import { type Drive, driveScreen, type Replies } from './screen-driver';

export const PIPELINES_NOW = '2026-10-01T09:00:00.000Z';
export const PIPELINES_ME = 'ann';

/**
 * A run on o/r that starts at `at`, an `HH:MM` on 2026-10-01 UTC, and ends `took` minutes later.
 */
export const pipelineRun = (
  id: string,
  pipeline: string,
  title: string,
  branch: string,
  at: string,
  took: number | null,
  more: Partial<PipelineRun> = {},
): PipelineRun => {
  const started = `2026-10-01T${at}:00Z`;
  const finished =
    took === null ? null : new Date(Date.parse(started) + took * 60_000).toISOString();

  return {
    id,
    // GitHub's page shows this number, not the REST id. Run 9003 shows as 103.
    number: String((Number(id) % 1000) + 100),
    pipeline,
    name: null,
    title,
    branch,
    trigger: 'pull request',
    actor: PIPELINES_ME,
    status: 'passed',
    createdAt: started,
    startedAt: started,
    finishedAt: finished,
    url: `https://github.com/o/r/actions/runs/${id}`,
    stages: [],
    sha: `${id}c7e152a00000000000000000000000000000`,
    attempt: 1,
    pr: null,
    ...more,
  };
};

export const PROD_GATE: Gate = {
  id: '9',
  kind: 'environment',
  environment: 'production',
  since: null,
  canApprove: true,
};

export const PIPELINE_RUNS: PipelineRun[] = [
  pipelineRun('9007', 'Deploy Prod', 'Release rc-213', 'main', '08:20', null, {
    trigger: 'manual',
    name: 'rc-213',
    status: 'waiting',
    stages: [
      { name: 'build', status: 'passed', startedAt: null, finishedAt: null, gate: null },
      {
        name: 'deploy · production',
        status: 'waiting',
        startedAt: null,
        finishedAt: null,
        gate: PROD_GATE,
      },
    ],
  }),
  pipelineRun(
    '9006',
    'PR checks',
    'Checkout copy for Nordic markets',
    'card/40-checkout-copy',
    '08:42',
    null,
    { status: 'running', actor: 'bob', pr: 57 },
  ),
  pipelineRun('9005', 'Deploy Dev/Test', 'Order history paginates', 'main', '08:38', null, {
    status: 'running',
    trigger: 'push',
    actor: 'bob',
  }),
  pipelineRun('9003', 'PR checks', 'Fix cart rounding', 'fix/AB-7-rounding', '08:00', 7, {
    status: 'failed',
    pr: 61,
  }),
  pipelineRun(
    '9001',
    'PR checks',
    'Cart total includes shipping',
    'card/34-cart-total',
    '07:31',
    6,
    { pr: 56 },
  ),
  pipelineRun(
    '9000',
    'PR checks',
    'Login redirect keeps the query',
    'fix/login-redirect',
    '07:10',
    6,
    { pr: 59, actor: 'bob' },
  ),
  pipelineRun(
    '8999',
    'PR checks',
    'Cart total includes shipping',
    'card/34-cart-total',
    '07:02',
    1,
    {
      status: 'cancelled',
      pr: 56,
    },
  ),
];

const job = (
  id: string,
  name: string,
  status: JobBox['status'],
  from?: string,
  to?: string,
): JobBox => ({
  id,
  name,
  status,
  url: `https://github.com/o/r/actions/runs/9003/job/${id}`,
  startedAt: from === undefined ? null : `2026-10-01T${from}Z`,
  finishedAt: to === undefined ? null : `2026-10-01T${to}Z`,
  runner: null,
  group: null,
  steps: [],
});

/** Run 103's attempt 1, inspected. */
export const INSPECTION_9003: Inspection = (() => {
  const sha = PIPELINE_RUNS[3]?.sha ?? '';

  return {
    repo: 'o/r',
    run: '9003',
    attempt: 1,
    sha,
    branch: 'fix/AB-7-rounding',
    workflow: '.github/workflows/pr.yml',
    jobs: [
      job('90031', 'install', 'passed', '08:00:00', '08:00:22'),
      job('90032', 'lint', 'passed', '08:00:30', '08:01:18'),
      {
        ...job('90033', 'unit tests', 'failed', '08:01:00', '08:03:10'),
        runner: 'ubuntu-latest',
        steps: [
          { name: 'Set up job', status: 'passed', startedAt: null, finishedAt: null },
          { name: 'Run npm test', status: 'failed', startedAt: null, finishedAt: null },
          { name: 'Upload coverage', status: 'skipped', startedAt: null, finishedAt: null },
        ],
      },
      job('90034', 'build', 'passed', '08:00:30', '08:02:05'),
      job('90035', 'e2e · Chromium', 'skipped'),
      job('90036', 'deploy preview', 'skipped'),
    ],
    edges: [
      ['90031', '90032'],
      ['90031', '90033'],
      ['90031', '90034'],
      ['90033', '90035'],
      ['90034', '90035'],
      ['90035', '90036'],
    ],
    partial: false,
    artifacts: [
      {
        id: '8',
        name: 'e2e-report',
        url: 'https://github.com/o/r/actions/runs/9003/artifacts/8',
        expired: false,
        sha,
        job: '90033',
        attempt: 1,
      },
      {
        id: '9',
        name: 'playwright-trace',
        url: 'https://github.com/o/r/actions/runs/9003/artifacts/9',
        expired: true,
        sha,
        job: null,
        attempt: null,
      },
    ],
    artifactsNote: null,
  };
})();

/** Any other run inspected, with one `build` job in its status. */
export const inspectionOf = (r: PipelineRun): Inspection =>
  r.id === '9003'
    ? INSPECTION_9003
    : {
        repo: 'o/r',
        run: r.id,
        attempt: r.attempt,
        sha: r.sha,
        branch: r.branch,
        workflow: '.github/workflows/ci.yml',
        jobs: [{ ...job('1', 'build', r.status), url: `${r.url}/job/1` }],
        edges: [],
        partial: false,
        artifacts: [],
        artifactsNote: null,
      };

/** Unit tests' log, with a failing vitest test and the step's error. */
export const LOG_90033 = [
  '2026-10-01T08:01:01.0000000Z ▾ Run npm test',
  '2026-10-01T08:01:02.0000000Z > vitest run --reporter=dot',
  '2026-10-01T08:01:06.0000000Z  ✓ src/api/price.test.ts (3 tests) 12ms',
  '2026-10-01T08:01:06.0000000Z  ✗ src/api/cart.test.ts > cartTotal > rounds to two decimals',
  '2026-10-01T08:01:06.0000000Z    AssertionError: expected 10.000000000000002 to be 10',
  '2026-10-01T08:01:06.0000000Z     ❯ src/api/cart.test.ts:14:21',
  '2026-10-01T08:01:06.0000000Z  Test Files  1 failed | 2 passed (3)',
  '2026-10-01T08:01:06.0000000Z ##[error]Process completed with exit code 1.',
].join('\n');

export const PIPELINE_LIST: PipelineListData = {
  provider: 'github-actions',
  source: 'o/r',
  me: PIPELINES_ME,
  runs: PIPELINE_RUNS.map((r) => ({ ...r, stages: [] })),
  workflows: ['Deploy Dev/Test', 'Deploy Prod', 'PR checks'],
  deploys: [],
};

/**
 * The world's deploys, dev → test → prod: Deploy Dev/Test's run 9005 and Deploy Prod's 9007 are
 * among the newest runs, Terraform apply last ran days before them, and Deploy QA never ran.
 */
export const PIPELINE_DEPLOYS: PipelineDeploy[] = [
  { workflow: 'Deploy Dev/Test', environment: 'dev, test', run: PIPELINE_RUNS[2] ?? null },
  { workflow: 'Deploy QA', environment: 'qa', run: null },
  {
    workflow: 'Terraform apply',
    environment: 'staging',
    run: {
      ...pipelineRun('8601', 'Terraform apply', 'Queue for order exports', 'main', '06:12', 4, {
        trigger: 'push',
        actor: 'bob',
      }),
      createdAt: '2026-09-20T06:12:00Z',
      startedAt: '2026-09-20T06:12:00Z',
      finishedAt: '2026-09-20T06:16:00Z',
    },
  },
  {
    workflow: 'Deploy Prod',
    environment: 'production',
    run: PIPELINE_RUNS[0] === undefined ? null : { ...PIPELINE_RUNS[0], stages: [] },
  },
];

/** `pipeline list`'s answer. */
export const pipelineListAnswer = (data: PipelineListData = PIPELINE_LIST): Answer => ({
  kind: 'result',
  id: 'pipelines#0',
  command: 'pipeline list',
  reply: { ok: true, data },
});

/** What the world holds beyond the runs the list reads (`pipelinesReplies`). */
export type PipelinesWorld = {
  runs?: readonly PipelineRun[];
  /** Runs older than the ones the list reads. `pipeline show` still finds each by its id. */
  older?: readonly PipelineRun[];
  inspect?: (r: PipelineRun) => Inspection;
  log?: string;
  /** The workflows `pipeline workflows` lists (default: `DISPATCH_WORKFLOWS`). */
  dispatchable?: readonly DispatchWorkflow[];
  /** The deploys the overview's first page names (default: none). */
  deploys?: readonly PipelineDeploy[];
};

/** The world's workflows run by hand: Deploy Dev/Test with its inputs; PR checks is not. */
export const DISPATCH_WORKFLOWS: DispatchWorkflow[] = [
  {
    name: 'Deploy Dev/Test',
    file: 'deploy.yml',
    dispatch: true,
    inputs: [
      {
        name: 'environment',
        description: 'Where it deploys',
        type: 'choice',
        required: true,
        default: 'dev',
        options: ['dev', 'test'],
      },
      {
        name: 'dry-run',
        description: 'Plan only',
        type: 'boolean',
        required: false,
        default: 'false',
        options: [],
      },
      {
        name: 'version',
        description: 'The build to deploy (default: the newest)',
        type: 'string',
        required: false,
        default: null,
        options: [],
      },
    ],
  },
  { name: 'Deploy Prod', file: 'deploy-prod.yml', dispatch: true, inputs: [] },
  { name: 'PR checks', file: 'pr.yml', dispatch: false, inputs: [] },
];

/** A flag's value in an argv (`--limit 30`); undefined when not given. */
const flagOf = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);

  return at < 0 ? undefined : argv[at + 1];
};

/**
 * Answers the Pipelines screen's reads from the world: `list` (one workflow's runs with
 * `--workflow`, a later page with `--page`: the first page is `runs`, the next ones `older` in
 * `--limit`s; a workflow's runs are both filtered, paged by `--limit`), `show`, `inspect`, `log`,
 * `workflows` and `settings get prodEnvironments`; and the live facts it follows, `session list`
 * and `factory status`, as none. A read it does not know stays asked.
 */
export const pipelinesReplies =
  (o: PipelinesWorld = {}): Replies =>
  ({ id, argv }) => {
    const runs = o.runs ?? PIPELINE_RUNS;
    const [noun, verb, run] = argv;
    const deployed = (o.deploys ?? []).flatMap((d) => (d.run === null ? [] : [d.run]));
    const r = [...runs, ...(o.older ?? []), ...deployed].find((x) => x.id === run);

    if (noun === 'pipeline' && verb === 'list') {
      const workflow = flagOf(argv, '--workflow');
      const page = Number(flagOf(argv, '--page') ?? '1');
      const limit = Number(flagOf(argv, '--limit') ?? '30');
      const older = o.older ?? [];
      const pageOf = (all: readonly PipelineRun[]) => all.slice((page - 1) * limit, page * limit);
      let listed: readonly PipelineRun[];

      if (workflow !== undefined)
        listed = pageOf([...runs, ...older].filter((x) => x.pipeline === workflow));
      else listed = page === 1 ? runs : older.slice((page - 2) * limit, (page - 1) * limit);

      return {
        ...pipelineListAnswer({
          ...PIPELINE_LIST,
          runs: listed.map((x) => ({ ...x, stages: [] })),
          deploys: workflow === undefined && page === 1 ? [...(o.deploys ?? [])] : [],
        }),
        id,
      };
    }
    if (noun === 'pipeline' && verb === 'workflows')
      return {
        kind: 'result',
        id,
        command: 'pipeline workflows',
        reply: {
          ok: true,
          data: {
            provider: 'github-actions',
            source: 'o/r',
            ref: flagOf(argv, '--ref') ?? null,
            workflows: [...(o.dispatchable ?? DISPATCH_WORKFLOWS)],
            note: null,
          },
        },
      };
    if (noun === 'pipeline' && verb === 'show' && r !== undefined)
      return { kind: 'result', id, command: 'pipeline show', reply: { ok: true, data: r } };
    if (noun === 'pipeline' && verb === 'inspect' && r !== undefined)
      return {
        kind: 'result',
        id,
        command: 'pipeline inspect',
        reply: { ok: true, data: (o.inspect ?? inspectionOf)(r) },
      };
    if (noun === 'pipeline' && verb === 'log' && run !== undefined) {
      const job = argv[argv.indexOf('--job') + 1] ?? '';

      return {
        kind: 'result',
        id,
        command: 'pipeline log',
        reply: {
          ok: true,
          data: { run, job, log: job === '90033' ? (o.log ?? LOG_90033) : '' },
        },
      };
    }
    if (noun === 'session' && verb === 'list')
      return {
        kind: 'result',
        id,
        command: 'session list',
        reply: { ok: true, data: { sessions: [] } },
      };
    if (noun === 'factory' && verb === 'status')
      return {
        kind: 'result',
        id,
        command: 'factory status',
        reply: { ok: true, data: { runs: [] } },
      };
    if (noun === 'settings' && verb === 'get')
      return {
        kind: 'result',
        id,
        command: 'settings get',
        reply: {
          ok: true,
          data: { key: 'prodEnvironments', value: [], layer: 'core', lowered: null, problems: [] },
        },
      };

    return undefined;
  };

/** Each write a fake port saw, in order. */
export type PipelinesWrite =
  | { kind: 'control'; id: string; attempt: number; control: RunControl }
  | { kind: 'approve'; run: string; gate: Gate }
  | { kind: 'dispatch'; file: string; ref: string; inputs: Readonly<Record<string, string>> };

/**
 * The `Pipelines` port in memory on the world. Reads answer from the world. It records each
 * write, which answers `ok` or the error in `refuse`.
 */
export const fakePipelines = (
  o: {
    runs?: PipelineRun[];
    inspect?: (r: PipelineRun) => Inspection;
    logs?: Readonly<Record<string, string | null>>;
    refuse?: { code: string; message: string };
    /** The workflows' files `workflowFiles` answers (default: none). */
    files?: CiWorkflowFile[];
  } = {},
): Pipelines & { writes: PipelinesWrite[]; sources: PipelineSource[] } => {
  const runs = o.runs ?? PIPELINE_RUNS;
  const writes: PipelinesWrite[] = [];
  const sources: PipelineSource[] = [];
  const ok = <T>(data: T): Promise<Answered<T>> => Promise.resolve({ ok: true, data });
  const find = (id: string): Answered<PipelineRun> => {
    const r = runs.find((x) => x.id === id);

    return r === undefined
      ? { ok: false, error: { code: 'not-found', message: `no run ${id}` } }
      : { ok: true, data: r };
  };
  const seen = (s: PipelineSource) => {
    sources.push(s);
  };

  return {
    writes,
    sources,
    runs: (s, limit, branch, query) => {
      seen(s);
      const page = query?.page ?? 1;

      return ok(
        runs
          .filter((r) => branch === undefined || r.branch === branch)
          .filter(
            (r) =>
              query?.workflow === undefined ||
              r.pipeline === query.workflow ||
              o.files?.find((f) => f.file === query.workflow)?.name === r.pipeline,
          )
          .slice((page - 1) * limit, page * limit)
          .map((r) => ({ ...r, stages: [] })),
      );
    },
    workflows: (s) => {
      seen(s);

      return ok([...new Set(runs.map((r) => r.pipeline))]);
    },
    workflowFiles: (s) => {
      seen(s);

      return ok([...(o.files ?? [])]);
    },
    dispatchable: (s) => {
      seen(s);

      return ok([...DISPATCH_WORKFLOWS]);
    },
    // the run it started: the world's newest run of that workflow, as GitHub would list it
    dispatch: (s, file, ref, inputs) => {
      seen(s);
      writes.push({ kind: 'dispatch', file, ref, inputs });
      if (o.refuse !== undefined) return Promise.resolve({ ok: false, error: o.refuse });
      const name = DISPATCH_WORKFLOWS.find((w) => w.file === file)?.name;

      return ok(runs.find((r) => r.pipeline === name) ?? null);
    },
    run: (s, id) => {
      seen(s);

      return Promise.resolve(find(id));
    },
    inspect: (s, id) => {
      seen(s);
      const r = find(id);

      return Promise.resolve(r.ok ? { ok: true, data: (o.inspect ?? inspectionOf)(r.data) } : r);
    },
    log: (s, _run, job) => {
      seen(s);

      return ok(o.logs?.[job] ?? (job === '90033' ? LOG_90033 : null));
    },
    control: (s, id, attempt, control) => {
      seen(s);
      writes.push({ kind: 'control', id, attempt, control });

      return Promise.resolve(
        o.refuse === undefined ? { ok: true, data: null } : { ok: false, error: o.refuse },
      );
    },
    approve: (s, run, gate) => {
      seen(s);
      writes.push({ kind: 'approve', run, gate });

      return Promise.resolve(
        o.refuse === undefined ? { ok: true, data: null } : { ok: false, error: o.refuse },
      );
    },
    me: (s) => {
      seen(s);

      return ok(PIPELINES_ME);
    },
  };
};

/** The pane as the Editor gives it, wide enough for the summary beside the runs. */
export const PIPELINES_SIZE = { width: 1400, height: 340 };

export type PipelinesDrive = Drive<Node>;

/**
 * The Pipelines screen in the pane slot at `PIPELINES_NOW`. `params` holds the shown folder's
 * `root` and `branch`. `answer()` answers from the world.
 */
export const drivePipelines = (
  params: Record<string, string> = { root: '/r/app', branch: 'main' },
  o: { size?: { width: number; height: number }; answer?: PipelinesWorld } = {},
): PipelinesDrive =>
  driveScreen(pipelinesScreen, {
    params,
    size: o.size ?? PIPELINES_SIZE,
    now: PIPELINES_NOW,
    replies: pipelinesReplies(o.answer),
  });

/** The contract's Pipelines trees (`packages/ui/contract/trees/pipelines-*.json`). */
export const pipelineTrees = (): Record<string, Node> => {
  const opened = () => drivePipelines().answer();

  return {
    // the main checkout shows All, grouped. The failed run is selected, its summary beside the
    // runs.
    'pipelines-overview': opened().keys('ö', 'ö', 'ö').answer().tree,
    // before `pipeline list` answers
    'pipelines-reading': drivePipelines().tree,
    // a story's worktree with no runs yet, This workspace picked (⇧Tab from All). It says so,
    // and ⏎ shows All.
    'pipelines-workspace-empty': drivePipelines({
      root: '/r/app-wt/12',
      branch: 'card/12-saved-carts',
    })
      .answer()
      .keys('<S-Tab>')
      .answer().tree,
    // Deploys pinned first: each deploy's newest run, older than the runs read or never run
    'pipelines-deploys': drivePipelines(undefined, {
      answer: { deploys: PIPELINE_DEPLOYS },
    }).answer().tree,
    // one workflow's history, newest first, no groups
    'pipelines-history': opened()
      .send({
        kind: 'choice',
        menu: 'pipelines:workflows',
        row: 'PR checks',
      })
      .answer().tree,
    // the narrow pane has no summary
    'pipelines-narrow': drivePipelines(undefined, { size: { width: 760, height: 340 } })
      .answer()
      .keys('ö', 'ö', 'ö')
      .answer().tree,
    // run 103 entered shows its graph with the failed job selected
    'pipelines-graph': opened().keys('ö', 'ö', 'ö').answer().keys('<CR>').answer().tree,
    // its log at the failure, the evidence beside it
    'pipelines-log': opened()
      .keys('ö', 'ö', 'ö')
      .answer()
      .keys('<CR>')
      .answer()
      .keys('<CR>')
      .answer().tree,
  };
};
