/**
 * The Settings dialog's tree (#345 split of `settings.ts`): the nodes shown (folded, searched), the
 * cursor's page, Problems' count.
 */
import { type PageId, type SearchHits, type SettingsDialogRules, type TreeNode } from '@abe/core';
import { problemsOnly } from './settings-words';
import { hitsOf, searching } from './settings-rows';
import { FIRST_PAGE, type SettingsState } from './settings-state';

/** The tree's cursor on `node`, its page shown (in place of `/`'s results while searching). */
export const pick = (s: SettingsState, node: string): SettingsState => ({
  ...s,
  node,
  row: 0,
  moved: true,
  picked: s.search !== null,
});

type Visible = { node: TreeNode; depth: number };

/** Every row of Problems: the problems, then the info rows (#168: your Overrides). */
export const problemRows = (s: SettingsState) => s.problems?.problems ?? [];

/** The problems alone (info rows left out): what counts, and lands the dialog on Problems. */
export const problemCount = (s: SettingsState) => problemsOnly(problemRows(s)).length;

/** The tree's rows as drawn: folded groups' children left out, Problems only while there are any. */
export const visible = (r: SettingsDialogRules, s: SettingsState): Visible[] => {
  const walk = (nodes: readonly TreeNode[], depth: number): Visible[] =>
    nodes.flatMap((node) => {
      if (node.whileProblems === true && problemRows(s).length === 0) return [];
      const kids = s.folded.includes(node.id) ? [] : walk(node.children, depth + 1);

      return [{ node, depth }, ...kids];
    });

  return walk(r.tree, 0);
};

/**
 * The tree's rows ↑ ↓ visit: while searching only those with hits (a page with hits, a group over
 * one), the greyed ones passed over (#152).
 */
export const walkable = (r: SettingsDialogRules, s: SettingsState): Visible[] => {
  const q = searching(s);
  const all = visible(r, s);

  if (q === undefined) return all;
  const counts = hitsOf(r, s, q).counts;
  const lit = all.filter((v) => hasHits(v.node, counts));

  return lit.length === 0 ? all : lit;
};

/** A tree node with hits: its page's, or any page under it. */
export const hasHits = (node: TreeNode, counts: SearchHits['counts']): boolean =>
  (node.page !== null && counts[node.page] !== undefined) ||
  node.children.some((c) => hasHits(c, counts));

export const findNode = (nodes: readonly TreeNode[], id: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = findNode(n.children, id);

    if (inner !== undefined) return inner;
  }

  return undefined;
};

export const parentOf = (nodes: readonly TreeNode[], id: string): TreeNode | undefined => {
  for (const n of nodes) {
    if (n.children.some((c) => c.id === id)) return n;
    const inner = parentOf(n.children, id);

    if (inner !== undefined) return inner;
  }

  return undefined;
};

/**
 * The page shown: the cursor's node's, or a group's first child's; while searching the first page
 * with hits at or under the node (a group lit by a later child opens that child).
 */
export const pageShown = (r: SettingsDialogRules, s: SettingsState): PageId => {
  const q = searching(s);
  const node = q === undefined ? undefined : findNode(r.tree, s.node);
  const lit =
    q === undefined || node === undefined ? undefined : firstLit(node, hitsOf(r, s, q).counts);

  return lit ?? r.opens(s.node) ?? FIRST_PAGE;
};

/** The first page with hits at or under a node, in tree order. */
const firstLit = (node: TreeNode, counts: SearchHits['counts']): PageId | undefined => {
  if (node.page !== null && counts[node.page] !== undefined) return node.page;
  for (const c of node.children) {
    const lit = firstLit(c, counts);

    if (lit !== undefined) return lit;
  }

  return undefined;
};

/** A tree node by a page's id: a leaf's id is its page's. */
export const nodeOfPage = (r: SettingsDialogRules, page: string): string =>
  findNode(r.tree, page)?.id ?? FIRST_PAGE;
