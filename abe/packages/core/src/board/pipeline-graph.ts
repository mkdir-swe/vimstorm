/**
 * A run's real dependency graph, read from the run's own revision (spec story 79): GitHub
 * Actions' `needs` and Azure Pipelines' `dependsOn`, mapped onto the jobs the run actually had.
 * Pure: the adapters hand in the workflow as parsed YAML (any value) and the jobs.
 *
 * - Matrix jobs: every leg is a box of its own carrying its key's edges, grouped under the key.
 * - Reusable workflows (`uses:`): GitHub names their jobs `caller / callee`; they are grouped under
 *   the caller, take the caller's edges, and their own `needs` when the called workflow can be
 *   read (a local `./…` file at the same revision). A caller with a matrix calls it once a leg
 *   (`deploy (dev) / plan`): each leg's jobs wait only for their own leg's.
 * - `needs` given as an expression, a job the workflow does not name, a called workflow that
 *   cannot be read: the edges known are kept and the graph says some are missing (`partial`).
 * - Nothing trustworthy (no job matches, an unreadable workflow, a pull request's workflow that
 *   no longer names every job): no edges at all, and the graph orders the jobs by start time.
 */

import { WORKFLOW_INPUT_TYPES, type WorkflowInput } from './pipelines';

export type Graph = {
  /** Null: unknown. */
  edges: [string, string][] | null;
  partial: boolean;
  /** Each job's group (a matrix key, a reusable workflow's caller, an Azure stage), by job id. */
  groups: Record<string, string>;
};

const NONE: Graph = { edges: null, partial: false, groups: {} };

type Doc = Readonly<Record<string, unknown>>;

const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const field = (v: unknown, key: string): unknown => (isDoc(v) ? v[key] : undefined);

/** A job's `needs`: the keys it waits for, or something only the runner evaluates (`unknown`). */
type Needs = string[] | 'unknown';

const needsOf = (v: unknown): Needs => {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return v.includes('${{') ? 'unknown' : [v];
  if (!Array.isArray(v)) return 'unknown';
  const keys: string[] = [];

  for (const n of v) {
    if (typeof n !== 'string' || n.includes('${{')) return 'unknown';
    keys.push(n);
  }

  return keys;
};

/** A workflow's job as the graph needs it. */
type Def = { key: string; display: string; needs: Needs; uses: string | undefined };

const defsOf = (doc: unknown): Def[] | undefined => {
  const jobs = field(doc, 'jobs');

  if (!isDoc(jobs)) return undefined;

  return Object.entries(jobs).map(([key, v]) => ({
    key,
    display: text(field(v, 'name')) ?? key,
    needs: needsOf(field(v, 'needs')),
    uses: text(field(v, 'uses')),
  }));
};

/**
 * Whether a run's job name is the job `display` names: the same, a matrix leg of it
 * (`e2e (chromium)`), or its `${{ }}` parts filled in.
 */
const names = (display: string, name: string): boolean => {
  if (name === display || name.startsWith(`${display} (`)) return true;
  if (!display.includes('${{')) return false;
  const literals: string[] = [];
  let rest = display;

  for (let start = rest.indexOf('${{'); start >= 0; start = rest.indexOf('${{')) {
    literals.push(rest.slice(0, start));
    const end = rest.indexOf('}}', start);

    rest = end < 0 ? '' : rest.slice(end + 2);
  }
  literals.push(rest);
  const first = literals[0] ?? '';
  const last = literals.at(-1) ?? '';

  if (!name.startsWith(first) || !name.endsWith(last) || name.length < first.length + last.length)
    return false;
  let at = first.length;

  for (const mid of literals.slice(1, -1)) {
    const i = name.indexOf(mid, at);

    if (i < 0) return false;
    at = i + mid.length;
  }

  return at <= name.length - last.length;
};

/** The workflow's job a run's job name belongs to (an exact name before a pattern). */
const defOf = (defs: readonly Def[], name: string): Def | undefined =>
  defs.find((d) => d.display === name) ?? defs.find((d) => names(d.display, name));

/** An edge as a set key (ids never hold a newline). */
const add = (edges: Set<string>, from: string, to: string) => {
  edges.add(`${from}\n${to}`);
};

const sorted = (edges: Set<string>): [string, string][] =>
  [...edges]
    .map((e): [string, string] => {
      const at = e.indexOf('\n');

      return [e.slice(0, at), e.slice(at + 1)];
    })
    .sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));

/**
 * GitHub's graph of the jobs `jobs` (id, name) of a run of workflow `doc`. `callee` reads a
 * reusable workflow it calls (`./.github/workflows/x.yml`) at the same revision, parsed;
 * `strict`: a job the workflow does not name makes the whole graph untrustworthy (a pull
 * request's run, whose workflow may come from its merge commit).
 */
