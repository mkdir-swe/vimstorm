/**
 * The Factory's pr stage and Done (ticket #48, ADRs 0008, 0009): the agent writes the pull
 * request's body with the pr skill and hands it to `abe factory pr`; `serve` checks the body,
 * pushes the branch, opens or updates the pull request with the card's link line, and from then
 * on watches it: a person merges (or `serve` does, with `autoMerge` lowered by an Override with a
 * reason, once its checks are green), and Done is the merge commit's deployment to `test`
 * succeeding. Done runs clear after the next local midnight.
 *
 * The rules here are pure: what a body must carry, the link line, what a pull request's state
 * means for the run, and what `serve` does next.
 */
import { z } from 'zod';
import { type Merged } from '../layer/settings';
import { type DeployState, PrReviewer } from '../board/tracking';
import { type BoardRef, boardCardName, isLocalBoard } from '../board/board';
import { type FactValue } from '../skills/workflow/expr';
import { type RunWorkflow } from '../skills/workflow/run';

/**
 * The environment whose deployment of the merge commit is Done, unless the run's checkout says
 * another in `factory.done` (#184).
 */
export const DONE_ENVIRONMENT = 'test';

/** `factory.done`'s value for a repo with no deploy to wait for: the merge itself is Done. */
export const MERGED_IS_DONE = 'merged';

/** How often `serve` reads a pull request or its deployment, and sweeps Done runs. */
export const PR_POLL_MS = 60_000;

/** The one line of the body that says how the change was verified. */
export const VERIFIED_LINE = '**Verified:**';
export const NOTES_HEADING = '## Notes';
export const MAX_NOTES = 5;

/** A top-level list item: `-`, `*`, `+` or a number. */
const BULLET = /^([-*+]|\d+[.)])\s/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;

/** The body's lines outside fenced code blocks: a fence may quote anything. */
const proseLines = (body: string): string[] => {
  let fenced = false;

  return body.split(/\r?\n/).filter((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;

      return false;
    }

    return !fenced;
  });
};

/**
 * What is wrong with a pull request body, one entry each, or none: exactly one line starting
 * `**Verified:**`, one `## Notes` section of at most five bullets, and for risky work a
 * verification line naming each regression test the run holds (it must hold some).
 */
export const prBodyProblems = (
  body: string,
  o: { risky: boolean; regressionTests: readonly string[] },
): string[] => {
  const lines = proseLines(body);
  const verified = lines.filter((l) => l.trimStart().startsWith(VERIFIED_LINE));
  const notesAt = lines.flatMap((l, i) => (l.trimEnd() === NOTES_HEADING ? [i] : []));
  const problems: string[] = [];

  if (verified.length === 0)
    problems.push(
      `no line starts with ${VERIFIED_LINE}: the body needs exactly one verification line`,
    );
  if (verified.length > 1)
    problems.push(`${verified.length} lines start with ${VERIFIED_LINE}: exactly one is allowed`);
  if (notesAt.length === 0) problems.push(`no ${NOTES_HEADING} section`);
  if (notesAt.length > 1) problems.push(`${notesAt.length} ${NOTES_HEADING} sections: one only`);
  const [first] = notesAt;

  if (first !== undefined) {
    const rest = lines.slice(first + 1);
    const end = rest.findIndex((l) => HEADING.test(l));
    const bullets = (end === -1 ? rest : rest.slice(0, end)).filter((l) => BULLET.test(l));

    if (bullets.length > MAX_NOTES)
      problems.push(`${NOTES_HEADING} has ${bullets.length} bullets: at most ${MAX_NOTES}`);
  }
  const [line] = verified;

  if (o.risky && verified.length === 1 && line !== undefined) {
    const named = o.regressionTests;
    const missing = named.filter((t) => !line.includes(t));

    if (missing.length > 0)
      problems.push(
        `risky work: the ${VERIFIED_LINE} line does not name its regression tests ${missing.join(', ')}`,
      );
    if (named.length === 0)
      problems.push(
        `risky work: the run names no regression tests, so the ${VERIFIED_LINE} line cannot name them`,
      );
  }

  return problems;
};

/** What the Verified line of a run whose checks ran nothing starts with (#159). */
// checks.ts's `NO_CHECKS` (an import of it here is a cycle at load), with its full stop.
const NO_CHECKS_WORDS = 'no checks configured: nothing was run';
export const NO_CHECKS_VERIFIED = `${NO_CHECKS_WORDS}.`;

