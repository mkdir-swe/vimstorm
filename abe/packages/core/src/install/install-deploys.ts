/**
 * Factory install's Read of what a merge deploys (ADR 0026): the CI jobs that deploy on a push to
 * the default branch, and to which environments. The same reading names the workflows that deploy
 * for the Pipelines overview's Deploys (`deployWorkflowsOf`), by hand ones too. A repo whose CI deploys on every push (a tenant
 * config, Terraform applied by CI) turns a merged pull request into a deploy, prod included: Board
 * then asks who merges, and never keeps an earlier `autoMerge` without asking. Pure,
 * over the workflow files' text: GitHub Actions (`on: push`, a job's `environment:`, its steps)
 * and Azure Pipelines (`trigger:`, a `deployment` job's `environment:`).
 */
import { z } from 'zod';
import { deployOrder, envRank, type CiWorkflowFile } from '../board/pipelines';

/** One job that deploys when the default branch is pushed (a merge). */
export const MergeDeploy = z.object({
  /** Its workflow (`.github/workflows/deploy.yml`) and the job's line in it. */
  file: z.string(),
  line: z.number().int(),
  /** The job's key (`deploy_prod`). */
  job: z.string(),
  /** The environment it deploys to: its `environment:`, else the one its name says, else its key. */
  env: z.string(),
  /** Whether that environment is prod (a prod word in it). */
  prod: z.boolean(),
});
export type MergeDeploy = z.infer<typeof MergeDeploy>;

/** The branch names taken for the default one: Read sees local files only, not origin's HEAD. */
export const DEFAULT_BRANCHES = ['main', 'master'] as const;

const PROD_WORDS = ['prod', 'production', 'prd', 'live'];
const ENV_WORDS = [
  'dev',
  'development',
  'test',
  'testing',
  'qa',
  'uat',
  'stage',
  'staging',
  'preview',
  ...PROD_WORDS,
];

/** A step's command that deploys (not one that only says the word: `echo`, a comment). */
const DEPLOY_RUN =
  /\b(a0deploy\s+(deploy|import)|deploy(:[\w-]+)?\b|terraform\s+apply|cdk\s+deploy|(serverless|sls)\s+deploy|helm\s+(upgrade|install)|kubectl\s+apply|pulumi\s+up|sam\s+deploy|firebase\s+deploy|netlify\s+deploy|wrangler\s+(deploy|publish)|aws\s+s3\s+sync)/;
const NOT_A_COMMAND = /^\s*(echo|printf|#)/;

/** An action that deploys (`azure/webapps-deploy`, `aws-actions/amazon-ecs-deploy-task-definition`). */
const DEPLOY_USES = /deploy|wrangler-action|terraform-apply/i;

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '');

const indentOf = (line: string) => line.length - line.trimStart().length;

const unquote = (v: string) =>
  v
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');

/** The list a YAML value is: `[a, b]`, `a`, or the `- a` lines under it. */
const listAt = (lines: readonly string[], i: number, rest: string): string[] => {
  const v = rest.replace(/\s+#.*$/, '').trim();

  if (v.startsWith('[')) return v.slice(1, v.indexOf(']')).split(',').map(unquote).filter(Boolean);
  if (v !== '') return [unquote(v)];
  const own = indentOf(lines[i] ?? '');
  const out: string[] = [];

  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? '';

    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= own) break;
    const m = /^\s*-\s+(.*)$/.exec(line);

    if (m !== null) out.push(unquote(m[1] ?? ''));
  }

  return out;
};

/** The lines of the block under line `i` (deeper than it), with their numbers. */
const blockOf = (lines: readonly string[], i: number): { at: number; line: string }[] => {
  const own = indentOf(lines[i] ?? '');
  const out: { at: number; line: string }[] = [];

  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? '';

    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= own) break;
    out.push({ at: j, line });
  }

  return out;
};

