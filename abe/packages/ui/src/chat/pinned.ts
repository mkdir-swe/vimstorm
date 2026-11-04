/**
 * The `chat` screen (#119): the Chat slot's screen, Chat pinned to the shown workspace. It reads
 * `abe session list` and `abe factory status` and follows their events, and your Mine (`card list
 * --mine --closed`, your done cards too, #239: a story not in it and assigned is a teammate's, its
 * Chat read-only), and pins the session whose worktree is the shown project's folder (a local
 * workspace) or whose box is the shown box (a cloud one). It draws the rendered Chat (#113,
 * `rendered.ts`: the header B, the session's transcript as turns, its keys and ⌘⏎ actions; Claude
 * Code's TUI is Terminal mode's (the `mode: terminal` param): in the Factory view (#155) this
 * screen draws it, the pinned session attached: `abe session attach <id>`, a box's `abe box attach
 * <box> --session <id>`, under the same header; in the Editor (#340) the same attach is its
 * Terminal mode's pinned Claude Code tab, on the session `chat-session` names. No session: the
 * quiet W-NoSession look, `No session on #<card> yet` with `Launch agent ⏎` (`abe factory run
 * <card> --repo <root>`, as the overview's launch) and `⌘⏎ more`, the card from the branch
 * (`card/<n>-…`). The `session` and `card` open params pin it instead (the Factory view; a
 * prototype session opened as its own chat beside the Abe chat). In the main checkout with no
 * story it is the repo's Abe chat (kind `abe`, `abe chat`); with none yet, ⏎ starts it.
 */
import {
  type ActionsAt,
  actionAnswer,
  type CardActions,
  isActionAnswer,
  launch as cardLaunch,
  launchedCard,
  launchFromBox,
  launchGoing,
  type LaunchOn,
  mayOf,
  NO_CARD_ACTIONS,
  shortChoice,
} from '../board/card-actions';
import { LAUNCH_SHORT, type ShortRuns, withShortAsk } from '../board/launch-short';
import type {
  BoardChangedEvent,
  BoxListData,
  CardData,
  Event,
  FactoryRunData,
  InstallView,
  LaunchProgress,
  LaunchTarget,
  PrototypeData,
  RepoHere,
  SessionData,
} from '@abe/core';
import { BOX_BOOTING_WORD } from '@abe/core/box-text';
import { boxRuns } from '@abe/core/launch';
import { hasPrototype } from '@abe/core/prototype-tag';
import { isHere } from '@abe/core/here';
import {
  ASSIGN_AND_LAUNCH,
  LAUNCH_BOX,
  type LaunchSetup,
  noConversation,
  reopenCommand,
  retriesRun,
  sessionReopens,
} from '../board/card-actions';
import { cardOfBranch } from '../board/branch';
import { jumpCommands } from '../board/jumps';
import type { BoxMoves } from '../live';
import {
  boxMarkOf,
  endedWithBox,
  isYours,
  launchTicking,
  placedBox,
  sameBoard,
  shownState,
  standing,
  standsAlone,
  startingLook,
} from '../board/flow';
import { type Facts as LiveFacts, type LiveRead } from '../live';
import {
  type ChatCards,
  chatCardsFor,
  chatCardsLive,
  chatCardsOverride,
  chatCardsRead,
  chatCardsRun,
  chatCardsSlots,
  chatCardsWait,
  chatCardsWaits,
  OVERRIDE_MENU,
  stepChatCards,
} from './chat-cards';
import { type InstallOpen, installParts, partMessage, stripClick } from './install-parts';
import { type Hold, holding, holdPress, readingWords, statusLine } from '../runtime/held';
import { empty, island, type Node, stack } from '../runtime/components';
import {
  composerDock,
  composerEmpty,
  type ComposerFacts,
  composerFocus,
  composerInput,
  composerMenuOpen,
  composerSession,
  composerShown,
  type ComposerState,
  NO_COMPOSER,
  slashRowsOf,
} from './composer';
import { type Caret, type ViewSize } from '../runtime/protocol';
import { cardsOpen, shownAsked, shownCard, shownKind, waitingCount } from './cards';
import {
  chatStatus,
  type Facts,
  headerOf,
  hubArgv,
  HUB_RUN,
  HUB_TAB,
  HUB_TAB_CLOSE,
  HUB_TAB_NEW,
  NEW_CONVERSATION,
  hubTabs,
  RECENT_ROW,
  REOPEN_HUB,
  SESSION_MENU,
  launchBody,
  previewOpen,
  PROTOTYPE_PAGE,
  FIND_ID,
  type Rendered,
  renderedFindClosed,
  renderedFinding,
  renderedFindInput,
  renderedFindLeft,
  renderedFindOpen,
  renderedFor,
  revealEntry,
  renderedView,
  sessionMenu,
  stepRendered,
} from './rendered';
import {
  type Answer,
  type Command,
  type Here,
  type Menu,
  type MenuRow,
  type Input,
  type Refused,
  type Screen,
} from '../runtime/runtime';

export { cardOfBranch };

/** A launch on a card heard going: the checkout it was asked from, and its session once answered. */
type LaunchHeard = { repo: string; session: string | null };

export type PinnedState = {
  /** Retry runs and Reopens asked, their argv until answered (`launch-short.ts`, #9). */
  shortRuns?: ShortRuns | undefined;
  size?: ViewSize | undefined;
  /** The shown project's folder, its box (a cloud workspace) and branch (`project`). */
  root?: string | undefined;
  box?: string | undefined;
  branch?: string | undefined;
  /**
   * The repo `session list` / `factory status` were read in (#256): a card's session and run are
   * only that repo's (another repo's board may have the same card number).
   */
  here?: RepoHere | undefined;
  /** The open params' pin: this session, or this card's newest run's. */
  session?: string | undefined;
  /**
   * The `restore` open param last taken: the session Chat was on at the app's last quit, pinned
   * once (an open naming it again keeps what Chat is on); not listed once the sessions are read,
   * it gives way.
   */
  restored?: string | undefined;
  card?: number | undefined;
  sessions?: SessionData[] | undefined;
  runs?: FactoryRunData[] | undefined;
  /** The session the last launch from here answered: pinned until the folder changes. */
  launched?: string | undefined;
  /** Launch and assign-then-launch on the pin's card (`card-actions.ts`), as on every screen. */
  actions: CardActions;
  /** The session a Reopen from here was asked for (#343; a prototype chat's too, #350), until it answers: ⏎ again asks nothing. */
  reopening?: string | undefined;
  /**
   * A launch's steps heard (`session.step`) before its session is listed (#229): a warm box's
   * launch lists them as a cold one's does, not a bare Starting.
   */
  launchSeen?: { id: string; card: number; launch: LaunchProgress } | undefined;
  /**
   * Launches heard going (`launch.started`), by card, from any screen or the CLI: the card is
   * Launching here too until its session is listed (`session` once answered); refused, gone.
   */
  launchesHeard?: Readonly<Record<number, LaunchHeard>> | undefined;
  /** The last launch refused on a card (`launch.ended`): said under its no-session look until the next. */
  launchRefused?: { card: number; repo: string; text: string } | undefined;
  /** Where the launch in flight was asked: its answer is dropped once the workspace moved. */
  launchFrom?: { root?: string | undefined; box?: string | undefined } | undefined;
  /**
   * The card as `card show` has it: its title for the header while there is no session, and whose
   * it is (its assignee) when it is not in your Mine.
   */
  title?:
    | {
        card: number;
        title: string;
        assignee: CardData['assignee'];
        /** It has a prototype (its tag): its Launch box reads the reference (#347). */
        prototype?: boolean | undefined;
      }
    | undefined;
  /**
   * The card's title as the Factory view's Board has it (the `title` param, #309): the header
   * names the card it moved to in the same frame as the body, before `card show` answers.
   */
  named?: { card: number; title: string } | undefined;
  /**
   * The Factory view's Board selects no card (the `card: none` param, its ring on an empty
   * column, #309): Chat is on nothing, not on the workspace's session.
   */
  noCard?: boolean | undefined;
  /**
   * Your cards (`card list --mine`): a story not among them and assigned to someone else than
   * their assignee (you, #259) is a teammate's.
   */
  mine?: Pick<CardData, 'id' | 'assignee'>[] | undefined;
  /**
   * A card assigned since Mine was handed: Mine is taken again only from a read answered after
   * this many (`cards:mine`'s answers), so one from before the assignment never shows (#231).
   */
  mineAfter?: number | undefined;
  /** The board your Mine is of (#236): another board's `board.changed` is not this one's. */
  board?: BoardChangedEvent['board'] | undefined;
  /** The Factory view's selected card's teammate owner (the `whose` param, from its Board). */
  whose?: string | undefined;
  /** The pinned session's rendered Chat (its transcript, cursor, folds, scroll). */
  rendered?: Rendered | undefined;
  /** An entry of `at`'s session to show (the Run page's Open in Chat, 3.0 #21), until pinned. */
  at?: { session: string; entry: string } | undefined;
  /**
   * The rendered Chats of the sessions pinned before, by session id (#105 S2): going back to a
   * workspace's or a card's session finds its folds, cursor and scroll where they were.
   */
  kept?: Readonly<Record<string, Rendered>> | undefined;
  /** The pinned session's cards (#114: questions, permissions, Needs you, Override). */
  cards?: ChatCards | undefined;
  /** The tick's time: the header's time in state, a running step's. */
  now?: string | undefined;
  /** The slot has the keyboard (`focus`). */
  focused: boolean;
  /** The keys went to a layer (a menu, Command mode) while this session was pinned ('' none). */
  layered?: string | undefined;
  /** The Editor's caret (`caret`): M1's implicit context. */
  caret?: Caret | undefined;
  /**
   * A workspace jump landed on a box not known to run (#105 Behaviour 7, the `waking` param): Chat says
   * `Waking <box>…` with the box's state until `box.state` says it runs.
   */
  waking?: { box: string; state: string; failed?: string | undefined } | undefined;
  /** The composer (#115): a draft per session, the caret's chip, the queue, the model line. */
  composer: ComposerState;
  /** When the composer last took a key or the field's text (the bridge's `at`): typing then. */
  typed?: string | undefined;
  /** Terminal mode (the `mode: terminal` param, the Factory view's column, #155). */
  terminal?: boolean | undefined;
  /**
   * Each session's attach in Terminal mode, by session id: its run (the Terminal's key) and
   * whether it exited. An exited one stays drawn; going into Terminal mode again attaches anew.
   */
  attached?: Readonly<Record<string, { run: number; exited: boolean }>> | undefined;
  /** `serve.target` in the shown folder, once read: where a card's ⏎ launches (#208). */
  target?: string | undefined;
  /**
   * How many times `serve.target` changed (#223): a read's id carries it, so only the newest
   * read's answer counts; `target` is stale until it answers and is read again before it is used.
   */
  targetChanges?: number | undefined;
  /** `target` is from before `serve.target`'s last change (#223). */
  targetStale?: boolean | undefined;
  /**
   * `abe chat` asked (`:chat`, the `hub` open param, ⏎ on the main checkout's empty Chat, New
   * conversation): Chat pins on its answer, or says why it could not.
   */
  hubbing?: { failed?: string | undefined } | undefined;
  /**
   * `box list` as read for the pinned session's box (`boxListFor`), and the `box.state` moves
   * since: its header's cloud says what the box does, not what its ended session suggests.
   */
  boxList?: BoxListData | undefined;
  boxMoves?: BoxMoves | undefined;
  /**
   * The Abe chat's conversation shown last, by its repo: Chat goes back to it (its tab selected),
   * after ⌘⌥A or a round of the workspaces too; the newest only while none was shown yet.
   */
  hubShown?: Readonly<Record<string, string>> | undefined;
  /** The tab marked shown in serve last (`abe chat --shown`), by its repo: one shown by choice. */
  hubMarked?: Readonly<Record<string, string>> | undefined;
  /**
   * ⌘§ went to the repo's Abe chat from here: the pin it had, which ⌘§ again goes back to, the
   * card Chat followed (the Board's) with it.
   */
  abeBack?:
    | {
        session?: string | undefined;
        launched?: string | undefined;
        card?: number | undefined;
        named?: { card: number; title: string } | undefined;
        whose?: string | undefined;
      }
    | undefined;
  /**
   * `:install` (#71, the `install` open param): `abe install` asked (it opens the repo's Abe chat
   * and says `/abe:install` there while not Done), until it answers, or why it could not; then
   * Chat pins on it.
   */
  installing?: { failed?: string | undefined } | undefined;
  /** The install's status (`install status`, `install.changed`): its strip atop the Abe chat. */
  install?: InstallView | undefined;
  /** What unfolds under the install's strip: a part's last check, or its files; undefined: none. */
  installOpen?: InstallOpen | undefined;
  /** The Abe chat the status was last read for: once each, then on its turn's end. */
  installRead?: string | undefined;
  /** ⌘⏎ asked on this card before its run was read (#315): its menu opens once it is (`held.ts`). */
  heldMenu?: number | undefined;
  /** What `chat-session` last said (#340); undefined: nothing said yet. */
  toldSession?: string | null | undefined;
  /**
   * The prototypes (`prototype list`), read while a prototype session is pinned: its header's
   * preview address and app state; read again as a prototype moves (`prototype.*`, `command.ran
   * prototype`). `protoAsked`: a read is out.
   */
  prototypes?: PrototypeData[] | undefined;
  /** The live facts last handed: the sessions, runs, launches, boxes and prototypes are theirs. */
  facts?: LiveFacts | undefined;
};

