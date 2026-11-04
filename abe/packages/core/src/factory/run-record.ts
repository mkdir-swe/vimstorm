/**
 * A card's Run page (3.0 #21): the run as one record, built from what the run already keeps. Its
 * stage moves (`run.json`, `FactoryRunData`), its session's transcript (Claude Code's JSONL as
 * `TranscriptEntry`s), the After verification's report (the verify skill's numbered steps) and
 * the spec issue. `abe factory record <card>` answers it: live while the run goes (read where the
 * run is), afterwards from the org log store (ADR 0019), where the same files were shipped. Pure:
 * `runRecordOf` takes the files' contents, never reads them.
 *
 * The timeline is one step per stage visit (a loop visits a stage again: `Build #2`), each with
 * the transcript's entries of its time: the files its tools changed, the commands it ran and their
 * results, its last words; plus the person's steps (Needs you, how a person ended it, the merge).
 * A step is a decision (drawn teal) when a person or a decision made it: the spec's questions to
 * the person, a judge's answer, Needs you, review findings, the merge, a person's end.
 */
import { z } from 'zod';
import { FactoryRunData, type Stage, STAGES, type Verification } from './factory';
import { stepOf } from '../session/steps';
import { FilePatch, type TranscriptEntry } from '../session/transcript';
import { StepDecision, type StepSummary } from './run-brief';
import { FeatureResult, featureResults } from './verification-pack';
import { VerifyHtml, type VerifyWhere } from './verify-html';
import { MadeCommit, type MadeKept, StepMade } from './step-made';
import { findingRounds, ReviewRound } from './review-findings';

/** A step's mark: done, failed (a loop back), running now, or waiting on you. */
export const RUN_STEP_MARKS = ['ok', 'failed', 'running', 'needs-you'] as const;
export type RunStepMark = (typeof RUN_STEP_MARKS)[number];

/** What a step is: a stage's visit, or one of the person's moments. */
export const RUN_STEP_KINDS = ['stage', 'needs-you', 'ended', 'merge'] as const;

/** A command a step ran (a Bash call the verb table reads as `Ran`), with its result's words. */
export const RunCommand = z.object({
  command: z.string(),
  /** Null while it runs. */
  ok: z.boolean().nullable(),
  /** `18 passed`, `1 error`; null when the verb table says nothing. */
  result: z.string().nullable(),
});
export type RunCommand = z.infer<typeof RunCommand>;

/** A grill question and its answer, as the answer message said them. */
export const RunAnswer = z.object({ question: z.string(), answer: z.string(), at: z.string() });
export type RunAnswer = z.infer<typeof RunAnswer>;

export const RunRecordStep = z.object({
  /** `build:2` (the second Build), `needs-you`, `ended`, `merge`. */
  id: z.string(),
  kind: z.enum(RUN_STEP_KINDS),
  stage: z.enum(STAGES),
  /** Which visit of its stage (1 the first); 1 for the person's steps. */
  visit: z.number().int().positive(),
  at: z.string(),
  /** Null while it goes on. */
  endedAt: z.string().nullable(),
  /** One line: what came of it (`Lint failed: back to Build`). */
  headline: z.string(),
  /**
   * Its Step summary's words once its pass wrote them, else the agent's last words in it,
   * their first paragraph; null when it said none.
   */
  summary: z.string().nullable(),
  /** The real choices it made (chose, over, why), from its Step summary; empty for none. */
  decisions: z.array(StepDecision).default([]),
  /** Its Evidence's paths, from its Step summary. */
  evidence: z.array(z.string()).default([]),
  /** Its Step summary is written: false while the pass after it is still out (or never ran). */
  summarised: z.boolean().default(false),
  /** The skills it loaded (a Skill call's name, its subagents' too), each once, in order. */
  skills: z.array(z.string()).default([]),
  /** It ran in a subagent: a Task or Agent call, or a subagent's lines, in its time. */
  subagent: z.boolean().default(false),
  mark: z.enum(RUN_STEP_MARKS),
  /** A person's step or a decision: drawn teal, and what Only decisions keeps. */
  decision: z.boolean(),
  /** What its tools changed, paths relative to the worktree, each file once. */
  files: z.array(FilePatch),
  commands: z.array(RunCommand),
  /** The questions the step asked the person, and their answers. */
  answers: z.array(RunAnswer),
  /** The transcript entry Open in Chat jumps to; null when the transcript has none of its time. */
  chat: z.string().nullable(),
  /** The step going on now: pinned at the timeline's foot. */
  live: z.boolean(),
  /** The report its `stage-done` named (`.scratch/4/tickets.md`); null for none. */
  report: z.string().nullable().default(null),
  /** What it made, as its skill wrote it (`--made`): build's lanes, the tickets; null: none kept. */
  made: StepMade.nullable().default(null),
});
export type RunRecordStep = z.infer<typeof RunRecordStep>;