/**
 * The body with its one `**Verified:**` line (outside code fences) saying first that no check
 * ran, for a run whose checkout has no check with a command (#159); unchanged when it says so.
 */
export const withNoChecksVerified = (body: string): string => {
  let fenced = false;
  let done = false;

  return body
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      if (fenced || done || !line.trimStart().startsWith(VERIFIED_LINE)) return line;
      done = true;
      if (line.includes(NO_CHECKS_WORDS)) return line;
      const at = line.indexOf(VERIFIED_LINE) + VERIFIED_LINE.length;
      const rest = line.slice(at).trim();
      const cr = line.endsWith('\r') ? '\r' : '';

      return `${line.slice(0, at)} ${NO_CHECKS_VERIFIED}${rest === '' ? '' : ` ${rest}`}${cr}`;
    })
    .join('\n');
};

/**
 * The card's link line: Azure Boards links a pull request whose body carries `AB#<id>`; a board on
 * this machine's card is named so, linking nothing.
 */
export const cardLinkLine = (card: number, board: Pick<BoardRef, 'provider'> = {}): string =>
  isLocalBoard(board)
    ? `Card: ${boardCardName(card, board)} (on this machine's board)`
    : `Card: ${boardCardName(card, board)}`;

/** The body with the card's link line at its end, unless it names the card already. */
export const withCardLine = (
  body: string,
  card: number,
  board: Pick<BoardRef, 'provider'> = {},
): string =>
  new RegExp(`(?<![\\w#-])${boardCardName(card, board)}\\b`).test(body)
    ? body
    : `${body.trimEnd()}\n\n${cardLinkLine(card, board)}\n`;

/** `AB#<n>` as GitHub reads it: a link to Azure Boards' card n. */
const AZURE_NAME = /\bAB#[1-9][0-9]*\b/g;

/**
 * A board on this machine's pull request naming an Azure card, one entry each for its title and
 * body: GitHub would link someone's Azure card. The card is named `L-<id>` instead.
 */
export const azureNamesOnThisMachine = (title: string, body: string, card: number): string[] =>
  (
    [
      ['title', title],
      ['body', proseLines(body).join('\n')],
    ] as const
  ).flatMap(([where, text]) => {
    const named = [...new Set(text.match(AZURE_NAME) ?? [])];

    return named.length === 0
      ? []
      : [
          `the ${where} names ${named.join(', ')}: this card is on this machine's board, so name it ${boardCardName(card, { provider: 'local' })} (GitHub links ${named[0]} to an Azure Boards card)`,
        ];
  });

/** A closing keyword naming an issue (`Closes #5`, `fixes o/r#5`), as GitHub reads it. */
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

/**
 * The body with a line closing the run's spec issue and slices (#200), `Closes #4, closes #5`
 * (GitHub needs the keyword before each), so the merge closes what it built: `#n` in the pull
 * request's own repo, `owner/repo#n` in another. Those the body closes already are left out;
 * none left: the body as it is.
 */
export const withClosesLine = (body: string, issues: readonly string[], repo: string): string => {
  const closed = new Set(
    [...body.matchAll(CLOSING)].map(([, r, n]) => `${(r ?? repo).toLowerCase()}#${n}`),
  );
  const named = issues
    .filter((i) => !closed.has(i.toLowerCase()))
    .map((i) => {
      const at = i.lastIndexOf('#');
      const r = i.slice(0, at);

      return r.toLowerCase() === repo.toLowerCase() ? i.slice(at) : i;
    });

  if (named.length === 0) return body;

  return `${body.trimEnd()}\n\n${named.map((n, i) => `${i === 0 ? 'Closes' : 'closes'} ${n}`).join(', ')}\n`;
};

/**
 * Why `branch` is no branch name git takes (`git check-ref-format --branch`), or undefined: no
 * leading `-` (it would read as a flag), no `..`, `@{`, `//`, space, control character or any of
 * `~^:?*[\\`; no part starting `.` or ending `.lock`; no `/` or `.` at either end; not `@`.
 */