export const githubGraph = (
  doc: unknown,
  jobs: readonly { id: string; name: string }[],
  callee: (path: string) => unknown,
  strict: boolean,
): Graph => {
  const defs = defsOf(doc);

  if (defs === undefined) return NONE;
  let partial = false;
  const groups: Record<string, string> = {};
  // each job's workflow key; for a called workflow's job its name there and the call it is of
  // (`deploy (dev)`: a caller run per matrix leg calls the workflow once each)
  const ofKey = new Map<string, { id: string; inner: string | undefined; call: string }[]>();

  for (const { id, name } of jobs) {
    const split = name.indexOf(' / ');
    const caller = split < 0 ? name : name.slice(0, split);
    const inner = split < 0 ? undefined : name.slice(split + 3);
    const def =
      inner === undefined
        ? defOf(defs, name)
        : defs
            .filter((d) => d.uses !== undefined)
            .find((d) => d.display === caller || names(d.display, caller));

    if (def === undefined) {
      if (strict) return NONE;
      partial = true;
      continue;
    }
    if (inner !== undefined) groups[id] = caller;
    ofKey.set(def.key, [...(ofKey.get(def.key) ?? []), { id, inner, call: caller }]);
  }
  if (ofKey.size === 0) return NONE;
  // a matrix's legs are grouped under their key
  for (const [key, list] of ofKey)
    if (list.length > 1 && list.every((l) => l.inner === undefined)) {
      const display = defs.find((d) => d.key === key)?.display ?? key;

      for (const { id } of list) groups[id] = display;
    }
  const edges = new Set<string>();
  // a key's entries (its first jobs) and exits (its last ones)
  const ends = new Map<string, { entries: string[]; exits: string[] }>();

  for (const def of defs) {
    const list = ofKey.get(def.key);

    if (list === undefined) continue;
    const ids = list.map((l) => l.id);
    const called = def.uses !== undefined && list.some((l) => l.inner !== undefined);

    if (!called || def.uses === undefined) {
      ends.set(def.key, { entries: ids, exits: ids });
      continue;
    }
    const innerDefs = def.uses.startsWith('./') ? defsOf(callee(def.uses.slice(2))) : undefined;

    if (innerDefs === undefined) {
      partial = true;
      ends.set(def.key, { entries: ids, exits: ids });
      continue;
    }
    // the called workflow's own needs among its jobs, within one call of it: a matrix calls it
    // once a leg, and a leg's jobs never wait for another leg's
    const innerKey = new Map<string, { key: string; call: string }>();

    for (const { id, inner, call } of list) {
      const d = inner === undefined ? undefined : defOf(innerDefs, inner);

      if (d === undefined) partial = true;
      else innerKey.set(id, { key: d.key, call });
    }
    const hasIn = new Set<string>();
    const hasOut = new Set<string>();

    for (const [id, { key, call }] of innerKey) {
      const d = innerDefs.find((x) => x.key === key);

      if (d === undefined) continue;
      if (d.needs === 'unknown') {
        partial = true;
        continue;
      }
      for (const n of d.needs)
        for (const [from, k] of innerKey)
          if (k.key === n && k.call === call) {
            add(edges, from, id);
            hasIn.add(id);
            hasOut.add(from);
          }
    }
    ends.set(def.key, {
      entries: ids.filter((i) => !hasIn.has(i)),
      exits: ids.filter((i) => !hasOut.has(i)),
    });
  }
  for (const def of defs) {
    const at = ends.get(def.key);

    if (at === undefined) continue;
    if (def.needs === 'unknown') {
      partial = true;
      continue;
    }
    for (const n of def.needs) {
      if (!defs.some((d) => d.key === n)) {
        partial = true;
        continue;
      }
      const from = ends.get(n);

      if (from === undefined) continue;
      for (const a of from.exits) for (const b of at.entries) add(edges, a, b);
    }
  }

  return { edges: sorted(edges), partial, groups };
};

/**
 * Whether a GitHub workflow (parsed YAML) runs by hand (`on: workflow_dispatch`), and the inputs
 * it takes: name, description, type (`string` unless it says), whether required, its default as
 * text, a choice's options. A workflow without `on:` or with an unreadable one runs by nothing.
 */
export const dispatchInputsOf = (doc: unknown): { dispatch: boolean; inputs: WorkflowInput[] } => {
  // YAML 1.1 readers give `on:` as the key `true`
  const on = field(doc, 'on') ?? field(doc, 'true');
  const has =
    on === 'workflow_dispatch' ||
    (Array.isArray(on) && on.includes('workflow_dispatch')) ||
    (isDoc(on) && Object.hasOwn(on, 'workflow_dispatch'));

  if (!has) return { dispatch: false, inputs: [] };
  const inputs = field(field(on, 'workflow_dispatch'), 'inputs');

  if (!isDoc(inputs)) return { dispatch: true, inputs: [] };

  return {
    dispatch: true,
    inputs: Object.entries(inputs).map(([name, v]) => {
      const type = WORKFLOW_INPUT_TYPES.find((t) => t === field(v, 'type')) ?? 'string';
      const options = field(v, 'options');

      return {
        name,
        description: text(field(v, 'description')) ?? '',
        type,
        required: field(v, 'required') === true,
        default: scalarText(field(v, 'default')),
        options: Array.isArray(options)
          ? options.flatMap((o: unknown) => {
              const t = scalarText(o);

              return t === null ? [] : [t];
            })
          : [],
      };
    }),
  };
};

