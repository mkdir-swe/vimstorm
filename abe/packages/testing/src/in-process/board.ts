/**
 * Boards for scenarios. One refuses every call. The other holds cards in memory, and the next read
 * sees its writes. Tests of code that reads and writes cards, like the Factory, use it without the
 * fake server.
 */
import {
  type Board,
  type Boarded,
  type BoardRef,
  carriesTag,
  CardData,
  type DoneCards,
  type CardDetail,
  doneCardsOf,
  isDoneState,
  type Person,
  retag,
} from '@abe/core';

export const refusingBoard = (): Board => {
  const refuse = (name: string) => () =>
    Promise.resolve<Boarded<never>>({
      ok: false,
      error: { code: 'ado-failed', message: `${name}: this scenario has no Azure DevOps` },
    });

  return {
    list: refuse('list'),
    show: refuse('show'),
    image: refuse('image'),
    comment: refuse('comment'),
    tag: refuse('tag'),
    move: refuse('move'),
    assign: refuse('assign'),
    members: refuse('members'),
    me: refuse('me'),
    attach: refuse('attach'),
    currentSprint: refuse('currentSprint'),
    changes: refuse('changes'),
    create: refuse('create'),
    write: refuse('write'),
  };
};

export type FakeBoard = Board & {
  /** The cards as they now stand, comments included. */
  cards: () => CardDetail[];
  /** Someone else changes a card on the board, and `changes` finds it next. */
  outside: (id: number, change: Partial<Omit<CardDetail, 'id'>>) => void;
};

/** A card with every field filled from `id`, `title` and what `rest` gives. */
export const card = (
  id: number,
  title: string,
  rest: Partial<Omit<CardDetail, 'id' | 'title'>> = {},
): CardDetail => ({
  id,
  title,
  state: 'New',
  type: 'User Story',
  tags: [],
  assignee: null,
  description: '',
  acceptanceCriteria: '',
  points: null,
  createdBy: null,
  url: `https://dev.azure.com/demo-org/Shop/_workitems/edit/${id}`,
  comments: [],
  ...rest,
});

/**
 * The given cards on any board. `me` is you. `--mine` matches you, you write the comments, and
 * `assign` can set you. Without `me`, `assign` refuses you. `team` is the other members. `states`
 * are the states a move may set (any, when not given). `at` stamps each comment. `sprint` is the
 * team's current sprint and the cards in it (none when not given). `images` is what `image` reads.
 */
