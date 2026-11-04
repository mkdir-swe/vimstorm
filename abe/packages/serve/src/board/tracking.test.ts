/**
 * Tracking on an in-process `serve` (`served`) whose GitHub is `gh` on `PATH`, a fake one that
 * keeps what it was asked and answers GitHub's shapes; what every `gh` child gets through the real
 * `abe` and a detached `serve` (`cli`). Nothing reaches github.com.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeployStatusData, IssueData, MergeData, PrData } from '@abe/core';
import { ghTrackingFrom } from '@abe/ports';
import {
  cli,
  fakeGh,
  ghChecks,
  ghCommitStatus,
  ghDeployment,
  ghDeploymentStatus,
  ghIssue,
  ghPrView,
  ghPull,
  ghWorkflowRun,
  NOT_FOUND,
  served,
  type ServedCli,
  tempState,
  type TempState,
} from '@abe/testing';

const REPO = 'mkdir-swe/demo-shop';
const SHA = '6378c0009ba02dd15f0af334b9902a58b260913f';

/** Variables a parent shell may carry that would change which login or repo `gh` uses. */
const LEAKY = {
  GITHUB_TOKEN: 'fake-github-token',
  GH_TOKEN: 'fake-gh-token',
  GIT_DIR: '/elsewhere/.git',
  GIT_WORK_TREE: '/elsewhere',
  GIT_INDEX_FILE: '/elsewhere/.git/index',
};

const gh = fakeGh();
/** A serve on `state` whose GitHub is the fake `gh`, in an environment that leaks tokens. */
const servedOn = (state: TempState) =>
  served({ state, tracking: ghTrackingFrom({ ...state.env, PATH: gh.path, ...LEAKY }) });
const state = tempState();
let abe: ServedCli;
let before = 0;

beforeAll(async () => {
  abe = await servedOn(state);
});

/** The calls `gh` got in this test. */
const calls = () => gh.calls().slice(before);
const argvs = () => calls().map((c) => c.argv.join(' '));

beforeEach(() => {
  before = gh.calls().length;
});

afterAll(async () => {
  await abe.close();
  gh.remove();
});

const body = (name: string, text: string) => {
  writeFileSync(join(state.dir, name), text);

  return name;
};

