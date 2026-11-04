/**
 * The Card page (`card`): the story as a page, in a card's workspace (its Card page, the `main`
 * slot) or as a popup over the Board on any card (`from: board`, the `popup` slot). Its card is the
 * `card` param, else the shown branch's (`card/<n>-…`). It reads `card show` on open, on the card's
 * `board.changed` and after a card write; the sessions and the card's runs for its actions; the
 * board's team for Assign… and whether the card is yours; `serve.target` for where a launch goes.
 *
 * The page is the story dialog's (`story.ts`): the head (`#id`, the title, the facts line), the
 * Description, the Acceptance criteria, its Comments, Linked, its Sheets beside them (a click: that
 * Sheet as a tab in the Board's place); then the comment composer (its draft kept per card) and the
 * actions: Comment ⏎, Move…, Assign…, Launch again…, Stop the session (only while a session runs,
 * asked first). Its keys: `l ö` and the pages scroll, `gg` `G` the top and
 * the end; Tab ⇧Tab go round the page, the composer and the actions; ⏎ on the page is the composer,
 * in it posts; ⌘⏎ the card's menu; `?` its keys. Esc puts the keys back on the page; there it is
 * the window's (`unhandled`), but in the Board's popup it goes back to the Board on the card.
 */
import type {
  BoardMember,
  CardComment,
  CardData,
  Event,
  FactoryRunData,
  RepoHere,
  SessionData,
} from '@abe/core';
import {
  type ActionsAt,
  actionAnswer,
  assignCard,
  type CardActions,
  isActionAnswer,
  launchFromBox,
  launchOnCard,
  NO_CARD_ACTIONS,
  relaunchAnswer,
  reopenCard,
  retryCard,
  shortChoice,
  stopCard,
} from './card-actions';
import { LAUNCH_SHORT } from './launch-short';
import { isHere } from '@abe/core/here';
import { cardName } from '@abe/core/local-names';
import { type ShortRuns, withShortAsk } from './launch-short';
import {
  assignsToLaunch,
  type CardFacts,
  cardMenu,
  cardSubject,
  LAUNCH_BOX,
  LAUNCH_BOX_ROW,
  launchBox,
  launchRefusal,
  launchedOn,
  replacing,
} from './card-actions';
import { isAssignRun } from './assign';
import {
  imagesToRead,
  linkChosen,
  linkCommands,
  storyDialog,
  type StoryFacts,
  storyLink,
  type StoryRead,
} from './story';
import { standing } from './flow';
import { dialogSheetRef, dialogSheets } from './sheet';
import { cardOfBranch } from './branch';
import { JUMP_WORKSPACE, workspaceJump, workspaceLanding } from './jumps';
import type { Facts, LaunchHeard } from '../live';
import {
  type Answer,
  type CardPage,
  caretProp,
  type Choice,
  type Command,
  type DialogButton,
  type DialogSheets,
  type Field,
  fieldInsert,
  fieldKey,
  fieldOf,
  type Here,
  type Input,
  type Jump,
  listMove,
  movedRow,
  PAGE_ROWS,
  type PageComposer,
  type Refused,
  type Screen,
  statusLine,
  type ViewSize,
} from '../runtime/runtime';

/** The screen's name, as `open` names it. */
export const CARD_SCREEN = 'card';

/** The page's actions, in the footer's order: the ids their buttons' clicks name. */
const ACTIONS = ['comment', 'move', 'assign', 'launch', 'stop'] as const;
type Action = (typeof ACTIONS)[number];

/** A button's click id: `card:move`. */
const ACTION = 'card:';

/** Where the keys are on the page: reading it, in the composer, or on an action. */
type Focus = 'page' | 'composer' | Action;

/** A post under way, or one that failed (its draft kept). */
type Post = { card: number; state: 'posting' | 'failed'; error?: string | undefined };

export type CardPageState = {
  /** Launches asked, their argv until answered (`launch-short.ts`). */
  shortRuns?: ShortRuns | undefined;
  size: ViewSize;
  now?: string | undefined;
  root?: string | undefined;
  /** The card shown. */
  card?: number | undefined;
  /** The Board's popup: Esc goes back to the Board. */
  from?: 'board' | undefined;
  /** `card show`'s card, once read. */
  shown?: CardData | undefined;
  /** Its text, comments and images as `card show` and `card images` read them. */
  read: StoryRead;
  /** Its attached Sheets as `card show` read them, or why not. */
  sheets?: DialogSheets | undefined;
  /** The live facts' sessions, runs and the repo they were read in. */
  sessions?: SessionData[] | undefined;
  runs?: FactoryRunData[] | undefined;
  here?: RepoHere | undefined;
  /** Launches heard going, by card (live's): Launching… here as on every screen. */
  launches?: Readonly<Record<number, LaunchHeard>> | undefined;
  members?: BoardMember[] | undefined;
  membersFailed?: boolean | undefined;
  target?: string | undefined;
  /** Lines scrolled down, and how far the page scrolls as the window drew it. */
  scroll: number;
  extent?: number | undefined;
  focus: Focus;
  /** The composer's drafts, by card. */
  drafts: Readonly<Record<number, Field>>;
  post?: Post | undefined;
  /** `g` typed: the next `g` is `gg`. */
  g: boolean;
  /** Its slot lost the keyboard: the composer draws no caret. */
  away?: boolean | undefined;
  /** Reads asked and not answered. */
  pending: readonly string[];
  /** Launch, retry, reopen, stop and assign-then-launch on its card (`card-actions.ts`). */
  actions: CardActions;
};

