/** Factory install's Connection check: each fact as read live, ok / failed with why / skipped. */
import { describe, expect, test } from 'bun:test';
import { type BoardRef, type CardData } from '../board/board';
import {
  boardFact,
  cloudFact,
  type ConnectionFact,
  githubFact,
  sourceFact,
  credentialsFact,
} from './install-connection';
import { type BoardWhere } from './install-read';
import { parseRepo, type Repo } from '../board/tracking';

const AZURE: BoardWhere = { provider: 'azure-boards', name: 'Shop/Web', from: 'repo' };
const REF: BoardRef = {
  organization: 'https://dev.azure.com/acme',
  project: 'Shop',
  team: 'Web',
  types: ['User Story'],
};
const card = (id: number, title: string): CardData => ({
  id,
  title,
  state: 'New',
  type: 'User Story',
  tags: [],
  assignee: null,
  description: '',
  acceptanceCriteria: '',
  url: '',
  points: null,
  createdBy: null,
});
const CARDS = [card(12, 'Cart'), card(31, 'Checkout'), card(7, 'Login'), card(29, 'Search')];
type Shown = (string | string[] | null)[];
const shown = (f: ConnectionFact): Shown => [
  f.state,
  f.rows.map((r) => `${r.label} ${r.text}`),
  f.why,
  f.fix,
];
const SHOP: Repo | undefined = parseRepo('acme/shop');

