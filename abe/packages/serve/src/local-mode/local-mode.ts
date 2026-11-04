/**
 * Local mode (#24): the checkouts your Layer's `localMode` lists read the board and GitHub as
 * usual and hold every write on this Mac. `serve` keeps the records (`<state>/local/`): the held
 * writes, the local pull requests and issues, and what each would have sent as a file ⏎ opens.
 * The ports a request or a run uses are wrapped here (core's held decorators) where local mode is
 * on; `abe local` reads the records, turns it on or off, and merges or discards a local pull
 * request. Turning it off sends nothing held: they stay a record. The checkouts `boardReadOnly`
 * lists hold the board's writes alone (a read-only board; local mode's is read-only too), and
 * `abe board discard` drops a checkout's held board writes (Discard local changes).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Answered,
  type Board,
  type BoardDiscardData,
  type BoardReadOnlyData,
  isBoardWrite,
  CardDetail,
  cardOfBody,
  localCardName,
  type LocalPrChanges,
  type Clock,
  type Git,
  heldBoard,
  heldGit,
  heldPipelines,
  heldTracking,
  heldReview,
  heldLayerPulls,
  heldOrgStore,
  type LayerPulls,
  type LogStore,
  type OrgStore,
  type ReviewPort,
  isLocalNumber,
  type HeldWrite,
  type HeldStore,
  type HoldInput,
  localCheckoutOf,
  LocalIssue,
  type LocalMerge,
  localModeView,
  type LocalModeView,
  localModeWith,
  localName,
  localNumber,
  LocalPr,
  type Outcome,
  parseLocalName,
  type Pipelines,
  dropEntry,
  putEntry,
  refused,
  SETTINGS,
  type Tracking,
  HeldWrite as HeldWriteSchema,
  individualFile,
  type Handlers,
} from '@abe/core';
import { fileLogStore, fileOrgStore, mainCheckout, readYamlFile, writeYamlFile } from '@abe/ports';
import { z } from 'zod';
import { type SettingsService } from '../layer/settings';

/** A card made in local mode (a held card, `LC<n>`): the checkout that holds it, as it stands. */
const HeldCard = z.object({ checkout: z.string(), card: CardDetail });

const Records = z.object({
  seq: z.number().int().nonnegative(),
  prs: z.number().int().nonnegative(),
  issues: z.number().int().nonnegative(),
  cards: z.number().int().nonnegative().default(0),
  held: z.array(HeldWriteSchema),
  localPrs: z.array(LocalPr),
  localIssues: z.array(LocalIssue),
  heldCards: z.array(HeldCard).default([]),
});
type Records = z.infer<typeof Records>;

const EMPTY: Records = {
  seq: 0,
  prs: 0,
  issues: 0,
  cards: 0,
  held: [],
  localPrs: [],
  localIssues: [],
  heldCards: [],
};

/** The main checkout holding `dir` (a card worktree's: the one it was added from). */
export const checkoutOf = mainCheckout;

export type LocalModeOptions = {
  /** Where the records are kept: `<dir>/local/`. */
  stateDir: string;
  clock: Clock;
  settings: SettingsService | undefined;
  /** A local pull request's head and its squash merge into the local base; none: merges refused. */
  merge: LocalMerge | undefined;
  emitHeld: (w: HeldWrite) => void;
  emitPr: (p: LocalPr) => void;
  /** Discard local changes dropped a checkout's held board changes. */
  emitDiscarded?: ((d: BoardDiscardData) => void) | undefined;
};

