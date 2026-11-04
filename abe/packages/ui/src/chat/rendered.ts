/**
 * The rendered Chat's body and header (#113 S4 + S5, slice t113d; boards R-Turn, R-Working,
 * R-Anatomy, H-States B rows): what the `chat` screen (`pinned.ts`) draws for the session it
 * pinned, in place of 2.0's terminal on `abe session attach`.
 *
 * On a session it reads `abe session transcript <id>` once, then follows its
 * `session.transcript` events (`watch.gap` reads on with `--since`; a `serve.started` reads it
 * all again, serve numbering it anew). The tree is `transcript.ts`'s. The header is 2.1's B
 * Signal: `#2` and the title, the box's cloud or `Local sandbox`, `⌘⏎`; the rail, the state word,
 * the time in it, `N subagents`, all from `session list` / `factory status` and their events.
 * The column's `Chat | Terminal` toggle, Terminal mode, ⌘4, ⌃⌘← / ⌃⌘→ and Esc are the shell's (#119).
 *
 * Keys (Chat has the keyboard): `l ö` (and the arrows) the parts, `gg G` first / last (G jumps
 * down), ⏎ opens the part (a diff card: its file at the change in the editor, `open-file`; a
 * step: its output; `N steps`, `show N more`, `↓ N new`; the changes bar: Open all; an answered
 * card's line that made something, `◆ Made the pull request · o/shop#71`: opens it, #136), `u` on a
 * diff card reverts that file, on the bar the turn (asked `y` in Command mode, then `abe session
 * revert`), `y` copies the part (a step's output, a diff card's path, the turn's answer), ⌘⏎ the
 * session's actions, `/` finds in it (`find.ts`; ⌘F from the composer too), `n` / `N` go on with
 * the last text. The mouse selects text and ⌘C copies it (the app's, `transcript.rs`). A
 * teammate's session is read-only: no Keep, Revert, `u`.
 */
import type { FactoryRunData, LaunchProgress, PrototypeData, SessionData } from '@abe/core';
import { queuedForText } from '@abe/core/box-text';
import { screenWhen } from '@abe/core/when';
import { overridePill, overrideWords } from '../settings/settings-words';
import { type Glyph } from '../board/board';
import { empty, island, type AgentState, type Node, stack } from '../runtime/components';
import {
  BOX_ASLEEP,
  launchClock,
  lookOf,
  minutesIn,
  NEVER_PLACED,
  placedBox,
  railWord,
  sessionLook,
  shownState,
  subagentsWorking,
  whereOf,
} from '../board/flow';
import { type BoxMark, CLOUD_OF, type CloudState } from '../live';
import { launchLook, launchSteps } from '../board/launch';
import { HUB_WHERE } from '../board/session-rows';
import type { JumpTo } from '../runtime/protocol';
import { type Command, type Input, type Menu, type MenuRow } from '../runtime/runtime';
import {
  carriedOf,
  endRow,
  launchArgv,
  notReproducedRow,
  reopenDim,
  RETRY_RUN,
  retriesRun,
  retryTarget,
  sessionReopens,
} from '../board/card-actions';
import { overrideLine } from './cards';
import { type ChatHeader } from './terminal';
import { type ChatStatus, type SubagentRow } from './composer';
import {
  clockOf,
  dividersOf,
  reopenedDividers,
  type Folds,
  ids,
  isFolded,
  openFrom,
  type Log,
  NO_FOLDS,
  nextNumber,
  putEntries,
  type Stop,
  stopsOf,
  transcriptNode,
  type TreeOptions,
  type Turn,
  type TurnFile,
  turnsOf,
} from './transcript';
import { cloudOf, workspaceLook } from '../board/workspaces';
import {
  type ChatFind,
  findAgain,
  findKey,
  findLook,
  findMatches,
  findMoved,
  findOpened,
  findText,
  type Found,
} from './find';
import { stopDim, stopSessionConfirm, stoppedWords } from '../runtime/said';

/** The transcript Chat holds for one session, and how it is looked at. */
export type Rendered = {
  session: string;
  log: Log;
  /** Its first read: under way, done, or refused (the file gone, a moved session). */
  read: 'reading' | 'read' | 'unreadable';
  /** Unreadable because its box runs another abe (#188): the `box-version` refusal's words. */
  refusal?: string | undefined;
  folds: Folds;
  /** Scrolled up (the shell's `<transcript>:up`): new entries leave it, counted in `fresh`. */
  up: boolean;
  fresh: number;
  /** The shell's scroll moves: `bottom` counts the jumps down, `reveal` the cursor's part. */
  bottom: number;
  reveal?: string | undefined;
  /** An entry to show once it is read (the Run page's Open in Chat, 3.0 #21): its turn revealed. */
  at?: string | undefined;
  /** A `g` waits for its second. */
  g: boolean;
  /** The status line's subagent list, unfolded (Tab, a click): its selected row. */
  agents?: { row: number } | undefined;
  /** Find's field while it shows (`find.ts`); the last text once it closed (`n` / `N`). */
  find?: ChatFind | undefined;
  found?: Found | undefined;
};

/** What the body and header are drawn from besides the transcript. */
export type Facts = {
  session: SessionData;
  run?: FactoryRunData | undefined;
  /** The tick's time. */
  now?: string | undefined;
  /** A teammate's session: whose (`Ada Example`); read-only. */
  whose?: string | undefined;
  /** The shown workspace: its local folder, its box (a cloud one): where ⏎ opens a box's files. */
  shown?: { root?: string | undefined; box?: string | undefined } | undefined;
  /** `factory status` not read yet (#315): a session with no run may have one; its stage unknown. */
  runsUnread?: boolean | undefined;
  /** A prototype session's prototype, once `prototype list` named it: its preview; its card's title. */
  prototype?: Pick<PrototypeData, 'id' | 'url' | 'state'> | undefined;
  cardTitle?: string | undefined;
  /** The Abe chat's: every conversation of its repo (`abe chat --new`'s), ended ones too. */
  hubs?: readonly SessionData[] | undefined;
  /**
   * The session's box as `box list` and `box.state` say it: the header's cloud (a box that runs
   * on after its session ended runs, not asleep). None: the session's own state says it.
   */
  box?: BoxMark | undefined;
};

type Out = { state: Rendered; commands: Command[] };

const READ_ID = 'transcript';

const readFrom = (session: string, since = 0): Command => ({
  kind: 'run',
  id: READ_ID,
  argv: ['session', 'transcript', session, ...(since > 0 ? ['--since', String(since)] : [])],
  // the whole transcript kept by the host: another workspace's Chat and back draws it at once
  ...(since > 0 ? {} : { keep: true as const }),
});

/** A session's Chat before anything was read: its first read asked. */
export const renderedFor = (session: string): Out => ({
  state: {
    session,
    log: [],
    read: 'reading',
    folds: NO_FOLDS,
    up: false,
    fresh: 0,
    bottom: 0,
    g: false,
  },
  commands: [readFrom(session)],
});

