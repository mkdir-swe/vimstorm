/**
 * Pipelines' rules (1.0's abe-core `pipelines` tables, ported): the groups and their order, the
 * scopes and the filter, the state words, the times, prod, the graph's places and moves, the
 * log's evidence and the file a failure names, Fix with agent's branch and prompt, the providers'
 * words.
 */
import { describe, expect, test } from 'bun:test';
import {
  INSPECTION_9003,
  LOG_90033,
  PIPELINE_RUNS,
  PIPELINES_NOW,
  pipelineRun,
} from '@abe/testing';
import {
  azureStatus,
  azureTrigger,
  cardOfRunBranch,
  duration,
  failureEvidence,
  failureFile,
  firstError,
  fixBranch,
  fixJobs,
  fixPrompt,
  githubStatus,
  githubTrigger,
  graphNeighbor,
  graphNote,
  graphPlaces,
  deployMatches,
  deployOrder,
  groupHeading,
  groupRuns,
  type Inspection,
  isProd,
  type JobBox,
  logView,
  pipelineActText,
  pipelineFixText,
  pipelineListText,
  type PipelineDeploy,
  type PipelineGroup,
  type PipelineRun,
  RECENT,
  runMatches,
  runNameOf,
  runStateWord,
  runTook,
  scopeDeploys,
  scopeHolds,
  shownJob,
  splitTime,
  startedText,
  stepAt,
  tookText,
} from './pipelines';

const NOW = Date.parse(PIPELINES_NOW);
const run = (id: string): PipelineRun => {
  const r = PIPELINE_RUNS.find((x) => x.id === id);

  if (r === undefined) throw new Error(`no run ${id}`);

  return r;
};

/** A deploy's run from days before every run the list read. */
const old = (id: string, pipeline: string): PipelineRun => ({
  ...pipelineRun(id, pipeline, 'Release', 'main', '06:00', 4, { trigger: 'manual' }),
  createdAt: '2026-09-24T06:00:00Z',
  startedAt: '2026-09-24T06:00:00Z',
  finishedAt: '2026-09-24T06:04:00Z',
});

const box = (
  id: string,
  name: string,
  status: JobBox['status'],
  startedAt: string | null = null,
): JobBox => ({
  id,
  name,
  status,
  url: '',
  startedAt,
  finishedAt: null,
  runner: null,
  group: null,
  steps: [],
});

