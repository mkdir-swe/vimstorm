/**
 * Pipelines on Azure Pipelines: the project's builds (one in progress that a pending approval
 * holds is waiting), a build with its timeline's stages (a stage under an approval still waiting
 * has it as its gate, the build waiting then), a build's jobs as the run graph draws them
 * (the timeline's jobs under their stages, the edges from the pipeline's YAML at the build's
 * revision when its repository is an Azure Repos one), a job's log and an approval approved, all
 * on Azure DevOps' REST API with `az`'s token (`ado-rest.ts`). Run controls (rerun, cancel) are
 * GitHub's only here. Azure's answers are read with zod; what they mean is core's
 * (`azureStatus`, `azureTrigger`, `azureGraph`).
 */
import {
  type Answered,
  type AzureJobRecord,
  azureGraph,
  azureStatus,
  azureTrigger,
  type Gate,
  type Inspection,
  type JobStep,
  type PipelineRun,
  type Pipelines,
  type PipelineSource,
  type RunStage,
} from '@abe/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { adoRest } from './ado-rest';
import { azTokens, type Tokens } from './az';
import { type Env } from '../mac/locations';

const API = '7.1';
const APPROVALS_API = '7.1-preview.1';

const Build = z.object({
  id: z.number(),
  buildNumber: z.string().optional(),
  definition: z.object({ id: z.number().optional(), name: z.string().optional() }).optional(),
  sourceBranch: z.string().optional(),
  sourceVersion: z.string().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
  result: z.string().optional(),
  queueTime: z.string().optional(),
  startTime: z.string().nullable().optional(),
  finishTime: z.string().nullable().optional(),
  requestedFor: z.object({ displayName: z.string().optional() }).optional(),
  triggerInfo: z.record(z.string(), z.string()).optional(),
  _links: z.object({ web: z.object({ href: z.string() }).optional() }).optional(),
});
type Build = z.infer<typeof Build>;

const Builds = z.object({ value: z.array(Build) });

const TimelineRecord = z.object({
  id: z.string(),
  parentId: z.string().nullable().optional(),
  type: z.string(),
  name: z.string().optional(),
  identifier: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  order: z.number().nullable().optional(),
  startTime: z.string().nullable().optional(),
  finishTime: z.string().nullable().optional(),
  workerName: z.string().nullable().optional(),
  log: z.object({ id: z.number() }).nullable().optional(),
});
type TimelineRecord = z.infer<typeof TimelineRecord>;

const Timeline = z.object({ records: z.array(TimelineRecord).nullable().optional() });

const Definition = z.object({
  process: z.object({ yamlFilename: z.string().optional() }).optional(),
  repository: z.object({ id: z.string().optional(), type: z.string().optional() }).optional(),
});

/** `build/definitions?name=`: the pipelines named so (their ids filter the builds). */
const Definitions = z.object({
  value: z.array(z.object({ id: z.number(), name: z.string().optional() })),
});

const Item = z.object({ content: z.string().optional() });

/**
 * `pipelines/approvals?state=pending`: the approvals still waiting, each with the run it holds
 * (`pipeline.owner.id`, the build's id).
 */
const PendingApprovals = z.object({
  value: z.array(
    z.object({
      pipeline: z.object({ owner: z.object({ id: z.number() }).optional() }).optional(),
    }),
  ),
});

/** Get Build Log Lines: `{count, value: [line…]}`. */
const LogLines = z.union([z.object({ value: z.array(z.string()) }), z.array(z.string())]);

export type AdoPipelinesOptions = { env: Env } | { tokens: Tokens; base?: string | undefined };

