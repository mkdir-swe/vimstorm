/**
 * The Pipelines tab's own components (1.0 artboards L-01 … L-21, PipelineRuns / PipelineGraph
 * READMEs): the scope bar over the runs (a `Table`), the selected run's summary beside them, a
 * run's head, its jobs as a graph, a job's panel (its card, step counters, steps and evidence) and
 * its log. Rust draws them (`app/src/factory/pipelines.rs`); the screen (`pipelines.ts`) decides
 * every word, hue and place.
 *
 * Clicks name: a scope tab's `id`, `workflow` (the chip), `workflow:clear` (its ×), a crumb's
 * `id`, a button's `act:<row>`, a box's `job:<id>`, an evidence row's `evidence:<n>`, its Open
 * file `open-file:<n>`.
 */
import { z } from 'zod';
import type { Hue } from '../runtime/components';

/** A state as drawn: glyph, word, hue (core's `StateWord`). */
export type StateMark = { glyph: string; word: string; hue: Hue };

/** A button of a run's head or a job's card: its click is `act:<id>`. */
export type PipelineAction = {
  id: string;
  label: string;
  disabled?: boolean | undefined;
  primary?: boolean | undefined;
};

/** The scope row (L-01 §1): This workspace · All · Mine, the Workflow chip, the count, the filter. */
export type PipelinesBar = {
  kind: 'PipelinesBar';
  id?: string | undefined;
  props: {
    scopes: { id: string; label: string; tooltip?: string | undefined }[];
    selected: string;
    /** `Workflow ▾`, or `Workflow: PR checks` with its × (`on`). */
    workflow: { label: string; on: boolean };
    /** `14 runs`, `abe/AB-1234-cart-total · 2 runs · All shows 7`. */
    count: string;
    /** Dim at the right: `o/r · GitHub Actions`. */
    source?: string | undefined;
  };
};

/** The selected run at a glance (L-01's right pane). */
export type RunSummary = {
  kind: 'RunSummary';
  id?: string | undefined;
  props: {
    /** `PR checks · run #103 · attempt 1`. */
    identity: string;
    state: StateMark;
    title: string;
    /** `fix/AB-7-rounding · PR #61 · c7e152a · 08:00 · 7m 00s`. */
    meta: string;
    jobs: { mark: string; name: string; duration: string; hue: Hue; prod?: boolean | undefined }[];
    /** Skipped jobs folded into one dim line. */
    skipped?: string | undefined;
    /** (label, value): Evidence, Agent, Brings. */
    facts: { label: string; value: string }[];
    /** The agent on the run's branch: its state and where it runs. */
    agent?: { word: string; hue: Hue; workspace: string; env: string } | undefined;
    /** The run's inline actions (L-01 §5): a click is `act:<id>`. */
    actions: PipelineAction[];
  };
};

/** A run entered (L-05): its crumbs, title, state, meta and its buttons. */
export type RunHead = {
  kind: 'RunHead';
  id?: string | undefined;
  props: {
    /** `PR checks › Run #103 · Fix cart rounding › unit tests`: a crumb with an id is a click. */
    crumbs: { id?: string | undefined; text: string }[];
    title: string;
    state: StateMark;
    /** `run #103 · attempt 1 · fix/AB-7-rounding · PR #61 · 9003c7e · started 08:00 · 7m 00s`. */
    meta: string;
    actions: PipelineAction[];
  };
};

/** One box of the graph: its place in columns (dependency depth) and rows. */
export type GraphJobProp = {
  id: string;
  name: string;
  /** Boxes of one group in one column are framed together under its name. */
  group?: string | undefined;
  state: StateMark;
  duration: string;
  column: number;
  row: number;
};

/** A run's jobs as dependency-connected boxes (L-05 / L-18, PipelineGraph README). */
export type RunGraph = {
  kind: 'RunGraph';
  id?: string | undefined;
  props: {
    jobs: GraphJobProp[];
    /** `[from, to]` box ids; absent: dependency data unavailable (no lines drawn). */
    edges?: [string, string][] | undefined;
    selected?: string | undefined;
    /** The graph's note under it (`Order from start times · …`). */
    note?: string | undefined;
    /** The log view's narrow graph: smaller boxes, closer columns. */
    narrow?: boolean | undefined;
    /** The legend under it: each state's mark and word. */
    legend?: StateMark[] | undefined;
  };
};

/** An evidence row: an error line of the log (with the file it names) or an artifact. */
export type EvidenceProp = {
  title: string;
  detail: string;
  /** Why it cannot go with a fix (`expired`). */
  unavailable?: string | undefined;
  /** `src/api/cart.test.ts:14`: its Open file. */
  file?: string | undefined;
  /** An artifact (▤), not a line of the log (✗). */
  artifact?: boolean | undefined;
};