describe('abe issue show', () => {
  test('the issue, its labels, its parent and its sub-issues', async () => {
    gh.answer([
      [
        'issues/12/sub_issues',
        {
          json: [
            ghIssue(REPO, 13, { title: 'Part one' }),
            ghIssue('mkdir-swe/abe-org', 4, { state: 'closed' }),
          ],
        },
      ],
      ['issues/12/parent', { json: ghIssue(REPO, 10, { title: 'The spec' }) }],
      [
        'issues/12',
        { json: ghIssue(REPO, 12, { title: 'Checkout', labels: ['2.0', 'ready-for-agent'] }) },
      ],
    ]);
    const { exit, doc } = await abe.json(IssueData, 'issue', 'show', `${REPO}#12`);

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        repo: REPO,
        number: 12,
        title: 'Checkout',
        body: 'Body of 12.',
        state: 'open',
        url: `https://github.com/${REPO}/issues/12`,
        labels: ['2.0', 'ready-for-agent'],
        parent: { repo: REPO, number: 10, title: 'The spec', state: 'open' },
        subIssues: [
          { repo: REPO, number: 13, title: 'Part one', state: 'open' },
          { repo: 'mkdir-swe/abe-org', number: 4, title: 'Issue 4', state: 'closed' },
        ],
      },
    });
    expect(argvs().sort()).toEqual([
      `api repos/${REPO}/issues/12`,
      `api repos/${REPO}/issues/12/parent`,
      `api repos/${REPO}/issues/12/sub_issues?per_page=100`,
    ]);
  });

  test('no parent (a 404 there), no sub-issues and an empty body', async () => {
    gh.answer([
      ['issues/5/sub_issues', { json: [] }],
      [
        'issues/5/parent',
        {
          stdout: '{"message":"No parent issue found"}',
          stderr: 'gh: No parent issue found (HTTP 404)',
          exit: 1,
        },
      ],
      ['issues/5', { json: ghIssue(REPO, 5, { body: null }) }],
    ]);
    const { doc } = await abe.json(IssueData, 'issue', 'show', `${REPO}#5`);

    expect(doc).toMatchObject({
      ok: true,
      data: { number: 5, body: '', parent: null, subIssues: [] },
    });
  });

  test('text names the parent and the sub-issues', async () => {
    gh.answer([
      ['issues/12/sub_issues', { json: [ghIssue(REPO, 13, { title: 'Part one' })] }],
      ['issues/12/parent', { json: ghIssue(REPO, 10, { title: 'The spec' }) }],
      ['issues/12', { json: ghIssue(REPO, 12, { title: 'Checkout' }) }],
    ]);
    const { exit, stdout } = await abe.run('issue', 'show', `${REPO}#12`);

    expect(exit).toBe(0);
    expect(stdout).toBe(
      [
        `${REPO}#12 (open) Checkout`,
        `https://github.com/${REPO}/issues/12`,
        `parent: ${REPO}#10 (open) The spec`,
        'sub-issues:',
        `  ${REPO}#13 (open) Part one`,
        '',
      ].join('\n'),
    );
  });

  test("an issue GitHub does not have is not-found, with gh's message", async () => {
    gh.answer([]);
    const { exit, doc } = await abe.json(IssueData, 'issue', 'show', `${REPO}#404`);

    expect(exit).toBe(1);
    expect(doc).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'gh: Not Found (HTTP 404)' },
    });
  });

  test.each([
    ['gh: Bad credentials (HTTP 401)', 'auth'],
    ['gh: API rate limit exceeded for user ID 1. (HTTP 403)', 'rate-limited'],
    ['gh: Server Error (HTTP 502)', 'gh-failed'],
  ])('%s is %s', async (stderr, code) => {
    gh.answer([['issues/7', { stderr, exit: 1 }]]);
    const { exit, doc } = await abe.json(IssueData, 'issue', 'show', `${REPO}#7`);

    expect(exit).toBe(1);
    expect(doc).toEqual({ ok: false, error: { code, message: stderr } });
  });

  test("a pull request's number is not an issue", async () => {
    gh.answer([['issues/3', { json: { ...ghIssue(REPO, 3), pull_request: { url: 'x' } } }]]);
    const { exit, doc } = await abe.json(IssueData, 'issue', 'show', `${REPO}#3`);

    expect(exit).toBe(1);
    expect(doc).toEqual({
      ok: false,
      error: { code: 'not-found', message: `${REPO}#3 is a pull request, not an issue` },
    });
  });

  test('a ref that is not <owner/repo>#<n> is a usage error, and gh is not run', async () => {
    const { exit, stderr, doc } = await abe.json(IssueData, 'issue', 'show', 'demo-shop#12');

    expect(exit).toBe(2);
    expect(doc).toMatchObject({ ok: false, error: { code: 'usage' } });
    expect(stderr).toContain('usage: abe issue show <ref>');
    expect(calls()).toEqual([]);
  });
});

describe('every gh child, through the real abe and its detached serve', () => {
  const real = cli({ env: { PATH: gh.path, ...LEAKY } });

  afterAll(async () => {
    await real.close();
  });

  test('runs without tokens or a parent git of its own', async () => {
    gh.answer([
      ['issues/1/sub_issues', { json: [] }],
      ['issues/1/parent', NOT_FOUND],
      ['issues/1', { json: ghIssue(REPO, 1) }],
    ]);
    const { exit, doc } = await real.json(IssueData, 'issue', 'show', `${REPO}#1`);

    expect(exit).toBe(0);
    expect(doc).toMatchObject({ ok: true, data: { number: 1 } });
    expect(calls().length).toBeGreaterThan(0);
    for (const call of calls()) {
      for (const name of Object.keys(LEAKY)) expect(call.env).not.toHaveProperty(name);
      expect(call.env.PATH).toBe(gh.path);
      expect(call.env.HOME).toBe(real.state.dir);
      expect(call.env.GH_PROMPT_DISABLED).toBe('1');
    }
  });
});