describe('the overview: groups, scopes, the filter', () => {
  test('grouped Needs approval · Running · Failed · Recent, newest first in each', () => {
    const g = groupRuns(PIPELINE_RUNS);

    expect(g.map((x) => groupHeading(x.group, x.runs.length))).toEqual([
      'NEEDS APPROVAL · 1',
      'RUNNING · 2',
      'FAILED · 1',
      'RECENT · LAST 20',
    ]);
    expect(g[1]?.runs.map((r) => r.id)).toEqual(['9006', '9005']);
    expect(g[3]?.runs.map((r) => r.id)).toEqual(['9001', '9000', '8999']);
  });

  test('a newer pass of the same workflow on the branch resolves a failure; Recent is the last 20', () => {
    const fixed = pipelineRun(
      '9004',
      'PR checks',
      'Fix cart rounding',
      'fix/AB-7-rounding',
      '08:30',
      5,
    );

    expect(groupRuns([...PIPELINE_RUNS, fixed]).map((x) => x.group)).toEqual([
      'needs-approval',
      'running',
      'recent',
    ]);
    const many = Array.from({ length: 30 }, (_, i) =>
      pipelineRun(String(100 + i), 'CI', 't', 'main', '07:00', 1),
    );

    expect(groupRuns(many)[0]?.runs).toHaveLength(RECENT);
  });

  test.each<[string, PipelineDeploy[], PipelineGroup[], string[]]>([
    ['no deploys: no Deploys group', [], ['needs-approval', 'running', 'failed', 'recent'], []],
    [
      'a deploy older than every run read: pinned first, its run nowhere else',
      [{ workflow: 'Deploy Prod', environment: 'prod', run: old('7001', 'Deploy Prod') }],
      ['deploys', 'needs-approval', 'running', 'failed', 'recent'],
      ['7001'],
    ],
    [
      'a deploy among the runs read: in Deploys only (Needs approval no more)',
      [{ workflow: 'Deploy Prod', environment: 'production', run: run('9007') }],
      ['deploys', 'running', 'failed', 'recent'],
      ['9007'],
    ],
    [
      'never run: a row of its own, no run',
      [
        { workflow: 'Deploy Dev', environment: 'dev', run: old('7002', 'Deploy Dev') },
        { workflow: 'Deploy Prod', environment: 'prod', run: null },
      ],
      ['deploys', 'needs-approval', 'running', 'failed', 'recent'],
      ['7002'],
    ],
  ])('Deploys: %s', (_, deploys, groups, pinned) => {
    const g = groupRuns(PIPELINE_RUNS, RECENT, deploys);

    expect(g.map((x) => x.group)).toEqual(groups);
    expect(g.find((x) => x.group === 'deploys')?.runs.map((r) => r.id) ?? []).toEqual(pinned);
    expect(g.find((x) => x.group === 'deploys')?.deploys ?? []).toEqual(deploys);
    // every run shown once
    const ids = g.flatMap((x) => x.runs.map((r) => r.id));

    expect(new Set(ids).size).toBe(ids.length);
    expect(groupHeading('deploys', deploys.length)).toBe(`DEPLOYS · ${deploys.length}`);
  });

  test('a newer deploy that passed resolves an older failure of it on its branch', () => {
    const failed = pipelineRun('9002', 'Deploy Dev', 't', 'main', '07:50', 2, { status: 'failed' });
    const passed = pipelineRun('9008', 'Deploy Dev', 't', 'main', '08:50', 2);
    const g = groupRuns([...PIPELINE_RUNS, failed], RECENT, [
      { workflow: 'Deploy Dev', environment: 'dev', run: passed },
    ]);

    expect(g.find((x) => x.group === 'recent')?.runs.map((r) => r.id)).toContain('9002');
  });

  test('deploys dev → test → prod, others between by name, none named last', () => {
    const d = (workflow: string, environment: string | null) => ({ workflow, environment });

    expect(
      [
        d('Ship', null),
        d('Deploy Prod', 'prod'),
        d('Deploy Staging', 'staging'),
        d('Deploy Test', 'test'),
        d('Deploy QA', 'qa'),
        d('Deploy Live', 'eu-live'),
        d('Deploy Dev', 'dev, test'),
        d('Deploy Edge', 'edge'),
      ]
        .sort(deployOrder(['edge']))
        .map((x) => x.workflow),
    ).toEqual([
      'Deploy Dev',
      'Deploy Test',
      'Deploy QA',
      'Deploy Staging',
      'Deploy Edge',
      'Deploy Live',
      'Deploy Prod',
      'Ship',
    ]);
  });

  test("a scope's deploys: All and Mine every one, This workspace those on its branch", () => {
    const dev: PipelineDeploy = { workflow: 'Deploy Dev', environment: 'dev', run: run('9005') };
    const prod: PipelineDeploy = { workflow: 'Deploy Prod', environment: 'prod', run: null };
    const deploys = [dev, prod];

    expect(scopeDeploys('all', deploys, 'x')).toHaveLength(2);
    expect(scopeDeploys('mine', deploys, 'x')).toHaveLength(2);
    expect(scopeDeploys('workspace', deploys, 'main').map((d) => d.workflow)).toEqual([
      'Deploy Dev',
    ]);
    expect(scopeDeploys('workspace', deploys, 'card/12-x')).toEqual([]);
    expect(deployMatches(prod, 'PROD')).toBe(true);
    expect(deployMatches(dev, '#105')).toBe(true);
    expect(deployMatches(prod, 'zzz')).toBe(false);
  });

  test("This workspace holds its branch's runs, Mine the ones you started, All every one", () => {
    const r = run('9001');

    expect(scopeHolds('workspace', r, 'card/34-cart-total', 'ann')).toBe(true);
    expect(scopeHolds('workspace', r, 'main', 'ann')).toBe(false);
    expect(scopeHolds('workspace', r, undefined, 'ann')).toBe(false);
    expect(scopeHolds('mine', run('9000'), 'main', 'ann')).toBe(false);
    expect(scopeHolds('mine', r, 'main', 'ann')).toBe(true);
    expect(scopeHolds('mine', r, 'main', null)).toBe(false);
    expect(scopeHolds('all', r, undefined, null)).toBe(true);
  });

  test('the filter finds a run by pipeline, branch, title and its number as shown', () => {
    expect(runMatches(run('9000'), 'LOGIN')).toBe(true);
    expect(runMatches(run('9003'), '#103')).toBe(true);
    expect(runMatches(run('9003'), 'zzz')).toBe(false);
    expect(runMatches(run('9003'), '  ')).toBe(true);
  });
});

