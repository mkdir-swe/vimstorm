/**
 * What you send a session from Chat (#115): your message with its implicit context
 * (`core/src/session/context.ts`), typed into the session's terminal; and its model and effort, switched in
 * Claude Code's own `/model` picker for this session only (#180: `/model <name>` and `/effort
 * <level>` save what they set in the person's `~/.claude/settings.json`; `core/src/session/model-pick.ts`
 * reads the picker).
 *
 * A message is typed in as you send it, mid-turn too (#197): Claude Code keeps one typed while it
 * works in its own queue and takes it at the agent's next step (with the next tool result), as it
 * does what you type in its terminal; so a Factory run hears you while it runs, not after its turn.
 * The transcript shows it once, where Claude Code took it (`transcript.ts`, its `queued_command`
 * line). `serve` holds a message back only while the session cannot take it (`Hold`): its
 * `claude` has not started, or not taken its launch's prompt (keys would land in its trust
 * dialog, or be kept for after its whole first turn); a dialog of Claude Code's asks in its
 * terminal (a permission prompt: keys would answer it); or a question card waits for its answer
 * while the agent ends its turn (#114, below). What it holds goes as one prompt at the first hook
 * after that, unless you take one back (`unqueue`). A dialog answered by its Esc runs no hook: its
 * hold goes once its screen shows no dialog (`escaped`; a message sent while it holds looks too).
 *
 * The held queue is `serve`'s, so every client sees the same one: kept in the session's `meta.json`
 * (a restarted `serve` still has it, and types it in if the session can take it meanwhile), each
 * change a `session.queued` event. Waiting on a dialog is not waiting on your turn: a turn ends
 * when a `Stop` hook leaves the session waiting on you. A slash command (`/compact`, `/model`) is
 * never held, joined to others or given context: it goes at once (refused while its `claude`
 * starts or a dialog waits), and Claude Code runs its immediate ones (`/model`) mid-turn and
 * queues the rest itself. What is typed into one session goes one paste at a time (they share its
 * tmux buffer), and whether it may go is looked at again just before its paste: a dialog that
 * opened while it waited holds it. A dialog's own hook waits for a paste on its way in (`typed`),
 * so Claude Code draws no dialog under that paste's Enter.
 *
 * A question or grill card open (#114: AskUserQuestion denied, its turn ended) holds the queue:
 * the turn's end does not send it, since the agent waits for the card's answer. The answer goes
 * first, the queue after it, as one prompt (`answer`); a message you type then goes at once, the
 * queue before it, as answering does. An answer is never held by a card still open: answering one
 * while another waits and the agent works goes in now (#326).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Answered,
  type Clock,
  dialogShown,
  type Effort,
  type EventData,
  type Hold,
  heldWords,
  modelPicked,
  modelPickKeys,
  pickerFocus,
  pickerOpen,
  type ImplicitContext,
  ImplicitContext as ContextShape,
  messageWithContext,
  type Outcome,
  type QueuedRow,
  refused,
  type SentContext,
  type SessionMeta,
  type SessionModelData,
  type SessionRunner,
  type Handlers,
} from '@abe/core';
import { launchSettings, on, type SessionCtx } from './sessions';

/** A model name as `allowedModels` names one: nothing a typed `/model` line could carry more of. */
const MODEL_NAME = /^[\w.-]+$/;
/** The `/model` picker's screen read every 100 ms, for 5 s at most before it opens or answers. */
const PICK = { everyMs: 100, forMs: 5000 };

const failed = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message },
});

/**
 * How long a dialog's hold waits before its screen is looked at for it: Claude Code draws the
 * dialog only once its hook is answered.
 */
const DIALOG_DRAWN_MS = 2000;

/** The code of a paste not made because the session could not take keys any more (`Hold`). */
const HELD = 'held';

/** A question or grill card waits for its answer (a permission card is a dialog's, not a turn's). */
const asking = (meta: SessionMeta): boolean => meta.asks.some((c) => c.kind !== 'permission');

/** The queue's prompts as one: in order, a blank line between each. */
export const queuedPrompt = (queue: readonly { prompt: string }[]): string =>
  queue.map((q) => q.prompt).join('\n\n');

