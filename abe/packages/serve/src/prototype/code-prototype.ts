/**
 * Prototype sessions (core's `code-prototype.ts`): `prototype start <words…> [--card]` (the Abe
 * chat's `/abe:prototype`) makes the throwaway worktree (`proto/<card or id>-<slug>`, no
 * upstream, the refusing pre-push hook), launches a Claude Code session on it with the prototype
 * skill, jailed as a card's session (with a card, its run in Build: it never moves on), its
 * packages cloned from the main checkout and the person's Figma server loaded, and starts the app
 * from that worktree behind the prototype proxy, or the normal way on a repo's fixed ports (ADR
 * 0039): its `url` is the preview link. Where cards
 * run (`serve.target`): this Mac, or the repo's box (its workspace keyed by the prototype's id,
 * its app's port forwarded here by `prototype list`).
 * `prototype make-card` makes a plain card of it (New, tagged `prototype`, a `## Prototype`
 * section), its diff and screenshots kept in the org store as the card's reference. `prototype
 * discard` stops it and removes the worktree and its branch, whatever they hold.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  boardOf,
  codePrototypeLine,
  type CodePrototype,
  codePrototypeInstructions,
  CODE_PROTOTYPE_DENY,
  CODE_PROTOTYPE_PLUGIN,
  codePrototypePrompt,
  type CodeShown,
  isPng,
  lastLines,
  LOG_LINES,
  patchesOfDiff,
  type PrototypeShowData,
  screenshotFile,
  type Mover,
  codeStoreVersion,
  codeUploadPlan,
  type DiscardData,
  FACTORY_PERMISSION_MODE,
  isCloudTarget,
  type MakeCardData,
  newRun,
  type Outcome,
  parseCardId,
  prototypeBranch,
  type PrototypeData,
  prototypeData,
  type PrototypeMeta,
  type SessionData,
  prototypeTitle,
  PROTOTYPE_TAG,
  refused,
  storeRepoName,
  withPrototypeSection,
  type WorktreeFate,
  type Handlers,
} from '@abe/core';
import { type BoardCtx } from '../board/board';
import { type FactoryCtx, runStarted } from '../factory/factory';
import { putVersion, readOrgPrototype } from '../sheets/org';
import { boardAt, orgAt } from '../local-mode/local-mode';
import { serveTargetIn } from '../layer/settings';
import {
  dropDatabase,
  fresh,
  halt,
  launch,
  newMeta,
  now,
  type Prototypes,
  type PrototypesCtx,
  queued,
  RUNNING,
  withPrototypes,
} from './prototypes';
import { sessionReach } from '../layer/reach';
import { readOwnBody } from '../session/own';
import { cloudRepo, prototypeLaunchSettings, readCard } from '../session/sessions';

export type CodePrototypeCtx = PrototypesCtx &
  FactoryCtx &
  BoardCtx & {
    serve: {
      /** Reads a box's workspace (a prototype there: its diff for make-card). */
      mover?: Mover | undefined;
    };
  };

/** Where a prototype session on a box keeps its PNGs (its instructions say so). */
const BOX_SCREENSHOTS = '.scratch/prototype';

/**
 * A prototype on a box: the PNGs its session kept in its clone (`BOX_SCREENSHOTS`) copied here
 * and kept as its screenshots, each once (by its file's name, its `what`), so make-card uploads
 * them as it does a local one's. One on this Mac: as it is.
 */
