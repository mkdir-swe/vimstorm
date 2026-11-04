/**
 * The Board's handlers: `abe card`, on the `Board` port, on the board the merged `board` setting
 * names where the command was typed (the repo's). From a session: the board of its
 * own checkout, and it comments on, tags and moves its own card only; only a person assigns (to
 * themselves, a teammate of the board's team, or no one).
 */
import {
  agentComment,
  assignTarget,
  type CardListData,
  type Board,
  type BoardRef,
  boardOf,
  doneCardsOf,
  type Handlers,
  membersInOrder,
  type OrgStore,
  type Outcome,
  parseCardId,
  refused,
} from '@abe/core';
import { type LocalMode } from '../local-mode/local-mode';
import { notYours, type OwnCtx, ownSession, readOwnBody } from '../session/own';
import { type SettingsCtx } from '../layer/settings';

/** `org`: where `card show` finds the card's attached Sheets (none without one). */
export type BoardCtx = SettingsCtx &
  OwnCtx & {
    ports: { board: Board };
    serve: {
      org: OrgStore | undefined;
      /** Local mode (#24): where the request's checkout is in it, Sheets are kept on this Mac. */
      localMode?: LocalMode | undefined;
    };
  };

const usage = (message: string) => Promise.resolve(refused('usage', message, 2));

/** Why `card assign` is refused on a read-only board: held, it would change nothing read. */
export const BOARD_READ_ONLY_ASSIGN =
  'the board is read-only here (abe board read-only on): an assignment would only be held on this machine, so the board, abe card show and a launch would still see the card unassigned. Assign it on the board itself, or turn read-only off first (abe board read-only off)';

/** The board in force where the command was typed (a session's own checkout), or why there is none. */
export const withBoard = <T>(ctx: BoardCtx, then: (board: BoardRef) => Promise<Outcome<T>>) => {
  const own = ownSession(ctx);

  if (!own.ok) return Promise.resolve(own);
  if (ctx.settings === undefined)
    return Promise.resolve(refused('no-board', 'no settings to read the board from'));
  const board = boardOf(ctx.settings.at(own.data?.checkout ?? ctx.cwd).values.board);

  return board.ok ? then(board.board) : Promise.resolve<Outcome<T>>(board);
};

/** The card `text` names on the board in force, or why there is none. */
export const withCard = <T>(
  ctx: BoardCtx,
  text: string,
  then: (board: BoardRef, id: number) => Promise<Outcome<T>>,
) => {
  const id = parseCardId(text);

  return id === undefined
    ? usage(`not a card id (4, AB#4): ${text}`)
    : withBoard(ctx, (board) => then(board, id));
};

/** A card the caller may change: a session its own, a person any. */
export const withOwnCard = <T>(
  ctx: BoardCtx,
  text: string,
  then: (board: BoardRef, id: number) => Promise<Outcome<T>>,
) =>
  withCard(ctx, text, (board, id) => {
    const own = ownSession(ctx);

    if (!own.ok) return Promise.resolve(own);

    return own.data === undefined || own.data.card === id
      ? then(board, id)
      : Promise.resolve(notYours(own.data, `AB#${id}`));
  });

/** The comment's markdown, from `--text` or else the body file, or why it is none. */
const readComment = async (
  ctx: BoardCtx,
  from: { text?: string | undefined; bodyFile?: string | undefined },
): Promise<Outcome<string>> => {
  if (from.text !== undefined)
    return from.text.trim() === ''
      ? refused('empty-body', 'the --text is empty')
      : { ok: true, data: from.text.trim() };
  const file = from.bodyFile ?? '';
  const body = await readOwnBody(ctx, file);

  if (!body.ok) return body;

  return body.data.trim() === ''
    ? refused('empty-body', `the body file ${file} is empty`)
    : { ok: true, data: body.data.trimEnd() };
};

