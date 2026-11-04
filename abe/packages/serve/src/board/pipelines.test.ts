/**
 * `abe pipeline …` through the CLI seam (2.2's Pipelines tab): the real `abe` and its `serve` on a
 * fake `gh` answering GitHub Actions' REST, a checkout whose origin is o/r on GitHub (fetched from
 * a local bare clone through `insteadOf`), the fake Azure DevOps for the cards and a fake `claude`
 * in a real `tmux` for Fix with agent. The `pipelines` setting picks the provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Inspection,
  type LayerSource,
  PipelineActData,
  PipelineFixData,
  PipelineListData,
  PipelineLogData,
  PipelineRun,
  PipelineRunData,
  PipelineWorkflowsData,
  SessionListData,
} from '@abe/core';
import {
  claudeOutput,
  cli,
  type Cli,
  FAKE_GITHUB_TOKEN,
  fakeAdo,
  type FakeAdo,
  fakeAz,
  type FakeAz,
  fakeClaude,
  type FakeClaude,
  fakeGh,
  type FakeGh,
  fakePipelines,
  pipelineRun,
  served,
  tmuxPath,
  until,
  installDone,
} from '@abe/testing';
import { z } from 'zod';
import { newestRunOn } from './pipelines';
import { fixedSettings, type SettingsService } from '../layer/settings';

const env = (home: string) => ({
  PATH: '/usr/bin:/bin',
  HOME: home,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.test',
});

const git = (cwd: string, ...args: string[]) => {
  const ran = Bun.spawnSync(['git', '-C', cwd, ...args], { env: env(cwd) });

  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`);

  return ran.stdout.toString().trim();
};

/** Card 4's session branch on the fake board (`cardBranch`). */
const CARD_BRANCH = 'card/4-as-a-visitor-i-can';

const run = (id: number, branch: string, sha: string, more: Record<string, unknown> = {}) => ({
  id,
  name: 'PR checks',
  run_number: id + 12,
  display_title: `Run ${id}`,
  head_branch: branch,
  head_sha: sha,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-10-01T08:00:00Z',
  run_started_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-01T08:07:00Z',
  html_url: `https://github.com/o/r/actions/runs/${id}`,
  run_attempt: 1,
  path: '.github/workflows/pr.yml',
  triggering_actor: { login: 'ann' },
  pull_requests: [],
  ...more,
});

const job = (id: number, name: string, status: string, conclusion: string | null) => ({
  id,
  name,
  status,
  conclusion,
  started_at: '2026-10-01T08:00:10Z',
  completed_at: status === 'completed' ? '2026-10-01T08:01:10Z' : null,
  html_url: `https://github.com/o/r/actions/runs/91/job/${id}`,
  labels: ['ubuntu-latest'],
  steps: [],
});

const LOG = [
  '2026-10-01T08:01:06.0000000Z  ✗ src/cart.test.ts > rounds to two decimals',
  '2026-10-01T08:01:06.0000000Z     ❯ src/cart.test.ts:14:21',
  '2026-10-01T08:01:06.0000000Z ##[error]Process completed with exit code 1.',
].join('\n');

/** Deploy Prod's file: run by hand with an environment, a dry run and a version. */
const DEPLOY_YAML = [
  'name: Deploy Prod',
  'on:',
  '  workflow_dispatch:',
  '    inputs:',
  '      environment:',
  '        description: Where it deploys',
  '        type: choice',
  '        options: [dev, test]',
  '        default: dev',
  '        required: true',
  '      dry-run:',
  '        type: boolean',
  '        default: false',
  '      version:',
  '        description: The build to deploy',
  'jobs:',
  '  deploy: {}',
  '',
].join('\n');

