/**
 * The load check (#15): every Layer's `workflows/*.yaml` read into the view the Editor's preview,
 * the tree and `abe workflow list` show, with what is wrong in each, as problems are shown in code (the file,
 * its line, one line of why). A file failing it is not offered on a card, and no earlier version
 * of it runs: of an id, only the nearest Layer's file counts.
 *
 * Checked: YAML, the schema, every step's skill found in a Layer (its `skill:`, else its name's),
 * each step once, `pr` last, checks / review / verify each after a build step, pins kept by
 * nearer copies, loops between steps of the file (back, never forward), each `when:` /
 * `done_when:` / `ends:` at most one of `check:` (over facts the steps report) or `judge:` (a
 * question with `sees:`; a gate's sees the card, the spec or the diff), `max:` on every loop.
 */
import { z } from 'zod';
import { factsIn, parseCheck } from './expr';
import {
  AFTER_BUILD,
  BUILT_IN_SKILLS,
  builtInStep,
  FACTS,
  factsOfKind,
  FRESH_MODES,
  type FreshMode,
  nearness,
  SEES,
  STEP_KINDS,
  type StepKind,
  WORKFLOW_LAYERS,
  type WorkflowLayer,
} from './kinds';
import { HUB_INVOKED_SKILLS } from '../skills';
import { type Condition, FACTORY_LOOP_MAX, FACTORY_REVIEW_MAX, type RunWorkflow } from './run';
import { type ConditionFile, EndsFile, LoopFile, StepOptions, WorkflowFile } from './schema';

/** A path into a file's YAML: keys and list indexes. */
export type YamlPath = readonly (string | number)[];

/**
 * One workflow file as the ports read it: its parsed YAML, or why it does not parse and where;
 * `lineOf` finds a path's line (1-based) in its text.
 */
export type WorkflowSource = {
  layer: WorkflowLayer;
  /** Its path, as the problem's way opens it. */
  file: string;
  /** Its name without `.yaml`: the workflow's id. */
  id: string;
  read: { doc: unknown } | { error: string; line: number | null };
  lineOf?: (path: YamlPath) => number | null;
};

/**
 * A skill folder a Layer has (`skills/<name>/`); the ports add where it is (`dir`: its folder, or
 * `built-in/skills/<name>`), its `SKILL.md` frontmatter's `description:` and its files.
 */
export type SkillSource = {
  name: string;
  layer: WorkflowLayer;
  dir?: string;
  description?: string;
  /** Its files' paths relative to `dir`, sorted (`SKILL.md`, `scripts/seed.sh`). */
  files?: readonly string[];
};

export const WORKFLOW_PROBLEM_CODES = [
  'not-yaml',
  'schema',
  'unknown-skill',
  'duplicate-step',
  'pr-last',
  'checks-skill',
  'needs-build',
  'pin-nearer',
  'pin-dropped',
  'pin-moved',
  'loop-step',
  'loop-forward',
  'both-kinds',
  'no-max',
  'judge-question',
  'judge-sees',
  'gate-sees',
  'bad-check',
  'unknown-fact',
  'text-fact',
  'into-step',
  'into-fact',
] as const;
export type WorkflowProblemCode = (typeof WORKFLOW_PROBLEM_CODES)[number];

export const WorkflowLayerName = z.enum(WORKFLOW_LAYERS);

/** Something wrong in a workflow file: where (its line when known), what, and the fix if one is plain. */
export const WorkflowProblem = z.object({
  workflow: z.string(),
  layer: WorkflowLayerName,
  file: z.string(),
  line: z.number().int().positive().nullable(),
  code: z.enum(WORKFLOW_PROBLEM_CODES),
  text: z.string(),
  /** The quick fix in words (⌥⏎), when there is one. */
  fix: z.string().nullable(),
});
export type WorkflowProblem = z.infer<typeof WorkflowProblem>;

export const ConditionView = z.discriminatedUnion('kind', [
  /** Abe evaluates it, no model; `facts`: the facts it reads. */
  z.object({ kind: z.literal('check'), check: z.string(), facts: z.array(z.string()) }),
  /** The step's own agent answers it. */
  z.object({ kind: z.literal('judge'), question: z.string(), sees: z.array(z.string()) }),
]);
export type ConditionView = z.infer<typeof ConditionView>;

/** A step's `ends:`: when (null: always) the run ends after it, with its report. */
export const EndsView = z.object({ when: ConditionView.nullable(), then: z.literal('report') });
export type EndsView = z.infer<typeof EndsView>;

