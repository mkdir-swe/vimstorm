/** The Settings dialog's catalogue (#108): the tree in order, each page's rows, every key on one page. */
import { describe, expect, test } from 'bun:test';
import {
  CONTROLS,
  homeRows,
  NO_ROW,
  openPage,
  pageOf,
  PAGES,
  rowOf,
  rowsOfKey,
  SETTINGS_TREE,
  type PageId,
  type TreeNode,
} from './pages';
import { settingKeys } from './keys';
import { controlFits, inputOf } from './input';

const flat = (nodes: readonly TreeNode[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.label}`, ...flat(n.children, depth + 1)]);

describe('the tree', () => {
  test("is Behaviour 2's, in order: Problems first, groups fold, Browser profiles under Boxes & cloud", () => {
    expect(flat(SETTINGS_TREE)).toEqual([
      'Problems',
      'Appearance & Behavior',
      '  Appearance',
      '  Import config',
      'Editor',
      '  General',
      '  Font',
      '  Color scheme',
      '  Vim',
      'Abe',
      '  Agents & models',
      '  Board & you',
      '  Boxes & cloud',
      '    Browser profiles',
      '  Factory policy',
      '  Local mode',
      '  Reach',
      'Logins & tools',
      'Tools check',
    ]);
  });

  test('a page with nothing in it is out of the tree (#345): Skills, Version control, Keymap, Layers', () => {
    const ids = PAGES.map((p) => p.id);

    for (const id of ['skills', 'version-control', 'keymap', 'layers'] as const)
      expect(ids).not.toContain(id);
    // Problems and Import config draw their own lines
    for (const id of ['problems', 'import-config'] as const) expect(ids).toContain(id);
  });

  test('Problems is shown only while there are any', () => {
    expect(SETTINGS_TREE[0]).toMatchObject({ page: 'problems', whileProblems: true });
    expect(SETTINGS_TREE.slice(1).every((n) => n.whileProblems !== true)).toBe(true);
  });

  test('a group with no page of its own opens its first child', () => {
    expect(openPage('appearance-behavior')).toBe('appearance');
    expect(openPage('editor')).toBe('editor-general');
    expect(openPage('abe')).toBe('agents');
    expect(openPage('boxes-cloud')).toBe('boxes-cloud');
  });

  test('every page has one node, and pages run in tree order', () => {
    const pages = (nodes: readonly TreeNode[]): PageId[] =>
      nodes.flatMap((n) => [...(n.page === null ? [] : [n.page]), ...pages(n.children)]);

    expect(PAGES.map((p) => p.id)).toEqual(pages(SETTINGS_TREE));
  });

  test("a page's crumb is its path in the tree", () => {
    expect(pageOf('appearance').crumb).toBe('Appearance & Behavior › Appearance');
    expect(pageOf('browser-profiles').crumb).toBe('Abe › Boxes & cloud › Browser profiles');
    expect(pageOf('logins-tools').crumb).toBe('Logins & tools');
    expect(pageOf('local-mode').crumb).toBe('Abe › Local mode');
  });
});

describe('the rows', () => {
  test('every setting has one home (#345): its rows on exactly one page, link rows only name it', () => {
    for (const key of settingKeys()) {
      const pages = new Set(rowsOfKey(key).map((r) => r.page));

      expect({ key, pages: pages.size }).toEqual({ key, pages: NO_ROW.includes(key) ? 0 : 1 });
    }
    expect(PAGES.flatMap((p) => p.rows).filter((r) => r.link !== null && r.key !== null)).toEqual(
      [],
    );
  });

  test('dark or light lives on Appearance › Theme alone; Color scheme has the editor scheme and Colours', () => {
    expect(rowsOfKey('ui.theme').map((r) => [r.page, r.control])).toEqual([
      ['appearance', 'preview'],
    ]);
    expect(rowsOfKey('editor.scheme').map((r) => [r.page, r.control])).toEqual([
      ['color-scheme', 'combo'],
    ]);
    expect(pageOf('color-scheme').rows.map((r) => r.id)).toEqual(['editor.scheme', 'colours']);
    expect(pageOf('appearance').rows.some((r) => r.id === 'colours')).toBe(false);
  });

  test('the editor font’s home is Editor › Font; Appearance links to it and to the scheme', () => {
    for (const key of ['ui.font.editorFamily', 'ui.font.editorSize', 'ui.font.ligatures'] as const)
      expect(rowsOfKey(key).map((r) => r.page)).toEqual(['editor-font']);
    expect(rowOf('editor-font-link')).toMatchObject({
      page: 'appearance',
      group: 'Font',
      control: 'link',
      key: null,
      link: { page: 'editor-font', row: 'ui.font.editorFamily' },
    });
    expect(rowOf('editor-scheme-link')).toMatchObject({
      page: 'appearance',
      group: 'Theme',
      link: { page: 'color-scheme', row: 'editor.scheme', keys: ['editor.scheme'] },
    });
  });

  test('rows that are not there (#345): the Chat width a drag overrules, Custom boxes', () => {
    expect(rowsOfKey('chat.width')).toEqual([]);
    expect(rowOf('custom-boxes')).toBeUndefined();
  });

  test('row ids are unique; a link names an existing home row', () => {
    const rows = PAGES.flatMap((p) => p.rows);

    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows.filter((x) => x.link !== null)) {
      const home = rowOf(r.link?.row ?? '');

      expect(home?.page).toBe(r.link?.page);
      expect(home?.link).toBeNull();
      expect(r.link?.keys.some((k) => k === home?.key)).toBe(true);
    }
  });

  test('home rows leave out link rows, so search and list see each setting once', () => {
    expect(homeRows().every((r) => r.link === null)).toBe(true);
    expect(homeRows().filter((r) => r.key === 'ui.font.ligatures')).toHaveLength(1);
  });

  test('each setting row’s control fits its schema (#345)', () => {
    for (const row of homeRows()) {
      if (row.key === null) continue;
      const input = inputOf(row.key, row.field);

      expect({
        row: row.id,
        input,
        control: row.control,
        fits: controlFits(row.control, input),
      }).toEqual({
        row: row.id,
        input,
        control: row.control,
        fits: true,
      });
    }
  });

  test('no known setting opens raw JSON; every closed choice and account is a dropdown', () => {
    expect(homeRows().filter((r) => r.control === 'advanced')).toEqual([]);
    const closed = homeRows().filter(
      (r) => r.key !== null && r.fixed === null && inputOf(r.key, r.field) === 'choice',
    );

    expect(closed.filter((r) => r.control !== 'combo' && r.control !== 'segmented')).toEqual([]);
    // id, where its choices come from, a name typed taken, none a value
    const ROWS: readonly [string, string | null, boolean, boolean][] = [
      ['logins.gh', 'gh-accounts', true, true],
      ['githubIdentity', 'gh-accounts', true, true],
      ['box.owner', 'gh-accounts', true, true],
      ['box.profile', 'aws-profiles', true, true],
      ['box.region', 'aws-regions', true, true],
      ['board#organization', 'azure-orgs', true, true],
      ['browser.default', 'browser-profiles', false, true],
      ['factory.done', 'environments', true, false],
      ['models.coordinator', null, false, false],
    ];

    for (const [id, known, free, clearable] of ROWS)
      expect(rowOf(id)).toMatchObject({ control: 'combo', known, free, clearable });
    expect([rowOf('views')?.control, rowOf('environments')?.control]).toEqual([
      'records',
      'records',
    ]);
  });

  test('controls are the WebStorm ones; a combo or segmented pick names its choices when fixed', () => {
    for (const r of PAGES.flatMap((p) => p.rows)) expect(CONTROLS).toContain(r.control);
    expect(rowOf('ui.density')).toMatchObject({
      control: 'segmented',
      choices: ['compact', 'default'],
      label: 'Density',
      help: 'Compact tightens rows, tabs and the toolbar',
    });
    expect(rowOf('effort')).toMatchObject({
      control: 'segmented',
      choices: ['low', 'medium', 'high'],
    });
    expect(rowOf('models.reader')).toMatchObject({
      page: 'agents',
      group: 'Models',
      control: 'combo',
      label: 'Reader',
      help: 'subagents that only read',
    });
  });

  test("session.mcp sits by the sandbox on Agents & models, saying a repo's own never load and MCP tools are outside Abe's fence", () => {
    expect(rowOf('session.mcp')).toMatchObject({
      page: 'agents',
      group: 'Sandbox',
      control: 'segmented',
      choices: ['yours', 'abe-only'],
      label: "Your MCP servers, never a repo's",
    });
    expect(rowOf('session.mcp')?.help).toContain(
      "a repo's own never load, in any session · MCP tools run outside the sandbox and aren't checked by Abe's fence",
    );
  });

  test('an object setting shows a row per field', () => {
    expect(rowsOfKey('board').map((r) => r.field)).toEqual([
      'provider',
      'repo',
      'organization',
      'project',
      'team',
      'types',
      'active',
      'done',
      'azureConfigDir',
    ]);
  });

  test('a row yours alone is never proposed: yours for the repo, or on this Mac (ADR 0030)', () => {
    for (const key of [
      'logins.gh',
      'agents.prod',
      'improve.suggest',
      'views',
      'localMode',
    ] as const)
      expect(rowsOfKey(key).every((r) => r.personalOnly)).toBe(true);
    expect(rowOf('environments')).toMatchObject({ personalOnly: false });
    expect(rowOf('autoMerge')).toMatchObject({ personalOnly: false });
  });

  test('a fixed row has no setting and says who fixed it', () => {
    expect(rowOf('agents.override-reason')).toMatchObject({
      key: null,
      label: 'Overrides require a reason',
      fixed: { by: 'built-in' },
    });
    expect(rowOf('agents.sandbox')).toMatchObject({
      key: null,
      fixed: { by: 'built-in', value: 'Local sandbox · auto mode · always' },
    });
    // agents read only the environments on for them: off is not reached, reads included
    expect(rowOf('reach.reads')).toMatchObject({
      key: null,
      label: 'Agents read',
      fixed: {
        by: 'built-in',
        value: 'only the environments on for them',
        why: 'off: not reached at all, reads included · Agents & models › Environments',
      },
    });
    // Local mode (#24, LM-Setting): this checkout's checkbox (filled from `abe local status`),
    // what it means as fixed lines, then the checkouts' home row
    expect(
      pageOf('local-mode').rows.map((r) => [r.id, r.label, r.control, r.key, r.fixed?.by ?? null]),
    ).toEqual([
      ['local.here', 'Local mode', 'checkbox', null, null],
      ['local.reads', 'Reads', 'text', null, 'built-in'],
      ['local.writes', 'Writes, held', 'text', null, 'built-in'],
      ['local.agents', 'Agents', 'text', null, 'built-in'],
      ['local.off', 'Turning it off', 'text', null, 'built-in'],
      ['local.done', 'Done', 'text', null, 'built-in'],
      ['localMode', 'Local mode checkouts', 'chips', 'localMode', null],
      ['boardReadOnly', 'Read-only board checkouts', 'chips', 'boardReadOnly', null],
    ]);
  });

  test('a page with no setting yet says so; Problems says it has none', () => {
    const said = (id: string) => (id === 'problems' ? 'No problems' : 'Nothing to set here yet');

    for (const p of PAGES)
      expect({ id: p.id, empty: p.empty }).toEqual({
        id: p.id,
        empty: p.rows.length === 0 ? said(p.id) : null,
      });
  });
});

describe('help (#345)', () => {
  test('every row’s help fits two lines of the narrowest value column (never cut)', () => {
    // the dialog's page is 752 wide less a label column of at most 280: two lines of 12 px text
    // hold about 120 characters
    const long = PAGES.flatMap((p) => p.rows)
      .filter((r) => r.help.length > 120)
      .map((r) => `${r.id}: ${r.help}`);
    expect(long).toEqual([]);
  });
});
