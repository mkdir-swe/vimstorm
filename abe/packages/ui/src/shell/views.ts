/**
 * View tweaks (ticket #85, spec #36 I2): your `views` setting hides, reorders or relabels parts of
 * a screen by node id, with nothing but the components already there. Every screen the bridge
 * opens is wrapped (`withViews`): it reads `abe settings get views`, again on each
 * `settings.changed`, and its tree is drawn with the tweaks applied. Which ids a tweak may name
 * is core's (`views.ts`), checked when it is written; a tweak whose node is not on screen now
 * does nothing. The screen is told its tweaks too (a `views` input), so its keys walk the parts
 * as drawn (the Board's columns, `arranged`).
 */
import { type ViewTweak } from '@abe/core';
import { Node, type Size } from '../runtime/components';
import { type Answer, type Command, type Input, type Screen } from '../runtime/runtime';

/** The words a node draws as its own, by kind: what a `label` tweak replaces. */
const LABEL_PROP: Readonly<Partial<Record<Node['kind'], string>>> = {
  BoardColumn: 'name',
  BoardHeader: 'title',
  ListRow: 'text',
  KeyHint: 'label',
};

const childrenOf = (n: Node): readonly Node[] | undefined =>
  'children' in n ? n.children : undefined;

/** `n` with other children; a Stack's sizes go along with theirs (`order`: where each came from). */
const withChildren = (n: Node, kids: Node[], from: readonly number[], moved: boolean): Node => {
  const sizes = n.kind === 'Stack' ? n.props.sizes : undefined;

  // parsed again: a node of any kind with children, checked against the closed set
  if (n.kind !== 'Stack' || sizes === undefined || !moved)
    return Node.parse({ ...n, children: kids });

  return {
    ...n,
    props: { ...n.props, sizes: from.map((i): Size => sizes[i] ?? 'auto') },
    children: kids,
  };
};

const relabel = (n: Node, label: string): Node => {
  const prop = LABEL_PROP[n.kind];

  return prop === undefined ? n : Node.parse({ ...n, props: { ...n.props, [prop]: label } });
};

/** Which of `ids` stay, in their new order, as indexes into it: a hide or an order tweak. */
const arrangeOnce = (
  ids: readonly (string | undefined)[],
  t: ViewTweak,
  from: number[],
): number[] => {
  if (t.hide === true) return from.filter((i) => ids[i] !== t.node);
  if (t.order === undefined) return from;
  const at = from.findIndex((i) => ids[i] === t.node);

  if (at < 0) return from;
  const rest = from.filter((_, j) => j !== at);
  const place = Math.min(t.order, rest.length);

  return [...rest.slice(0, place), from[at] ?? at, ...rest.slice(place)];
};

/**
 * `items` as the tweaks leave them, hidden ones out and moved ones moved: what a screen walks
 * with its keys, so they go where the drawn tree shows (the Board's columns).
 */
export const arranged = <T>(
  items: readonly T[],
  idOf: (item: T) => string,
  tweaks: readonly ViewTweak[],
): T[] => {
  const ids = items.map(idOf);

  return tweaks
    .reduce(
      (from, t) => arrangeOnce(ids, t, from),
      items.map((_, i) => i),
    )
    .flatMap((i) => {
      const item = items[i];

      return item === undefined ? [] : [item];
    });
};

/** One tweak over a node and everything under it. */
const tweak = (n: Node, t: ViewTweak): Node => {
  const self = t.label !== undefined && n.id === t.node ? relabel(n, t.label) : n;
  const kids = childrenOf(self);

  if (kids === undefined) return self;
  const from = arrangeOnce(
    kids.map((k) => k.id),
    t,
    kids.map((_, i) => i),
  );
  const moved = from.flatMap((i) => {
    const kid = kids[i];

    return kid === undefined ? [] : [tweak(kid, t)];
  });
  const same = moved.length === kids.length && moved.every((k, i) => k === kids[i]);

  const shuffled = from.length !== kids.length || from.some((f, i) => f !== i);

  return same ? self : withChildren(self, moved, from, shuffled);
};

/** `tree` as `screen` draws it with your tweaks for it, in order. */
export const applyViews = (screen: string, tree: Node, tweaks: readonly ViewTweak[]): Node =>
  tweaks.filter((t) => t.screen === screen).reduce(tweak, tree);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A `settings get views` value as tweaks: those of the right shape (core checked them on write).
 */