const turnsFor = (r: Rendered, f: Facts) =>
  turnsOf(r.log, f.session.worktree, { live: f.session.state !== 'ended' });

/** A prototype session's preview: its app's page in the browser, once it is live. */
export const previewOpen = (f: Pick<Facts, 'prototype'>): Command[] =>
  f.prototype?.state === 'live' && f.prototype.url !== null
    ? [{ kind: 'shell', effect: { kind: 'open-url', url: f.prototype.url } }]
    : [];

const stopsFor = (r: Rendered, f: Facts): Stop[] =>
  stopsOf(turnsFor(r, f), r.folds, { newBelow: r.up && r.fresh > 0 });

const withFolds = (r: Rendered, change: Partial<Folds>): Rendered => ({
  ...r,
  folds: { ...r.folds, ...change },
});

const toggled = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

const added = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? [...list] : [...list, id];

const cursorAt = (r: Rendered, id: string): Rendered => ({
  ...withFolds(r, { cursor: id }),
  reveal: id,
});

/** A diff card's header clicked: folded by hand the other way than it is now. */
const flip = (r: Rendered, turn: Turn, n: number, id: string, f: Facts): Rendered => {
  const turns = turnsFor(r, f);
  const newest = turns.findIndex((t) => t.id === turn.id) >= openFrom(turns);
  const folded = isFolded(r.folds, id, newest, n);
  const without = (list: readonly string[]) => list.filter((x) => x !== id);

  return withFolds(
    r,
    folded
      ? { shown: [...without(r.folds.shown), id], hidden: without(r.folds.hidden) }
      : { hidden: [...without(r.folds.hidden), id], shown: without(r.folds.shown) },
  );
};

/** Jumped to the bottom: stuck there again, nothing new waiting. */
const jumpDown = (r: Rendered): Rendered => ({ ...r, up: false, fresh: 0, bottom: r.bottom + 1 });

/** What `↓ N new` counts: new parts to read (a message, the agent's text, a step). */
const COUNTED = new Set(['user', 'assistant-text', 'tool-use']);

/** Entries that are new to read (not a replacement): what `↓ N new` counts. */
const newCount = (r: Rendered, from: number, entries: readonly Log[number][]): number =>
  entries.filter((e, i) => from + i >= r.log.length && e?.agent === null && COUNTED.has(e.kind))
    .length;

/** The turn an entry is in: its own message, or the last of yours before it. */
const turnOfEntry = (log: Log, at: string): string | undefined => {
  const i = log.findIndex((e) => e?.id === at);

  if (i === -1) return undefined;

  return log.slice(0, i + 1).findLast((e) => e?.kind === 'user' && e.agent === null)?.id;
};

/**
 * Chat at an entry (the Run page's Open in Chat, 3.0 #21): its turn scrolled into view, the
 * transcript no longer stuck to the bottom; held until the entry is read.
 */
export const revealEntry = (r: Rendered, at: string): Rendered => {
  const turn = turnOfEntry(r.log, at);

  return turn === undefined
    ? { ...r, at }
    : { ...r, at: undefined, reveal: ids.turn(turn), up: true };
};

/** A `session.transcript` batch, an answer of `session transcript`. */
const put = (r: Rendered, from: number, entries: Parameters<typeof putEntries>[2]): Out => {
  const gap = from > nextNumber(r.log);
  const fresh = r.up ? r.fresh + newCount(r, from, entries) : 0;

  // a first read refused, then serve's events bring the entries after all
  const read = r.read === 'unreadable' && entries.length > 0 ? 'read' : r.read;

  return {
    state: ((next: Rendered) => (next.at === undefined ? next : revealEntry(next, next.at)))({
      ...r,
      log: putEntries(r.log, from, entries),
      fresh,
      read,
    }),
    commands: gap ? [readFrom(r.session, nextNumber(r.log))] : [],
  };
};

const openFile = (path: string, line: number): Command => ({
  kind: 'shell',
  effect: { kind: 'open-file', path, line },
});

/**
 * ⏎'s open-file for the files of a turn (#113 B8). A local session's are on this Mac as they are;
 * a box's are on its box: its own cloud workspace shown, as the box has them (the workspace's
 * attach reads them); a local checkout shown, at the same place in it; else nowhere here, said so.
 */
const openFiles = (f: Facts, files: readonly TurnFile[]): Command[] => {
  const box = f.session.box;
  const shown = f.shown ?? {};

  if (box === undefined || shown.box === box) return files.map((x) => openFile(x.abs, x.line));
  const root = shown.box === undefined ? shown.root?.replace(/\/+$/, '') : undefined;
  const opened = files.flatMap((x) =>
    root === undefined || x.path.startsWith('/') ? [] : [openFile(`${root}/${x.path}`, x.line)],
  );
  const first = files.find((x) => root === undefined || x.path.startsWith('/'));

  return first === undefined
    ? opened
    : [
        ...opened,
        {
          kind: 'shell',
          effect: {
            kind: 'balloon',
            tone: 'warning',
            text: `${first.path} is on box ${box}: open its workspace from the Board, ⏎ on the card or ⌘→`,
          },
        },
      ];
};

const revertTurn = (r: Rendered, turn: string, files: number): Command => ({
  kind: 'confirm',
  argv: ['session', 'revert', r.session, '--turn', turn],
  question: `Revert ${files} file${files === 1 ? '' : 's'}?`,
  details: ["Puts back each file's text from before this turn. A file changed since is refused."],
  yes: 'Revert',
  done: `Reverted ${files} file${files === 1 ? '' : 's'}`,
});

const revertFile = (r: Rendered, turn: string, path: string): Command => ({
  kind: 'confirm',
  argv: ['session', 'revert', r.session, '--turn', turn, '--file', path],
  question: `Revert ${path}?`,
  details: ['Puts back its text from before this turn. Refused when it changed since.'],
  yes: 'Revert',
  done: `Reverted ${path}`,
});

/** ⏎ on the cursor's part. */
const enter = (r: Rendered, f: Facts): Out => {
  const stop = stopsFor(r, f).find((s) => s.id === r.folds.cursor);

  switch (stop?.kind) {
    case 'diff':
      return { state: r, commands: openFiles(f, [stop.file]) };
    case 'bar':
      return { state: r, commands: openFiles(f, stop.turn.files) };
    case 'more':
      return {
        state: cursorAt(withFolds(r, { full: added(r.folds.full, stop.card) }), stop.card),
        commands: [],
      };
    case 'step':
      return {
        state: withFolds(r, { unfolded: toggled(r.folds.unfolded, stop.id) }),
        commands: [],
      };
    case 'steps': {
      const opened = withFolds(r, { opened: added(r.folds.opened, stop.turn.id) });
      const first = stop.turn.steps[0];

      return {
        state: first === undefined ? opened : cursorAt(opened, ids.step(first.id)),
        commands: [],
      };
    }
    case 'new':
      return { state: jumpDown(withFolds(r, { cursor: undefined })), commands: [] };
    case undefined:
      return { state: r, commands: [] };
  }
};