export const branchNameProblem = (branch: string): string | undefined => {
  const bad = (why: string) => `${JSON.stringify(branch)} is no branch name: ${why}`;

  if (branch === '' || branch === '@') return bad('it names nothing');
  if (branch.startsWith('-')) return bad('it starts with -');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(branch)) return bad('space, control or ~^:?*[\\ in it');
  if (branch.includes('..') || branch.includes('@{') || branch.includes('//'))
    return bad('.., @{ or // in it');
  if (/^\/|\/$|\.$/.test(branch)) return bad('it starts or ends with /, or ends with .');
  if (branch.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')))
    return bad('a part starts with . or ends with .lock');

  return undefined;
};

/**
 * The branch a run's pull request goes into (its pr step's `into:`, ADR 0008): `fact` the text
 * fact naming it, `branch` that fact's value, null until a step reported it as text. Null: no
 * `into:`, the repo's default branch as ever.
 */
export const intoOf = (run: {
  workflow: Pick<RunWorkflow, 'steps'>;
  facts: Readonly<Record<string, FactValue>>;
}): { fact: string; branch: string | null } | null => {
  const fact = run.workflow.steps.find((s) => s.kind === 'pr')?.into ?? null;

  if (fact === null) return null;
  const value = run.facts[fact];

  return { fact, branch: typeof value === 'string' && value !== '' ? value : null };
};

/** The line a pull request into a teammate's branch opens with: fixes onto it, and their pull request. */
export const intoLine = (branch: string, theirs: number | null): string =>
  `Fixes onto \`${branch}\`${theirs === null ? '' : ` (#${theirs})`}.`;

/** The body with the `intoLine` first, unless it starts with it already. */
export const withIntoLine = (body: string, branch: string, theirs: number | null): string => {
  const line = intoLine(branch, theirs);

  return body.trimStart().startsWith(line) ? body : `${line}\n\n${body.trimStart()}`;
};

const DEPLOY_STATES = ['pending', 'success', 'failure'] as const;

/** The card's branch on origin after `serve`'s own squash merge: deleted, or kept and why. */
export const HeadBranch = z.object({ deleted: z.boolean(), why: z.string().nullable() });
export type HeadBranch = z.infer<typeof HeadBranch>;

/** The run's pull request, as `serve` last read it. */
export const RunPr = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  /** Its title as last read (`AB#102 Count each line's…`); absent when read before #135. */
  title: z.string().optional(),
  /** The branch it merges. */
  head: z.string(),
  /** The branch it merges into (`main`); empty when read before #199. */
  base: z.string().default(''),
  /** Whether GitHub can merge it (#199): `conflicting` until the branch has its base brought in. */
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']).default('unknown'),
  /** Its head commit as last read: what a squash merge took from the branch. */
  headSha: z.string().default(''),
  /** Whether `serve` merges it once its checks are green (as last read from the settings). */
  autoMerge: z.boolean(),
  state: z.enum(['open', 'closed', 'merged']),
  checks: z.enum(['none', 'pending', 'success', 'failure']),
  mergeCommit: z.string().nullable(),
  /** Why `serve`'s own merge was refused, until it merges. */
  mergeFailed: z.string().nullable(),
  /** The merge commit's newest deployment to `test`, once read. */
  deploy: z.object({ state: z.enum(DEPLOY_STATES), url: z.string().nullable() }).nullable(),
  /** Reads in a row of this head that found no checks, up to `NO_CHECKS_READS`. */
  noChecksReads: z.number().int().min(0).default(0),
  /** After `serve`'s own merge: whether it deleted the branch on origin (null: not its merge). */
  branch: HeadBranch.nullable().default(null),
  /**
   * What is Done, as last read from `factory.done` in the run's checkout (#184): the environment
   * whose deploy of the merge commit is Done, or `merged` (`MERGED_IS_DONE`).
   */
  done: z.string().min(1).default(DONE_ENVIRONMENT),
  /**
   * Since when it has waited on the person as it does now (`prWaitReason`, #187); null or absent:
   * no wait (optional, so a pull request read before #187 still parses).
   */
  waitSince: z.iso.datetime().nullable().optional(),
  /** Its reviewers and where each stands, polled with its state. */
  reviewers: z.array(PrReviewer).optional(),
  /** The body as `serve` last sent it (its link and closes lines in); absent before it was kept. */
  body: z.string().optional(),
  /** When `abe factory pr` first opened it; absent before it was kept. */
  openedAt: z.iso.datetime().optional(),
});
export type RunPr = z.infer<typeof RunPr>;

