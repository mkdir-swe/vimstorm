/**
 * The story dialog: what ⏎ on a card opens, the card dialog in its story look. `Story ·
 * <project>` over `#id` and the title, the facts line (type, column, assignee, sprint, tags), the
 * description and the criteria, then Linked at its end: Session · PR · Box from the facts the
 * Board already holds (its session, the run's pull request, the box's last `box.state`), a row not
 * there yet dim; no Run row, since runs have their place in the workspace. The footer names one
 * next step, `nextStep`'s (the menu's first row too), and `⌘⏎ more`. Once `card show` answers, its
 * text as read then, its Comments oldest first, and the images `card images` read drawn from their
 * files (any other image a link). Pure rules; `factory.ts` holds the state and does what a click
 * names.
 */
import {
  type BoardChangedEvent,
  type BoxListData,
  type CardComment,
  type Event,
  type LinkedOpens,
} from '@abe/core';
import { BOX_BOOTING_WORD, boxBooting } from '@abe/core/box-text';
import { cardImageSources, withCardImages } from '@abe/core/card-images';
import {
  type CardDialog,
  type Command,
  type CommentThread,
  type DialogButton,
  type DialogFact,
  type DialogLink,
  type DialogSheets,
  type Hue,
  localTime,
} from '../runtime/runtime';
import { overridePill } from '../settings';
import {
  ASSIGN_AND_LAUNCH,
  assignsToLaunch,
  type CardFacts,
  launchRefusal,
  nextStep,
  STEP_ROWS,
} from './card-actions';
import { BOX_MARK_WORDS, type BoxMoves, cardBoxName, cardBoxWords } from '../live';
import {
  boxMarkOf,
  endedWord,
  initials,
  noBoxWords,
  placedBox,
  pointsText,
  sameBoard,
  typeBadge,
  whereOf,
} from './flow';

/** What the story dialog is worked out from: the card's actions' facts and the Board's reads. */
export type StoryFacts = CardFacts & {
  /** The team's current sprint (`card list`), null when none spans today. */
  sprint?: string | null | undefined;
  /** The boxes' last `box.state`, by name. */
  boxes?: BoxMoves | undefined;
  /** `box list`, once read: the card's box by its `abe:card` tag. */
  boxList?: BoxListData | undefined;
  /** The tick's time (ms): a box booting then says so. */
  now?: number | undefined;
};

/**
 * What `card show` read of the open story, kept while the dialog is open: its text then,
 * its comments oldest first (`error`: why they could not be read), and each image `card images`
 * answered, by its address: its local file, or null when it was not read.
 */
export type StoryRead = {
  text?: { description: string; acceptanceCriteria: string } | undefined;
  comments?: readonly CardComment[] | undefined;
  error?: string | undefined;
  images?: Readonly<Record<string, string | null>> | undefined;
};

/** The images the story's text and comments name that `card images` has not answered yet. */
export const imagesToRead = (read: Pick<StoryRead, 'text' | 'comments' | 'images'>): string[] => {
  const texts = [
    read.text?.description ?? '',
    read.text?.acceptanceCriteria ?? '',
    ...(read.comments ?? []).map((c) => c.text),
  ];

  return [...new Set(texts.flatMap(cardImageSources))].filter(
    (src) => read.images?.[src] === undefined,
  );
};

/** Linked's rows in the story dialog, in order: Session, PR, Box (runs are the workspace's). */
export const STORY_LINKS = ['session', 'pr', 'box'] as const;
export type StoryLinkKey = (typeof STORY_LINKS)[number];

/**
 * One Linked row: its words, then its state (an Override's pill) in `hue` (with no state
 * the words are); dim while not there yet; what a click on it opens.
 */
export type StoryLink = {
  key: StoryLinkKey;
  label: string;
  words: string;
  state?: string | undefined;
  hue?: Hue | undefined;
  dim: boolean;
  opens: LinkedOpens | null;
};

/** A row's click id in the dialog (`dialog:linked:pr`); Command mode hands back `linked:pr`. */
const LINK_ID = 'dialog:linked:';

/** The choice a click on a Linked row hands the screen: its key, or undefined for another row. */
export const linkChosen = (row: string): StoryLinkKey | undefined => {
  const key = row.startsWith('linked:') ? row.slice('linked:'.length) : undefined;

  return STORY_LINKS.find((k) => k === key);
};

/**
 * What a click on a Linked row runs that is the same from every screen: the PR row its page, the
 * Box row the bottom pane's Boxes tab on it, shown. The Session row is the screen's own (Chat on
 * the session); a dim row none (empty).
 */
