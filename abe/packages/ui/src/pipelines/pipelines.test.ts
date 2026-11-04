/**
 * The Pipelines tab as the bridge drives it in the pane slot (1.0's abe-core `pipelines`
 * scenarios, ported): the overview grouped and scoped with the agent on each branch, the selected
 * run's summary and actions, the graph then the log with its evidence and Esc stepping back, the
 * run's Action menu with its writes (a rerun at once on the attempt inspected, Cancel run… and
 * Approve… asked, a prod approval the red yes), Fix with agent saying what goes where, the
 * filter, one workflow's history, the reads again and the open params.
 */
import { describe, expect, test } from 'bun:test';
import type { FactoryRunData, Inspection, PipelineRun, SessionData } from '@abe/core';
import {
  drivePipelines,
  eventInput,
  factoryRun,
  INSPECTION_9003,
  type PipelinesDrive,
  PIPELINE_DEPLOYS,
  PIPELINE_LIST,
  pipelineListAnswer,
  PIPELINE_RUNS,
  PIPELINES_NOW,
  pipelineRun,
  pipelinesReplies,
  runsAnswer,
  session,
  sessionsAnswer,
} from '@abe/testing';
import { type Node, type Table } from '../runtime/components';
import {
  type JobLog,
  type JobPanel,
  type PipelinesBar,
  type RunGraph,
  type RunHead,
  type RunSummary,
} from './pipeline-components';
import { type Command, type Menu, type MenuRow } from '../runtime/runtime';

type Kinds = {
  Table: Table;
  PipelinesBar: PipelinesBar;
  RunSummary: RunSummary;
  RunHead: RunHead;
  RunGraph: RunGraph;
  JobPanel: JobPanel;
  JobLog: JobLog;
};

const isKind = <K extends keyof Kinds>(n: Node, kind: K): n is Kinds[K] => n.kind === kind;

/** The node of `kind` in the tree, if drawn. */
const find = <K extends keyof Kinds>(tree: Node, kind: K): Kinds[K] | undefined => {
  if (isKind(tree, kind)) return tree;
  const children = 'children' in tree ? (tree.children ?? []) : [];

  for (const c of children) {
    const got = find(c, kind);

    if (got !== undefined) return got;
  }

  return undefined;
};

/** The world's run `id`. */
const worldRun = (id: string): PipelineRun => {
  const r = PIPELINE_RUNS.find((x) => x.id === id);

  if (r === undefined) throw new Error(`no run ${id}`);

  return r;
};

const must = <K extends keyof Kinds>(d: PipelinesDrive, kind: K): Kinds[K] => {
  const got = find(d.tree, kind);

  if (got === undefined) throw new Error(`no ${kind}: ${JSON.stringify(d.tree).slice(0, 400)}`);

  return got;
};

/** The table's rows as words: `▸ ✗ Failed | PR checks | #103 Fix cart rounding | …`. */
const rows = (d: PipelinesDrive): string[] => {
  const t = must(d, 'Table');

  return t.props.rows.map(
    (r) =>
      `${r.id !== undefined && r.id === t.props.selected ? '▸ ' : ''}${r.cells
        .map((c) => [c.accent, c.mark, c.text].filter((x) => x !== undefined).join(' '))
        .join(' | ')}`,
  );
};

const selected = (d: PipelinesDrive) => rows(d).find((r) => r.startsWith('▸ '));

const runs = (commands: readonly Command[]) =>
  commands.flatMap((c) => (c.kind === 'run' ? [c.argv.join(' ')] : []));

const menuOf = (commands: readonly Command[]): Menu => {
  const m = commands.find((c): c is Menu => c.kind === 'menu');

  if (m === undefined) throw new Error(`no menu: ${JSON.stringify(commands)}`);

  return m;
};

const row = (m: Menu, id: string): MenuRow => {
  const r = m.rows.find((x) => x.id === id);

  if (r === undefined) throw new Error(`no row ${id}`);

  return r;
};

/** The main checkout's tab, every read answered. */
const main = (o: Parameters<typeof drivePipelines>[1] = {}) =>
  drivePipelines({ root: '/r/app', branch: 'main' }, o).answer();

/** The failed run #103 selected (Needs approval, Running ×2, then Failed). */
const onFailed = (d: PipelinesDrive) => d.keys('ö', 'ö', 'ö').answer();

/** The live sessions answered: the agents on the runs' branches. */
const sessions = (list: SessionData[]) => sessionsAnswer(list);

/** The live runs answered: the runs the agents are of. */
const factoryRuns = (list: FactoryRunData[]) => runsAnswer(list);