/** A criterion's mark: not verified yet, being verified, verified, failed. */
export const CRITERION_MARKS = ['todo', 'checking', 'pass', 'fail'] as const;
export type CriterionMark = (typeof CRITERION_MARKS)[number];

/** A piece of a criterion's proof: a command's output or an HTTP answer, or a screenshot's path. */
export const RunEvidence = z.object({
  kind: z.enum(['output', 'screenshot']),
  text: z.string(),
});
export type RunEvidence = z.infer<typeof RunEvidence>;

export const RunCriterion = z.object({
  n: z.number().int().positive(),
  text: z.string(),
  mark: z.enum(CRITERION_MARKS),
  /** How it was checked (`API: asked for a cart of 3 mugs`); null until verified. */
  how: z.string().nullable(),
  /** What was seen. */
  seen: z.string().nullable(),
  evidence: z.array(RunEvidence),
  /** Its chapter in the recording (`0:03`). */
  chapter: z.string().nullable(),
});
export type RunCriterion = z.infer<typeof RunCriterion>;

/** The spec the run worked from: its issue, its file on the card branch, or the spec stage's report. */
export const RunSpec = z.object({
  /** `o/shop#41`; null for a spec only in the run's report. */
  ref: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string(),
  /** Markdown. */
  body: z.string(),
  /** Its file on the card branch, read live (`.abe/specs/4/spec.md`); absent: not a file. */
  path: z.string().optional(),
});
export type RunSpec = z.infer<typeof RunSpec>;

/** The card as the board has it, for what the steps read: its words, its type and state. */
export const RunCard = z.object({
  type: z.string(),
  state: z.string(),
  tags: z.array(z.string()),
  /** The description as plain text (a bug's repro steps are here). */
  text: z.string(),
  /** Its acceptance criteria field as lines (the spec's may differ: `criteria` are the run's). */
  criteria: z.array(z.string()),
  url: z.string(),
});
export type RunCard = z.infer<typeof RunCard>;

/** A numbered step of a verify report: how, what was seen, its evidence and chapter. */
export const RunProofRow = z.object({
  n: z.number().int().positive(),
  how: z.string(),
  seen: z.string().nullable(),
  failed: z.boolean(),
  evidence: z.array(z.lazy(() => RunEvidence)),
  chapter: z.string().nullable(),
});

/** A bug's Before on the merge base (its reproduce step, or verify's own Before): what it found. */
export const RunBefore = z.object({
  at: z.iso.datetime(),
  result: z.enum(['pass', 'fail', 'not-reproduced']),
  /** The report's numbered steps. */
  rows: z.array(RunProofRow),
  recording: z.object({ path: z.string(), length: z.string().nullable() }).nullable(),
  /** Its HTML report as serve kept it, as the kit's parts; null for none. */
  report: VerifyHtml.nullable(),
  /** The report's own text (markdown); null when it cannot be read. */
  text: z.string().nullable(),
});
export type RunBefore = z.infer<typeof RunBefore>;

/** What the pull request carries: its files and their lines, the run's `.scratch/` left out. */
export const RunChanged = z.object({
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type RunChanged = z.infer<typeof RunChanged>;

/** Whether `path` is one of `copied` (the worktree recipe's files and folders) or under one. */
const copiedIn = (path: string, copied: readonly string[]): boolean =>
  copied.some((c) => {
    const at = c.replace(/\/+$/, '');

    return path === at || path.startsWith(`${at}/`);
  });

/**
 * A `git diff -U0` of the worktree against its merge base, counted as `RunChanged`: each file once
 * (a rename's header names both), a binary one with no lines; a file under a `.scratch/` left out,
 * and a new one the worktree got from its checkout (`copied`: the worktree recipe's links and
 * copies, its env files), as the pull request carries neither.
 */
export const runChangedOf = (patch: string, copied: readonly string[] = []): RunChanged => {
  const c = { files: 0, added: 0, removed: 0 };
  const blocks = patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git '));

  for (const block of blocks) {
    const lines = block.split('\n');
    const head = lines[0] ?? '';
    const path = / b\/(.*)$/.exec(head)?.[1] ?? '';

    if (head.includes('/.scratch/')) continue;
    if (lines.some((l) => l.startsWith('new file mode')) && copiedIn(path, copied)) continue;
    c.files += 1;
    let inHunk = false;

    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith('+')) c.added += 1;
      else if (inHunk && line.startsWith('-')) c.removed += 1;
    }
  }

  return c;
};