type Out = { state: CardPageState; commands: Command[] };

const none = (state: CardPageState): Out => ({ state, commands: [] });

const INIT: CardPageState = {
  size: { width: 0, height: 0 },
  read: {},
  scroll: 0,
  focus: 'page',
  drafts: {},
  g: false,
  pending: [],
  actions: NO_CARD_ACTIONS,
};

// ---------------------------------------------------------------- reads

const SHOW = 'card-show:';
const IMAGES = 'card-images:';
const POST = 'card-comment:';
const CHECKOUT = 'card-checkout:';
const PROTOTYPE = 'card-prototype:';

/** The live sessions and runs read again (after a launch, a Retry, a Reopen, `r`). */
const factsAgain: Command = { kind: 'live', reads: ['sessions', 'runs'] };

/** The reads besides the card's own: the team, where a launch goes (its sessions and runs: live's). */
const factReads = (): Command[] => [
  { kind: 'run', id: 'members', argv: ['card', 'members'] },
  { kind: 'run', id: 'target', argv: ['settings', 'get', 'serve.target'] },
];

/** The tick's time in ms; undefined before the first. */
const nowMs = (s: Pick<CardPageState, 'now'>): number | undefined =>
  s.now === undefined ? undefined : Date.parse(s.now);

const showRead = (card: number): Command => ({
  kind: 'run',
  id: `${SHOW}${card}`,
  argv: ['card', 'show', String(card)],
  // kept by the host: another workspace's card and back draws it at once while it is read
  keep: true,
});

/** `commands`' reads not already out, and the state holding them as asked. */
const asking = (s: CardPageState, commands: readonly Command[]): Out => {
  const fresh = commands.filter((c) => c.kind !== 'run' || !s.pending.includes(c.id));

  return {
    state: {
      ...s,
      pending: [...s.pending, ...fresh.flatMap((c) => (c.kind === 'run' ? [c.id] : []))],
    },
    commands: fresh,
  };
};

// ---------------------------------------------------------------- what the page stands on

/** The card's run and session, of the shown repo's: as the Board's card reads them. */
const standingOf = (s: CardPageState) => {
  const card = s.card;

  if (card === undefined) return {};
  const runs = (s.runs ?? []).filter((r) => r.card === card && isHere(s.here, r.repo));
  const sessions = (s.sessions ?? []).filter((x) => x.card === card && isHere(s.here, x.repo));

  return standing(runs, sessions).get(card) ?? {};
};

/** The card is yours: assigned to the member the team names as you. */
const mineOf = (s: CardPageState): boolean => {
  const you = s.members?.find((m) => m.you);
  const a = s.shown?.assignee ?? null;

  if (you === undefined || a === null) return false;

  return a.email !== '' && you.email !== ''
    ? a.email.toLowerCase() === you.email.toLowerCase()
    : a.name === you.name;
};

/** What the card's actions are worked out from, once `card show` answered. */
const factsOf = (s: CardPageState): CardFacts | undefined => {
  if (s.shown === undefined) return undefined;
  const { run, session } = standingOf(s);

  return {
    card: s.shown,
    run,
    session,
    mine: mineOf(s),
    ...(s.members === undefined ? {} : { members: s.members }),
    ...(s.membersFailed === true ? { membersFailed: true } : {}),
    root: s.root,
    target: s.target,
  };
};

/** The card's own session while it runs: Stop the session is offered. */
const liveSession = (f: CardFacts | undefined): SessionData | undefined => {
  const x = f?.session;

  return x?.card === f?.card.id && x?.state !== 'ended' ? x : undefined;
};

// ---------------------------------------------------------------- the actions

/** Why an action cannot run now, or undefined. */
const reasonOf = (a: Action, f: CardFacts | undefined): string | undefined => {
  if (f === undefined) return 'reading the card';
  switch (a) {
    case 'assign':
      return cardMenu(f).rows.find((r) => r.id === 'assign')?.reason;
    case 'launch':
      return assignsToLaunch(f) ? undefined : launchRefusal(f);
    default:
      return undefined;
  }
};

