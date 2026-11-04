/**
 * A session's transcript for Chat (#113, slice t113b): `serve` follows each session's Claude Code
 * transcript JSONL (the hooks' `transcript_path`, kept in its meta) and its subagents' own files
 * beside it, from the byte offset each reached (a partial last line waits), on every hook and on
 * a slow timer, plus the hooks' own entries that come before the JSONL has them (`entriesOfHook`:
 * the running step from PreToolUse, a result from PostToolUse). One ordered list per session: an
 * entry of a kind and id already there replaces it in its place (t113a's rule). Each batch is
 * `session.transcript` events, one per run of numbers it touched, so a reader puts each entry at
 * its number; `abe session transcript <id> --since <n>` answers the same numbers. Kept in memory
 * (the newest `ENTRIES_MAX`), read again from the files after a `serve` restart.
 *
 * Each turn's changes come from git (#113's M1 comment): the worktree is snapshotted at the
 * turn's start (UserPromptSubmit), after each tool that may have written and at Stop, without
 * touching it (`TranscriptFiles.snapshot`), and the turn's files go out as a `changes` entry.
 * The snapshots are kept in `<state>/sessions/<id>/turns.json`, so `abe session revert` puts a
 * turn's files back after a restart too. A box's sessions are read by the box's own `serve`
 * (inside its workspace container, through the same port); the Mac gets the events through the
 * merged watch and forwards these two commands to the box.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type ChangesEntry,
  type Clock,
  entriesOfHook,
  entriesOfLine,
  interruptedAt,
  type EventData,
  isTranscriptPath,
  type Outcome,
  patchesOfDiff,
  refused,
  sameChanges,
  SessionRevertData,
  type SessionMeta,
  SessionTranscriptData,
  type TranscriptEntry,
  type ByCard,
  type TranscriptFiles,
  type Handlers,
} from '@abe/core';
import { sessionDir } from '@abe/ports';
import { type SessionCtx, yours } from './sessions';

/** Entries kept in memory per session; older ones are read again only after a restart. */
export const ENTRIES_MAX = 5000;
/** A transcript line read whole up to this size; a longer one is skipped (logged). */
export const LINE_BYTES_MAX = 64_000_000;
/** How often running sessions' files are read between hooks. */
const EVERY_MS = 5000;

/** Tools after which the worktree may have changed: its snapshot is taken again. */
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);

export type TranscriptsOptions = {
  stateDir: string;
  /**
   * Where a session runs, by its card: its transcript files and worktree (on a box, its
   * workspace's container).
   */
  files: ByCard<TranscriptFiles>;
  /** The sessions' `HOME` where they run: their transcripts are under its `.claude/projects`. */
  home: string;
  /** What `serve` keeps of a session now. */
  meta: (id: string) => SessionMeta | undefined;
  clock: Clock;
  emit: (data: EventData<'session.transcript'>) => void;
  log: (message: string) => void;
  /**
   * The session's own agent was stopped mid-turn (Esc in its Claude Code, which runs no hook
   * then), `at` its line's time: told as the line is read, never for one read in after a restart.
   */
  interrupted?: (id: string, at: string) => void;
  /** How often open sessions are read without a hook (default 5 s). */
  everyMs?: number;
  /** Entries kept per session (default `ENTRIES_MAX`). */
  max?: number;
};

export type Transcripts = {
  /**
   * A hook came for `id` (its meta already moved): its entries, the files read, a snapshot.
   * Resolves once its own step is done (a snapshot after a tool comes later still).
   */
  hook: (id: string, event: string, payload: unknown) => Promise<void>;
  read: (id: string, since: number) => Promise<Outcome<SessionTranscriptData>>;
  revert: (id: string, turn: string, file?: string) => Promise<Outcome<SessionRevertData>>;
  /** Once every read and snapshot asked so far is done. */
  settled: () => Promise<void>;
  close: () => Promise<void>;
};

const Turn = z.object({
  /** The turn's `user` entry id (its `prompt_id`). */
  turn: z.string(),
  at: z.string(),
  /** The worktree's tree at the turn's start; null when it could not be taken (no git there). */
  start: z.string().nullable(),
  /** At its latest snapshot (after a tool that may have written, or at Stop). */
  last: z.string().nullable(),
  /** At its Stop; null while it runs (or one cut off without a Stop). */
  end: z.string().nullable(),
});
type Turn = z.infer<typeof Turn>;
const TurnsFile = z.object({ v: z.literal(1), turns: z.array(Turn) });

