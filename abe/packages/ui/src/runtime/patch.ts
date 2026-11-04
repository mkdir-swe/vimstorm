/**
 * Keyed patches of a screen's tree (ADR 0036): what the bridge sends in place of a whole tree once
 * the app holds the slot's last one. A patch is a list of ops, each at a path of child indexes
 * into the tree as the ops before it left it: a node replaced whole, or a node's children spliced.
 * Children are matched by key (their `id`, else their kind), so a transcript entry appended to a
 * long Chat is one splice of one turn, not the tree. Only the kinds in `PARENTS` are walked into
 * (the window keeps their children); any other node that changed is replaced whole.
 */
import { z } from 'zod';
import { Node } from './components';
import type { BridgeFrame } from './protocol';

/** One change: `node` in place of the node at `path`, or that node's children spliced. */
export const PatchOp = z.union([
  z.strictObject({ path: z.array(z.number().int().nonnegative()), node: Node }),
  z.strictObject({
    path: z.array(z.number().int().nonnegative()),
    /** `[from, remove]`: `remove` children from `from`, `add` put there. */
    splice: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    add: z.array(Node),
  }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

/**
 * The kinds a patch walks into: the window holds their children as nodes. A changed node of any
 * other kind goes whole, so a patch never names a child the window drops.
 */
const PARENTS: ReadonlySet<Node['kind']> = new Set([
  'Island',
  'Stack',
  'ListRow',
  'BoardColumns',
  'BoardColumn',
  'Transcript',
  'Turn',
  'StepsFold',
]);

/** Any node's fields as the patch reads them: a node of any kind, its children if it has any. */
type Fields = {
  kind: string;
  id?: string | undefined;
  props?: unknown;
  children?: readonly Node[] | undefined;
};

const childrenOf = (n: Node): readonly Node[] => {
  const f: Fields = n;

  return f.children ?? [];
};

const keyOf = (n: Node): string => n.id ?? `~${n.kind}`;

/** Two JSON values alike, as their text would be (no text made: a tree is walked once). */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;

    return a.every((x, i) => same(x, b[i]));
  }
  // (an absent field and one `undefined` are alike: JSON drops both)
  const ka = Object.keys(a).filter((k) => field(a, k) !== undefined);
  const kb = Object.keys(b).filter((k) => field(b, k) !== undefined);

  return ka.length === kb.length && ka.every((k) => same(field(a, k), field(b, k)));
};

const field = (o: object, k: string): unknown => Object.getOwnPropertyDescriptor(o, k)?.value;

/** The node apart from its children alike: what decides it is the same node in place. */
const sameOwn = (a: Node, b: Node): boolean => {
  const x: Fields = a;
  const y: Fields = b;

  return x.kind === y.kind && x.id === y.id && same(x.props, y.props);
};

const walk = (a: Node, b: Node, path: number[], ops: PatchOp[]): void => {
  if (a === b) return;
  const parent = PARENTS.has(b.kind) && sameOwn(a, b);

  if (!parent) {
    if (!same(a, b)) ops.push({ path, node: b });

    return;
  }
  const was = childrenOf(a);
  const now = childrenOf(b);
  const short = Math.min(was.length, now.length);
  let head = 0;

  while (head < short && keyOf(was[head] ?? b) === keyOf(now[head] ?? b)) head += 1;
  let tail = 0;

  while (
    tail < short - head &&
    keyOf(was[was.length - 1 - tail] ?? b) === keyOf(now[now.length - 1 - tail] ?? b)
  )
    tail += 1;
  const gone = was.length - tail - head;
  const come = now.length - tail - head;
  // the same children in place: each walked; else the ones between the kept ends spliced
  const pairs = gone === come ? head + gone : head;

  for (let i = 0; i < pairs; i += 1) {
    const x = was[i];
    const y = now[i];

    if (x !== undefined && y !== undefined) walk(x, y, [...path, i], ops);
  }
  if (gone !== come) ops.push({ path, splice: [head, gone], add: now.slice(head, head + come) });
  for (let k = 0; k < tail; k += 1) {
    const x = was[was.length - 1 - k];
    const y = now[now.length - 1 - k];

    if (x !== undefined && y !== undefined) walk(x, y, [...path, now.length - 1 - k], ops);
  }
};

/**
 * What turns `was` into `now`: none when they are the same tree; one op at the root when nothing
 * of `was` is kept (the bridge sends the tree whole then).
 */
export const patchOf = (was: Node, now: Node): PatchOp[] => {
  const ops: PatchOp[] = [];

  walk(was, now, [], ops);

  return ops;
};

/** `ops` applied to `tree` in order, as the window applies them; undefined: a path not there. */
export const applyPatch = (tree: Node, ops: readonly PatchOp[]): Node | undefined => {
  let root: Node | undefined = tree;

  for (const op of ops) {
    if (root === undefined) return undefined;
    root = applyOne(root, op, 0);
  }

  return root;
};

const withChildren = (n: Node, children: Node[]): Node => Node.parse({ ...n, children });

const applyOne = (n: Node, op: PatchOp, depth: number): Node | undefined => {
  if (depth === op.path.length) {
    if ('node' in op) return op.node;
    const kids = [...childrenOf(n)];
    const [from, remove] = op.splice;

    if (from + remove > kids.length) return undefined;
    kids.splice(from, remove, ...op.add);

    return withChildren(n, kids);
  }
  const at = op.path[depth] ?? 0;
  const kids = [...childrenOf(n)];
  const child = kids[at];

  if (child === undefined) return undefined;
  const next = applyOne(child, op, depth + 1);

  if (next === undefined) return undefined;
  kids[at] = next;

  return withChildren(n, kids);
};

/**
 * The bridge's frames as the window takes them (a test's, a client's): each slot's tree held,
 * a `patch` applied to it and handed on as the whole `tree` it gives, any other frame as it came.
 * A patch on no tree held, or on another base, throws: the bridge sent what the window can't apply.
 */
export const asTrees = () => {
  const held = new Map<string, { tree: Node; rev: number }>();

  return (frame: BridgeFrame): BridgeFrame => {
    if (frame.type === 'closed') held.delete(frame.slot);
    if (frame.type === 'tree') held.set(frame.slot ?? 'main', { tree: frame.tree, rev: frame.rev });
    if (frame.type !== 'patch') return frame;
    const was = held.get(frame.slot ?? 'main');
    const tree = was?.rev === frame.base ? applyPatch(was.tree, frame.ops) : undefined;

    if (tree === undefined)
      throw new Error(`a patch on rev ${frame.base} the window does not hold`);
    held.set(frame.slot ?? 'main', { tree, rev: frame.rev });

    return {
      v: frame.v,
      type: 'tree',
      screen: frame.screen,
      rev: frame.rev,
      tree,
      ...(frame.slot === undefined ? {} : { slot: frame.slot }),
    };
  };
};
