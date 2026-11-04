/**
 * Factory install's Connection check (spec 3.0.1 "Confirm the connection", #71): serve reads live
 * what was set up, as facts, not as what the agent wrote: the board (its kind, org, project,
 * team, iteration and its 3 newest cards), GitHub (the repo from origin, the account gh acts as,
 * whether it reads pull requests), the cloud (cards on cloud boxes: the Layer's `box.profile`, `box.region`,
 * its account; Local only: aws if used), and each added source. Each is ok, failed with why and
 * its fix, a warning, or skipped. The Connection part passes with none failed and each warning
 * accepted by the person (`install-parts.ts`). Pure: serve hands it what each read answered; no
 * token or credential is in a fact, only names and ids.
 */
import { z } from 'zod';

/**
 * Where the repo's cards run (`serve.target`): on this machine, where GitHub not read is a warning
 * and the cloud is the app's own aws, or on cloud boxes.
 */
export type CardsRun = 'local' | 'cloud';

/** A board fact's fix: the board the repo's settings name, written again. */
const BOARD_FIX = 'name the board in abe.yaml, then abe install check board';

/** A fact's fix when reading it again may answer. */
const CHECK_AGAIN = 'abe install connection';
import {
  type BoardError,
  type Boarded,
  type BoardRef,
  type CardData,
  isGithubBoard,
  isLocalBoard,
  type Sprint,
} from '../board/board';
import { defaultTeam } from './install-board-hints';
import { BOARD_PROVIDER_WORDS, type BoardWhere } from './install-read';
import { type SourceAccount } from './install-source-account';
import { type PrTouch, type Repo, type Tracked } from '../board/tracking';
import { type AzFolderFact, azFolderWords, azLoginCommand } from '../logins';

/** `warning`: not right, yet no blocker (A local one's GitHub: nothing is sent there). */
export const CONNECTION_STATES = ['ok', 'failed', 'warning', 'skipped'] as const;
export const ConnectionState = z.enum(CONNECTION_STATES);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const ConnectionFact = z.object({
  of: z.enum(['board', 'github', 'cloud', 'source', 'credentials']),
  /** How the page names it: `Board`, `GitHub`, `Cloud`, `Sentry`. */
  name: z.string(),
  /** A source's id (`sources:`); null for the others. */
  source: z.string().nullable(),
  state: ConnectionState,
  /** What was read, as the board, gh, aws or the source answered it. */
  rows: z.array(z.object({ label: z.string(), text: z.string() })),
  /** Failed or warning: why; skipped: why not needed. */
  why: z.string().nullable(),
  /** Failed or warning: the person's way to fix it (a sign-in, the platform Terraform, a setting here). */
  fix: z.string().nullable(),
});
export type ConnectionFact = z.infer<typeof ConnectionFact>;

export const Connection = z.object({ at: z.string(), facts: z.array(ConnectionFact) });
export type Connection = z.infer<typeof Connection>;

/** Where box infrastructure is set up: the org's, not the repo install's. */
/** Box infrastructure (profiles, accounts, image, stores) is the platform Terraform's, never a setting here. */
export const ABE_ORG = 'set up by the platform Terraform (infra/aws)';

/** A source's MCP server as Claude Code says it for the person (`claude mcp get <name>`). */
export const MCP_STATES = ['connected', 'needs-auth', 'failed', 'none'] as const;
export type McpState = (typeof MCP_STATES)[number];

/** What `aws sts get-caller-identity --profile` answered: the account id only. */
export type AwsAccount = { account: string } | { cannot: string };

const failed = (
  f: Pick<ConnectionFact, 'of' | 'name' | 'rows'> & { source?: string },
  why: string,
  fix: string | null,
): ConnectionFact => ({ source: null, ...f, state: 'failed', why, fix });

const ok = (f: Pick<ConnectionFact, 'of' | 'name' | 'rows'> & { source?: string }) => ({
  source: null,
  ...f,
  state: 'ok' as const,
  why: null,
  fix: null,
});

