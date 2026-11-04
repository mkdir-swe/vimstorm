/**
 * A run's graph from its own revision's workflow (1.0's abe-ports `graph` tables, ported): matrix
 * legs, reusable workflows, `needs` as an expression, a pull request's workflow that no longer
 * names every job, Azure's stages and jobs. The workflows here are the YAML as parsed.
 */
import { describe, expect, test } from 'bun:test';
import { azureGraph, githubGraph } from './pipeline-graph';

const jobs = (list: [string, string][]) => list.map(([id, name]) => ({ id, name }));
const none = () => undefined;

const MATRIX = {
  jobs: {
    build: { 'runs-on': 'ubuntu-latest' },
    e2e: { needs: 'build', strategy: { matrix: { browser: ['chromium', 'webkit'] } } },
    deploy: { name: 'Deploy to ${{ inputs.env }}', needs: ['e2e'] },
  },
};

const CALLER = {
  jobs: {
    lint: { 'runs-on': 'ubuntu-latest' },
    checks: { name: 'Checks', needs: 'lint', uses: './.github/workflows/checks.yml' },
    release: { needs: 'checks' },
  },
};

const CALLEE = { on: 'workflow_call', jobs: { unit: { 'runs-on': 'x' }, e2e: { needs: 'unit' } } };

describe("GitHub's graph", () => {
  test("matrix legs are boxes of their own with their key's edges, grouped under it", () => {
    const g = githubGraph(
      MATRIX,
      jobs([
        ['1', 'build'],
        ['2', 'e2e (chromium)'],
        ['3', 'e2e (webkit)'],
        ['4', 'Deploy to test'],
      ]),
      none,
      false,
    );

    expect(g.edges).toEqual([
      ['1', '2'],
      ['1', '3'],
      ['2', '4'],
      ['3', '4'],
    ]);
    expect(g.partial).toBe(false);
    expect(g.groups).toEqual({ '2': 'e2e', '3': 'e2e' });
  });

  test("a reusable workflow's jobs nest under their caller with its edges and their own", () => {
    const run = jobs([
      ['1', 'lint'],
      ['2', 'Checks / unit'],
      ['3', 'Checks / e2e'],
      ['4', 'release'],
    ]);
    const read = (path: string) => (path === '.github/workflows/checks.yml' ? CALLEE : undefined);
    const g = githubGraph(CALLER, run, read, false);

    // lint → the called workflow's first job → its own needs → its last job → release
    expect(g.edges).toEqual([
      ['1', '2'],
      ['2', '3'],
      ['3', '4'],
    ]);
    expect(g.partial).toBe(false);
    expect(g.groups).toEqual({ '2': 'Checks', '3': 'Checks' });
    // the called workflow unread: its jobs take the caller's edges, some links missing
    const unread = githubGraph(CALLER, run, none, false);

    expect(unread.edges).toEqual([
      ['1', '2'],
      ['1', '3'],
      ['2', '4'],
      ['3', '4'],
    ]);
    expect(unread.partial).toBe(true);
  });

  test("a reusable workflow called per matrix leg: each leg's jobs wait for their own leg only", () => {
    // build, then a deploy workflow called once for dev and once for test, and lint on its own
    const doc = {
      jobs: {
        build: { 'runs-on': 'ubuntu-latest' },
        deploy: {
          needs: 'build',
          strategy: { matrix: { env: ['dev', 'test'] } },
          uses: './.github/workflows/deploy.yml',
          with: { env: '${{ matrix.env }}' },
        },
        lint: { 'runs-on': 'ubuntu-latest' },
      },
    };
    const deploy = {
      on: 'workflow_call',
      jobs: { plan: { 'runs-on': 'x' }, apply: { needs: 'plan', 'runs-on': 'x' } },
    };
    const g = githubGraph(
      doc,
      jobs([
        ['1', 'build'],
        ['2', 'deploy (dev) / plan'],
        ['3', 'deploy (dev) / apply'],
        ['4', 'deploy (test) / plan'],
        ['5', 'deploy (test) / apply'],
        ['6', 'lint'],
      ]),
      (path) => (path === '.github/workflows/deploy.yml' ? deploy : undefined),
      false,
    );

    // build → each leg's plan → that leg's apply; lint waits for nothing, nothing waits for it
    expect(g.edges).toEqual([
      ['1', '2'],
      ['1', '4'],
      ['2', '3'],
      ['4', '5'],
    ]);
    expect(g.partial).toBe(false);
    expect(g.groups).toEqual({
      '2': 'deploy (dev)',
      '3': 'deploy (dev)',
      '4': 'deploy (test)',
      '5': 'deploy (test)',
    });
  });

  test('needs as an expression keeps the known edges and says some are missing', () => {
    const doc = {
      jobs: {
        build: {},
        test: { needs: 'build' },
        report: { needs: '${{ fromJSON(inputs.after) }}' },
      },
    };
    const g = githubGraph(
      doc,
      jobs([
        ['1', 'build'],
        ['2', 'test'],
        ['3', 'report'],
      ]),
      none,
      false,
    );

    expect(g.edges).toEqual([['1', '2']]);
    expect(g.partial).toBe(true);
  });

  test("a pull request's workflow that no longer names every job gives no edges", () => {
    const doc = { jobs: { build: {}, test: { needs: 'build' } } };
    const two = jobs([
      ['1', 'build'],
      ['2', 'test'],
    ]);
    const three = jobs([
      ['1', 'build'],
      ['2', 'test'],
      ['3', 'lint'],
    ]);

    expect(githubGraph(doc, two, none, true).edges).toEqual([['1', '2']]);
    // the run had a job the head's workflow does not name (the merge commit's): untrusted
    expect(githubGraph(doc, three, none, true)).toEqual({
      edges: null,
      partial: false,
      groups: {},
    });
    // a push run's unknown job only makes it partial
    expect(githubGraph(doc, three, none, false)).toMatchObject({
      edges: [['1', '2']],
      partial: true,
    });
    // an unreadable workflow: none at all
    expect(githubGraph(undefined, two, none, false).edges).toBeNull();
    expect(githubGraph({ jobs: [] }, two, none, false).edges).toBeNull();
  });
});