export type LocalMode = {
  /** The checkout in local mode `dir` is in (its own, a folder in it, a card worktree beside it). */
  at: (dir: string) => string | undefined;
  /**
   * The checkout whose board is read-only that `dir` is in: in local mode, or made read-only
   * alone (`boardReadOnly`). Its board writes are held there.
   */
  boardHeldAt: (dir: string) => string | undefined;
  tracking: (inner: Tracking, dir: string | undefined) => Tracking;
  /**
   * `inner` with every call on a local number (`#L<n>`) answered by the checkout that holds it,
   * wherever it was typed (a person's `factory end` comment on a local pull request): never sent.
   */
  localNumbers: (inner: Tracking) => Tracking;
  board: (inner: Board, dir: string | undefined) => Board;
  /** The checkout holding held card `id` (`LC<n>`), wherever it is asked about. */
  heldCardAt: (id: number) => string | undefined;
  git: (inner: Git, dir: string | undefined) => Git;
  pipelines: (inner: Pipelines | undefined, dir: string | undefined) => Pipelines | undefined;
  review: (inner: ReviewPort | undefined, dir: string | undefined) => ReviewPort | undefined;
  layerPulls: (inner: LayerPulls | undefined, dir: string | undefined) => LayerPulls | undefined;
  /** The org store where `dir` is in local mode: written in `<dir>/local/store/`, read there first. */
  org: (inner: OrgStore | undefined, dir: string | undefined) => OrgStore | undefined;
  /** Where `dir` is in local mode, its sessions' log store: `<state>/local/logs/`, never shipped. */
  logs: (dir: string | undefined) => LogStore | undefined;
  view: (dir: string) => LocalModeView;
  /** A local pull request of the checkout `dir` is in, by `L<n>`, merged into its base or discarded. */
  merge: (dir: string, name: string) => Promise<Outcome<LocalPr>>;
  discard: (dir: string, name: string) => Promise<Outcome<LocalPr>>;
  /** Discard local changes: the board changes held for the checkout `dir` is in, dropped. */
  discardBoard: (dir: string) => Outcome<BoardDiscardData>;
  /**
   * A repo moved from `from` to `to`: what is held for it kept for `to`, and your Layer's
   * `localMode` and `boardReadOnly` naming `to` where they named `from` (else its writes would go
   * out). How many held records followed; why your Layer could not be written, if it could not.
   */
  rehome: (from: string, to: string) => { records: number; problem?: string };
};

