/**
 * The ask channel (#114 S1, S4's held permission): `abe hook` as Claude Code runs it, with the two
 * hooks serve answers; `abe session answer` and `abe session asks`.
 *
 * - AskUserQuestion's PreToolUse: its questions become cards in the session's meta (a grill round
 *   when several), `session.ask` goes out, and the tool is denied with `askDeny`, so the agent
 *   ends its turn; that Stop leaves the session waiting on you (core's `sessionStep`).
 * - A local session's PreToolUse of a fenced tool (#181, core's `fence.ts`): a file tool writing
 *   outside its worktree, or WebFetch to a host it does not reach and no live Override names, is
 *   denied, whatever the permission mode.
 * - A PermissionRequest in the area of a live Override (`inArea`): held for a permission card
 *   until it is answered, at most `PERMISSION_HOLD_MS` (then the hook answers nothing, Claude
 *   Code's own dialog stays and the card says `EXPIRED_TEXT`). One allowed for the session is
 *   allowed again at once.
 * - Any other PermissionRequest a person answers (not an unattended run's, answered by 2.0's
 *   rules): Claude Code's own dialog answers it, and a card names its tool and command, so Chat
 *   and `session asks` show what the session waits on. The card is answerable while the dialog
 *   is up: its answer presses the dialog's keys (core's `dialogKeys`); the card goes once the
 *   prompt is decided (in the terminal, or Claude Code's own auto-deny).
 *
 * A box's session: its hooks land in the box's serve, which keeps its cards; the Mac relays
 * `session answer` / `asks` there (`CloudSessions.relay`).
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import {
  type AskCard,
  askAnswer,
  askCards,
  askDeny,
  type Choice,
  dialogKeys,
  dialogNoAlways,
  NO_ALWAYS_TEXT,
  type Clock,
  EXPIRED_TEXT,
  fenceAnswer,
  FENCED_TOOLS,
  type HookAnswer,
  type Journal,
  type Outcome,
  type PermissionAnswer,
  PERMISSION_HOLD_MS,
  type PreToolAnswer,
  permissionCard,
  permissionDecision,
  type PromptWhere,
  overrideWhy,
  promptInput,
  readChoices,
  readPick,
  refused,
  withPick,
  SessionAnswerData,
  SessionAsksData,
  type SessionMeta,
  unattendedAnswer,
  WORKSPACE_MOUNT,
  HOOK_WAIT_MS,
  type Handlers,
} from '@abe/core';
import { z } from 'zod';
import { type WorkflowCtx } from '../skills/workflows';
import { heldBy } from '../layer/override';
import { noSessions, on, type SessionCtx } from './sessions';

/** How often a held permission's clock is looked at for its end. */
const HOLD_POLL_MS = 250;

/** The permission prompts serve holds, by card: answered, or let go at their end. */
export type Holds = {
  /** Holds `card` until `answer` or its end (undefined: it ran out, or serve stops). */
  wait: (card: string) => Promise<PermissionAnswer | undefined>;
  /** False when `card` is held no more (ran out, or this serve never held it). */
  answer: (card: string, answer: PermissionAnswer) => boolean;
  has: (card: string) => boolean;
  /** Lets `card` go unanswered (answered in Claude Code's own dialog, the session ended). */
  release: (card: string) => void;
  close: () => void;
};

