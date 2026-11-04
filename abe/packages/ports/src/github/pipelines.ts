/**
 * Pipelines on GitHub Actions through `gh` (REST through `gh api`, as the person): the repo's
 * runs, a run with its jobs as stages and the pending deployments its waiting jobs stand at, an
 * attempt's jobs, steps, graph (the workflow file at the run's own revision) and artifacts, a
 * job's log, the reruns, the cancel and an approval. Azure Pipelines is `pipelines-azure.ts`;
 * `pipelinesPort` picks by the source. GitHub's answers are read with zod here; what they mean is
 * core's (`githubStatus`, `githubTrigger`, `runNameOf`, `githubGraph`).
 *
 * A write reads the run again first: another attempt than the one inspected is `attempt-changed`,
 * a rerun of a run still going `still-running`; a write whose answer was lost is read once more
 * and, still not seen to have happened, said `uncertain` and never sent again by itself.
 */
import {
  type Answered,
  type Artifact,
  type CiWorkflowFile,
  type DispatchWorkflow,
  dispatchInputsOf,
  type Gate,
  githubGraph,
  githubStatus,
  githubTrigger,
  type Inspection,
  isOver,
  type JobBox,
  type PipelineRun,
  type Pipelines,
  type PipelineSource,
  type RunControl,
  runNameOf,
  type RunStage,
} from '@abe/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { adoPipelines, type AdoPipelinesOptions } from '../azure-devops/pipelines-azure';
import { type Gh, ghRunner, readGh } from './gh';
import { type Env } from '../mac/locations';

const Login = z.object({ login: z.string() }).nullable().optional();

const RestRun = z.object({
  id: z.number(),
  name: z.string().nullable().optional(),
  run_number: z.number(),
  display_title: z.string().nullable().optional(),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  event: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  created_at: z.string(),
  run_started_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  html_url: z.string(),
  run_attempt: z.number().optional(),
  /** The workflow's id in the catalog. */
  workflow_id: z.number().optional(),
  path: z.string().optional(),
  actor: Login,
  triggering_actor: Login,
  pull_requests: z
    .array(z.object({ number: z.number() }))
    .nullable()
    .optional(),
});
type RestRun = z.infer<typeof RestRun>;

const Runs = z.object({ workflow_runs: z.array(RestRun) });

const RestStep = z.object({
  name: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
});
const RestJob = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  steps: z.array(RestStep).optional(),
});
const Jobs = z.object({ jobs: z.array(RestJob) });

const Pending = z.array(
  z.object({
    environment: z.object({ id: z.number(), name: z.string() }),
    current_user_can_approve: z.boolean().optional(),
  }),
);

const Workflows = z.object({
  workflows: z.array(
    z.object({
      /** What a run names its workflow by (`workflow_id`); older answers in tests name none. */
      id: z.number().optional(),
      name: z.string(),
      /** `.github/workflows/deploy.yml`; older answers in tests name none. */
      path: z.string().optional(),
      state: z.string().optional(),
    }),
  ),
});

/** A workflow of the catalog: its id, name, file's path and whether GitHub still runs it. */
type Catalogued = { id: number | undefined; name: string; path: string; active: boolean };

/** A parsed workflow file; undefined when it is not YAML. */
const parsed = (text: Answered<string>): unknown => {
  if (!text.ok) return undefined;
  try {
    return parseYaml(text.data);
  } catch {
    return undefined;
  }
};

/** How many times, a second apart, a workflow run by hand is looked for before giving up. */
const DISPATCH_POLLS = 6;

const Artifacts = z.object({
  artifacts: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      expired: z.boolean(),
      workflow_run: z.object({ head_sha: z.string().optional() }).nullable().optional(),
    }),
  ),
});

/** A time GitHub gives; empty and its zero time (not started) are none. */
const time = (t: string | null | undefined): string | null =>
  t === null || t === undefined || t === '' || t.startsWith('0001-') ? null : t;

/** A run's file in the repo (`.github/workflows/deploy.yml`, a dynamic one's `dynamic/…`). */
const fileOfRun = (r: RestRun): string => (r.path ?? '').replace(/@[^@]*$/, '');

/**
 * The workflow a run is of, as the catalog names it: by its id, else by its file. A run's own
 * `name` is its `run-name:` where the workflow sets one, so only one the catalog lacks goes by it.
 */
