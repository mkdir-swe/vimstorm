/**
 * A workflow file's preview beside its YAML in the Editor (ADR 0033, design "Workflows in the
 * editor"): what `abe workflow read` answers as `preview`, the words and hues decided here, drawn
 * by the app (`app/src/editor/markdown/abe.rs`). Top to bottom: the title with whose it is and
 * what it takes, a count line, a red banner while it fails the load check; one card per step (its
 * name and a tag, its main skill and what it does), a gated one dashed with its judge's question
 * and a way around it, a way out as a dashed tag off its right; the loops back as brackets on the
 * right (`↩ build ×10`); a step's problem under its card.
 */
import { z } from 'zod';
import { onWords, SOURCE_WORDS } from './launch-pick';
import {
  type ConditionView,
  type SkillView,
  type WorkflowStepView,
  type WorkflowView,
} from './load';

/** The hues the app draws a preview's words in (its own colours for each). */
export const PREVIEW_HUES = ['text', 'dim', 'accent', 'good', 'warn', 'bad'] as const;
export const PreviewHue = z.enum(PREVIEW_HUES);
export type PreviewHue = z.infer<typeof PreviewHue>;

/** A badge by the title: whose it is (dim), what it takes (accent). */
export const PreviewBadge = z.object({ text: z.string(), hue: PreviewHue });
export type PreviewBadge = z.infer<typeof PreviewBadge>;

/** A step's way out: a dashed tag off its card's right, a dim note under it. */
export const PreviewExit = z.object({ text: z.string(), note: z.string() });

/** One step, a card. */
export const PreviewStep = z.object({
  name: z.string(),
  /** Its tag at the card's right: `⟲ fresh`, `on loop`, `gated`; null for none. */
  tag: z.string().nullable(),
  /** Its main skill (`serve` for checks). */
  skill: z.string(),
  /** Under the name, after the skill: what it does, a gate's question, or why it fails. */
  about: z.string(),
  /** A gate: the card dashed, a way around it (`skipped if no`). */
  gated: z.boolean(),
  /** It has a problem: the card and its skill red, the problem under the card. */
  bad: z.boolean(),
  /** Its problem in words, under the card; null for none. */
  problem: z.string().nullable(),
  exit: PreviewExit.nullable(),
  /** Its line in the file: the caret there rings it, a click puts the caret there. */
  line: z.number().int().positive().nullable(),
});
export type PreviewStep = z.infer<typeof PreviewStep>;

/** A loop back, a bracket on the right: from a step's card back up to an earlier one's. */
export const PreviewLoop = z.object({
  /** The steps' indexes: `from` the later one. */
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  /** `↩ build`. */
  label: z.string(),
  /** `×10`, dim. */
  times: z.string(),
});
export type PreviewLoop = z.infer<typeof PreviewLoop>;

/** A load-check problem, at its line. */
export const PreviewProblem = z.object({
  line: z.number().int().positive().nullable(),
  text: z.string(),
});
export type PreviewProblem = z.infer<typeof PreviewProblem>;

/** A link under the head: an action the Editor runs (`abe:<action>`). */
export const PreviewAction = z.object({ label: z.string(), action: z.string() });
export type PreviewAction = z.infer<typeof PreviewAction>;

export const WorkflowPreview = z.object({
  title: z.string(),
  badges: z.array(PreviewBadge),
  /** `7 steps · 3 loops · 1 gate · 1 exit`, dim after the badges. */
  summary: z.string(),
  /** Its `description:`; '' when none. */
  about: z.string(),
  actions: z.array(PreviewAction),
  /** The red banner while it fails the load check; null when it loads. */
  banner: z.string().nullable(),
  problems: z.array(PreviewProblem),
  steps: z.array(PreviewStep),
  loops: z.array(PreviewLoop),
  /** Under the last card: `a pull request`, `a report`. */
  end: z.string(),
});
export type WorkflowPreview = z.infer<typeof WorkflowPreview>;

/** What a workflow takes: `on default`, `on type Bug · tags docs`, else `picked by hand`. */
export const takesWords = (w: Pick<WorkflowView, 'on'>): string => {
  const on = w.on === null ? '' : onWords(w.on);

  return on === '' ? 'picked by hand' : `on ${on}`;
};

