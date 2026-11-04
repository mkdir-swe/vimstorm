/**
 * Pipelines on GitHub Actions against the fake `gh` (1.0's abe-ports `pipelines` cases, ported):
 * the runs in core's shape, a run with its jobs as stages and its pending deployment as the gate,
 * an approval, an attempt inspected with its graph from the run's own revision and its artifacts
 * tied to the job whose log names their upload, the reruns and the cancel read the run again first
 * and never repeat an uncertain write; Azure Pipelines against a local server standing in for
 * Azure DevOps.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type Gate } from '@abe/core';
import { fakeGh, type FakeGh } from '@abe/testing';
import { adoPipelines } from '../azure-devops/pipelines-azure';
import { ghPipelines } from './pipelines';
import { ghRunner } from './gh';

const GH = { provider: 'github-actions', repo: 'o/r' } as const;
const AZ = {
  provider: 'azure-pipelines',
  organization: 'https://dev.azure.com/contoso',
  project: 'Shop Web',
} as const;

const restRun = (id: number, more: Record<string, unknown> = {}) => ({
  id,
  name: 'PR checks',
  run_number: 103,
  display_title: 'Fix cart rounding',
  head_branch: 'fix/x',
  head_sha: 'cafe1234567',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-10-01T08:00:00Z',
  run_started_at: '2026-10-01T08:00:05Z',
  updated_at: '2026-10-01T08:07:00Z',
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  run_attempt: 1,
  path: '.github/workflows/pr.yml',
  actor: { login: 'bob' },
  triggering_actor: { login: 'ann' },
  pull_requests: [{ number: 61 }],
  ...more,
});

const restJob = (id: number, name: string, status: string, conclusion: string | null) => ({
  id,
  name,
  status,
  conclusion,
  started_at: '2026-10-01T08:00:10Z',
  completed_at: status === 'completed' ? '2026-10-01T08:01:10Z' : null,
  html_url: `https://github.com/o/r/actions/runs/91/job/${id}`,
  labels: ['ubuntu-latest'],
  steps: [{ name: 'Run npm test', status, conclusion }],
});

describe('Pipelines on GitHub Actions', () => {
  let gh: FakeGh | undefined;
  const start = (answers: Parameters<typeof fakeGh>[0]) => {
    gh = fakeGh(answers);

    return { gh, p: ghPipelines(ghRunner({ PATH: gh.path })) };
  };

  afterEach(() => {
    gh?.remove();
  });

  test('runs map to the run shape: who started it, its attempt, revision and pull request', async () => {
    const { p, gh } = start([
      [
        'actions/runs?per_page=30',
        {
          json: {
            workflow_runs: [
              restRun(91),
              restRun(92, {
                name: 'Deploy Prod',
                display_title: 'Release rc-213',
                event: 'workflow_dispatch',
                status: 'waiting',
                conclusion: null,
                pull_requests: [],
                triggering_actor: null,
              }),
            ],
          },
        },
      ],
    ]);
    const runs = await p.runs(GH, 30);

    expect(runs).toMatchObject({
      ok: true,
      data: [
        {
          id: '91',
          number: '103',
          pipeline: 'PR checks',
          title: 'Fix cart rounding',
          branch: 'fix/x',
          trigger: 'pull request',
          actor: 'ann',
          status: 'failed',
          startedAt: '2026-10-01T08:00:05Z',
          finishedAt: '2026-10-01T08:07:00Z',
          sha: 'cafe1234567',
          attempt: 1,
          pr: 61,
        },
        {
          id: '92',
          name: 'rc-213',
          trigger: 'manual',
          actor: 'bob',
          status: 'waiting',
          finishedAt: null,
          pr: null,
        },
      ],
    });
    expect(gh.calls()[0]?.argv).toEqual(['api', 'repos/o/r/actions/runs?per_page=30']);
  });

  test("a run is its workflow's by the catalog, never by its run-name; one the catalog lacks by its name", async () => {
    // `run-name:` set, GitHub's `name` of a run is that run-name, not its workflow's name
    const runs = [
      restRun(66, {
        name: 'Deploy Prod: rc-902',
        display_title: 'Deploy Prod: rc-902',
        workflow_id: 11,
        path: '.github/workflows/deploy-prod.yml',
        event: 'workflow_dispatch',
      }),
      restRun(67, {
        name: 'rc-920: Bump the cart service',
        display_title: 'rc-920: Bump the cart service',
        workflow_id: 12,
        path: '.github/workflows/deploy.yml',
        event: 'push',
      }),
      // a dynamic workflow (CodeQL's default setup) is in the catalog too
      restRun(68, {
        name: 'CodeQL',
        display_title: 'Push on main',
        workflow_id: 13,
        path: 'dynamic/github-code-scanning/codeql',
        event: 'dynamic',
      }),
      // no workflow id: by its file
      restRun(69, {
        name: 'rc-921: Cart badge',
        display_title: 'rc-921: Cart badge',
        path: '.github/workflows/deploy.yml',
      }),
      // a workflow the catalog does not hold: the name GitHub gives
      restRun(70, { workflow_id: 99, path: '.github/workflows/gone.yml' }),
    ];
    const { p } = start([
      ['actions/runs/66', { json: { ...runs[0], jobs: [] } }],
      ['actions/workflows/deploy-prod.yml/runs', { json: { workflow_runs: [runs[0]] } }],
      ['actions/runs?per_page=30', { json: { workflow_runs: runs } }],
      [
        'actions/workflows?per_page=100',
        {
          json: {
            workflows: [
              { id: 11, name: 'Deploy Prod', path: '.github/workflows/deploy-prod.yml' },
              { id: 12, name: 'Deploy Dev/Test', path: '.github/workflows/deploy.yml' },
              { id: 13, name: 'CodeQL', path: 'dynamic/github-code-scanning/codeql' },
            ],
          },
        },
      ],
    ]);
    const listed = await p.runs(GH, 30);

    expect(listed.ok && listed.data.map((r) => [r.pipeline, r.name, r.title])).toEqual([
      ['Deploy Prod', 'rc-902', 'Deploy Prod: rc-902'],
      ['Deploy Dev/Test', 'rc-920', 'Bump the cart service'],
      ['CodeQL', null, 'Push on main'],
      ['Deploy Dev/Test', 'rc-921', 'Cart badge'],
      ['PR checks', null, 'Fix cart rounding'],
    ]);
    // the workflow's own runs, and a run read in full, by the same name
    const prod = await p.runs(GH, 30, undefined, { workflow: 'Deploy Prod' });

    expect(prod.ok && prod.data.map((r) => [r.id, r.pipeline])).toEqual([['66', 'Deploy Prod']]);
    expect(await p.run(GH, '66')).toMatchObject({ ok: true, data: { pipeline: 'Deploy Prod' } });
  });

  test("a branch's newest run: asked of GitHub on that branch", async () => {
    const { p, gh } = start([
      ['actions/runs?per_page=1', { json: { workflow_runs: [restRun(91)] } }],
    ]);

    expect(await p.runs(GH, 1, 'card/2-cart & tax')).toMatchObject({
      ok: true,
      data: [{ id: '91' }],
    });
    expect(gh.calls()[0]?.argv).toEqual([
      'api',
      'repos/o/r/actions/runs?per_page=1&branch=card%2F2-cart%20%26%20tax',
    ]);
  });

  test('a run is read with its jobs as stages and its pending deployment as the gate', async () => {
    const { p } = start([
      [
        'actions/runs/92/jobs',
        {
          json: {
            jobs: [
              restJob(1, 'build', 'completed', 'success'),
              restJob(2, 'deploy · production', 'waiting', null),
            ],
          },
        },
      ],
      [
        'actions/runs/92/pending_deployments',
        {
          json: [{ environment: { id: 9, name: 'production' }, current_user_can_approve: true }],
        },
      ],
      ['actions/runs/92', { json: restRun(92, { status: 'waiting', conclusion: null }) }],
    ]);
    const r = await p.run(GH, '92');

    expect(r.ok && r.data.stages).toEqual([
      {
        name: 'build',
        status: 'passed',
        startedAt: '2026-10-01T08:00:10Z',
        finishedAt: '2026-10-01T08:01:10Z',
        gate: null,
      },
      {
        name: 'deploy · production',
        status: 'waiting',
        startedAt: '2026-10-01T08:00:10Z',
        finishedAt: null,
        gate: {
          id: '9',
          kind: 'environment',
          environment: 'production',
          since: null,
          canApprove: true,
        },
      },
    ]);
  });

  test('several environments waiting are never matched to jobs by the order of two answers', async () => {
    const { p } = start([
      [
        'actions/runs/92/jobs',
        {
          json: {
            jobs: [
              restJob(1, 'deploy eu', 'waiting', null),
              restJob(2, 'deploy us', 'waiting', null),
            ],
          },
        },
      ],
      [
        'actions/runs/92/pending_deployments',
        {
          json: [
            { environment: { id: 1, name: 'prod-eu' }, current_user_can_approve: true },
            { environment: { id: 2, name: 'prod-us' }, current_user_can_approve: false },
          ],
        },
      ],
      ['actions/runs/92', { json: restRun(92, { status: 'waiting', conclusion: null }) }],
    ]);
    const r = await p.run(GH, '92');

    expect(r.ok && r.data.stages.map((s) => [s.name, s.gate?.environment ?? null])).toEqual([
      ['deploy eu', null],
      ['deploy us', null],
      ['Deployment approval: prod-eu', 'prod-eu'],
      ['Deployment approval: prod-us', 'prod-us'],
    ]);
  });

  test("approving posts the run's pending deployment to the gate's environment", async () => {
    const { p, gh } = start([
      [
        'pending_deployments --input',
        { json: [{ id: 1, environment: 'production', state: 'approved' }] },
      ],
      [
        'actions/runs/92/pending_deployments',
        { json: [{ environment: { id: 9, name: 'production' }, current_user_can_approve: true }] },
      ],
    ]);
    const gate: Gate = {
      id: '9',
      kind: 'environment',
      environment: 'production',
      since: null,
      canApprove: true,
    };

    expect(await p.approve(GH, '92', gate)).toEqual({ ok: true, data: null });
    const post = gh.calls().at(-1);

    expect(post?.argv).toEqual([
      'api',
      '-X',
      'POST',
      'repos/o/r/actions/runs/92/pending_deployments',
      '--input',
      '-',
    ]);
    expect(JSON.parse(post?.stdin ?? '')).toEqual({
      environment_ids: [9],
      state: 'approved',
      comment: '',
    });
    // a gate that is gone, or not yours, is said, never posted
    expect(await p.approve(GH, '92', { ...gate, environment: 'staging' })).toMatchObject({
      ok: false,
      error: { code: 'no-gate' },
    });
  });

  test('an attempt is inspected exactly: its jobs, its graph at its revision, artifacts tied by their upload', async () => {
    const { p, gh } = start([
      [
        'actions/runs/91/attempts/1/jobs',
        {
          json: {
            jobs: [
              restJob(21, 'build', 'completed', 'success'),
              restJob(22, 'e2e (chromium)', 'completed', 'failure'),
            ],
          },
        },
      ],
      [
        'actions/runs/91/artifacts',
        {
          json: {
            artifacts: [
              {
                id: 8,
                name: 'e2e-report',
                expired: false,
                workflow_run: { head_sha: 'cafe1234567' },
              },
              { id: 9, name: 'trace', expired: true, workflow_run: { head_sha: 'cafe1234567' } },
            ],
          },
        },
      ],
      [
        'contents/.github/workflows/pr.yml?ref=cafe1234567',
        {
          stdout:
            'jobs:\n  build: {}\n  e2e:\n    needs: build\n    strategy:\n      matrix:\n        browser: [chromium]\n',
        },
      ],
      ['actions/jobs/21/logs', { stdout: 'nothing uploaded\n' }],
      [
        'actions/jobs/22/logs',
        {
          stdout:
            '2026-10-01T08:01:00Z Artifact download URL: https://github.com/o/r/actions/runs/91/artifacts/8\n',
        },
      ],
      ['actions/runs/91', { json: restRun(91) }],
    ]);
    const i = await p.inspect(GH, '91');

    expect(i.ok).toBe(true);
    if (!i.ok) return;
    expect(i.data.edges).toEqual([['21', '22']]);
    expect(i.data.jobs[0]).toMatchObject({
      id: '21',
      runner: 'ubuntu-latest',
      startedAt: '2026-10-01T08:00:10Z',
      steps: [{ name: 'Run npm test', status: 'passed' }],
    });
    expect(i.data.jobs[1]?.group).toBeNull();
    expect(i.data.artifacts).toEqual([
      {
        id: '8',
        name: 'e2e-report',
        url: 'https://github.com/o/r/actions/runs/91/artifacts/8',
        expired: false,
        sha: 'cafe1234567',
        job: '22',
        attempt: 1,
      },
      {
        id: '9',
        name: 'trace',
        url: 'https://github.com/o/r/actions/runs/91/artifacts/9',
        expired: true,
        sha: 'cafe1234567',
        job: null,
        attempt: null,
      },
    ]);
    // the job logs are read once: an ended job's log never changes
    const reads = () => gh.calls().filter((c) => c.argv.join(' ').includes('/logs')).length;
    const first = reads();

    await p.inspect(GH, '91');
    expect(reads()).toBe(first);
  });

  test('a rerun reads the run first: another attempt or one still going is refused, never posted', async () => {
    const { p, gh } = start([
      ['actions/runs/91/rerun-failed-jobs', { json: {} }],
      ['actions/runs/91/cancel', { json: {} }],
      ['actions/runs/91', { json: restRun(91, { run_attempt: 2 }) }],
    ]);
    const posts = () => gh.calls().filter((c) => c.argv.includes('POST')).length;

    expect(await p.control(GH, '91', 1, 'rerun-failed')).toMatchObject({
      ok: false,
      error: { code: 'attempt-changed' },
    });
    expect(posts()).toBe(0);
    expect(await p.control(GH, '91', 2, 'rerun-failed')).toEqual({ ok: true, data: null });
    expect(gh.calls().at(-1)?.argv).toEqual([
      'api',
      '--method',
      'POST',
      'repos/o/r/actions/runs/91/rerun-failed-jobs',
    ]);
    // sent once: the same write again waits for the provider, never posts twice
    expect(await p.control(GH, '91', 2, 'rerun-failed')).toMatchObject({
      ok: false,
      error: { code: 'uncertain' },
    });
    expect(posts()).toBe(1);
    // a run that ended needs no cancel
    expect(await p.control(GH, '91', 2, 'cancel')).toEqual({ ok: true, data: null });
    expect(posts()).toBe(1);
    gh.answer([
      ['actions/runs/91', { json: restRun(91, { status: 'in_progress', conclusion: null }) }],
    ]);
    expect(await p.control(GH, '91', 1, 'rerun')).toMatchObject({
      ok: false,
      error: { code: 'still-running' },
    });
  });

  test('a write whose answer was lost is read again, said uncertain and not sent again', async () => {
    const { p, gh } = start([
      ['actions/runs/91/rerun', { stderr: 'gh: HTTP 502 Bad Gateway', exit: 1 }],
      ['actions/runs/91', { json: restRun(91) }],
    ]);

    expect(await p.control(GH, '91', 1, 'rerun')).toMatchObject({
      ok: false,
      error: { code: 'uncertain' },
    });
    expect(await p.control(GH, '91', 1, 'rerun')).toMatchObject({
      ok: false,
      error: { code: 'uncertain' },
    });
    expect(gh.calls().filter((c) => c.argv.includes('POST'))).toHaveLength(1);
  });

  test("GitHub's own refusal of a rerun is said as it is, and a later try may send it again", async () => {
    const { p, gh } = start([
      [
        'actions/runs/91/rerun',
        { stderr: 'gh: This workflow run cannot be rerun (HTTP 403)', exit: 1 },
      ],
      ['actions/runs/91', { json: restRun(91) }],
    ]);

    expect(await p.control(GH, '91', 1, 'rerun')).toMatchObject({
      ok: false,
      error: { message: 'gh: This workflow run cannot be rerun (HTTP 403)' },
    });
    await p.control(GH, '91', 1, 'rerun');
    expect(gh.calls().filter((c) => c.argv.includes('POST'))).toHaveLength(2);
  });

  test("the workflow catalog names one that never ran; a job's log, none while it has none", async () => {
    const { p } = start([
      ['actions/workflows', { json: { workflows: [{ name: 'PR checks' }, { name: 'Nightly' }] } }],
      ['actions/jobs/7/logs', { stdout: 'line 1\nline 2' }],
    ]);

    expect(await p.workflows(GH)).toEqual({ ok: true, data: ['PR checks', 'Nightly'] });
    expect(await p.log(GH, '91', '7')).toEqual({ ok: true, data: 'line 1\nline 2' });
    expect(await p.log(GH, '91', '8')).toEqual({ ok: true, data: null });
  });
});

describe('Pipelines on Azure Pipelines', () => {
  const builds = {
    value: [
      {
        id: 91,
        buildNumber: '20261001.3',
        definition: { id: 7, name: 'Shop release' },
        sourceBranch: 'refs/heads/main',
        sourceVersion: 'abc123',
        reason: 'manual',
        status: 'completed',
        result: 'failed',
        queueTime: '2026-10-01T08:49:00Z',
        startTime: '2026-10-01T08:50:00Z',
        finishTime: '2026-10-01T08:55:00Z',
        requestedFor: { displayName: 'Ann' },
        triggerInfo: { 'ci.message': 'Cart fixes', 'pr.number': '12' },
        _links: {
          web: { href: 'https://dev.azure.com/contoso/Shop%20Web/_build/results?buildId=91' },
        },
      },
    ],
  };
  const timeline = {
    records: [
      {
        id: 's1',
        type: 'Stage',
        name: 'Build',
        identifier: 'Build',
        state: 'completed',
        result: 'failed',
        order: 1,
      },
      { id: 'p1', type: 'Phase', parentId: 's1', name: 'Compile' },
      {
        id: 'j1',
        type: 'Job',
        parentId: 'p1',
        name: 'Compile',
        identifier: 'Build.Compile',
        state: 'completed',
        result: 'succeeded',
        startTime: '2026-10-01T08:50:00Z',
        log: { id: 5 },
      },
      {
        id: 't1',
        type: 'Task',
        parentId: 'j1',
        name: 'npm ci',
        state: 'completed',
        result: 'succeeded',
        order: 1,
      },
      { id: 'p2', type: 'Phase', parentId: 's1', name: 'Test' },
      {
        id: 'j2',
        type: 'Job',
        parentId: 'p2',
        name: 'Test',
        identifier: 'Build.Test',
        state: 'completed',
        result: 'failed',
      },
      { id: 's2', type: 'Stage', name: 'Prod', identifier: 'Prod', state: 'pending', order: 2 },
      { id: 'c2', type: 'Checkpoint', parentId: 's2' },
      {
        id: 'a2',
        type: 'Checkpoint.Approval',
        parentId: 'c2',
        state: 'inProgress',
        startTime: '2026-10-01T08:56:00Z',
      },
    ],
  };
  const seen: string[] = [];
  const server = Bun.serve({
    // 127.0.0.1, as fetched: a port 0 on the default [::] may answer nothing there (a hang)
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      seen.push(`${req.method} ${decodeURIComponent(url.pathname)}${url.search}`);
      const path = decodeURIComponent(url.pathname);
      const json = (v: unknown) => Response.json(v);

      if (path.endsWith('/_apis/build/builds')) return json(builds);
      if (path.endsWith('/_apis/build/builds/91')) return json(builds.value[0]);
      if (path.endsWith('/_apis/build/builds/91/timeline')) return json(timeline);
      if (path.endsWith('/_apis/build/builds/91/logs/5'))
        return json({ count: 2, value: ['2026-10-01T08:50:01.0000000Z npm ci', 'done'] });
      if (path.endsWith('/_apis/build/definitions/7'))
        return json({
          process: { yamlFilename: '/azure-pipelines.yml' },
          repository: { type: 'TfsGit', id: 'repo1' },
        });
      if (path.endsWith('/_apis/git/repositories/repo1/items'))
        return json({
          content:
            'stages:\n- stage: Build\n  jobs:\n  - job: Compile\n  - job: Test\n    dependsOn: Compile\n',
        });
      if (path.endsWith('/_apis/pipelines/approvals') && req.method === 'PATCH')
        return json({ value: [await req.json()] });

      return new Response('{"message":"no"}', { status: 404 });
    },
  });
  const p = adoPipelines({
    tokens: { get: () => Promise.resolve({ ok: true, token: 'tok' }) },
    base: `http://127.0.0.1:${server.port}`,
  });

  test('builds map to the run shape; a build is read with its stages and a waiting approval as its gate', async () => {
    expect(await p.runs(AZ, 30)).toMatchObject({
      ok: true,
      data: [
        {
          id: '91',
          number: '20261001.3',
          pipeline: 'Shop release',
          title: 'Cart fixes',
          branch: 'main',
          trigger: 'manual',
          actor: 'Ann',
          status: 'failed',
          sha: 'abc123',
          pr: 12,
          attempt: 1,
        },
      ],
    });
    expect(seen.at(-1)).toBe(
      'GET /contoso/Shop Web/_apis/build/builds?api-version=7.1&%24top=30&queryOrder=queueTimeDescending',
    );
    // a branch's newest: the builds of its ref
    expect(await p.runs(AZ, 1, 'card/2-cart')).toMatchObject({ ok: true, data: [{ id: '91' }] });
    expect(seen.at(-1)).toBe(
      'GET /contoso/Shop Web/_apis/build/builds?api-version=7.1&%24top=1&queryOrder=queueTimeDescending&branchName=refs%2Fheads%2Fcard%2F2-cart',
    );
    const r = await p.run(AZ, '91');

    expect(r.ok && r.data.stages).toEqual([
      { name: 'Build', status: 'failed', startedAt: null, finishedAt: null, gate: null },
      {
        name: 'Prod',
        status: 'waiting',
        startedAt: null,
        finishedAt: null,
        gate: {
          id: 'a2',
          kind: 'approval',
          environment: 'Prod',
          since: '2026-10-01T08:56:00Z',
          canApprove: true,
        },
      },
    ]);
  });

  test("a build is inspected from its timeline and its Azure Repos YAML; a job's log is its lines", async () => {
    const i = await p.inspect(AZ, '91');

    expect(i.ok).toBe(true);
    if (!i.ok) return;
    expect(i.data.jobs.map((j) => [j.id, j.name, j.status, j.group])).toEqual([
      ['j1', 'Compile', 'passed', 'Build'],
      ['j2', 'Test', 'failed', 'Build'],
    ]);
    expect(i.data.jobs[0]?.steps).toEqual([
      { name: 'npm ci', status: 'passed', startedAt: null, finishedAt: null },
    ]);
    expect(i.data.edges).toEqual([['j1', 'j2']]);
    expect(seen.some((s) => s.includes('versionDescriptor.version=abc123'))).toBe(true);
    expect(await p.log(AZ, '91', 'j1')).toEqual({
      ok: true,
      data: '2026-10-01T08:50:01.0000000Z npm ci\ndone',
    });
    expect(await p.log(AZ, '91', 'j2')).toEqual({ ok: true, data: null });
  });

  test("an approval is patched; run controls are said to be GitHub's only", async () => {
    const gate: Gate = {
      id: 'a2',
      kind: 'approval',
      environment: 'Prod',
      since: null,
      canApprove: true,
    };

    expect(await p.approve(AZ, '91', gate)).toEqual({ ok: true, data: null });
    expect(seen.at(-1)).toBe(
      'PATCH /contoso/Shop Web/_apis/pipelines/approvals?api-version=7.1-preview.1',
    );
    expect(await p.control(AZ, '91', 1, 'rerun')).toMatchObject({
      ok: false,
      error: { code: 'unsupported' },
    });
  });
});

describe('Azure Pipelines runs waiting at an approval (#236)', () => {
  const build = (id: number, status: string, result?: string) => ({
    id,
    buildNumber: `20261001.${id}`,
    definition: { id: 7, name: 'Shop release' },
    sourceBranch: 'refs/heads/main',
    status,
    ...(result === undefined ? {} : { result }),
    queueTime: '2026-10-01T08:49:00Z',
  });
  /** The fake's builds and pending approvals; the approvals read answers `approvals` (a status). */
  const serve = (o: { builds: unknown[]; approvals: unknown[] | number }) => {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        const path = decodeURIComponent(url.pathname);

        seen.push(`${req.method} ${path}${url.search}`);
        if (path.endsWith('/_apis/build/builds')) return Response.json({ value: o.builds });
        if (path.endsWith('/_apis/pipelines/approvals') && req.method === 'GET')
          return typeof o.approvals === 'number'
            ? new Response('{"message":"no"}', { status: o.approvals })
            : Response.json({ count: o.approvals.length, value: o.approvals });

        return new Response('{"message":"no"}', { status: 404 });
      },
    });
    const p = adoPipelines({
      tokens: { get: () => Promise.resolve({ ok: true, token: 'tok' }) },
      base: `http://127.0.0.1:${server.port}`,
    });

    return { p, seen, stop: () => server.stop(true) };
  };
  const pending = (build: number) => ({
    id: `a-${build}`,
    status: 'pending',
    pipeline: { id: 7, name: 'Shop release', owner: { id: build, name: `20261001.${build}` } },
  });

  test('an in-progress build a pending approval names is waiting; the others stand as they are', async () => {
    const f = serve({
      builds: [build(93, 'inProgress'), build(92, 'inProgress'), build(91, 'completed', 'failed')],
      approvals: [pending(92)],
    });

    try {
      const runs = await f.p.runs(AZ, 30);

      expect(runs.ok && runs.data.map((r) => [r.id, r.status])).toEqual([
        ['93', 'running'],
        ['92', 'waiting'],
        ['91', 'failed'],
      ]);
      const asked = f.seen.at(-1) ?? '';

      expect(asked).toStartWith('GET /contoso/Shop Web/_apis/pipelines/approvals?');
      expect(asked).toContain('state=pending');
    } finally {
      await f.stop();
    }
  });

  test('a build read in full that a stage holds at its approval is waiting too', async () => {
    const records = [
      { id: 's1', type: 'Stage', name: 'Prod', state: 'pending', order: 1 },
      { id: 'c1', type: 'Checkpoint', parentId: 's1' },
      { id: 'a1', type: 'Checkpoint.Approval', parentId: 'c1', state: 'inProgress' },
    ];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        const path = decodeURIComponent(new URL(req.url).pathname);

        if (path.endsWith('/_apis/build/builds/92')) return Response.json(build(92, 'inProgress'));
        if (path.endsWith('/_apis/build/builds/92/timeline')) return Response.json({ records });

        return new Response('{"message":"no"}', { status: 404 });
      },
    });
    const p = adoPipelines({
      tokens: { get: () => Promise.resolve({ ok: true, token: 'tok' }) },
      base: `http://127.0.0.1:${server.port}`,
    });

    try {
      expect(await p.run(AZ, '92')).toMatchObject({
        ok: true,
        data: { status: 'waiting', stages: [{ name: 'Prod', status: 'waiting' }] },
      });
    } finally {
      await server.stop(true);
    }
  });

  test('no build in progress: no approvals read; approvals not to be read: the builds as they are', async () => {
    const done = serve({ builds: [build(91, 'completed', 'succeeded')], approvals: [pending(91)] });

    try {
      expect(await done.p.runs(AZ, 30)).toMatchObject({ ok: true, data: [{ status: 'passed' }] });
      expect(done.seen.some((s) => s.includes('approvals'))).toBe(false);
    } finally {
      await done.stop();
    }
    const refused = serve({ builds: [build(92, 'inProgress')], approvals: 403 });

    try {
      expect(await refused.p.runs(AZ, 30)).toMatchObject({
        ok: true,
        data: [{ id: '92', status: 'running' }],
      });
    } finally {
      await refused.stop();
    }
  });
});