/** `abe factory record <card>`. */
export const RunRecordData = z.object({
  card: z.number().int().positive(),
  title: z.string(),
  /** Read where the run is (`live`), or from the org log store once it is gone (`record`). */
  source: z.enum(['live', 'record']),
  /** When it was read. */
  at: z.string(),
  run: FactoryRunData,
  /** The card's type as the board says it (`Bug`); null when not read. */
  type: z.string().nullable(),
  branch: z.string().nullable(),
  /** Where it runs, in words (`Local sandbox`, `box demo-shop-2`). */
  where: z.string().nullable(),
  steps: z.array(RunRecordStep),
  criteria: z.array(RunCriterion),
  spec: RunSpec.nullable(),
  /** The verification's recording: its path and length. */
  recording: z.object({ path: z.string(), length: z.string().nullable() }).nullable(),
  /** The last After pass's verdict per mapped feature; empty when it gave none. */
  features: z.array(FeatureResult).default([]),
  /** The last After pass's HTML report, sanitised into the verify kit's parts; null for none. */
  report: VerifyHtml.nullable().default(null),
  /** What the pull request carries: the worktree against its merge base; null when not read. */
  changed: RunChanged.nullable().default(null),
  /** The card as the board has it; null when not read. */
  cardDetail: RunCard.nullable().default(null),
  /** The card branch's commits since the merge base, oldest first; null when not read. */
  commits: z.array(MadeCommit).nullable().default(null),
  /** Every review round, its findings tracked per build round. */
  reviews: z.array(ReviewRound).default([]),
  /** The last Before on the merge base; null when none ran. */
  before: RunBefore.nullable().default(null),
  /** The report a step's `ends:` ended the run with, as text; null for none (or not read). */
  reported: z.string().nullable().default(null),
  /**
   * The parts still being read from outside (the board's card, the spec's issue): answered
   * without them rather than waiting, so read the record again in a moment for them.
   */
  unread: z.array(z.enum(['card', 'spec'])).default([]),
});
export type RunRecordData = z.infer<typeof RunRecordData>;

// ── The criteria ───────────────────────────────────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** A board's HTML (Azure's criteria field) as lines of text; plain text unchanged. */
const textOf = (html: string): string =>
  html
    .replace(/<\s*(br|\/p|\/div|\/li|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);

const BULLET = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|\[[ xX]\]\s+)/;

/** The section under `## Acceptance criteria` (any level), up to the next heading. */
const criteriaSection = (markdown: string): string | undefined => {
  const lines = markdown.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{1,6}\s+acceptance criteria\s*$/i.test(l.trim()));

  if (at === -1) return undefined;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l.trim()));

  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

/**
 * The acceptance criteria, one per line or list item, in order: the spec's `## Acceptance
 * criteria` section when it has one, else the card's criteria field (its HTML read as text).
 */
export const criteriaOf = (card: string, spec?: string | null): string[] => {
  const source = (spec === undefined || spec === null ? undefined : criteriaSection(spec)) ?? card;

  return textOf(source)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(BULLET, '').trim())
    .filter((l) => l !== '');
};

/** The card as the board read it, for the Run page: its description as plain text, its criteria field as lines. */
export const runCardOf = (c: {
  type: string;
  state: string;
  tags: readonly string[];
  description: string;
  acceptanceCriteria: string;
  url: string;
}): RunCard => ({
  type: c.type,
  state: c.state,
  tags: [...c.tags],
  text: textOf(c.description)
    .replace(/\n{3,}/g, '\n\n')
    .trim(),
  criteria: criteriaOf(c.acceptanceCriteria),
  url: c.url,
});

// ── The verify report ──────────────────────────────────────────────────────────────────────

/** One numbered step of a verify report: one per acceptance criterion, in their order. */
export type VerifyRow = {
  n: number;
  how: string;
  seen: string | null;
  failed: boolean;
  evidence: RunEvidence[];
  chapter: string | null;
};

export type VerifyReport = {
  result: 'pass' | 'fail' | null;
  rows: VerifyRow[];
  recording: { path: string; length: string | null } | null;
};