describe('the overview', () => {
  test('its runs read, it tells the stripe Pipelines’ dot (#20)', () => {
    const dots = main().commands.flatMap((c) =>
      c.kind === 'shell' && c.effect.kind === 'stripe-dot' ? [c.effect] : [],
    );

    expect(dots.length).toBeGreaterThan(0);
    expect(dots.at(-1)?.id).toBe('pipelines');
    expect(dots.at(-1)?.dot).toMatch(/^(needs-you|failed)$/);
  });

  test.each([
    ['the main checkout on its default branch', '/r/app', 'main'],
    ['the main checkout on a branch of its own', '/r/app', 'bump-node'],
    ["a card's workspace on its branch", '/r/app-wt/34', 'card/34-cart-total'],
  ])('%s opens on All', (_, root, branch) => {
    const d = drivePipelines({ root, branch }).answer();

    expect(must(d, 'PipelinesBar').props).toMatchObject({ selected: 'scope:all', count: '7 runs' });
  });

  test("⇧Tab: This workspace lists its branch's runs with its agent, kept once picked; Tab walks All and Mine", () => {
    const d = drivePipelines(
      { root: '/r/app-wt/34', branch: 'card/34-cart-total' },
      { size: { width: 1400, height: 600 } },
    ).answer();
    const s34 = {
      ...session('34-a1b2', 'working', 34),
      branch: 'card/34-cart-total',
      title: 'Cart total includes shipping',
    };

    d.send(sessions([s34]))
      .keys('<S-Tab>')
      .answer();
    expect(must(d, 'PipelinesBar').props).toMatchObject({
      selected: 'scope:workspace',
      count: 'card/34-cart-total · 2 runs · All shows 7',
    });
    expect(rows(d)).toEqual([
      'RECENT · LAST 20',
      '▸ ✓ Passed | PR checks | #101 Cart total includes shipping | card/34-cart-total · PR #56 | ● Running · #34 cart total includes shipping | 07:31 | 6m 00s',
      '· Cancelled | PR checks | #1099 Cart total includes shipping | card/34-cart-total · PR #56 | ● Running · #34 cart total includes shipping | 07:02 | 1m 00s',
    ]);
    // the scope picked stays on another branch and opened again
    d.send({ kind: 'root', root: '/r/app-wt/34', branch: 'card/34-cart-total-v2' }).answer();
    d.send({ kind: 'open', params: {}, size: { width: 1400, height: 600 } }).answer();
    expect(must(d, 'PipelinesBar').props.selected).toBe('scope:workspace');
    d.send({ kind: 'root', root: '/r/app-wt/34', branch: 'card/34-cart-total' }).answer();
    // Tab: All, grouped in its order, newest first in each
    d.keys('<Tab>').answer();
    expect(rows(d).filter((r) => !r.includes('|'))).toEqual([
      'NEEDS APPROVAL · 1',
      'RUNNING · 2',
      'FAILED · 1',
      'RECENT · LAST 20',
    ]);
    expect(rows(d)).toContain(
      '▸ ◆ Needs approval | Deploy Prod | #107 Release rc-213 | main · manual | — | 08:20 | 40m 00s',
    );
    // Mine: the runs I started
    d.keys('<Tab>').answer();
    expect(must(d, 'PipelinesBar').props.selected).toBe('scope:mine');
    const mine = rows(d).join('\n');

    expect(mine).not.toContain('Checkout copy for Nordic markets');
    expect(mine).not.toContain('Login redirect keeps the query');
    expect(mine).toContain('Fix cart rounding');
  });

  const pr = {
    repo: 'mkdir-swe/demo-shop',
    number: 56,
    url: 'https://github.com/mkdir-swe/demo-shop/pull/56',
    state: 'open' as const,
    checks: 'success' as const,
    mergeCommit: null,
    deploy: null,
    branch: null,
  };

  test.each([
    ['no run of its own: its session’s word', [], '● Needs you'],
    [
      'its run’s pull request for a person to merge: Ready for review, as its header says',
      [
        factoryRun(34, 'Cart total', 'pr', 'needs-you', {
          session: '34-a1b2',
          pr: { ...pr, merge: 'person' as const },
        }),
      ],
      '● Ready for review',
    ],
  ])('the agent on a waiting session: %s', (_, list, word) => {
    const d = drivePipelines({ root: '/r/app-wt/34', branch: 'card/34-cart-total' }).answer();

    d.keys('<S-Tab>').answer();
    d.send(sessions([{ ...session('34-a1b2', 'waiting', 34), branch: 'card/34-cart-total' }])).send(
      factoryRuns(list),
    );
    expect(rows(d)[1]).toContain(`| ${word} · #34`);
  });

  test('a workspace without runs says why, and ⏎ shows All', () => {
    const d = drivePipelines({ root: '/r/app-wt/12', branch: 'card/12-saved-carts' }).answer();

    d.keys('<S-Tab>').answer();
    expect(must(d, 'Table').props.empty).toEqual({
      title: 'No runs for this workspace yet · All shows 7',
      line: 'A run appears here once card/12-saved-carts is pushed · ⏎ Show All',
    });
    d.keys('<CR>').answer();
    expect(must(d, 'PipelinesBar').props.selected).toBe('scope:all');
  });

  test("the selected run's summary and its actions; the moves cross the groups", () => {
    const d = onFailed(main());

    expect(selected(d)).toBe(
      '▸ ✗ Failed | PR checks | #103 Fix cart rounding | fix/AB-7-rounding · PR #61 | — | 08:00 | 7m 00s',
    );
    const s = must(d, 'RunSummary').props;

    expect(s.identity).toBe('PR checks · run #103 · attempt 1');
    expect(s.meta).toBe('fix/AB-7-rounding · PR #61 · 9003c7e · 08:00 · 7m 00s');
    expect(s.jobs).toContainEqual({
      mark: '✗',
      name: 'unit tests',
      duration: '2m 10s',
      hue: 'bad',
    });
    expect(s.skipped).toBe('e2e · Chromium, deploy preview · Skipped');
    expect(s.facts).toEqual([
      { label: 'Evidence', value: 'rounds to two decimals · cart.test.ts:14' },
      { label: 'Agent', value: 'none on fix/AB-7-rounding' },
    ]);
    expect(s.actions.map((a) => a.label)).toEqual(['Fix with agent…', 'Rerun failed']);
    // the gate's run offers Approve…, a running one Cancel run…
    d.click('run:9007').answer();
    expect(must(d, 'RunSummary').props.actions.map((a) => a.label)).toEqual(['Approve…']);
    d.click('run:9006').answer();
    expect(must(d, 'RunSummary').props.actions.map((a) => a.label)).toEqual(['Cancel run…']);
  });

  test.each<[number, boolean, string[]]>([
    [1600, true, ['State', 'Workflow', 'Run', 'Branch · trigger', 'Agent', 'Started', 'Duration']],
    // 1440 with Chat docked: the runs and the summary share the rest
    [954, true, ['State', 'Workflow', 'Run', 'Started']],
    [760, false, ['State', 'Workflow', 'Run', 'Branch · trigger', 'Started']],
    [400, false, ['State', 'Run', 'Started']],
  ])(
    'at %i the summary %p; the columns the runs hold whole, the least read gone',
    (width, summary, want) => {
      const d = main({ size: { width, height: 340 } });
      const table = find(d.tree, 'Table')?.props;

      expect(find(d.tree, 'RunSummary') !== undefined).toBe(summary);
      expect(table?.columns.map((c) => c.label)).toEqual(want);
      // each run's cells the columns'
      expect(
        table?.rows
          .filter((r) => r.id?.startsWith('run:') === true)
          .every((r) => r.cells.length === want.length),
      ).toBe(true);
    },
  );

  test('the filter narrows the runs, finds one by its number and says when none match', () => {
    const d = main().keys('/', 'l', 'o', 'g', 'i', 'n');
    const words = rows(d).join('\n');

    expect(words).toContain('Login redirect keeps the query');
    expect(words).not.toContain('Fix cart rounding');
    d.keys('z');
    expect(must(d, 'Table').props.empty?.title).toBe('No runs match “loginz”');
    const n = main().keys('/', '#', '1', '0', '3');

    expect(rows(n).filter((r) => r.includes('|'))).toHaveLength(1);
    expect(rows(n).join('\n')).toContain('Fix cart rounding');
  });

  test('Deploys pinned first: each deploy’s newest run however old, or Never run; ⏎ inspects one', () => {
    const d = main({ answer: { deploys: PIPELINE_DEPLOYS }, size: { width: 1400, height: 600 } });

    expect(rows(d).slice(0, 6)).toEqual([
      'DEPLOYS · 4',
      '▸ ● Running | Deploy Dev/Test | #105 Order history paginates | main · 9005c7e · bob | — | 08:38 | 22m 00s',
      '· Never run | Deploy QA | deploys qa | — | — | — | —',
      '✓ Passed | Terraform apply | #701 Queue for order exports | main · 8601c7e · bob | — | 11d | 4m 00s',
      '◆ Needs approval | Deploy Prod | #107 Release rc-213 | main · 9007c7e · ann | — | 08:20 | 40m 00s',
      'RUNNING · 1',
    ]);
    // a deploy's run is not shown again in its own group: no Needs approval, Deploy Dev/Test once
    expect(rows(d).filter((r) => !r.includes('|'))).toEqual([
      'DEPLOYS · 4',
      'RUNNING · 1',
      'FAILED · 1',
      'RECENT · LAST 20',
    ]);
    expect(rows(d).filter((r) => r.includes('Order history paginates'))).toHaveLength(1);
    // Never run: no run to sum up, ⏎ reads nothing
    d.keys('ö').answer();
    expect(selected(d)).toContain('Never run');
    expect(find(d.tree, 'RunSummary')).toBeUndefined();
    expect(runs(d.keys('<CR>').commands)).toEqual([]);
    // the old deploy's run: its summary, ⏎ its graph
    expect(runs(d.keys('ö').commands)).toEqual(['pipeline show 8601', 'pipeline inspect 8601']);
    d.answer();
    expect(must(d, 'RunSummary').props.title).toContain('Queue for order exports');
    d.keys('<CR>').answer();
    expect(must(d, 'RunHead').props.title).toContain('Queue for order exports');
    // the filter finds a deploy by its environment
    const f = main({ answer: { deploys: PIPELINE_DEPLOYS } });

    f.keys('/', 's', 't', 'a', 'g', 'i', 'n', 'g').answer();
    expect(rows(f).filter((r) => r.includes('|'))).toEqual([
      '▸ ✓ Passed | Terraform apply | #701 Queue for order exports | main · 8601c7e · bob | — | 11d | 4m 00s',
    ]);
  });

  test.each([
    ['All', [], 4],
    ['Mine: deploys are the repo’s, whoever ran them', ['<Tab>'], 4],
  ])('Deploys in %s', (_, keys, n) => {
    const d = main({ answer: { deploys: PIPELINE_DEPLOYS } });

    d.keys(...keys).answer();
    expect(rows(d)[0]).toBe(`DEPLOYS · ${n}`);
  });

  test('This workspace shows the deploys whose run is on its branch only', () => {
    const card = drivePipelines(
      { root: '/r/app-wt/34', branch: 'card/34-cart-total' },
      { answer: { deploys: PIPELINE_DEPLOYS } },
    ).answer();

    card.keys('<S-Tab>').answer();
    expect(must(card, 'PipelinesBar').props.selected).toBe('scope:workspace');
    expect(rows(card).join('\n')).not.toContain('DEPLOYS');
    // the main checkout's This workspace: the three deploys run on main, not the one never run
    const d = main({ answer: { deploys: PIPELINE_DEPLOYS } });

    d.keys('<S-Tab>').answer();
    expect(must(d, 'PipelinesBar').props.selected).toBe('scope:workspace');
    expect(rows(d)[0]).toBe('DEPLOYS · 3');
  });

  test("`w` picks one workflow's history: newest first, no groups; Esc back to the overview", () => {
    const d = main();

    expect(menuOf(d.keys('w').take()).rows.map((r) => [r.text, r.dim])).toEqual([
      ['All workflows', '7 runs · the overview'],
      ['Deploy Dev/Test', '1 run'],
      ['Deploy Prod', '1 run'],
      ['PR checks', '5 runs · ✗ 1 failed'],
    ]);
    d.click('PR checks').answer();
    expect(d.tree.id).toBe('pipelines-history');
    expect(must(d, 'PipelinesBar').props).toMatchObject({
      workflow: { label: 'Workflow: PR checks', on: true },
      count: 'PR checks · 5 runs',
    });
    expect(rows(d).some((r) => r.startsWith('RECENT'))).toBe(false);
    expect(rows(d).join('\n')).not.toContain('Release rc-213');
    d.keys('<Esc>').answer();
    expect(d.tree.id).toBe('pipelines');
    expect(rows(d)).toContain('NEEDS APPROVAL · 1');
    // Esc at home is the pane's: the keys go back to the code
    expect(d.take()).toEqual([]);
    expect(d.keys('<Esc>').take()).toEqual([
      { kind: 'shell', effect: { kind: 'unhandled', slot: 'pane', key: '<Esc>' } },
    ]);
  });
});

