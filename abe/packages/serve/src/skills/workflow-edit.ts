/**
 * A Layer's file opened and changed (#15, spec #19 stories 24, 26, 27, 28, 36): `abe workflow
 * read` (the readable side, read-only or yours, the problems with their ⌥⏎ fixes, on the text the
 * Editor has now), `copy` (Edit my copy), `propose` (your copy as one pull request on its Layer's
 * repo, through the Git Data API: no checkout touched), `change` (Change with AI, a one-shot)
 * and `retro` (Retro on a file: this Mac's runs of it, kept as the file's last retro and shown
 * on its readable side).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BUILT_IN_SKILL_FILES,
  BUILT_IN_STEPS,
  builtInFile,
  CHANGE_SYSTEM,
  ChangeAnswer,
  changePrompt,
  fixesOf,
  type Journal,
  layerWords,
  loadWorkflows,
  type LayerPulls,
  NOT_A_LAYER_FILE,
  type Outcome,
  proposeBody,
  proposeBranch,
  proposeTitle,
  type ReadHeader,
  readableSkill,
  readHead,
  workflowPreview,
  readableWorkflow,
  readJsonAnswer,
  refused,
  FILE_RETRO_SYSTEM,
  FileRetroAnswer,
  fileRetroPrompt,
  type FileRetroRun,
  Run,
  type SkillView,
  type Tracking,
  type WorkflowChangeData,
  type WorkflowCopyData,
  type WorkflowLayer,
  type WorkflowProposeData,
  type WorkflowReadData,
  WorkflowRetroData,
  type WorkflowsData,
  type WorkflowView,
  readableSkillBody,
  type Handlers,
  YOURS_IN_REPO,
  REPO_SKILLS_DIR,
  REPO_WORKFLOWS_DIR,
} from '@abe/core';
import { excludeInstalled, readRuns, repoRoot, workflowSource, writeReadOnly } from '@abe/ports';
import { type LocalMode } from '../local-mode/local-mode';
import { askOneShot, type OneShotCtx } from '../layer/one-shot';
import { githubOf, noLayerPulls } from '../layer/settings';
import { readLayers, workflowDirs, type WorkflowCtx, yourWorkflowsDir } from './workflows';

export type WorkflowEditCtx = WorkflowCtx &
  OneShotCtx & {
    ports: { tracking: Tracking; layerPulls: LayerPulls | undefined };
    serve: {
      emit: Journal['emit'];
      /** Local mode (#24): a proposal from or to a checkout in it is held, never sent. */
      localMode?: LocalMode | undefined;
    };
  };

const noSettings = () => refused('no-settings', 'this abe serve was started without its settings');

/** One Layer file located: a workflow's or a markdown file in a skill's folder; its text now. */
type Located =
  | { kind: 'workflow'; listed: string; text: string; view: WorkflowView }
  | { kind: 'skill'; listed: string; text: string; skill: SkillView; rel: string };

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** A file's text, a built-in one from core. */
const textOf = (listed: string): string | null =>
  listed.startsWith('built-in/') ? (builtInFile(listed) ?? null) : readText(listed);

/** The name `workflow list` gives a file: a built-in one written out is `built-in/…` again. */
const listedName = (file: string, cwd: string, stateDir: string): string => {
  if (file.startsWith('built-in/')) return file;
  const path = resolve(cwd, file);
  const out = join(stateDir, 'built-in');

  return path.startsWith(`${out}/`) ? `built-in/${path.slice(out.length + 1)}` : path;
};

const locate = (d: WorkflowsData, listed: string): Located | null => {
  const view = d.workflows.find((w) => w.file === listed);
  const text = textOf(listed);

  if (text === null) return null;
  if (view !== undefined) return { kind: 'workflow', listed, text, view };
  const skill = d.skills.find((k) => k.dir !== '' && listed.startsWith(`${k.dir}/`));
  const rel = skill === undefined ? '' : listed.slice(skill.dir.length + 1);

  // a skill's readable side is markdown: its other files (JSON, scripts) open as themselves, no Layer's
  return skill?.files.includes(rel) === true && rel.toLowerCase().endsWith('.md')
    ? { kind: 'skill', listed, text, skill, rel }
    : null;
};

