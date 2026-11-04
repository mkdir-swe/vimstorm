/**
 * The Board: cards on Azure DevOps Boards, read and written as the person (`az`'s login), a board
 * On this Mac, or the repo's GitHub Issues (`gh`'s login, `github-board.ts`). Which board comes from the merged `board` setting (the repo's). The results every
 * client reads, the port's error codes, and the rules: the board setting, card ids, tags, the
 * WIQL of a board's cards.
 */
import { z } from 'zod';
import { DONE_STATES, OVER_STATES } from './prototype-tag';
import {
  boardProviderOf,
  NO_CARDS_YET,
  noCardsProviderOf,
  providerRefusal,
} from './board-provider';
import { localNumber } from '../local-mode/local-names';

/** What a failed Board call means: the error code a client reads, with Azure DevOps' message. */
export const BOARD_ERRORS = [
  /** No board in the settings, or one missing its organization, project or team. */
  'no-board',
  /** A board setting Abe will not use (an organization that is not Azure DevOps). */
  'bad-board',
  'not-found',
  /** No token from `az`, or Azure DevOps refused it after one renewal. */
  'auth',
  /** The card changed meanwhile (its revision moved). */
  'conflict',
  /** Azure DevOps refused the write itself: a state the card's type does not have, a rule. */
  'rejected',
  /** Azure DevOps could not be reached. */
  'offline',
  'ado-failed',
  /** The board has nothing like it: a GitHub board's sprints, image reads or attachments. */
  'unsupported',
  /** `gh` failed on a GitHub board, with its message. */
  'gh-failed',
] as const;
export type BoardErrorCode = (typeof BOARD_ERRORS)[number];
export type BoardError = { code: BoardErrorCode; message: string };

/** What a Board call answers: its data or why it could not. */
export type Boarded<T> = { ok: true; data: T } | { ok: false; error: BoardError };

/**
 * The board a command works on, from the settings. `organization` is `https://dev.azure.com/<org>`;
 * a board on this Mac (`provider: 'local'`) has `LOCAL_BOARD_ORG` there and lives in Abe's state.
 */
export type BoardRef = {
  /**
   * `local`: the board On this Mac (`board.provider: local`); `github`: the repo's GitHub Issues
   * (`organization` is `https://github.com/<owner>`, `project` the repo `<owner>/<name>`, `team`
   * `Issues`); absent: Azure Boards.
   */
  provider?: 'local' | 'github' | undefined;
  /** A GitHub board's repo, `<owner>/<name>` (`board.repo`, else the checkout's origin). */
  repo?: string;
  /** The gh login a GitHub board is read and written as there (`logins.gh`); none: gh's active one. */
  githubAccount?: string;
  organization: string;
  project: string;
  team: string;
  /** The work item types that are cards. */
  types: readonly string[];
  /**
   * Your az login folder in force where the board was read (`board.azureConfigDir`, yours or
   * yours for that checkout, ADR 0025): its cards are read with that login. None: az's own.
   */
  azureConfigDir?: string;
  /**
   * Which cards of a shared board are this repo's (`board.area`, `board.tag`): the cards under
   * this area path (or any of these), and the ones carrying this tag. A list reads only those.
   */
  area?: string | readonly string[];
  tag?: string;
  /**
   * The cards a repo leaves out of every list (`board.excludeLanes`, `board.notTag`): those in
   * these swimlanes (`System.BoardLane`, the lane on the board of the team owning the card's area
   * path; a card in the default lane, which has none, stays), and those carrying this tag.
   */
  excludeLanes?: readonly string[];
  notTag?: string;
};

/** Cards on a board unless `board.types` says otherwise (the Agile process's). */
export const DEFAULT_CARD_TYPES = ['User Story', 'Bug'];

const ORG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * An organization URL as `https://dev.azure.com/<org>` (`https://<org>.visualstudio.com` too), or
 * `undefined` for anything else: the person's `az` token is sent to Azure DevOps only, whatever a
 * Layer's file says.
 */