/** `u`: the cursor's diff card's file, or the bar's whole turn, asked first. */
const revert = (r: Rendered, f: Facts): Out => {
  if (f.whose !== undefined) return { state: r, commands: [] };
  const stop = stopsFor(r, f).find((s) => s.id === r.folds.cursor);

  if (stop?.kind === 'diff')
    return { state: r, commands: [revertFile(r, stop.turn.id, stop.file.path)] };
  if (stop?.kind === 'bar')
    return { state: r, commands: [revertTurn(r, stop.turn.id, stop.turn.files.length)] };

  return { state: r, commands: [] };
};

/** What `y` copies from a part, and the status line's words for it; undefined: nothing to copy. */
const yankOf = (stop: Stop): { text: string; words: string } | undefined => {
  switch (stop.kind) {
    case 'step': {
      const { step, output } = stop.step;

      return output.length > 0
        ? { text: output.join('\n'), words: "Copied the step's output" }
        : { text: `${step.verb} ${step.object}`.trim(), words: 'Copied the step' };
    }
    case 'diff':
      return { text: stop.file.path, words: `Copied ${stop.file.path}` };
    case 'bar':
    case 'steps': {
      const text = stop.turn.prose.join('\n\n');

      return text === '' ? undefined : { text, words: "Copied the agent's answer" };
    }
    default:
      return undefined;
  }
};

/**
 * `y` on the cursor's part: its text on the clipboard (a step's output, a diff card's path, the
 * turn's answer from its bar or `N steps`); with no cursor, undefined (the key types).
 */
const yank = (r: Rendered, f: Facts): Out | undefined => {
  const stop = stopsFor(r, f).find((s) => s.id === r.folds.cursor);

  if (stop === undefined) return undefined;
  const y = yankOf(stop);
  const said = (text: string): Command => ({ kind: 'shell', effect: { kind: 'status', text } });

  return {
    state: r,
    commands:
      y === undefined
        ? [said('Nothing to copy here')]
        : [{ kind: 'shell', effect: { kind: 'clipboard', text: y.text } }, said(y.words)],
  };
};

/** `l` / `ö`: the previous / next part; from none, the last. */
const move = (r: Rendered, f: Facts, by: -1 | 1): Out => {
  const stops = stopsFor(r, f);
  const at = stops.findIndex((s) => s.id === r.folds.cursor);
  const next = at < 0 ? stops.length - 1 : Math.min(stops.length - 1, Math.max(0, at + by));
  const stop = stops[next];

  return { state: stop === undefined ? r : cursorAt(r, stop.id), commands: [] };
};

const edge = (r: Rendered, f: Facts, last: boolean): Out => {
  const stops = stopsFor(r, f);
  const stop = last ? stops.at(-1) : stops[0];
  const moved = stop === undefined ? r : cursorAt(r, stop.id);

  return { state: last ? jumpDown(moved) : moved, commands: [] };
};

// ── Find ─────────────────────────────────────────────────────────────────────

/** Find's ids: its field (a click gives it the keys: the screen's), ↑ ↓ ×. */
export const FIND_ID = `${ids.transcript}:find`;

const matchesOf = (r: Rendered, f: Facts, text: string) =>
  findMatches(turnsFor(r, f), r.folds, text);

/** The current match drawn: a folded turn's rows opened (the app scrolls to its line). */
const atMatch = (r: Rendered, f: Facts): Rendered => {
  if (r.find === undefined) return r;
  const matches = matchesOf(r, f, r.find.text);
  const m = matches[Math.min(r.find.at, matches.length - 1)];

  return m?.opens === undefined ? r : withFolds(r, { opened: added(r.folds.opened, m.opens) });
};

/** The field closed: its text kept for `n` / `N`. */
const findClosed = (r: Rendered): Rendered => ({
  ...r,
  find: undefined,
  found:
    r.find === undefined || r.find.text === '' ? r.found : { text: r.find.text, at: r.find.at },
});

/** ⌘F (from the composer: `composer`): the find field with the keys. */
export const renderedFindOpen = (r: Rendered, composer: boolean): Rendered => ({
  ...r,
  find: findOpened(r.find, composer),
});

/** Whether the find field has the keys. */
export const renderedFinding = (r: Rendered | undefined): boolean => r?.find?.typing === true;

/** Another chat shown: its find bar closed, its text kept for `n` / `N`. */
export const renderedFindClosed = (r: Rendered): Rendered =>
  r.find === undefined ? r : findClosed(r);

/** The find field gave the keys up (to the composer, a card's own words): it stays shown. */
export const renderedFindLeft = (r: Rendered): Rendered =>
  r.find?.typing === true ? { ...r, find: { ...r.find, typing: false } } : r;

/**
 * Find's input: a click on its bar (any time), a key or text while its field has the keys.
 * Undefined: not its. `back`: it closed with the keys it took from the composer.
 */
export const renderedFindInput = (
  r: Rendered,
  f: Facts,
  input: Input,
): { state: Rendered; back: boolean } | undefined => {
  const find = r.find;

  if (find === undefined) return undefined;
  const count = (text: string) => matchesOf(r, f, text).length;
  const moved = (by: 1 | -1) => atMatch({ ...r, find: findMoved(find, count(find.text), by) }, f);

  if (input.kind === 'click')
    switch (input.id) {
      case `${FIND_ID}:next`:
        return { state: moved(1), back: false };
      case `${FIND_ID}:prev`:
        return { state: moved(-1), back: false };
      case `${FIND_ID}:close`:
        return { state: findClosed(r), back: find.composer === true };
      default:
        return undefined;
    }
  if (!find.typing) return undefined;
  if (input.kind === 'text')
    return { state: atMatch({ ...r, find: findText(find, input.text, count) }, f), back: false };
  if (input.kind !== 'key') return undefined;
  const out = findKey(find, input.key, count);

  if (out === undefined) return undefined;
  if (out.closed === true) return { state: findClosed(r), back: find.composer === true };

  return { state: atMatch({ ...r, find: out.find }, f), back: false };
};

/** `/`, `n` / `N` and Esc (a shown find closes) in the transcript's keys. */
const findTranscriptKey = (r: Rendered, f: Facts, key: string): Out | undefined => {
  if (key === '/') return { state: renderedFindOpen(r, false), commands: [] };
  if (key === '<Esc>' && r.find !== undefined) return { state: findClosed(r), commands: [] };
  if (key !== 'n' && key !== 'N') return undefined;
  const by = key === 'n' ? 1 : -1;
  const found = r.find ?? r.found;

  if (found === undefined) return undefined;
  const total = matchesOf(r, f, found.text).length;
  const find = r.find === undefined ? findAgain(found, total, by) : findMoved(r.find, total, by);

  return { state: atMatch({ ...r, find }, f), commands: [] };
};

