import { describe, expect, test } from 'bun:test';
import {
  type AzureBoard,
  azureBoardOf,
  azureRemoteOf,
  type BoardHint,
  boardHintsIn,
  withOriginHint,
} from './install-board-hints';

describe('azureRemoteOf: an Azure DevOps remote names an organization and project', () => {
  test.each<[string, string | undefined, string | null]>([
    ['https://dev.azure.com/acme/Shop/_git/web', 'https://dev.azure.com/acme', 'Shop'],
    ['https://ann@dev.azure.com/acme/Shop/_git/web', 'https://dev.azure.com/acme', 'Shop'],
    ['https://dev.azure.com/acme/My%20Shop/_git/web', 'https://dev.azure.com/acme', 'My Shop'],
    ['git@ssh.dev.azure.com:v3/acme/Shop/web', 'https://dev.azure.com/acme', 'Shop'],
    ['https://acme.visualstudio.com/Shop/_git/web', 'https://dev.azure.com/acme', 'Shop'],
    [
      'https://acme.visualstudio.com/DefaultCollection/Shop/_git/web',
      'https://dev.azure.com/acme',
      'Shop',
    ],
    ['https://github.com/acme/web.git', undefined, null],
    ['git@github.com:acme/web.git', undefined, null],
    ['https://dev.azure.com.evil.example/acme/Shop/_git/web', undefined, null],
  ])('%s', (remote, organization, project) => {
    expect(azureRemoteOf(remote)).toEqual(
      organization === undefined ? undefined : { organization, project },
    );
  });
});

const ACME = 'https://dev.azure.com/acme';