export const linkCommands = (l: StoryLink | undefined): Command[] => {
  switch (l?.opens?.kind) {
    case 'url':
      return [{ kind: 'shell', effect: { kind: 'open-url', url: l.opens.url } }];
    case 'box':
      return [
        {
          kind: 'open',
          screen: 'boxes',
          slot: 'pane',
          params: {
            box: l.opens.name,
            ...(l.opens.card === undefined ? {} : { card: String(l.opens.card) }),
          },
        },
        { kind: 'shell', effect: { kind: 'show', place: 'boxes' } },
      ];
    default:
      return [];
  }
};

const NONE_YET = (key: StoryLinkKey, label: string, words = 'none yet'): StoryLink => ({
  key,
  label,
  words,
  dim: true,
  opens: null,
});

/** The card's own session (the newest run's), if the Board has it. */
const sessionOf = (f: StoryFacts) => (f.session?.card === f.card.id ? f.session : undefined);

const sessionLink = (f: StoryFacts): StoryLink => {
  const s = sessionOf(f);

  if (s === undefined) return NONE_YET('session', 'Session');
  const where = whereOf(s);

  // your settings Overrides its run launched under
  const pill = overridePill(f.run?.personal ?? []);

  return {
    key: 'session',
    label: 'Session',
    // stopped by you, else ended
    words: s.state === 'ended' ? `${where} · ${endedWord(s).toLowerCase()}` : where,
    ...(pill === undefined ? {} : { state: pill, hue: 'accent' }),
    dim: false,
    opens: { kind: 'sessions', ids: [s.id] },
  };
};

const prLink = (f: StoryFacts): StoryLink => {
  const pr = f.run?.pr ?? null;

  if (pr === null) return NONE_YET('pr', 'PR');
  const hue = ((): Hue | undefined => {
    if (pr.state === 'merged') return 'good';
    if (pr.state === 'closed' || pr.checks === 'failure') return 'bad';

    return undefined;
  })();

  return {
    key: 'pr',
    label: 'PR',
    // `#10 AB#102 Count each line's…`; one read before its title was kept says its state
    words:
      pr.title === undefined || pr.title === ''
        ? `#${pr.number} · ${pr.state}`
        : `#${pr.number} ${pr.title}`,
    ...(hue === undefined ? {} : { hue }),
    dim: false,
    opens: { kind: 'url', url: pr.url },
  };
};

/** The card's box: its session's, else the one tagged with the card or Queued for it. */
const boxNameOf = (f: StoryFacts): string | undefined =>
  placedBox(sessionOf(f)) ??
  (f.boxList === undefined ? undefined : cardBoxName(f.boxList, f.card.id));

const boxLink = (f: StoryFacts): StoryLink => {
  const s = sessionOf(f);
  const name = boxNameOf(f);
  const mark = boxMarkOf(s, f.boxes ?? {}, { card: f.card.id, list: f.boxList, now: f.now });

  if (name === undefined || mark === undefined) {
    // boxes off: none comes, its work runs on this machine
    return NONE_YET(
      'box',
      'Box',
      f.boxesOff === true ? 'off · runs on this machine' : noBoxWords(s),
    );
  }
  // starting, as its mark: booting while EC2 runs it and its serve does not answer yet
  const listed = f.boxList?.boxes.find((b) => b.name === name);
  const booting =
    mark === 'starting' && listed !== undefined && f.now !== undefined && boxBooting(listed, f.now);

  return {
    key: 'box',
    label: 'Box',
    words: `${cardBoxWords(name, f.card.id, listed)} · ${booting ? BOX_BOOTING_WORD : BOX_MARK_WORDS[mark]}`,
    dim: false,
    opens: { kind: 'box', name, card: f.card.id },
  };
};

/** Linked's three rows for the card, in order. */
export const storyLinks = (f: StoryFacts): StoryLink[] => [sessionLink(f), prLink(f), boxLink(f)];

/** One of Linked's rows. */
export const storyLink = (f: StoryFacts, key: StoryLinkKey): StoryLink =>
  ({ session: sessionLink, pr: prLink, box: boxLink })[key](f);

/**
 * Whether an `abe watch` event changes what the card's open story dialog says: its run's move,
 * its session's state, its box's state, the card itself changed on Azure DevOps (`board`: the
 * board the dialog's card is of). The screen draws the dialog again on one.
 */
export const storyTouched = (
  e: Event,
  f: StoryFacts,
  board?: BoardChangedEvent['board'],
): boolean => {
  switch (e.type) {
    case 'factory.stage':
    case 'session.state':
      return e.data.card === f.card.id;
    case 'box.state':
      return e.data.box === boxNameOf(f);
    case 'board.changed':
      // changed on Azure DevOps outside Abe: drawn from the card as serve read it
      return sameBoard(board, e.data.board) && e.data.cards.some((c) => c.card.id === f.card.id);
    default:
      return false;
  }
};