const bare = (path: string) => path.replace(/\/+$/, '');

/** The newest first; one not ended before an ended one (#105). */
const ranked = (sessions: readonly SessionData[]): SessionData[] =>
  [...sessions].sort(
    (a, b) =>
      Number(b.state !== 'ended') - Number(a.state !== 'ended') ||
      Date.parse(b.startedAt) - Date.parse(a.startedAt),
  );

/** An Abe chat conversation's repo, the key its shown tab is kept by (`hubShown`). */
const hubRepo = (x: Pick<SessionData, 'abe' | 'repo'>): string => bare(x.abe?.repo ?? x.repo);

/** The repo's Abe chat conversation shown last, while it is open; none: the newest goes. */
const hubKept = (
  s: Pick<PinnedState, 'hubShown'>,
  sessions: readonly SessionData[],
  repo: string,
): SessionData | undefined => {
  const id = s.hubShown?.[bare(repo)];

  return id === undefined
    ? undefined
    : sessions.find((x) => x.id === id && x.kind === 'abe' && x.state !== 'ended');
};

/** Whether `id` is a prototype's session as read: pinned only while an open names it (its tile). */
const tileOnly = (s: Pick<PinnedState, 'sessions'>, id: string | undefined): boolean =>
  id !== undefined && (s.sessions ?? []).some((x) => x.id === id && x.kind === 'prototype');

/** What Chat is pinned to: a session (and its run), or only a card (a story), or nothing. */
export type Pin = { card?: number | undefined; session?: SessionData; run?: FactoryRunData };

/** Whether a session runs in the shown workspace: a cloud one by its box, a local one by its worktree. */
const inWorkspace = (s: Pick<PinnedState, 'root' | 'box'>, x: SessionData): boolean =>
  s.box === undefined
    ? s.root !== undefined && bare(x.worktree) === bare(s.root)
    : placedBox(x) === s.box;

/**
 * The pinning rule (#105 S1): a chosen session (the `session` param, or the one launched from
 * here) holds (once ended, until a new session on its story comes: `followNewer`, #227); else
 * what the story's card stands for (`standing`, #335: as its Board card and Sessions read it),
 * else the story's newest session, ended. The story is
 * the `card` param (the Factory view's selected card), else the card of a session in the shown
 * workspace, else the workspace's branch's (`card/<n>-…`); none: the main checkout, no story.
 */
export const pinOf = (s: PinnedState): Pin => {
  if (s.noCard === true) return {};
  const sessions = s.sessions ?? [];
  const runs = s.runs ?? [];
  const bySession = (id: string): Pin => {
    const session = sessions.find((x) => x.id === id);
    const run = runs.find((r) => r.session === id);
    const card = session?.card ?? run?.card ?? undefined;

    return {
      card,
      ...(session === undefined ? {} : { session }),
      ...(run === undefined ? {} : { run }),
    };
  };

  if (s.session !== undefined) return bySession(s.session);
  if (s.launched !== undefined) return bySession(s.launched);
  const shown = ranked(sessions.filter((x) => inWorkspace(s, x)));
  const own = s.card === undefined ? shown.find((x) => x.card !== null) : undefined;
  const story = s.card ?? own?.card ?? cardOfBranch(s.branch);

  if (story === undefined) {
    // the main checkout: its Abe chat's conversation shown last, else the newest
    const found =
      (shown[0]?.kind === 'abe' ? hubKept(s, shown, hubRepo(shown[0])) : undefined) ?? shown[0];

    return found === undefined ? {} : bySession(found.id);
  }
  // the story's repo (#256): the one the lists were read in, or the workspace session's
  const ofStory = (x: { card: number | null; repo: string }) =>
    x.card === story && (isHere(s.here, x.repo) || x.repo === own?.repo);
  // what the story's card stands for, as the Board and Sessions read it (#335)
  const stands = standing(runs.filter(ofStory), sessions.filter(ofStory)).get(story);

  if (stands !== undefined) return { ...stands, card: story };
  // nothing stands: its newest session all the same (one ended on its own reads Ended)
  const found = ranked(sessions.filter(ofStory))[0];

  return found === undefined ? { card: story } : { ...bySession(found.id), card: story };
};

type Out = { state: PinnedState; commands: Command[] };

/**
 * Chat's reads on a pin: Mine and the card's title; the live sessions and runs read again when it
 * pins a session they do not hold yet (one just launched), or after a write (`fresh`: a launch's
 * answer with its run, a Retry, a Reopen).
 */
const readAll = (s: PinnedState, fresh?: { ran?: FactoryRunData | undefined }): Out => {
  const unknown =
    s.session !== undefined &&
    s.sessions !== undefined &&
    !s.sessions.some((x) => x.id === s.session);
  const live: Command[] =
    fresh !== undefined || unknown
      ? [
          {
            kind: 'live',
            reads: ['sessions', 'runs'],
            ...(fresh?.ran === undefined ? {} : { ran: fresh.ran }),
          },
        ]
      : [];

  return { state: s, commands: [...live, ...titleRead(s)] };
};

/**
 * The card, once, while no session or run of yours is pinned on it: its title, which nothing
 * else names, and its assignee once Mine says it is not yours.
 */
const titleRead = (s: PinnedState): Command[] => {
  const pin = pinOf(s);

  if (pin.card === undefined || s.title?.card === pin.card) return [];
  // the Factory view's Board named it (#309): its title and whose (`whose`) are the Board's, so no
  // `card show` per card the ring passes; one not in your Mine is read once Mine is, for whether
  // no one has it (Assign to me and launch)
  if (s.named?.card === pin.card && (s.whose !== undefined || !notMine(s, pin.card))) return [];

  // a session or run pinned is yours (#306): its card names no one to wait on
  return pin.session === undefined && pin.run === undefined ? [cardRead(pin.card)] : [];
};

/** Mine is read and `card` is not in it. */
const notMine = (s: PinnedState, card: number): boolean =>
  s.mine !== undefined && !s.mine.some((c) => c.id === card);

const cardRead = (card: number): Command => ({
  kind: 'run',
  id: `card:${card}`,
  argv: ['card', 'show', String(card)],
});

/**
 * A teammate's story (#113 Behaviour 11, #114 Behaviour 12): Chat on it is read-only, the header
 * names whose. A session or run pinned is yours whoever holds the card (#306): `session list` and
 * `factory status` list only your serve's and your boxes' (a launch from the CLI, the Board's menu,
 * a Retry on a card someone else holds). With none, the Factory view's Board says whose its
 * selected card is (`whose`); elsewhere it is the story's: not in your Mine and assigned to
 * someone else, it is theirs; until Mine is read, unassigned, or assigned to the person your Mine
 * cards are (you: a card made or assigned after Mine was read, #259), it is yours.
 */
export const whoseOf = (s: PinnedState): string | undefined => {
  const pin = pinOf(s);

  if (pin.session !== undefined || pin.run !== undefined) return undefined;
  if (s.whose !== undefined) return s.whose;
  const card = pin.card;

  if (card === undefined || s.mine === undefined || s.title?.card !== card) return undefined;
  const assignee = s.title.assignee;

  return assignee === null || isYours({ id: card, assignee }, s.mine) ? undefined : assignee.name;
};

/** What the rendered Chat is drawn from, for a pin with a session. */
const factsOf = (s: PinnedState, session: SessionData, run?: FactoryRunData): Facts => {
  return {
    session,
    ...(run === undefined ? {} : { run }),
    ...(s.now === undefined ? {} : { now: s.now }),
    ...(whoseOf(s) === undefined ? {} : { whose: whoseOf(s) }),
    shown: { root: s.root, box: s.box },
    // the runs not read yet (#315): the header says its stage is being read, not none
    ...(s.runs === undefined ? { runsUnread: true } : {}),
    // the Abe chat: its repo's conversations, its tabs
    ...(session.kind === 'abe' ? { hubs: hubsOf(s, session) } : {}),
    ...prototypeFacts(s, session),
    ...boxFacts(s, session),
  };
};

/** The session's box as `box list` and `box.state` say it, for the header's cloud. */
const boxFacts = (s: PinnedState, session: SessionData): Pick<Facts, 'box'> => {
  const box = boxMarkOf(session, s.boxMoves ?? {}, {
    list: s.boxList,
    now: s.now === undefined ? undefined : Date.parse(s.now),
  });

  return box === undefined ? {} : { box };
};

/** A prototype session's prototype as last read, and its card's title. */
const prototypeFacts = (
  s: PinnedState,
  session: SessionData,
): Pick<Facts, 'prototype' | 'cardTitle'> => {
  const of = session.prototype;

  if (of === null) return {};
  const prototype = s.prototypes?.find((p) => p.id === of.id);
  const card = of.card ?? session.card;
  const cardTitle = card === null ? undefined : titleOf(s, card);

  return {
    ...(prototype === undefined ? {} : { prototype }),
    ...(cardTitle === undefined ? {} : { cardTitle }),
  };
};

/** What the cards take from the pin. */
const cardFactsOf = (s: PinnedState, session: SessionData, run?: FactoryRunData) => ({
  session: session.id,
  card: session.card ?? run?.card,
  whose: whoseOf(s),
  ...(session.state === 'ended' ? { ended: true } : {}),
  cursor: s.rendered?.folds.cursor !== undefined,
  // the composer's field has the keys: a card that comes meanwhile waits for it
  composing: s.composer.active,
});

/** The pinned session's cards: read once it is pinned, its run's Needs you kept in step. */
const settleCards = (s: PinnedState, pin: Pin): Out => {
  const session = pin.session;

  if (session === undefined) return { state: { ...s, cards: undefined }, commands: [] };
  const fresh = s.cards?.session === session.id ? undefined : chatCardsFor(session.id);
  const run = chatCardsRun(
    fresh?.held ?? s.cards ?? chatCardsFor(session.id).held,
    pin.run,
    session,
  );
  // ended → live (resumed), however the pin learnt it: its asks read afresh (#317)
  const live = chatCardsLive(run, session);
  const held = live.held;

  return {
    state: held === s.cards ? s : { ...s, cards: held },
    commands: [...(fresh?.commands ?? []), ...live.commands],
  };
};

/** The pinned Chats kept: the one shown before goes in with the rest (#105 S2). */
/** The chat shown before kept as it was, its find bar closed (another chat shown now). */
const keptWith = (s: PinnedState): Readonly<Record<string, Rendered>> => {
  if (s.rendered === undefined) return s.kept ?? {};
  const id = s.rendered.session;
  // the one shown last goes in newest; past `KEPT_CHATS` the oldest not shown is let go, so a long
  // day of Chats viewed holds a bounded few transcripts
  const others = Object.entries(s.kept ?? {}).filter(([k]) => k !== id);

  return Object.fromEntries([
    ...others.slice(Math.max(0, others.length - (KEPT_CHATS - 1))),
    [id, renderedFindClosed(s.rendered)],
  ]);
};

/** How many Chats not shown keep their place (folds, cursor, scroll) for going back to them. */
export const KEPT_CHATS = 8;

/**
 * A workspace jump's Waking gone once its box is known to run (#339): a session on it works, waits or builds
 * its workspace there, however the pin learnt it (a read, a state or step event). A box running
 * already says no `box.state` again.
 */
const woke = (s: PinnedState): PinnedState => {
  const box = s.waking?.box;

  if (box === undefined || !(s.sessions ?? []).some((x) => x.box === box && boxRuns(x))) return s;
  const next = { ...s };

  delete next.waking;

  return next;
};

/** `abe chat --shown`: the Abe chat's tab shown, marked in serve (its answer not waited on). */
const HUB_SHOWN = 'chat:hub-shown';

/**
 * After any input: a newly pinned session's Chat is read (one pinned before comes back as it
 * was, read again for what it missed); none pinned, none held.
 */
const settle = (held: PinnedState): Out => {
  const woken = woke(held);
  const pin = pinOf(woken);
  const session = pin.session;
  // the Abe chat's tab shown by choice (not the main checkout's newest by default: `:chat` and ⌘§
  // ask serve then), kept by its repo (its conversation shown again, not the newest), and marked
  // in serve too, so `abe chat` opens it after the app's restart (F6)
  const chosen = session?.kind === 'abe' && (woken.session ?? woken.launched) === session.id;
  const hubMoved = chosen && woken.hubShown?.[hubRepo(session)] !== session.id;
  const s00 = hubMoved
    ? { ...woken, hubShown: { ...woken.hubShown, [hubRepo(session)]: session.id } }
    : woken;
  const mark = chosen && woken.hubMarked?.[hubRepo(session)] !== session.id;
  const s0 = mark
    ? { ...s00, hubMarked: { ...woken.hubMarked, [hubRepo(session)]: session.id } }
    : s00;
  const marked: Command[] = mark
    ? [
        {
          kind: 'run',
          id: HUB_SHOWN,
          argv: ['chat', '--shown', session.id, '--repo', hubRepo(session)],
        },
      ]
    : [];
  const cards = settleCards(s0, pin);
  const s = cards.state;
  const commands = [...marked, ...cards.commands];

  if (session === undefined)
    return {
      state: s.rendered === undefined ? s : { ...s, rendered: undefined, kept: keptWith(s) },
      commands,
    };
  // Open in Chat at an entry (3.0 #21): its turn shown once the transcript has it
  const at = (r: Rendered): Rendered =>
    s.at?.session === session.id ? revealEntry(r, s.at.entry) : r;
  const told = s.at?.session === session.id ? { at: undefined } : {};

  if (s.rendered?.session === session.id)
    return { state: { ...s, ...told, rendered: at(s.rendered) }, commands };
  const kept = keptWith(s);
  const fresh = renderedFor(session.id);
  const back = kept[session.id];

  return {
    state: { ...s, ...told, rendered: at(back ?? fresh.state), kept },
    commands: [...commands, ...fresh.commands],
  };
};

