/**
 * A Layer's repo on GitHub through `gh api` as the person (`LayerPulls` in core's ports): the
 * default branch, a file at a commit (the contents API), and a change proposed as one pull
 * request made with the Git Data API (one tree over the base commit's, one commit, the branch,
 * the pull request, its label; or, with a pull request open on the branch, that one updated), so
 * no checkout is touched; and the open pull requests on a branch prefix. GitHub's answers are
 * read with zod here.
 */
import { type LayerPulls, type Tracked } from '@abe/core';
import { z } from 'zod';
import { type Gh, ghRunner, readGh as read } from './gh';
import { type Env } from '../mac/locations';

const RepoInfo = z.object({ default_branch: z.string() });
const RefInfo = z.object({ object: z.object({ sha: z.string() }) });
const CommitInfo = z.object({ sha: z.string(), tree: z.object({ sha: z.string() }) });
const Contents = z.object({ type: z.string(), encoding: z.string(), content: z.string() });
const Made = z.object({ sha: z.string() });
const Pull = z.object({ number: z.number(), html_url: z.string() });
const OpenPull = Pull.extend({
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/** The colour a label is made with when the repo has none yet. */
const LABEL_COLOR = '5319e7';

/** A file under `scripts/` or ending `.sh` is written executable. */
const modeOf = (path: string) =>
  path.endsWith('.sh') || path.split('/').includes('scripts') ? '100755' : '100644';

/** A repo path as one URL path: each segment encoded, the slashes kept. */
const pathUrl = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export const ghLayerPulls = (gh: Gh): LayerPulls => {
  const call = async <T extends z.ZodType>(
    schema: T,
    args: readonly string[],
    input?: unknown,
  ): Promise<Tracked<z.output<T>>> => {
    const out = await gh(args, input === undefined ? undefined : JSON.stringify(input));

    return out.ok ? read(schema, out.stdout) : out;
  };
  const api = <T extends z.ZodType>(schema: T, path: string) => call(schema, ['api', path]);
  const send = <T extends z.ZodType>(schema: T, method: string, path: string, input: unknown) =>
    call(schema, ['api', '-X', method, path, '--input', '-'], input);

  return {
    base: async (repo) => {
      const info = await api(RepoInfo, `repos/${repo}`);

      if (!info.ok) return info;
      const branch = info.data.default_branch;
      const head = await api(RefInfo, `repos/${repo}/git/ref/heads/${branch}`);

      return head.ok ? { ok: true, data: { branch, sha: head.data.object.sha } } : head;
    },
    show: async (repo, sha, path) => {
      const got = await api(Contents, `repos/${repo}/contents/${pathUrl(path)}?ref=${sha}`);

      if (!got.ok) return got.error.code === 'not-found' ? { ok: true, data: null } : got;
      if (got.data.type !== 'file' || got.data.encoding !== 'base64')
        return {
          ok: false,
          error: { code: 'gh-failed', message: `${repo}:${path} is no file GitHub sends whole` },
        };

      return { ok: true, data: Buffer.from(got.data.content, 'base64').toString('utf8') };
    },
    propose: async (input) => {
      const at = `repos/${input.repo}`;
      const parent = await api(CommitInfo, `${at}/git/commits/${input.base.sha}`);

      if (!parent.ok) return parent;
      const tree = await send(Made, 'POST', `${at}/git/trees`, {
        base_tree: parent.data.tree.sha,
        tree: input.files.map((f) =>
          f.content === null
            ? { path: f.path, mode: '100644', type: 'blob', sha: null }
            : { path: f.path, mode: modeOf(f.path), type: 'blob', content: f.content },
        ),
      });

      if (!tree.ok) return tree;
      if (tree.data.sha === parent.data.tree.sha)
        return {
          ok: false,
          error: {
            code: 'nothing-to-propose',
            message: `${input.repo}'s files already read as the proposal makes them`,
          },
        };
      const commit = await send(Made, 'POST', `${at}/git/commits`, {
        message: input.message,
        tree: tree.data.sha,
        parents: [parent.data.sha],
      });

      if (!commit.ok) return commit;
      const moveBranch = () =>
        send(Made.partial(), 'PATCH', `${at}/git/refs/heads/${input.branch}`, {
          sha: commit.data.sha,
          force: true,
        });

      // A pull request open on the branch already: the branch moves, the pull request is updated.
      if (input.pull !== undefined) {
        const moved = await moveBranch();

        if (!moved.ok) return moved;
        const updated = await send(Pull, 'PATCH', `${at}/pulls/${input.pull}`, {
          title: input.title,
          body: input.body,
        });

        return updated.ok
          ? { ok: true, data: { number: updated.data.number, url: updated.data.html_url } }
          : updated;
      }
      const ref = await send(Made.partial(), 'POST', `${at}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: commit.data.sha,
      });

      // A proposal that failed after its branch: the branch moves to the new commit.
      if (!ref.ok && /already exists|HTTP 422/i.test(ref.error.message)) {
        const moved = await moveBranch();

        if (!moved.ok) return moved;
      } else if (!ref.ok) return ref;
      // The label is made once per repo; one that exists already answers 422, which is fine.
      if (input.label !== null)
        await gh(
          ['api', '-X', 'POST', `${at}/labels`, '--input', '-'],
          JSON.stringify({ ...input.label, color: LABEL_COLOR }),
        );
      const pull = await send(Pull, 'POST', `${at}/pulls`, {
        head: input.branch,
        base: input.base.branch,
        title: input.title,
        body: input.body,
      });

      if (!pull.ok) return pull;
      if (input.label !== null) {
        const labelled = await send(
          z.unknown(),
          'POST',
          `${at}/issues/${pull.data.number}/labels`,
          { labels: [input.label.name] },
        );

        if (!labelled.ok) return labelled;
      }

      return { ok: true, data: { number: pull.data.number, url: pull.data.html_url } };
    },
    open: async (repo, prefix) => {
      // One page of the 100 updated last: a Layer's repo has far fewer open proposals than that.
      const got = await call(z.array(OpenPull), [
        'api',
        '-X',
        'GET',
        `repos/${repo}/pulls`,
        '-f',
        'state=open',
        '-f',
        'sort=updated',
        '-f',
        'direction=desc',
        '-f',
        'per_page=100',
      ]);

      if (!got.ok) return got;

      return {
        ok: true,
        data: got.data
          .filter(
            (p) =>
              p.head.repo?.full_name.toLowerCase() === repo.toLowerCase() &&
              p.head.ref.startsWith(prefix),
          )
          .map((p) => ({ branch: p.head.ref, number: p.number, url: p.html_url })),
      };
    },
  };
};

/** A Layer's repo as the person: `gh` on its keyring login. */
export const ghLayerPullsFrom = (env: Env): LayerPulls => ghLayerPulls(ghRunner(env));