describe('the board, as it answers', () => {
  test.each<[string, Parameters<typeof boardFact>[0], Shown]>([
    [
      'Azure Boards: org, project, team, the sprint, the 3 newest cards',
      {
        where: AZURE,
        board: { ok: true, board: REF },
        cards: { ok: true, data: CARDS },
        sprint: { ok: true, data: { name: 'Sprint 9', path: 'Shop\\Sprint 9' } },
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Iteration Shop\\Sprint 9',
          'Card #31 Checkout',
          'Card #29 Search',
          'Card #12 Cart',
        ],
        null,
        null,
      ],
    ],
    [
      'a shared board: the area and tag that are this repo’s',
      {
        where: AZURE,
        board: { ok: true, board: { ...REF, area: 'Shop\\Auth', tag: 'auth' } },
        cards: { ok: true, data: [card(7, 'Login')] },
        sprint: { ok: true, data: null },
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Area Shop\\Auth',
          'Tag auth',
          'Iteration no current sprint',
          'Card #7 Login',
        ],
        null,
        null,
      ],
    ],
    [
      'a tag leaves no card open: how many are open without it',
      {
        where: AZURE,
        board: { ok: true, board: { ...REF, tag: 'auth' } },
        cards: { ok: true, data: [] },
        openWithoutFilter: 125,
        sprint: { ok: true, data: null },
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Tag auth',
          'Iteration no current sprint',
          'Cards none open with tag auth (125 open without it)',
        ],
        null,
        null,
      ],
    ],
    [
      'an area and a tag leave none open, the board has none either',
      {
        where: AZURE,
        board: { ok: true, board: { ...REF, area: 'Shop\\Auth', tag: 'auth' } },
        cards: { ok: true, data: [] },
        openWithoutFilter: 0,
        sprint: { ok: true, data: null },
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Area Shop\\Auth',
          'Tag auth',
          'Iteration no current sprint',
          'Cards none open',
        ],
        null,
        null,
      ],
    ],
    [
      'an area and a tag leave none open, 4 are open without them',
      {
        where: AZURE,
        board: { ok: true, board: { ...REF, area: 'Shop\\Auth', tag: 'auth' } },
        cards: { ok: true, data: [] },
        openWithoutFilter: 4,
        sprint: { ok: true, data: null },
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Area Shop\\Auth',
          'Tag auth',
          'Iteration no current sprint',
          'Cards none open with area Shop\\Auth and tag auth (4 open without them)',
        ],
        null,
        null,
      ],
    ],
    [
      'lanes and a tag left out: said, and how many are open without them when none is',
      {
        where: AZURE,
        board: {
          ok: true,
          board: { ...REF, excludeLanes: ['External dependencies', 'Ops'], notTag: 'blocked' },
        },
        cards: { ok: true, data: [] },
        openWithoutFilter: 3,
        sprint: { ok: true, data: null },
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Lanes left out External dependencies, Ops',
          'Tag left out blocked',
          'Iteration no current sprint',
          'Cards none open with no lane External dependencies, Ops and no tag blocked (3 open without them)',
        ],
        null,
        null,
      ],
    ],
    [
      'a board Abe does not read',
      {
        where: { provider: 'jira', name: 'SHOP', from: 'you' },
        board: { ok: false, error: { code: 'no-board', message: 'no board' } },
      },
      [
        'failed',
        ['Kind Jira', 'Board SHOP'],
        'Jira has no cards in Abe yet',
        'name the board in abe.yaml, then abe install check board',
      ],
    ],
    [
      'Azure Boards read-only: its writes stay on this machine',
      {
        where: AZURE,
        board: { ok: true, board: REF },
        cards: { ok: true, data: [card(7, 'Login')] },
        sprint: { ok: true, data: null },
        readOnly: true,
      },
      [
        'ok',
        [
          'Kind Azure Boards',
          'Org acme',
          'Project Shop',
          'Team Web',
          'Iteration no current sprint',
          'Writes read-only: changes stay on this machine, never sent',
          'Card #7 Login',
        ],
        null,
        null,
      ],
    ],
    [
      'On this machine: its name and newest cards, not a failure',
      {
        where: { provider: 'local', name: 'shop', from: 'you' },
        board: {
          ok: true,
          board: { ...REF, provider: 'local', organization: 'this machine', project: 'shop' },
        },
        cards: { ok: true, data: [card(1, 'First'), card(2, 'Second')] },
      },
      [
        'ok',
        [
          'Kind On this machine',
          'Board shop',
          'Kept on this machine only',
          'Card #2 Second',
          'Card #1 First',
        ],
        null,
        null,
      ],
    ],
    [
      'On this machine, none made yet',
      {
        where: { provider: 'local', name: 'shop', from: 'repo' },
        board: {
          ok: true,
          board: { ...REF, provider: 'local', organization: 'this machine', project: 'shop' },
        },
        cards: { ok: true, data: [] },
      },
      [
        'ok',
        [
          'Kind On this machine',
          'Board shop',
          'Kept on this machine only',
          'Cards none yet: make the first with abe card create --title "<what to build>"',
        ],
        null,
        null,
      ],
    ],
    [
      "GitHub Issues: the repo's issues, the newest as cards",
      {
        where: { provider: 'github-issues', name: 'acme/shop', from: 'repo' },
        board: {
          ok: true,
          board: {
            ...REF,
            provider: 'github',
            repo: 'acme/shop',
            organization: 'https://github.com/acme',
            project: 'acme/shop',
            team: 'Issues',
          },
        },
        cards: { ok: true, data: [card(3, 'Show stock')] },
      },
      ['ok', ['Kind GitHub Issues', 'Repo acme/shop', 'Card #3 Show stock'], null, null],
    ],
    [
      'GitHub Issues refused by gh: its sign-in',
      {
        where: { provider: 'github-issues', name: 'acme/shop', from: 'repo' },
        board: {
          ok: true,
          board: { ...REF, provider: 'github', repo: 'acme/shop', project: 'acme/shop' },
        },
        cards: { ok: false, error: { code: 'auth', message: 'HTTP 401: Bad credentials' } },
      },
      [
        'failed',
        ['Kind GitHub Issues', 'Repo acme/shop'],
        'HTTP 401: Bad credentials',
        'abe login github',
      ],
    ],
    [
      'On this machine answered, the setting not written yet',
      {
        where: { provider: 'local', name: 'shop', from: 'you' },
        board: { ok: false, error: { code: 'no-board', message: 'no board' } },
      },
      [
        'failed',
        ['Kind On this machine'],
        'the board setting does not say provider: local',
        'name the board in abe.yaml, then abe install check board',
      ],
    ],
    [
      "the board refuses, az's own folder: its sign-in, or a folder of its own here",
      {
        where: AZURE,
        board: { ok: true, board: REF },
        cards: { ok: false, error: { code: 'auth', message: 'az is not signed in' } },
      },
      [
        'failed',
        ['Kind Azure Boards', 'Org acme', 'Project Shop', 'Team Web'],
        'az is not signed in',
        "this checkout reads az's own folder (~/.azure): abe login az, or to keep it apart, abe settings set board.azureConfigDir ~/.azure-<org> --mine, then AZURE_CONFIG_DIR=~/.azure-<org> az login --allow-no-subscriptions",
      ],
    ],
    [
      "the board refuses, this checkout's az folder: sign in there",
      {
        where: AZURE,
        board: { ok: true, board: REF },
        cards: { ok: false, error: { code: 'auth', message: 'HTTP 401' } },
        az: { from: 'checkout', dir: '/me/az-acme' },
      },
      [
        'failed',
        ['Kind Azure Boards', 'Org acme', 'Project Shop', 'Team Web'],
        'HTTP 401',
        'this checkout reads az from /me/az-acme (board.azureConfigDir here): AZURE_CONFIG_DIR=/me/az-acme az login --allow-no-subscriptions',
      ],
    ],
  ])('%s', (_, input, want) => {
    expect(shown(boardFact(input))).toEqual(want);
  });
});

