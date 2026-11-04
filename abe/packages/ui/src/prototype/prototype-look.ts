/**
 * The rail's prototype tiles (Design B · Tiles): every prototype not done with, as the
 * `workspaces` effect's `prototypes` names them. Pure; the Factory overview (`factory.ts`) reads
 * `prototype list` and sends it with the header's feed.
 */
import type { PrototypeData, SessionData } from '@abe/core';
import { waitsOnYou } from '@abe/core/waits-on';
import { type PrototypeLook } from '../runtime/protocol';

/** `proto/p7-cart-badge` → `cart badge`; `proto/12-cart-total` → `cart total`. */
export const branchWords = (branch: string): string =>
  branch
    .replace(/^proto\//, '')
    .replace(/^[a-z]?[0-9a-f]+-/, '')
    .replace(/-/g, ' ');

/** A prototype's state as its tile's bar says it. */
export const lookState = (p: Pick<PrototypeData, 'state'>): PrototypeLook['state'] =>
  p.state === 'live' ? 'running' : p.state;

/** What it tries: its words, else its card's title, else its branch's words. */
export const prototypeName = (
  p: Pick<PrototypeData, 'title' | 'card' | 'branch' | 'code'>,
  titles: Readonly<Record<number, string>>,
): string =>
  p.title ??
  (p.card === null ? undefined : titles[p.card]) ??
  (p.card === null ? branchWords(p.code?.branch ?? p.branch) : `#${p.card}`);

/**
 * Where it runs, as its tile says it: `Local · on :4000` while its app answers on that port (its
 * preview link's: the app's own on a repo's fixed ports, ADR 0039), `Local` while it does not,
 * `☁ <box>` on a box.
 */
export const prototypeWhere = (
  p: Pick<PrototypeData, 'state' | 'url'> & { code: { box: string | null } },
): string => {
  if (p.code.box !== null) return `☁ ${p.code.box}`;
  const port = p.state === 'live' ? /^[a-z]+:\/\/[^/?#]*:(\d+)/i.exec(p.url ?? '')?.[1] : undefined;

  return port === undefined ? 'Local' : `Local · on :${port}`;
};

/** The tiles, in `prototype list`'s order: the ones discarded (or from before 3.3) have none. */
export const prototypeLooks = (
  prototypes: readonly PrototypeData[] | undefined,
  sessions: readonly SessionData[] | undefined,
  titles: Readonly<Record<number, string>>,
): PrototypeLook[] =>
  (prototypes ?? []).flatMap((p) => {
    if (p.code === null || p.code.ended) return [];
    const session = (sessions ?? []).find((x) => x.id === p.code?.session);

    return [
      {
        id: p.id,
        title: prototypeName(p, titles),
        card: p.card,
        state: lookState(p),
        session: p.code.session,
        branch: p.code.branch,
        where: prototypeWhere({ ...p, code: p.code }),
        since: p.since,
        url: p.url,
        needsYou: session !== undefined && waitsOnYou(session),
      },
    ];
  });
