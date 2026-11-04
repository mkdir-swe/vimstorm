/**
 * `abe session override` (#114 S4, serve's half): an Override on one session, kept in its meta
 * (it dies with the session), noted in the pull request's Notes (now through the PR port when one
 * is open, else when `abe factory pr` opens it) and sent as `session.override`; the story gets no
 * comment (`NOT_COMMENTED`). What it lowers: a PermissionRequest in its area is held for a
 * permission card (`ask.ts`) instead of 2.0's answer (a box's unattended rules, a person's own
 * dialog). The session's environment and sandbox are fixed at launch, so a write name a session
 * was not launched with stays out of it: such an Override is recorded and tracked only.
 */
import {
  type ByCard,
  type Git,
  githubRepoOf,
  inArea,
  NOT_COMMENTED,
  type Outcome,
  overrideNote,
  parseOverride,
  refused,
  type SessionMeta,
  type SessionOverride,
  SessionOverrideData,
  withOverrideNotes,
  type Handlers,
} from '@abe/core';
import { type AskCtx } from '../session/ask';
import { type Factory } from '../factory/factory';
import { noSessions, on } from '../session/sessions';

/** The first live Override whose area a PermissionRequest is in; undefined: 2.0's rules answer. */
export const heldBy = (meta: SessionMeta, payload: unknown): SessionOverride | undefined =>
  meta.state === 'ended' ? undefined : meta.overrides.find((o) => inArea(o, payload));

export type OverrideCtx = AskCtx & {
  /** A session's worktree's git, by its card. */
  ports: { git: ByCard<Git> | undefined };
  serve: {
    /** The Factory runs: a session with none has no `abe factory pr` to note it later (#187). */
    factory?: Pick<Factory, 'get'> | undefined;
  };
};

/** Why the story got no comment: Abe leaves them to you (`NOT_COMMENTED`). */
const storyOf = (meta: SessionMeta): string =>
  meta.card === null ? 'no story: a chat of yours' : NOT_COMMENTED;

/** The note in the open pull request's body, or where it goes instead. */
const notePr = async (ctx: OverrideCtx, meta: SessionMeta, o: SessionOverride): Promise<string> => {
  const later =
    ctx.serve.factory?.get(meta.id) === undefined
      ? 'no pull request open: not noted (no Factory run on this session, so none opens one)'
      : 'no pull request open yet: noted when abe factory pr opens it';

  if (meta.branch === '' || meta.worktree === '') return later;
  if (ctx.ports.git === undefined)
    return `not noted: this abe serve has no git for sessions; ${later}`;
  const origin = await ctx.ports.git(meta.card).origin(meta.worktree);

  if (!origin.ok) return `not noted: ${origin.error.message}; ${later}`;
  const repo = githubRepoOf(origin.data.url);

  if (repo === undefined) return `not noted: origin is not a repo on GitHub; ${later}`;
  const open = await ctx.ports.tracking.prFind({ repo, head: meta.branch });

  if (!open.ok) return `not noted: ${open.error.message}; ${later}`;
  if (open.data === null) return later;
  const body = withOverrideNotes(open.data.body, [overrideNote(o, meta.id)]);

  if (body === open.data.body) return `noted on ${open.data.url}`;
  const updated = await ctx.ports.tracking.prUpdate({ repo, number: open.data.number }, { body });

  return updated.ok ? `noted on ${updated.data.url}` : `not noted: ${updated.error.message}`;
};

/** An Override on this serve's session: recorded, sent, noted. */
const overrideHere = async (
  ctx: OverrideCtx,
  args: { id: string; what: string; reason: string },
): Promise<Outcome<SessionOverrideData>> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  const meta = sessions.metaOf(args.id);

  if (meta === undefined) return refused('no-session', `no session ${args.id}`);
  if (meta.state === 'ended') return refused('session-ended', `session ${args.id} has ended`);
  const values = ctx.settings?.at(meta.repo).values;
  const parsed = parseOverride({
    what: args.what,
    reason: args.reason,
    // A box's serve runs its sessions in your environment, where write names exist.
    where: ctx.serve.where,
    environments: Object.keys(values?.environments ?? {}),
    at: new Date(ctx.serve.clock.now()).toISOString(),
  });

  if (!parsed.ok) return parsed;
  const o = parsed.data;
  const kept = sessions.amend(args.id, (m) => ({
    ...m,
    overrides: [...m.overrides.filter((x) => x.what !== o.what), o],
  }));

  ctx.serve.emit('session.override', { id: args.id, card: meta.card, override: o });
  const after = kept ?? meta;
  const pr = await notePr(ctx, after, o);

  return { ok: true, data: { id: args.id, override: o, story: storyOf(after), pr } };
};

export const overrideHandlers = () =>
  ({
    'session override': (args, ctx) =>
      on(
        ctx,
        args.id,
        () => overrideHere(ctx, args),
        (c) =>
          c.relay(args.id, SessionOverrideData, [
            'session',
            'override',
            args.id,
            '--what',
            args.what,
            '--reason',
            args.reason,
          ]),
      ),
  }) satisfies Partial<Handlers<OverrideCtx>>;