export const WorkflowStepView = z.object({
  /** As the file names it: a skill, or a built-in step. */
  name: z.string(),
  kind: z.enum(STEP_KINDS),
  /** Its one main skill (`skill:`, else its name's); null for checks (serve runs them). */
  skill: z.string().nullable(),
  /** How fresh its subagent starts (`fresh:`; the preview's ⟲). */
  fresh: z.enum(FRESH_MODES).default('never'),
  /** Its gate (`when:`): it runs only when this holds, else it is skipped. */
  gate: ConditionView.nullable().default(null),
  /** Its way out (`ends:`): the run ends after it, with its report. */
  ends: EndsView.nullable().default(null),
  /** The Layer its skill was found in; null when none has it (a problem) or it runs none. */
  skillLayer: WorkflowLayerName.nullable(),
  /** The built-in's jump in words (`red → build`); null for a plain step. */
  jump: z.string().nullable(),
  /** The Layer that pins it, when one does (its own or one farther). */
  pin: WorkflowLayerName.nullable(),
  reviewers: z.array(z.string()),
  /** The facts it reports: a built-in's own, then its `reports:`. */
  reports: z.array(z.string()),
  doneWhen: ConditionView.nullable(),
  /** A pr step's `into:`: the text fact naming the branch its pull request goes into. */
  into: z.string().nullable().default(null),
  line: z.number().int().positive().nullable(),
});
export type WorkflowStepView = z.infer<typeof WorkflowStepView>;

export const LoopView = z.object({
  /** Its number (1, 2, …): the Map's arc and the run's count. */
  id: z.string(),
  from: z.string(),
  to: z.string(),
  when: ConditionView,
  carries: z.array(z.string()),
  max: z.number().int().positive(),
  /** Not in the file: a checks, review or verify step's own way back to build. */
  implied: z.boolean(),
  line: z.number().int().positive().nullable(),
});
export type LoopView = z.infer<typeof LoopView>;

export const WorkflowOnView = z.object({
  /** A card no other workflow takes. */
  default: z.boolean(),
  types: z.array(z.string()),
  tags: z.array(z.string()),
});
export type WorkflowOnView = z.infer<typeof WorkflowOnView>;

/** One workflow file as loaded: what it says, whether it runs, and why not. */
export const WorkflowView = z.object({
  id: z.string(),
  layer: WorkflowLayerName,
  file: z.string(),
  /** Its `name:`; the id when the file does not read. */
  name: z.string(),
  description: z.string(),
  on: WorkflowOnView.nullable(),
  branch: z.string().nullable(),
  steps: z.array(WorkflowStepView),
  loops: z.array(LoopView),
  /** It passed the load check. */
  ok: z.boolean(),
  /** The nearest of its id and ok: the one offered and run. */
  inForce: z.boolean(),
  /** Farther Layers with a file of the same id, nearest first. */
  shadows: z.array(WorkflowLayerName),
  problems: z.array(WorkflowProblem),
});
export type WorkflowView = z.infer<typeof WorkflowView>;

export const FactView = z.object({
  name: z.string(),
  about: z.string(),
  type: z.enum(['count', 'text']),
  by: z.array(z.enum(STEP_KINDS)),
});

/** One skill folder of a Layer, as `abe workflow list` lists it. */
export const SkillView = z.object({
  name: z.string(),
  layer: WorkflowLayerName,
  /** Its folder: a real path, or `built-in/skills/<name>` (`abe workflow path` opens its files). */
  dir: z.string(),
  /** Its `SKILL.md` frontmatter's `description:`; '' when none. */
  description: z.string(),
  /** Its files' paths relative to `dir`, sorted (`SKILL.md`, `scripts/seed.sh`). */
  files: z.array(z.string()),
  /** The nearest Layer's of its name: the one steps run. */
  inForce: z.boolean(),
  /** Farther Layers with a skill of the same name, nearest first. */
  shadows: z.array(WorkflowLayerName),
  /** The in-force workflows (ids) with a step running this one. */
  usedBy: z.array(z.string()),
  /** Abe's (or the repo's copy in `abe/skills`), invoked in the Abe chat as `/abe:<name>` (`HUB_INVOKED_SKILLS`). */
  invoked: z.boolean().default(false),
});
export type SkillView = z.infer<typeof SkillView>;

/** A Layer that applies here: its name (the repo's folder) and its folder. */
export const LayerView = z.object({
  layer: WorkflowLayerName,
  /** The repo's folder name; null for yours and built-in. */
  name: z.string().nullable(),
  /** The folder holding its `workflows/` and `skills/`; null for built-in. */
  dir: z.string().nullable(),
});
export type LayerView = z.infer<typeof LayerView>;

/** A workflow's Factory runs on this Mac in the last 30 days, and how many fired each loop. */
export const RecentView = z.object({
  workflow: z.string(),
  runs: z.number().int().nonnegative(),
  /** By loop id: the runs that went back by it at least once. */
  loops: z.record(z.string(), z.number().int().nonnegative()),
});
export type RecentView = z.infer<typeof RecentView>;

/** `abe workflow list`: every Layer's workflows, nearest first, the facts, and every problem. */
export const WorkflowsData = z.object({
  workflows: z.array(WorkflowView),
  facts: z.array(FactView),
  problems: z.array(WorkflowProblem),
  /** Every Layer's skill folders, nearest first then by name. */
  skills: z.array(SkillView).default([]),
  /** The Layers that apply, nearest first. */
  layers: z.array(LayerView).default([]),
  /** This Mac's runs of each workflow in the last 30 days. */
  recent: z.array(RecentView).default([]),
});
export type WorkflowsData = z.infer<typeof WorkflowsData>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A step entry's name and options, read loosely (before the schema). */
const stepOf = (entry: unknown): { name: string; options: Record<string, unknown> } | null => {
  if (typeof entry === 'string') return { name: entry, options: {} };
  if (!isRecord(entry)) return null;
  const [first] = Object.entries(entry);

  return first === undefined
    ? null
    : { name: first[0], options: isRecord(first[1]) ? first[1] : {} };
};