const STEP_LINE = /^(\d+)\.\s+(.*)$/;
const CHAPTER = /^▶\s*(\d+:\d{2})$/;
const SHOT = /\.(png|jpe?g|webp|gif)$/i;
const FENCE = /^\s*(```|~~~)/;

/**
 * The verify skill's After report read for its proof: each `N. <where>: <done> → <seen> ·
 * <evidence> · ▶ m:ss` line (a fenced block under it its output), `Result: pass | fail (step N …)`,
 * and `Recording: <path> · m:ss`. A step is failed when it starts `✗` or the result names it.
 */
export const verifyReportOf = (text: string): VerifyReport => {
  const rows: VerifyRow[] = [];
  let result: VerifyReport['result'] = null;
  let recording: VerifyReport['recording'] = null;
  let failing = '';
  let fence: string[] | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      if (fence === undefined) fence = [];
      else {
        const row = rows.at(-1);

        if (row !== undefined && fence.length > 0)
          row.evidence.push({ kind: 'output', text: fence.join('\n') });
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      fence.push(line);
      continue;
    }
    const said = /^result:\s*(pass|fail)\b(.*)$/i.exec(line.trim());

    if (said !== null) {
      result = said[1]?.toLowerCase() === 'pass' ? 'pass' : 'fail';
      failing = said[2] ?? '';
      continue;
    }
    const rec = /^recording:\s*(.+)$/i.exec(line.trim());

    if (rec !== null) {
      const [path = '', length] = (rec[1] ?? '').split(' · ').map((p) => p.trim());

      recording = { path, length: length?.replace(/^▶\s*/, '') ?? null };
      continue;
    }
    const m = STEP_LINE.exec(line.trim());

    if (m === null) continue;
    const parts = (m[2] ?? '').split(' · ').map((p) => p.trim());
    const [head = '', ...tail] = parts;
    const failed = /^✗\s*/.test(head);
    const words = head.replace(/^[✓✗]\s*/, '');
    const arrow = words.indexOf('→');

    rows.push({
      n: Number(m[1]),
      how: (arrow === -1 ? words : words.slice(0, arrow)).trim(),
      seen: arrow === -1 ? null : words.slice(arrow + 1).trim(),
      failed,
      evidence: tail
        .filter((p) => SHOT.test(p))
        .map((p) => ({ kind: 'screenshot' as const, text: p })),
      chapter: tail.map((p) => CHAPTER.exec(p)?.[1]).find((c) => c !== undefined) ?? null,
    });
  }
  const named = [...failing.matchAll(/\bstep\s+(\d+)/gi)].map((x) => Number(x[1]));

  for (const row of rows) if (named.includes(row.n)) row.failed = true;

  return { result, rows, recording };
};

/** A screenshot's file name, as the proof names it: its folder is git-ignored. */
const shotName = (path: string): string => `\`${path.split('/').at(-1) ?? path}\``;

/**
 * The proof rows a pull request's body carries (the same rows as the Run page's Verify): one line
 * per verified step, its mark, how and what was seen, its evidence (by file name: it is not in the
 * repository) and chapter. Empty for none.
 */
export const proofLines = (report: VerifyReport): string[] =>
  report.rows.map((r) =>
    [
      `- ${r.failed ? '✗' : '✓'} ${r.n}. ${r.how}${r.seen === null ? '' : ` → ${r.seen}`}`,
      ...r.evidence.filter((e) => e.kind === 'screenshot').map((e) => shotName(e.text)),
      ...(r.chapter === null ? [] : [`▶ ${r.chapter}`]),
    ].join(' · '),
  );

export const PROOF_HEADING = '## Proof';

/**
 * Under the proof rows that name evidence: where it is, so a reader on GitHub knows it is not a
 * link (the screenshots and the recording stay with the run, in its git-ignored `.scratch/`).
 */
export const PROOF_LOCAL =
  "_The screenshots and the recording stay with the run on the author's machine (its Run page, Verify): the repository has none of them._";

/**
 * Where each web feature was driven, from the HTML report: its env, the account and the pages its
 * shots and recordings name, one line per feature that names any. Empty for none.
 */
export const proofWhereLines = (html: VerifyHtml | null): string[] =>
  (html?.features ?? []).flatMap((f) => {
    const wheres = f.parts.flatMap((p): VerifyWhere[] => {
      switch (p.kind) {
        case 'pair':
          return [p.before, p.after];
        case 'shot':
          return [p.shot];
        case 'recording':
          return [p];
        default:
          return [];
      }
    });
    const accounts = [...new Set(wheres.flatMap((w) => w.account ?? []))];
    const urls = [...new Set(wheres.flatMap((w) => w.url ?? []))];
    const said = [
      ...(f.env === undefined ? [] : [f.env]),
      ...(accounts.length === 0 ? [] : [`as ${accounts.map((a) => `\`${a}\``).join(', ')}`]),
      ...urls.map((u) => `\`${u}\``),
    ];

    return said.length === 0 ? [] : [`- \`${f.feature}\` · ${said.join(' · ')}`];
  });

/**
 * The body with a `## Proof` section of the verify report's rows, unless it has one or none; with
 * the HTML report, where each feature was driven under them.
 */
