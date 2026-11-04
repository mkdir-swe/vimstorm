/**
 * `abe chat` (the Abe chat, core's `hub.ts`): the repo's hub sessions, in its main checkout,
 * unjailed on this Mac as the person's own Claude Code (no Seatbelt, no fence; every abe command
 * the person's, prod-on too), its MCP servers the repo's `sources:`. Opened: the one running as
 * it is; else the last one reopened (its conversation resumed); none, or `--new`, a new
 * conversation beside any running (each its own session; Chat's tabs). `abe session reopen` on
 * one reopens that one. Words given are said to it as the person's message. `abe install`
 * opens it too and says `/abe:install` while the install is not Done. `--shown` marks the one
 * Chat shows (its tab): the one opened while several run.
 */
import { resolve } from 'node:path';
import {
  CORE_HUB_SKILLS,
  HUB_HELLO,
  HUB_REOPENED_PROMPT,
  type Clock,
  type HubData,
  hubInstructions,
  hubName,
  hubNumbered,
  hubTitle,
  hubUnnamed,
  type Journal,
  type Outcome,
  refused,
  type SessionData,
  type Handlers,
} from '@abe/core';
import { mainCheckout } from '@abe/ports';
import { answerQuestions } from './ask';
import { launchSettings, noSessions, type SessionCtx } from './sessions';

export type HubCtx = Pick<SessionCtx, 'settings' | 'cwd'> & {
  serve: Pick<SessionCtx['serve'], 'sessions'>;
} & {
  serve: {
    emit: Journal['emit'];
  };
};

/**
 * How `abe chat` opens it. `fresh`: a new conversation; `say`: the person's message to it; `id`:
 * that conversation (`abe session reopen`).
 */
export type HubOpen = { fresh?: boolean; say?: string | undefined; id?: string | undefined };

const opened = (s: SessionData, how: HubData['opened']): HubData => ({
  repo: s.abe?.repo ?? s.repo,
  id: s.id,
  title: s.title,
  state: s.state,
  opened: how,
});

/** Launched anew, or (`again`) its ended conversation reopened with `prompt` its first message. */
const launchHub = (
  ctx: HubCtx,
  top: string,
  prompt: string,
  again?: { id: string; name?: string | undefined },
  say?: string,
): Promise<Outcome<SessionData>> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return Promise.resolve(noSessions());
  // named by your first words to it, else by its number among the repo's
  const named = again?.name !== undefined && !hubUnnamed(again.name) ? again.name : undefined;
  const name =
    named ??
    (say === undefined
      ? (again?.name ?? hubNumbered(sessions.hubs(top).length + 1))
      : hubName(say));

  return sessions.launch(null, top, {}, launchSettings(ctx, top), {
    ...(again === undefined ? {} : { id: again.id, reopen: true as const }),
    abe: { of: { repo: top, name }, folder: top, title: hubTitle(top) },
    instructions: hubInstructions({ repo: top }),
    plugin: CORE_HUB_SKILLS,
    prompt,
  });
};

/**
 * The repo's Abe chat opened in its main checkout `top` (`abe chat`, `abe install`): see the
 * module. A message to a running one goes as the person's (a question it asked is answered by it).
 */
export const openHub = async (
  ctx: HubCtx,
  top: string,
  o: HubOpen = {},
): Promise<Outcome<HubData>> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  // On this Mac only: a box's serve has no Abe chat.
  if (!sessions.onTheMac()) return refused('no-hub', 'the Abe chat runs on your own machine');
  const had = o.id === undefined ? sessions.hub(top) : sessions.metaOf(o.id);
  const say = o.say?.trim() === '' ? undefined : o.say?.trim();

  if (had !== undefined && had.state !== 'ended' && o.fresh !== true) {
    if (say !== undefined && !(await answerQuestions(ctx, had.id, say))) {
      const sent = await sessions.message(had.id, say, null);

      if (!sent.ok) return sent;
    }
    const now = await sessions.get(had.id);

    return now.ok ? { ok: true, data: opened(now.data, 'running') } : now;
  }
  // an ended one goes on in its conversation; one with none (no hook ever heard) starts anew
  if (had !== undefined && o.fresh !== true) {
    const back = await launchHub(
      ctx,
      top,
      say ?? HUB_REOPENED_PROMPT,
      { id: had.id, name: had.abe?.name },
      say,
    );

    if (back.ok) {
      ctx.serve.emit('session.reopened', {
        id: back.data.id,
        card: null,
        worktree: back.data.worktree,
        at: back.data.since,
        recreated: false,
      });

      return { ok: true, data: opened(back.data, 'reopened') };
    }
  }
  const launched = await launchHub(ctx, top, say ?? HUB_HELLO, undefined, say);

  return launched.ok ? { ok: true, data: opened(launched.data, 'new') } : launched;
};

/**
 * `abe chat --shown <id>`: the repo's conversation `id` marked the one Chat shows (its tab), so
 * `abe chat` opens it again after the app's restart, not the newest; nothing else opened or said.
 */
const markShown = async (
  ctx: HubCtx & {
    serve: {
      clock: Clock;
    };
  },
  top: string,
  id: string,
): Promise<Outcome<HubData>> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  const had = sessions.hubs(top).find((m) => m.id === id);

  if (had === undefined) return refused('no-session', `no Abe chat conversation ${id} in ${top}`);
  const now = new Date(ctx.serve.clock.now()).toISOString();
  const marked = sessions.amend(id, (m) => ({ ...m, shown: now })) ?? had;

  return { ok: true, data: opened(marked, 'running') };
};

/** The main checkout `abe chat` names (default: where it was typed); a worktree's is its checkout's. */
export const hubCheckout = (cwd: string, repo: string | undefined): Outcome<string> => {
  const dir = resolve(cwd, repo ?? '.');
  const top = mainCheckout(dir);

  return top === undefined
    ? refused('not-a-checkout', `${dir} is no git checkout: the Abe chat is a repo's`)
    : { ok: true, data: top };
};

export const hubHandlers = () =>
  ({
    chat: async (args, ctx) => {
      const top = hubCheckout(ctx.cwd, args.repo);

      if (!top.ok) return top;
      if (args.shown !== undefined) return markShown(ctx, top.data, args.shown);

      return openHub(ctx, top.data, {
        fresh: args.new,
        say: args.words.join(' '),
      });
    },
  }) satisfies Partial<Handlers<HubCtx & { serve: { clock: Clock } }>>;