type Found = Omit<WorkflowProblem, 'workflow' | 'layer' | 'file'>;

const problem = (
  code: WorkflowProblemCode,
  text: string,
  line: number | null,
  fix: string | null = null,
): Found => ({ code, text, line, fix });

const CONDITION_WORDS = 'exactly one of check: or judge:';

/** The friendly problems the schema would say only as `invalid input`: read off the raw YAML. */
const rawProblems = (doc: unknown, lineOf: (p: YamlPath) => number | null): Found[] => {
  if (!isRecord(doc)) return [];
  const out: Found[] = [];
  const condition = (c: unknown, path: YamlPath, what: string) => {
    if (!isRecord(c)) return;
    const hasCheck = c.check !== undefined;
    const hasJudge = c.judge !== undefined;

    if (hasCheck && hasJudge)
      out.push(
        problem(
          'both-kinds',
          `One kind per condition: this ${what} has both check: and judge:; keep the check: when a fact says it`,
          lineOf([...path, 'judge']) ?? lineOf(path),
          'Keep check:, drop judge:',
        ),
      );
    else if (!hasCheck && !hasJudge)
      out.push(problem('schema', `a ${what} has ${CONDITION_WORDS}`, lineOf(path)));
    if (hasJudge && c.sees === undefined)
      out.push(
        problem(
          'judge-sees',
          'a judge names what it sees: (sees: [facts or evidence])',
          lineOf([...path, 'judge']) ?? lineOf(path),
        ),
      );
  };
  // `ends:` takes at most one of check: or judge: (none: always)
  const endsProblems = (c: unknown, path: YamlPath) => {
    if (!isRecord(c)) return;
    if (c.check !== undefined && c.judge !== undefined)
      out.push(
        problem(
          'both-kinds',
          'One kind per condition: this ends: has both check: and judge:; keep the check: when a fact says it',
          lineOf([...path, 'judge']) ?? lineOf(path),
          'Keep check:, drop judge:',
        ),
      );
    if (c.judge !== undefined && c.sees === undefined)
      out.push(
        problem(
          'judge-sees',
          'a judge names what it sees: (sees: [card, spec or diff])',
          lineOf([...path, 'judge']) ?? lineOf(path),
        ),
      );
  };
  const loops = Array.isArray(doc.loops) ? doc.loops : [];

  loops.forEach((l: unknown, i) => {
    if (!isRecord(l)) return;
    if (l.max === undefined)
      out.push(
        problem(
          'no-max',
          'a loop needs max: (how many times it may go back; past it the run stops at Needs you)',
          lineOf(['loops', i]),
          'Add max: 2',
        ),
      );
    condition(l.when, ['loops', i, 'when'], 'when:');
  });
  const steps = Array.isArray(doc.steps) ? doc.steps : [];

  steps.forEach((s: unknown, i) => {
    const step = stepOf(s);

    if (step !== null) {
      condition(step.options.done_when, ['steps', i, step.name, 'done_when'], 'done_when:');
      condition(step.options.when, ['steps', i, step.name, 'when'], 'when:');
      endsProblems(step.options.ends, ['steps', i, step.name, 'ends']);
    }
  });

  return out;
};

const startsWith = (path: YamlPath, prefix: YamlPath) =>
  prefix.every((p, i) => String(path[i]) === String(p));

/** What a key takes, in words: the allowed side of a schema problem there. */
const TAKES: Record<string, string> = {
  file: 'a map: name:, steps: and the rest',
  on: 'a card type (on: bug), default, or { type: bug, tags: [qa] }',
  type: 'a card type, or a list of them: [bug, task]',
  tags: 'a list of tags: [qa]',
  steps: "a list of steps, each a skill's name or `- name: { skill: … }`",
  step: "a skill's name, or `- name: { skill: …, fresh: … }`",
  loops: 'a list of loops: `- { from: …, to: …, when: { check: … }, max: 2 }`',
  loop: '{ from: …, to: …, when: { check: … }, max: 2 }',
  fresh: 'true, false or loop',
  when: 'one of { check: … } or { judge: …?, sees: [ … ] }',
  done_when: 'one of { check: … } or { judge: …?, sees: [ … ] }',
  ends: '{ then: report }, with a check: or judge: when it ends only sometimes',
  max: 'a whole number, 1 or more',
  name: 'text',
  description: 'text',
  branch: 'text, like card/<card>',
  skill: "a skill's name",
  from: "a step's name",
  to: "a step's name",
  check: 'an expression over facts, like checks.failed > 0',
  judge: 'a yes/no question, ending in ?',
  sees: 'a list: [card, spec, diff]',
  carries: 'a list: [checks.output]',
  reviewers: 'a list of names',
  reports: 'a list of facts',
  into: 'a text fact an earlier step reports, like audit.head',
};

