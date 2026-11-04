/**
 * A GitHub board (`board.provider: github`): the repo's issues as cards, pure. An issue's state and
 * two labels give the Board's columns (New, Active, Resolved, Closed); `bug` makes it a Bug; its
 * body's `## Acceptance criteria` heading splits off the criteria. The IO is `ports`'
 * `github/board.ts`, through `gh`.
 */
import { boardProviderOf } from './board-provider';
import { githubRepoOf } from './tracking';

/** The labels an open issue's column is read from and written as: none is New. */
export const GITHUB_STATE_LABELS = { Active: 'active', Resolved: 'resolved' } as const;

/** The states a GitHub board's card can be moved to, the Board's columns and Removed. */
export const GITHUB_STATES = ['New', 'Active', 'Resolved', 'Closed', 'Removed'] as const;
export type GithubState = (typeof GITHUB_STATES)[number];

/** The label that makes an issue a Bug, and the one a new Bug gets. */
export const GITHUB_BUG_LABEL = 'bug';

const lower = (labels: readonly string[]) => labels.map((l) => l.toLowerCase());

/** Whether a label is one a column is read from (`active`, `resolved`). */
export const isStateLabel = (label: string): boolean =>
  Object.values(GITHUB_STATE_LABELS).some((l) => l === label.toLowerCase());

/**
 * An issue's state on the Board: closed as completed is Closed, closed as not planned (or a
 * duplicate) Removed; open, `resolved` Resolved, `active` Active, else New.
 */
export const githubCardState = (issue: {
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: readonly string[];
}): GithubState => {
  if (issue.state === 'closed')
    return issue.stateReason === 'not_planned' || issue.stateReason === 'duplicate'
      ? 'Removed'
      : 'Closed';
  const has = lower(issue.labels);

  if (has.includes(GITHUB_STATE_LABELS.Resolved)) return 'Resolved';

  return has.includes(GITHUB_STATE_LABELS.Active) ? 'Active' : 'New';
};

/** A card's tags: the issue's labels less the ones its column is read from. */
export const githubCardTags = (labels: readonly string[]): string[] =>
  labels.filter((l) => !isStateLabel(l));

/** A card's type: Bug when the issue is labelled `bug`, else Issue. */
export const githubCardType = (labels: readonly string[]): string =>
  lower(labels).includes(GITHUB_BUG_LABEL) ? 'Bug' : 'Issue';

/** A state as typed (any case; Done reads as Closed), or undefined for none of a GitHub board's. */
export const githubStateOf = (typed: string): GithubState | undefined => {
  const t = typed.trim().toLowerCase();

  return t === 'done' ? 'Closed' : GITHUB_STATES.find((s) => s.toLowerCase() === t);
};

/** What an issue is written as for a state: open or closed (and why), its labels. */
export type IssueStateWrite = {
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | 'reopened' | null;
  labels: string[];
};

/**
 * The write that puts an issue with `labels` in `state`: its column's label on (the other's
 * off), opened again when it was closed, closed as completed (Closed) or not planned (Removed)
 * with no column label left.
 */
export const githubStateWrite = (
  to: GithubState,
  now: { state: 'open' | 'closed'; labels: readonly string[] },
): IssueStateWrite => {
  const tags = githubCardTags(now.labels);

  if (to === 'Closed' || to === 'Removed')
    return {
      state: 'closed',
      stateReason: to === 'Closed' ? 'completed' : 'not_planned',
      labels: tags,
    };
  const label = to === 'New' ? [] : [GITHUB_STATE_LABELS[to]];

  return {
    state: 'open',
    stateReason: now.state === 'closed' ? 'reopened' : null,
    labels: [...tags, ...label],
  };
};

const CRITERIA = /^#{1,6}[ \t]*Acceptance criteria[ \t]*:?[ \t]*$/im;

/** An issue's body as a card's long fields: the text above its `## Acceptance criteria`, and below. */
export const splitIssueBody = (
  body: string | null,
): { description: string; acceptanceCriteria: string } => {
  const text = body ?? '';
  const m = CRITERIA.exec(text);

  if (m === null) return { description: text.trim(), acceptanceCriteria: '' };

  return {
    description: text.slice(0, m.index).trim(),
    acceptanceCriteria: text.slice(m.index + m[0].length).trim(),
  };
};

/** A card's long fields as one issue body, the criteria under their own heading. */
export const issueBody = (f: { description: string; acceptanceCriteria: string }): string => {
  const criteria = f.acceptanceCriteria.trim();
  const description = f.description.trim();

  if (criteria === '') return description;

  return `${description === '' ? '' : `${description}\n\n`}## Acceptance criteria\n\n${criteria}\n`;
};

/**
 * The `board` setting with what a GitHub board reads at a checkout filled in: its repo from origin
 * (unless `board.repo` names one; `origin` read only then) and the checkout's gh login
 * (`logins.gh`). Any other board, as it is.
 */
export const githubBoardFilled = <B extends Readonly<Record<string, unknown>>>(
  board: B,
  at: { origin: () => string | undefined; githubAccount: string | null },
): B => {
  if (boardProviderOf(board.provider) !== 'github') return board;
  const url = board.repo === undefined ? at.origin() : undefined;
  const repo = url === undefined ? undefined : githubRepoOf(url);

  return {
    ...board,
    ...(repo === undefined ? {} : { repo }),
    ...(at.githubAccount === null ? {} : { githubAccount: at.githubAccount }),
  };
};
