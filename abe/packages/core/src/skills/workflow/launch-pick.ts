/**
 * Which workflow a launch offers (pure, types only: the Launch box reads it too): every one in
 * force, grouped Repo's, Yours, Abe's; the one preselected by the card's type and tags (a repo's
 * or yours whose `on:` takes it over Abe's; else the nearest `on: default`, Abe's Feature) and
 * why; a warning when the one picked does not take the card (it still runs it).
 */
import { type WorkflowLayer } from './kinds';
import { type WorkflowOnView, type WorkflowsData, type WorkflowView } from './load';

/** A card as a workflow's `on:` reads it. */
export type CardKind = { type: string; tags: readonly string[] };

/** The sources a launch groups by, in the order it shows them. */
export const LAUNCH_SOURCES: readonly WorkflowLayer[] = ['repo', 'yours', 'built-in'];

/** A source's name as people say it. */
export const SOURCE_WORDS: Readonly<Record<WorkflowLayer, string>> = {
  repo: 'Repo’s',
  yours: 'Yours',
  'built-in': 'Abe’s',
};

/** `type Bug`, `tags docs, help`, `type Bug · tags cart`, `default`; '' for none. */
export const onWords = (on: WorkflowOnView | null): string => {
  if (on === null) return '';
  if (on.default) return 'default';

  return [
    ...(on.types.length === 0 ? [] : [`type ${on.types.join(', ')}`]),
    ...(on.tags.length === 0 ? [] : [`tags ${on.tags.join(', ')}`]),
  ].join(' · ');
};

const lower = (s: string) => s.trim().toLowerCase();

/** Whether a workflow's `on:` takes the card: its type (when named) and a tag (when named). */
export const takesCard = (on: WorkflowOnView, card: CardKind): boolean => {
  if (on.default || (on.types.length === 0 && on.tags.length === 0)) return false;
  const type = on.types.length === 0 || on.types.some((t) => lower(t) === lower(card.type));
  const tag =
    on.tags.length === 0 || on.tags.some((t) => card.tags.some((c) => lower(c) === lower(t)));

  return type && tag;
};

/** The workflows offered at launch: in force, Repo's then Yours then Abe's. */
export const cardWorkflows = (loaded: Pick<WorkflowsData, 'workflows'>): WorkflowView[] =>
  LAUNCH_SOURCES.flatMap((layer) => loaded.workflows.filter((w) => w.layer === layer && w.inForce));

/**
 * The workflow a card runs with no pick: yours or the repo's whose `on:` takes it, else yours or
 * the repo's `on: default`; only then Abe's (Bug → bug, Task → quick-fix), else Abe's default,
 * Feature. Undefined: none in force.
 */
export const preselected = (
  card: CardKind,
  loaded: Pick<WorkflowsData, 'workflows'>,
): WorkflowView | undefined => {
  // nearest first: yours, the repo's, Abe's (the load check's order)
  const offered = loaded.workflows.filter((w) => w.inForce && w.on !== null);
  const pick = (from: readonly WorkflowView[]) =>
    from.find((w) => w.on !== null && takesCard(w.on, card)) ??
    from.find((w) => w.on?.default === true);

  return (
    pick(offered.filter((w) => w.layer !== 'built-in')) ??
    pick(offered.filter((w) => w.layer === 'built-in'))
  );
};

/**
 * Said by the install's Board check: the workflows in force whose `on:` names only card types the
 * board's cards are none of (`types`, `board.types`), so never preselected there, and the one each
 * card falls to instead (the nearest `on: default`, Abe's Feature). Null: every one can be.
 */
export const unmetTypes = (
  loaded: Pick<WorkflowsData, 'workflows'>,
  types: readonly string[],
): { workflows: { name: string; types: readonly string[] }[]; fallback: string } | null => {
  const has = (t: string) => types.some((b) => lower(b) === lower(t));
  const unmet = cardWorkflows(loaded).flatMap((w) =>
    w.on === null || w.on.default || w.on.types.length === 0 || w.on.types.some(has)
      ? []
      : [{ name: w.name, types: w.on.types }],
  );
  const workflows = unmet.filter((w, i) => unmet.findIndex((u) => u.name === w.name) === i);

  return workflows.length === 0
    ? null
    : { workflows, fallback: preselected({ type: '', tags: [] }, loaded)?.name ?? 'Feature' };
};

/** One workflow the launch offers. */
export type LaunchOption = {
  id: string;
  name: string;
  description: string;
  layer: WorkflowLayer;
  /** Its `on:` in words (`type Bug`, `default`). */
  on: string;
  /** Its `on:` takes this card (a default one never says so). */
  takes: boolean;
};

/** What a card's launch offers: every card workflow, the one preselected and why. */
export type LaunchChoices = {
  options: LaunchOption[];
  /** The preselected one's id (`feature` when none is in force). */
  picked: string;
  /** `Preselected: Bug takes type Bug.`, `Preselected: Feature, for any card no other takes.` */
  why: string;
};

/** The launch's choices on `card`. */
export const launchChoices = (
  card: CardKind,
  loaded: Pick<WorkflowsData, 'workflows'>,
): LaunchChoices => {
  const options = cardWorkflows(loaded).map((w): LaunchOption => ({
    id: w.id,
    name: w.name,
    description: w.description,
    layer: w.layer,
    on: onWords(w.on),
    takes: w.on !== null && takesCard(w.on, card),
  }));
  const pick = preselected(card, loaded);
  const name = pick?.name ?? 'Feature';

  return {
    options,
    picked: pick?.id ?? 'feature',
    why:
      pick?.on?.default === false
        ? `Preselected: ${name} takes ${onWords(pick.on)}.`
        : `Preselected: ${name}, for any card no other workflow takes.`,
  };
};

/** A card as words: `a Bug tagged cart, pricing`, `a User Story`. */
const cardWords = (card: CardKind): string => {
  const type = card.type.trim() === '' ? 'a card' : `a ${card.type}`;

  return card.tags.length === 0 ? type : `${type} tagged ${card.tags.join(', ')}`;
};

/**
 * The warning when the workflow picked does not take the card (its `on:` names a type or tags
 * the card has not); null when it does, it is a default one, or it has no `on:`. It still runs
 * the card.
 */
export const mismatchWords = (card: CardKind, o: LaunchOption): string | null =>
  o.takes || o.on === 'default' || o.on === ''
    ? null
    : `${o.name} takes ${o.on}; this is ${cardWords(card)}. It still runs it.`;