export const organizationOf = (text: string): string | undefined => {
  const m =
    /^https:\/\/dev\.azure\.com\/([^/?#]+)\/?$/i.exec(text) ??
    /^https:\/\/([^./?#]+)\.visualstudio\.com\/?$/i.exec(text);
  const org = m?.[1];

  return org !== undefined && ORG_NAME.test(org) ? `https://dev.azure.com/${org}` : undefined;
};

const Text = z.string().min(1);

/** The `board.provider` of a board kept on this Mac only: its cards never leave it. */
export const LOCAL_BOARD = 'local';
/** What a board On this Mac has for its organization. */
export const LOCAL_BOARD_ORG = 'this machine';
/** How a screen names it. */
export const LOCAL_BOARD_WORDS = 'On this machine';
/** Its name when the setting gives no project. */
const LOCAL_BOARD_NAME = 'Board';

/** A board On this Mac: its cards, states, comments and new cards are Abe's, on this Mac. */
export const isLocalBoard = (b: Pick<BoardRef, 'provider'>): boolean => b.provider === LOCAL_BOARD;

/** The `board.provider` of the repo's GitHub Issues as its board. */
export const GITHUB_BOARD = 'github';
/** What a GitHub board has for its team: the repo's issues are one board. */
export const GITHUB_BOARD_TEAM = 'Issues';
/** A GitHub board's card types: an issue, a Bug when labelled `bug` (`githubCardType`). */
export const GITHUB_CARD_TYPES = ['Issue', 'Bug'];

/** The repo's GitHub Issues: cards are its issues, read and written with `gh`. */
export const isGithubBoard = (b: Pick<BoardRef, 'provider'>): boolean =>
  b.provider === GITHUB_BOARD;

/**
 * The states a Factory run moves its card to: when it starts building, at Done, and back to New
 * when a person abandons it (#184).
 */
export type BoardColumns = { active: string; done: string; new: string };

/** The Agile process's (and the fake Azure DevOps'): New → Active → Resolved → Closed. */
export const DEFAULT_COLUMNS: BoardColumns = { active: 'Active', done: 'Closed', new: 'New' };

const Column = z.string().trim().min(1);

/** `board.active` and `board.done` in the merged board setting, each else its default. */
export const boardColumnsOf = (setting: unknown): BoardColumns => {
  const s = z
    .looseObject({
      active: z.unknown().optional(),
      done: z.unknown().optional(),
      new: z.unknown().optional(),
    })
    .safeParse(setting);
  const named = (value: unknown, fallback: string) => {
    const c = Column.safeParse(value);

    return c.success ? c.data : fallback;
  };

  return s.success
    ? {
        active: named(s.data.active, DEFAULT_COLUMNS.active),
        done: named(s.data.done, DEFAULT_COLUMNS.done),
        new: named(s.data.new, DEFAULT_COLUMNS.new),
      }
    : DEFAULT_COLUMNS;
};

/** The board setting's keys the Board reads; others (columns) belong to other readers. */
const BoardSetting = z.looseObject({
  provider: z.unknown().optional(),
  organization: z.unknown().optional(),
  project: z.unknown().optional(),
  team: z.unknown().optional(),
  types: z.unknown().optional(),
  area: z.unknown().optional(),
  tag: z.unknown().optional(),
  excludeLanes: z.unknown().optional(),
  notTag: z.unknown().optional(),
  repo: z.unknown().optional(),
  githubAccount: z.unknown().optional(),
});

const refuse = (code: BoardErrorCode, message: string) =>
  ({ ok: false, error: { code, message } }) as const;

/** The merged `board` setting as a board, or why it is none. */
export const boardOf = (
  setting: unknown,
): { ok: true; board: BoardRef } | { ok: false; error: BoardError } => {
  const s = BoardSetting.safeParse(setting);
  const b = s.success ? s.data : {};
  const missing = (['organization', 'project', 'team'] as const).filter(
    (k) => b[k] === undefined || b[k] === null || b[k] === '',
  );

  const provider = b.provider === undefined ? undefined : boardProviderOf(b.provider);

  const noCards = noCardsProviderOf(b.provider);

  if (noCards !== undefined)
    return refuse(
      'bad-board',
      `board.provider ${JSON.stringify(b.provider)}: ${NO_CARDS_YET(noCards)}`,
    );
  if (b.provider !== undefined && provider === undefined)
    return refuse('bad-board', `board.provider ${providerRefusal(b.provider)}`);
  if (provider === LOCAL_BOARD) {
    const named = Text.safeParse(b.project);
    const project = named.success ? named.data : LOCAL_BOARD_NAME;
    const team = Text.safeParse(b.team);
    const types = z.array(Text).min(1).optional().safeParse(b.types);

    if (!types.success) return refuse('bad-board', 'board.types is not a list of card types');

    return {
      ok: true,
      board: {
        provider: LOCAL_BOARD,
        organization: LOCAL_BOARD_ORG,
        project,
        team: team.success ? team.data : project,
        types: types.data ?? DEFAULT_CARD_TYPES,
      },
    };
  }
  if (provider === GITHUB_BOARD) return githubBoardOf(b);
  if (missing.length === 3)
    return refuse(
      'no-board',
      'no board in the settings: set board (organization, project and team) in abe.yaml',
    );
  if (missing.length > 0)
    return refuse(
      'no-board',
      `the board setting has no ${missing.map((k) => `board.${k}`).join(', ')}`,
    );
  const organization =
    typeof b.organization === 'string' ? organizationOf(b.organization) : undefined;

  if (organization === undefined)
    return refuse(
      'bad-board',
      `board.organization ${JSON.stringify(b.organization)} is not https://dev.azure.com/<org>`,
    );
  const project = Text.safeParse(b.project);
  const team = Text.safeParse(b.team);
  const types = z.array(Text).min(1).optional().safeParse(b.types);

  if (!project.success) return refuse('bad-board', 'board.project is not a name');
  if (!team.success) return refuse('bad-board', 'board.team is not a name');
  if (!types.success) return refuse('bad-board', 'board.types is not a list of work item types');

  const az = Text.safeParse(b.azureConfigDir);
  const area =
    b.area === undefined ? undefined : z.union([Text, z.array(Text).min(1)]).safeParse(b.area);
  const tag = b.tag === undefined ? undefined : Text.safeParse(b.tag);
  const lanes =
    b.excludeLanes === undefined
      ? undefined
      : z.union([Text.transform((l) => [l]), z.array(Text).min(1)]).safeParse(b.excludeLanes);
  const notTag = b.notTag === undefined ? undefined : Text.safeParse(b.notTag);

  if (area !== undefined && !area.success)
    return refuse('bad-board', 'board.area is not an area path, or a list of them');
  if (tag !== undefined && !tag.success) return refuse('bad-board', 'board.tag is not a tag');
  if (lanes !== undefined && !lanes.success)
    return refuse('bad-board', 'board.excludeLanes is not a swimlane, or a list of them');
  if (notTag !== undefined && !notTag.success)
    return refuse('bad-board', 'board.notTag is not a tag');

  return {
    ok: true,
    board: {
      organization,
      project: project.data,
      team: team.data,
      types: types.data ?? DEFAULT_CARD_TYPES,
      ...(az.success ? { azureConfigDir: az.data } : {}),
      ...(area?.success === true ? { area: area.data } : {}),
      ...(tag?.success === true ? { tag: tag.data } : {}),
      ...(lanes?.success === true ? { excludeLanes: lanes.data } : {}),
      ...(notTag?.success === true ? { notTag: notTag.data } : {}),
    },
  };
};

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/**
 * A GitHub board from its setting: `repo` (the settings fill in origin's), its types, `tag` and
 * `notTag` (labels). An area or swimlanes are Azure's: refused, never left unread.
 */
const githubBoardOf = (
  b: z.infer<typeof BoardSetting>,
): { ok: true; board: BoardRef } | { ok: false; error: BoardError } => {
  const repo = Text.safeParse(b.repo);

  if (!repo.success)
    return refuse(
      'no-board',
      "board.provider github: no repo; the checkout's origin is not on GitHub: set board.repo to <owner>/<name>",
    );
  if (!REPO_NAME.test(repo.data))
    return refuse('bad-board', `board.repo ${JSON.stringify(b.repo)} is not <owner>/<name>`);
  const types = z.array(Text).min(1).optional().safeParse(b.types);
  const tag = b.tag === undefined ? undefined : Text.safeParse(b.tag);
  const notTag = b.notTag === undefined ? undefined : Text.safeParse(b.notTag);
  const account = Text.safeParse(b.githubAccount);
  const azureOnly = (['area', 'excludeLanes'] as const).filter((k) => b[k] !== undefined);

  if (!types.success) return refuse('bad-board', 'board.types is not a list of card types');
  if (azureOnly.length > 0)
    return refuse(
      'bad-board',
      `${azureOnly.map((k) => `board.${k}`).join(' and ')}: Azure Boards only; a GitHub board takes tag and notTag (labels)`,
    );
  if (tag !== undefined && !tag.success) return refuse('bad-board', 'board.tag is not a label');
  if (notTag !== undefined && !notTag.success)
    return refuse('bad-board', 'board.notTag is not a label');
  const [owner = ''] = repo.data.split('/');

  return {
    ok: true,
    board: {
      provider: GITHUB_BOARD,
      repo: repo.data,
      organization: `https://github.com/${owner}`,
      project: repo.data,
      team: GITHUB_BOARD_TEAM,
      types: types.data ?? GITHUB_CARD_TYPES,
      ...(account.success ? { githubAccount: account.data } : {}),
      ...(tag?.success === true ? { tag: tag.data } : {}),
      ...(notTag?.success === true ? { notTag: notTag.data } : {}),
    },
  };
};

/**
 * A card's name where people and GitHub read it (a commit, a pull request, a comment): `AB#4` on
 * Azure Boards, which GitHub links to the card; `L-4` on a board on this machine, so GitHub links
 * no one's Azure card 4; `#4` on a GitHub board, the issue itself.
 */
export const boardCardName = (id: number, board: Pick<BoardRef, 'provider'>): string => {
  if (isLocalBoard(board)) return `L-${id}`;

  return isGithubBoard(board) ? `#${id}` : `AB#${id}`;
};

/**
 * A card's id: `4`, `#4` or `AB#4`, a board on this machine's `L-4`; a held card's (local mode)
 * `LC3`, `#LC3` too.
 */
export const parseCardId = (text: string): number | undefined => {
  const held = /^(?:AB#|#)?LC([1-9][0-9]{0,8})$/i.exec(text)?.[1];

  if (held !== undefined) return localNumber(Number(held));
  const digits = /^(?:AB#|#|L-)?([1-9][0-9]*)$/i.exec(text)?.[1];

  return digits === undefined ? undefined : Number(digits);
};

/** `System.Tags` (`auth; web`) as a list. */
export const parseTags = (field: string | undefined): string[] =>
  (field ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter((t) => t !== '');

export const tagsField = (tags: readonly string[]): string => tags.join('; ');

const has = (tags: readonly string[], tag: string) =>
  tags.some((t) => t.toLowerCase() === tag.toLowerCase());

/** Whether tags (a card's, an issue's labels) carry this one; a tag's case does not matter. */
export const carriesTag = (tags: readonly string[], tag: string): boolean => has(tags, tag);

/** Tags with `remove` taken out and `add` put on the end; a tag's case does not matter. */
export const retag = (
  tags: readonly string[],
  change: { add: readonly string[]; remove: readonly string[] },
): string[] => {
  const kept = tags.filter((t) => !has(change.remove, t));

  for (const tag of change.add) if (!has(kept, tag)) kept.push(tag);

  return kept;
};

/** What a tag change writes to `System.Tags`: nothing, its new text, or the field taken off. */
export type TagsWrite = { write: 'none' } | { write: 'set'; field: string } | { write: 'clear' };

/** A tag change against the tags read: a write only when the tags differ; none left clears it. */
export const tagsWrite = (
  field: string | undefined,
  change: { add: readonly string[]; remove: readonly string[] },
): TagsWrite => {
  const before = parseTags(field);
  const after = retag(before, change);

  if (tagsField(after) === tagsField(before)) return { write: 'none' };

  return after.length === 0 ? { write: 'clear' } : { write: 'set', field: tagsField(after) };
};

/** A long field's text is markdown when Azure keeps it so (`multilineFieldsFormat`), else html. */
export const isMarkdownFormat = (format: string | undefined): boolean =>
  format?.toLowerCase() === 'markdown';

/** A card's description: its own, or a bug's repro steps when it has none. Both markdown. */
export const cardDescription = (description: string, reproSteps: string): string =>
  description === '' ? reproSteps : description;

/** One of a team's areas: its cards are under it (with its sub-areas, or only it). */
export type Area = { path: string; includeChildren: boolean };

/**
 * A team's field values as its areas. A board is cut by area when its team field is
 * `System.AreaPath`; any other team field gives no areas, so the list is the project's cards.
 */
export const teamAreas = (
  field: string,
  values: readonly { value: string; includeChildren: boolean }[],
): Area[] =>
  field === 'System.AreaPath'
    ? values.map((v) => ({ path: v.value, includeChildren: v.includeChildren }))
    : [];

export const isDoneState = (state: string): boolean => DONE_STATES.some((d) => d === state);

/** Days of done cards a board with no current sprint shows (#239), so its column stays short. */
export const DONE_DAYS = 14;

/**
 * The done cards a list takes beside the open ones (#239): a sprint's (its path, and the ones
 * under it), or with no sprint those changed in the last `days`. A Removed card never shows.
 */
export type DoneCards = { iteration: string } | { days: number };

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const list = (values: readonly string[]) => values.map(quote).join(', ');

/** A team's iteration: `path` is what `System.IterationPath` holds (`Shop\\Sprint 4`). */
export type Sprint = { name: string; path: string };

/** The done cards `card list --closed` takes (#239): the sprint's, else (none, or not read) the last days'. */
export const doneCardsOf = (sprint: Sprint | null): DoneCards =>
  sprint === null ? { days: DONE_DAYS } : { iteration: sprint.path };

/** The state's clause: open cards, and the done ones `done` names. */
const stateClause = (done: DoneCards | undefined) => {
  const open = `[System.State] NOT IN (${list(OVER_STATES)})`;

  if (done === undefined) return open;
  const which =
    'iteration' in done
      ? `[System.IterationPath] UNDER ${quote(done.iteration)}`
      : `[System.ChangedDate] >= @Today - ${Math.max(0, Math.floor(done.days))}`;

  return `(${open} OR ([System.State] IN (${list(DONE_STATES)}) AND ${which}))`;
};

/** A shared board's areas: under the one, or under any of several. */
const areaClause = (area: string | readonly string[]) => {
  const under = (typeof area === 'string' ? [area] : area).map(
    (a) => `[System.AreaPath] UNDER ${quote(a)}`,
  );

  return under.length === 1 ? (under[0] ?? '') : `(${under.join(' OR ')})`;
};

/**
 * Not in these swimlanes. A card in the default lane has an empty `System.BoardLane`, which a
 * `NOT IN` alone may leave out (an empty field compares as no value): `= ''` keeps it.
 */
const lanesClause = (lanes: readonly string[]) =>
  `([System.BoardLane] NOT IN (${list(lanes)}) OR [System.BoardLane] = '')`;

/** Yours: assigned to you. */
const MINE = '[System.AssignedTo] = @Me';

/**
 * The WIQL of a board's cards: its types, open (and the done ones `done` names), in the team's
 * areas, newest change first; only yours (`mine`), only in an iteration and under it
 * (`iteration`, a sprint's path).
 */
export const cardsQuery = (q: {
  types: readonly string[];
  areas: readonly Area[];
  mine: boolean;
  iteration?: string;
  done?: DoneCards;
  /** Only these cards (#236: which of those changed are on the board). */
  ids?: readonly number[];
  /** A shared board's cards that are this repo's: under this area path (or any), carrying this tag. */
  area?: string | readonly string[];
  tag?: string;
  /** The cards it leaves out: in these swimlanes, carrying this tag. */
  excludeLanes?: readonly string[];
  notTag?: string;
}) =>
  `SELECT [System.Id] FROM WorkItems WHERE ${[
    '[System.TeamProject] = @project',
    `[System.WorkItemType] IN (${list(q.types)})`,
    ...(q.ids === undefined ? [] : [`[System.Id] IN (${q.ids.join(', ')})`]),
    stateClause(q.done),
    ...(q.areas.length === 0
      ? []
      : [
          `(${q.areas
            .map((a) => `[System.AreaPath] ${a.includeChildren ? 'UNDER' : '='} ${quote(a.path)}`)
            .join(' OR ')})`,
        ]),
    ...(q.area === undefined ? [] : [areaClause(q.area)]),
    ...(q.tag === undefined ? [] : [`[System.Tags] CONTAINS ${quote(q.tag)}`]),
    ...(q.excludeLanes === undefined || q.excludeLanes.length === 0
      ? []
      : [lanesClause(q.excludeLanes)]),
    ...(q.notTag === undefined ? [] : [`[System.Tags] NOT CONTAINS ${quote(q.notTag)}`]),
    ...(q.mine ? [MINE] : []),
    ...(q.iteration === undefined ? [] : [`[System.IterationPath] UNDER ${quote(q.iteration)}`]),
  ].join(' AND ')} ORDER BY [System.ChangedDate] DESC`;

/**
 * The WIQL of the board's types changed on its project (#236): after `since` (Azure DevOps' own
 * time, compared to the second and below only with `timePrecision`), in any state and any area,
 * so a card that left the board is found too, the oldest change first (a look that reads only
 * some goes on from the last next time); without `since`, any one of them: the query's `asOf` is
 * where the next look starts.
 */
export const changedQuery = (q: { types: readonly string[]; since?: string }) =>
  `SELECT [System.Id] FROM WorkItems WHERE ${[
    '[System.TeamProject] = @project',
    `[System.WorkItemType] IN (${list(q.types)})`,
    ...(q.since === undefined ? [] : [`[System.ChangedDate] > ${quote(q.since)}`]),
  ].join(' AND ')} ORDER BY [System.ChangedDate] ${q.since === undefined ? 'DESC' : 'ASC'}`;

/** An Azure DevOps answer outside 2xx → the error code; 203 is its sign-in page for a bad token. */
export const adoErrorCode = (status: number, message: string): BoardErrorCode => {
  if (/TF26071|WorkItemRevisionMismatch/.test(message) || status === 409 || status === 412)
    return 'conflict';
  if (status === 401 || status === 403 || status === 203) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 400) return 'rejected';

  return 'ado-failed';
};

export const Person = z.object({ name: z.string(), email: z.string() });
export type Person = z.infer<typeof Person>;

/**
 * A member of the board's team (B2, #213): their name and login as Azure DevOps knows them
 * (`uniqueName`, an email), and whether they are you (the login the token is).
 */
export const BoardMember = Person.extend({ you: z.boolean() });
export type BoardMember = z.infer<typeof BoardMember>;

/** `abe card members`: the team's members, you first, then the others by name A–Z. */
export const CardMembersData = z.object({ members: z.array(BoardMember) });
export type CardMembersData = z.infer<typeof CardMembersData>;

/** The members as `card members` lists them: you first, then by name A–Z (case and accents aside). */
export const membersInOrder = (members: readonly BoardMember[]): BoardMember[] =>
  members.toSorted(
    (a, b) =>
      Number(b.you) - Number(a.you) ||
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
      a.email.localeCompare(b.email, 'en', { sensitivity: 'base' }),
  );

export const cardMembersText = (d: CardMembersData): string =>
  d.members.length === 0
    ? 'no members on the team\n'
    : `${d.members.map((m) => `${m.name} <${m.email}>${m.you ? '  (you)' : ''}`).join('\n')}\n`;

/**
 * `abe card checkout`: a worktree on this Mac on the card's branch as origin has it (a teammate's
 * story, or one on a box: a second checkout beside the box's own). `made`: made now, not held already.
 */
export const CardCheckoutData = z.object({
  worktree: z.string(),
  branch: z.string(),
  made: z.boolean(),
});
export type CardCheckoutData = z.infer<typeof CardCheckoutData>;

export const cardCheckoutText = (d: CardCheckoutData): string =>
  `${d.made ? 'checked out' : 'already checked out'} ${d.branch} at ${d.worktree}\n`;

/** Who `card assign` writes: you, no one, or a teammate by their login (`uniqueName`). */
export type AssignTo = { kind: 'me' } | { kind: 'none' } | { kind: 'member'; login: string };

/**
 * `card assign <id> <who>`'s `who` as the person typed it: `me`, `none`, or a teammate by their
 * email, their name, or their email's part before the `@` (any case); any other email as it is. A
 * name that fits more than one member, or none, is said with the members it could be.
 */
export const assignTarget = (
  who: string,
  members: readonly BoardMember[],
): { ok: true; to: AssignTo; member?: BoardMember } | { ok: false; message: string } => {
  const t = who.trim();
  const low = t.toLowerCase();

  if (low === 'me') return { ok: true, to: { kind: 'me' } };
  if (low === 'none') return { ok: true, to: { kind: 'none' } };
  const same = (a: string) => a.toLowerCase() === low;
  const found = [
    members.filter((m) => same(m.email)),
    members.filter((m) => same(m.name)),
    members.filter((m) => same(m.email.split('@')[0] ?? '')),
  ].find((ms) => ms.length > 0);
  const listed = membersInOrder(members)
    .map((m) => m.email)
    .join(', ');

  // an email not on the team as it is: Azure DevOps says whether it knows them (a card's
  // assignee from another team, put back by an undo)
  if (found === undefined && t.includes('@')) return { ok: true, to: { kind: 'member', login: t } };
  if (found === undefined)
    return {
      ok: false,
      message: `'${t}' is not on the team: ${listed === '' ? 'it has no members' : listed}`,
    };
  const [one, ...more] = found;

  if (one === undefined || more.length > 0)
    return {
      ok: false,
      message: `'${t}' fits more than one member: ${found.map((m) => m.email).join(', ')}`,
    };

  return one.you
    ? { ok: true, to: { kind: 'me' }, member: one }
    : { ok: true, to: { kind: 'member', login: one.email }, member: one };
};

/** `abe card show`, and each card of `abe card list`. Long fields are markdown, `''` when empty. */
export const CardData = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  assignee: Person.nullable(),
  /** The description; a bug without one has its repro steps here. */
  description: z.string(),
  acceptanceCriteria: z.string(),
  /** The card on Azure Boards. */
  url: z.string(),
  /** Its story points (`Microsoft.VSTS.Scheduling.StoryPoints`); null: none set (a `serve` before #135 too). */
  points: z.number().nonnegative().nullable().default(null),
  /** Who made it (`System.CreatedBy`); null from a `serve` before. */
  createdBy: Person.nullable().default(null),
  /** Its swimlane on the board (`System.BoardLane`); absent: the default lane, or no lanes. */
  lane: z.string().min(1).optional(),
});
export type CardData = z.infer<typeof CardData>;

/** `abe card list`: the board's open cards (`--closed`: the sprint's done ones too), by change. */
export const CardListData = z.object({
  board: z.object({
    /** `local`: the board On this Mac; `github`: the repo's GitHub Issues; absent: Azure Boards. */
    provider: z.enum([LOCAL_BOARD, GITHUB_BOARD]).optional(),
    organization: z.string(),
    project: z.string(),
    team: z.string(),
    /** The card types it lists, the first a New card's default (#346). */
    types: z.array(z.string()).optional(),
  }),
  mine: z.boolean(),
  /** Done cards listed too (#239): the current sprint's, else the last `DONE_DAYS` days'. */
  closed: z.boolean().optional(),
  cards: z.array(CardData),
  /** The team's current sprint's name; null when none spans today or it could not be read. */
  sprint: z.string().nullable().default(null),
});
export type CardListData = z.infer<typeof CardListData>;

/** A comment on a card, its text as markdown. */
export const CardComment = z.object({
  id: z.number().int(),
  text: z.string(),
  by: z.string(),
  at: z.string(),
});
export type CardComment = z.infer<typeof CardComment>;

/** `abe card show`: the card and its comments, oldest first. */
export const CardDetail = CardData.extend({ comments: z.array(CardComment) });
export type CardDetail = z.infer<typeof CardDetail>;

/** A card changed outside (#236), as the board now lists it: on Mine too, or only on Team. */
export const BoardChange = z.object({ card: CardData, mine: z.boolean() });
export type BoardChange = z.infer<typeof BoardChange>;

/**
 * What changed on a board since the last look (#236): the changed cards it lists now (as `card
 * list --closed` would), newest change first, and the changed ones it does not list (moved out
 * of its areas, removed, done before the sprint, or another team's in the project). `at` is
 * where the next look starts, on Azure DevOps' clock (the query's `asOf`); null only when Azure
 * DevOps did not say.
 */
export const BoardChanges = z.object({
  at: z.string().nullable(),
  cards: z.array(BoardChange),
  gone: z.array(z.number().int().positive()),
});
export type BoardChanges = z.infer<typeof BoardChanges>;

/** `board.changed` (#236): a board's cards changed outside Abe, read by their ids. */
export const BoardChangedEvent = z.object({
  board: z.object({ organization: z.string(), project: z.string(), team: z.string() }),
  cards: z.array(BoardChange),
  gone: z.array(z.number().int().positive()),
});
export type BoardChangedEvent = z.infer<typeof BoardChangedEvent>;

export const boardChangedText = (d: BoardChangedEvent): string =>
  `${d.board.project} / ${d.board.team}: ${[
    ...d.cards.map((c) => `AB#${c.card.id} ${c.card.state}`),
    ...d.gone.map((id) => `AB#${id} not on the board`),
  ].join(', ')}`;

/**
 * What Abe answers where it once commented on a card by itself (a step's report, a run's end, its
 * pull request's link, an Override, a Sheet's link line): nothing is written on the card. Abe
 * comments on a card only when the person asks (`card comment`, `triage apply`), ADR 0038; a
 * pull request on GitHub still gets its own.
 */
export const NOT_COMMENTED = 'not commented: Abe leaves card comments to you';

/** `abe card comment`: the comment as it now stands on the card. */
export const CardCommentData = CardComment.extend({ card: z.number().int().positive() });
export type CardCommentData = z.infer<typeof CardCommentData>;

const head = (c: CardData) => `AB#${c.id} (${c.state}) ${c.title}`;

export const cardText = (c: CardData): string =>
  `${[
    head(c),
    [
      c.type,
      c.assignee?.name ?? 'unassigned',
      ...(c.tags.length === 0 ? [] : [c.tags.join(', ')]),
    ].join(' · '),
    c.url,
    ...(c.description === '' ? [] : ['', c.description]),
    ...(c.acceptanceCriteria === '' ? [] : ['', 'Acceptance criteria:', c.acceptanceCriteria]),
  ].join('\n')}\n`;

export const cardDetailText = (c: CardDetail): string =>
  `${cardText(c)}${c.comments
    .map((m) => `\n${m.by}, ${m.at.slice(0, 10)}:\n${m.text}\n`)
    .join('')}`;

export const cardListText = (l: CardListData): string => {
  // the board and its sprint first, as the JSON names it (#187)
  const where = `${l.board.project} / ${l.board.team}${l.sprint === null ? '' : ` · ${l.sprint}`}`;

  if (l.cards.length === 0)
    return `no ${l.closed === true ? '' : 'open '}cards${l.mine ? ' of yours' : ''} on ${where}\n`;
  const width = Math.max(...l.cards.map((c) => c.state.length));

  return `${where}\n\n${l.cards
    .map(
      (c) =>
        `${boardCardName(c.id, l.board).padEnd(9)} ${c.state.padEnd(width)}  ${c.title}${c.assignee === null ? '' : `  (${c.assignee.name})`}`,
    )
    .join('\n')}\n`;
};

/**
 * A card comment an agent wrote from its session (#187): marked as AI's, as triage's are
 * (`TRIAGE_DISCLAIMER`), naming the session.
 */
export const agentComment = (session: string, markdown: string): string =>
  `> *This was generated by AI in session ${session}.*\n\n${markdown}`;

export const cardCommentText = (c: CardCommentData): string =>
  `commented on AB#${c.card} as ${c.by}\n`;
