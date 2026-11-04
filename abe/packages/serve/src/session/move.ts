/**
 * Download locally and Move to cloud (#88): recovery only, no flow and no confirm. `abe session
 * download <id>` copies a cloud session's Workspace from its box to this Mac and the same session
 * goes on here (reads only, its state from hooks as any session's); the box is stopped, its disk
 * kept. `abe session move-to-cloud <id>` is the other way: into a Workspace on the card's own box
 * (Queued past your box limit); the local worktree stays as it was. Each side's record of the
 * session is marked moved, and `session.moved` says where it went. What crosses is core's
 * (`core/src/session/move.ts`), the copy the Mover's (`ports/src/git/move.ts`), the box reached only through
 * `abe box attach <box> -- …` (ADR 0021).
 *
 * Order: everything a move can refuse for is asked before its running `claude` is stopped (the
 * card's session here, the id, the worktree); one move of a session at a time (`move-busy`); a
 * worktree this run made is taken away again when the copy or the launch fails after it.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  boxUnreachableMessage,
  type Clock,
  claudeSessionOf,
  type Commands,
  type Handler,
  type Journal,
  type Mover,
  movedPrompt,
  movedTranscriptLog,
  movePlan,
  type MovePlan,
  type Outcome,
  refused,
  SETTINGS,
  type SessionMoveData,
  localCheckoutOf,
  type Handlers,
} from '@abe/core';
import { originRepo } from '@abe/ports';
import { realPathAt } from '../contract/here';
import { sessionReach } from '../layer/reach';
import { launchSettings, readCard, type SessionCtx } from './sessions';

/** The sessions one serve moves now: a second move of one is refused while it runs. */
export type MoveLocks = {
  /** `run` for `id`, one at a time: a second move of the same session is `move-busy`. */
  once: <T>(id: string, run: () => Promise<Outcome<T>>) => Promise<Outcome<T>>;
};

/** A serve's own move locks: two serves in one process never hold each other up. */
export const moveLocks = (): MoveLocks => {
  const moving = new Set<string>();

  return {
    once: async (id, run) => {
      if (moving.has(id)) return refused('move-busy', `session ${id} is being moved already`);
      moving.add(id);
      try {
        return await run();
      } finally {
        moving.delete(id);
      }
    },
  };
};

export type MoveCtx = SessionCtx & {
  serve: {
    mover: Mover;
    /** This serve's moves in flight. */
    moves: MoveLocks;
    /** Where packs wait (a Move to cloud's until its box is up): `<state>/moves`. */
    moveDir: string | undefined;
    clock: Clock;
    emit: Journal['emit'];
  };
};

const noEnvironment = () =>
  refused('no-boxes', 'this abe serve fronts no boxes: sessions are moved from your local machine');

/** The repo pack's `move.leave` in force in `checkout` (never a worktree the agent writes). */
const leaveGlobs = (ctx: MoveCtx, checkout: string): readonly string[] =>
  ctx.settings?.at(checkout).values['move.leave'] ?? SETTINGS['move.leave'].default;

const packFile = (ctx: MoveCtx, id: string): Outcome<string> => {
  if (ctx.serve.moveDir === undefined)
    return refused('no-sessions', 'this abe serve was started without a session runner');
  mkdirSync(ctx.serve.moveDir, { recursive: true, mode: 0o700 });

  return { ok: true, data: join(ctx.serve.moveDir, `${id}.tar`) };
};

/** The listed files as a plan, or the refusal when the other side listed what no worktree does. */
const planOf = (ctx: MoveCtx, checkout: string, files: readonly string[]): Outcome<MovePlan> => {
  const plan = movePlan(files, leaveGlobs(ctx, checkout));

  return plan.unsafe.length === 0
    ? { ok: true, data: plan }
    : refused(
        'unsafe-path',
        `the worktree listed paths no move copies (out of it, or into .git): ${plan.unsafe.slice(0, 3).join(', ')}${plan.unsafe.length > 3 ? ', …' : ''}`,
      );
};

/** What the box's stop said, when it did not stop. */
const boxNote = (box: Outcome<unknown> | undefined): string | null => {
  if (box === undefined) return 'no box control here: stop it with abe box stop';

  return box.ok ? null : `the box did not stop: ${box.error.message}`;
};