describe('a run entered', () => {
  test('⏎ the graph, ⏎ again the log at its failure; Esc back keeping filter and selection', () => {
    const d = main().keys('/', 'r', 'o', 'u', 'n', 'd', 'i', 'n', 'g', '<CR>').answer();

    expect(d.tree.id).toBe('pipelines-run');
    const head = must(d, 'RunHead').props;

    expect(head.crumbs.map((c) => c.text)).toEqual([
      'PR checks',
      'Run #103 · Fix cart rounding',
      'unit tests',
    ]);
    expect(JSON.stringify(head)).not.toContain('run 9003');
    const g = must(d, 'RunGraph').props;

    expect(
      g.jobs.map((j) => `${j.id} ${j.name} · ${j.state.word} ${j.duration} (${j.column},${j.row})`),
    ).toEqual([
      'job:90031 install · Passed 22s (0,0)',
      'job:90032 lint · Passed 48s (1,0)',
      'job:90033 unit tests · Failed 2m 10s (1,1)',
      'job:90034 build · Passed 1m 35s (1,2)',
      'job:90035 e2e · Chromium · Skipped  (2,0)',
      'job:90036 deploy preview · Skipped  (3,0)',
    ]);
    expect(g.selected).toBe('job:90033');
    expect(must(d, 'JobPanel').props.words).toBe(
      'after 2m 10s · job 90033 · ubuntu-latest · step Run npm test',
    );
    // k / ä between the boxes
    d.keys('k').answer();
    expect(must(d, 'RunGraph').props.selected).toBe('job:90031');
    d.keys('ä', 'ö').answer();
    expect(must(d, 'RunGraph').props.selected).toBe('job:90033');
    // ⏎: the job's log, opened at its failure, its evidence beside it
    d.keys('<CR>').answer();
    const log = must(d, 'JobLog').props;

    expect(`${log.title} · ${log.range}`).toBe('LOG · RUN NPM TEST · lines 1–8 of 8');
    const panel = must(d, 'JobPanel').props;

    expect(panel.selected).toBe(0);
    expect(
      panel.evidence.map(
        (e) =>
          `${e.title} · ${e.detail}${e.file === undefined ? '' : ` · ${e.file}`}${e.unavailable === undefined ? '' : ` · ${e.unavailable}`}`,
      ),
    ).toEqual([
      'src/api/cart.test.ts > cartTotal > rounds to two decimals · log line 4 · AssertionError: expected 10.000000000000002 to be 10 · src/api/cart.test.ts:14',
      'Process completed with exit code 1. · log line 8 · ##[error]',
      'e2e-report · run #103 · job 90033 · attempt 1 · 9003c7e',
      'playwright-trace · run #103 · attempt 1 · 9003c7e · job unknown · expired',
    ]);
    // Esc: the graph, then the overview with its filter and selection kept
    d.keys('<Esc>').answer();
    expect(find(d.tree, 'JobLog')).toBeUndefined();
    expect(find(d.tree, 'RunGraph')).toBeDefined();
    d.keys('<Esc>').answer();
    expect(selected(d)).toStartWith('▸ ✗ Failed | PR checks | #103 Fix cart rounding');
    expect(must(d, 'Table').props.filter).toBe('rounding');
    // looking never writes nor launches
    expect(
      runs(d.commands).filter(
        (c) =>
          !/^(pipeline (list|show|inspect|log)|session list|factory status|settings get)/.test(c),
      ),
    ).toEqual([]);
  });

  test('without dependency data the jobs go by start time and the graph says so; missing links too', () => {
    const noEdges = (r: PipelineRun): Inspection =>
      r.id === '9003'
        ? { ...INSPECTION_9003, edges: null }
        : { ...INSPECTION_9003, run: r.id, jobs: [] };
    const d = onFailed(main({ answer: { inspect: noEdges } }))
      .keys('<CR>')
      .answer();

    expect(must(d, 'RunGraph').props.note).toBe(
      'Order from start times · dependency data unavailable for this revision',
    );
    expect(must(d, 'RunGraph').props.edges).toBeUndefined();
    const partial = (r: PipelineRun): Inspection =>
      r.id === '9003'
        ? { ...INSPECTION_9003, partial: true }
        : { ...INSPECTION_9003, run: r.id, jobs: [] };
    const p = onFailed(main({ answer: { inspect: partial } }))
      .keys('<CR>')
      .answer();

    expect(must(p, 'RunGraph').props.note).toBe(
      'Some dependency links cannot be drawn for this revision',
    );
  });

  test("a click on a box enters the graph on it; a crumb steps out; the log's `o` opens a failure's file", () => {
    const d = onFailed(main()).click('job:90034').answer();

    expect(d.tree.id).toBe('pipelines-run');
    expect(must(d, 'RunGraph').props.selected).toBe('job:90034');
    d.click('crumb:log').answer();
    expect(must(d, 'JobPanel').props.name).toBe('build');
    d.click('job:90033').answer().keys('o');
    expect(d.take().filter((c) => c.kind === 'shell' && c.effect.kind !== 'stripe-dot')).toEqual([
      {
        kind: 'shell',
        effect: { kind: 'open-file', path: '/r/app/src/api/cart.test.ts', line: 14 },
      },
    ]);
    d.click('crumb:workflow').answer();
    expect(d.tree.id).toBe('pipelines-history');
  });
});

