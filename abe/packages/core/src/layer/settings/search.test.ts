/** `/` in the Settings dialog (#108): one matcher over every page, results grouped by page. */
import { describe, expect, test } from 'bun:test';
import {
  noMatch,
  pagesCorpus,
  searchSettings,
  searchSummary,
  type SearchItem,
  settingsCorpus,
  tokensCorpus,
} from './search';

const ids = (hits: ReturnType<typeof searchSettings>) =>
  hits.pages.map((p) => [p.page, p.items.map((i) => i.id)]);

describe('searchSettings', () => {
  test('matches labels, keys and help, grouped under their page, the page with most hits first', () => {
    const hits = searchSettings('box', [settingsCorpus()]);

    expect(ids(hits)[0]).toEqual([
      'boxes-cloud',
      [
        'limits.maxBoxesPerPerson',
        'box.size',
        'limits.maxBoxSize',
        'limits.maxBoxDisk',
        'box.idleMinutes',
        'box.waitingMinutes',
        'box.profile',
        'box.region',
        'box.owner',
        'stores.logs',
        'stores.org',
      ],
    ]);
    expect(hits.pages[0]?.label).toBe('Boxes & cloud');
    expect(hits.total).toBe(hits.pages.reduce((n, p) => n + p.items.length, 0));
    expect(hits.counts['boxes-cloud']).toBe(11);
  });

  test('a key name finds its row', () => {
    expect(ids(searchSettings('box.idleMinutes', [settingsCorpus()]))).toEqual([
      ['boxes-cloud', ['box.idleMinutes']],
    ]);
    expect(ids(searchSettings('ui.density', [settingsCorpus()]))).toEqual([
      ['appearance', ['ui.density']],
    ]);
  });

  test('matches the value in effect, case-insensitively, every word somewhere', () => {
    const values = new Map([['models.coordinator', 'opus']]);

    expect(ids(searchSettings('OPUS coord', [settingsCorpus(values)]))).toEqual([
      ['agents', ['models.coordinator']],
    ]);
  });

  test("a page's name finds its rows", () => {
    const hits = searchSettings('factory policy', [settingsCorpus()]);

    expect(hits.pages.map((p) => p.page)).toEqual(['factory-policy']);
    expect(hits.pages[0]?.items.map((i) => i.id)).toContain('autoMerge');
    // Local mode (#24): the page, its lines and the checkouts' row; its checkbox by the page
    const local = searchSettings('local mode', [pagesCorpus(), settingsCorpus()]);

    expect(local.pages[0]?.page).toBe('local-mode');
    expect(local.pages[0]?.items.map((i) => i.id)).toEqual([
      'local-mode',
      'local.reads',
      'local.writes',
      'local.agents',
      'local.off',
      'local.done',
      'localMode',
      'boardReadOnly',
    ]);
  });

  test('a page is found by its name, a page with no settings too (#152)', () => {
    const hits = searchSettings('Import', [pagesCorpus(), settingsCorpus()]);

    expect(ids(hits)).toEqual([['import-config', ['import-config']]]);
    expect(hits.pages[0]?.items[0]).toMatchObject({
      kind: 'page',
      label: 'Import config',
      help: 'Appearance & Behavior › Import config',
    });
    expect(hits.counts['import-config']).toBe(1);
    expect(searchSummary(hits)).toBe('Search · 1 result on 1 page');
  });

  test('a page is found by its own name, not its path; Problems is never a page hit', () => {
    expect(ids(searchSettings('box', [pagesCorpus()]))).toEqual([['boxes-cloud', ['boxes-cloud']]]);
    expect(searchSettings('problems', [pagesCorpus()]).total).toBe(0);
  });

  test('a setting is found once, on its home page (#345: a link row is no hit)', () => {
    const hits = searchSettings('ligatures', [settingsCorpus()]);

    expect(ids(hits)).toEqual([['editor-font', ['ui.font.ligatures']]]);
  });

  test('more corpora (Colours tokens) are searched beside the settings', () => {
    const tokens: SearchItem[] = [
      {
        page: 'appearance',
        id: 'abe-needs-you',
        kind: 'token',
        label: 'abe-needs-you',
        key: null,
        value: '#B589EC',
        help: '◆ Needs you: cards, tabs, rails, status bar',
      },
    ];
    const hits = searchSettings('needs', [settingsCorpus(), tokens]);

    expect(hits.pages.find((p) => p.page === 'appearance')?.items.map((i) => i.id)).toContain(
      'abe-needs-you',
    );
    expect(searchSummary(searchSettings('#B589EC', [settingsCorpus(), tokens]))).toBe(
      'Search · 1 result on 1 page',
    );
  });

  test('a row the dialog fills from elsewhere (Colours) is no setting hit (#299)', () => {
    // `colours` names Color scheme's Colours table
    expect(settingsCorpus().map((i) => i.id)).not.toContain('colours');
    // the page it is on is found by it: ⏎ opens Color scheme (#345); Changed files by its
    // choices' words (#325: Colours, Colours and letters)
    expect(ids(searchSettings('colours', [pagesCorpus(), settingsCorpus()]))).toEqual([
      ['editor-general', ['tree.decorations']],
      ['color-scheme', ['color-scheme']],
    ]);
    // a table a setting fills is drawn: still found
    expect(ids(searchSettings('view tweaks', [settingsCorpus()]))).toEqual([
      ['appearance', ['views']],
    ]);
  });

  test('a theme is found by its name while another is in force: `Islands Light` (#299)', () => {
    const values = new Map([['ui.theme', 'islands-dark']]);

    expect(ids(searchSettings('Islands Light', [settingsCorpus(values)]))).toEqual([
      ['appearance', ['ui.theme']],
      ['color-scheme', ['editor.scheme']],
    ]);
    // a combo by its choices too
    expect(ids(searchSettings('after delay', [settingsCorpus()]))).toEqual([
      ['editor-general', ['files.autoSave']],
    ]);
  });

  test('an empty query matches nothing; no match says so with a hint', () => {
    expect(searchSettings('  ', [settingsCorpus()])).toMatchObject({ total: 0, pages: [] });
    const none = searchSettings('xyz', [settingsCorpus()]);

    expect(none.total).toBe(0);
    expect(noMatch(none.query)).toEqual({
      text: 'No setting matches "xyz"',
      hint: 'Try a key name, like box.idleMinutes',
    });
  });

  test('the summary counts settings and pages', () => {
    expect(searchSummary(searchSettings('box', [settingsCorpus()]))).toMatch(
      /^Search · \d+ settings on \d+ pages$/,
    );
    expect(searchSummary(searchSettings('box.idleMinutes', [settingsCorpus()]))).toBe(
      'Search · 1 setting on 1 page',
    );
  });
});