const boxScreenshots = async (
  ctx: CodePrototypeCtx,
  p: Prototypes,
  meta: PrototypeMeta,
  code: CodePrototype,
): Promise<Outcome<PrototypeMeta>> => {
  if (code.box === null || ctx.serve.cloud === undefined || ctx.serve.mover === undefined)
    return { ok: true, data: meta };
  const to = mkdtempSync(join(tmpdir(), 'abe-shots-'));

  try {
    const got = await ctx.serve.mover.get({
      exec: ctx.serve.cloud.execOn(code.box, meta.id),
      root: code.worktree,
      dir: BOX_SCREENSHOTS,
      to,
    });

    if (!got.ok)
      return refused('no-screenshots', `${BOX_SCREENSHOTS} on ${code.box}: ${got.error.message}`);
    let next = meta;

    for (const name of readdirSync(to)
      .filter((n) => n.endsWith('.png'))
      .sort()) {
      const what = name.replace(/\.png$/, '');
      const png = new Uint8Array(readFileSync(join(to, name)));

      if (next.screenshots.some((x) => x.what === what) || !isPng(png)) continue;
      const n = Math.max(0, ...next.screenshots.map((x) => x.n)) + 1;
      const screenshot = { n, file: screenshotFile(n), what, at: now(p) };

      await p.local.writeScreenshot(meta.id, screenshot.file, png);
      next = { ...next, screenshots: [...next.screenshots, screenshot] };
    }
    if (next !== meta) await p.local.write(next);

    return { ok: true, data: next };
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
};

/**
 * The prototype's diff against where its branch was made from: its worktree's on this Mac, its
 * workspace's clone on a box (read over the box's exec).
 */
const diffOf = async (
  ctx: CodePrototypeCtx,
  meta: PrototypeMeta,
  code: CodePrototype,
): Promise<Outcome<string>> => {
  if (code.box !== null) {
    if (ctx.serve.cloud === undefined || ctx.serve.mover === undefined)
      return refused(
        'no-boxes',
        `prototype ${meta.id} is on ${code.box}: this serve reaches no boxes`,
      );
    const read = await ctx.serve.mover.diff(
      ctx.serve.cloud.execOn(code.box, meta.id),
      code.worktree,
      meta.commit,
    );

    return read.ok
      ? read
      : refused('no-diff', `${code.worktree} on ${code.box}: ${read.error.message}`);
  }
  const factory = ctx.serve.factory;

  if (factory === undefined) return noSessions();
  const diff = await factory.tree(null).diff(code.worktree);

  return diff.ok
    ? { ok: true, data: diff.patch }
    : refused('no-diff', `${code.worktree} has no diff to keep: ${diff.message}`);
};

const usage = (message: string) => refused('usage', message, 2);

const noSessions = () =>
  refused('no-sessions', 'this abe serve was started without a session runner');

/** The prototype's session and worktree, when it is one not done with. */
const codeOf = (meta: PrototypeMeta): Outcome<CodePrototype> => {
  if (meta.code === null)
    return refused(
      'not-code',
      `${meta.id} is an older prototype of injected changes: abe prototype start makes a new one`,
    );
  if (meta.code.ended)
    return refused(
      'prototype-ended',
      `${meta.id} is done with: discarded, or opened again in a new session`,
    );

  return { ok: true, data: meta.code };
};

/** The prototype's `code` changed and kept (read again first: its queue may have moved it). */
const keepCode = async (p: Prototypes, meta: PrototypeMeta, code: Partial<CodePrototype>) => {
  const now0 = (await fresh(p, meta.id)) ?? meta;

  if (now0.code !== null) await p.local.write({ ...now0, code: { ...now0.code, ...code } });
  // Done with (discarded, opened again under a new id): its database goes too (#349).
  if (code.ended === true) await dropDatabase(p, now0).catch(() => undefined);
};

/** A card's prototype's run ends: cleared, so the lanes no longer show it. */
const dropRun = async (
  ctx: CodePrototypeCtx,
  p: Prototypes,
  code: CodePrototype,
  fate: WorktreeFate,
) => {
  if (ctx.serve.factory?.get(code.session) === undefined) return;
  await ctx.serve.factory.apply(
    code.session,
    { type: 'prototype-dropped', cleared: { at: now(p), ...fate } },
    'prototype-dropped',
  );
};

/**
 * A card's prototype already open: the same again, its app started if it does not run. One whose
 * session ended: its app stopped and its run off the lanes, done with (the new session goes on in
 * the same worktree).
 */
const openOnCard = async (
  ctx: CodePrototypeCtx,
  p: Prototypes,
  repo: string,
  card: number,
): Promise<PrototypeMeta | undefined> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return undefined;
  // sessions whose claude is gone are ended first
  await sessions.list();
  const mine = (await p.local.all()).filter(
    (m) => m.code !== null && !m.code.ended && m.repo === repo && m.card === card,
  );
  const ended = (m: PrototypeMeta) =>
    (sessions.metaOf(m.code?.session ?? '')?.state ?? 'ended') === 'ended';
  const open = mine.find((m) => !ended(m));

  if (open !== undefined) {
    if (!RUNNING.includes(open.state))
      void p
        .serial(open.id, async () => launch(p, (await fresh(p, open.id)) ?? open, 'reopen'))
        .catch(() => undefined);

    return open;
  }
  // On its queue, read again there: its app's start may still be going, and would write it back
  // live and not ended after this.
  for (const listed of mine)
    await p.serial(listed.id, async () => {
      const old = (await fresh(p, listed.id)) ?? listed;

      if (old.code === null) return;
      if (RUNNING.includes(old.state)) await halt(p, old, 'reopen').catch(() => undefined);
      if (ctx.serve.factory?.get(old.code.session)?.cleared === null)
        await dropRun(ctx, p, old.code, {
          worktree: 'kept',
          why: 'opened again in a new session',
        });
      await keepCode(p, old, { ended: true });
    });

  return undefined;
};

