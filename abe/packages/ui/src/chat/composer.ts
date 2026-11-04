/**
 * Chat's composer (2.1 #115, slice t115b; boards R-Composer, C-Context, R-Anatomy, R-Working):
 * the one field you talk to the agent with, at the bottom of the Chat column.
 *
 * - **Composer**: the field (13 px, at least 2 rows, growing to 8, then the last rows shown), the
 *   placeholder `Ask or tell the agent…`, the caret where it is (`field.ts`), and under it the dim
 *   model line `opus · medium` (a click picks another). Its children: the ContextChip row first,
 *   the SlashMenu over it while one is open.
 * - **ContextChip**: what goes with the message without asking (implicit context): the Editor's
 *   selection `@api/src/cart.ts#L12-18 · selected`, else its caret line `@api/src/cart.ts:16 ·
 *   caret line`, on the Factory view the selected card `#2 … · selected card`; `⌫ drop` at its
 *   right. Dropped for one message: `context dropped · ⌫ again brings it back`.
 * - **SlashMenu**: `/` as the first character: VimStorm's commands over the field (`/override`,
 *   `/compact`, `/clear`, `/model`), then the skills the session's Claude Code loads (`session
 *   skills`, read once per session as the menu first opens: `/abe:triage  Abe’s · …`), filtered
 *   as you type, at most `MENU_ROWS` shown around the selected one; the model pick in the same
 *   look. A `/` after a space or a line mid-message (`please run /abe:sp`) opens the skills
 *   alone, filtered by its word up to the caret; a pick puts the skill in that word's place.
 * - Held messages above the chip row are t113c's QueuedMessage rows, `×` taking one back: only
 *   while the session cannot take one (starting, a dialog, a question card; #197), since a message
 *   sent mid-turn goes into Claude Code's own queue at once.
 *
 * Types and schemas live here; `components.ts` adds them to the closed set; Rust draws them
 * (`app/src/factory/composer.rs`). The model below is pure: a draft per session (switching
 * workspace or card and back keeps it), the caret's context, the queue and the model as `serve`
 * says (`session show`, `session.queued`, `session.model`), the menu and the pick; the keys and the
 * commands they run (`session send [--context]`, `session unqueue`, `session model`, `settings
 * get allowedModels`). Text comes as keys (a typed character) and as `text` (⌘V, a dead key's or
 * an IME's composed text) at the caret, which moves and deletes as a macOS field's (`field.ts`).
 */
import {
  type Effort,
  type Event,
  type QueuedRow,
  type SessionData,
  type SessionSkill,
} from '@abe/core';
import { modelName } from '@abe/core/model-name';
import { z } from 'zod';
import type { Node } from '../runtime/components';
import type { QueuedMessage } from './chat-components';
import type { Caret } from '../runtime/protocol';
import {
  type Field,
  caretOf,
  caretProp,
  fieldInsert,
  fieldKey,
  fieldOf,
  typedChar,
} from '../runtime/field';
import { type Answer, type Command, type Input, type Refused } from '../runtime/runtime';
import { endedWhen } from '../live/box-feed';

// ── Components ────────────────────────────────────────────────────────────────

/** The field's rows: it starts at `min`, grows with its text to `max`, then shows its last rows. */
export const COMPOSER_ROWS = { min: 2, max: 8 } as const;
export const COMPOSER_PLACEHOLDER = 'Ask or tell the agent…';

/** The field, its model line; children: the ContextChip, then a SlashMenu while one is open. */
export type Composer = {
  kind: 'Composer';
  id?: string | undefined;
  props: {
    /** What is typed (lines by `\n`). */
    text: string;
    /** Its caret in characters (`field.ts`, #314); absent: at its end. */
    caret?: number | undefined;
    /** Drawn dim while the text is empty. */
    placeholder?: string | undefined;
    /** The field has the keyboard: the focus border and the caret. */
    focused?: boolean | undefined;
    /** `opus · medium` at the right under the field; a click on `id` picks another. */
    model?: { label: string; note?: string | undefined; id?: string | undefined } | undefined;
    /** No field: this dim line in its place (`Session stopped · ⏎ Retry`). */
    line?: string | undefined;
    /**
     * The app's own field types the text (a native text area) and tells it as `draft` inputs, each
     * with its number; `seq` is the last number taken here. Text sent with an older `seq` than the
     * app's own is stale (the app has typed on since); with the same, it is the screen's (a send
     * emptied it, another session's draft, a refused send given back).
     */
    seq?: number | undefined;
    /** The model pick is open over it: every key goes to the pick, none types in the field. */
    picking?: boolean | undefined;
  };
  children?: Node[] | undefined;
};

/** A file that goes with the next message (a pasted image, a dropped file): `×` drops it. */
export type AttachChip = {
  kind: 'AttachChip';
  id?: string | undefined;
  props: {
    /** Its file's name. */
    name: string;
    /** An image: a picture glyph, else a file one. */
    image?: boolean | undefined;
  };
};

/** One subagent in the status line's list: what it does, how long, its last tool. */
export type SubagentRow = {
  /** A click jumps to its Agent call in the transcript. */
  id: string;
  /** `abe:writer`, `Explore`. */
  name: string;
  /** The Agent call's description. */
  task?: string | undefined;
  state: 'running' | 'done';
  /** Started, in epoch ms: the app counts the time from it. */
  since: number;
  /** Ended, in epoch ms; absent while it runs. */
  until?: number | undefined;
  /** Its last tool call (`Bash bun test`), or its result's first line once done. */
  last?: string | undefined;
};

/**
 * The one line right above the field: what the agent does now (`Thinking`, `Reading cart.ts`,
 * `Waiting on you`, `Idle`) and for how long (the app counts it from `since`), the running
 * subagents' count at its right (a click or Tab unfolds their list above it).
 */
export type ChatStatus = {
  kind: 'ChatStatus';
  id?: string | undefined;
  props: {
    tone: 'working' | 'waiting' | 'idle' | 'starting';
    words: string;
    /** Since when, in epoch ms; absent: no time shown. */
    since?: number | undefined;
    /** `3 subagents`; a click on `id` folds the list. */
    agents?: { text: string; id: string; running: number; open: boolean } | undefined;
    /** The list while unfolded, the selected row tinted. */
    list?: SubagentRow[] | undefined;
    selected?: number | undefined;
  };
};

/** What goes with the next message, 12 px dim, `⌫ drop` at the right (a click on `id` drops it). */
export type ContextChip = {
  kind: 'ContextChip';
  id?: string | undefined;
  props: {
    text: string;
    /** The hint at the right: `⌫ drop`; none once dropped. */
    drop?: string | undefined;
    /** Dropped for this message: the row says so, dimmer. */
    dropped?: boolean | undefined;
  };
};

/** One row of a SlashMenu: the command (mono), what it does (dim); a grey row says why not. */
export type SlashRow = {
  id: string;
  cmd: string;
  desc: string;
  /** Grey, never run: why (`Improve mode comes with #117`). */
  reason?: string | undefined;
};