type Kept = {
  entries: TranscriptEntry[];
  /** The number of `entries[0]`. */
  base: number;
  /** `kind id` → its number. */
  at: Map<string, number>;
  /** Each file read → the byte offset reached (past its last whole line). */
  offsets: Map<string, number>;
  /**
   * The numbers of your messages put from a UserPromptSubmit hook whose JSONL line has not come
   * yet: the line replaces it, by its id or, under another id, by its words (#185).
   */
  hooked: Set<number>;
  /** The number of the last message of yours a hook put or found: a later hook's is past it. */
  mark: number;
  turns: Turn[];
  /** Read in from the files once (after a restart: all of them, no events). */
  loaded: boolean;
  /** The main transcript was not there at the last read. */
  gone: boolean;
  /** This session's work, one step after another. */
  chain: Promise<void>;
  /** A snapshot after a tool is already waiting in the chain: no second one. */
  snapping: boolean;
  /** A timer read is already waiting in the chain. */
  reading: boolean;
};

const key = (e: Pick<TranscriptEntry, 'kind' | 'id'>) => `${e.kind} ${e.id}`;

/**
 * Your message under an id that already has other words (a second message in one turn's
 * prompt id): found again by its words too.
 */
const wordsKey = (e: TranscriptEntry) =>
  e.kind === 'user' ? `${key(e)} ${JSON.stringify([e.text, e.context])}` : key(e);

/** An unreadable `at` is never earlier than another file's next entry (its own order kept). */
const time = (e: TranscriptEntry) => Date.parse(e.at);

/** The lists merged by `at`, each one's own order kept; the earlier list first on a tie. */
export const byTime = (lists: readonly (readonly TranscriptEntry[])[]): TranscriptEntry[] => {
  const next = lists.map(() => 0);
  const out: TranscriptEntry[] = [];

  for (;;) {
    let pick = -1;

    lists.forEach((l, i) => {
      const e = l[next[i] ?? 0];
      const best = pick < 0 ? undefined : lists[pick]?.[next[pick] ?? 0];

      if (e !== undefined && (best === undefined || time(e) < time(best))) pick = i;
    });
    const list = lists[pick];

    if (list === undefined) return out;
    const i = next[pick] ?? 0;
    const e = list[i];

    if (e !== undefined) out.push(e);
    next[pick] = i + 1;
  }
};

const Payload = z.looseObject({ tool_name: z.string().optional() });

/** Where a subagent's own transcript files are: `<session>/subagents/agent-*.jsonl` beside it. */
const subagentsDir = (transcript: string) => `${transcript.replace(/\.jsonl$/, '')}/subagents`;