const balloon = (input: Answer | Refused): Command[] =>
  input.reply.ok
    ? []
    : [
        {
          kind: 'shell',
          effect: {
            kind: 'balloon',
            tone: 'error',
            text: `${input.reply.error.message} (${input.reply.error.code})`,
          },
        },
      ];

/** ⏎ Reopen on an ended prototype session: `session reopen` on it. */
const REOPEN_RUN = 'chat:reopen';
/** A workspace jump's wake asked of serve (#18): the Editor's attach wakes it on EC2, serve saying nothing. */
const WAKING_RUN = 'waking:';

/** The Abe chat `session`'s repo's conversations, as the sessions read lists them. */
const hubsOf = (s: PinnedState, session: SessionData): SessionData[] => {
  const repo = hubRepo(session);

  return (s.sessions ?? []).filter((x) => x.kind === 'abe' && hubRepo(x) === repo);
};

/** Chat pinned on session `id` (the slot's open params naming it, so a reconnect keeps it). */
const pinSession = (s: PinnedState, id: string, more: Command[] = []): Out => {
  const reads = readAll({ ...s, hubbing: undefined, session: id, launched: undefined });
  // its Chat shown at once (the one before kept, its find bar closed)
  const shown = settle(reads.state);

  return {
    state: shown.state,
    commands: [
      ...reads.commands,
      ...shown.commands,
      ...more,
      { kind: 'open', screen: 'chat', params: { session: id }, slot: 'chat', ifOpen: true },
    ],
  };
};

/** ⌘§ as the app tells it (the ISO key left of 1). */
const ABE_KEY = '<D-§>';

/**
 * ⌘§: Chat on the repo's Abe chat (the conversation shown last, else its newest open one, else
 * `abe chat` opens or starts one), the pin it had kept; on the Abe chat, back to that pin (none
 * kept: it stays).
 */
const abeJump = (s: PinnedState, input: Input): Out | undefined => {
  if (input.kind !== 'key' || input.key !== ABE_KEY) return undefined;
  const pin = pinOf(s);
  const x = pin.session;

  if (x?.kind === 'abe') {
    const back = s.abeBack;

    if (back === undefined) return { state: s, commands: [] };
    const read = readAll({
      ...s,
      abeBack: undefined,
      session: back.session,
      launched: back.launched,
      card: back.card,
      named: back.named,
      whose: back.whose,
    });
    const shown = settle(read.state);
    // the slot's open params name the pin again (the Abe chat's open dropped the Board's card)
    const params = {
      ...(back.card === undefined ? {} : { card: String(back.card) }),
      ...(back.named === undefined ? {} : { title: back.named.title }),
      ...(back.whose === undefined ? {} : { whose: back.whose }),
      ...(back.session === undefined ? {} : { session: back.session }),
    };
    const open: Command[] =
      back.card === undefined && back.session === undefined
        ? []
        : [{ kind: 'open', screen: 'chat', params, slot: 'chat', ifOpen: true }];

    return { state: shown.state, commands: [...read.commands, ...shown.commands, ...open] };
  }
  const repo = x?.repo ?? s.root;

  if (repo === undefined) return { state: s, commands: [] };
  const kept = {
    ...s,
    abeBack: {
      session: s.session,
      launched: s.launched,
      card: s.card,
      named: s.named,
      whose: s.whose,
    },
  };
  // none shown since the app started: `abe chat` names it (serve's mark, F6)
  const open =
    hubKept(s, s.sessions ?? [], repo) ??
    (s.hubShown?.[bare(repo)] === undefined
      ? undefined
      : (s.sessions ?? [])
          .filter((y) => y.kind === 'abe' && y.state !== 'ended' && hubRepo(y) === bare(repo))
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]);

  return open === undefined ? hubRun(kept, repo) : pinSession(kept, open.id);
};

/** A conversation closed (its tab's ×): its session stopped, kept in Recent conversations…. */
const HUB_STOP = 'chat:tab-stop:';

/**
 * The Abe chat's tabs (`rendered.ts`' `hubTabs`): a click on one pins its conversation, `+`
 * starts a new one, × closes one (its session stopped, never asked; the one shown gives way to
 * its neighbour), and Recent conversations… reopens a closed one as a tab.
 */
const hubTabbed = (s: PinnedState, input: Input): Out | undefined => {
  const pin = pinOf(s);
  const x = pin.session;

  if (x?.kind !== 'abe') return undefined;
  if (input.kind === 'choice' && input.menu === SESSION_MENU && input.row === RECENT_ROW) {
    const id = input.values?.[0];

    return id === undefined
      ? undefined
      : pinSession(s, id, [{ kind: 'run', id: REOPEN_HUB, argv: ['session', 'reopen', id] }]);
  }
  if (input.kind === 'choice' && input.menu === SESSION_MENU && input.row === NEW_CONVERSATION)
    return hubRun(s, x.abe?.repo ?? x.repo, true);
  if (input.kind !== 'click') return undefined;
  if (input.id === HUB_TAB_NEW) return hubRun(s, x.abe?.repo ?? x.repo, true);
  const tabs = hubTabs({ session: x, hubs: hubsOf(s, x) });

  if (input.id.startsWith(HUB_TAB_CLOSE)) {
    const id = input.id.slice(HUB_TAB_CLOSE.length);
    const stop: Command = { kind: 'run', id: `${HUB_STOP}${id}`, argv: ['session', 'stop', id] };
    const i = tabs.findIndex((t) => t.id === id);
    const next = id === x.id ? (tabs[i + 1] ?? tabs[i - 1]) : undefined;
    const ended = tabs[i]?.state === 'ended';

    if (next === undefined) return { state: s, commands: ended ? [] : [stop] };

    return pinSession(s, next.id, ended ? [] : [stop]);
  }
  if (!input.id.startsWith(HUB_TAB)) return undefined;
  const id = input.id.slice(HUB_TAB.length);

  return id === x.id ? { state: s, commands: [] } : pinSession(s, id);
};

/** `abe chat` in the shown folder's repo (`--new`: a new conversation), its answer pinned. */
const hubRun = (s: PinnedState, root: string, fresh = false): Out => ({
  state: { ...s, hubbing: {} },
  commands: [{ kind: 'run', id: HUB_RUN, argv: hubArgv(root, fresh) }],
});

/**
 * `abe chat`'s answer: Chat pinned on the Abe chat (the slot's open params naming it, so a
 * reconnect keeps it), or the refusal in the column.
 */
const onHub = (s: PinnedState, input: Answer | Refused): Out => {
  // asked before Chat moved to another workspace or card: that place's Chat stays its own
  if (s.hubbing === undefined) return { state: s, commands: [] };
  if (input.command !== 'chat' || !input.reply.ok)
    return input.reply.ok
      ? { state: { ...s, hubbing: undefined }, commands: [] }
      : {
          state: {
            ...s,
            hubbing: { failed: `${input.reply.error.message} (${input.reply.error.code})` },
          },
          commands: [],
        };
  const hub = input.reply.data;
  // one running: the conversation shown last in the repo (its tab, F6), not `abe chat`'s newest
  const kept = hub.opened === 'running' ? hubKept(s, s.sessions ?? [], hub.repo) : undefined;
  const id = kept?.id ?? hub.id;
  const reads = readAll({ ...s, hubbing: undefined, session: id, launched: undefined });

  return {
    state: reads.state,
    commands: [
      ...reads.commands,
      { kind: 'open', screen: 'chat', params: { session: id }, slot: 'chat', ifOpen: true },
    ],
  };
};

const onResult = (s: PinnedState, input: Answer | Refused): Out => {
  if (input.id.startsWith(WAKING_RUN)) {
    const w = s.waking;

    if (w === undefined || input.id !== `${WAKING_RUN}${w.box}`) return { state: s, commands: [] };
    // a box running already sends no box.state: its answer says it
    if (input.reply.ok && input.command === 'box start' && input.reply.data.state === 'running') {
      const next = { ...s };

      delete next.waking;

      return { state: next, commands: [] };
    }
    if (!input.reply.ok)
      return {
        state: {
          ...s,
          waking: { ...w, failed: `${input.reply.error.message} (${input.reply.error.code})` },
        },
        commands: [],
      };

    return { state: s, commands: [] };
  }
  if (input.id === HUB_RUN) return onHub(s, input);
  if (isActionAnswer(input.id)) {
    // (no `u` here: the composer takes it)
    const out = actionAnswer(s.actions, input, { undo: false });
    const from = s.launchFrom;
    const card = launchedCard(input.id);
    const next = {
      ...s,
      actions: out.actions,
      ...(card === undefined ? {} : { launchFrom: undefined }),
    };
    const l = out.launched;

    // an assign's answer, or another workspace shown meanwhile: the run is the other's
    if (card === undefined || from === undefined || from.root !== s.root || from.box !== s.box)
      return { state: next, commands: out.commands };
    // refused: no launch, so none of its steps shown (#229)
    if (l === undefined)
      return { state: { ...next, launchSeen: undefined }, commands: out.commands };
    const read = readAll(
      {
        ...next,
        launched: l.run.session,
        runs: [...(next.runs ?? []).filter((r) => r.session !== l.run.session), l.run],
      },
      { ran: l.run },
    );

    return { state: read.state, commands: [...out.commands, ...read.commands] };
  }
  // a prototype session reopened like a card's session (#343): the sessions read again (it is
  // the same session); refused, said
  if (
    input.id === 'retry' ||
    input.id === REOPEN_RUN ||
    input.id === REOPEN_HUB ||
    input.id.startsWith('reopen:')
  ) {
    const next = { ...s, reopening: undefined };

    return input.reply.ok ? readAll(next, {}) : { state: next, commands: balloon(input) };
  }
  if (!input.reply.ok) return { state: s, commands: [] };
  switch (input.command) {
    case 'card show': {
      const c = input.reply.data;

      // the card left's, answering late (#309): not this pin's title nor whose
      if (c.id !== pinOf(s).card) return { state: s, commands: [] };

      return {
        state: { ...s, title: titled(c) },
        commands: [],
      };
    }
    case 'settings get': {
      const value = input.reply.data.value;

      // an answer asked for the folder shown before is dropped
      return input.id === targetId(s) && typeof value === 'string'
        ? { state: { ...s, target: value, targetStale: false }, commands: [] }
        : { state: s, commands: [] };
    }
    default:
      return { state: s, commands: [] };
  }
};

/**
 * Cards changed on Azure DevOps outside Abe (#236, serve's fresh look), on your Mine's board: the
 * pinned story's title and assignee as serve read it, and your Mine with each card in or out as
 * the board lists it now. Nothing is read; what is typed, the cursor and the scroll stay.
 */
const boardMoved = (s: PinnedState, d: BoardChangedEvent): PinnedState => {
  if (!sameBoard(s.board, d.board)) return s;
  const card = pinOf(s).card;
  const now = d.cards.find((c) => c.card.id === card)?.card;
  // (Mine is live's, moved there)
  if (now === undefined) return s;
  // the Board's name for it (the Factory view's `title` param, never `card show`'s) is renamed in
  // place, so the Board's next name still wins; else the card as `card show` would read it
  if (s.named?.card === now.id && s.title?.card !== now.id)
    return { ...s, named: { card: now.id, title: now.title } };

  return { ...s, title: titled(now) };
};

/**
 * The live facts handed: the sessions, runs, launches, boxes and prototypes Chat draws. A new
 * session list lets go of the last quit's session gone since; a list that failed lets a ⌘⏎ held
 * for it give way; runs or prototypes that failed say none, so the header goes on without them.
 */
const onFacts = (s: PinnedState, f: LiveFacts): Out => {
  const listed = f.read.sessions.answers > (s.facts?.read.sessions.answers ?? 0);
  const failedNow =
    f.read.sessions.failed !== undefined && s.facts?.read.sessions.failed === undefined;
  const sessions = f.sessions;
  // the last quit's session gone since, or a prototype's (its tile's): Chat pins as without it
  const gone =
    listed &&
    sessions !== undefined &&
    s.session !== undefined &&
    s.session === s.restored &&
    !sessions.some((x) => x.id === s.session && x.kind !== 'prototype');
  const next: PinnedState = {
    ...s,
    facts: f,
    sessions,
    runs: f.runs ?? (f.read.runs.failed === undefined ? undefined : (s.runs ?? [])),
    here: f.here ?? s.here,
    launchesHeard: Object.keys(f.launches).length === 0 ? undefined : f.launches,
    boxList: f.boxList,
    boxMoves: f.boxMoves,
    prototypes:
      f.prototypes ?? (f.read.prototypes.failed === undefined ? undefined : (s.prototypes ?? [])),
    ...(listed && sessions !== undefined
      ? { composer: sessions.reduce(composerSession, s.composer) }
      : {}),
    ...(gone ? { session: undefined } : {}),
    ...(failedNow ? { heldMenu: undefined } : {}),
  };
  // Mine: yours meanwhile after an assign, until a read answered since
  const mineIn =
    f.mine !== s.facts?.mine &&
    f.mine !== undefined &&
    (s.mineAfter === undefined || f.read['cards:mine'].answers > s.mineAfter);
  const mined: PinnedState =
    mineIn && f.mine !== undefined
      ? {
          ...next,
          mine: f.mine.cards.map((c) => ({ id: c.id, assignee: c.assignee })),
          board: {
            organization: f.mine.board.organization,
            project: f.mine.board.project,
            team: f.mine.board.team,
          },
          mineAfter: undefined,
        }
      : next;
  const moved = f.sessions !== s.facts?.sessions || f.runs !== s.facts?.runs || listed || mineIn;

  return { state: mined, commands: moved ? titleRead(mined) : [] };
};

