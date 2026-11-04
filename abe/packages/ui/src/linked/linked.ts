/**
 * Linked (#109 S2–S3, board W-Linked): ⌃L's popup of everything on a story, Command mode's layer
 * (`command.ts` holds it, the bridge sends it as its `layer` frame). Search Everywhere's size and
 * look: the title `Linked · #2 The cart total ignores quantity` with `⌃L` dim at its right, the
 * ten rows of `abe story linked` (`linked-rows.ts`) always in their order, a label then its state
 * (the Run row with its StageRail, a state mark in its hue), a row with nothing dim and in place;
 * the footer `⏎ open · Esc close`. Typing filters the rows at once,
 * every letter types; ↑ ↓ and ⌃N ⌃P move, ⏎ opens the row ([`opensOf`]), Esc closes. It opens at once
 * (#341): the ten rows `Reading…`, each part of the read (`--part`) its own run, its rows drawn as
 * it lands, so none waits for the slowest. While it is up the rows follow `abe watch`
 * (`linkedOnEvent`): the Run row moves in place, the parts it can change are read again, one run
 * of a part out at a time (an event meanwhile reads it once more after: #124), the cursor staying
 * on its row.
 */
import {
  type Event,
  type LinkedKey,
  type LinkedOpens,
  type LinkedPart,
  type LinkedRow,
  type StoryLinkedData,
} from '@abe/core';
import { LINKED_KEYS, LINKED_PARTS } from '@abe/core/linked-keys';
import { reopenCommand } from '../board/card-actions';
import { type Hue } from '../runtime/components';
import { timeIn } from '../board/flow';
import { JUMP_KEYS } from '../board/jumps';
import { linkedOnEvent, linkedReading, linkedSettled, mergeLinked } from './linked-rows';
import { type ListMove, PAGE_ROWS, menuMove, movedRow } from '../runtime/list-moves';
import { type LinkedLayerNode, type LinkedRowView } from './linked-layer';
import {
  type Answer,
  type Command,
  type Input,
  type MenuRow,
  type Refused,
} from '../runtime/runtime';
import { type Span } from '../board/workspaces';

/** A run of the popup's: `linked:<story>:<n>`. */
export const LINKED_RUN = 'linked:';

/** The footer: only this popup's keys (⏎ and Esc). */
export const LINKED_HINT = '⏎ open · Esc close';

/**
 * A part's run out: its id (`linked:<story>:<n>`), how many events the popup had seen when it was
 * asked (`asked`), and an event asked for the part meanwhile.
 */
type Out = { run: string; asked: number; again: boolean };

/** The popup's state in Command mode. */
export type LinkedLayer = {
  kind: 'linked';
  story: number;
  /** The parts' runs out: one at most each (#124: an answer is never left for a newer one). */
  out: Partial<Record<LinkedPart, Out>>;
  /** The rows as the parts' answers so far drew them (`Reading…` until a part's is in). */
  data: StoryLinkedData;
  /** How many `abe watch` events it has seen. */
  events: number;
  /**
   * As of how many events each row is said: an event moving it in place, or the answer of a run
   * asked after them (#341: an answer asked before is never drawn over it).
   */
  drawn: Partial<Record<LinkedKey, number>>;
  /** Why a part's read failed whole (serve not answering): its rows say so once all are in. */
  error?: string | undefined;
  filter: string;
  /** The row the cursor is on, by its key: it stays there while the rows change. */
  selected?: LinkedKey | undefined;
  /** The clock (`tick`): times in stage and `ago` said as of it. */
  now?: string | undefined;
};

/** What a step leaves: the popup (undefined: closed), what to do, how many runs it used. */
export type LinkedStep = { layer: LinkedLayer | undefined; commands: Command[]; runs: number };

/**
 * `parts` read again: each its own run (`n`, `n + 1`, … : Command mode's run count), or, one of
 * its runs still out, read once more when that one is in.
 */
const read = (l: LinkedLayer, parts: readonly LinkedPart[], n: number): LinkedStep => {
  const out = { ...l.out };
  const commands: Command[] = [];

  for (const part of parts) {
    const was = out[part];

    if (was !== undefined) {
      out[part] = { ...was, again: true };
      continue;
    }
    const run = `${LINKED_RUN}${l.story}:${n + commands.length}`;

    out[part] = { run, asked: l.events, again: false };
    commands.push({
      kind: 'run',
      id: run,
      argv: ['story', 'linked', String(l.story), '--part', part],
    });
  }

  return { layer: { ...l, out }, commands, runs: commands.length };
};