describe('abe issue create', () => {
  test('opens the issue with the body file and labels, and reads it back', async () => {
    gh.answer([
      ['-X POST', { json: ghIssue(REPO, 21, { title: 'New' }) }],
      ['issues/21/sub_issues', { json: [] }],
      ['issues/21/parent', NOT_FOUND],
      [
        'issues/21',
        { json: ghIssue(REPO, 21, { title: 'New', body: 'Why.\n', labels: ['2.0', 'spec'] }) },
      ],
    ]);
    const file = body('new.md', 'Why.\n');
    const { exit, doc } = await abe.json(
      IssueData,
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      'New',
      '--body-file',
      file,
      '--label',
      '2.0',
      '--label',
      'spec',
    );

    expect(exit).toBe(0);
    expect(doc).toMatchObject({
      ok: true,
      data: { number: 21, labels: ['2.0', 'spec'], parent: null },
    });
    const [create] = calls();

    expect(create?.argv).toEqual(['api', '-X', 'POST', `repos/${REPO}/issues`, '--input', '-']);
    expect(JSON.parse(create?.stdin ?? '')).toEqual({
      title: 'New',
      body: 'Why.\n',
      labels: ['2.0', 'spec'],
    });
  });

  test('--parent makes it a sub-issue of that issue', async () => {
    gh.answer([
      ['issues/10/sub_issues', { json: ghIssue(REPO, 10) }],
      ['-X POST', { json: ghIssue(REPO, 22) }],
      ['issues/22/sub_issues', { json: [] }],
      ['issues/22/parent', { json: ghIssue(REPO, 10, { title: 'The spec' }) }],
      ['issues/22', { json: ghIssue(REPO, 22) }],
      ['issues/10', { json: ghIssue(REPO, 10) }],
    ]);
    const { doc } = await abe.json(
      IssueData,
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      'Part',
      '--body-file',
      body('part.md', 'Part.'),
      '--parent',
      '10',
    );

    expect(doc).toMatchObject({
      ok: true,
      data: { number: 22, parent: { number: 10, title: 'The spec' } },
    });
    const link = calls().find((c) => c.argv.includes(`repos/${REPO}/issues/10/sub_issues`));

    expect(link?.argv).toEqual([
      'api',
      '-X',
      'POST',
      `repos/${REPO}/issues/10/sub_issues`,
      '--input',
      '-',
    ]);
    expect(JSON.parse(link?.stdin ?? '')).toEqual({ sub_issue_id: 9_000_022 });
  });

  const create = (parent: string, title = 'Part') =>
    abe.json(
      IssueData,
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      title,
      '--body-file',
      body('o.md', 'x'),
      '--parent',
      parent,
    );

  test('a parent GitHub does not have is not-found, and no issue is opened', async () => {
    gh.answer([['-X POST', { json: ghIssue(REPO, 23) }]]);
    const { exit, doc } = await create('99');

    expect(exit).toBe(1);
    expect(doc).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'gh: Not Found (HTTP 404)' },
    });
    expect(argvs()).toEqual([`api repos/${REPO}/issues/99`]);
  });

  test('a parent that refuses the link says the issue was still opened', async () => {
    const stderr = 'gh: Validation Failed (HTTP 422)';

    gh.answer([
      ['issues/98/sub_issues', { stderr, exit: 1 }],
      ['-X POST', { json: ghIssue(REPO, 23) }],
      ['issues/98', { json: ghIssue(REPO, 98) }],
    ]);
    const { exit, doc } = await create('98', 'Orphan');

    expect(exit).toBe(1);
    expect(doc).toEqual({
      ok: false,
      error: {
        code: 'gh-failed',
        message: `opened https://github.com/${REPO}/issues/23 but could not make it a sub-issue of #98: ${stderr}`,
      },
    });
  });

  test.each(['0', '-1', '1.5'])(
    '--parent %s is a usage error, and gh is not run',
    async (parent) => {
      const { exit } = await create(parent);

      expect(exit).toBe(2);
      expect(calls()).toEqual([]);
    },
  );

  test('a body file that is not there is refused before gh runs', async () => {
    const { exit, doc } = await abe.json(
      IssueData,
      'issue',
      'create',
      '--repo',
      REPO,
      '--title',
      'X',
      '--body-file',
      'missing.md',
    );

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'unreadable-body-file' } });
    expect(calls()).toEqual([]);
  });

  test('a repo that is not <owner/repo> is a usage error', async () => {
    const { exit } = await abe.json(
      IssueData,
      'issue',
      'create',
      '--repo',
      'demo-shop',
      '--title',
      'X',
      '--body-file',
      'b',
    );

    expect(exit).toBe(2);
  });
});