/**
 * How many reads in a row (one a minute) a head may show no checks before auto merge needs you:
 * GitHub lists a pull request's checks a few seconds after it opens or a push. The read when the
 * pull request opens is not counted, so it is the third poll after it.
 */
export const NO_CHECKS_READS = 3;

/** `noChecksReads` after a read of the pull request: one more while one head shows none. */
export const noChecksAfter = (
  pr: RunPr,
  read: { checks: RunPr['checks']; headSha: string },
): number => {
  if (read.checks !== 'none') return 0;
  if (read.headSha !== pr.headSha) return 1;

  return Math.min(NO_CHECKS_READS, pr.noChecksReads + 1);
};

/** What `abe factory pr` opened (or updated): the pull request as it is now. */
export const openedPr = (
  pr: {
    repo: string;
    number: number;
    url: string;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    mergeable: RunPr['mergeable'];
    state: RunPr['state'];
    checks: { state: RunPr['checks'] };
    mergeCommit: string | null;
  },
  autoMerge: boolean,
  done: string = DONE_ENVIRONMENT,
): RunPr => ({
  repo: pr.repo,
  number: pr.number,
  url: pr.url,
  title: pr.title,
  head: pr.head.ref,
  headSha: pr.head.sha,
  base: pr.base.ref,
  mergeable: pr.mergeable,
  autoMerge,
  state: pr.state,
  checks: pr.checks.state,
  mergeCommit: pr.mergeCommit,
  mergeFailed: null,
  deploy: null,
  noChecksReads: 0,
  waitSince: null,
  branch: null,
  done,
  reviewers: [],
});

/**
 * Why a run with its pull request open waits on the person, or null while `serve` waits on
 * GitHub (checks, a merge it makes, the deploy). `noChecks`: the run's checks ran nothing (#159).
 */
export const prWaitReason = (pr: RunPr, noChecks = false): string | null => {
  if (pr.state === 'merged')
    return pr.deploy?.state === 'failure'
      ? `the deploy to ${pr.done} failed: ${pr.deploy.url ?? 'no link'}`
      : null;
  if (pr.state === 'closed') return 'the pull request was closed without a merge';
  // #199: GitHub runs no checks on a pull request it cannot merge; the conflict is the reason.
  if (pr.mergeable === 'conflicting') return prConflictReason(pr);
  if (pr.checks === 'failure') return "the pull request's checks failed";
  // #159: no check with a command ran, so serve never merges it; the reason says why.
  if (noChecks) return 'no checks configured, nothing was run: a person reviews and merges';
  if (!pr.autoMerge) return 'merge waits for a person';
  if (pr.mergeFailed !== null) return `auto merge failed: ${pr.mergeFailed}`;
  if (pr.checks === 'none' && pr.noChecksReads >= NO_CHECKS_READS)
    return 'auto merge waits for green checks: the pull request has none';

  return null;
};

/**
 * `next`, its wait dated (#187): since `at` when a wait begins or changes, the same wait keeps its
 * start, no wait none.
 */
export const datedWait = (was: RunPr | null, next: RunPr, noChecks: boolean, at: string): RunPr => {
  const waits = prWaitReason(next, noChecks);

  if (waits === null) return { ...next, waitSince: null };
  const since = was?.waitSince ?? null;
  const kept = was !== null && since !== null && prWaitReason(was, noChecks) === waits;

  return { ...next, waitSince: kept ? since : at };
};

/** `PR #7 conflicts with main: bring the branch up to date`, the run's Needs you while it does (#199). */
export const prConflictReason = (pr: Pick<RunPr, 'number' | 'base'>): string =>
  `PR #${pr.number} conflicts with ${pr.base === '' ? 'its base' : pr.base}: bring the branch up to date`;

/**
 * What a read of the pull request says of its mergeability (#199). GitHub answers `unknown` while
 * it works it out again (its base moved); at the same head the last answer stands, so a conflict
 * is neither forgotten nor told twice.
 */
export const seenMergeable = (
  pr: Pick<RunPr, 'mergeable' | 'headSha'>,
  read: { mergeable: RunPr['mergeable']; headSha: string },
): RunPr['mergeable'] =>
  read.mergeable === 'unknown' && read.headSha === pr.headSha ? pr.mergeable : read.mergeable;

/**
 * Whether a read of the pull request newly shows it conflicting (#199): it was not, or its head
 * moved since and still conflicts. Then the run's session is told (`prConflictPrompt`), once.
 */