/** The selected job (L-06): its card, step counters, buttons, steps and evidence. */
export type JobPanel = {
  kind: 'JobPanel';
  id?: string | undefined;
  props: {
    name: string;
    state: StateMark;
    /** `after 2m 10s · job 90033 · ubuntu-latest · step Run npm test`. */
    words: string;
    counters: { text: string; hue: Hue }[];
    actions: PipelineAction[];
    /** The steps, the one it failed in (else running) marked `current`. */
    steps: { state: StateMark; name: string; duration: string; current?: boolean | undefined }[];
    /** `EVIDENCE · 3` (the log view), `ANNOTATIONS · 3` (the graph). */
    evidenceTitle?: string | undefined;
    evidence: EvidenceProp[];
    /** The evidence row the keys are on (the log view). */
    selected?: number | undefined;
  };
};

/** A job's log (L-07): its title and range over the lines shown, error and evidence lines marked. */
export type JobLog = {
  kind: 'JobLog';
  id?: string | undefined;
  props: {
    /** `LOG · RUN NPM TEST`. */
    title: string;
    /** `lines 396–418 of 418`, or why there are none (`Reading the log…`). */
    range: string;
    lines: {
      n: number;
      time: string;
      text: string;
      error?: boolean | undefined;
      evidence?: boolean | undefined;
    }[];
  };
};

export type PipelineNode = PipelinesBar | RunSummary | RunHead | RunGraph | JobPanel | JobLog;

export const PIPELINE_KINDS = [
  'PipelinesBar',
  'RunSummary',
  'RunHead',
  'RunGraph',
  'JobPanel',
  'JobLog',
] as const;

/** The components' schemas, on the set's own primitives (`components.ts` calls this). */
export const pipelineSchemas = (d: { nodeId: z.ZodString; hue: z.ZodType<Hue> }) => {
  const mark = z.strictObject({ glyph: z.string(), word: z.string(), hue: d.hue });
  const action = z.strictObject({
    id: d.nodeId,
    label: z.string(),
    disabled: z.boolean().optional(),
    primary: z.boolean().optional(),
  });

  return [
    z.strictObject({
      kind: z.literal('PipelinesBar'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        scopes: z.array(
          z.strictObject({ id: d.nodeId, label: z.string(), tooltip: z.string().optional() }),
        ),
        selected: d.nodeId,
        workflow: z.strictObject({ label: z.string(), on: z.boolean() }),
        count: z.string(),
        source: z.string().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('RunSummary'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        identity: z.string(),
        state: mark,
        title: z.string(),
        meta: z.string(),
        jobs: z.array(
          z.strictObject({
            mark: z.string(),
            name: z.string(),
            duration: z.string(),
            hue: d.hue,
            prod: z.boolean().optional(),
          }),
        ),
        skipped: z.string().optional(),
        facts: z.array(z.strictObject({ label: z.string(), value: z.string() })),
        agent: z
          .strictObject({ word: z.string(), hue: d.hue, workspace: z.string(), env: z.string() })
          .optional(),
        actions: z.array(action),
      }),
    }),
    z.strictObject({
      kind: z.literal('RunHead'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        crumbs: z.array(z.strictObject({ id: d.nodeId.optional(), text: z.string() })),
        title: z.string(),
        state: mark,
        meta: z.string(),
        actions: z.array(action),
      }),
    }),
    z.strictObject({
      kind: z.literal('RunGraph'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        jobs: z.array(
          z.strictObject({
            id: d.nodeId,
            name: z.string(),
            group: z.string().optional(),
            state: mark,
            duration: z.string(),
            column: z.number().int().nonnegative(),
            row: z.number().int().nonnegative(),
          }),
        ),
        edges: z.array(z.tuple([d.nodeId, d.nodeId])).optional(),
        selected: d.nodeId.optional(),
        note: z.string().optional(),
        narrow: z.boolean().optional(),
        legend: z.array(mark).optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('JobPanel'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        name: z.string(),
        state: mark,
        words: z.string(),
        counters: z.array(z.strictObject({ text: z.string(), hue: d.hue })),
        actions: z.array(action),
        steps: z.array(
          z.strictObject({
            state: mark,
            name: z.string(),
            duration: z.string(),
            current: z.boolean().optional(),
          }),
        ),
        evidenceTitle: z.string().optional(),
        evidence: z.array(
          z.strictObject({
            title: z.string(),
            detail: z.string(),
            unavailable: z.string().optional(),
            file: z.string().optional(),
            artifact: z.boolean().optional(),
          }),
        ),
        selected: z.number().int().nonnegative().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('JobLog'),
      id: d.nodeId.optional(),
      props: z.strictObject({
        title: z.string(),
        range: z.string(),
        lines: z.array(
          z.strictObject({
            n: z.number().int().positive(),
            time: z.string(),
            text: z.string(),
            error: z.boolean().optional(),
            evidence: z.boolean().optional(),
          }),
        ),
      }),
    }),
  ] as const;
};
