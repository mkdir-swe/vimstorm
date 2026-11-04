/**
 * The pass after each finished step of a run: serve reads what the step left (its
 * reports, its transcript's window, the card for a brief) and asks the fast model through the
 * one-shot port (core's `step-summary.ts`), then keeps the Step summary on the step's visit and,
 * after Decide and each Grill, the Run brief on the run. Checks are summarised from their result.
 * A model that fails or answers nothing usable leaves the step its own words, without decisions;
 * a step that left no words has no summary. Never in the run's way: the Factory does not wait.
 */
import {
  type BriefCard,
  checksSummary,
  type KnownSecret,
  readStepSummary,
  type Run,
  type StepSaid,
  stepAskOf,
  stepPrompt,
  stepReports,
  writesBrief,
  type TranscriptEntry,
  type Visit,
  wordsSummary,
} from '@abe/core';

/** Where the pass reads from, and the model it asks. */
export type StepSummarySources = {
  /** The run's session's transcript, as read (empty: none could be). */
  entries: (session: string) => Promise<readonly TranscriptEntry[]>;
  /** A report the run named, as text; null when it cannot be read. */
  file: (run: Run, path: string) => Promise<string | null>;
  /** The card's words, for a brief; null when the board cannot be read. */
  card: (run: Run) => Promise<BriefCard | null>;
  /** The values to redact: every Abe env file's of its checkout. */
  known: (run: Run) => Promise<readonly KnownSecret[]>;
  /** The one-shot (`summarizer` role): its text answer, or why there is none. */
  ask: (
    run: Run,
    prompt: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; why: string }>;
  now: () => string;
};

/** A finished step's summary (and the run's brief after Decide or a Grill); null: it left none. */
export type StepSummarizer = (run: Run, visit: Visit) => Promise<StepSaid | null>;

export const stepSummarizer =
  (s: StepSummarySources): StepSummarizer =>
  async (run, visit) => {
    if (visit.stage === 'checks')
      return { summary: checksSummary(run, visit, s.now()), brief: null };
    const reports = await Promise.all(stepReports(run, visit).map((p) => s.file(run, p)));
    const texts = reports.filter((t): t is string => t !== null && t.trim() !== '');
    const [entries, card, known] = await Promise.all([
      s.entries(run.session),
      writesBrief(run, visit) ? s.card(run) : Promise.resolve(null),
      s.known(run),
    ]);
    const ask = stepAskOf({
      run,
      visit,
      entries,
      report: texts.length === 0 ? null : texts.join('\n\n'),
      card,
      known,
    });

    if (ask.report === null && ask.digest === '') return null;
    const answer = await s.ask(run, stepPrompt(ask));
    const read = answer.ok ? readStepSummary(answer.text, ask, { at: s.now(), known }) : undefined;

    if (read?.ok === true) return read.said;
    const words = wordsSummary(ask, s.now());

    return words === null ? null : { summary: words, brief: null };
  };