/** The actions the footer shows: Stop the session only while one runs. */
const shownActions = (f: CardFacts | undefined): Action[] =>
  ACTIONS.filter((a) => a !== 'stop' || liveSession(f) !== undefined);

/** The footer's buttons, Comment the primary. */
const buttonsOf = (f: CardFacts | undefined): DialogButton[] =>
  shownActions(f).map((a): DialogButton => {
    const reason = reasonOf(a, f);
    const label = ((): string => {
      switch (a) {
        case 'comment':
          return 'Comment';
        case 'move':
          return 'Move…';
        case 'assign':
          return 'Assign…';
        case 'launch':
          return f !== undefined && launchedOn(f) ? 'Launch again…' : 'Launch agent…';
        case 'stop':
          return 'Stop the session';
      }
    })();

    return {
      id: `${ACTION}${a}`,
      label,
      ...(a === 'comment' ? { keys: '⏎', primary: true } : {}),
      ...(reason === undefined ? {} : { reason }),
    };
  });

/** Tab's round: the page, the composer, then each action that can run now. */
const round = (s: CardPageState): Focus[] => {
  const f = factsOf(s);

  return ['page', 'composer', ...shownActions(f).filter((a) => reasonOf(a, f) === undefined)];
};

/** Where the keys are: on an action that can no longer run (Launch again… once launched), the page. */
const focusOf = (s: CardPageState): Focus => (round(s).includes(s.focus) ? s.focus : 'page');

/** The keys `by` places on in Tab's round. */
const tabbed = (s: CardPageState, by: 1 | -1): CardPageState => {
  const r = round(s);
  const at = Math.max(0, r.indexOf(s.focus));

  return { ...s, focus: r[(at + by + r.length) % r.length] ?? 'page' };
};

/** `k ä` (← →) on an action: the one beside it, within the actions. */
const beside = (s: CardPageState, by: 1 | -1): CardPageState => {
  const actions = round(s).slice(2);
  const at = actions.indexOf(s.focus);
  const to = actions[Math.max(0, Math.min(actions.length - 1, at + by))];

  return to === undefined ? s : { ...s, focus: to };
};

/** Chat on the card (on `session` when named) with the keys: the window's Chat column. */
const chatOn = (card: number, session?: string): Command[] => [
  {
    kind: 'open',
    screen: 'chat',
    params: session === undefined ? { card: String(card) } : { card: String(card), session },
    slot: 'chat',
  },
  { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } },
];

/** The card's menu (⌘⏎): the Board's rows but Comment…, the page's composer being it. */
const menuOf = (s: CardPageState): Out => {
  const f = factsOf(s);

  if (f === undefined) return none(s);
  const menu = cardMenu(f);

  return {
    state: s,
    commands: [{ ...menu, rows: menu.rows.filter((r) => r.id !== 'comment') }],
  };
};

/** One row of the card's menu chosen at once (Move…, Assign…): its pick asked straight away. */
const chosenRow = (s: CardPageState, row: string): Out => {
  const f = factsOf(s);

  if (f === undefined) return none(s);

  return { state: s, commands: [{ ...cardMenu(f), chosen: row }] };
};

/** The Launch box on the card, where Launch agent goes as its detail says; `runs` picked. */
const launchBoxOn = (s: CardPageState, runs?: string): Out => {
  const f = factsOf(s);

  if (f === undefined || (launchRefusal(f) !== undefined && !assignsToLaunch(f))) return none(s);
  const box = launchBox(f.card, s.target, replacing(f));

  return { state: s, commands: [runs === undefined ? box : { ...box, draft: { note: '', runs } }] };
};

/** What the card actions go by on the page: the launches heard in the repo shown. */
const actionsAt = (s: CardPageState): ActionsAt => ({ launches: s.launches, here: s.here });

/**
 * The Launch box's ⏎ (`card-actions.ts`): launched (a card no one has assigned to you once it
 * is: a refused launch changes nothing on the board), or why not with the box back.
 */
const onLaunchBox = (s: CardPageState, c: Choice): Out => {
  const f = factsOf(s);

  if (f === undefined) return none(s);
  const out = launchFromBox(
    s.actions,
    actionsAt(s),
    launchOnCard(f),
    launchBox(f.card, s.target, replacing(f)),
    c.values,
  );

  return { state: { ...s, actions: out.actions }, commands: out.commands };
};

/** Assign… › who: `card assign`, said on the status line. */
const assign = (s: CardPageState, who: string | undefined): Out => {
  const f = factsOf(s);

  if (f === undefined || who === undefined) return none(s);
  const out = assignCard(s.actions, f.card, who, { mine: f.mine, members: s.members ?? [] });

  return { state: { ...s, actions: out.actions }, commands: out.commands };
};

/** Stop the session: asked first in Command mode's ConfirmLayer, No the default. */
const stopOn = (s: CardPageState): Out =>
  s.card === undefined
    ? none(s)
    : { state: s, commands: stopCard(s.card, liveSession(factsOf(s))) };