const PR_VIEW = `pr view 3 -R ${REPO} --json number,title,body,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeCommit,reviewRequests,latestReviews`;

describe('abe pr show', () => {
  // A fine-grained token cannot read check runs (#67: GitHub offers no Checks permission for
  // one), so the checks are the head's Actions workflow runs and its commit statuses.
  test('state, head, base, mergeable, its reviewers and the checks on its head: its workflow runs and commit statuses', async () => {
    gh.answer([
      [
        'pr view 3',
        {
          // asked again after a comment: requested; else each one's latest review
          json: ghPrView(REPO, 3, {
            mergeable: 'CONFLICTING',
            requested: ['shop-dev'],
            reviews: [
              ['shop-lead', 'APPROVED'],
              ['shop-dev', 'COMMENTED'],
            ],
          }),
        },
      ],
      ...ghChecks(
        SHA,
        [
          ghWorkflowRun('checks', 'completed', 'success', { id: 6, workflowId: 1 }),
          // An earlier run of the same workflow on this head: only the newest counts.
          ghWorkflowRun('e2e', 'completed', 'failure', {
            id: 2,
            workflowId: 2,
            createdAt: '2026-10-23T00:30:00Z',
          }),
          ghWorkflowRun('e2e', 'in_progress', null, { id: 3, workflowId: 2 }),
        ],
        [ghCommitStatus('deploy/preview', 'success')],
      ),
    ]);
    const { exit, doc } = await abe.json(PrData, 'pr', 'show', `${REPO}#3`);

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        repo: REPO,
        number: 3,
        title: 'Pull 3',
        body: 'Body of pull 3.',
        url: `https://github.com/${REPO}/pull/3`,
        state: 'open',
        draft: false,
        head: { ref: 't3-change', sha: SHA },
        base: { ref: 'main' },
        mergeable: 'conflicting',
        checks: {
          state: 'pending',
          runs: [
            { name: 'checks', state: 'success', url: 'https://github.com/o/r/actions/runs/6' },
            { name: 'e2e', state: 'pending', url: 'https://github.com/o/r/actions/runs/3' },
            {
              name: 'deploy/preview',
              state: 'success',
              url: 'https://ci.example.test/deploy/preview',
            },
          ],
        },
        mergeCommit: null,
        reviewers: [
          { login: 'shop-dev', state: 'requested' },
          { login: 'shop-lead', state: 'approved' },
        ],
      },
    });
    // The pull request first; its runs and statuses are read together, in either order.
    expect(argvs()[0]).toBe(PR_VIEW);
    expect(argvs().slice(1).sort()).toEqual([
      `api repos/${REPO}/actions/runs?head_sha=${SHA}&per_page=100`,
      `api repos/${REPO}/commits/${SHA}/status?per_page=100`,
    ]);
  });

  test('a failed workflow run or status fails the checks; a skipped run passes', async () => {
    gh.answer([
      ['pr view 3', { json: ghPrView(REPO, 3) }],
      ...ghChecks(
        SHA,
        [
          ghWorkflowRun('CI', 'completed', 'success', { workflowId: 1 }),
          ghWorkflowRun('docs', 'completed', 'skipped', { workflowId: 2 }),
        ],
        [ghCommitStatus('ci/legacy', 'error')],
      ),
    ]);
    const { doc } = await abe.json(PrData, 'pr', 'show', `${REPO}#3`);

    expect(doc).toMatchObject({
      ok: true,
      data: {
        checks: {
          state: 'failure',
          runs: [
            { name: 'CI', state: 'success' },
            { name: 'docs', state: 'skipped' },
            { name: 'ci/legacy', state: 'failure' },
          ],
        },
      },
    });
  });

  test('checks GitHub refuses to read are an error, never none', async () => {
    gh.answer([
      ['pr view 3', { json: ghPrView(REPO, 3) }],
      [
        'actions/runs?head_sha=',
        {
          stdout: '{"message":"Resource not accessible by personal access token","status":"403"}',
          stderr: 'gh: Resource not accessible by personal access token (HTTP 403)',
          exit: 1,
        },
      ],
    ]);
    const { doc } = await abe.json(PrData, 'pr', 'show', `${REPO}#3`);

    expect(doc).toMatchObject({ ok: false });
  });

  test('a merged pull request with no checks: its merge commit', async () => {
    gh.answer([
      [
        'pr view 3',
        {
          json: ghPrView(REPO, 3, { state: 'MERGED', mergeable: 'UNKNOWN', mergeCommit: 'm3rg3d' }),
        },
      ],
    ]);
    const { doc } = await abe.json(PrData, 'pr', 'show', `${REPO}#3`);

    expect(doc).toMatchObject({
      ok: true,
      data: {
        state: 'merged',
        mergeable: 'unknown',
        checks: { state: 'none', runs: [] },
        mergeCommit: 'm3rg3d',
      },
    });
  });

  test('a pull request GitHub does not have', async () => {
    const stderr =
      'GraphQL: Could not resolve to a PullRequest with the number of 3. (repository.pullRequest)';

    gh.answer([['pr view 3', { stderr, exit: 1 }]]);
    const { doc } = await abe.json(PrData, 'pr', 'show', `${REPO}#3`);

    expect(doc).toEqual({ ok: false, error: { code: 'not-found', message: stderr } });
  });
});