/** A branch filter that takes the default branch (`main`, `*`, `**`, `ma*`). */
const takesDefault = (branches: readonly string[]): boolean =>
  branches.some((b) => {
    const re = new RegExp(`^${b.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*?/g, '.*')}$`);

    return DEFAULT_BRANCHES.some((d) => re.test(d));
  });

/**
 * Whether a GitHub workflow runs on a push to the default branch: `on: push`, `on: [push, …]`, or
 * `on: { push: { branches: […] } }` naming it (no branch filter: every branch; tags only: none).
 */
const onDefaultPush = (lines: readonly string[]): boolean => {
  const at = lines.findIndex((l) => /^(on|"on"|'on'|true):/.test(l));

  if (at < 0) return false;
  const rest = (lines[at] ?? '').replace(/^[^:]+:/, '');

  if (rest.trim() !== '' && !rest.trim().startsWith('#'))
    return listAt(lines, at, rest).includes('push');
  const push = blockOf(lines, at).find(({ line }) => /^\s*push:/.test(line));

  if (push === undefined) return false;
  const under = blockOf(lines, push.at);
  const key = (name: string) => under.find(({ line }) => new RegExp(`^\\s*${name}:`).test(line));
  const branches = key('branches');
  const ignored = key('branches-ignore');

  if (branches !== undefined)
    return takesDefault(
      listAt(lines, branches.at, (lines[branches.at] ?? '').replace(/^[^:]+:/, '')),
    );
  if (ignored !== undefined)
    return !takesDefault(
      listAt(lines, ignored.at, (lines[ignored.at] ?? '').replace(/^[^:]+:/, '')),
    );

  // tags only: a push of a branch runs nothing
  return key('tags') === undefined;
};

/** The environment a job names, else the one its key or name says, else its key. */
const envOf = (job: string, name: string | undefined, env: string | undefined): string => {
  if (env !== undefined && env !== '') return env;
  const said = [...tokens(job), ...tokens(name ?? '')].find((t) => ENV_WORDS.includes(t));

  return said ?? job;
};

const isProd = (env: string) => tokens(env).some((t) => PROD_WORDS.includes(t));

/** A GitHub workflow's job: its key, line, name, the environment it names, whether it deploys. */
type GithubJob = {
  at: number;
  key: string;
  name: string | undefined;
  /** Its `environment:` (or `environment.name`); undefined where it names none. */
  environment: string | undefined;
  /** It runs a deploy: an action or a command that deploys. */
  deploys: boolean;
};

/** A GitHub workflow's jobs, in order. */
const githubJobs = (lines: readonly string[]): GithubJob[] => {
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));

  if (jobsAt < 0) return [];
  const body = blockOf(lines, jobsAt);
  const jobIndent = Math.min(...body.map(({ line }) => indentOf(line)));
  const out: GithubJob[] = [];

  for (const { at, line } of body) {
    const key = indentOf(line) === jobIndent ? /^\s*([\w-]+):\s*$/.exec(line)?.[1] : undefined;

    if (key === undefined) continue;
    const job = blockOf(lines, at);
    const own = Math.min(...job.map((j) => indentOf(j.line)));
    const field = (name: string) =>
      job.find((j) => indentOf(j.line) === own && new RegExp(`^\\s*${name}:`).test(j.line));
    const name = field('name');
    const environment = field('environment');
    const envName =
      environment === undefined
        ? undefined
        : unquote(environment.line.replace(/^[^:]+:/, '')) ||
          unquote(
            blockOf(lines, environment.at)
              .find((j) => /^\s*name:/.test(j.line))
              ?.line.replace(/^[^:]+:/, '') ?? '',
          );
    // its actions (a reusable workflow's, a step's) and its commands: each `run:` and the lines of
    // a `run: |` block; other keys (`name:`, `with:`, `env:`) are no command
    const uses = job.flatMap(({ line: l }) => /^\s*(?:-\s+)?uses:\s*(.*)$/.exec(l)?.[1] ?? []);
    const commands = job.flatMap(({ line: l }) => {
      const t = l.trim().replace(/^-\s+/, '');
      const run = /^run:\s*(.*)$/.exec(t);

      if (run !== null) return [run[1] ?? ''];

      return /^[\w-]+:/.test(t) ? [] : [t];
    });

    out.push({
      at,
      key,
      name: name === undefined ? undefined : unquote(name.line.replace(/^[^:]+:/, '')),
      environment: envName,
      deploys:
        uses.some((u) => DEPLOY_USES.test(u)) ||
        commands.some((c) => !NOT_A_COMMAND.test(c) && DEPLOY_RUN.test(c)),
    });
  }

  return out;
};