/** GitHub's answers: #103 failed on card 4's branch, #104 failed on main, #105 at the prod gate. */
const answers = (sha: string): Parameters<typeof fakeGh>[0] => {
  const failedJobs = {
    json: {
      jobs: [
        job(21, 'build', 'completed', 'success'),
        job(22, 'unit tests', 'completed', 'failure'),
      ],
    },
  };

  return [
    ['auth token --hostname github.com --user me-work', { stdout: `${FAKE_GITHUB_TOKEN}\n` }],
    ['api user', { json: { login: 'ann' } }],
    // one workflow's runs, and the run Deploy Prod started by hand (made a while from now, so
    // it counts as made since it was asked)
    ['actions/workflows/pr.yml/runs', { json: { workflow_runs: [run(91, CARD_BRANCH, sha)] } }],
    [
      'actions/workflows/deploy.yml/runs',
      {
        json: {
          workflow_runs: [
            run(94, 'main', sha, {
              name: 'Deploy Prod',
              path: '.github/workflows/deploy.yml',
              event: 'workflow_dispatch',
              status: 'queued',
              conclusion: null,
              created_at: new Date(Date.now() + 10 * 60_000).toISOString(),
            }),
          ],
        },
      },
    ],
    ['workflow run deploy.yml', { stdout: '' }],
    ['contents/.github/workflows/deploy.yml', { stdout: DEPLOY_YAML }],
    ['contents/.github/workflows/pr.yml', { stdout: 'on: [pull_request]\njobs:\n  build: {}\n' }],
    [
      'actions/workflows',
      {
        json: {
          workflows: [
            { id: 1, name: 'PR checks', path: '.github/workflows/pr.yml', state: 'active' },
            { id: 2, name: 'Deploy Prod', path: '.github/workflows/deploy.yml', state: 'active' },
          ],
        },
      },
    ],
    [
      'actions/runs?per_page=',
      {
        json: {
          workflow_runs: [
            run(91, CARD_BRANCH, sha),
            run(92, 'main', sha),
            run(93, 'main', sha, {
              name: 'Deploy Prod',
              status: 'waiting',
              conclusion: null,
              event: 'workflow_dispatch',
            }),
          ],
        },
      },
    ],
    ['actions/runs/91/rerun-failed-jobs', { json: {} }],
    ['actions/runs/93/pending_deployments --input', { json: [] }],
    [
      'actions/runs/93/pending_deployments',
      { json: [{ environment: { id: 9, name: 'production' }, current_user_can_approve: true }] },
    ],
    ['actions/runs/93/attempts/1/jobs', { json: { jobs: [job(31, 'deploy', 'waiting', null)] } }],
    ['actions/runs/93/jobs', { json: { jobs: [job(31, 'deploy', 'waiting', null)] } }],
    ['actions/runs/91/attempts/1/jobs', failedJobs],
    ['actions/runs/92/attempts/1/jobs', failedJobs],
    ['actions/runs/91/jobs', failedJobs],
    ['actions/runs/92/jobs', failedJobs],
    ['/artifacts', { json: { artifacts: [] } }],
    ['actions/jobs/22/logs', { stdout: LOG }],
    ['actions/jobs/21/logs', { stdout: 'ok\n' }],
    ['actions/runs/91', { json: run(91, CARD_BRANCH, sha) }],
    ['actions/runs/92', { json: run(92, 'main', sha) }],
    [
      'actions/runs/93',
      { json: run(93, 'main', sha, { name: 'Deploy Prod', status: 'waiting', conclusion: null }) },
    ],
  ];
};

type World = {
  root: string;
  repo: string;
  sha: string;
  gh: FakeGh;
  ado: FakeAdo;
  az: FakeAz;
  claude: FakeClaude;
  abe: Cli;
};

const world = async (): Promise<World> => {
  const root = mkdtempSync(join(tmpdir(), 'abe-pipe-'));
  const repo = join(root, 'demo');
  const ado = await fakeAdo();
  const az = fakeAz({ tokens: ['token-one'] });
  const claude = fakeClaude();

  for (const dir of ['mine', 'demo/.abe', 'bare/o'])
    mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'mine', 'settings.yaml'), 'serve.target: local\n');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  // the repo's settings, committed: its board
  writeFileSync(join(repo, 'abe.yaml'), `board: ${JSON.stringify(ado.board)}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const sha = git(repo, 'rev-parse', 'HEAD');

  // o/r on GitHub as the checkout's config writes it, fetched from a bare clone here
  git(join(root, 'bare', 'o'), 'clone', '-q', '--bare', repo, 'r.git');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(repo, 'config', `url.file://${join(root, 'bare')}/.insteadOf`, 'https://github.com/');
  const gh = fakeGh(answers(sha));
  const abe = cli({
    env: {
      PATH: `${gh.dir}:${claude.dir}:${az.dir}:/usr/bin:/bin`,
      ABE_CONFIG_DIR: join(root, 'mine'),
      ABE_TMUX: tmuxPath(),
      ...ado.env,
    },
  });

  // the Mac's serve starts a card only where the install is done
  await installDone(abe.state.dir, repo);

  return { root, repo, sha, gh, ado, az, claude, abe };
};

