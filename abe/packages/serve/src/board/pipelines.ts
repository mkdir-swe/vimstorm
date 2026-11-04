/**
 * The Pipelines commands' handlers (`abe pipeline …`, 2.2's Pipelines tab): the runs of the
 * checkout named by `--repo` (default: where the command was typed), on the `Pipelines` port, from
 * the provider the `pipelines` setting in force there names (GitHub Actions on the checkout's
 * origin; Azure Pipelines on the `board` setting's organization and project).
 *
 * `pipeline list` also names each workflow that deploys with its newest run, however old: a busy
 * repo's pull request checks push its deploys out of the newest runs.
 *
 * Writes act on the attempt named and say why not otherwise; a prod environment's approval needs
 * `--yes` (Command mode asks it, a risky confirm with No the default). `pipeline workflows` says
 * which workflows a person may run by hand at a ref and their inputs, `pipeline run` runs one
 * (`gh workflow run`) and names its run once GitHub lists it. `pipeline fix` is Fix with
 * agent: the failed run to a Claude Code session in the Local sandbox (ADR 0020: never another
 * agent) on its card, as `session launch` starts one: on the card's own branch when the run is
 * on it, else a fix branch made from the failed revision; a card with a live session gets the fix
 * as a message instead, never a second session.
 */
import {
  type Answered,
  cardOfRunBranch,
  type CiWorkflowFile,
  deployWorkflowsOf,
  fixBranch,
  fixJobs,
  fixPrompt,
  gatesOf,
  type Handlers,
  isProd,
  newestFirst,
  type Outcome,
  type PipelineDeploy,
  type PipelineFixData,
  type PipelineRun,
  type Pipelines,
  type PipelineSource,
  refused,
  runNamed,
  SETTINGS,
} from '@abe/core';
import { githubRepoOf, isHere } from '@abe/core';
import { currentBranch, originConfigUrl, originHead } from '@abe/ports';
import { launchProfile } from '../browser/browser-profiles';
import { realPathAt, repoHere } from '../contract/here';
import { sessionReach } from '../layer/reach';
import {
  launchSettings,
  noSessions,
  on,
  placement,
  readCard,
  type SessionCtx,
} from '../session/sessions';

type PipelinesPorts = {
  /** GitHub Actions and Azure Pipelines, as the person; none: `abe pipeline` is refused. */
  pipelines: Pipelines | undefined;
  /**
   * The same as your gh login and in your az folder in force at a checkout (ADR 0025), `--repo`'s
   * when given; none: `pipelines`.
   */
  pipelinesAt?: (path: string) => Pipelines | undefined;
};

export type PipelinesCtx = SessionCtx & { ports: PipelinesPorts };

const DEFAULT_LIMIT = 30;

const noPipelines = () =>
  Promise.resolve(refused('no-pipelines', 'this abe serve was started without pipelines'));

/**
 * Where the runs of the checkout at `path` live, by the `pipelines` setting in force there; on
 * GitHub, `github`'s repo where one is given (or why none is known), else its origin's.
 */
export const sourceAt = async (
  ctx: Pick<PipelinesCtx, 'settings'>,
  path: string,
  github?: Outcome<string>,
): Promise<Outcome<PipelineSource>> => {
  const values = ctx.settings?.at(path).values;
  const provider = values?.pipelines ?? SETTINGS.pipelines.default;

  if (provider === 'azure-pipelines') {
    const { organization, project } = values?.board ?? {};

    return organization === undefined || project === undefined
      ? refused(
          'no-azure-project',
          'pipelines is azure-pipelines, but the board setting names no organization and project',
        )
      : { ok: true, data: { provider, organization, project } };
  }
  if (github !== undefined)
    return github.ok ? { ok: true, data: { provider, repo: github.data } } : github;
  const origin = await originConfigUrl(path);
  const repo = origin === undefined ? undefined : githubRepoOf(origin);

  return repo === undefined
    ? refused('no-github-repo', `${path} has no GitHub origin to read its Actions from`)
    : { ok: true, data: { provider, repo } };
};

/** The source's words: `owner/name`, or `<org>/<project>`. */
export const sourceText = (s: PipelineSource): string =>
  s.provider === 'github-actions'
    ? s.repo
    : `${s.organization.replace(/\/+$/, '').split('/').at(-1) ?? s.organization}/${s.project}`;

