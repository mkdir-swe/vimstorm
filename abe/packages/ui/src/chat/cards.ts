/**
 * Chat's cards (2.1 #114, slice t114b; boards R-Question, C-Question, C-Answered, C-Permission,
 * C-NeedsYou, C-Override, C-Grill, C-States, R-Anatomy): what the session asks you, answered in
 * Chat with one card and a digit.
 *
 * - **QuestionCard**: a question (AskUserQuestion's, `core/src/session/ask.ts`), a permission held under an
 *   Override, a Factory run's Needs you, or one question of a grill round: the question itself as
 *   the title (bold, short), the why line, the rest of what was written folded under it (`m`
 *   unfolds it), the options 1–9 (the recommended one first, marked), then `o` for your own words.
 * - **GrillRound**: a round under `◆ Round 2 · 3 questions  1 of 3 answered`, one question at a
 *   time with its place (`2 of 3`), sent as one numbered message.
 * - **CardLine**: an answered card folded to one dim line (`◆ Answered · The existing market table
 *   (1)`), a grill's answered question (`◆ Q1 · No, static widths (2)`).
 * - **OverrideCard**: `/override <what>`'s reason card (`◆ Override · Test DB write`).
 * - **DeferredPill**: cards left for later (Esc), above the composer: `◆ 1 for later · Which…`.
 *
 * Types and schemas live here; `components.ts` adds them to the closed set; Rust draws them
 * (`app/src/factory/cards.rs`). The model below is pure: the open cards as `serve` keeps them
 * (`session asks`, `session.ask`, `session.answered`), a run's Needs you, what is selected, typed,
 * picked, left for later and answered; the keys (1–9, ⏎, y, Tab / ⇧Tab, o, m, l / ö, Esc) and the
 * commands they run (`session answer`, `session send`, `session stop`, `session override`). The
 * `chat` screen holds a `Cards` per session, gives it the keys while a card is open, and places
 * its nodes: the shown card at the end of the transcript, the pill above the composer, the
 * answered lines where their cards stood.
 */
import {
  type AskCard,
  type AskOption,
  type Event,
  type FactoryRunData,
  type SessionData,
  type SessionOverride,
} from '@abe/core';
import { answerWords } from '@abe/core/steps';
import { z } from 'zod';
import type { Node } from '../runtime/components';
import { caretOf, caretProp, fieldInsert, fieldKey, fieldOf } from '../runtime/field';
import { endAsks } from '../board/card-actions';
import { railWord } from '../board/flow';
import { type Answer, type Command, type Refused } from '../runtime/runtime';

// ── Components ────────────────────────────────────────────────────────────────