export const boardHandlers = {
  'card list': (args, ctx) =>
    withBoard<CardListData>(ctx, async (board) => {
      // The sprint names the list, and with --closed picks its done cards (#239): a board without
      // one, or a failed read, lists the cards anyway, the done ones of the last days. Without
      // --closed it is read after the cards, so a refused board answers its error once.
      const sprintOf = async () => {
        const read = await ctx.ports.board.currentSprint(board);

        return read.ok ? read.data : null;
      };
      const before = args.closed ? await sprintOf() : undefined;
      const done = before === undefined ? undefined : doneCardsOf(before);
      const cards = await ctx.ports.board.list(board, {
        mine: args.mine,
        ...(done === undefined ? {} : { done }),
      });

      if (!cards.ok) return cards;
      const sprint = before === undefined ? await sprintOf() : before;

      return {
        ok: true,
        data: {
          board: {
            ...(board.provider === undefined ? {} : { provider: board.provider }),
            organization: board.organization,
            project: board.project,
            team: board.team,
            types: [...board.types],
          },
          mine: args.mine,
          ...(args.closed ? { closed: true } : {}),
          cards: cards.data,
          sprint: sprint?.name ?? null,
        },
      };
    }),
  // each image on its own: one the board does not hold, or a failed read, says why beside the rest
  'card images': (args, ctx) =>
    withBoard(ctx, async (board) => ({
      ok: true,
      data: {
        images: await Promise.all(
          [...new Set(args.url)].map(async (url) => {
            const read = await ctx.ports.board.image(board, url);

            return read.ok ? { url, path: read.data } : { url, error: read.error.message };
          }),
        ),
      },
    })),
  'card comment': (args, ctx) =>
    (args.text === undefined) === (args.bodyFile === undefined)
      ? usage(
          args.text === undefined
            ? 'give the comment: --text <markdown> or --body-file <file>'
            : 'give --text or --body-file, not both',
        )
      : withOwnCard(ctx, args.id, async (board, id) => {
          const body = await readComment(ctx, args);

          if (!body.ok) return body;
          const own = ownSession(ctx);
          // an agent's comment says it is AI's (#187); a person's goes as typed
          const text =
            own.ok && own.data !== undefined ? agentComment(own.data.id, body.data) : body.data;

          return ctx.ports.board.comment(board, id, text);
        }),
  'card tag': (args, ctx) =>
    args.add.length === 0 && args.remove.length === 0
      ? usage('give --add <tag> or --remove <tag> (again for more)')
      : withOwnCard(ctx, args.id, (board, id) =>
          ctx.ports.board.tag(board, id, { add: args.add, remove: args.remove }),
        ),
  'card move': (args, ctx) =>
    withOwnCard(ctx, args.id, (board, id) => ctx.ports.board.move(board, id, args.state.join(' '))),
  // `me` and `none` as they are; a teammate found among the team's members first (B2, #213)
  'card assign': (args, ctx) =>
    withCard(ctx, args.id, async (board, id) => {
      const who = args.who.trim().toLowerCase();
      const dir = ownSession(ctx);
      const at = dir.ok ? (dir.data?.checkout ?? ctx.cwd) : ctx.cwd;

      // read-only alone: a held assignment would change nothing anyone reads, launches included
      if (
        ctx.serve.localMode?.boardHeldAt(at) !== undefined &&
        ctx.serve.localMode.at(at) === undefined
      )
        return refused('board-read-only', BOARD_READ_ONLY_ASSIGN);

      if (who === 'me' || who === 'none') return ctx.ports.board.assign(board, id, { kind: who });
      // an email as it is: Azure DevOps says whether it knows them (no team read to fail on)
      if (who.includes('@'))
        return ctx.ports.board.assign(board, id, { kind: 'member', login: args.who.trim() });
      const members = await ctx.ports.board.members(board);

      if (!members.ok) return members;
      const target = assignTarget(args.who, members.data);

      return target.ok
        ? ctx.ports.board.assign(board, id, target.to)
        : refused('not-a-member', target.message);
    }),
  'card members': (_args, ctx) =>
    withBoard(ctx, async (board) => {
      const members = await ctx.ports.board.members(board);

      return members.ok ? { ok: true, data: { members: membersInOrder(members.data) } } : members;
    }),
} satisfies Partial<Handlers<BoardCtx>>;