export const openLocalMode = (o: LocalModeOptions): LocalMode => {
  const root = join(o.stateDir, 'local');
  const file = join(root, 'records.json');
  const filesDir = join(root, 'files');
  const store = fileOrgStore(join(root, 'store'));
  const logStore = fileLogStore(join(root, 'logs'));
  const read = (): Records => {
    if (!existsSync(file)) return structuredClone(EMPTY);
    try {
      const parsed = Records.safeParse(JSON.parse(readFileSync(file, 'utf8')));

      return parsed.success ? parsed.data : structuredClone(EMPTY);
    } catch {
      return structuredClone(EMPTY);
    }
  };
  let records = read();
  const save = () => {
    mkdirSync(root, { recursive: true });
    const tmp = `${file}.tmp`;

    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`);
    renameSync(tmp, file);
  };
  const keep = (name: string, bytes: string | Uint8Array) => {
    mkdirSync(filesDir, { recursive: true });
    const path = join(filesDir, name);

    writeFileSync(path, bytes);

    return path;
  };
  const now = () => new Date(o.clock.now()).toISOString();
  const at = (dir: string) =>
    o.settings === undefined
      ? localCheckoutOf(SETTINGS.localMode.default, dir)
      : o.settings.facts(dir).localMode;
  const readOnly = (dir: string) =>
    o.settings?.at(dir).values.boardReadOnly ?? SETTINGS.boardReadOnly.default;
  const boardHeldAt = (dir: string) => at(dir) ?? localCheckoutOf(readOnly(dir), dir);

  const holdFor = (checkout: string): HeldStore => {
    const pr = (number: number) =>
      records.localPrs.find((p) => p.checkout === checkout && p.number === number);
    const changed = (p: LocalPr) => {
      records.localPrs = records.localPrs.map((x) =>
        x.checkout === p.checkout && x.number === p.number ? p : x,
      );
      save();
      o.emitPr(p);

      return p;
    };
    const headOf = async (head: string) => {
      const sha = o.merge === undefined ? undefined : await o.merge.head(checkout, head);

      return sha?.ok === true ? sha.data : '';
    };
    /** What its head changes since its base, as git says now; none read: none. */
    const changesOf = async (head: string, base: string): Promise<LocalPrChanges> => {
      const read =
        o.merge === undefined ? undefined : await o.merge.changes(checkout, { head, base });

      return read?.ok === true ? read.data : { baseSha: '', files: [], commits: [] };
    };
    const heldCard = (id: number) =>
      records.heldCards.find((c) => c.checkout === checkout && c.card.id === id)?.card;

    return {
      record: (w: HoldInput) => {
        const seq = records.seq + 1;
        const body = w.body === undefined ? undefined : keep(`${seq}-${w.kind}.md`, w.body);
        const kept =
          w.file === undefined
            ? body
            : keep(`${seq}-${w.file.name.replace(/[^\w.-]/g, '_')}`, w.file.bytes);
        const held: HeldWrite = {
          seq,
          at: now(),
          checkout,
          kind: w.kind,
          what: w.what,
          where: w.where,
          card: w.card ?? null,
          to: w.to ?? null,
          open: w.open ?? (kept === undefined ? null : { kind: 'file', path: kept }),
          ...(w.tags === undefined ? {} : { tags: w.tags }),
          ...(w.text === undefined ? {} : { text: w.text }),
          ...(w.fields === undefined ? {} : { fields: w.fields }),
        };

        records = { ...records, seq, held: [...records.held, held] };
        save();
        o.emitHeld(held);

        return Promise.resolve(held);
      },
      issueCreate: (input) => {
        const n = records.issues + 1;
        const number = localNumber(n);
        const issue: LocalIssue = {
          number,
          checkout,
          repo: input.repo,
          title: input.title,
          body: input.body,
          labels: [...input.labels],
          parent: input.parent,
          file: keep(`issue-${localName(number)}.md`, `# ${input.title}\n\n${input.body}`),
        };

        records = { ...records, issues: n, localIssues: [...records.localIssues, issue] };
        save();

        return Promise.resolve(issue);
      },
      issue: (number) =>
        Promise.resolve(
          records.localIssues.find((i) => i.checkout === checkout && i.number === number),
        ),
      prFind: (repo, head) =>
        Promise.resolve(
          records.localPrs.find(
            (p) =>
              p.checkout === checkout && p.repo === repo && p.head === head && p.state === 'open',
          ),
        ),
      pr: (number) => Promise.resolve(pr(number)),
      prOpen: async (input) => {
        const n = records.prs + 1;
        const number = localNumber(n);
        const at = now();
        const p: LocalPr = {
          number,
          name: localName(number),
          checkout,
          repo: input.repo,
          card: cardOfBody(input.body),
          head: input.head,
          headSha: await headOf(input.head),
          ...(await changesOf(input.head, input.base)),
          base: input.base,
          title: input.title,
          body: input.body,
          file: keep(`pr-${localName(number)}.md`, `# ${input.title}\n\n${input.body}`),
          state: 'open',
          openedAt: at,
          updatedAt: at,
          mergeCommit: null,
        };

        records = { ...records, prs: n, localPrs: [...records.localPrs, p] };
        save();
        o.emitPr(p);

        return p;
      },
      prUpdate: async (number, change) => {
        const p = pr(number);

        if (p === undefined) return undefined;
        const title = change.title ?? p.title;

        return changed({
          ...p,
          title,
          body: change.body,
          card: cardOfBody(change.body) ?? p.card,
          headSha: await headOf(p.head),
          ...(await changesOf(p.head, p.base)),
          file: keep(`pr-${p.name}.md`, `# ${title}\n\n${change.body}`),
          updatedAt: now(),
        });
      },
      prMerge: async (number): Promise<Answered<LocalPr>> => {
        const p = pr(number);

        if (p === undefined)
          return {
            ok: false,
            error: { code: 'not-found', message: `no local pull request ${localName(number)}` },
          };
        if (p.state === 'merged') return { ok: true, data: p };
        if (p.state === 'discarded')
          return { ok: false, error: { code: 'discarded', message: `${p.name} was discarded` } };
        if (o.merge === undefined)
          return {
            ok: false,
            error: { code: 'no-git', message: 'this abe serve merges nothing locally' },
          };
        const merged = await o.merge.squash(checkout, {
          head: p.head,
          base: p.base,
          message: `${p.title} (${p.name})\n\n${p.body}`,
        });

        if (!merged.ok) return merged;

        return {
          ok: true,
          data: changed({ ...p, state: 'merged', mergeCommit: merged.data.sha, updatedAt: now() }),
        };
      },
      writes: () => Promise.resolve(records.held.filter((w) => w.checkout === checkout)),
      cardCreate: (input) => {
        const n = records.cards + 1;
        const id = localNumber(n);
        const card: CardDetail = { ...input, id, url: `local:${localCardName(id)}`, comments: [] };

        records = { ...records, cards: n, heldCards: [...records.heldCards, { checkout, card }] };
        save();

        return Promise.resolve(card);
      },
      card: (id) => Promise.resolve(heldCard(id)),
      cardChange: (id, change) => {
        const was = heldCard(id);

        if (was === undefined) return Promise.resolve(undefined);
        const card = { ...change(was), id: was.id, url: was.url };

        records.heldCards = records.heldCards.map((c) =>
          c.checkout === checkout && c.card.id === id ? { checkout, card } : c,
        );
        save();

        return Promise.resolve(card);
      },
      cards: () =>
        Promise.resolve(
          records.heldCards
            .filter((c) => c.checkout === checkout)
            .map((c) => c.card)
            .sort((a, b) => b.id - a.id),
        ),
    };
  };

  /**
   * `inner`, held where `dir` is in local mode: decided at the first call, not before, so a
   * request that never uses the port never reads the settings for it.
   */
  const held = <P extends object>(
    inner: P,
    dir: string | undefined,
    wrap: (p: P, h: HeldStore) => P,
    where: (dir: string) => string | undefined = at,
  ): P => {
    if (dir === undefined) return inner;
    let picked: P | undefined;
    const pick = () => {
      if (picked === undefined) {
        const checkout = where(dir);

        picked = checkout === undefined ? inner : wrap(inner, holdFor(checkout));
      }

      return picked;
    };

    return new Proxy(inner, {
      get: (_, key) => {
        const value: unknown = Reflect.get(pick(), key);

        return value;
      },
    });
  };

  /** The local pull request `name` of the checkout `dir` is in (on or off: its records stay). */
  const named = (dir: string, name: string): Outcome<{ checkout: string; pr: LocalPr }> => {
    const checkout = at(dir) ?? checkoutOf(dir);
    const number = parseLocalName(name);

    if (checkout === undefined) return refused('not-a-checkout', `${dir} is in no checkout`);
    if (number === undefined)
      return refused('usage', `not a local pull request: ${name} (L<n>)`, 2);
    const p = records.localPrs.find((x) => x.checkout === checkout && x.number === number);

    return p === undefined
      ? refused('not-found', `no local pull request ${localName(number)} in ${checkout}`)
      : { ok: true, data: { checkout, pr: p } };
  };

  /** The checkout holding local number `number` of `repo`, if any. */
  const ownerOf = (repo: string, number: number) =>
    [...records.localPrs, ...records.localIssues].find(
      (x) => x.repo === repo && x.number === number,
    )?.checkout;
  const localNumbers = (inner: Tracking): Tracking => {
    const by = (ref: { repo: string; number: number }) => {
      const owner = isLocalNumber(ref.number) ? ownerOf(ref.repo, ref.number) : undefined;

      return owner === undefined ? inner : heldTracking(inner, holdFor(owner));
    };

    return {
      ...inner,
      issueShow: (ref) => by(ref).issueShow(ref),
      issueComment: (ref, body) => by(ref).issueComment(ref, body),
      prShow: (ref) => by(ref).prShow(ref),
      prUpdate: (ref, change) => by(ref).prUpdate(ref, change),
      prMerge: (ref, how) => by(ref).prMerge(ref, how),
      prReviews: (ref) => by(ref).prReviews(ref),
    };
  };

  return {
    at,
    boardHeldAt,
    localNumbers,
    tracking: (inner, dir) => held(inner, dir, heldTracking),
    board: (inner, dir) => held(inner, dir, heldBoard, boardHeldAt),
    heldCardAt: (id) => records.heldCards.find((c) => c.card.id === id)?.checkout,
    git: (inner, dir) => held(inner, dir, heldGit),
    review: (inner, dir) => (inner === undefined ? undefined : held(inner, dir, heldReview)),
    layerPulls: (inner, dir) =>
      inner === undefined ? undefined : held(inner, dir, heldLayerPulls),
    pipelines: (inner, dir) => (inner === undefined ? undefined : held(inner, dir, heldPipelines)),
    org: (inner, dir) =>
      dir !== undefined && at(dir) !== undefined ? heldOrgStore(inner, store) : inner,
    logs: (dir) => (dir !== undefined && at(dir) !== undefined ? logStore : undefined),
    view: (dir) => {
      const on = at(dir);
      const boardHeld = boardHeldAt(dir);
      const checkout = on ?? boardHeld ?? checkoutOf(dir) ?? null;

      return localModeView({
        checkout,
        on: on !== undefined,
        readOnlyBoard: boardHeld !== undefined,
        held: records.held,
        prs: records.localPrs,
      });
    },
    merge: async (dir, name) => {
      const found = named(dir, name);

      if (!found.ok) return found;
      const hold = holdFor(found.data.checkout);
      const merged = await hold.prMerge(found.data.pr.number);

      if (!merged.ok) return refused(merged.error.code, merged.error.message);
      await hold.record({
        kind: 'pr-merge',
        what: `merge pull request ${merged.data.name} into ${merged.data.base}`,
        where: `${merged.data.repo} on GitHub`,
        ...(merged.data.card === null ? {} : { card: merged.data.card }),
        open: { kind: 'local-pr', number: merged.data.number },
      });

      return { ok: true, data: merged.data };
    },
    discard: (dir, name) => {
      const found = named(dir, name);

      if (!found.ok) return Promise.resolve(found);
      const p = found.data.pr;

      if (p.state !== 'open')
        return Promise.resolve(refused(`pr-${p.state}`, `${p.name} is ${p.state} already`));
      const next: LocalPr = { ...p, state: 'discarded', updatedAt: now() };

      records.localPrs = records.localPrs.map((x) =>
        x.checkout === p.checkout && x.number === p.number ? next : x,
      );
      save();
      o.emitPr(next);

      return Promise.resolve({ ok: true, data: next });
    },
    discardBoard: (dir) => {
      const checkout = boardHeldAt(dir) ?? checkoutOf(dir);

      if (checkout === undefined) return refused('not-a-checkout', `${dir} is in no checkout`);
      const writes = records.held.filter((w) => w.checkout === checkout && isBoardWrite(w));
      const cards = records.heldCards.filter((c) => c.checkout === checkout);
      const done: BoardDiscardData = { checkout, writes: writes.length, cards: cards.length };

      if (writes.length === 0 && cards.length === 0) return { ok: true, data: done };
      records = {
        ...records,
        held: records.held.filter((w) => !writes.includes(w)),
        heldCards: records.heldCards.filter((c) => !cards.includes(c)),
      };
      save();
      o.emitDiscarded?.(done);

      return { ok: true, data: done };
    },
    rehome: (from, to) => {
      let n = 0;
      const follow = <T extends { checkout: string }>(r: T): T => {
        if (r.checkout !== from) return r;
        n += 1;

        return { ...r, checkout: to };
      };

      records = {
        ...records,
        held: records.held.map(follow),
        localPrs: records.localPrs.map(follow),
        localIssues: records.localIssues.map(follow),
        heldCards: records.heldCards.map(follow),
      };
      if (n > 0) save();
      const problem = o.settings === undefined ? undefined : rehomeLists(o.settings, from, to);

      return problem === undefined ? { records: n } : { records: n, problem };
    },
  };
};

