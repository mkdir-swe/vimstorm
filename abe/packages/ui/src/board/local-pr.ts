/**
 * A local pull request (`#L3`) in the Board's place: what the Factory's PR stage wrote on this Mac
 * instead of on GitHub, with Merge locally, Discard and Diff. Its card's run gives the checks.
 */
import { localPrDiff, localPrNode, localPrOfRun, mergeConfirm, discardConfirm } from './local-view';
import type { LocalPr } from '@abe/core';
import { close, type Mode, stay, type Under } from './mode';
import { island } from '../runtime/runtime';

/** The local pull request shown, and the button the keys are on. */
export type LocalPrShown = { number: number; focus: 'merge' | 'discard' };

/** Its buttons, its Diff and a file row (`local-pr:file:<n>`, 1-based), by their node ids. */
const MERGE = 'local-pr:merge';
const DISCARD = 'local-pr:discard';
const DIFF = 'local-pr:diff';
const FILE = 'local-pr:file:';

const BUTTON_KEYS = new Set(['k', 'ä', '<Left>', '<Right>', '<Tab>', '<S-Tab>']);

/** The pull request shown, as `local status` last said it; none once this checkout lost it. */
const prOf = (at: LocalPrShown, u: Under): LocalPr | undefined =>
  u.local?.prs.find((x) => x.number === at.number);

export const localPrMode: Mode<LocalPrShown> = {
  // Esc back to the Board, ← → Tab between its buttons, ⏎ the focused one, asked first
  key: (at, key, u) => {
    const p = prOf(at, u);

    if (key === '<Esc>') return close();
    // its diff, open, merged or discarded alike
    if (key === '<D-d>') return stay(at, p === undefined ? [] : localPrDiff(p));
    if (p?.state !== 'open') return stay(at);
    if (BUTTON_KEYS.has(key))
      return stay({ ...at, focus: at.focus === 'merge' ? 'discard' : 'merge' });
    if (key === '<CR>')
      return stay(at, [at.focus === 'merge' ? mergeConfirm(p) : discardConfirm(p)]);

    return stay(at);
  },
  click: (at, id, u) => {
    const p = prOf(at, u);

    if (id === DIFF) return stay(at, p === undefined ? [] : localPrDiff(p));
    if (id.startsWith(FILE))
      return stay(at, p === undefined ? [] : localPrDiff(p, Number(id.slice(FILE.length))));
    if (id !== MERGE && id !== DISCARD) return undefined;
    if (p?.state !== 'open') return stay(at);

    return stay(at, [id === MERGE ? mergeConfirm(p) : discardConfirm(p)]);
  },
  choice: (at) => stay(at),
  answer: (at) => stay(at),
  event: () => undefined,
  browser: () => undefined,
  view: (at, u) => {
    const p = prOf(at, u);

    if (p === undefined) return undefined;
    const run = u.runs().find((r) => localPrOfRun(r) === at.number);

    return island([localPrNode(p, { run, focus: at.focus, away: u.away })], 'local-pr-view');
  },
};