describe('abe pr create and update', () => {
  test('create sends head, base, title, body and draft, then reads it', async () => {
    gh.answer([
      ['-X POST', { json: ghPull(REPO, 3) }],
      ['pr view 3', { json: ghPrView(REPO, 3, { isDraft: true }) }],
    ]);
    const { exit, doc } = await abe.json(
      PrData,
      'pr',
      'create',
      '--repo',
      REPO,
      '--head',
      't3-change',
      '--base',
      'main',
      '--title',
      'Pull 3',
      '--body-file',
      body('pr.md', 'Verified: after.\n'),
      '--draft',
    );

    expect(exit).toBe(0);
    expect(doc).toMatchObject({ ok: true, data: { number: 3, draft: true } });
    const [create, view] = calls();

    expect(create?.argv).toEqual(['api', '-X', 'POST', `repos/${REPO}/pulls`, '--input', '-']);
    expect(JSON.parse(create?.stdin ?? '')).toEqual({
      head: 't3-change',
      base: 'main',
      title: 'Pull 3',
      body: 'Verified: after.\n',
      draft: true,
    });
    expect(view?.argv.join(' ')).toBe(PR_VIEW);
  });

  test('a head GitHub refuses is gh-failed with its message', async () => {
    const stderr =
      'gh: Validation Failed: {"resource":"PullRequest","field":"head","code":"invalid"} (HTTP 422)';

    gh.answer([['-X POST', { stderr, exit: 1 }]]);
    const { doc } = await abe.json(
      PrData,
      'pr',
      'create',
      '--repo',
      REPO,
      '--head',
      'nope',
      '--base',
      'main',
      '--title',
      'T',
      '--body-file',
      body('pr2.md', 'x'),
    );

    expect(doc).toEqual({ ok: false, error: { code: 'gh-failed', message: stderr } });
  });

  test('update replaces the body (and the title when given)', async () => {
    gh.answer([
      ['-X PATCH', { json: ghPull(REPO, 3) }],
      ['pr view 3', { json: ghPrView(REPO, 3) }],
    ]);
    const { exit } = await abe.json(
      PrData,
      'pr',
      'update',
      `${REPO}#3`,
      '--body-file',
      body('pr3.md', 'Notes.\n'),
      '--title',
      'Better',
    );

    expect(exit).toBe(0);
    const [patch] = calls();

    expect(patch?.argv).toEqual(['api', '-X', 'PATCH', `repos/${REPO}/pulls/3`, '--input', '-']);
    expect(JSON.parse(patch?.stdin ?? '')).toEqual({ body: 'Notes.\n', title: 'Better' });
  });
});