/**
 * `prototype start` where cards run on boxes (`serve.target` cloud): the session on the repo's
 * box (`CloudSessions.prototype`), its workspace keyed by the prototype's id on its `proto/…`
 * branch, jailed by its container as a card's. Its app is started there by the session (`abe run
 * start`); `prototype list` forwards its port here and names that as its url once it listens.
 */
const startOnBox = async (
  ctx: CodePrototypeCtx,
  p: Prototypes,
  head: Parameters<typeof newMeta>[1],
  id: number | null,
  words: string,
): Promise<Outcome<PrototypeData>> => {
  const cloud = ctx.serve.cloud;

  if (cloud === undefined)
    return refused(
      'no-boxes',
      'serve.target is cloud, but this abe serve reaches no environment of yours to start a prototype in',
    );
  const github = await cloudRepo('', head.repo);

  if (!github.ok) return github;
  const card = id === null ? null : await readCard(ctx, String(id), head.repo);

  if (card !== null && !card.ok) return card;
  const meta = await newMeta(p, head, id);
  const branch =
    card === null
      ? prototypeBranch(meta.id, words)
      : prototypeBranch(card.data.id, card.data.title);
  const ran = await cloud.prototype(
    {
      id: meta.id,
      card: card === null ? null : card.data,
      words,
      title: prototypeTitle({ card: id, words }),
      branch,
      base: head.branch,
      commit: head.commit,
    },
    github.data,
    head.repo,
  );

  if (!ran.ok) return ran;
  const kept: PrototypeMeta = {
    ...meta,
    code: {
      session: ran.data.id,
      branch,
      worktree: ran.data.worktree,
      box: ran.data.box ?? null,
      spec: null,
      stored: null,
      commented: false,
      sent: null,
      made: null,
      ended: false,
    },
  };

  await p.local.write(kept);

  return { ok: true, data: prototypeData(kept) };
};

