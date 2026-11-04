import { describe, expect, test } from 'bun:test';
import {
  adoErrorCode,
  assignTarget,
  type BoardMember,
  boardColumnsOf,
  type BoardErrorCode,
  boardOf,
  cardDescription,
  cardListText,
  type CardListData,
  cardsQuery,
  DONE_DAYS,
  isMarkdownFormat,
  LOCAL_BOARD,
  membersInOrder,
  organizationOf,
  parseCardId,
  boardCardName,
  type BoardRef,
  parseTags,
  retag,
  tagsField,
  tagsWrite,
  type TagsWrite,
  teamAreas,
} from './board';

describe('organizationOf: an Azure DevOps organization URL, as dev.azure.com names it', () => {
  test.each([
    ['https://dev.azure.com/demo-org', 'https://dev.azure.com/demo-org'],
    ['https://dev.azure.com/demo-org/', 'https://dev.azure.com/demo-org'],
    ['https://demo-org.visualstudio.com', 'https://dev.azure.com/demo-org'],
    ['https://demo-org.visualstudio.com/', 'https://dev.azure.com/demo-org'],
    ['https://DEV.azure.com/Demo', 'https://dev.azure.com/Demo'],
  ])('%s', (text, url) => {
    expect(organizationOf(text)).toEqual(url);
  });

  test.each([
    'http://dev.azure.com/demo-org',
    'https://dev.azure.com/',
    'https://dev.azure.com/a/b',
    'https://evil.example/demo-org',
    'https://dev.azure.com.evil.example/demo-org',
    'https://dev.azure.com/demo?x=1',
    'dev.azure.com/demo-org',
    '',
  ])('%s is refused: a token goes to Azure DevOps only', (text) => {
    expect(organizationOf(text)).toBeUndefined();
  });
});