const download: Handler<Commands['session download'], MoveCtx> = async (args, ctx) => {
  const { cloud, sessions } = ctx.serve;

  if (cloud === undefined) return noEnvironment();
  if (sessions === undefined)
    return refused('no-sessions', 'this abe serve was started without a session runner');
  if (!cloud.knows(args.id))
    return sessions.metaOf(args.id)?.moved === null
      ? refused('not-cloud', `session ${args.id} runs on this machine already`)
      : refused('no-session', `no session ${args.id} on your boxes`);
  // The newest the box says (its transcript, once a hook named it), while it still answers.
  await cloud.get(args.id);
  const m = cloud.movable(args.id);

  if (!m.ok) return m;
  const s = m.data;
  const checkout = realPathAt(ctx.cwd, args.repo ?? '.');
  const repo = await originRepo(checkout);

  if (repo !== s.repo)
    return refused(
      'wrong-repo',
      `${checkout} is ${repo ?? 'no GitHub checkout'}, not ${s.repo}: run it in that repo's checkout or name it with --repo`,
    );

  // The Claude session resumed: the transcript's (after `/clear` it is not the one started).
  const claudeSession = claudeSessionOf(s.transcriptPath);

  return ctx.serve.moves.once(s.id, async () => {
    // What the launch here would refuse, before the box is touched.
    const admitted = sessions.admit(s.card, checkout, s.id, claudeSession !== undefined);

    if (!admitted.ok) return admitted;
    const pack = packFile(ctx, s.id);

    if (!pack.ok) return pack;
    const worktree = await ctx.serve.mover.worktree(checkout, s.branch);

    if (!worktree.ok) return worktree;
    // From here a failure takes the worktree this run made away again.
    const undone = async <T>(out: Outcome<T>): Promise<Outcome<T>> => {
      if (!out.ok) await ctx.serve.mover.dropWorktree(checkout, worktree.data);

      return out;
    };
    const exec = cloud.execOn(s.box, s.card);
    const unreachable = (why: string) =>
      refused('box-unreachable', boxUnreachableMessage(s.box, s.repo, s.card, why));
    const reached = await ctx.serve.mover.reach(exec);

    if (!reached.ok) return undone(unreachable(reached.error.message));
    // Its claude stopped first: the transcript and the files hold still while they are copied.
    const stopped = await cloud.stopOnBox(s.id);

    if (!stopped.ok)
      return undone(
        stopped.error.code === 'box-unreachable' || stopped.error.code === 'serve-unreachable'
          ? unreachable(stopped.error.message)
          : stopped,
      );
    const listed = await ctx.serve.mover.list(exec, s.worktree);

    if (!listed.ok) return undone(listed);
    const plan = planOf(ctx, checkout, listed.data.files);

    if (!plan.ok) return undone(plan);
    const log = movedTranscriptLog(s.card, s.id);

    try {
      const packed = await ctx.serve.mover.pack({
        exec,
        root: s.worktree,
        files: plan.data.copied,
        transcript: claudeSession === undefined ? null : s.transcriptPath,
        out: pack.data,
      });

      if (!packed.ok) return await undone(packed);
      const copied = await ctx.serve.mover.unpack({
        exec: [],
        root: worktree.data,
        pack: pack.data,
        files: plan.data.copied,
        branch: s.branch,
        log: claudeSession === undefined ? null : log,
        stash: `abe: before ${s.id} was downloaded`,
      });

      if (!copied.ok) return await undone(copied);
      // Reads only: a session on this Mac (ADR 0010).
      const reach = await sessionReach({ ...ctx, cwd: checkout }, 'local');

      if (!reach.ok) return await undone(reach);
      const launched = await sessions.launch(
        { id: s.card, title: s.title, description: s.description, acceptanceCriteria: s.criteria },
        checkout,
        reach.data.env,
        launchSettings(ctx, checkout),
        {
          id: s.id,
          branch: s.branch,
          ...(claudeSession === undefined
            ? {}
            : {
                prompt: movedPrompt('local'),
                resume: { claudeSession, transcript: log, from: listed.data.cwd },
              }),
        },
      );

      if (!launched.ok) return await undone(launched);
      const at = new Date(ctx.serve.clock.now()).toISOString();

      cloud.movedOut(s.id, { to: 'local', at, where: launched.data.worktree });
      // Stopped, never deleted: its disk (the clone, .scratch) stays for a later look.
      const box = ctx.serve.boxes === undefined ? undefined : await ctx.serve.boxes.stop(s.box);
      const boxStopped = box?.ok === true;

      ctx.serve.emit('session.moved', {
        id: s.id,
        card: s.card,
        from: 'cloud',
        to: 'local',
        box: s.box,
        worktree: launched.data.worktree,
      });

      return {
        ok: true,
        data: {
          id: s.id,
          card: s.card,
          from: 'cloud',
          to: 'local',
          box: s.box,
          worktree: launched.data.worktree,
          branch: s.branch,
          head: listed.data.head,
          state: launched.data.state,
          copied: {
            staged: listed.data.staged,
            unstaged: listed.data.unstaged,
            files: plan.data.copied,
            transcript: claudeSession !== undefined,
          },
          left: plan.data.left,
          boxStopped,
          note: boxNote(box),
        } satisfies SessionMoveData,
      };
    } finally {
      rmSync(pack.data, { force: true });
    }
  });
};