/** `prototype start`: the worktree, the session (with a card, its run in Build), then the app. */
const start = (
  ctx: CodePrototypeCtx,
  args: { words?: string[] | undefined; repo?: string | undefined; card?: string | undefined },
): Promise<Outcome<PrototypeData>> =>
  withPrototypes(ctx, async (p) => {
    if (ctx.session !== undefined)
      return refused(
        'not-from-session',
        "a prototype is the person's (or the Abe chat's): abe prototype start is never run from a session",
      );
    const words = (args.words ?? []).join(' ').trim();
    const id = args.card === undefined ? null : parseCardId(args.card);

    if (id === undefined) return usage(`not a card id (4, AB#4): ${String(args.card)}`);
    if (id === null && words === '')
      return usage('say what to try: abe prototype start <words…> (or --card <n>)');
    const { sessions, factory } = ctx.serve;
    const worktrees = p.worktrees;

    if (sessions === undefined || factory === undefined || worktrees === undefined)
      return noSessions();
    const head = await p.apps.head(resolve(ctx.cwd, args.repo ?? '.'));

    if (!head.ok) return head;
    const repo = head.data.repo;

    // Where cards run: on a box, the session there and its app forwarded here.
    if (isCloudTarget(serveTargetIn(ctx.settings, repo, ctx.serve.onBox)))
      return startOnBox(ctx, p, head.data, id, words);
    const open = id === null ? undefined : await openOnCard(ctx, p, repo, id);

    if (open !== undefined) return { ok: true, data: prototypeData(open) };
    const card = id === null ? null : await readCard(ctx, String(id), repo);

    if (card !== null && !card.ok) return card;
    const reach = await sessionReach({ ...ctx, cwd: repo }, 'local');

    if (!reach.ok) return reach;
    const meta = await newMeta(p, head.data, id);
    const branch =
      card === null
        ? prototypeBranch(meta.id, words)
        : prototypeBranch(card.data.id, card.data.title);
    const tree = await worktrees.make(repo, branch, head.data.commit);

    if (!tree.ok) return tree;
    let session: string | undefined;
    const launched = await sessions.launch(
      card === null ? null : card.data,
      repo,
      reach.data.env,
      prototypeLaunchSettings(ctx, repo).at,
      {
        code: { of: { id: meta.id, card: id }, title: prototypeTitle({ card: id, words }) },
        branch,
        instructions: codePrototypeInstructions({
          id: meta.id,
          card: id,
          branch,
          base: head.data.branch,
          commit: head.data.commit,
          fixedPorts: (await p.fixedPorts?.(repo)) ?? [],
        }),
        prompt: codePrototypePrompt({ card: card === null ? null : card.data, words }),
        plugin: CODE_PROTOTYPE_PLUGIN,
        readOnlyFiles: tree.data.denied,
        deny: CODE_PROTOTYPE_DENY,
        permissionMode: FACTORY_PERMISSION_MODE,
        starting: (started) => {
          session = started;
          // a card's prototype sits on its lane, in Build; one with no card has no run
          if (card !== null)
            factory.start(
              newRun({
                session: started,
                card: card.data.id,
                title: card.data.title,
                repo,
                worktree: '',
                at: factory.stamp(),
                prototype: true,
              }),
            );
        },
      },
    );

    if (!launched.ok) {
      if (session !== undefined && card !== null) factory.dropped(session);
      // A worktree made for nothing goes again; one there before stays.
      if (tree.data.made) await worktrees.remove(repo, tree.data.path, { force: true, branch });

      return launched;
    }
    const kept: PrototypeMeta = {
      ...meta,
      code: {
        session: launched.data.id,
        branch,
        worktree: launched.data.worktree === '' ? tree.data.path : launched.data.worktree,
        box: null,
        spec: null,
        stored: null,
        commented: false,
        sent: null,
        made: null,
        ended: false,
      },
    };

    // Kept before anything else can fail: a session of a prototype is always one Discard names.
    await p.local.write(kept);
    if (card !== null) {
      const started = await runStarted(
        factory,
        launched.data.id,
        launched.data.worktree,
        launched.data.setup,
      );

      if (!started.ok) {
        await sessions.stop(launched.data.id);

        return started;
      }
    }
    // The app starts in the background, on the prototype's queue: `prototype list` says when it
    // is live, with its url.
    void p.serial(kept.id, () => launch(p, kept, 'start')).catch(() => undefined);

    return { ok: true, data: prototypeData(kept) };
  });

/**
 * `abe session reopen` on a prototype session with no card: the same id, worktree, branch and
 * Claude Code conversation (`claude --resume`; one whose claude never ran a hook starts a new one
 * there), jailed as it was, `message` its first prompt; its app started again when it does not run.
 */
