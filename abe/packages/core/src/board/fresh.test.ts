/** Fresh data's rules (#236): where a look starts, what it finds changed, the WIQL it sends. */
import { describe, expect, test } from 'bun:test';
import { cardsQuery, changedQuery } from './board';
import { changedSince, freshText, runsMoved, type Seen } from './fresh';
import { type PipelineRun } from './pipelines';

type Item = { key: string; at: string };
const of = (i: Item) => i;

describe('changedSince', () => {
  test.each<[string, Seen | undefined, Item[], string[], Seen]>([
    [
      'the first look changes nothing: it starts at the newest change',
      undefined,
      [
        { key: '7', at: '2026-10-25T10:00:00Z' },
        { key: '8', at: '2026-10-25T11:00:00Z' },
      ],
      [],
      { since: '2026-10-25T11:00:00Z', keys: ['8'] },
    ],
    [
      'a first look at an empty list starts before anything',
      undefined,
      [],
      [],
      { since: '', keys: [] },
    ],
    [
      'after an empty first look, the first item is new',
      { since: '', keys: [] },
      [{ key: '1', at: '2026-10-25T11:00:00Z' }],
      ['1'],
      { since: '2026-10-25T11:00:00Z', keys: ['1'] },
    ],
    [
      'nothing newer: nothing changed, the same start',
      { since: '2026-10-25T11:00:00Z', keys: ['8'] },
      [
        { key: '8', at: '2026-10-25T11:00:00Z' },
        { key: '7', at: '2026-10-25T10:00:00Z' },
      ],
      [],
      { since: '2026-10-25T11:00:00Z', keys: ['8'] },
    ],
    [
      'a newer change is found, and the next look starts there',
      { since: '2026-10-25T11:00:00Z', keys: ['8'] },
      [
        { key: '7', at: '2026-10-25T11:30:00Z' },
        { key: '8', at: '2026-10-25T11:00:00Z' },
      ],
      ['7'],
      { since: '2026-10-25T11:30:00Z', keys: ['7'] },
    ],
    [
      'another item changed in the same second as the last seen one is found once',
      { since: '2026-10-25T11:00:00Z', keys: ['8'] },
      [
        { key: '8', at: '2026-10-25T11:00:00Z' },
        { key: '9', at: '2026-10-25T11:00:00Z' },
      ],
      ['9'],
      { since: '2026-10-25T11:00:00Z', keys: ['8', '9'] },
    ],
  ])('%s', (_, seen, items, changed, next) => {
    const got = changedSince(seen, items, of);

    expect(got.changed.map((i) => i.key)).toEqual(changed);
    expect(got.seen).toEqual(next);
  });
});

describe('the WIQL', () => {
  test('what changed: the project and types only (any state, any area), after the last look, oldest first', () => {
    expect(changedQuery({ types: ['User Story', 'Bug'], since: '2026-10-25T11:00:00.123Z' })).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') AND [System.ChangedDate] > '2026-10-25T11:00:00.123Z' ORDER BY [System.ChangedDate] ASC",
    );
  });

  test('where to start: one card, the query’s asOf is the start', () => {
    expect(changedQuery({ types: ['Bug'] })).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Bug') ORDER BY [System.ChangedDate] DESC",
    );
  });

  test('which changed cards the board lists: its own query on their ids', () => {
    expect(
      cardsQuery({
        types: ['Bug'],
        areas: [{ path: 'Shop\\Web', includeChildren: true }],
        mine: true,
        done: { days: 14 },
        ids: [4, 9],
      }),
    ).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Bug') AND [System.Id] IN (4, 9) AND ([System.State] NOT IN ('Removed', 'Closed', 'Done') OR ([System.State] IN ('Closed', 'Done') AND [System.ChangedDate] >= @Today - 14)) AND ([System.AreaPath] UNDER 'Shop\\Web') AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC",
    );
  });
});

test('abe fresh says what each part found', () => {
  expect(
    freshText({
      board: { project: 'Shop', team: 'Web', cards: 1, gone: 2 },
      github: { repo: 'o/r', prs: 0 },
      pipelines: { source: 'o/r', runs: 3 },
      failed: [],
      first: false,
    }),
  ).toBe(
    'Shop / Web: 1 card changed, 2 others not on the board · o/r: 0 pull requests changed · o/r: 3 runs moved\n',
  );
  expect(freshText({ board: null, github: null, pipelines: null, failed: [], first: true })).toBe(
    'nothing to look at here: no board, no GitHub origin and no pipelines\n',
  );
});

const run = (id: string, more: Partial<PipelineRun> = {}): PipelineRun => ({
  id,
  number: id,
  pipeline: 'ci',
  name: null,
  title: 'Cart total',
  branch: 'card/4-cart-total',
  trigger: 'push',
  actor: null,
  status: 'running',
  createdAt: '2026-10-25T10:00:00Z',
  startedAt: '2026-10-25T10:00:00Z',
  finishedAt: null,
  url: `https://example.test/runs/${id}`,
  stages: [],
  sha: '',
  attempt: 1,
  pr: null,
  ...more,
});

describe('runsMoved', () => {
  test('the first look finds where to start and says nothing moved', () => {
    expect(runsMoved(undefined, [run('1')]).changed).toEqual([]);
  });

  test('a new run, one finished and one run again moved; one standing still did not', () => {
    const { seen } = runsMoved(undefined, [run('1'), run('2'), run('3')]);
    const now = [
      run('4'),
      run('1', { status: 'passed', finishedAt: '2026-10-25T10:05:00Z' }),
      run('2', { attempt: 2 }),
      run('3'),
    ];
    const next = runsMoved(seen, now);

    expect(next.changed.map((r) => r.id)).toEqual(['4', '1', '2']);
    expect(runsMoved(next.seen, now).changed).toEqual([]);
  });

  test('a run come to an approval gate moved (waiting), and again once approved (#236)', () => {
    const { seen } = runsMoved(undefined, [run('1')]);
    const gated = runsMoved(seen, [run('1', { status: 'waiting' })]);

    expect(gated.changed.map((r) => [r.id, r.status])).toEqual([['1', 'waiting']]);
    expect(runsMoved(gated.seen, [run('1')]).changed.map((r) => r.status)).toEqual(['running']);
  });
});
