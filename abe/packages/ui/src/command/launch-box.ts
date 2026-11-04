/**
 * The Launch box (#342, #347): a card's run set up before it starts, in Command mode. Typing
 * writes the Launch note (⇧⏎ a new line), ↑ / ↓ the workflow, ⌃R where it runs (local or a box),
 * ⌃P prod for this session alone (local only, its warning shown); ⏎ hands the launch back to the
 * screen that opened it (`[note, workflow, runs, prod]`), Esc closes it keeping the draft for its
 * card. It reads the standing notes in force
 * (`settings explain launch.notes`) and shows them dim, the card workflows (`workflow list`):
 * grouped Repo's, Yours, Abe's, the one whose `on:` takes the card preselected with why, a warning
 * when the one picked does not take it (it still runs it); and the environments agents reach
 * (`settings get agents.<env>`). A note of more than `MAX_NOTE` characters launches nothing; a dim
 * count shows from `NOTE_COUNT_FROM` on.
 */
import { type LaunchChoices, type LaunchTarget } from '@abe/core';
import { launchChoices, mismatchWords, SOURCE_WORDS } from '@abe/core/workflow-pick';
import { referenceWords } from '@abe/core/prototype-tag';
import {
  MAX_NOTE,
  NOTE_COUNT_FROM,
  type StandingNote,
  standingOf,
  standingWords,
} from '@abe/core/launch-words';
import { type Field, caretOf, caretProp, fieldInsert, fieldKey, fieldOf } from '../runtime/field';
import { type LaunchBox } from '../runtime/layers';
import {
  type Answer,
  type Command,
  type Input,
  type LaunchOn,
  type Refused,
} from '../runtime/runtime';

/** Where the run goes: local (its card worktree, in the sandbox) or a box. */
export const RUNS = ['local-sandbox', 'cloud'] as const satisfies readonly LaunchTarget[];
export type Runs = (typeof RUNS)[number];

const RUNS_WORDS: Readonly<Record<Runs, string>> = {
  'local-sandbox': 'Local · its card worktree',
  cloud: 'A box · your environment',
};

/** The environments agents reach, as the repo's settings say (ADR 0029). */
export const REACH_ENVS = ['dev', 'test', 'prod'] as const;
export type ReachEnv = (typeof REACH_ENVS)[number];

/** Prod turned on here: the warning beside it. */
export const PROD_WARNING =
  'Prod on for this session alone: its agents reach prod in full, read and write. The repo’s settings stay as they are.';

/**
 * What a closed box keeps for its card until the app quits: the note, the workflow and where it
 * runs picked (prod is never kept: it is turned on again each launch).
 */
export type LaunchDraft = {
  note: string;
  workflow?: string | undefined;
  runs?: Runs | undefined;
};

export type LaunchLayer = {
  kind: 'launch';
  on: LaunchOn;
  draft: string;
  /** The draft's caret (`field.ts`); absent: at its end. */
  caret?: number | undefined;
  /** The standing notes once read; unread or unreadable: none shown. */
  standing?: readonly StandingNote[] | undefined;
  /** A prototype's reference once its card was read (`referenceWords`); unread: plain words. */
  reference?: string | undefined;
  /** The card workflows once read; `failed`: unreadable (it launches with the card's own). */
  choices?: LaunchChoices | 'failed' | undefined;
  /** The workflow picked; none: the preselected one. */
  workflow?: string | undefined;
  /** Where it runs picked; none: where `serve.target` says. */
  runs?: Runs | undefined;
  /** Prod on for this session alone (ADR 0029): the person's, local only. */
  prod: boolean;
  /** Each environment on for agents, as read; unread: dev and test on, prod off. */
  reach?: Partial<Record<ReachEnv, boolean>> | undefined;
  /**
   * When it opened, and its last ⏎ (ms, the clock's): a ⏎ within the guard of either launches
   * nothing (#313, #285): the ⏎ that chose `Launch agent…`, a double or a held one.
   */
  opened?: number | undefined;
  enter?: number | undefined;
};

/** The run that reads the standing notes, by card. */
export const STANDING_RUN = 'launch:standing:';

/** The run that reads a prototype's card for its reference (its comments), by card. */
export const REFERENCE_RUN = 'launch:reference:';