export const reopenPrototype = (
  ctx: PrototypesCtx & Parameters<typeof sessionReach>[0],
  session: SessionData,
  message: string | undefined,
): Promise<Outcome<SessionData>> =>
  withPrototypes(ctx, async (p) => {
    const sessions = ctx.serve.sessions;
    const of = session.prototype;

    if (sessions === undefined) return noSessions();
    if (of?.card !== null)
      return refused('not-reopenable', `session ${session.id} is no prototype with no card`);
    const meta = (await p.local.all()).find((m) => m.id === of.id);
    const code = meta?.code ?? null;

    if (meta === undefined || code?.ended !== false || code.session !== session.id)
      return refused(
        'prototype-ended',
        `prototype ${of.id} is done with (discarded): abe prototype start starts another`,
      );
    const worktrees = p.worktrees;

    if (worktrees === undefined) return noSessions();
    // its worktree again (made anew from its branch when it was removed), its hook with it
    const tree = await worktrees.make(meta.repo, code.branch, meta.commit);

    if (!tree.ok) return tree;
    const reach = await sessionReach({ ...ctx, cwd: meta.repo }, 'local');

    if (!reach.ok) return reach;
    const back = await sessions.launch(
      null,
      meta.repo,
      reach.data.env,
      prototypeLaunchSettings(ctx, meta.repo).at,
      {
        id: session.id,
        reopen: true,
        code: { of, title: session.title },
        branch: code.branch,
        instructions: codePrototypeInstructions({
          id: meta.id,
          card: null,
          branch: code.branch,
          base: meta.branch,
          commit: meta.commit,
          fixedPorts: (await p.fixedPorts?.(meta.repo)) ?? [],
        }),
        ...(message === undefined ? {} : { prompt: message }),
        plugin: CODE_PROTOTYPE_PLUGIN,
        readOnlyFiles: tree.data.denied,
        deny: CODE_PROTOTYPE_DENY,
        permissionMode: FACTORY_PERMISSION_MODE,
      },
    );

    // its app again once the session is back, on the prototype's own queue
    if (back.ok)
      void p
        .serial(meta.id, async () => {
          const now0 = (await fresh(p, meta.id)) ?? meta;

          return RUNNING.includes(now0.state)
            ? { ok: true as const, data: prototypeData(now0) }
            : launch(p, now0, 'reopen');
        })
        .catch(() => undefined);

    return back;
  });

/** The prototype stopped: its app and proxy, then its session. */
const stopAll = async (
  ctx: CodePrototypeCtx,
  p: Prototypes,
  meta: PrototypeMeta,
  code: CodePrototype,
  cause: string,
) => {
  const now0 = (await fresh(p, meta.id)) ?? meta;

  // on a box: its session there (the app goes with its workspace), its forward's url said stopped
  if (code.box !== null) {
    const there = await ctx.serve.cloud?.stop(code.session);

    if (RUNNING.includes(now0.state))
      await p.local.write({ ...now0, state: 'stopped', since: now(p), url: null, app: null });

    return there === undefined || there.ok || there.error.code === 'no-session' ? undefined : there;
  }
  if (RUNNING.includes(now0.state)) await halt(p, now0, cause);
  const stopped = await ctx.serve.sessions?.stop(code.session);

  return stopped === undefined || stopped.ok || stopped.error.code === 'no-session'
    ? undefined
    : stopped;
};

/**
 * The prototype kept in the org store as the card's next version (its branch and diff), once:
 * every run of the card reads it as its reference. Null without an org store.
 */
const keepInStore = async (
  ctx: CodePrototypeCtx,
  p: Prototypes,
  meta: PrototypeMeta,
  code: CodePrototype,
  card: number,
  shown: CodeShown,
): Promise<Outcome<number | null>> => {
  if (code.stored !== null) return { ok: true, data: code.stored };
  const org = orgAt(ctx, meta.repo);

  if (org === undefined) return { ok: true, data: null };
  const repo = storeRepoName(meta);
  const index = await readOrgPrototype(org, repo, card);

  if (!index.ok) return index;
  const n = codeStoreVersion(index.data, meta.id);
  const plan = codeUploadPlan({
    prototype: meta.id,
    at: now(p),
    repo,
    remote: meta.remote,
    card,
    n,
    shown,
    screenshots: meta.screenshots,
  });
  const put = await putVersion(org, plan, (file) => p.local.readScreenshot(meta.id, file));

  if (!put.ok) return put;
  await keepCode(p, meta, { stored: n });

  return { ok: true, data: n };
};

