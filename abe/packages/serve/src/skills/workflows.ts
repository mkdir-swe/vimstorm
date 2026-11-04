/**
 * `abe workflow list` (#15): every Layer's workflows and skills through core's load check, for the
 * checkout asked in, the Layers that apply and this Mac's recent runs of each; `abe workflow path`:
 * a listed file to open (a built-in one written out read-only); and the workflow a Factory run
 * launches with (`launchWorkflow`): the card's, else the nearest Layer's `on: default` one, else
 * the built-in Factory.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  abeInForce,
  applyUpdates,
  proposeUpdates,
  updatesNotice,
  updatesOf,
  treeTags,
  builtInFile,
  type Clock,
  type LayerView,
  loadWorkflows,
  NOT_A_LAYER_FILE,
  type Outcome,
  pickedWorkflow,
  type RecentView,
  refused,
  Run,
  type RunWorkflow,
  workflowFor,
  type WorkflowsData,
  type Handlers,
  REPO_ABE_DIR,
  REPO_ABE_SKILLS_DIR,
  REPO_SKILLS_DIR,
  repoWorkflowsDir,
} from '@abe/core';
import {
  abeFolder,
  mainCheckout,
  readRuns,
  readWorkflowLayers,
  repoRoot,
  type WorkflowDir,
  writeReadOnly,
} from '@abe/ports';
import { type SettingsCtx, type SettingsService } from '../layer/settings';
import { VERSION } from '../process/version';

/**
 * Yours beside the repo's for work in `repo`: its main checkout's `.abe/workflows/` (a card
 * worktree never has yours: they are never committed).
 */
export const yourWorkflowsDir = (repo: string): string => {
  const main = mainCheckout(repo);
  const real = (() => {
    try {
      return realpathSync(repo);
    } catch {
      return repo;
    }
  })();

  // the main checkout itself: as given, so its files keep the path asked in
  return join(main === undefined || main === real ? repo : main, '.abe', 'workflows');
};

/**
 * Each Layer's folder for work in `repo`, nearest first: yours (your skills in your config
 * folder, your workflows the main checkout's `<id>.local.yaml`), then the repo's.
 */
export const workflowDirs = (
  settings: SettingsService | undefined,
  repo: string | undefined,
): WorkflowDir[] => {
  const repos: WorkflowDir[] =
    repo === undefined
      ? []
      : [
          {
            layer: 'repo',
            dir: join(repo, '.abe'),
            // the team's workflows: abe/workflows/<id>.yaml (ADR 0033)
            workflows: { dir: repoWorkflowsDir(repo), local: false },
            // its own Claude Code skills first, then Abe's as the repo has them (ADR 0033)
            skills: [join(repo, REPO_SKILLS_DIR), join(repo, REPO_ABE_SKILLS_DIR)],
          },
        ];

  if (settings === undefined) return repos;

  return [
    {
      layer: 'yours',
      dir: settings.places.configDir,
      workflows: repo === undefined ? null : { dir: yourWorkflowsDir(repo), local: true },
    },
    ...repos,
  ];
};

/**
 * Each Layer's files for work in `repo` (`readWorkflowLayers`), then Abe's own the shipped files'
 * rule keeps in force there (`abeInForce`): all before the install, after it only those Abe keeps.
 */
export const readLayers = (settings: SettingsService | undefined, repo: string | undefined) =>
  readWorkflowLayers(
    workflowDirs(settings, repo),
    abeInForce(repo === undefined ? null : abeFolder(repo)),
  );

/** A Layer's name: the repo's folder; none for yours. */
const layerName = ({ layer, dir }: WorkflowDir): string | null =>
  layer === 'repo' ? basename(dirname(dir)) : null;

/** Every Layer's workflows and skills for work in the checkout `repo` (its top folder, or none). */
export const loadedWorkflows = (
  settings: SettingsService | undefined,
  repo: string | undefined,
): WorkflowsData => {
  const dirs = workflowDirs(settings, repo);
  const layers: LayerView[] = [
    ...dirs.map((d) => ({ layer: d.layer, name: layerName(d), dir: d.dir })),
    { layer: 'built-in', name: null, dir: null },
  ];

  return { ...loadWorkflows(readLayers(settings, repo)), layers };
};

/** How far back `recent` counts a workflow's runs. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The loops a run went back by: its count now (`looped`, 0 again once its step passes), or a move
 * in its visits from a loop's `from` back to its `to`.
 */
const firedLoops = (run: Run): Set<string> => {
  const { steps, loops } = run.workflow;
  const nameOf = (stage: string, step: string | null | undefined) =>
    step ?? steps.find((s) => s.kind === stage)?.name;
  const path = [
    ...run.visits.map((v) => nameOf(v.stage, v.step)),
    ...(run.stage === 'done' ? [] : [nameOf(run.stage, run.step)]),
  ];
  const at = (name: string) => steps.findIndex((s) => s.name === name);
  const fired = new Set(Object.keys(run.looped).filter((id) => (run.looped[id] ?? 0) > 0));

  path.forEach((from, i) => {
    const to = path[i + 1];

    for (const l of loops)
      if (l.from === from && l.to === to && at(l.to) <= at(l.from)) fired.add(l.id);
  });

  return fired;
};