/** One of the footer's actions pressed (⏎ on it, or a click). */
const press = (s: CardPageState, a: Action): Out => {
  if (reasonOf(a, factsOf(s)) !== undefined) return none(s);
  switch (a) {
    case 'comment':
      return s.focus === 'composer' ? postDraft(s) : none({ ...s, focus: 'composer' });
    case 'move':
      return chosenRow(s, 'move');
    case 'assign':
      return chosenRow(s, 'assign');
    case 'launch':
      return launchBoxOn(s);
    case 'stop':
      return stopOn(s);
  }
};

/** Open workspace: the card's session's, as the Board's row opens it (`workspace attach-spec`). */
const workspaceOf = (s: CardPageState): Out => {
  const f = factsOf(s);

  if (f === undefined) return none(s);

  return {
    state: s,
    commands: workspaceJump(
      (s.runs ?? []).filter((r) => isHere(s.here, r.repo)),
      (s.sessions ?? []).filter((y) => isHere(s.here, y.repo)),
      f.card.id,
      f.mine,
    ),
  };
};

/** Open worktree: a local session's as a project; any other's branch checked out here first. */
const worktreeOf = (s: CardPageState): Out => {
  const f = factsOf(s);
  const x = f?.session;

  if (f === undefined || x?.neverPlaced === true) return none(s);
  if (x !== undefined && x.box === undefined)
    return {
      state: s,
      commands: [{ kind: 'shell', effect: { kind: 'open-project', path: x.worktree } }],
    };

  return {
    state: s,
    commands: [
      {
        kind: 'run',
        id: `${CHECKOUT}${f.card.id}`,
        argv: [
          'card',
          'checkout',
          String(f.card.id),
          ...(s.root === undefined ? [] : ['--repo', s.root]),
        ],
      },
    ],
  };
};

/** A row of the card's menu handed back: what it does from the page. */
const onCardRow = (s: CardPageState, row: string, values?: readonly string[]): Out => {
  const f = factsOf(s);

  if (f === undefined) return none(s);
  const card = f.card.id;
  const x = f.session;

  switch (row) {
    case 'assign':
      return assign(s, values?.[0]);
    case 'launch':
    case LAUNCH_BOX_ROW:
      return launchBoxOn(s);
    case 'launch-local-sandbox':
      return launchBoxOn(s, 'local-sandbox');
    case 'stop':
      return stopOn(s);
    case 'workspace':
      return workspaceOf(s);
    case 'worktree':
      return worktreeOf(s);
    case 'reopen': {
      if (x === undefined) return none(s);
      if (x.state !== 'ended') return { state: s, commands: chatOn(card, x.id) };
      const asked = reopenCard(f);

      return {
        state: s,
        commands: [...asked, ...(asked.some((c) => c.kind === 'run') ? chatOn(card, x.id) : [])],
      };
    }
    case 'retry': {
      const asked = retryCard(f, s.root);

      return { state: s, commands: asked.length === 0 ? [] : [...asked, ...chatOn(card)] };
    }
    case 'pull-request':
      // a local pull request is shown in the Board's place
      return { state: s, commands: [statusLine('Its local pull request is on the Board')] };
    case 'prototype':
      return {
        state: s,
        commands: [
          {
            kind: 'run',
            id: `${PROTOTYPE}${card}`,
            argv: [
              'prototype',
              'start',
              '--card',
              String(card),
              ...(s.root === undefined ? [] : ['--repo', s.root]),
            ],
          },
        ],
      };
    default:
      return none(s);
  }
};

const onChoice = (s: CardPageState, c: Choice): Out => {
  if (s.card === undefined) return none(s);
  if (c.menu === `${LAUNCH_BOX}${s.card}`) return onLaunchBox(s, c);
  if (c.menu.startsWith(LAUNCH_SHORT)) {
    const out = shortChoice(s.actions, Number(c.menu.slice(LAUNCH_SHORT.length)), c.row);

    return { state: { ...s, actions: out.actions }, commands: out.commands };
  }
  if (c.menu === `card:${s.card}`) return onCardRow(s, c.row, c.values);

  return none(s);
};

// ---------------------------------------------------------------- the composer

const draftOf = (s: CardPageState): Field =>
  (s.card === undefined ? undefined : s.drafts[s.card]) ?? fieldOf('');

const withDraft = (s: CardPageState, f: Field): CardPageState =>
  s.card === undefined ? s : { ...s, drafts: { ...s.drafts, [s.card]: f } };

const posting = (s: CardPageState): boolean =>
  s.post?.state === 'posting' && s.post.card === s.card;