describe('the run menu and its writes', () => {
  test('seven rows; Approve… takes Fix with agent’s place at a gate', () => {
    const d = onFailed(main());
    const m = menuOf(d.keys('<D-CR>').take());

    expect(m.title).toBe('PR checks · run #103 · Fix cart rounding');
    expect(m.rows.map((r) => [r.text, r.reason])).toEqual([
      ['Inspect', undefined],
      ['Fix with agent…', undefined],
      ['Rerun failed', undefined],
      ['Rerun', undefined],
      ['Cancel run…', 'the run has ended'],
      ['Open in browser', undefined],
      ['Run workflow…', undefined],
    ]);
    expect(row(m, 'rerun-failed').dim).toBe('unit tests and the 2 jobs it skipped');
    expect(row(m, 'rerun').dim).toBe('all 6 jobs');
    // starting paid work: the menu never rests on it
    expect(row(m, 'fix').costly).toBe(true);
    d.keys('<Esc>').click('run:9007').answer();
    expect(menuOf(d.keys('<D-CR>').take()).rows.map((r) => r.text)).toEqual([
      'Inspect',
      'Approve…',
      'Rerun failed',
      'Rerun',
      'Cancel run…',
      'Open in browser',
      'Run workflow…',
    ]);
  });

  test('a prod approval is the red yes, No the default, who acts said; a test one a plain ask', () => {
    const d = main().click('run:9007').answer();
    const approve = row(menuOf(d.keys('<D-CR>').take()), 'approve');

    expect(approve.does).toEqual({
      kind: 'run',
      argv: ['pipeline', 'approve', '9007', '--environment', 'production', '--yes'],
      confirm: {
        question: 'Deploy rc-213 to production?',
        details: [
          'Deploy Prod · run #107 · main at 9007c7e',
          'Brings Release rc-213',
          "As ann · GitHub checks the repository's permissions",
        ],
        yes: 'Yes, deploy to prod',
        danger: true,
      },
      done: 'rc-213: production approved',
    });
    // the head's button asks the same, through Command mode
    expect(menuOf(d.keys('<CR>').answer().click('act:approve').take()).rows).toEqual([approve]);
    const staging: PipelineRun = {
      ...worldRun('9007'),
      stages: [
        {
          name: 'deploy · staging',
          status: 'waiting',
          startedAt: null,
          finishedAt: null,
          gate: {
            id: '3',
            kind: 'environment',
            environment: 'staging',
            since: null,
            canApprove: true,
          },
        },
      ],
    };
    const t = drivePipelines()
      .answer(pipelinesReplies({ runs: [staging] }))
      .click('run:9007')
      .answer(pipelinesReplies({ runs: [staging] }));
    const plain = row(menuOf(t.keys('<D-CR>').take()), 'approve').does;

    expect(plain).toMatchObject({
      argv: ['pipeline', 'approve', '9007', '--environment', 'staging'],
      confirm: { question: 'Approve deployment to staging?', yes: 'Approve' },
    });
    expect(plain.kind === 'run' && plain.confirm?.danger).toBeUndefined();
  });

  test('Rerun failed runs at once on the attempt inspected; Cancel run… asks, Keep running the default', () => {
    const d = onFailed(main()).click('act:rerun-failed');

    expect(runs(d.take())).toEqual(['pipeline rerun 9003 --attempt 1 --failed']);
    // its answer: the status line, everything read again
    d.send({
      kind: 'result',
      id: 'pipelines:act:rerun-failed',
      command: 'pipeline rerun',
      reply: {
        ok: true,
        data: { run: '9003', named: '#103', did: 'rerun-failed', attempt: 1, environment: null },
      },
      text: 'Run #103: failed jobs rerun',
    });
    const after = d.take();

    expect(after).toContainEqual({
      kind: 'shell',
      effect: { kind: 'status', text: 'Run #103: failed jobs rerun' },
    });
    expect(runs(after)).toContain('pipeline list --limit 30');
    // a running run's Cancel run… asks first
    d.answer().click('run:9006').answer();
    const cancel = menuOf(d.click('act:cancel').take()).rows[0];

    expect(cancel?.does).toMatchObject({
      kind: 'run',
      argv: ['pipeline', 'cancel', '9006', '--attempt', '1'],
      confirm: { question: 'Cancel run #106?', yes: 'Cancel run', no: 'Keep running' },
    });
  });

  test("a write Command mode ran (command.ran) reads the runs again; the agents' moves are live's, no read of its own", () => {
    const d = main().send(
      sessions([{ ...session('4-a1b2', 'working', 4), branch: 'card/4-cart-total' }]),
      factoryRuns([factoryRun(4, 'Cart total', 'build', 'running', { session: '4-a1b2' })]),
    );

    d.take();
    d.send(
      eventInput(
        { type: 'command.ran', data: { noun: 'pipeline', verb: 'approve', exit: 0 } },
        PIPELINES_NOW,
      ),
    );
    expect(runs(d.commands)).toContain('pipeline list --limit 30');
    d.answer().take();
    d.send(
      eventInput(
        { type: 'command.ran', data: { noun: 'card', verb: 'list', exit: 0 } },
        PIPELINES_NOW,
      ),
    );
    expect(runs(d.take())).toEqual([]);
    d.send(
      eventInput(
        {
          type: 'session.state',
          data: { id: '4-a1b2', card: 4, state: 'waiting', since: PIPELINES_NOW, cause: 'Stop' },
        },
        PIPELINES_NOW,
      ),
    );
    expect(runs(d.take())).toEqual([]);
    d.send(
      eventInput(
        {
          type: 'factory.stage',
          data: {
            card: 4,
            session: '4-a1b2',
            stage: 'pr',
            from: null,
            state: 'needs-you',
            reason: 'merge waits for a person',
            since: PIPELINES_NOW,
            cause: 'run',
            outcome: null,
          },
        },
        PIPELINES_NOW,
      ),
    );
    expect(runs(d.take())).toEqual([]);
    // `r`: its own reads, and the live facts it follows, again
    const again = runs(d.keys('r').take());

    for (const read of ['pipeline list --limit 30', 'session list', 'factory status'])
      expect(again).toContain(read);
  });

  test('Azure Pipelines: rerun and cancel are grey, saying why', () => {
    const d = drivePipelines()
      .answer()
      .send({
        kind: 'result',
        id: 'pipelines#0',
        command: 'pipeline list',
        reply: {
          ok: true,
          data: { ...PIPELINE_LIST, provider: 'azure-pipelines', source: 'contoso/Shop', me: null },
        },
      })
      .keys('ö', 'ö', 'ö')
      .answer();
    const m = menuOf(d.keys('<D-CR>').take());

    for (const id of ['rerun-failed', 'rerun', 'cancel'])
      expect(row(m, id).reason).toBe('Run controls are unavailable for Azure Pipelines');
    expect(row(m, 'browser').dim).toBe('Azure Pipelines');
    expect(row(m, 'dispatch').reason).toBe('Run workflow is GitHub Actions only for now');
  });
});

