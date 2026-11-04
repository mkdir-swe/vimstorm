/**
 * The Board On this Mac: a board whose cards, states, comments and new cards are Abe's, kept in
 * one JSON file per board under `dir` (`<slug of the project>.json`, read with zod, written whole
 * through a temporary file renamed over). Nothing leaves the Mac. What the words mean is core's
 * (`DONE_STATES`, `OVER_STATES`, `retag`, `DONE_DAYS`); this keeps the cards.
 * `boardsByKind` sends each call to this, the GitHub one or the Azure DevOps one by the board it names.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AssignTo,
  type Board,
  type Boarded,
  type BoardRef,
  CardData,
  CardDetail,
  type Clock,
  type DoneCards,
  DONE_DAYS,
  isDoneState,
  isGithubBoard,
  isLocalBoard,
  OVER_STATES,
  type Person,
  retag,
} from '@abe/core';
import { z } from 'zod';

/** The states a card On this Mac can be in, the Agile process's. */
const STATES = ['New', 'Active', 'Resolved', 'Closed', 'Removed'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A card as kept: its detail, when it changed (ms), and the card it is a child of (a ticket). Who
 * made it is its `createdBy`.
 */
const Stored = CardDetail.extend({ changedAt: z.number(), parent: z.number().optional() });
type Stored = z.infer<typeof Stored>;
const BoardFile = z.object({ cards: z.array(Stored) });

const fail = (code: 'rejected' | 'not-found', message: string) =>
  ({ ok: false, error: { code, message } }) as const;

/** A board's file name: its project in lowercase letters and digits, the rest a dash. */
const slug = (project: string): string =>
  project
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '') || 'board';

/** A file's name as attached: no folders, nothing the file system would read as more. */
const safeName = (name: string): string =>
  basename(name.replaceAll('\\', '/'))
    .replaceAll(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '') || 'file';