const rows = (meta: SessionMeta): QueuedRow[] => meta.queue.map(({ n, text }) => ({ n, text }));

/**
 * `--context` with its selection's lines: as sent, else read from the session's worktree (the
 * file as saved). Null: no context.
 */
export const sentContext = (
  context: ImplicitContext | null,
  worktree: string,
): Outcome<SentContext | null> => {
  if (context === null || !('from' in context)) return { ok: true, data: context };
  if (context.lines !== undefined)
    return context.lines.length === context.to - context.from + 1
      ? { ok: true, data: { ...context, lines: context.lines } }
      : refused(
          'bad-context',
          `lines ${context.from}–${context.to} are ${context.to - context.from + 1}, not ${context.lines.length}`,
        );
  let text: string;

  try {
    text = readFileSync(resolve(worktree, context.path), 'utf8');
  } catch {
    return refused('bad-context', `no file ${context.path} in the session's worktree`);
  }
  // A last newline ends the last line; it starts none.
  const all = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');

  if (context.from > all.length)
    return refused('bad-context', `${context.path} has ${all.length} lines, not ${context.from}`);
  const to = Math.min(context.to, all.length);

  return { ok: true, data: { ...context, to, lines: all.slice(context.from - 1, to) } };
};

/** `--context <json>` read; undefined or empty: none. */
export const parseContext = (json: string | undefined): Outcome<ImplicitContext | null> => {
  if (json === undefined || json.trim() === '' || json.trim() === 'null')
    return { ok: true, data: null };
  let doc: unknown;

  try {
    doc = JSON.parse(json);
  } catch {
    return refused('usage', '--context is not JSON', 2);
  }
  const parsed = ContextShape.safeParse(doc);

  return parsed.success
    ? { ok: true, data: parsed.data }
    : refused(
        'usage',
        `--context: {path, from, to[, lines]}, {path, line}, {card, title}, {page} or {change, what}: ${parsed.error.issues[0]?.message ?? 'not one of them'}`,
        2,
      );
};

export type QueueOptions = {
  /** The session as `serve` keeps it now (one being launched too); undefined for none. */
  meta: (id: string) => SessionMeta | undefined;
  /** Being launched, or its `claude` has not taken its launch's prompt yet: it takes no keys. */
  starting: (id: string) => boolean;
  /** Keeps the session's meta (and its `meta.json`). */
  keep: (meta: SessionMeta) => void;
  /**
   * Claude Code's dialog is gone with no hook saying so (answered by its Esc: its turn stopped):
   * the session waiting on it waits on your turn, said as `session.state`.
   */
  undialog: (id: string) => void;
  clock: Clock;
  runner: Pick<SessionRunner, 'send' | 'keys' | 'screen'>;
  /** How often the `/model` picker's screen is read, and for how long at most (`PICK`). */
  pick?: { everyMs: number; forMs: number };
  emitQueued: (data: EventData<'session.queued'>) => void;
  emitModel: (data: EventData<'session.model'>) => void;
  log: (message: string) => void;
};

export type SessionQueue = {
  /**
   * Your message, with its context: typed in now (`queued` null), mid-turn too; held while the
   * session takes no keys (its `n`, and why). A slash command is never held.
   */
  message: (
    id: string,
    text: string,
    context: ImplicitContext | null,
  ) => Promise<Outcome<{ prompt: string; queued: number | null; held: Hold | null }>>;
  /** Takes queued message `n` back: the queue left. */
  unqueue: (id: string, n: number) => Outcome<QueuedRow[]>;
  /**
   * Types the held queue in as one prompt, once the session takes keys again and no question card
   * waits for its answer.
   */
  deliver: (id: string) => Promise<void>;
  /**
   * A card's answer (#114) typed in now, the queue after it, as one prompt; not typed in (tmux
   * failing): refused, the queue kept.
   */
  answer: (id: string, prompt: string) => Promise<Outcome<{ prompt: string }>>;
  model: (
    id: string,
    ask: { model: string; effort?: Effort; allowed: readonly string[] },
  ) => Promise<Outcome<SessionModelData>>;
  /**
   * Once everything asked to be typed into the session so far is in (its Enter pressed), at most
   * `ms`: a dialog's hook waits for it, so Claude Code never draws the dialog under a paste's
   * Enter (#197).
   */
  typed: (id: string, ms: number) => Promise<void>;
  /**
   * Claude Code's own dialog answered by its Esc (Deny, own words from Chat): its turn stops and no
   * hook comes. Once the dialog is gone from its screen the session waits on your turn; `words`
   * (own words) go in then, the queue after them, as one prompt, else the queue alone. Still up
   * at `PICK`'s limit: refused, the hold kept.
   */
  escaped: (id: string, words: string | null) => Promise<Outcome<null>>;
  /** `text` typed in now, never queued (a run's checks' output), after any paste before it. */
  type: (id: string, text: string) => ReturnType<SessionRunner['send']>;
};

