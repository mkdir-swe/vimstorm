/**
 * The pass that writes a step's Step summary and the run's Run brief as the step ends.
 * A fast model (the person's own `claude -p`, Haiku first: the `summarizer` role) reads what the
 * step left: its report (a stage's `--report`, a review or verify report; a stage
 * subagent's own report too, as its tool result in the transcript) and a digest of the step's
 * transcript. It answers one JSON document: the summary, the decisions (chose, over, why) and the
 * Evidence paths it saw; after Decide and each Grill, the brief too. Its answer is read strictly:
 * a decision with no real alternative is dropped (no filler), a path the step never named is
 * dropped, and every secret value is redacted from what is kept, as from what is sent. When the
 * model gives nothing usable the step keeps its own words, without decisions. Checks are serve's
 * own: summarised from their result, never by the model. Pure: the transcript, report and card
 * are given.
 */
import { z } from 'zod';
import { type Run, STAGES, type Visit } from './factory';
import { runStageWord } from './run-record';
import { checksFile } from './checks';
import { type BriefAnswer, type RunBrief, type StepDecision, type StepSummary } from './run-brief';
import { stepOf } from '../session/steps';
import { type TranscriptEntry } from '../session/transcript';
import { type KnownSecret, redactText } from '../improve/logs';
import { askingJson, readJsonAnswer } from '../triage/one-shot';

/** The steps whose pass writes the brief too: the spec, a bug's Before, or a run's first step. */
const BRIEF_STAGES: ReadonlySet<Run['stage']> = new Set(['spec', 'reproduce']);

/** Whether a finished step's pass writes the Run brief too (from the card). */
export const writesBrief = (
  run: Pick<Run, 'startedAt'>,
  visit: Pick<Visit, 'stage' | 'startedAt'>,
): boolean => BRIEF_STAGES.has(visit.stage) || visit.startedAt === run.startedAt;

const DIGEST_MAX = 24_000;
const DIGEST_HEAD = 4_000;
const REPORT_MAX = 12_000;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A verify report's header line under its title (browser's `withProfileLine`): no summary. */
const PROFILE_LINE = /^Browser profile: .*$/gm;