describe('words and times', () => {
  test('a run at a gate is Needs approval whatever its status says', () => {
    expect(runStateWord(run('9007'))).toEqual({ glyph: '◆', word: 'Needs approval', hue: 'warn' });
    expect(runStateWord({ status: 'running', stages: run('9007').stages })).toMatchObject({
      word: 'Needs approval',
    });
    expect(runStateWord(run('9003'))).toEqual({ glyph: '✗', word: 'Failed', hue: 'bad' });
    expect(runStateWord(run('8999'))).toMatchObject({ glyph: '·', word: 'Cancelled' });
  });

  test('durations: 40s, 6m 05s, 1h 04m; a run going counts to now', () => {
    expect(duration(40_000)).toBe('40s');
    expect(duration(365_000)).toBe('6m 05s');
    expect(duration(3_840_000)).toBe('1h 04m');
    expect(tookText(runTook(run('9003'), NOW))).toBe('7m 00s');
    expect(tookText(runTook(run('9006'), NOW))).toBe('18m 00s');
    expect(tookText(runTook({ ...run('8999'), finishedAt: null }, NOW))).toBe('');
  });

  test('started: the clock today, the weekday this week, else how long ago', () => {
    expect(startedText('2026-10-01T08:00:00Z', NOW)).toBe('08:00');
    // 2026-09-29 is a Tuesday
    expect(startedText('2026-09-29T16:10:00Z', NOW)).toBe('Tue 16:10');
    expect(startedText('2026-09-22T09:00:00Z', NOW)).toBe('9d');
    expect(startedText('not a time', NOW)).toBe('');
  });

  test('prod: its words in any case, or a name the prodEnvironments setting adds', () => {
    for (const name of ['production', 'Prod', 'deploy · prd', 'live-eu'])
      expect(isProd(name)).toBe(true);
    for (const name of ['test', 'staging', 'product-demo', 'deliver'])
      expect(isProd(name)).toBe(false);
    expect(isProd('customer-eu', ['Customer-EU'])).toBe(true);
  });

  test("a run's RC name: `rc-N:` before its title, or a prod workflow's tag in it", () => {
    expect(runNameOf('Release', 'rc-12: Cart fixes')).toEqual({
      title: 'Cart fixes',
      name: 'rc-12',
    });
    expect(runNameOf('Deploy Prod', 'Deploy rc-213 to prod')).toEqual({
      title: 'Deploy rc-213 to prod',
      name: 'rc-213',
    });
    expect(runNameOf('PR checks', 'Bump rc-2 parser\nbody')).toEqual({
      title: 'Bump rc-2 parser',
      name: null,
    });
  });

  test("the providers' words", () => {
    expect(githubStatus('completed', 'success')).toBe('passed');
    expect(githubStatus('completed', 'timed_out')).toBe('failed');
    expect(githubStatus('completed', 'skipped')).toBe('skipped');
    expect(githubStatus('waiting', null)).toBe('waiting');
    expect(githubStatus('in_progress', null)).toBe('running');
    expect(githubStatus('requested', null)).toBe('queued');
    expect(githubTrigger('pull_request_target')).toBe('pull request');
    expect(githubTrigger('workflow_dispatch')).toBe('manual');
    expect(githubTrigger('release_published')).toBe('release published');
    expect(azureStatus('completed', 'succeeded')).toBe('passed');
    expect(azureStatus('completed', 'canceled')).toBe('cancelled');
    expect(azureStatus('inProgress', '')).toBe('running');
    expect(azureStatus('notStarted', '')).toBe('queued');
    expect(azureTrigger('individualCI')).toBe('push');
    expect(azureTrigger('pullRequest')).toBe('pull request');
  });
});