/** Your Layer's checkout lists naming `from` name `to`; why not, if your Layer can't be read. */
const rehomeLists = (settings: SettingsService, from: string, to: string): string | undefined => {
  const own = individualFile(settings.places.configDir);

  if (!existsSync(own)) return undefined;
  const doc = readYamlFile(own);

  if ('error' in doc) return `${own}: ${doc.error}`;
  const lists = z
    .object({ localMode: z.array(z.string()), boardReadOnly: z.array(z.string()) })
    .partial()
    .safeParse(doc.doc).data;
  let next: unknown = doc.doc;
  let changed = false;

  for (const key of ['localMode', 'boardReadOnly'] as const) {
    const list = lists?.[key];

    if (list?.includes(from) !== true) continue;
    next = putEntry(next, key, { kind: 'plain', value: list.map((p) => (p === from ? to : p)) });
    changed = true;
  }
  if (changed) {
    writeYamlFile(own, next);
    settings.poll();
  }

  return undefined;
};

export type LocalCtx = {
  cwd: string;
  /** The session a request came from; none: the person. */
  session?: string | undefined;
  settings: SettingsService | undefined;
  serve: {
    localMode: LocalMode | undefined;
  };
};

/**
 * Your Layer's `localMode` with the checkout `cwd` is in put on or taken off. The last checkout
 * off drops the key, unless `keepKey`: your Layer had the key (an empty list) before.
 */