/** The epoch: when nothing was read yet (no row says a time before a part is in). */
const NEVER = new Date(0).toISOString();

/** ⌃L: the popup on `story` at once, each part read (`n`: Command mode's run count). */
export const openLinked = (story: number, n: number, now?: string): LinkedStep =>
  read(
    {
      kind: 'linked',
      story,
      out: {},
      data: linkedReading(story, now ?? NEVER),
      events: 0,
      drawn: {},
      filter: '',
      ...(now === undefined ? {} : { now }),
    },
    LINKED_PARTS,
    n,
  );

const kept = (layer: LinkedLayer | undefined): LinkedStep => ({ layer, commands: [], runs: 0 });

/** The rows the filter leaves, in their order: by label or by state. */
export const shownRows = (l: LinkedLayer): LinkedRow[] => {
  const f = l.filter.trim().toLowerCase();
  const rows = l.data.rows;

  return f === ''
    ? rows
    : rows.filter((r) => r.label.toLowerCase().includes(f) || r.words.toLowerCase().includes(f));
};

/** The row the cursor is on: the selected one if the filter left it, else the first. */
const cursorRow = (l: LinkedLayer): LinkedRow | undefined => {
  const rows = shownRows(l);

  return rows.find((r) => r.key === l.selected) ?? rows[0];
};

const moved = (l: LinkedLayer, m: ListMove): LinkedLayer => {
  const rows = shownRows(l);
  const at = rows.findIndex((r) => r.key === cursorRow(l)?.key);
  const next = rows[movedRow(m, at, rows.length)];

  return next === undefined ? l : { ...l, selected: next.key };
};

/** What a key types into the filter: one character (`<Space>` as a space). */
const typed = (key: string): string | undefined => {
  if (key === '<Space>') return ' ';
  if (key === '<lt>') return '<';

  return Array.from(key).length === 1 ? key : undefined;
};

/** The filter changed: the cursor on the first row it leaves. */
const filtered = (l: LinkedLayer, filter: string): LinkedLayer => {
  const next = { ...l, filter };

  return { ...next, selected: shownRows(next)[0]?.key };
};

const shell = (effect: Extract<Command, { kind: 'shell' }>['effect']): Command => ({
  kind: 'shell',
  effect,
});

const show = (place: 'chat' | 'sessions' | 'boxes' | 'pipelines'): Command =>
  shell({ kind: 'show', place });

const chatOn = (session: string): Command[] => [
  { kind: 'open', screen: 'chat', params: { session }, slot: 'chat' },
  show('chat'),
];

const sheetOn = (story: number, ref: string): Command[] => [
  shell({ kind: 'view', view: 'factory' }),
  { kind: 'open', screen: 'factory', params: { sheet: ref, card: String(story) } },
];

/** A pick of several (sessions, Sheets): each row runs its commands. */
const pickOf = (
  id: string,
  title: string,
  rows: readonly { id: string; text: string; commands: Command[] }[],
): Command => ({
  kind: 'menu',
  id,
  title,
  rows: rows.map((r): MenuRow => ({
    id: r.id,
    text: r.text,
    does: { kind: 'do', commands: r.commands },
  })),
});

/**
 * What ⏎ on a row does (#109 Behaviour 5): the story's Card page, the browser, the spec's file,
 * the Factory view on the card, the session in the Chat column (several: a pick), the bottom
 * pane's Pipelines or Boxes tab on that row, the workspace, the Sheet (several: a pick).
 */
export const opensOf = (story: number, opens: LinkedOpens): Command[] => {
  switch (opens.kind) {
    case 'story':
      return [{ kind: 'jump', to: 'story', story: opens.card }];
    case 'workspace':
      return [{ kind: 'jump', to: 'workspace', story }];
    case 'url':
      return [shell({ kind: 'open-url', url: opens.url })];
    case 'file':
      return [shell({ kind: 'open-file', path: opens.path })];
    case 'factory':
      return [
        shell({ kind: 'view', view: 'factory' }),
        { kind: 'open', screen: 'factory', params: { card: String(opens.card) } },
      ];
    case 'sessions': {
      const [one, ...more] = opens.ids;

      if (one === undefined) return [];
      // all ended: the one the card is on goes on (#343), reopened, Chat on it; an older one is
      // picked from the list (Chat on it, whose ⏎ reopens it)
      if (opens.reopen !== undefined)
        return [reopenCommand(story, opens.reopen), ...chatOn(opens.reopen)];
      if (more.length === 0) return chatOn(one);

      return [
        pickOf(
          `linked:sessions:${story}`,
          `Sessions · #${story}`,
          opens.ids.map((id) => ({ id, text: id, commands: chatOn(id) })),
        ),
      ];
    }
    case 'pipeline':
      return [
        { kind: 'open', screen: 'pipelines', params: { run: opens.id }, slot: 'pane' },
        show('pipelines'),
      ];
    case 'box':
      return [
        {
          kind: 'open',
          screen: 'boxes',
          params: {
            box: opens.name,
            ...(opens.card === undefined ? {} : { card: String(opens.card) }),
          },
          slot: 'pane',
        },
        show('boxes'),
      ];
    case 'sheets': {
      const [one, ...more] = opens.refs;

      if (one === undefined) return [];
      if (more.length === 0) return sheetOn(story, one);

      return [
        pickOf(
          `linked:sheets:${story}`,
          `Sheets · #${story}`,
          opens.refs.map((ref) => ({ id: ref, text: ref, commands: sheetOn(story, ref) })),
        ),
      ];
    }
  }
};