/** This Mac's Factory runs started in the last 30 days, by workflow id, and each loop's fired runs. */
export const recentRuns = (stateDir: string, now: number): RecentView[] => {
  const by = new Map<string, RecentView>();

  for (const doc of readRuns(stateDir)) {
    const read = Run.safeParse(doc);

    if (!read.success || Date.parse(read.data.startedAt) < now - RECENT_MS) continue;
    const run = read.data;
    const r = by.get(run.workflow.id) ?? { workflow: run.workflow.id, runs: 0, loops: {} };

    r.runs += 1;
    for (const id of firedLoops(run)) r.loops[id] = (r.loops[id] ?? 0) + 1;
    by.set(r.workflow, r);
  }

  return [...by.values()].sort((a, b) => a.workflow.localeCompare(b.workflow));
};

/** A file `workflow list` names, to open: a Layer's as it is, a built-in one written out. */
const pathOf = (d: WorkflowsData, file: string, cwd: string, stateDir: string): string | null => {
  if (file.startsWith('built-in/')) {
    const text = builtInFile(file);

    if (text === undefined) return null;
    const path = join(stateDir, file);

    writeReadOnly(path, text);

    return path;
  }
  const path = resolve(cwd, file);
  const known = [
    ...d.workflows.filter((w) => w.layer !== 'built-in').map((w) => w.file),
    ...d.skills
      .filter((k) => k.layer !== 'built-in')
      .flatMap((k) => k.files.map((f) => join(k.dir, f))),
  ];

  return known.includes(path) ? path : null;
};

/** Whether `repo` is its repo's main checkout (a card worktree is not). */
const isMain = (repo: string): boolean => {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const main = mainCheckout(repo);

  return main === undefined || real(main) === real(repo);
};

/** What `abe workflow …` reads beyond the settings: the Mac's state (its runs) and its clock. */
export type WorkflowCtx = SettingsCtx & {
  serve: {
    clock: Clock;
    workflowState: string;
  };
};

/**
 * The workflow a run on `card` launches with in the checkout `repo`: the one whose `on:` takes
 * the card; with no card type known (a box's launch), the nearest `on: default`.
 */
export const launchWorkflow = (
  settings: SettingsService | undefined,
  repo: string,
  card: { type: string; tags: readonly string[] } = { type: '', tags: [] },
): RunWorkflow => workflowFor(card, loadedWorkflows(settings, repoRoot(repo) ?? repo));

/**
 * The workflow a launch on `card` runs: `id` when given (`--workflow`, whatever its `on:` says;
 * refused when no source has it, it fails the load check or takes no card), else the card's.
 */
export const launchWorkflowFor = (
  settings: SettingsService | undefined,
  repo: string,
  card: { type: string; tags: readonly string[] },
  id: string | undefined,
): Outcome<RunWorkflow> =>
  id === undefined
    ? { ok: true, data: launchWorkflow(settings, repo, card) }
    : pickedWorkflow(id, loadedWorkflows(settings, repoRoot(repo) ?? repo));

export const workflowHandlers = <Ctx extends WorkflowCtx>() =>
  ({
    'workflow list': (args, ctx) => {
      const repo = repoRoot(resolve(ctx.cwd, args.repo ?? '.'));

      return Promise.resolve({
        ok: true,
        data: {
          ...loadedWorkflows(ctx.settings, repo),
          recent: recentRuns(ctx.serve.workflowState, ctx.serve.clock.now()),
        },
      });
    },
    'workflow tree': (args, ctx) => {
      const repo = repoRoot(resolve(ctx.cwd, args.repo ?? '.'));

      if (repo === undefined || !isMain(repo))
        return Promise.resolve({ ok: true, data: { main: false, dir: null, tags: [] } });
      const dir = join(repo, REPO_ABE_DIR);
      // a newer Abe's files: said on the abe/ folder's row
      const notice = updatesNotice(VERSION, updatesOf(abeFolder(repo)));

      return Promise.resolve({
        ok: true,
        data: {
          main: true,
          dir: existsSync(dir) ? dir : null,
          tags: [
            ...(notice === null || !existsSync(dir)
              ? []
              : [{ path: dir, tag: notice, bad: false }]),
            ...treeTags(loadedWorkflows(ctx.settings, repo)),
          ],
        },
      });
    },
    'workflow update': async (args, ctx) => {
      const repo = repoRoot(resolve(ctx.cwd, args.repo ?? '.'));

      if (repo === undefined)
        return refused(NOT_A_LAYER_FILE, 'not in a repo: abe workflow update runs in its checkout');
      const folder = abeFolder(repo);
      const files = await proposeUpdates(folder, VERSION, args.name);

      if (args.write) applyUpdates(folder, VERSION, files);

      return { ok: true, data: { abe: VERSION, files, written: args.write } };
    },
    'workflow path': (args, ctx) => {
      const dir = resolve(ctx.cwd, args.repo ?? '.');
      const path = pathOf(
        loadedWorkflows(ctx.settings, repoRoot(dir)),
        args.file,
        ctx.cwd,
        ctx.serve.workflowState,
      );

      return Promise.resolve(
        path === null
          ? refused(
              NOT_A_LAYER_FILE,
              `${args.file} is no Layer's workflow or skill file (abe workflow list names them)`,
            )
          : { ok: true, data: { path } },
      );
    },
  }) satisfies Partial<Handlers<Ctx>>;