describe('the Colours tokens (#345)', () => {
  const tokens = [
    {
      name: 'abe-needs-you',
      group: 'abe' as const,
      value: '#b589ec',
      was: null,
      usage: 'a card that needs you',
    },
    {
      name: 'editor-bg',
      group: 'editor' as const,
      value: '#1e1f22',
      was: null,
      usage: 'the editor',
    },
  ];

  test('`/` finds a token by its name, its hex or what it colours, on Editor › Color scheme', () => {
    const corpora = [settingsCorpus(), tokensCorpus(tokens)];

    for (const q of ['needs-you', 'needs you', '#b589ec', 'card that needs'])
      expect(ids(searchSettings(q, corpora)).find(([page]) => page === 'color-scheme')).toEqual([
        'color-scheme',
        ['abe-needs-you'],
      ]);
    expect(searchSettings('editor-bg', corpora).pages[0]?.items[0]).toMatchObject({
      kind: 'token',
      label: 'editor-bg',
      value: '#1e1f22',
    });
    expect(searchSummary(searchSettings('needs-you', corpora))).toContain('result');
    // never by its page's or group's name: `scheme` finds the Scheme row, not every token
    for (const q of ['scheme', 'color', 'abe status'])
      expect(
        searchSettings(q, corpora)
          .pages.flatMap((p) => p.items)
          .filter((i) => i.kind === 'token'),
      ).toEqual([]);
  });
});
