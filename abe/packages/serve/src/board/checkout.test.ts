/**
 * `abe card checkout` on an in-process `serve` (`served`) with its port faked: the card id read
 * (`AB#4` too), `--repo` taken from where abe runs, the port's answer and refusals passed on, and
 * a serve with no port (a box's) refusing.
 */
import { describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { type CardCheckout, CardCheckoutData } from '@abe/core';
import { served } from '@abe/testing';

type Row = {
  name: string;
  argv: string[];
  /** The port; undefined: none, as on a box. */
  port?: CardCheckout;
  /** What the port was asked: the repo relative to the state dir, and the card. */
  asked?: [string, string];
  want: { exit: number; data?: CardCheckoutData; code?: string };
};

const made: CardCheckout = (repo, card) =>
  Promise.resolve({
    ok: true,
    data: { path: `${repo}-wt/${card}-cart`, branch: `card/${card}-cart`, made: true },
  });

const rows: Row[] = [
  {
    name: 'the port’s worktree, the card id as AB#12 read as 12, --repo from where abe runs',
    argv: ['card', 'checkout', 'AB#12', '--repo', 'shop'],
    port: made,
    asked: ['shop', '12'],
    want: { exit: 0, data: { worktree: 'shop-wt/12-cart', branch: 'card/12-cart', made: true } },
  },
  {
    name: 'no branch on origin: the port’s refusal as it is',
    argv: ['card', 'checkout', '4'],
    port: () =>
      Promise.resolve({ ok: false, error: { code: 'no-branch', message: 'origin has no card/4' } }),
    asked: ['', '4'],
    want: { exit: 1, code: 'no-branch' },
  },
  {
    name: 'not a card id: usage',
    argv: ['card', 'checkout', 'cart'],
    port: made,
    want: { exit: 2, code: 'usage' },
  },
  {
    name: 'a serve with no checkout (a box’s): refused',
    argv: ['card', 'checkout', '4'],
    want: { exit: 1, code: 'no-checkout' },
  },
];

describe('abe card checkout', () => {
  test.each(rows)('$name', async ({ argv, port, asked, want }) => {
    const calls: [string, string][] = [];
    const abe = await served(
      port === undefined
        ? {}
        : {
            checkout: (repo, card) => {
              calls.push([repo, card]);

              return port(repo, card);
            },
          },
    );

    try {
      const out = await abe.json(CardCheckoutData, ...argv);
      const dir = realpathSync(abe.state.dir);
      const rel = (p: string) => relative(dir, p);

      expect(out.exit).toBe(want.exit);
      if (want.data !== undefined)
        expect(
          out.doc.ok ? { ...out.doc.data, worktree: rel(out.doc.data.worktree) } : out.doc,
        ).toEqual(want.data);
      if (want.code !== undefined) expect(out.doc.ok ? 'ok' : out.doc.error.code).toBe(want.code);
      expect(calls.map(([repo, card]) => [rel(repo), card])).toEqual(
        asked === undefined ? [] : [asked],
      );
    } finally {
      await abe.close();
    }
  });
});