/**
 * The watch's events Chat takes (its transcript, its cards, its composer, its header, the
 * launches); the rest (a Board's, a box's idle stop) never re-view it. The sessions and runs come
 * as live facts.
 */
const CHAT_EVENTS: ReadonlySet<Event['type']> = new Set([
  'board.changed',
  'box.state',
  'box.step',
  'command.ran',
  'install.changed',
  'launch.ended',
  'launch.started',
  'serve.started',
  'session.answered',
  'session.ask',
  'session.model',
  'session.queued',
  'session.state',
  'session.step',
  'session.transcript',
  'settings.changed',
  'watch.gap',
]);

/** The live facts Chat shows: the sessions and runs; the boxes and prototypes while its pin has one. */
const chatFollows = (s: PinnedState): readonly LiveRead[] => {
  const session = pinOf(s).session;

  return [
    'sessions',
    'runs',
    'cards:mine',
    ...(session !== undefined && placedBox(session) !== undefined ? (['boxes'] as const) : []),
    ...(session !== undefined && session.prototype !== null ? (['prototypes'] as const) : []),
  ];
};

const onEvent = (s: PinnedState, event: Event): Out => {
  switch (event.type) {
    case 'serve.started':
    case 'watch.gap':
      // (the sessions, runs, launches, prototypes and Mine are live's: read again there)
      return { state: s, commands: titleRead(s) };
    case 'settings.changed': {
      // read again when it moved (now, or on the next card when none is shown, #223); the header
      // keeps the old place meanwhile
      // local mode and the board keep launches here whatever serve.target says (serve's reply)
      if (!event.data.keys.some((k) => TARGET_KEYS.includes(k))) return { state: s, commands: [] };
      const next = { ...s, targetChanges: (s.targetChanges ?? 0) + 1, targetStale: true };

      return { state: next, commands: targetRead(next) };
    }
    case 'session.step': {
      const d = event.data;

      // the launch from here (or the session chosen) not listed yet: its steps kept for the
      // starting look (#229); a listed one's steps are live's
      if (s.sessions?.some((x) => x.id === d.id) !== true)
        return {
          state:
            d.card === pinOf(s).card &&
            (launchHeard(s, d.card) ||
              d.id === s.launched ||
              d.id === s.session ||
              launchHeard(s, d.card))
              ? { ...s, launchSeen: { id: d.id, card: d.card, launch: d.launch } }
              : s,
          commands: [],
        };

      return { state: s, commands: [] };
    }
    case 'launch.started': {
      // asked anywhere (the Board, the Card page, the CLI): Launching here too, its last refusal gone
      const d = event.data;
      const refused = s.launchRefused?.card === d.card ? undefined : s.launchRefused;

      return { state: { ...s, launchRefused: refused }, commands: [] };
    }
    case 'launch.ended': {
      const d = event.data;

      // launched: Launching until its session is listed (live's launches)
      if (d.refused === null && d.session !== null) return { state: s, commands: [] };
      // refused: no session again, and why under it; none of its steps shown (#229)
      const text =
        d.refused === null
          ? 'Launch failed'
          : `Launch refused: ${d.refused.message} (${d.refused.code})`;

      return {
        state: {
          ...s,
          launchRefused: { card: d.card, repo: d.repo, text },
          launchSeen: s.launchSeen?.card === d.card ? undefined : s.launchSeen,
        },
        commands: [],
      };
    }
    case 'command.ran': {
      // a card assigned (Assign… on the Board, `abe card assign`): whose the story is moved, so
      // Mine and the card are read again, yours meanwhile (#231: never its new assignee's while
      // a Mine from before the assignment leaves it out)
      const d = event.data;

      if (d.noun !== 'card' || d.verb !== 'assign' || d.exit !== 0)
        return { state: s, commands: [] };
      const card = pinOf(s).card;

      return {
        state: { ...s, mine: undefined, mineAfter: s.facts?.read['cards:mine'].answers ?? 0 },
        commands: card === undefined ? [] : [cardRead(card)],
      };
    }
    case 'board.changed':
      return { state: boardMoved(s, event.data), commands: [] };
    case 'box.state': {
      // (the box's move is live's) a workspace jump waking it: Waking until it runs
      const w = s.waking;
      const moved = s;

      if (w?.box !== event.data.box) return { state: moved, commands: [] };
      if (event.data.state === 'running') {
        const next = { ...moved };

        delete next.waking;

        return { state: next, commands: [] };
      }

      return { state: { ...moved, waking: { ...w, state: event.data.state } }, commands: [] };
    }
    case 'box.step': {
      // EC2 runs it, its serve not answering yet (#213 B4): booting, as the Boxes tab says it
      const w = s.waking;

      if (w?.box !== event.data.box || event.data.step !== 'booting')
        return { state: s, commands: [] };

      return { state: { ...s, waking: { ...w, state: BOX_BOOTING_WORD } }, commands: [] };
    }
    default:
      return { state: s, commands: [] };
  }
};

type Target = 'local-sandbox' | 'cloud';

/**
 * Where ⏎ launches: the Editor's local workspace in the Local sandbox (the workspace is local, so
 * the session is too); the Factory view's card (`card` param) and a box's where `serve.target` says.
 */
const defaultTarget = (s: PinnedState): Target | undefined =>
  s.card === undefined && s.box === undefined ? 'local-sandbox' : undefined;

/**
 * The `serve.target` read's id: the folder and the changes seen in it, so an answer for one
 * shown before, or one asked before the last change (#223), is dropped.
 */
const targetId = (s: PinnedState) => `target:${s.root ?? ''}#${s.targetChanges ?? 0}`;

/** The settings whose change moves where a card launches: `serve.target`'s read answers for them. */
const TARGET_KEYS: readonly string[] = ['serve.target', 'localMode', 'board'];

/** `serve.target` read once per folder and change, only where ⏎ goes by it (#208). */
const targetRead = (s: PinnedState): Command[] =>
  defaultTarget(s) !== undefined || (s.target !== undefined && s.targetStale !== true)
    ? []
    : [{ kind: 'run', id: targetId(s), argv: ['settings', 'get', 'serve.target'] }];

/** The header's place for a new session (#208): none until `serve.target` is read. */
/** Where serve.target says the Launch box's run goes, for its Runs pick. */
const targetOf = (s: PinnedState): { target?: string } => {
  const t = defaultTarget(s) ?? s.target;

  return t === undefined ? {} : { target: t };
};

const launchEnv = (s: PinnedState): string | undefined => {
  if (defaultTarget(s) === 'local-sandbox') return 'Local sandbox';
  if (s.target === undefined) return undefined;

  // core's `isCloudTarget` (ui reads only core's types, #37): `cloud` alone, anything else local
  return s.target === 'cloud' ? 'Cloud' : 'Local sandbox';
};

/**
 * The launch whose steps Chat shows while its session is not listed (#229): heard for the pin's
 * card, which has no session listed yet; undefined otherwise.
 */
const launchShown = (s: PinnedState): LaunchProgress | undefined => {
  const l = s.launchSeen;
  const pin = pinOf(s);

  return l === undefined || l.card !== pin.card || pin.session !== undefined ? undefined : l.launch;
};

/**
 * A launch on `card` heard going (`launch.started`), from here or anywhere else, in the repo the
 * lists were read in: Launching, nothing launched again, until its session is listed.
 */
const launchHeard = (s: PinnedState, card: number | undefined): boolean =>
  card !== undefined && launchGoing(s.actions, actionsAt(s), card);

/** What the card actions go by in Chat: the launches heard in the repo the lists were read in. */
const actionsAt = (s: PinnedState): ActionsAt => ({ launches: s.launchesHeard, here: s.here });

/** The last launch on `card` refused, in the repo the lists were read in: why, said under it. */
const refusedOn = (s: PinnedState, card: number): string | undefined => {
  const r = s.launchRefused;

  return r?.card === card && isHere(s.here, r.repo) ? r.text : undefined;
};

/** ⏎ with no session: launch on the card, once (a second ⏎ while it runs launches nothing). */
const launch = (
  s: PinnedState,
  pin: Pin,
  target = defaultTarget(s),
  setup: LaunchSetup = {},
): Out =>
  pin.session !== undefined || pin.run !== undefined
    ? { state: s, commands: [] }
    : launchOn(s, pin, target, s.root, setup);

/**
 * ⇧⏎ with no session (#347): the Launch box on the card, where ⏎ would launch; its ⏎ comes back
 * as `LAUNCH_BOX`'s choice. Nothing while the card's run is not read yet, or it is a teammate's.
 */
const launchBoxHere = (s: PinnedState, runs?: LaunchTarget): Out => {
  const pin = pinOf(s);
  const unread = runUnread(s, pin);

  if (unread !== undefined) return { state: s, commands: [statusLine(readingWords(unread))] };
  if (
    pin.card === undefined ||
    pin.session !== undefined ||
    pin.run !== undefined ||
    launchHeard(s, pin.card) ||
    whoseOf(s) !== undefined
  )
    return { state: s, commands: [] };

  return {
    state: s,
    commands: [
      {
        kind: 'launch',
        id: `${LAUNCH_BOX}${pin.card}`,
        card: pin.card,
        title: titleOf(s, pin.card) ?? '',
        where: launchEnv(s) ?? 'where serve.target says',
        ...targetOf(s),
        ...referenceOf(s, pin.card),
        ...(runs === undefined ? {} : { draft: { note: '', runs } }),
      },
    ],
  };
};

/**
 * No one has the card (`card show` read it so): Chat's launch assigns it to you once it is launched,
 * as the story dialog's Assign to me and launch does, and says so.
 */
const unassigned = (s: PinnedState, card: number): boolean =>
  s.title?.card === card && s.title.assignee === null;

/** The pin's card as a launch sees it: a teammate's is not yours to launch; no one's, yours once launched. */
const launchOnPin = (s: PinnedState, card: number, root = s.root, refused?: string): LaunchOn => {
  const why = refused ?? (whoseOf(s) === undefined ? undefined : 'not yours to launch');

  return { card, root, may: mayOf(why, why === undefined && unassigned(s, card)) };
};

/**
 * `abe factory run` on the pinned story (`card-actions.ts`), followed here as its launch: in the
 * shown folder's repo, a retried run's in its own (`root`); none while one is going.
 */
const launchOn = (
  s: PinnedState,
  pin: Pin,
  target: LaunchTarget | undefined,
  root = s.root,
  setup: LaunchSetup = {},
): Out => {
  if (pin.card === undefined) return { state: s, commands: [] };
  const out = cardLaunch(s.actions, actionsAt(s), launchOnPin(s, pin.card, root), target, setup);

  if ('refused' in out) return { state: s, commands: [] };

  return {
    state: {
      ...s,
      actions: out.actions,
      launchFrom: { root: s.root, box: s.box },
      launchSeen: undefined,
    },
    commands: out.commands,
  };
};

/**
 * The story's card while its run or the sessions are not read yet (#315, as the Board's): ⏎ and
 * ⌘⏎ wait for them (a status line says so), so no Resume stands where Retry would, and no launch
 * goes where a run or a session may be.
 */
const runUnread = (s: PinnedState, pin: Pin): number | undefined =>
  s.sessions === undefined || (s.runs === undefined && pin.run === undefined)
    ? pin.card
    : undefined;

/** ⏎ with no session launches; with one, the transcript has it (`rendered.ts`). */
const enter = (s: PinnedState): Out => {
  const pin = pinOf(s);
  const unread = runUnread(s, pin);

  // a launch is not held: it waits for no one (only the menu is, `HELD_MENU`)
  if (unread !== undefined) return { state: s, commands: [statusLine(readingWords(unread))] };
  // the main checkout, no story: the Abe chat started (or reopened)
  if (pin.session === undefined && pin.run === undefined && pin.card === undefined)
    return s.root === undefined || s.box !== undefined || s.hubbing !== undefined
      ? { state: s, commands: [] }
      : hubRun(s, s.root);
  if (pin.session === undefined && pin.run === undefined) return launchBoxHere(s);

  return resume(s) ?? { state: s, commands: [] };
};

/**
 * ⏎ on an ended session of yours, as its ended line says (#343): Reopen, the same session id,
 * worktree and Claude Code conversation, a run's (any, failed, stopped or Done) and a plain one's
 * alike; `undefined` for a teammate's, a chat's or a prototype's (it goes on from its own place).
 */
