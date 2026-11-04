/**
 * What Abe itself says to the Abe chat (`hub.ts`), apart so the transcript's reader tells them
 * from the person's messages without the session types `hub.ts` reads.
 */

/** The skill the Abe chat starts on (`core/skills/abe/SKILL.md`): the hub's guide. */
export const HUB_SKILL = 'abe';

/** A new conversation's first message: the hub's skill, which greets in a line or two. */
export const HUB_HELLO = `/abe:${HUB_SKILL}`;

/** The first message of the Abe chat reopened (`abe chat` on an ended one), its conversation resumed. */
export const HUB_REOPENED_PROMPT =
  'I opened the Abe chat again. Go on from where we were; say in one line only what changed since (abe factory status).';