/** A YAML scalar as text (`dev`, `3`, `true`); null for none or a structure. */
const scalarText = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);

  return null;
};

/** An Azure Pipelines stage or job as the YAML names it, and what it depends on. */
type AzNode = { name: string; display: string | undefined; depends: Needs };

/** `dependsOn`: absent → `fallback`, a name, a list, `[]`, or an expression. */
const dependsOf = (v: unknown, fallback: string[]): Needs =>
  v === undefined ? fallback : needsOf(v);

/**
 * The stages (each with its jobs) of an Azure Pipelines YAML: a stage without `dependsOn` depends
 * on the one before it; a job without one on nothing. Top-level `jobs:` are one stage.
 */
const azureDefs = (doc: unknown): { stage: AzNode; jobs: AzNode[] }[] | undefined => {
  const jobsOf = (v: unknown): AzNode[] => {
    const list = field(v, 'jobs');

    return (Array.isArray(list) ? list : []).flatMap((j: unknown) => {
      const name = text(field(j, 'job')) ?? text(field(j, 'deployment'));

      return name === undefined
        ? []
        : [
            {
              name,
              display: text(field(j, 'displayName')),
              depends: dependsOf(field(j, 'dependsOn'), []),
            },
          ];
    });
  };
  const stages = field(doc, 'stages');

  if (Array.isArray(stages)) {
    const out: { stage: AzNode; jobs: AzNode[] }[] = [];
    let before: string | undefined;

    for (const s of stages) {
      const name = text(field(s, 'stage'));

      if (name === undefined) return undefined;
      out.push({
        stage: {
          name,
          display: text(field(s, 'displayName')),
          depends: dependsOf(field(s, 'dependsOn'), before === undefined ? [] : [before]),
        },
        jobs: jobsOf(s),
      });
      before = name;
    }

    return out;
  }
  const jobs = jobsOf(doc);

  return jobs.length === 0
    ? undefined
    : [{ stage: { name: '__default', display: undefined, depends: [] }, jobs }];
};

/** An Azure timeline job record as the graph needs it. */
export type AzureJobRecord = {
  id: string;
  name: string;
  /** `Stage.Job[.leg]`. */
  identifier: string;
  /** The stage it runs in (its name or identifier). */
  stage: string;
};

const isNode = (n: AzNode, name: string): boolean =>
  n.display === name ||
  name === n.name ||
  name.startsWith(`${n.name} `) ||
  (n.display !== undefined && name.startsWith(`${n.display} `));

/** Azure's graph of a build's jobs from the pipeline's YAML at the build's revision. */
export const azureGraph = (doc: unknown, jobs: readonly AzureJobRecord[]): Graph => {
  const stages = doc === undefined ? undefined : azureDefs(doc);

  if (stages === undefined) return NONE;
  let partial = false;
  const groups: Record<string, string> = {};
  // each stage's jobs: (id, job key)
  const placed = new Map<string, { id: string; key: string }[]>();

  for (const r of jobs) {
    const at = stages.find(
      (s) =>
        s.stage.name === r.stage || s.stage.display === r.stage || s.stage.name === '__default',
    );

    if (at === undefined) return NONE;
    const leaf = r.identifier.split('.')[1] ?? '';
    const def =
      at.jobs.find((d) => leaf !== '' && d.name === leaf) ?? at.jobs.find((d) => isNode(d, r.name));
    const list = placed.get(at.stage.name) ?? [];

    if (def === undefined) partial = true;
    list.push({ id: r.id, key: def?.name ?? '' });
    placed.set(at.stage.name, list);
    if (at.stage.name !== '__default') groups[r.id] = at.stage.display ?? at.stage.name;
  }
  const edges = new Set<string>();
  const ends = new Map<string, { entries: string[]; exits: string[] }>();

  for (const { stage, jobs: defs } of stages) {
    const list = placed.get(stage.name);

    if (list === undefined) continue;
    const hasIn = new Set<string>();
    const hasOut = new Set<string>();

    for (const { id, key } of list) {
      const d = defs.find((x) => x.name === key);

      if (d === undefined) continue;
      if (d.depends === 'unknown') {
        partial = true;
        continue;
      }
      for (const n of d.depends)
        for (const { id: from, key: k } of list)
          if (k === n) {
            add(edges, from, id);
            hasIn.add(id);
            hasOut.add(from);
          }
    }
    const ids = list.map((l) => l.id);

    ends.set(stage.name, {
      entries: ids.filter((i) => !hasIn.has(i)),
      exits: ids.filter((i) => !hasOut.has(i)),
    });
  }
  for (const { stage } of stages) {
    const at = ends.get(stage.name);

    if (at === undefined) continue;
    if (stage.depends === 'unknown') {
      partial = true;
      continue;
    }
    for (const n of stage.depends) {
      const from = ends.get(n);

      if (from === undefined) continue;
      for (const a of from.exits) for (const b of at.entries) add(edges, a, b);
    }
  }

  return { edges: sorted(edges), partial, groups };
};