/** ⏎ in the composer: `card comment <card> --text`, the draft kept until it answers. */
const postDraft = (s: CardPageState): Out => {
  const card = s.card;
  const text = draftOf(s).text;

  if (card === undefined || posting(s) || text.trim() === '') return none(s);

  return {
    state: { ...s, post: { card, state: 'posting' } },
    commands: [
      {
        kind: 'run',
        id: `${POST}${card}`,
        argv: ['card', 'comment', String(card), '--text', text],
      },
    ],
  };
};

/** A key while the composer has them: its field's, ⏎ posts, ⇧⏎ a new line, Esc the page. */
const composerKey = (s: CardPageState, key: string): Out => {
  switch (key) {
    case '<CR>':
      return postDraft(s);
    case '<S-CR>':
      return posting(s) ? none(s) : none(withDraft(s, fieldInsert(draftOf(s), '\n')));
    case '<Esc>':
      return none({ ...s, focus: 'page' });
    case '<Tab>':
      return none(tabbed(s, 1));
    case '<S-Tab>':
      return none(tabbed(s, -1));
    case '<D-CR>':
      return menuOf(s);
    default: {
      if (posting(s)) return none(s);
      // its lines: ⌘← ⌘→ ⌘⌫ stop at the caret's line's ends
      const next = fieldKey(draftOf(s), key, { lines: true });

      return next === undefined ? none(s) : none(withDraft(s, next));
    }
  }
};

// ---------------------------------------------------------------- keys and clicks

/** How far the page scrolls: as the window drew it, else as its lines estimate. */
const lastLine = (s: CardPageState): number => s.extent ?? pageLines(s);

const pageLines = (s: CardPageState): number => {
  const f = factsOf(s);

  return f === undefined ? 0 : storyDialog(f, undefined, s.read, s.now).lines;
};

/**
 * Esc the page has no use for: the window's, or (the Board's popup) the Board again on the card,
 * which closes the popup.
 */
const escape = (s: CardPageState): Out => {
  if (s.from !== 'board' || s.card === undefined)
    return {
      state: s,
      commands: [{ kind: 'shell', effect: { kind: 'unhandled', slot: 'main', key: '<Esc>' } }],
    };

  return {
    state: s,
    commands: [{ kind: 'open', screen: 'factory', params: { card: String(s.card) }, slot: 'main' }],
  };
};

/** Every read of the page, `r`'s. */
const allReads = (s: CardPageState): Command[] =>
  s.card === undefined ? [] : [showRead(s.card), ...factReads()];

const onKey = (s0: CardPageState, raw: string): Out => {
  const focus = focusOf(s0);

  if (focus === 'composer') return composerKey({ ...s0, g: false }, raw);
  const key = s0.g && raw === 'g' ? 'gg' : raw;
  const s: CardPageState = { ...s0, g: false };

  if (key === 'g') return none({ ...s, g: true });
  const move = listMove(key, PAGE_ROWS);

  if (move !== undefined) return none({ ...s, scroll: movedRow(move, s.scroll, lastLine(s) + 1) });
  const onAction = focus !== 'page';

  switch (key) {
    case '<Tab>':
      return none(tabbed(s, 1));
    case '<S-Tab>':
      return none(tabbed(s, -1));
    case 'k':
    case '<Left>':
      return onAction ? none(beside(s, -1)) : none(s);
    case 'ä':
    case '<Right>':
      return onAction ? none(beside(s, 1)) : none(s);
    case '<CR>':
      return focus === 'page' ? none({ ...s, focus: 'composer' }) : press(s, focus);
    case '<D-CR>':
      return menuOf(s);
    case '<Esc>':
      return onAction ? none({ ...s, focus: 'page' }) : escape(s);
    case 'r': {
      const asked = asking({ ...s, pending: [] }, allReads(s));

      return { state: asked.state, commands: [...asked.commands, factsAgain] };
    }
    default:
      return none(s);
  }
};

const onClick = (s: CardPageState, id: string): Out => {
  if (id === 'card:composer') return none({ ...s, focus: 'composer' });
  if (id === 'dialog:menu') return menuOf(s);
  // the popup's close button: as Esc on the page
  if (id === 'dialog:close') return escape(s);
  // one of its Sheets: as a tab in the Board's place, on the card
  const sheet = dialogSheetRef(id);

  if (sheet !== undefined && s.card !== undefined)
    return {
      state: s,
      commands: [
        {
          kind: 'open',
          screen: 'factory',
          params: { card: String(s.card), sheet },
          slot: 'main',
        },
      ],
    };
  const action = ACTIONS.find((a) => id === `${ACTION}${a}`);

  if (action !== undefined)
    return press({ ...s, focus: action === 'comment' ? s.focus : action }, action);
  // Linked's chips: the session Chat on it, the PR its page, the box the Boxes tab on it
  const link = id.startsWith('dialog:') ? linkChosen(id.slice('dialog:'.length)) : undefined;
  const f = factsOf(s);

  if (link === undefined || f === undefined) return none(s);
  if (link === 'session')
    return f.session === undefined
      ? none(s)
      : { state: s, commands: chatOn(f.card.id, f.session.id) };
  const facts: StoryFacts = { ...f, now: nowMs(s) };
  const chip = storyDialog(facts, undefined, s.read, s.now).dialog.props.linked ?? [];

  return chip.some((c) => c.id === id && c.dim !== true)
    ? { state: s, commands: linkCommands(storyLink(facts, link)) }
    : none(s);
};