/** The keys an object in the file takes, and what it is in words, by its path. */
const keysAt = (path: YamlPath): { what: string; keys: string[] } => {
  const last = path.at(-1);
  const keys = (o: Record<string, unknown>) => Object.keys(o);

  if (last === undefined) return { what: 'a workflow', keys: keys(WorkflowFile.shape) };
  if (last === 'on') return { what: 'on:', keys: ['type', 'tags'] };
  if (last === 'ends') return { what: 'ends:', keys: keys(EndsFile.shape) };
  if (last === 'when' || last === 'done_when')
    return { what: `${last}:`, keys: ['check', 'judge', 'sees'] };
  if (path.at(-2) === 'loops') return { what: 'a loop', keys: keys(LoopFile.shape) };

  return { what: "a step's options", keys: keys(StepOptions.shape) };
};

/** The key a path ends at, as the file says it (`fresh:`, a step, the file). */
const keyOf = (path: YamlPath): string => {
  const last = path.at(-1);

  if (last === undefined) return 'file';
  if (typeof last === 'string') return last;

  return path.at(-2) === 'loops' ? 'loop' : 'step';
};
const labelOf = (key: string) => {
  if (key === 'file') return 'The file';

  return key === 'step' || key === 'loop' ? `A ${key}` : `${key}:`;
};

const RECEIVED: Record<string, string> = {
  string: 'text',
  number: 'a number',
  boolean: 'true or false',
  object: 'a map',
  array: 'a list',
  null: 'empty',
};

/**
 * A schema issue in plain words: what is wrong and what is allowed (`tags: takes a list of tags:
 * [qa], not text`), never zod's `Invalid input`. A union says the branch that got furthest.
 */
const plainIssues = (i: z.core.$ZodIssue, at: YamlPath): { path: YamlPath; text: string }[] => {
  const path: YamlPath = [...at, ...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p))];
  const key = keyOf(path);
  const label = labelOf(key);
  const takes = TAKES[key];

  if (i.code === 'invalid_union') {
    // the branch that read past its own type (into a key): its issues; else the key's allowed forms
    const deep = i.errors.find((b) =>
      b.some((e) => e.path.length > 0 || e.code === 'unrecognized_keys' || e.code === 'custom'),
    );

    if (deep !== undefined && i.errors.length > 1) return deep.flatMap((e) => plainIssues(e, path));

    return [{ path, text: takes ? `${label} takes ${takes}` : `${label} doesn't read` }];
  }
  if (i.code === 'unrecognized_keys') {
    const { what, keys } = keysAt(path);
    const named = i.keys.map((k) => `${k}:`).join(', ');

    return [
      {
        path: [...path, i.keys[0] ?? ''],
        text: `${named} ${i.keys.length === 1 ? "isn't a key" : "aren't keys"} of ${what}; it takes ${keys.join(', ')}`,
      },
    ];
  }
  if (i.code === 'invalid_type') {
    const received = /received (\w+)/.exec(i.message)?.[1];

    if (received === 'undefined')
      return [{ path, text: `${label} is missing${takes ? `: it takes ${takes}` : ''}` }];
    const not = received && RECEIVED[received] ? `, not ${RECEIVED[received]}` : '';

    return [{ path, text: takes ? `${label} takes ${takes}${not}` : `${label} ${i.message}` }];
  }
  if (i.code === 'invalid_value')
    return [{ path, text: `${label} takes ${i.values.map(String).join(', ')}` }];
  if (i.code === 'too_small' && key === 'steps')
    return [{ path, text: 'steps: needs at least one step' }];
  if (i.code === 'custom') return [{ path, text: i.message }];

  return [{ path, text: takes ? `${label} takes ${takes}` : `${label} ${i.message}` }];
};

/** The schema's issues in plain words, but none under a path a friendly problem already speaks of. */
const schemaProblems = (
  error: z.ZodError,
  lineOf: (p: YamlPath) => number | null,
  said: readonly YamlPath[],
): Found[] =>
  error.issues
    .flatMap((i) => plainIssues(i, []))
    .filter(({ path }) => !said.some((s) => startsWith(path, s)))
    .map(({ path, text }) => problem('schema', text, lineOf(path) ?? lineOf(path.slice(0, -1))));

/** Where a raw problem speaks: its loop, or its condition. */
const saidPaths = (doc: unknown): YamlPath[] => {
  if (!isRecord(doc)) return [];
  const loops = Array.isArray(doc.loops) ? doc.loops : [];
  const steps = Array.isArray(doc.steps) ? doc.steps : [];

  return [
    ...loops.flatMap((l: unknown, i): YamlPath[] =>
      isRecord(l) ? [['loops', i, 'when'], ...(l.max === undefined ? [['loops', i]] : [])] : [],
    ),
    ...steps.flatMap((s: unknown, i): YamlPath[] => {
      const step = stepOf(s);

      if (step === null) return [];
      // a step is one union: zod says its bad condition as the whole step's `Invalid input`
      const bad = ['done_when', 'when', 'ends'].some((k) => {
        const c = step.options[k];

        return isRecord(c) && (c.check !== undefined) === (c.judge !== undefined) && k !== 'ends';
      });

      return [
        ...(bad ? [['steps', i]] : []),
        ['steps', i, step.name, 'done_when'],
        ['steps', i, step.name, 'when'],
        ['steps', i, step.name, 'ends'],
      ];
    }),
  ];
};

