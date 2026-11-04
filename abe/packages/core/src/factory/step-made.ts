/**
 * What a step made, as its own skill wrote it down (the Run page's Made side): the build's lanes,
 * one per writer (its ticket, worktree, commits, tests run and time), and to-tickets' tickets with
 * their original data and the spec lines each came from. Never parsed from a transcript: the skill
 * writes a JSON file and hands it to `abe factory stage-done <step> --made <file>`; serve holds it
 * to this shape (`stepMadeOf`) and keeps it on the run (`Run.made`), at the time it was handed.
 *
 * ```json
 * { "kind": "build",
 *   "lanes": [{ "ticket": "T1", "ref": "#41", "title": "Sign-in tokens", "wave": 1,
 *               "worktree": "4-t1", "commits": [{ "sha": "a1f20c3", "subject": "Sign-in tokens" }],
 *               "files": { "count": 3, "added": 118, "removed": 0 }, "areas": ["auth/token"],
 *               "tests": [{ "name": "typecheck", "ok": true }], "tookMs": 240000 }],
 *   "milestones": [{ "n": 1, "afterWave": 2, "text": "A visitor signs in", "tests": [] }] }
 * ```
 */
import { z } from 'zod';

/** A commit as `git log --format='%h %s'` says it. */
export const MadeCommit = z.object({
  sha: z.string().min(4),
  subject: z.string(),
});
export type MadeCommit = z.infer<typeof MadeCommit>;

/** A test or check a writer ran: its name (`typecheck`, `cart/total.spec.ts`), green or not. */
export const MadeTest = z.object({
  name: z.string().min(1),
  ok: z.boolean(),
  /** Tests run, when it said (`6`). */
  count: z.number().int().nonnegative().nullable().default(null),
});
export type MadeTest = z.infer<typeof MadeTest>;

/** One writer's lane: a ticket (or a slice of the card, or a round of fixes) built in one worktree. */
export const BuildLane = z.object({
  /** The ticket's id in `tickets.md` (`T1`); null for a slice or a round of fixes. */
  ticket: z.string().nullable().default(null),
  /** Its reference (`#41`, `AB#12`); null when it has none. */
  ref: z.string().nullable().default(null),
  /** `slice 1`, `findings 1–2`, `lint`: what the lane is, when it is no ticket. */
  label: z.string().default(''),
  title: z.string().min(1),
  wave: z.number().int().positive().default(1),
  writer: z.string().default('abe:writer'),
  /** Its worktree's folder name (`4-t1`); null: it worked on the card branch itself. */
  worktree: z.string().nullable().default(null),
  commits: z.array(MadeCommit).default([]),
  files: z
    .object({
      count: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  areas: z.array(z.string()).default([]),
  tests: z.array(MadeTest).default([]),
  tookMs: z.number().int().nonnegative().nullable().default(null),
  /** Merged into the card branch; false: it failed, or still runs. */
  merged: z.boolean().default(true),
});
export type BuildLane = z.infer<typeof BuildLane>;

/** Where the heavy testing ran: after a wave, what then works, the full suite's result. */
export const BuildMilestone = z.object({
  n: z.number().int().positive(),
  afterWave: z.number().int().positive(),
  text: z.string(),
  tests: z.array(MadeTest).default([]),
  /** What the app showed when it was looked at (`sign-in → check email → open link`); null: not. */
  looked: z.string().nullable().default(null),
});
export type BuildMilestone = z.infer<typeof BuildMilestone>;

/** A spec line a ticket comes from: `story-1`, `decision-4`, `criterion-2`. */
export const SPEC_LINE = /^(story|decision|criterion)-([1-9][0-9]*)$/;

/** One ticket, with its original data as to-tickets wrote it. */
export const MadeTicket = z.object({
  /** `T1`, the build's map's id. */
  id: z.string().min(1),
  /** Where it was published (`#41`, `AB#12`, `.abe/specs/4/tickets/01-tokens.md`); null: not. */
  ref: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  title: z.string().min(1),
  /** What to build, in the user's words. */
  what: z.string().default(''),
  area: z.array(z.string()).default([]),
  criteria: z.array(z.string()).default([]),
  /** The tickets it waits for, by id. */
  blockedBy: z.array(z.string()).default([]),
  wave: z.number().int().positive().default(1),
  milestone: z.number().int().positive().nullable().default(null),
  /** Its writer may hand parts on. */
  big: z.boolean().default(false),
  /** The spec lines it comes from (`story-1`, `decision-4`, `criterion-2`). */
  from: z.array(z.string().regex(SPEC_LINE)).default([]),
});
export type MadeTicket = z.infer<typeof MadeTicket>;

export const StepMade = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('build'),
    lanes: z.array(BuildLane),
    milestones: z.array(BuildMilestone).default([]),
  }),
  z.object({
    kind: z.literal('tickets'),
    /** Where they went, as `spec.where` said. */
    where: z.enum(['issue', 'card', 'file']).default('issue'),
    /** The spec they slice (`demo-shop#40`); null when it has no reference. */
    parent: z.string().nullable().default(null),
    tickets: z.array(MadeTicket),
    milestones: z.array(z.object({ n: z.number().int().positive(), text: z.string() })).default([]),
  }),
]);
export type StepMade = z.infer<typeof StepMade>;

/** What a step made, as the run keeps it: the step by its name, when it was handed. */
export const MadeKept = z.object({
  step: z.string(),
  at: z.iso.datetime(),
  made: StepMade,
});
export type MadeKept = z.infer<typeof MadeKept>;

/** A `--made` file's text read and held to `StepMade`, or why it does not hold. */
export const stepMadeOf = (
  text: string,
): { ok: true; made: StepMade } | { ok: false; problem: string } => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not JSON' };
  }
  const made = StepMade.safeParse(doc);

  if (!made.success)
    return {
      ok: false,
      problem: made.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'the file'}: ${i.message}`)
        .join('; '),
    };

  return { ok: true, made: made.data };
};