describe('the graph', () => {
  test('boxes by dependency depth: install, then lint / unit tests / build, then e2e, then preview', () => {
    expect(graphPlaces(INSPECTION_9003)).toEqual([
      { id: '90031', column: 0, row: 0 },
      { id: '90032', column: 1, row: 0 },
      { id: '90033', column: 1, row: 1 },
      { id: '90034', column: 1, row: 2 },
      { id: '90035', column: 2, row: 0 },
      { id: '90036', column: 3, row: 0 },
    ]);
    expect(graphNote(INSPECTION_9003)).toBeNull();
  });

  test('without dependency data: waves of jobs started together, never started last, and says so', () => {
    const i: Inspection = { ...INSPECTION_9003, edges: null };

    expect(graphPlaces(i)).toEqual([
      { id: '90031', column: 0, row: 0 },
      { id: '90032', column: 1, row: 0 },
      { id: '90034', column: 1, row: 1 },
      { id: '90033', column: 2, row: 0 },
      { id: '90035', column: 3, row: 0 },
      { id: '90036', column: 3, row: 1 },
    ]);
    expect(graphNote(i)).toBe(
      'Order from start times · dependency data unavailable for this revision',
    );
  });

  test('links the workflow hides: the known edges drawn, some said missing', () => {
    expect(graphNote({ ...INSPECTION_9003, partial: true })).toBe(
      'Some dependency links cannot be drawn for this revision',
    );
  });

  test('moves go to the nearest box that way, and stay at an edge; the selection follows the jobs', () => {
    const i: Pick<Inspection, 'jobs' | 'edges'> = {
      jobs: [
        box('11', 'build', 'passed'),
        box('22', 'test', 'failed'),
        box('33', 'lint', 'running'),
      ],
      edges: [['11', '22']],
    };

    expect(graphNeighbor(i, '11', 'right')).toBe('22');
    expect(graphNeighbor(i, '22', 'left')).toBe('11');
    expect(graphNeighbor(i, '11', 'left')).toBe('11');
    expect(graphNeighbor(i, '11', 'down')).toBe('33');
    expect(shownJob({ jobs: [...i.jobs].reverse() }, '22')).toBe('22');
    expect(shownJob(i, 'gone')).toBe('22');
    expect(fixJobs(i, '22').map((j) => j.id)).toEqual(['22']);
    expect(fixJobs(i, '11').map((j) => j.id)).toEqual(['22']);
    expect(stepAt(INSPECTION_9003.jobs[2] ?? box('x', 'x', 'passed'))?.name).toBe('Run npm test');
  });
});

describe('the log', () => {
  test("a GitHub or Azure log line's time split off", () => {
    expect(splitTime('2026-10-01T08:01:06.0000000Z ##[error]exit 1')).toEqual({
      time: '08:01:06',
      text: '##[error]exit 1',
    });
    expect(splitTime('plain')).toEqual({ time: null, text: 'plain' });
  });

  test("its first failure, and the summary's Evidence: the test's own name and its file", () => {
    expect(firstError(LOG_90033)).toEqual({
      line: 4,
      text: 'src/api/cart.test.ts > cartTotal > rounds to two decimals',
    });
    expect(failureEvidence(LOG_90033)).toBe('rounds to two decimals · cart.test.ts:14');
    expect(failureEvidence('##[error]boom')).toBe('boom · log line 1');
    expect(failureEvidence('all good')).toBeUndefined();
  });

  test('opened at its failure with its evidence rows, each error and failed test with its file', () => {
    const v = logView(LOG_90033, undefined);

    expect(v.range).toBe('lines 1–8 of 8');
    expect(v.evidence.map((e) => `${e.title} · ${e.detail}`)).toEqual([
      'src/api/cart.test.ts > cartTotal > rounds to two decimals · log line 4 · AssertionError: expected 10.000000000000002 to be 10',
      'Process completed with exit code 1. · log line 8 · ##[error]',
    ]);
    expect(v.evidence[0]?.file).toEqual({ path: 'src/api/cart.test.ts', line: 14 });
    expect(v.lines.filter((l) => l.evidence).map((l) => l.n)).toEqual([4, 5, 8]);
    // a long log opens 9 lines above its first error
    const long = [...Array.from({ length: 40 }, (_, i) => `line ${i + 1}`), '##[error]x'].join(
      '\n',
    );

    expect(logView(long, undefined).lines[0]?.n).toBe(32);
    expect(logView(long, 0).lines[0]?.n).toBe(1);
  });

  test('a test failure names its file and line wherever the runner put it', () => {
    const file = (path: string, line: number) => ({ path, line });

    expect(failureFile(['❯ src/api/cart.test.ts:14:21'])).toEqual(file('src/api/cart.test.ts', 14));
    expect(
      failureFile(['✗ src/api/cart.test.ts > cartTotal', '  ❯ src/api/cart.test.ts:14:21']),
    ).toEqual(file('src/api/cart.test.ts', 14));
    expect(failureFile(['FAIL src/a.test.tsx > renders'])).toEqual(file('src/a.test.tsx', 1));
    expect(
      failureFile([
        '    at Object.<anonymous> (/home/runner/work/shop-web/shop-web/src/cart.ts:9:3)',
      ]),
    ).toEqual(file('src/cart.ts', 9));
    expect(failureFile(['2026-10-01T08:01:06.0000000Z   File "app/models.py", line 3'])).toEqual(
      file('app/models.py', 1),
    );
    expect(failureFile(['at node_modules/vitest/dist/x.js:1:2'])).toBeUndefined();
    expect(failureFile(['see https://example.com/a.ts:3'])).toBeUndefined();
    expect(failureFile(['AssertionError: expected 1 to be 2'])).toBeUndefined();
  });
});