/** The keys the transcript takes; any other is the screen's (a printable one the composer's, #115). */
const TRANSCRIPT_KEYS = new Set(['l', '<Up>', 'ö', '<Down>', 'g', 'G', '<CR>', 'u']);

const onKey = (r0: Rendered, f: Facts, key: string): Out => {
  const r = { ...r0, g: false };

  switch (key) {
    case 'l':
    case '<Up>':
      return move(r, f, -1);
    case 'ö':
    case '<Down>':
      return move(r, f, 1);
    case 'g':
      return r0.g ? edge(r, f, false) : { state: { ...r, g: true }, commands: [] };
    case 'G':
      return edge(r, f, true);
    case '<CR>':
      return enter(r, f);
    case 'u':
      return revert(r, f);
    default:
      return { state: r, commands: [] };
  }
};

/** A click: on a part (it takes the cursor), its button, or the shell's scroll news. */
const onClick = (r: Rendered, f: Facts, id: string): Out | undefined => {
  const agents = agentsClick(r, f, id);

  if (agents !== undefined) return agents;
  if (id === `${ids.transcript}:up`) return { state: { ...r, up: true }, commands: [] };
  if (id === `${ids.transcript}:bottom`)
    return { state: { ...r, up: false, fresh: 0 }, commands: [] };
  if (id === ids.newBelow) return { state: jumpDown(r), commands: [] };
  const bar = /^bar:(.+):(open-all|keep|revert)$/.exec(id);

  if (bar !== null) {
    const turn = turnsFor(r, f).find((t) => t.id === bar[1]);

    if (turn === undefined) return { state: r, commands: [] };
    if (bar[2] === 'open-all') return { state: r, commands: openFiles(f, turn.files) };
    if (f.whose !== undefined) return { state: r, commands: [] };
    if (bar[2] === 'keep')
      return { state: withFolds(r, { kept: added(r.folds.kept, turn.id) }), commands: [] };

    return { state: r, commands: [revertTurn(r, turn.id, turn.files.length)] };
  }
  const stop = stopsFor(r, f).find((s) => s.id === id);

  switch (stop?.kind) {
    case 'diff':
      // the header folds and unfolds the card
      return {
        state: cursorAt(flip(r, stop.turn, stop.n, id, f), id),
        commands: [],
      };
    case 'more':
    case 'step':
    case 'steps':
      return enter(cursorAt(r, id), f);
    case 'bar':
      return { state: cursorAt(r, id), commands: [] };
    default:
      return undefined;
  }
};

/**
 * One input on the rendered Chat: its read's answer, its events, keys and clicks. Undefined: not
 * the transcript's (the screen's own keys, ⌘⏎).
 */
export const stepRendered = (r: Rendered, f: Facts, input: Input): Out | undefined => {
  switch (input.kind) {
    case 'result':
      if (input.id !== READ_ID) return undefined;
      // the transcript as last read, drawn on an empty Chat while it is read anew; one drawn stays
      if (input.cached === true && r.log.length > 0) return { state: r, commands: [] };
      if (input.command !== 'session transcript')
        return { state: { ...r, read: r.log.length === 0 ? 'unreadable' : r.read }, commands: [] };
      if (!input.reply.ok) {
        const { error } = input.reply;

        return {
          state: {
            ...r,
            read: r.log.length === 0 ? 'unreadable' : r.read,
            refusal: error.code === 'box-version' ? error.message : undefined,
          },
          commands: [],
        };
      }
      if (input.reply.data.session !== r.session) return { state: r, commands: [] };
      {
        const out = put(r, input.reply.data.from, input.reply.data.entries);

        return { ...out, state: { ...out.state, read: 'read' } };
      }
    case 'event': {
      const e = input.event;

      if (e.type === 'session.transcript' && e.data.session === r.session)
        return put(r, e.data.from, e.data.entries);
      if (e.type === 'serve.started') {
        const again = renderedFor(r.session);

        return {
          state: { ...again.state, folds: r.folds, read: r.read },
          commands: again.commands,
        };
      }
      if (e.type === 'watch.gap')
        return { state: r, commands: [readFrom(r.session, nextNumber(r.log))] };

      return undefined;
    }
    case 'key': {
      // the status line's subagent list first, while it is unfolded (Tab unfolds it)
      const listed = agentsKey(r, f, input.key);

      if (listed !== undefined) return listed;
      if (input.key === 'y') {
        const y = yank({ ...r, g: false }, f);

        if (y !== undefined) return y;
      }
      const found = findTranscriptKey({ ...r, g: false }, f, input.key);

      if (found !== undefined) return found;
      // ⌘⏎ is the screen's menu; Esc hands the keys back (the screen says `unhandled`)
      if (!TRANSCRIPT_KEYS.has(input.key))
        // `g` and another key: Vim's, swallowed; any other key is the screen's
        return r.g ? { state: { ...r, g: false }, commands: [] } : undefined;

      return onKey(r, f, input.key);
    }
    case 'click':
      return onClick(r, f, input.id);
    default:
      return undefined;
  }
};

/**
 * The header's state, glyph and word: the run's look (its glyph the Board's rail row's), else the
 * session's own; ended `○ Ended`.
 */
const stateOf = (f: Facts): { state: AgentState; glyph: Glyph; word: string } => {
  const s = f.session;

  if (f.run !== undefined) {
    // a teammate's grill waits on them (#342): `◆ Needs Ana · Grill round 2`
    const look = lookOf(f.run, s, f.now, f.whose);
    // stopped by you: the look's own `○ Stopped` (#205); its box stopped: `◆ Box asleep` (#316)
    const settled =
      look.state === 'on-test' ||
      look.state === 'failed' ||
      look.state === 'ended' ||
      look === BOX_ASLEEP ||
      s.stopped;

    return s.state === 'ended' && !settled
      ? { state: 'ended', glyph: '○', word: 'Ended' }
      : { state: shownState(look), glyph: look.glyph, word: look.word };
  }
  // the session's own, as the Board's card says it (#310); a cloud launch's step (#142)
  const l = sessionLook(s, f.now);

  return { state: shownState(l), glyph: l.glyph, word: l.word };
};

/**
 * The header, B Signal (H-States B rows): `#2 The cart total ignores quantity`, the box's cloud
 * or `Local sandbox` (a teammate's: whose session), `⌘⏎`; the rail, the stage, the state word, the
 * time in it, `N subagents`. The column's toggle, ⋮ and × are the shell's, so none here.
 */