export const startHolds = (o: { clock: Clock; holdMs?: number; pollMs?: number }): Holds => {
  const held = new Map<
    string,
    { until: number; done: (answer: PermissionAnswer | undefined) => void }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  const settle = (card: string, answer: PermissionAnswer | undefined) => {
    const one = held.get(card);

    held.delete(card);
    one?.done(answer);
    if (held.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const look = () => {
    const now = o.clock.now();

    for (const [card, one] of [...held]) if (now >= one.until) settle(card, undefined);
  };

  return {
    wait: (card) =>
      new Promise((done) => {
        held.set(card, { until: o.clock.now() + (o.holdMs ?? PERMISSION_HOLD_MS), done });
        timer ??= setInterval(look, o.pollMs ?? HOLD_POLL_MS);
      }),
    answer: (card, answer) => {
      if (!held.has(card)) return false;
      settle(card, answer);

      return true;
    },
    has: (card) => held.has(card),
    release: (card) => {
      settle(card, undefined);
    },
    close: () => {
      for (const card of [...held.keys()]) settle(card, undefined);
    },
  };
};

export type AskCtx = SessionCtx & {
  serve: {
    emit: Journal['emit'];
    /** This serve's held permission prompts; undefined where none are held (no sessions). */
    holds: Holds | undefined;
  };
};

const stamp = (clock: Clock) => new Date(clock.now()).toISOString();
const cardId = (prefix: 'q' | 'p') => `${prefix}-${randomBytes(4).toString('hex')}`;

const PreToolPayload = z.looseObject({
  tool_name: z.string(),
  tool_input: z.unknown().optional(),
});

/**
 * The session's open question and grill cards closed, as answered outside Chat, and `text` typed in
 * as their answer at once (never held behind the cards, as a message you type is while it works).
 * False: none was open, nothing typed.
 */
export const answerQuestions = async (
  ctx: {
    serve: {
      sessions: SessionCtx['serve']['sessions'];
      emit: Journal['emit'];
    };
  },
  id: string,
  text: string,
): Promise<boolean> => {
  const meta = ctx.serve.sessions?.metaOf(id);
  const open = meta?.asks.filter((c) => c.kind === 'question' || c.kind === 'grill') ?? [];

  if (ctx.serve.sessions === undefined || meta === undefined || open.length === 0) return false;
  const ids = new Set(open.map((c) => c.id));

  ctx.serve.sessions.step(id, { kind: 'ask', closed: [...ids] });
  const sent = await ctx.serve.sessions.answer(id, text);

  if (!sent.ok) {
    ctx.serve.sessions.step(id, { kind: 'ask', back: open });

    return false;
  }
  ctx.serve.emit('session.answered', { id, card: meta.card, cards: [...ids], answer: text });

  return true;
};

/**
 * AskUserQuestion's questions as the session's cards (`fresh`: not open already, a call heard
 * again keeps its cards); undefined for any other PreToolUse.
 */
const askedCards = (
  ctx: AskCtx,
  meta: SessionMeta,
  doc: unknown,
): { cards: AskCard[]; fresh: boolean } | undefined => {
  const p = PreToolPayload.safeParse(doc);

  if (!p.success || p.data.tool_name !== 'AskUserQuestion') return undefined;
  const cards = askCards(p.data.tool_input, {
    session: meta.id,
    base: cardId('q'),
    at: stamp(ctx.serve.clock),
  });

  if (cards === null) return undefined;
  const open = cards.map((c) =>
    meta.asks.find((a) => a.kind === c.kind && a.question === c.question),
  );

  if (open.every((a) => a !== undefined)) return { cards: open, fresh: false };

  return { cards, fresh: true };
};

/** A PermissionRequest under a live Override: its card, or allowed at once for the session. */
const heldPrompt = (
  ctx: AskCtx,
  meta: SessionMeta,
  doc: unknown,
): { card: AskCard } | { allowed: true } | undefined => {
  const override = heldBy(meta, doc);

  if (override === undefined || ctx.serve.holds === undefined) return undefined;
  // What 2.0 allows a box's unattended run stays allowed: an Override never tightens.
  if (
    meta.unattended &&
    unattendedAnswer(doc, WORKSPACE_MOUNT).answer.hookSpecificOutput.decision.behavior === 'allow'
  )
    return undefined;
  const asked = promptInput(doc);

  if (meta.allowed.some((a) => a.tool === asked.tool && a.input === asked.input))
    return { allowed: true };

  return {
    card: permissionCard(doc, {
      session: meta.id,
      id: cardId('p'),
      at: stamp(ctx.serve.clock),
      why: overrideWhy(override),
      where: whereOf(ctx, meta),
      worktree: meta.worktree,
    }),
  };
};

/**
 * A local session's PreToolUse of a fenced tool (#181): `fenced` whether serve decides on it (no
 * transcript wait then: the hook's four seconds), `answer` the deny past the fence. While the
 * session starts (no `metaOf` yet) its fence holds already.
 */
const fencedPrompt = (
  sessions: NonNullable<AskCtx['serve']['sessions']>,
  id: string,
  doc: unknown,
): { fenced: boolean; answer: PreToolAnswer | undefined } => {
  const fence = sessions.fence(id);
  const tool = typeof doc === 'object' && doc !== null && 'tool_name' in doc ? doc.tool_name : null;

  if (fence === undefined || !FENCED_TOOLS.some((t) => t === tool))
    return { fenced: false, answer: undefined };

  return {
    fenced: true,
    answer: fenceAnswer(doc, fence, {
      realpath: realpathSync,
      readlink: readlinkSync,
      dirs: (path) =>
        readdirSync(path, { withFileTypes: true })
          .filter((d) => d.isDirectory() || d.isSymbolicLink())
          .map((d) => ({ name: d.name, link: d.isSymbolicLink() })),
      cut: (worktree, name) =>
        void process.stderr.write(
          `fence: skill ${name} let by, its nested search in ${worktree} stopped at the cap\n`,
        ),
      hardLinks: (path) => {
        const stat = statSync(path, { throwIfNoEntry: false });

        return stat?.isFile() === true ? stat.nlink : undefined;
      },
    }),
  };
};

/** Where the session's commands run, as its permission cards say: the Abe chat's has no sandbox. */
const whereOf = (ctx: AskCtx, meta: SessionMeta): PromptWhere =>
  meta.abe !== undefined && meta.abe !== null ? 'hub' : ctx.serve.where;

/** Why a prompt only Claude Code's own dialog answers asks you. */
const DIALOG_WHY = 'Claude Code asks before it runs this';

/**
 * A prompt Claude Code's own dialog answers: its card, not held (`dialog`: its answer presses the
 * dialog's keys); the step leaves it out when one for the same prompt is open already.
 */
const dialogCard = (ctx: AskCtx, meta: SessionMeta, doc: unknown): AskCard => ({
  ...permissionCard(doc, {
    session: meta.id,
    id: cardId('p'),
    at: stamp(ctx.serve.clock),
    why: DIALOG_WHY,
    where: whereOf(ctx, meta),
    worktree: meta.worktree,
  }),
  dialog: true,
});

const ALLOW: PermissionAnswer = {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
};

/**
 * The hooks that wait for Chat's transcript to read on (#113), at most `HOOK_WAIT_MS` (their hook
 * gives up after one second): the JSONL up to a call and its result. UserPromptSubmit waits for
 * the turn's start snapshot however long it takes (behind the last turn's Stop one; its hook waits
 * as long): a write before it would be left out of the turn.
 */
const TRANSCRIPT_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']);
/** The hooks after which Claude Code draws a dialog of its own in the terminal. */
const DIALOG_HOOKS = new Set(['PermissionRequest', 'Elicitation']);
/**
 * How long a PermissionRequest waits at most for a paste on its way in (one takes ~0.2 s): its
 * hook waits for a held card's answer, so far longer. An Elicitation's hook gives up after one
 * second: it waits `HOOK_WAIT_MS` at most.
 */
const PASTE_WAIT_MS = 3000;

/**
 * `abe hook <event>`: stepped and kept once (`Sessions.hook`), with the cards its payload asks,
 * and answered when it is AskUserQuestion's PreToolUse (denied, its cards asked) or a
 * PermissionRequest held for its card. Its payload's JSON is parsed here, once.
 */
const answerHook = async (
  ctx: AskCtx,
  id: string,
  event: string,
  text: string,
): Promise<
  Outcome<{ id: string; event: string; state: SessionMeta['state']; answer?: HookAnswer }>
> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  // undefined while its launch has not returned: its fence holds already, it asks no card yet
  const meta = sessions.metaOf(id);
  let doc: unknown;

  try {
    doc = JSON.parse(text);
  } catch {
    return refused('bad-payload', `the ${event} hook's payload is not JSON`);
  }
  const asked =
    meta !== undefined && event === 'PreToolUse' ? askedCards(ctx, meta, doc) : undefined;
  const fencing =
    event === 'PreToolUse' ? fencedPrompt(sessions, id, doc) : { fenced: false, answer: undefined };
  const fenced = fencing.answer;
  const held =
    meta !== undefined && event === 'PermissionRequest' ? heldPrompt(ctx, meta, doc) : undefined;
  const allowed = held !== undefined && 'allowed' in held;
  const card = held !== undefined && 'card' in held ? held.card : undefined;
  const hooked = sessions.hook(id, event, doc, {
    ...(allowed ? { answer: ALLOW } : {}),
    ...(asked === undefined ? {} : { asked }),
    ...(card === undefined ? {} : { held: card }),
    ...(meta !== undefined && event === 'PermissionRequest' && held === undefined
      ? { dialog: dialogCard(ctx, meta, doc) }
      : {}),
    holding: (meta?.asks ?? []).filter((c) => ctx.serve.holds?.has(c.id) === true).map((c) => c.id),
  });

  if (!hooked.ok) return hooked;
  // its cards answered outside Chat: their holds let go
  for (const c of hooked.data.cleared) ctx.serve.holds?.release(c);
  // held from now: its card is open with it
  const answered = card === undefined ? undefined : ctx.serve.holds?.wait(card.id);

  // A dialog shows once this hook is answered: a paste on its way in gets its Enter in first, so
  // that Enter never lands on the dialog (#197). Its check before the paste holds the next ones.
  if (DIALOG_HOOKS.has(event) && !allowed)
    await sessions.typed(id, event === 'PermissionRequest' ? PASTE_WAIT_MS : HOOK_WAIT_MS);
  // Chat's transcript reads on before the agent does (its order is the JSONL's then), each hook
  // held at most this long for it; never an asked question's deny, which must reach the hook
  // client within its four seconds, nor a fenced tool's (its hook refuses it when serve is late).
  // A turn's start snapshot is waited for whole.
  const read = ctx.serve.transcripts?.hook(id, event, doc);

  if (read !== undefined && event === 'UserPromptSubmit') await read;
  else if (
    read !== undefined &&
    asked === undefined &&
    !fencing.fenced &&
    TRANSCRIPT_HOOKS.has(event)
  )
    await Promise.race([read, Bun.sleep(HOOK_WAIT_MS)]);
  const data = { id, event, state: hooked.data.state };

  if (fenced !== undefined) return { ok: true, data: { ...data, answer: fenced } };
  if (asked !== undefined) {
    const [first] = asked.cards;

    return {
      ok: true,
      data: { ...data, answer: askDeny(first?.question ?? 'the question') },
    };
  }
  if (card === undefined || answered === undefined)
    return {
      ok: true,
      data: {
        ...data,
        ...(hooked.data.answer === undefined ? {} : { answer: hooked.data.answer }),
      },
    };
  const answer = await answered;

  if (answer !== undefined) return { ok: true, data: { ...data, answer } };
  const now = sessions.metaOf(id);

  // Let go (answered in its dialog, the session ended): nothing more to say.
  if (now === undefined || now.state === 'ended' || !now.asks.some((c) => c.id === card.id))
    return { ok: true, data };
  // Ran out: Claude Code's own dialog stays, the card says where to answer it.
  sessions.step(id, { kind: 'ask', asked: [{ ...card, expired: EXPIRED_TEXT }] });

  return { ok: true, data };
};

/** The cards `--card` names: one card, or a grill round's (by its id or any card of it), in order. */
const named = (cards: readonly AskCard[], card: string): AskCard[] => {
  const one = cards.find((c) => c.id === card);
  const round = one?.round?.id ?? card;
  const ofRound = cards
    .filter((c) => c.round?.id === round)
    .sort((a, b) => (a.round?.n ?? 0) - (b.round?.n ?? 0));

  if (ofRound.length > 0) return ofRound;

  return one === undefined ? [] : [one];
};

/** What `session asks` shows: a permission card no longer held here says so. */
const shown = (ctx: AskCtx, cards: readonly AskCard[]): AskCard[] =>
  cards.map((c) =>
    c.kind === 'permission' &&
    c.expired === null &&
    c.dialog !== true &&
    ctx.serve.holds?.has(c.id) !== true
      ? { ...c, expired: EXPIRED_TEXT }
      : c,
  );

/**
 * A dialog's card answered: the dialog's keys pressed while it is up. Its Esc (Deny, own words)
 * stops the turn with no hook after it: once the dialog is gone the session waits on your turn,
 * own words its next message, the queue after them (`escaped`). Gone from the screen, Claude Code
 * no longer asks it: the card goes, refused.
 */
const answerDialog = async (
  ctx: AskCtx,
  meta: SessionMeta,
  card: AskCard,
  choice: Choice,
): Promise<Outcome<SessionAnswerData>> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  if ('text' in choice && choice.text.trim() === '')
    return refused('usage', 'own words are empty: say what to do instead', 2);
  if ('option' in choice && !card.options.some((o) => o.n === choice.option))
    return refused('no-option', `card ${card.id} has options 1–${card.options.length}`, 2);
  let keys: readonly string[] | undefined;
  let noAlways: boolean | undefined;
  const pressed = await sessions.press(meta.id, (screen) => {
    noAlways = dialogNoAlways(screen, choice);

    return (keys = dialogKeys(screen, choice));
  });

  if (!pressed.ok) return pressed;
  // Allow for this session on a Yes / No dialog: refused, the card kept (never allowed once)
  if (noAlways === true) return refused('no-session-allow', NO_ALWAYS_TEXT);
  const words = permissionDecision(choice).words;

  sessions.step(meta.id, { kind: 'ask', closed: [card.id], answer: pressed.data ? words : null });
  if (!pressed.data) return refused('card-expired', `${card.title}: Claude Code no longer asks it`);
  if (keys?.includes('Escape') === true) {
    const after = await sessions.escaped(meta.id, 'text' in choice ? choice.text : null);

    if (!after.ok) return after;
  }

  return { ok: true, data: { id: meta.id, cards: [card.id], sent: words } };
};