// ---------------------------------------------------------------- answers and events

/** The images the story names that `card images` has not answered, asked. */
const imagesCommand = (card: number, read: StoryRead): Command[] => {
  const urls = imagesToRead(read);

  return urls.length === 0
    ? []
    : [{ kind: 'run', id: `${IMAGES}${card}`, argv: ['card', 'images', ...urls] }];
};

const keptImages = (images: StoryRead['images']): StoryRead['images'] =>
  images === undefined
    ? undefined
    : Object.fromEntries(Object.entries(images).filter(([, path]) => path !== null));

const shownRead = (
  comments: readonly CardComment[],
  c: CardData,
  images: StoryRead['images'],
): StoryRead => ({
  text: { description: c.description, acceptanceCriteria: c.acceptanceCriteria },
  comments: [...comments],
  ...(images === undefined ? {} : { images }),
});

const balloon = (text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'balloon', tone: 'error', text },
});

const refusal = (input: Answer | Refused): string =>
  input.reply.ok ? '' : `${input.reply.error.message} (${input.reply.error.code})`;

const onResult = (s0: CardPageState, input: Answer | Refused): Out => {
  const id = input.id;

  // the card as last read, drawn on an empty page while it is read anew (still out: its answer
  // comes after); a page that shows the card keeps what it shows
  if (input.cached === true)
    return id === `${SHOW}${s0.card ?? ''}` &&
      s0.shown === undefined &&
      input.command === 'card show' &&
      input.reply.ok
      ? none({
          ...s0,
          shown: input.reply.data,
          read: shownRead(input.reply.data.comments, input.reply.data, keptImages(s0.read.images)),
          sheets: dialogSheets(input.reply.data.id, input.reply.data.sheets),
        })
      : none(s0);
  const s: CardPageState = { ...s0, pending: s0.pending.filter((p) => p !== id) };

  if (id.startsWith(SHOW)) {
    if (Number(id.slice(SHOW.length)) !== s.card) return none(s);
    if (!input.reply.ok)
      return none({
        ...s,
        read: { error: input.reply.error.message, images: keptImages(s.read.images) },
        sheets: { rows: [], state: 'error', message: input.reply.error.message },
      });
    if (input.command !== 'card show') return none(s);
    const d = input.reply.data;
    const read = shownRead(d.comments, d, keptImages(s.read.images));

    return {
      state: { ...s, shown: d, read, sheets: dialogSheets(d.id, d.sheets) },
      commands: imagesCommand(d.id, read),
    };
  }
  if (id.startsWith(IMAGES)) {
    if (Number(id.slice(IMAGES.length)) !== s.card || s.read.text === undefined) return none(s);
    const answered: Record<string, string | null> = {};

    if (input.reply.ok && input.command === 'card images')
      for (const i of input.reply.data.images) answered[i.url] = i.path ?? null;
    else if (!input.reply.ok) for (const url of imagesToRead(s.read)) answered[url] = null;

    return none({ ...s, read: { ...s.read, images: { ...s.read.images, ...answered } } });
  }
  if (id.startsWith(POST)) {
    const card = Number(id.slice(POST.length));

    if (!input.reply.ok)
      return none({ ...s, post: { card, state: 'failed', error: refusal(input) } });
    const drafts = Object.fromEntries(Object.entries(s.drafts).filter(([k]) => Number(k) !== card));
    const next: CardPageState = { ...s, drafts, post: undefined };

    // the thread read again: the comment as the board keeps it
    return card === s.card ? asking(next, [showRead(card)]) : none(next);
  }
  // (no `u` here: an assign says whom, without the Board's undo)
  if (isActionAnswer(id)) {
    const out = actionAnswer(s.actions, input, { undo: false });
    const next = { ...s, actions: out.actions };
    const l = out.launched;

    if (isAssignRun(id)) {
      // the card read again: whose it is now
      const read =
        input.reply.ok && s.card !== undefined ? asking(next, [showRead(s.card)]) : none(next);

      return { state: read.state, commands: [...out.commands, ...read.commands] };
    }

    return {
      state: next,
      commands:
        l === undefined
          ? out.commands
          : [...out.commands, factsAgain, ...chatOn(l.card, l.run.session)],
    };
  }
  if (id.startsWith('retry:') || id.startsWith('reopen:'))
    return { state: s, commands: relaunchAnswer(input) };
  if (id.startsWith(JUMP_WORKSPACE)) {
    if (!input.reply.ok) return { state: s, commands: [balloon(refusal(input))] };
    if (input.command !== 'workspace attach-spec') return none(s);
    const session = id.slice(JUMP_WORKSPACE.length);

    return {
      state: s,
      commands: [
        { kind: 'shell', effect: workspaceLanding(input.reply.data, `download:${session}`) },
      ],
    };
  }
  if (id.startsWith(CHECKOUT)) {
    if (!input.reply.ok) return { state: s, commands: [statusLine(input.reply.error.message)] };
    if (input.command !== 'card checkout') return none(s);
    const d = input.reply.data;

    return {
      state: s,
      commands: [
        { kind: 'shell', effect: { kind: 'open-project', path: d.worktree } },
        statusLine(`${d.made ? 'Checked out' : 'Opened'} ${d.branch}`),
      ],
    };
  }
  if (id.startsWith(PROTOTYPE)) {
    if (!input.reply.ok || input.command !== 'prototype start')
      return { state: s, commands: input.reply.ok ? [] : [balloon(refusal(input))] };
    const session = input.reply.data.code?.session;

    return {
      state: s,
      commands: session === undefined ? [] : chatOn(Number(id.slice(PROTOTYPE.length)), session),
    };
  }
  if (input.command === null) return none(s);

  return none(answered(s, input));
};