const orgName = (url: string) => url.replace(/\/+$/, '').split('/').pop() ?? url;

/** A folder for a second az login, as the fix suggests it. */
const NEW_AZ_DIR = '~/.azure-<org>';

/**
 * Azure DevOps refused the login: the az folder this checkout reads, and how to give it its own
 * (`board.azureConfigDir` for this checkout) or sign in there; never a sign-in into another org's.
 */
export const azAuthFix = (az: AzFolderFact | undefined): string => {
  const own = `abe settings set board.azureConfigDir ${NEW_AZ_DIR} --mine, then ${azLoginCommand(NEW_AZ_DIR)}`;
  const at = az ?? { from: 'none', dir: null };

  switch (at.from) {
    case 'checkout':
      return `${azFolderWords(at)}: ${azLoginCommand(at.dir)}`;
    case 'environment':
      return `${azFolderWords(at)}: sign in there (${azLoginCommand(at.dir)}), or start abe serve without it`;
    case 'none':
      return `${azFolderWords(at)}: abe login az, or to keep it apart, ${own}`;
  }
};

/** A shared board's area path, or its several, in words. */
const areaWords = (area: string | readonly string[]): string =>
  typeof area === 'string' ? area : area.join(', ');

/**
 * The newest cards as rows, or that none is open: with a shared board's area or tag, or the lanes
 * and tag it leaves out, how many are open without them (`without`), so a tag nobody put on a card
 * yet reads as that.
 */
const newestRows = (
  cards: readonly CardData[],
  filter: Pick<BoardRef, 'area' | 'tag' | 'excludeLanes' | 'notTag'> = {},
  without = 0,
) => {
  const newest = [...cards].sort((x, y) => y.id - x.id).slice(0, 3);
  const by = [
    ...(filter.area === undefined ? [] : [`area ${areaWords(filter.area)}`]),
    ...(filter.tag === undefined ? [] : [`tag ${filter.tag}`]),
    ...(filter.excludeLanes === undefined ? [] : [`no lane ${filter.excludeLanes.join(', ')}`]),
    ...(filter.notTag === undefined ? [] : [`no tag ${filter.notTag}`]),
  ];
  const none =
    by.length === 0 || without === 0
      ? 'none open'
      : `none open with ${by.join(' and ')} (${without} open without ${by.length === 1 ? 'it' : 'them'})`;

  return newest.length === 0
    ? [{ label: 'Cards', text: none }]
    : newest.map((c) => ({ label: 'Card', text: `#${c.id} ${c.title}` }));
};

/** An empty board On this Mac: the Factory has no card to take until one is made. */
export const FIRST_CARD = 'none yet: make the first with abe card create --title "<what to build>"';

/** What a read-only board's row says: its changes stay here. */
export const READ_ONLY_WORDS = 'read-only: changes stay on this machine, never sent';

/**
 * The board as it answers: Azure Boards' org, project, team, the sprint and the newest cards; a
 * board On this Mac its name and newest cards. `readOnly`: its writes are held on this Mac (local
 * mode, or the board read-only alone).
 */
