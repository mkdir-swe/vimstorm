/**
 * A card draft's long fields as written (#346): Why and What as the description, the criteria
 * as checkboxes. Pure, with only a type import, so ui takes it as `@abe/core/draft-fields`.
 */
import type { CardDraft } from '../prototype/make-card';

/** The card's description as written: Why, then What. */
export const cardDraftDescription = (d: CardDraft): string =>
  `## Why\n\n${d.why.trim()}\n\n## What\n\n${d.what.trim()}`;

/** The card's acceptance criteria as written: one checkbox each. */
export const criteriaMarkdown = (d: CardDraft): string =>
  d.criteria.map((c) => `- [ ] ${c.trim()}`).join('\n');

/** The draft's long fields as `abe card create` writes them: Why and What, criteria as checkboxes. */
export const draftFields = (d: CardDraft): { description: string; acceptanceCriteria: string } => ({
  description: cardDraftDescription(d),
  acceptanceCriteria: criteriaMarkdown(d),
});