export const withProof = (
  body: string,
  report: VerifyReport,
  html: VerifyHtml | null = null,
): string => {
  const lines = proofLines(report);
  const where = proofWhereLines(html);

  if (lines.length === 0 || body.split(/\r?\n/).some((l) => l.trimEnd() === PROOF_HEADING))
    return body;
  const shown =
    report.recording !== null ||
    report.rows.some((r) => r.chapter !== null || r.evidence.some((e) => e.kind === 'screenshot'));

  return `${body.trimEnd()}\n\n${PROOF_HEADING}\n\n${lines.join('\n')}\n${where.length === 0 ? '' : `\nDriven at:\n\n${where.join('\n')}\n`}${shown ? `\n${PROOF_LOCAL}\n` : ''}`;
};

// ── The steps ──────────────────────────────────────────────────────────────────────────────

const ms = (at: string) => Date.parse(at);

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STAGE_WORD: Readonly<Record<Stage, string>> = {
  spec: 'Spec',
  reproduce: 'Reproduce',
  build: 'Build',
  checks: 'Checks',
  review: 'Review',
  verify: 'Verify',
  pr: 'PR',
  step: 'Step',
  done: 'Done',
};

/** Its first paragraph, in one line. */
const firstParagraph = (text: string): string | null => {
  const para = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p !== '');

  return para === undefined ? null : cut(para, 280);
};

const relative = (path: string, root: string) => {
  const base = `${root.replace(/\/+$/, '')}/`;

  return root !== '' && path.startsWith(base) ? path.slice(base.length) : path;
};

/** The files a window's tools changed, each once (its counts summed, its hunks in order). */
const filesOf = (window: readonly TranscriptEntry[], root: string): FilePatch[] => {
  const by = new Map<string, FilePatch>();
  const add = (p: FilePatch) => {
    const path = relative(p.path, root);
    const was = by.get(path);

    by.set(
      path,
      was === undefined
        ? { ...p, path }
        : {
            ...was,
            added: was.added + p.added,
            removed: was.removed + p.removed,
            hunks: [...was.hunks, ...p.hunks],
            cut: was.cut + p.cut,
          },
    );
  };

  for (const e of window) if (e.kind === 'tool-result' && e.patch !== null) add(e.patch);
  // nothing from a file tool (a Bash `sed`, a subagent's merge): the turns' changes from git
  if (by.size === 0) {
    const turns = new Map<string, FilePatch[]>();

    for (const e of window) if (e.kind === 'changes') turns.set(e.turn, e.files);
    for (const files of turns.values()) for (const f of files) add(f);
  }

  return [...by.values()].slice(0, 30);
};

/** The commands a window ran (`Ran …`), with their results. */
const commandsOf = (
  window: readonly TranscriptEntry[],
  all: readonly TranscriptEntry[],
  root: string,
): RunCommand[] =>
  window
    .flatMap((e) => {
      if (e.kind !== 'tool-use' || e.tool !== 'Bash') return [];
      const result = all.find(
        (r): r is Extract<TranscriptEntry, { kind: 'tool-result' }> =>
          r.kind === 'tool-result' && r.id === e.id,
      );
      const s = stepOf(e, result ?? null, { root });

      if (s.verb !== 'Ran' && s.verb !== 'Running') return [];

      return [
        {
          command: s.object,
          ok: s.glyph === 'running' ? null : s.glyph === 'ok',
          result: s.result,
        },
      ];
    })
    .slice(0, 12);

const ANSWER = /^(?:\d+\.\s+)?Answer to "(.*)":\s*(?:\d\s+)?(.*)$/;

/** A step's questions and answers, from the answer messages Chat sent. */
const answersOf = (window: readonly TranscriptEntry[]): RunAnswer[] =>
  window.flatMap((e) =>
    e.kind !== 'user'
      ? []
      : e.text.split('\n').flatMap((l) => {
          const m = ANSWER.exec(l.trim());

          return m === null ? [] : [{ question: m[1] ?? '', answer: m[2] ?? '', at: e.at }];
        }),
  );

/** The visits as windows: each finished one, then the one going on. */
type Window = {
  stage: Stage;
  start: string;
  end: string | null;
  summary: StepSummary | null;
  report: string | null;
};

const windowsOf = (run: FactoryRunData): Window[] => {
  const done: Window[] = run.stages.map((v) => ({
    stage: v.stage,
    start: v.startedAt,
    end: v.endedAt,
    summary: v.summary ?? null,
    report: v.report,
  }));
  const goes = run.outcome === null && run.stage !== 'done';

  return goes
    ? [...done, { stage: run.stage, start: run.since, end: null, summary: null, report: null }]
    : done;
};

/** What a window's step made: the last `--made` handed in its time. */
const madeIn = (made: readonly MadeKept[], w: Window): StepMade | null =>
  within(made, w)?.made ?? null;