export const sessionQueue = (o: QueueOptions): SessionQueue => {
  const unknown = (id: string) => refused('no-session', `no session ${id}`);
  const ended = (id: string) => refused('session-ended', `session ${id} has ended`);
  const said = (meta: SessionMeta) => {
    o.emitQueued({ session: meta.id, queue: rows(meta) });
  };
  /** Sessions whose queue is being typed in now: a second Stop never sends it twice. */
  const delivering = new Set<string>();
  /** Each session's last paste: the next one waits for it (one tmux buffer per session). */
  const lanes = new Map<string, Promise<unknown>>();
  /** `work` once everything typed into the session before it is in: one at a time per session. */
  const inLane = <T>(id: string, work: () => Promise<Answered<T>>): Promise<Answered<T>> => {
    const done = (lanes.get(id) ?? Promise.resolve()).then(work).catch((err: unknown) => ({
      ok: false as const,
      error: { code: 'send-failed', message: err instanceof Error ? err.message : String(err) },
    }));

    lanes.set(id, done);
    void done.then(() => {
      if (lanes.get(id) === done) lanes.delete(id);
    });

    return done;
  };
  const typeIn = (id: string, text: string): ReturnType<SessionRunner['send']> =>
    inLane(id, () => o.runner.send(id, text));
  /**
   * Why the session takes no message now; null: it does. A question card asked while it still
   * works holds one for the card's answer (#114); once its turn has ended, one you type is yours
   * in your own words and goes (`deliver`'s `asked`).
   */
  const holdOf = (meta: SessionMeta): Hold | null => {
    if (o.starting(meta.id) || meta.state === 'queued' || meta.state === 'starting')
      return 'starting';
    if (meta.state === 'waiting' && meta.waitingOn === 'dialog') return 'dialog';

    return meta.state === 'working' && asking(meta) ? 'question' : null;
  };
  /**
   * A dialog's hold to look at on its screen: one just asked is not drawn yet, so not before
   * `DIALOG_DRAWN_MS`.
   */
  const lookable = (meta: SessionMeta): boolean =>
    holdOf(meta) === 'dialog' && o.clock.now() - Date.parse(meta.since) >= DIALOG_DRAWN_MS;
  /**
   * The session once its dialog's hold is looked at on its screen: no dialog there any more
   * (answered by Esc, in the terminal or from Chat: no hook says so), its hold let go.
   */
  const unheld = async (meta: SessionMeta): Promise<SessionMeta> => {
    const shown = await o.runner.screen(meta.id);

    if (!shown.ok || dialogShown(shown.data)) return meta;
    o.log(`${meta.id}: no dialog on its screen any more, its hold let go`);
    o.undialog(meta.id);

    return o.meta(meta.id) ?? meta;
  };
  /**
   * `text` typed in once everything before it is, if the session takes keys then (looked at just
   * before the paste); else not, as `HELD`. A card's answer (`answer`) is what an open question
   * card holds the rest for, so that hold never holds it: answering one card while another is
   * still open and the agent works goes in now, Claude Code's own queue taking it (#326).
   */
  const typeWhenFree = (
    id: string,
    text: string,
    how: { answer?: boolean } = {},
  ): ReturnType<SessionRunner['send']> =>
    inLane(id, () => {
      const now = o.meta(id);
      const hold = now === undefined ? 'starting' : holdOf(now);

      return hold === null || (hold === 'question' && how.answer === true)
        ? o.runner.send(id, text)
        : Promise.resolve(failed(HELD, `session ${id} is held: ${heldWords(hold)}`));
    });
  const pickEvery = o.pick?.everyMs ?? PICK.everyMs;
  const pickFor = o.pick?.forMs ?? PICK.forMs;
  /** The session's screen once `ready` says it shows what is waited for; undefined at the limit. */
  const screenUntil = async <T>(
    id: string,
    ready: (screen: string) => T | undefined,
  ): Promise<Answered<T | undefined>> => {
    const until = Date.now() + pickFor;

    for (;;) {
      const shown = await o.runner.screen(id);

      if (!shown.ok) return shown;
      const got = ready(shown.data);

      if (got !== undefined || Date.now() >= until) return { ok: true, data: got };
      await Bun.sleep(pickEvery);
    }
  };
  /**
   * `/model` alone, then the picker's keys to `model` (and `effort`) and `s`, "use this session
   * only": nothing saved as the person's default (#180). The picker left open (no row for it, an
   * answer that never came) is closed with Esc; Esc is never pressed once it is gone (it would
   * stop the agent's turn).
   */
  const pickModel = (id: string, model: string, effort: Effort | undefined) =>
    inLane(id, async (): Promise<Answered<string>> => {
      const typed = await o.runner.send(id, '/model');

      if (!typed.ok) return typed;
      const open = await screenUntil(id, (screen) => (pickerOpen(screen) ? screen : undefined));

      if (!open.ok) return open;
      if (open.data === undefined)
        return failed('model-picker', `Claude Code's /model picker did not open in ${id}`);
      const keys = modelPickKeys(open.data, { model, effort });
      const close = async () => {
        const now = await o.runner.screen(id);

        if (now.ok && pickerOpen(now.data)) await o.runner.keys(id, ['Escape']);
      };

      if (!keys.ok) {
        await close();

        return failed('model-picker', `${id}: ${keys.reason}`);
      }
      // `s` only once the model's row has the focus (a key lost on the way never picks another).
      const moved = await o.runner.keys(id, keys.keys.slice(0, -1));
      const on = moved.ok
        ? await screenUntil(id, (screen) => (pickerFocus(screen) === keys.row ? true : undefined))
        : moved;

      if (!on.ok || on.data === undefined) {
        await close();

        return on.ok
          ? failed('model-picker', `${id}: the /model picker never reached ${keys.row}`)
          : on;
      }
      const pressed = await o.runner.keys(id, ['s']);

      if (!pressed.ok) {
        await close();

        return pressed;
      }
      const picked = await screenUntil(id, modelPicked);

      if (!picked.ok) return picked;
      if (picked.data?.kind === 'session') return { ok: true, data: picked.data.line };
      await close();

      return failed(
        'model-picker',
        picked.data === undefined
          ? `Claude Code did not say it switched ${id} to ${model}`
          : `Claude Code in ${id}: ${picked.data.line}`,
      );
    });
  const enqueue = (meta: SessionMeta, text: string, prompt: string) => {
    const n = meta.queueNext;
    const next = { ...meta, queue: [...meta.queue, { n, text, prompt }], queueNext: n + 1 };

    o.keep(next);
    said(next);

    return n;
  };

  /**
   * Types `first` (a card's answer) and the queue in as one prompt, the queue taken out before it
   * is typed; not typed in (held again, tmux failing), the queue comes back, ahead of anything
   * queued since.
   */
  const typeQueue = async (
    meta: SessionMeta,
    first: string | null,
  ): ReturnType<SessionRunner['send']> => {
    const id = meta.id;

    delivering.add(id);
    const sending = meta.queue;
    const cleared = { ...meta, queue: [] };

    if (sending.length > 0) {
      o.keep(cleared);
      said(cleared);
    }
    // never a blank line first: Chat reads the prompt from its start (an answer's `Answer to …`)
    const prompt = [...(first === null ? [] : [first]), ...sending.map((q) => q.prompt)]
      .filter((p) => p.trim() !== '')
      .join('\n\n')
      .trim();
    const typed = await typeWhenFree(id, prompt, { answer: first !== null }).finally(() =>
      delivering.delete(id),
    );

    if (typed.ok || sending.length === 0) return typed;
    const now = o.meta(id) ?? cleared;
    const back = { ...now, queue: [...sending, ...now.queue] };

    o.keep(back);
    said(back);
    if (typed.error.code !== HELD) o.log(`the queue of ${id} was not sent: ${typed.error.message}`);

    return typed;
  };

  /**
   * The held queue typed in, again while more was held meanwhile. `asked`: a message of yours goes
   * with it, so an open question card holds nothing back.
   */
  const deliver = async (id: string, how: { asked?: boolean } = {}): Promise<void> => {
    for (;;) {
      const meta = o.meta(id);

      if (
        meta === undefined ||
        meta.state === 'ended' ||
        meta.queue.length === 0 ||
        holdOf(meta) !== null ||
        (asking(meta) && how.asked !== true) ||
        delivering.has(id)
      )
        return;
      if (!(await typeQueue(meta, null)).ok) return;
    }
  };

  return {
    message: async (id, text, context) => {
      const was = o.meta(id);

      if (was === undefined) return unknown(id);
      if (was.state === 'ended') return ended(id);
      // looked at only when it might be: anything else goes in its lane before any await
      const meta = lookable(was) ? await unheld(was) : was;
      // A slash command takes its words as its arguments: no context after them.
      const command = text.startsWith('/');
      const hold = holdOf(meta);

      // Never held, so never typed into what would take it as an answer or lose it (#197).
      if (command && (hold === 'starting' || hold === 'dialog'))
        return refused(
          hold === 'starting' ? 'session-starting' : 'session-asking',
          `${text.split(' ')[0] ?? text} not typed into ${id}: ${heldWords(hold)}`,
        );
      // Its worktree is made by the launch: a selection's lines are read from it once it is there.
      if (
        meta.worktree === '' &&
        context !== null &&
        'from' in context &&
        context.lines === undefined
      )
        return refused(
          'session-starting',
          `session ${id} has no worktree yet to read ${context.path} from: send the selection's lines`,
        );
      // Shell input (`!git status`) runs as typed: a context after it would run as a command too.
      const shell = text.startsWith('!');
      const sent = sentContext(command || shell ? null : context, meta.worktree);

      if (!sent.ok) return sent;
      const prompt = messageWithContext(text, sent.data);

      if (command) {
        const typed = await typeIn(id, prompt);

        return typed.ok
          ? { ok: true, data: { prompt, queued: null, held: null } }
          : refused(typed.error.code, typed.error.message);
      }
      // Taking keys, nothing held before it: typed in now, mid-turn too (Claude Code's own queue).
      if (hold === null && meta.queue.length === 0 && !delivering.has(id)) {
        const typed = await typeWhenFree(id, prompt);

        if (typed.ok) return { ok: true, data: { prompt, queued: null, held: null } };
        if (typed.error.code !== HELD) return refused(typed.error.code, typed.error.message);
      }
      // Held: after what is held before it, until the session takes keys.
      const now = o.meta(id) ?? meta;
      const n = enqueue(now, text, prompt);

      await deliver(id, { asked: true });
      const after = o.meta(id) ?? now;

      return {
        ok: true,
        data: {
          prompt,
          queued: n,
          held: after.queue.some((q) => q.n === n) ? holdOf(after) : null,
        },
      };
    },
    unqueue: (id, n) => {
      const meta = o.meta(id);

      if (meta === undefined) return unknown(id);
      if (!meta.queue.some((q) => q.n === n))
        return refused('not-queued', `no message ${n} is queued for ${id}`);
      const next = { ...meta, queue: meta.queue.filter((q) => q.n !== n) };

      o.keep(next);
      said(next);

      return { ok: true, data: rows(next) };
    },
    deliver: (id) => deliver(id),
    typed: async (id, ms) => {
      await Promise.race([lanes.get(id) ?? Promise.resolve(), Bun.sleep(ms)]);
    },
    type: typeIn,
    escaped: async (id, words) => {
      // nothing else goes meanwhile (the transcript's Esc line lets go too): own words first
      delivering.add(id);
      const gone = await screenUntil(id, (screen) =>
        dialogShown(screen) ? undefined : true,
      ).finally(() => delivering.delete(id));

      if (!gone.ok) return refused(gone.error.code, gone.error.message);
      if (gone.data === undefined)
        return refused('dialog-up', `Claude Code's dialog in ${id} is still up after its Esc`);
      o.undialog(id);
      const meta = o.meta(id);

      if (meta === undefined) return unknown(id);
      if (words === null) {
        await deliver(id);

        return { ok: true, data: null };
      }
      const typed = await typeQueue(meta, words);

      return typed.ok ? typed : refused(typed.error.code, typed.error.message);
    },
    answer: async (id, prompt) => {
      const meta = o.meta(id);

      if (meta === undefined) return unknown(id);
      if (meta.state === 'ended') return ended(id);
      // Taken now, before anything is awaited: a turn's end heard meanwhile finds it empty.
      const typed = await typeQueue(meta, prompt);

      return typed.ok
        ? { ok: true, data: { prompt: [prompt, ...meta.queue.map((q) => q.prompt)].join('\n\n') } }
        : refused(typed.error.code, typed.error.message);
    },
    model: async (id, ask) => {
      const meta = o.meta(id);

      if (meta === undefined) return unknown(id);
      if (meta.state === 'ended') return ended(id);
      if (!MODEL_NAME.test(ask.model)) return refused('usage', `not a model name: ${ask.model}`, 2);
      // What Claude Code holds it to (its launch's `availableModels`) and what is in force now.
      const allowed = ask.allowed.filter(
        (m) => meta.allowedModels.length === 0 || meta.allowedModels.includes(m),
      );

      if (!allowed.includes(ask.model))
        return refused(
          'model-not-allowed',
          `${ask.model} is not in allowedModels for ${id}: ${allowed.join(', ') || 'none'}`,
        );
      if (holdOf(meta) === 'starting')
        return refused(
          'session-starting',
          `session ${id}'s claude has not started yet: switch the model once it runs`,
        );
      if (meta.state === 'waiting' && meta.waitingOn !== 'turn' && meta.waitingOn !== 'question')
        return refused(
          'session-asking',
          `session ${id} waits on a dialog in its terminal: answer it first, then switch the model`,
        );
      const picked = await pickModel(id, ask.model, ask.effort);

      if (!picked.ok) return refused(picked.error.code, picked.error.message);
      o.log(`${id}: ${picked.data}`);
      const now = o.meta(id) ?? meta;
      const next = { ...now, model: ask.model, effort: ask.effort ?? now.effort };

      o.keep(next);
      const data = { id, model: ask.model, effort: next.effort, effortPending: false };

      o.emitModel({ session: id, model: data.model, effort: data.effort, effortPending: false });

      return { ok: true, data };
    },
  };
};