export const boardFact = (o: {
  where: BoardWhere | null;
  board: { ok: true; board: BoardRef } | { ok: false; error: BoardError };
  cards?: Boarded<CardData[]>;
  /** How many cards are open on the board without its area and tag (read when they left none). */
  openWithoutFilter?: number;
  sprint?: Boarded<Sprint | null>;
  readOnly?: boolean;
  /** az's folder in force at the checkout: a refused login's fix names it. */
  az?: AzFolderFact;
}): ConnectionFact => {
  const base = { of: 'board' as const, name: 'Board' };

  if (o.where === null) return failed({ ...base, rows: [] }, 'no board named', BOARD_FIX);
  const kind = { label: 'Kind', text: BOARD_PROVIDER_WORDS[o.where.provider] };

  if (o.where.provider === 'local') {
    if (!o.board.ok || !isLocalBoard(o.board.board))
      return failed(
        { ...base, rows: [kind] },
        'the board setting does not say provider: local',
        BOARD_FIX,
      );
    const rows = [kind, { label: 'Board', text: o.board.board.project }];

    if (o.cards === undefined) return failed({ ...base, rows }, 'the board was not read', null);
    if (!o.cards.ok) return failed({ ...base, rows }, o.cards.error.message, null);

    return ok({
      ...base,
      rows: [
        ...rows,
        { label: 'Kept', text: 'on this machine only' },
        // nothing for the Factory to take yet: say how the first card is made
        ...(o.cards.data.length === 0
          ? [{ label: 'Cards', text: FIRST_CARD }]
          : newestRows(o.cards.data)),
      ],
    });
  }
  if (o.where.provider === 'github-issues') {
    if (!o.board.ok) return failed({ ...base, rows: [kind] }, o.board.error.message, BOARD_FIX);
    if (!isGithubBoard(o.board.board))
      return failed(
        { ...base, rows: [kind] },
        'the board setting does not say provider: github',
        BOARD_FIX,
      );
    const rows = [kind, { label: 'Repo', text: o.board.board.project }];

    if (o.cards === undefined) return failed({ ...base, rows }, 'the board was not read', null);
    if (!o.cards.ok)
      return failed(
        { ...base, rows },
        o.cards.error.message,
        o.cards.error.code === 'auth' ? 'abe login github' : null,
      );

    return ok({
      ...base,
      rows: [
        ...rows,
        ...(o.readOnly === true ? [{ label: 'Writes', text: READ_ONLY_WORDS }] : []),
        ...newestRows(o.cards.data, o.board.board, o.openWithoutFilter),
      ],
    });
  }
  if (o.where.provider !== 'azure-boards')
    return failed(
      { ...base, rows: [kind, { label: 'Board', text: o.where.name }] },
      `${kind.text} has no cards in Abe yet`,
      BOARD_FIX,
    );
  if (!o.board.ok) return failed({ ...base, rows: [kind] }, o.board.error.message, BOARD_FIX);
  const b = o.board.board;
  const rows = [
    kind,
    { label: 'Org', text: orgName(b.organization) },
    { label: 'Project', text: b.project },
    {
      label: 'Team',
      text:
        o.where.defaultTeam === true && b.team === defaultTeam(b.project)
          ? `${b.team} (the link names no team: the project's default team)`
          : b.team,
    },
    // a shared board: only the cards that are this repo's
    ...(b.area === undefined ? [] : [{ label: 'Area', text: areaWords(b.area) }]),
    ...(b.tag === undefined ? [] : [{ label: 'Tag', text: b.tag }]),
    // and the cards it leaves out
    ...(b.excludeLanes === undefined
      ? []
      : [{ label: 'Lanes left out', text: b.excludeLanes.join(', ') }]),
    ...(b.notTag === undefined ? [] : [{ label: 'Tag left out', text: b.notTag }]),
  ];

  if (o.cards === undefined) return failed({ ...base, rows }, 'the board was not read', null);
  if (!o.cards.ok)
    return failed(
      { ...base, rows },
      o.cards.error.message,
      o.cards.error.code === 'auth' ? azAuthFix(o.az) : null,
    );
  const sprint = o.sprint?.ok === true ? o.sprint.data : null;

  return ok({
    ...base,
    rows: [
      ...rows,
      { label: 'Iteration', text: sprint === null ? 'no current sprint' : sprint.path },
      ...(o.readOnly === true ? [{ label: 'Writes', text: READ_ONLY_WORDS }] : []),
      ...newestRows(o.cards.data, b, o.openWithoutFilter),
    ],
  });
};

/** A local one's GitHub not read right: no blocker, nothing is sent there. */
export const GITHUB_ON_MAC = 'Local only sends nothing to GitHub: you may go on';