/** The header rail's stage word: the workspace's, Grill while its run grills (#342). */
const stageOfHeader = (f: Facts, look: ReturnType<typeof workspaceLook> | undefined): string =>
  f.run !== undefined && look?.stage !== null && look?.stage !== undefined
    ? railWord(f.run)
    : (look?.stage ?? '');

/** The preview's address in a prototype session's header: a click opens it in the browser. */
export const PROTOTYPE_PAGE = 'chat:prototype-page';

/** A URL as its header shows it: no scheme, no trailing slash. */
const addressOf = (url: string): string => url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');

/** The app's state on a prototype session's line 2 while its page is not up. */
const APP_WORDS: Readonly<Record<PrototypeData['state'], string[]>> = {
  live: [],
  starting: ['Starting the app…'],
  failed: ['app failed'],
  stopped: ['app stopped'],
};

/** A prototype session's line 2 before its state word: where it runs, its app's state. */
const prototypeWhere = (s: SessionData, p: Facts['prototype']): string =>
  [
    placedBox(s) ?? 'Local',
    ...(s.branch === '' ? [] : [s.branch]),
    ...(p === undefined ? [] : APP_WORDS[p.state]),
  ].join(' · ');

/**
 * A prototype session's header (the B Signal's prototype variant): line 1 `Prototype · #4 Show
 * VAT under the cart total` (no card: `Prototype` and its words) with `⌘⏎`; line 2 the preview's
 * address (a click opens it), where it runs and its branch, then the state word and the time in it.
 */
const prototypeHeader = (f: Facts, of: NonNullable<SessionData['prototype']>): ChatHeader => {
  const s = f.session;
  const card = of.card ?? s.card ?? undefined;
  const p = f.prototype;
  const { state, glyph, word } = stateOf(f);
  const elapsed = launchClock(s, f.now) ?? minutesIn(s.since, f.now);
  const url = p?.state === 'live' ? p.url : null;
  // no card: its own words (`Prototype · VAT line` says `VAT line`)
  const words = s.title.replace(/^Prototype\b\s*·?\s*/, '');

  return {
    kind: 'ChatHeader',
    id: 'chat-header',
    props: {
      title: 'Chat',
      story: {
        id: 'Prototype',
        title:
          card === undefined
            ? [words]
                .filter((w) => w !== '')
                .map((w) => `· ${w}`)
                .join('')
            : `· #${card}${f.cardTitle === undefined || f.cardTitle === '' ? '' : ` ${f.cardTitle}`}`,
      },
      hint: '⌘⏎',
      ...(url === null ? {} : { address: { id: PROTOTYPE_PAGE, text: addressOf(url) } }),
      rail: {
        segments: [],
        stage: prototypeWhere(s, p),
        state,
        glyph,
        word,
        ...(elapsed === '' ? {} : { elapsed }),
      },
      ...(subagentsWorking(s) > 0 ? { subagents: subagentsWorking(s) } : {}),
    },
  };
};

/** Where the Abe chat runs (the Sessions rows' words). */
export { HUB_WHERE };

/**
 * The Abe chat's header: line 1 `Abe · demo-shop` with `⌘⏎` (New conversation, Stop…), `Local ·
 * no sandbox`; line 2 dim, the main checkout it runs in.
 */
const hubHeader = (f: Facts): ChatHeader => {
  const s = f.session;

  return {
    kind: 'ChatHeader',
    id: 'chat-header',
    props: {
      title: 'Chat',
      story: { id: 'Abe', title: s.title.replace(/^Abe /, '') },
      face: true,
      env: HUB_WHERE,
      note: s.abe?.repo ?? s.worktree,
      hint: '⌘⏎',
      tabs: hubTabs(f).map((x) => {
        const state = sessionLook(x, f.now).state;

        return {
          id: `${HUB_TAB}${x.id}`,
          label: hubLabel(x),
          ...(x.id === s.id ? { selected: true } : {}),
          ...(state === 'running' || state === 'starting' ? { mark: 'working' as const } : {}),
          ...(state === 'needs-you' ? { mark: 'needs-you' as const } : {}),
          close: `${HUB_TAB_CLOSE}${x.id}`,
        };
      }),
      add: HUB_TAB_NEW,
    },
  };
};

/** The Abe chat's tabs' ids: one conversation (its session's id after it), its ×, `+`. */
export const HUB_TAB = 'chat:tab:';
export const HUB_TAB_CLOSE = 'chat:tab-close:';
export const HUB_TAB_NEW = 'chat:tab-new';

/**
 * A conversation's name: its first message's words (one named `/abe:install` before skills were
 * named is `Install`), else `Abe 2`, else (from before names) `Abe`.
 */
export const hubLabel = (x: SessionData): string => x.abe?.name ?? 'Abe';

/**
 * The Abe chat's tabs: its repo's open conversations (an ended one closed, unless it is the one
 * shown), the oldest first, the newest at the right.
 */
export const hubTabs = (f: Pick<Facts, 'session' | 'hubs'>): SessionData[] =>
  [...(f.hubs ?? [f.session])]
    .filter((x) => x.state !== 'ended' || x.id === f.session.id)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

/** How many closed conversations Recent conversations… lists. */
const RECENT = 20;

/** The menu's row that reopens a closed conversation: its id comes back as the choice's value. */
export const RECENT_ROW = 'recent';

/**
 * The header's cloud: what its box does as listed (`f.box`), but while its session starts or is
 * queued, starting, as the session says.
 */
const cloudIn = (f: Facts): CloudState | null => {
  const own = cloudOf(f.session);

  return own === null || own === 'starting' || f.box === undefined ? own : CLOUD_OF[f.box];
};

export const headerOf = (f: Facts): ChatHeader => {
  const s = f.session;

  if (s.prototype !== null) return prototypeHeader(f, s.prototype);
  if (s.kind === 'abe') return hubHeader(f);
  const card = s.card ?? f.run?.card;
  const look = card === undefined ? undefined : workspaceLook({ ...s, card }, f.run, f.now);
  const { state, glyph, word } = stateOf(f);
  // the Board's clock, to the minute (#147); a cloud launch's by the second (#142)
  const elapsed = launchClock(s, f.now) ?? (look === undefined ? '' : minutesIn(look.since, f.now));
  const cloud = cloudIn(f);
  const working = subagentsWorking(s);
  const box = placedBox(s);
  // a box's name is the header's box; else where it is in words (#246: never got a box)
  const where = box === undefined ? whereOf(s) : undefined;
  const whose = f.whose === undefined ? undefined : `${f.whose}'s session`;
  // an Override dies with its session: no row once it ended
  const override = s.state === 'ended' ? undefined : overrideLine(s.overrides, f.whose);
  // your settings Overrides the run launched under (#168)
  const personal = f.run?.personal ?? [];
  const pill = overridePill(personal);

  return {
    kind: 'ChatHeader',
    id: 'chat-header',
    props: {
      title: 'Chat',
      story: {
        id: card === undefined ? s.id : `#${card}`,
        title: f.run?.title ?? s.title,
      },
      ...(box === undefined || cloud === null ? {} : { box: { name: box, state: cloud } }),
      ...(where === undefined && whose === undefined
        ? {}
        : { env: [whose, where].filter((w) => w !== undefined).join(' · ') }),
      hint: '⌘⏎',
      rail: {
        // a session of no card (the Abe chat) has no card stages to draw
        segments:
          card === undefined ? [] : (look?.rail ?? ['todo', 'todo', 'todo', 'todo', 'todo']),
        // its run not read yet (#315): the stage is being read, not none
        stage: f.runsUnread === true && f.run === undefined ? 'Reading…' : stageOfHeader(f, look),
        state,
        glyph,
        word,
        ...(elapsed === '' ? {} : { elapsed }),
      },
      ...(working > 0 ? { subagents: working } : {}),
      // an Override live in the session (#114): the ✎ row in the warn hue
      ...(override === undefined ? {} : { override }),
      ...(pill === undefined
        ? {}
        : {
            pill: {
              text: pill,
              tooltip: `${f.whose === undefined ? 'Your' : `${f.whose}'s`} Override, for ${f.whose === undefined ? 'your' : 'their'} runs only: ${personal.map(overrideWords).join('; ')}`,
            },
          }),
    },
  };
};

