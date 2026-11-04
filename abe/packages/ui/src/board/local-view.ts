/**
 * Local mode on the Factory view. What `abe local status` says (`LocalModeView`), kept current by
 * `local.held`, `local.pr` and `local.discarded`, drawn as the band over the Board (also for a
 * board read-only alone), a card's state here over the board's (dashed), the toolbar's dashed
 * badge, the Held writes list and Discard local changes. A local pull request in the Board's place
 * is its own mode, `local-pr.ts`, drawn with `localPrNode`.
 */
import type {
  BoardDiscardData,
  CardData,
  FactoryRunData,
  HeldWrite,
  LocalModeView,
  LocalPr,
} from '@abe/core';
import {
  isLocalNumber,
  localCards,
  localCheckoutOf,
  localName,
  localPrStat,
} from '@abe/core/local-names';
import { screenWhen } from '@abe/core/when';
import type { Command, Confirm, Hue, Menu, MenuRow } from '../runtime/runtime';
import { type LocalBand, type LocalCheck, type LocalPullRequest } from './local-components';
import { type Workspaces } from './workspaces';

/** What the Factory view holds of local mode. */
export type LocalState = {
  /** `abe local status` as last read, changed in place by `local.held` and `local.pr`. */
  view?: LocalModeView | undefined;
};

/** Its read's id and argv (in the shown folder: its checkout). */
export const LOCAL_READ = 'local';
export const LOCAL_ARGV: readonly string[] = ['local', 'status'];

/** The Held writes list's menu id; a row is `held:<seq>`. */
export const LOCAL_HELD_MENU = 'local:held';
const HELD_ROW = 'held:';

/** The band's links (`LocalBand`) and the toolbar badge's id: each opens what it names. */
export const LOCAL_HELD_CLICK = 'local:held';
export const LOCAL_SETTINGS_CLICK = 'local:settings';
/** The band's Discard local changes: asked first (`discardLocalConfirm`). */
export const LOCAL_DISCARD_CLICK = 'local:discard';
export const LOCAL_BADGE_CLICK = 'toolbar:local';

/** px the band takes over the Board (30 high, 6 under it). */
export const BAND_HEIGHT = 36;

export const localOn = (l: LocalState | undefined): boolean => l?.view?.on === true;

/** The board read-only alone (`abe board read-only on`), local mode off: its own band. */
export const readOnlyAlone = (v: LocalModeView | undefined): boolean =>
  v?.on !== true && v?.readOnlyBoard === true;

/** A band over the Board: local mode on, or the board read-only alone. */
export const bandShown = (l: LocalState | undefined): boolean =>
  localOn(l) || readOnlyAlone(l?.view);

/** The board's local changes held here: the held writes on its cards (`card-*`), newest first. */
export const boardChanges = (v: LocalModeView): HeldWrite[] =>
  v.held.filter((w) => w.kind.startsWith('card-'));

/** `local status` answered. */
export const localRead = (l: LocalState | undefined, view: LocalModeView): LocalState => ({
  ...l,
  view,
});

/** `local.held`: this checkout's write, newest first, each card's local state again. */
export const localHeld = (l: LocalState | undefined, w: HeldWrite): LocalState | undefined => {
  const v = l?.view;

  if (v === undefined || v.checkout === null || w.checkout !== v.checkout) return l;
  const held = [w, ...v.held.filter((x) => x.seq !== w.seq)].sort((a, b) => b.seq - a.seq);

  return { ...l, view: { ...v, held, cards: localCards(held) } };
};

/**
 * `local.discarded`: this checkout's board changes dropped, its cards' local state with them.
 * `true` when it is this checkout's (the Board reads `local status` and its cards again).
 */
export const localDiscarded = (
  l: LocalState | undefined,
  d: BoardDiscardData,
): { state: LocalState | undefined; ours: boolean } => {
  const v = l?.view;

  if (v === undefined || v.checkout === null || d.checkout !== v.checkout)
    return { state: l, ours: false };
  const held = v.held.filter((w) => !w.kind.startsWith('card-'));

  return { state: { ...l, view: { ...v, held, cards: localCards(held) } }, ours: true };
};