describe('GitHub: the repo from origin, the account, its pull requests', () => {
  test.each<[string, Parameters<typeof githubFact>[0], Shown]>([
    [
      'all read',
      {
        origin: 'https://ann:secret@github.com/acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann' } },
        prs: { ok: true, data: [] },
      },
      [
        'ok',
        ['Repo acme/shop', "Account ann (gh's active login)", 'Pull requests can read'],
        null,
        null,
      ],
    ],
    [
      'as logins.gh here',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann-acme' } },
        prs: { ok: true, data: [] },
        account: 'ann-acme',
      },
      [
        'ok',
        ['Repo acme/shop', 'Account ann-acme (logins.gh here)', 'Pull requests can read'],
        null,
        null,
      ],
    ],
    [
      'set here by the install: the login in force could not read it, this one can',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann-acme' } },
        prs: { ok: true, data: [] },
        account: 'ann-acme',
        setFrom: 'ann',
      },
      [
        'ok',
        [
          'Repo acme/shop',
          "Account ann-acme (logins.gh here, set by the install: ann can't read the repo)",
          'Pull requests can read',
        ],
        null,
        null,
      ],
    ],
    [
      'none of the signed-in logins reads it: said, with the sign-in that fixes it',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann' } },
        prs: { ok: false, error: { code: 'not-found', message: 'HTTP 404' } },
        tried: ['ann', 'ann-acme'],
      },
      [
        'failed',
        ['Repo acme/shop', "Account ann (gh's active login)"],
        'none of your gh logins (ann, ann-acme) can read acme/shop: HTTP 404',
        'gh auth login --web, as an account that can read acme/shop, then abe install connection',
      ],
    ],
    [
      'another signed-in login reads it: named, set here',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann' } },
        prs: { ok: false, error: { code: 'not-found', message: 'HTTP 404' } },
        readable: { login: 'ann-acme', active: 'ann' },
      },
      [
        'failed',
        ['Repo acme/shop', "Account ann (gh's active login)"],
        'cannot read its pull requests: HTTP 404',
        'ann-acme is signed in but ann is active: abe settings set logins.gh ann-acme --mine',
      ],
    ],
    [
      'an enterprise managed login reads it: named whole, set here, not a new sign-in',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann' } },
        prs: { ok: false, error: { code: 'not-found', message: 'HTTP 404' } },
        readable: { login: 'ann_acme', active: 'ann' },
        kind: 'local',
      },
      [
        'warning',
        ['Repo acme/shop', "Account ann (gh's active login)"],
        'cannot read its pull requests: HTTP 404. Local only sends nothing to GitHub: you may go on',
        'ann_acme is signed in but ann is active: abe settings set logins.gh ann_acme --mine',
      ],
    ],
    [
      'Local only: not read is a warning, nothing is sent there',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: true, data: { login: 'ann' } },
        prs: { ok: false, error: { code: 'not-found', message: 'HTTP 404' } },
        kind: 'local',
      },
      [
        'warning',
        ['Repo acme/shop', "Account ann (gh's active login)"],
        'cannot read its pull requests: HTTP 404. Local only sends nothing to GitHub: you may go on',
        'abe login github',
      ],
    ],
    [
      'no origin',
      { origin: undefined, repo: undefined },
      ['failed', [], 'the checkout has no origin remote', null],
    ],
    [
      'origin elsewhere',
      { origin: 'https://ann:secret@gitlab.com/acme/shop.git', repo: undefined },
      ['failed', [], 'origin is not a GitHub repo', null],
    ],
    [
      'gh not signed in',
      {
        origin: 'git@github.com:acme/shop.git',
        repo: SHOP,
        me: { ok: false, error: { code: 'auth', message: 'gh auth login' } },
      },
      ['failed', ['Repo acme/shop'], 'gh auth login', 'abe login github'],
    ],
  ])('%s', (_, input, want) => {
    expect(shown(githubFact(input))).toEqual(want);
    // origin's URL is never said: it may carry a login
    expect(JSON.stringify(githubFact(input))).not.toContain('secret');
  });
});