/** A condition short enough for a card: its question or check, cut at a word by `max` characters. */
const shortOf = (c: ConditionView, max = 48): string => {
  const words = c.kind === 'judge' ? c.question : c.check;

  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  const at = cut.lastIndexOf(' ');

  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
};

/** A `<fact> == 0` way out said plainly, by its fact. */
const NOT_WORDS: Readonly<Record<string, string>> = { 'bug.reproduced': 'no repro' };

const endsWhen = (c: ConditionView): string => {
  const zero = c.kind === 'check' ? /^([\w.]+)\s*==\s*0$/.exec(c.check.trim())?.[1] : undefined;

  return (zero === undefined ? undefined : NOT_WORDS[zero]) ?? shortOf(c);
};

const FRESH_TAGS: Readonly<Record<WorkflowStepView['fresh'], string | null>> = {
  never: null,
  always: '⟲ fresh',
  loop: 'on loop',
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a built-in step does when its skill says nothing. */
const BUILT_IN_ABOUT: Readonly<Record<string, string>> = {
  checks: 'runs the app, the tests',
};

const stepOf = (
  w: WorkflowView,
  s: WorkflowStepView,
  skills: readonly SkillView[],
): PreviewStep => {
  const problems = w.problems.filter((p) => p.line !== null && p.line === s.line);
  const missing = s.skill !== null && s.skillLayer === null;
  const skill = skills.find((k) => k.name === s.skill && k.layer === s.skillLayer);
  const does = skill?.description.split(/(?<=\.)\s/)[0] ?? BUILT_IN_ABOUT[s.kind] ?? '';
  const about = missing ? '✗ no such skill' : does;

  return {
    name: s.name,
    tag: s.gate === null ? FRESH_TAGS[s.fresh] : 'gated',
    skill: s.skill ?? 'serve',
    about: s.gate === null ? about : shortOf(s.gate, 64),
    gated: s.gate !== null,
    bad: missing || problems.length > 0,
    problem: problems.length === 0 ? null : problems.map((p) => p.text).join(' · '),
    exit:
      s.ends === null
        ? null
        : {
            text: s.ends.when === null ? 'report, end' : `${endsWhen(s.ends.when)} → report, end`,
            note: 'ends with a report',
          },
    line: s.line,
  };
};

/**
 * A loaded workflow's preview; `skills`: the Layers' (each step's main skill says what it does),
 * `actions`: the head's links.
 */
export const workflowPreview = (
  w: WorkflowView,
  skills: readonly SkillView[] = [],
  actions: readonly PreviewAction[] = [],
): WorkflowPreview => {
  const at = (name: string) => w.steps.findIndex((s) => s.name === name);
  const loops = w.loops.flatMap((l) => {
    const from = at(l.from);
    const to = at(l.to);

    return from < 0 || to < 0 ? [] : [{ from, to, label: `↩ ${l.to}`, times: `×${l.max}` }];
  });
  const gates = w.steps.filter((s) => s.gate !== null).length;
  const exits = w.steps.filter((s) => s.ends !== null).length;
  const last = w.steps.at(-1);
  const [first] = w.problems;

  return {
    title: w.name,
    badges: [
      { text: SOURCE_WORDS[w.layer], hue: 'dim' },
      { text: takesWords(w), hue: 'accent' },
    ],
    summary: [
      plural(w.steps.length, 'step'),
      ...(loops.length === 0 ? [] : [plural(loops.length, 'loop')]),
      ...(gates === 0 ? [] : [plural(gates, 'gate')]),
      ...(exits === 0 ? [] : [plural(exits, 'exit')]),
      ...(w.on?.default === true ? ['a card no other workflow takes runs this'] : []),
    ].join(' · '),
    about: w.description,
    actions: [...actions],
    banner:
      first === undefined
        ? null
        : `✗ ${plural(w.problems.length, 'problem')} · not loadable. No card gets ${w.name} until it loads.${first.line === null ? '' : ` Line ${first.line}:`} ${first.text}`,
    problems: w.problems.map((p) => ({ line: p.line, text: p.text })),
    steps: w.steps.map((s) => stepOf(w, s, skills)),
    loops,
    end: endOf(last),
  };
};

/** Under the last card: what the run ends with. */
const endOf = (last: WorkflowStepView | undefined): string => {
  if (last === undefined) return '';
  if (last.kind === 'pr') return 'a pull request';

  return last.ends?.when === null ? 'a report' : 'done';
};