export const newlyConflicting = (
  pr: Pick<RunPr, 'mergeable' | 'headSha'>,
  read: { mergeable: RunPr['mergeable']; headSha: string },
): boolean =>
  read.mergeable === 'conflicting' &&
  (pr.mergeable !== 'conflicting' || pr.headSha !== read.headSha);

/**
 * What the run's session is told when its pull request conflicts (#199): bring the base in with
 * a merge (serve's push is never forced, so no rebase), the checks again, then `abe factory pr`
 * pushes it. `fetched`: whether serve fetched origin just now, so `origin/<base>` is current.
 */
export const prConflictPrompt = (
  pr: Pick<RunPr, 'number' | 'url' | 'base'>,
  fetched: boolean,
): string => {
  const base = pr.base === '' ? 'main' : pr.base;

  return [
    `Your pull request #${pr.number} (${pr.url}) conflicts with ${base}, so GitHub runs no checks on it and cannot merge it.`,
    `${fetched ? `origin is fetched: merge origin/${base} into your branch` : `Fetch origin and merge origin/${base} into your branch`} (git merge origin/${base}; not a rebase: the push is never forced), resolve the conflicts keeping both sides' intent, commit, run the checks, then run abe factory pr again with the same body file to push it.`,
  ].join(' ');
};

/**
 * Whether `serve` merges a run's pull request itself: `autoMerge` on in the settings of the
 * run's checkout (never its worktree, which the agent writes) and lowered there by an Override
 * with a reason. By default a person merges.
 */
export const autoMergeOf = (merged: Merged): boolean =>
  merged.values.autoMerge && merged.explain('autoMerge').lowered !== null;

/** What a read of the pull request changes on the run. */
const SEEN = [
  'title',
  'state',
  'base',
  'mergeable',
  'checks',
  'mergeCommit',
  'autoMerge',
  'mergeFailed',
  'headSha',
  'noChecksReads',
  'branch',
  'done',
  'reviewers',
] as const;
export type PrSeen = Pick<RunPr, (typeof SEEN)[number]>;

/** What the run keeps of its pull request as a read would see it: a read again with nothing new. */
export const seenOf = (pr: RunPr): PrSeen => ({
  state: pr.state,
  base: pr.base,
  mergeable: pr.mergeable,
  checks: pr.checks,
  mergeCommit: pr.mergeCommit,
  autoMerge: pr.autoMerge,
  mergeFailed: pr.mergeFailed,
  headSha: pr.headSha,
  noChecksReads: pr.noChecksReads,
  branch: pr.branch,
  done: pr.done,
  reviewers: pr.reviewers,
});

/** Whether a read changes nothing the run keeps. */
export const sameSeen = (pr: RunPr, seen: PrSeen): boolean =>
  SEEN.every((k) => JSON.stringify(pr[k]) === JSON.stringify(seen[k]));

/**
 * Why `serve`'s squash merge keeps the card's branch on origin, or null to delete it: only when
 * the run's worktree holds nothing past the head it merges (`workKept`; gone counts as nothing),
 * so work nobody pushed still has its branch to go to. `undefined`: git could not say.
 */
export const branchKept = (
  work: { uncommitted: number; unpushed: number; head: string } | null | undefined,
  mergedHead: string,
): string | null => {
  if (work === undefined) return 'git could not read the worktree';
  if (work === null) return null;
  const kept = workKept(work, mergedHead);

  return kept === null ? null : `the worktree holds work: ${kept}`;
};

/** A deployment's state as Done reads it: no deployment yet is pending. */
export const deployStateOf = (state: DeployState): 'pending' | 'success' | 'failure' =>
  state === 'none' ? 'pending' : state;

/**
 * What `serve` does next for a run's pull request: read it, read the merge commit's deploy, or
 * nothing more once merged where the merge is Done (`MERGED_IS_DONE`).
 */
export const prNext = (pr: RunPr): 'show' | 'deploy' | 'done' => {
  if (pr.state !== 'merged' || pr.mergeCommit === null) return 'show';

  return pr.done === MERGED_IS_DONE ? 'done' : 'deploy';
};

/** Whether the run is Done at its merge: merged, where the merge is Done. */
export const doneAtMerge = (pr: Pick<RunPr, 'state' | 'done'>): boolean =>
  pr.state === 'merged' && pr.done === MERGED_IS_DONE;