describe('one workflow’s runs and the pages', () => {
  test('a workflow picked asks serve for its runs; the overview’s of it show meanwhile under Reading runs…', () => {
    // an older deploy the overview's 30 never held: the workflow's read finds it
    const older = [
      pipelineRun('8990', 'Deploy Dev/Test', 'Older deploy', 'main', '06:00', 5, {
        trigger: 'push',
        actor: 'bob',
      }),
    ];
    const d = drivePipelines(undefined, { answer: { older } }).answer();

    d.keys('w').take();
    d.click('Deploy Dev/Test');
    expect(runs(d.commands)).toContain('pipeline list --limit 30 --workflow Deploy Dev/Test');
    // what the overview knew of it shows while serve answers, said to be read
    expect(must(d, 'Table').props.note).toBe('Reading runs…');
    expect(rows(d).join('\n')).toContain('Order history paginates');
    expect(rows(d).join('\n')).not.toContain('Older deploy');
    d.answer();
    expect(rows(d).filter((r) => r.includes('|'))).toHaveLength(2);
    expect(rows(d).join('\n')).toContain('Older deploy');
    expect(must(d, 'PipelinesBar').props.count).toBe('Deploy Dev/Test · 2 runs');
    expect(must(d, 'Table').props.note).toBe('Read 09:00');
    // a workflow the overview holds no run of: the reading state, never an empty No runs
    d.send({ kind: 'choice', menu: 'pipelines:workflows', row: 'Nightly' });
    expect(runs(d.commands)).toContain('pipeline list --limit 30 --workflow Nightly');
    expect(must(d, 'Table').props.empty).toEqual({
      title: 'Reading runs…',
      line: 'Nightly’s runs, a moment',
    });
    d.answer();
    expect(must(d, 'Table').props.empty?.title).toBe('No runs');
    // back to the overview: its runs as read, no read while fresh
    d.keys('<Esc>');
    expect(runs(d.take())).toEqual([]);
    expect(rows(d)).toContain('NEEDS APPROVAL · 1');
  });

  test("a workflow whose runs carry a run-name: picked, its runs show under the workflow's name", () => {
    // `run-name:` set: a run is its workflow's still, the run-name its title and the RC it brings
    const world = [
      ...PIPELINE_RUNS,
      pipelineRun('9066', 'Deploy Prod', 'Deploy Prod: rc-902', 'main', '06:00', 5, {
        name: 'rc-902',
        trigger: 'manual',
      }),
      pipelineRun('9020', 'Deploy Dev/Test', 'Bump the cart service', 'main', '05:00', 4, {
        name: 'rc-920',
        trigger: 'push',
      }),
    ];
    const d = main({ answer: { runs: world } });

    expect(menuOf(d.keys('w').take()).rows.map((r) => [r.text, r.dim])).toEqual([
      ['All workflows', '9 runs · the overview'],
      ['Deploy Dev/Test', '2 runs'],
      ['Deploy Prod', '2 runs'],
      ['PR checks', '5 runs · ✗ 1 failed'],
    ]);
    d.click('Deploy Prod');
    expect(runs(d.commands)).toContain('pipeline list --limit 30 --workflow Deploy Prod');
    d.answer();
    expect(must(d, 'PipelinesBar').props.count).toBe('Deploy Prod · 2 runs');
    expect(rows(d).map((r) => r.split(' | ').slice(1, 3).join(' | '))).toEqual([
      'Deploy Prod | #107 Release rc-213',
      'Deploy Prod | #166 Deploy Prod: rc-902',
    ]);
    d.keys('ö').answer();
    expect(must(d, 'RunSummary').props.facts).toContainEqual({ label: 'Brings', value: 'rc-902' });
  });

  test('m (or the Older runs… row) reads the next page, older; the selection stays, the bar counts the pages', () => {
    const at = (i: number) =>
      `0${7 - Math.floor(i / 60)}:${String(59 - (i % 60)).padStart(2, '0')}`;
    const many = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) =>
        pipelineRun(String(from - i), 'PR checks', `Change ${from - i}`, 'main', at(i), 3, {
          trigger: 'push',
        }),
      );
    const d = drivePipelines(undefined, {
      size: { width: 1400, height: 3000 },
      answer: { runs: many(9500, 30), older: many(9400, 10) },
    }).answer();

    // a full page read: an older one may follow
    expect(must(d, 'Table').props.foot).toContainEqual({ keys: 'm', label: 'older' });
    expect(rows(d).at(-1)).toBe('Older runs… · the next 30');
    expect(rows(d)).toContain('RECENT · LAST 20');
    d.keys('ö', 'ö');
    const picked = selected(d);

    expect(picked).toContain('Change 9498');
    d.keys('m');
    expect(runs(d.commands)).toContain('pipeline list --limit 30 --page 2');
    expect(rows(d).at(-1)).toBe('Reading older runs…');
    d.answer();
    expect(must(d, 'PipelinesBar').props.count).toBe('40 runs · pages 1–2');
    expect(rows(d)).toContain('RECENT · LAST 40');
    expect(rows(d).join('\n')).toContain('Change 9391');
    expect(selected(d)).toBe(picked);
    // ten came, not a full page: no older one to read
    expect(rows(d).at(-1)).not.toContain('Older runs…');
    expect(must(d, 'Table').props.foot?.some((f) => f.keys === 'm')).toBe(false);
    const before = runs(d.commands).length;

    d.keys('m');
    expect(runs(d.commands)).toHaveLength(before);
    // the 15 s read is the first page again; the second stays
    d.send({ kind: 'tick', at: '2026-10-01T09:00:16.000Z' }).answer();
    expect(must(d, 'PipelinesBar').props.count).toBe('40 runs · pages 1–2');
  });

  test('Run workflow…: the workflows at the branch picked; its branch and inputs asked, then pipeline run', () => {
    // ⌘⏎ with no run: the tab's own menu, Run workflow… alone
    const empty = drivePipelines({ root: '/r/app-wt/12', branch: 'card/12-saved-carts' }).answer();

    empty.keys('<S-Tab>').answer();
    expect(menuOf(empty.keys('<D-CR>').take()).rows.map((r) => r.text)).toEqual(['Run workflow…']);
    const d = onFailed(main());
    const m = menuOf(d.keys('<D-CR>').take());

    expect(row(m, 'dispatch').dim).toBe('a workflow run by hand on main, with its inputs');
    d.send({ kind: 'choice', menu: 'run:9003', row: 'dispatch' });
    expect(runs(d.commands)).toContain('pipeline workflows --ref main');
    d.answer();
    const pick = menuOf(d.take());

    expect(pick.title).toBe('Run workflow · at main');
    expect(pick.rows.map((r) => [r.text, r.dim ?? r.reason])).toEqual([
      ['Deploy Dev/Test', 'deploy.yml · environment: dev · test, dry-run, version'],
      ['Deploy Prod', 'deploy-prod.yml · no inputs'],
      ['PR checks', 'pr.yml has no workflow_dispatch: it is not run by hand'],
    ]);
    // the branch first, the shown one preset; a choice a pick on its default, a boolean yes/no,
    // a text on its default; one not required may stay empty
    const deploy = row(pick, 'deploy.yml');
    const asks = deploy.does.kind === 'back' ? (deploy.does.ask ?? []) : [];

    expect(asks.map((a) => [a.name, a.type, a.values, a.preselect, a.required])).toEqual([
      ['ref', 'string', undefined, 'main', true],
      ['environment', 'string', ['dev', 'test'], 'dev', true],
      ['dry-run', 'boolean', undefined, 'false', false],
      ['version', 'string', undefined, undefined, false],
    ]);
    // the values answered ride the choice: the argv, an input left empty not given
    d.send({
      kind: 'choice',
      menu: 'pipelines:dispatch',
      row: 'deploy.yml',
      values: ['release/1', 'test', 'true', ''],
    });
    expect(runs(d.take())).toEqual([
      'pipeline run deploy.yml --ref release/1 --input environment=test --input dry-run=true',
    ]);
    // never a secret: nothing but the workflow's own inputs is asked
    // started: its words on the status line, the runs read again and the run selected
    d.send({
      kind: 'result',
      id: 'pipelines:act:dispatch',
      command: 'pipeline run',
      reply: {
        ok: true,
        data: {
          workflow: 'Deploy Dev/Test',
          file: 'deploy.yml',
          ref: 'release/1',
          inputs: { environment: 'test', 'dry-run': 'true' },
          run: worldRun('9005'),
        },
      },
      text: 'Started Deploy Dev/Test on release/1 · run #105',
    });
    expect(d.effects).toContainEqual({
      kind: 'status',
      text: 'Started Deploy Dev/Test on release/1 · run #105',
    });
    expect(runs(d.commands)).toContain('pipeline list --limit 30');
    d.answer();
    expect(selected(d)).toContain('Order history paginates');
  });
});