describe('boardOf reads the merged board setting', () => {
  const full = { organization: 'https://dev.azure.com/demo', project: 'Shop', team: 'Web' };

  test('organization, project and team; the card types default to stories and bugs', () => {
    expect(boardOf(full)).toEqual({
      ok: true,
      board: {
        organization: 'https://dev.azure.com/demo',
        project: 'Shop',
        team: 'Web',
        types: ['User Story', 'Bug'],
      },
    });
  });

  test.each(['azure', 'azure-boards', 'Azure-DevOps', 'ado', ' azure boards '])(
    'provider %j is Azure',
    (provider) => {
      expect(boardOf({ ...full, provider })).toMatchObject({
        ok: true,
        board: { organization: 'https://dev.azure.com/demo', project: 'Shop' },
      });
    },
  );

  test.each(['github', 'GitHub Issues', 'github-issues', 'gh'])(
    'provider %j is the repo’s GitHub Issues: its repo, issue types, labels to keep or leave out',
    (provider) => {
      expect(boardOf({ provider, repo: 'acme/shop', tag: 'web', githubAccount: 'ada' })).toEqual({
        ok: true,
        board: {
          provider: 'github',
          repo: 'acme/shop',
          organization: 'https://github.com/acme',
          project: 'acme/shop',
          team: 'Issues',
          types: ['Issue', 'Bug'],
          githubAccount: 'ada',
          tag: 'web',
        },
      });
    },
  );

  test('area and tag: which cards of a shared board are this repo’s', () => {
    expect(boardOf({ ...full, area: 'Shop\\Auth', tag: 'auth' })).toMatchObject({
      ok: true,
      board: { area: 'Shop\\Auth', tag: 'auth' },
    });
    expect(boardOf(full)).not.toHaveProperty('board.area');
  });

  test('excludeLanes and notTag: the cards a repo leaves out, a lane as a list of one', () => {
    expect(
      boardOf({ ...full, excludeLanes: ['External dependencies', 'Ops'], notTag: 'blocked' }),
    ).toMatchObject({
      ok: true,
      board: { excludeLanes: ['External dependencies', 'Ops'], notTag: 'blocked' },
    });
    expect(boardOf({ ...full, excludeLanes: 'External dependencies' })).toMatchObject({
      ok: true,
      board: { excludeLanes: ['External dependencies'] },
    });
    expect(boardOf(full)).not.toHaveProperty('board.excludeLanes');
    expect(boardOf(full)).not.toHaveProperty('board.notTag');
  });

  test('types from the setting; other keys (columns) are not the port’s', () => {
    expect(boardOf({ ...full, types: ['Product Backlog Item'], columns: ['a'] })).toMatchObject({
      ok: true,
      board: { types: ['Product Backlog Item'] },
    });
  });

  test.each([
    [{}, 'no-board', 'organization, project and team'],
    [{ organization: full.organization, project: 'Shop' }, 'no-board', 'board.team'],
    [{ ...full, organization: 'https://example.test/x' }, 'bad-board', 'board.organization'],
    [{ ...full, provider: 'github' }, 'no-board', 'board.repo'],
    [{ provider: 'github', repo: 'acme' }, 'bad-board', 'board.repo'],
    [{ provider: 'github', repo: 'acme/shop', area: 'Shop' }, 'bad-board', 'Azure Boards only'],
    [
      { provider: 'github', repo: 'acme/shop', excludeLanes: ['Ops'] },
      'bad-board',
      'board.excludeLanes',
    ],
    [{ ...full, provider: 'jira' }, 'bad-board', 'jira has no cards in Abe yet'],
    [
      { ...full, provider: 'github-projects' },
      'bad-board',
      'github-projects has no cards in Abe yet',
    ],
    [{ ...full, provider: 'trello' }, 'bad-board', 'only azure, local and github have cards'],
    [{ ...full, types: [] }, 'bad-board', 'board.types'],
    [{ ...full, area: 3 }, 'bad-board', 'board.area'],
    [{ ...full, tag: '' }, 'bad-board', 'board.tag'],
    [{ ...full, excludeLanes: [''] }, 'bad-board', 'board.excludeLanes'],
    [{ ...full, excludeLanes: [] }, 'bad-board', 'board.excludeLanes'],
    [{ ...full, notTag: 3 }, 'bad-board', 'board.notTag'],
  ] satisfies [object, BoardErrorCode, string][])('%j → %s', (board, code, says) => {
    const got = boardOf(board);

    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error.code).toBe(code);
    expect(got.error.message).toContain(says);
  });
});

describe('parseCardId', () => {
  test.each([
    ['4', 4],
    ['AB#4', 4],
    ['ab#12', 12],
    ['#7', 7],
    ['L-3', 3],
    ['l-3', 3],
  ])('%s', (text, id) => {
    expect(parseCardId(text)).toBe(id);
  });

  test.each(['0', '-1', 'x', '4x', '1.5', 'AB#', 'AB4', 'L-', 'L-0', 'AB#L-3', ''])(
    '%s is no card id',
    (text) => {
      expect(parseCardId(text)).toBeUndefined();
    },
  );
});

describe("a card's name where people and GitHub read it", () => {
  const rows: [string, Pick<BoardRef, 'provider'>, string][] = [
    ['Azure Boards: GitHub links it to the card', {}, 'AB#4'],
    [
      "on this machine: nothing GitHub links (AB#4 is Azure's card 4)",
      { provider: 'local' },
      'L-4',
    ],
    ['a GitHub board: the issue itself', { provider: 'github' }, '#4'],
  ];

  test.each(rows)('%s', (_, board, name) => {
    expect(boardCardName(4, board)).toBe(name);
  });
});