const firstParagraph = (text: string): string | null => {
  const para = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => oneLine(p.replace(/^#+\s.*$/gm, '').replace(PROFILE_LINE, '')))
    .find((p) => p !== '');

  return para === undefined ? null : cut(para, 400);
};

const relative = (path: string, root: string) => {
  const base = `${root.replace(/\/+$/, '')}/`;

  return root !== '' && path.startsWith(base) ? path.slice(base.length) : path;
};

const inVisit = (e: TranscriptEntry, v: Pick<Visit, 'startedAt' | 'endedAt'>) =>
  Date.parse(e.at) >= Date.parse(v.startedAt) && Date.parse(e.at) < Date.parse(v.endedAt);

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/**
 * The step's transcript as lines a model reads fast: the person's messages, the agent's words,
 * each tool call as its step row (`Ran bun test → 18 passed`), a subagent's report whole (a
 * stage run in a subagent returns one). Over the cap its head and its end are kept.
 */
export const stepDigest = (
  window: readonly TranscriptEntry[],
  all: readonly TranscriptEntry[],
  root: string,
): string => {
  const lines = window.flatMap((e): string[] => {
    const who = e.agent === null ? '' : ' (subagent)';

    if (e.kind === 'user') return [`Person: ${cut(e.text.trim(), 1_500)}`];
    if (e.kind === 'assistant-text') return [`Agent${who}: ${cut(e.text.trim(), 1_500)}`];
    if (e.kind !== 'tool-use') return [];
    const result = all.find(
      (r): r is Extract<TranscriptEntry, { kind: 'tool-result' }> =>
        r.kind === 'tool-result' && r.id === e.id,
    );
    const s = stepOf(e, result ?? null, { root });
    const row = `Tool${who}: ${s.verb} ${s.object}${s.result === null ? '' : ` → ${s.result}`}`;

    return SUBAGENT_TOOLS.has(e.tool) && result !== undefined
      ? [row, `Subagent report: ${cut(result.text.trim(), 3_000)}`]
      : [row];
  });
  const text = lines.join('\n');

  return text.length <= DIGEST_MAX
    ? text
    : `${text.slice(0, DIGEST_HEAD)}\n…\n${text.slice(text.length - (DIGEST_MAX - DIGEST_HEAD))}`;
};

/** The reports a step left as the run keeps them: its stage report, its review and verify ones. */
export const stepReports = (run: Run, visit: Visit): string[] => {
  const during = (x: { at: string }) =>
    Date.parse(x.at) >= Date.parse(visit.startedAt) &&
    Date.parse(x.at) <= Date.parse(visit.endedAt);

  return [
    ...new Set([
      ...(visit.report === null ? [] : [visit.report]),
      ...run.reviews.filter(during).flatMap((r) => (r.report === null ? [] : [r.report])),
      ...run.verifications.filter(during).map((v) => v.report),
    ]),
  ];
};

/** A step's Evidence as the run names it (`stepReports`), relative to the worktree under it. */
export const stepEvidence = (run: Run, visit: Visit): string[] => [
  ...new Set(stepReports(run, visit).map((p) => relative(p, run.worktree))),
];

/** The card's words a brief is written from. */
export type BriefCard = { description: string; criteria: string };

/** What the model is asked about one finished step, its secrets already out. */
export type StepAsk = {
  card: number;
  title: string;
  /** `Build`, or a workflow step's own name. */
  step: string;
  /** When it ended: its brief's time. */
  ended: string;
  report: string | null;
  digest: string;
  /** The session's own agent's last words in it, for a summary without the model. */
  words: string | null;
  /** The paths the run names for it (`stepEvidence`). */
  evidence: string[];
  /** For a brief (Decide, Grill): the card's words; null: no brief asked. */
  brief: BriefCard | null;
  /** A Grill's transcript path and answers: the brief cites them. */
  grill: { path: string | null; answers: BriefAnswer[] } | null;
};

/**
 * The ask for `visit`, the run's last finished step of its kind: its window of the transcript,
 * its report and the card's words, each with the known secrets and any token-shaped value
 * redacted before the model sees it.
 */
export const stepAskOf = (o: {
  run: Run;
  visit: Visit;
  entries: readonly TranscriptEntry[];
  report: string | null;
  card: BriefCard | null;
  known: readonly KnownSecret[];
}): StepAsk => {
  const { run, visit } = o;
  const clean = (text: string) => redactText(text, o.known);
  const window = o.entries.filter((e) => inVisit(e, visit));
  const last = window.findLast((e) => e.kind === 'assistant-text' && e.agent === null);

  return {
    card: run.card,
    title: run.title,
    step: visit.step ?? runStageWord(visit.stage),
    ended: visit.endedAt,
    report: o.report === null ? null : clean(cut(o.report, REPORT_MAX)),
    digest: clean(stepDigest(window, o.entries, run.worktree)),
    words: last?.kind === 'assistant-text' ? clean(last.text) : null,
    evidence: stepEvidence(run, visit),
    brief:
      writesBrief(run, visit) && o.card !== null
        ? { description: clean(o.card.description), criteria: clean(o.card.criteria) }
        : null,
    grill: null,
  };
};

export const SUMMARY_SYSTEM =
  'You summarise one finished step of a coding run from what it left. You write plainly and briefly. You never invent a decision, an alternative, a reason or a path.';

const SHAPE = (
  brief: boolean,
) => `{"summary": "one or two plain sentences: what the step did and what came of it",
 "decisions": [{"chose": "what the step chose, a few words", "over": "the option it did not take, a few words", "why": "its reason, one sentence"}],
 "evidence": ["a proof file's path as the text writes it"]${
   brief
     ? `,
 "brief": {"what": "what the run does, one sentence", "why": "why it matters, from the card", "plan": "how it will be done, one or two sentences", "doneWhen": "what is true when it is done"}`
     : ''
 }}`;

/** The one-shot's prompt for `a`: the step, its report and transcript, the JSON wanted back. */
export const stepPrompt = (a: StepAsk): string =>
  askingJson(
    [
      `Summarise the "${a.step}" step of the run on card #${a.card} "${a.title}".`,
      'decisions: only real choices the step made between options, each with the option it did not take and its own reason for the one it took. A step that did what it was told, ran something or only reported made no decision: give []. Never pad the list.',
      'evidence: the paths of proof files the text below names (reports, screenshots, recordings, logs), exactly as written; [] for none.',
      ...(a.brief === null
        ? []
        : [
            `brief: from the card${a.grill === null ? '' : " and the grill's answers"}: what the run does, why, the plan, and when it is done.`,
            `Card description:\n${a.brief.description.trim() === '' ? '(none)' : a.brief.description.trim()}`,
            `Acceptance criteria:\n${a.brief.criteria.trim() === '' ? '(none)' : a.brief.criteria.trim()}`,
          ]),
      `Report:\n${a.report === null || a.report.trim() === '' ? '(none)' : a.report.trim()}`,
      `Transcript:\n${a.digest === '' ? '(none)' : a.digest}`,
    ].join('\n\n'),
    SHAPE(a.brief !== null),
  );

const Said = z.object({
  summary: z.string(),
  decisions: z
    .array(z.object({ chose: z.string(), over: z.string(), why: z.string() }))
    .default([]),
  evidence: z.array(z.string()).default([]),
  brief: z
    .object({ what: z.string(), why: z.string(), plan: z.string(), doneWhen: z.string() })
    .nullable()
    .optional(),
});

/** An `over` that names no option: the step had no real choice. */
const NO_OPTION =
  /^(none|nothing|n\/?a|-+|no( other)? (alternative|option)s?|not applicable|doing nothing|no change)\.?$/i;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The decisions worth keeping: each with a real other option and a reason, once. */
const realDecisions = (said: z.infer<typeof Said>['decisions']): StepDecision[] => {
  const kept: StepDecision[] = [];

  for (const d of said) {
    const chose = cut(oneLine(d.chose), 140);
    const over = cut(oneLine(d.over.replace(/^over\s+/i, '')), 140);
    const why = cut(oneLine(d.why), 300);

    if (chose === '' || over === '' || why === '' || NO_OPTION.test(over) || same(chose, over))
      continue;
    if (kept.some((k) => same(k.chose, chose))) continue;
    kept.push({ chose, over, why });
  }

  return kept;
};

/** What the pass gives a step: its summary, and after Decide and Grill a brief. */
export type StepSaid = { summary: StepSummary; brief: RunBrief | null };

/**
 * The model's answer read strictly: its decisions without filler, its paths only those the step
 * named, everything kept redacted; why not when it is not the JSON asked for or says nothing.
 */
export const readStepSummary = (
  text: string,
  a: StepAsk,
  o: { at: string; known: readonly KnownSecret[] },
): { ok: true; said: StepSaid } | { ok: false; why: string } => {
  const r = readJsonAnswer(text, Said);

  if (!r.ok) return { ok: false, why: `the summary is not the JSON asked for: ${r.message}` };
  const clean = (s: string) => redactText(s, o.known);
  const summary = cut(oneLine(clean(r.data.summary)), 600);

  if (summary === '') return { ok: false, why: 'the summary says nothing' };
  const named = `${a.report ?? ''}\n${a.digest}`;
  const seen = r.data.evidence.map((p) => p.trim()).filter((p) => p !== '' && named.includes(p));
  const b = r.data.brief;
  const part = (s: string, max: number) => cut(oneLine(clean(s)), max);
  const parts =
    b === null || b === undefined
      ? undefined
      : {
          what: part(b.what, 300),
          why: part(b.why, 600),
          plan: part(b.plan, 600),
          doneWhen: part(b.doneWhen, 600),
        };
  // a brief missing a part is none: never one padded out
  const brief: RunBrief | null =
    a.brief === null || parts === undefined || Object.values(parts).some((w) => w === '')
      ? null
      : {
          ...parts,
          source: { card: a.card, grill: a.grill?.path ?? null, answers: a.grill?.answers ?? [] },
          at: a.ended,
        };

  return {
    ok: true,
    said: {
      summary: {
        text: summary,
        decisions: realDecisions(r.data.decisions).map((d) => ({
          chose: clean(d.chose),
          over: clean(d.over),
          why: clean(d.why),
        })),
        evidence: [...new Set([...a.evidence, ...seen.map(clean)])],
        by: 'model',
        at: o.at,
      },
      brief,
    },
  };
};

/**
 * A step's summary without the model: its report's first paragraph, else the agent's last words
 * in its digest, and no decisions; null when it left no words at all.
 */
export const wordsSummary = (a: StepAsk, at: string): StepSummary | null => {
  const text =
    (a.report === null ? null : firstParagraph(a.report)) ??
    (a.words === null ? null : firstParagraph(a.words));

  return text === null ? null : { text, decisions: [], evidence: a.evidence, by: 'words', at };
};

/**
 * Checks' summary, from their result (serve runs them, no agent does): passed, ran nothing, or
 * failed back to Build; their output kept as Evidence in `checks.md`.
 */
export const checksSummary = (run: Run, visit: Visit, at: string): StepSummary => {
  const i = run.visits.findIndex((v) => v.startedAt === visit.startedAt && v.stage === visit.stage);
  const next = (i === -1 ? undefined : run.visits[i + 1]?.stage) ?? run.stage;
  const passed = run.noChecks
    ? 'No check has a command here: nothing ran, on to Review.'
    : 'Checks passed.';
  const text = next === 'build' ? 'Checks failed: back to Build with what they said.' : passed;

  return { text, decisions: [], evidence: [checksFile(run.card)], by: 'serve', at };
};

/**
 * The run with `visit`'s summary kept on it, and the brief when one came and none from a later
 * step is held.
 */
export const withStepSummary = (run: Run, visit: Visit, said: StepSaid): Run => ({
  ...run,
  visits: run.visits.map((v) =>
    v.stage === visit.stage && v.startedAt === visit.startedAt && v.endedAt === visit.endedAt
      ? { ...v, summary: said.summary }
      : v,
  ),
  ...(said.brief !== null && (run.brief === undefined || run.brief.at <= said.brief.at)
    ? { brief: said.brief }
    : {}),
});

/** The `factory.summary` event's data: a finished step's summary is kept (and the brief, when). */
export const FactorySummaryEvent = z.object({
  card: z.number().int().positive(),
  session: z.string(),
  stage: z.enum(STAGES),
  /** The step's start: which visit of its stage. */
  startedAt: z.iso.datetime(),
  brief: z.boolean(),
});
export type FactorySummaryEvent = z.infer<typeof FactorySummaryEvent>;

export const factorySummaryText = (d: FactorySummaryEvent): string =>
  `AB#${d.card} ${d.stage} summarised${d.brief ? ', brief written' : ''}`;
