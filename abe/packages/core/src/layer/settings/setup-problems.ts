/**
 * The setup a new user gets wrong, as Problems (#158): no board for the repo, and
 * `serve.target: cloud` with no AWS profile or region to reach boxes on. Each with its fix, typed
 * into the fix strip.
 */
import { type SettingKey } from './keys';
import { homeRowOf, pageOf, type PageId } from './pages';
import { type ProblemWay, type SettingsProblem } from './problems';

/** What `settings problems` found of the setup, beside the merge. */
export type SetupFacts = {
  /** Why the merged `board` names no board (`boardOf`'s message); `null` when it names one. */
  board: string | null;
  /**
   * `serve.target` in force and the AWS profile and region boxes are reached on (`undefined`: not
   * checked, a box's own serve).
   */
  cloud?: { target: string; profile: string | null; region: string | null };
};

export const SETUP_PROBLEM_CODES = ['no-board', 'no-aws'] as const;
type SetupCode = (typeof SETUP_PROBLEM_CODES)[number];

/** Where a key's row is (its page and label), as the where-lines and the open ways name it. */
const rowOf = (
  key: SettingKey,
  fallback: PageId,
): { page: PageId; label: string; open: ProblemWay } => {
  const row = homeRowOf(key);

  return {
    page: row?.page ?? fallback,
    label: row?.label ?? key,
    open: { kind: 'open', page: row?.page ?? fallback, row: row?.id ?? null },
  };
};

const problem = (
  code: SetupCode,
  text: string,
  key: SettingKey,
  fallback: PageId,
  file: string,
  way?: ProblemWay,
): SettingsProblem => {
  const row = rowOf(key, fallback);

  return {
    kind: 'setup',
    code,
    text,
    where: `${pageOf(row.page).label} › ${row.label} · ${file}`,
    page: row.page,
    way: way ?? row.open,
  };
};

const fix = (command: string): ProblemWay => ({ kind: 'fix', command });

/** Every setup problem: the repo's board, then the cloud. */
export const setupProblems = (f: SetupFacts): SettingsProblem[] => {
  const out: SettingsProblem[] = [];

  if (f.board !== null)
    out.push(
      problem('no-board', `no board for this repo: ${f.board}`, 'board', 'board-team', 'abe.yaml'),
    );
  const c = f.cloud;

  if (c?.target === 'cloud' && (c.profile === null || c.region === null)) {
    const lacking = [
      ...(c.profile === null ? ['no AWS profile'] : []),
      ...(c.region === null ? ['no AWS region'] : []),
    ].join(' and ');

    out.push(
      problem(
        'no-aws',
        `serve.target is cloud but there is ${lacking}, so boxes can't be reached — name the AWS profile of your boxes' account: abe settings set box.profile <profile> (and box.region), then abe serve stop so serve starts on it, or run locally`,
        'box.profile',
        'boxes-cloud',
        'yours',
        fix('abe settings set serve.target local'),
      ),
    );
  }

  return out;
};
