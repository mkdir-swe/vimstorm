/**
 * Create Draft PR's rules (G20): the description it starts with, the bases to pick from and who can
 * be asked to review.
 */
import { cardLinkLine } from '../factory/factory-pr';

/**
 * The draft's description: the card's link line when the branch names a card (`AB-1234`), then
 * the commits under `## What`.
 */
export const draftBody = (branch: string, subjects: readonly string[]): string => {
  const words = branch.split(/[^A-Za-z0-9]/);
  const at = words.findIndex(
    (w, i) => w.toLowerCase() === 'ab' && /^\d+$/.test(words[i + 1] ?? ''),
  );
  const card = at < 0 ? undefined : Number(words[at + 1]);
  const out = [
    ...(card === undefined ? [] : [cardLinkLine(card), '']),
    ...(subjects.length === 0 ? [] : ['## What', ...subjects.map((s) => `- ${s}`)]),
  ];

  return out.join('\n').trimEnd();
};

/** origin's branches (`git for-each-ref` lines) to pick a base from: never HEAD, the default or the branch itself. */
export const otherBases = (listed: string, base: string, branch: string): string[] =>
  listed
    .split('\n')
    .flatMap((l) => (l.startsWith('origin/') ? [l.slice('origin/'.length)] : []))
    .filter((b) => b !== 'HEAD' && b !== base && b !== branch)
    .sort();

/** The repo's assignable people but you, by name (else login). */
export const reviewersOf = <P extends { login: string; name: string }>(
  people: readonly P[],
  me: string | null,
): P[] =>
  people
    .filter((p) => p.login.toLowerCase() !== me?.toLowerCase())
    .sort((a, b) =>
      (a.name || a.login).toLowerCase().localeCompare((b.name || b.login).toLowerCase()),
    );
