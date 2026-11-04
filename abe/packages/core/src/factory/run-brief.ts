/**
 * What a run's record says about it beyond its moves: the Run brief on top (what the run
 * does, why, the plan, done when, and where that came from: the card and the Grill answers) and a
 * Step summary per finished step (what it did, the decisions it took, its Evidence). The fast
 * model's pass writes them as each step ends (`step-summary.ts`); serve keeps them on the run, and
 * `abe factory status --json` returns them. Schemas only: `factory.ts` reads them as it loads.
 */
import { z } from 'zod';

/** A real choice a step made: what it chose, the option it did not take, and why. */
export const StepDecision = z.object({
  chose: z.string().min(1),
  over: z.string().min(1),
  why: z.string().min(1),
});
export type StepDecision = z.infer<typeof StepDecision>;

/**
 * Where a step summary's words came from: the fast model's pass over the step's report and
 * transcript, the step's own words when the model gave none (no decisions then), or serve's
 * result for a step serve ran itself (checks).
 */
export const SUMMARY_SOURCES = ['model', 'words', 'serve'] as const;

export const StepSummary = z.object({
  /** What the step did and what came of it, in a sentence or two. */
  text: z.string().min(1),
  /** Empty when the step made no real choice: never filler. */
  decisions: z.array(StepDecision),
  /** Its proof's paths (reports, screenshots, recordings, checks output), as the run names them. */
  evidence: z.array(z.string()),
  by: z.enum(SUMMARY_SOURCES),
  at: z.iso.datetime(),
});
export type StepSummary = z.infer<typeof StepSummary>;

/** A Grill question and its answer, as the grill's transcript says them. */
export const BriefAnswer = z.object({ question: z.string(), answer: z.string() });
export type BriefAnswer = z.infer<typeof BriefAnswer>;

export const RunBrief = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  plan: z.string().min(1),
  doneWhen: z.string().min(1),
  /** Where it came from: the card, and the Grill's transcript and answers (none before a Grill). */
  source: z.object({
    card: z.number().int().positive(),
    grill: z.string().nullable(),
    answers: z.array(BriefAnswer),
  }),
  /** When the step it was written from ended: a later step's brief replaces it. */
  at: z.iso.datetime(),
});
export type RunBrief = z.infer<typeof RunBrief>;
