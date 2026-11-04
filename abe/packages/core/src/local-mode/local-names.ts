/**
 * Local mode's names and pure rules a screen reads as values too (#24): local numbers (`#L3`),
 * which checkout a folder is in, and each card's local state from its held writes. Types only
 * from `local-mode.ts`, so `ui` may import this module (`@abe/core/local-names`).
 */
import type { HeldWrite, LocalCard, LocalPr } from './local-mode';

/**
 * Local numbers (pull requests and issues made in local mode) sit above this, so no number GitHub
 * gives is ever read as one, nor one of these sent there: `#L3` is `LOCAL_FLOOR + 3`.
 */
export const LOCAL_FLOOR = 900_000_000;

export const isLocalNumber = (n: number): boolean => n > LOCAL_FLOOR;
export const localNumber = (n: number): number => LOCAL_FLOOR + n;
/** `L3`: how a local number reads. */
export const localName = (number: number): string => `L${number - LOCAL_FLOOR}`;
/** `L3`, `#L3` or `l3` → its number; anything else undefined. */
export const parseLocalName = (text: string): number | undefined => {
  const [, n] = /^#?L([1-9][0-9]{0,8})$/i.exec(text.trim()) ?? [];

  return n === undefined ? undefined : localNumber(Number(n));
};
/**
 * `LC3`: a card made in local mode (a held card, kept on this Mac), apart from a local pull
 * request's `L3`; its id is a local number too.
 */
export const localCardName = (id: number): string => `LC${id - LOCAL_FLOOR}`;
/** A card's number as a screen says it: `LC3` for a held card, else its own (`1240`). */
export const cardName = (id: number): string =>
  isLocalNumber(id) ? localCardName(id) : String(id);
/** Where a local pull request or issue "is": no web page, a name that reads as local. */
export const localUrl = (repo: string, number: number): string =>
  `local:${repo}#${localName(number)}`;

/**
 * The checkout of `localMode`'s list that `dir` is in: the checkout itself, a folder in it, or a
 * card worktree beside it (`<checkout>-wt/…`); undefined when local mode is off there.
 */
export const localCheckoutOf = (list: readonly string[], dir: string): string | undefined => {
  const trim = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const at = trim(dir);

  return list
    .map(trim)
    .filter((p) => at === p || at.startsWith(`${p}/`) || at.startsWith(`${p}-wt/`))
    .sort((a, b) => b.length - a.length)[0];
};

/** `localMode` with `checkout` put on or taken off, the others kept as written. */
export const localModeWith = (list: readonly string[], checkout: string, on: boolean): string[] => {
  const rest = list.filter((p) => p !== checkout);

  return on ? [...rest, checkout] : rest;
};

/** `tags` with a held tag change on: `remove` taken off, `add` put on (once each). */
export const withTags = (
  tags: readonly string[],
  change: { add: readonly string[]; remove: readonly string[] },
): string[] => [
  ...tags.filter((t) => !change.remove.includes(t)),
  ...change.add.filter((t) => !tags.includes(t) && !change.remove.includes(t)),
];

/** The held writes a card's local state is made of. */
const ON_CARD: readonly HeldWrite['kind'][] = [
  'card-move',
  'card-assign',
  'card-tag',
  'card-write',
  'card-comment',
];

/**
 * Each card's local state from its held writes (any order in, by card out): its last held move
 * and assignment, the tags its held tag changes put on and took off, net, the fields its held
 * edits changed and how many comments are held on it.
 */
export const localCards = (held: readonly HeldWrite[]): LocalCard[] => {
  const by = new Map<number, LocalCard>();

  for (const w of [...held].sort((a, b) => a.seq - b.seq)) {
    if (w.card === null || !ON_CARD.includes(w.kind)) continue;
    const was = by.get(w.card) ?? {
      card: w.card,
      state: null,
      assignee: null,
      added: [],
      removed: [],
      at: w.at,
    };
    const tag = w.kind === 'card-tag' ? (w.tags ?? { add: [], remove: [] }) : undefined;
    const edited = w.kind === 'card-write' ? Object.keys(w.fields ?? {}) : [];

    by.set(w.card, {
      ...was,
      at: w.at,
      ...(w.kind === 'card-move' ? { state: w.to } : {}),
      ...(w.kind === 'card-assign' ? { assignee: w.to } : {}),
      ...(w.kind === 'card-comment' ? { comments: (was.comments ?? 0) + 1 } : {}),
      ...(edited.length === 0 ? {} : { edited: [...new Set([...(was.edited ?? []), ...edited])] }),
      ...(tag === undefined
        ? {}
        : {
            added: withTags(was.added, { add: tag.add, remove: tag.remove }),
            removed: withTags(was.removed, { add: tag.remove, remove: tag.add }),
          }),
    });
  }

  return [...by.values()].sort((a, b) => a.card - b.card);
};

/** `3 files · +40 −2 · 2 commits`: what a local pull request changes, in a line. */
export const localPrStat = (p: Pick<LocalPr, 'files' | 'commits'>): string => {
  const added = p.files.reduce((n, f) => n + f.added, 0);
  const removed = p.files.reduce((n, f) => n + f.removed, 0);
  const many = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

  return `${many(p.files.length, 'file')} · +${added} −${removed} · ${many(p.commits.length, 'commit')}`;
};