/** A Layer's name: the repo's folder; none for yours. */
const nameOf = (x: { layer: WorkflowLayer; dir: string }): string | null =>
  x.layer === 'repo' ? (dirname(x.dir).split('/').at(-1) ?? null) : null;

/** The Layers for work in `repo`, with `text` read in place of the file `listed`. */
const loaded = (ctx: WorkflowEditCtx, repo: string | undefined, over?: Located): WorkflowsData => {
  const dirs = workflowDirs(ctx.settings, repo);
  const read = readLayers(ctx.settings, repo);
  const sources =
    over?.kind === 'workflow'
      ? read.sources.map((s) =>
          s.file === over.listed ? workflowSource(s.layer, s.file, s.id, over.text) : s,
        )
      : read.sources;
  const layers = [
    ...dirs.map((x) => ({
      layer: x.layer,
      name: nameOf(x),
      dir: x.dir,
    })),
    { layer: 'built-in' as const, name: null, dir: null },
  ];

  return { ...loadWorkflows({ ...read, sources }), layers };
};

type Where = { d: WorkflowsData; at: Located; repo: string | undefined };

/** The file `args.file` names, through the Layers of the checkout asked in. */
const where = (
  ctx: WorkflowEditCtx,
  args: { file: string; repo?: string | undefined; text?: string | undefined },
): Outcome<Where> => {
  const repo = repoRoot(resolve(ctx.cwd, args.repo ?? '.'));
  const listed = listedName(args.file, ctx.cwd, ctx.serve.workflowState);
  const now = loaded(ctx, repo);
  const first = locate(now, listed);

  if (first === null)
    return refused(
      NOT_A_LAYER_FILE,
      `${args.file} is no Layer's workflow or skill file (abe workflow list names them)`,
    );
  if (args.text === undefined) return { ok: true, data: { d: now, at: first, repo } };
  const at = { ...first, text: args.text };
  const d = loaded(ctx, repo, at);
  const again = at.kind === 'workflow' ? d.workflows.find((w) => w.file === listed) : undefined;

  return {
    ok: true,
    data: {
      d,
      at: again === undefined || at.kind !== 'workflow' ? at : { ...at, view: again },
      repo,
    },
  };
};

const idOf = (at: Located) => (at.kind === 'workflow' ? at.view.id : at.skill.name);
const layerOf = (at: Located): WorkflowLayer =>
  at.kind === 'workflow' ? at.view.layer : at.skill.layer;

/** Your copy of a farther Layer's file, when you have one. */
const mineOf = (d: WorkflowsData, at: Located): string | null => {
  if (layerOf(at) === 'yours') return null;
  if (at.kind === 'workflow')
    return d.workflows.find((w) => w.layer === 'yours' && w.id === at.view.id)?.file ?? null;
  const mine = d.skills.find((k) => k.layer === 'yours' && k.name === at.skill.name);

  if (mine === undefined) return null;

  return mine.files.includes(at.rel) ? join(mine.dir, at.rel) : join(mine.dir, 'SKILL.md');
};

/** The Layer your copy goes to by Propose: the nearest farther one with the same name. */
const proposeToOf = (at: Located): WorkflowLayer | null => {
  if (layerOf(at) !== 'yours') return null;
  const shadows = at.kind === 'workflow' ? at.view.shadows : at.skill.shadows;

  return shadows.find((l) => l !== 'built-in') ?? null;
};

// ── the last retro of a file ────────────────────────────────────────────────────────────────

const retroPath = (ctx: WorkflowEditCtx, listed: string) =>
  join(
    ctx.serve.workflowState,
    'workflow-retros',
    `${createHash('sha256').update(listed).digest('hex').slice(0, 16)}.json`,
  );

const lastRetro = (ctx: WorkflowEditCtx, listed: string) => {
  const text = readText(retroPath(ctx, listed));

  if (text === null) return null;
  try {
    const read = WorkflowRetroData.safeParse(JSON.parse(text));

    return read.success ? read.data : null;
  } catch {
    return null;
  }
};

const known = (d: WorkflowsData) => [
  ...new Set([...d.skills.map((k) => k.name), ...Object.keys(BUILT_IN_STEPS)]),
];

