/**
 * A review round's findings, structured: the code-review skill writes them as JSON beside its
 * report and hands the file to `abe factory review --findings-file <file>`; serve keeps them on
 * the round (`Review.items`). Each finding has its place (`file:line`), what is wrong, the fix and
 * its severity: `must` (the build must change it: counted in `--findings`) or `noted` (a judgement
 * call nobody holds the change for). A later round looks at the earlier round's findings again
 * (`earlier`: fixed or still open, by id).
 *
 * The run tracks them per build round (`findingRounds`): a finding is open until a later review
 * looks again; then fixed (in the build between the two) unless that review says it is still
 * open, or finds it again. Pure.
 *
 * ```json
 * { "findings": [{ "id": "F1", "axis": "standards", "file": "auth/token.ts", "line": 58,
 *                  "text": "The expiry is a bare 900000", "fix": "name it LINK_WINDOW_MS",
 *                  "severity": "must" }],
 *   "earlier": [{ "id": "F0", "fixed": true }],
 *   "risk": { "risky": true, "why": "authentication: the diff adds a sign-in path" } }
 * ```
 */
import { z } from 'zod';

/** The review's two axes: the repo's standards, and the card's spec. */
export const FINDING_AXES = ['standards', 'spec'] as const;
export type FindingAxis = (typeof FINDING_AXES)[number];