const conditionView = (c: ConditionFile): ConditionView => {
  if ('check' in c) {
    const parsed = parseCheck(c.check);

    return { kind: 'check', check: c.check, facts: parsed.ok ? factsIn(parsed.expr) : [] };
  }

  return { kind: 'judge', question: c.judge, sees: c.sees };
};

const endsView = (e: EndsFile): EndsView => {
  if (e.check !== undefined) return { when: conditionView({ check: e.check }), then: e.then };
  if (e.judge !== undefined)
    return { when: conditionView({ judge: e.judge, sees: e.sees ?? [] }), then: e.then };

  return { when: null, then: e.then };
};

/** A step's `fresh:` as a mode. */
const freshOf = (f: StepOptions['fresh']): FreshMode => {
  if (f === 'loop') return 'loop';

  return f === true ? 'always' : 'never';
};

/** The default way back of a checks, review or verify step with no loop of its own. */
const IMPLIED: Readonly<
  Partial<Record<StepKind, { check: string; carries: string[]; max: number }>>
> = {
  checks: { check: 'checks.failed > 0', carries: ['checks.output'], max: FACTORY_LOOP_MAX },
  review: { check: 'review.findings > 0', carries: ['review.findings'], max: FACTORY_REVIEW_MAX },
  verify: {
    check: 'criteria.failed > 0',
    carries: ['criterion', 'evidence'],
    max: FACTORY_LOOP_MAX,
  },
};

const onView = (on: WorkflowFile['on']): WorkflowOnView | null => {
  if (on === undefined) return null;
  if (typeof on === 'string')
    return on === 'default'
      ? { default: true, types: [], tags: [] }
      : { default: false, types: [on], tags: [] };
  const type = on.type ?? [];
  const types = typeof type === 'string' ? [type] : type;

  return { default: false, types, tags: on.tags ?? [] };
};

/** Where a skill is found: the nearest Layer that has it, or built-in while Abe's is in force. */
const skillLayerOf = (
  skill: string,
  skills: readonly SkillSource[],
  builtIn: readonly string[],
): WorkflowLayer | null => {
  const found = skills
    .filter((s) => s.name === skill)
    .sort((a, b) => nearness(a.layer) - nearness(b.layer))[0];

  if (found !== undefined) return found.layer;

  return builtIn.some((b) => b === skill) ? 'built-in' : null;
};

type Checked = {
  view: Omit<WorkflowView, 'inForce' | 'shadows' | 'problems'>;
  found: Found[];
  /** Pinned steps' names in order, for the nearer copies. */
  pinned: string[];
  file: WorkflowFile | null;
};