const workflowOf = (r: RestRun, catalog: readonly Catalogued[]): string => {
  const file = fileOfRun(r);
  const known =
    catalog.find((w) => w.id !== undefined && w.id === r.workflow_id) ??
    (file === '' ? undefined : catalog.find((w) => w.path === file));

  return known?.name ?? r.name ?? file.split('/').at(-1) ?? '';
};

/** GitHub's REST run as core's one shape (its stages unread), its workflow named by `catalog`. */
export const runOfRest = (r: RestRun, catalog: readonly Catalogued[] = []): PipelineRun => {
  const status = githubStatus(r.status, r.conclusion);
  const pipeline = workflowOf(r, catalog);
  const { title, name } = runNameOf(pipeline, r.display_title ?? '');

  return {
    id: String(r.id),
    number: String(r.run_number),
    pipeline,
    name,
    title,
    branch: r.head_branch ?? '',
    trigger: githubTrigger(r.event),
    actor: r.triggering_actor?.login ?? r.actor?.login ?? null,
    status,
    createdAt: r.created_at,
    startedAt: time(r.run_started_at) ?? r.created_at,
    finishedAt: isOver(status) ? time(r.updated_at) : null,
    url: r.html_url,
    stages: [],
    sha: r.head_sha,
    attempt: r.run_attempt ?? 1,
    pr: r.pull_requests?.[0]?.number ?? null,
  };
};

const jobOf = (j: z.infer<typeof RestJob>): JobBox => ({
  id: String(j.id),
  name: j.name,
  status: githubStatus(j.status, j.conclusion),
  url: j.html_url ?? '',
  startedAt: time(j.started_at),
  finishedAt: time(j.completed_at),
  runner: j.labels?.[0] ?? null,
  group: null,
  steps: (j.steps ?? []).map((s) => ({
    name: s.name,
    status: githubStatus(s.status, s.conclusion),
    startedAt: time(s.started_at),
    finishedAt: time(s.completed_at),
  })),
});

/** How long the workflow catalog is kept. */
const CATALOG_MS = 5 * 60_000;

/** How many workflow files are read at once. */
const FILES_AT_ONCE = 6;

/** The line upload-artifact writes in its job's log, naming the artifact it uploaded. */
const UPLOADED = 'Artifact download URL: ';

/** What a GitHub source is: its repo, else a refusal (an Azure source asked here). */
const repoOf = (s: PipelineSource): string | undefined =>
  s.provider === 'github-actions' ? s.repo : undefined;

const notGithub: Answered<never> = {
  ok: false,
  error: { code: 'bad-source', message: 'not a GitHub Actions source' },
};

/**
 * `waitMs`: between the looks for a run started by hand (tests shorten it).
 */