/** The fact reads' answers: the sessions, the card's runs, the team, `serve.target`. */
const answered = (s: CardPageState, input: Answer): CardPageState => {
  if (!input.reply.ok) return input.id === 'members' ? { ...s, membersFailed: true } : s;
  switch (input.command) {
    case 'card members':
      return { ...s, members: input.reply.data.members, membersFailed: false };
    case 'settings get': {
      const value = input.reply.data.value;

      return typeof value === 'string' ? { ...s, target: value } : s;
    }
    default:
      return s;
  }
};

/** The live facts handed: the card's sessions and runs among them, the launches heard. */
const onFacts = (s: CardPageState, f: Facts): CardPageState => ({
  ...s,
  sessions: f.sessions,
  runs: f.runs,
  here: f.here ?? s.here,
  launches: f.launches,
});

/** The verbs of `abe card` that change what the page shows. */
const CARD_WRITES = new Set(['move', 'assign', 'tag', 'edit', 'comment']);

const onEvent = (s: CardPageState, e: Event): Out => {
  const card = s.card;

  if (card === undefined) return none(s);
  switch (e.type) {
    case 'serve.started':
    case 'watch.gap':
      return asking(s, allReads(s));
    case 'board.changed': {
      const changed = e.data.cards.find((c) => c.card.id === card)?.card;

      if (changed === undefined) return none(s);
      // its text as serve read it at once, its comments with `card show` anew
      return asking(
        {
          ...s,
          shown: changed,
          read: {
            ...s.read,
            text: {
              description: changed.description,
              acceptanceCriteria: changed.acceptanceCriteria,
            },
          },
        },
        [showRead(card)],
      );
    }
    case 'command.ran':
      return e.data.noun === 'card' && e.data.verb !== null && CARD_WRITES.has(e.data.verb)
        ? asking(s, [showRead(card)])
        : none(s);
    default:
      return none(s);
  }
};

/** Opened (or opened again) on its card: a new card is read, the old one's draft kept. */
const onOpen = (s: CardPageState, input: Extract<Input, { kind: 'open' }>): Out => {
  const p = input.params;
  const named = p.card === undefined ? undefined : Number(p.card);
  const card =
    named !== undefined && Number.isInteger(named) && named > 0 ? named : cardOfBranch(p.branch);
  const base: CardPageState = {
    ...s,
    size: input.size,
    ...(p.root === undefined ? {} : { root: p.root }),
    from: p.from === 'board' ? 'board' : undefined,
  };

  if (card === s.card && s.shown !== undefined) return none(base);

  return asking(
    {
      ...base,
      card,
      shown: undefined,
      read: {},
      sheets: undefined,
      scroll: 0,
      extent: undefined,
      focus: 'page',
    },
    card === undefined ? [] : [showRead(card), ...factReads()],
  );
};

const stepCard = (s: CardPageState, input: Input): Out => {
  switch (input.kind) {
    case 'open':
      return onOpen(s, input);
    case 'root': {
      // another workspace shown: its branch's card, if it is a card's
      const card = cardOfBranch(input.branch);

      return card === undefined || card === s.card
        ? none({ ...s, root: input.root })
        : onOpen(
            { ...s, root: input.root },
            {
              kind: 'open',
              params: { card: String(card), root: input.root },
              size: s.size,
            },
          );
    }
    case 'resize':
      return none({ ...s, size: input.size });
    case 'tick':
      return none({ ...s, now: input.at });
    case 'focus':
      return none({ ...s, away: !input.focused });
    case 'key':
      return onKey(s, input.key);
    case 'click':
      return onClick(s, input.id);
    case 'text':
      return s.focus === 'composer' && !posting(s)
        ? none(withDraft(s, fieldInsert(draftOf(s), input.text)))
        : none(s);
    case 'extent':
      return s.card !== undefined && input.id === pageId(s.card)
        ? none({ ...s, extent: input.lines, scroll: Math.min(s.scroll, input.lines) })
        : none(s);
    case 'choice':
      return onChoice(s, input);
    case 'result':
      return onResult(s, input);
    case 'live':
      return none(onFacts(s, input.facts));
    case 'event':
      return onEvent(s, input.event);
    case 'jump':
      return onJump(s, input);
    default:
      return none(s);
  }
};