describe('Fix with agent', () => {
  test("the card's own branch gets the fix; any other a fix branch from the failed revision", () => {
    expect(cardOfRunBranch('card/12-cart-total')).toBe(12);
    expect(cardOfRunBranch('card/12')).toBe(12);
    expect(cardOfRunBranch('fix/12-x')).toBeUndefined();
    expect(fixBranch(12, { branch: 'card/12-cart-total', number: '103', id: '9003' })).toEqual({
      branch: 'card/12-cart-total',
      from: 'branch',
    });
    expect(fixBranch(12, run('9003'))).toEqual({ branch: 'fix/12-run-103', from: 'revision' });
    expect(fixBranch(7, { branch: 'main', number: '', id: '91' })).toEqual({
      branch: 'fix/7-run-91',
      from: 'revision',
    });
  });

  test('the prompt: the message, then what failed, where, its logs and the evidence that may go', () => {
    const r = run('9003');
    const jobs = fixJobs(INSPECTION_9003);
    const prompt = fixPrompt(r, INSPECTION_9003, {
      jobs,
      evidence: 'rounds to two decimals · log line 4',
      artifacts: ['8', '9'],
      base: 'main',
      branch: 'fix/12-run-103',
    });

    expect(prompt.split('\n')[0]).toBe(
      'PR checks run #103 (attempt 1) failed in unit tests on fix/AB-7-rounding at 9003c7e.',
    );
    expect(prompt).toContain('Repository: o/r · base main');
    expect(prompt).toContain(`Run: #103 (id 9003) · attempt 1 · revision ${r.sha}`);
    expect(prompt).toContain('Fix branch: fix/12-run-103');
    expect(prompt).toContain(
      'Job 90033: unit tests · log https://github.com/o/r/actions/runs/9003/job/90033',
    );
    expect(prompt).toContain('Evidence: rounds to two decimals · log line 4');
    expect(prompt).toContain('Artifact 8: e2e-report');
    // an expired artifact never goes
    expect(prompt).not.toContain('playwright-trace');
    expect(prompt).not.toContain('Job 90031');
    expect(
      fixPrompt(r, INSPECTION_9003, {
        jobs,
        base: 'main',
        branch: 'x',
        message: ' Round once. ',
      }).split('\n')[0],
    ).toBe('Round once.');
  });
});

describe("the CLI's words", () => {
  test('list, acts and a fix', () => {
    const list = {
      provider: 'github-actions' as const,
      source: 'o/r',
      me: 'ann',
      runs: [run('9003')],
      workflows: [],
      deploys: [],
    };
    const text = pipelineListText(list, { now: NOW });

    expect(text).toBe(
      '✗ Failed  PR checks  #103 Fix cart rounding  fix/AB-7-rounding · PR #61  08:00  7m 00s',
    );
    // the deploys first, each with its newest run or never run
    expect(
      pipelineListText(
        {
          ...list,
          deploys: [
            { workflow: 'Deploy Dev', environment: 'dev', run: run('9000') },
            { workflow: 'Deploy Prod', environment: 'prod', run: null },
          ],
        },
        { now: NOW },
      ).split('\n'),
    ).toEqual([
      'Deploys',
      '  Deploy Dev → dev  ✓ Passed  PR checks  #100 Login redirect keeps the query  fix/login-redirect · PR #59  07:10  6m 00s',
      '  Deploy Prod → prod  never run',
      '',
      text,
    ]);
    expect(
      pipelineListText({
        provider: 'azure-pipelines',
        source: 'contoso/Shop',
        me: null,
        runs: [],
        workflows: [],
        deploys: [],
      }),
    ).toBe('No runs on contoso/Shop (Azure Pipelines)');
    expect(
      pipelineActText({
        run: '9007',
        named: '#107',
        did: 'approve',
        attempt: 1,
        environment: 'production',
      }),
    ).toBe('Run #107: production approved');
    expect(
      pipelineFixText({
        run: '9003',
        named: '#103',
        card: 12,
        session: '12-a1b2',
        branch: 'fix/12-run-103',
        sent: 'launched',
      }),
    ).toBe('Fixing run #103: session 12-a1b2 on fix/12-run-103 (#12)');
  });
});