const moveToCloud: Handler<Commands['session move-to-cloud'], MoveCtx> = async (args, ctx) => {
  const { cloud, sessions } = ctx.serve;

  if (sessions === undefined)
    return refused('no-sessions', 'this abe serve was started without a session runner');
  const meta = sessions.metaOf(args.id);

  if (meta?.moved !== null)
    return cloud?.knows(args.id) === true
      ? refused('not-local', `session ${args.id} runs on its box already`)
      : refused('no-session', `no session ${args.id} on this machine`);
  if (meta.card === null)
    return refused('not-a-card', `session ${args.id} is on no card (the Abe chat): it stays here`);
  if (cloud === undefined) return noEnvironment();
  const checkout = meta.repo;
  // Local mode (#24): agents run on this Mac only.
  const localMode = localCheckoutOf(ctx.settings?.at(checkout).values.localMode ?? [], checkout);

  if (localMode !== undefined)
    return refused(
      'local-mode',
      `local mode is on in ${localMode}: session ${args.id} stays on this machine`,
    );
  const repo = await originRepo(checkout);

  if (repo === undefined)
    return refused('no-github-repo', `${checkout} has no GitHub origin to move onto a box`);
  const card = await readCard(ctx, String(meta.card), checkout);

  if (!card.ok) return card;
  const cardId = meta.card;

  return ctx.serve.moves.once(meta.id, async () => {
    // What the placement would refuse, before its claude is stopped.
    const admitted = cloud.admit(cardId, repo, meta.id);

    if (!admitted.ok) return admitted;
    const pack = packFile(ctx, meta.id);

    if (!pack.ok) return pack;
    // Its claude stopped first: the transcript and the files hold still while they are packed.
    if (meta.state !== 'ended') {
      const stopped = await sessions.stop(meta.id);

      if (!stopped.ok) return stopped;
    }
    const listed = await ctx.serve.mover.list([], meta.worktree);

    if (!listed.ok) return listed;
    const plan = planOf(ctx, checkout, listed.data.files);

    if (!plan.ok) return plan;
    // The Claude session as its transcript names it (after `/clear` it is not the one started).
    const claudeSession = claudeSessionOf(meta.transcriptPath);
    const transcript = claudeSession === undefined ? null : meta.transcriptPath;
    const log = movedTranscriptLog(cardId, meta.id);
    const packed = await ctx.serve.mover.pack({
      exec: [],
      root: meta.worktree,
      files: plan.data.copied,
      transcript,
      out: pack.data,
    });

    if (!packed.ok) {
      rmSync(pack.data, { force: true });

      return packed;
    }
    // The pack waits in moves/ until the box is up (a queued move's, until a box stops or is deleted, or the limit rises).
    const launched = await cloud.moveIn(
      card.data,
      repo,
      checkout,
      {
        id: meta.id,
        pack: pack.data,
        files: plan.data.copied,
        worktree: meta.worktree,
        browserProfile: meta.browserProfile,
        resume:
          claudeSession === undefined
            ? null
            : { claudeSession, transcript: log, from: listed.data.cwd },
      },
      // onto its repo's box running short (ADR 0022): asked as a launch is; its claude stopped
      // already, so the answer moves the ended session
      args.short,
    );

    if (!launched.ok) {
      rmSync(pack.data, { force: true });

      return launched;
    }
    const box = launched.data.box ?? '';
    const at = new Date(ctx.serve.clock.now()).toISOString();
    const moved = await sessions.moveOut(meta.id, { to: 'cloud', at, where: box });

    if (!moved.ok) return moved;
    ctx.serve.emit('session.moved', {
      id: meta.id,
      card: cardId,
      from: 'local',
      to: 'cloud',
      box,
      worktree: launched.data.worktree,
    });

    return {
      ok: true,
      data: {
        id: meta.id,
        card: cardId,
        from: 'local',
        to: 'cloud',
        box,
        worktree: launched.data.worktree,
        branch: meta.branch,
        head: listed.data.head,
        state: launched.data.state,
        copied: {
          staged: listed.data.staged,
          unstaged: listed.data.unstaged,
          files: plan.data.copied,
          transcript: transcript !== null,
        },
        left: plan.data.left,
        boxStopped: null,
        note: `${meta.worktree} stays as it was`,
      },
    };
  });
};

export const moveHandlers = () =>
  ({
    'session download': download,
    'session move-to-cloud': moveToCloud,
  }) satisfies Partial<Handlers<MoveCtx>>;