/** Open card on another card: that card's page here. */
const onJump = (s: CardPageState, j: Jump): Out =>
  j.to === 'story' && j.story !== s.card
    ? onOpen(s, { kind: 'open', params: { card: String(j.story) }, size: s.size })
    : none(s);

// ---------------------------------------------------------------- the tree

const pageId = (card: number): string => `card-page:${card}`;

/** How the comment's post goes. */
const composerState = (s: CardPageState, failed: Post | undefined): PageComposer['state'] => {
  if (posting(s)) return 'posting';

  return failed === undefined ? 'writing' : 'failed';
};

/** The title before `card show` answered: reading it, or that it was not read. */
const unreadTitle = (s: CardPageState): string => {
  if (s.card === undefined) return 'No card here';

  return s.read.error === undefined
    ? `Reading #${cardName(s.card)}…`
    : `#${cardName(s.card)} not read`;
};

/**
 * The page's heading: `Card · ` the card's own workspace (its session's worktree folder, a box's
 * name), plain `Card` with none; never the window's worktree.
 */
const headingOf = (f: CardFacts): string => {
  const x = f.session;
  const where =
    x?.box ??
    x?.worktree
      .split('/')
      .filter((p) => p !== '')
      .at(-1);

  return where === undefined ? 'Card' : `Card · ${where}`;
};

/** The page, once `card show` answered; reading or why not until then. */
export const viewCardPage = (s: CardPageState): CardPage => {
  const f = factsOf(s);
  const card = s.card ?? 0;
  const draft = draftOf(s);
  const failed = s.post?.state === 'failed' && s.post.card === s.card ? s.post : undefined;
  const composer: PageComposer = {
    text: draft.text,
    ...(caretProp(draft) === undefined ? {} : { caret: caretProp(draft) }),
    placeholder: `Comment on #${cardName(card)}… · ⏎ comment · ⌘⏎ actions`,
    focused: s.focus === 'composer' && s.away !== true,
    state: composerState(s, failed),
    ...(failed?.error === undefined ? {} : { error: failed.error }),
  };
  const at = focusOf(s);
  const focus = at === 'page' || at === 'composer' ? {} : { focus: `${ACTION}${at}` };

  if (f === undefined)
    return {
      kind: 'CardPage',
      id: pageId(card),
      props: {
        kicker: 'Card',
        card,
        state: '',
        title: unreadTitle(s),
        meta: s.read.error === undefined ? [] : [s.read.error],
        sections: [],
        scroll: 0,
        buttons: [],
        heading: 'Card',
        composer: { ...composer, focused: false },
      },
    };
  const story = storyDialog({ ...f, now: nowMs(s) }, s.sheets, s.read, s.now).dialog.props;

  return {
    kind: 'CardPage',
    id: pageId(card),
    props: {
      ...story,
      heading: headingOf(f),
      scroll: s.scroll,
      buttons: buttonsOf(f),
      hint: '⌘⏎ actions · ? keys',
      ...focus,
      composer,
    },
  };
};

/** `:` and `?` on the page: the card as the Subject, the page's keys. */
const cardHere = (s: CardPageState): Here => {
  const f = factsOf(s);

  return { keys: 'card', ...(f === undefined ? {} : { subject: cardSubject(f) }) };
};

/** What it keeps for a reopen: the drafts; the card read again. */
const keepCard = (s: CardPageState): CardPageState => ({ ...INIT, drafts: s.drafts });

/** The watch's events it takes: a card written or changed on the board (its thread read again), a break; any other never re-views it. */
const CARD_EVENTS: ReadonlySet<Event['type']> = new Set([
  'serve.started',
  'watch.gap',
  'command.ran',
  'board.changed',
]);

export const cardScreen: Screen<CardPageState> = {
  events: CARD_EVENTS,
  name: CARD_SCREEN,
  init: INIT,
  step: withShortAsk(stepCard),
  follows: () => ['sessions', 'runs'],
  view: viewCardPage,
  linked: (s) => s.card,
  // the composer takes every key, `?` and `:` too
  typing: (s) => s.focus === 'composer',
  keep: keepCard,
  here: cardHere,
};