export const setLocal = (
  ctx: LocalCtx,
  on: boolean,
  keepKey = false,
): Outcome<{ checkout: string; on: boolean }> => {
  if (ctx.settings === undefined) return refused('no-settings', 'this abe serve reads no settings');
  const checkout = checkoutOf(ctx.cwd);

  if (checkout === undefined)
    return refused('not-a-checkout', `${ctx.cwd} is in no checkout: local mode is per checkout`);
  const own = individualFile(ctx.settings.places.configDir);
  const doc = readYamlFile(own);

  if ('error' in doc) return refused('bad-layer-file', `${own}: ${doc.error}`);
  const was = ctx.settings
    .at(checkout)
    .explain('localMode')
    .layers.find((l) => l.layer === 'individual')?.written;
  const list = z.array(z.string()).safeParse(was);

  const next = localModeWith(list.success ? list.data : [], checkout, on);

  mkdirSync(dirname(own), { recursive: true });
  // the last checkout off: the key goes, rather than staying as an empty list
  writeYamlFile(
    own,
    next.length === 0 && !keepKey
      ? dropEntry(doc.doc, 'localMode')
      : putEntry(doc.doc, 'localMode', { kind: 'plain', value: next }),
  );
  ctx.settings.poll();

  return { ok: true, data: { checkout, on } };
};