/**
 * What other parts of Chat put into the rendered body (#114's cards, #115's composer): nodes in
 * the transcript (`placed` by time, `tail` after the last turn) and the column's foot under it
 * (the deferred pill, then the composer), top to bottom.
 */
export type Slots = Pick<TreeOptions, 'placed' | 'tail'> & { foot?: readonly Node[] | undefined };

/**
 * A cloud launch's steps while it starts (#142), in place of a transcript it has not got yet:
 * each step gone through with its time, the one now with its clock, and once it is late what is
 * late and what to run.
 */
export const launchBody = (l: LaunchProgress, now: string): Node => {
  const seen = launchLook(l, now);
  const row = (text: string, o: { dim?: string; note?: string } = {}): Node => ({
    kind: 'ListRow',
    props: { text, ...o },
  });

  return stack(
    'column',
    [
      ...launchSteps(l, now).map((s) => row(s.text, { note: s.time })),
      ...(seen.note === undefined
        ? []
        : [
            {
              kind: 'ListRow' as const,
              props: { text: seen.note },
              children: [
                {
                  kind: 'Badge' as const,
                  props: {
                    text: seen.tone === 'stuck' ? 'Stuck' : 'Slow',
                    hue: seen.tone === 'stuck' ? ('bad' as const) : ('warn' as const),
                  },
                },
              ],
            },
          ]),
      ...(seen.fix ?? []).map((x) => row(x.label, { dim: x.argv })),
    ],
    { gap: 2, pad: [12, 16, 12, 16] },
  );
};

/**
 * A Queued launch (#321), in place of a transcript it has not got yet: what it waits for (the
 * boxes that count against `limits.maxBoxesPerPerson`, as `session show` says it) and the ways on:
 * stop one of those boxes, or take it out of the queue.
 */
const queuedBody = (s: SessionData): Node => {
  const row = (text: string): Node => ({ kind: 'ListRow', props: { text } });

  return stack(
    'column',
    [
      row(
        s.queuedFor === undefined
          ? 'Queued: waits for room under limits.maxBoxesPerPerson · starts when one of your boxes stops'
          : `Queued: ${queuedForText(s.queuedFor)}`,
      ),
      row('Make room: stop one of those boxes (Boxes, on the rail)'),
      row('Or ⌘⏎ Stop… takes it out of the queue'),
    ],
    { gap: 2, pad: [12, 16, 12, 16] },
  );
};

/** The body under the header: the transcript, or why there is none to show. */
const bodyOf = (r: Rendered, f: Facts, slots: Slots): Node => {
  const l = f.session.launch;

  if (f.session.state === 'starting' && l !== null && f.now !== undefined && r.log.length === 0)
    return launchBody(l, f.now);
  if (f.session.state === 'queued' && r.log.length === 0) return queuedBody(f.session);
  // one dim line each, the header still live above it
  if (r.read === 'unreadable') {
    // Terminal mode attaches a live session only (#258): no way on to offer once it ended
    const terminal = f.session.state === 'ended' ? '' : ' · ⌃⌘→ Terminal mode';

    return empty(
      '',
      r.refusal === undefined
        ? `Transcript not readable here${terminal}`
        : `Transcript not readable: ${r.refusal}${terminal}`,
    );
  }
  if (r.read === 'reading' && r.log.length === 0) return empty('', 'Reading the transcript');
  // a reopen waking its box (#343): its launch steps below the conversation it goes on with
  const waking =
    f.session.state === 'starting' && l !== null && f.now !== undefined
      ? [launchBody(l, f.now)]
      : [];
  const tail = [...(slots.tail ?? []), ...waking];

  return transcriptNode(
    turnsFor(r, f),
    [...dividersOf(f.run), ...reopenedDividers(f.session)],
    r.folds,
    {
      session: r.session,
      now: f.now,
      readOnly: f.whose !== undefined,
      newBelow: r.up ? r.fresh : 0,
      ...(r.reveal === undefined ? {} : { reveal: r.reveal }),
      ...(r.bottom > 0 ? { bottom: r.bottom } : {}),
      ...(slots.placed === undefined ? {} : { placed: slots.placed }),
      ...(tail.length === 0 ? {} : { tail }),
      ...(r.find === undefined ? {} : { find: findLook(r.find, matchesOf(r, f, r.find.text)) }),
      ...(f.session.kind === 'abe' ? { mark: 'abe' as const } : {}),
    },
  );
};

/** Chat's island in the column: the header B, the transcript, then the slots' foot. */
// ── The status line ───────────────────────────────────────────────────────────

/** The status line's ids: the subagents' toggle, each listed run. */
export const STATUS_ID = 'chat:status';
export const AGENTS_ID = 'chat:agents';
const AGENT_PREFIX = 'chat:agent:';

/** The status line's list at most. */
const AGENTS_MAX = 12;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A session's subagent runs as the list has them: the running only, newest first. */
const runsListed = (s: SessionData): SessionData['subagents'] =>
  [...s.subagents]
    .reverse()
    .filter((x) => x.state === 'running')
    .slice(0, AGENTS_MAX);

/** The newest turn's step still running (its tool call made, no result yet). */
const runningStep = (r: Rendered, f: Facts) =>
  turnsFor(r, f)
    .at(-1)
    ?.steps.findLast((x) => x.done === undefined && x.step.glyph === 'running');

const epoch = (iso: string): number => Math.max(0, Date.parse(iso));