const S3 = 'package.json:3 @aws-sdk/client-s3';
const SIGNED_IN = { state: 'ok', fix: 'abe login aws --profile shop-test' };

describe("the cloud: the platform Terraform's profile when Connected, the app's aws login on Just this Mac", () => {
  test.each<[string, Parameters<typeof cloudFact>[0], Shown]>([
    [
      'Local only, the repo uses no aws: not needed',
      { kind: 'local', profile: 'shop-test', region: null, needs: [], login: SIGNED_IN },
      ['skipped', [], 'not needed: nothing in the repo uses aws', null],
    ],
    [
      'Local only, the repo uses aws: why, the profile logins: names, signed in',
      { kind: 'local', profile: 'shop-test', region: null, needs: [S3], login: SIGNED_IN },
      ['ok', [`Needed by ${S3}`, 'Profile shop-test', 'Login signed in'], null, null],
    ],
    [
      'Local only, an abe-* profile: its account too',
      {
        kind: 'local',
        profile: 'abe-shop',
        region: null,
        account: { account: '123456789012' },
        needs: [S3, 'cdk.json'],
        login: { state: 'ok', fix: 'abe login aws --profile abe-shop' },
      },
      [
        'ok',
        [
          `Needed by ${S3} and 1 more`,
          'Profile abe-shop',
          'Login signed in',
          'Account 123456789012',
        ],
        null,
        null,
      ],
    ],
    [
      'Local only, not signed in',
      {
        kind: 'local',
        profile: 'shop-test',
        region: null,
        needs: [S3],
        login: { state: 'missing', fix: 'abe login aws --profile shop-test' },
      },
      [
        'failed',
        [`Needed by ${S3}`, 'Profile shop-test', 'Login missing'],
        'aws missing',
        'abe login aws --profile shop-test',
      ],
    ],
    [
      'Local only, no profile and Logins never checked it',
      { kind: 'local', profile: null, region: null, needs: [S3], login: null },
      [
        'failed',
        [`Needed by ${S3}`, 'Profile none in logins:'],
        'aws was not checked',
        'abe login aws',
      ],
    ],
    [
      'Local only, you skipped which profile: not checked, nothing failed',
      {
        kind: 'local',
        profile: null,
        region: null,
        needs: [S3],
        login: { state: 'skipped', fix: 'abe login aws' },
      },
      [
        'skipped',
        [`Needed by ${S3}`, 'Profile none in logins:'],
        'not checked: you skipped which aws profile it uses',
        null,
      ],
    ],
    [
      'the profile, its account and region',
      {
        kind: 'cloud',
        profile: 'abe-tooling',
        region: 'eu-west-1',
        account: { account: '123456789012' },
      },
      ['ok', ['Profile abe-tooling', 'Account 123456789012', 'Region eu-west-1'], null, null],
    ],
    [
      'no profile: the platform Terraform sets it up',
      { kind: 'cloud', profile: null, region: 'eu-west-1' },
      ['failed', [], 'no box.profile', 'set up by the platform Terraform (infra/aws)'],
    ],
    [
      'a profile that is not abe-*',
      { kind: 'cloud', profile: 'prod-admin', region: 'eu-west-1' },
      [
        'failed',
        ['Profile prod-admin'],
        'prod-admin is no abe-* profile',
        'set up by the platform Terraform (infra/aws)',
      ],
    ],
    [
      'aws cannot say who it is',
      {
        kind: 'cloud',
        profile: 'abe-tooling',
        region: 'eu-west-1',
        account: { cannot: 'expired' },
      },
      [
        'failed',
        ['Profile abe-tooling', 'Region eu-west-1'],
        'expired',
        'abe login aws --profile abe-tooling',
      ],
    ],
  ])('%s', (_, input, want) => {
    expect(shown(cloudFact(input))).toEqual(want);
  });
});