/** `at`'s problems, each with the fixes that take it away (checked through the load again). */
const problemsOf = (ctx: WorkflowEditCtx, w: Where): WorkflowReadData['problems'] => {
  if (w.at.kind !== 'workflow') return [];
  const at = w.at;
  const count = (text: string, code: string) =>
    loaded(ctx, w.repo, { ...at, text })
      .workflows.find((x) => x.file === at.listed)
      ?.problems.filter((p) => p.code === code).length ?? 0;

  return at.view.problems.map((p) => {
    const before = at.view.problems.filter((x) => x.code === p.code).length;

    return {
      line: p.line,
      code: p.code,
      text: p.text,
      fixes: fixesOf(at.text, p, { known: known(w.d), view: at.view }).filter(
        (f) => count(f.text, p.code) < before,
      ),
    };
  });
};

/** A listed file on disk: a built-in one written out read-only under the state (as `workflow path`). */
const onDisk = (ctx: WorkflowEditCtx, listed: string): string => {
  if (!listed.startsWith('built-in/')) return listed;
  const path = join(ctx.serve.workflowState, listed);

  writeReadOnly(path, builtInFile(listed) ?? '');

  return path;
};

/** The nearest farther Layer's file of the same name as `at` (yours): what your copy shadows. */
const fartherOf = (
  d: WorkflowsData,
  at: Located,
): { layer: WorkflowLayer; listed: string } | null => {
  const layer = (at.kind === 'workflow' ? at.view.shadows : at.skill.shadows)[0];

  if (layer === undefined) return null;
  if (at.kind === 'workflow') {
    const file = d.workflows.find((x) => x.id === at.view.id && x.layer === layer)?.file;

    return file === undefined ? null : { layer, listed: file };
  }
  const k = d.skills.find((x) => x.name === at.skill.name && x.layer === layer);

  if (k === undefined) return null;

  return { layer, listed: `${k.dir}/${k.files.includes(at.rel) ? at.rel : 'SKILL.md'}` };
};

/** Compare (⌘D): your copy and the file it shadows, both on disk. */
const compareOf = (ctx: WorkflowEditCtx, d: WorkflowsData, at: Located) => {
  if (layerOf(at) === 'yours') {
    const far = fartherOf(d, at);

    return far === null
      ? null
      : { layer: far.layer, theirs: onDisk(ctx, far.listed), mine: at.listed };
  }
  const mine = mineOf(d, at);

  return mine === null ? null : { layer: 'yours' as const, theirs: onDisk(ctx, at.listed), mine };
};

/** The readable side under no header: a SKILL.md's words, another markdown file as itself. */
const bodyOf = (at: Located, d: WorkflowsData, markdown: string): string => {
  if (at.kind === 'workflow') return markdown;

  return at.rel === 'SKILL.md' ? readableSkillBody(at.skill, d, at.text) : at.text;
};

/** Each step's skill's `SKILL.md` on disk, at the step's line (go to definition). */
const defsOf = (
  ctx: WorkflowEditCtx,
  d: WorkflowsData,
  w: WorkflowView,
): WorkflowReadData['defs'] =>
  w.steps.flatMap((s) => {
    const k = d.skills.find((x) => x.name === s.skill && x.layer === s.skillLayer);

    return s.line === null || k === undefined
      ? []
      : [{ line: s.line, name: k.name, path: onDisk(ctx, `${k.dir}/SKILL.md`) }];
  });

/** Every workflow step running the skill `k`, at its line in its file on disk (find usages). */
const refsOf = (ctx: WorkflowEditCtx, d: WorkflowsData, k: SkillView): WorkflowReadData['refs'] =>
  d.workflows.flatMap((w) =>
    w.steps.flatMap((s) =>
      s.line === null || s.skill !== k.name || s.skillLayer !== k.layer
        ? []
        : [{ path: onDisk(ctx, w.file), line: s.line, text: `${w.name} · ${s.name}` }],
    ),
  );

