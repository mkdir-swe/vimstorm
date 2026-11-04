/**
 * A card's prototype mark and the states a card is over in: pure (only type imports), so the
 * screens read it too (`@abe/core/prototype-tag`).
 */
import { type CardComment, type CardData } from './board';

/** The tag a prototype's card carries (`abe prototype make-card`): the Board's prototype mark. */
export const PROTOTYPE_TAG = 'prototype';

/** States a card is done in, across Azure's processes (Agile's Closed, Scrum's Done). */
export const DONE_STATES = ['Closed', 'Done'] as const;

/** States a card is over in: done, or Removed. */
export const OVER_STATES = ['Removed', ...DONE_STATES] as const;

/** Whether the card has a prototype linked (its `prototype` tag): the Board's mark. */
export const hasPrototype = (card: Pick<CardData, 'tags'>): boolean =>
  card.tags.some((t) => t.toLowerCase() === PROTOTYPE_TAG);

/** A prototype link line (`prototypeLinkLine`), maybe after a bullet or other words. */
const LINK_LINE = /Prototype v[1-9][0-9]* · .* · prototype:\/\/\S+\s*$/;

/**
 * What the Launch box says goes along as reference, from the card's newest prototype link line
 * (its description's `## Prototype`, or a comment): the line without its commit, address and
 * mocks, and the screenshots after it (`Prototype v3 · code on proto/4-vat, 2 screenshots`). No
 * link line read: undefined.
 */
export const referenceWords = (
  card: Pick<CardData, 'description'> & { comments: readonly Pick<CardComment, 'text'>[] },
): string | undefined => {
  const found = [card.description, ...card.comments.map((c) => c.text)]
    .flatMap((text) =>
      text.split('\n').flatMap((l) => {
        const line = LINK_LINE.exec(l)?.[0];

        return line === undefined ? [] : [{ text, line }];
      }),
    )
    .at(-1);

  if (found === undefined) return undefined;
  const parts = found.line.trim().split(' · ');
  const end = parts.findIndex((p) => p.startsWith('at ') || p.startsWith('prototype://'));
  const [version = 'Prototype', ...said] = parts
    .slice(0, end)
    .filter((p) => !p.startsWith('mock '));
  // its screenshots follow it in the same text, never images above it
  const n = (found.text.slice(found.text.indexOf(found.line)).match(/!\[/g) ?? []).length;
  const what = [...said, ...(n === 0 ? [] : [`${n} screenshot${n === 1 ? '' : 's'}`])].join(', ');

  return what === '' ? version : `${version} · ${what}`;
};