/** A GitHub workflow's jobs that deploy on a push to the default branch. */
const githubDeploys = (file: string, text: string): MergeDeploy[] => {
  const lines = text.split('\n');

  if (!onDefaultPush(lines)) return [];

  return githubJobs(lines).flatMap((j) => {
    if (!j.deploys) return [];
    const env = envOf(j.key, j.name, j.environment);

    return [{ file, line: j.at + 1, job: j.key, env, prod: isProd(env) }];
  });
};

/**
 * Azure Pipelines' deployment jobs when the default branch triggers it: `trigger:` naming it, or
 * none (every branch, the default).
 */
const azureDeploys = (file: string, text: string): MergeDeploy[] => {
  const lines = text.split('\n');
  const trigger = lines.findIndex((l) => l.startsWith('trigger:'));
  const rest = trigger < 0 ? '' : (lines[trigger] ?? '').replace(/^[^:]+:/, '').trim();
  const included = (): string[] => {
    const inc = blockOf(lines, trigger).find(({ line }) => /^\s*include:/.test(line));

    return inc === undefined
      ? listAt(lines, trigger, rest)
      : listAt(lines, inc.at, (lines[inc.at] ?? '').replace(/^[^:]+:/, ''));
  };
  const runs = trigger < 0 || (rest !== 'none' && takesDefault(included()));

  if (!runs) return [];

  return lines.flatMap((line, at) => {
    const job = /^\s*-\s+deployment:\s*([\w-]+)/.exec(line)?.[1];

    if (job === undefined) return [];
    const env = blockOf(lines, at).find((j) => /^\s*environment:/.test(j.line));
    const named =
      env === undefined
        ? undefined
        : unquote(env.line.replace(/^[^:]+:/, '')) ||
          unquote(
            blockOf(lines, env.at)
              .find((j) => /^\s*name:/.test(j.line))
              ?.line.replace(/^[^:]+:/, '') ?? '',
          );
    const e = envOf(job, undefined, named);

    return [{ file, line: at + 1, job, env: e, prod: isProd(e) }];
  });
};

/** The CI jobs that deploy on a merge to the default branch, in each workflow's order. */
export const mergeDeploysOf = (files: ReadonlyMap<string, string>, ci: readonly string[]) =>
  ci.flatMap((file) => {
    const text = files.get(file) ?? '';

    return file === 'azure-pipelines.yml' ? azureDeploys(file, text) : githubDeploys(file, text);
  });

/** The environments a merge deploys, each once, in order: `dev, test, prod`. */
export const mergeEnvs = (deploys: readonly MergeDeploy[]): string[] => [
  ...new Set(deploys.map((d) => d.env)),
];

/** What a merge here does, in words: `a merge here deploys dev, test, prod`; null: nothing. */
export const mergeDeploysWords = (deploys: readonly MergeDeploy[]): string | null => {
  const envs = mergeEnvs(deploys);

  return envs.length === 0 ? null : `a merge here deploys ${envs.join(', ')}`;
};

// ── the workflows that deploy (the Pipelines overview's Deploys) ────────────────────────────