export const fakeBoard = (
  initial: readonly CardDetail[],
  o: {
    me?: Person;
    states?: readonly string[];
    at?: () => string;
    sprint?: { name: string; path: string; cards: readonly number[] };
    /** The local file of each image `image` reads, by its address (any other is refused). */
    images?: Readonly<Record<string, string>>;
    /** The team's other members. `members` lists them after `me`, and `assign` may set them. */
    team?: readonly Person[];
  } = {},
): FakeBoard => {
  const held = new Map(initial.map((c) => [c.id, structuredClone(c)]));
  // the sprint's cards, with each new card added
  const sprint = o.sprint === undefined ? undefined : { ...o.sprint, cards: [...o.sprint.cards] };
  let nextComment = 1;
  // each card's last change, a millisecond apart. The seeded cards all start at the same time.
  let clock = Date.parse('2026-10-23T00:00:00.000Z');
  const changedAt = new Map(initial.map((c) => [c.id, new Date(clock).toISOString()]));
  const touch = (id: number) => {
    clock += 1;
    changedAt.set(id, new Date(clock).toISOString());
  };
  const missing = (id: number): Boarded<never> => ({
    ok: false,
    error: { code: 'not-found', message: `TF401232: Work item ${id} does not exist.` },
  });
  /** The card without its comments, as list, tag and move answer. */
  const plain = (c: CardDetail): CardData => CardData.parse(c);
  const write = (id: number, change: (c: CardDetail) => CardDetail) => {
    const c = held.get(id);

    if (c === undefined) return Promise.resolve(missing(id));
    const next = change(c);

    held.set(id, next);
    touch(id);

    return Promise.resolve({ ok: true, data: plain(next) } as const);
  };

  const inSprint = (path: string, id: number) => path === sprint?.path && sprint.cards.includes(id);
  // like Azure's list: the open cards and the done ones asked for, never a Removed card. This
  // board keeps no dates, so `days` takes every done card.
  const listedBy = (done: DoneCards | undefined) => (c: CardDetail) => {
    if (c.state === 'Removed') return false;
    if (!isDoneState(c.state)) return true;
    if (done === undefined) return false;

    return 'days' in done || inSprint(done.iteration, c.id);
  };
  const isMine = (c: CardDetail) => c.assignee?.email === o.me?.email;
  // like the board's query: a shared board's tag, and the lanes and tag a repo leaves out
  const isRepos = (board: BoardRef) => (c: CardDetail) =>
    (board.tag === undefined || carriesTag(c.tags, board.tag)) &&
    (board.notTag === undefined || !carriesTag(c.tags, board.notTag)) &&
    !(board.excludeLanes ?? []).some((l) => l.toLowerCase() === c.lane?.toLowerCase());

  return {
    changes: (board, since) => {
      const newest = [...changedAt.values()].reduce<string | null>(
        (max, at) => (max === null || at > max ? at : max),
        null,
      );

      if (since === null)
        return Promise.resolve({ ok: true, data: { at: newest, cards: [], gone: [] } });
      const ids = [...changedAt].filter(([, at]) => at > since).map(([id]) => id);
      const listed = listedBy(
        doneCardsOf(sprint === undefined ? null : { name: sprint.name, path: sprint.path }),
      );
      const repos = isRepos(board);
      const on = ids.flatMap((id) => {
        const c = held.get(id);

        return c === undefined || !listed(c) || !repos(c) ? [] : [c];
      });

      return Promise.resolve({
        ok: true,
        data: {
          at: newest,
          cards: on.map((c) => ({ card: plain(c), mine: o.me !== undefined && isMine(c) })),
          gone: ids.filter((id) => !on.some((c) => c.id === id)),
        },
      });
    },
    list: (board, { mine, iteration, done }) => {
      const listed = listedBy(done);

      return Promise.resolve({
        ok: true,
        data: [...held.values()]
          .filter(listed)
          .filter(isRepos(board))
          .filter((c) => !mine || isMine(c))
          .filter((c) => iteration === undefined || inSprint(iteration, c.id))
          .map(plain),
      });
    },
    currentSprint: () =>
      Promise.resolve({
        ok: true,
        data: sprint === undefined ? null : { name: sprint.name, path: sprint.path },
      }),
    show: (_, id) => {
      const c = held.get(id);

      return Promise.resolve(
        c === undefined ? missing(id) : { ok: true, data: structuredClone(c) },
      );
    },
    image: (_, url) =>
      Promise.resolve(
        o.images?.[url] === undefined
          ? { ok: false, error: { code: 'rejected', message: `no image at ${url}` } }
          : { ok: true, data: o.images[url] },
      ),
    comment: (_, id, markdown) => {
      const c = held.get(id);

      if (c === undefined) return Promise.resolve(missing(id));
      const comment = {
        id: nextComment,
        text: markdown,
        by: o.me?.name ?? 'Me',
        at: o.at?.() ?? '2026-10-23T00:00:00.000Z',
      };

      nextComment += 1;
      c.comments.push(comment);

      return Promise.resolve({ ok: true, data: { card: id, ...comment } });
    },
    tag: (_, id, change) => write(id, (c) => ({ ...c, tags: retag(c.tags, change) })),
    move: (_, id, state) =>
      o.states !== undefined && !o.states.includes(state)
        ? Promise.resolve({
            ok: false,
            error: { code: 'rejected', message: `'${state}' is not a state of this card` },
          })
        : write(id, (c) => ({ ...c, state })),
    assign: (_, id, who) => {
      if (who.kind === 'none') return write(id, (c) => ({ ...c, assignee: null }));
      const person =
        who.kind === 'me'
          ? o.me
          : [...(o.team ?? []), ...(o.me === undefined ? [] : [o.me])].find(
              (p) => p.email.toLowerCase() === who.login.toLowerCase(),
            );

      if (person !== undefined) return write(id, (c) => ({ ...c, assignee: person }));

      return Promise.resolve({
        ok: false,
        error:
          who.kind === 'me'
            ? { code: 'auth', message: 'this board knows no you: give it `me`' }
            : { code: 'rejected', message: `TF401320: '${who.login}' is not a valid identity` },
      });
    },
    members: () =>
      Promise.resolve({
        ok: true,
        data: [
          ...(o.me === undefined ? [] : [{ ...o.me, you: true }]),
          ...(o.team ?? []).map((p) => ({ ...p, you: false })),
        ],
      }),
    me: () =>
      Promise.resolve(
        o.me === undefined
          ? { ok: false, error: { code: 'auth', message: 'this board knows no you: give it `me`' } }
          : { ok: true, data: o.me },
      ),
    attach: (_, id, file) =>
      Promise.resolve(
        held.has(id)
          ? {
              ok: true,
              data: {
                url: `https://dev.azure.com/demo-org/_apis/wit/attachments/${id}-${file.name}`,
              },
            }
          : missing(id),
      ),
    create: (b, text) => {
      const refuse = (message: string) =>
        Promise.resolve<Boarded<never>>({ ok: false, error: { code: 'rejected', message } });
      const type = text.type ?? b.types[0] ?? 'User Story';

      if (text.state !== undefined && o.states !== undefined && !o.states.includes(text.state))
        return refuse(`'${text.state}' is not a state of a ${type}: ${o.states.join(', ')}`);
      if (text.assignee === 'me' && o.me === undefined)
        return Promise.resolve<Boarded<never>>({
          ok: false,
          error: { code: 'auth', message: 'this board knows no you: give it `me`' },
        });
      const id = Math.max(0, ...held.keys()) + 1;
      const made = card(id, text.title, {
        type,
        state: text.state ?? 'New',
        assignee: text.assignee === 'me' ? (o.me ?? null) : null,
        description: text.description,
        acceptanceCriteria: text.acceptanceCriteria,
        tags: [...(text.tags ?? [])],
        createdBy: o.me ?? null,
      });

      if (sprint !== undefined && text.sprint !== 'none') sprint.cards.push(id);

      held.set(id, made);
      touch(id);

      return Promise.resolve({ ok: true, data: plain(made) });
    },
    write: (_, id, text) => write(id, (c) => ({ ...c, ...text })),
    cards: () => [...held.values()].map((c) => structuredClone(c)),
    outside: (id, change) => {
      const c = held.get(id) ?? card(id, change.title ?? `Card ${id}`);

      held.set(id, { ...c, ...structuredClone(change) });
      touch(id);
    },
  };
};
