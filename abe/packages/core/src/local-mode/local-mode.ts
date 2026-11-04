/**
 * Local mode (#24, spec #19 stories 53–61): your setting per checkout (`localMode`, your Layer
 * alone). Abe reads the board, issues, pull requests, CI and deploys as usual but never writes:
 * each writing port is wrapped in a held one that records the write on this Mac and answers as if
 * it had happened. The pr stage opens a local pull request (`#L<n>`) instead, merged into the
 * local main or discarded by a person; a card is Done when its local pull request merges. Held
 * writes stay a record: turning local mode off sends none of them (decided: no Publish).
 *
 * The rules here are pure: which checkout a folder is in, the held decorators over the ports, the
 * records and the view `abe local status` serves. Where the records are kept is `serve`'s.
 */
import { z } from 'zod';
import {
  type Answered,
  type Board,
  type Git,
  type LayerPulls,
  type OrgStore,
  type Pipelines,
  type ReviewPort,
  type Tracking,
} from '../ports';
import {
  type BoardRef,
  CardData,
  type CardDetail,
  isDoneState,
  isLocalBoard,
  type Person,
} from '../board/board';
import { type IssueData, type MergeData, type PrData } from '../board/tracking';

export {
  cardName,
  isLocalNumber,
  localCardName,
  LOCAL_FLOOR,
  localCards,
  localCheckoutOf,
  localModeWith,
  localName,
  localNumber,
  localPrStat,
  localUrl,
  parseLocalName,
  withTags,
} from './local-names';
import {
  isLocalNumber,
  localCardName,
  localCards,
  localName,
  localNumber,
  localPrStat,
  localUrl,
  withTags,
} from './local-names';

/** Each kind of write a held port records: what would have gone to GitHub or the board. */
export const HELD_KINDS = [
  'card-move',
  'card-assign',
  'card-tag',
  'card-write',
  'card-comment',
  'card-create',
  'card-attach',
  'issue-create',
  'issue-comment',
  'push',
  'pr-create',
  'pr-update',
  'pr-merge',
  'pipeline-control',
  'pipeline-approve',
  'pipeline-run',
  'review-submit',
  'review-comment',
  'review-reply',
  'review-resolve',
  'review-request',
  'pr-ready',
  'pr-close',
  'pr-draft',
  'layer-propose',
] as const;
export const HeldKind = z.enum(HELD_KINDS);
export type HeldKind = z.infer<typeof HeldKind>;

/** A card's fields a held edit changed (`card-write`). */
export const CardEdit = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
});
export type CardEdit = z.infer<typeof CardEdit>;

/** What ⏎ on a held write opens: the local pull request, a file of what it would have sent, the card. */
export const HeldOpen = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-pr'), number: z.number().int().positive() }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('card'), id: z.number().int().positive() }),
]);
export type HeldOpen = z.infer<typeof HeldOpen>;

/** One held write: when, what, where it would have gone, and what ⏎ opens. */
export const HeldWrite = z.object({
  /** Rises by one per write held on this Mac. */
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  /** The checkout in local mode it was held for. */
  checkout: z.string(),
  kind: HeldKind,
  /** In words: `move AB#12 to Active`, `open pull request L1 "Sign in"`. */
  what: z.string(),
  /** Where it would have gone: `acme/demo on GitHub`, `Shop/Web on dev.azure.com/demo-org`. */
  where: z.string(),
  /** The card it touches, if any. */
  card: z.number().int().positive().nullable(),
  /** A card move's state, an assignment's assignee (`none`): the card's local state. */
  to: z.string().nullable(),
  open: HeldOpen.nullable(),
  /** A tag change's tags put on and taken off (`card-tag`): the Board shows them on the card. */
  tags: z.object({ add: z.array(z.string()), remove: z.array(z.string()) }).optional(),
  /** A comment's markdown (`card-comment`): the card shows it after the board's comments. */
  text: z.string().optional(),
  /** A field edit's fields (`card-write`): the card shows them over the board's. */
  fields: CardEdit.optional(),
});
export type HeldWrite = z.infer<typeof HeldWrite>;

export const LOCAL_PR_STATES = ['open', 'merged', 'discarded'] as const;