/** The run that reads the card workflows (`workflow list`), by card. */
export const WORKFLOWS_RUN = 'launch:workflows:';

/** The runs that read whether agents reach each environment, by card. */
export const REACH_RUN: Readonly<Record<ReachEnv, string>> = {
  dev: 'launch:reach-dev:',
  test: 'launch:reach-test:',
  prod: 'launch:reach-prod:',
};

/** The reference row's words before (or without) the card read. */
const SOME_REFERENCE = 'the card’s prototype';

/** The click ids: Launch, each workflow, each place it runs, prod. */
export const LAUNCH_GO = 'launch:go';
const WORKFLOW_CLICK = 'launch:workflow:';
const RUNS_CLICK = 'launch:runs:';
const PROD_CLICK = 'launch:prod';

/** The box open on its card, its kept draft back, the standing notes (and a reference) asked for. */
export const openLaunch = (
  on: LaunchOn,
  kept: LaunchDraft | undefined,
  at: number | undefined,
): { layer: LaunchLayer; commands: Command[] } => ({
  layer: {
    kind: 'launch',
    on,
    draft: on.draft?.note ?? kept?.note ?? '',
    workflow: on.draft?.workflow ?? kept?.workflow,
    runs: runsOf(on.draft?.runs) ?? kept?.runs,
    prod: false,
    opened: at,
  },
  commands: [
    { kind: 'run', id: `${STANDING_RUN}${on.card}`, argv: ['settings', 'explain', 'launch.notes'] },
    { kind: 'run', id: `${WORKFLOWS_RUN}${on.card}`, argv: ['workflow', 'list'] },
    ...REACH_ENVS.map((env): Command => ({
      kind: 'run',
      id: `${REACH_RUN[env]}${on.card}`,
      argv: ['settings', 'get', `agents.${env}`],
    })),
    ...(on.prototype === true
      ? [
          {
            kind: 'run' as const,
            id: `${REFERENCE_RUN}${on.card}`,
            argv: ['card', 'show', String(on.card)],
          },
        ]
      : []),
  ],
});

const runsOf = (v: string | undefined): Runs | undefined => RUNS.find((r) => r === v);

/** Where it runs now: picked, else where `serve.target` says; none while that is not known. */
const runsNow = (l: LaunchLayer): Runs | undefined => {
  if (l.runs !== undefined) return l.runs;
  if (l.on.target === undefined) return undefined;

  return l.on.target === 'local' || l.on.target === 'local-sandbox' ? 'local-sandbox' : 'cloud';
};

/** The card as a workflow's `on:` reads it. */
const kindOf = (l: LaunchLayer) => ({ type: l.on.type ?? '', tags: l.on.tags ?? [] });

/** The card's type is known: the preselection is the one serve makes. */
const kindKnown = (l: LaunchLayer) => l.on.type !== undefined;

/**
 * The workflow picked now: the person's, else the preselected one (the card's type known); none
 * before the list read.
 */
const workflowNow = (l: LaunchLayer): string | undefined => {
  if (l.choices === undefined || l.choices === 'failed') return l.workflow;
  const ids = l.choices.options.map((o) => o.id);

  if (l.workflow !== undefined && ids.includes(l.workflow)) return l.workflow;

  return kindKnown(l) ? l.choices.picked : undefined;
};

/** Prod reached by this launch: on in the repo's settings, or turned on here (local only). */
const prodOn = (l: LaunchLayer): boolean =>
  l.reach?.prod === true || (l.prod && runsNow(l) === 'local-sandbox');

/** What a key or click did: the box as it is now, or closed with its draft kept or the launch. */
export type LaunchStep =
  | { kind: 'open'; layer: LaunchLayer }
  | { kind: 'closed'; kept: LaunchDraft }
  | { kind: 'launched'; choice: Command };

const over = (draft: string): boolean => draft.trim().length > MAX_NOTE;

const nextWorkflow = (l: LaunchLayer, by: 1 | -1): LaunchLayer => {
  if (l.choices === undefined || l.choices === 'failed') return l;
  const ids = l.choices.options.map((o) => o.id);
  const at = ids.indexOf(workflowNow(l) ?? ids[0] ?? '');
  const next = ids[Math.min(ids.length - 1, Math.max(0, at + by))];

  return next === undefined ? l : { ...l, workflow: next };
};