/**
 * Your Layer's `boardReadOnly` with the checkout `cwd` is in put on or taken off (the key kept as
 * an empty list when `keepKey`, as `setLocal`).
 */
export const setBoardReadOnly = (
  ctx: LocalCtx,
  on: boolean,
  keepKey = false,
): Outcome<BoardReadOnlyData> => {
  if (ctx.settings === undefined) return refused('no-settings', 'this abe serve reads no settings');
  const checkout = checkoutOf(ctx.cwd);

  if (checkout === undefined)
    return refused(
      'not-a-checkout',
      `${ctx.cwd} is in no checkout: a read-only board is per checkout`,
    );
  const own = individualFile(ctx.settings.places.configDir);
  const doc = readYamlFile(own);

  if ('error' in doc) return refused('bad-layer-file', `${own}: ${doc.error}`);
  const was = ctx.settings
    .at(checkout)
    .explain('boardReadOnly')
    .layers.find((l) => l.layer === 'individual')?.written;
  const list = z.array(z.string()).safeParse(was);

  const next = localModeWith(list.success ? list.data : [], checkout, on);

  mkdirSync(dirname(own), { recursive: true });
  // the last checkout off: the key goes, rather than staying as an empty list
  writeYamlFile(
    own,
    next.length === 0 && !keepKey
      ? dropEntry(doc.doc, 'boardReadOnly')
      : putEntry(doc.doc, 'boardReadOnly', { kind: 'plain', value: next }),
  );
  ctx.settings.poll();

  return {
    ok: true,
    data: { checkout, on, localMode: ctx.serve.localMode?.at(checkout) !== undefined },
  };
};

const noLocal = () => refused('no-local-mode', 'this abe serve keeps no local mode');

export const localHandlers = <Ctx extends LocalCtx>() =>
  ({
    'local status': (_, ctx) =>
      Promise.resolve(
        ctx.serve.localMode === undefined
          ? noLocal()
          : { ok: true, data: ctx.serve.localMode.view(ctx.cwd) },
      ),
    'local on': (_, ctx) => Promise.resolve(setLocal(ctx, true)),
    'local off': (_, ctx) => Promise.resolve(setLocal(ctx, false)),
    'local merge': async (args, ctx) => {
      if (ctx.serve.localMode === undefined) return noLocal();
      const merged = await ctx.serve.localMode.merge(ctx.cwd, args.pr);

      return merged.ok ? { ok: true, data: { pr: merged.data } } : merged;
    },
    'local discard': async (args, ctx) => {
      if (ctx.serve.localMode === undefined) return noLocal();
      const done = await ctx.serve.localMode.discard(ctx.cwd, args.pr);

      return done.ok ? { ok: true, data: { pr: done.data } } : done;
    },
    // a session may keep the board's writes here, never send them again
    'board read-only': (args, ctx) =>
      Promise.resolve(
        args.state === 'off' && ctx.session !== undefined
          ? refused(
              'not-in-session',
              'only a person makes the board writable again: abe board read-only off in Terminal',
            )
          : setBoardReadOnly(ctx, args.state === 'on'),
      ),
    'board discard': (_, ctx) =>
      Promise.resolve(
        ctx.serve.localMode === undefined ? noLocal() : ctx.serve.localMode.discardBoard(ctx.cwd),
      ),
  }) satisfies Partial<Handlers<Ctx>>;