describe('azureBoardOf: any Azure Boards URL names its organization, project and team', () => {
  test.each<[string, string, AzureBoard | undefined]>([
    [
      'a team board',
      'https://dev.azure.com/acme/Shop/_boards/board/t/Web/Stories',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    [
      'a team board, its names encoded',
      'https://dev.azure.com/acme/Web%20Shop/_boards/board/t/Web%20Team/Backlog%20items',
      { organization: ACME, project: 'Web Shop', team: 'Web Team' },
    ],
    [
      'a team board with no level',
      'https://dev.azure.com/acme/Shop/_boards/board/t/Web',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    [
      'a backlog',
      'https://dev.azure.com/acme/Shop/_backlogs/backlog/Web/Stories',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    [
      'a sprint taskboard',
      'https://dev.azure.com/acme/Shop/_sprints/taskboard/Web/Shop/Sprint%209',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    [
      'a query: no team',
      'https://dev.azure.com/acme/Shop/_queries/query/1f2e3d4c-0000-4000-8000-000000000000/',
      { organization: ACME, project: 'Shop', team: null },
    ],
    [
      'a work item: no team',
      'https://dev.azure.com/acme/Shop/_workitems/edit/1234',
      { organization: ACME, project: 'Shop', team: null },
    ],
    [
      'a signed-in link with a query string',
      'https://ann@dev.azure.com/acme/Shop/_boards/board/t/Web/Stories?workitem=12#x',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    [
      'an older link, the team in its path',
      'https://acme.visualstudio.com/Shop/Web/_backlogs/board/Stories',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    [
      'an older link with its collection',
      'https://acme.visualstudio.com/DefaultCollection/Shop/_boards/board/t/Web',
      { organization: ACME, project: 'Shop', team: 'Web' },
    ],
    ['an organization alone is no board', 'https://dev.azure.com/acme', undefined],
    ['an API path is no board', 'https://dev.azure.com/acme/_apis/wit', undefined],
    ['a package feed is no board', 'https://pkgs.dev.azure.com/acme/_packaging', undefined],
    ['another host', 'https://dev.azure.com.evil.example/acme/Shop/_boards/board/t/Web', undefined],
    ['GitHub', 'https://github.com/acme/shop', undefined],
  ])('%s', (_, url, want) => {
    expect(azureBoardOf(url)).toEqual(want);
  });
});

const hint = (h: Partial<BoardHint> & Pick<BoardHint, 'provider' | 'name' | 'why'>): BoardHint => ({
  organization: null,
  project: null,
  team: null,
  url: null,
  ...h,
});

describe('boardHintsIn: the boards the agent files, README, docs and CI name', () => {
  test.each<[string, Record<string, string>, BoardHint[]]>([
    ['nothing named', { 'README.md': '# Shop\nSee GitHub.\n' }, []],
    [
      "a team board link in the repo's CLAUDE.md",
      {
        'CLAUDE.md':
          '# Shop\n\nCards: https://dev.azure.com/acme/Shop/_boards/board/t/Web/Stories\n',
      },
      [
        hint({
          provider: 'azure-boards',
          name: 'Shop/Web',
          organization: ACME,
          project: 'Shop',
          team: 'Web',
          url: 'https://dev.azure.com/acme/Shop/_boards/board/t/Web/Stories',
          why: 'CLAUDE.md:3',
        }),
      ],
    ],
    [
      'a visualstudio.com link in CI',
      {
        '.github/workflows/ci.yml':
          'env:\n  BOARD: https://acme.visualstudio.com/Shop/_workitems/edit/7\n',
      },
      [
        hint({
          provider: 'azure-boards',
          name: 'Shop',
          organization: ACME,
          project: 'Shop',
          url: 'https://acme.visualstudio.com/Shop/_workitems/edit/7',
          why: '.github/workflows/ci.yml:2',
        }),
      ],
    ],
    [
      'an org alone, in Azure Pipelines',
      { 'azure-pipelines.yml': 'variables:\n  ORG: https://dev.azure.com/acme\n' },
      [
        hint({
          provider: 'azure-boards',
          name: 'acme',
          organization: ACME,
          url: 'https://dev.azure.com/acme',
          why: 'azure-pipelines.yml:2',
        }),
      ],
    ],
    [
      "a work item and the project's team board: one hint, with its team",
      {
        'README.md': 'Story: https://dev.azure.com/acme/Shop/_workitems/edit/12\n',
        'docs/board.md': 'Board: https://dev.azure.com/acme/Shop/_boards/board/t/Web\n',
      },
      [
        hint({
          provider: 'azure-boards',
          name: 'Shop/Web',
          organization: ACME,
          project: 'Shop',
          team: 'Web',
          url: 'https://dev.azure.com/acme/Shop/_boards/board/t/Web',
          why: 'docs/board.md:1',
        }),
      ],
    ],
    [
      'the agent files first, then the README',
      {
        'README.md': 'https://dev.azure.com/other/Old/_boards/board/t/Old\n',
        'AGENTS.md': 'https://dev.azure.com/acme/Shop/_boards/board/t/Web\n',
      },
      [
        hint({
          provider: 'azure-boards',
          name: 'Shop/Web',
          organization: ACME,
          project: 'Shop',
          team: 'Web',
          url: 'https://dev.azure.com/acme/Shop/_boards/board/t/Web',
          why: 'AGENTS.md:1',
        }),
        hint({
          provider: 'azure-boards',
          name: 'Old/Old',
          organization: 'https://dev.azure.com/other',
          project: 'Old',
          team: 'Old',
          url: 'https://dev.azure.com/other/Old/_boards/board/t/Old',
          why: 'README.md:1',
        }),
      ],
    ],
    [
      'an org and a project said in prose, in an agent file about Azure DevOps',
      { 'CLAUDE.md': '# Shop\n\n## Azure DevOps Work Items\n\nOrg: "acme", project: "Web Shop"\n' },
      [
        hint({
          provider: 'azure-boards',
          name: 'Web Shop',
          organization: ACME,
          project: 'Web Shop',
          why: 'CLAUDE.md:5',
        }),
      ],
    ],
    [
      'an az command with --org and --project',
      {
        'AGENTS.md':
          'Read a card: az boards work-item show --id 7 --org acme --project "Web Shop"\n',
      },
      [
        hint({
          provider: 'azure-boards',
          name: 'Web Shop',
          organization: ACME,
          project: 'Web Shop',
          why: 'AGENTS.md:1',
        }),
      ],
    ],
    [
      'an org named in a file that never mentions Azure DevOps is none',
      { 'CLAUDE.md': 'Org: "acme", project: "Web Shop" on GitHub.\n' },
      [],
    ],
    [
      'a project said in prose and linked too: the link',
      {
        'CLAUDE.md': 'Azure DevOps\nOrg: "acme", project: "Shop"\n',
        'README.md': 'Board: https://dev.azure.com/acme/Shop/_boards/board/t/Web\n',
      },
      [
        hint({
          provider: 'azure-boards',
          name: 'Shop/Web',
          organization: ACME,
          project: 'Shop',
          team: 'Web',
          url: 'https://dev.azure.com/acme/Shop/_boards/board/t/Web',
          why: 'README.md:1',
        }),
      ],
    ],
    [
      'a GitHub project, an org’s and a user’s',
      {
        'README.md':
          'Plan: https://github.com/orgs/acme/projects/7\nMine: https://github.com/users/ann/projects/2/views/1\n',
      },
      [
        hint({
          provider: 'github-projects',
          name: 'acme/7',
          url: 'https://github.com/orgs/acme/projects/7',
          why: 'README.md:1',
        }),
        hint({
          provider: 'github-projects',
          name: 'ann/2',
          url: 'https://github.com/users/ann/projects/2/views/1',
          why: 'README.md:2',
        }),
      ],
    ],
    [
      'a Jira issue and its board: one project',
      {
        'CLAUDE.md':
          'See https://acme.atlassian.net/browse/SHOP-12\nBoard https://acme.atlassian.net/jira/software/c/projects/SHOP/boards/3\n',
      },
      [
        hint({
          provider: 'jira',
          name: 'SHOP',
          organization: 'https://acme.atlassian.net',
          project: 'SHOP',
          url: 'https://acme.atlassian.net/browse/SHOP-12',
          why: 'CLAUDE.md:1',
        }),
      ],
    ],
  ])('%s', (_, files, want) => {
    expect(boardHintsIn(new Map(Object.entries(files)))).toEqual(want);
  });
});

describe("withOriginHint: origin's board, Azure DevOps' first, GitHub's issues last", () => {
  const linked: BoardHint = {
    provider: 'jira',
    name: 'SHOP',
    organization: 'https://acme.atlassian.net',
    project: 'SHOP',
    team: null,
    url: 'https://acme.atlassian.net/browse/SHOP-1',
    why: 'README.md:1',
  };

  test.each<[string, string | undefined, string[]]>([
    ['no origin', undefined, ['jira SHOP']],
    [
      'an Azure DevOps origin',
      'https://dev.azure.com/acme/Shop/_git/web',
      ['azure-boards Shop', 'jira SHOP'],
    ],
    ['a GitHub origin', 'git@github.com:acme/shop.git', ['jira SHOP', 'github-issues acme/shop']],
    ['any other origin', 'https://git.example.test/acme/shop.git', ['jira SHOP']],
  ])('%s', (_, origin, hints) => {
    expect(withOriginHint([linked], origin).map((h) => `${h.provider} ${h.name}`)).toEqual(hints);
  });
});