describe('Fix with agent', () => {
  test("says what goes where and asks; a run on no card's branch asks the card first", () => {
    const d = onFailed(main());
    const fix = row(menuOf(d.keys('<D-CR>').take()), 'fix').does;

    expect(fix).toMatchObject({
      kind: 'run',
      argv: ['pipeline', 'fix', '9003'],
      ask: [{ name: 'card', kind: 'flag', title: 'Fix run #103 for which card?' }],
      confirm: {
        question: 'Fix run #103 with an agent?',
        details: [
          'To the card you name: its live session as a message, else a new Claude Code session · Local sandbox · on fix/<card>-run-103 from 9003c7e',
          'Run: PR checks · run #103 · attempt 1 · PR #61',
          'Job: unit tests ✗ Failed',
          'Evidence: rounds to two decimals · cart.test.ts:14',
          'Revision: 9003c7e · fix/AB-7-rounding',
        ],
        yes: 'Fix with agent',
      },
    });
  });

  test("a run on a card's branch goes to its live session as a message, else a new one there", () => {
    const failed: PipelineRun = {
      ...worldRun('9003'),
      branch: 'card/12-cart-rounding',
    };
    const world = {
      runs: [failed],
      inspect: () => ({ ...INSPECTION_9003, branch: 'card/12-cart-rounding' }),
    };
    const d = drivePipelines()
      .answer(pipelinesReplies(world))
      .click('run:9003')
      .answer(pipelinesReplies(world));
    const fresh = row(menuOf(d.keys('<D-CR>').take()), 'fix').does;

    expect(fresh.kind === 'run' && fresh.ask).toBeUndefined();
    expect(fresh.kind === 'run' && fresh.confirm?.details?.[0]).toBe(
      "To a new Claude Code session on #12 · Local sandbox · on card/12-cart-rounding, the run's branch",
    );
    d.keys('<Esc>').send(
      sessions([{ ...session('12-a1b2', 'working', 12), branch: 'card/12-cart-rounding' }]),
    );
    const live = row(menuOf(d.keys('<D-CR>').take()), 'fix').does;

    expect(live.kind === 'run' && live.confirm?.details?.[0]).toBe(
      "To #12's session 12-a1b2 (Running): the fix goes as a message",
    );
  });

  test('⏎ on an evidence row: the fix with that evidence, asked; an expired artifact only says so', () => {
    const d = onFailed(main()).keys('<CR>').answer().keys('<CR>').answer();
    const first = menuOf(d.keys('<CR>').take()).rows[0];

    expect(first?.does).toMatchObject({
      argv: [
        'pipeline',
        'fix',
        '9003',
        '--evidence',
        'src/api/cart.test.ts > cartTotal > rounds to two decimals · log line 4 · AssertionError: expected 10.000000000000002 to be 10',
      ],
    });
    // l ö walk the evidence; the e2e report goes as an artifact
    d.keys('<Esc>', 'ö', 'ö');
    expect(must(d, 'JobPanel').props.selected).toBe(2);
    expect(menuOf(d.keys('<CR>').take()).rows[0]?.does).toMatchObject({
      argv: ['pipeline', 'fix', '9003', '--artifact', '8'],
    });
    d.keys('<Esc>', 'ö');
    expect(d.keys('<CR>').take()).toEqual([
      { kind: 'shell', effect: { kind: 'status', text: 'playwright-trace: expired' } },
    ]);
  });
});