const inWindow = (e: TranscriptEntry, w: Window) =>
  ms(e.at) >= ms(w.start) && (w.end === null || ms(e.at) < ms(w.end));

const within = <T extends { at: string }>(list: readonly T[], w: Window): T | undefined =>
  list.findLast((x) => ms(x.at) >= ms(w.start) && (w.end === null || ms(x.at) <= ms(w.end)));

type Said = { headline: string; mark: RunStepMark; decision: boolean };

/** A visit's headline, mark and whether it was a decision. */
const said = (
  run: FactoryRunData,
  w: Window,
  next: Window | undefined,
  o: { files: number; answers: number; criteria: number; passed: number; spec: RunSpec | null },
): Said => {
  const live = w.end === null;
  const going = (headline: string): Said => ({
    headline,
    mark: run.state === 'needs-you' ? 'needs-you' : 'running',
    decision: false,
  });
  const ok = (headline: string, decision = false): Said => ({ headline, mark: 'ok', decision });
  const back = (headline: string, decision = false): Said => ({
    headline,
    mark: 'failed',
    decision,
  });

  switch (w.stage) {
    case 'spec': {
      // its questions to the person, when it asked any, are decisions
      const asked = o.answers === 0 ? '' : `${plural(o.answers, 'question')} answered · `;

      if (live) return { ...going(`${asked}Writing the spec`), decision: o.answers > 0 };

      return ok(
        `${asked}${o.spec?.ref === null || o.spec === null ? 'Spec written' : `Spec written: ${o.spec.ref}`}`,
        o.answers > 0,
      );
    }
    case 'reproduce': {
      if (live) return going('Reproducing on the merge base');
      const v: Verification | undefined = within(run.verifications, w);

      if (v === undefined) return ok('Reproduced');

      return v.result === 'pass'
        ? ok('Reproduced on the merge base')
        : back(
            v.result === 'not-reproduced'
              ? 'Did not reproduce on the merge base'
              : 'Could not run on the merge base',
          );
    }
    case 'build':
      if (live) return going('Building');

      return ok(o.files === 0 ? 'Built' : `${plural(o.files, 'file')} changed`);
    case 'checks':
      if (live) return going('Checking');

      return next?.stage === 'build' ? back('Checks failed: back to Build') : ok('Checks passed');
    case 'review': {
      if (live) return going('Reviewing');
      const r = within(run.reviews, w);

      if (r === undefined || r.findings === 0) return ok('No findings');
      const words = plural(r.findings, 'finding');

      return next?.stage === 'build' ? back(`${words}: back to Build`, true) : ok(words, true);
    }
    case 'verify': {
      if (live) return going('Verifying');
      const v: Verification | undefined = within(run.verifications, w);

      if (v === undefined) return ok('Verified');
      if (v.phase === 'before')
        return v.result === 'not-reproduced'
          ? back('Did not reproduce on the merge base')
          : ok('Reproduced on the merge base');
      if (v.result === 'fail') return back('Verify failed: back to Build');

      return ok(o.criteria === 0 ? 'Verified' : `${o.passed} of ${o.criteria} criteria pass`);
    }
    case 'pr': {
      const pr = run.pr;

      if (pr === null) return live ? going('Opening the pull request') : ok('Pull request');

      return live && pr.state === 'open'
        ? going(`Pull request #${pr.number} open`)
        : ok(`Pull request #${pr.number} ${pr.state}`);
    }
    // a workflow's own skill (#15): its name is `Run.step`'s, not the stage's
    case 'step':
      return live ? going(run.step ?? 'Step') : ok(run.step ?? 'Step');
    case 'done':
      return ok('Done');
  }
};

/** The skills a window loaded: each Skill call's name once, in order. */
const skillsOf = (window: readonly TranscriptEntry[]): string[] => [
  ...new Set(
    window.flatMap((e) =>
      e.kind === 'tool-use' && e.tool === 'Skill' && typeof e.input.skill === 'string'
        ? [e.input.skill]
        : [],
    ),
  ),
];

const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** A window run in a subagent: a Task or Agent call, or a subagent's own lines. */
const inSubagent = (window: readonly TranscriptEntry[]): boolean =>
  window.some((e) => e.agent !== null || (e.kind === 'tool-use' && SUBAGENT_TOOLS.has(e.tool)));

/** Its first message or words in the transcript: where Open in Chat lands. */
const chatOf = (window: readonly TranscriptEntry[]): string | null =>
  window.find((e) => e.kind === 'user' || e.kind === 'assistant-text')?.id ?? null;

const ENDED_WORD = {
  done: 'Ended done',
  'not-reproduced': 'Ended: not reproduced',
  abandoned: 'Abandoned',
};

// ── The criteria's marks ───────────────────────────────────────────────────────────────────