/** What the agent does now, in the status line's words. */
const doing = (
  r: Rendered,
  f: Facts,
  asking: boolean,
): Pick<ChatStatus['props'], 'tone' | 'words' | 'since'> => {
  const s = f.session;
  const since = epoch(s.since);
  // its turn ended: your turn, though its background subagents still work
  const ended = (): Pick<ChatStatus['props'], 'tone' | 'words' | 'since'> => {
    const working = subagentsWorking(s);

    return working > 0
      ? { tone: 'working', words: `Your turn · ${plural(working, 'subagent')} working`, since }
      : { tone: 'idle', words: 'Idle · your turn' };
  };

  switch (s.state) {
    case 'queued':
      return { tone: 'starting', words: 'Queued', since };
    case 'starting':
      return { tone: 'starting', words: 'Starting', since };
    case 'waiting':
      // a card of Chat's or a dialog in its terminal; its turn simply ended is your turn
      return asking || s.waitingOn === 'dialog'
        ? { tone: 'waiting', words: 'Waiting on you', since }
        : ended();
    case 'working':
    case 'ended': {
      if (s.state === 'working' && s.turnEnded === true) return ended();
      const step = runningStep(r, f);
      const working = subagentsWorking(s);
      const words = (() => {
        if (step !== undefined && step.step.verb !== 'Task')
          return `${step.step.verb} ${step.step.object}`.trim();

        return working > 0 ? `Waiting on ${plural(working, 'subagent')}` : 'Thinking';
      })();

      return { tone: 'working', words, since };
    }
  }
};

/** A run's row in the list: its task, how long, its last tool (its result once done). */
const agentRow = (x: SessionData['subagents'][number]): SubagentRow => {
  const last = x.state === 'running' ? x.tool : (x.result ?? x.tool);

  return {
    id: `${AGENT_PREFIX}${x.id}`,
    name: x.name,
    ...(x.task === null ? {} : { task: x.task }),
    state: x.state,
    since: epoch(x.startedAt),
    ...(x.endedAt === null ? {} : { until: epoch(x.endedAt) }),
    ...(last === null || last === undefined ? {} : { last }),
  };
};

/**
 * The one line right above the composer: what the agent does now and for how long, `N subagents`
 * at its right while any run; unfolded, their list. None once the session ended.
 */
export const chatStatus = (r: Rendered, f: Facts, o: { asking: boolean }): ChatStatus | null => {
  const s = f.session;

  if (s.state === 'ended') return null;
  const runs = runsListed(s);
  const running = subagentsWorking(s);
  const open = r.agents !== undefined && runs.length > 0;

  return {
    kind: 'ChatStatus',
    id: STATUS_ID,
    props: {
      ...doing(r, f, o.asking),
      ...(runs.length === 0
        ? {}
        : { agents: { text: plural(running, 'subagent'), id: AGENTS_ID, running, open } }),
      ...(open
        ? {
            list: runs.map(agentRow),
            selected: Math.min(r.agents?.row ?? 0, runs.length - 1),
          }
        : {}),
    },
  };
};

/** The transcript at a subagent's Agent call: its turn's rows shown, its row unfolded, the cursor on it. */
const atAgentCall = (r: Rendered, f: Facts, call: string | null | undefined): Rendered => {
  if (call === null || call === undefined) return r;
  for (const turn of turnsFor(r, f)) {
    const step = turn.steps.find((x) => x.id === call || x.calls?.includes(call) === true);

    if (step !== undefined) {
      const id = ids.step(step.id);
      const opened = withFolds(r, {
        opened: added(r.folds.opened, turn.id),
        unfolded: added(r.folds.unfolded, id),
      });

      return { ...cursorAt(opened, id), up: true };
    }
  }

  return r;
};

/** A listed run's own transcript opened in the editor; a box's is on its box, said so. */
const agentLog = (f: Facts, run: SessionData['subagents'][number] | undefined): Command[] => {
  if (run?.transcript === null || run?.transcript === undefined) return [];
  if (f.session.box !== undefined)
    return [
      {
        kind: 'shell',
        effect: {
          kind: 'balloon',
          tone: 'warning',
          text: `${run.name}'s transcript is on box ${f.session.box}`,
        },
      },
    ];

  return [openFile(run.transcript, 1)];
};

/**
 * The status line's list's keys: Tab unfolds and folds it; unfolded, `l ö` (↑ ↓) move, ⏎ goes to
 * the run's Agent call in the transcript, `o` opens its own transcript, Esc folds it.
 * Undefined: not the list's.
 */
const agentsKey = (r: Rendered, f: Facts, key: string): Out | undefined => {
  const runs = runsListed(f.session);

  if (key === '<Tab>' && runs.length > 0)
    return {
      state: { ...r, agents: r.agents === undefined ? { row: 0 } : undefined },
      commands: [],
    };
  if (r.agents === undefined || runs.length === 0) return undefined;
  const row = Math.min(r.agents.row, runs.length - 1);

  switch (key) {
    case 'l':
    case '<Up>':
      return { state: { ...r, agents: { row: Math.max(0, row - 1) } }, commands: [] };
    case 'ö':
    case '<Down>':
      return { state: { ...r, agents: { row: Math.min(runs.length - 1, row + 1) } }, commands: [] };
    case '<CR>':
      return { state: atAgentCall(r, f, runs[row]?.call), commands: [] };
    case 'o':
      return { state: r, commands: agentLog(f, runs[row]) };
    case '<Esc>':
      return { state: { ...r, agents: undefined }, commands: [] };
    default:
      return undefined;
  }
};

const agentsClick = (r: Rendered, f: Facts, id: string): Out | undefined => {
  if (id === AGENTS_ID)
    return {
      state: { ...r, agents: r.agents === undefined ? { row: 0 } : undefined },
      commands: [],
    };
  if (!id.startsWith(AGENT_PREFIX)) return undefined;
  const runs = runsListed(f.session);
  const row = runs.findIndex((x) => `${AGENT_PREFIX}${x.id}` === id);

  if (row === -1) return { state: r, commands: [] };

  return { state: atAgentCall({ ...r, agents: { row } }, f, runs[row]?.call), commands: [] };
};

export const renderedView = (r: Rendered, f: Facts, slots: Slots = {}): Node => {
  const foot = slots.foot ?? [];

  return island(
    [
      stack('column', [headerOf(f), bodyOf(r, f, slots), ...foot], {
        sizes: ['auto', { flex: 1 }, ...foot.map(() => 'auto' as const)],
      }),
    ],
    'chat',
  );
};

/** The session's menu's id: its rows come back as `choice`s. */
export const SESSION_MENU = 'chat:session';

/** A jump along the session's story (#106), as its key does (if it has one); grey with no story to go along. */
const jumpRow = (
  to: JumpTo,
  text: string,
  key: string | undefined,
  story: number | undefined,
): MenuRow => ({
  id: to,
  text,
  ...(key === undefined ? {} : { key }),
  ...(story === undefined
    ? { reason: 'no story', does: { kind: 'back' as const } }
    : { does: { kind: 'do' as const, commands: [{ kind: 'jump' as const, to, story }] } }),
});