const resume = (s: PinnedState): Out | undefined => {
  const pin = pinOf(s);
  const session = pin.session;

  if (session?.state !== 'ended') return undefined;
  // the Abe chat's conversation or a prototype session: the same conversation goes on (`session
  // reopen`, #343's rule; the Abe chat's other conversations stay as they are)
  if (session.prototype !== null || session.kind === 'abe') {
    if (endedStep(s, pin) !== 'reopen') return undefined;

    return s.reopening === session.id
      ? { state: s, commands: [] }
      : {
          state: { ...s, reopening: session.id },
          commands: [{ kind: 'run', id: REOPEN_RUN, argv: ['session', 'reopen', session.id] }],
        };
  }
  // a card's session whose claude never started (#355): no conversation to go back into, said
  if (
    pin.card !== undefined &&
    whoseOf(s) === undefined &&
    session.kind === 'card' &&
    session.transcriptPath === null
  )
    return {
      state: s,
      commands: [statusLine(noConversation(pin.run !== undefined && retriesRun(pin.run)))],
    };
  if (endedStep(s, pin) !== 'reopen' || pin.card === undefined) return undefined;
  // once: a second ⏎ while it reopens asks nothing more
  if (s.reopening === session.id) return { state: s, commands: [] };

  return {
    state: { ...s, reopening: session.id },
    commands: [reopenCommand(pin.card, session.id)],
  };
};

/** What ⏎ does on an ended session (`resume`), as its ended line names it; none: nothing. */
const endedStep = (s: PinnedState, pin: Pin): ComposerFacts['step'] => {
  const session = pin.session;

  if (session?.state !== 'ended' || whoseOf(s) !== undefined) return undefined;
  // a prototype session and the Abe chat go on in their conversation
  if (session.prototype !== null || session.kind === 'abe') return 'reopen';
  // a card's own session only, one that had a box and whose claude started (`sessionReopens`)
  return pin.card !== undefined && sessionReopens(session) ? 'reopen' : undefined;
};

/** The menu's id: its rows come back as `choice`s. */
const MENU = 'chat:more';
/** Chat's Launch agent ⏎ with no session (W-NoSession). */
const LAUNCH = 'chat:launch';

/**
 * ⌘⏎: the session's actions (Stop…, Retry, Open workspace …); with none, the launch's menu. Asked
 * before the card's run is read (#315): held, it opens once it is (`HELD_MENU`).
 */
const more = (s: PinnedState): Out => {
  const pin = pinOf(s);
  const unread = runUnread(s, pin);

  if (unread !== undefined) return holdPress(HELD_MENU, s, unread, readingWords(unread));
  if (pin.session !== undefined)
    return { state: s, commands: [sessionMenu(factsOf(s, pin.session, pin.run))] };
  if (pin.card === undefined || pin.run !== undefined || whoseOf(s) !== undefined)
    return { state: s, commands: [] };

  return {
    state: s,
    commands: [
      {
        kind: 'menu',
        id: MENU,
        title: `#${pin.card}`,
        rows: [
          // each opens the Launch box, where it runs picked: the menu rests on neither (#313)
          {
            id: 'launch-local-sandbox',
            text: 'Launch in Local sandbox',
            costly: true,
            does: { kind: 'back' },
          },
          { id: 'launch-cloud', text: 'Launch on a box', costly: true, does: { kind: 'back' } },
          {
            id: 'launch-box',
            text: 'Launch agent…',
            costly: true,
            dim: 'its workflow, where it runs, a note, grill me or just build',
            key: '⏎',
            does: { kind: 'back' },
          },
          // the story's jumps, as with a session (#213, #346)
          { id: 'story', text: 'Open card', separator: true, does: { kind: 'back' } },
          { id: 'linked', text: 'Linked', key: '⌃L', does: { kind: 'back' } },
        ],
      },
    ],
  };
};

/**
 * The early ⌘⏎ held (#315, `held.ts`): its menu opens once the runs are read, or nothing once Chat
 * is on another card.
 */
const HELD_MENU: Hold<PinnedState, number> = {
  held: (s) => s.heldMenu,
  hold: (s, card) => ({ ...s, heldMenu: card }),
  ready: (s, card) => pinOf(s).card !== card || runUnread(s, pinOf(s)) === undefined,
  act: (s, card) => (pinOf(s).card === card ? more(s) : { state: s, commands: [] }),
};

/** Esc the screen did not take (#119): the app's column hands the keyboard back to the code. */
const UNHANDLED_ESC: Command = {
  kind: 'shell',
  effect: { kind: 'unhandled', slot: 'chat', key: '<Esc>' },
};

const onKey = (s: PinnedState, key: string): Out => {
  switch (key) {
    case '<CR>':
      return enter(s);
    case '<D-CR>':
      return more(s);
    case '<S-CR>':
      return launchBoxHere(s);
    case '<Esc>':
      // nothing of its own open: the column gives the keyboard back to the code
      return { state: s, commands: [UNHANDLED_ESC] };
    default:
      return { state: s, commands: [] };
  }
};

/** A prototype session's address clicked: its preview in the browser. */
const showPage = (s: PinnedState): Out => {
  const pin = pinOf(s);

  return {
    state: s,
    commands: pin.session === undefined ? [] : previewOpen(factsOf(s, pin.session, pin.run)),
  };
};

const onClick = (s: PinnedState, id: string): Out => {
  switch (id) {
    case PROTOTYPE_PAGE:
      return showPage(s);
    case LAUNCH:
    case HUB_START:
      return enter(s);
    case MENU:
      return more(s);
    default:
      return { state: s, commands: [] };
  }
};

/**
 * Another workspace shown (its folder or box changed): what was chosen or launched there was the
 * other's. The branch alone (read after the folder) changes no pin.
 */
const moved = (s: PinnedState, root: string, box?: string, branch?: string): PinnedState => {
  if (root === s.root && box === s.box) return branch === s.branch ? s : { ...s, branch };
  const next: PinnedState = { ...s, root, box, branch };

  // its own serve.target, its own layers
  if (root !== s.root) {
    delete next.target;
    delete next.targetStale;
  }
  // the repo the lists were read in was the other project's (#256): read again there
  if (root !== s.root) delete next.here;
  delete next.launched;
  delete next.session;
  delete next.launchFrom;
  delete next.launchSeen;
  if (next.waking?.box !== box) delete next.waking;

  return next;
};

/**
 * The Board's title for `card` (the `title` param, #309); an open on the same card without one
 * (Board ⏎'s) keeps the one it had.
 */
const namedOf = (
  card: number | undefined,
  title: string | undefined,
  had: PinnedState['named'],
): PinnedState['named'] => {
  if (card === undefined) return undefined;
  if (title !== undefined) return { card, title };

  return had?.card === card ? had : undefined;
};

/** The `card` param when the Factory view's Board selects no card (#309). */
const NO_CARD = 'none';

const paramCard = (text: string | undefined): number | undefined => {
  const n = Number(text);

  return text === undefined || !Number.isInteger(n) || n <= 0 ? undefined : n;
};

const stepPinned = (s: PinnedState, input: Input): Out => {
  switch (input.kind) {
    case 'open': {
      const p = input.params;
      // another folder: its own box and branch, never the last one's (the Abe chat on Boxes
      // from a card's workspace is the main checkout's, not that card's branch)
      const same = p.root === s.root;
      const where =
        p.root === undefined
          ? s
          : moved(
              s,
              p.root,
              same ? (p.box ?? s.box) : p.box,
              same ? (p.branch ?? s.branch) : p.branch,
            );
      const card = paramCard(p.card);
      // the Board selecting no card (its first selection, as an install wrote its board, M1)
      // leaves the Abe chat you went to pinned: only a card selected moves Chat off it
      const hubHeld =
        p.card === NO_CARD &&
        p.session === undefined &&
        s.session !== undefined &&
        where.session === s.session &&
        pinOf(s).session?.kind === 'abe';
      // the chosen session holds until the workspace or the card changes, or the Board's click
      // on its selected card shows the card (`picked`, M5)
      const picked = p.picked !== undefined && card !== undefined;
      // a prototype's session is its tile's: an open naming no session (the tile left for the
      // workspace in the same folder, Abe's on ⌘↓ round) never keeps Chat on it
      const kept =
        ((card === where.card && !picked) || hubHeld) &&
        (p.session !== undefined || !tileOnly(s, where.session))
          ? where
          : { ...where, session: undefined, launched: undefined };
      const terminal = p.mode === 'terminal';
      // `:chat` (the `hub` param): the repo's Abe chat opened and pinned
      const hub = p.hub !== undefined && (p.root ?? s.root) !== undefined;
      // the session Chat was on at the last quit: pinned once (never a prototype's, its tile's)
      const restore = p.restore === s.restored || tileOnly(s, p.restore) ? undefined : p.restore;
      // `abe chat` asked here is still awaited while Chat stays in this place
      const awaited =
        where.root === s.root && where.box === s.box && card === s.card ? s.hubbing : undefined;
      const next: PinnedState = {
        ...kept,
        size: input.size,
        card,
        session: p.session ?? restore ?? kept.session,
        restored: p.restore ?? s.restored,
        at:
          p.at === undefined || p.session === undefined
            ? undefined
            : { session: p.session, entry: p.at },
        whose: p.whose,
        named: namedOf(card, p.title, kept.named),
        noCard: p.card === NO_CARD && !hubHeld ? true : undefined,
        terminal,
        hubbing: hub ? {} : awaited,
        // into Terminal mode again: an attach that exited attaches anew
        attached: terminal && s.terminal !== true ? reattached(kept.attached) : kept.attached,
        ...(p.waking === undefined ? {} : { waking: { box: p.waking, state: 'asleep' } }),
      };

      // a session it has not read (one just launched): the sessions and runs read again
      const unread =
        next.session !== undefined && !(s.sessions ?? []).some((x) => x.id === next.session);

      const reads =
        s.sessions === undefined || unread
          ? readAll(next)
          : { state: next, commands: titleRead(next) };

      return {
        ...reads,
        commands: [
          ...reads.commands,
          ...targetRead(next),
          ...(hub ? hubRun(next, p.root ?? s.root ?? '').commands : []),
          // the slot's open params name it again, so a reconnect keeps it
          ...(hubHeld && s.session !== undefined
            ? [
                {
                  kind: 'open' as const,
                  screen: 'chat',
                  params: { session: s.session },
                  slot: 'chat' as const,
                  ifOpen: true as const,
                },
              ]
            : []),
          ...(p.waking === undefined || next.waking === undefined
            ? []
            : [
                {
                  kind: 'run' as const,
                  id: `${WAKING_RUN}${p.waking}`,
                  argv: ['box', 'start', p.waking],
                },
              ]),
        ],
      };
    }
    case 'root': {
      // another project's: a ⌘⏎ held here (#315) is not opened on its runs
      const there = moved(s, input.root, input.box, input.branch);
      const next = input.root === s.root ? there : { ...there, heldMenu: undefined };
      // (the sessions and runs are live's: read again there in the folder shown)
      return { state: next, commands: [...titleRead(next), ...targetRead(next)] };
    }
    case 'resize':
      return { state: { ...s, size: input.size }, commands: [] };
    case 'tick':
      return { state: { ...s, now: input.at }, commands: [] };
    case 'focus':
      return { state: { ...s, focused: input.focused }, commands: [] };
    case 'caret': {
      const caret: Caret = {
        file: input.file,
        line: input.line,
        ...(input.selection === undefined ? {} : { selection: input.selection }),
      };

      return { state: { ...s, caret }, commands: [] };
    }
    case 'no-caret': {
      const next = { ...s };

      delete next.caret;

      return { state: next, commands: [] };
    }
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return onClick(s, input.id);
    case 'choice':
      // `:override` with no session here (the cards take it when there is one)
      if (input.menu === OVERRIDE_MENU)
        return {
          state: s,
          commands: [
            {
              kind: 'shell',
              effect: {
                kind: 'balloon',
                tone: 'warning',
                text: 'No session here to override: the Override is on the shown workspace’s session',
              },
            },
          ],
        };
      // a launch's box short of memory or disk: the answer chosen sends it again
      if (input.menu.startsWith(LAUNCH_SHORT)) {
        const out = shortChoice(
          s.actions,
          Number(input.menu.slice(LAUNCH_SHORT.length)),
          input.row,
        );

        return { state: { ...s, actions: out.actions }, commands: out.commands };
      }
      // the Launch box's ⏎ (#347), on the card Chat is still on
      if (input.menu.startsWith(LAUNCH_BOX)) {
        const card = Number(input.menu.slice(LAUNCH_BOX.length));
        const pin = pinOf(s);

        if (!Number.isInteger(card)) return { state: s, commands: [] };
        const other = (() => {
          if (card !== pin.card) return 'Chat is on another card now';

          return pin.session !== undefined || pin.run !== undefined
            ? 'it has a session already'
            : undefined;
        })();
        const out = launchFromBox(
          s.actions,
          actionsAt(s),
          launchOnPin(s, card, s.root, other),
          {
            kind: 'launch',
            id: input.menu,
            card,
            title: titleOf(s, card) ?? '',
            where: launchEnv(s) ?? 'where serve.target says',
            ...targetOf(s),
            ...referenceOf(s, card),
          },
          input.values,
          defaultTarget(s),
        );
        const launched = out.commands.some((c) => c.kind === 'run');

        return {
          state: {
            ...s,
            actions: out.actions,
            ...(launched
              ? { launchFrom: { root: s.root, box: s.box }, launchSeen: undefined }
              : {}),
          },
          commands: out.commands,
        };
      }
      if (input.menu !== MENU) return { state: s, commands: [] };
      switch (input.row) {
        case 'launch-box':
          return launchBoxHere(s);
        case 'launch-local-sandbox':
          return launchBoxHere(s, 'local-sandbox');
        case 'launch-cloud':
          return launchBoxHere(s, 'cloud');
        case 'story':
        case 'linked':
          return { state: s, commands: jumpCommands(input.row, pinOf(s).card) };
        default:
          return launch(s, pinOf(s));
      }
    case 'result':
      return onResult(s, input);
    case 'event':
      return onEvent(s, input.event);
    case 'live':
      return onFacts(s, input.facts);
    case 'exit':
      return { state: attachExited(s, input.key), commands: [] };
    default:
      return { state: s, commands: [] };
  }
};