const done = async (w: World) => {
  await w.abe.close();
  await w.ado.stop();
  w.gh.remove();
  w.az.remove();
  w.claude.remove();
  rmSync(w.root, { recursive: true, force: true });
};

describe('abe pipeline on GitHub Actions', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await done(w);
  });

  test("list: the checkout's origin's runs, its workflows and who you are", async () => {
    const out = await w.abe.json(PipelineListData, 'pipeline', 'list', '--repo', w.repo);

    expect(out.doc).toMatchObject({
      ok: true,
      data: {
        provider: 'github-actions',
        source: 'o/r',
        me: 'ann',
        workflows: ['PR checks', 'Deploy Prod'],
      },
    });
    expect(out.doc.ok && out.doc.data.runs.map((r) => [r.id, r.number, r.status])).toEqual([
      ['91', '103', 'failed'],
      ['92', '104', 'failed'],
      ['93', '105', 'waiting'],
    ]);
    // the person's words: one run a line
    const text = await w.abe.runWith({ cwd: w.repo }, 'pipeline', 'list');

    expect(text.stdout).toContain('✗ Failed  PR checks  #103 Run 91');
  });

  test('a folder with no GitHub origin is refused, saying so', async () => {
    const out = await w.abe.json(PipelineListData, 'pipeline', 'list', '--repo', w.root);

    expect(out.doc).toMatchObject({ ok: false, error: { code: 'no-github-repo' } });
  });

  test("show, inspect and log: a run in full, its attempt's jobs, a job's log", async () => {
    const shown = await w.abe.json(PipelineRun, 'pipeline', 'show', '93', '--repo', w.repo);

    expect(shown.doc.ok && shown.doc.data.stages[0]?.gate?.environment).toBe('production');
    const i = await w.abe.json(Inspection, 'pipeline', 'inspect', '91', '--repo', w.repo);

    expect(i.doc.ok && i.doc.data.jobs.map((j) => [j.id, j.status])).toEqual([
      ['21', 'passed'],
      ['22', 'failed'],
    ]);
    const log = await w.abe.json(
      PipelineLogData,
      'pipeline',
      'log',
      '91',
      '--job',
      '22',
      '--repo',
      w.repo,
    );

    expect(log.doc).toMatchObject({ ok: true, data: { run: '91', job: '22', log: LOG } });
  });

  test("list --workflow reads that workflow's runs from GitHub, --page a later page", async () => {
    const out = await w.abe.json(
      PipelineListData,
      'pipeline',
      'list',
      '--workflow',
      'PR checks',
      '--page',
      '2',
      '--repo',
      w.repo,
    );

    expect(out.doc.ok && out.doc.data.runs.map((r) => r.id)).toEqual(['91']);
    const asked = w.gh
      .calls()
      .map((c) => c.argv.join(' '))
      .filter((c) => c.includes('actions/workflows/pr.yml/runs'));

    expect(asked.at(-1)).toContain('actions/workflows/pr.yml/runs?per_page=30&page=2');
  });

  test('workflows: which run by hand at a ref and their inputs; run: gh workflow run, then its run once listed', async () => {
    const listed = await w.abe.json(
      PipelineWorkflowsData,
      'pipeline',
      'workflows',
      '--ref',
      'main',
      '--repo',
      w.repo,
    );

    expect(listed.doc).toMatchObject({
      ok: true,
      data: {
        ref: 'main',
        note: null,
        workflows: [
          { name: 'PR checks', file: 'pr.yml', dispatch: false, inputs: [] },
          {
            name: 'Deploy Prod',
            file: 'deploy.yml',
            dispatch: true,
            inputs: [
              {
                name: 'environment',
                description: 'Where it deploys',
                type: 'choice',
                required: true,
                default: 'dev',
                options: ['dev', 'test'],
              },
              { name: 'dry-run', type: 'boolean', required: false, default: 'false', options: [] },
              { name: 'version', type: 'string', required: false, default: null, options: [] },
            ],
          },
        ],
      },
    });
    // by its name, on the checkout's branch when none is named: gh asked as the person
    const ran = await w.abe.json(
      PipelineRunData,
      'pipeline',
      'run',
      'Deploy Prod',
      '--input',
      'environment=test',
      '--input',
      'dry-run=true',
      '--repo',
      w.repo,
    );

    expect(ran.doc).toMatchObject({
      ok: true,
      data: {
        workflow: 'Deploy Prod',
        file: 'deploy.yml',
        ref: 'main',
        inputs: { environment: 'test', 'dry-run': 'true' },
        run: { id: '94', number: '106', trigger: 'manual', status: 'queued' },
      },
    });
    expect(w.gh.calls().find((c) => c.argv[0] === 'workflow')?.argv).toEqual([
      'workflow',
      'run',
      'deploy.yml',
      '--repo',
      'o/r',
      '--ref',
      'main',
      '-f',
      'environment=test',
      '-f',
      'dry-run=true',
    ]);
    // one not run by hand is refused before anything is sent
    const sent = w.gh.calls().filter((c) => c.argv[0] === 'workflow').length;
    const no = await w.abe.json(PipelineRunData, 'pipeline', 'run', 'pr.yml', '--repo', w.repo);

    expect(no.doc).toMatchObject({ ok: false, error: { code: 'not-dispatchable' } });
    expect(w.gh.calls().filter((c) => c.argv[0] === 'workflow')).toHaveLength(sent);
    const text = await w.abe.runWith({ cwd: w.repo }, 'pipeline', 'run', 'deploy.yml');

    expect(text.stdout.trim()).toBe('Started Deploy Prod on main · run #106');
  });

  test('rerun acts on the attempt named; a prod approval only with --yes, never posted without', async () => {
    const posts = () =>
      w.gh.calls().filter((c) => c.argv.includes('POST') || c.argv.includes('-X'));
    const rerun = await w.abe.runWith(
      { cwd: w.repo },
      'pipeline',
      'rerun',
      '91',
      '--attempt',
      '1',
      '--failed',
    );

    expect(rerun.stdout.trim()).toBe('Run #103: failed jobs rerun');
    // another attempt than the one named: refused, never posted
    const stale = await w.abe.json(
      PipelineActData,
      'pipeline',
      'rerun',
      '91',
      '--attempt',
      '2',
      '--repo',
      w.repo,
    );

    expect(stale.doc).toMatchObject({ ok: false, error: { code: 'attempt-changed' } });
    // a run that ended needs no cancel: said done, nothing posted
    const posted = posts().length;
    const cancel = await w.abe.json(
      PipelineActData,
      'pipeline',
      'cancel',
      '91',
      '--attempt',
      '1',
      '--repo',
      w.repo,
    );

    expect(cancel.doc).toMatchObject({ ok: true, data: { did: 'cancel', named: '#103' } });
    expect(posts()).toHaveLength(posted);
    const before = posts().length;
    const refused = await w.abe.json(
      PipelineActData,
      'pipeline',
      'approve',
      '93',
      '--environment',
      'production',
      '--repo',
      w.repo,
    );

    expect(refused.doc).toMatchObject({ ok: false, error: { code: 'prod-needs-yes' } });
    expect(posts()).toHaveLength(before);
    const approved = await w.abe.json(
      PipelineActData,
      'pipeline',
      'approve',
      '93',
      '--environment',
      'production',
      '--yes',
      '--repo',
      w.repo,
    );

    expect(approved.doc).toMatchObject({
      ok: true,
      data: { run: '93', named: '#105', did: 'approve', environment: 'production' },
    });
    expect(posts().at(-1)?.argv).toContain('repos/o/r/actions/runs/93/pending_deployments');
    const gone = await w.abe.json(
      PipelineActData,
      'pipeline',
      'approve',
      '93',
      '--environment',
      'staging',
      '--repo',
      w.repo,
    );

    expect(gone.doc).toMatchObject({ ok: false, error: { code: 'no-gate' } });
  });

  test("fix: a run on no card's branch asks which card; one with nothing failed is refused", async () => {
    const noCard = await w.abe.json(PipelineFixData, 'pipeline', 'fix', '92', '--repo', w.repo);

    expect(noCard.doc).toMatchObject({ ok: false, error: { code: 'no-card' } });
    const nothing = await w.abe.json(PipelineFixData, 'pipeline', 'fix', '93', '--repo', w.repo);

    expect(nothing.doc).toMatchObject({ ok: false, error: { code: 'no-failure' } });
  });

  test("fix: a Claude Code session on the card's own branch with the fix as its prompt; a live one gets the next as a message", async () => {
    const out = await w.abe.json(PipelineFixData, 'pipeline', 'fix', '91', '--repo', w.repo);

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    const fix = out.doc.data;

    expect(fix).toMatchObject({
      run: '91',
      named: '#103',
      card: 4,
      branch: CARD_BRANCH,
      sent: 'launched',
    });
    const listed = await w.abe.json(SessionListData, 'session', 'list');
    const s = listed.doc.ok
      ? listed.doc.data.sessions.find((x) => x.id === fix.session)
      : undefined;

    expect(s).toMatchObject({ card: 4, branch: CARD_BRANCH, kind: 'card' });
    const worktree = s?.worktree ?? '';

    // made from the failed revision: the branch was nowhere yet
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(w.sha);
    const argv = z
      .array(z.string())
      .parse(await until('the fix session’s claude', () => claudeOutput(worktree).argv));
    const prompt = argv.at(-1) ?? '';

    expect(prompt.split('\n')[0]).toBe(
      `PR checks run #103 (attempt 1) failed in unit tests on ${CARD_BRANCH} at ${w.sha.slice(0, 7)}.`,
    );
    expect(prompt).toContain('Repository: o/r · base main');
    expect(prompt).toContain(
      'Job 22: unit tests · log https://github.com/o/r/actions/runs/91/job/22',
    );
    // the card's session lives: the next fix goes to it, never a second session
    const again = await w.abe.json(
      PipelineFixData,
      'pipeline',
      'fix',
      '91',
      '--evidence',
      'rounds to two decimals · log line 1',
      '--repo',
      w.repo,
    );

    expect(again.doc).toMatchObject({
      ok: true,
      data: { sent: 'sent', session: fix.session, card: 4 },
    });
    // a failure on main fixed for card 4 goes to its live session, on that session's branch
    const main = await w.abe.json(
      PipelineFixData,
      'pipeline',
      'fix',
      '92',
      '--card',
      '4',
      '--repo',
      w.repo,
    );

    expect(main.doc).toMatchObject({ ok: true, data: { sent: 'sent', branch: CARD_BRANCH } });
    const typed = await until('the fix typed into the live session', () =>
      claudeOutput(worktree).typed.find((t) => typeof t === 'string' && t.includes('run #104')),
    );

    expect(typed).toContain(`Fix branch: ${CARD_BRANCH}`);
  });

  test('a fix branch from the failed revision when the run is on no card of its own', async () => {
    const out = await w.abe.json(
      PipelineFixData,
      'pipeline',
      'fix',
      '92',
      '--card',
      '5',
      '--repo',
      w.repo,
    );

    if (!out.doc.ok) throw new Error(JSON.stringify(out.doc.error));
    expect(out.doc.data).toMatchObject({ card: 5, branch: 'fix/5-run-104', sent: 'launched' });
  });
});