const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const localBoard = (o: { dir: string; clock: Clock; me: Person }): Board => {
  const { me } = o;
  const fileOf = (b: BoardRef) => join(o.dir, `${slug(b.project)}.json`);
  const missing = (b: BoardRef, id: number) =>
    fail('not-found', `AB#${id} is not on this machine's board ${b.project}`);
  const stateList = STATES.join(', ');

  const load = (b: BoardRef): Boarded<Stored[]> => {
    const file = fileOf(b);

    if (!existsSync(file)) return { ok: true, data: [] };
    try {
      return { ok: true, data: BoardFile.parse(JSON.parse(readFileSync(file, 'utf8'))).cards };
    } catch (err) {
      return fail('rejected', `the board file ${file} could not be read: ${why(err)}`);
    }
  };

  const save = (b: BoardRef, cards: readonly Stored[]): Boarded<null> => {
    const file = fileOf(b);
    const part = `${file}.${process.pid}.part`;

    try {
      mkdirSync(o.dir, { recursive: true, mode: 0o700 });
      writeFileSync(part, `${JSON.stringify({ cards }, null, 2)}\n`, { mode: 0o600 });
      renameSync(part, file);

      return { ok: true, data: null };
    } catch (err) {
      rmSync(part, { force: true });

      return fail('rejected', `the board file ${file} could not be written: ${why(err)}`);
    }
  };

  /** Whether a person is you: by login when you have one, else by name. */
  const isMe = (p: Person | null): boolean =>
    p !== null &&
    p.email.toLowerCase() === me.email.toLowerCase() &&
    (me.email !== '' || p.name === me.name);

  const mineOf = (c: Stored): boolean => isMe(c.assignee);

  /** An open card, or a done one `done` names (a Removed card never shows). */
  const shows = (c: Stored, done: DoneCards | undefined): boolean => {
    if (!OVER_STATES.some((s) => s === c.state)) return true;
    if (done === undefined || !isDoneState(c.state) || !('days' in done)) return false;

    return c.changedAt >= o.clock.now() - done.days * DAY_MS;
  };

  /** Newest change first. */
  const newest = (cards: readonly Stored[]): Stored[] =>
    cards.toSorted((a, b) => b.changedAt - a.changedAt || b.id - a.id);

  const data = (c: Stored): CardData => CardData.parse(c);

  const stateOf = (name: string): string | undefined =>
    STATES.find((s) => s.toLowerCase() === name.toLowerCase());

  /**
   * The card `id` changed by `change` (the card it becomes, and what the call answers), kept with
   * the change time moved to now when it differs. All in one turn: no call reads between.
   */
  const edit = <T>(
    b: BoardRef,
    id: number,
    change: (card: Stored, all: readonly Stored[]) => Boarded<{ card: Stored; out: T }>,
  ): Boarded<T> => {
    const all = load(b);

    if (!all.ok) return all;
    const card = all.data.find((c) => c.id === id);

    if (card === undefined) return missing(b, id);
    const changed = change(card, all.data);

    if (!changed.ok) return changed;
    if (JSON.stringify(changed.data.card) === JSON.stringify(card))
      return { ok: true, data: changed.data.out };
    const next = { ...changed.data.card, changedAt: o.clock.now() };
    const saved = save(
      b,
      all.data.map((c) => (c.id === id ? next : c)),
    );

    return saved.ok ? { ok: true, data: changed.data.out } : saved;
  };

  const tidy = (card: Stored) => ({ ok: true, data: { card, out: data(card) } }) as const;

  const assignee = (who: AssignTo): Person | null => {
    if (who.kind === 'me') return me;

    return who.kind === 'none' ? null : { name: who.login, email: who.login };
  };

  const board: Board = {
    list: (b, { mine, iteration, done }) => {
      const all = load(b);

      if (!all.ok) return Promise.resolve(all);
      // there are no sprints: no card is in an iteration
      if (iteration !== undefined) return Promise.resolve({ ok: true, data: [] });
      const found = all.data.filter((c) => shows(c, done) && (!mine || mineOf(c)));

      return Promise.resolve({ ok: true, data: newest(found).map(data) });
    },
    currentSprint: () => Promise.resolve({ ok: true, data: null }),
    changes: (b, since) => {
      const at = new Date(o.clock.now()).toISOString();

      if (since === null) return Promise.resolve({ ok: true, data: { at, cards: [], gone: [] } });
      const after = Date.parse(since);

      if (Number.isNaN(after)) return Promise.resolve(fail('rejected', `not a time: ${since}`));
      const all = load(b);

      if (!all.ok) return Promise.resolve(all);
      // as `card list --closed` lists them: the done cards of the last days too
      const done: DoneCards = { days: DONE_DAYS };
      const changed = all.data.filter((c) => c.changedAt > after);

      return Promise.resolve({
        ok: true,
        data: {
          at,
          cards: newest(changed.filter((c) => shows(c, done))).map((c) => ({
            card: data(c),
            mine: mineOf(c),
          })),
          // oldest change first, as the Azure DevOps one says them
          gone: changed
            .filter((c) => !shows(c, done))
            .toSorted((a, c) => a.changedAt - c.changedAt || a.id - c.id)
            .map((c) => c.id),
        },
      });
    },
    show: (b, id) => {
      const all = load(b);

      if (!all.ok) return Promise.resolve(all);
      const card = all.data.find((c) => c.id === id);

      return Promise.resolve(
        card === undefined ? missing(b, id) : { ok: true, data: CardDetail.parse(card) },
      );
    },
    image: () => Promise.resolve(fail('rejected', 'a board On this machine has no images to read')),
    comment: (b, id, markdown) =>
      Promise.resolve(
        edit(b, id, (card, all) => {
          const last = Math.max(0, ...all.flatMap((c) => c.comments.map((m) => m.id)));
          const made = {
            id: last + 1,
            text: markdown,
            by: me.name,
            at: new Date(o.clock.now()).toISOString(),
          };

          return {
            ok: true,
            data: {
              card: { ...card, comments: [...card.comments, made] },
              out: { card: id, ...made },
            },
          };
        }),
      ),
    tag: (b, id, change) =>
      Promise.resolve(edit(b, id, (card) => tidy({ ...card, tags: retag(card.tags, change) }))),
    move: (b, id, state) =>
      Promise.resolve(
        edit(b, id, (card) => {
          const to = stateOf(state);

          return to === undefined
            ? fail(
                'rejected',
                `'${state}' is not a state of AB#${id} (a ${card.type}): ${stateList}`,
              )
            : tidy({ ...card, state: to });
        }),
      ),
    assign: (b, id, who) =>
      Promise.resolve(edit(b, id, (card) => tidy({ ...card, assignee: assignee(who) }))),
    members: () => Promise.resolve({ ok: true, data: [{ ...me, you: true }] }),
    me: () => Promise.resolve({ ok: true, data: me }),
    create: (b, card) => {
      const type = card.type ?? b.types[0];

      if (type === undefined)
        return Promise.resolve(fail('rejected', 'the board names no card type to create'));
      if (!b.types.includes(type))
        return Promise.resolve(
          fail('rejected', `'${type}' is not a type of this board: ${b.types.join(', ')}`),
        );
      const state = card.state === undefined ? 'New' : stateOf(card.state);

      if (state === undefined)
        return Promise.resolve(
          fail('rejected', `'${card.state}' is not a state of a ${type}: ${stateList}`),
        );
      const all = load(b);

      if (!all.ok) return Promise.resolve(all);
      const id = Math.max(0, ...all.data.map((c) => c.id)) + 1;
      const made: Stored = {
        id,
        title: card.title,
        state,
        type,
        tags: [...(card.tags ?? [])],
        assignee: card.assignee === 'me' ? me : null,
        description: card.description,
        acceptanceCriteria: card.acceptanceCriteria,
        url: `local:${b.project}#${id}`,
        points: null,
        createdBy: me,
        comments: [],
        changedAt: o.clock.now(),
        ...(card.parent === undefined ? {} : { parent: card.parent }),
      };
      const saved = save(b, [...all.data, made]);

      return Promise.resolve(saved.ok ? { ok: true, data: data(made) } : saved);
    },
    attach: (b, id, file) => {
      const all = load(b);

      if (!all.ok) return Promise.resolve(all);
      if (!all.data.some((c) => c.id === id)) return Promise.resolve(missing(b, id));
      const dir = join(o.dir, 'files', slug(b.project));
      const path = join(dir, `${id}-${safeName(file.name)}`);

      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path, file.bytes, { mode: 0o600 });
      } catch (err) {
        return Promise.resolve(
          fail('rejected', `the file could not be kept in ${dir}: ${why(err)}`),
        );
      }

      return Promise.resolve({ ok: true, data: { url: pathToFileURL(path).href } });
    },
    write: (b, id, text) =>
      Promise.resolve(
        edit(b, id, (card) =>
          tidy({
            ...card,
            title: text.title ?? card.title,
            description: text.description ?? card.description,
            acceptanceCriteria: text.acceptanceCriteria ?? card.acceptanceCriteria,
          }),
        ),
      ),
  };

  return board;
};