const criteriaMarks = (
  run: FactoryRunData,
  texts: readonly string[],
  report: VerifyReport | null,
): RunCriterion[] => {
  const after = run.verifications.findLast((v) => v.phase === 'after');
  // verifying again now (after a fail, or for the first time): what is checked is checking
  const checking =
    run.stage === 'verify' &&
    run.outcome === null &&
    (after === undefined || ms(after.at) < ms(run.since));

  return texts.map((text, i) => {
    const n = i + 1;
    const row = report?.rows.find((r) => r.n === n);
    const proof = {
      how: row?.how ?? null,
      seen: row?.seen ?? null,
      evidence: row?.evidence ?? [],
      chapter: row?.chapter ?? null,
    };
    const blank = { how: null, seen: null, evidence: [], chapter: null };

    if (checking) return { n, text, mark: 'checking' as const, ...blank };
    if (after === undefined) return { n, text, mark: 'todo' as const, ...blank };
    if (after.result === 'pass') return { n, text, mark: 'pass' as const, ...proof };
    if (row === undefined) return { n, text, mark: 'todo' as const, ...blank };

    return { n, text, mark: row.failed ? ('fail' as const) : ('pass' as const), ...proof };
  });
};

// ── The record ─────────────────────────────────────────────────────────────────────────────

export type RunRecordInputs = {
  run: FactoryRunData;
  /** Its session's transcript, as read (empty: none could be read). */
  entries: readonly TranscriptEntry[];
  /** The card's acceptance criteria field (HTML or text); empty when not read. */
  criteria: string;
  /** The last After verification's report text; null when there is none or it cannot be read. */
  verify: string | null;
  /** Its HTML report as serve kept it, read into the kit's parts; null for none. */
  html?: VerifyHtml | null;
  spec: RunSpec | null;
  source: 'live' | 'record';
  at: string;
  type?: string | null;
  branch?: string | null;
  where?: string | null;
  changed?: RunChanged | null;
  cardDetail?: RunCard | null;
  commits?: readonly MadeCommit[] | null;
  /** The last Before's report text and its HTML report as the kit's parts; null for none. */
  before?: { text: string | null; html: VerifyHtml | null } | null;
  /** The text of the report a step's `ends:` ended the run with; null for none. */
  reported?: string | null;
  /** The parts still being read from outside (`RunRecordData.unread`). */
  unread?: RunRecordData['unread'];
};

export const runRecordOf = (i: RunRecordInputs): RunRecordData => {
  const { run } = i;
  const root = run.worktree;
  const report = i.verify === null ? null : verifyReportOf(i.verify);
  const criteria = criteriaMarks(run, criteriaOf(i.criteria, i.spec?.body), report);
  const passed = criteria.filter((c) => c.mark === 'pass').length;
  const windows = windowsOf(run);
  const seen = new Map<Stage, number>();
  const steps: RunRecordStep[] = windows.map((w, n) => {
    const visit = (seen.get(w.stage) ?? 0) + 1;

    seen.set(w.stage, visit);
    const window = i.entries.filter((e) => inWindow(e, w));
    const files = filesOf(window, root);
    const answers = answersOf(window);
    const words = window.findLast((e) => e.kind === 'assistant-text' && e.agent === null);
    const s = said(run, w, windows[n + 1], {
      files: files.length,
      answers: answers.length,
      criteria: criteria.length,
      passed,
      spec: i.spec,
    });

    return {
      id: `${w.stage}:${visit}`,
      kind: 'stage',
      stage: w.stage,
      visit,
      at: w.start,
      endedAt: w.end,
      ...s,
      // a step that made a real choice is a decision too
      decision: s.decision || (w.summary?.decisions.length ?? 0) > 0,
      summary:
        w.summary?.text ?? (words?.kind === 'assistant-text' ? firstParagraph(words.text) : null),
      decisions: w.summary?.decisions ?? [],
      evidence: w.summary?.evidence ?? [],
      summarised: w.summary !== null,
      skills: skillsOf(window),
      subagent: inSubagent(window),
      files,
      commands: commandsOf(window, i.entries, root),
      answers,
      chat: chatOf(window),
      live: w.end === null && run.state !== 'needs-you',
      report: w.report,
      made: madeIn(run.made ?? [], w),
    };
  });
  const person = (
    o: Pick<RunRecordStep, 'id' | 'kind' | 'at' | 'headline' | 'mark' | 'live'> & {
      stage: Stage;
    },
  ): RunRecordStep => ({
    visit: 1,
    endedAt: null,
    summary: null,
    decision: true,
    decisions: [],
    evidence: [],
    summarised: false,
    skills: [],
    subagent: false,
    files: [],
    commands: [],
    answers: [],
    chat: i.entries.find((e) => ms(e.at) >= ms(o.at) && e.kind === 'user')?.id ?? null,
    report: null,
    made: null,
    ...o,
  });
  const extra: RunRecordStep[] = [
    ...(run.state === 'needs-you' && run.reason !== null
      ? [
          person({
            id: 'needs-you',
            kind: 'needs-you',
            stage: run.stage,
            at: run.needsYouSince ?? run.since,
            headline: run.reason,
            mark: 'needs-you',
            live: true,
          }),
        ]
      : []),
    ...(run.ended === null
      ? []
      : [
          person({
            id: 'ended',
            kind: 'ended',
            stage: run.ended.from,
            at: run.ended.at,
            headline: `${ENDED_WORD[run.ended.as]}: ${run.ended.reason}`,
            mark: 'ok',
            live: false,
          }),
        ]),
    ...(run.pr?.state === 'merged'
      ? [
          person({
            id: 'merge',
            kind: 'merge',
            stage: 'pr',
            at: run.stages.findLast((v) => v.stage === 'pr')?.endedAt ?? run.since,
            headline: run.pr.merge === 'auto' ? 'Merged by Abe' : 'Merged',
            mark: 'ok',
            live: false,
          }),
        ]
      : []),
  ];

  return {
    card: run.card,
    title: run.title,
    source: i.source,
    at: i.at,
    run,
    type: i.type ?? null,
    branch: i.branch ?? null,
    where: i.where ?? null,
    steps: [...steps, ...extra].sort((a, b) => ms(a.at) - ms(b.at)),
    criteria,
    spec: i.spec,
    recording: report?.recording ?? null,
    features: featuresOf(run, i.verify),
    report: i.html ?? null,
    changed: i.changed ?? null,
    cardDetail: i.cardDetail ?? null,
    commits: i.commits === undefined || i.commits === null ? null : [...i.commits],
    reviews: findingRounds(
      run.reviews,
      run.stages.filter((v) => v.stage === 'build'),
    ),
    before: beforeOf(run, i.before ?? null),
    reported: i.reported ?? null,
    unread: i.unread ?? [],
  };
};