/** A file a local pull request changes, base to head: how, and its lines added and removed. */
export const LocalPrFile = z.object({
  path: z.string(),
  /** A rename's path before. */
  oldPath: z.string().optional(),
  status: z.enum(['A', 'M', 'D', 'R']),
  /** Lines added and removed; a binary file 0 and 0. */
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type LocalPrFile = z.infer<typeof LocalPrFile>;

/** One of a local pull request's commits, oldest first. */
export const LocalPrCommit = z.object({ sha: z.string(), subject: z.string() });
export type LocalPrCommit = z.infer<typeof LocalPrCommit>;

/** What a local pull request changes, read from git as it is opened or updated. */
export const LocalPrChanges = z.object({
  /** Where its head left its base (their merge base): the diff's left side. */
  baseSha: z.string(),
  files: z.array(LocalPrFile),
  commits: z.array(LocalPrCommit),
});
export type LocalPrChanges = z.infer<typeof LocalPrChanges>;
export type LocalPrState = (typeof LOCAL_PR_STATES)[number];

/** A local pull request: the pr stage's in local mode, merged into the local main or discarded. */
export const LocalPr = z.object({
  number: z.number().int().positive(),
  /** `L1`. */
  name: z.string(),
  checkout: z.string(),
  repo: z.string(),
  /** The card its body links (`AB#<id>`), if any. */
  card: z.number().int().positive().nullable(),
  head: z.string(),
  /** The head branch's commit when last opened or updated. */
  headSha: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
  /** The body as a file, what ⏎ opens. */
  file: z.string(),
  state: z.enum(LOCAL_PR_STATES),
  openedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Its squash commit on the local base, once merged. */
  mergeCommit: z.string().nullable(),
  /** Where its head left its base (`''`: not read): the diff's left side, `headSha` its right. */
  baseSha: z.string().default(''),
  /** The files it changes, base to head, with their lines added and removed. */
  files: z.array(LocalPrFile).default([]),
  /** Its commits on its head since its base, oldest first. */
  commits: z.array(LocalPrCommit).default([]),
});
export type LocalPr = z.infer<typeof LocalPr>;

/** An issue opened in local mode (a spec, its slices): kept here, never on GitHub. */
export const LocalIssue = z.object({
  number: z.number().int().positive(),
  checkout: z.string(),
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  parent: z.number().int().positive().nullable(),
  /** The body as a file, what ⏎ opens. */
  file: z.string(),
});
export type LocalIssue = z.infer<typeof LocalIssue>;

/** A card's state here over the board's (`Resolved here · GitHub: Active`): its last held move. */
export const LocalCard = z.object({
  card: z.number().int().positive(),
  /** The state its last held move set; null: none held. */
  state: z.string().nullable(),
  /** Its last held assignment (`me`, `none`, a login); null: none held. */
  assignee: z.string().nullable(),
  /** Tags its held tag changes put on, and took off, net (the board's tags under them). */
  added: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
  /** The fields its held edits changed (`title`, `description`, `acceptanceCriteria`). */
  edited: z.array(z.string()).optional(),
  /** Its held comments. */
  comments: z.number().int().nonnegative().optional(),
  at: z.iso.datetime(),
});
export type LocalCard = z.infer<typeof LocalCard>;

/**
 * `abe local status`: local mode where it was asked, the writes held for that checkout (newest
 * first), its local pull requests (newest first) and its cards' local states. What the band, the
 * badge, the dashed cards and the Held writes list are drawn from.
 */
export const LocalModeView = z.object({
  /** The checkout asked about (its top folder), or null outside one. */
  checkout: z.string().nullable(),
  on: z.boolean(),
  /**
   * The board's writes held here (its local changes): local mode is on, or you made the board
   * read-only alone (`abe board read-only on`). A board On this Mac is never held.
   */
  readOnlyBoard: z.boolean().optional(),
  held: z.array(HeldWrite),
  prs: z.array(LocalPr),
  cards: z.array(LocalCard),
});
export type LocalModeView = z.infer<typeof LocalModeView>;

/** The view of `checkout`'s records, newest first. */
export const localModeView = (o: {
  checkout: string | null;
  on: boolean;
  readOnlyBoard: boolean;
  held: readonly HeldWrite[];
  prs: readonly LocalPr[];
}): LocalModeView => {
  const held = o.held.filter((w) => w.checkout === o.checkout).sort((a, b) => b.seq - a.seq);

  return {
    checkout: o.checkout,
    on: o.on,
    readOnlyBoard: o.on || o.readOnlyBoard,
    held,
    prs: o.prs.filter((p) => p.checkout === o.checkout).sort((a, b) => b.number - a.number),
    cards: localCards(held),
  };
};

/** The card a pull request body links (`AB#<id>`), the first one. */
export const cardOfBody = (body: string): number | null => {
  const [, id] = /\bAB#([1-9][0-9]*)\b/.exec(body) ?? [];

  return id === undefined ? null : Number(id);
};

/** A local pull request as the Tracking port answers one: GitHub's shape, local in every part. */
export const localPrData = (p: LocalPr): PrData => ({
  repo: p.repo,
  number: p.number,
  title: p.title,
  body: p.body,
  url: localUrl(p.repo, p.number),
  state: p.state === 'discarded' ? 'closed' : p.state,
  draft: false,
  head: { ref: p.head, sha: p.headSha },
  base: { ref: p.base },
  mergeable: 'mergeable',
  // Its checks are the run's own, which ran here: none run on GitHub.
  checks: { state: 'none', runs: [] },
  mergeCommit: p.mergeCommit,
});

const localIssueData = (i: LocalIssue): IssueData => ({
  repo: i.repo,
  number: i.number,
  title: i.title,
  body: i.body,
  state: 'open',
  url: localUrl(i.repo, i.number),
  labels: i.labels,
  parent: null,
  subIssues: [],
});

/** A write to record: what it is in words, where it would have gone, what it would have sent. */
export type HoldInput = {
  kind: HeldKind;
  what: string;
  where: string;
  card?: number;
  to?: string;
  /** What it would have sent (markdown): kept as a file ⏎ opens. */
  body?: string;
  /** A file it would have uploaded (a card attachment): kept as that file. */
  file?: { name: string; bytes: Uint8Array };
  open?: HeldOpen;
  /** A tag change's tags (`card-tag`). */
  tags?: { add: string[]; remove: string[] };
  /** A comment's markdown (`card-comment`), shown on its card. */
  text?: string;
  /** A field edit's fields (`card-write`), shown on its card. */
  fields?: CardEdit;
};

/** A card made in local mode as it is first kept: all but its id, its url and its comments. */
export type HeldCardInput = Omit<CardData, 'id' | 'url'>;

/**
 * Where held writes go, for one checkout in local mode: `serve`'s records on this Mac. Every
 * method keeps what it is given; none reaches GitHub or the board.
 */
export type HeldStore = {
  record: (w: HoldInput) => Promise<HeldWrite>;
  issueCreate: (input: {
    repo: string;
    title: string;
    body: string;
    labels: readonly string[];
    parent: number | null;
  }) => Promise<LocalIssue>;
  issue: (number: number) => Promise<LocalIssue | undefined>;
  /** The open local pull request on `head`, if any. */
  prFind: (repo: string, head: string) => Promise<LocalPr | undefined>;
  pr: (number: number) => Promise<LocalPr | undefined>;
  prOpen: (input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<LocalPr>;
  prUpdate: (
    number: number,
    change: { body: string; title?: string },
  ) => Promise<LocalPr | undefined>;
  /** Merged into the local base (a squash commit on this Mac), or why not. */
  prMerge: (number: number) => Promise<Answered<LocalPr>>;
  /** The checkout's held writes, oldest first: the board's cards' held tags. */
  writes: () => Promise<HeldWrite[]>;
  /**
   * A card made in local mode (a held card), kept on this Mac: its id a local number (`LC<n>`),
   * its url `local:LC<n>`; no board ever has it.
   */
  cardCreate: (card: HeldCardInput) => Promise<CardDetail>;
  /** A held card of the checkout as it stands, with its comments. */
  card: (id: number) => Promise<CardDetail | undefined>;
  /** A held card changed (moved, assigned, tagged, edited, commented on): as it then stands. */
  cardChange: (
    id: number,
    change: (c: CardDetail) => CardDetail,
  ) => Promise<CardDetail | undefined>;
  /** The checkout's held cards, newest first. */
  cards: () => Promise<CardDetail[]>;
};

const gone = (what: string, number: number) => ({
  ok: false as const,
  error: { code: 'not-found' as const, message: `no local ${what} ${localName(number)}` },
});

const onGithub = (repo: string) => `${repo} on GitHub`;

/**
 * GitHub held (local mode): reads pass through, except local issues and pull requests, answered
 * from the records; every write is recorded and answered as if it had happened. `prFind` answers
 * only a local pull request, so the pr stage never updates one on GitHub.
 */
export const heldTracking = (inner: Tracking, hold: HeldStore): Tracking => ({
  ...inner,
  issueShow: async (ref) => {
    if (!isLocalNumber(ref.number)) return inner.issueShow(ref);
    const i = await hold.issue(ref.number);

    return i === undefined ? gone('issue', ref.number) : { ok: true, data: localIssueData(i) };
  },
  issueCreate: async (input) => {
    const i = await hold.issueCreate({
      repo: input.repo,
      title: input.title,
      body: input.body,
      labels: input.labels,
      parent: input.parent ?? null,
    });

    await hold.record({
      kind: 'issue-create',
      what: `open issue ${localName(i.number)} "${input.title}"`,
      where: onGithub(input.repo),
      open: { kind: 'file', path: i.file },
    });

    return { ok: true, data: localIssueData(i) };
  },
  issueComment: async (ref, body) => {
    const w = await hold.record({
      kind: 'issue-comment',
      what: `comment on ${isLocalNumber(ref.number) ? localName(ref.number) : `#${ref.number}`}`,
      where: onGithub(ref.repo),
      body,
    });

    return {
      ok: true,
      data: { repo: ref.repo, number: ref.number, id: w.seq, url: localUrl(ref.repo, ref.number) },
    };
  },
  prShow: async (ref) => {
    if (!isLocalNumber(ref.number)) return inner.prShow(ref);
    const p = await hold.pr(ref.number);

    return p === undefined ? gone('pull request', ref.number) : { ok: true, data: localPrData(p) };
  },
  prFind: async ({ repo, head }) => {
    const p = await hold.prFind(repo, head);

    return { ok: true, data: p === undefined ? null : localPrData(p) };
  },
  prCreate: async (input) => {
    const p = await hold.prOpen(input);

    await hold.record({
      kind: 'pr-create',
      what: `open pull request ${p.name} "${input.title}" (${input.head} → ${input.base})`,
      where: onGithub(input.repo),
      ...(p.card === null ? {} : { card: p.card }),
      open: { kind: 'local-pr', number: p.number },
    });

    return { ok: true, data: localPrData(p) };
  },
  prUpdate: async (ref, change) => {
    if (!isLocalNumber(ref.number)) {
      const read = await inner.prShow(ref);

      await hold.record({
        kind: 'pr-update',
        what: `update pull request #${ref.number}`,
        where: onGithub(ref.repo),
        body: change.body,
      });

      return read.ok
        ? {
            ok: true,
            data: { ...read.data, body: change.body, title: change.title ?? read.data.title },
          }
        : read;
    }
    const p = await hold.prUpdate(ref.number, change);

    if (p === undefined) return gone('pull request', ref.number);
    await hold.record({
      kind: 'pr-update',
      what: `update pull request ${p.name}`,
      where: onGithub(ref.repo),
      ...(p.card === null ? {} : { card: p.card }),
      open: { kind: 'local-pr', number: p.number },
    });

    return { ok: true, data: localPrData(p) };
  },
  prMerge: async (ref, how) => {
    if (!isLocalNumber(ref.number)) {
      await hold.record({
        kind: 'pr-merge',
        what: `merge pull request #${ref.number} (${how.method})`,
        where: onGithub(ref.repo),
      });

      return {
        ok: false,
        error: {
          code: 'gh-failed',
          message: `local mode: pull request #${ref.number} on GitHub is not merged from this machine (the merge is held)`,
        },
      };
    }
    const merged = await hold.prMerge(ref.number);

    if (!merged.ok)
      return { ok: false, error: { code: 'gh-failed', message: merged.error.message } };
    const p = merged.data;
    const data: MergeData = {
      repo: ref.repo,
      number: ref.number,
      merged: true,
      sha: p.mergeCommit ?? '',
    };

    await hold.record({
      kind: 'pr-merge',
      what: `merge pull request ${p.name} into ${p.base}`,
      where: onGithub(ref.repo),
      ...(p.card === null ? {} : { card: p.card }),
      open: { kind: 'local-pr', number: p.number },
    });

    return { ok: true, data };
  },
  prReviews: (ref) =>
    isLocalNumber(ref.number) ? Promise.resolve({ ok: true, data: [] }) : inner.prReviews(ref),
});

const onBoard = (b: { organization: string; project: string; team: string }) =>
  `${b.project}/${b.team} on ${b.organization.replace(/^https:\/\//, '')}`;

const tagWords = (change: { add: readonly string[]; remove: readonly string[] }) =>
  `${change.add.length === 0 ? '' : ` +${change.add.join(' +')}`}${change.remove.length === 0 ? '' : ` -${change.remove.join(' -')}`}`;

const samePerson = (a: Person | null, b: Person): boolean =>
  a !== null &&
  (a.email !== '' && b.email !== ''
    ? a.email.toLowerCase() === b.email.toLowerCase()
    : a.name === b.name);

/** `AB#12`, or a held card's `LC3`. */
const cardRef = (id: number) => (isLocalNumber(id) ? localCardName(id) : `AB#${id}`);

/** The fields `held`'s edits of `card` set, the later over the earlier. */
const editsOf = (held: readonly HeldWrite[], card: number): CardEdit =>
  held
    .filter((w) => w.card === card && w.kind === 'card-write' && w.fields !== undefined)
    .sort((a, b) => a.seq - b.seq)
    .reduce<CardEdit>((all, w) => ({ ...all, ...w.fields }), {});

/** Who a held comment is by, as the card shows it: the person, here. */
const HELD_BY = 'you (held here)';

/**
 * The board held (local mode, or the board read-only alone): its local changes, drawn over the
 * real cards and never sent. Reads pass through, each card with its held tag changes and field
 * edits on and its held comments after the board's; a move, assignment, tag, edit, comment, new
 * card or attachment is recorded and answered as if made (the card as the board reads it, the
 * change on it). A new card is a held card (`LC<n>`, kept here): listed beside the board's,
 * read, moved, tagged, edited, commented on and launched as one, every write on it held too. A
 * board On this Mac (`isLocalBoard`) is not held: nothing of it would leave this Mac.
 */
export const heldBoard = (inner: Board, hold: HeldStore): Board => {
  /** The board's cards with their held tags and edits on. */
  const tagged = async <C extends CardData>(cards: readonly C[]): Promise<C[]> => {
    const held = await hold.writes();
    const local = localCards(held);

    return cards.map((c) => {
      const l = local.find((x) => x.card === c.id);

      if (l === undefined) return c;
      const tags =
        l.added.length === 0 && l.removed.length === 0
          ? c.tags
          : withTags(c.tags, { add: l.added, remove: l.removed });

      return (l.edited ?? []).length === 0
        ? { ...c, tags }
        : { ...c, tags, ...editsOf(held, c.id) };
    });
  };
  /** A card's held comments, oldest first, after the board's. */
  const heldComments = async (id: number) =>
    (await hold.writes())
      .filter((w) => w.card === id && w.kind === 'card-comment' && w.text !== undefined)
      .sort((a, b) => a.seq - b.seq)
      .map((w) => ({ id: w.seq, text: w.text ?? '', by: HELD_BY, at: w.at }));
  const gone = (id: number) => ({
    ok: false as const,
    error: { code: 'not-found' as const, message: `no held card ${localCardName(id)} here` },
  });
  /** The card as read now with `change` on it: what the write would have answered. */
  const asIf = async (
    board: Parameters<Board['show']>[0],
    id: number,
    change: (c: CardData) => CardData,
  ) => {
    if (isLocalNumber(id)) {
      const c = await hold.cardChange(id, (d) => ({ ...d, ...change(d) }));

      return c === undefined ? gone(id) : { ok: true as const, data: CardData.parse(c) };
    }
    const read = await inner.show(board, id);

    if (!read.ok) return read;
    const [card] = await tagged([CardData.parse(read.data)]);

    return { ok: true as const, data: change(card ?? CardData.parse(read.data)) };
  };

  const held: Board = {
    ...inner,
    list: async (board, query) => {
      const read = await inner.list(board, query);

      if (!read.ok) return read;
      const me = query.mine ? await inner.me(board) : undefined;
      const made = (await hold.cards()).filter((c) => {
        if (c.state === 'Removed' || (query.done === undefined && isDoneState(c.state)))
          return false;
        if (!query.mine) return true;

        return me?.ok === true && samePerson(c.assignee, me.data);
      });

      return {
        ok: true,
        data: [...made.map((c) => CardData.parse(c)), ...(await tagged(read.data))],
      };
    },
    show: async (board, id) => {
      if (isLocalNumber(id)) {
        const c = await hold.card(id);

        return c === undefined ? gone(id) : { ok: true, data: c };
      }
      const read = await inner.show(board, id);

      if (!read.ok) return read;
      const [card] = await tagged([read.data]);
      const shown = card ?? read.data;

      return {
        ok: true,
        data: { ...shown, comments: [...shown.comments, ...(await heldComments(id))] },
      };
    },
    move: async (board, id, state) => {
      await hold.record({
        kind: 'card-move',
        what: `move ${cardRef(id)} to ${state}`,
        where: onBoard(board),
        card: id,
        to: state,
        open: { kind: 'card', id },
      });

      return asIf(board, id, (c) => ({ ...c, state }));
    },
    assign: async (board, id, who) => {
      const to = who.kind === 'member' ? who.login : who.kind;
      const me = who.kind === 'me' ? await inner.me(board) : undefined;

      await hold.record({
        kind: 'card-assign',
        what: `assign ${cardRef(id)} to ${to}`,
        where: onBoard(board),
        card: id,
        to,
        open: { kind: 'card', id },
      });

      const yours = (c: CardData) => (me?.ok === true ? me.data : c.assignee);
      const member = who.kind === 'member' ? { name: who.login, email: who.login } : undefined;

      return asIf(board, id, (c) => ({
        ...c,
        assignee: who.kind === 'none' ? null : (member ?? yours(c)),
      }));
    },
    tag: async (board, id, change) => {
      await hold.record({
        kind: 'card-tag',
        what: `tag ${cardRef(id)}${tagWords(change)}`,
        where: onBoard(board),
        card: id,
        open: { kind: 'card', id },
        tags: { add: [...change.add], remove: [...change.remove] },
      });

      // a held card's tags are its own; the board's under the held ones already for the others
      return isLocalNumber(id)
        ? asIf(board, id, (c) => ({ ...c, tags: withTags(c.tags, change) }))
        : asIf(board, id, (c) => c);
    },
    write: async (board, id, text) => {
      await hold.record({
        kind: 'card-write',
        what: `edit ${cardRef(id)}: ${Object.keys(text).join(', ')}`,
        where: onBoard(board),
        card: id,
        body: [text.title, text.description, text.acceptanceCriteria]
          .filter((t) => t !== undefined)
          .join('\n\n'),
        fields: text,
      });

      return asIf(board, id, (c) => ({ ...c, ...text }));
    },
    comment: async (board, id, markdown) => {
      const w = await hold.record({
        kind: 'card-comment',
        what: `comment on ${cardRef(id)}`,
        where: onBoard(board),
        card: id,
        body: markdown,
        // a held card keeps its comments itself
        ...(isLocalNumber(id) ? {} : { text: markdown }),
      });
      const data = { card: id, id: w.seq, text: markdown, by: HELD_BY, at: w.at };

      if (isLocalNumber(id)) {
        const c = await hold.cardChange(id, (d) => ({
          ...d,
          comments: [...d.comments, { id: data.id, text: data.text, by: data.by, at: data.at }],
        }));

        if (c === undefined) return gone(id);
      }

      return { ok: true, data };
    },
    create: async (board, card) => {
      // its maker, as a board says who made a card; and assigned to them when asked
      const you = await inner.me(board);
      const made = await hold.cardCreate({
        title: card.title,
        state: card.state ?? 'New',
        type: card.type ?? board.types[0] ?? 'User Story',
        tags: [...(card.tags ?? [])],
        assignee: card.assignee === 'me' && you.ok ? you.data : null,
        description: card.description,
        acceptanceCriteria: card.acceptanceCriteria,
        points: null,
        createdBy: you.ok ? you.data : null,
      });

      await hold.record({
        kind: 'card-create',
        what: `new card ${localCardName(made.id)} "${card.title}"`,
        where: onBoard(board),
        card: made.id,
        body: [card.title, card.description, card.acceptanceCriteria].join('\n\n'),
        open: { kind: 'card', id: made.id },
      });

      return { ok: true, data: CardData.parse(made) };
    },
    attach: async (board, id, file) => {
      const w = await hold.record({
        kind: 'card-attach',
        what: `attach ${file.name} to ${cardRef(id)}`,
        where: onBoard(board),
        card: id,
        file,
      });

      return {
        ok: true,
        data: { url: w.open?.kind === 'file' ? `file://${w.open.path}` : `local:${file.name}` },
      };
    },
  };
  /** A board On this Mac answers itself. */
  const by = (b: BoardRef): Board => (isLocalBoard(b) ? inner : held);

  return {
    list: (b, query) => by(b).list(b, query),
    currentSprint: (b) => by(b).currentSprint(b),
    changes: (b, since) => by(b).changes(b, since),
    show: (b, id) => by(b).show(b, id),
    image: (b, url) => by(b).image(b, url),
    comment: (b, id, markdown) => by(b).comment(b, id, markdown),
    tag: (b, id, change) => by(b).tag(b, id, change),
    move: (b, id, state) => by(b).move(b, id, state),
    assign: (b, id, who) => by(b).assign(b, id, who),
    members: (b) => by(b).members(b),
    me: (b) => by(b).me(b),
    create: (b, card) => by(b).create(b, card),
    attach: (b, id, file) => by(b).attach(b, id, file),
    write: (b, id, text) => by(b).write(b, id, text),
  };
};

/** A worktree's git held (local mode): the push is recorded, never sent; reads and local work pass. */
export const heldGit = (inner: Git, hold: HeldStore): Git => ({
  ...inner,
  push: async (worktree, branch) => {
    await hold.record({
      kind: 'push',
      what: `push ${branch}`,
      where: `origin of ${worktree}`,
    });

    return { ok: true, data: null };
  },
});

/**
 * VimStorm's PR review held (local mode): reviews, inline comments, replies, resolves, review
 * requests, ready, close and Draft PRs recorded, never sent; reads and the local docs pass.
 */
export const heldReview = (inner: ReviewPort, hold: HeldStore): ReviewPort => {
  const ok = { ok: true as const, data: null };

  return {
    ...inner,
    submit: async (repo, review) => {
      await hold.record({
        kind: 'review-submit',
        what: `review #${review.pr} (${review.verdict}, ${review.comments.length} comments)`,
        where: onGithub(repo),
        ...(review.body === undefined ? {} : { body: review.body }),
      });

      return ok;
    },
    postComment: async (input) => {
      await hold.record({
        kind: 'review-comment',
        what: `comment on #${input.number}`,
        where: onGithub(input.repo),
        body: input.comment.body,
      });

      return ok;
    },
    reply: async (input) => {
      await hold.record({
        kind: 'review-reply',
        what: `reply on #${input.number}`,
        where: onGithub(input.repo),
        body: input.body,
      });

      return ok;
    },
    resolve: async (thread, resolved) => {
      await hold.record({
        kind: 'review-resolve',
        what: `${resolved ? 'resolve' : 'unresolve'} thread ${thread}`,
        where: 'GitHub',
      });

      return ok;
    },
    requestReviewers: async (repo, number, logins) => {
      await hold.record({
        kind: 'review-request',
        what: `ask ${logins.join(', ')} to review #${number}`,
        where: onGithub(repo),
      });

      return ok;
    },
    ready: async (repo, number) => {
      await hold.record({
        kind: 'pr-ready',
        what: `#${number} out of draft`,
        where: onGithub(repo),
      });

      return ok;
    },
    close: async (repo, number) => {
      await hold.record({ kind: 'pr-close', what: `close #${number}`, where: onGithub(repo) });

      return ok;
    },
    say: async (repo, number, body) => {
      await hold.record({
        kind: 'review-comment',
        what: `comment on #${number}'s conversation`,
        where: onGithub(repo),
        body,
      });

      return ok;
    },
    draftCreate: async (input) => {
      const w = await hold.record({
        kind: 'pr-draft',
        what: `draft pull request "${input.title}" (→ ${input.base})${input.push ? ', pushed' : ''}`,
        where: 'GitHub',
        body: input.body,
      });
      const number = localNumber(w.seq);

      return { ok: true, data: { number, url: `local:${localName(number)}` } };
    },
  };
};

/** A Layer's pull request held (local mode): the proposal recorded, never sent; reads pass. */
export const heldLayerPulls = (inner: LayerPulls, hold: HeldStore): LayerPulls => ({
  ...inner,
  propose: async (input) => {
    const w = await hold.record({
      kind: 'layer-propose',
      what: `propose "${input.title}" (${input.files.map((f) => f.path).join(', ')})`,
      where: onGithub(input.repo),
      body: input.body,
    });
    const number = localNumber(w.seq);

    return { ok: true, data: { number, url: localUrl(input.repo, number) } };
  },
});

/** Pipelines held (local mode): reruns, cancels, approvals and workflow runs recorded, never sent. */
export const heldPipelines = (inner: Pipelines, hold: HeldStore): Pipelines => {
  const where = (s: Parameters<Pipelines['runs']>[0]) =>
    s.provider === 'github-actions'
      ? `${s.repo} on GitHub Actions`
      : `${s.project} on Azure Pipelines`;

  return {
    ...inner,
    control: async (source, id, attempt, control) => {
      await hold.record({
        kind: 'pipeline-control',
        what: `${control} run ${id} (attempt ${attempt})`,
        where: where(source),
      });

      return { ok: true, data: null };
    },
    approve: async (source, run, gate) => {
      await hold.record({
        kind: 'pipeline-approve',
        what: `approve run ${run} at ${gate.environment}`,
        where: where(source),
      });

      return { ok: true, data: null };
    },
    dispatch: async (source, file, ref, inputs) => {
      const given = Object.entries(inputs).map(([k, v]) => `${k}=${v}`);

      await hold.record({
        kind: 'pipeline-run',
        what: `run ${file} on ${ref}${given.length === 0 ? '' : ` with ${given.join(' ')}`}`,
        where: where(source),
      });

      return { ok: true, data: null };
    },
  };
};

/** `abe local merge` / `discard`: the local pull request as it now stands. */
export const LocalPrData = z.object({ pr: LocalPr });
export type LocalPrData = z.infer<typeof LocalPrData>;

/** `abe local on` / `off`: the checkout and whether local mode is on there now. */
export const LocalSetData = z.object({ checkout: z.string(), on: z.boolean() });
export type LocalSetData = z.infer<typeof LocalSetData>;

export const localStatusText = (v: LocalModeView): string => {
  if (v.checkout === null) return 'not in a checkout: local mode is per checkout\n';
  const head = `local mode ${v.on ? 'on' : 'off'} · ${v.checkout}`;
  const prs = v.prs.map(
    (p) =>
      `  ${p.name.padEnd(5)} ${p.state.padEnd(9)} ${p.title} (${p.head} → ${p.base})${p.files.length === 0 ? '' : ` · ${localPrStat(p)}`}`,
  );
  const held = v.held.map((w) => `  ${w.at}  ${w.what} · ${w.where}`);

  return `${[
    head,
    ...(prs.length === 0 ? [] : ['pull requests', ...prs]),
    ...(held.length === 0 ? ['nothing held'] : [`held writes (${held.length})`, ...held]),
  ].join('\n')}\n`;
};

/** `abe board read-only on` / `off`: the checkout and whether its board is read-only now. */
export const BoardReadOnlyData = z.object({
  checkout: z.string(),
  on: z.boolean(),
  /** Local mode is on there: the board stays read-only whatever this says. */
  localMode: z.boolean(),
});
export type BoardReadOnlyData = z.infer<typeof BoardReadOnlyData>;

export const boardReadOnlyText = (d: BoardReadOnlyData): string =>
  `board read-only ${d.on ? 'on' : 'off'} · ${d.checkout}${
    !d.on && d.localMode ? ' (local mode is on: the board stays read-only)' : ''
  }${d.on || d.localMode ? '' : ' (its local changes stay until you discard them; none is sent)'}\n`;

/**
 * `abe board discard` (Discard local changes): the checkout's board changes held on this Mac
 * dropped, the held writes on cards and the held cards (`LC<n>`); the board shows as it is.
 */
export const BoardDiscardData = z.object({
  checkout: z.string(),
  /** The held writes on cards dropped. */
  writes: z.number().int().nonnegative(),
  /** The held cards dropped. */
  cards: z.number().int().nonnegative(),
});
export type BoardDiscardData = z.infer<typeof BoardDiscardData>;

export const boardDiscardText = (d: BoardDiscardData): string =>
  d.writes === 0 && d.cards === 0
    ? `no local changes to the board in ${d.checkout}\n`
    : `discarded ${d.writes} local change${d.writes === 1 ? '' : 's'}${
        d.cards === 0 ? '' : ` and ${d.cards} card${d.cards === 1 ? '' : 's'} made here`
      } · ${d.checkout}: the board shows as it is\n`;

/** The held writes Discard local changes drops: those on the board (a card's). */
export const isBoardWrite = (w: Pick<HeldWrite, 'kind'>): boolean => w.kind.startsWith('card-');

export const localPrText = (d: LocalPrData): string =>
  `${d.pr.name} ${d.pr.state}${d.pr.mergeCommit === null ? '' : ` · ${d.pr.base} at ${d.pr.mergeCommit.slice(0, 7)}`} · ${d.pr.title}\n`;

export const localSetText = (d: LocalSetData): string =>
  `local mode ${d.on ? 'on' : 'off'} · ${d.checkout}${d.on ? '' : ' (held writes stay a record; none is sent)'}\n`;

/**
 * The org store held (local mode): a write lands in `local` (a folder on this Mac), never in the
 * org's shared store, so a prototype made here is no teammate's. A read takes `local`'s object
 * first and the org's (`inner`, none without `$ABE_ORG_STORE`) otherwise; a listing is both, a
 * key in each named once. Without an org store local mode still keeps prototypes.
 */
export const heldOrgStore = (inner: OrgStore | undefined, local: OrgStore): OrgStore => ({
  put: (key, body, contentType) => local.put(key, body, contentType),
  get: async (key) => {
    const here = await local.get(key);

    return here.ok || inner === undefined || here.error.code !== 'not-found'
      ? here
      : inner.get(key);
  },
  list: async (prefix) => {
    const here = await local.list(prefix);

    if (!here.ok || inner === undefined) return here;
    const there = await inner.list(prefix);

    if (!there.ok) return here;
    const keys = new Set(here.data.map((o) => o.key));

    return {
      ok: true,
      data: [...here.data, ...there.data.filter((o) => !keys.has(o.key))].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    };
  },
});

/**
 * What a session on a read-only board is refused of its own tools: Azure Boards' writes, typed as a
 * command. Local mode refuses them too (`LOCAL_MODE_DENY`); a checkout in `boardReadOnly` alone
 * is refused these and nothing else. `az boards work-item show` passes.
 */
export const BOARD_WRITE_DENY = [
  'Bash(az boards work-item create:*)',
  'Bash(az boards work-item update:*)',
  'Bash(az boards work-item delete:*)',
  'Bash(az boards work-item relation:*)',
] as const;

/**
 * What a session launched in local mode is refused of its own tools (Claude Code's deny rules,
 * as a Developer prototype's are): a push, a pull request's or issue's write, a label, a release,
 * a run, a write through `gh api` and Azure Boards' or Repos' writes, typed as a command: its work
 * stays on this Mac. aws is the enabled environments' (ADR 0029). Its `abe` commands are held by serve already; reads (`gh pr view`, `git fetch`, `az
 * boards work-item show`) pass. The sandbox reaches no AWS or Azure host anyway; a script that
 * writes on its own is not stopped: the refusal keeps an agent from shipping by mistake.
 */
export const LOCAL_MODE_DENY = [
  'Bash(git push:*)',
  'Bash(git * push)',
  'Bash(git * push *)',
  ...['create', 'comment', 'merge', 'review', 'edit', 'close', 'reopen', 'ready'].map(
    (verb) => `Bash(gh pr ${verb}:*)`,
  ),
  ...['create', 'comment', 'edit', 'close', 'reopen', 'delete', 'transfer', 'develop'].map(
    (verb) => `Bash(gh issue ${verb}:*)`,
  ),
  ...['create', 'edit', 'delete', 'clone'].map((verb) => `Bash(gh label ${verb}:*)`),
  ...['create', 'edit', 'upload', 'delete'].map((verb) => `Bash(gh release ${verb}:*)`),
  'Bash(gh repo create:*)',
  'Bash(gh repo edit:*)',
  'Bash(gh repo delete:*)',
  'Bash(gh workflow run:*)',
  'Bash(gh run rerun:*)',
  'Bash(gh run cancel:*)',
  ...[
    'create',
    'edit',
    'delete',
    'close',
    'copy',
    'link',
    'unlink',
    'item-add',
    'item-create',
    'item-edit',
    'item-delete',
    'item-archive',
    'field-create',
    'field-delete',
  ].map((verb) => `Bash(gh project ${verb}:*)`),
  ...['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].flatMap((flag) => [
    `Bash(gh api ${flag}:*)`,
    `Bash(gh api * ${flag} *)`,
  ]),
  ...BOARD_WRITE_DENY,
  ...['create', 'update', 'set-vote', 'reviewer', 'work-item'].map(
    (verb) => `Bash(az repos pr ${verb}:*)`,
  ),
  'Bash(az pipelines run:*)',
  ...[
    ['az rest', '--method'],
    ['az rest', '-m'],
    ['az rest', '--body'],
    ['az rest', '-b'],
    ['az devops invoke', '--http-method'],
    ['az devops invoke', '--in-file'],
  ].flatMap(([cmd, flag]) => [`Bash(${cmd} ${flag}:*)`, `Bash(${cmd} * ${flag} *)`]),
] as const;

/** A session launched in local mode runs with these: Claude Code sends no telemetry or error reports. */
export const LOCAL_MODE_ENV = { DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' } as const;