/** `local.pr`: this checkout's local pull request opened, updated, merged or discarded. */
export const localPrMoved = (l: LocalState | undefined, p: LocalPr): LocalState | undefined => {
  const v = l?.view;

  if (v === undefined || v.checkout === null || p.checkout !== v.checkout) return l;
  const prs = [p, ...v.prs.filter((x) => x.number !== p.number)].sort(
    (a, b) => b.number - a.number,
  );

  return { ...l, view: { ...v, prs } };
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The checkout's folder name (`demo-shop`). */
const checkoutName = (v: LocalModeView): string =>
  v.checkout === null
    ? 'this folder'
    : (v.checkout
        .split('/')
        .filter((p) => p !== '')
        .pop() ?? v.checkout);

/** `N local changes`: the board's changes held here, as the band and `:` count them. */
const changesWords = (n: number): string => (n === 0 ? 'Local changes' : plural(n, 'local change'));

/**
 * The band over the Board while local mode is on, or the board read-only alone
 * (its lead `Read-only board`); Discard local changes while any board change is held.
 */
export const localBand = (v: LocalModeView): LocalBand => {
  const changes = boardChanges(v).length;
  const discard =
    changes === 0 ? [] : [{ id: LOCAL_DISCARD_CLICK, label: 'Discard local changes' }];
  const settings = { id: LOCAL_SETTINGS_CLICK, label: 'Settings' };

  return {
    kind: 'LocalBand',
    id: 'local-band',
    props: v.on
      ? {
          lead: 'Local mode',
          text: 'the board, issues and CI are read as usual; writes stay on this machine, agents run here.',
          links: [
            {
              id: LOCAL_HELD_CLICK,
              label: v.held.length === 0 ? 'Held writes' : plural(v.held.length, 'held write'),
            },
            ...discard,
            settings,
          ],
        }
      : {
          lead: 'Read-only board',
          text: 'the board is read as usual; your changes stay on this machine, drawn over its cards, never sent.',
          links: [{ id: LOCAL_HELD_CLICK, label: changesWords(changes) }, ...discard, settings],
        },
  };
};

/**
 * Discard local changes, asked first: the board changes held here dropped, the cards made here
 * with them; nothing is sent (`abe board discard`).
 */
export const discardLocalConfirm = (v: LocalModeView): Confirm => {
  const changes = boardChanges(v);
  const made = changes.filter((w) => w.kind === 'card-create').length;

  return {
    kind: 'confirm',
    question: 'Discard local changes to the board?',
    details: [
      `${plural(changes.length, 'change')}${made === 0 ? '' : ` and ${plural(made, 'card')} made here`} dropped from this machine.`,
      'The board then shows as it is. Nothing is sent.',
    ],
    yes: 'Discard local changes',
    no: 'Keep them',
    argv: ['board', 'discard'],
    done: 'Local changes discarded',
  };
};

/** A board On this Mac's organization (core's `LOCAL_BOARD_ORG`): its cards are its own. */
export const THIS_MAC = 'this machine';

/**
 * Who the board is, as a card's dashed line says it: `GitHub`, `Azure`, else `board`. A board On
 * this Mac (`THIS_MAC`) has no dashed line: nothing of it is held.
 */
export const boardName = (organization: string | undefined): string => {
  if (organization === undefined) return 'board';
  if (/github/i.test(organization)) return 'GitHub';

  return /azure|visualstudio/i.test(organization) ? 'Azure' : 'board';
};

/**
 * A card's state here over the board's: `Resolved here · GitHub: Active`, while a held
 * move put it elsewhere than the board says (then what else is held on it: `· edited`); else
 * the tags a held change put on or took off, a held edit and held comments (`+prototype, edited,
 * 2 comments here · not on Azure`); a held card (made here, `LC<n>`) `New here · not on Azure`;
 * none once the board says the same (or none held).
 */
export const cardLocal = (
  v: LocalModeView | undefined,
  card: Pick<CardData, 'id' | 'state'>,
  board: string,
): string | undefined => {
  if (isLocalNumber(card.id)) return `${card.state} here · not on ${board}`;
  const l = v?.cards.find((c) => c.card === card.id);
  const here = l?.state ?? null;

  const tags = [...(l?.added ?? []).map((t) => `+${t}`), ...(l?.removed ?? []).map((t) => `−${t}`)];
  const comments = l?.comments ?? 0;
  const more = [
    ...(tags.length === 0 ? [] : [tags.join(' ')]),
    ...((l?.edited ?? []).length === 0 ? [] : ['edited']),
    ...(comments === 0 ? [] : [plural(comments, 'comment')]),
  ].join(', ');

  if (here !== null && here !== card.state)
    return `${here} here · ${board}: ${card.state}${more === '' ? '' : ` · ${more}`}`;

  return more === '' ? undefined : `${more} here · not on ${board}`;
};

/**
 * A held write the Board's cards show: a held card made or written, a held tag or edit.
 * The card lists are read again for it (serve lists them with the board's).
 */
export const heldOnBoard = (w: HeldWrite): boolean =>
  w.kind === 'card-create' ||
  w.kind === 'card-tag' ||
  w.kind === 'card-write' ||
  (w.card !== null && isLocalNumber(w.card) && w.kind.startsWith('card-'));

/** `Move AB#12 to Active`: a held write's words, a sentence's first letter. */
const sentence = (what: string): string => what.charAt(0).toUpperCase() + what.slice(1);

/** The Held writes list's hint: local mode on, the board read-only alone, or neither now. */
const heldHint = (v: LocalModeView): string => {
  if (v.on)
    return '⏎ opens it · turning local mode off keeps them here as a record; nothing is ever sent';

  return readOnlyAlone(v)
    ? '⏎ opens it · they stay on this machine until you discard them; nothing is sent'
    : 'local mode is off: these stay a record; nothing is ever sent';
};

/**
 * The Held writes list: every write held for this checkout, newest first, when, what and
 * where it would have gone; ⏎ hands the row back (`held:<seq>`) to open it. Wide, as a list. The
 * board read-only alone: its local changes only, kept until discarded.
 */
export const heldMenu = (v: LocalModeView, now?: string): Menu => {
  const alone = readOnlyAlone(v);
  const held = alone ? boardChanges(v) : v.held;
  const name = alone ? 'Local changes' : 'Held writes';

  return {
    kind: 'menu',
    id: LOCAL_HELD_MENU,
    title: held.length === 0 ? name : `${name} · ${held.length}`,
    rows: held.map((w): MenuRow => ({
      id: `${HELD_ROW}${w.seq}`,
      lead: screenWhen(w.at, now),
      text: sentence(w.what),
      note: `would go to ${w.where}`,
      does: { kind: 'back' },
    })),
    look: {
      caption: `${checkoutName(v)} · ${held.length === 0 ? 'nothing held yet' : 'nothing left this machine'}`,
      hint: heldHint(v),
      local: true,
    },
  };
};

/** The held write a Held writes row names. */
export const heldOfRow = (v: LocalModeView | undefined, row: string): HeldWrite | undefined => {
  if (!row.startsWith(HELD_ROW)) return undefined;
  const seq = Number(row.slice(HELD_ROW.length));

  return v?.held.find((w) => w.seq === seq);
};

/** The local pull request with this number, if this checkout has it. */
export const localPrOf = (l: LocalState | undefined, n: number): LocalPr | undefined =>
  l?.view?.prs.find((p) => p.number === n);

/** A run's checks and verification as the local pull request lists them (`✓ checks`, `✓ verify`). */
const checksOf = (run: FactoryRunData | undefined): LocalCheck[] | undefined => {
  if (run === undefined) return undefined;
  const marks: Readonly<Record<string, { glyph: string; hue: Hue }>> = {
    success: { glyph: '✓', hue: 'good' },
    pass: { glyph: '✓', hue: 'good' },
    failure: { glyph: '✗', hue: 'bad' },
    fail: { glyph: '✗', hue: 'bad' },
    pending: { glyph: '●', hue: 'warn' },
    'not-reproduced': { glyph: '○', hue: 'dim' },
  };
  const checks = run.pr?.checks ?? 'none';
  const verified = [...run.verifications].reverse().find((x) => x.phase === 'after');
  const out: LocalCheck[] = [];
  const check = marks[checks];
  const verify = verified === undefined ? undefined : marks[verified.result];

  if (check !== undefined) out.push({ name: 'checks', ...check });
  if (verify !== undefined) out.push({ name: 'verify', ...verify });

  return out.length === 0 ? undefined : out;
};

/** A local pull request in the Board's place, its card's run giving the checks. */
export const localPrNode = (
  p: LocalPr,
  o: { run?: FactoryRunData | undefined; focus: 'merge' | 'discard'; away: boolean },
): LocalPullRequest => {
  const merged = p.mergeCommit === null ? '' : ` · ${p.mergeCommit.slice(0, 7)}`;
  const DONE: Readonly<Record<LocalPr['state'], LocalPullRequest['props']['done']>> = {
    open: undefined,
    merged: { text: `✓ Merged into ${p.base}${merged}`, hue: 'good' },
    discarded: { text: '○ Discarded · its branch kept', hue: 'dim' },
  };
  const done = DONE[p.state];
  const checks = checksOf(o.run);
  const files = p.files.map(({ path, status, added, removed }) => ({
    path,
    status,
    added,
    removed,
  }));

  return {
    kind: 'LocalPullRequest',
    id: 'local-pr',
    props: {
      name: `#${p.name}`,
      line: `local · ${p.head} → ${p.base} · not pushed${p.files.length === 0 ? '' : ` · ${localPrStat(p)}`}`,
      title: p.title,
      about:
        "The Feature run's PR stage wrote it here instead of on GitHub: same title, body, checks and evidence. Merge stays local too (the base on this machine), or throw it away.",
      ...(checks === undefined ? {} : { checks }),
      ...(files.length === 0 ? {} : { files }),
      ...(diffable(p) ? { diff: true } : {}),
      ...(p.commits.length === 0
        ? {}
        : { commits: p.commits.map((c) => ({ sha: c.sha.slice(0, 7), subject: c.subject })) }),
      body: p.body,
      ...(done === undefined ? { actions: { focus: o.focus } } : { done }),
      note: `would open on github.com/${p.repo}`,
      ...(o.away ? { away: true } : {}),
    },
  };
};

/** Its diff can be shown: git said what it changes. */
const diffable = (p: LocalPr): boolean =>
  p.files.length > 0 && p.baseSha !== '' && p.headSha !== '';

/**
 * Diff (⌘D, a file row's click): VimStorm's diff viewer on its files, base left and head right,
 * at file `index` (1-based), in its checkout, as a real pull request's review shows one.
 */
export const localPrDiff = (p: LocalPr, index = 1): Command[] =>
  diffable(p)
    ? [
        {
          kind: 'shell',
          effect: {
            kind: 'show-diff',
            root: p.checkout,
            files: p.files.map((f) => ({
              path: f.path,
              ...(f.oldPath === undefined ? {} : { oldPath: f.oldPath }),
              status: f.status,
            })),
            index: Math.min(Math.max(1, index), p.files.length),
            base: p.baseSha,
            head: p.headSha,
            line: 1,
            pr: { number: p.number, head: p.headSha },
          },
        },
      ]
    : [];

/** Merge locally, asked first (a squash commit on the local base; nothing is pushed). */
export const mergeConfirm = (p: LocalPr): Confirm => ({
  kind: 'confirm',
  question: `Merge #${p.name} into ${p.base} on this machine?`,
  details: [p.title, 'A squash commit on the local base; nothing is pushed.'],
  yes: 'Merge locally',
  argv: ['local', 'merge', p.name],
  done: `Merged #${p.name} into ${p.base} on this machine`,
});

/** Discard, asked first (closed unmerged, its branch kept; the run needs you). */
export const discardConfirm = (p: LocalPr): Confirm => ({
  kind: 'confirm',
  question: `Discard #${p.name}?`,
  details: [p.title, 'Closed unmerged; its branch stays. Its run then needs you.'],
  yes: 'Discard',
  no: 'Keep it',
  argv: ['local', 'discard', p.name],
  done: `Discarded #${p.name}`,
});

/** A run's pull request is a local one (`#L3`): its number. */
export const localPrOfRun = (run: FactoryRunData | undefined): number | undefined => {
  const n = run?.pr?.number;

  return n !== undefined && isLocalNumber(n) ? n : undefined;
};

/** `#L3`: a local pull request's number as the card menu says it. */
export const localPrName = (n: number): string => `#${localName(n)}`;

/**
 * The header's feed in local mode: the Factory line's dashed badge (`Local mode
 * · nothing written`, a click the Held writes list) and its crumb; each workspace of the checkout
 * (its card worktrees too) gets the badge `Local mode`.
 */
export const withLocal = (w: Workspaces, v: LocalModeView | undefined): Workspaces => {
  if (v === undefined || !v.on || v.checkout === null) return w;
  const checkout = v.checkout;
  const badge = { text: 'Local mode', hue: 'dim' as const, local: true };

  return {
    ...w,
    workspaces: w.workspaces.map((x) =>
      localCheckoutOf([checkout], x.root) === undefined
        ? x
        : { ...x, line: [...x.line, badge], label: `${x.label} · Local mode` },
    ),
    factory: {
      ...w.factory,
      line: [
        ...w.factory.line,
        { ...badge, text: 'Local mode · nothing written', id: LOCAL_BADGE_CLICK },
      ],
      label: `${w.factory.label} · Local mode, nothing written`,
      crumb: w.factory.crumb === '' ? 'local mode' : `${w.factory.crumb} · local mode`,
    },
  };
};