/** A workflow that deploys: its name, file, environments and where its deploys run. */
export type DeployWorkflow = {
  workflow: string;
  /** Its file (`deploy.yml`), as its runs are read by; empty on Azure (its name is). */
  file: string;
  /** The environments it deploys to in order (`dev, test`); null where none is named. */
  environment: string | null;
  /**
   * It also runs for pull requests (or on every push, never by hand): its deploys are its runs on
   * the default branch, not its newest run anywhere.
   */
  defaultBranch: boolean;
};

const DEPLOY_WORDS = ['deploy', 'deploys', 'deployment', 'deployments', 'release', 'releases'];
const PR_EVENTS = ['pull_request', 'pull_request_target', 'merge_group'];

/** The events a GitHub workflow runs on: `on: push`, `on: [push, pull_request]`, `on:`'s keys. */
const eventsOf = (lines: readonly string[]): string[] => {
  const at = lines.findIndex((l) => /^(on|"on"|'on'|true):/.test(l));

  if (at < 0) return [];
  const rest = (lines[at] ?? '').replace(/^[^:]+:/, '');

  if (rest.trim() !== '' && !rest.trim().startsWith('#')) return listAt(lines, at, rest);
  const body = blockOf(lines, at);
  const own = Math.min(...body.map(({ line }) => indentOf(line)));

  return body.flatMap(({ line }) =>
    indentOf(line) === own ? (/^\s*([\w-]+):/.exec(line)?.[1] ?? []) : [],
  );
};

/** The environment words a text says (`Deploy Dev/Test`: dev, test). */
const envWordsOf = (text: string): string[] => tokens(text).filter((t) => ENV_WORDS.includes(t));

/** Each once, dev → test → prod; null for none. */
const envList = (envs: readonly string[], also: readonly string[]): string | null => {
  const once = [...new Set(envs)];

  return once.length === 0
    ? null
    : once.sort((a, b) => envRank(a, also) - envRank(b, also) || a.localeCompare(b)).join(', ');
};

/**
 * Whether a workflow deploys, and where to: a job that runs a deploy (as a merge's deploy is
 * found) or names an `environment:`, on any trigger (by hand too) but pull requests or a call
 * alone; else its name says deploy or release and an environment (`Deploy Prod`). A workflow not
 * read (Azure's pipelines) goes by its name alone. Its environments: each job's own (an
 * expression is none), else the one the job's key or name says, else its name's.
 */
export const deployWorkflowOf = (
  w: CiWorkflowFile,
  also: readonly string[] = [],
): DeployWorkflow | undefined => {
  const nameEnvs = envWordsOf(w.name);
  const named = tokens(w.name).some((t) => DEPLOY_WORDS.includes(t)) && nameEnvs.length > 0;
  const lines = w.text?.split('\n') ?? [];
  const events = eventsOf(lines);

  if (events.length > 0 && events.every((e) => [...PR_EVENTS, 'workflow_call'].includes(e)))
    return undefined;
  const jobs = githubJobs(lines).filter((j) => j.deploys || j.environment !== undefined);

  if (jobs.length === 0 && !named) return undefined;
  const envs = jobs.flatMap((j) =>
    j.environment !== undefined && j.environment !== '' && !j.environment.includes('${{')
      ? [j.environment]
      : envWordsOf(`${j.key} ${j.name ?? ''}`).slice(0, 1),
  );

  return {
    workflow: w.name,
    file: w.file,
    environment: envList(envs.length > 0 ? envs : nameEnvs, also),
    defaultBranch:
      events.some((e) => PR_EVENTS.includes(e)) ||
      (events.includes('push') && !events.includes('workflow_dispatch')),
  };
};

/** The workflows that deploy, dev → test → prod (others between, by name), none named last. */
export const deployWorkflowsOf = (
  workflows: readonly CiWorkflowFile[],
  also: readonly string[] = [],
): DeployWorkflow[] =>
  workflows.flatMap((w) => deployWorkflowOf(w, also) ?? []).sort(deployOrder(also));