describe('abe pipeline on Azure Pipelines', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
    // yours for this repo says the runs are Azure's: the board's organization and project
    writeFileSync(join(w.repo, '.abe', 'settings.local.yaml'), 'pipelines: azure-pipelines\n');
  });
  afterAll(async () => {
    await done(w);
  });

  test("the board's organization and project are where the runs are read", async () => {
    await w.abe.json(PipelineListData, 'pipeline', 'list', '--repo', w.repo);
    const asked = w.ado.requests().filter((r) => r.includes('/_apis/build/builds'));

    expect(asked[0]).toContain(`/${w.ado.board.project}/_apis/build/builds`);
    expect(w.gh.calls().filter((c) => c.argv.join(' ').includes('actions/runs'))).toHaveLength(0);
  });
});

describe("abe pipeline as the --repo checkout's gh login and az folder (ADR 0030)", () => {
  let w: World;
  const mine = (more: string) => {
    writeFileSync(
      join(w.repo, '.abe', 'settings.local.yaml'),
      `${more}logins.gh: me-work\nboard:\n  azureConfigDir: ${join(w.root, 'az-shop')}\n`,
    );
  };

  beforeAll(async () => {
    w = await world();
    mine('');
  });
  afterAll(async () => {
    await done(w);
  });

  test("GitHub Actions: as that login's token, gh's own never switched", async () => {
    const out = await w.abe.json(PipelineListData, 'pipeline', 'list', '--repo', w.repo);
    const read = w.gh.calls().filter((c) => c.argv.join(' ').includes('actions/runs'));

    expect(out.doc).toMatchObject({ ok: true, data: { provider: 'github-actions' } });
    expect(read.length).toBeGreaterThan(0);
    for (const c of read) expect(c.env.GH_TOKEN).toBe(FAKE_GITHUB_TOKEN);
    expect(w.gh.calls().some((c) => c.argv.includes('switch'))).toBe(false);
  });

  test("Azure Pipelines: on the az login in that checkout's folder", async () => {
    mine('pipelines: azure-pipelines\n');
    // the edit is in force from serve's next poll
    await until('pipelines: azure-pipelines in force', async () =>
      (await w.abe.runWith({ cwd: w.repo }, 'settings', 'get', 'pipelines')).stdout.includes(
        'azure-pipelines',
      )
        ? true
        : undefined,
    );
    await w.abe.json(PipelineListData, 'pipeline', 'list', '--repo', w.repo);

    expect(w.ado.requests().some((r) => r.includes('/_apis/build/builds'))).toBe(true);
    expect(w.az.dirs()).toContain(join(w.root, 'az-shop'));
  });
});