/** `must`: the build must change it to pass (counted); `noted`: a judgement call, not held. */
export const FINDING_SEVERITIES = ['must', 'noted'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const ReviewFinding = z.object({
  /** Kept across rounds by the skill (`F1`): a later round names it in `earlier`. */
  id: z.string().min(1),
  axis: z.enum(FINDING_AXES),
  /** Relative to the worktree. */
  file: z.string().min(1),
  line: z.number().int().positive().nullable().default(null),
  /** What is wrong. */
  text: z.string().min(1),
  /** The change that fixes it. */
  fix: z.string().default(''),
  severity: z.enum(FINDING_SEVERITIES).default('must'),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** An earlier round's finding looked at again: fixed, or still open. */
export const FindingAgain = z.object({ id: z.string().min(1), fixed: z.boolean() });
export type FindingAgain = z.infer<typeof FindingAgain>;

/** The review's judgement of the change's risk (`Risk: risky · authentication`). */
export const ReviewRisk = z.object({ risky: z.boolean(), why: z.string() });
export type ReviewRisk = z.infer<typeof ReviewRisk>;

/** The file `--findings-file` names. */
export const ReviewFindingsFile = z.object({
  findings: z.array(ReviewFinding).default([]),
  earlier: z.array(FindingAgain).default([]),
  risk: ReviewRisk.nullable().default(null),
});
export type ReviewFindingsFile = z.infer<typeof ReviewFindingsFile>;

/** The findings the build must fix: the count `--findings` gives. */
export const mustCount = (f: Pick<ReviewFindingsFile, 'findings'>): number =>
  f.findings.filter((x) => x.severity === 'must').length;

/** A `--findings-file`'s text held to its shape, or why not (its count `--findings` must match). */
export const findingsFileOf = (
  text: string,
  findings?: number,
): { ok: true; file: ReviewFindingsFile } | { ok: false; problem: string } => {
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not JSON' };
  }
  const read = ReviewFindingsFile.safeParse(doc);

  if (!read.success)
    return {
      ok: false,
      problem: read.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'the file'}: ${i.message}`)
        .join('; '),
    };
  const ids = read.data.findings.map((f) => f.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);

  if (twice !== undefined) return { ok: false, problem: `finding ${twice} is listed twice` };
  const must = mustCount(read.data);

  if (findings !== undefined && must !== findings)
    return {
      ok: false,
      problem: `--findings ${findings}, but the file has ${must} must finding${must === 1 ? '' : 's'}`,
    };

  return { ok: true, file: read.data };
};

// ── Per build round ────────────────────────────────────────────────────────────────────────

/** `open`: to fix (nobody looked again, or it came back); `fixed`: the next round did not find it. */
export const FINDING_STATES = ['open', 'fixed'] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/** A finding as the run tracks it: its state, and the build that fixed it. */
export const TrackedFinding = ReviewFinding.extend({
  /** Null for a noted one: nobody holds the change for it. */
  state: z.enum(FINDING_STATES).nullable(),
  /** The build visit that fixed it (2: the second build); null unless fixed. */
  fixedIn: z.number().int().positive().nullable(),
});
export type TrackedFinding = z.infer<typeof TrackedFinding>;

/** One review round as the Run page shows it. */
export const ReviewRound = z.object({
  at: z.iso.datetime(),
  /** Which review of the run (1 the first). */
  n: z.number().int().positive(),
  findings: z.number().int().nonnegative(),
  report: z.string().nullable(),
  regression: z.array(z.string()),
  risk: ReviewRisk.nullable(),
  /** Its own findings, must then noted, each with its state. */
  items: z.array(TrackedFinding),
  /** The round before's must findings, as this round found them again. */
  checked: z.array(TrackedFinding),
});
export type ReviewRound = z.infer<typeof ReviewRound>;

/** What a review keeps for this (a `Review` without the rest). */
export type ReviewKept = {
  at: string;
  findings: number;
  report: string | null;
  regression: readonly string[];
  items?: readonly ReviewFinding[] | undefined;
  earlier?: readonly FindingAgain[] | undefined;
  risk?: ReviewRisk | null | undefined;
};

/** The same finding in a later round: by id, else the same file and words. */
const same = (a: ReviewFinding, b: ReviewFinding): boolean =>
  a.id === b.id || (a.file === b.file && a.text.trim() === b.text.trim());

const ms = (at: string) => Date.parse(at);

/**
 * Every review round with its findings tracked per build round. A must finding of a round is
 * `open` until a later round looks again; that round's `earlier` says fixed or open by id, else
 * it is open when that round finds it again, fixed when not; `fixedIn` is the last build visit
 * started between the two rounds (`builds`: each build visit's start, in order).
 */
export const findingRounds = (
  reviews: readonly ReviewKept[],
  builds: readonly { startedAt: string }[],
): ReviewRound[] => {
  const trackedOf = (k: number): TrackedFinding[] => {
    const r = reviews[k];

    if (r === undefined) return [];
    const next = reviews[k + 1];
    const buildIn = (): number | null => {
      if (next === undefined) return null;
      const at = builds.findLastIndex(
        (b) => ms(b.startedAt) >= ms(r.at) && ms(b.startedAt) <= ms(next.at),
      );

      return at === -1 ? null : at + 1;
    };

    return (r.items ?? []).map((f) => {
      if (f.severity === 'noted') return { ...f, state: null, fixedIn: null };
      if (next === undefined) return { ...f, state: 'open' as const, fixedIn: null };
      const said = next.earlier?.find((e) => e.id === f.id);
      const fixed =
        said?.fixed ?? !(next.items ?? []).some((g) => g.severity === 'must' && same(f, g));

      return fixed
        ? { ...f, state: 'fixed' as const, fixedIn: buildIn() }
        : { ...f, state: 'open' as const, fixedIn: null };
    });
  };
  const tracked = reviews.map((_, k) => trackedOf(k));
  const mustFirst = (list: readonly TrackedFinding[]) => [
    ...list.filter((f) => f.severity === 'must'),
    ...list.filter((f) => f.severity === 'noted'),
  ];

  return reviews.map((r, k) => ({
    at: r.at,
    n: k + 1,
    findings: r.findings,
    report: r.report,
    regression: [...r.regression],
    risk: r.risk ?? null,
    items: mustFirst(tracked[k] ?? []),
    checked: (k === 0 ? [] : (tracked[k - 1] ?? [])).filter((f) => f.severity === 'must'),
  }));
};