/** One file through the check, pins aside (they need the other Layers). */
const checkOne = (
  src: WorkflowSource,
  skills: readonly SkillSource[],
  builtIn: readonly string[],
): Checked => {
  const lineOf = src.lineOf ?? (() => null);
  const bare = {
    id: src.id,
    layer: src.layer,
    file: src.file,
    name: src.id,
    description: '',
    on: null,
    branch: null,
    steps: [],
    loops: [],
    ok: false,
  };

  if ('error' in src.read)
    return {
      view: bare,
      found: [
        problem(
          'not-yaml',
          `Can't read ${src.file.slice(src.file.lastIndexOf('/') + 1)}${src.read.line === null ? '' : `: line ${src.read.line}`}: ${src.read.error}`,
          src.read.line,
        ),
      ],
      pinned: [],
      file: null,
    };
  const doc = src.read.doc;
  const raw = rawProblems(doc, lineOf);
  const parsed = WorkflowFile.safeParse(doc);

  if (!parsed.success)
    return {
      view: bare,
      found: [
        ...raw,
        ...schemaProblems(parsed.error, lineOf, raw.length === 0 ? [] : saidPaths(doc)),
      ],
      pinned: [],
      file: null,
    };
  const wf = parsed.data;
  const found: Found[] = [...raw];
  const seen = new Set<string>();
  const kindsSeen = new Set<StepKind>();
  const steps = wf.steps.map((entry, i): WorkflowStepView => {
    const none: StepOptions = {};
    const { name, options } =
      typeof entry === 'string'
        ? { name: entry, options: none }
        : (Object.entries(entry).map(([n, o]) => ({ name: n, options: o }))[0] ?? {
            name: '',
            options: none,
          });
    const line = lineOf(['steps', i]);
    const built = builtInStep(name);
    const kind: StepKind = built?.kind ?? 'step';
    const skill = kind === 'checks' ? null : (options.skill ?? built?.skill ?? name);
    const skillLayer = skill === null ? null : skillLayerOf(skill, skills, builtIn);

    if (kind === 'checks' && options.skill !== undefined)
      found.push(
        problem(
          'checks-skill',
          `${name} runs no skill: serve runs the repo's checks`,
          lineOf(['steps', i, name, 'skill']) ?? line,
          'Drop skill:',
        ),
      );
    if (skill !== null && skillLayer === null)
      found.push(
        problem(
          'unknown-skill',
          `No skill named ${skill} in any Layer`,
          line,
          `Make skill ${skill}, or pick another`,
        ),
      );
    if (seen.has(name)) found.push(problem('duplicate-step', `${name} is a step twice`, line));
    else if (kind !== 'step' && kind !== 'build' && kindsSeen.has(kind))
      found.push(problem('duplicate-step', `${name} is a second ${kind} step`, line));
    seen.add(name);
    kindsSeen.add(kind);
    if (options.pin !== undefined && nearness(options.pin) < nearness(src.layer))
      found.push(
        problem(
          'pin-nearer',
          `${name} is pinned by ${options.pin}, nearer than this file's Layer (${src.layer}): a Layer pins only for those below it`,
          line,
        ),
      );

    return {
      name,
      kind,
      skill,
      skillLayer,
      fresh: freshOf(options.fresh),
      gate: options.when === undefined ? null : conditionView(options.when),
      ends: options.ends === undefined ? null : endsView(options.ends),
      jump: built?.jump ?? null,
      pin: options.pin ?? null,
      reviewers: options.reviewers ?? [],
      reports: [...new Set([...factsOfKind(kind), ...(options.reports ?? [])])],
      doneWhen: options.done_when === undefined ? null : conditionView(options.done_when),
      into: options.into ?? null,
      line,
    };
  });
  const index = (name: string) => steps.findIndex((s) => s.name === name);

  steps.forEach((s, i) => {
    if (s.kind === 'pr' && i !== steps.length - 1)
      found.push(problem('pr-last', 'pr is the last step: the run ends at its merge', s.line));
    if (AFTER_BUILD.includes(s.kind) && !steps.slice(0, i).some((b) => b.kind === 'build')) {
      const build = steps.find((b) => b.kind === 'build');

      found.push(
        problem(
          'needs-build',
          `${s.name} needs a build step before it${build === undefined ? '' : `: ${build.name} is on line ${build.line ?? '?'}`}. A ${s.name} with nothing built has nothing to check`,
          s.line,
          build === undefined ? null : `Move ${s.name} after ${build.name}`,
        ),
      );
    }
  });
  const reported = new Set(steps.flatMap((s) => s.reports));
  const checkFacts = (c: ConditionView, path: YamlPath, facts: ReadonlySet<string>) => {
    if (c.kind === 'judge') {
      if (!c.question.trim().endsWith('?'))
        found.push(
          problem(
            'judge-question',
            'a judge: is one yes/no question, ending in ?',
            lineOf([...path, 'judge']),
          ),
        );

      return;
    }
    const parsedCheck = parseCheck(c.check);

    if (!parsedCheck.ok) {
      found.push(
        problem(
          'bad-check',
          `check: ${parsedCheck.message} (at ${parsedCheck.at + 1})`,
          lineOf([...path, 'check']),
        ),
      );

      return;
    }
    for (const f of factsIn(parsedCheck.expr)) {
      if (!facts.has(f))
        found.push(
          problem(
            'unknown-fact',
            `check: ${f} is no fact a step here reports`,
            lineOf([...path, 'check']),
          ),
        );
      else if (FACTS[f]?.type === 'text')
        found.push(
          problem(
            'text-fact',
            `check: ${f} is text: carries: hands it back, a check: can't compare it`,
            lineOf([...path, 'check']),
          ),
        );
    }
  };

  steps.forEach((s, i) => {
    const path: YamlPath = ['steps', i, s.name];

    if (s.doneWhen !== null) checkFacts(s.doneWhen, [...path, 'done_when'], new Set(s.reports));
    // a gate reads what the steps before it reported, or sees the card, the spec or the diff
    if (s.gate !== null) {
      checkFacts(s.gate, [...path, 'when'], new Set(steps.slice(0, i).flatMap((b) => b.reports)));
      const unseen = s.gate.kind === 'judge' ? s.gate.sees.filter((x) => !isSees(x)) : [];

      if (unseen.length > 0)
        found.push(
          problem(
            'gate-sees',
            `a gate's call sees the ${SEES.join(', the ')}: not ${unseen.join(', ')}`,
            lineOf([...path, 'when', 'sees']),
          ),
        );
    }
    const ends = s.ends?.when ?? null;

    if (ends !== null)
      checkFacts(ends, [...path, 'ends'], new Set(steps.slice(0, i + 1).flatMap((b) => b.reports)));
    // into: the branch a pr step opens into, a fact a step before it reports
    if (s.into !== null && s.kind !== 'pr')
      found.push(
        problem(
          'into-step',
          `into: is a pr step's: ${s.name} opens no pull request`,
          lineOf([...path, 'into']),
          'Drop into:',
        ),
      );
    else if (s.into !== null && !steps.slice(0, i).some((b) => b.reports.includes(s.into ?? '')))
      found.push(
        problem(
          'into-fact',
          `into: ${s.into} is no fact a step before ${s.name} reports: add it to that step's reports:`,
          lineOf([...path, 'into']),
        ),
      );
    else if (s.into !== null && FACTS[s.into]?.type === 'count')
      found.push(
        problem(
          'into-fact',
          `into: ${s.into} is a count: into: names a text fact, the branch`,
          lineOf([...path, 'into']),
        ),
      );
  });
  const declared = (wf.loops ?? []).map((l, i): LoopView => {
    const line = lineOf(['loops', i]);
    const from = index(l.from);
    const to = index(l.to);

    if (from === -1)
      found.push(
        problem(
          'loop-step',
          `from: ${l.from} is no step of this workflow`,
          lineOf(['loops', i, 'from']),
        ),
      );
    if (to === -1)
      found.push(
        problem('loop-step', `to: ${l.to} is no step of this workflow`, lineOf(['loops', i, 'to'])),
      );
    if (from !== -1 && to !== -1 && to > from)
      found.push(
        problem(
          'loop-forward',
          `to: ${l.to} comes after from: ${l.from}; a loop goes back, or to the same step`,
          lineOf(['loops', i, 'to']),
        ),
      );
    const when = conditionView(l.when);

    checkFacts(when, ['loops', i, 'when'], reported);

    return {
      id: String(i + 1),
      from: l.from,
      to: l.to,
      when,
      carries: l.carries ?? [],
      max: l.max,
      implied: false,
      line,
    };
  });
  const implied = steps.flatMap((s, i): LoopView[] => {
    const way = IMPLIED[s.kind];
    const build = steps.slice(0, i).findLast((b) => b.kind === 'build');

    if (way === undefined || build === undefined || declared.some((l) => l.from === s.name))
      return [];

    return [
      {
        id: '',
        from: s.name,
        to: build.name,
        when: conditionView({ check: way.check }),
        carries: way.carries,
        max: way.max,
        implied: true,
        line: null,
      },
    ];
  });
  const loops = [...declared, ...implied].map((l, i) => ({ ...l, id: String(i + 1) }));

  return {
    view: {
      id: src.id,
      layer: src.layer,
      file: src.file,
      name: wf.name,
      description: wf.description ?? '',
      on: onView(wf.on),
      branch: wf.branch ?? null,
      steps,
      loops,
      ok: found.length === 0,
    },
    found,
    pinned: steps.filter((s) => s.pin !== null).map((s) => s.name),
    file: wf,
  };
};