describe('tags, as Azure Boards keeps them: one field, `; ` between', () => {
  test.each([
    [undefined, []],
    ['', []],
    ['web', ['web']],
    ['auth; web', ['auth', 'web']],
    [' auth ;web; ', ['auth', 'web']],
  ])('%j', (field, tags) => {
    expect(parseTags(field)).toEqual(tags);
  });

  test('written back', () => {
    expect(tagsField(['auth', 'web'])).toBe('auth; web');
  });

  test.each([
    [['web'], { add: ['needs-info'], remove: [] }, ['web', 'needs-info']],
    [['web'], { add: ['Web'], remove: [] }, ['web']],
    [['web', 'auth'], { add: [], remove: ['WEB'] }, ['auth']],
    [['web'], { add: ['a', 'a'], remove: [] }, ['web', 'a']],
    [['web'], { add: [], remove: ['none'] }, ['web']],
    [['web'], { add: ['x'], remove: ['web'] }, ['x']],
  ])('%j %j → %j (case does not matter, as on the board)', (tags, change, out) => {
    expect(retag(tags, change)).toEqual(out);
  });
});

describe('tagsWrite: what a tag change writes over the tags read', () => {
  test.each([
    ['web', { add: ['web'], remove: [] }, { write: 'none' }],
    ['web', { add: ['WEB'], remove: ['none'] }, { write: 'none' }],
    [undefined, { add: [], remove: ['web'] }, { write: 'none' }],
    ['web', { add: ['auth'], remove: [] }, { write: 'set', field: 'web; auth' }],
    ['auth; web', { add: [], remove: ['Auth'] }, { write: 'set', field: 'web' }],
    ['web', { add: [], remove: ['web'] }, { write: 'clear' }],
  ] satisfies [string | undefined, Parameters<typeof tagsWrite>[1], TagsWrite][])(
    '%j %j → %j',
    (field, change, write) => {
      expect(tagsWrite(field, change)).toEqual(write);
    },
  );
});

describe('isMarkdownFormat: how Azure keeps a long field or a comment', () => {
  test.each([
    ['markdown', true],
    ['Markdown', true],
    ['html', false],
    [undefined, false],
  ])('%j → %j', (format, markdown) => {
    expect(isMarkdownFormat(format)).toBe(markdown);
  });
});

describe('cardDescription: a bug without a description shows its repro steps', () => {
  test.each([
    ['Why', 'Steps', 'Why'],
    ['', 'Steps', 'Steps'],
    ['Why', '', 'Why'],
    ['', '', ''],
  ])('%j, repro %j → %j', (description, repro, out) => {
    expect(cardDescription(description, repro)).toBe(out);
  });
});

describe('teamAreas: a team’s field values are its areas only when its board is cut by area', () => {
  const values = [
    { value: 'Shop\\Web', includeChildren: true },
    { value: 'Shop\\Ops', includeChildren: false },
  ];

  test.each([
    [
      'System.AreaPath',
      [
        { path: 'Shop\\Web', includeChildren: true },
        { path: 'Shop\\Ops', includeChildren: false },
      ],
    ],
    ['Custom.Team', []],
  ])('%s', (field, areas) => {
    expect(teamAreas(field, values)).toEqual(areas);
  });
});

