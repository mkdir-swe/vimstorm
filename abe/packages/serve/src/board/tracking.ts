/**
 * The Tracking commands' handlers: `issue`, `pr` and `deploy`, on the `Tracking` port. From a
 * session, `issue create` and `pr create` only in its run's repo (its worktree's origin), a pull
 * request only from its own branch, and `pr update` only on that branch's pull request. `pr
 * merge` goes only as the `githubIdentity` setting's login (unset: gh's).
 */
import {
  type Handlers,
  IDENTITY_REFUSED,
  identityRefusal,
  type IssueData,
  type Move,
  type Outcome,
  githubAccountOf,
  parseRef,
  parseRepo,
  type Ref,
  refused,
  repoNotVisibleText,
  type Repo,
  type Run,
  showRef,
  type Tracking,
  overrideNote,
  withOverrideNotes,
} from '@abe/core';
import { type SettingsService } from '../layer/settings';
import {
  notYours,
  type Own,
  type OwnCtx,
  ownRepo,
  ownSession,
  readOwnBody,
  sameRepo,
} from '../session/own';

export type TrackingCtx = OwnCtx & {
  /** Where the command was typed: a relative `--body-file` is read from here. */
  cwd: string;
  ports: { tracking: Tracking };
  /** The Layers' settings: `githubIdentity` is the login a merge goes as. */
  settings?: SettingsService | undefined;
  serve: {
    /** The Factory: an issue a run's session opens is told to its run (#200). */
    factory?:
      { apply: (id: string, move: Move, cause: string) => Promise<Outcome<Run>> } | undefined;
  };
};

const usage = (message: string) => Promise.resolve(refused('usage', message, 2));

/** A Not Found from GitHub said as what it means: this login can't see the repo, and what to do. */
export const notVisible = <T>(
  ctx: Pick<TrackingCtx, 'settings' | 'cwd'>,
  repo: string,
  made: Outcome<T>,
): Outcome<T> =>
  !made.ok && made.error.code === 'not-found'
    ? refused(
        'not-found',
        repoNotVisibleText(repo, githubAccountOf(ctx.settings?.at(ctx.cwd).values)),
      )
    : made;

const withRef = <T>(text: string, then: (ref: Ref) => Promise<Outcome<T>>) => {
  const ref = parseRef(text);

  return ref === undefined ? usage(`not <owner/repo>#<n>: ${text}`) : then(ref);
};

const withRepo = <T>(text: string, then: (repo: Repo) => Promise<Outcome<T>>) => {
  const repo = parseRepo(text);

  return repo === undefined ? usage(`--repo is not <owner/repo>: ${text}`) : then(repo);
};

/** The body file's text, or the refusal saying why it could not be read. */
const withBody = async <T>(
  ctx: TrackingCtx,
  file: string,
  then: (body: string) => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const body = await readOwnBody(ctx, file);

  return body.ok ? then(body.data) : body;
};

/**
 * Why gh's login may not merge as the `githubIdentity` in force where the command was typed (the
 * review screen's rule, `core/src/review/identity.ts`); none when it may or none is set.
 */
const notYou = async (ctx: TrackingCtx) => {
  const expected = ctx.settings?.at(ctx.cwd).values.githubIdentity ?? null;

  if (expected === null) return undefined;
  const me = await ctx.ports.tracking.me();

  return identityRefusal(expected, me.ok ? { ok: true, data: me.data.login } : me);
};

/**
 * `then` when the caller may write to `repo`: a person always, a session only in its run's repo
 * and when `mine` (given the session) holds.
 */
