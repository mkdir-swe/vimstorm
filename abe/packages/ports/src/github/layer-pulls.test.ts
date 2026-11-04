/** `LayerPulls` against the fake `gh`: a Layer's file at a commit, and a pull request made with the Git Data API. */
import { afterEach, describe, expect, test } from 'bun:test';
import { PROPOSAL_PATH, PROPOSAL_PREFIX, proposalBranch, Repo } from '@abe/core';
import { z } from 'zod';
import { fakeGh, type FakeGh, type GhAnswer } from '@abe/testing';
import { ghLayerPullsFrom } from './layer-pulls';

const REPO = Repo.parse('acme/abe-org');
const BASE = { branch: 'main', sha: 'base-sha' };

const PARENT: [string, GhAnswer] = [
  'repos/acme/abe-org/git/commits/base-sha',
  { json: { sha: 'base-sha', tree: { sha: 'base-tree' } } },
];

const proposal = (label: { name: string; description: string } | null) => ({
  repo: REPO,
  base: BASE,
  branch: 'improve/imp-abc123',
  title: 'Improve web: skills on top',
  body: 'Why.',
  message: 'Improve web: skills on top',
  label,
  files: [
    { path: 'abe.yaml', content: 'skillsOnTop: true\n' },
    { path: 'checks/seed.sh', content: '#!/bin/sh\n' },
    { path: 'old.md', content: null },
  ],
});