export const viewsOfValue = (value: unknown): ViewTweak[] =>
  Array.isArray(value)
    ? value.flatMap((v): ViewTweak[] => {
        if (!isRecord(v) || typeof v.screen !== 'string' || typeof v.node !== 'string') return [];
        const base = { screen: v.screen, node: v.node };

        if (v.hide === true) return [{ ...base, hide: true }];
        if (typeof v.order === 'number') return [{ ...base, order: v.order }];
        if (v.group === 'top' || v.group === 'bottom') return [{ ...base, group: v.group }];

        return typeof v.label === 'string' ? [{ ...base, label: v.label }] : [];
      })
    : [];

/** A screen and its tweaks as last read. */
export type Viewed<S> = { inner: S; views: readonly ViewTweak[]; reads: number };

const READ = 'views:read:';

const read = (n: number): Command => ({
  kind: 'run',
  id: `${READ}${n}`,
  argv: ['settings', 'get', 'views'],
});

const isViewsAnswer = (input: Input): input is Answer =>
  input.kind === 'result' && input.id.startsWith(READ);

/**
 * `serve`'s `command.ran` for the wrapper's own read, by the run id the bridge tagged it with: it
 * never reaches the screen (the status screen would read again and name it Last command). Anyone
 * else's `abe settings get` still does.
 */
const isViewsEcho = (input: Input): boolean =>
  input.kind === 'event' &&
  input.event.type === 'command.ran' &&
  input.event.data.tag?.startsWith(READ) === true;

/**
 * `screen` drawn with your view tweaks: read on open and after every settings change. The read is
 * the wrapper's, not the screen's: its answer and its `command.ran` stop here.
 */
export const withViews = <S>(screen: Screen<S>): Screen<Viewed<S>> => ({
  name: screen.name,
  init: { inner: screen.init, views: [], reads: 0 },
  ...(screen.words === undefined ? {} : { words: screen.words }),
  ...(screen.opensOnMainCard === undefined ? {} : { opensOnMainCard: screen.opensOnMainCard }),
  // the jumps' story (#106) and a field of its own, as the screen says them
  ...(screen.linked === undefined
    ? {}
    : { linked: (state: Viewed<S>) => screen.linked?.(state.inner) }),
  ...(screen.typing === undefined
    ? {}
    : { typing: (state: Viewed<S>) => screen.typing?.(state.inner) === true }),
  // what it keeps for a reopen (#156), the tweaks with it
  ...(screen.keep === undefined
    ? {}
    : {
        keep: (state: Viewed<S>) => ({
          ...state,
          inner: screen.keep?.(state.inner) ?? state.inner,
        }),
      }),
  // a cloud launch's clock by the second (#142), as the screen says it
  ...(screen.seconds === undefined
    ? {}
    : { seconds: (state: Viewed<S>) => screen.seconds?.(state.inner) === true }),
  // what `:` and `?` start from (#346), as the screen says it
  ...(screen.here === undefined
    ? {}
    : { here: (state: Viewed<S>) => screen.here?.(state.inner) ?? {} }),
  ...(screen.follows === undefined
    ? {}
    : { follows: (state: Viewed<S>) => screen.follows?.(state.inner) ?? [] }),
  // (its own `settings.changed` read of the views goes on: the set says what the screen takes)
  events: new Set([...screen.events, 'settings.changed', 'serve.started']),
  step: (state, input) => {
    if (isViewsAnswer(input)) {
      // only the latest read counts; a failed one keeps the tweaks as they were
      if (
        input.id !== `${READ}${state.reads}` ||
        input.command !== 'settings get' ||
        !input.reply.ok
      )
        return { state, commands: [] };

      const views = viewsOfValue(input.reply.data.value);
      // the screen walks its parts as they are drawn (a hidden column `ä` never lands on)
      const told = screen.step(state.inner, {
        kind: 'views',
        tweaks: views.filter((t) => t.screen === screen.name),
        all: views,
      });

      return { state: { ...state, inner: told.state, views }, commands: told.commands };
    }
    if (isViewsEcho(input)) return { state, commands: [] };
    const next = screen.step(state.inner, input);
    const again =
      input.kind === 'open' ||
      (input.kind === 'event' &&
        (input.event.type === 'settings.changed' || input.event.type === 'serve.started'));

    if (!again) return { state: { ...state, inner: next.state }, commands: next.commands };
    const reads = state.reads + 1;

    return {
      state: { ...state, inner: next.state, reads },
      commands: [...next.commands, read(reads)],
    };
  },
  view: (state) => applyViews(screen.name, screen.view(state.inner), state.views),
});