const readOf = (ctx: WorkflowEditCtx, w: Where): WorkflowReadData => {
  const { d, at } = w;
  const compare = compareOf(ctx, d, at);
  const header: ReadHeader = {
    layer: layerOf(at),
    // the repo's files are the checkout's own, changed and committed like the code (ADR 0033)
    readOnly: layerOf(at) === 'built-in',
    mine: mineOf(d, at),
    proposeTo: proposeToOf(at),
    compare: compare?.layer ?? null,
  };
  const retro = lastRetro(ctx, at.listed);
  const markdown =
    at.kind === 'workflow'
      ? readableWorkflow(at.view, d, header, retro)
      : readableSkill(at.skill, d, header, at.text, at.rel);

  return {
    file: at.listed,
    kind: at.kind,
    layer: header.layer,
    id: idOf(at),
    readOnly: header.readOnly,
    mine: header.mine,
    proposeTo: header.proposeTo,
    markdown,
    text: at.text,
    body: bodyOf(at, d, markdown),
    problems: problemsOf(ctx, w),
    retro,
    compare,
    preview:
      at.kind === 'workflow'
        ? workflowPreview(at.view, d.skills, readHead(d, header, at.view.id).actions)
        : null,
    defs: at.kind === 'workflow' ? defsOf(ctx, d, at.view) : [],
    refs: at.kind === 'skill' ? refsOf(ctx, d, at.skill) : [],
  };
};

// ── Edit my copy ────────────────────────────────────────────────────────────────────────────

const changed = (ctx: WorkflowEditCtx, files: readonly string[]) => {
  ctx.settings?.poll();
  ctx.serve.emit('settings.changed', { keys: [], repo: null, files: [...files] });
};

const writeFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** Where yours go: your skills in your config folder, your workflows the checkout's `.local.yaml`. */
type Mine = { configDir: string; repo: string | undefined };

const mineAt = (ctx: WorkflowEditCtx, configDir: string, repo?: string): Mine => ({
  configDir,
  repo: repo ?? repoRoot(resolve(ctx.cwd, '.')),
});

const NO_REPO_FOR_YOURS = () =>
  refused(
    'not-a-checkout',
    "your workflows sit beside the repo's, in its .abe/workflows/<id>.local.yaml: ask in a checkout",
  );

/** Your workflow `id`: `<main checkout>/.abe/workflows/<id>.local.yaml`; none outside a checkout. */
const yourWorkflowFile = (mine: Mine, id: string): string | undefined =>
  mine.repo === undefined ? undefined : join(yourWorkflowsDir(mine.repo), `${id}.local.yaml`);

/** Written, and yours beside the repo's kept out of git (Abe's exclude block). */
const writeMine = (path: string, text: string) => {
  writeFile(path, text);
  if (path.endsWith('.local.yaml'))
    excludeInstalled(dirname(dirname(dirname(path))), YOURS_IN_REPO);
};

/** Your copy of `at` (yours, `Mine`): made when you have none. */
const copyOf = (mine: Mine, d: WorkflowsData, at: Located): Outcome<WorkflowCopyData> => {
  const layer = layerOf(at);
  const from = at.listed;

  if (layer === 'yours') return { ok: true, data: { from, layer, path: at.listed, existed: true } };
  if (at.kind === 'workflow') {
    const path = yourWorkflowFile(mine, at.view.id);

    if (path === undefined) return NO_REPO_FOR_YOURS();
    if (existsSync(path)) return { ok: true, data: { from, layer, path, existed: true } };
    writeMine(path, textOf(at.listed) ?? at.text);

    return { ok: true, data: { from, layer, path, existed: false } };
  }
  const dir = join(mine.configDir, 'skills', at.skill.name);
  const path = join(dir, at.rel);

  if (existsSync(dir))
    return { ok: true, data: { from, layer, path: mineOf(d, at) ?? path, existed: true } };
  for (const f of at.skill.files) {
    const text =
      at.skill.layer === 'built-in'
        ? BUILT_IN_SKILL_FILES.find((b) => b.path === `skills/${at.skill.name}/${f}`)?.text
        : readText(join(at.skill.dir, f));

    if (text !== undefined && text !== null) writeFile(join(dir, f), text);
  }

  return { ok: true, data: { from, layer, path, existed: false } };
};

// ── Propose ─────────────────────────────────────────────────────────────────────────────────

/** The repo Layer's checkout here. */
const targetOf = (repo: string | undefined): Outcome<{ checkout: string }> =>
  repo === undefined
    ? refused('no-repo', 'not in a checkout: its repo Layer is not here')
    : { ok: true, data: { checkout: repo } };

/**
 * A proposal's files in the repo: a workflow as `abe/workflows/<id>.yaml` (ADR 0033), a skill's
 * files under `.claude/skills/` (ADR 0031).
 */