/** `then` on the port and the source of `--repo` (else the request's cwd). */
const withSource = async <T>(
  ctx: PipelinesCtx,
  repo: string | undefined,
  then: (p: Pipelines, source: PipelineSource, path: string) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const path = realPathAt(ctx.cwd, repo ?? '.');
  const p = ctx.ports.pipelinesAt === undefined ? ctx.ports.pipelines : ctx.ports.pipelinesAt(path);

  if (p === undefined) return noPipelines();
  const source = await sourceAt(ctx, path);

  return source.ok ? then(p, source.data, path) : source;
};

/**
 * The newest run on `branch` (Linked's Pipelines row), from the provider in force at `path`:
 * GitHub Actions on `github` (the repo the story's work is on, or why that is not known; none:
 * none read, as the Pull request row), else Azure Pipelines on the board's project (its CI
 * builds of the branch's ref, not a pull request's validation builds).
 */
export const newestRunOn = async (
  ctx: Pick<PipelinesCtx, 'settings'> & { ports: PipelinesPorts },
  path: string,
  branch: string,
  github: Outcome<string> | undefined,
): Promise<Outcome<PipelineRun | null>> => {
  const p = ctx.ports.pipelinesAt === undefined ? ctx.ports.pipelines : ctx.ports.pipelinesAt(path);

  if (p === undefined) return noPipelines();
  const provider = ctx.settings?.at(path).values.pipelines ?? SETTINGS.pipelines.default;

  if (provider === 'github-actions' && github === undefined) return { ok: true, data: null };
  const source = await sourceAt(ctx, path, github);

  if (!source.ok) return source;
  const runs = await p.runs(source.data, 1, branch);

  return runs.ok ? { ok: true, data: runs.data[0] ?? null } : runs;
};

/**
 * Each workflow that deploys (`deployWorkflowsOf` over `files`) with its newest run, dev → test →
 * prod: the newest of `runs` (the newest runs, read already) where it is among them, else one
 * read of its own, all at once; on the default branch only for one that also runs for pull
 * requests. One whose run could not be read is left out (not said never run); files not read: none.
 */
export const deploysOf = async (
  p: Pipelines,
  source: PipelineSource,
  files: Answered<CiWorkflowFile[]>,
  runs: readonly PipelineRun[],
  o: { defaultBranch: string | undefined; prod: readonly string[] },
): Promise<PipelineDeploy[]> => {
  if (!files.ok) return [];
  const read = await Promise.all(
    deployWorkflowsOf(files.data, o.prod).map(async (d): Promise<PipelineDeploy[]> => {
      const branch = d.defaultBranch ? o.defaultBranch : undefined;
      const listed = runs
        .filter((r) => r.pipeline === d.workflow && (branch === undefined || r.branch === branch))
        .sort(newestFirst)[0];
      const deploy = { workflow: d.workflow, environment: d.environment };

      if (listed !== undefined) return [{ ...deploy, run: listed }];
      const newest = await p.runs(source, 1, branch, {
        workflow: d.file === '' ? d.workflow : d.file,
      });

      return newest.ok ? [{ ...deploy, run: newest.data[0] ?? null }] : [];
    }),
  );

  return read.flat();
};

/** A run read for a write: refused as the port says. */
const runOf = async (
  p: Pipelines,
  source: PipelineSource,
  id: string,
): Promise<Outcome<PipelineRun>> => p.run(source, id);