/** ⏎ (or a click) on a row: what it opens, the popup gone; a dim row only says its words. */
const enter = (l: LinkedLayer, row: LinkedRow | undefined): LinkedStep => {
  if (row === undefined) return kept(l);
  if (row.opens === null)
    return {
      layer: { ...l, selected: row.key },
      commands: [shell({ kind: 'status', text: `${row.label} · ${row.words}` })],
      runs: 0,
    };

  return { layer: undefined, commands: opensOf(l.story, row.opens), runs: 0 };
};

const ROW = 'linked:row:';

/** An input while the popup is the top layer (`n`: the next run's number). */
export const onLinked = (l: LinkedLayer, input: Input, n: number): LinkedStep => {
  switch (input.kind) {
    case 'tick':
      return kept({ ...l, now: input.at });
    case 'event':
      return onEvent(l, input.event, n);
    case 'text':
      return kept(filtered(l, l.filter + input.text.replaceAll('\n', ' ')));
    case 'click':
      if (input.id.startsWith(ROW)) {
        const key = input.id.slice(ROW.length);

        return enter(
          l,
          l.data.rows.find((r) => r.key === key),
        );
      }

      return kept(l);
    case 'key':
      break;
    default:
      return kept(l);
  }
  const key = input.key;
  // every menu's moves (`list-moves.ts`, #334)
  const m = menuMove(key, PAGE_ROWS);

  if (m !== undefined) return kept(moved(l, m));
  switch (key) {
    case '<Esc>':
      return kept(undefined);
    case '<CR>':
      return enter(l, cursorRow(l));
    // left and right: a list has neither, and they never type
    case 'k':
    case 'ä':
      return kept(l);
    case '<BS>':
      return kept(filtered(l, Array.from(l.filter).slice(0, -1).join('')));
    case '<C-u>':
    case '<D-BS>':
      return kept(filtered(l, ''));
    default: {
      const ch = typed(key);

      return ch === undefined ? kept(l) : kept(filtered(l, l.filter + ch));
    }
  }
};

/** An `abe watch` event while it is up: the Run row in place, the parts it changes read again. */
const onEvent = (l: LinkedLayer, e: Event, n: number): LinkedStep => {
  const next = linkedOnEvent(l.data, e);
  const events = l.events + 1;
  const drawn = { ...l.drawn };

  next.data.rows.forEach((r, i) => {
    if (r !== l.data.rows[i]) drawn[r.key] = events;
  });

  return read({ ...l, data: next.data, events, drawn }, next.reread, n);
};

/** Nothing landed yet: every row still `Reading…`. */
const unread = (d: StoryLinkedData): boolean => (d.reading ?? []).length === LINKED_KEYS.length;

/**
 * Why a part's answer drew nothing: refused, or (a stray run id) not Linked's, so its rows say why
 * once all are in, never `Reading…` on.
 */
const failureOf = (input: Answer | Refused, linked: boolean): string | undefined => {
  if (!input.reply.ok) return input.reply.error.message;

  return linked ? undefined : `not a Linked answer: ${input.command}`;
};

/**
 * A part's `abe story linked --part` answer: its rows in place (the cursor kept on its row), but
 * none an event moved or a newer answer drew since it was asked; or why not. Read once more if an
 * event asked meanwhile (`n`: Command mode's run count). Once no part is out, a row still
 * `Reading…` says why it is not (the whole popup, when none came in).
 */