/** The last Before on the merge base, its report read for its steps. */
const beforeOf = (
  run: FactoryRunData,
  read: { text: string | null; html: VerifyHtml | null } | null,
): RunBefore | null => {
  const v = run.verifications.findLast((x) => x.phase === 'before');

  if (v === undefined) return null;
  const report = read?.text === null || read?.text === undefined ? null : verifyReportOf(read.text);

  return {
    at: v.at,
    result: v.result,
    rows: report?.rows ?? [],
    recording: report?.recording ?? null,
    report: read?.html ?? null,
    text: read?.text ?? null,
  };
};

/** The last After pass's verdicts: as its verification kept them, else read from its report. */
const featuresOf = (run: FactoryRunData, verify: string | null): FeatureResult[] =>
  run.verifications.findLast((v) => v.phase === 'after')?.features ??
  (verify === null ? [] : featureResults(verify));

/** The stage's word (`Build`), and with a visit past the first its number (`Build #2`). */
export const runStepTitle = (s: Pick<RunRecordStep, 'kind' | 'stage' | 'visit'>, loops: number) => {
  if (s.kind === 'needs-you') return 'Needs you';
  if (s.kind === 'ended') return 'Ended';
  if (s.kind === 'merge') return 'Merge';

  return loops > 1 ? `${STAGE_WORD[s.stage]} #${s.visit}` : STAGE_WORD[s.stage];
};

export const runStageWord = (stage: Stage): string => STAGE_WORD[stage];

/** `abe factory record`'s human text: the title, the steps, the criteria. */
export const runRecordText = (d: RunRecordData): string => {
  const loops = (stage: Stage) =>
    d.steps.filter((s) => s.stage === stage && s.kind === 'stage').length;
  const glyph = { ok: '✓', failed: '✗', running: '●', 'needs-you': '◆' };
  const crit = { todo: '○', checking: '●', pass: '✓', fail: '✗' };

  return `${[
    `Run · #${d.card} ${d.title}${d.run.workflow === null ? '' : ` · ${d.run.workflow.name ?? d.run.workflow.id} (${d.run.workflow.layer})`}${d.source === 'record' ? ' · record' : ''}`,
    ...d.steps.map(
      (s) =>
        `  ${glyph[s.mark]} ${runStepTitle(s, loops(s.stage)).padEnd(10)} ${s.headline}${s.decision ? ' ◆' : ''}`,
    ),
    ...(d.criteria.length === 0
      ? []
      : ['Acceptance criteria', ...d.criteria.map((c) => `  ${crit[c.mark]} ${c.text}`)]),
  ].join('\n')}\n`;
};