describe('abe pr merge', () => {
  test('squashes by default and answers the merge commit', async () => {
    gh.answer([
      [
        '/merge',
        { json: { sha: 'abc123', merged: true, message: 'Pull Request successfully merged' } },
      ],
    ]);
    const { exit, doc } = await abe.json(MergeData, 'pr', 'merge', `${REPO}#3`);

    expect(exit).toBe(0);
    expect(doc).toEqual({ ok: true, data: { repo: REPO, number: 3, merged: true, sha: 'abc123' } });
    const [merge] = calls();

    expect(merge?.argv).toEqual([
      'api',
      '-X',
      'PUT',
      `repos/${REPO}/pulls/3/merge`,
      '--input',
      '-',
    ]);
    expect(JSON.parse(merge?.stdin ?? '')).toEqual({ merge_method: 'squash' });
  });

  test('--method and --sha go to GitHub', async () => {
    gh.answer([['/merge', { json: { sha: 'def456', merged: true, message: 'merged' } }]]);
    await abe.json(MergeData, 'pr', 'merge', `${REPO}#3`, '--method', 'rebase', '--sha', SHA);

    expect(JSON.parse(calls()[0]?.stdin ?? '')).toEqual({ merge_method: 'rebase', sha: SHA });
  });

  test('a pull request that cannot merge is gh-failed', async () => {
    const stderr = 'gh: Pull Request is not mergeable (HTTP 405)';

    gh.answer([['/merge', { stderr, exit: 1 }]]);
    const { exit, doc } = await abe.json(MergeData, 'pr', 'merge', `${REPO}#3`);

    expect(exit).toBe(1);
    expect(doc).toEqual({ ok: false, error: { code: 'gh-failed', message: stderr } });
  });
});