/**
 * The fix for GitHub not read as it should be: another gh login that reads the repo named, set
 * as this checkout's `logins.gh` (gh's active login never switched); else a sign-in.
 */
const githubFix = (account: string | null, readable: GithubReadable | undefined): string => {
  if (readable !== undefined) {
    const as =
      account === null
        ? `${readable.active ?? 'none'} is active`
        : `Abe reads as ${account} (logins.gh)`;

    return `${readable.login} is signed in but ${as}: abe settings set logins.gh ${readable.login} --mine`;
  }

  return account === null ? 'abe login github' : `gh auth login, as ${account}`;
};

/** A signed-in gh login, not the one read with, that reads the repo; and gh's active one. */
export type GithubReadable = { login: string; active: string | null };

/**
 * GitHub: the repo from origin (never its URL, which may carry a login), the account Abe reads it
 * as (`logins.gh` in force at the checkout, else gh's active one), its PRs. Cards on this machine
 * sends nothing there: not read right is a warning, never a blocker.
 */
export const githubFact = (o: {
  origin: string | undefined;
  repo: Repo | undefined;
  me?: Tracked<{ login: string }>;
  prs?: Tracked<PrTouch[]>;
  /** `logins.gh` in force at the checkout; `null` or none: gh's active login. */
  account?: string | null;
  /** Another signed-in login that reads the repo, when this one could not. */
  readable?: GithubReadable;
  /** The install set `account` as `logins.gh` here: this login, in force before, could not read it. */
  setFrom?: string;
  /** Every signed-in login was tried and none reads the repo. */
  tried?: readonly string[];
  kind?: CardsRun;
}): ConnectionFact => {
  const base = { of: 'github' as const, name: 'GitHub' };
  const account = o.account ?? null;
  const none = o.tried !== undefined && o.tried.length > 0 && o.repo !== undefined;
  const fix = none
    ? `gh auth login --web, as an account that can read ${o.repo ?? ''}, then abe install connection`
    : githubFix(account, o.readable);
  const not = (rows: ConnectionFact['rows'], why: string, f: string | null): ConnectionFact =>
    o.kind === 'local'
      ? { ...failed({ ...base, rows }, `${why}. ${GITHUB_ON_MAC}`, f), state: 'warning' }
      : failed({ ...base, rows }, why, f);

  if (o.origin === undefined) return not([], 'the checkout has no origin remote', null);
  if (o.repo === undefined) return not([], 'origin is not a GitHub repo', null);
  const repo = { label: 'Repo', text: o.repo };

  if (o.me === undefined) return not([repo], 'gh was not asked', fix);
  if (!o.me.ok) return not([repo], o.me.error.message, fix);
  const set =
    o.setFrom === undefined ? '' : `, set by the install: ${o.setFrom} can't read the repo`;
  const rows = [
    repo,
    {
      label: 'Account',
      text: `${o.me.data.login}${account === null ? " (gh's active login)" : ` (logins.gh here${set})`}`,
    },
  ];

  if (o.prs === undefined) return not(rows, 'its pull requests were not read', fix);
  if (!o.prs.ok)
    return not(
      rows,
      none
        ? `none of your gh logins (${(o.tried ?? []).join(', ')}) can read ${o.repo}: ${o.prs.error.message}`
        : `cannot read its pull requests: ${o.prs.error.message}`,
      fix,
    );

  return ok({ ...base, rows: [...rows, { label: 'Pull requests', text: 'can read' }] });
};

/** A local one's cloud when the repo uses no aws. */
export const CLOUD_NOT_NEEDED = 'not needed: nothing in the repo uses aws';

/** Cards on this machine, the person skipped which aws profile the repo uses: not checked. */
export const CLOUD_PROFILE_SKIPPED = 'not checked: you skipped which aws profile it uses';

/**
 * A local one's cloud: not needed unless Read found the repo uses aws (`needs`); then the aws
 * login the app uses: why it is needed, `logins:`'s aws profile, the login as Logins checked it,
 * and the account only for an `abe-*` profile (no other is asked).
 */