describe('cardsQuery: the WIQL of a board’s open cards', () => {
  const base = { types: ['User Story', 'Bug'], areas: [], mine: false };

  test('its types, open, newest change first', () => {
    expect(cardsQuery(base)).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') AND [System.State] NOT IN ('Removed', 'Closed', 'Done') ORDER BY [System.ChangedDate] DESC",
    );
  });

  test('the team’s areas, with or without their sub-areas, and mine', () => {
    const q = cardsQuery({
      ...base,
      areas: [
        { path: 'Shop\\Web', includeChildren: true },
        { path: "Shop\\Ops'", includeChildren: false },
      ],
      mine: true,
    });

    expect(q).toContain(
      "AND ([System.AreaPath] UNDER 'Shop\\Web' OR [System.AreaPath] = 'Shop\\Ops''') AND [System.AssignedTo] = @Me ORDER BY",
    );
  });

  test('a shared board’s cards that are this repo’s: under its area path, carrying its tag', () => {
    expect(cardsQuery({ ...base, area: "Shop\\Auth's", tag: 'auth' })).toContain(
      "AND [System.AreaPath] UNDER 'Shop\\Auth''s' AND [System.Tags] CONTAINS 'auth' ORDER BY",
    );
  });

  test('lanes left out, a card in no lane kept; a tag left out', () => {
    expect(
      cardsQuery({
        ...base,
        excludeLanes: ['External dependencies', "Ops' lane"],
        notTag: "won't",
      }),
    ).toContain(
      "AND ([System.BoardLane] NOT IN ('External dependencies', 'Ops'' lane') OR [System.BoardLane] = '') AND [System.Tags] NOT CONTAINS 'won''t' ORDER BY",
    );
  });

  test('several area paths: under any of them', () => {
    expect(cardsQuery({ ...base, area: ['Shop\\Web', 'Shop\\API'] })).toContain(
      "AND ([System.AreaPath] UNDER 'Shop\\Web' OR [System.AreaPath] UNDER 'Shop\\API') ORDER BY",
    );
  });

  test('a sprint: its iteration and the ones under it', () => {
    expect(cardsQuery({ ...base, mine: true, iteration: "Shop\\Sprint 4's" })).toContain(
      "AND [System.AssignedTo] = @Me AND [System.IterationPath] UNDER 'Shop\\Sprint 4''s' ORDER BY",
    );
  });
});

describe('cardsQuery with done cards (#239): the sprint’s, else the last days’; Removed never', () => {
  const base = { types: ['User Story'], areas: [], mine: false };
  const open = "[System.State] NOT IN ('Removed', 'Closed', 'Done')";

  test('a sprint’s done cards beside the open ones', () => {
    expect(cardsQuery({ ...base, done: { iteration: "Shop\\Sprint 4's" } })).toContain(
      `AND (${open} OR ([System.State] IN ('Closed', 'Done') AND [System.IterationPath] UNDER 'Shop\\Sprint 4''s')) ORDER BY`,
    );
  });

  test('no sprint: those changed in the last days', () => {
    expect(cardsQuery({ ...base, mine: true, done: { days: DONE_DAYS } })).toContain(
      `AND (${open} OR ([System.State] IN ('Closed', 'Done') AND [System.ChangedDate] >= @Today - 14)) AND [System.AssignedTo] = @Me ORDER BY`,
    );
  });
});

describe('adoErrorCode: an Azure DevOps answer → the error code a client reads', () => {
  test.each([
    [401, '', 'auth'],
    [403, '', 'auth'],
    [203, '<html>sign in</html>', 'auth'],
    [404, 'TF401232: Work item 99 does not exist', 'not-found'],
    [412, '', 'conflict'],
    [400, 'TF26071: This work item has been changed by someone else', 'conflict'],
    [400, "TF401320: Rule Error for field State. 'Nope' is not a state", 'rejected'],
    [500, '', 'ado-failed'],
  ] satisfies [number, string, BoardErrorCode][])('%d %s → %s', (status, message, code) => {
    expect(adoErrorCode(status, message)).toBe(code);
  });
});

describe("boardColumnsOf: the states a Factory run moves its card to, the Agile process's by default", () => {
  test.each<[string, unknown, { active: string; done: string; new: string }]>([
    ['none set', {}, { active: 'Active', done: 'Closed', new: 'New' }],
    ['no board at all', undefined, { active: 'Active', done: 'Closed', new: 'New' }],
    [
      'the team names its own',
      { active: 'Doing', done: 'Resolved', new: 'To Do' },
      { active: 'Doing', done: 'Resolved', new: 'To Do' },
    ],
    ['one of them', { done: 'Done' }, { active: 'Active', done: 'Done', new: 'New' }],
    [
      'blank or not a name: the default',
      { active: '', done: 7, new: ' ' },
      { active: 'Active', done: 'Closed', new: 'New' },
    ],
  ])('%s', (_, setting, columns) => {
    expect(boardColumnsOf(setting)).toEqual(columns);
  });
});