/** Every attach that exited gets a new run (its next Terminal a new key). */
const reattached = (attached: PinnedState['attached']): PinnedState['attached'] =>
  attached === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(attached).map(([id, a]) => [
          id,
          a.exited ? { run: a.run + 1, exited: false } : a,
        ]),
      );

/**
 * Terminal mode's Terminal key for a session's attach (the shell finds the Editor's Claude Code tab's
 * attach by its `attach:<session>:` prefix, #340).
 */
const attachKey = (s: PinnedState, session: string): string =>
  `attach:${session}:${s.attached?.[session]?.run ?? 0}`;

/** A Terminal exited: the session attach under that key, if one, exited. */
const attachExited = (s: PinnedState, key: string): PinnedState => {
  const id = (s.sessions ?? []).map((x) => x.id).find((x) => attachKey(s, x) === key);

  if (id === undefined) return s;

  return {
    ...s,
    attached: { ...s.attached, [id]: { run: s.attached?.[id]?.run ?? 0, exited: true } },
  };
};

/** The program that attaches to a session's Claude Code: its tmux here, or on its box. */
const attachArgv = (session: SessionData): string[] =>
  session.box === undefined
    ? ['abe', 'session', 'attach', session.id]
    : ['abe', 'box', 'attach', session.box, '--session', session.id];

/**
 * Terminal mode (#155): the header B over the session attached (yours: #306); an ended one has
 * nothing to attach here, so it says so.
 */
const attachBody = (s: PinnedState, session: SessionData): Node => {
  if (session.state === 'ended') return empty('Session ended', '⌃⌘← Chat shows its transcript');

  return {
    kind: 'Terminal',
    id: 'chat-terminal',
    props: { key: attachKey(s, session.id), argv: attachArgv(session), focused: s.focused },
  };
};

const attachView = (s: PinnedState, session: SessionData, run?: FactoryRunData): Node => {
  const body = attachBody(s, session);

  return island(
    [stack('column', [headerOf(factsOf(s, session, run)), body], { sizes: ['auto', { flex: 1 }] })],
    'chat',
  );
};

/** The input on the pinned session's transcript first: keys, clicks, its read, its events. */
const onRendered = (s: PinnedState, input: Input): Out | undefined => {
  const pin = pinOf(s);

  if (pin.session === undefined || s.rendered?.session !== pin.session.id) return undefined;
  const out = stepRendered(s.rendered, factsOf(s, pin.session, pin.run), input);

  return out === undefined
    ? undefined
    : { state: { ...s, rendered: out.state }, commands: out.commands };
};

/**
 * Find in the transcript first (`find.ts`): ⌘F opens its field, the keys taken from the composer
 * (or the transcript) until Esc gives them back; its bar's clicks; its field's keys and text. Not
 * in Terminal mode, nor while a card's own words or an Override's reason are typed (theirs).
 */
const onFind = (s: PinnedState, input: Input): Out | undefined => {
  const pin = pinOf(s);
  const r = s.rendered;

  if (pin.session === undefined || r?.session !== pin.session.id || s.terminal === true)
    return undefined;
  // ⌘F, or a click on its field
  if (
    (input.kind === 'key' && input.key === '<D-f>') ||
    (input.kind === 'click' && input.id === FIND_ID)
  ) {
    if (s.cards?.cards.typing !== undefined || s.cards?.cards.override !== undefined)
      return undefined;
    const from = s.composer.active || r.find?.composer === true;

    return {
      state: {
        ...s,
        rendered: renderedFindOpen(r, from),
        composer: composerFocus(s.composer, false),
      },
      commands: [],
    };
  }
  const out = renderedFindInput(r, factsOf(s, pin.session, pin.run), input);

  if (out === undefined) return undefined;
  const composer = out.back ? composerFocus(s.composer, true) : s.composer;

  return { state: { ...s, rendered: out.state, composer }, commands: [] };
};

/** The input on the pinned session's cards first: an open card takes the keys (#114). */
const onCards = (s: PinnedState, input: Input): Out | undefined => {
  const pin = pinOf(s);

  if (pin.session === undefined || s.cards?.session !== pin.session.id) return undefined;
  const facts = cardFactsOf(s, pin.session, pin.run);

  // Tab to a card that waits (it came while you typed): the keys its own, the draft kept
  if (
    input.kind === 'key' &&
    input.key === '<Tab>' &&
    chatCardsWait(s.cards, facts) &&
    !composerMenuOpen(s.composer, composerFacts(s) ?? NO_FIELD)
  )
    return {
      state: {
        ...s,
        cards: chatCardsWaits(s.cards, false),
        composer: composerFocus(s.composer, false),
      },
      commands: [],
    };
  const out = stepChatCards(s.cards, facts, input);

  return out === undefined
    ? undefined
    : { state: { ...s, cards: out.held }, commands: out.commands };
};

/** The composer's facts for the pinned session; none without one. */
const composerFacts = (s: PinnedState): ComposerFacts | undefined => {
  const pin = pinOf(s);
  const session = pin.session;

  if (session === undefined) return undefined;
  const whose = whoseOf(s);
  const step = endedStep(s, pin);

  return {
    session: session.id,
    focused: s.focused,
    ...(whose === undefined ? {} : { whose }),
    ...(session.state === 'ended'
      ? {
          ended: true,
          // stopped as its header says (#332): a cleared run's session reads ended, as on the card
          ...(session.stopped && (pin.run !== undefined || standsAlone(session))
            ? { stopped: true }
            : {}),
          ...(step === undefined ? {} : { step }),
          endedAt: session.since,
          ...(s.now === undefined ? {} : { now: s.now }),
          // its box stopped under it (#316): the reason's head says so
          ...(endedWithBox(session) && session.reason !== null
            ? { why: session.reason.split(' · ')[0] ?? session.reason }
            : {}),
        }
      : {}),
    // the Factory view's selected card (the `card` param) is the context there
    ...(s.card === undefined ? {} : { card: { id: s.card, title: cardTitle(s, session) } }),
    ...placeholderOf(session, pin.run),
  };
};

/** The empty field's words this long at the most, the title cut to fit (the 420 px column). */
const PLACEHOLDER_MAX = 44;

/**
 * Who the field's message goes to, in its placeholder: the Abe chat's `Ask Abe · make a card ·
 * /abe:…`, a prototype's `Message the prototype…`, a card's `Message #12 Cart total rounds
 * wrong…`; a session of no card says the composer's own.
 */
const placeholderOf = (
  session: SessionData,
  run: FactoryRunData | undefined,
): { placeholder?: string } => {
  if (session.kind === 'abe') return { placeholder: 'Ask Abe · make a card · /abe:…' };
  if (session.prototype !== null) return { placeholder: 'Message the prototype…' };
  const card = session.card ?? run?.card;

  if (card === undefined) return {};
  const words = `Message #${card} ${run?.title ?? session.title}`;
  const chars = Array.from(words);

  if (chars.length < PLACEHOLDER_MAX) return { placeholder: `${words}…` };
  // cut at the last word that fits
  const fits = chars.slice(0, PLACEHOLDER_MAX - 1).join('');
  const space = fits.lastIndexOf(' ');

  return { placeholder: `${(space > 0 ? fits.slice(0, space) : fits).trimEnd()}…` };
};

const cardTitle = (s: PinnedState, session: SessionData): string => {
  if (session.card === s.card) return session.title;

  return s.card === undefined ? '' : (titleOf(s, s.card) ?? '');
};

/** The card's title: `card show`'s once read, else the Board's (the `title` param, #309). */
/** The card as `card show` or the Board has it: its title, whose and whether it has a prototype. */
const titled = (c: CardData): NonNullable<PinnedState['title']> => ({
  card: c.id,
  title: c.title,
  assignee: c.assignee,
  ...(hasPrototype(c) ? { prototype: true } : {}),
});

/** Whether a launch of `card` has a prototype along, when the card was read. */
const referenceOf = (s: PinnedState, card: number): { prototype?: true } =>
  s.title?.card === card && s.title.prototype === true ? { prototype: true } : {};

const titleOf = (s: PinnedState, card: number): string | undefined => {
  if (s.title?.card === card) return s.title.title;

  return s.named?.card === card ? s.named.title : undefined;
};

/** No session pinned: no field, but the caret, the events and answers are still followed. */
const NO_FIELD: ComposerFacts = { session: '', ended: true };

/** The composer's turn: before the transcript (`first`) or after it. */
const onComposer = (s: PinnedState, input: Input, first: boolean): Out & { handled: boolean } => {
  const f = composerFacts(s) ?? NO_FIELD;
  const o = composerInput(s.composer, input, f, first);

  if (o === undefined) return { state: s, commands: [], handled: false };
  // typing now: a card that comes in a moment waits for it (N2)
  const typed =
    o.handled && (input.kind === 'key' || input.kind === 'draft' || input.kind === 'text')
      ? (input.at ?? s.typed)
      : s.typed;
  const cards =
    o.override === undefined || s.cards === undefined
      ? s.cards
      : chatCardsOverride(s.cards, o.override, {
          session: f.session,
          card: pinOf(s).card,
          whose: whoseOf(s),
        });

  return {
    state: { ...s, composer: o.composer, cards, ...(typed === undefined ? {} : { typed }) },
    commands: o.commands,
    handled: o.handled,
  };
};

const step = (s0: PinnedState, input: Input): Out => {
  // find's field takes its keys first; then an open card (#114), the composer's field, the
  // transcript, the rest
  const found = onFind(s0, input);

  if (found !== undefined) return found;
  const cards = onCards(s0, input);

  if (cards !== undefined && input.kind !== 'event') {
    const settled = settle(cards.state);

    return { state: settled.state, commands: [...cards.commands, ...settled.commands] };
  }
  const s1 = cards?.state ?? s0;
  const mine = onComposer(s1, input, true);

  const before = cards?.commands ?? [];

  if (mine.handled) {
    const settled = settle(mine.state);

    return { state: settled.state, commands: [...before, ...mine.commands, ...settled.commands] };
  }
  const later = afterComposer(mine.state, input);

  if (later.handled)
    return { state: later.state, commands: [...before, ...mine.commands, ...later.commands] };
  const theirs = onComposer(later.state, input, false);
  const settled = settle(theirs.state);

  return {
    state: settled.state,
    commands: [
      ...before,
      ...mine.commands,
      ...later.commands,
      ...theirs.commands,
      ...settled.commands,
    ],
  };
};

/** How lately typing keeps a card that comes from taking the keys (N2). */
const TYPED_LATELY_MS = 1500;

/** The composer took a key shortly before the shown card was asked (or after). */
const typedLately = (s: PinnedState): boolean => {
  const asked = s.cards === undefined ? undefined : shownAsked(s.cards.cards);

  return (
    s.typed !== undefined &&
    asked !== undefined &&
    Date.parse(s.typed) >= Date.parse(asked) - TYPED_LATELY_MS
  );
};

/** Another card is shown (asked, or read) by serve's word, not by your keys on the cards. */
const cameShown = (was: PinnedState, s: PinnedState, input: Input): boolean => {
  const now = s.cards === undefined ? undefined : shownCard(s.cards.cards);

  return (
    (input.kind === 'event' || input.kind === 'result') &&
    now !== undefined &&
    s.cards?.cards.override === undefined &&
    (was.cards?.session !== s.cards?.session ||
      now !== (was.cards === undefined ? undefined : shownCard(was.cards.cards)))
  );
};

/** A card is open on the pinned session: it takes the keys (#114). */
const cardOpen = (s: PinnedState): boolean => s.cards !== undefined && cardsOpen(s.cards.cards);

/** The card whose own words are being typed, if any. */
const ownWords = (s: PinnedState): string | undefined => s.cards?.cards.typing?.card;

/** A key or click answered a card on the same session (its line folded among the turns). */
const answeredBy = (was: PinnedState, s: PinnedState, input: Input): boolean =>
  (input.kind === 'key' || input.kind === 'click') &&
  was.cards !== undefined &&
  s.cards?.session === was.cards.session &&
  s.cards.cards.folded.length > was.cards.cards.folded.length;

/** The session the keys were pinned on as a layer took them; none once they moved otherwise. */
const layeredAfter = (s: PinnedState, input: Input, pin: string): string | undefined => {
  if (input.kind !== 'focus') return s.layered;

  return !input.focused && input.layer === true ? pin : undefined;
};

/**
 * Where the keys are in Chat after `input`: the field as Chat shows a chat, once its slot gets the
 * keys (⌘4, ⌃⌘←, every rail move, `:chat`, a Sessions row's ⏎, back from Terminal mode) or, holding
 * them, pins another session (a launch, a new conversation); an open card waits for Tab, not over
 * an Override card (its reason has them) or with no field (a teammate's, ended). Back from a layer
 * on the same session, where they were. A card asked over an empty field takes them; one read (there
 * before the keys came) waits; its own words begun (a click on their row while the field had them)
 * take them too, the draft kept.
 */