/** `/`'s menu over the field (and the model pick in its look): rows, the selected one tinted. */
export type SlashMenu = {
  kind: 'SlashMenu';
  id?: string | undefined;
  props: { items: SlashRow[]; selected?: number | undefined };
};

export type ComposerNode = Composer | ContextChip | SlashMenu | AttachChip | ChatStatus;

export const COMPOSER_KINDS = [
  'Composer',
  'ContextChip',
  'SlashMenu',
  'AttachChip',
  'ChatStatus',
] as const;

/** The schemas, built on the set's own primitives (`components.ts` calls this). */
export const composerSchemas = (d: { nodeId: z.ZodString; node: () => z.ZodType<Node> }) => {
  const id = d.nodeId.optional();

  return [
    z.strictObject({
      kind: z.literal('Composer'),
      id,
      props: z.strictObject({
        text: z.string(),
        caret: z.number().int().min(0).optional(),
        placeholder: z.string().optional(),
        focused: z.boolean().optional(),
        model: z
          .strictObject({
            label: z.string().min(1),
            note: z.string().optional(),
            id: d.nodeId.optional(),
          })
          .optional(),
        line: z.string().optional(),
        seq: z.number().int().nonnegative().optional(),
        picking: z.boolean().optional(),
      }),
      get children() {
        return z.array(d.node()).optional();
      },
    }),
    z.strictObject({
      kind: z.literal('ContextChip'),
      id,
      props: z.strictObject({
        text: z.string().min(1),
        drop: z.string().optional(),
        dropped: z.boolean().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('SlashMenu'),
      id,
      props: z.strictObject({
        items: z.array(
          z.strictObject({
            id: d.nodeId,
            cmd: z.string().min(1),
            desc: z.string(),
            reason: z.string().optional(),
          }),
        ),
        selected: z.number().int().nonnegative().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal('AttachChip'),
      id,
      props: z.strictObject({ name: z.string().min(1), image: z.boolean().optional() }),
    }),
    z.strictObject({
      kind: z.literal('ChatStatus'),
      id,
      props: z.strictObject({
        tone: z.enum(['working', 'waiting', 'idle', 'starting']),
        words: z.string().min(1),
        since: z.number().nonnegative().optional(),
        agents: z
          .strictObject({
            text: z.string().min(1),
            id: d.nodeId,
            running: z.number().int().nonnegative(),
            open: z.boolean(),
          })
          .optional(),
        list: z
          .array(
            z.strictObject({
              id: d.nodeId,
              name: z.string().min(1),
              task: z.string().optional(),
              state: z.enum(['running', 'done']),
              since: z.number().nonnegative(),
              until: z.number().nonnegative().optional(),
              last: z.string().optional(),
            }),
          )
          .optional(),
        selected: z.number().int().nonnegative().optional(),
      }),
    }),
  ] as const;
};

// ── The model ─────────────────────────────────────────────────────────────────

/** One session's field: its text, the chip dropped for this message, the menu shut with Esc. */
export type Draft = {
  text: string;
  /** The caret in `text` (`field.ts`, #314); absent: at its end. */
  caret?: number | undefined;
  dropped: boolean;
  /** Esc closed the `/` menu: it stays shut while the text still starts with `/`. */
  menuShut: boolean;
  /** Esc closed a mid-message `/word`'s menu: where that word starts, shut while the caret is in it. */
  shutAt?: number | undefined;
  /** The selected menu row, among the rows the filter leaves. */
  row: number;
  /** Files that go with it (absolute paths): pasted images, dropped files. */
  files?: readonly string[] | undefined;
};

/** A session's model and effort as `serve` said; `pending`: the effort waits for a resume. */
export type ModelLine = { model: string | null; effort: Effort | null; pending: boolean };

/** The model pick: the models `allowedModels` allows (null while read), the filter, the row. */
export type ModelPick = {
  session: string;
  models: readonly string[] | null;
  filter: string;
  row: number;
};

export type ComposerState = {
  /** The field has the keys inside Chat (a printable key in the transcript gives them to it). */
  active: boolean;
  /** Per session. */
  drafts: Readonly<Record<string, Draft>>;
  /** The Editor's caret (the app's `caret`); null: no file open. */
  caret: Caret | null;
  /** Per session, as `serve` keeps them. */
  queues: Readonly<Record<string, readonly QueuedRow[]>>;
  models: Readonly<Record<string, ModelLine>>;
  /** `allowedModels`, once read. */
  allowed: readonly string[] | null;
  pick?: ModelPick | undefined;
  /** Sent, not answered yet, by run id: given back to the field when `serve` refuses it. */
  sending: Readonly<Record<string, { session: string; text: string }>>;
  /** Sends so far: each send's run id is its own (`composer:send:<n>`). */
  sends: number;
  /** The app's field's last `draft` number taken (`Composer.seq`). */
  synced: number;
  /** Per session, the skills its Claude Code loads (`session skills`); null while first read. */
  skills: Readonly<Record<string, readonly SessionSkill[] | null>>;
};

export const NO_COMPOSER: ComposerState = {
  active: false,
  drafts: {},
  caret: null,
  queues: {},
  models: {},
  allowed: null,
  sending: {},
  sends: 0,
  synced: 0,
  skills: {},
};

/** What the composer is for: the session, whose it is, the Factory view's card, the keyboard. */
export type ComposerFacts = {
  session: string;
  /** A teammate's session: no field. */
  whose?: string | undefined;
  /** Ended: `Session ended` in its place (`Session stopped` once you stopped it). */
  ended?: boolean | undefined;
  /** You stopped it (#205): its word is Stopped, as its card's (#258). */
  stopped?: boolean | undefined;
  /**
   * What ⏎ does on it, the ended line naming it (#343): Reopen the same session and conversation;
   * the field stays live, and ⏎ on what you typed reopens it with that as its first prompt. None:
   * nothing works from here, nothing offered.
   */
  step?: 'reopen' | undefined;
  /** When it ended (its state's `since`): the foot's `Session ended 14:02` (#343). */
  endedAt?: string | undefined;
  /** The screen's clock: `endedAt` dated when it is another day. */
  now?: string | undefined;
  /** Why it ended, when that is no failure of its own (#316: its box stopped under it). */
  why?: string | undefined;
  /** The Factory view's selected card: the context there, in place of the caret. */
  card?: { id: number; title: string } | undefined;
  /** The Chat slot has the keyboard (the screen's `focus`). */
  focused?: boolean | undefined;
  /** Who it goes to, in the empty field (`Ask Abe…`, `Message #12 …`); else `Ask or tell the agent…`. */
  placeholder?: string | undefined;
};

/** What a key, a click or text did; `override`: `/override <what>` asks the screen for its card. */
export type ComposerOut = {
  composer: ComposerState;
  commands: Command[];
  handled: boolean;
  override?: string | undefined;
};

const PREFIX = 'composer:';

/** Whether a `run`'s answer is the composer's own. */
export const isComposerResult = (id: string): boolean => id.startsWith(PREFIX);

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

const EMPTY: Draft = { text: '', dropped: false, menuShut: false, row: 0 };

const draftOf = (c: ComposerState, session: string): Draft => c.drafts[session] ?? EMPTY;

const withDraft = (c: ComposerState, session: string, d: Draft): ComposerState => ({
  ...c,
  drafts: { ...c.drafts, [session]: d },
});

const out = (composer: ComposerState, commands: Command[] = [], handled = true): ComposerOut => ({
  composer,
  commands,
  handled,
});

const balloon = (text: string): Command => ({
  kind: 'shell',
  effect: { kind: 'balloon', tone: 'error', text },
});

const refusal = (e: { message: string; code: string }): Command =>
  balloon(`${e.message} (${e.code})`);

const status = (text: string): Command => ({ kind: 'shell', effect: { kind: 'status', text } });

// ── Context ───────────────────────────────────────────────────────────────────

/** The context as `abe session send --context` takes it (core's `ImplicitContext`). */
export type SendContext =
  | { path: string; from: number; to: number }
  | { path: string; line: number }
  | { card: number; title: string }
  | { page: string }
  | { change: number; what: string };

/** What goes with a message now: the Factory view's card, else the caret's selection or line. */
export const contextOf = (c: ComposerState, f: ComposerFacts): SendContext | null => {
  if (f.card !== undefined) return { card: f.card.id, title: f.card.title };
  const at = c.caret;

  if (at === null) return null;
  if (at.selection !== undefined) {
    const from = Math.min(at.selection.from, at.selection.to);
    const to = Math.max(at.selection.from, at.selection.to);

    return { path: at.file, from, to };
  }

  return { path: at.file, line: at.line };
};

/** The chip's words: `@api/src/cart.ts#L12-18 · selected`, `@…:16 · caret line`, `#2 … · selected card`. */
export const chipText = (ctx: SendContext): string => {
  if ('card' in ctx) return `#${ctx.card} ${ctx.title} · selected card`;
  if ('page' in ctx) return `@${ctx.page} · page`;
  if ('change' in ctx) return `change ${ctx.change} · selected`;
  if ('line' in ctx) return `@${ctx.path}:${ctx.line} · caret line`;

  return `@${ctx.path}#L${ctx.from}${ctx.to === ctx.from ? '' : `-${ctx.to}`} · selected`;
};

export const DROPPED_TEXT = 'context dropped · ⌫ again brings it back';

/** The Editor's caret moved (the app's `caret`); null: no file open, no chip. */
export const composerCaret = (c: ComposerState, caret: Caret | null): ComposerState => ({
  ...c,
  caret,
});

// ── Serve's facts ─────────────────────────────────────────────────────────────

/** A session read (`session show`, `session list`): its queue and its model. */
export const composerSession = (c: ComposerState, s: SessionData): ComposerState => ({
  ...c,
  queues: { ...c.queues, [s.id]: s.queue },
  models: { ...c.models, [s.id]: { model: s.model, effort: s.effort, pending: false } },
});

/** `session.queued` and `session.model` change a session's rows and line in place. */
export const composerEvent = (c: ComposerState, event: Event): ComposerState => {
  if (event.type === 'session.queued')
    return { ...c, queues: { ...c.queues, [event.data.session]: event.data.queue } };
  if (event.type === 'session.model') {
    const { session, model, effort, effortPending } = event.data;

    return { ...c, models: { ...c.models, [session]: { model, effort, pending: effortPending } } };
  }

  return c;
};

// ── The `/` menu ──────────────────────────────────────────────────────────────

/** A row: one of VimStorm's commands, or a skill (`skill`: ⏎ / Tab complete it, never run it). */
type SlashCommand = { cmd: string; desc: string; reason?: string; skill?: true };

/** The most rows the menu shows at once; the selected one always among them. */
export const MENU_ROWS = 10;

const SLASH: readonly SlashCommand[] = [
  { cmd: '/override', desc: 'lower a limit for this session' },
  { cmd: '/compact', desc: 'shorten the conversation, keep the gist' },
  { cmd: '/clear', desc: 'start a fresh conversation' },
  { cmd: '/model', desc: '' },
];

/** The model line's words: `opus · medium`, `opus` with no effort; `model` before a read. */
const modelWords = (m: ModelLine | undefined): string => {
  if (m?.model === null || m?.model === undefined) return 'model';

  const model = modelName(m.model);

  return m.effort === null ? model : `${model} · ${m.effort}`;
};

/**
 * How well `word` finds a skill (`/abe:triage`): its name starts with it (`abe:t`), else the part
 * after its plugin does (`tri`), else it is in the name (`age`); -1: not at all.
 */
export const skillMatch = (name: string, word: string): number => {
  const typed = name.slice(1).toLowerCase();
  const bare = typed.slice(typed.indexOf(':') + 1);

  if (typed.startsWith(word)) return 0;
  if (bare.startsWith(word)) return 1;

  return typed.includes(word) ? 2 : -1;
};

/** A description's room in a row: the app cuts it to the row's width. */
const DESC_MAX = 160;

/** The skills `word` finds, best first (`skillMatch`), each in its place among those as good. */
/** Whose a skill is, as the menu says it. */
const SKILL_OWNER: Record<SessionSkill['whose'], string> = {
  abe: 'Abe’s',
  repo: 'Repo’s',
  yours: 'Yours',
};

const skillRows = (skills: readonly SessionSkill[], word: string): SlashCommand[] =>
  skills
    .map((s, i) => ({ s, i, rank: skillMatch(s.name, word) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ s }) => ({
      cmd: s.name,
      desc: `${SKILL_OWNER[s.whose]} · ${s.description}`.slice(0, DESC_MAX),
      skill: true as const,
    }));

/** The whole text a `/word` with no space after it: the at-start menu's. */
const atStart = (text: string): boolean => text.startsWith('/') && !/\s/.test(text);

/** A mid-message `/word` at the caret: where it starts and ends (characters), its word typed so far. */
type SlashWord = { start: number; end: number; word: string };

/**
 * The `/word` the caret is in mid-message: its `/` after a space or a line (never inside a word:
 * `src/app`, `and/or`), the caret after the `/`; at the text's start the at-start menu's instead.
 */
const slashWordAt = (text: string, caret?: number): SlashWord | undefined => {
  const cs = Array.from(text);
  const at = fieldOf(text, caret).caret;
  let start = at;

  while (start > 0 && !/\s/.test(cs[start - 1] ?? '')) start -= 1;
  if (start === 0 || start === at || cs[start] !== '/') return undefined;
  let end = at;

  while (end < cs.length && !/\s/.test(cs[end] ?? '')) end += 1;

  return {
    start,
    end,
    word: cs
      .slice(start + 1, at)
      .join('')
      .toLowerCase(),
  };
};

const midWord = (d: Draft): SlashWord | undefined =>
  atStart(d.text) ? undefined : slashWordAt(d.text, d.caret);

/** A draft whose mid-message menu was shut, the caret gone from that word: shut no more. */
const settled = (d: Draft): Draft =>
  d.shutAt !== undefined && midWord(d)?.start !== d.shutAt ? { ...d, shutAt: undefined } : d;

/**
 * The menu's rows for what is typed: at the start, the commands its word starts, then the
 * session's skills it finds (none once a space is typed); mid-message the skills its `/word` finds.
 */
const slashRows = (c: ComposerState, f: ComposerFacts, d: Draft): SlashCommand[] => {
  if (!atStart(d.text)) {
    const mid = midWord(d);

    return mid === undefined || mid.start === d.shutAt
      ? []
      : skillRows(c.skills[f.session] ?? [], mid.word);
  }
  if (d.menuShut) return [];
  const word = d.text.slice(1).toLowerCase();
  const line = modelWords(c.models[f.session]);

  return [
    ...SLASH.filter((s) => s.cmd.slice(1).startsWith(word)).map((s) => ({
      ...s,
      // /model says the model now
      desc: s.cmd === '/model' ? line : s.desc,
    })),
    ...skillRows(c.skills[f.session] ?? [], word),
  ];
};

const menuOpen = (c: ComposerState, f: ComposerFacts): boolean =>
  slashRows(c, f, draftOf(c, f.session)).length > 0;

/** The skill in the `/word`'s place, a space after it (one already there kept), the caret past it. */
const skillPut = (d: Draft, w: SlashWord, cmd: string): Draft => {
  const cs = Array.from(d.text);
  const after = cs.slice(w.end).join('');
  const put = `${cmd}${after.startsWith(' ') ? '' : ' '}`;
  const text = `${cs.slice(0, w.start).join('')}${put}${after}`;
  const caret = w.start + Array.from(cmd).length + 1;

  return settled({ ...withText(d, text), caret: caretProp(fieldOf(text, caret)) });
};

// ── Sending ───────────────────────────────────────────────────────────────────

/** The field emptied after a send or a command: the chip back, the menu as new. */
const cleared = (c: ComposerState, f: ComposerFacts): ComposerState =>
  withDraft(c, f.session, EMPTY);

/** `text` sent (with its context): the field emptied, the text kept by the run's own id. */
const sent = (
  c: ComposerState,
  f: ComposerFacts,
  text: string,
  ctx: SendContext | null,
): ComposerOut => {
  const id = `${PREFIX}send:${c.sends + 1}`;

  return out(
    {
      ...cleared(c, f),
      sends: c.sends + 1,
      sending: { ...c.sending, [id]: { session: f.session, text } },
    },
    [
      {
        kind: 'run',
        id,
        argv: [
          'session',
          'send',
          f.session,
          text,
          ...(ctx === null ? [] : ['--context', JSON.stringify(ctx)]),
        ],
      },
    ],
  );
};

const CLEAR_CONFIRM = (session: string): Command => ({
  kind: 'confirm',
  argv: ['session', 'send', session, '/clear'],
  question: 'Start a fresh conversation?',
  details: ["Claude Code's /clear drops this conversation's context; the worktree stays."],
  yes: 'Clear',
  done: 'Started a fresh conversation',
});

/** A `/word` (or `/word …`) run: VimStorm's own, else sent to Claude Code as typed, no context. */
const runSlash = (c: ComposerState, f: ComposerFacts, text: string): ComposerOut => {
  const [word = '', ...rest] = text.trim().split(/\s+/);
  const args = rest.join(' ');

  switch (word) {
    case '/override':
      if (args === '') return out(withDraft(c, f.session, { ...EMPTY, text: '/override ' }));

      return { ...out(cleared(c, f)), override: args };
    case '/model':
      if (args === '') return openPick(cleared(c, f), f);

      return pickModel(cleared(c, f), f, rest[0] ?? '', parseEffort(rest[1]));
    case '/clear':
      return out(cleared(c, f), [CLEAR_CONFIRM(f.session)]);
    default:
      return sent(c, f, text.trim(), null);
  }
};

/** A `:` row of Chat's slash commands (#346): handed back as `slash:/model` and run as typed. */
export const SLASH_ROW = 'slash:';

/** The slash commands `:` lists on Chat's session (`/override` only on a card's). */
export const slashRowsOf = (
  c: ComposerState,
  f: ComposerFacts,
  card: boolean,
): { id: string; text: string; dim: string }[] =>
  f.ended === true || f.whose !== undefined
    ? []
    : ['/model', '/compact', ...(card ? ['/override'] : [])].flatMap((cmd) => {
        const x = SLASH.find((y) => y.cmd === cmd);

        return x === undefined
          ? []
          : [
              {
                id: `${SLASH_ROW}${cmd}`,
                text: cmd,
                dim: cmd === '/model' ? modelWords(c.models[f.session]) : x.desc,
              },
            ];
      });

/**
 * A slash row chosen in `:`: as if typed and ⏎ in the field, the keys then in Chat (`/model`'s
 * pick, `/override`'s field waiting for what it lowers).
 */
const slashChosen = (c: ComposerState, f: ComposerFacts, cmd: string): ComposerOut => {
  const done = runSlash(c, f, cmd);
  const focus: Command = { kind: 'shell', effect: { kind: 'focus', slot: 'chat' } };

  return cmd === '/compact'
    ? done
    : {
        ...done,
        composer: composerFocus(done.composer, true),
        commands: [...done.commands, focus],
      };
};

const parseEffort = (word: string | undefined): Effort | null =>
  EFFORTS.find((e) => e === word) ?? null;

/** An ended session ⏎ reopens (#343): its field stays live. */
const reopens = (f: ComposerFacts): boolean => f.ended === true && f.step === 'reopen';

/**
 * ⏎ in an ended session's field (#343): what you typed is its first prompt as it reopens (`abe
 * session reopen --message`), kept as a send is, so a refusal puts it back; empty, the screen's ⏎
 * (Reopen with none).
 */
const reopenSend = (c: ComposerState, f: ComposerFacts, text: string): ComposerOut => {
  // once: while its reopen with a message is asked, ⏎ again asks nothing more
  if (Object.values(c.sending).some((x) => x.session === f.session)) return out(c);
  if (text.trim() === '') return out(c, [], false);
  const id = `${PREFIX}send:${c.sends + 1}`;

  return out(
    {
      ...cleared(c, f),
      sends: c.sends + 1,
      sending: { ...c.sending, [id]: { session: f.session, text } },
    },
    [{ kind: 'run', id, argv: ['session', 'reopen', f.session, '--message', text] }],
  );
};

/** Shell input (`!git status`) runs as typed: a context after it would run as a command too. */
const shellInput = (d: Draft): boolean => d.text.startsWith('!');

/** A file as Claude Code takes it in a prompt: `@path` (quoted when it has a space). */
export const fileRef = (path: string): string => (/\s/.test(path) ? `@"${path}"` : `@${path}`);

/** The message with its files after it, each as `@path` (Claude Code reads an image as one). */
export const withFiles = (text: string, files: readonly string[]): string => {
  if (files.length === 0) return text;
  const refs = files.map(fileRef).join(' ');

  return text.trim() === '' ? refs : `${text.trimEnd()}\n\n${refs}`;
};

/** ⏎ in the field: the message with its context, a `/word` its own way; empty sends nothing. */
const send = (c: ComposerState, f: ComposerFacts): ComposerOut => {
  const d = draftOf(c, f.session);
  const text = d.text.trim();
  const files = d.files ?? [];

  if (reopens(f)) return reopenSend(c, f, withFiles(d.text, files));
  if (text === '' && files.length === 0) return out(c);
  if (text.startsWith('/') && files.length === 0) return runSlash(c, f, d.text);
  const ctx = d.dropped || shellInput(d) ? null : contextOf(c, f);

  return sent(c, f, withFiles(d.text, files), ctx);
};

// ── The model pick ────────────────────────────────────────────────────────────

const MODELS_ID = `${PREFIX}models`;

type PickRow = { model: string; effort: Effort };

const pickRows = (p: ModelPick): PickRow[] =>
  (p.models ?? [])
    .flatMap((model) => EFFORTS.map((effort) => ({ model, effort })))
    .filter((r) => `${r.model} ${r.effort}`.toLowerCase().includes(p.filter.toLowerCase()));

/** Whether the line is on the row: a full id on its family's row (`claude-haiku-5-5`, `haiku`). */
const isModel = (m: ModelLine | undefined, r: PickRow): boolean =>
  m?.model !== null &&
  m?.model !== undefined &&
  modelName(m.model) === modelName(r.model) &&
  m.effort === r.effort;

/** The current model's row, else the first. */
const currentRow = (c: ComposerState, p: ModelPick): number => {
  const m = c.models[p.session];
  const at = pickRows(p).findIndex((r) => isModel(m, r));

  return Math.max(0, at);
};

const openPick = (c: ComposerState, f: ComposerFacts): ComposerOut => {
  const pick: ModelPick = { session: f.session, models: c.allowed, filter: '', row: 0 };
  const next = { ...c, pick: { ...pick, row: currentRow(c, pick) } };

  return c.allowed === null
    ? out(next, [{ kind: 'run', id: MODELS_ID, argv: ['settings', 'get', 'allowedModels'] }])
    : out(next);
};

const pickModel = (
  c: ComposerState,
  f: ComposerFacts,
  model: string,
  effort: Effort | null,
): ComposerOut => {
  if (model === '') return out(c);
  const was = c.models[f.session];
  const line: ModelLine = { model, effort: effort ?? was?.effort ?? null, pending: false };

  return out({ ...c, pick: undefined, models: { ...c.models, [f.session]: line } }, [
    {
      kind: 'run',
      id: `${PREFIX}model:${f.session}`,
      argv: [
        'session',
        'model',
        f.session,
        '--model',
        model,
        ...(line.effort === null ? [] : ['--effort', line.effort]),
      ],
    },
  ]);
};

/** A menu's moves (the pick's, the `/` menu's): ↑ ↓ and ⌃P ⌃N; every letter types. */
const UP = new Set(['<Up>', '<C-p>']);
const DOWN = new Set(['<Down>', '<C-n>']);
/** ← → move sideways: nothing to move to in a list. */
const SIDE = new Set(['<Left>', '<Right>']);

const pickKey = (c: ComposerState, p: ModelPick, key: string, f: ComposerFacts): ComposerOut => {
  const rows = pickRows(p);

  if (key === '<Esc>') return out({ ...c, pick: undefined });
  if (UP.has(key) || DOWN.has(key)) {
    const row = Math.min(Math.max(0, rows.length - 1), Math.max(0, p.row + (UP.has(key) ? -1 : 1)));

    return out({ ...c, pick: { ...p, row } });
  }
  if (SIDE.has(key)) return out(c);
  if (key === '<CR>') {
    const r = rows[p.row];

    return r === undefined ? out(c) : pickModel(c, f, r.model, r.effort);
  }
  if (key === '<BS>') {
    const filter = Array.from(p.filter).slice(0, -1).join('');

    return out({ ...c, pick: { ...p, filter, row: 0 } });
  }
  const ch = typedChar(key);

  return ch === undefined ? out(c) : out({ ...c, pick: { ...p, filter: p.filter + ch, row: 0 } });
};

// ── Keys ──────────────────────────────────────────────────────────────────────

/** The text grown by `more`; the menu shut stays shut only while the text starts with `/`. */
const typed = (d: Draft, more: string): Draft =>
  withField(d, fieldInsert(fieldOf(d.text, d.caret), more));

/** The draft with this text: the menu shut stays shut only while the text still starts with `/`. */
const withText = (d: Draft, text: string): Draft => ({
  ...d,
  text,
  caret: undefined,
  row: 0,
  menuShut: d.menuShut && text.startsWith('/'),
});

/** The draft after a field key (`field.ts`): a caret moved keeps the menu's row. */
const withField = (d: Draft, f: Field): Draft =>
  settled(
    f.text === d.text
      ? { ...d, caret: caretProp(f) }
      : { ...withText(d, f.text), caret: caretProp(f) },
  );

/** ← → in the `/` menu are its text's caret (#314); every letter types. */
const menuKey = (c: ComposerState, f: ComposerFacts, key: string): ComposerOut | undefined => {
  const d = draftOf(c, f.session);
  const rows = slashRows(c, f, d);

  if (rows.length === 0) return undefined;
  const mid = midWord(d);

  if (key === '<Esc>')
    return out(
      withDraft(
        c,
        f.session,
        mid === undefined ? { ...d, menuShut: true } : { ...d, shutAt: mid.start },
      ),
    );
  if (UP.has(key) || DOWN.has(key)) {
    const row = Math.min(rows.length - 1, Math.max(0, d.row + (UP.has(key) ? -1 : 1)));

    return out(withDraft(c, f.session, { ...d, row }));
  }
  if (key === '<CR>' || key === '<Tab>') {
    const r = rows[Math.min(d.row, rows.length - 1)];

    if (r === undefined) return out(c);
    if (r.reason !== undefined) return out(c, [status(r.reason)]);
    // mid-message: the skill in its `/word`'s place, the text around it kept
    if (mid !== undefined) return out(withDraft(c, f.session, skillPut(d, mid, r.cmd)));
    // a skill goes in the field as typed, its arguments after it; ⏎ then sends it as text
    if (r.skill === true) return out(withDraft(c, f.session, withText(d, `${r.cmd} `)));

    return runSlash(c, f, r.cmd);
  }

  return undefined;
};

/**
 * A key while Chat has the keyboard. The field active: it types, sends, opens the menu; not
 * active: a printable key makes it active and types, anything else is the screen's (`handled`
 * false). The model pick and the `/` menu take their keys first.
 */
export const composerKey = (c: ComposerState, key: string, f: ComposerFacts): ComposerOut => {
  // no field to type in: whatever had the keys lets them go
  if (f.whose !== undefined || (f.ended === true && !reopens(f)))
    return out(composerFocus(c, false), [], false);
  if (c.pick?.session === f.session) return pickKey(c, c.pick, key, f);
  const d = draftOf(c, f.session);

  if (!c.active) {
    const ch = typedChar(key);

    return ch === undefined
      ? out(c, [], false)
      : out(withDraft({ ...c, active: true }, f.session, typed(d, ch)));
  }
  const inMenu = menuKey(c, f, key);

  if (inMenu !== undefined) return inMenu;
  switch (key) {
    case '<CR>':
      return send(c, f);
    case '<S-CR>':
      return out(withDraft(c, f.session, typed(d, '\n')));
    case '<BS>':
      if (d.text !== '') {
        const next = fieldKey(fieldOf(d.text, d.caret), key);

        return next === undefined ? out(c) : out(withDraft(c, f.session, withField(d, next)));
      }

      // no chip: nothing to drop
      return contextOf(c, f) === null
        ? out(c)
        : out(withDraft(c, f.session, { ...d, dropped: !d.dropped }));
    case '<Esc>':
      // A `/word` the menu was shut on: a second Esc clears it.
      if (d.menuShut && d.text.startsWith('/') && !/\s/.test(d.text))
        return out(withDraft(c, f.session, EMPTY));

      // Keys to the transcript (its Esc gives them back to the code); the draft stays.
      return out({ ...c, active: false });
  }
  // a macOS field's keys (`field.ts`): the caret, typing and deleting at it; ⌘← ⌘→ its line's ends
  const next = fieldKey(fieldOf(d.text, d.caret), key, { lines: true });

  return next === undefined ? out(c, [], false) : out(withDraft(c, f.session, withField(d, next)));
};

/** Text the keys do not carry (⌘V, a composed character): into the field, lines kept. */
export const composerText = (c: ComposerState, text: string, f: ComposerFacts): ComposerOut => {
  if (f.whose !== undefined || (f.ended === true && !reopens(f)) || text === '')
    return out(c, [], false);
  if (c.pick?.session === f.session) {
    const line = text.replace(/\s+/g, ' ');

    return out({ ...c, pick: { ...c.pick, filter: c.pick.filter + line, row: 0 } });
  }
  const d = draftOf(c, f.session);

  return out(withDraft({ ...c, active: true }, f.session, typed(d, text.replace(/\r\n?/g, '\n'))));
};

/** No field to type in: a teammate's session, or one ended that ⏎ does not reopen. */
const noField = (f: ComposerFacts): boolean =>
  f.whose !== undefined || (f.ended === true && !reopens(f));

/**
 * The app's own field's text (`draft`, numbered `seq`) and its caret (characters; absent: the
 * text's end, or where it was for the same text): the draft as typed there, the field keeping the
 * keys. A number older than one taken is a draft overtaken: nothing changes.
 */
export const composerDraft = (
  c: ComposerState,
  text: string,
  seq: number,
  f: ComposerFacts,
  caret?: number,
): ComposerOut => {
  if (noField(f)) return out(c, [], false);
  if (seq < c.synced) return out(c);
  const d = draftOf(c, f.session);
  const had = d.text === text ? d : withText(d, text.replace(/\r\n?/g, '\n'));
  const next = settled(
    caret === undefined ? had : { ...had, caret: caretProp(fieldOf(had.text, caret)) },
  );

  return out(withDraft({ ...c, active: true, synced: seq }, f.session, next));
};

/** Files pasted or dropped on the field (`attach`): with the next message, each once. */
export const composerAttach = (
  c: ComposerState,
  paths: readonly string[],
  f: ComposerFacts,
): ComposerOut => {
  if (noField(f) || paths.length === 0) return out(c, [], false);
  const d = draftOf(c, f.session);
  const had = d.files ?? [];
  const files = [...had, ...paths.filter((p, i) => !had.includes(p) && paths.indexOf(p) === i)];

  return out(withDraft({ ...c, active: true }, f.session, { ...d, files }));
};

/** Whether the field has the keys (the screen gives them to it, or takes them back). */
export const composerActive = (c: ComposerState): boolean => c.active;

/** Nothing typed in the session's field (no text, no file). */
export const composerEmpty = (c: ComposerState, session: string): boolean => {
  const d = draftOf(c, session);

  return d.text === '' && (d.files ?? []).length === 0;
};

/** The keys to the field as Chat shows its session; none without a field. */
export const composerShown = (c: ComposerState, f: ComposerFacts): ComposerState =>
  noField(f) ? c : composerFocus(c, true);

export const composerFocus = (c: ComposerState, active: boolean): ComposerState => ({
  ...c,
  active,
  pick: active ? c.pick : undefined,
});

/** A click on the composer's parts; undefined: not the composer's. */
export const composerClick = (
  c: ComposerState,
  id: string,
  f: ComposerFacts,
): ComposerOut | undefined => {
  if (!id.startsWith(PREFIX) || f.whose !== undefined) return undefined;
  // an ended session's field (#343): a click gives it the keys; nothing else of it is live
  if (f.ended === true)
    return reopens(f) && id === `${PREFIX}composer` ? out({ ...c, active: true }) : undefined;
  const d = draftOf(c, f.session);

  if (id === `${PREFIX}composer`) return out({ ...c, active: true });
  if (id === `${PREFIX}chip`)
    return out(withDraft({ ...c, active: true }, f.session, { ...d, dropped: !d.dropped }));
  if (id === `${PREFIX}model`) return openPick({ ...c, active: true }, f);
  const menu = /^composer:menu:(\d+)$/.exec(id);

  if (menu !== null) {
    const row = Number(menu[1]);

    return menuKey(withDraft(c, f.session, { ...d, row }), f, '<CR>') ?? out(c);
  }
  const pick = /^composer:pick:(\d+)$/.exec(id);

  if (pick !== null && c.pick !== undefined) {
    // the clicked row, not the one the keys had selected (#219)
    const at = { ...c.pick, row: Number(pick[1]) };

    return pickKey({ ...c, pick: at }, at, '<CR>', f);
  }
  const detach = /^composer:detach:(\d+)$/.exec(id);

  if (detach !== null) {
    const at = Number(detach[1]);

    return out(
      withDraft(c, f.session, { ...d, files: (d.files ?? []).filter((_, i) => i !== at) }),
    );
  }
  const unqueue = /^composer:unqueue:(\d+)$/.exec(id);

  if (unqueue !== null)
    return out(c, [
      {
        kind: 'run',
        id: `${PREFIX}unqueue:${f.session}`,
        argv: ['session', 'unqueue', f.session, unqueue[1] ?? ''],
      },
    ]);

  return undefined;
};

/** An answer of the composer's own commands. */
export const composerResult = (
  c: ComposerState,
  input: Answer | Refused,
): { composer: ComposerState; commands: Command[] } => {
  const same = (commands: Command[] = []) => ({ composer: c, commands });

  if (input.id === MODELS_ID) {
    if (!input.reply.ok)
      return {
        composer: { ...c, pick: undefined },
        commands: [refusal(input.reply.error)],
      };
    const value: unknown = input.command === 'settings get' ? input.reply.data.value : null;
    const models = z.array(z.string()).safeParse(value);
    const allowed = models.success ? models.data : [];
    const pick = c.pick === undefined ? undefined : { ...c.pick, models: allowed };

    return {
      composer: {
        ...c,
        allowed,
        pick: pick === undefined ? undefined : { ...pick, row: currentRow(c, pick) },
      },
      commands: [],
    };
  }
  if (input.id.startsWith(SKILLS_ID)) {
    const session = input.id.slice(SKILLS_ID.length);
    // refused (an older serve, a box asleep): the commands alone, not asked again
    const skills =
      input.command === 'session skills' && input.reply.ok ? input.reply.data.skills : [];

    return { composer: { ...c, skills: { ...c.skills, [session]: skills } }, commands: [] };
  }
  const was = c.sending[input.id];

  if (input.id.startsWith(`${PREFIX}send:`)) {
    const sending = Object.fromEntries(Object.entries(c.sending).filter(([k]) => k !== input.id));

    if (was === undefined) return { composer: { ...c, sending }, commands: [] };
    const { session, text } = was;

    if (input.reply.ok) {
      const n = input.command === 'session send' ? input.reply.data.queued : null;
      const queue = c.queues[session] ?? [];
      const queues =
        n === null || queue.some((q) => q.n === n)
          ? c.queues
          : { ...c.queues, [session]: [...queue, { n, text }] };

      return { composer: { ...c, sending, queues }, commands: [] };
    }
    // the refused text back at the field's top, what was typed since under it
    const d = draftOf(c, session);
    const back = withText(d, d.text === '' ? text : `${text}\n${d.text}`);

    return {
      composer: { ...withDraft(c, session, back), sending },
      commands: [refusal(input.reply.error)],
    };
  }
  const unqueue = /^composer:unqueue:(.+)$/.exec(input.id);

  if (unqueue !== null) {
    if (!input.reply.ok) return same([refusal(input.reply.error)]);
    if (input.command !== 'session unqueue') return same();

    return {
      composer: { ...c, queues: { ...c.queues, [unqueue[1] ?? '']: input.reply.data.queue } },
      commands: [],
    };
  }
  const model = /^composer:model:(.+)$/.exec(input.id);

  if (model !== null) {
    const session = model[1] ?? '';

    if (!input.reply.ok) {
      const models = Object.fromEntries(Object.entries(c.models).filter(([k]) => k !== session));

      return {
        composer: { ...c, models },
        commands: [
          refusal(input.reply.error),
          // the line as serve keeps it again
          { kind: 'run', id: `${PREFIX}show:${session}`, argv: ['session', 'show', session] },
        ],
      };
    }
    if (input.command !== 'session model') return same();
    const { effort, effortPending } = input.reply.data;

    return {
      composer: {
        ...c,
        models: {
          ...c.models,
          [session]: { model: input.reply.data.model, effort, pending: effortPending },
        },
      },
      commands: [],
    };
  }
  if (input.id.startsWith(`${PREFIX}show:`) && input.reply.ok && input.command === 'session show')
    return { composer: composerSession(c, input.reply.data), commands: [] };

  return { composer: c, commands: [] };
};

// ── View ──────────────────────────────────────────────────────────────────────

/** The model line under the field: `opus · medium`, a pending effort `high · next resume`. */
const modelProp = (m: ModelLine | undefined): Composer['props']['model'] =>
  m?.model === null || m?.model === undefined
    ? undefined
    : {
        label: m.pending ? modelName(m.model) : modelWords(m),
        ...(m.pending && m.effort !== null ? { note: `· ${m.effort} · next resume` } : {}),
        id: `${PREFIX}model`,
      };

const chipNode = (c: ComposerState, f: ComposerFacts, d: Draft): ContextChip | null => {
  const ctx = contextOf(c, f);

  if (ctx === null || shellInput(d)) return null;

  return d.dropped
    ? { kind: 'ContextChip', id: `${PREFIX}chip`, props: { text: DROPPED_TEXT, dropped: true } }
    : {
        kind: 'ContextChip',
        id: `${PREFIX}chip`,
        props: { text: chipText(ctx), drop: '⌫ drop' },
      };
};

/** The pick's rows; while read, or when none is allowed or matches, one grey row says so. */
const pickItems = (p: ModelPick, rows: PickRow[], m: ModelLine | undefined): SlashRow[] => {
  const none = (desc: string): SlashRow[] => [
    { id: `${PREFIX}pick:none`, cmd: 'model', desc, reason: desc },
  ];

  if (p.models === null) return none('reading allowedModels…');
  if (p.models.length === 0) return none('allowedModels allows none');
  if (rows.length === 0) return none(`no model matches “${p.filter}”`);

  return rows.map((r, i) => ({
    id: `${PREFIX}pick:${i}`,
    cmd: r.model,
    desc: isModel(m, r) ? `${r.effort} · now` : r.effort,
  }));
};

const menuNode = (c: ComposerState, f: ComposerFacts, d: Draft): SlashMenu | null => {
  // over the field only while it has the keys: given back (Esc, a click in the editor) it folds
  if (!c.active) return null;
  const p = c.pick;

  if (p?.session === f.session) {
    const rows = pickRows(p);
    const m = c.models[f.session];

    return {
      kind: 'SlashMenu',
      id: `${PREFIX}pick`,
      props: {
        items: pickItems(p, rows, m),
        selected: rows.length === 0 ? undefined : Math.min(p.row, rows.length - 1),
      },
    };
  }
  const rows = slashRows(c, f, d);

  if (rows.length === 0) return null;
  const selected = Math.min(d.row, rows.length - 1);
  // the selected row the last shown once the keys go past the first `MENU_ROWS`
  const top = Math.max(0, selected - MENU_ROWS + 1);

  return {
    kind: 'SlashMenu',
    id: `${PREFIX}menu`,
    props: {
      items: rows.slice(top, top + MENU_ROWS).map((r, i) => ({
        id: `${PREFIX}menu:${top + i}`,
        cmd: r.cmd,
        desc: r.desc,
        ...(r.reason === undefined ? {} : { reason: r.reason }),
      })),
      selected: selected - top,
    },
  };
};

/** The session's held messages, oldest first: dim rows, `×` takes one back. */
export const queuedNodes = (c: ComposerState, f: ComposerFacts): QueuedMessage[] =>
  (c.queues[f.session] ?? []).map((q) => ({
    kind: 'QueuedMessage',
    id: `${PREFIX}queued:${q.n}`,
    props: {
      text: q.text,
      ...(f.whose === undefined ? { remove: `${PREFIX}unqueue:${q.n}` } : {}),
    },
  }));

/** What the ended line offers for each step ⏎ takes (#343). */
const STEP_WORDS = { reopen: ' · ⏎ Reopen · ⌘⏎ more' } as const;

/** The field's words on an ended session ⏎ reopens (#343). */
export const REOPEN_PLACEHOLDER = 'Type a message…';

/**
 * An ended session's line (#258): its word as its card says it and when, why when its box ended
 * it (#316); what ⏎ does here, only when it does something.
 */
const endedHead = (f: ComposerFacts): string =>
  `Session ${f.stopped === true ? 'stopped' : 'ended'}${f.endedAt === undefined ? '' : ` ${endedWhen(f.endedAt, f.now)}`}${f.why === undefined ? '' : `: ${f.why}`}`;

const endedLine = (f: ComposerFacts): string =>
  `${endedHead(f)}${f.step === undefined ? '' : STEP_WORDS[f.step]}`;

/** The draft's files as chips, each `×` (a click) dropping it. */
const fileChips = (d: Draft): AttachChip[] =>
  (d.files ?? []).map((path, i) => ({
    kind: 'AttachChip',
    id: `${PREFIX}detach:${i}`,
    props: {
      name: path.split('/').at(-1) ?? path,
      ...(/\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(path) ? { image: true } : {}),
    },
  }));

/** The composer: none on a teammate's session, the ended line on an ended one. */
export const composerNode = (c: ComposerState, f: ComposerFacts): Composer | null => {
  if (f.whose !== undefined) return null;
  // ⏎ reopens it (#343): the field is live, the foot says how it ended and what ⏎ does
  if (reopens(f)) {
    const d = draftOf(c, f.session);
    const files = fileChips(d);

    return {
      kind: 'Composer',
      id: `${PREFIX}composer`,
      props: {
        text: d.text,
        ...caretOf(d.caret),
        placeholder: REOPEN_PLACEHOLDER,
        ...(c.active && f.focused === true ? { focused: true } : {}),
        model: { label: endedHead(f), note: STEP_WORDS.reopen.replace(/^ /, '') },
        ...(c.synced === 0 ? {} : { seq: c.synced }),
      },
      ...(files.length === 0 ? {} : { children: files }),
    };
  }
  if (f.ended === true)
    return {
      kind: 'Composer',
      id: `${PREFIX}composer`,
      props: { text: '', line: endedLine(f) },
    };
  const d = draftOf(c, f.session);
  const chip = chipNode(c, f, d);
  const menu = menuNode(c, f, d);
  const model = modelProp(c.models[f.session]);

  return {
    kind: 'Composer',
    id: `${PREFIX}composer`,
    props: {
      text: d.text,
      ...caretOf(d.caret),
      placeholder: f.placeholder ?? COMPOSER_PLACEHOLDER,
      ...(c.active && f.focused === true ? { focused: true } : {}),
      ...(model === undefined ? {} : { model }),
      ...(c.synced === 0 ? {} : { seq: c.synced }),
      ...(c.pick?.session === f.session ? { picking: true } : {}),
    },
    children: [...(chip === null ? [] : [chip]), ...fileChips(d), ...(menu === null ? [] : [menu])],
  };
};

/**
 * The column's dock: the queued rows above the composer, 4 / 12 / 12 px around them (R-Composer's
 * `.vs-chatbar__dock`); null when there is nothing to draw (a teammate's session, nothing queued).
 */
export const composerDock = (
  c: ComposerState,
  f: ComposerFacts,
  status?: ChatStatus,
): Node | null => {
  const queued = queuedNodes(c, f);
  const field = composerNode(c, f);

  if (field === null && queued.length === 0 && status === undefined) return null;

  return {
    kind: 'Stack',
    id: `${PREFIX}dock`,
    props: { direction: 'column', gap: 4, pad: [4, 12, 12, 12] },
    children: [
      ...(queued.length === 0
        ? []
        : [{ kind: 'Stack' as const, props: { direction: 'column' as const }, children: queued }]),
      // the status line right above the field
      ...(status === undefined ? [] : [status]),
      ...(field === null ? [] : [field]),
    ],
  };
};

/** Whether the `/` menu or the model pick is open over the field (the screen's keys wait). */
export const composerMenuOpen = (c: ComposerState, f: ComposerFacts): boolean =>
  c.pick?.session === f.session || menuOpen(c, f);

/**
 * The `chat` screen's input as the composer sees it: its keys, text, clicks and answers (`handled`:
 * the screen stops there), and what it follows beside the screen (focus, the caret, `no-caret`,
 * events; `handled` false). A key comes here before the transcript while the field has the keys,
 * after it otherwise (`first`).
 */
export const composerInput = (
  c: ComposerState,
  input: Input,
  f: ComposerFacts,
  first: boolean,
): ComposerOut | undefined => {
  const done = inputOf(c, input, f, first);

  return done === undefined ? undefined : skillsAsked(c, done, f);
};

const SKILLS_ID = `${PREFIX}skills:`;

/** A `/` the menu is for: the text's first character, or a mid-message `/word` at the caret. */
const slashing = (d: Draft): boolean => d.text.startsWith('/') || midWord(d) !== undefined;

/**
 * The session's skills asked of `serve` (`session skills`) each time the `/` menu opens (its field
 * starts with `/`), so a skill the repo got since the session started is in it: the first time the
 * menu's commands shown meanwhile (not asked again until it answers), after that the last list.
 */
const skillsAsked = (was: ComposerState, done: ComposerOut, f: ComposerFacts): ComposerOut => {
  const c = done.composer;

  if (noField(f) || c.skills[f.session] === null) return done;
  if (!slashing(draftOf(c, f.session))) return done;
  const opens = !slashing(draftOf(was, f.session));

  if (c.skills[f.session] !== undefined && !opens) return done;

  return {
    ...done,
    composer: { ...c, skills: { ...c.skills, [f.session]: c.skills[f.session] ?? null } },
    commands: [
      ...done.commands,
      { kind: 'run', id: `${SKILLS_ID}${f.session}`, argv: ['session', 'skills', f.session] },
    ],
  };
};

const inputOf = (
  c: ComposerState,
  input: Input,
  f: ComposerFacts,
  first: boolean,
): ComposerOut | undefined => {
  switch (input.kind) {
    case 'key':
      return first === c.active ? composerKey(c, input.key, f) : undefined;
    case 'text':
      return first ? composerText(c, input.text, f) : undefined;
    case 'draft':
      return first ? composerDraft(c, input.text, input.seq, f, input.caret) : undefined;
    case 'attach':
      return first ? composerAttach(c, input.paths, f) : undefined;
    case 'click':
      return first ? composerClick(c, input.id, f) : undefined;
    case 'result':
      return first && isComposerResult(input.id)
        ? { ...composerResult(c, input), handled: true }
        : undefined;
    case 'focus':
      // lost to a layer (a menu, Command mode): they come back where they were
      return first && !input.focused && input.layer !== true
        ? out(composerFocus(c, false), [], false)
        : undefined;
    case 'caret':
      return first
        ? out(
            composerCaret(c, {
              file: input.file,
              line: input.line,
              ...(input.selection === undefined ? {} : { selection: input.selection }),
            }),
            [],
            false,
          )
        : undefined;
    case 'no-caret':
      return first ? out(composerCaret(c, null), [], false) : undefined;
    case 'choice':
      return first && input.row.startsWith(SLASH_ROW)
        ? slashChosen(c, f, input.row.slice(SLASH_ROW.length))
        : undefined;
    case 'event':
      return first ? out(composerEvent(c, input.event), [], false) : undefined;
    default:
      return undefined;
  }
};