export const pipelineHandlers = <Ctx extends PipelinesCtx>() =>
  ({
    'pipeline list': (args, ctx) =>
      withSource(ctx, args.repo, async (p, source, path) => {
        // the deploys go with the overview's first page only
        const overview = args.workflow === undefined && (args.page ?? 1) === 1;
        const [runs, workflows, me, files, defaultBranch] = await Promise.all([
          p.runs(source, args.limit ?? DEFAULT_LIMIT, undefined, {
            workflow: args.workflow,
            page: args.page,
          }),
          p.workflows(source),
          p.me(source),
          overview ? p.workflowFiles(source) : Promise.resolve({ ok: true as const, data: [] }),
          overview ? originHead(path) : Promise.resolve(undefined),
        ]);

        if (!runs.ok) return runs;
        const deploys = await deploysOf(p, source, files, runs.data, {
          defaultBranch,
          prod: ctx.settings?.at(path).values.prodEnvironments ?? [],
        });

        return {
          ok: true,
          data: {
            provider: source.provider,
            source: sourceText(source),
            me: me.ok ? me.data : null,
            runs: runs.data,
            workflows: workflows.ok ? workflows.data : [],
            deploys,
          },
        };
      }),
    'pipeline workflows': (args, ctx) =>
      withSource(ctx, args.repo, async (p, source) => {
        const list = await p.dispatchable(source, args.ref);

        if (!list.ok) return list;

        return {
          ok: true,
          data: {
            provider: source.provider,
            source: sourceText(source),
            ref: args.ref ?? null,
            workflows: list.data,
            note:
              source.provider === 'azure-pipelines'
                ? 'Running a pipeline by hand is GitHub Actions only for now'
                : null,
          },
        };
      }),
    'pipeline run': (args, ctx) =>
      withSource(ctx, args.repo, async (p, source, path) => {
        const inputs: Record<string, string> = {};

        for (const given of args.input) {
          const at = given.indexOf('=');

          if (at <= 0)
            return refused('bad-input', `--input takes name=value, not ${JSON.stringify(given)}`);
          inputs[given.slice(0, at)] = given.slice(at + 1);
        }
        const ref = args.ref ?? (await currentBranch(path));

        if (ref === undefined)
          return refused('no-ref', `${path} is on no branch: name the ref to run on with --ref`);
        // the workflow's file and name, where the catalog names it (a file given runs as is)
        const known = await p.dispatchable(source, ref);
        const workflow = known.ok
          ? known.data.find((w) => w.file === args.workflow || w.name === args.workflow)
          : undefined;
        const file = workflow?.file ?? args.workflow;

        if (workflow !== undefined && !workflow.dispatch)
          return refused(
            'not-dispatchable',
            `${workflow.name} has no workflow_dispatch at ${ref}: it cannot be run by hand there`,
          );
        const run = await p.dispatch(source, file, ref, inputs);

        return run.ok
          ? {
              ok: true,
              data: { workflow: workflow?.name ?? args.workflow, file, ref, inputs, run: run.data },
            }
          : run;
      }),
    'pipeline show': (args, ctx) => withSource(ctx, args.repo, (p, s) => p.run(s, args.run)),
    'pipeline inspect': (args, ctx) =>
      withSource(ctx, args.repo, (p, s) => p.inspect(s, args.run, args.attempt)),
    'pipeline log': (args, ctx) =>
      withSource(ctx, args.repo, async (p, s) => {
        const log = await p.log(s, args.run, args.job);

        return log.ok ? { ok: true, data: { run: args.run, job: args.job, log: log.data } } : log;
      }),
    'pipeline rerun': (args, ctx) =>
      withSource(ctx, args.repo, async (p, s) => {
        const r = await runOf(p, s, args.run);

        if (!r.ok) return r;
        const did = args.failed ? 'rerun-failed' : 'rerun';
        const done = await p.control(s, args.run, args.attempt, did);

        return done.ok
          ? {
              ok: true,
              data: {
                run: args.run,
                named: runNamed(r.data),
                did,
                attempt: args.attempt,
                environment: null,
              },
            }
          : done;
      }),
    'pipeline cancel': (args, ctx) =>
      withSource(ctx, args.repo, async (p, s) => {
        const r = await runOf(p, s, args.run);

        if (!r.ok) return r;
        const done = await p.control(s, args.run, args.attempt, 'cancel');

        return done.ok
          ? {
              ok: true,
              data: {
                run: args.run,
                named: runNamed(r.data),
                did: 'cancel',
                attempt: args.attempt,
                environment: null,
              },
            }
          : done;
      }),
    'pipeline approve': (args, ctx) =>
      withSource(ctx, args.repo, async (p, s, path) => {
        const r = await runOf(p, s, args.run);

        if (!r.ok) return r;
        const at = gatesOf(r.data).find((g) => g.gate.environment === args.environment);

        if (at === undefined)
          return refused(
            'no-gate',
            `run ${runNamed(r.data)} waits for no approval on ${args.environment}`,
          );
        const also = ctx.settings?.at(path).values.prodEnvironments ?? [];

        // a prod deploy is only ever a person's explicit yes (spec story 81)
        if (isProd(args.environment, also) && !args.yes)
          return refused(
            'prod-needs-yes',
            `${args.environment} is prod: approving run ${runNamed(r.data)} there needs --yes`,
          );
        if (!at.gate.canApprove)
          return refused('not-yours', `you may not approve deployments to ${args.environment}`);
        const done = await p.approve(s, args.run, at.gate);

        return done.ok
          ? {
              ok: true,
              data: {
                run: args.run,
                named: runNamed(r.data),
                did: 'approve',
                attempt: r.data.attempt,
                environment: args.environment,
              },
            }
          : done;
      }),
    'pipeline fix': (args, ctx) =>
      withSource(ctx, args.repo, async (p, s, path): Promise<Outcome<PipelineFixData>> => {
        const r = await runOf(p, s, args.run);

        if (!r.ok) return r;
        const run = await p.inspect(s, args.run);

        if (!run.ok) return run;
        const jobs = fixJobs(run.data, args.job);

        if (jobs.length === 0)
          return refused('no-failure', `run ${runNamed(r.data)} has no failed job to fix`);
        const card = args.card ?? String(cardOfRunBranch(r.data.branch) ?? '');

        if (card === '')
          return refused(
            'no-card',
            `run ${runNamed(r.data)} is on ${r.data.branch}, no card's branch: name the card the fix is for with --card <n>`,
          );
        // a product owner never launches (ADR 0017); a fix runs in the Local sandbox
        const placed = await placement(ctx, card, args.repo ?? '.', 'local-sandbox');

        if (!placed.ok) return placed;
        const detail = await readCard(ctx, card, path);

        if (!detail.ok) return detail;
        const id = detail.data.id;
        const sessions = ctx.serve.sessions;
        const listed = await (sessions?.list() ?? Promise.resolve(undefined));
        // the card's session in this repo only: another checkout's of the same number is not it
        const { here } = await repoHere(path);
        const live = [
          ...(listed?.ok === true ? listed.data : []),
          ...(ctx.serve.cloud === undefined ? [] : await ctx.serve.cloud.list()),
        ].find(
          (x) => x.card === id && x.state !== 'ended' && x.kind === 'card' && isHere(here, x.repo),
        );
        // a live session fixes it on its own branch; a new one on the card's, or a fix branch
        const branch = fixBranch(id, r.data);
        const prompt = fixPrompt(r.data, run.data, {
          jobs,
          evidence: args.evidence,
          artifacts: args.artifact,
          base: (await originHead(path)) ?? 'main',
          branch: live?.branch ?? branch.branch,
          message: args.message,
        });

        if (live !== undefined) {
          const sent = await on(
            ctx,
            live.id,
            async (x) => {
              const m = await x.message(live.id, prompt, null);

              return m.ok ? { ok: true as const, data: null } : m;
            },
            async (c) => {
              const m = await c.send(live.id, prompt, undefined);

              return m.ok ? { ok: true as const, data: null } : m;
            },
          );

          return sent.ok
            ? {
                ok: true,
                data: {
                  run: args.run,
                  named: runNamed(r.data),
                  card: id,
                  session: live.id,
                  branch: live.branch,
                  sent: 'sent',
                },
              }
            : sent;
        }
        if (sessions === undefined) return noSessions();
        const profile = await launchProfile(ctx, path, undefined);

        if (!profile.ok) return profile;
        const reach = await sessionReach({ ...ctx, cwd: path }, 'local');

        if (!reach.ok) return reach;
        const launched = await sessions.launch(
          detail.data,
          path,
          reach.data.env,
          launchSettings(ctx, path),
          {
            browserProfile: profile.data,
            prompt,
            branch: branch.branch,
            from:
              branch.from === 'revision'
                ? [r.data.sha]
                : [`refs/remotes/origin/${r.data.branch}`, r.data.sha],
          },
        );

        return launched.ok
          ? {
              ok: true,
              data: {
                run: args.run,
                named: runNamed(r.data),
                card: id,
                session: launched.data.id,
                branch: launched.data.branch,
                sent: 'launched',
              },
            }
          : launched;
      }),
  }) satisfies Partial<Handlers<Ctx>>;