/** A held permission card answered: its decision to the waiting hook. */
const answerPermission = (
  ctx: AskCtx,
  meta: SessionMeta,
  card: AskCard,
  choices: readonly Choice[],
): Outcome<SessionAnswerData> => {
  const [choice] = choices;

  if (choices.length !== 1 || choice === undefined)
    return refused('usage', `card ${card.id} takes one answer: --option <n> or --text`, 2);
  if ('text' in choice && choice.text.trim() === '')
    return refused('usage', 'own words are empty: say what to do instead', 2);
  if ('options' in choice) return refused('one-option', `card ${card.id} takes one option`, 2);
  if ('option' in choice && !card.options.some((o) => o.n === choice.option))
    return refused('no-option', `card ${card.id} has options 1–${card.options.length}`, 2);
  if (ctx.serve.holds?.has(card.id) !== true)
    return refused('card-expired', `${card.title} is no longer held here: ${EXPIRED_TEXT}`);
  const decision = permissionDecision(choice);

  ctx.serve.sessions?.step(meta.id, {
    kind: 'ask',
    closed: [card.id],
    answer: decision.words,
    ...(decision.session && card.prompt !== undefined ? { allow: card.prompt } : {}),
  });
  ctx.serve.holds.answer(card.id, decision.answer);

  return { ok: true, data: { id: meta.id, cards: [card.id], sent: decision.words } };
};