/**
 * The checkout a write on a card is held for: its run's (`string`), none (the request's own), or
 * `several` where the request names no checkout and runs in more than one share the card's number.
 */
export type CardCheckout = string | { several: readonly string[] } | undefined;

/**
 * The board a write on a card goes through: held where that card's run's checkout has its board
 * read-only (local mode, or `boardReadOnly`; `dirOf`), else `other` (the board where the request
 * was typed, held there or not). Runs in several checkouts, one of them holding its board, and no
 * checkout named: the write is refused, never sent or held for the wrong one.
 */
export const cardRoutedBoard = (
  raw: Board,
  local: LocalMode,
  dirOf: (card: number) => CardCheckout,
  other: Board = raw,
): Board => {
  const refusing = (id: number, several: readonly string[]): Board => {
    const no = () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'rejected' as const,
          message: `AB#${id} has runs in ${several.join(' and ')}: type it in the checkout it is for`,
        },
      });

    return { ...other, comment: no, tag: no, move: no, assign: no, attach: no, write: no };
  };
  const on = (id: number) => {
    // a held card's own checkout when no run says one
    const dir = dirOf(id) ?? (isLocalNumber(id) ? local.heldCardAt(id) : undefined);

    if (typeof dir === 'object')
      return dir.several.some((d) => local.boardHeldAt(d) !== undefined)
        ? refusing(id, dir.several)
        : other;

    return dir !== undefined && local.boardHeldAt(dir) !== undefined
      ? local.board(raw, dir)
      : other;
  };

  return {
    list: (b, query) => other.list(b, query),
    currentSprint: (b) => other.currentSprint(b),
    changes: (b, since) => other.changes(b, since),
    image: (b, url) => other.image(b, url),
    members: (b) => other.members(b),
    me: (b) => other.me(b),
    create: (b, card) => other.create(b, card),
    show: (b, id) => on(id).show(b, id),
    comment: (b, id, markdown) => on(id).comment(b, id, markdown),
    tag: (b, id, change) => on(id).tag(b, id, change),
    move: (b, id, state) => on(id).move(b, id, state),
    assign: (b, id, who) => on(id).assign(b, id, who),
    attach: (b, id, file) => on(id).attach(b, id, file),
    write: (b, id, text) => on(id).write(b, id, text),
  };
};

/** What a handler that knows its repo needs to write where that repo says (#13, #24). */
export type RepoPortsCtx = {
  ports: {
    board: Board;
    /** The board held by `dir`'s local mode, else the board as it is (none: `board`). */
    boardAt?: ((dir: string) => Board) | undefined;
  };
  serve: {
    org: OrgStore | undefined;
    localMode?: LocalMode | undefined;
  };
};

/**
 * The board a write about `repo`'s card goes through: held where `repo`'s board is read-only
 * (local mode, or `boardReadOnly`),
 * wherever the request was typed (a prototype's own worktree, the app's folder).
 */
export const boardAt = (
  ctx: Pick<RepoPortsCtx, 'ports'> & { serve: Pick<RepoPortsCtx['serve'], 'localMode'> },
  repo: string,
): Board =>
  ctx.serve.localMode?.boardHeldAt(repo) !== undefined && ctx.ports.boardAt !== undefined
    ? ctx.ports.boardAt(repo)
    : ctx.ports.board;

/** The org store for `repo`: this Mac's own folder where `repo` is in local mode (#13, #24). */
export const orgAt = (
  ctx: {
    serve: {
      org?: OrgStore | undefined;
      localMode?: LocalMode | undefined;
    };
  },
  repo: string,
): OrgStore | undefined =>
  ctx.serve.localMode === undefined ? ctx.serve.org : ctx.serve.localMode.org(ctx.serve.org, repo);