export const ghPipelines = (gh: Gh, o: { waitMs?: number } = {}): Pipelines => {
  const waitMs = o.waitMs ?? 1_000;
  const json = async <T extends z.ZodType>(
    schema: T,
    args: readonly string[],
  ): Promise<Answered<z.output<T>>> => {
    const out = await gh(args);

    return out.ok ? readGh(schema, out.stdout) : out;
  };
  const api = <T extends z.ZodType>(schema: T, path: string) => json(schema, ['api', path]);
  const raw = async (args: readonly string[]): Promise<Answered<string>> => {
    const out = await gh(args);

    return out.ok ? { ok: true, data: out.stdout } : out;
  };
  /** Each job's artifact upload URLs (an ended job's log never changes): at most 256 jobs kept. */
  const uploads = new Map<string, string[]>();
  /** The writes sent whose outcome was not seen (`repo run attempt control`). */
  const sent = new Set<string>();
  /** Your login, once read. */
  let login: string | undefined;
  /** Workflow files at a revision (`repo sha path`): at most 64 kept. */
  const files = new Map<string, string>();
  /** The workflow catalog by repo (a read still out too), read again after `CATALOG_MS`. */
  const catalogs = new Map<string, { at: number; list: Promise<Answered<Catalogued[]>> }>();
  /** The workflows run by hand and their inputs, by `repo ref`: a branch moves, so a minute. */
  const dispatchables = new Map<string, { at: number; list: DispatchWorkflow[] }>();
  /** Each repo's workflows with their files' text on the default branch, read as the catalog. */
  const texts = new Map<string, { at: number; list: CiWorkflowFile[] }>();

  const readCatalog = async (repo: string): Promise<Answered<Catalogued[]>> => {
    const read = await api(Workflows, `repos/${repo}/actions/workflows?per_page=100`);

    return read.ok
      ? {
          ok: true,
          data: read.data.workflows.map((w) => ({
            id: w.id,
            name: w.name,
            path: w.path ?? '',
            active: w.state === undefined || w.state === 'active',
          })),
        }
      : read;
  };
  // the catalog changes with a new workflow file: read again every few minutes, not each list;
  // the runs and the workflows asked at once share one read (a failed one is read again next time)
  const catalogOf = (repo: string): Promise<Answered<Catalogued[]>> => {
    const had = catalogs.get(repo);

    if (had !== undefined && Date.now() - had.at < CATALOG_MS) return had.list;
    const kept = { at: Date.now(), list: readCatalog(repo) };

    catalogs.set(repo, kept);
    void kept.list.then((read) => {
      if (!read.ok && catalogs.get(repo) === kept) catalogs.delete(repo);
    });

    return kept.list;
  };

  /** The catalog runs are named by; unread, none (each run then as GitHub names it). */
  const namesOf = async (repo: string): Promise<readonly Catalogued[]> => {
    const catalog = await catalogOf(repo);

    return catalog.ok ? catalog.data : [];
  };

  /** GitHub's runs as core's, each named by its workflow in the catalog. */
  const runsOf = async (repo: string, rest: readonly RestRun[]): Promise<PipelineRun[]> => {
    if (rest.length === 0) return [];
    const known = await namesOf(repo);

    return rest.map((r) => runOfRest(r, known));
  };

  /** A workflow's file name (`deploy.yml`), as `gh` and the REST take it, from its name or file. */
  const fileOf = async (repo: string, workflow: string): Promise<Answered<string>> => {
    if (/\.ya?ml$/i.test(workflow)) return { ok: true, data: workflow.split('/').at(-1) ?? '' };
    const catalog = await catalogOf(repo);

    if (!catalog.ok) return catalog;
    const found =
      catalog.data.find((w) => w.name === workflow) ??
      catalog.data.find((w) => w.name.toLowerCase() === workflow.toLowerCase());
    const file = found?.path.split('/').at(-1);

    return file === undefined || file === ''
      ? { ok: false, error: { code: 'not-found', message: `${repo} has no workflow ${workflow}` } }
      : { ok: true, data: file };
  };

  const jobsOf = async (repo: string, id: string, attempt: number) => {
    const out: z.infer<typeof RestJob>[] = [];

    for (let page = 1; ; page += 1) {
      const read = await api(
        Jobs,
        `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      );

      if (!read.ok) return read;
      out.push(...read.data.jobs);
      if (read.data.jobs.length < 100) return { ok: true as const, data: out };
    }
  };

  const uploadedBy = async (repo: string, job: string): Promise<string[] | undefined> => {
    const key = `${repo} ${job}`;
    const had = uploads.get(key);

    if (had !== undefined) return had;
    const log = await raw(['api', `repos/${repo}/actions/jobs/${job}/logs`]);

    if (!log.ok) return undefined;
    const urls = log.data
      .split('\n')
      .flatMap((l) => {
        const at = l.indexOf(UPLOADED);

        return at < 0 ? [] : [l.slice(at + UPLOADED.length).trim()];
      })
      .filter((u) => u.length <= 1024)
      .slice(0, 256);

    if (uploads.size >= 256) uploads.clear();
    uploads.set(key, urls);

    return urls;
  };

  const run = async (repo: string, id: string): Promise<Answered<PipelineRun>> => {
    const read = await api(RestRun, `repos/${repo}/actions/runs/${id}`);

    if (!read.ok) return read;
    const r = runOfRest(read.data, await namesOf(repo));
    const jobs = await api(Jobs, `repos/${repo}/actions/runs/${id}/jobs?per_page=100`);

    if (!jobs.ok) return jobs;
    const stages: RunStage[] = jobs.data.jobs.map((j) => ({
      name: j.name,
      status: githubStatus(j.status, j.conclusion),
      startedAt: time(j.started_at),
      finishedAt: time(j.completed_at),
      gate: null,
    }));
    const waiting = stages.flatMap((s, i) => (s.status === 'waiting' ? [i] : []));

    if (waiting.length === 0 && r.status !== 'waiting') return { ok: true, data: { ...r, stages } };
    const pending = await api(Pending, `repos/${repo}/actions/runs/${id}/pending_deployments`);

    if (!pending.ok) return pending;
    const gates = pending.data.map((p): Gate => ({
      id: String(p.environment.id),
      kind: 'environment',
      environment: p.environment.name,
      since: null,
      canApprove: p.current_user_can_approve ?? false,
    }));
    const [only] = waiting;
    const [gate] = gates;

    const one = only === undefined ? undefined : stages[only];

    if (waiting.length === 1 && gates.length === 1 && one !== undefined && gate !== undefined)
      stages[only ?? 0] = { ...one, gate };
    else
      // pending deployments name no job: each is an environment fact of its own, never matched
      // to a job by the order of two answers
      for (const g of gates)
        stages.push({
          name: `Deployment approval: ${g.environment}`,
          status: 'waiting',
          startedAt: null,
          finishedAt: null,
          gate: g,
        });

    return { ok: true, data: { ...r, stages } };
  };

  const inspect = async (
    repo: string,
    id: string,
    asked: number | undefined,
  ): Promise<Answered<Inspection>> => {
    const base = `repos/${repo}/actions/runs/${id}`;
    const read = await api(RestRun, asked === undefined ? base : `${base}/attempts/${asked}`);

    if (!read.ok) return read;
    const r = read.data;
    const attempt = r.run_attempt ?? 1;
    const jobs = await jobsOf(repo, id, attempt);

    if (!jobs.ok) return jobs;
    const boxes = jobs.data.map(jobOf);
    const path = fileOfRun(r);
    // a file at a revision never changes: read once (a failed read again next time)
    const at = async (file: string): Promise<Answered<string>> => {
      const key = `${repo} ${r.head_sha} ${file}`;
      const had = files.get(key);

      if (had !== undefined) return { ok: true, data: had };
      const read = await raw([
        'api',
        `repos/${repo}/contents/${file}?ref=${r.head_sha}`,
        '-H',
        'Accept: application/vnd.github.raw+json',
      ]);

      if (read.ok) {
        if (files.size >= 64) files.clear();
        files.set(key, read.data);
      }

      return read;
    };
    const workflow = path === '' ? undefined : parsed(await at(path));
    // a called workflow (`./.github/workflows/x.yml`), read once each
    const called = new Map<string, unknown>();

    for (const file of calledFiles(workflow)) called.set(file, parsed(await at(file)));
    const graph =
      workflow === undefined
        ? { edges: null, partial: false, groups: {} }
        : githubGraph(
            workflow,
            boxes.map((j) => ({ id: j.id, name: j.name })),
            (file) => called.get(file),
            r.event === 'pull_request' || r.event === 'pull_request_target',
          );
    const artifacts: Artifact[] = [];
    let artifactsNote: string | null = null;

    for (let page = 1; ; page += 1) {
      const list = await api(Artifacts, `${base}/artifacts?per_page=100&page=${page}`);

      if (!list.ok) {
        artifactsNote = `Artifacts unavailable: ${list.error.message}`;
        break;
      }
      for (const a of list.data.artifacts)
        artifacts.push({
          id: String(a.id),
          name: a.name,
          url: `https://github.com/${repo}/actions/runs/${id}/artifacts/${a.id}`,
          expired: a.expired,
          sha: a.workflow_run?.head_sha ?? '',
          job: null,
          attempt: null,
        });
      if (list.data.artifacts.length < 100) break;
    }
    // upload-artifact writes its artifact's exact URL in the uploading job's log: one job of this
    // attempt naming it is stronger evidence than names or times
    if (artifacts.length > 0) {
      const named = new Map<string, string[]>();

      for (const j of boxes)
        if (j.status === 'passed' || j.status === 'failed' || j.status === 'cancelled') {
          const urls = await uploadedBy(repo, j.id);

          if (urls !== undefined) named.set(j.id, urls);
        }
      for (const a of artifacts) {
        const by = [...named].filter(([, urls]) => urls.includes(a.url)).map(([job]) => job);
        const [job] = by;

        if (by.length === 1 && job !== undefined && a.sha === r.head_sha) {
          a.job = job;
          a.attempt = attempt;
        }
      }
    }

    return {
      ok: true,
      data: {
        repo,
        run: id,
        attempt,
        sha: r.head_sha,
        branch: r.head_branch ?? '',
        workflow: r.path ?? '',
        jobs: boxes.map((j) => ({ ...j, group: graph.groups[j.id] ?? null })),
        edges: graph.edges,
        partial: graph.partial,
        artifacts,
        artifactsNote,
      },
    };
  };

  const control = async (
    repo: string,
    id: string,
    attempt: number,
    what: RunControl,
  ): Promise<Answered<null>> => {
    const base = `repos/${repo}/actions/runs/${id}`;
    // read again before any write: another attempt or a run still going is refused
    const now = await api(RestRun, base);

    if (!now.ok) return now;
    if ((now.data.run_attempt ?? 1) !== attempt)
      return {
        ok: false,
        error: {
          code: 'attempt-changed',
          message: `run ${id} is on attempt ${now.data.run_attempt ?? 1} now, not ${attempt}: read it again before acting`,
        },
      };
    const cancel = what === 'cancel';
    const over = now.data.status === 'completed';

    if (cancel && over) return { ok: true, data: null };
    if (!cancel && !over)
      return {
        ok: false,
        error: { code: 'still-running', message: `run ${id} is still running: cancel it or wait` },
      };
    const key = `${repo} ${id} ${attempt} ${what}`;

    if (sent.has(key))
      return {
        ok: false,
        error: {
          code: 'uncertain',
          message: `run ${id} was asked to ${what} already and has not moved yet: read it again in a moment`,
        },
      };
    const suffix = { cancel: 'cancel', 'rerun-failed': 'rerun-failed-jobs', rerun: 'rerun' }[what];
    const wrote = await gh(['api', '--method', 'POST', `${base}/${suffix}`]);

    if (wrote.ok) {
      sent.add(key);

      return { ok: true, data: null };
    }
    // GitHub's own refusal is said as it is; a lost answer is read once more
    // GitHub's own refusal (`HTTP 4xx`: cannot be rerun, not allowed) is said as it is, never
    // taken for a lost answer: nothing happened, so a later try may send it again
    if (
      ['auth', 'not-found', 'rate-limited'].includes(wrote.error.code) ||
      /HTTP 4\d\d/.test(wrote.error.message)
    )
      return wrote;
    const again = await api(RestRun, base);
    const happened =
      again.ok &&
      (cancel ? again.data.status === 'completed' : (again.data.run_attempt ?? 1) > attempt);

    if (happened) return { ok: true, data: null };
    sent.add(key);

    return {
      ok: false,
      error: {
        code: 'uncertain',
        message: `outcome uncertain; run ${id} read again, not resent: ${wrote.error.message}`,
      },
    };
  };

  const approve = async (repo: string, id: string, gate: Gate): Promise<Answered<null>> => {
    const at = `repos/${repo}/actions/runs/${id}/pending_deployments`;
    const pending = await api(Pending, at);

    if (!pending.ok) return pending;
    const now = pending.data.find((p) => p.environment.name === gate.environment);

    if (now === undefined)
      return {
        ok: false,
        error: {
          code: 'no-gate',
          message: `run ${id} waits for no approval on ${gate.environment}`,
        },
      };
    if (now.current_user_can_approve !== true)
      return {
        ok: false,
        error: {
          code: 'not-yours',
          message: `you may not approve deployments to ${gate.environment}`,
        },
      };
    const wrote = await gh(
      ['api', '-X', 'POST', at, '--input', '-'],
      JSON.stringify({ environment_ids: [now.environment.id], state: 'approved', comment: '' }),
    );

    return wrote.ok ? { ok: true, data: null } : wrote;
  };

  const github = <T>(s: PipelineSource, then: (repo: string) => Promise<Answered<T>>) => {
    const repo = repoOf(s);

    return repo === undefined ? Promise.resolve(notGithub) : then(repo);
  };

  /** The runs of one workflow (`actions/workflows/<file>/runs`), else of every one. */
  const runsPath = async (
    repo: string,
    workflow: string | undefined,
  ): Promise<Answered<string>> => {
    if (workflow === undefined) return { ok: true, data: `repos/${repo}/actions/runs` };
    const file = await fileOf(repo, workflow);

    return file.ok
      ? { ok: true, data: `repos/${repo}/actions/workflows/${encodeURIComponent(file.data)}/runs` }
      : file;
  };

  const dispatchable = async (
    repo: string,
    ref: string | undefined,
  ): Promise<Answered<DispatchWorkflow[]>> => {
    const key = `${repo} ${ref ?? ''}`;
    const had = dispatchables.get(key);

    if (had !== undefined && Date.now() - had.at < 60_000) return { ok: true, data: had.list };
    const catalog = await catalogOf(repo);

    if (!catalog.ok) return catalog;
    const list: DispatchWorkflow[] = [];

    for (const w of catalog.data) {
      const file = w.path.split('/').at(-1) ?? '';

      if (!w.active || file === '') continue;
      // the file at the ref says whether it runs by hand there; unreadable there, it does not
      const at = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
      const doc = parsed(
        await raw([
          'api',
          `repos/${repo}/contents/${w.path}${at}`,
          '-H',
          'Accept: application/vnd.github.raw+json',
        ]),
      );
      const d = doc === undefined ? { dispatch: false, inputs: [] } : dispatchInputsOf(doc);

      list.push({ name: w.name, file, dispatch: d.dispatch, inputs: d.inputs });
    }
    if (dispatchables.size >= 64) dispatchables.clear();
    dispatchables.set(key, { at: Date.now(), list });

    return { ok: true, data: list };
  };

  // the active workflows' files on the default branch, a few at a time; one not read has no text
  const workflowFiles = async (repo: string): Promise<Answered<CiWorkflowFile[]>> => {
    const had = texts.get(repo);

    if (had !== undefined && Date.now() - had.at < CATALOG_MS) return { ok: true, data: had.list };
    const catalog = await catalogOf(repo);

    if (!catalog.ok) return catalog;
    const active = catalog.data.filter((w) => w.active && w.path !== '');
    const list: CiWorkflowFile[] = [];

    for (let i = 0; i < active.length; i += FILES_AT_ONCE)
      list.push(
        ...(await Promise.all(
          active.slice(i, i + FILES_AT_ONCE).map(async (w): Promise<CiWorkflowFile> => {
            const text = await raw([
              'api',
              `repos/${repo}/contents/${w.path}`,
              '-H',
              'Accept: application/vnd.github.raw+json',
            ]);

            return {
              name: w.name,
              file: w.path.split('/').at(-1) ?? '',
              text: text.ok ? text.data : null,
            };
          }),
        )),
      );
    if (texts.size >= 64) texts.clear();
    texts.set(repo, { at: Date.now(), list });

    return { ok: true, data: list };
  };

  const dispatch = async (
    repo: string,
    file: string,
    ref: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<Answered<PipelineRun | null>> => {
    const sentAt = Date.now();
    const wrote = await gh([
      'workflow',
      'run',
      file,
      '--repo',
      repo,
      '--ref',
      ref,
      ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`]),
    ]);

    if (!wrote.ok) return wrote;
    // GitHub lists the run a moment later: the workflow's newest run by hand on the ref, made
    // since it was asked (yours, where your login is known)
    const at = `repos/${repo}/actions/workflows/${encodeURIComponent(file)}/runs?per_page=5&event=workflow_dispatch&branch=${encodeURIComponent(ref)}`;

    for (let i = 0; i < DISPATCH_POLLS; i += 1) {
      const read = await api(Runs, at);
      const run = read.ok
        ? (await runsOf(repo, read.data.workflow_runs)).find(
            (r) =>
              Date.parse(r.createdAt) >= sentAt - 60_000 &&
              (login === undefined || r.actor === login),
          )
        : undefined;

      if (run !== undefined) return { ok: true, data: run };
      if (i + 1 < DISPATCH_POLLS) await Bun.sleep(waitMs);
    }

    return { ok: true, data: null };
  };

  return {
    runs: (s, limit, branch, query) =>
      github(s, async (repo) => {
        const base = await runsPath(repo, query?.workflow);

        if (!base.ok) return base;
        const page = Math.max(1, Math.floor(query?.page ?? 1));
        const on = branch === undefined ? '' : `&branch=${encodeURIComponent(branch)}`;
        const read = await api(
          Runs,
          `${base.data}?per_page=${Math.max(1, Math.min(100, limit))}${on}${page > 1 ? `&page=${page}` : ''}`,
        );

        return read.ok ? { ok: true, data: await runsOf(repo, read.data.workflow_runs) } : read;
      }),
    workflows: (s) =>
      github(s, async (repo) => {
        const catalog = await catalogOf(repo);

        return catalog.ok ? { ok: true, data: catalog.data.map((w) => w.name) } : catalog;
      }),
    workflowFiles: (s) => github(s, workflowFiles),
    dispatchable: (s, ref) => github(s, (repo) => dispatchable(repo, ref)),
    dispatch: (s, file, ref, inputs) => github(s, (repo) => dispatch(repo, file, ref, inputs)),
    run: (s, id) => github(s, (repo) => run(repo, id)),
    inspect: (s, id, attempt) => github(s, (repo) => inspect(repo, id, attempt)),
    log: (s, _run, job) =>
      github(s, async (repo): Promise<Answered<string | null>> => {
        const log = await raw(['api', `repos/${repo}/actions/jobs/${job}/logs`]);

        if (log.ok) return log;

        // GitHub has no log for a job still going
        return log.error.code === 'not-found' ? { ok: true, data: null } : log;
      }),
    control: (s, id, attempt, what) => github(s, (repo) => control(repo, id, attempt, what)),
    approve: (s, id, gate) => github(s, (repo) => approve(repo, id, gate)),
    // read once (a failure again next time): the login does not change under a serve
    me: (s) =>
      github(s, async () => {
        if (login !== undefined) return { ok: true, data: login };
        const user = await api(z.object({ login: z.string() }), 'user');

        if (user.ok) login = user.data.login;

        return user.ok ? { ok: true, data: user.data.login } : user;
      }),
  };
};

/** The local workflows a workflow calls (`uses: ./.github/workflows/x.yml`), without the `./`. */
const calledFiles = (doc: unknown): string[] => {
  if (typeof doc !== 'object' || doc === null || !('jobs' in doc)) return [];
  const jobs: unknown = doc.jobs;

  if (typeof jobs !== 'object' || jobs === null) return [];

  return [
    ...new Set(
      Object.values(jobs).flatMap((j: unknown) => {
        const uses: unknown =
          typeof j === 'object' && j !== null && 'uses' in j ? j.uses : undefined;

        return typeof uses === 'string' && uses.startsWith('./') ? [uses.slice(2)] : [];
      }),
    ),
  ];
};

/** One Pipelines port whose every call goes to the one `by` picks then, for its source. */
export const routedPipelines = (by: (s: PipelineSource) => Pipelines): Pipelines => ({
  runs: (s, limit, branch, query) => by(s).runs(s, limit, branch, query),
  workflows: (s) => by(s).workflows(s),
  workflowFiles: (s) => by(s).workflowFiles(s),
  dispatchable: (s, ref) => by(s).dispatchable(s, ref),
  dispatch: (s, file, ref, inputs) => by(s).dispatch(s, file, ref, inputs),
  run: (s, id) => by(s).run(s, id),
  inspect: (s, id, attempt) => by(s).inspect(s, id, attempt),
  log: (s, run, job) => by(s).log(s, run, job),
  control: (s, id, attempt, what) => by(s).control(s, id, attempt, what),
  approve: (s, run, gate) => by(s).approve(s, run, gate),
  me: (s) => by(s).me(s),
});

/** GitHub's and Azure's pipelines in one port, each source to its own. */
export const pipelinesPort = (github: Pipelines, azure: Pipelines): Pipelines =>
  routedPipelines((s) => (s.provider === 'github-actions' ? github : azure));

/**
 * The person's pipelines: GitHub's through `gh` on its own login, Azure's on `az`'s token (or the
 * fake Azure DevOps at `ABE_ADO_BASE_URL`).
 */
export const pipelinesFrom = (
  env: Env,
  azure?: AdoPipelinesOptions,
  gh: Gh = ghRunner(env),
): Pipelines => pipelinesPort(ghPipelines(gh), adoPipelines(azure ?? { env }));
