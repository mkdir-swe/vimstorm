/**
 * New card (#346): `abe card create` writes a card from nothing on the board in force (a person
 * any; from inside a session only a ticket, a child of its own card), `abe card draft` asks the one-shot for its Why, What and
 * criteria (make-card's card part) from the person's words, an Ask chat's conversation and the
 * earlier draft. Nothing is written by a draft.
 */
import {
  cardDraftPrompt,
  type CardDraftData,
  NEW_CARD_SKILL,
  type Outcome,
  parseCardId,
  parseEarlier,
  readCardDraft,
  refused,
  type TranscriptEntry,
  type Handlers,
} from '@abe/core';
import { type BoardCtx, withBoard } from './board';
import { askOneShot, type OneShotCtx } from '../layer/one-shot';
import { ownSession, readOwnBody } from '../session/own';
import { type Transcripts } from '../session/transcript';

export type NewCardCtx = BoardCtx &
  OneShotCtx & {
    serve: {
      transcripts?: Transcripts | undefined;
    };
  };

const usage = (message: string) => refused('usage', message, 2);

/** A long field from its text, else its file, else empty; both given is a usage error. */
const longField = async (
  ctx: NewCardCtx,
  name: string,
  text: string | undefined,
  file: string | undefined,
): Promise<Outcome<string>> => {
  if (text !== undefined && file !== undefined)
    return usage(`give --${name} or --${name}-file, not both`);
  if (text !== undefined) return { ok: true, data: text.trim() };
  if (file === undefined) return { ok: true, data: '' };
  const body = await readOwnBody(ctx, file);

  return body.ok ? { ok: true, data: body.data.trim() } : body;
};

/** The Ask chat's conversation as plain lines: your messages and the agent's words. */
const chatText = (entries: readonly TranscriptEntry[]): string =>
  entries
    .flatMap((e) => {
      if (e.agent !== null) return [];
      if (e.kind === 'user') return [`You: ${e.text.trim()}`];

      return e.kind === 'assistant-text' ? [`Agent: ${e.text.trim()}`] : [];
    })
    .join('\n\n');

export const newCardHandlers = <Ctx extends NewCardCtx>() =>
  ({
    'card create': async (args, ctx) => {
      const title = args.title.trim();

      if (title === '') return usage('give the card a title: --title <words>');
      const parent = args.parent === undefined ? undefined : parseCardId(args.parent);

      if (args.parent !== undefined && parent === undefined)
        return usage(`not a card id (4, AB#4): ${args.parent}`);
      // A session makes only tickets of its own card; a person any card.
      const own = ownSession(ctx);

      if (!own.ok) return own;
      if (own.data !== undefined && parent !== own.data.card)
        return refused(
          'not-your-session',
          `a session makes only tickets of its own card: --parent AB#${own.data.card}`,
        );
      const description = await longField(
        ctx,
        'description',
        args.description,
        args.descriptionFile,
      );

      if (!description.ok) return description;
      const criteria = await longField(ctx, 'criteria', args.criteria, args.criteriaFile);

      if (!criteria.ok) return criteria;

      return withBoard(ctx, (board) =>
        ctx.ports.board.create(board, {
          title,
          description: description.data,
          acceptanceCriteria: criteria.data,
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.assign === undefined ? {} : { assignee: args.assign === 'me' ? 'me' : 'none' }),
          ...(args.sprint === undefined
            ? {}
            : { sprint: args.sprint === 'none' ? 'none' : 'current' }),
          ...(parent === undefined ? {} : { parent }),
        }),
      );
    },
    'card draft': async (args, ctx): Promise<Outcome<CardDraftData>> => {
      const words = args.words.join(' ').trim();

      if (words === '') return usage('say what the card is about: abe card draft <words…>');
      const earlier = args.earlier === undefined ? undefined : parseEarlier(args.earlier);

      if (earlier?.ok === false) return usage(earlier.message);
      let chat: string | undefined;

      if (args.session !== undefined) {
        const read = await (ctx.serve.transcripts?.read(args.session, 0) ??
          Promise.resolve(refused('no-transcripts', 'this abe serve reads no transcripts')));

        if (!read.ok) return read;
        chat = chatText(read.data.entries);
      }
      const answer = await askOneShot(ctx, {
        role: 'writer',
        cwd: ctx.cwd,
        prompt: cardDraftPrompt({ words, chat, earlier: earlier?.data }),
        system: NEW_CARD_SKILL,
        reach: {},
      });

      if (!answer.ok) return answer;
      const read = readCardDraft(answer.data.text);

      return read.ok
        ? { ok: true, data: read.data }
        : refused(
            'unreadable-answer',
            `the one-shot's draft does not read (${read.message}); ask again`,
          );
    },
  }) satisfies Partial<Handlers<Ctx>>;