describe("Azure's graph", () => {
  const AZURE = {
    stages: [
      { stage: 'Build', jobs: [{ job: 'Compile' }, { job: 'Test', dependsOn: 'Compile' }] },
      { stage: 'DeployTest', displayName: 'Deploy test', jobs: [{ deployment: 'Web' }] },
      { stage: 'DeployProd', dependsOn: ['Build', 'DeployTest'], jobs: [{ deployment: 'Web' }] },
    ],
  };
  const records = [
    { id: '1', name: 'Compile', identifier: 'Build.Compile', stage: 'Build' },
    { id: '2', name: 'Test', identifier: 'Build.Test', stage: 'Build' },
    { id: '3', name: 'Web', identifier: 'DeployTest.Web', stage: 'DeployTest' },
    { id: '4', name: 'Web', identifier: 'DeployProd.Web', stage: 'DeployProd' },
  ];

  test('stages depend on the one before (or their dependsOn), jobs on theirs', () => {
    const g = azureGraph(AZURE, records);

    // Compile → Test inside Build; Build's last job → Deploy test; Deploy prod after both
    expect(g.edges).toEqual([
      ['1', '2'],
      ['2', '3'],
      ['2', '4'],
      ['3', '4'],
    ]);
    expect(g.partial).toBe(false);
    expect(g.groups['3']).toBe('Deploy test');
  });

  test('no YAML (a GitHub-hosted repo, an unreadable one): no edges, start order', () => {
    expect(azureGraph(undefined, records)).toEqual({ edges: null, partial: false, groups: {} });
    // top-level jobs are one stage, never grouped
    const flat = azureGraph({ jobs: [{ job: 'A' }, { job: 'B', dependsOn: 'A' }] }, [
      { id: 'a', name: 'A', identifier: 'A', stage: '' },
      { id: 'b', name: 'B', identifier: 'B', stage: '' },
    ]);

    expect(flat).toEqual({ edges: [['a', 'b']], partial: false, groups: {} });
  });
});