const proposedFiles = (at: Located): { path: string; content: string }[] =>
  at.kind === 'workflow'
    ? [{ path: `${REPO_WORKFLOWS_DIR}/${at.view.id}.yaml`, content: at.text }]
    : at.skill.files.flatMap((f) => {
        const text = readText(join(at.skill.dir, f));

        return text === null
          ? []
          : [{ path: `${REPO_SKILLS_DIR}/${at.skill.name}/${f}`, content: text }];
      });

// ── Retro on a file ─────────────────────────────────────────────────────────────────────────

/** Where a run with no outcome stands: stopped at Needs you, done, or at its step. */
const outcomeOf = (r: Run): string => {
  if (r.needsYou !== null) return `stopped at ${r.step ?? r.stage}`;

  return r.stage === 'done' ? 'done' : `at ${r.step ?? r.stage}`;
};

/** This Mac's runs of `at` (a workflow's, or of those whose steps run a skill), newest first. */
const runsOf = (ctx: WorkflowEditCtx, at: Located): (FileRetroRun & { path: string })[] =>
  readRuns(ctx.serve.workflowState)
    .flatMap((doc) => {
      const read = Run.safeParse(doc);

      return read.success ? [read.data] : [];
    })
    .filter((r) =>
      at.kind === 'workflow'
        ? r.workflow.id === at.view.id
        : r.workflow.steps.some(
            (s) => s.name === at.skill.name || BUILT_IN_STEPS[s.name]?.skill === at.skill.name,
          ),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20)
    .map((r) => ({
      session: r.session,
      card: r.card,
      title: r.title,
      outcome: r.outcome ?? outcomeOf(r),
      at: r.startedAt,
      path: r.visits.map((v) => v.step ?? v.stage).join(' → '),
    }));

// ── the handlers ────────────────────────────────────────────────────────────────────────────

