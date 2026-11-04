/**
 * New card (#346): a card written from nothing (`:new <title>`, the Board's New card…, an empty
 * column), not Make card's prototype finishing. `abe card draft` asks a one-shot with core's
 * make-card skill for the card part only (Why, What, criteria) from the title or the person's
 * words, from an Ask chat's conversation when it is opened there, and again from the earlier
 * draft; `abe card create` writes it. The rules here: the prompt, the answer's shape and its text.
 */
import { z } from 'zod';
import { CardDraft, MAKE_CARD_SKILL } from '../prototype/make-card';
import { askingJson, readJsonAnswer } from '../triage/one-shot';

/** The skill the one-shot drafts with: Make card's, its card part. */
export const NEW_CARD_SKILL = MAKE_CARD_SKILL;

/** `abe card draft`: the card as drafted, its title too. */
export const CardDraftData = CardDraft;
export type CardDraftData = CardDraft;

const SHAPE = `{
  "title": "<what the user gets, at most eight words>",
  "why": "<who needs it and what goes wrong without it>",
  "what": "<what changes on screen and in behaviour>",
  "criteria": ["<one observable behaviour>", "…"]
}`;

/** How much of an Ask chat's conversation the prompt carries (its end kept). */
export const CHAT_LIMIT = 12_000;

/**
 * The one-shot's prompt: the person's words (a title or a sentence), the Ask chat's conversation
 * when given, the earlier draft when asking again; then the answer's shape.
 */
export const cardDraftPrompt = (o: {
  words: string;
  chat?: string | undefined;
  earlier?: CardDraft | undefined;
}): string => {
  const chat = o.chat?.trim();
  const clipped =
    chat === undefined || chat.length <= CHAT_LIMIT
      ? chat
      : `… (${chat.length - CHAT_LIMIT} earlier characters)\n${chat.slice(-CHAT_LIMIT)}`;
  const lines = [
    'Draft a new card for the board with the card part of your make-card skill: no spec issue, and there is no prototype. A person wrote it from nothing; draft what they mean, nothing they did not say.',
    '',
    '## Their words',
    '',
    o.words.trim(),
    ...(clipped === undefined || clipped === ''
      ? []
      : ['', '## The chat it comes from', '', clipped]),
    ...(o.earlier === undefined
      ? []
      : [
          '',
          '## Your earlier draft',
          '',
          '```json',
          JSON.stringify(o.earlier, null, 2),
          '```',
          '',
          'Draft it again: keep what still fits their words, say it better where it does not.',
        ]),
  ];

  return askingJson(lines.join('\n'), SHAPE);
};

/** The one-shot's answer as the draft, or why it is not one. */
export const readCardDraft = (text: string) => readJsonAnswer(text, CardDraft);

export const cardDraftText = (d: CardDraftData): string =>
  `${d.title}\n\nWhy: ${d.why}\nWhat: ${d.what}\n\n${d.criteria.map((c) => `- ${c}`).join('\n')}\n`;

/** `--earlier`: a draft given back as JSON, or why it is not one. */
export const parseEarlier = (
  text: string,
): { ok: true; data: CardDraft } | { ok: false; message: string } => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: '--earlier is not JSON' };
  }
  const read = CardDraft.safeParse(parsed);

  return read.success
    ? { ok: true, data: read.data }
    : { ok: false, message: `--earlier is not a draft: ${z.prettifyError(read.error)}` };
};