/** The shown project's name: its folder's last part. */
const projectOf = (root: string | undefined): string | undefined =>
  root
    ?.split('/')
    .filter((p) => p !== '')
    .at(-1);

/** The facts line's plain words (`meta`): `Bug · Active · AE · 3 pt · Sprint 1 · tags api, cart`. */
const factsLine = (facts: readonly DialogFact[]): string[] =>
  facts.map((x) => (x.label === undefined ? x.text : `${x.label} ${x.text}`));

/** The facts line word by word in its colours. */
const factsOf = (f: StoryFacts): DialogFact[] => {
  const c = f.card;
  const points = pointsText(c.points);

  return [
    { text: typeBadge(c.type), tone: c.type === 'Bug' ? 'bug' : 'story' },
    { text: c.state },
    { text: c.assignee === null ? 'unassigned' : initials(c.assignee.name) },
    ...(points === undefined ? [] : [{ text: points, tone: 'points' as const }]),
    ...(f.sprint === null || f.sprint === undefined ? [] : [{ text: f.sprint }]),
    ...(c.tags.length === 0
      ? []
      : [{ text: c.tags.join(', '), tone: 'tags' as const, label: 'tags' }]),
  ];
};

const lineCount = (text: string): number => (text === '' ? 1 : text.split('\n').length);

/** A Linked row as the dialog's chip: dim and its hue only when it has one. */
const chip = (l: StoryLink): DialogLink => ({
  id: `${LINK_ID}${l.key}`,
  label: l.label,
  words: l.words,
  ...(l.state === undefined ? {} : { state: l.state }),
  ...(l.hue === undefined ? {} : { hue: l.hue }),
  ...(l.dim ? { dim: true } : {}),
});

/** The Comments: being read until `card show` answers; each `by · when` over its markdown. */
const threadOf = (read: StoryRead, now: string | undefined): CommentThread => {
  if (read.error !== undefined) return { state: 'error', message: read.error, comments: [] };
  if (read.comments === undefined) return { state: 'loading', comments: [] };

  return {
    state: 'ready',
    comments: read.comments.map((c) => ({
      by: c.by,
      when: localTime(c.at, now),
      markdown: withCardImages(c.text, read.images ?? {}),
    })),
  };
};

/**
 * The story dialog's node: its head, the card's description and criteria as markdown, its
 * Comments when `read` is given (the screen reads `card show`), Linked, and the footer's one next
 * step (none on a teammate's card) after `⌘⏎ more`. Its Sheets only once `abe card show`
 * named one attached (or could not read them). `now` dates a comment not from today.
 */
export const storyDialog = (
  f: StoryFacts,
  sheets?: DialogSheets,
  read?: StoryRead,
  now?: string,
): { dialog: CardDialog; lines: number } => {
  const c = f.card;
  const text = read?.text ?? c;
  const images = read?.images ?? {};
  const sections = [
    { title: 'Description', markdown: withCardImages(text.description, images) },
    { title: 'Acceptance criteria', markdown: withCardImages(text.acceptanceCriteria, images) },
  ];
  const thread = read === undefined ? undefined : threadOf(read, now);
  const step = nextStep(f);
  const assigns = step === undefined && assignsToLaunch(f) ? ASSIGN_AND_LAUNCH : undefined;
  const label = step === undefined ? assigns : STEP_ROWS[step];
  const primary: DialogButton[] =
    label === undefined ? [] : [{ id: 'dialog:primary', label, keys: '⏎', primary: true }];
  // no primary: why it cannot be launched, in the dialog (a teammate's card, a read-only board)
  const why = label === undefined ? launchRefusal(f) : undefined;
  const project = projectOf(f.root);
  const facts = factsOf(f);
  const shownSheets =
    sheets !== undefined && (sheets.rows.length > 0 || sheets.state === 'error')
      ? sheets
      : undefined;

  return {
    dialog: {
      kind: 'CardDialog',
      id: `dialog:${c.id}`,
      props: {
        kicker: c.type,
        card: c.id,
        state: c.state,
        title: c.title,
        meta: factsLine(facts),
        facts,
        sections,
        scroll: 0,
        buttons: primary,
        ...(shownSheets === undefined ? {} : { sheets: shownSheets }),
        heading: project === undefined ? 'Story' : `Story · ${project}`,
        linked: storyLinks(f).map(chip),
        hint: why === undefined ? '⌘⏎ more' : `${why} · ⌘⏎ more`,
        ...(thread === undefined ? {} : { comments: thread }),
      },
    },
    lines:
      sections.reduce((n, s) => n + 2 + lineCount(s.markdown), 0) +
      (thread === undefined
        ? 0
        : thread.comments.reduce((n, x) => n + 1 + lineCount(x.markdown), 2)),
  };
};