export const workflowEditHandlers = <Ctx extends WorkflowEditCtx>() =>
  ({
    'workflow read': (args, ctx) => {
      const w = where(ctx, args);

      return Promise.resolve(w.ok ? { ok: true, data: readOf(ctx, w.data) } : w);
    },
    'workflow copy': (args, ctx) => {
      if (ctx.settings === undefined) return Promise.resolve(noSettings());
      const w = where(ctx, args);

      if (!w.ok) return Promise.resolve(w);
      const copy = copyOf(
        mineAt(ctx, ctx.settings.places.configDir, w.data.repo),
        w.data.d,
        w.data.at,
      );

      if (!copy.ok) return Promise.resolve(copy);
      if (!copy.data.existed) changed(ctx, [copy.data.path]);

      return Promise.resolve(copy);
    },
    'workflow propose': async (args, ctx): Promise<Outcome<WorkflowProposeData>> => {
      const settings = ctx.settings;

      if (settings === undefined) return noSettings();
      const w = where(ctx, args);

      if (!w.ok) return w;
      const { d, at, repo } = w.data;

      if (layerOf(at) !== 'yours')
        return refused(
          'not-your-copy',
          `${at.listed} is ${layerOf(at)}'s: Edit my copy first (abe workflow copy), then propose your copy`,
        );
      const why = args.why.trim();

      if (why === '') return refused('reason-required', 'say why: the pull request opens with it');
      const to = proposeToOf(at);

      if (to === null)
        return refused(
          'nothing-to-propose-to',
          `the repo Layer has no ${idOf(at)}: your own one stays yours`,
        );
      const target = targetOf(repo);

      if (!target.ok) return target;
      // held where the checkout asked in, or the one it goes to, is in local mode
      const local = [repo, target.data.checkout].find(
        (dir) => dir !== undefined && ctx.serve.localMode?.at(dir) !== undefined,
      );
      const pulls =
        local === undefined || ctx.serve.localMode === undefined
          ? ctx.ports.layerPulls
          : ctx.serve.localMode.layerPulls(ctx.ports.layerPulls, local);

      if (pulls === undefined) return noLayerPulls();
      const github = await githubOf(target.data.checkout);

      if (!github.ok) return github;
      const files = proposedFiles(at);
      const base = await pulls.base(github.data);

      if (!base.ok) return refused(base.error.code, base.error.message);
      const branch = proposeBranch(at.kind, idOf(at));
      const open = await ctx.ports.tracking.prFind({ repo: github.data, head: branch });

      if (!open.ok) return refused(open.error.code, open.error.message);
      const where2 = layerWords(d, to);
      const title = proposeTitle(where2, idOf(at));
      const made = await pulls.propose({
        repo: github.data,
        base: base.data,
        branch,
        title,
        body: proposeBody({ where: where2, files: files.map((f) => f.path), why }),
        message: title,
        label: null,
        files,
        ...(open.data === null ? {} : { pull: open.data.number }),
      });

      if (!made.ok) return refused(made.error.code, made.error.message);

      return {
        ok: true,
        data: {
          path: at.listed,
          to,
          where: where2,
          repo: github.data,
          branch,
          files: files.map((f) => f.path),
          pr: made.data,
          existing: open.data !== null,
          held: local !== undefined,
        },
      };
    },
    'workflow change': async (args, ctx): Promise<Outcome<WorkflowChangeData>> => {
      const settings = ctx.settings;

      if (settings === undefined) return noSettings();
      const w = where(ctx, args);

      if (!w.ok) return w;
      const { d, at, repo } = w.data;
      const wish = args.wish.join(' ').trim();

      if (wish === '')
        return refused('usage', 'say what to change: abe workflow change <file> <wish>', 2);
      const asked = await askOneShot(ctx, {
        role: 'writer',
        cwd: ctx.cwd,
        reach: {},
        system: CHANGE_SYSTEM,
        prompt: changePrompt({
          file: at.listed,
          kind: at.kind,
          text: at.text,
          wish,
          skills: d.skills
            .filter((k) => k.inForce)
            .map((k) => ({ name: k.name, description: k.description })),
        }),
      });

      if (!asked.ok) return asked;
      const read = readJsonAnswer(asked.data.text, ChangeAnswer);

      if (!read.ok)
        return refused('change-unreadable', `the one-shot's answer is no change (${read.message})`);
      const text = read.data.text.endsWith('\n') ? read.data.text : `${read.data.text}\n`;

      if (text === at.text)
        return refused('nothing-changed', `${read.data.summary}: the file reads the same`);
      const view =
        at.kind === 'workflow'
          ? (loaded(ctx, repo, { ...at, text }).workflows.find((x) => x.file === at.listed) ?? null)
          : null;
      const problems = view?.problems.length ?? 0;
      let written: string | null = null;

      if (args.write) {
        const copy = copyOf(mineAt(ctx, settings.places.configDir, repo), d, at);

        if (!copy.ok) return copy;
        written = copy.data.path;
        writeMine(written, text);
        changed(ctx, [written]);
      }

      return {
        ok: true,
        data: {
          file: at.listed,
          summary: read.data.summary,
          before: at.text,
          text,
          problems,
          written,
          view,
        },
      };
    },
    'workflow retro': async (args, ctx) => {
      const w = where(ctx, args);

      if (!w.ok) return w;
      const { at } = w.data;
      const runs = runsOf(ctx, at);
      const asked = await askOneShot(ctx, {
        role: 'writer',
        cwd: ctx.cwd,
        reach: {},
        system: FILE_RETRO_SYSTEM,
        prompt: fileRetroPrompt({ file: at.listed, text: at.text, runs }),
      });

      if (!asked.ok) return asked;
      const read = readJsonAnswer(asked.data.text, FileRetroAnswer);

      if (!read.ok)
        return refused(
          'retro-unreadable',
          `the one-shot's answer is no findings (${read.message})`,
        );
      // a fix that does not read as the file is dropped, the finding kept
      const findings = read.data.findings.map((f) => {
        if (f.fix === null || at.kind !== 'workflow') return f;
        const fixed = loaded(ctx, w.data.repo, { ...at, text: f.fix.text }).workflows.find(
          (x) => x.file === at.listed,
        );

        return fixed?.ok === true ? f : { ...f, fix: null };
      });
      const data = {
        file: at.listed,
        id: idOf(at),
        at: new Date(ctx.serve.clock.now()).toISOString(),
        runs: runs.map((r) => ({
          session: r.session,
          card: r.card,
          title: r.title,
          outcome: r.outcome,
          at: r.at,
        })),
        findings,
      };

      writeFile(retroPath(ctx, at.listed), `${JSON.stringify(data, null, 2)}\n`);

      return { ok: true, data };
    },
  }) satisfies Partial<Handlers<Ctx>>;