/** Pins a farther copy set that this nearer one drops or reorders. */
const pinProblems = (near: Checked, farther: readonly Checked[]): Found[] => {
  const names = near.view.steps.map((s) => s.name);

  return farther.flatMap((far) => {
    const at = far.pinned.map((p) => names.indexOf(p));
    const dropped = far.pinned.filter((_, i) => at[i] === -1);
    const kept = at.filter((i) => i !== -1);
    const moved = kept.some((v, i) => i > 0 && v < (kept[i - 1] ?? -1));

    return [
      ...dropped.map((p) =>
        problem(
          'pin-dropped',
          `${p} is pinned by ${far.view.layer}'s ${far.view.id}.yaml: a copy keeps it, and may add around it`,
          null,
          `Put ${p} back`,
        ),
      ),
      ...(moved
        ? [
            problem(
              'pin-moved',
              `the steps ${far.view.layer} pins (${far.pinned.join(', ')}) keep their order in a copy`,
              null,
            ),
          ]
        : []),
    ];
  });
};

/** Each skill folder's view: nearest Layer first then by name; the nearest of a name in force. */
const skillViews = (
  skills: readonly SkillSource[],
  workflows: readonly WorkflowView[],
): SkillView[] => {
  const sorted = [...skills].sort(
    (a, b) => nearness(a.layer) - nearness(b.layer) || a.name.localeCompare(b.name),
  );

  return sorted.map((s): SkillView => {
    const same = sorted.filter((x) => x.name === s.name);

    return {
      name: s.name,
      layer: s.layer,
      dir: s.dir ?? (s.layer === 'built-in' ? `built-in/skills/${s.name}` : ''),
      description: s.description ?? '',
      files: [...(s.files ?? [])],
      inForce: same[0] === s,
      shadows: same.filter((x) => nearness(x.layer) > nearness(s.layer)).map((x) => x.layer),
      usedBy: workflows
        .filter(
          (w) => w.inForce && w.steps.some((t) => t.skill === s.name && t.skillLayer === s.layer),
        )
        .map((w) => w.id),
      // Abe's, or the repo's copy of it in abe/skills (ADR 0033)
      invoked:
        (s.layer === 'built-in' || /(^|\/)abe\/skills\/[^/]+$/.test(s.dir ?? '')) &&
        HUB_INVOKED_SKILLS.includes(s.name),
    };
  });
};

const FACT_VIEWS = Object.entries(FACTS).map(([name, f]) => ({
  name,
  about: f.about,
  type: f.type,
  by: [...f.by],
}));

/**
 * Every Layer's workflows through the load check: each file's view, nearest Layer first then by
 * id, with its problems; of an id the nearest file is in force when it is ok (a failing one is
 * offered nowhere, and no farther copy runs in its place).
 */
