/**
 * A launch's setup from the person's flags (#342, #347): the Grill choice, their Launch note
 * (`--note`, or `--note-file` read where the command was typed) from their board name (what
 * Assign › Me knows), else their git user, and the
 * standing notes in force in the checkout, each with its Layer.
 */
import {
  type Board,
  boardOf,
  type LaunchSetup,
  noteText,
  type Outcome,
  refused,
  standingNotes,
} from '@abe/core';
import { gitUserName } from '@abe/ports';
import { type OwnCtx, readOwnBody } from './own';
import { type SettingsService } from '../layer/settings';

/** Who a note is from when git names no user: the login, else plain words. */
const UNNAMED = 'the developer';

/** How long a launch waits on the board for your name before it takes git's user. */
const BOARD_NAME_MS = 3000;

/** Your name on each board as it answered once, by board port and organization. */
const named = new WeakMap<Pick<Board, 'me'>, Map<string, string>>();

/**
 * Your name on the board (Assign › Me's), asked once per organization and at most
 * `BOARD_NAME_MS`; else git's user, else the login.
 */
export const whoOf = async (
  board: Pick<Board, 'me'> | undefined,
  setting: unknown,
  repo: string,
): Promise<string> => {
  const ref = boardOf(setting);
  const known = board === undefined ? undefined : (named.get(board) ?? new Map<string, string>());

  if (board !== undefined && known !== undefined && ref.ok) {
    named.set(board, known);
    const kept = known.get(ref.board.organization);

    if (kept !== undefined) return kept;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const me = await Promise.race([
      board.me(ref.board),
      new Promise<undefined>((done) => {
        timer = setTimeout(() => {
          done(undefined);
        }, BOARD_NAME_MS);
      }),
    ]);

    clearTimeout(timer);
    if (me?.ok === true && me.data.name.trim() !== '') {
      known.set(ref.board.organization, me.data.name);

      return me.data.name;
    }
  }

  return (await gitUserName(repo)) ?? process.env.USER ?? UNNAMED;
};

export const launchSetupOf = async (
  ctx: OwnCtx & {
    cwd: string;
    settings: SettingsService | undefined;
    ports?: { board?: Pick<Board, 'me'> | undefined };
    serve: {
      clock: { now: () => number };
    };
  },
  repo: string,
  a: { note?: string | undefined; noteFile?: string | undefined },
): Promise<Outcome<LaunchSetup>> => {
  if (a.note !== undefined && a.noteFile !== undefined)
    return refused('usage', 'give --note or --note-file, not both', 2);
  const file = a.noteFile === undefined ? undefined : await readOwnBody(ctx, a.noteFile);

  if (file !== undefined && !file.ok) return file;
  const text = noteText({ note: a.note, file: file?.data });

  if (!text.ok) return text;
  const merged = ctx.settings?.at(repo);
  const by =
    text.data === null ? UNNAMED : await whoOf(ctx.ports?.board, merged?.values.board, repo);

  return {
    ok: true,
    data: {
      note:
        text.data === null
          ? null
          : { by, text: text.data, at: new Date(ctx.serve.clock.now()).toISOString() },
      standing: merged === undefined ? [] : standingNotes(merged),
    },
  };
};