describe('LayerPulls through gh api', () => {
  let gh: FakeGh | undefined;
  const start = (answers: [string, GhAnswer][]) => {
    gh = fakeGh(answers);

    return { gh, pulls: ghLayerPullsFrom({ PATH: gh.path }) };
  };
  const sent = (g: FakeGh, what: string) =>
    g.calls().find((c) => c.argv.join(' ').includes(`-X ${what}`));

  afterEach(() => {
    gh?.remove();
  });

  test('base: the default branch and its newest commit', async () => {
    const { pulls } = start([
      ['repos/acme/abe-org/git/ref/heads/trunk', { json: { object: { sha: 'abc' } } }],
      ['api repos/acme/abe-org', { json: { default_branch: 'trunk' } }],
    ]);

    expect(await pulls.base(REPO)).toEqual({ ok: true, data: { branch: 'trunk', sha: 'abc' } });
  });

  test('show: a file’s text at the commit; none there is null', async () => {
    const { gh, pulls } = start([
      [
        'contents/abe.yaml?ref=base-sha',
        {
          json: {
            type: 'file',
            encoding: 'base64',
            content: Buffer.from('board: {}\n').toString('base64'),
          },
        },
      ],
    ]);

    expect(await pulls.show(REPO, 'base-sha', 'abe.yaml')).toEqual({
      ok: true,
      data: 'board: {}\n',
    });
    expect(await pulls.show(REPO, 'base-sha', '.abe/keys.json')).toEqual({
      ok: true,
      data: null,
    });
    expect(gh.calls()[0]?.argv).toEqual([
      'api',
      'repos/acme/abe-org/contents/abe.yaml?ref=base-sha',
    ]);
  });

  test('propose: one tree over the base’s, one commit, the branch, the pull request, its label', async () => {
    const { gh, pulls } = start([
      PARENT,
      ['-X POST repos/acme/abe-org/git/trees', { json: { sha: 'tree-new' } }],
      ['-X POST repos/acme/abe-org/git/commits', { json: { sha: 'commit-new' } }],
      ['-X POST repos/acme/abe-org/git/refs', { json: { object: { sha: 'commit-new' } } }],
      ['-X POST repos/acme/abe-org/labels', { json: { name: 'abe-retro' } }],
      ['-X POST repos/acme/abe-org/issues/9/labels', { json: [{ name: 'abe-retro' }] }],
      [
        '-X POST repos/acme/abe-org/pulls',
        { json: { number: 9, html_url: 'https://github.com/acme/abe-org/pull/9' } },
      ],
    ]);
    const made = await pulls.propose(
      proposal({ name: 'abe-retro', description: 'A fix proposed by abe improve retro' }),
    );

    expect(made).toEqual({
      ok: true,
      data: { number: 9, url: 'https://github.com/acme/abe-org/pull/9' },
    });
    expect(JSON.parse(sent(gh, 'POST repos/acme/abe-org/git/trees')?.stdin ?? '')).toEqual({
      base_tree: 'base-tree',
      tree: [
        {
          path: 'abe.yaml',
          mode: '100644',
          type: 'blob',
          content: 'skillsOnTop: true\n',
        },
        { path: 'checks/seed.sh', mode: '100755', type: 'blob', content: '#!/bin/sh\n' },
        { path: 'old.md', mode: '100644', type: 'blob', sha: null },
      ],
    });
    expect(JSON.parse(sent(gh, 'POST repos/acme/abe-org/pulls')?.stdin ?? '')).toEqual({
      head: 'improve/imp-abc123',
      base: 'main',
      title: 'Improve web: skills on top',
      body: 'Why.',
    });
    expect(JSON.parse(sent(gh, 'POST repos/acme/abe-org/labels')?.stdin ?? '')).toEqual({
      name: 'abe-retro',
      description: 'A fix proposed by abe improve retro',
      color: '5319e7',
    });
    expect(JSON.parse(sent(gh, 'POST repos/acme/abe-org/issues/9/labels')?.stdin ?? '')).toEqual({
      labels: ['abe-retro'],
    });
  });

  test('propose: a branch an earlier try left is moved; no label, none made', async () => {
    const { gh, pulls } = start([
      PARENT,
      ['-X POST repos/acme/abe-org/git/trees', { json: { sha: 'tree-new' } }],
      ['-X POST repos/acme/abe-org/git/commits', { json: { sha: 'commit-new' } }],
      [
        '-X POST repos/acme/abe-org/git/refs',
        { stderr: 'gh: Reference already exists (HTTP 422)', exit: 1 },
      ],
      ['-X PATCH repos/acme/abe-org/git/refs/heads/improve/imp-abc123', { json: {} }],
      [
        '-X POST repos/acme/abe-org/pulls',
        { json: { number: 9, html_url: 'https://github.com/acme/abe-org/pull/9' } },
      ],
    ]);

    expect((await pulls.propose(proposal(null))).ok).toBe(true);
    expect(JSON.parse(sent(gh, 'PATCH')?.stdin ?? '')).toEqual({ sha: 'commit-new', force: true });
    expect(gh.calls().some((c) => c.argv.join(' ').includes('labels'))).toBe(false);
  });

  test('propose: files that already read so are nothing to propose, and nothing is made', async () => {
    const { gh, pulls } = start([
      PARENT,
      ['-X POST repos/acme/abe-org/git/trees', { json: { sha: 'base-tree' } }],
    ]);
    const made = await pulls.propose(proposal(null));

    expect(made.ok ? 'made' : made.error.code).toBe('nothing-to-propose');
    // The base commit read and the tree made: no commit, branch or pull request.
    expect(gh.calls()).toHaveLength(2);
  });

  test('propose: the repo’s settings file, on the proposal’s branch', async () => {
    const files = [{ path: PROPOSAL_PATH, content: 'autoMerge: true\n' }];
    const { gh, pulls } = start([
      PARENT,
      ['-X POST repos/acme/abe-org/git/trees', { json: { sha: 'tree-new' } }],
      ['-X POST repos/acme/abe-org/git/commits', { json: { sha: 'commit-new' } }],
      ['-X POST repos/acme/abe-org/git/refs', { json: { object: { sha: 'commit-new' } } }],
      [
        '-X POST repos/acme/abe-org/pulls',
        { json: { number: 14, html_url: 'https://github.com/acme/abe-org/pull/14' } },
      ],
    ]);
    const branch = proposalBranch('autoMerge');

    expect((await pulls.propose({ ...proposal(null), branch, files })).ok).toBe(true);
    const tree = z
      .object({ tree: z.array(z.object({ path: z.string(), mode: z.string() })) })
      .parse(JSON.parse(sent(gh, 'POST repos/acme/abe-org/git/trees')?.stdin ?? '{}'));

    expect(tree.tree).toEqual([{ path: 'abe.yaml', mode: '100644' }]);
    expect(JSON.parse(sent(gh, 'POST repos/acme/abe-org/git/refs')?.stdin ?? '')).toEqual({
      ref: 'refs/heads/settings/repo/autoMerge',
      sha: 'commit-new',
    });
  });

  test('propose: with a pull request open on the branch, the branch moves and that one is updated', async () => {
    const { gh, pulls } = start([
      PARENT,
      ['-X POST repos/acme/abe-org/git/trees', { json: { sha: 'tree-new' } }],
      ['-X POST repos/acme/abe-org/git/commits', { json: { sha: 'commit-2' } }],
      ['-X PATCH repos/acme/abe-org/git/refs/heads/settings/repo/autoMerge', { json: {} }],
      [
        '-X PATCH repos/acme/abe-org/pulls/14',
        { json: { number: 14, html_url: 'https://github.com/acme/abe-org/pull/14' } },
      ],
    ]);
    const made = await pulls.propose({
      ...proposal(null),
      branch: 'settings/repo/autoMerge',
      title: 'Repo: Auto merge → on',
      body: 'Green is enough.\n',
      pull: 14,
    });

    expect(made).toEqual({
      ok: true,
      data: { number: 14, url: 'https://github.com/acme/abe-org/pull/14' },
    });
    expect(JSON.parse(sent(gh, 'PATCH repos/acme/abe-org/git/refs')?.stdin ?? '')).toEqual({
      sha: 'commit-2',
      force: true,
    });
    expect(JSON.parse(sent(gh, 'PATCH repos/acme/abe-org/pulls/14')?.stdin ?? '')).toEqual({
      title: 'Repo: Auto merge → on',
      body: 'Green is enough.\n',
    });
    // No second branch, no second pull request.
    expect(sent(gh, 'POST repos/acme/abe-org/git/refs')).toBeUndefined();
    expect(sent(gh, 'POST repos/acme/abe-org/pulls')).toBeUndefined();
  });

  test('open: the repo’s own open pull requests on the prefix, forks and other branches left out', async () => {
    const pr = (number: number, ref: string, repo: string | null) => ({
      number,
      html_url: `https://github.com/acme/abe-org/pull/${number}`,
      head: { ref, repo: repo === null ? null : { full_name: repo } },
    });
    const { gh, pulls } = start([
      [
        '-X GET repos/acme/abe-org/pulls',
        {
          json: [
            pr(14, 'settings/repo/autoMerge', 'acme/abe-org'),
            pr(15, 'settings/repo/checks', 'someone/abe-org'),
            pr(16, 'improve/imp-1', 'acme/abe-org'),
            pr(17, 'settings/repo/board.done', null),
          ],
        },
      ],
    ]);

    expect(await pulls.open(REPO, PROPOSAL_PREFIX)).toEqual({
      ok: true,
      data: [
        {
          branch: 'settings/repo/autoMerge',
          number: 14,
          url: 'https://github.com/acme/abe-org/pull/14',
        },
      ],
    });
    expect(gh.calls()[0]?.argv).toEqual([
      'api',
      '-X',
      'GET',
      'repos/acme/abe-org/pulls',
      '-f',
      'state=open',
      '-f',
      'sort=updated',
      '-f',
      'direction=desc',
      '-f',
      'per_page=100',
    ]);
  });
});