export const startTranscripts = (o: TranscriptsOptions): Transcripts => {
  const kept = new Map<string, Kept>();
  const max = o.max ?? ENTRIES_MAX;
  const stamp = () => new Date(o.clock.now()).toISOString();
  const within = `${o.home.replace(/\/+$/, '')}/.claude/projects`;
  const logged = new Set<string>();
  const logOnce = (what: string, message: string) => {
    if (logged.has(what)) return;
    logged.add(what);
    o.log(message);
  };

  const turnsFile = (id: string) => join(sessionDir(o.stateDir, id), 'turns.json');
  const readTurns = (id: string): Turn[] => {
    try {
      const file = turnsFile(id);

      return existsSync(file) ? TurnsFile.parse(JSON.parse(readFileSync(file, 'utf8'))).turns : [];
    } catch {
      return [];
    }
  };
  const writeTurns = (id: string, turns: readonly Turn[]) => {
    const file = turnsFile(id);

    mkdirSync(sessionDir(o.stateDir, id), { recursive: true });
    writeFileSync(`${file}.new`, `${JSON.stringify({ v: 1, turns })}\n`, { mode: 0o600 });
    renameSync(`${file}.new`, file);
  };

  const keptOf = (id: string): Kept => {
    const found = kept.get(id);

    if (found !== undefined) return found;
    const k: Kept = {
      entries: [],
      base: 0,
      at: new Map(),
      offsets: new Map(),
      hooked: new Set(),
      mark: -1,
      turns: [],
      loaded: false,
      gone: false,
      chain: Promise.resolve(),
      snapping: false,
      reading: false,
    };

    kept.set(id, k);

    return k;
  };

  /** Puts `e` at its number (an entry of its kind and id replaced in place), noting the number. */
  const put = (k: Kept, e: TranscriptEntry, touched: Set<number>) => {
    const n = k.at.get(key(e));

    if (n !== undefined && n >= k.base) {
      k.entries[n - k.base] = e;
      touched.add(n);

      return n;
    }

    return append(k, e, touched, true);
  };

  /** `e` after the rest; `keyed`: found again by its kind and id. */
  const append = (k: Kept, e: TranscriptEntry, touched: Set<number>, keyed: boolean) => {
    const next = k.base + k.entries.length;

    k.entries.push(e);
    if (keyed) k.at.set(key(e), next);
    touched.add(next);
    if (k.entries.length > max) {
      const dropped = k.entries.splice(0, k.entries.length - max);

      for (const d of dropped)
        if ((k.at.get(key(d)) ?? -1) < k.base + dropped.length) k.at.delete(key(d));
      k.base += dropped.length;
      for (const h of k.hooked) if (h < k.base) k.hooked.delete(h);
    }

    return next;
  };

  const sameWords = (a: TranscriptEntry | undefined, b: TranscriptEntry) =>
    a?.kind === 'user' &&
    b.kind === 'user' &&
    a.agent === b.agent &&
    a.text === b.text &&
    a.context === b.context;

  /** The first message of yours past the mark with `e`'s words (a hook waiting for none). */
  const readPast = (k: Kept, e: TranscriptEntry) => {
    for (let n = Math.max(k.mark + 1, k.base); n < k.base + k.entries.length; n += 1)
      if (!k.hooked.has(n) && sameWords(k.entries[n - k.base], e)) return n;

    return undefined;
  };

  /**
   * A hook's entry put. Your message (UserPromptSubmit) never replaces one the JSONL gave: Claude
   * Code gives a message sent mid-turn the running turn's prompt_id (#185). One whose line was read
   * already (under its own id) is that one; another goes after the rest, unkeyed, found again by
   * its words when its line comes.
   */
  const putHooked = (k: Kept, e: TranscriptEntry, touched: Set<number>) => {
    if (e.kind !== 'user') return put(k, e, touched);
    const n = k.at.get(key(e));
    const was = n === undefined || n < k.base ? undefined : k.entries[n - k.base];
    const found = n !== undefined && sameWords(was, e) ? n : readPast(k, e);

    if (found !== undefined) {
      k.mark = Math.max(k.mark, found);

      return found;
    }
    const at = was === undefined ? put(k, e, touched) : append(k, e, touched, false);

    k.hooked.add(at);
    k.mark = at;

    return at;
  };

  /** Moves the entry at `from` to the end as `e`: what came after it up one, all of it sent. */
  const moveToEnd = (k: Kept, from: number, e: TranscriptEntry, touched: Set<number>) => {
    k.entries.splice(from - k.base, 1);
    k.entries.push(e);
    const last = k.base + k.entries.length - 1;
    const shift = (n: number) => (n > from ? n - 1 : n);

    for (const [name, n] of k.at) k.at.set(name, shift(n));
    k.hooked = new Set([...k.hooked].map(shift));
    k.mark = shift(k.mark);
    for (let n = from; n <= last; n += 1) touched.add(n);

    return last;
  };

  /**
   * A JSONL line's entry put: in its own place (your message there only with the same words),
   * else your message instead of a hook's of the same words waiting for its line. That one leaves
   * its place for the end, where the line has it (the same list a restart reads, #185). Your
   * message under an id that has other words already is one more, after the rest.
   */
  const putRead = (k: Kept, e: TranscriptEntry, touched: Set<number>) => {
    const n = k.at.get(key(e));
    const was = n === undefined || n < k.base ? undefined : k.entries[n - k.base];
    const other = e.kind === 'user' && was !== undefined && !sameWords(was, e);

    if (n !== undefined && was !== undefined && !other) {
      k.hooked.delete(n);
      put(k, e, touched);

      return;
    }
    if (e.kind !== 'user') {
      put(k, e, touched);

      return;
    }
    const again = other ? k.at.get(wordsKey(e)) : undefined;

    // Read before (the file written anew): in its place.
    if (again !== undefined && again >= k.base) {
      k.entries[again - k.base] = e;
      touched.add(again);

      return;
    }
    const waiting = [...k.hooked]
      .sort((a, b) => a - b)
      .find((h) => sameWords(k.entries[h - k.base], e));

    if (waiting !== undefined) {
      const old = k.entries[waiting - k.base];

      if (old !== undefined && k.at.get(key(old)) === waiting) k.at.delete(key(old));
      k.hooked.delete(waiting);
      k.at.set(other ? wordsKey(e) : key(e), moveToEnd(k, waiting, e, touched));

      return;
    }
    if (other) k.at.set(wordsKey(e), append(k, e, touched, false));
    else put(k, e, touched);
  };

  /** One event per run of numbers touched, oldest first. */
  const send = (id: string, k: Kept, touched: Set<number>) => {
    const numbers = [...touched].filter((n) => n >= k.base).sort((a, b) => a - b);
    let i = 0;

    while (i < numbers.length) {
      const from = numbers[i] ?? 0;
      let to = from;

      while (numbers[i + 1] === to + 1) {
        i += 1;
        to += 1;
      }
      i += 1;
      o.emit({
        session: id,
        from,
        entries: k.entries.slice(from - k.base, to - k.base + 1),
      });
    }
  };

  /** The session's transcript, when its meta names one this session may have. */
  const transcriptOf = (meta: SessionMeta): string | undefined =>
    meta.transcriptPath !== null &&
    isTranscriptPath(meta.transcriptPath, o.home, meta.claudeSession)
      ? meta.transcriptPath
      : undefined;

  /** One file read on from its offset, its whole new lines' entries to `out`; false: not readable. */
  const readFile = async (
    files: TranscriptFiles,
    k: Kept,
    path: string,
    out: TranscriptEntry[],
    stops?: string[],
  ): Promise<boolean> => {
    const from = k.offsets.get(path) ?? 0;
    const read = await files.tail(path, from, within);

    // A link, a file outside the projects folder: never read, as unreadable as one not there.
    if (!read.ok) {
      logOnce(`tail ${path}`, `transcript: ${read.error.message}`);

      return false;
    }
    if (read.data === undefined) return false;
    // Shorter than read so far: written anew, read from its start (entries replace by id).
    if (read.data.size < from) {
      k.offsets.set(path, 0);

      return readFile(files, k, path, out, stops);
    }
    const bytes = read.data.bytes;
    const end = bytes.lastIndexOf(0x0a);

    // No whole line in it: the last one still being written waits; one longer than a read
    // (a big Edit's `originalFile`) is read on to its end.
    if (end < 0)
      return from + bytes.length < read.data.size
        ? readLongLine(files, k, path, from, bytes, out, stops)
        : true;
    const text = new TextDecoder().decode(bytes.subarray(0, end));

    for (const line of text.split('\n')) {
      out.push(...entriesOfLine(line));
      const stopped = stops === undefined ? undefined : interruptedAt(line);

      if (stopped !== undefined) stops?.push(stopped);
    }
    k.offsets.set(path, from + end + 1);
    // A read goes so far at once (a long transcript after a restart): on from where it got.
    if (from + end + 1 < read.data.size) return readFile(files, k, path, out, stops);

    return true;
  };

  /**
   * The line at `from`, longer than one read (`first`), read on to its newline and put whole; one
   * past `LINE_BYTES_MAX` is skipped (logged), so the tail never stalls on it. Nothing moves while
   * its end is not written yet.
   */
  const readLongLine = async (
    files: TranscriptFiles,
    k: Kept,
    path: string,
    from: number,
    first: Uint8Array,
    out: TranscriptEntry[],
    stops?: string[],
  ): Promise<boolean> => {
    const parts = [first];
    let length = first.length;

    for (;;) {
      const read = await files.tail(path, from + length, within);

      // Unreadable or written anew meanwhile: the next read from `from` sees to it.
      if (!read.ok || read.data === undefined || read.data.size < from + length) return true;
      const bytes = read.data.bytes;
      const nl = bytes.indexOf(0x0a);

      if (nl < 0 && (bytes.length === 0 || from + length + bytes.length >= read.data.size))
        return true;
      const part = nl < 0 ? bytes : bytes.subarray(0, nl);

      if (length + part.length <= LINE_BYTES_MAX) parts.push(part);
      length += part.length;
      if (nl < 0) continue;
      if (length > LINE_BYTES_MAX)
        logOnce(`long ${path}`, `transcript: a line of ${length} bytes in ${path} skipped`);
      else {
        const whole = new Uint8Array(length);
        let at = 0;

        for (const p of parts) {
          whole.set(p, at);
          at += p.length;
        }
        out.push(...entriesOfLine(new TextDecoder().decode(whole)));
      }
      k.offsets.set(path, from + length + 1);

      return readFile(files, k, path, out, stops);
    }
  };

  /**
   * The session's transcript and its subagents' files read on, their new entries put in time order
   * (each file's own order kept): a subagent's work goes where it happened, read live or all of it
   * after a restart (#185).
   */
  const catchUp = async (meta: SessionMeta, k: Kept, touched: Set<number>, tell = true) => {
    const files = o.files(meta.card);
    const path = transcriptOf(meta);

    if (path === undefined) return;
    const main: TranscriptEntry[] = [];
    const stops: string[] = [];

    k.gone = !(await readFile(files, k, path, main, stops));
    const stopped = stops.at(-1);

    if (tell && stopped !== undefined) o.interrupted?.(meta.id, stopped);
    const read = [main];

    for (const name of await files.list(subagentsDir(path), within))
      if (/^agent-.+\.jsonl$/.test(name)) {
        const sub: TranscriptEntry[] = [];

        await readFile(files, k, `${subagentsDir(path)}/${name}`, sub);
        read.push(sub);
      }
    for (const e of byTime(read)) putRead(k, e, touched);
  };

  /** The turn's changes from its start to `to`, put when they say something new. */
  const changes = async (meta: SessionMeta, k: Kept, t: Turn, to: string, touched: Set<number>) => {
    if (t.start === null) return;
    const diff = await o.files(meta.card).diff(meta.worktree, t.start, to);

    if (!diff.ok) {
      logOnce(`diff ${meta.id}`, `transcript: ${diff.error.message}`);

      return;
    }
    const patches = patchesOfDiff(diff.data.patch, meta.worktree);
    // Files past the patch's byte cap are still named: counted as cut.
    const read = {
      files: patches.files,
      cut: Math.max(patches.cut, diff.data.names.length - patches.files.length),
    };
    const n = k.at.get(`changes ${t.turn}`);
    const was = n === undefined ? undefined : k.entries[n - k.base];
    const now: ChangesEntry = {
      kind: 'changes',
      id: t.turn,
      at: stamp(),
      agent: null,
      turn: t.turn,
      files: read.files,
      cut: read.cut,
    };

    if (was?.kind === 'changes' ? sameChanges(was, now) : read.files.length === 0) return;
    put(k, now, touched);
  };

  const snapshot = async (meta: SessionMeta) => {
    if (meta.worktree === '') return undefined;
    const tree = await o.files(meta.card).snapshot(meta.worktree);

    if (!tree.ok) logOnce(`snapshot ${meta.id}`, `transcript: ${tree.error.message}`);

    return tree.ok ? tree.data : undefined;
  };

  /** Read in after a restart (or first asked): every file from its start, each turn's changes. */
  const load = async (meta: SessionMeta, k: Kept) => {
    if (k.loaded) return;
    k.loaded = true;
    k.turns = readTurns(meta.id);
    const silent = new Set<number>();

    await catchUp(meta, k, silent, false);
    // A hook from now on is a message after all of these.
    k.mark = k.base + k.entries.length - 1;
    for (const t of k.turns) {
      const to = t.end ?? t.last;

      if (to !== null) await changes(meta, k, t, to, silent);
    }
  };

  /** `work` on `id`'s kept list after the steps before it, its touched numbers sent after. */
  const queue = (
    id: string,
    work: (meta: SessionMeta, k: Kept, touched: Set<number>) => Promise<void>,
  ): Promise<void> => {
    const k = keptOf(id);
    const step = k.chain.then(async () => {
      const meta = o.meta(id);

      if (meta === undefined) return;
      await load(meta, k);
      const touched = new Set<number>();

      try {
        await work(meta, k, touched);
      } finally {
        send(id, k, touched);
      }
    });

    k.chain = step.catch((err: unknown) => {
      o.log(`transcript of ${id}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return k.chain;
  };

  const latest = (k: Kept) => k.turns.at(-1);

  /** The worktree snapshotted again for the latest turn: its `last` (and `end` at Stop) moved. */
  const snapTurn = async (meta: SessionMeta, k: Kept, touched: Set<number>, stop: boolean) => {
    const t = latest(k);

    if (t?.start === undefined || t.start === null) return;
    const tree = await snapshot(meta);

    if (tree === undefined) return;
    // A tool after Stop (a background writer's work merged): the turn goes on.
    const next = { ...t, last: tree, end: stop ? tree : null };

    k.turns[k.turns.length - 1] = next;
    writeTurns(meta.id, k.turns);
    await changes(meta, k, next, tree, touched);
  };

  // The sessions heard from or asked about since this serve started, while they run.
  const timer = setInterval(() => {
    for (const [id, k] of kept) {
      if (k.reading || o.meta(id)?.state === 'ended') continue;
      k.reading = true;
      void queue(id, async (meta, kk, touched) => {
        kk.reading = false;
        await catchUp(meta, kk, touched);
      });
    }
  }, o.everyMs ?? EVERY_MS);

  return {
    hook: (id, event, payload) => {
      const at = stamp();
      const doc = Payload.safeParse(payload);
      const p = doc.success ? doc.data : {};

      if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
        const k = keptOf(id);
        const writes = WRITERS.has(p.tool_name ?? '');

        // The result before the JSONL is read on: what is there now came after the call. A
        // snapshot only when none waits already (it reads the newest files).
        const read = queue(id, async (meta, kk, touched) => {
          for (const e of entriesOfHook({ ...p, hook_event_name: event }, at))
            putHooked(kk, e, touched);
          await catchUp(meta, kk, touched);
        });

        if (!writes || k.snapping) return read;
        k.snapping = true;
        void queue(id, async (meta, kk, touched) => {
          kk.snapping = false;
          await snapTurn(meta, kk, touched, false);
        });

        return read;
      }

      return queue(id, async (meta, k, touched) => {
        const entries = entriesOfHook({ ...p, hook_event_name: event }, at);
        // A turn is your message on: a subagent's hand-back or a task notice Claude Code sends as a
        // prompt mid-turn (t113b's real run) goes on with the turn it came in.
        const turn = entries.find((e) => e.kind === 'user' && e.agent === null)?.id;

        // The turn's start before the agent writes anything (the hook waits on this step).
        if (turn !== undefined && !k.turns.some((t) => t.turn === turn)) {
          // Kept without a start when none could be taken: later work is never the turn before's.
          const start = (await snapshot(meta)) ?? null;

          k.turns.push({ turn, at, start, last: null, end: null });
          writeTurns(meta.id, k.turns);
        }
        // The JSONL first: the agent's text before this tool call is in it by now.
        await catchUp(meta, k, touched);
        for (const e of entries) putHooked(k, e, touched);
        if (event === 'Stop' || event === 'StopFailure') await snapTurn(meta, k, touched, true);
      });
    },
    read: async (id, since) => {
      if (o.meta(id) === undefined) return refused('no-session', `no session ${id}`);
      await queue(id, (meta, k, touched) => catchUp(meta, k, touched));
      const meta = o.meta(id);
      const k = keptOf(id);

      if (meta === undefined) return refused('no-session', `no session ${id}`);
      if (meta.transcriptPath !== null && (transcriptOf(meta) === undefined || k.gone))
        return refused(
          'transcript-unreadable',
          `the transcript of ${id} is not readable here (${meta.transcriptPath})`,
        );
      const from = Math.max(since, k.base);

      return {
        ok: true,
        data: { session: id, from, entries: k.entries.slice(from - k.base) },
      };
    },
    revert: async (id, turn, file) => {
      let answer: Outcome<SessionRevertData> = refused('no-session', `no session ${id}`);

      await queue(id, async (meta, k) => {
        answer = await revertIn(meta, k, turn, file);
      });

      return answer;
    },
    settled: async () => {
      // A step may queue another (a read waiting on the timer's): until none is left.
      for (;;) {
        const chains = [...kept.values()].map((k) => k.chain);

        await Promise.all(chains);
        if ([...kept.values()].every((k, i) => k.chain === chains[i])) return;
      }
    },
    close: async () => {
      clearInterval(timer);
      await Promise.all([...kept.values()].map((k) => k.chain));
    },
  };

  async function revertIn(
    meta: SessionMeta,
    k: Kept,
    turn: string,
    file: string | undefined,
  ): Promise<Outcome<SessionRevertData>> {
    const files = o.files(meta.card);
    const i = k.turns.findIndex((t) => t.turn === turn);
    const t = k.turns[i];

    if (t === undefined) return refused('no-turn', `session ${meta.id} has no turn ${turn}`);
    if (t.start === null)
      return refused('no-snapshot', `turn ${turn} of ${meta.id} has no snapshot of its start`);
    const start = t.start;
    // Still going: working, or waiting on you mid-turn (a question, a permission).
    if (t.end === null && i === k.turns.length - 1 && meta.state !== 'ended')
      return refused('turn-running', `turn ${turn} of ${meta.id} is still running`);
    const end = t.end ?? t.last ?? start;
    const made = await files.diff(meta.worktree, start, end);

    if (!made.ok) return made;
    const root = `${meta.worktree.replace(/\/+$/, '')}/`;
    const wanted = file?.startsWith(root) === true ? file.slice(root.length) : file;
    const names = made.data.names.filter((n) => wanted === undefined || n === wanted);

    if (wanted !== undefined && names.length === 0)
      return refused('not-in-turn', `turn ${turn} did not change ${wanted}`);
    const now = await files.snapshot(meta.worktree);

    if (!now.ok) return now;
    const since = await files.diff(meta.worktree, end, now.data, names);

    if (!since.ok) return since;
    // Moved past the turn's end: refused, unless back at its start already (reverted before).
    const back = await files.diff(meta.worktree, start, now.data, since.data.names);

    if (!back.ok) return back;
    const moved = since.data.names.filter((n) => back.data.names.includes(n));

    if (moved.length > 0)
      return refused(
        'changed-since',
        `changed since turn ${turn}: ${moved.join(', ')} (nothing reverted)`,
      );
    const reverted = new Set(since.data.names);
    const restored = await files.restore(
      meta.worktree,
      start,
      names.filter((n) => !reverted.has(n)),
    );

    if (!restored.ok) return restored;
    const removed = new Set(restored.data.removed);

    return {
      ok: true,
      data: {
        session: meta.id,
        turn,
        restored: names.filter((n) => !removed.has(n) && !reverted.has(n)),
        removed: [...removed],
      },
    };
  }
};

const noTranscripts = () =>
  Promise.resolve(refused('no-sessions', 'this abe serve was started without a session runner'));

export const transcriptHandlers = <Ctx extends SessionCtx>() =>
  ({
    'session transcript': (args, ctx) => {
      const since = args.since ?? 0;

      if (!Number.isInteger(since) || since < 0)
        return Promise.resolve(refused('usage', `--since is an entry number (0, 12): ${since}`, 2));
      const refusal = yours(ctx, args.id);

      if (refusal !== undefined) return Promise.resolve(refusal);
      // A box's session: its own serve reads it.
      if (ctx.session === undefined && ctx.serve.cloud?.knows(args.id) === true)
        return ctx.serve.cloud.forward(args.id, SessionTranscriptData, [
          'session',
          'transcript',
          args.id,
          '--since',
          String(since),
        ]);

      return ctx.serve.transcripts?.read(args.id, since) ?? noTranscripts();
    },
    'session revert': (args, ctx) => {
      const refusal = yours(ctx, args.id);

      if (refusal !== undefined) return Promise.resolve(refusal);
      if (ctx.session === undefined && ctx.serve.cloud?.knows(args.id) === true)
        return ctx.serve.cloud.forward(args.id, SessionRevertData, [
          'session',
          'revert',
          args.id,
          '--turn',
          args.turn,
          ...(args.file === undefined ? [] : ['--file', args.file]),
        ]);

      return ctx.serve.transcripts?.revert(args.id, args.turn, args.file) ?? noTranscripts();
    },
  }) satisfies Partial<Handlers<Ctx>>;
