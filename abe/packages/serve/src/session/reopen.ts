/**
 * `abe session reopen <id>` (#343): an ended card session goes on, the same id, worktree and
 * Claude Code conversation (`claude --resume`). Its worktree is made again from its branch when it
 * was cleared; with the branch gone too it is refused (`worktree-gone`). A run not over goes on at
 * its stage (its Needs you answered); a run over is a plain conversation (`abe factory` refuses
 * it, `run-over`). In your environment the box does it (`CloudSessions.reopen`).
 */
import { existsSync } from 'node:fs';
import {
  cardRunningText,
  type Clock,
  FACTORY_PERMISSION_MODE,
  type Journal,
  type Outcome,
  refused,
  reopenedInstructions,
  reopenedPrompt,
  runOver,
  type SessionData,
  type ShortAnswer,
  worktreeGoneText,
  type Handlers,
} from '@abe/core';
import { type FactoryCtx } from '../factory/factory';
import { reopenPrototype } from '../prototype/code-prototype';
import { type PrototypesCtx } from '../prototype/prototypes';
import { sessionReach } from '../layer/reach';
import { openHub } from './hub';
import { launchSettings, noSessions, yours } from './sessions';

export type ReopenCtx = FactoryCtx &
  Pick<PrototypesCtx, 'settings'> & {
    serve: Pick<PrototypesCtx['serve'], 'prototypes' | 'org'>;
  } & {
    serve: {
      emit: Journal['emit'];
      clock: Clock;
    };
  };

/** Another session of the same card still running (here or in your environment), if one is. */
const runningOnCard = async (
  ctx: ReopenCtx,
  meta: Pick<SessionData, 'id' | 'card' | 'repo'>,
): Promise<SessionData | undefined> => {
  const here = await ctx.serve.sessions?.list();
  const there = ctx.serve.cloud === undefined ? [] : await ctx.serve.cloud.list();

  return [...(here?.ok === true ? here.data : []), ...there].find(
    (s) =>
      s.id !== meta.id &&
      s.card === meta.card &&
      s.repo === meta.repo &&
      s.kind === 'card' &&
      s.state !== 'ended',
  );
};

export const reopen = async (
  ctx: ReopenCtx,
  id: string,
  message: string | undefined,
  /** Onto its box running short (ADR 0022): resized first, or as it is; none: asked. */
  short?: ShortAnswer,
): Promise<Outcome<SessionData>> => {
  const refusal = yours(ctx, id);

  if (refusal !== undefined) return refusal;
  if (ctx.session === undefined && ctx.serve.cloud?.knows(id) === true) {
    // in your environment: one of its card running here (or on its box) holds it as a local one
    const there = await ctx.serve.cloud.get(id);
    const busy = there.ok ? await runningOnCard(ctx, there.data) : undefined;

    if (busy !== undefined && there.ok && there.data.card !== null)
      return refused('card-has-session', cardRunningText(there.data.card, busy.id));
    const opened = await ctx.serve.cloud.reopen(id, message, short);

    if (opened.ok)
      ctx.serve.emit('session.reopened', {
        id,
        card: opened.data.card,
        worktree: opened.data.worktree,
        at: opened.data.since,
        recreated: false,
      });

    return opened;
  }
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  const meta = sessions.metaOf(id);

  if (meta === undefined) return refused('no-session', `no session ${id}`);
  // the Abe chat: the same conversation, as `abe chat` reopens it
  if (meta.kind === 'abe' && meta.abe !== undefined && meta.abe !== null) {
    if (meta.state !== 'ended')
      return refused(
        'not-ended',
        `session ${id} is ${meta.state}: attach it (abe session attach ${id})`,
      );
    const hub = await openHub(ctx, meta.abe.repo, { say: message, id });

    if (!hub.ok) return hub;
    const back = await sessions.get(hub.data.id);

    return back;
  }
  // a prototype with no card: the same session, worktree and conversation
  if (meta.kind === 'prototype' && meta.card === null) {
    if (meta.state !== 'ended')
      return refused(
        'not-ended',
        `session ${id} is ${meta.state}: attach it (abe session attach ${id})`,
      );
    const back = await reopenPrototype(
      { ...ctx, serve: { ...ctx.serve, sessions } },
      meta,
      message,
    );

    if (back.ok)
      ctx.serve.emit('session.reopened', {
        id,
        card: null,
        worktree: back.data.worktree,
        at: back.data.since,
        recreated: false,
      });

    return back;
  }
  if (meta.kind !== 'card' || meta.card === null)
    return refused(
      'not-reopenable',
      `session ${id} is a card's prototype session: abe prototype start --card ${String(meta.card)} opens it again, in the same worktree`,
    );
  if (meta.state !== 'ended')
    return refused(
      'not-ended',
      `session ${id} is ${meta.state}: attach it (abe session attach ${id})`,
    );
  const busy = await runningOnCard(ctx, meta);

  if (busy !== undefined) return refused('card-has-session', cardRunningText(meta.card, busy.id));
  const run = ctx.serve.factory?.get(id);
  const goesOn = run !== undefined && !runOver(run);
  // its claude never ran a hook (#355): no conversation to go back into, said with the way on
  if (meta.transcriptPath === null)
    return refused(
      'no-conversation',
      `session ${id} never started a conversation (its claude ran no hook): ${goesOn ? 'Retry run starts its card again' : 'Launch new agent… starts fresh'}`,
    );
  const recreated = meta.worktree !== '' && !existsSync(meta.worktree);
  // The settings and Reach in force in its checkout now: a reopen is launched as a launch is.
  const reach = await sessionReach({ ...ctx, cwd: meta.repo }, 'local');

  if (!reach.ok) return reach;
  const launched = await sessions.launch(
    { id: meta.card, title: meta.title, description: '', acceptanceCriteria: '' },
    meta.repo,
    reach.data.env,
    launchSettings(ctx, meta.repo),
    {
      id,
      reopen: true,
      branch: meta.branch,
      browserProfile: meta.browserProfile,
      instructions: reopenedInstructions(run),
      prompt: reopenedPrompt(message, run),
      // A run that goes on keeps a run's launch: its permission mode and its own browser.
      ...(goesOn ? { permissionMode: FACTORY_PERMISSION_MODE, browser: true, factory: true } : {}),
    },
  );

  if (!launched.ok)
    return launched.error.code === 'worktree-gone'
      ? refused(
          'worktree-gone',
          worktreeGoneText({
            branch: meta.branch,
            cleared: run?.cleared?.at ?? null,
            now: new Date(ctx.serve.clock.now()).toISOString(),
          }),
        )
      : launched;
  // Reopen clears Needs you (the person is back): the run goes on at its stage.
  if (goesOn && run.needsYou !== null)
    await ctx.serve.factory?.apply(id, { type: 'answered' }, 'reopen');
  ctx.serve.emit('session.reopened', {
    id,
    card: meta.card,
    worktree: launched.data.worktree,
    at: launched.data.since,
    recreated,
  });

  return launched;
};

export const reopenHandlers = () => {
  /** Reopens under way: a second one of the same session (a ⏎ twice) never starts a second claude. */
  const reopening = new Set<string>();

  return {
    'session reopen': async (args, ctx) => {
      if (reopening.has(args.id))
        return refused('not-ended', `session ${args.id} is being reopened already`);
      reopening.add(args.id);
      try {
        return await reopen(ctx, args.id, args.message, args.short);
      } finally {
        reopening.delete(args.id);
      }
    },
  } satisfies Partial<Handlers<ReopenCtx>>;
};