/**
 * `prototype make-card`: a new card (New, tagged `prototype`) with the title and description
 * given and its `## Prototype` section, the prototype's diff and screenshots in the org store as
 * its reference (the section then names that version). Each step once: a retry makes no second
 * card.
 */
const makeCard = (
  ctx: CodePrototypeCtx,
  args: {
    id?: string | undefined;
    title: string;
    description?: string | undefined;
    descriptionFile?: string | undefined;
  },
): Promise<Outcome<MakeCardData>> =>
  withPrototypes(ctx, async (p) => {
    const title = args.title.trim();

    if (title === '') return usage('--title names the card');
    if (args.description !== undefined && args.descriptionFile !== undefined)
      return usage('give --description or --description-file, not both');
    const body =
      args.descriptionFile === undefined
        ? { ok: true as const, data: args.description ?? '' }
        : await readOwnBody(ctx, args.descriptionFile);

    if (!body.ok) return body;

    return queued(p, args.id, ctx, async (was): Promise<Outcome<MakeCardData>> => {
      const code = codeOf(was);

      if (!code.ok) return code;
      // on a box, its PNGs there kept as its screenshots first, as `screenshot add` keeps them here
      const shot = await boxScreenshots(ctx, p, was, code.data);

      if (!shot.ok) return shot;
      const meta = shot.data;
      const diff = await diffOf(ctx, meta, code.data);

      if (!diff.ok) return diff;
      const shown: CodeShown = {
        branch: code.data.branch,
        base: meta.branch,
        commit: meta.commit,
        diff: diff.data,
        screenshots: meta.screenshots,
      };
      const board = boardOf(ctx.settings?.at(meta.repo).values.board);

      if (!board.ok) return board;
      const on = boardAt(ctx, meta.repo);
      const line = codePrototypeLine(shown);
      const made =
        code.data.made === null
          ? await on.create(board.board, {
              title,
              description: [body.data.trim(), `## Prototype\n\n${line}`]
                .filter((x) => x !== '')
                .join('\n\n'),
              acceptanceCriteria: '',
              // its mark only with its reference in the org store: a run of it reads it there
              tags: orgAt(ctx, meta.repo) === undefined ? [] : [PROTOTYPE_TAG],
            })
          : await on.show(board.board, code.data.made);

      if (!made.ok) return made;
      const card = made.data.id;

      if (code.data.made === null) await keepCode(p, meta, { made: card });
      const stored = await keepInStore(ctx, p, meta, code.data, card, shown);

      if (!stored.ok) return stored;
      // the section names the store's version once it is there
      if (stored.data !== null) {
        const read = await on.show(board.board, card);
        const plan = codeUploadPlan({
          prototype: meta.id,
          at: now(p),
          repo: storeRepoName(meta),
          remote: meta.remote,
          card,
          n: stored.data,
          shown,
          screenshots: meta.screenshots,
        });

        if (read.ok)
          await on.write(board.board, card, {
            description: withPrototypeSection(read.data.description, plan.meta),
          });
      }

      return {
        ok: true,
        data: {
          prototype: meta.id,
          card,
          title: made.data.title,
          url: made.data.url,
          version: stored.data,
          line,
        },
      };
    });
  });

/** A `refused.jsonl` line, as `prototype show` lists it; a broken one is left out. */
const refusedLine = (line: string): PrototypeShowData['refused'][number] | undefined => {
  try {
    const r: unknown = JSON.parse(line);

    if (typeof r !== 'object' || r === null) return undefined;
    const field = (k: string) => {
      const v: unknown = Reflect.get(r, k);

      return typeof v === 'string' ? v : '';
    };

    return {
      at: field('at'),
      method: field('method'),
      host: field('host'),
      reason: field('reason'),
    };
  } catch {
    return undefined;
  }
};