describe('cardListText: the board and its sprint, then a row a card (#187)', () => {
  const card = {
    id: 4,
    title: 'Cart total',
    state: 'Active',
    type: 'User Story',
    tags: [],
    assignee: null,
    description: '',
    acceptanceCriteria: '',
    url: 'https://dev.azure.com/o/Shop/_workitems/edit/4',
    points: null,
    createdBy: null,
  };
  const board = { organization: 'https://dev.azure.com/o', project: 'Shop', team: 'Web' };

  test('the sprint named in the head', () => {
    expect(cardListText({ board, mine: false, cards: [card], sprint: 'Sprint 4' })).toBe(
      'Shop / Web · Sprint 4\n\nAB#4      Active  Cart total\n',
    );
  });

  test('a board on this machine names its cards L-<id>, as their branch and pull request do', () => {
    const local: CardListData['board'] = { ...board, provider: LOCAL_BOARD };

    expect(cardListText({ board: local, mine: false, cards: [card], sprint: null })).toBe(
      'Shop / Web\n\nL-4       Active  Cart total\n',
    );
  });

  test('no sprint, no cards', () => {
    expect(cardListText({ board, mine: true, cards: [], sprint: null })).toBe(
      'no open cards of yours on Shop / Web\n',
    );
    expect(cardListText({ board, mine: false, cards: [], sprint: 'Sprint 4' })).toBe(
      'no open cards on Shop / Web · Sprint 4\n',
    );
  });
});

describe('the team’s members (B2): you first, then A–Z; whom card assign’s who names', () => {
  const m = (name: string, email: string, you = false): BoardMember => ({ name, email, you });
  const team = [
    m('sam Sample', 'sam@example.test'),
    m('Alex Example', 'alex@example.test', true),
    m('Åsa Ödman', 'asa@example.test'),
    m('Robin Placeholder', 'robin@example.test'),
    m('Robin Other', 'robin.o@other.test'),
  ];

  test('membersInOrder: you, then by name with case and accents aside', () => {
    expect(membersInOrder(team).map((x) => x.name)).toEqual([
      'Alex Example',
      'Åsa Ödman',
      'Robin Other',
      'Robin Placeholder',
      'sam Sample',
    ]);
  });

  test.each([
    ['me', { kind: 'me' }],
    ['ME', { kind: 'me' }],
    ['none', { kind: 'none' }],
    ['sam', { kind: 'member', login: 'sam@example.test' }],
    ['SAM@EXAMPLE.TEST', { kind: 'member', login: 'sam@example.test' }],
    ['robin placeholder', { kind: 'member', login: 'robin@example.test' }],
    ['robin.o', { kind: 'member', login: 'robin.o@other.test' }],
    // yourself by name or email is you
    ['alex', { kind: 'me' }],
    // an email not on the team as it is (an undo's assignee from another team)
    ['kim@example.test', { kind: 'member', login: 'kim@example.test' }],
  ])('%s → %o', (who, to) => {
    expect(assignTarget(who, team)).toMatchObject({ ok: true, to });
  });

  test('a name on no one is refused with the members; one fitting two names them', () => {
    const none = assignTarget('kim', team);

    expect(none.ok).toBe(false);
    if (!none.ok)
      expect(none.message).toBe(
        "'kim' is not on the team: alex@example.test, asa@example.test, robin.o@other.test, robin@example.test, sam@example.test",
      );
    const two = assignTarget('robin', [m('Robin', 'r1@x.test'), m('robin', 'r2@x.test')]);

    expect(two).toEqual({
      ok: false,
      message: "'robin' fits more than one member: r1@x.test, r2@x.test",
    });
  });
});