const ownWrite = async <T>(
  ctx: TrackingCtx,
  repo: Repo,
  mine: (own: Own) => Promise<Outcome<null>>,
  then: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> => {
  const own = ownSession(ctx);

  if (!own.ok) return own;
  if (own.data === undefined) return then();
  const its = await ownRepo(ctx, own.data);

  if (!its.ok) return its;
  if (!sameRepo(its.data, repo)) return notYours(own.data, repo);
  const ok = await mine(own.data);

  return ok.ok ? then() : ok;
};

/** A body from a session with its Overrides' lines in the Notes (#114): a rewrite keeps them. */
const withNotes = (ctx: TrackingCtx, body: string): string => {
  const meta = ctx.session === undefined ? undefined : ctx.serve.sessions?.metaOf(ctx.session);

  return meta === undefined
    ? body
    : withOverrideNotes(
        body,
        meta.overrides.map((o) => overrideNote(o, meta.id)),
      );
};

const always = () => Promise.resolve<Outcome<null>>({ ok: true, data: null });

/**
 * An issue a session opened, told to its Factory run (#200): the run keeps its spec's issues, for
 * its pull request to close. A session with no run, or a run that keeps none, changes nothing.
 */
const toldRun = async (
  ctx: TrackingCtx,
  made: Outcome<IssueData>,
  o: { labels: readonly string[]; parent: number | undefined },
): Promise<Outcome<IssueData>> => {
  if (made.ok && ctx.session !== undefined && ctx.serve.factory !== undefined)
    await ctx.serve.factory.apply(
      ctx.session,
      {
        type: 'issue-made',
        issue: {
          repo: made.data.repo,
          number: made.data.number,
          labels: o.labels,
          parent: o.parent ?? null,
        },
      },
      'issue-made',
    );

  return made;
};

export const trackingHandlers = {
  'issue show': (args, ctx) => withRef(args.ref, (ref) => ctx.ports.tracking.issueShow(ref)),
  'issue create': (args, ctx) =>
    args.parent !== undefined && !(Number.isInteger(args.parent) && args.parent > 0)
      ? usage(`--parent is not an issue number: ${args.parent}`)
      : withRepo(args.repo, (repo) =>
          ownWrite(ctx, repo, always, () =>
            withBody(ctx, args.bodyFile, async (body) => {
              const made = await ctx.ports.tracking.issueCreate({
                repo,
                title: args.title,
                body,
                labels: args.label,
                ...(args.parent === undefined ? {} : { parent: args.parent }),
              });

              // a parent's own Not Found says itself; the repo's means this login can't see it
              return toldRun(ctx, args.parent === undefined ? notVisible(ctx, repo, made) : made, {
                labels: args.label,
                parent: args.parent,
              });
            }),
          ),
        ),
  'pr show': (args, ctx) => withRef(args.ref, (ref) => ctx.ports.tracking.prShow(ref)),
  'pr create': (args, ctx) =>
    withRepo(args.repo, (repo) =>
      ownWrite(
        ctx,
        repo,
        (own) =>
          Promise.resolve(
            args.head === own.branch
              ? { ok: true, data: null }
              : notYours(own, `a pull request from ${args.head}`),
          ),
        () =>
          withBody(ctx, args.bodyFile, (body) =>
            ctx.ports.tracking.prCreate({
              repo,
              head: args.head,
              base: args.base,
              title: args.title,
              body: withNotes(ctx, body),
              draft: args.draft,
            }),
          ),
      ),
    ),
  'pr update': (args, ctx) =>
    withRef(args.ref, (ref) =>
      ownWrite(
        ctx,
        ref.repo,
        async (own) => {
          const pr = await ctx.ports.tracking.prShow(ref);

          if (!pr.ok) return pr;

          return pr.data.head.ref === own.branch
            ? { ok: true, data: null }
            : notYours(own, `${showRef(ref)} (from ${pr.data.head.ref})`);
        },
        () =>
          withBody(ctx, args.bodyFile, (body) =>
            ctx.ports.tracking.prUpdate(ref, {
              body: withNotes(ctx, body),
              ...(args.title === undefined ? {} : { title: args.title }),
            }),
          ),
      ),
    ),
  'pr merge': (args, ctx) =>
    withRef(args.ref, async (ref) => {
      const no = await notYou(ctx);

      if (no !== undefined) return refused(IDENTITY_REFUSED, no.why);

      return ctx.ports.tracking.prMerge(ref, {
        method: args.method ?? 'squash',
        ...(args.sha === undefined ? {} : { sha: args.sha }),
      });
    }),
  'deploy status': (args, ctx) =>
    withRepo(args.repo, (repo) =>
      ctx.ports.tracking.deployStatus({ repo, sha: args.sha, environment: args.env }),
    ),
} satisfies Partial<Handlers<TrackingCtx>>;