describe('reads', () => {
  test('the runs again every 15 s while shown; a run still going its own too', () => {
    const d = main();

    d.take();
    d.send({ kind: 'tick', at: '2026-10-01T09:00:10.000Z' });
    expect(runs(d.take())).toEqual([]);
    d.send({ kind: 'tick', at: '2026-10-01T09:00:16.000Z' });
    // 9007 (selected, at its gate) is read again with the list
    expect(runs(d.take())).toEqual([
      'pipeline list --limit 30',
      'pipeline show 9007',
      'pipeline inspect 9007',
    ]);
  });

  test("another project's runs are read anew; an answer still out for the one before is dropped", () => {
    const d = main();

    d.take();
    d.send({ kind: 'tick', at: '2026-10-01T09:00:20.000Z' });
    const stale = d.take().find((c) => c.kind === 'run' && c.argv[1] === 'list');

    expect(stale).toBeDefined();
    d.send({ kind: 'root', root: '/r/other', branch: 'main' });
    // the new project's list is asked at once, never held back by the one still out
    expect(runs(d.commands)).toContain('pipeline list --limit 30');
    expect(find(d.tree, 'Table')?.props.rows).toEqual([]);
    if (stale?.kind === 'run') d.send({ ...pipelineListAnswer(), id: stale.id });
    expect(find(d.tree, 'Table')?.props.rows).toEqual([]);
    d.answer();
    expect(rows(d)).toContain('NEEDS APPROVAL · 1');
  });

  test('a failed read is asked again only after 15 s, never on every tick', () => {
    const d = main();
    const show = () => runs(d.take()).filter((c) => c === 'pipeline show 9007').length;

    d.take();
    d.send({ kind: 'tick', at: '2026-10-01T09:00:16.000Z' });
    const asked = d.commands.find(
      (c) => c.kind === 'run' && c.argv.join(' ') === 'pipeline show 9007',
    );

    if (asked?.kind !== 'run') throw new Error('no show asked');
    d.take();
    d.send({
      kind: 'result',
      id: asked.id,
      command: 'pipeline show',
      reply: { ok: false, error: { code: 'rate-limited', message: 'HTTP 429' } },
    });
    for (const sec of [17, 18, 20, 25])
      d.send({ kind: 'tick', at: `2026-10-01T09:00:${sec}.000Z` });
    expect(show()).toBe(0);
    d.send({ kind: 'tick', at: '2026-10-01T09:00:32.000Z' });
    expect(show()).toBe(1);
  });

  test("Linked's Pipelines row: its run selected, in All when the scope picked does not hold it", () => {
    const d = drivePipelines({ root: '/r/app-wt/34', branch: 'card/34-cart-total' }).answer();

    d.keys('<S-Tab>').answer();
    d.send({ kind: 'open', params: { run: '9003' }, size: { width: 1400, height: 340 } }).answer();
    expect(must(d, 'PipelinesBar').props.selected).toBe('scope:all');
    expect(selected(d)).toStartWith('▸ ✗ Failed | PR checks | #103');
  });

  test("Linked's run older than the latest runs read: read by its id, shown and selected in All", () => {
    const old = pipelineRun(
      '8001',
      'PR checks',
      'Older cart fix',
      'card/35-cart-badge',
      '01:00',
      6,
      {
        status: 'failed',
      },
    );
    const asked: string[] = [];
    const d = drivePipelines({
      root: '/r/app-wt/34',
      branch: 'card/34-cart-total',
      run: '8001',
    }).answer((a) => {
      asked.push(a.argv.join(' '));

      return pipelinesReplies({ older: [old] })(a);
    });

    expect(asked).toContain('pipeline show 8001');
    expect(must(d, 'PipelinesBar').props.selected).toBe('scope:all');
    expect(selected(d)).toContain('Older cart fix');
    // ⏎ inspects it as any listed run
    d.keys('<CR>').answer();
    expect(must(d, 'RunHead').props.title).toBe('Older cart fix');
  });

  test("Linked's run the provider does not know: the overview as it was, a balloon says why", () => {
    const d = drivePipelines({ root: '/r/app', branch: 'main', run: '7777' }).answer();
    const asked = d.commands.find(
      (c) => c.kind === 'run' && c.argv.join(' ') === 'pipeline show 7777',
    );

    if (asked?.kind !== 'run') throw new Error('run 7777 not asked by its id');
    d.take();
    d.send({
      kind: 'result',
      id: asked.id,
      command: 'pipeline show',
      reply: { ok: false, error: { code: 'not-found', message: 'HTTP 404: Not Found' } },
    });
    expect(d.take()).toContainEqual({
      kind: 'shell',
      effect: { kind: 'balloon', tone: 'error', text: 'Run 7777 not read: HTTP 404: Not Found' },
    });
    expect(selected(d)).toStartWith('▸');
    // the ask is let go: a later list that holds 7777 does not jump to it
    const late = pipelineRun('7777', 'PR checks', 'Late run', 'main', '08:59', null, {
      status: 'running',
    });

    d.send({ kind: 'tick', at: '2026-10-01T09:05:00.000Z' }).answer(
      pipelinesReplies({ runs: [late, ...PIPELINE_RUNS] }),
    );
    expect(rows(d).join('\n')).toContain('Late run');
    expect(selected(d)).not.toContain('Late run');
  });

  test("Linked's run asked in one project is not looked for in the next", () => {
    const d = drivePipelines({ root: '/r/app', branch: 'main', run: '7777' }).answer();

    d.take();
    d.send({ kind: 'root', root: '/r/other', branch: 'main' });
    expect(runs(d.take())).not.toContain('pipeline show 7777');
  });

  test("a failed read says why; the clock's time of the last good one is the table's note", () => {
    const d = main();

    expect(must(d, 'Table').props.note).toBe('Read 09:00');
    const f = drivePipelines().send({
      kind: 'result',
      id: 'pipelines#0',
      command: 'pipeline list',
      reply: {
        ok: false,
        error: { code: 'no-github-repo', message: '/r/app has no GitHub origin' },
      },
    });

    expect(must(f, 'Table').props.empty).toEqual({
      title: 'Runs not read',
      line: '/r/app has no GitHub origin',
    });
    expect(PIPELINES_NOW).toBe('2026-10-01T09:00:00.000Z');
  });
});