const keysAfter = (was: PinnedState, input: Input, out: Out): Out => {
  const s = out.state;
  const pin = pinOf(s).session?.id ?? '';
  const layered = layeredAfter(s, input, pin);
  const came = input.kind === 'focus' && input.focused && !was.focused && was.layered !== pin;
  const repinned = s.focused && pin !== '' && (pinOf(was).session?.id ?? '') !== pin;
  // back to Chat from Claude Code (its tab, ⌃⌘←) with the keys: the field, not the transcript
  const untermed = was.terminal === true && s.terminal !== true && s.focused;
  const arrived = s.cards !== undefined && cameShown(was, s, input);
  // a card that comes while you type (a key a moment ago, a draft in the field) waits: a
  // message's keys never answer it (N2); a permission waits whenever the field has the keys, and
  // so does a card read, not asked now (there before a move put the keys in the field)
  const waits =
    arrived &&
    (typedLately(s) ||
      (s.composer.active &&
        (chatCardsRead(input) ||
          (s.cards !== undefined && shownKind(s.cards.cards) === 'permission') ||
          !composerEmpty(s.composer, pin))));
  const composer = (() => {
    // Terminal mode's keys are its Claude Code's; an open card waits for Tab
    if (
      (came || repinned || untermed) &&
      s.cards?.cards.override === undefined &&
      s.terminal !== true
    )
      return composerShown(s.composer, composerFacts(s) ?? NO_FIELD);
    // a question over an empty, idle field: its digits answer it
    if (arrived && !waits && s.composer.active) return composerFocus(s.composer, false);
    // `/override`'s card over the field it was typed in: its reason has the keys
    if (
      !cardOpen(was) &&
      s.cards?.cards.override !== undefined &&
      s.composer.active &&
      composerEmpty(s.composer, pin)
    )
      return composerFocus(s.composer, false);
    // else their ⏎ and Esc would be the field's: its draft sent, the card left unanswered
    if (ownWords(was) === undefined && ownWords(s) !== undefined && s.composer.active)
      return composerFocus(s.composer, false);
    // the last card answered (a digit, ⏎, a click): the field, so `/` is a skill, not find
    if (cardOpen(was) && !cardOpen(s) && answeredBy(was, s, input) && s.terminal !== true)
      return composerShown(s.composer, composerFacts(s) ?? NO_FIELD);

    return s.composer;
  })();

  // Tab or a click goes to a card that waits
  const cards = s.cards !== undefined && arrived ? chatCardsWaits(s.cards, waits) : s.cards;
  // the field, a card's own words or an Override's reason taking the keys: find's field leaves them
  const rendered =
    s.rendered !== undefined &&
    (composer.active ||
      s.cards?.cards.typing !== undefined ||
      s.cards?.cards.override !== undefined)
      ? renderedFindLeft(s.rendered)
      : s.rendered;

  return composer === s.composer &&
    layered === s.layered &&
    rendered === s.rendered &&
    cards === s.cards
    ? out
    : { ...out, state: { ...s, composer, layered, rendered, cards } };
};

const afterComposer = (s: PinnedState, input: Input): Out & { handled: boolean } => {
  // `Session ended · ⏎ Resume` / `Session stopped · ⏎ Retry` (#243, #296): ⏎ on no line of the
  // transcript does what the ended line says
  if (input.kind === 'key' && input.key === '<CR>' && s.rendered?.folds.cursor === undefined) {
    const resumed = resume(s);

    if (resumed !== undefined) return { ...resumed, handled: true };
  }
  const own = onRendered(s, input);
  // events reach both: the transcript's own and the sessions' and runs' the pin follows
  const stepped =
    own !== undefined && input.kind !== 'event'
      ? own
      : (() => {
          const base = own ?? { state: s, commands: [] };
          const next = stepPinned(base.state, input);

          return { state: next.state, commands: [...base.commands, ...next.commands] };
        })();
  const settled = settle(stepped.state);

  return {
    state: settled.state,
    commands: [...stepped.commands, ...settled.commands],
    handled: own !== undefined,
  };
};

/** A card's launch asked, its session not listed yet: the Board's card says it so too. */
const LAUNCHING = 'Launching…';

/**
 * W-NoSession: the card's Chat before any session, one quiet step offered (a refused launch's
 * why under it); launched, from here or anywhere, `● Launching…` until its session comes
 * (`starting`), as the Board's card says it; a teammate's card (`whose`), read-only: nothing
 * offered. Its header is the 2.1 one a session's has (#291): `#4` and the card's title as
 * written, where ⏎ launches it, the empty rail `New · no session`.
 */
const noSession = (s: PinnedState, card: number, starting = launchHeard(s, card)): Node => {
  const title = titleOf(s, card) ?? '';
  const whose = whoseOf(s);
  // a launch whose steps came before its session is listed (#229)
  const seen = s.launchSeen?.card === card ? launchShown(s) : undefined;
  const look =
    seen === undefined || s.now === undefined
      ? undefined
      : startingLook({ state: 'starting', launch: seen }, s.now);
  const offered = whose === undefined && !starting;
  const body = (() => {
    // why nothing is offered, as the story dialog says it
    if (whose !== undefined)
      return empty(`${whose}'s story`, `Assigned to ${whose}: Chat launches only your own cards.`);
    if (starting && seen !== undefined && s.now !== undefined)
      // its steps under one another, in the middle of the column
      return stack('column', [stack('column', []), launchBody(seen, s.now), stack('column', [])], {
        sizes: [{ flex: 1 }, 'auto', { flex: 1 }],
      });
    if (starting) return empty(LAUNCHING, 'Chat attaches once its Claude Code runs.');

    // Abe's head, the title and the one quiet step, centred (#292)
    return {
      kind: 'Empty',
      props: {
        title: `No session on #${card} yet`,
        line: refusedOn(s, card) ?? '',
        head: true,
        actions: [
          {
            id: LAUNCH,
            label: unassigned(s, card) ? ASSIGN_AND_LAUNCH : 'Launch agent',
            keys: '⏎',
            primary: true,
          },
          { id: MENU, label: 'more', keys: '⌘⏎' },
        ],
      },
    } satisfies Node;
  })();
  // where ⏎ launches it; a teammate's: whose, as the rendered header says it
  const env = whose === undefined ? launchEnv(s) : `${whose}'s session`;

  return island(
    [
      stack(
        'column',
        [
          {
            kind: 'ChatHeader',
            id: 'chat-header',
            props: {
              title: 'Chat',
              ...(env === undefined ? {} : { env }),
              story: { id: `#${card}`, title },
              ...(offered ? { hint: '⌘⏎' } : {}),
              rail: {
                segments: ['todo', 'todo', 'todo', 'todo', 'todo'],
                stage: 'New',
                // launched: its step and tone, as a listed launch's header says them
                ...(starting
                  ? {
                      state: look === undefined ? 'starting' : shownState(look),
                      glyph: '●',
                      word: look?.word ?? LAUNCHING,
                    }
                  : { state: 'idle', glyph: '○', word: 'no session' }),
              },
            },
          },
          body,
        ],
        { sizes: ['auto', { flex: 1 }] },
      ),
    ],
    'chat',
  );
};

/** The `Empty` action that starts the Abe chat (⏎ does it too). */
export const HUB_START = 'chat:hub-start';

/**
 * The main checkout with no story and no Abe chat yet: ⏎ starts it (`abe chat`). A box's
 * workspace has none: the Abe chat runs on this machine.
 */
const noHub = (s: PinnedState): Node =>
  island(
    [
      s.root === undefined || s.box !== undefined
        ? empty('No story here', '⌘⌥A Abe view to pick one')
        : {
            kind: 'Empty',
            props: {
              title: 'Abe chat',
              line: 'Ask about cards, make cards, start runs; /abe:install sets the repo up.',
              head: true,
              actions: [{ id: HUB_START, label: 'Start the Abe chat', keys: '⏎', primary: true }],
            },
          },
    ],
    'chat',
  );

const viewChat = (s: PinnedState): Node => {
  const pin = pinOf(s);

  // `:install` (#71): the Abe chat opens and follows /abe:install
  if (s.installing !== undefined)
    return island(
      [
        s.installing.failed === undefined
          ? empty('Opening the Abe chat', 'It starts, or opens again, and follows /abe:install.')
          : empty('Install', s.installing.failed),
      ],
      'chat',
    );
  // `abe chat` asked: it starts, or opens again
  if (s.hubbing !== undefined)
    return island(
      [
        s.hubbing.failed === undefined
          ? empty('Opening the Abe chat', 'It starts, or the one it had opens again.')
          : empty('Abe chat', s.hubbing.failed),
      ],
      'chat',
    );

  if (s.waking !== undefined)
    return island(
      [
        s.waking.failed === undefined
          ? empty(
              `Waking ${s.waking.box}…`,
              `the box is ${s.waking.state}; Chat attaches once it runs`,
            )
          : empty(`Waking ${s.waking.box} failed`, s.waking.failed),
      ],
      'chat',
    );

  // the Board's ring on an empty column (#309): header and body empty with it, nothing to read
  if (s.noCard === true)
    return island(
      [
        stack(
          'column',
          [
            { kind: 'ChatHeader', id: 'chat-header', props: { title: 'Chat' } },
            empty('No card selected', ''),
          ],
          { sizes: ['auto', { flex: 1 }] },
        ),
      ],
      'chat',
    );
  if (s.sessions === undefined)
    return island([empty('Asking abe serve', 'Chat shows once the sessions are read.')], 'chat');
  // a chosen session not listed yet: read again once it is (`session.state`); on a card (one
  // just launched from the Board), it is starting
  if (
    s.session !== undefined &&
    pin.session === undefined &&
    pin.run === undefined &&
    s.card !== undefined
  )
    return noSession(s, s.card, true);
  if (s.session !== undefined && pin.session === undefined && pin.run === undefined)
    return island([empty('Asking abe serve', 'Chat attaches once its session is read.')], 'chat');
  if (pin.session === undefined && pin.run === undefined)
    return pin.card === undefined ? noHub(s) : noSession(s, pin.card);
  // launched here, its session not listed yet: still starting
  if (pin.session === undefined && s.launched !== undefined && pin.card !== undefined)
    return noSession(s, pin.card, true);
  // Terminal mode (#155): the session attached, its transcript not needed
  if (s.terminal === true && pin.session !== undefined) return attachView(s, pin.session, pin.run);
  // a run whose session is not listed yet
  if (pin.session === undefined || s.rendered === undefined)
    return island([empty('Asking abe serve', 'Chat shows once its session is read.')], 'chat');

  const f = composerFacts(s);
  const facts = factsOf(s, pin.session, pin.run);
  // what the agent does now, right above the field
  const status =
    chatStatus(s.rendered, facts, {
      asking: s.cards !== undefined && waitingCount(s.cards.cards) > 0,
    }) ?? undefined;
  const dock = f === undefined ? (status ?? null) : composerDock(s.composer, f, status);
  const slots =
    s.cards === undefined ? {} : chatCardsSlots(s.cards, cardFactsOf(s, pin.session, pin.run));
  // the pill just above the composer
  const foot = [...(slots.foot ?? []), ...(dock === null ? [] : [dock])];

  return renderedView(s.rendered, facts, { ...slots, foot });
};

/**
 * A chosen session (the `session` param, or the one launched from here) that ended gives way to a
 * new session on its story (#227): one not read before this input, not ended, started after it:
 * a Retry or Resume from the Board, Sessions, Chat or the CLI. Chat is on it at once (the slot's
 * open params name it, so a reconnect keeps it), and its menus act on it. An ended session picked
 * while the newer one was known stays, and so does a live one.
 */
const followNewer = (before: PinnedState, out: Out): Out => {
  const s = out.state;
  const chosen = s.session ?? s.launched;

  if (chosen === undefined || before.sessions === undefined) return out;
  const was = s.sessions?.find((x) => x.id === chosen);

  if (was?.card === null || was?.card === undefined || was.state !== 'ended') return out;
  const known = new Set(before.sessions.map((x) => x.id));

  // the read that first lists the chosen one: what it lists with it was there when it was chosen
  if (!known.has(chosen)) return out;
  const next = ranked(
    (s.sessions ?? []).filter(
      (x) =>
        x.card === was.card &&
        (x.repo === was.repo || (isHere(s.here, x.repo) && isHere(s.here, was.repo))) &&
        !known.has(x.id) &&
        x.state !== 'ended' &&
        Date.parse(x.startedAt) > Date.parse(was.startedAt),
    ),
  )[0];

  if (next === undefined) return out;
  const settled = settle({ ...s, session: next.id, launched: undefined });

  return {
    state: settled.state,
    commands: [
      ...out.commands,
      ...settled.commands,
      {
        kind: 'open',
        screen: 'chat',
        params: {
          ...(s.card === undefined ? {} : { card: String(s.card) }),
          session: next.id,
          ...(s.whose === undefined ? {} : { whose: s.whose }),
        },
        slot: 'chat',
        ifOpen: true,
      },
    ],
  };
};

/**
 * The session the Editor's Terminal mode attaches as its pinned **Claude Code** tab (#340): the one
 * Chat is pinned to, unless it ended (nothing to attach); null: none. Undefined while the sessions,
 * or the chosen one, are still being read: not known yet.
 */