describe('abe pr merge as githubIdentity', () => {
  /** An `abe` typed in a checkout whose yours for this repo says `githubIdentity: ada` (ADR 0030). */
  const adaState = tempState();
  const dir = join(adaState.dir, '.abe');
  let asAda: ServedCli;

  mkdirSync(join(adaState.dir, '.git'), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.local.yaml'), 'githubIdentity: ada\n');
  beforeAll(async () => {
    asAda = await servedOn(adaState);
  });

  afterAll(async () => {
    await asAda.close();
  });

  const merged = [
    '/merge',
    { json: { sha: 'abc123', merged: true, message: 'Pull Request successfully merged' } },
  ] as const;

  test('gh signed in as it: the merge goes', async () => {
    gh.answer([['api user', { json: { login: 'Ada' } }], merged]);
    const { exit, doc } = await asAda.json(MergeData, 'pr', 'merge', `${REPO}#3`);

    expect(exit).toBe(0);
    expect(doc).toMatchObject({ ok: true, data: { merged: true, sha: 'abc123' } });
    expect(argvs()).toEqual(['api user', `api -X PUT repos/${REPO}/pulls/3/merge --input -`]);
  });

  test("gh's login unread: refused, nothing merged", async () => {
    gh.answer([merged]);
    const { exit, doc } = await asAda.json(MergeData, 'pr', 'merge', `${REPO}#3`);

    expect(exit).toBe(1);
    expect(doc).toMatchObject({ ok: false, error: { code: 'github-identity' } });
    expect(argvs()).toEqual(['api user']);
  });

  test('gh signed in as another: refused naming both, nothing merged', async () => {
    gh.answer([['api user', { json: { login: 'eve' } }], merged]);
    const { exit, doc } = await asAda.json(MergeData, 'pr', 'merge', `${REPO}#3`);

    expect(exit).toBe(1);
    expect(doc).toEqual({
      ok: false,
      error: {
        code: 'github-identity',
        message:
          '✗ GitHub writes go as ada (githubIdentity), but gh is signed in as eve: gh auth switch --user ada',
      },
    });
    expect(argvs().some((a) => a.includes('/merge'))).toBe(false);
  });

  test("unset: gh's login is not even asked, the merge goes", async () => {
    gh.answer([['api user', { json: { login: 'eve' } }], merged]);
    const { exit } = await abe.json(MergeData, 'pr', 'merge', `${REPO}#3`);

    expect(exit).toBe(0);
    expect(argvs()).toEqual([`api -X PUT repos/${REPO}/pulls/3/merge --input -`]);
  });
});

describe('abe deploy status', () => {
  const DEPLOYS = `api -X GET repos/${REPO}/deployments -f sha=${SHA} -f environment=test -f per_page=100`;

  test('the newest deployment of the commit to the environment, and its latest status', async () => {
    gh.answer([
      [
        'deployments/502/statuses',
        {
          json: [
            ghDeploymentStatus(2, 'success', '2026-10-23T10:05:00Z'),
            ghDeploymentStatus(1, 'in_progress', '2026-10-23T10:01:00Z'),
          ],
        },
      ],
      [
        'deployments -f',
        {
          json: [
            ghDeployment(REPO, 502, SHA, 'test', '2026-10-23T10:00:00Z'),
            ghDeployment(REPO, 501, SHA, 'test', '2026-10-23T09:00:00Z'),
          ],
        },
      ],
    ]);
    const { exit, doc } = await abe.json(
      DeployStatusData,
      'deploy',
      'status',
      '--repo',
      REPO,
      '--sha',
      SHA,
      '--env',
      'test',
    );

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: {
        repo: REPO,
        sha: SHA,
        environment: 'test',
        state: 'success',
        deployment: {
          id: 502,
          createdAt: '2026-10-23T10:00:00Z',
          status: 'success',
          description: 'Deployment finished successfully.',
          url: 'https://github.com/o/r/actions/runs/2',
        },
      },
    });
    expect(argvs()).toEqual([DEPLOYS, `api repos/${REPO}/deployments/502/statuses?per_page=100`]);
  });

  test.each([
    ['failure', 'failure'],
    ['error', 'failure'],
    ['queued', 'pending'],
  ])('a latest status %s is %s', async (status, state) => {
    gh.answer([
      ['deployments/7/statuses', { json: [ghDeploymentStatus(1, status, '2026-10-23T10:05:00Z')] }],
      ['deployments -f', { json: [ghDeployment(REPO, 7, SHA, 'test', '2026-10-23T10:00:00Z')] }],
    ]);
    const { doc } = await abe.json(
      DeployStatusData,
      'deploy',
      'status',
      '--repo',
      REPO,
      '--sha',
      SHA,
      '--env',
      'test',
    );

    expect(doc).toMatchObject({ ok: true, data: { state, deployment: { status } } });
  });

  test('no deployment of that commit there is none', async () => {
    gh.answer([['deployments -f', { json: [] }]]);
    const { exit, doc } = await abe.json(
      DeployStatusData,
      'deploy',
      'status',
      '--repo',
      REPO,
      '--sha',
      SHA,
      '--env',
      'test',
    );

    expect(exit).toBe(0);
    expect(doc).toEqual({
      ok: true,
      data: { repo: REPO, sha: SHA, environment: 'test', state: 'none', deployment: null },
    });
    const { stdout } = await abe.run(
      'deploy',
      'status',
      '--repo',
      REPO,
      '--sha',
      SHA,
      '--env',
      'test',
    );

    expect(stdout).toBe('no deployment of 6378c00 to test\n');
  });
});
