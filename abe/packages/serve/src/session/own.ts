/**
 * What a command from inside a session may act on (ADR 0020): its own card, its run's repo and the
 * pull request of its branch, with the settings of its own checkout and files from its own
 * worktree. On `serve`'s own socket (`ctx.session` undefined) a person's command acts wherever it
 * names, from where it was typed.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  type ByCard,
  githubRepoOf,
  type Outcome,
  parseRepo,
  refused,
  type Repo,
  type RunTree,
  type SessionMeta,
} from '@abe/core';
import { originUrl } from '@abe/ports';
import { readBodyFile } from '../contract/body';

export type OwnCtx = {
  /** The session whose socket the request came in on; undefined on `serve`'s own socket. */
  session?: string | undefined;
  /**
   * From a box's workspace container (#67): the session's worktree and the files it names are
   * the container's, never on the box's disk, and its checkout is named by its GitHub repo.
   */
  inside?: boolean;
  serve: {
    sessions?: { metaOf: (id: string) => SessionMeta | undefined } | undefined;
    /** Where a card's worktree is read (the Factory's): inside its workspace container on a box. */
    factory?: { tree: ByCard<RunTree> } | undefined;
  };
};

/**
 * The session a request came from, as `serve` keeps it: a card's, on its card, worktree and
 * branch. The Abe chat's requests are the person's (`ctx.session` undefined).
 */
export type Own = {
  id: string;
  /** Its card. */
  card: number | null;
  /** The main checkout it was launched on: its settings are the ones in force. */
  checkout: string;
  worktree: string;
  branch: string;
};

/** The requesting session (data undefined for a person), or why it is not known. */
export const ownSession = (ctx: OwnCtx): Outcome<Own | undefined> => {
  if (ctx.session === undefined) return { ok: true, data: undefined };
  const meta = ctx.serve.sessions?.metaOf(ctx.session);

  if (meta === undefined) return refused('no-session', `no session ${ctx.session}`);
  const base = { id: meta.id, checkout: meta.repo, worktree: meta.worktree };

  if (meta.card === null)
    return refused(
      'not-your-session',
      `session ${meta.id} is ${meta.kind === 'prototype' ? 'a prototype' : 'on no card'}`,
    );

  return { ok: true, data: { ...base, card: meta.card, branch: meta.branch } };
};

export const notYours = (own: Own, what: string): Outcome<never> =>
  refused('not-your-session', `session ${own.id} may act only on its own run, not on ${what}`);

/**
 * The GitHub repo the session's worktree pushes to: its `origin`, or from a box's container
 * (`inside`) the repo its session was launched on (its worktree is not on the box's disk).
 */
export const ownRepo = async (ctx: OwnCtx, own: Own): Promise<Outcome<Repo>> => {
  const repo = ctx.inside === true ? parseRepo(own.checkout) : await originRepo(own.worktree);

  return repo === undefined
    ? refused('not-your-session', `session ${own.id}'s worktree has no GitHub origin`)
    : { ok: true, data: repo };
};

const originRepo = async (worktree: string): Promise<Repo | undefined> => {
  const url = await originUrl(worktree);

  return url === undefined ? undefined : githubRepoOf(url);
};

/** GitHub names a repo without regard to case. */
export const sameRepo = (a: Repo, b: Repo): boolean => a.toLowerCase() === b.toLowerCase();

const inside = (root: string, path: string) => {
  const rel = relative(root, path);

  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};

const real = (path: string) => realpath(path).catch(() => undefined);

/**
 * The file a caller names on argv (`--body-file`, `--report`, `--file`), relative to where the
 * command was typed. From a session it must be in its worktree or its checkout (its writers'
 * worktrees are there) after any link, and comes back as its real path: `serve` reads as the
 * person, so a session never makes it read a file of theirs, nor serve's state.
 */
export const ownPath = async (
  ctx: OwnCtx & { cwd: string },
  file: string,
): Promise<Outcome<string>> => {
  const named = resolve(ctx.cwd, file);
  const meta = ctx.session === undefined ? undefined : ctx.serve.sessions?.metaOf(ctx.session);

  // A prototype with no card names files in its worktree (its screenshots, a card's description).
  if (meta?.kind === 'prototype' && meta.card === null)
    return withinRoots(named, [meta.worktree], () =>
      refused(
        'not-your-session',
        `session ${meta.id} may name only files in its worktree, not ${named}`,
      ),
    );
  const own = ownSession(ctx);

  if (!own.ok) return own;
  if (own.data === undefined) return { ok: true, data: named };
  const session = own.data;

  return withinRoots(named, [session.worktree, session.checkout], () =>
    notYours(session, `the file ${named}, outside its worktree`),
  );
};

/** `named`'s real path when it is inside one of `roots` (after any link), else `refusal`. */
const withinRoots = async (
  named: string,
  roots: readonly string[],
  refusal: () => Outcome<never>,
): Promise<Outcome<string>> => {
  const path = await real(named);

  if (path === undefined) return refused('unreadable-file', `cannot read ${named}: not there`);
  const realRoots = await Promise.all(roots.map(real));

  return realRoots.some((root) => root !== undefined && inside(root, path))
    ? { ok: true, data: path }
    : refusal();
};

/** `--body-file`'s text, by `ownPath`'s rule. */
export const readOwnBody = async (
  ctx: OwnCtx & { cwd: string },
  file: string,
): Promise<Outcome<string>> => {
  if (ctx.inside === true) return containerBody(ctx, file);
  const path = await ownPath(ctx, file);

  return path.ok ? readBodyFile(ctx.cwd, path.data) : path;
};

/** `--body-file` named from a box's container: read there, inside the session's own worktree. */
const containerBody = async (ctx: OwnCtx, file: string): Promise<Outcome<string>> => {
  const own = ownSession(ctx);

  if (!own.ok) return own;
  if (own.data === undefined || own.data.card === null || ctx.serve.factory === undefined)
    return refused('unreadable-body-file', `cannot read ${file}: no worktree to read it in`);
  const read = await ctx.serve.factory.tree(own.data.card).report(own.data.worktree, file);

  return read.ok
    ? read
    : refused('unreadable-body-file', `cannot read the body file ${file} in ${own.data.worktree}`);
};