type AnswerArgs = {
  id: string;
  card: string;
  option: number[];
  text?: string;
  answers?: string;
  pick?: string;
};

/**
 * `--pick` (#342): one grill question's pick kept on its card in the session's meta, said as
 * `session.ask` so every client shows it; nothing is typed until the round is sent.
 */
const keepPick = (
  sessions: NonNullable<AskCtx['serve']['sessions']>,
  meta: SessionMeta,
  cards: readonly AskCard[],
  args: AnswerArgs & { pick: string },
): Outcome<SessionAnswerData> => {
  if (args.option.length > 0 || args.text !== undefined || args.answers !== undefined)
    return refused('usage', '--pick goes alone: one pick, the round sent once all are picked', 2);
  const read = readPick(args.pick);

  if (!read.ok) return read;
  const picked = withPick(cards, read.data.n, read.data.choice);

  if (!picked.ok) return picked;
  const card = picked.data;

  sessions.step(meta.id, { kind: 'ask', asked: [card] });

  return { ok: true, data: { id: meta.id, cards: [card.id], sent: '', picked: card.id } };
};

/** `session answer` on this serve's session: a permission decided, else the answer sent. */
const answerHere = async (
  ctx: AskCtx & Pick<WorkflowCtx, 'settings'>,
  args: AnswerArgs,
): Promise<Outcome<SessionAnswerData>> => {
  const sessions = ctx.serve.sessions;

  if (sessions === undefined) return noSessions();
  const meta = sessions.metaOf(args.id);

  if (meta === undefined) return refused('no-session', `no session ${args.id}`);
  if (meta.state === 'ended') return refused('session-ended', `session ${args.id} has ended`);
  const cards = named(meta.asks, args.card);
  const [first] = cards;

  if (first === undefined)
    return refused(
      'no-card',
      `session ${args.id} has no open card ${args.card} (abe session asks ${args.id})`,
    );
  if (args.pick !== undefined) return keepPick(sessions, meta, cards, { ...args, pick: args.pick });
  const choices = readChoices(args);

  if (!choices.ok) return choices;
  if (first.kind === 'permission' && first.dialog === true) {
    const [choice] = choices.data;

    return choices.data.length !== 1 || choice === undefined || 'options' in choice
      ? refused('usage', `card ${first.id} takes one answer: --option <n> or --text`, 2)
      : answerDialog(ctx, meta, first, choice);
  }
  if (first.kind === 'permission') return answerPermission(ctx, meta, first, choices.data);
  const message = askAnswer(cards, choices.data);

  if (!message.ok) return message;
  const ids = new Set(cards.map((c) => c.id));

  // Cleared before it is typed: the prompt's own hooks see no card waiting. The queue held for
  // the answer goes with it, after it, as one prompt.
  sessions.step(args.id, { kind: 'ask', closed: [...ids] });
  const sent = await sessions.answer(args.id, message.data);

  if (!sent.ok) {
    sessions.step(args.id, { kind: 'ask', back: cards });

    return sent;
  }
  ctx.serve.emit('session.answered', {
    id: args.id,
    card: meta.card,
    cards: [...ids],
    answer: message.data,
  });

  return { ok: true, data: { id: args.id, cards: [...ids], sent: message.data } };
};