/**
 * ⌘⏎: the session's actions. Stop… (asked) while it has not ended, Retry on a failed or stopped run
 * (neither on a teammate's; ⏎ too), Resume once it ended with no run of its own (a new session on
 * the story, #243; nothing grey where it does not work, #296), a
 * Factory run's End run… and, on a bug that does not reproduce, End: can't reproduce (#184), Open workspace,
 * Open card and Linked ⌃L (the jumps along its story, #106).
 */
/** Open workspace (no key: the Board's ⌘→); one that never got a box has none (#246). */
const workspaceRow = (s: SessionData, card: number | undefined): MenuRow =>
  s.neverPlaced === true
    ? {
        id: 'workspace',
        text: 'Open workspace',
        reason: NEVER_PLACED,
        does: { kind: 'back' },
      }
    : jumpRow('workspace', 'Open workspace', undefined, card);

/** The Abe chat's New conversation (its ⌘⏎ menu row): `abe chat --new` in its repo. */
export const NEW_CONVERSATION = 'new-conversation';

/** `abe chat`'s run (start, reopen, New conversation): its answer pins Chat on the Abe chat. */
export const HUB_RUN = 'chat:hub';

/** `abe chat` in the Abe chat's repo: `--new` a new conversation, else the one it had reopened. */
export const hubArgv = (repo: string, fresh = false): string[] => [
  'chat',
  ...(fresh ? ['--new'] : []),
  '--repo',
  repo,
];

/**
 * The Abe chat's ⌘⏎ (its repo's one, never a card's): New conversation (the old one kept), Stop…
 * while it runs, Reopen once it ended (`abe chat`: its conversation resumed).
 */
const hubMenu = (f: Facts): Menu => {
  const s = f.session;
  const rows: MenuRow[] = [
    {
      id: NEW_CONVERSATION,
      text: 'New conversation',
      dim: 'a tab beside this one',
      // back to Chat, which opens it as its + does: the new tab selected, its input with the keys;
      // an idle tab spends nothing until you write, so not costly: the menu rests on it (⌘⏎ ⏎)
      does: { kind: 'back' },
    },
    s.state === 'ended'
      ? {
          id: 'reopen',
          text: 'Reopen',
          dim: reopenDim(s.since, f.now),
          key: '⏎',
          costly: true,
          does: {
            kind: 'do',
            commands: [{ kind: 'run', id: REOPEN_HUB, argv: ['session', 'reopen', s.id] }],
          },
        }
      : {
          id: 'stop',
          text: 'Stop…',
          dim: stopDim(s),
          does: {
            kind: 'run',
            argv: ['session', 'stop', s.id],
            risky: true,
            confirm: stopSessionConfirm(undefined, s),
            done: stoppedWords(undefined),
          },
        },
    ...recentRow(f),
  ];

  return { kind: 'menu', id: SESSION_MENU, title: s.title, rows };
};

/** The Abe chat's Reopen (its menu's): `session reopen` on this conversation. */
export const REOPEN_HUB = 'chat:hub-reopen';

/**
 * Recent conversations…: the repo's closed ones (the last 20, newest first, each its name and
 * when it closed); the one picked comes back as the row's choice, reopened as a tab.
 */
const recentRow = (f: Facts): MenuRow[] => {
  const closed = (f.hubs ?? [])
    .filter((x) => x.state === 'ended' && x.id !== f.session.id)
    .sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
    .slice(0, RECENT);
  const [first, ...rest] = closed.map((x) => x.id);

  if (first === undefined) return [];

  return [
    {
      id: RECENT_ROW,
      text: 'Recent conversations…',
      dim: `${String(closed.length)} closed`,
      does: {
        kind: 'back',
        ask: [
          {
            name: 'conversation',
            kind: 'positional',
            type: 'enum',
            values: [first, ...rest],
            labels: Object.fromEntries(
              closed.map((x) => [
                x.id,
                `${hubLabel(x)} · ${f.now === undefined ? clockOf(x.since) : screenWhen(x.since, f.now)}`,
              ]),
            ),
            title: 'Reopen a conversation',
            required: true,
            repeats: false,
            summary: 'the conversation',
          },
        ],
      },
    },
  ];
};

export const sessionMenu = (f: Facts): Menu => {
  const s = f.session;

  if (s.kind === 'abe') return hubMenu(f);
  const card = s.card ?? f.run?.card ?? undefined;
  // a teammate's session is only looked at: nothing stops, reopens or retries it from here
  const yours = f.whose === undefined;
  // ⏎ on an ended card session of yours reopens it (#343): failed, stopped and Done runs too
  const reopens = yours && card !== undefined && sessionReopens(s);
  // Retry run (#343): a new session from decide, only on a run not over
  const retries = s.state === 'ended' && yours && f.run !== undefined && retriesRun(f.run);
  const rows: MenuRow[] = [
    ...(s.state === 'ended' || !yours
      ? []
      : [
          {
            id: 'stop',
            text: 'Stop…',
            dim: stopDim(s),
            does: {
              kind: 'run' as const,
              argv: ['session', 'stop', s.id],
              risky: true,
              confirm: stopSessionConfirm(card, s),
              done: stoppedWords(card),
            },
          },
        ]),
    ...(reopens
      ? [
          {
            id: 'reopen',
            text: 'Reopen',
            dim: reopenDim(s.since, f.now),
            // ⏎ on the ended session does it too, as its ended line says
            key: '⏎',
            // a session goes on and spends: never where the menu rests (#313)
            costly: true,
            does: {
              kind: 'run' as const,
              argv: ['session', 'reopen', s.id],
              done: `Reopened ${s.id}`,
            },
          },
        ]
      : []),
    ...(retries && f.run !== undefined
      ? [
          {
            id: 'retry',
            text: RETRY_RUN,
            dim: 'a new session from decide, same worktree',
            costly: true,
            does: {
              kind: 'run' as const,
              // a box that slept while it waited goes on in the cloud (#192, #221), in the shown
              // folder's repo as the Board and Sessions do; a cloud run's own `repo` is no folder here
              argv: launchArgv(
                { card: { id: f.run.card }, root: f.shown?.root ?? f.run.repo },
                retryTarget(s),
                carriedOf(f.run),
              ),
            },
          },
        ]
      : []),
    // a Factory run's way out (#184): End run…, and End: can't reproduce while it waits on that
    ...(f.run === undefined || !yours
      ? []
      : [...notReproducedRow(f.run.card, f.run), endRow(f.run.card, f.run)]),
    workspaceRow(s, card),
    jumpRow('story', 'Open card', undefined, card),
    jumpRow('linked', 'Linked', '⌃L', card),
  ];

  return { kind: 'menu', id: SESSION_MENU, title: card === undefined ? s.id : `#${card}`, rows };
};