describe("newestRunOn: Linked's Pipelines row, from the provider in force", () => {
  const settings = (doc: unknown): SettingsService => {
    const mine: LayerSource = { place: 'local', file: '/r/shop/.abe/settings.local.yaml', doc };

    return fixedSettings({ configDir: '/me', home: '/home' }, [mine]);
  };
  const BRANCH = 'card/2-cart';
  const runs = [
    pipelineRun('513', 'Shop CI', 'Cart', 'main', '08:30', 3),
    pipelineRun('512', 'Shop CI', 'Cart', BRANCH, '08:00', null, { status: 'running' }),
  ];
  const board = { organization: 'https://dev.azure.com/contoso', project: 'Shop', team: 'Web' };

  test("under Azure Pipelines: the board's project's newest build on the branch, GitHub never asked", async () => {
    const pipelines = fakePipelines({ runs });
    const got = await newestRunOn(
      { ports: { pipelines }, settings: settings({ pipelines: 'azure-pipelines', board }) },
      '/r/shop',
      BRANCH,
      { ok: false, error: { code: 'no-github-repo', message: 'origin is not a repo on GitHub' } },
    );

    expect(got).toMatchObject({ ok: true, data: { id: '512', status: 'running' } });
    expect(pipelines.sources).toEqual([
      { provider: 'azure-pipelines', organization: board.organization, project: 'Shop' },
    ]);
  });

  test("on GitHub Actions: in the story's repo; why it is not known is the row's; none ran is null", async () => {
    const pipelines = fakePipelines({ runs });
    const at = { ports: { pipelines }, settings: settings({}) };

    expect(await newestRunOn(at, '/r/shop', BRANCH, { ok: true, data: 'o/shop' })).toMatchObject({
      ok: true,
      data: { id: '512' },
    });
    expect(pipelines.sources).toEqual([{ provider: 'github-actions', repo: 'o/shop' }]);
    expect(
      await newestRunOn(at, '/r/shop', BRANCH, {
        ok: false,
        error: { code: 'no-github-repo', message: 'no origin' },
      }),
    ).toMatchObject({ ok: false, error: { message: 'no origin' } });
    expect(await newestRunOn(at, '/r/shop', 'card/9', { ok: true, data: 'o/shop' })).toEqual({
      ok: true,
      data: null,
    });
    // no repo known (as the Pull request row): nothing read
    expect(await newestRunOn(at, '/r/shop', BRANCH, undefined)).toEqual({ ok: true, data: null });
    expect(pipelines.sources).toHaveLength(2);
    expect(
      await newestRunOn(
        { ports: { pipelines: undefined }, settings: undefined },
        '/r',
        BRANCH,
        undefined,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'no-pipelines' },
    });
  });
});