const answerArgv = (args: AnswerArgs): string[] => [
  'session',
  'answer',
  args.id,
  '--card',
  args.card,
  ...args.option.flatMap((n) => ['--option', String(n)]),
  ...(args.text === undefined ? [] : ['--text', args.text]),
  ...(args.answers === undefined ? [] : ['--answers', args.answers]),
  ...(args.pick === undefined ? [] : ['--pick', args.pick]),
];

export const askHandlers = <Ctx extends AskCtx & Pick<WorkflowCtx, 'settings'>>() =>
  ({
    hook: (args, ctx) => {
      if (ctx.serve.sessions === undefined) return noSessions();
      if (ctx.session === undefined)
        return Promise.resolve(
          refused('not-a-session', "abe hook is answered only on a session's own socket"),
        );

      return answerHook(ctx, ctx.session, args.event, args.payload);
    },
    'session answer': (args, ctx) =>
      on(
        ctx,
        args.id,
        () => answerHere(ctx, args),
        (c) => c.relay(args.id, SessionAnswerData, answerArgv(args)),
      ),
    'session asks': (args, ctx) =>
      on(
        ctx,
        args.id,
        (s) => {
          const meta = s.metaOf(args.id);

          return Promise.resolve(
            meta === undefined
              ? refused('no-session', `no session ${args.id}`)
              : {
                  ok: true,
                  // An ended session asks nothing any more.
                  data: { id: args.id, cards: meta.state === 'ended' ? [] : shown(ctx, meta.asks) },
                },
          );
        },
        (c) => c.relay(args.id, SessionAsksData, ['session', 'asks', args.id]),
      ),
  }) satisfies Partial<Handlers<Ctx>>;