const appCloud = (o: {
  profile: string | null;
  account?: AwsAccount;
  needs: readonly string[];
  login: { state: string; fix: string } | null;
}): ConnectionFact => {
  const base = { of: 'cloud' as const, name: 'Cloud' };
  const [first] = o.needs;

  if (first === undefined)
    return { ...base, source: null, state: 'skipped', rows: [], why: CLOUD_NOT_NEEDED, fix: null };
  const fix = o.login?.fix ?? `abe login aws${o.profile === null ? '' : ` --profile ${o.profile}`}`;
  const rows = [
    {
      label: 'Needed by',
      text: o.needs.length === 1 ? first : `${first} and ${o.needs.length - 1} more`,
    },
    { label: 'Profile', text: o.profile ?? 'none in logins:' },
  ];

  if (o.login === null) return failed({ ...base, rows }, 'aws was not checked', fix);
  // the person skipped which profile: aws left unchecked, nothing failed
  if (o.login.state === 'skipped')
    return { ...base, source: null, state: 'skipped', rows, why: CLOUD_PROFILE_SKIPPED, fix: null };
  const login = { label: 'Login', text: o.login.state === 'ok' ? 'signed in' : o.login.state };

  if (o.login.state !== 'ok')
    return failed({ ...base, rows: [...rows, login] }, `aws ${o.login.state}`, fix);
  if (o.account !== undefined && 'cannot' in o.account)
    return failed({ ...base, rows: [...rows, login] }, o.account.cannot, fix);

  return ok({
    ...base,
    rows: [
      ...rows,
      login,
      ...(o.account === undefined ? [] : [{ label: 'Account', text: o.account.account }]),
    ],
  });
};

/**
 * The cloud. Cards on cloud boxes: the Layer's `box.profile` (an `abe-*` one, else it is not asked) and
 * `box.region`, and the account the profile is; missing: the platform Terraform sets it up,
 * the cloud waits.
 * Cards on this machine: the app's aws login when the repo needs aws (`appCloud`), else not needed.
 */
export const cloudFact = (o: {
  kind: CardsRun;
  profile: string | null;
  region: string | null;
  account?: AwsAccount;
  /** Cards on this machine: why the repo needs aws (Read's `aws`); none: not needed. */
  needs?: readonly string[];
  /** Cards on this machine: the aws login as Logins checked it; null: not checked. */
  login?: { state: string; fix: string } | null;
}): ConnectionFact => {
  const base = { of: 'cloud' as const, name: 'Cloud' };

  if (o.kind === 'local')
    return appCloud({
      profile: o.profile,
      ...(o.account === undefined ? {} : { account: o.account }),
      needs: o.needs ?? [],
      login: o.login ?? null,
    });
  if (o.profile === null) return failed({ ...base, rows: [] }, 'no box.profile', ABE_ORG);
  const profile = { label: 'Profile', text: o.profile };

  if (!o.profile.startsWith('abe-'))
    return failed({ ...base, rows: [profile] }, `${o.profile} is no abe-* profile`, ABE_ORG);
  if (o.region === null) return failed({ ...base, rows: [profile] }, 'no box.region', ABE_ORG);
  const region = { label: 'Region', text: o.region };

  if (o.account === undefined || 'cannot' in o.account)
    return failed(
      { ...base, rows: [profile, region] },
      o.account === undefined ? 'aws was not asked' : o.account.cannot,
      `abe login aws --profile ${o.profile}`,
    );

  return ok({ ...base, rows: [profile, { label: 'Account', text: o.account.account }, region] });
};

const MCP_WHY: Readonly<Record<Exclude<McpState, 'connected'>, (mcp: string) => string>> = {
  'needs-auth': (mcp) => `${mcp} needs you to sign in`,
  failed: (mcp) => `${mcp} does not answer`,
  none: (mcp) => `you have no MCP server ${mcp}`,
};