/**
 * One `Board` for callers: a call goes to `local` when its board is On this Mac
 * (`board.provider: local`), to `github` when it is the repo's GitHub Issues (`board.provider:
 * github`; none given: refused), else to `azure`.
 */
export const boardsByKind = (o: { azure: Board; local: Board; github?: Board }): Board =>
  routedBoard((b) => {
    if (isLocalBoard(b)) return o.local;
    if (isGithubBoard(b)) return o.github ?? NO_GITHUB_BOARD;

    return o.azure;
  });

const noGithub = () =>
  Promise.resolve({
    ok: false as const,
    error: { code: 'unsupported' as const, message: 'this abe serve reads no GitHub board' },
  });

/** A GitHub board where serve has none: every call refused. */
const NO_GITHUB_BOARD: Board = {
  list: noGithub,
  currentSprint: noGithub,
  changes: noGithub,
  show: noGithub,
  image: noGithub,
  comment: noGithub,
  tag: noGithub,
  move: noGithub,
  assign: noGithub,
  members: noGithub,
  me: noGithub,
  create: noGithub,
  attach: noGithub,
  write: noGithub,
};

/** One `Board` whose every call goes to the board `of` picks for the board it names. */
export const routedBoard = (of: (b: BoardRef) => Board): Board => {
  return {
    list: (b, query) => of(b).list(b, query),
    currentSprint: (b) => of(b).currentSprint(b),
    changes: (b, since) => of(b).changes(b, since),
    show: (b, id) => of(b).show(b, id),
    image: (b, url) => of(b).image(b, url),
    comment: (b, id, markdown) => of(b).comment(b, id, markdown),
    tag: (b, id, change) => of(b).tag(b, id, change),
    move: (b, id, state) => of(b).move(b, id, state),
    assign: (b, id, who) => of(b).assign(b, id, who),
    members: (b) => of(b).members(b),
    me: (b) => of(b).me(b),
    create: (b, card) => of(b).create(b, card),
    attach: (b, id, file) => of(b).attach(b, id, file),
    write: (b, id, text) => of(b).write(b, id, text),
  };
};