describe("pipeline list's deploys: each deploy workflow's newest run, however old", () => {
  // a busy repo: 30 pull request checks newer than any deploy
  const checks = Array.from({ length: 30 }, (_, i) =>
    pipelineRun(String(9100 + i), 'PR checks', `Bump ${i}`, `dependabot/npm-${i}`, '08:30', 2),
  );
  const at = (id: string, workflow: string, day: string, more: Partial<PipelineRun> = {}) => ({
    ...pipelineRun(id, workflow, 'Release', 'main', '06:00', 5, { trigger: 'manual', ...more }),
    createdAt: `2026-09-${day}T06:00:00Z`,
    startedAt: `2026-09-${day}T06:00:00Z`,
    finishedAt: `2026-09-${day}T06:05:00Z`,
  });
  const files = [
    { name: 'PR checks', file: 'pr.yml', text: 'on: [pull_request]\njobs:\n  test: {}\n' },
    {
      name: 'Deploy Prod',
      file: 'deploy-prod.yml',
      text: 'on: workflow_dispatch\njobs:\n  go:\n    environment: production\n    steps:\n      - run: npm run deploy\n',
    },
    {
      name: 'Deploy Dev',
      file: 'deploy-dev.yml',
      text: 'on:\n  push:\n    branches: [main]\njobs:\n  go:\n    steps:\n      - run: ./ship.sh\n',
    },
    { name: 'Deploy Test', file: 'deploy-test.yml', text: null },
  ];

  test('pinned dev → test → prod, each read by its workflow; never run said; not with --workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'abe-deploys-'));
    const repo = join(root, 'shop');

    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/shop.git');
    const pipelines = fakePipelines({
      runs: [
        ...checks,
        at('8001', 'Deploy Prod', '20', { status: 'failed', actor: 'bob' }),
        at('8000', 'Deploy Dev', '18', { trigger: 'push' }),
        // an older Deploy Prod: not its newest
        at('7999', 'Deploy Prod', '10'),
      ],
      files,
    });
    const abe = await served({ pipelines, cwd: repo });
    const out = await abe.json(PipelineListData, 'pipeline', 'list');

    expect(out.doc.ok && out.doc.data.runs).toHaveLength(30);
    expect(
      out.doc.ok &&
        out.doc.data.deploys.map((d) => [d.workflow, d.environment, d.run?.id ?? 'never run']),
    ).toEqual([
      ['Deploy Dev', 'dev', '8000'],
      ['Deploy Test', 'test', 'never run'],
      ['Deploy Prod', 'production', '8001'],
    ]);
    const text = await abe.run('pipeline', 'list');

    expect(text.stdout).toContain('Deploys\n  Deploy Dev → dev  ✓ Passed  Deploy Dev');
    expect(text.stdout).toContain('  Deploy Test → test  never run');
    // one workflow's runs, or an older page: no deploys read
    const one = await abe.json(PipelineListData, 'pipeline', 'list', '--workflow', 'PR checks');

    expect(one.doc.ok && one.doc.data.deploys).toEqual([]);
    await abe.close();
    rmSync(root, { recursive: true, force: true });
  });
});