export const queueHandlers = <Ctx extends SessionCtx>() =>
  ({
    'session send': (args, ctx) => {
      const text = args.text.join(' ');
      const context = parseContext(args.context);

      if (!context.ok) return Promise.resolve(context);

      return on(
        ctx,
        args.id,
        async (s) => {
          const sent = await s.message(args.id, text, context.data);

          return sent.ok
            ? {
                ok: true,
                data: {
                  id: args.id,
                  sent: sent.data.prompt,
                  queued: sent.data.queued,
                  ...(sent.data.held === null ? {} : { held: sent.data.held }),
                },
              }
            : sent;
        },
        // A box's session: its own serve reads the context there, in its own worktree.
        (c) => c.send(args.id, text, args.context),
      );
    },
    'session unqueue': (args, ctx) =>
      on(
        ctx,
        args.id,
        (s) => {
          const left = s.unqueue(args.id, args.n);

          return Promise.resolve(
            left.ok ? { ok: true, data: { id: args.id, queue: left.data } } : left,
          );
        },
        (c) => c.unqueue(args.id, args.n),
      ),
    'session model': (args, ctx) =>
      on(
        ctx,
        args.id,
        (s) => {
          const repo = s.metaOf(args.id)?.repo;

          return s.model(args.id, {
            model: args.model,
            ...(args.effort === undefined ? {} : { effort: args.effort }),
            allowed: repo === undefined ? [] : launchSettings(ctx, repo).allowedModels,
          });
        },
        (c) => c.model(args.id, args.model, args.effort),
      ),
  }) satisfies Partial<Handlers<Ctx>>;