/** Whether `serve` merges it now: auto merge on, open, not a draft, checks green, no conflict. */
export const mergesNow = (
  pr: RunPr,
  seen: { draft: boolean; mergeable: 'mergeable' | 'conflicting' | 'unknown' },
): boolean =>
  pr.autoMerge &&
  pr.state === 'open' &&
  pr.checks === 'success' &&
  !seen.draft &&
  seen.mergeable !== 'conflicting';

/** What a run keeps of the pull request's summary in `abe factory status`. */
export const FactoryPrData = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  /** Its title as last read; absent when read before #135. */
  title: z.string().optional(),
  state: z.enum(['open', 'closed', 'merged']),
  merge: z.enum(['person', 'auto']),
  /** Its head's checks, as last read. */
  checks: z.enum(['none', 'pending', 'success', 'failure']).default('none'),
  mergeCommit: z.string().nullable(),
  deploy: z.enum(DEPLOY_STATES).nullable(),
  /** After `serve`'s own merge: its branch on origin deleted, or kept and why. */
  branch: HeadBranch.nullable(),
  /** What is Done (#184): the environment whose deploy is waited for (absent: test), or `merged`. */
  done: z.string().optional(),
  /** The branch it merges and the one it merges into, its head commit; empty when not read. */
  head: z.string().optional(),
  base: z.string().optional(),
  headSha: z.string().optional(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']).optional(),
  /** Why `serve`'s own merge was refused, until it merges. */
  mergeFailed: z.string().nullable().optional(),
  reviewers: z.array(PrReviewer).optional(),
  /** The body as sent; absent when not kept. */
  body: z.string().optional(),
  openedAt: z.iso.datetime().optional(),
});
export type FactoryPrData = z.infer<typeof FactoryPrData>;

export const prData = (pr: RunPr): FactoryPrData => ({
  repo: pr.repo,
  number: pr.number,
  url: pr.url,
  ...(pr.title === undefined ? {} : { title: pr.title }),
  state: pr.state,
  merge: pr.autoMerge ? 'auto' : 'person',
  checks: pr.checks,
  mergeCommit: pr.mergeCommit,
  deploy: pr.deploy?.state ?? null,
  branch: pr.branch,
  done: pr.done,
  head: pr.head,
  base: pr.base,
  headSha: pr.headSha,
  mergeable: pr.mergeable,
  mergeFailed: pr.mergeFailed,
  reviewers: pr.reviewers ?? [],
  ...(pr.body === undefined ? {} : { body: pr.body }),
  ...(pr.openedAt === undefined ? {} : { openedAt: pr.openedAt }),
});

const MERGE_WORDS: Readonly<Record<FactoryPrData['merge'], string>> = {
  person: 'a person merges',
  auto: 'auto merge',
};

const branchText = (b: HeadBranch | null) => {
  if (b === null) return null;

  return b.deleted ? 'branch deleted' : `branch kept${b.why === null ? '' : `: ${b.why}`}`;
};

export const prLine = (pr: FactoryPrData): string =>
  [
    pr.url,
    pr.state,
    pr.state === 'open' ? MERGE_WORDS[pr.merge] : null,
    pr.deploy === null ? null : `deploy to ${pr.done ?? DONE_ENVIRONMENT} ${pr.deploy}`,
    branchText(pr.branch),
  ]
    .filter((p) => p !== null)
    .join(' · ');

/** How a Done run was cleared: its worktree removed, or kept because it holds work. */
export const Clearing = z.object({
  at: z.iso.datetime(),
  worktree: z.enum(['removed', 'kept', 'gone']),
  /** What kept it: uncommitted changes, unpushed commits. */
  why: z.string().nullable(),
});
export type Clearing = z.infer<typeof Clearing>;

/**
 * Why a worktree is kept when its card clears, or null when nothing would be lost. Commits on no
 * remote are work, unless the worktree's head is the head its pull request merged (a squash
 * merge, its branch deleted on GitHub since).
 */
export const workKept = (
  work: { uncommitted: number; unpushed: number; head: string },
  merged?: string,
): string | null => {
  const unpushed =
    merged !== undefined && merged !== '' && work.head === merged ? 0 : work.unpushed;
  const parts = [
    work.uncommitted > 0 ? `${work.uncommitted} uncommitted` : null,
    unpushed > 0 ? `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}` : null,
  ].filter((p) => p !== null);

  return parts.length === 0 ? null : parts.join(', ');
};
