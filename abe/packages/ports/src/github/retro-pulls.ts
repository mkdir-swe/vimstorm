/**
 * What Improve retro reads from GitHub, through `gh api` as the person (`RetroPulls` in core's
 * ports): a pull request's comments, reviews and line comments; the pull requests carrying a label
 * (the issues endpoint lists them with `merged_at`). A fix's pull request is `LayerPulls`'
 * (`layer-pulls.ts`). GitHub's answers are read with zod here.
 */
import { type LabelledPull, type PullComment, type RetroPulls, type Tracked } from '@abe/core';
import { z } from 'zod';
import { type Gh, ghRunner, readGh as read } from './gh';
import { type Env } from '../mac/locations';

const User = z.object({ login: z.string() }).nullable();
const IssueComment = z.object({ user: User, created_at: z.string(), body: z.string().nullable() });
const Review = z.object({
  user: User,
  submitted_at: z.string().nullable(),
  state: z.string(),
  body: z.string().nullable(),
});
const LineComment = z.object({
  user: User,
  created_at: z.string(),
  path: z.string(),
  body: z.string(),
});
const LabelledIssue = z.object({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  pull_request: z.object({ merged_at: z.string().nullable().optional() }).optional(),
});

const who = (u: z.infer<typeof User>) => u?.login ?? 'ghost';

export const ghRetroPulls = (gh: Gh): RetroPulls => {
  const api = async <T extends z.ZodType>(
    schema: T,
    path: string,
  ): Promise<Tracked<z.output<T>>> => {
    const out = await gh(['api', path]);

    return out.ok ? read(schema, out.stdout) : out;
  };

  return {
    comments: async (ref) => {
      const at = `repos/${ref.repo}`;
      const [said, reviews, lines] = await Promise.all([
        api(z.array(IssueComment), `${at}/issues/${ref.number}/comments?per_page=100`),
        api(z.array(Review), `${at}/pulls/${ref.number}/reviews?per_page=100`),
        api(z.array(LineComment), `${at}/pulls/${ref.number}/comments?per_page=100`),
      ]);

      if (!said.ok) return said;
      if (!reviews.ok) return reviews;
      if (!lines.ok) return lines;
      const all: PullComment[] = [
        ...said.data.map((c): PullComment => ({
          author: who(c.user),
          at: c.created_at,
          kind: 'comment',
          state: null,
          path: null,
          body: c.body ?? '',
        })),
        ...reviews.data
          // A review with no words and no verdict (a pending one) says nothing.
          .filter((r) => r.submitted_at !== null)
          .map((r): PullComment => ({
            author: who(r.user),
            at: r.submitted_at ?? '',
            kind: 'review',
            state: r.state,
            path: null,
            body: r.body ?? '',
          })),
        ...lines.data.map((c): PullComment => ({
          author: who(c.user),
          at: c.created_at,
          kind: 'line',
          state: null,
          path: c.path,
          body: c.body,
        })),
      ];

      return { ok: true, data: all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
    },
    labelled: async (repo, label) => {
      const listed = await api(
        z.array(LabelledIssue),
        `repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&sort=created&direction=desc&per_page=100`,
      );

      if (!listed.ok) return listed;

      return {
        ok: true,
        data: listed.data.flatMap((i): LabelledPull[] => {
          if (i.pull_request === undefined) return [];
          const mergedAt = i.pull_request.merged_at ?? null;

          return [
            {
              repo,
              number: i.number,
              title: i.title,
              url: i.html_url,
              state: mergedAt !== null ? 'merged' : i.state,
              mergedAt,
            },
          ];
        }),
      };
    },
  };
};

/** The retro's GitHub as the person: `gh` on its keyring login. */
export const ghRetroPullsFrom = (env: Env): RetroPulls => ghRetroPulls(ghRunner(env));