const MCP_FIX: Readonly<Record<Exclude<McpState, 'connected'>, (mcp: string) => string>> = {
  'needs-auth': (mcp) => `/mcp in Claude Code: sign in to ${mcp}`,
  failed: (mcp) => `claude mcp get ${mcp}`,
  none: (mcp) => `claude mcp add ${mcp} …`,
};

const ACCOUNT_ROWS = [
  ['account', 'Account'],
  ['org', 'Org'],
  ['project', 'Project'],
] as const satisfies readonly (readonly [keyof SourceAccount, string])[];

/**
 * An added source: its MCP server as Claude Code answers for the person and, connected, the
 * account its server told (`Account`, `Org`, `Project`, only those it named).
 */
export const sourceFact = (o: {
  id: string;
  name: string;
  mcp: string;
  state: McpState;
  account?: SourceAccount;
  /** The probe's one read, once connected (ADR 0027); none: not probed. */
  probe?: 'ok' | 'tool-error' | 'timeout';
  /** It has a sign-in though its server told no account (it once needed one, or serve ran it). */
  signIn?: boolean;
}): ConnectionFact => {
  const f = { of: 'source' as const, name: o.name, source: o.id };
  const row = { label: 'MCP server', text: `${o.mcp}: ${o.state}` };
  const told = ACCOUNT_ROWS.flatMap(([key, label]) => {
    const text = o.account?.[key];

    return text === undefined ? [] : [{ label, text }];
  });
  const read = o.probe === undefined ? [] : [{ label: 'Read', text: PROBE_WORDS[o.probe] }];

  if (o.state !== 'connected')
    return failed({ ...f, rows: [row] }, MCP_WHY[o.state](o.mcp), MCP_FIX[o.state](o.mcp));
  // signed in only when its server told an account or it had a sign-in; else it just answered
  if (o.probe === 'tool-error')
    return told.length > 0 || o.signIn === true
      ? failed(
          { ...f, rows: [...told, row, ...read] },
          `${o.mcp} is signed in, but the account can't read it`,
          'abe source sign-in again, as an account that reads it',
        )
      : failed(
          { ...f, rows: [row, ...read] },
          `${o.mcp} answers, but its one read gave an error`,
          `check ${o.mcp}'s server, then ${CHECK_AGAIN}`,
        );
  if (o.probe === 'timeout')
    return {
      ...ok({ ...f, rows: [...told, row, ...read] }),
      state: 'warning',
      why: `${o.mcp} gave no answer to its one read in time`,
      fix: CHECK_AGAIN,
    };

  return ok({ ...f, rows: [...told, row, ...read] });
};

const PROBE_WORDS = {
  ok: 'one read ok',
  'tool-error': 'its one read gave an error',
  timeout: 'no answer in time',
} as const;

/**
 * An environment's credentials (ADR 0028): its aws profile and the account it is, and its Abe env
 * file with its key names, never a value. An expired login is a failure naming its sign-in.
 */
export const credentialsFact = (o: {
  env: string;
  profile: string | null;
  account?: AwsAccount;
  envFile: { file: string; keys: readonly string[] } | null;
}): ConnectionFact => {
  const f = { of: 'credentials' as const, name: `Env file · ${o.env}` };
  const rows = [
    {
      label: 'aws profile',
      text: o.profile ?? 'none',
    },
    ...(o.account !== undefined && 'account' in o.account
      ? [{ label: 'Account', text: o.account.account }]
      : []),
    ...(o.envFile === null
      ? []
      : [
          {
            label: o.envFile.file,
            text: o.envFile.keys.length === 0 ? 'no keys' : o.envFile.keys.join(', '),
          },
        ]),
  ];

  return o.account !== undefined && 'cannot' in o.account
    ? failed({ ...f, rows }, o.account.cannot, `abe login aws --profile ${o.profile ?? ''}`)
    : ok({ ...f, rows });
};