/** What a card asks: a question, one of a grill round, a held permission, a run's Needs you. */
export const CARD_KINDS = ['question', 'grill', 'permission', 'needs-you'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** One answer row: its digit, words, `recommended`, a key it has too, or why it is grey. */
export type CardOption = {
  n: number;
  /** Drawn and pressed in place of its digit: Abe's own row on a run's Needs you (`w`, `e`). */
  letter?: string | undefined;
  label: string;
  /** What it means, dim under the label and wrapped: an AskUserQuestion option's `description`. */
  note?: string | undefined;
  recommended?: boolean | undefined;
  /** Dim at the row's right: a shortcut that does the same. */
  key?: string | undefined;
  /** Grey, never picked: why it cannot be. */
  reason?: string | undefined;
  /** A multiSelect question's row (`multi`): ticked to go with the answer. */
  ticked?: boolean | undefined;
};

export type QuestionCard = {
  kind: 'QuestionCard';
  id?: string | undefined;
  props: {
    ask: CardKind;
    title: string;
    /** A part of the title drawn in mono: a permission's command (`npm ci`). */
    mono?: string | undefined;
    why?: string | undefined;
    /** A permission's where line: `Local sandbox · the command runs in Claude Code's sandbox`. */
    where?: string | undefined;
    options: CardOption[];
    /** Several options may go (AskUserQuestion's multiSelect): a box per row, `ticked` or not. */
    multi?: boolean | undefined;
    /**
     * The own row's words: `Type your own answer…`, `Tell it what to do instead…`; none on a card
     * nothing can be told to (a run's Needs you whose session ended).
     */
    own?: string | undefined;
    /** Your own words being typed: the own row is a field with them. */
    typing?: string | undefined;
    /** Their caret in characters (`field.ts`, #314); absent: at their end. */
    caret?: number | undefined;
    /** The app's own field types them: the last `draft` number taken (`Composer.seq`'s rule). */
    seq?: number | undefined;
    /** The selected row: an option's `n`, or `own`. */
    selected?: number | 'own' | undefined;
    /** Several cards open: this one's place, `2 of 3` at the title's right. */
    stack?: { n: number; of: number } | undefined;
    /** Open cards waiting under it: 0–2 edges drawn below. */
    under?: number | undefined;
    /** The keys, dim under the rows: `1–3 pick · ⏎ answer · o own words · Esc later`. */
    foot?: string | undefined;
    /** It can no longer be answered here: why, in place of the keys (`Answer in Terminal mode · ⌃⌘→`). */
    expired?: string | undefined;
    /** A teammate's session: read-only, `waiting on Ada Example` in place of the keys. */
    whose?: string | undefined;
    /**
     * The question's context, folded under its title (the title is the question itself, short):
     * the rest of what the agent wrote. A click on `<card>:more` or `m` unfolds it.
     */
    more?: string | undefined;
    /** The context unfolded. */
    moreOpen?: boolean | undefined;
  };
};

/** A folded card: `◆ Answered · <label> (<n>)`; a grill's `◆ Q1 · <label> (<n>)`. */
export type CardLine = {
  kind: 'CardLine';
  id?: string | undefined;
  props: {
    head: string;
    text?: string | undefined;
    n?: number | undefined;
    /** Dim after the text: `· ⌘4 shows it`. */
    note?: string | undefined;
    /** ◆ in the Needs you hue (still waiting); else dim (settled). */
    waiting?: boolean | undefined;
    /** A grill's answered question: boxed as a card is, inside its round. */
    boxed?: boolean | undefined;
    selected?: boolean | undefined;
  };
};

/** A grill question's progress dot: answered, the one the keys are on, not answered yet. */
export const GRILL_DOTS = ['done', 'now', 'todo'] as const;
export type GrillDot = (typeof GRILL_DOTS)[number];

/** A grill round: its header and progress dots over its cards, the keys at the bottom. */
export type GrillRound = {
  kind: 'GrillRound';
  id?: string | undefined;
  props: {
    round: number;
    questions: number;
    answered: number;
    /** One progress dot per question: answered, the current one, to do. */
    dots: GrillDot[];
    foot?: string | undefined;
    whose?: string | undefined;
    stack?: { n: number; of: number } | undefined;
  };
  children: Node[];
};

/** `/override`'s card: the reason field (required) and what it lowers, until when. */
export type OverrideCard = {
  kind: 'OverrideCard';
  id?: string | undefined;
  props: {
    title: string;
    line: string;
    reason: string;
    /** The reason's caret in characters (`field.ts`, #314); absent: at its end. */
    caret?: number | undefined;
    /** ⏎ with no reason: the field marked. */
    missing?: boolean | undefined;
    /** Refused by `serve`: why, under the field. */
    error?: string | undefined;
    facts: { label: string; text: string }[];
    foot: string;
    /** Sent: waiting for `serve`'s answer. */
    sending?: boolean | undefined;
  };
};

/** Cards left for later, above the composer: `◆ 1 for later · <the oldest one's title>`. */
export type DeferredPill = {
  kind: 'DeferredPill';
  id?: string | undefined;
  props: { count: number; text: string };
};

export type CardNode = QuestionCard | CardLine | GrillRound | OverrideCard | DeferredPill;

export const CARD_COMPONENT_KINDS = [
  'QuestionCard',
  'CardLine',
  'GrillRound',
  'OverrideCard',
  'DeferredPill',
] as const;

/** The schemas, built on the set's own primitives (`components.ts` calls this). */
export const cardSchemas = (d: { nodeId: z.ZodString; node: () => z.ZodType<Node> }) => {
  const id = d.nodeId.optional();
  const n = z.number().int().min(1).max(9);
  const stack = z
    .strictObject({ n: z.number().int().positive(), of: z.number().int().positive() })
    .optional();

  return [
    z.strictObject({
      kind: z.literal('QuestionCard'),
      id,
      props: z.strictObject({
        ask: z.enum(CARD_KINDS),
        title: z.string(),
        mono: z.string().min(1).optional(),
        why: z.string().optional(),
        where: z.string().optional(),
        options: z
          .array(
            z.strictObject({
              n,
              letter: z.string().length(1).optional(),
              label: z.string(),
              note: z.string().min(1).optional(),
              recommended: z.boolean().optional(),
              key: z.string().min(1).optional(),
              reason: z.string().min(1).optional(),
              ticked: z.boolean().optional(),
            }),
          )
          .max(9),
        multi: z.boolean().optional(),
        own: z.string().optional(),
        typing: z.string().optional(),
        seq: z.number().int().nonnegative().optional(),
        caret: z.number().int().min(0).optional(),
        selected: z.union([n, z.literal('own')]).optional(),
        stack,
        under: z.number().int().min(0).max(2).optional(),
        foot: z.string().optional(),
        expired: z.string().optional(),
        whose: z.string().optional(),
        more: z.string().min(1).optional(),
        moreOpen: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('CardLine'),
      id,
      props: z.strictObject({
        head: z.string().min(1),
        text: z.string().optional(),
        n: n.optional(),
        note: z.string().optional(),
        waiting: z.boolean().optional(),
        boxed: z.boolean().optional(),
        selected: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('GrillRound'),
      id,
      props: z.strictObject({
        round: z.number().int().positive(),
        questions: z.number().int().positive(),
        answered: z.number().int().nonnegative(),
        dots: z.array(z.enum(GRILL_DOTS)),
        foot: z.string().optional(),
        whose: z.string().optional(),
        stack,
      }),
      get children() {
        return z.array(d.node());
      },
    }),
    z.strictObject({
      kind: z.literal('OverrideCard'),
      id,
      props: z.strictObject({
        title: z.string(),
        line: z.string(),
        reason: z.string(),
        caret: z.number().int().min(0).optional(),
        missing: z.boolean().optional(),
        error: z.string().optional(),
        facts: z.array(z.strictObject({ label: z.string(), text: z.string() })),
        foot: z.string(),
        sending: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('DeferredPill'),
      id,
      props: z.strictObject({ count: z.number().int().positive(), text: z.string() }),
    }),
  ] as const;
};

// ── The model ─────────────────────────────────────────────────────────────────

/** A card as Chat holds it: serve's, or a run's Needs you made into one. */
export type HeldCard = Omit<AskCard, 'kind' | 'options' | 'own'> & {
  kind: CardKind;
  options: (AskOption & { key?: string; reason?: string; letter?: string })[];
  /** The own row's words; null: no own row (nothing can be told to it). */
  own: string | null;
  /** A run's Needs you on an ended session: what its Retry (option 1) runs. */
  retry?: string[] | undefined;
  /** A run's Needs you: the card its End the run… (option 3) ends (#184). */
  ends?: number | undefined;
  /** Its own row is selected first (a run's Needs you that asks a question, #303). */
  ownFirst?: true | undefined;
  /**
   * A run's Needs you: the answers its agent offered (#213), options 1..n sent as the next
   * prompt; Open workspace and End the run… follow them.
   */
  offers?: readonly string[] | undefined;
};

/** Your answer to one card: an option, or your own words. */
export type CardPick = { option: number } | { options: number[] } | { text: string };

/** A card answered, folded to its line: in the transcript where it stood (`at`, its asking time). */
export type Folded = {
  /** The cards it answered (a grill round's every card). */
  cards: string[];
  at: string;
  head: string;
  text: string;
  n?: number | undefined;
  /** Sent, `serve` has not said so yet (a refusal unfolds it again). */
  pending: boolean;
  /**
   * A question's or a grill round's (first) question: its answer went as the session's next
   * prompt (`Answer to "<question>": …`), so once the transcript has that prompt its line there
   * is the record (it outlives the app), not this (#275).
   */
  question?: string | undefined;
};

export type OverrideDraft = {
  what: string;
  words: string;
  facts: { label: string; text: string }[];
  line: string;
  reason: string;
  /** The reason's caret (`field.ts`); absent: at its end. */
  caret?: number | undefined;
  missing: boolean;
  error?: string | undefined;
  sending: boolean;
};

export type Cards = {
  /** The session's open cards, oldest first, as `serve` said. */
  open: HeldCard[];
  /** Its run's Needs you as a card; none while the run does not need you for its own reason. */
  needsYou?: HeldCard | undefined;
  /** The selected row, per card. */
  rows: Readonly<Record<string, number | 'own'>>;
  /** Your own words being typed, on one card, and their caret (`field.ts`; absent: the end). */
  typing?:
    | { card: string; text: string; caret?: number | undefined; seq?: number | undefined }
    | undefined;
  /** A grill round's picks, per card, until the round is sent. */
  picks: Readonly<Record<string, CardPick>>;
  /** A multiSelect question's ticked options, per card, until ⏎ sends or picks them. */
  ticks?: Readonly<Record<string, readonly number[]>> | undefined;
  /** The grill question the keys are on; none: the first not answered, or all are (⏎ sends). */
  at?: string | undefined;
  /** An answered grill question opened again with ⏎. */
  unfolded?: string | undefined;
  /** The card whose context (`more`) is unfolded. */
  more?: string | undefined;
  /** Cards (a round by its id) left for later, oldest first. */
  later: readonly string[];
  folded: readonly Folded[];
  /** Cards answered since the stack began: the shown one's place counts them. */
  stacked: number;
  /** Rounds by id, numbered as this Chat met them. */
  rounds: Readonly<Record<string, number>>;
  override?: OverrideDraft | undefined;
};

export const NO_CARDS: Cards = {
  open: [],
  rows: {},
  picks: {},
  later: [],
  folded: [],
  stacked: 0,
  rounds: {},
};

/** What the cards are about: the session (its id, card, Overrides), whose it is, its run. */
export type CardFacts = {
  session: string;
  card?: number | null | undefined;
  /** A teammate's session: their name; every card read-only. */
  whose?: string | undefined;
  /** Its session ended (stopped too): its asks take no answer, only a run's Needs you does (#317). */
  ended?: boolean | undefined;
  /** The keys are elsewhere (a message being typed): the card waits, Tab gives them to it. */
  waits?: boolean | undefined;
};

/** A waiting card's foot: how its keys are had. */
export const WAITS_FOOT = 'Tab to answer';

/** Why an ended session's ask shows no keys: nothing can answer it (#317). */
const ENDED_ASK = 'Its session ended: no answer reaches it';

/** An ask of a session that ended (#317): read-only, the keys the screen's (⏎ Retry). */
const askEnded = (f: CardFacts, card: HeldCard): boolean =>
  f.ended === true && card.kind !== 'needs-you';

/** A card or a round: what the stack shows one at a time. */
type Group = { id: string; cards: HeldCard[] };

const isRound = (c: HeldCard) => c.round !== null;

const groupsOf = (c: Cards): Group[] => {
  const all = [...c.open, ...(c.needsYou === undefined ? [] : [c.needsYou])];
  const sent = new Set(c.folded.filter((f) => f.pending).flatMap((f) => f.cards));
  const out: Group[] = [];

  for (const card of all) {
    if (sent.has(card.id)) continue;
    const id = card.round?.id ?? card.id;
    const had = out.find((g) => g.id === id);

    if (had === undefined) out.push({ id, cards: [card] });
    else had.cards.push(card);
  }
  for (const g of out) g.cards.sort((a, b) => (a.round?.n ?? 0) - (b.round?.n ?? 0));

  return out;
};

/** The group the keys and the card go to: the oldest not left for later. */
const shownGroup = (c: Cards): Group | undefined =>
  groupsOf(c).find((g) => !c.later.includes(g.id));

/** The shown card's (or round's) id; none up. */
export const shownCard = (c: Cards): string | undefined => shownGroup(c)?.id;

/** What the shown card asks (a round's first); none up. */
export const shownKind = (c: Cards): CardKind | undefined => shownGroup(c)?.cards[0]?.kind;

/** When the shown card (a round's first) was asked; none up. */
export const shownAsked = (c: Cards): string | undefined => shownGroup(c)?.cards[0]?.at;

/** Whether a card is up and takes the keys (an Override card too). */
export const cardsOpen = (c: Cards): boolean =>
  c.override !== undefined || shownGroup(c) !== undefined;

/** Cards waiting on you: the open ones and the run's Needs you, a round counted once. */
export const waitingCount = (c: Cards): number => groupsOf(c).length;

const roundNumbers = (c: Cards, cards: readonly HeldCard[]): Record<string, number> => {
  const rounds = { ...c.rounds };
  let next = Object.keys(rounds).length + 1;

  for (const card of cards)
    if (card.round !== null && rounds[card.round.id] === undefined) rounds[card.round.id] = next++;

  return rounds;
};

const held = (a: AskCard): HeldCard => ({ ...a });

/**
 * The picks serve keeps on a round's cards (#342: after a restart, from another client), under
 * the ones made here: a pick made here and not yet heard back stays.
 */
const keptPicks = (c: Cards, open: readonly HeldCard[]): Record<string, CardPick> => ({
  ...Object.fromEntries(
    open.flatMap((x) => (x.round !== null && x.picked !== undefined ? [[x.id, x.picked]] : [])),
  ),
  ...c.picks,
});

/** `session asks`' answer: the open cards as they stand. */
export const cardsRead = (c: Cards, cards: readonly AskCard[]): Cards => {
  const open = cards.map(held);

  return settled({ ...c, open, picks: keptPicks(c, open), rounds: roundNumbers(c, open) });
};

/** Drops what names cards no longer open; the stack's count starts again once none are. */
const settled = (c: Cards): Cards => {
  const ids = new Set(
    [...c.open, ...(c.needsYou === undefined ? [] : [c.needsYou])].map((x) => x.id),
  );
  const groups = new Set(groupsOf(c).map((g) => g.id));
  const keep = <V>(r: Readonly<Record<string, V>>): Record<string, V> =>
    Object.fromEntries(Object.entries(r).filter(([k]) => ids.has(k)));

  return {
    ...c,
    rows: keep(c.rows),
    picks: keep(c.picks),
    typing: c.typing !== undefined && ids.has(c.typing.card) ? c.typing : undefined,
    at: c.at !== undefined && ids.has(c.at) ? c.at : undefined,
    unfolded: c.unfolded !== undefined && ids.has(c.unfolded) ? c.unfolded : undefined,
    more: c.more !== undefined && ids.has(c.more) ? c.more : undefined,
    later: c.later.filter((g) => groups.has(g)),
    stacked: groups.size === 0 ? 0 : c.stacked,
  };
};

/** The words an answer folds to, read back from what was sent (another client answered). */
const labelOf = (answer: string): { text: string; n?: number } => {
  const { text, n } = answerWords(answer);

  return n === undefined ? { text } : { text, n };
};

const roundLine = (c: Cards, round: string, questions: number) => ({
  head: 'Answered',
  text: `Round ${c.rounds[round] ?? 1} · ${questions} question${questions === 1 ? '' : 's'}`,
});

/** `session.ask` / `session.answered` of this session. */
export const cardsEvent = (c: Cards, session: string, event: Event): Cards => {
  if (event.type === 'session.ask' && event.data.id === session) {
    const fresh = event.data.cards.map(held);
    const open = [
      ...c.open.map((x) => fresh.find((f) => f.id === x.id) ?? x),
      ...fresh.filter((f) => !c.open.some((x) => x.id === f.id)),
    ];

    return settled({ ...c, open, picks: keptPicks(c, open), rounds: roundNumbers(c, open) });
  }
  if (event.type === 'session.answered' && event.data.id === session) {
    const gone = new Set(event.data.cards);
    const was = c.open.filter((x) => gone.has(x.id));
    const ours = c.folded.find((f) => f.cards.some((id) => gone.has(id)));
    const answer = event.data.answer;
    const [first] = was;
    const lineOf = (card: HeldCard): { head: string; text: string; n?: number } => {
      if (answer === null) return { head: 'Answered outside Chat', text: '' };
      if (card.round !== null) return roundLine(c, card.round.id, was.length);

      return { head: 'Answered', ...labelOf(answer) };
    };
    let folded: readonly Folded[] = c.folded;

    // ours settles; one answered elsewhere folds to its line now
    if (ours !== undefined)
      folded = c.folded.map((f) => (f === ours ? { ...f, pending: false } : f));
    else if (first !== undefined)
      folded = [
        ...c.folded,
        {
          cards: was.map((x) => x.id),
          at: first.at,
          ...lineOf(first),
          pending: false,
          ...(answer !== null && prompts(first) ? { question: first.question } : {}),
        },
      ];
    const stacked = c.stacked + (ours === undefined && first !== undefined ? 1 : 0);

    return settled({
      ...c,
      open: c.open.filter((x) => !gone.has(x.id)),
      folded,
      stacked,
    });
  }

  return c;
};

/**
 * Whether a Needs you's reason asks the person something (#303): its first line has a question
 * mark ending a sentence (not a URL's query). A failed setup's reason quotes its output, whatever
 * it asks: never a question to you, its way on is Done, continue once it is fixed.
 */
const asksSomething = (reason: string): boolean =>
  !reason.startsWith("the repo's setup") && /\?(?=[\s)"'”’…]|$)/.test(reason.split('\n')[0] ?? '');

/** Its pull request merged and the merge's deploy failed (#361): it waits on you, not on GitHub. */
const deployFailed = (run: FactoryRunData): boolean =>
  run.pr?.state === 'merged' && run.pr.deploy === 'failure';

/**
 * Abe's own rows on a run's Needs you go by a letter, never a digit (`w`, and `e` for End): the
 * digits stay the agent's answers, numbered as it numbered them.
 */
const WORKSPACE = { label: 'Open workspace', recommended: false, letter: 'w' };

/** Reasons that are the session's own state: Chat shows the session's cards for those, no Needs you card. */
const SESSION_OWN = new Set(['waiting on you in Chat', 'its session ended']);

/**
 * A Factory run's Needs you as a card (#114 S5): only when the run waits on you for a reason of
 * its own (the agent's `needs-you`, a no-start, a failed setup), not its session's (`waiting on
 * you in Chat`: its question cards say why; `its session ended`). Its session ended (a no-start
 * always has), nothing can be sent to it: `1 Retry` (the card launched again, as ⌘⏎'s Retry) and
 * `2 Open workspace`, no own row.
 */
export const needsYouCard = (
  run: FactoryRunData | undefined,
  session: Pick<SessionData, 'state'> | undefined,
): HeldCard | undefined => {
  if (
    run?.state !== 'needs-you' ||
    run.reason === null ||
    SESSION_OWN.has(run.reason) ||
    // its pull request open, it waits on GitHub or a review (`prWaitReason`), not on a word
    (run.stage === 'pr' && run.pr !== null && !deployFailed(run))
  )
    return undefined;
  const base = {
    id: `needs-you:${run.session}`,
    session: run.session,
    kind: 'needs-you' as const,
    title: run.reason,
    question: run.reason,
    round: null,
    at: run.since,
    expired: null,
  };

  // #361: merged, its deploy failed: re-run it and Done follows, or end the run; no continue
  if (deployFailed(run))
    return {
      ...base,
      why: 'Merged; its deploy failed. Re-run the deploy and Done follows, or end the run',
      options: [
        { ...WORKSPACE, n: 2 },
        { n: 3, label: 'End the run…', recommended: true, letter: 'e' },
      ],
      // its session ended: nothing can be sent to it
      own: session?.state === 'ended' ? null : 'Tell it something…',
      ends: run.card,
    };

  if (session?.state === 'ended')
    return {
      ...base,
      why: `The session ended; the run waits in ${railWord(run)} until you answer`,
      options: [
        { n: 1, label: 'Retry', recommended: true },
        { ...WORKSPACE, n: 2 },
        // a prototype is never ended as a run: it has no 3 here, as before #184
        ...(run.prototype
          ? []
          : [{ n: 3, label: 'End the run…', recommended: false, letter: 'e' }]),
      ],
      own: null,
      retry: ['factory', 'run', String(run.card), '--repo', run.repo],
      ends: run.prototype ? undefined : run.card,
    };

  const last = run.prototype ? 'Stop the run' : 'End the run…';

  // #213: the agent named the answers: those first, nothing recommended, then the two of every one
  if (run.options.length > 0)
    return {
      ...base,
      why: `The run waits in ${railWord(run)} until you answer`,
      options: [
        ...run.options.map((label, i) => ({ n: i + 1, label, recommended: false })),
        { ...WORKSPACE, n: run.options.length + 1 },
        { n: run.options.length + 2, label: last, recommended: false, letter: 'e' },
      ],
      own: 'Answer it…',
      offers: run.options,
      ends: run.prototype ? undefined : run.card,
    };

  // #303: a question has no Done to recommend: your answer leads (selected), 2 and 3 stay theirs
  if (asksSomething(run.reason))
    return {
      ...base,
      why: `The run waits in ${railWord(run)} until you answer`,
      options: [
        { ...WORKSPACE, n: 2 },
        { n: 3, label: last, recommended: false, letter: 'e' },
      ],
      own: 'Answer it…',
      ownFirst: true,
      ends: run.prototype ? undefined : run.card,
    };

  return {
    id: `needs-you:${run.session}`,
    session: run.session,
    kind: 'needs-you',
    title: run.reason,
    question: run.reason,
    why: `The run waits in ${railWord(run)} until you answer`,
    options: [
      { n: 1, label: 'Done, continue', recommended: true },
      { ...WORKSPACE, n: 2 },
      // a prototype is stopped, never ended as a run (`step` refuses it `prototype-never-ships`)
      {
        n: 3,
        label: run.prototype ? 'Stop the run' : 'End the run…',
        recommended: false,
        letter: 'e',
      },
    ],
    own: 'Tell it something…',
    round: null,
    at: run.since,
    expired: null,
    ends: run.prototype ? undefined : run.card,
  };
};

/** The run as `factory status` and its events have it: its Needs you card kept, or gone. */
export const cardsRun = (
  c: Cards,
  run: FactoryRunData | undefined,
  session: Pick<SessionData, 'state'> | undefined,
): Cards => {
  const card = needsYouCard(run, session);
  const was = c.needsYou;

  // the same card, unless its session ended meanwhile: then its Retry form (#317)
  const offers = (x: HeldCard | undefined) => (x?.offers ?? []).join('\n');

  if (
    card?.id === was?.id &&
    card?.title === was?.title &&
    card?.own === was?.own &&
    offers(card) === offers(was)
  )
    return c;
  // the run went on (answered here or elsewhere): its line settles, its pick and place go
  const folded = c.folded.map((f) =>
    was !== undefined && f.cards.includes(was.id) ? { ...f, pending: false } : f,
  );

  return settled({ ...c, needsYou: card, folded });
};

type Out = { cards: Cards; commands: Command[] };

/** What cardsKey did: `handled` false when no card took the key (the screen's own keys then). */
export type KeyOut = Out & { handled: boolean };

const RUN_PREFIX = 'cards:';

/** Whether a `run`'s answer is the cards' own. */
export const isCardsResult = (id: string): boolean => id.startsWith(RUN_PREFIX);

const answerCommand = (session: string, card: string, extra: string[]): Command => ({
  kind: 'run',
  id: `${RUN_PREFIX}answer:${card}`,
  argv: ['session', 'answer', session, '--card', card, ...extra],
});

const recommended = (card: HeldCard): number | undefined =>
  card.options.find((o) => o.recommended)?.n;

const pickable = (card: HeldCard, n: number) =>
  card.options.some((o) => o.n === n && o.reason === undefined);

/** The selected row: as moved, else the pick, else the recommended one, else the first. */
const rowOf = (c: Cards, card: HeldCard): number | 'own' => {
  const moved = c.rows[card.id];

  if (moved !== undefined) return moved;
  const picked = c.picks[card.id];

  if (picked !== undefined) {
    if ('text' in picked) return 'own';

    return 'option' in picked ? picked.option : (picked.options[0] ?? 'own');
  }

  if (card.ownFirst === true && card.own !== null) return 'own';

  return recommended(card) ?? card.options.find((o) => o.reason === undefined)?.n ?? 'own';
};

/** The rows the selection walks: the options that can be picked, then the own row if it has one. */
const walk = (card: HeldCard): (number | 'own')[] => [
  ...card.options.filter((o) => o.reason === undefined).map((o) => o.n),
  ...(card.own === null ? [] : ['own' as const]),
];

const moveRow = (c: Cards, card: HeldCard, by: 1 | -1): Cards => {
  const rows = walk(card);
  const at = rows.indexOf(rowOf(c, card));
  const next = rows[Math.min(rows.length - 1, Math.max(0, at + by))] ?? rowOf(c, card);

  return { ...c, rows: { ...c.rows, [card.id]: next } };
};

const labelPicked = (card: HeldCard, p: CardPick): { text: string; n?: number } => {
  if ('text' in p) return { text: p.text.trim() };
  const label = (n: number) => card.options.find((x) => x.n === n)?.label ?? String(n);

  if ('options' in p)
    return p.options.length === 1 && p.options[0] !== undefined
      ? { text: label(p.options[0]), n: p.options[0] }
      : { text: p.options.map(label).join(', ') };

  return { text: label(p.option), n: p.option };
};

/** A pick as `session answer`'s flags: one `--option` per option, or `--text`. */
const pickFlags = (p: CardPick): string[] => {
  if ('text' in p) return ['--text', p.text.trim()];

  return ('options' in p ? p.options : [p.option]).flatMap((n) => ['--option', String(n)]);
};

/** Whether every option of a pick can be picked. */
const pickedOk = (card: HeldCard, p: CardPick): boolean => {
  if ('text' in p) return p.text.trim() !== '';

  return 'options' in p
    ? p.options.length > 0 && p.options.every((n) => pickable(card, n))
    : pickable(card, p.option);
};

/** A multiSelect card's ticked options, in its order. */
const ticksOf = (c: Cards, card: HeldCard): number[] => {
  const t = c.ticks?.[card.id] ?? [];

  return card.options.map((o) => o.n).filter((n) => t.includes(n));
};

/** Option `n` ticked, or off again when it was. */
const tick = (c: Cards, card: HeldCard, n: number | 'own'): Cards => {
  if (n === 'own' || !pickable(card, n)) return c;
  const t = c.ticks?.[card.id] ?? [];

  return {
    ...c,
    ticks: { ...c.ticks, [card.id]: t.includes(n) ? t.filter((x) => x !== n) : [...t, n] },
  };
};

/** ⏎ on a multiSelect card: what is ticked, else the selected row alone; `own`: your words. */
const multiPick = (c: Cards, card: HeldCard): CardPick | 'own' => {
  const ticked = ticksOf(c, card);
  const row = rowOf(c, card);

  if (ticked.length > 0) return { options: ticked };

  return row === 'own' ? 'own' : { option: row };
};

/** Whether a card's answer is typed to the session as its next prompt (`ask.ts`' `askAnswer`). */
const prompts = (card: HeldCard) => card.kind === 'question' || card.kind === 'grill';

/** Folds what was just sent, at once; `serve`'s `session.answered` settles it. */
const fold = (
  c: Cards,
  cards: readonly HeldCard[],
  line: { head: string; text: string; n?: number },
): Cards => {
  const [first] = cards;

  if (first === undefined) return c;

  return {
    ...c,
    folded: [
      ...c.folded,
      {
        cards: cards.map((x) => x.id),
        at: first.at,
        ...line,
        pending: true,
        ...(prompts(first) ? { question: first.question } : {}),
      },
    ],
    typing: undefined,
    at: undefined,
    unfolded: undefined,
    stacked: c.stacked + 1,
  };
};

const balloon = (text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'balloon', tone: 'error', text },
});

/** One card answered (a question, a permission, a run's Needs you). */
const answerOne = (c: Cards, card: HeldCard, p: CardPick, f: CardFacts): Out => {
  if (!pickedOk(card, p)) return { cards: c, commands: [] };
  const line = { head: 'Answered', ...labelPicked(card, p) };

  if (card.kind === 'needs-you' && card.offers !== undefined && 'option' in p) {
    const offered = card.offers[p.option - 1];

    // one the agent offered: its words as the next prompt; past them, Open workspace (2) and End (3)
    if (offered !== undefined)
      return {
        cards: fold(c, [card], line),
        commands: [
          {
            kind: 'run',
            id: `${RUN_PREFIX}send:${card.id}`,
            argv: ['session', 'send', card.session, offered],
          },
        ],
      };

    const past = card.offers.length - 1;
    const theirs = {
      ...card,
      offers: undefined,
      options: card.options.slice(card.offers.length).map((o) => ({ ...o, n: o.n - past })),
    };

    return answerOne(c, theirs, { option: p.option - past }, f);
  }
  if (card.kind === 'needs-you') {
    // its session ended: Retry launches the card again (a new run, a new session)
    if (card.retry !== undefined && 'option' in p && p.option === 1)
      return {
        cards: fold(c, [card], line),
        commands: [{ kind: 'run', id: `${RUN_PREFIX}retry:${card.id}`, argv: card.retry }],
      };
    // Open workspace's jump: the run's workspace in the Editor, Chat beside it; the card stays
    if ('option' in p && p.option === 2)
      return {
        cards: c,
        commands:
          typeof f.card === 'number' ? [{ kind: 'jump', to: 'workspace', story: f.card }] : [],
      };
    // End the run… (#184): `abe factory end`, asked how and why; stopping its session alone
    // would leave the run waiting on you with nothing behind it
    if ('option' in p && p.option === 3 && card.ends !== undefined)
      return {
        cards: c,
        commands: [
          {
            kind: 'ask',
            argv: ['factory', 'end', String(card.ends)],
            summary: `End #${card.ends}'s run`,
            ask: endAsks({ state: 'needs-you', reason: card.question }),
          },
        ],
      };
    if ('option' in p && p.option === 3)
      return {
        cards: c,
        commands: [
          {
            kind: 'confirm',
            argv: ['session', 'stop', card.session],
            question: `Stop ${f.card === undefined || f.card === null ? 'the' : `#${f.card}'s`} run?`,
            details: ['Its session stops; the worktree and the branch stay.'],
            yes: 'Stop',
            done: `Stopped ${f.card === undefined || f.card === null ? 'the' : `#${f.card}'s`} run`,
          },
        ],
      };
    const text = 'text' in p ? p.text.trim() : 'continue';

    if (card.retry !== undefined) return { cards: c, commands: [] };

    return {
      cards: fold(c, [card], line),
      commands: [
        {
          kind: 'run',
          id: `${RUN_PREFIX}send:${card.id}`,
          argv: ['session', 'send', card.session, text],
        },
      ],
    };
  }

  return {
    cards: fold(c, [card], line),
    commands: [answerCommand(f.session, card.id, pickFlags(p))],
  };
};

/** A grill round's every pick, sent as one numbered message. */
const sendRound = (c: Cards, g: Group, f: CardFacts): Out => {
  const answers = g.cards.map((x) => c.picks[x.id]);

  if (answers.some((a) => a === undefined)) return { cards: c, commands: [] };
  const json = JSON.stringify(answers.map((a) => (a === undefined ? '' : pickValue(a))));

  return {
    cards: fold(c, g.cards, roundLine(c, g.id, g.cards.length)),
    commands: [answerCommand(f.session, g.id, ['--answers', json])],
  };
};

/** The grill question the keys are on: `at`, else the first not picked; none when all are. */
const currentOf = (c: Cards, g: Group): HeldCard | undefined =>
  g.cards.find((x) => x.id === c.at) ?? g.cards.find((x) => c.picks[x.id] === undefined);

/** A pick on a grill question; the keys move on to the next one not picked, or to the send. */
const pickGrill = (c: Cards, g: Group, card: HeldCard, p: CardPick): Cards => {
  if (!pickedOk(card, p)) return c;
  const picks = { ...c.picks, [card.id]: p };
  const rows = Object.fromEntries(Object.entries(c.rows).filter(([k]) => k !== card.id));
  const i = g.cards.indexOf(card);
  const after = [...g.cards.slice(i + 1), ...g.cards.slice(0, i)];
  const next = after.find((x) => picks[x.id] === undefined);

  return { ...c, picks, rows, typing: undefined, unfolded: undefined, at: next?.id };
};

const digit = (key: string): number | undefined => (/^[1-9]$/.test(key) ? Number(key) : undefined);

const UP = new Set(['l', '<Up>']);
const DOWN = new Set(['ö', '<Down>']);

/** Keys while your own words are typed: text, ⌫, ⏎ answers, Esc back to the options. */
const typingKey = (c: Cards, g: Group, card: HeldCard, key: string, f: CardFacts): KeyOut => {
  const text = c.typing?.text ?? '';

  if (key === '<Esc>') return { cards: { ...c, typing: undefined }, commands: [], handled: true };
  if (key === '<CR>') {
    const out = isRound(card)
      ? pickAndGo(c, g, card, { text }, f)
      : answerOne(c, card, { text }, f);

    return { ...out, handled: true };
  }
  const next = fieldKey(fieldOf(text, c.typing?.caret), key);

  return {
    cards:
      next === undefined
        ? c
        : { ...c, typing: { card: card.id, text: next.text, caret: caretProp(next) } },
    commands: [],
    handled: true,
  };
};

/**
 * A grill question's pick told to serve as it is made (#342: `session answer --pick`), so a
 * restart, a second client and Reopen show it; the round itself goes once all are picked.
 */
const pickCommand = (session: string, card: HeldCard, p: CardPick): Command => ({
  kind: 'run',
  id: `${RUN_PREFIX}pick:${card.id}`,
  argv: [
    'session',
    'answer',
    session,
    '--card',
    card.id,
    '--pick',
    `${card.round?.n ?? 1}:${JSON.stringify(pickValue(p))}`,
  ],
});

/** A pick as `--pick` and `--answers` say it: an option's number, its options', or the words. */
const pickValue = (p: CardPick): number | number[] | string => {
  if ('text' in p) return p.text.trim();

  return 'options' in p ? p.options : p.option;
};

/** A pick on a grill question, kept by serve; nothing when it took no pick. */
const pickKept = (c: Cards, g: Group, card: HeldCard, p: CardPick, f: CardFacts): Out => {
  const next = pickGrill(c, g, card, p);

  return next === c
    ? { cards: c, commands: [] }
    : { cards: next, commands: [pickCommand(f.session, card, p)] };
};

/**
 * ⏎ on a grill question picked it, kept by serve: the round goes once every question has its
 * answer (a round refused keeps every pick there).
 */
const pickAndGo = (c: Cards, g: Group, card: HeldCard, p: CardPick, f: CardFacts): Out => {
  const kept = pickKept(c, g, card, p, f);

  if (!g.cards.every((x) => kept.cards.picks[x.id] !== undefined)) return kept;
  const sent = sendRound(kept.cards, g, f);

  return { cards: sent.cards, commands: [...kept.commands, ...sent.commands] };
};

const later = (c: Cards, g: Group): Cards => ({
  ...c,
  later: [...c.later.filter((x) => x !== g.id), g.id],
  typing: undefined,
  at: undefined,
  unfolded: undefined,
});

const grillKey = (c: Cards, g: Group, key: string, f: CardFacts): KeyOut => {
  const card = currentOf(c, g);
  const done = (cards: Cards, commands: Command[] = []): KeyOut => ({
    cards,
    commands,
    handled: true,
  });

  if (card !== undefined && c.typing?.card === card.id) return typingKey(c, g, card, key, f);
  if (key === '<Esc>') return done(later(c, g));
  if (key === '<Tab>' || key === '<S-Tab>') {
    const from = key === '<Tab>' ? -1 : g.cards.length;
    const i = card === undefined ? from : g.cards.indexOf(card);
    const j = Math.min(g.cards.length - 1, Math.max(0, i + (key === '<Tab>' ? 1 : -1)));

    return done({ ...c, at: g.cards[j]?.id, unfolded: undefined, typing: undefined });
  }
  // all answered: ⏎ sends the round
  if (card === undefined) {
    if (key !== '<CR>') return done(c);
    const sent = sendRound(c, g, f);

    return done(sent.cards, sent.commands);
  }
  const answered = c.picks[card.id] !== undefined && c.unfolded !== card.id;

  // on an answered question's line: ⏎ opens it again, nothing else picks
  if (answered) return done(key === '<CR>' ? { ...c, unfolded: card.id } : c);
  if (key === 'm') return done(toggleMore(c, card));
  const n = digit(key);

  // a multiSelect question: a digit or Space ticks, ⏎ picks what is ticked
  if (card.multi === true && (n !== undefined || key === '<Space>'))
    return done(tick(c, card, n ?? rowOf(c, card)));
  if (card.multi === true && key === '<CR>') {
    const p = multiPick(c, card);

    if (p === 'own') return done({ ...c, typing: { card: card.id, text: '' } });
    const out = pickAndGo(c, g, card, p, f);

    return done(out.cards, out.commands);
  }

  if (n !== undefined) {
    const out = pickKept(c, g, card, { option: n }, f);

    return done(out.cards, out.commands);
  }
  switch (key) {
    case 'y': {
      const r = recommended(card);
      const row = rowOf(c, card);
      const option = r ?? (row === 'own' ? undefined : row);

      if (option === undefined) return done({ ...c, typing: { card: card.id, text: '' } });
      const out = pickKept(c, g, card, { option }, f);

      return done(out.cards, out.commands);
    }
    case 'o':
      return done({ ...c, typing: { card: card.id, text: '' } });
    case '<CR>': {
      const row = rowOf(c, card);

      if (row === 'own') return done({ ...c, typing: { card: card.id, text: '' } });
      const out = pickAndGo(c, g, card, { option: row }, f);

      return done(out.cards, out.commands);
    }
    default:
      if (UP.has(key)) return done(moveRow(c, card, -1));
      if (DOWN.has(key)) return done(moveRow(c, card, 1));

      return done(c);
  }
};

/** How long a permission is up before a key may allow it: sooner, it was meant for something else. */
export const ALLOW_GRACE_MS = 400;

/** A key that would allow a permission, come sooner than `ALLOW_GRACE_MS` after it was asked. */
const allowsTooSoon = (c: Cards, card: HeldCard, key: string, at: string | undefined): boolean => {
  if (card.kind !== 'permission' || at === undefined) return false;
  if (Date.parse(at) - Date.parse(card.at) >= ALLOW_GRACE_MS) return false;
  const n = digit(key) ?? (key === '<CR>' ? rowOf(c, card) : undefined);
  const row = card.options.find((o) => o.n === n);

  return row?.label.startsWith('Allow') === true;
};

const oneKey = (
  c: Cards,
  g: Group,
  card: HeldCard,
  key: string,
  f: CardFacts,
  at: string | undefined,
): KeyOut => {
  const done = (out: Out): KeyOut => ({ ...out, handled: true });

  if (c.typing?.card === card.id) return typingKey(c, g, card, key, f);
  if (key === '<Esc>') return done({ cards: later(c, g), commands: [] });
  if (key === 'm') return done({ cards: toggleMore(c, card), commands: [] });
  // ran out (a held permission's 600 s): answered in Terminal mode now, only Esc here
  if (card.expired !== null) return done({ cards: c, commands: [] });
  // an allow typed before the card could be read: a key meant for the field, taken by nothing
  if (allowsTooSoon(c, card, key, at)) return done({ cards: c, commands: [] });
  const n = digit(key);

  // a multiSelect question: a digit or Space ticks, ⏎ sends what is ticked
  if (card.multi === true && (n !== undefined || key === '<Space>'))
    return done({ cards: tick(c, card, n ?? rowOf(c, card)), commands: [] });
  if (card.multi === true && key === '<CR>') {
    const p = multiPick(c, card);

    return p === 'own'
      ? done({ cards: { ...c, typing: { card: card.id, text: '' } }, commands: [] })
      : done(answerOne(c, card, p, f));
  }
  const lettered = card.options.find((o) => o.letter === key);

  if (lettered !== undefined) return done(answerOne(c, card, { option: lettered.n }, f));
  // a row with a letter takes no digit: the digits are the agent's answers
  if (n !== undefined && !card.options.some((o) => o.n === n && o.letter !== undefined))
    return done(answerOne(c, card, { option: n }, f));
  switch (key) {
    case 'o':
      return card.own === null
        ? done({ cards: c, commands: [] })
        : done({ cards: { ...c, typing: { card: card.id, text: '' } }, commands: [] });
    case '<CR>': {
      const row = rowOf(c, card);

      if (row !== 'own') return done(answerOne(c, card, { option: row }, f));

      return card.own === null
        ? done({ cards: c, commands: [] })
        : done({ cards: { ...c, typing: { card: card.id, text: '' } }, commands: [] });
    }
    default:
      if (UP.has(key)) return done({ cards: moveRow(c, card, -1), commands: [] });
      if (DOWN.has(key)) return done({ cards: moveRow(c, card, 1), commands: [] });

      return done({ cards: c, commands: [] });
  }
};

/** Override card keys: the reason typed, ⏎ overrides (a reason required), Esc cancels. */
const overrideKey = (c: Cards, d: OverrideDraft, key: string, f: CardFacts): KeyOut => {
  const done = (cards: Cards, commands: Command[] = []): KeyOut => ({
    cards,
    commands,
    handled: true,
  });

  if (d.sending) return done(c);
  if (key === '<Esc>') return done({ ...c, override: undefined });
  if (key === '<CR>') {
    const reason = d.reason.trim();

    if (reason === '') return done({ ...c, override: { ...d, missing: true } });

    return done({ ...c, override: { ...d, sending: true, error: undefined } }, [
      {
        kind: 'run',
        id: `${RUN_PREFIX}override`,
        argv: ['session', 'override', f.session, '--what', d.what, '--reason', reason],
      },
    ]);
  }
  const next = fieldKey(fieldOf(d.reason, d.caret), key);

  return done(
    next === undefined
      ? c
      : { ...c, override: { ...d, reason: next.text, caret: caretProp(next), missing: false } },
  );
};

/**
 * A key while Chat has the keyboard: the Override card's, else the shown card's; `handled` false
 * when none is up (or the session is a teammate's: read-only), the screen's keys then. `at`: when
 * it came (a permission's allow sooner than `ALLOW_GRACE_MS` is no answer).
 */
export const cardsKey = (c: Cards, key: string, f: CardFacts, at?: string): KeyOut => {
  if (c.override !== undefined) return overrideKey(c, c.override, key, f);
  const g = shownGroup(c);

  if (g === undefined || f.whose !== undefined) return { cards: c, commands: [], handled: false };
  const [first] = g.cards;

  if (first === undefined || askEnded(f, first)) return { cards: c, commands: [], handled: false };

  return isRound(first) ? grillKey(c, g, key, f) : oneKey(c, g, first, key, f, at);
};

/** Pasted text (⌘V): into the field being typed (own words, the Override's reason). */
export const cardsText = (c: Cards, text: string): Cards => {
  const line = text.replace(/\s*\n\s*/g, ' ');

  if (c.override !== undefined && !c.override.sending) {
    const f = fieldInsert(fieldOf(c.override.reason, c.override.caret), line);

    return {
      ...c,
      override: { ...c.override, reason: f.text, caret: caretProp(f), missing: false },
    };
  }
  if (c.typing !== undefined) {
    const f = fieldInsert(fieldOf(c.typing.text, c.typing.caret), line);

    return { ...c, typing: { ...c.typing, text: f.text, caret: caretProp(f) } };
  }

  return c;
};

/**
 * The app's own field typed your own words (`draft`, numbered): they are its text; an older number
 * than one taken changes nothing. No card's words being typed: not the cards'.
 */
export const cardsDraft = (c: Cards, text: string, seq: number): Cards => {
  if (c.typing === undefined || seq < (c.typing.seq ?? 0)) return c;

  return { ...c, typing: { card: c.typing.card, text: text.replace(/\r\n?/g, '\n'), seq } };
};

/** ⏎ / a click on the pill: the oldest card left for later shown again. */
export const cardsReopen = (c: Cards): Cards => {
  const [oldest] = c.later;

  return oldest === undefined ? c : { ...c, later: c.later.slice(1) };
};

/** A click on a card's part: an option row picks it, the own row types, a grill line opens. */
export const cardsClick = (c: Cards, id: string, f: CardFacts): KeyOut | undefined => {
  if (id === 'cards:pill') return { cards: cardsReopen(c), commands: [], handled: true };
  const g = shownGroup(c);
  // the context unfolds on a read-only card too
  const reading = g?.cards.find((x) => id === `card:${x.id}:more`);

  if (reading !== undefined) return { cards: toggleMore(c, reading), commands: [], handled: true };

  if (g === undefined || f.whose !== undefined || g.cards.some((x) => askEnded(f, x)))
    return undefined;
  for (const card of g.cards) {
    const own = id === `card:${card.id}:own` && card.own !== null;
    const opt = /^card:(.+):(\d)$/.exec(id);
    const line = id === `card:${card.id}:line`;
    if (line)
      return { cards: { ...c, at: card.id, unfolded: card.id }, commands: [], handled: true };
    if (own)
      return {
        cards: { ...c, at: isRound(card) ? card.id : c.at, typing: { card: card.id, text: '' } },
        commands: [],
        handled: true,
      };
    if (opt?.[1] === card.id && opt[2] !== undefined && card.multi === true) {
      const at = isRound(card) ? { at: card.id, unfolded: card.id } : {};

      return { cards: tick({ ...c, ...at }, card, Number(opt[2])), commands: [], handled: true };
    }
    if (opt?.[1] === card.id && opt[2] !== undefined) {
      const p = { option: Number(opt[2]) };
      const out = isRound(card)
        ? pickKept({ ...c, at: card.id, unfolded: card.id }, g, card, p, f)
        : answerOne(c, card, p, f);

      return { ...out, handled: true };
    }
  }

  return undefined;
};

/** An answer of the cards' own commands: a refusal unfolds the card again and says why. */
export const cardsResult = (c: Cards, input: Answer | Refused): Out => {
  if (input.id === `${RUN_PREFIX}override`) {
    const d = c.override;

    if (d === undefined) return { cards: c, commands: [] };

    return input.reply.ok
      ? { cards: { ...c, override: undefined }, commands: [] }
      : {
          cards: { ...c, override: { ...d, sending: false, error: input.reply.error.message } },
          commands: [],
        };
  }
  // A pick serve did not keep: its card is gone (the round went, another client answered), or
  // it says why on a card still open.
  if (input.id.startsWith(`${RUN_PREFIX}pick:`) && !input.reply.ok) {
    const id = input.id.slice(`${RUN_PREFIX}pick:`.length);

    return c.open.some((x) => x.id === id)
      ? {
          cards: c,
          commands: [balloon(`${input.reply.error.message} (${input.reply.error.code})`)],
        }
      : { cards: c, commands: [] };
  }
  // `cards:answer:<card or round>`, `cards:send:` / `cards:retry:<needs-you card>`
  const named = input.id.replace(/^cards:(answer|send|retry):/, '');
  if (input.reply.ok) return { cards: c, commands: [] };
  const back = c.folded.filter(
    (f) =>
      f.pending &&
      f.cards.some((x) => x === named || c.open.find((o) => o.id === x)?.round?.id === named),
  );

  return {
    cards: {
      ...c,
      folded: c.folded.filter((f) => !back.includes(f)),
      stacked: Math.max(0, c.stacked - back.length),
    },
    commands: [balloon(`${input.reply.error.message} (${input.reply.error.code})`)],
  };
};

// ── Override ──────────────────────────────────────────────────────────────────

const REACH_WORDS: Readonly<Record<'read' | 'write', string>> = {
  read: 'none → read',
  write: 'read → write',
};

const AREAS = 'db read <env>, db write <env>, aws read <env>, aws write <env>';

const title = (word: string) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;

/**
 * What an Override names, in words, read only to say so on the card (core's `parseOverride` is
 * serve's: it checks the environment against Reach and a write against where the session runs).
 */
const readArea = (
  what: string,
): { words: string; fact: { label: string; text: string } } | undefined => {
  const [first, second, third, ...rest] = what.trim().toLowerCase().split(/\s+/);

  if (rest.length > 0 || second === undefined) return undefined;
  if (
    (first === 'db' || first === 'aws') &&
    (second === 'read' || second === 'write') &&
    third !== undefined
  ) {
    const place = `${title(third)} ${first === 'db' ? 'DB' : 'AWS'}`;

    return {
      words: `${place} ${second}`,
      fact: { label: 'Reach', text: `${place} · ${REACH_WORDS[second]}` },
    };
  }

  return undefined;
};

/**
 * `/override <what>` / `:override <what>`: its card, the reason field focused. What it lowers is
 * read here only to say so; `serve` decides (an area of its Reach, a write only on a box).
 */
export const openOverride = (c: Cards, what: string, f: CardFacts): Cards => {
  const read = readArea(what);
  const words = read?.words ?? what.trim();
  const story = f.card === undefined || f.card === null ? '' : `#${f.card} and `;

  return {
    ...c,
    override: {
      what: what.trim(),
      words,
      facts: [
        ...(read === undefined ? [] : [read.fact]),
        { label: 'Until', text: 'this session ends' },
      ],
      line: `Reach lowered for this session only · tracked on ${story}the PR`,
      reason: '',
      missing: false,
      ...(read === undefined
        ? {
            error: `not an area an Override lowers: ${what.trim() || '(none)'}. Override one of: ${AREAS}`,
          }
        : {}),
      sending: false,
    },
  };
};

/**
 * Chat's header row for the session's Overrides (#114 S4): `Test DB write · overridden by you:
 * <reason>` (the shell draws the ✎ and the warn hue), the newest first with `+N` for the rest.
 */
export const overrideLine = (
  overrides: readonly SessionOverride[],
  whose?: string,
): string | undefined => {
  const newest = overrides.at(-1);

  if (newest === undefined) return undefined;
  const more = overrides.length > 1 ? ` · +${overrides.length - 1}` : '';

  return `${newest.words} · overridden by ${whose ?? 'you'}: ${newest.reason}${more}`;
};

// ── View ──────────────────────────────────────────────────────────────────────

/** A line's sentences: cut after `.`, `?` or `!` and the space after it. */
const sentencesOf = (line: string): string[] =>
  line.trim() === '' ? [] : line.trim().split(/(?<=[.?!])\s+(?=\S)/);

const ASKS = /\?["'”’)]*$/;

/**
 * What a card says, read first: its title the question itself (the first sentence asking
 * something, else the first sentence), `more` the rest of what was written, in its order, folded
 * under it; `why` only when it is not part of that text (a header, the stage the run waits in). A
 * permission's title is its command and stays whole.
 */
export const askParts = (
  card: Pick<HeldCard, 'kind' | 'title' | 'question' | 'why'>,
): { title: string; more: string | null; why: string | null } => {
  if (card.kind === 'permission') return { title: card.title, more: null, why: card.why };
  const lines = card.question.split('\n').map(sentencesOf);
  const all = lines.flat();
  const ask = all.find((x) => ASKS.test(x)) ?? all[0];

  if (ask === undefined) return { title: card.title, more: null, why: card.why };
  let dropped = false;
  const rest = lines
    .map((line) =>
      line
        .filter((x) => {
          if (dropped || x !== ask) return true;
          dropped = true;

          return false;
        })
        .join(' '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const why = card.why !== null && card.question.includes(card.why) ? null : card.why;

  return { title: ask, more: rest === '' ? null : rest, why };
};

/** Whether the card has context folded under its title. */
const hasMore = (card: HeldCard): boolean => askParts(card).more !== null;

/** `m` / a click on the context line: it unfolds, or folds again. */
const toggleMore = (c: Cards, card: HeldCard): Cards =>
  hasMore(card) ? { ...c, more: c.more === card.id ? undefined : card.id } : c;

const span = (n: number) => (n === 1 ? '1' : `1–${n}`);

/** The digits a card's options take: `1–3`, or `1 or 3` when one is skipped (a make card, #136). */
const digitsOf = (card: HeldCard): string => {
  const ns = card.options.filter((o) => o.letter === undefined).map((o) => o.n);

  return ns.every((n, i) => n === i + 1)
    ? span(ns.length)
    : `${ns.slice(0, -1).join(', ')} or ${String(ns.at(-1) ?? '')}`;
};

const footOf = (card: HeldCard, c: Cards): string => {
  if (c.typing?.card === card.id) return '⏎ answer · Esc back to the options';

  const own = card.own === null ? '' : ' · o own words';

  if (card.multi === true) return `Space or ${digitsOf(card)} tick · ⏎ send${own} · Esc later`;

  const digits = card.options.some((o) => o.letter === undefined)
    ? `${digitsOf(card)} pick · `
    : '';

  return `${digits}⏎ answer${own} · Esc later`;
};

/**
 * A grill round's key line (#286), short enough for the 420 px column: `y` only on a question with
 * a recommendation, `o` only where your own words go; `⏎ send all` before `Tab next`, and first
 * once every question has its answer.
 */
const grillFoot = (current: HeldCard | undefined): string =>
  current === undefined
    ? '⏎ send all · Tab back to a question'
    : [
        ...(recommended(current) === undefined ? [] : ['y recommended']),
        current.multi === true ? 'Space or 1–9 tick' : '1–9 pick',
        ...(current.own === null ? [] : ['o own words']),
        '⏎ send all',
        'Tab next',
      ].join(' · ');

/** A permission's command, drawn mono in its title (`Allow Bash: npm ci?`). */
const monoOf = (card: HeldCard): string | undefined =>
  card.kind === 'permission' &&
  card.prompt !== undefined &&
  card.prompt.input !== '' &&
  card.title.includes(card.prompt.input)
    ? card.prompt.input
    : undefined;

const optionsOf = (c: Cards, card: HeldCard): CardOption[] => {
  const ticked = ticksOf(c, card);

  return card.options.map((o) => ({
    n: o.n,
    ...(o.letter === undefined ? {} : { letter: o.letter }),
    label: o.label,
    ...(o.note === undefined || o.note.trim() === '' ? {} : { note: o.note.trim() }),
    ...(o.recommended ? { recommended: true } : {}),
    ...(o.key === undefined ? {} : { key: o.key }),
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(card.multi === true ? { ticked: ticked.includes(o.n) } : {}),
  }));
};

const questionCard = (
  c: Cards,
  card: HeldCard,
  f: CardFacts,
  o: { stack?: { n: number; of: number }; under?: number; foot?: boolean } = {},
): QuestionCard => {
  const mono = monoOf(card);
  const { title: asks, more, why } = askParts(card);
  const typing = c.typing?.card === card.id ? c.typing.text : undefined;
  const caret = c.typing?.card === card.id ? c.typing.caret : undefined;
  const seq = c.typing?.card === card.id ? (c.typing.seq ?? 0) : 0;
  const ended = askEnded(f, card);
  const readOnly = f.whose !== undefined || ended;
  /** What stands under the rows: whose it is, why it ran out, or the keys. */
  const bottomOf = (): Partial<QuestionCard['props']> => {
    if (f.whose !== undefined) return { whose: `waiting on ${f.whose}` };
    if (ended) return { expired: ENDED_ASK };
    if (card.expired !== null) return { expired: card.expired };
    if (o.foot === false) return {};

    return { foot: f.waits === true ? WAITS_FOOT : footOf(card, c) };
  };

  return {
    kind: 'QuestionCard',
    id: `card:${card.id}`,
    props: {
      ask: card.kind,
      title: asks,
      ...(mono === undefined ? {} : { mono }),
      ...(why === null ? {} : { why }),
      ...(more === null ? {} : { more, ...(c.more === card.id ? { moreOpen: true } : {}) }),
      ...(card.where === undefined ? {} : { where: card.where }),
      options: optionsOf(c, card),
      ...(card.multi === true ? { multi: true } : {}),
      ...(card.own === null ? {} : { own: card.own }),
      ...(typing === undefined ? {} : { typing }),
      ...caretOf(caret),
      ...(seq === 0 ? {} : { seq }),
      ...(readOnly || card.expired !== null
        ? {}
        : { selected: typing === undefined ? rowOf(c, card) : 'own' }),
      ...(o.stack === undefined ? {} : { stack: o.stack }),
      ...(o.under === undefined || o.under === 0 ? {} : { under: o.under }),
      ...bottomOf(),
    },
  };
};

/** The round's foot: its keys, or why there are none (#317). */
const roundFoot = (
  ended: boolean,
  typing: boolean,
  current: HeldCard | undefined,
  waits: boolean,
): string => {
  if (ended) return ENDED_ASK;
  if (waits) return WAITS_FOOT;

  return typing ? '⏎ answer · Esc back to the options' : grillFoot(current);
};

const roundNode = (
  c: Cards,
  g: Group,
  f: CardFacts,
  stack: { n: number; of: number } | undefined,
): GrillRound => {
  const ended = g.cards.some((x) => askEnded(f, x));
  const current = f.whose === undefined && !ended ? currentOf(c, g) : undefined;
  const picked = g.cards.filter((x) => c.picks[x.id] !== undefined).length;
  const lineOf = (card: HeldCard, p: CardPick, selected: boolean): CardLine => {
    const label = labelPicked(card, p);

    return {
      kind: 'CardLine',
      id: `card:${card.id}:line`,
      props: {
        head: `Q${card.round?.n ?? 1}`,
        text: label.text,
        ...(label.n === undefined ? {} : { n: label.n }),
        boxed: true,
        ...(selected ? { selected: true } : {}),
      },
    };
  };
  // one question at a time, its place `2 of 3` at its title's right; every one answered: their
  // lines, read over before ⏎ sends them all
  const shown = current ?? g.cards.find((x) => c.picks[x.id] === undefined);
  const children: Node[] =
    shown === undefined
      ? g.cards.flatMap((card) => {
          const p = c.picks[card.id];

          return p === undefined ? [] : [lineOf(card, p, false)];
        })
      : [
          ((): Node => {
            const p = c.picks[shown.id];
            const place = { n: g.cards.indexOf(shown) + 1, of: g.cards.length };

            return p !== undefined && c.unfolded !== shown.id
              ? lineOf(shown, p, true)
              : questionCard(c, shown, f, { stack: place, foot: false });
          })(),
        ];
  const dots = g.cards.map((card): GrillDot => {
    if (card === current) return 'now';

    return c.picks[card.id] === undefined ? 'todo' : 'done';
  });
  const typingHere = current !== undefined && c.typing?.card === current.id;

  return {
    kind: 'GrillRound',
    id: `round:${g.id}`,
    props: {
      round: c.rounds[g.id] ?? 1,
      questions: g.cards.length,
      answered: picked,
      dots,
      ...(f.whose !== undefined
        ? { whose: `waiting on ${f.whose}` }
        : { foot: roundFoot(ended, typingHere, current, f.waits === true) }),
      ...(stack === undefined ? {} : { stack }),
    },
    children,
  };
};

/** The shown card (or round, or Override card), drawn at the end of the transcript; none: null. */
export const cardNode = (c: Cards, f: CardFacts): Node | null => {
  const d = c.override;

  if (d !== undefined)
    return {
      kind: 'OverrideCard',
      id: 'override',
      props: {
        title: `Override · ${d.words}`,
        line: d.line,
        reason: d.reason,
        ...caretOf(d.caret),
        ...(d.missing ? { missing: true } : {}),
        ...(d.error === undefined ? {} : { error: d.error }),
        facts: d.facts,
        foot: '⏎ override · Esc cancel',
        ...(d.sending ? { sending: true } : {}),
      },
    };
  const groups = groupsOf(c);
  const g = groups.find((x) => !c.later.includes(x.id));

  if (g === undefined) return null;
  const i = groups.indexOf(g);
  const of = c.stacked + groups.length;
  const stack = of > 1 ? { n: c.stacked + i + 1, of } : undefined;
  const [first] = g.cards;

  if (first === undefined) return null;
  if (isRound(first)) return roundNode(c, g, f, stack);
  const under = Math.min(2, groups.slice(i + 1).filter((x) => !c.later.includes(x.id)).length);

  return questionCard(c, first, f, {
    ...(stack === undefined ? {} : { stack }),
    under,
  });
};

/** The pill above the composer while cards wait for later: how many, the oldest one's title. */
export const pillNode = (c: Cards): DeferredPill | null => {
  const groups = groupsOf(c).filter((g) => c.later.includes(g.id));
  const oldest = c.later.map((id) => groups.find((g) => g.id === id)).find((g) => g !== undefined);
  const [first] = oldest?.cards ?? [];

  if (first === undefined) return null;

  return {
    kind: 'DeferredPill',
    id: 'cards:pill',
    props: {
      count: groups.length,
      text: isRound(first)
        ? `Round ${c.rounds[first.round?.id ?? ''] ?? 1} · ${oldest?.cards.length ?? 1} questions`
        : first.title,
    },
  };
};

/** The answered cards' lines, each at its card's asking time: the transcript places them. */
export const foldedNodes = (c: Cards): { at: string; node: CardLine; question?: string }[] =>
  c.folded.map((x) => ({
    at: x.at,
    ...(x.question === undefined ? {} : { question: x.question }),
    node: {
      kind: 'CardLine',
      id: `answered:${x.cards[0] ?? ''}`,
      props: {
        head: x.head,
        ...(x.text === '' ? {} : { text: x.text }),
        ...(x.n === undefined ? {} : { n: x.n }),
      },
    },
  }));