export const attachable = (s: PinnedState): string | null | undefined => {
  if (s.sessions === undefined) return undefined;
  const session = pinOf(s).session;

  if (session === undefined && s.session !== undefined) return undefined;

  return session === undefined || session.state === 'ended' ? null : session.id;
};

/**
 * `chat-session` (#340): the shell told the attachable session on every open (the Editor shown
 * again, another workspace) and as soon as it changed (a Retry's or Resume's new session).
 */
const telling =
  (stepping: (s: PinnedState, input: Input) => Out) =>
  (s: PinnedState, input: Input): Out => {
    const out = stepping(s, input);
    const session = attachable(out.state);

    if (session === undefined || (input.kind !== 'open' && session === out.state.toldSession))
      return out;

    return {
      state: { ...out.state, toldSession: session },
      commands: [...out.commands, { kind: 'shell', effect: { kind: 'chat-session', session } }],
    };
  };

/**
 * `:` on Chat's session (#346): its ⌘⏎ rows with its slash commands (`/model`, `/compact`, …)
 * before the jumps along its story, so they stay within the Subject's six.
 */
const withSlashRows = (menu: Menu, s: PinnedState, x: SessionData): Menu => {
  const jumps = new Set(['workspace', 'story', 'linked']);
  const slash = slashRowsOf(s.composer, composerFacts(s) ?? NO_FIELD, x.kind === 'card').map(
    (r): MenuRow => ({ ...r, does: { kind: 'back' } }),
  );

  return {
    ...menu,
    rows: [
      ...menu.rows.filter((r) => !jumps.has(r.id)),
      ...slash,
      ...menu.rows.filter((r) => jumps.has(r.id)),
    ],
  };
};

/**
 * Where Chat's keys are (#346): its session as the Subject (its ⌘⏎ rows, an Ask about it, `Tell
 * #N's session` while it runs); with none, its card.
 */
const pinnedHere = (s: PinnedState): Here => {
  const pin = pinOf(s);
  const x = pin.session;
  const card = x?.card ?? pin.card ?? undefined;
  const label = card === undefined ? 'this chat' : `#${card}`;

  if (x === undefined)
    return card === undefined
      ? { keys: 'chat' }
      : { keys: 'chat', subject: { caption: `#${card}`, label, ask: ['--card', String(card)] } };
  const f = factsOf(s, x, pin.run);

  return {
    keys: 'chat',
    subject: {
      caption: card === undefined ? x.title : `#${card} ${pin.run?.title ?? x.title}`,
      label,
      ask: [...(card === undefined ? [] : ['--card', String(card)]), '--session', x.id],
      menu: withSlashRows(sessionMenu(f), s, x),
      ...(x.state === 'ended' || f.whose !== undefined || x.kind !== 'card'
        ? {}
        : {
            tell: {
              session: x.id,
              whose: label,
              dim: x.state === 'working' ? 'it is working' : 'it waits on you',
              ...(card === undefined ? {} : { card }),
            },
          }),
    },
  };
};

// ── the install in the Abe chat (#71) ─────────────────────────────────────────────────────

/** `:install`'s `abe install`: its answer pins Chat on the Abe chat, which follows /abe:install. */
const INSTALL_RUN = 'chat:install';
const INSTALL_READ = {
  kind: 'run',
  id: 'chat:install-status',
  argv: ['install', 'status'],
} as const satisfies Command;
/** A row's Re-check or Do again, said to the Abe chat. */
const INSTALL_SAY = 'chat:install-say';

/** The Abe chat the status names, as the sessions list has it if it does. */
const installSession = (s: PinnedState): { id: string; state: string } | undefined => {
  const named = s.install?.session ?? undefined;

  return named === undefined ? undefined : (s.sessions?.find((x) => x.id === named.id) ?? named);
};

/**
 * `abe install`'s answer: Chat pinned on the Abe chat (the slot's open params naming it, so a
 * reconnect keeps it), or the refusal in the column. Asked no more (another open came
 * meanwhile): a status line says it is there for `:install` again.
 */
const onInstall = (s: PinnedState, input: Answer | Refused): Out => {
  const asked = s.installing;

  if (input.command !== 'install' || !input.reply.ok) {
    if (asked === undefined || input.reply.ok) return { state: s, commands: balloon(input) };

    return {
      state: {
        ...s,
        installing: { failed: `${input.reply.error.message} (${input.reply.error.code})` },
      },
      commands: [],
    };
  }
  const v = input.reply.data;
  const id = v.session?.id;

  if (asked === undefined || asked.failed !== undefined || id === undefined)
    return {
      state: { ...s, install: v, installing: undefined },
      commands: [
        statusLine(
          id === undefined ? 'The install has no Abe chat' : 'The Abe chat is ready · :install',
        ),
      ],
    };
  const reads = readAll({
    ...s,
    install: v,
    installRead: id,
    installing: undefined,
    session: id,
    launched: undefined,
  });

  return {
    state: reads.state,
    commands: [
      ...reads.commands,
      { kind: 'open', screen: 'chat', params: { session: id }, slot: 'chat', ifOpen: true },
    ],
  };
};

/** A part's Re-check or Do again: said to the Abe chat, an ended one reopened with it. */
const partSaid = (s: PinnedState, text: string): Out => {
  const x = installSession(s);

  if (x === undefined) return { state: s, commands: [] };

  return {
    state: s,
    commands: [
      {
        kind: 'run',
        id: INSTALL_SAY,
        argv:
          x.state === 'ended'
            ? ['session', 'reopen', x.id, '--message', text]
            : ['session', 'send', x.id, text],
      },
    ],
  };
};

/**
 * What the install's strip hears: its status as it changes, read again as the Abe chat's turn ends
 * (a check it ran may say nothing else), and read once for each Abe chat pinned (a repo with no
 * install answers none: no strip).
 */
const installHeard = (input: Input, out: Out): Out => {
  const next = out.state;
  const e = input.kind === 'event' ? input.event : undefined;

  if (
    e?.type === 'install.changed' &&
    (next.install === undefined || next.install.repo === e.data.repo)
  )
    return { state: { ...next, install: e.data }, commands: out.commands };
  const turnEnded =
    e?.type === 'session.state' &&
    e.data.id === next.install?.session?.id &&
    (e.data.state === 'waiting' || e.data.state === 'ended');
  const x = pinOf(next).session;
  const unread = x?.kind === 'abe' && next.installRead !== x.id;

  if (!turnEnded && !unread) return out;

  return {
    state: unread ? { ...next, installRead: x.id } : next,
    commands: [...out.commands, INSTALL_READ],
  };
};

/**
 * A click on the install's strip: a part or the files unfolded (folded again), a file opened in
 * the Editor; undefined: not the strip's.
 */
const stripClicked = (s: PinnedState, id: string): Out | undefined => {
  const c = stripClick(id);

  if (c === undefined) return undefined;
  if ('unfold' in c)
    return {
      state: { ...s, installOpen: s.installOpen === c.unfold ? undefined : c.unfold },
      commands: [],
    };
  const path = s.install?.files[c.file];

  return {
    state: s,
    commands:
      s.install === undefined || path === undefined
        ? []
        : [{ kind: 'shell', effect: { kind: 'open-file', path: `${s.install.repo}/${path}` } }],
  };
};

/** The install in the Abe chat (#71): `:install` asked and answered, its strip's clicks, its status. */
const withInstall =
  (stepping: (s: PinnedState, input: Input) => Out) =>
  (s: PinnedState, input: Input): Out => {
    if (input.kind === 'result' && input.id === INSTALL_RUN) return onInstall(s, input);
    if (input.kind === 'result' && input.id === INSTALL_READ.id)
      return {
        state:
          input.command === 'install status' && input.reply.ok
            ? { ...s, install: input.reply.data }
            : s,
        commands: [],
      };
    if (input.kind === 'result' && input.id === INSTALL_SAY)
      return { state: s, commands: balloon(input) };
    const tabbed = hubTabbed(s, input) ?? abeJump(s, input);

    if (tabbed !== undefined) return tabbed;
    const said = input.kind === 'click' ? partMessage(input.id) : undefined;

    if (said !== undefined) return partSaid(s, said);
    const clicked = input.kind === 'click' ? stripClicked(s, input.id) : undefined;

    if (clicked !== undefined) return clicked;
    // another project's install is its own
    const s1 =
      input.kind === 'root' && input.root !== s.root
        ? { ...s, install: undefined, installRead: undefined, installOpen: undefined }
        : s;
    const out = stepping(s1, input);

    if (input.kind !== 'open') return installHeard(input, out);
    // `:install` asked; another open leaves an answer to come
    const asked = input.params.install !== undefined;

    return installHeard(input, {
      state: { ...out.state, installing: asked ? {} : undefined },
      commands: [
        ...out.commands,
        ...(asked ? [{ kind: 'run' as const, id: INSTALL_RUN, argv: ['install'] }] : []),
      ],
    });
  };

/** The strip names each part from this width on; narrower, their marks alone. */
const STRIP_NAMES = 760;

/**
 * Whether the install's strip shows atop the pinned session: the Abe chat, its install not Done,
 * or Done in this conversation (it began before Done was checked: its files to open). A join no
 * Abe chat has run for, its personal parts checked or not yet, shows none.
 */
export const stripShown = (s: PinnedState): boolean => {
  const x = pinOf(s).session;
  const i = s.install;

  if (x?.kind !== 'abe' || i === undefined || (i.join && i.session === null)) return false;
  if (i.session?.id !== x.id && bare(i.repo) !== bare(x.abe?.repo ?? x.repo)) return false;
  if (!i.done) return true;
  const done = i.parts.find((p) => p.id === 'done')?.checkedAt ?? null;

  return done !== null && Date.parse(x.startedAt) <= Date.parse(done);
};

/** The Abe chat with its install: the strip under its header, over the transcript (#71). */
const withStrip = (s: PinnedState, chat: Node): Node => {
  if (chat.kind !== 'Island' || !stripShown(s)) return chat;
  const strip = installParts(s.install, {
    open: s.installOpen,
    compact: (s.size?.width ?? 0) < STRIP_NAMES,
  });
  const [only] = chat.children;
  const head = only?.kind === 'Stack' ? only.children[0] : undefined;

  // the header's column: the strip right under it
  if (
    chat.children.length === 1 &&
    only?.kind === 'Stack' &&
    only.props.direction === 'column' &&
    head?.kind === 'ChatHeader'
  ) {
    const sizes = only.props.sizes;

    return {
      ...chat,
      children: [
        {
          ...only,
          props: {
            ...only.props,
            ...(sizes === undefined
              ? {}
              : { sizes: [sizes[0] ?? 'auto', 'auto', ...sizes.slice(1)] }),
          },
          children: [head, strip, ...only.children.slice(1)],
        },
      ],
    };
  }
  const body =
    chat.children.length === 1 && only !== undefined ? only : stack('column', chat.children);

  return {
    ...chat,
    children: [stack('column', [strip, body], { sizes: ['auto', { flex: 1 }], align: 'stretch' })],
  };
};

export const viewPinned = (s: PinnedState): Node => withStrip(s, viewChat(s));

export const pinnedScreen: Screen<PinnedState> = {
  name: 'chat',
  here: pinnedHere,
  init: { actions: NO_CARD_ACTIONS, focused: false, composer: NO_COMPOSER },
  step: withShortAsk(
    telling(
      holding(
        HELD_MENU,
        withInstall((s, input) => keysAfter(s, input, followNewer(s, step(s, input)))),
      ),
    ),
  ),
  view: viewPinned,
  follows: chatFollows,
  events: CHAT_EVENTS,
  // Chat (either mode): its session's story (#106 Behaviour 4)
  linked: (s) => pinOf(s).card,
  // a cloud launch's steps by the second (#142)
  seconds: (s) =>
    launchTicking([
      ...(s.sessions ?? []),
      // a launch heard before its session is listed (#229)
      ...((l) => (l === undefined ? [] : [{ state: 'starting' as const, launch: l }]))(
        launchShown(s),
      ),
    ]),
  // the composer has the keys (#115), or a card's own words or an Override's reason are typed
  // (#114): `:` and `?` are typed
  typing: (s) => {
    const f = composerFacts(s);
    const composing =
      s.composer.active && f !== undefined && f.ended !== true && f.whose === undefined;

    return (
      composing ||
      s.cards?.cards.typing !== undefined ||
      s.cards?.cards.override !== undefined ||
      renderedFinding(s.rendered)
    );
  },
  words: [
    // `:chat`: the repo's Abe chat in the Chat column, the keys in its composer
    {
      word: 'chat',
      summary:
        "the repo's Abe chat in the Chat column: ask about cards, make cards, start runs, /abe:<skill>",
      commands: [
        { kind: 'open', screen: 'chat', params: { hub: '1' }, slot: 'chat' },
        { kind: 'shell', effect: { kind: 'show', place: 'chat' } },
        { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
      ],
    },
    {
      word: 'override',
      summary:
        "lower one limit for the shown workspace's session, with a reason, tracked: db write <env>, aws write <env>, their read forms",
      ask: [
        {
          name: 'what',
          kind: 'positional',
          type: 'string',
          required: true,
          repeats: true,
          summary: 'the area (`db write test`, `network api.example.com`)',
        },
      ],
      // the Override card in Chat, on the shown workspace's session, with the keys
      commands: (values) => [
        { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
        { kind: 'choice', menu: OVERRIDE_MENU, row: values.join(' ').trim(), slot: 'chat' },
      ],
    },
  ],
};