describe('a source: its MCP server for you and, connected, the account it told', () => {
  test.each<[string, Pick<Parameters<typeof sourceFact>[0], 'state' | 'account' | 'probe'>, Shown]>(
    [
      ['connected', { state: 'connected' }, ['ok', ['MCP server sentry: connected'], null, null]],
      // ADR 0027: the probe's one read
      [
        'connected, its one read ok',
        { state: 'connected', probe: 'ok' },
        ['ok', ['MCP server sentry: connected', 'Read one read ok'], null, null],
      ],
      [
        "signed in, the account can't read",
        { state: 'connected', probe: 'tool-error', account: { org: 'acme' } },
        [
          'failed',
          ['Org acme', 'MCP server sentry: connected', 'Read its one read gave an error'],
          "sentry is signed in, but the account can't read it",
          'abe source sign-in again, as an account that reads it',
        ],
      ],
      [
        'no sign-in told, its one read an error',
        { state: 'connected', probe: 'tool-error' },
        [
          'failed',
          ['MCP server sentry: connected', 'Read its one read gave an error'],
          'sentry answers, but its one read gave an error',
          "check sentry's server, then abe install connection",
        ],
      ],
      [
        'connected, no answer in time',
        { state: 'connected', probe: 'timeout' },
        [
          'warning',
          ['MCP server sentry: connected', 'Read no answer in time'],
          'sentry gave no answer to its one read in time',
          'abe install connection',
        ],
      ],
      [
        'connected, its org and project told',
        { state: 'connected', account: { org: 'acme', project: 'shop-web' } },
        ['ok', ['Org acme', 'Project shop-web', 'MCP server sentry: connected'], null, null],
      ],
      [
        'connected, all three told',
        { state: 'connected', account: { project: 'web', account: 'ann', org: 'acme' } },
        [
          'ok',
          ['Account ann', 'Org acme', 'Project web', 'MCP server sentry: connected'],
          null,
          null,
        ],
      ],
      [
        'connected, none told',
        { state: 'connected', account: {} },
        ['ok', ['MCP server sentry: connected'], null, null],
      ],
      [
        'needs-auth',
        { state: 'needs-auth' },
        [
          'failed',
          ['MCP server sentry: needs-auth'],
          'sentry needs you to sign in',
          '/mcp in Claude Code: sign in to sentry',
        ],
      ],
      [
        'none',
        { state: 'none' },
        [
          'failed',
          ['MCP server sentry: none'],
          'you have no MCP server sentry',
          'claude mcp add sentry …',
        ],
      ],
    ],
  )('%s', (_, input, want) => {
    expect(shown(sourceFact({ id: 'sentry', name: 'Sentry', mcp: 'sentry', ...input }))).toEqual(
      want,
    );
  });
});

describe("an environment's credentials: its aws profile and Abe env file, key names only", () => {
  test.each<[string, Parameters<typeof credentialsFact>[0], Shown]>([
    [
      'a profile and an Abe env file',
      {
        env: 'dev',
        profile: 'shop-dev',
        envFile: { file: '.abe/abe.dev.env', keys: ['API_URL', 'API_KEY'] },
      },
      ['ok', ['aws profile shop-dev', '.abe/abe.dev.env API_URL, API_KEY'], null, null],
    ],
    [
      'an Abe env file alone',
      { env: 'test', profile: null, envFile: { file: '.abe/abe.test.env', keys: [] } },
      ['ok', ['aws profile none', '.abe/abe.test.env no keys'], null, null],
    ],
    [
      'an expired login: failed, its sign-in named',
      {
        env: 'dev',
        profile: 'shop-dev',
        account: { cannot: 'shop-dev gave no credentials (its login expired?)' },
        envFile: null,
      },
      [
        'failed',
        ['aws profile shop-dev'],
        'shop-dev gave no credentials (its login expired?)',
        'abe login aws --profile shop-dev',
      ],
    ],
  ])('%s', (_, input, want) => {
    expect(shown(credentialsFact(input))).toEqual(want);
  });
});