/**
 * `prototype show`: its diff by file (the worktree's against where its branch was made from),
 * its screenshots, its app's last output lines and what its proxy refused (newest last).
 */
const show = (
  ctx: CodePrototypeCtx,
  idArg: string | undefined,
): Promise<Outcome<PrototypeShowData>> =>
  withPrototypes(ctx, async (p) =>
    queued(p, idArg, ctx, async (meta) => {
      const code = codeOf(meta);
      const diff = code.ok ? await diffOf(ctx, meta, code.data) : code;
      const patches = diff.ok ? patchesOfDiff(diff.data, '') : { files: [], cut: 0 };
      const [log, refusedText] = await Promise.all([
        p.local.appLog(meta.id),
        p.local.refusedLog(meta.id),
      ]);

      return {
        ok: true,
        data: {
          id: meta.id,
          files: patches.files.map((f) => ({
            path: f.path.replace(/^\//, ''),
            added: f.added,
            removed: f.removed,
            lines: f.hunks.flatMap((h) => [
              `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
              ...h.lines,
            ]),
          })),
          cut: patches.cut,
          noDiff: diff.ok ? null : diff.error.message,
          screenshots: meta.screenshots.map((x) => ({
            n: x.n,
            what: x.what,
            path: p.local.screenshotPath(meta.id, x.file),
          })),
          log: lastLines(log, LOG_LINES),
          refused: refusedText
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map(refusedLine)
            .filter((r) => r !== undefined),
        },
      };
    }),
  );

const discard = (ctx: CodePrototypeCtx, idArg: string | undefined): Promise<Outcome<DiscardData>> =>
  withPrototypes(ctx, (p) =>
    queued(p, idArg, ctx, async (meta): Promise<Outcome<DiscardData>> => {
      const code = codeOf(meta);

      if (!code.ok) return code;
      const notStopped = await stopAll(ctx, p, meta, code.data, 'discard');

      if (notStopped !== undefined) return notStopped;
      // on a box: its workspace removed there, whatever it holds
      const box = code.data.box;

      if (box !== null) {
        const dropped = await ctx.serve.cloud?.dropPrototype(box, meta.id);
        const fate: WorktreeFate =
          dropped?.ok === true
            ? { worktree: 'removed', why: null }
            : { worktree: 'kept', why: dropped?.error.message ?? 'this serve reaches no boxes' };

        await keepCode(p, meta, { ended: true });

        return {
          ok: true,
          data: {
            prototype: meta.id,
            card: meta.card,
            session: code.data.session,
            branch: code.data.branch,
            worktree: code.data.worktree,
            fate,
          },
        };
      }
      const worktrees = p.worktrees;

      if (worktrees === undefined) return noSessions();
      // its database ended while its worktree (with its hook) is still there (#349)
      await dropDatabase(p, (await fresh(p, meta.id)) ?? meta).catch(() => undefined);
      const there = await worktrees.uncommitted(code.data.worktree);
      const removed = await worktrees.remove(meta.repo, code.data.worktree, {
        force: true,
        branch: code.data.branch,
      });

      if (!removed.ok) return removed;
      const fate: WorktreeFate = {
        worktree: there.ok && there.data === null ? 'gone' : 'removed',
        why: null,
      };

      await dropRun(ctx, p, code.data, fate);
      await keepCode(p, meta, { ended: true });

      return {
        ok: true,
        data: {
          prototype: meta.id,
          card: meta.card,
          session: code.data.session,
          branch: code.data.branch,
          worktree: code.data.worktree,
          fate,
        },
      };
    }),
  );

export const codePrototypeHandlers = <C extends CodePrototypeCtx>() =>
  ({
    'prototype start': (args, ctx) => start(ctx, args),
    'prototype make-card': (args, ctx) => makeCard(ctx, args),
    'prototype discard': (args, ctx) => discard(ctx, args.id),
    'prototype show': (args, ctx) => show(ctx, args.id),
  }) satisfies Partial<Handlers<C>>;