const text = (v: string | null | undefined): string => v ?? '';
const maybe = (v: string | null | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : v;

/** A build as core's one shape (its stages unread). */
export const runOfBuild = (b: Build): PipelineRun => {
  const branch = text(b.sourceBranch).replace(/^refs\/heads\//, '');
  const pr = b.triggerInfo?.['pr.number'];

  return {
    id: String(b.id),
    number: text(b.buildNumber),
    pipeline: text(b.definition?.name),
    name: null,
    title: b.triggerInfo?.['ci.message'] ?? '',
    branch,
    trigger: azureTrigger(text(b.reason)),
    actor: maybe(b.requestedFor?.displayName),
    status: azureStatus(text(b.status), text(b.result)),
    createdAt: text(b.queueTime),
    startedAt: maybe(b.startTime),
    finishedAt: maybe(b.finishTime),
    url: b._links?.web?.href ?? '',
    stages: [],
    sha: text(b.sourceVersion),
    attempt: 1,
    pr: pr !== undefined && /^\d+$/.test(pr) ? Number(pr) : null,
  };
};

const order = (r: TimelineRecord) => r.order ?? Number.MAX_SAFE_INTEGER;

/** A timeline's stages in order; a stage under an approval still waiting has it as its gate. */
export const stagesOf = (records: readonly TimelineRecord[]): RunStage[] => {
  const ofType = (t: string) => records.filter((r) => r.type === t);

  return ofType('Stage')
    .sort((a, b) => order(a) - order(b))
    .map((s) => {
      const waiting = ofType('Checkpoint.Approval').find(
        (a) =>
          a.state === 'inProgress' &&
          records.some((c) => c.id === a.parentId && c.parentId === s.id),
      );
      const name = text(s.name);
      const gate: Gate | null =
        waiting === undefined
          ? null
          : {
              id: waiting.id,
              kind: 'approval',
              environment: name,
              since: maybe(waiting.startTime),
              canApprove: true,
            };

      return {
        name,
        status: gate === null ? azureStatus(text(s.state), text(s.result)) : 'waiting',
        startedAt: maybe(s.startTime),
        finishedAt: maybe(s.finishTime),
        gate,
      };
    });
};

/** A timeline job's steps: its Task records in order. */
const stepsOf = (records: readonly TimelineRecord[], job: string): JobStep[] =>
  records
    .filter((r) => r.type === 'Task' && r.parentId === job)
    .sort((a, b) => order(a) - order(b))
    .map((t) => ({
      name: text(t.name),
      status: azureStatus(text(t.state), text(t.result)),
      startedAt: maybe(t.startTime),
      finishedAt: maybe(t.finishTime),
    }));

const azureOf = (s: PipelineSource) => (s.provider === 'azure-pipelines' ? s : undefined);

const notAzure: Answered<never> = {
  ok: false,
  error: { code: 'bad-source', message: 'not an Azure Pipelines source' },
};

export const adoPipelines = (o: AdoPipelinesOptions): Pipelines => {
  const options =
    'env' in o
      ? {
          tokens: azTokens(o.env),
          base: o.env.ABE_ADO_BASE_URL === '' ? undefined : o.env.ABE_ADO_BASE_URL,
        }
      : o;
  const { send } = adoRest(options, API);
  const root = (s: { organization: string; project: string }) =>
    `${s.organization.replace(/\/+$/, '')}/${encodeURIComponent(s.project)}`;
  const buildAt = (s: { organization: string; project: string }, id: string) =>
    `${root(s)}/_apis/build/builds/${encodeURIComponent(id)}`;

  const timeline = async (s: { organization: string; project: string }, id: string) => {
    const t = await send(Timeline, { method: 'GET', url: `${buildAt(s, id)}/timeline` });

    return t.ok ? { ok: true as const, data: t.data.records ?? [] } : t;
  };

  /** The pipeline's YAML at `sha`, when its repository is an Azure Repos one; else undefined. */
  const yamlOf = async (
    s: { organization: string; project: string },
    b: Build,
  ): Promise<unknown> => {
    const id = b.definition?.id;

    if (id === undefined) return undefined;
    const d = await send(Definition, {
      method: 'GET',
      url: `${root(s)}/_apis/build/definitions/${id}`,
    });

    if (!d.ok) return undefined;
    const path = d.data.process?.yamlFilename;
    const repo = d.data.repository?.id;

    if (path === undefined || repo === undefined || d.data.repository?.type !== 'TfsGit')
      return undefined;
    const item = await send(Item, {
      method: 'GET',
      url: `${root(s)}/_apis/git/repositories/${repo}/items`,
      query: {
        path,
        'versionDescriptor.version': text(b.sourceVersion),
        'versionDescriptor.versionType': 'commit',
        includeContent: 'true',
        $format: 'json',
      },
    });

    if (!item.ok || item.data.content === undefined) return undefined;
    try {
      return parseYaml(item.data.content);
    } catch {
      return undefined;
    }
  };

  const azure = <T>(
    s: PipelineSource,
    then: (a: { organization: string; project: string }) => Promise<Answered<T>>,
  ) => {
    const a = azureOf(s);

    return a === undefined ? Promise.resolve(notAzure) : then(a);
  };

  return {
    runs: (s, limit, branch, query) =>
      azure(s, async (a) => {
        const top = Math.max(1, Math.min(100, limit));
        const page = Math.max(1, Math.floor(query?.page ?? 1));
        // one pipeline's builds: its definition's id, by its name
        let definitions: string | undefined;

        if (query?.workflow !== undefined) {
          const defs = await send(Definitions, {
            method: 'GET',
            url: `${root(a)}/_apis/build/definitions`,
            query: { name: query.workflow },
          });

          if (!defs.ok) return defs;
          const id = defs.data.value[0]?.id;

          if (id === undefined)
            return {
              ok: false,
              error: {
                code: 'not-found',
                message: `${a.project} has no pipeline ${query.workflow}`,
              },
            };
          definitions = String(id);
        }
        // Azure pages by a continuation token: the builds up to the page are read, the page kept
        const read = await send(Builds, {
          method: 'GET',
          url: `${root(a)}/_apis/build/builds`,
          query: {
            $top: String(Math.min(1_000, top * page)),
            queryOrder: 'queueTimeDescending',
            ...(branch === undefined ? {} : { branchName: `refs/heads/${branch}` }),
            ...(definitions === undefined ? {} : { definitions }),
          },
        });

        if (!read.ok) return read;
        const runs = read.data.value.map(runOfBuild).slice((page - 1) * top, page * top);

        // a build at an approval is in progress to Azure (#236): the approvals still pending say
        // which wait, read only while one runs (not to be read: the builds as they are); other
        // checks (an exclusive lock, business hours) are not approvals and stay running
        if (!runs.some((r) => r.status === 'running')) return { ok: true, data: runs };
        const pending = await send(PendingApprovals, {
          method: 'GET',
          url: `${root(a)}/_apis/pipelines/approvals`,
          query: { 'api-version': APPROVALS_API, state: 'pending', top: '200' },
        });
        const held = new Set(
          pending.ok ? pending.data.value.flatMap((x) => x.pipeline?.owner?.id ?? []) : [],
        );

        return {
          ok: true,
          data: runs.map((r) =>
            r.status === 'running' && held.has(Number(r.id)) ? { ...r, status: 'waiting' } : r,
          ),
        };
      }),
    workflows: (s) => azure(s, () => Promise.resolve({ ok: true, data: [] })),
    // the project's pipelines by name: their YAML lives in their own repos, not read here
    workflowFiles: (s) =>
      azure(s, async (a) => {
        const defs = await send(Definitions, {
          method: 'GET',
          url: `${root(a)}/_apis/build/definitions`,
          query: {},
        });

        return defs.ok
          ? {
              ok: true,
              data: defs.data.value.flatMap((d) =>
                d.name === undefined ? [] : [{ name: d.name, file: '', text: null }],
              ),
            }
          : defs;
      }),
    // a pipeline run by hand (`az pipelines run --parameters`) is not here yet: GitHub's only
    dispatchable: (s) => azure(s, () => Promise.resolve({ ok: true, data: [] })),
    dispatch: (s) =>
      azure(s, () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'unsupported',
            message:
              'Running a pipeline by hand is GitHub Actions only for now: queue it on its page',
          },
        }),
      ),
    run: (s, id) =>
      azure(s, async (a) => {
        const b = await send(Build, { method: 'GET', url: buildAt(a, id) });

        if (!b.ok) return b;
        const t = await timeline(a, id);

        if (!t.ok) return t;
        const run = runOfBuild(b.data);
        const stages = stagesOf(t.data);
        // held at a stage's approval: waiting, as `runs` says it (#236)
        const waiting = run.status === 'running' && stages.some((x) => x.status === 'waiting');

        return { ok: true, data: { ...run, ...(waiting ? { status: 'waiting' } : {}), stages } };
      }),
    inspect: (s, id) =>
      azure(s, async (a): Promise<Answered<Inspection>> => {
        const b = await send(Build, { method: 'GET', url: buildAt(a, id) });

        if (!b.ok) return b;
        const t = await timeline(a, id);

        if (!t.ok) return t;
        const records = t.data;
        const run = runOfBuild(b.data);
        const byId = new Map(records.map((r) => [r.id, r]));
        const stageOf = (job: TimelineRecord): string => {
          let at = job.parentId;

          for (let i = 0; i < 4 && at !== null && at !== undefined; i += 1) {
            const r = byId.get(at);

            if (r === undefined) break;
            if (r.type === 'Stage')
              return text(r.identifier) === '' ? text(r.name) : text(r.identifier);
            at = r.parentId;
          }

          return '';
        };
        const jobs = records.filter((r) => r.type === 'Job');
        const graphJobs: AzureJobRecord[] = jobs.map((r) => ({
          id: r.id,
          name: text(r.name),
          identifier: text(r.identifier),
          stage: stageOf(r),
        }));
        const graph = azureGraph(await yamlOf(a, b.data), graphJobs);

        return {
          ok: true,
          data: {
            repo: a.project,
            run: run.id,
            attempt: 1,
            sha: run.sha,
            branch: run.branch,
            workflow: run.pipeline,
            jobs: jobs.map((r) => ({
              id: r.id,
              name: text(r.name),
              status: azureStatus(text(r.state), text(r.result)),
              url: run.url,
              startedAt: maybe(r.startTime),
              finishedAt: maybe(r.finishTime),
              runner: maybe(r.workerName),
              group: graph.groups[r.id] ?? null,
              steps: stepsOf(records, r.id),
            })),
            edges: graph.edges,
            partial: graph.partial,
            artifacts: [],
            artifactsNote: 'Artifacts are not read for Azure Pipelines',
          },
        };
      }),
    log: (s, run, job) =>
      azure(s, async (a) => {
        const t = await timeline(a, run);

        if (!t.ok) return t;
        const record = t.data.find((r) => r.type === 'Job' && r.id === job);

        if (record === undefined)
          return {
            ok: false,
            error: { code: 'not-found', message: `build ${run} has no job ${job} any more` },
          };
        const log = record.log?.id;

        if (log === undefined) return { ok: true, data: null };
        const lines = await send(LogLines, {
          method: 'GET',
          url: `${buildAt(a, run)}/logs/${log}`,
        });

        if (!lines.ok) return lines;

        return {
          ok: true,
          data: (Array.isArray(lines.data) ? lines.data : lines.data.value).join('\n'),
        };
      }),
    control: (s) =>
      azure(s, () =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'unsupported',
            message:
              'Run controls are unavailable for Azure Pipelines: rerun or cancel it on its page',
          },
        }),
      ),
    approve: (s, _run, gate) =>
      azure(s, async (a) => {
        if (gate.kind !== 'approval')
          return {
            ok: false,
            error: { code: 'bad-gate', message: `${gate.environment} is no Azure approval` },
          };
        const done = await send(z.unknown(), {
          method: 'PATCH',
          url: `${root(a)}/_apis/pipelines/approvals`,
          query: { 'api-version': APPROVALS_API },
          body: [{ approvalId: gate.id, status: 'approved', comment: '' }],
        });

        return done.ok ? { ok: true, data: null } : done;
      }),
    me: (s) => azure(s, () => Promise.resolve({ ok: true, data: null })),
  };
};