export const loadWorkflows = (o: {
  sources: readonly WorkflowSource[];
  skills: readonly SkillSource[];
  /**
   * Abe's own skills in force (the shipped files' rule): a step's skill no Layer has is found
   * built-in only among these. Default: all of Abe's, as in a repo not installed yet.
   */
  builtIn?: readonly string[];
}): WorkflowsData => {
  const sorted = [...o.sources].sort(
    (a, b) => nearness(a.layer) - nearness(b.layer) || a.id.localeCompare(b.id),
  );
  const checked = sorted.map((s) => checkOne(s, o.skills, o.builtIn ?? BUILT_IN_SKILLS));
  const workflows = checked.map((c): WorkflowView => {
    const same = checked.filter((x) => x.view.id === c.view.id);
    const farther = same.filter((x) => nearness(x.view.layer) > nearness(c.view.layer));
    const found = [
      ...c.found,
      ...(c.file === null
        ? []
        : pinProblems(
            c,
            farther.filter((f) => f.file !== null),
          )),
    ];
    const ok = c.file !== null && found.length === 0;
    const nearest = same[0] === c;
    const problems = found.map((f) => ({
      ...f,
      workflow: c.view.id,
      layer: c.view.layer,
      file: c.view.file,
    }));

    return {
      ...c.view,
      ok,
      inForce: ok && nearest,
      shadows: farther.map((f) => f.view.layer),
      problems,
    };
  });

  return {
    workflows,
    facts: FACT_VIEWS,
    problems: workflows.flatMap((w) => w.problems),
    skills: skillViews(o.skills, workflows),
    layers: [],
    recent: [],
  };
};

const isSees = (x: string): boolean => SEES.some((s) => s === x);

const conditionOf = (c: ConditionView): Condition =>
  c.kind === 'check' ? { check: c.check } : { judge: c.question, sees: c.sees };

/** A loaded workflow as a run carries it. */
export const runWorkflowOf = (w: WorkflowView): RunWorkflow => ({
  id: w.id,
  name: w.name,
  layer: w.layer,
  steps: w.steps.map((s) => ({
    name: s.name,
    kind: s.kind,
    skill: s.skill,
    fresh: s.fresh,
    when: s.gate === null ? null : conditionOf(s.gate),
    ends:
      s.ends === null
        ? null
        : { when: s.ends.when === null ? null : conditionOf(s.ends.when), then: s.ends.then },
    reports: s.reports,
    doneWhen: s.doneWhen === null ? null : conditionOf(s.doneWhen),
    into: s.into,
  })),
  loops: w.loops.map((l) => ({
    id: l.id,
    from: l.from,
    to: l.to,
    when: conditionOf(l.when),
    carries: l.carries,
    max: l.max,
  })),
});

const layerWords = (l: WorkflowLayer) => (l === 'built-in' ? 'built-in' : l);

const FRESH_WORDS: Readonly<Record<FreshMode, string>> = {
  never: '',
  always: 'fresh',
  loop: 'fresh on loop',
};

/** A step in words: `build (implement, fresh on loop)`, `playbook? (playbook)`, `reproduce (… ends: report)`. */
const stepWords = (s: WorkflowStepView): string => {
  const tags = [
    ...(s.skill === null || s.skill === s.name ? [] : [s.skill]),
    ...(FRESH_WORDS[s.fresh] === '' ? [] : [FRESH_WORDS[s.fresh]]),
    ...(s.ends === null ? [] : ['ends: report']),
  ];

  return `${s.name}${s.gate === null ? '' : '?'}${tags.length === 0 ? '' : ` (${tags.join(', ')})`}`;
};

/** `abe workflow list` in words: each workflow's on:, steps, loops, problems. */
export const workflowsText = (d: WorkflowsData): string => {
  const lines = d.workflows.flatMap((w) => {
    const shadowed = w.inForce ? '' : '  (shadowed)';
    const state = w.ok
      ? shadowed
      : `  (not run: ${w.problems.length} problem${w.problems.length === 1 ? '' : 's'})`;

    return [
      `${w.id}  ${layerWords(w.layer)}${state}`,
      ...(w.on === null
        ? []
        : [
            `  on: ${w.on.default ? 'default' : [...w.on.types.map((t) => `type ${t}`), ...w.on.tags.map((t) => `tag ${t}`)].join(', ')}`,
          ]),
      ...(w.steps.length === 0 ? [] : [`  ${w.steps.map(stepWords).join(' → ')}`]),
      ...w.loops.map(
        (l) =>
          `  ${l.id}. ${l.from} → ${l.to} when ${l.when.kind === 'check' ? l.when.check : `judge: ${l.when.question}`}, up to ${l.max}${l.implied ? ' (implied)' : ''}`,
      ),
      ...w.problems.map((p) => `  ! ${p.file}${p.line === null ? '' : `:${p.line}`}: ${p.text}`),
    ];
  });

  return lines.length === 0 ? 'no workflows\n' : `${lines.join('\n')}\n`;
};

/** `abe workflow path`: a Layer's file to open; a built-in one written out read-only. */
export const WorkflowPathData = z.object({ path: z.string() });
export type WorkflowPathData = z.infer<typeof WorkflowPathData>;

/** `abe workflow path`'s refusal: the file is no Layer's workflow or skill file, nor the guide. */
export const NOT_A_LAYER_FILE = 'not-a-layer-file';