const otherRuns = (r: Runs | undefined): Runs =>
  r === 'local-sandbox' ? 'cloud' : 'local-sandbox';

/** Prod turned on or off here: only for a run local, and never when the repo's settings have it on. */
const toggledProd = (l: LaunchLayer): LaunchLayer =>
  runsNow(l) === 'local-sandbox' && l.reach?.prod !== true ? { ...l, prod: !l.prod } : l;

const launched = (l: LaunchLayer): LaunchStep =>
  over(l.draft)
    ? { kind: 'open', layer: l }
    : {
        kind: 'launched',
        choice: {
          kind: 'choice',
          menu: l.on.id,
          row: l.on.row ?? 'launch',
          values: [
            l.draft.trim(),
            // the person's pick alone: else serve takes the one the card's on: takes, as shown
            l.workflow ?? '',
            // the person's pick alone: else where serve.target says
            l.runs ?? '',
            l.prod && runsNow(l) === 'local-sandbox' && l.reach?.prod !== true ? 'prod' : '',
          ],
        },
      };

export const onLaunch = (
  l: LaunchLayer,
  input: Input,
  at: number | undefined,
  guardMs: number,
): LaunchStep => {
  const open = (layer: LaunchLayer): LaunchStep => ({ kind: 'open', layer });
  const early = (since: number | undefined) =>
    at !== undefined && since !== undefined && at - since < guardMs;

  if (input.kind === 'click') {
    if (input.id === LAUNCH_GO) return launched(l);
    if (input.id === PROD_CLICK) return open(toggledProd(l));
    if (input.id.startsWith(WORKFLOW_CLICK))
      return open({ ...l, workflow: input.id.slice(WORKFLOW_CLICK.length) });
    const runs = runsOf(input.id.startsWith(RUNS_CLICK) ? input.id.slice(RUNS_CLICK.length) : '');

    return open(runs === undefined ? l : { ...l, runs });
  }
  const f = fieldOf(l.draft, l.caret);
  const edited = (next: Field | undefined): LaunchStep =>
    next === undefined ? open(l) : open({ ...l, draft: next.text, caret: caretProp(next) });

  if (input.kind === 'text') return edited(fieldInsert(f, input.text));
  if (input.kind !== 'key') return open(l);
  switch (input.key) {
    case '<Esc>':
      return {
        kind: 'closed',
        kept: { note: l.draft, workflow: l.workflow, runs: l.runs },
      };
    case '<CR>':
      // too soon after it opened or the ⏎ before: nothing, and the wait starts again
      return early(l.opened) || early(l.enter) ? open({ ...l, enter: at }) : launched(l);
    case '<S-CR>':
      return edited(fieldInsert(f, '\n'));
    case '<Up>':
      return open(nextWorkflow(l, -1));
    case '<Down>':
      return open(nextWorkflow(l, 1));
    case '<C-r>':
      return open({ ...l, runs: otherRuns(runsNow(l)) });
    case '<C-p>':
      return open(toggledProd(l));
    default:
      return edited(fieldKey(f, input.key, { lines: true }));
  }
};

/** The standing notes read: shown dim; unreadable, none (the launch still takes them). */
export const onStanding = (l: LaunchLayer, input: Answer | Refused): LaunchLayer =>
  input.command === 'settings explain' && input.reply.ok
    ? { ...l, standing: standingOf(input.reply.data.value, input.reply.data.layers) }
    : { ...l, standing: [] };

/** The card workflows read: offered, one preselected; unreadable, the card's own runs. */
export const onWorkflows = (l: LaunchLayer, input: Answer | Refused): LaunchLayer => {
  if (input.command !== 'workflow list' || !input.reply.ok) return { ...l, choices: 'failed' };

  return { ...l, choices: launchChoices(kindOf(l), input.reply.data) };
};

/** Whether agents reach `env`, as the repo's settings say; unreadable, its default. */
export const onReach =
  (env: ReachEnv) =>
  (l: LaunchLayer, input: Answer | Refused): LaunchLayer =>
    input.command === 'settings get' &&
    input.reply.ok &&
    typeof input.reply.data.value === 'boolean'
      ? { ...l, reach: { ...l.reach, [env]: input.reply.data.value } }
      : l;