export const linkedResult = (l: LinkedLayer, input: Answer | Refused, n: number): LinkedStep => {
  const part = LINKED_PARTS.find((p) => l.out[p]?.run === input.id);

  // a closed popup's, or another story's: no one's
  if (part === undefined) return kept(l);
  const asked = l.out[part]?.asked ?? 0;
  const again = l.out[part]?.again === true;
  const out: LinkedLayer['out'] = {};

  for (const p of LINKED_PARTS) {
    const was = l.out[p];

    if (p !== part && was !== undefined) out[p] = was;
  }
  const linked = input.reply.ok && input.command === 'story linked' ? input.reply.data : undefined;
  const failed = failureOf(input, linked !== undefined);
  const newer = new Set(LINKED_KEYS.filter((k) => (l.drawn[k] ?? 0) > asked));
  const drawn = { ...l.drawn };

  if (linked !== undefined)
    for (const k of LINKED_KEYS)
      if (!newer.has(k) && !(linked.reading ?? []).includes(k)) drawn[k] = asked;
  const done: LinkedLayer = {
    ...l,
    out,
    data: linked === undefined ? l.data : mergeLinked(l.data, linked, newer),
    drawn,
    ...(failed === undefined ? {} : { error: failed }),
  };
  const step = again ? read(done, [part], n) : kept(done);
  const after = step.layer ?? done;
  const settled =
    Object.keys(after.out).length === 0 && after.error !== undefined && !unread(after.data)
      ? { ...after, data: linkedSettled(after.data, after.error), error: undefined }
      : after;

  return { ...step, layer: settled };
};

const MARK_HUES: Readonly<Record<string, Hue>> = {
  '✓': 'good',
  '✗': 'bad',
  '◆': 'needs-you',
  '●': 'warn',
  '○': 'dim',
};

/** The states of more than one word a mark colours whole (`lookOf`'s words). */
const PHRASES: readonly (readonly string[])[] = [
  ['Needs', 'you'],
  ['Ready', 'for', 'review'],
  ['On', 'test'],
];

/**
 * A state's words as spans: its first mark and the state after it (a word, or a phrase: `◆ Needs
 * you`) in the mark's hue (`ci ✓ passed on …`), the rest plain; `hue` in place of the mark's (the
 * Run row's, the header's).
 */
export const spansOf = (text: string, hue?: Hue): Span[] => {
  const words = text.split(' ');
  const at = words.findIndex((w) => MARK_HUES[w] !== undefined);
  const mark = words[at];

  if (at < 0 || mark === undefined) return [{ text }];
  const rest = words.slice(at + 1);
  const phrase = PHRASES.find((p) => p.every((w, i) => rest[i] === w));
  const next = rest[0];
  const takes = phrase?.length ?? (next !== undefined && /^\p{L}/u.test(next) ? 1 : 0);
  const end = at + 1 + takes;
  const before = words.slice(0, at).join(' ');
  const after = words.slice(end).join(' ');

  return [
    ...(before === '' ? [] : [{ text: `${before} ` }]),
    { text: words.slice(at, end).join(' '), hue: hue ?? MARK_HUES[mark] ?? 'dim' },
    ...(after === '' ? [] : [{ text: ` ${after}` }]),
  ];
};

/** A row's words with its time as of `now` (core's `linkedRowText`): `Build ● Running · 21 min`. */
const rowText = (r: LinkedRow, now: string): string =>
  r.time === null
    ? r.words
    : `${r.words} · ${timeIn(r.time.since, now)}${r.time.ago ? ' ago' : ''}`;

const rowView = (r: LinkedRow, now: string): LinkedRowView => {
  const text = rowText(r, now);

  return {
    id: `${ROW}${r.key}`,
    label: r.label,
    value: r.dim ? [{ text }] : spansOf(text),
    ...(r.dim ? { dim: true } : {}),
  };
};

/** The popup as drawn. */
export const viewLinked = (l: LinkedLayer): LinkedLayerNode => {
  const d = l.data;
  const title = d.title === '' ? `#${l.story}` : `#${l.story} ${d.title}`;
  const at = cursorRow(l);
  const base = {
    story: title,
    keys: JUMP_KEYS.linked,
    filter: l.filter,
    hint: LINKED_HINT,
  };

  // every part failed whole and none came in (serve not answering): why, in place of the rows
  if (l.error !== undefined && Object.keys(l.out).length === 0 && unread(d))
    return {
      kind: 'LinkedLayer',
      id: 'linked',
      props: { ...base, rows: [], state: 'error', message: l.error },
    };

  return {
    kind: 'LinkedLayer',
    id: 'linked',
    props: {
      ...base,
      rows: shownRows(l).map((r) => rowView(r, l.now ?? d.at)),
      ...(at === undefined ? {} : { selected: `${ROW}${at.key}` }),
    },
  };
};