/** The prototype's card read: its newest link line's words; unread or none, plain words. */
export const onReference = (l: LaunchLayer, input: Answer | Refused): LaunchLayer => {
  const words =
    input.command === 'card show' && input.reply.ok ? referenceWords(input.reply.data) : undefined;

  return words === undefined ? l : { ...l, reference: words };
};

/** The workflow rows: each source's head, then its workflows, the picked one marked. */
const workflowsOf = (l: LaunchLayer): LaunchBox['props']['workflows'] => {
  if (l.choices === undefined) return { rows: [], note: 'Reading the workflows…' };
  if (l.choices === 'failed')
    return { rows: [], note: 'The workflows did not read: it runs the one the card’s on: takes' };
  const picked = workflowNow(l);
  const options = l.choices.options;
  const rows = (['repo', 'yours', 'built-in'] as const).flatMap((layer) => {
    const of = options.filter((o) => o.layer === layer);

    return of.length === 0
      ? []
      : [
          { kind: 'head' as const, text: SOURCE_WORDS[layer] },
          ...of.map((o) => ({
            kind: 'item' as const,
            id: o.id,
            name: o.name,
            desc: o.description,
            on: o.on,
            takes: o.takes,
            picked: o.id === picked,
          })),
        ];
  });
  const shown = options.find((o) => o.id === picked);
  const warn = shown === undefined ? null : mismatchWords(kindOf(l), shown);

  return {
    rows,
    note: kindKnown(l)
      ? `${l.choices.why} Any other runs this card too.`
      : 'The one whose on: takes the card runs, else Feature; pick any other here.',
    ...(warn === null || !kindKnown(l) ? {} : { warn }),
  };
};

const reachOf = (l: LaunchLayer): LaunchBox['props']['reach'] =>
  REACH_ENVS.map((env) => {
    const set = l.reach?.[env] ?? env !== 'prod';

    if (env !== 'prod') return { env, label: set ? `✓ ${env}` : `○ ${env} off`, on: set };
    if (set) return { env, label: '✓ prod', on: true };
    if (runsNow(l) !== 'local-sandbox')
      return { env, label: '○ prod off · on for one session only locally', on: false };

    return l.prod
      ? { env, label: '● prod on · this session', on: true, click: PROD_CLICK }
      : { env, label: '○ prod off', on: false, click: PROD_CLICK };
  });

/** The card's live session this launch stops first, as `abe session stop` stops it. */
export const stopsWords = (id: string): string =>
  `stops ${id} first · its run and worktree kept, ended`;

/** Where it runs, after the title; none while that is not known. */
const titleWhere = (r: Runs | undefined): string => {
  if (r === undefined) return '';

  return r === 'local-sandbox' ? ' · locally' : ' · on a box';
};

export const viewLaunch = (l: LaunchLayer): LaunchBox => {
  const chars = l.draft.trim().length;

  return {
    kind: 'LaunchBox',
    id: `launch:${l.on.card}`,
    props: {
      title: `Launch #${l.on.card} ${l.on.title}${titleWhere(runsNow(l))}`,
      label: 'Notes for the agent (optional)',
      draft: l.draft,
      ...caretOf(l.caret),
      placeholder: 'What the agent should know, as markdown',
      along: [
        ...(l.standing ?? []).map((n) => `+ standing · ${n.text} · ${standingWords(n)}`),
        ...(l.on.prototype === true ? [`+ reference · ${l.reference ?? SOME_REFERENCE}`] : []),
        ...(l.on.stops === undefined ? [] : [stopsWords(l.on.stops)]),
      ],
      where: l.on.where,
      workflows: workflowsOf(l),
      runs: RUNS.map((id) => ({ id, label: RUNS_WORDS[id] })),
      ran: runsNow(l) ?? '',
      reach: reachOf(l),
      ...(l.prod && prodOn(l) && l.reach?.prod !== true ? { prodWarn: PROD_WARNING } : {}),
      ...(chars < NOTE_COUNT_FROM ? {} : { count: `${chars} / ${MAX_NOTE}` }),
      ...(over(l.draft) ? { over: true } : {}),
      hint: '⏎ Launch · ↑↓ workflow · ⌃R runs · ⌃P prod · ⇧⏎ new line · Esc',
    },
  };
};
