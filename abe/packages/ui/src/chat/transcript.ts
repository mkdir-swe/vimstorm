/**
 * The rendered Chat's transcript model (#113 S3, slice t113d; boards R-Turn, R-Working,
 * R-Anatomy): a session's transcript entries (`abe session transcript`, `session.transcript`
 * events) grouped into turns and drawn as t113c's parts, changes first.
 *
 * A turn is your message, then the agent's work until your next one: the ChangesBar and one
 * DiffCard per file when it changed code (the turn's `changes` entry, serve's from git, so a
 * Bash `sed` counts; without one, its file tools' patches), its StepRows (core's verb table; the
 * running one last with its time so far), then its Prose, never interleaved. Every turn but the
 * newest folds its steps to `N steps`. A stage change of the session's run is a StageDivider
 * between turns. Subagents' own entries stay out: their Task row says what they did. No spinner:
 * the header's state word is the only sign the agent works.
 *
 * Pure: the entries, the run, the folds and the clock in, the parts and the tree out. Which part
 * the cursor is on, what is unfolded and what was kept are the screen's (`rendered.ts`).
 */
import type { FactoryRunData, FilePatch, TranscriptEntry } from '@abe/core';
import { LAUNCH_NOTE_HEADING, STANDING_LINE } from '@abe/core/launch-words';
import {
  answerWords,
  ASK_TOOL,
  foldTasks,
  isAnswerMessage,
  type Step,
  stepOf,
} from '@abe/core/steps';
import { screenClock, screenWhen } from '@abe/core/when';
import {
  changesBar,
  type DiffLine,
  diffCard,
  type FileChange,
  stepCut,
  stepRow,
  type StepMark,
  type StepRow,
  type Transcript,
  type TranscriptFind,
} from './chat-components';
import type { Node } from '../runtime/components';
import { ABANDONED, NOT_REPRODUCED, railStageIn, timeIn } from '../board/flow';

type Use = Extract<TranscriptEntry, { kind: 'tool-use' }>;
type Result = Extract<TranscriptEntry, { kind: 'tool-result' }>;
type Changes = Extract<TranscriptEntry, { kind: 'changes' }>;

/** A session's entries by their number (`from` + index); a hole is a number not read yet. */
export type Log = readonly (TranscriptEntry | undefined)[];

/**
 * Entries put at their numbers, each replacing what was held there (serve sends a replacement
 * under its old number, `session.transcript`).
 */
export const putEntries = (log: Log, from: number, entries: readonly TranscriptEntry[]): Log => {
  // the next entries, as they nearly always come: put after the rest in one go
  if (from === log.length) return log.concat(entries);
  const out: (TranscriptEntry | undefined)[] = Array.from(
    { length: Math.max(log.length, from + entries.length) },
    (_, i) => log[i],
  );

  entries.forEach((e, i) => {
    out[from + i] = e;
  });

  return out;
};

/** The next number to read from: one past the last entry held. */
export const nextNumber = (log: Log): number => log.length;

/** One step row's words and what ⏎ unfolds. */
export type TurnStep = {
  /** The tool call's id (the first of folded Task rows). */
  id: string;
  /** Folded Task rows: every call's id, the first's too. */
  calls?: readonly string[] | undefined;
  step: Step;
  /** When the call started: a running step's time so far. */
  at: string;
  /** When its result came; none while it runs (or it never came). */
  done?: string | undefined;
  /** Its result's text, by line (an unfolded row shows the first 10). */
  output: string[];
};

/** A file the turn changed, as its diff card draws it, and where ⏎ opens it. */
export type TurnFile = FileChange & {
  /** Absolute, as the worktree has it. */
  abs: string;
  /** The first changed line on the file's new side (1-based). */
  line: number;
};

export type Turn = {
  /** Your message's entry id (`session revert --turn`); `start` for entries before any. */
  id: string;
  message?: { text: string; context: string | null } | undefined;
  /**
   * Your answer to a card (#275), as its folded line says it: drawn as that line, not as a
   * message of yours, and the turn that asked stays open as the newest does (its steps shown),
   * since the agent goes on with it. The transcript keeps it, so the line outlives the app.
   */
  answer?: { head: string; text: string; n?: number | undefined; prompt: string } | undefined;
  at: string;
  steps: TurnStep[];
  prose: string[];
  files: TurnFile[];
};

/** A path under the worktree, relative to it; any other as it is. */
export const relative = (path: string, root: string | undefined): string => {
  if (root === undefined) return path;
  const base = `${root.replace(/\/+$/, '')}/`;

  return path.startsWith(base) ? path.slice(base.length) : path;
};

/** A patch's hunks as diff lines, each numbered on its own side (a context line: the new side). */
const linesOf = (p: FilePatch): DiffLine[] =>
  p.hunks.flatMap((h) => {
    let old = h.oldStart;
    let now = h.newStart;
    const num = (n: number) => (n > 0 ? { number: n } : {});

    return h.lines.flatMap((l): DiffLine[] => {
      const text = l.slice(1);

      if (l.startsWith('+')) return [{ kind: 'inserted', ...num(now++), text }];
      if (l.startsWith('-')) return [{ kind: 'deleted', ...num(old++), text }];
      if (l.startsWith('\\')) return [];
      old++;

      return [{ kind: 'context', ...num(now++), text }];
    });
  });

/** The first changed line on the new side: the first inserted line's, or where a deletion was. */
const firstChanged = (p: FilePatch): number => {
  for (const h of p.hunks) {
    let now = h.newStart;

    for (const l of h.lines) {
      if (l.startsWith('+') || l.startsWith('-')) return Math.max(1, now);
      if (!l.startsWith('\\')) now++;
    }
  }

  return 1;
};

const fileOf = (p: FilePatch, root: string | undefined): TurnFile => ({
  path: relative(p.path, root),
  abs: p.path,
  added: p.added,
  removed: p.removed,
  lines: linesOf(p),
  line: firstChanged(p),
});

/** A file tool's patches of one file, joined in the order they came. */
const joined = (a: TurnFile, b: TurnFile): TurnFile => ({
  ...a,
  added: a.added + b.added,
  removed: a.removed + b.removed,
  lines: [...a.lines, ...b.lines],
});

/** The paths a tool call names (`file_path`, `notebook_path`), absolute as the tool has them. */
const pathsOf = (u: Use): string[] =>
  ['file_path', 'notebook_path', 'path']
    .map((k) => u.input[k])
    .filter((v): v is string => typeof v === 'string');

type Building = {
  turn: Turn;
  /** A grill round's answers. */
  round?: boolean;
  uses: Use[];
  results: Map<string, Result>;
  patches: FilePatch[];
  /** `abe improve`'s blocks put among the prose. */
  blocks: Set<string>;
};

/** The head of `abe improve`'s answer block (core's `improveText`): its label, Fix here or Send to Abe. */
const IMPROVE_LABEL = /^\*\*(Fix here|Send to Abe)\*\* · /;
/** The line after the block: the agent's, never shown. */
const IMPROVE_NEXT = 'Next (for you, not to show):';
/** A Fix here block's last line, under its diff. */
const IMPROVE_APPLY = 'abe improve apply ';

/** A Bash call running `abe improve` (a wish, `suggest`, `retro …`). */
const improveCall = (u: Use): boolean =>
  u.tool === 'Bash' &&
  typeof u.input.command === 'string' &&
  /\babe improve\b/.test(u.input.command);

/**
 * `abe improve`'s answer block in its output, as the person reads it (P4): the label line, then a
 * Send to Abe draft's title and whole body, or a Fix here change with its diff fenced; the `Next`
 * line for the agent left out. Undefined: the output has none.
 */
export const improveBlock = (text: string): string | undefined => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => IMPROVE_LABEL.test(l));

  if (start < 0) return undefined;
  const next = lines.findIndex((l, i) => i > start && l.startsWith(IMPROVE_NEXT));
  const block = lines.slice(start, next < 0 ? undefined : next);

  while (block.length > 1 && block.at(-1)?.trim() === '') block.pop();
  const [label, ...rest] = block;

  if (label === undefined) return undefined;
  const apply = rest.findLastIndex((l) => l.startsWith(IMPROVE_APPLY));

  if (!label.startsWith('**Fix here**') || apply < 0) return block.join('\n');
  const diff = rest.slice(0, apply);

  while (diff[0]?.trim() === '') diff.shift();
  while (diff.length > 0 && diff.at(-1)?.trim() === '') diff.pop();

  return [label, '', '```diff', ...diff, '```', '', ...rest.slice(apply)].join('\n');
};

/** Task rows next to each other as one row (core's `foldTasks`), under the first call's id. */
const foldedSteps = (steps: readonly TurnStep[]): TurnStep[] => {
  const out: TurnStep[] = [];
  let run: TurnStep[] = [];
  const flush = () => {
    const [head] = run;

    if (head !== undefined) {
      const [step] = foldTasks(run.map((s) => s.step));

      // done when the run's last is: a line asked during a later Task goes before the row (#307)
      const dones = run.map((x) => x.done);
      const done = dones.every((d) => d !== undefined)
        ? dones.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a))
        : undefined;
      out.push(
        run.length === 1 || step === undefined
          ? head
          : {
              id: head.id,
              calls: run.map((x) => x.id),
              at: head.at,
              ...(done === undefined ? {} : { done }),
              step,
              output: [],
            },
      );
    }
    run = [];
  };

  for (const s of steps) {
    if (s.step.verb === 'Task') {
      run.push(s);
      continue;
    }
    flush();
    out.push(s);
  }
  flush();

  return out;
};

/**
 * The turn's files: its `changes` entry's (git's, ordered as the turn first touched them, the
 * rest in git's order), else its file tools' patches joined per file, in the order first touched.
 */
const filesOf = (b: Building, changes: Changes | undefined, root: string | undefined) => {
  const touched = [...b.uses.flatMap(pathsOf), ...b.patches.map((p) => p.path)];
  const rank = (abs: string) => {
    const at = touched.indexOf(abs);

    return at < 0 ? touched.length : at;
  };

  if (changes !== undefined)
    return changes.files
      .map((p, i) => ({ f: fileOf(p, root), i }))
      .sort((x, y) => rank(x.f.abs) - rank(y.f.abs) || x.i - y.i)
      .map((x) => x.f);
  const by = new Map<string, TurnFile>();

  for (const p of b.patches) {
    const f = fileOf(p, root);
    const had = by.get(f.abs);

    by.set(f.abs, had === undefined ? f : joined(had, f));
  }

  return [...by.values()];
};

/**
 * An answer prompt's line, as the cards fold it: `Answered · Magic link (1)`; a grill round's
 * `Answered · Round 2 · 3 questions`, counting the rounds answered before it.
 */
const answerLine = (text: string, before: readonly Building[]): NonNullable<Turn['answer']> => {
  const w = answerWords(text);
  const prompt = text;

  if (w.questions === undefined)
    return { head: 'Answered', text: w.text, ...(w.n === undefined ? {} : { n: w.n }), prompt };
  const round = 1 + before.filter((b) => b.round).length;

  return {
    head: 'Answered',
    text: `Round ${round} · ${w.questions} question${w.questions === 1 ? '' : 's'}`,
    prompt,
  };
};

/** What a call that never got its result is read as: it failed, with nothing to say. */
const STOPPED = { ok: false, text: '', patch: null } as const;

const outputOf = (r: Result | undefined): string[] => {
  if (r === undefined || r.text === '') return [];
  const lines = r.text.replace(/\n+$/, '').split('\n');

  return r.cut > 0 ? [...lines, `… ${r.cut} characters left out`] : lines;
};

/** Your message's bubble; Abe's own start and reopen prompts have none (the turn stays). */
const messageOf = (e: { text: string; context: string | null; abe?: true | undefined }) =>
  e.abe === true ? {} : { message: { text: e.text, context: e.context } };

/** The turns built so far from a log's entries: what a log grown by more entries goes on from. */
type Built = {
  log: Log;
  built: Building[];
  changes: Map<string, Changes>;
  byUse: Map<string, Building>;
  byTurn: Map<string, Building>;
  open: Building | undefined;
  /** Each building's turn as last put out, with the `running` it was put out with. */
  out: Map<Building, { turn: Turn; running: boolean }>;
  /** Buildings an entry moved since they were last put out. */
  dirty: Set<Building>;
  root: string | undefined;
};

/** The logs built last (a few Chats kept): a log they are the start of goes on from there. */
const BUILT: Built[] = [];
const BUILT_KEPT = 4;

/** Whether `log` is `was` with more entries after it, every entry of `was` the same one. */
const grownFrom = (was: Log, log: Log): boolean => {
  if (log.length < was.length) return false;
  for (let i = 0; i < was.length; i += 1) if (log[i] !== was[i]) return false;

  return true;
};

const freshBuilt = (root: string | undefined): Built => ({
  log: [],
  built: [],
  changes: new Map(),
  byUse: new Map(),
  byTurn: new Map(),
  open: undefined,
  out: new Map(),
  dirty: new Set(),
  root,
});

/** `entries` put into the turns built so far, each building they move marked to put out anew. */
const feed = (b: Built, entries: readonly (TranscriptEntry | undefined)[]): void => {
  const start = (turn: Turn): Building => {
    const one: Building = { turn, uses: [], results: new Map(), patches: [], blocks: new Set() };

    b.built.push(one);
    b.byTurn.set(turn.id, one);
    b.dirty.add(one);

    return one;
  };
  const current = (at: string): Building => {
    b.open ??= start({ id: 'start', at, steps: [], prose: [], files: [] });
    b.dirty.add(b.open);

    return b.open;
  };

  for (const e of entries) {
    if (e?.agent !== null) continue;
    switch (e.kind) {
      case 'user':
        b.open = start({
          id: e.id,
          ...(isAnswerMessage(e.text) ? { answer: answerLine(e.text, b.built) } : messageOf(e)),
          at: e.at,
          steps: [],
          prose: [],
          files: [],
        });
        b.open.round = isAnswerMessage(e.text) && answerWords(e.text).questions !== undefined;
        break;
      case 'tool-use': {
        // an AskUserQuestion is asked in Chat (#114): its card, then its answered line, stand in.
        // Never a row, not even while it waits for its result: one would show over the card and
        // go when the result comes, moving the card (#274)
        if (e.tool === ASK_TOOL) break;
        const one = current(e.at);

        one.uses.push(e);
        b.byUse.set(e.id, one);
        break;
      }
      case 'tool-result': {
        const one = b.byUse.get(e.id);

        if (one === undefined) break;
        b.dirty.add(one);
        one.results.set(e.id, e);
        if (e.patch !== null) one.patches.push(e.patch);
        // `abe improve`'s draft or change shown as the turn's words, not only folded in its step,
        // so it is read before File it or Apply whatever the agent writes
        const use = one.uses.find((u) => u.id === e.id);
        const block = use !== undefined && improveCall(use) ? improveBlock(e.text) : undefined;

        if (block !== undefined) {
          one.turn.prose.push(block);
          one.blocks.add(block);
        }
        break;
      }
      case 'assistant-text':
        current(e.at).turn.prose.push(e.text);
        break;
      case 'changes': {
        b.changes.set(e.turn, e);
        const named = b.byTurn.get(e.turn);

        if (named !== undefined) b.dirty.add(named);
        break;
      }
      case 'compact':
        break;
    }
  }
};

/** One building as its turn: its steps (a call with no result runs only while `running`), files, words. */
const turnOut = (b: Building, running: boolean, changes: Built['changes'], root?: string): Turn => {
  const where = root === undefined ? {} : { root };
  const steps = b.uses.map((u) => {
    const result = b.results.get(u.id);
    const step =
      result !== undefined || running
        ? stepOf(u, result ?? null, where)
        : { ...stepOf(u, STOPPED, where), result: 'stopped' };

    return {
      id: u.id,
      step,
      at: u.at,
      ...(result === undefined ? {} : { done: result.at }),
      output: outputOf(result),
    };
  });
  const files = filesOf(b, changes.get(b.turn.id), root);
  // a block the agent pasted itself (its label line among its words) is shown once, its paste
  const words = b.turn.prose.filter((p) => !b.blocks.has(p));
  const prose = b.turn.prose.filter(
    (p) => !b.blocks.has(p) || !words.some((w) => w.includes(p.split('\n')[0] ?? '')),
  );

  return { ...b.turn, steps: foldedSteps(steps), files, prose };
};

/**
 * The entries as turns, oldest first. Subagents' entries are left out (their Task row stands for
 * them); a result goes to its call's step; a `changes` entry to the turn it names. A call with
 * no result runs only in the newest turn of a `live` session; anywhere else it was stopped (Esc,
 * the session ended): its past verb, failed, `stopped`. A log that grew by entries goes on from
 * the turns its start built: only the turns its new entries moved are built again.
 */
export const turnsOf = (log: Log, root?: string, o: { live?: boolean } = {}): Turn[] => {
  const at = BUILT.findIndex((b) => b.root === root && grownFrom(b.log, log));
  const b = at === -1 ? freshBuilt(root) : (BUILT.splice(at, 1)[0] ?? freshBuilt(root));

  feed(b, log.slice(b.log.length));
  b.log = log;
  BUILT.unshift(b);
  BUILT.length = Math.min(BUILT.length, BUILT_KEPT);
  const live = o.live ?? true;

  return b.built.map((one, i) => {
    const running = live && i === b.built.length - 1;
    const had = b.out.get(one);

    if (had?.running === running && !b.dirty.has(one)) return had.turn;
    const turn = turnOut(one, running, b.changes, root);

    b.out.set(one, { turn, running });
    b.dirty.delete(one);

    return turn;
  });
};

/** Where a run that ended without shipping ends on Chat's stage dividers, in place of Done. */
const ENDED_IN: Readonly<Partial<Record<NonNullable<FactoryRunData['outcome']>, string>>> = {
  abandoned: ABANDONED,
  'not-reproduced': NOT_REPRODUCED,
};

/** A stage change of the session's run: `Build → Review` at `at`. */
export type Divider = { id: string; from: string; to: string; at: string };

/** The run's rail stage changes, from its finished stages (each ended into the next, or the current). */
export const dividersOf = (
  run:
    | (Pick<FactoryRunData, 'stages' | 'stage'> & Partial<Pick<FactoryRunData, 'outcome'>>)
    | undefined,
): Divider[] => {
  if (run === undefined) return [];

  return run.stages.flatMap((s, i) => {
    const next = run.stages[i + 1]?.stage ?? run.stage;
    // a plain step stays on the stage before it (playbook on verify's Review): no divider
    const from = railStageIn(s.stage, run.stages.slice(0, i));
    // given up: it ended in Abandoned (#229) or Not reproduced (#320), not Done
    const over =
      next === 'done' && run.outcome !== null && run.outcome !== undefined
        ? ENDED_IN[run.outcome]
        : undefined;
    const to = over ?? railStageIn(next, run.stages.slice(0, i + 1));

    return from === to ? [] : [{ id: `stage:${i}`, from, to, at: s.endedAt }];
  });
};

/**
 * Where a reopened session's conversation went on (#343): `── Reopened 09:14 ──`, one per reopen
 * (a divider with no `to` is a mark of its own).
 */
export const reopenedDividers = (session: { reopened?: readonly string[] }): Divider[] =>
  (session.reopened ?? []).map((at, i) => ({ id: `reopened:${i}`, from: 'Reopened', to: '', at }));

/** `12:41`: an RFC 3339 time on this Mac's clock, from its own instant (#260, core's `screenClock`). */
export const clockOf = (at: string, now?: string): string => screenClock(at, now);

/**
 * `@api/src/cart.ts#L12-18`, `@api/src/cart.ts:16`, `#2 The cart total ignores quantity · story`:
 * the chip of your message's implicit context (#115's forms), else its words as they are.
 */
export const chipOf = (context: string): string => {
  const lines = /^(.+) lines (\d+)[–-](\d+)/.exec(context);

  if (lines !== null) return `@${lines[1] ?? ''}#L${lines[2] ?? ''}-${lines[3] ?? ''}`;
  const caret = /^(.+), caret on line (\d+)/.exec(context);

  if (caret !== null) return `@${caret[1] ?? ''}:${caret[2] ?? ''}`;
  const story = /^story (#\d+.*)$/.exec(context);

  return story === null ? context : `${story[1] ?? ''} · story`;
};

/**
 * A launch prompt's first line (core's `launchPrompt`): `Work on card AB#4: <title>`, a board on
 * this machine's `L-4`, a GitHub board's `#4`.
 */
const LAUNCH_LINE = /^Work on card (?:AB#|L-|#)(\d+): (.+)$/;

/**
 * Your message as Chat shows it (#308). A launch prompt (core's `launchPrompt`, a Factory run's
 * with its `/<plugin>:<skill>` before it) is its first line, the card's description it carried
 * the `#4 <title> · story` chip; the story dialog has it in full. Anything else as you typed it.
 */
export const messageShown = (m: {
  text: string;
  context: string | null;
}): { text: string; context?: string } => {
  const plain = m.text.replace(/^\/[a-z0-9-]+:[a-z0-9-]+\s+(?=Work on card (?:AB#|L-|#)\d)/, '');
  const [first = '', ...rest] = plain.split('\n');
  const launch = LAUNCH_LINE.exec(first);
  const parts = launch === null ? undefined : launchParts(rest);
  // the card's description went along: the story chip says so
  const story =
    launch !== null && parts?.card.some((l) => l.trim() !== '') === true
      ? `story #${launch[1] ?? ''} ${launch[2] ?? ''}`
      : undefined;
  const context = m.context ?? story;

  return {
    text: launch === null || parts === undefined ? m.text : `${first}${parts.notes}`,
    ...(context === undefined ? {} : { context: chipOf(context) }),
  };
};

/** The Grill ask a launch prompt before 3.3 ended with: never part of the note. */
const ASK_LINES: ReadonlySet<string> = new Set([
  'The person asked to be grilled first: decide with --grill, whatever you would pick.',
  'The person asked to just build: decide with --no-grill; the spec is still your choice.',
]);

/** A line that ends a Launch note: the prototype reference's heading (#351), an old Grill ask. */
const afterNote = (l: string): boolean => l.startsWith('## Prototype') || ASK_LINES.has(l);

/** The last index in `lines` where `test` holds, or -1. */
const lastWhere = (lines: readonly string[], test: (l: string, i: number) => boolean): number => {
  for (let i = lines.length - 1; i >= 0; i -= 1) if (test(lines[i] ?? '', i)) return i;

  return -1;
};

/**
 * A launch prompt's parts after its first line (#347, core's `launchPrompt` + `notesPrompt`): the
 * card's own text, and what Chat shows under the first line, your Launch note and a quiet
 * `+ 2 standing notes`. Read from the end, so a card description with a `## Notes from …`
 * heading of its own is the card's.
 */
const launchParts = (rest: readonly string[]): { card: readonly string[]; notes: string } => {
  // the standing notes: the last `## Standing notes` followed only by their lines
  const standingAt = lastWhere(rest, (l, i) => {
    if (l !== '## Standing notes') return false;
    const after = rest.slice(i + 1);
    const stop = after.findIndex((x) => x.trim() === '');
    const block = stop < 0 ? after : after.slice(0, stop);

    return block.length > 0 && block.every((x) => STANDING_LINE.test(x));
  });
  const standingEnd =
    standingAt < 0 ? -1 : rest.findIndex((l, i) => i > standingAt && l.trim() === '');
  const standing =
    standingAt < 0 ? 0 : (standingEnd < 0 ? rest.length : standingEnd) - standingAt - 1;
  const noteAt = lastWhere(
    rest,
    (l, i) => LAUNCH_NOTE_HEADING.test(l) && (standingAt < 0 || i < standingAt),
  );
  const noteEnd = (() => {
    if (noteAt < 0) return -1;
    const stop = rest.findIndex((l, i) => i > noteAt && (i === standingAt || afterNote(l)));

    return stop < 0 ? rest.length : stop;
  })();
  const note =
    noteAt < 0
      ? ''
      : rest
          .slice(noteAt + 1, noteEnd)
          .join('\n')
          .trim();
  const cardEnd = [noteAt, standingAt, rest.findIndex((l) => afterNote(l))]
    .filter((i) => i >= 0)
    .reduce((a, b) => Math.min(a, b), rest.length);
  const notes = [
    ...(note === '' ? [] : [note]),
    ...(standing === 0 ? [] : [`_+ ${standing} standing note${standing === 1 ? '' : 's'}_`]),
  ]
    .map((part) => `\n\n${part}`)
    .join('');

  return { card: rest.slice(0, cardEnd), notes };
};

/** What the screen keeps of the transcript's look: the cursor and what was opened or kept. */
export type Folds = {
  /** The focusable part the cursor is on (its node id). */
  cursor?: string | undefined;
  /** Step rows showing their output. */
  unfolded: readonly string[];
  /** Earlier turns whose steps show as rows instead of `N steps`. */
  opened: readonly string[];
  /**
   * Diff cards opened and folded by hand: each starts as its place says (the newest turn's first
   * open, the rest folded) until then, and stays so as turns come.
   */
  shown: readonly string[];
  hidden: readonly string[];
  /** Diff cards showing every line (`show N more`). */
  full: readonly string[];
  /** Turns whose changes were kept (Keep): their bar dim. */
  kept: readonly string[];
};

export const NO_FOLDS: Folds = {
  unfolded: [],
  opened: [],
  shown: [],
  hidden: [],
  full: [],
  kept: [],
};

/** The parts' node ids, one rule for the tree and the screen's keys. */
export const ids = {
  transcript: 'chat:transcript',
  turn: (t: string) => `turn:${t}`,
  message: (t: string) => `msg:${t}`,
  bar: (t: string) => `bar:${t}`,
  /** By its path, so a card keeps its cursor and folds when the turn's files change. */
  diff: (t: string, path: string) => `diff:${t}:${path}`,
  more: (t: string, path: string) => `diff:${t}:${path}:more`,
  step: (s: string) => `step:${s}`,
  /** An answer prompt's line (#275). */
  answer: (t: string) => `answer:${t}`,
  steps: (t: string) => `steps:${t}`,
  prose: (t: string) => `prose:${t}`,
  newBelow: 'chat:new',
};

/** A part the cursor stops on, and what ⏎ / `u` act on there. */
export type Stop =
  | { kind: 'bar'; id: string; turn: Turn }
  | { kind: 'diff'; id: string; turn: Turn; file: TurnFile; n: number }
  | { kind: 'more'; id: string; card: string }
  | { kind: 'step'; id: string; step: TurnStep }
  | { kind: 'steps'; id: string; turn: Turn }
  | { kind: 'new'; id: string };

/**
 * Where the open turns start: the newest, and the turns it continues while it and those after it
 * are answers to cards (#275): answering a question does not fold the work that asked it.
 */
export const openFrom = (turns: readonly Pick<Turn, 'answer'>[]): number => {
  let i = turns.length - 1;

  while (i > 0 && turns[i]?.answer !== undefined) i--;

  return Math.max(0, i);
};

/** Whether a diff card is folded: as folded by hand, else folded but the newest turn's first. */
export const isFolded = (folds: Folds, id: string, newest: boolean, n: number): boolean => {
  if (folds.hidden.includes(id)) return true;
  if (folds.shown.includes(id)) return false;

  return !(newest && n === 0);
};

/** Every turn's steps but the newest's fold to `N steps` until opened. */
const stepsShown = (folds: Folds, turn: Turn, newest: boolean): boolean =>
  newest || folds.opened.includes(turn.id);

/**
 * Where things asked inside a turn go among its step rows (#307): before the first step still
 * running when it was asked, or started after (a permission's line before the call it held and
 * the work it allowed), by the index of that step. One with no such step (a question that ended
 * the turn) is not placed: it goes after the turn. Only while the turn shows its rows.
 */
export const placedInTurn = <T extends { at: string }>(
  turn: Turn,
  next: Turn | undefined,
  items: readonly T[],
  shown: boolean,
): Map<number, T[]> => {
  const out = new Map<number, T[]>();

  if (!shown) return out;
  const time = (t: string | undefined) => (t === undefined ? Infinity : Date.parse(t));

  for (const x of items) {
    const at = time(x.at);

    if (at <= time(turn.at) || at > time(next?.at)) continue;
    // a step that never got its result and runs no more (stopped) ended where it started
    const k = turn.steps.findIndex(
      (s) => time(s.done ?? (s.step.glyph === 'running' ? undefined : s.at)) > at,
    );

    if (k >= 0) out.set(k, [...(out.get(k) ?? []), x]);
  }

  return out;
};

/** `taken` out of `list`, in place. */
const drop = <T>(list: T[], taken: readonly T[]) => {
  list.splice(0, list.length, ...list.filter((x) => !taken.includes(x)));
};

/** The parts the cursor walks, top to bottom; `↓ N new` last while it shows. */
export const stopsOf = (
  turns: readonly Turn[],
  folds: Folds,
  o: { newBelow?: boolean } = {},
): Stop[] => {
  const open = openFrom(turns);
  const inTurns = turns.flatMap((turn, i): Stop[] => {
    const newest = i >= open;
    const shownRows = stepsShown(folds, turn, newest);
    const files = turn.files.flatMap((file, n): Stop[] => {
      const id = ids.diff(turn.id, file.path);
      const cut =
        !isFolded(folds, id, newest, n) &&
        !folds.full.includes(id) &&
        diffCard(id, file).props.more !== undefined;

      return [
        { kind: 'diff', id, turn, file, n },
        ...(cut ? [{ kind: 'more' as const, id: ids.more(turn.id, file.path), card: id }] : []),
      ];
    });
    const rows: Stop[] = turn.steps.flatMap((step): Stop[] => {
      const id = ids.step(step.id);
      // an unfolded step's output past its first lines: `show N more` (#343)
      const cut = folds.unfolded.includes(id) && stepCut(step.output, folds.full.includes(id));

      return [
        { kind: 'step', id, step },
        ...(cut ? [{ kind: 'more' as const, id: `${id}:more`, card: id }] : []),
      ];
    });
    const fold: Stop[] = [{ kind: 'steps', id: ids.steps(turn.id), turn }];
    const shown = shownRows ? rows : fold;
    const steps = turn.steps.length === 0 ? [] : shown;

    return [
      ...(turn.files.length > 0 ? [{ kind: 'bar' as const, id: ids.bar(turn.id), turn }] : []),
      ...files,
      ...steps,
    ];
  });
  return o.newBelow === true ? [...inTurns, { kind: 'new', id: ids.newBelow }] : inTurns;
};

const MARK: Readonly<Record<Step['glyph'], StepMark>> = {
  ok: 'good',
  failed: 'bad',
  running: 'live',
};

const PATH_VERBS = new Set(['Read', 'Reading', 'Edited', 'Editing', 'Wrote', 'Writing']);
const COMMAND_VERBS = new Set(['Ran', 'Running']);
const PATH_LIKE = new Set(['Created', 'Creating', 'Listed', 'Listing']);

const objectKind = (verb: string): StepRow['props']['objectKind'] => {
  if (PATH_VERBS.has(verb) || PATH_LIKE.has(verb)) return 'path';

  return COMMAND_VERBS.has(verb) ? 'command' : 'text';
};

/** A step's row: its mark, verb, object, result; running, its time so far. */
const rowOf = (s: TurnStep, folds: Folds, now: string | undefined, selected: boolean): StepRow => {
  const id = ids.step(s.id);
  const time = s.step.glyph === 'running' ? timeIn(s.at, now) : '';

  return stepRow(
    id,
    {
      mark: MARK[s.step.glyph],
      verb: s.step.verb,
      ...(s.step.object === ''
        ? {}
        : { object: s.step.object, objectKind: objectKind(s.step.verb) }),
      ...(s.step.result === null ? {} : { result: s.step.result }),
      ...(time === '' ? {} : { time }),
      ...(selected ? { selected: true } : {}),
    },
    {
      output: s.output,
      unfolded: folds.unfolded.includes(id),
      full: folds.full.includes(id),
      moreSelected: folds.cursor === `${id}:more`,
    },
  );
};

export type TreeOptions = {
  /** The tick's time: a running step's time so far. */
  now?: string | undefined;
  /** A teammate's: no Keep, Revert or `u`. */
  readOnly?: boolean | undefined;
  /** Scrolled up while this many new entries came: `↓ N new` under the parts. */
  newBelow?: number | undefined;
  /** The shell's scroll moves: `reveal` the cursor's part, `bottom` a counter. */
  reveal?: string | undefined;
  bottom?: number | undefined;
  /**
   * Nodes placed among the turns by time, as the stage dividers are (#114's answered cards'
   * lines, each at its asking time): before the first turn that started after `at`.
   */
  /**
   * `question`: a card's line whose answer goes as the session's next prompt (#275), by its
   * (first) question: once that prompt is in the transcript, its line there stands instead.
   */
  placed?: readonly { at: string; node: Node; question?: string | undefined }[] | undefined;
  /** Nodes after the last turn, above `↓ N new` (#114's open card). */
  tail?: readonly Node[] | undefined;
  /** The session it is: the shell keeps the scroll by it. */
  session?: string | undefined;
  /** Find's bar at its top and the matches it marks (`find.ts`). */
  find?: TranscriptFind | undefined;
  /** The Abe chat's: Abe's face behind its parts. */
  mark?: 'abe' | undefined;
};

/**
 * One turn's agent part: changes, diff cards, steps (or `N steps`), prose; `inside`: nodes asked
 * during it, each before the step row of its index (`placedInTurn`).
 */
const turnNode = (
  turn: Turn,
  newest: boolean,
  folds: Folds,
  o: TreeOptions,
  inside: ReadonlyMap<number, readonly Node[]> = new Map(),
): Node[] => {
  const at = (id: string) => folds.cursor === id;
  const parts: Node[] = [];

  if (turn.files.length > 0) {
    const bar = changesBar(ids.bar(turn.id), turn.files);
    const kept = folds.kept.includes(turn.id);

    parts.push({
      ...bar,
      props: {
        ...bar.props,
        ...(o.readOnly === true
          ? { actions: (bar.props.actions ?? []).filter((a) => a.id.endsWith(':open-all')) }
          : {}),
        ...(kept ? { kept: true } : {}),
        ...(at(bar.id ?? '') ? { selected: true } : {}),
      },
    });
    turn.files.forEach((file, n) => {
      const id = ids.diff(turn.id, file.path);
      const card = diffCard(id, file, {
        folded: isFolded(folds, id, newest, n),
        full: folds.full.includes(id),
        selected: at(id),
      });
      const more = card.props.more;

      parts.push({
        ...card,
        props: {
          ...card.props,
          ...(o.readOnly === true && card.props.folded !== true ? { note: '⏎ open' } : {}),
          ...(more !== undefined && at(ids.more(turn.id, file.path))
            ? { more: { ...more, selected: true } }
            : {}),
        },
      });
    });
  }
  if (turn.steps.length > 0) {
    if (stepsShown(folds, turn, newest))
      parts.push(
        ...turn.steps.flatMap((s, k) => [
          ...(inside.get(k) ?? []),
          rowOf(s, folds, o.now, at(ids.step(s.id))),
        ]),
      );
    else
      parts.push({
        kind: 'StepsFold',
        id: ids.steps(turn.id),
        props: {
          count: turn.steps.length,
          ...(at(ids.steps(turn.id)) ? { selected: true } : {}),
        },
      });
  }
  if (turn.prose.length > 0)
    parts.push({
      kind: 'Prose',
      id: ids.prose(turn.id),
      props: { markdown: turn.prose.join('\n\n') },
    });

  return parts;
};

/**
 * Each question the turns' answer prompts answer (`Answer to "<question>": `, numbered or not),
 * with when it was answered last: one pass over the turns. A prompt is put under every question
 * it could start with (a question may hold `": ` itself).
 */
const answersOf = (turns: readonly Turn[]): ReadonlyMap<string, number> => {
  const last = new Map<string, number>();

  for (const t of turns) {
    const prompt = t.answer?.prompt;

    if (prompt === undefined) continue;
    const head = ['Answer to "', '1. Answer to "'].find((h) => prompt.startsWith(h));

    if (head === undefined) continue;
    const at = Date.parse(t.at);

    for (
      let end = prompt.indexOf('": ', head.length);
      end !== -1;
      end = prompt.indexOf('": ', end + 1)
    ) {
      const q = prompt.slice(head.length, end);

      last.set(q, Math.max(last.get(q) ?? -Infinity, at));
    }
  }

  return last;
};

/** A question's answered line the transcript says itself: its answer prompt came after it. */
const answeredIn = (
  answers: ReadonlyMap<string, number>,
  x: { at: string; question?: string | undefined },
) => x.question !== undefined && (answers.get(x.question) ?? -Infinity) > Date.parse(x.at);

/**
 * The Transcript node: each turn's message and agent part, a divider before the first turn after
 * it (or at the end), `↓ N new` pinned under them while scrolled up.
 */
export const transcriptNode = (
  turns: readonly Turn[],
  dividers: readonly Divider[],
  folds: Folds,
  o: TreeOptions = {},
): Transcript => {
  const children: Node[] = [];
  const answers = answersOf(turns);
  const left = [
    ...dividers.map((d) => ({
      at: d.at,
      divider: true,
      node: {
        kind: 'StageDivider',
        id: d.id,
        // a reopen is often another day (#343): dated then
        props: {
          from: d.from,
          to: d.to,
          at: d.to === '' && o.now !== undefined ? screenWhen(d.at, o.now) : clockOf(d.at, o.now),
        },
      } satisfies Node,
    })),
    // a placed card line the cursor is on is drawn selected (#136); a question's answered line
    // gives way to its answer's in the transcript once that came (#275)
    ...(o.placed ?? [])
      .filter((x) => !answeredIn(answers, x))
      .map((x) =>
        x.node.kind === 'CardLine' && x.node.id !== undefined && x.node.id === folds.cursor
          ? {
              ...x,
              divider: false,
              node: { ...x.node, props: { ...x.node.props, selected: true } },
            }
          : { ...x, divider: false },
      ),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const divide = (before: string | undefined) => {
    while (
      left[0] !== undefined &&
      (before === undefined || Date.parse(left[0].at) <= Date.parse(before))
    ) {
      const d = left.shift();

      if (d !== undefined) children.push(d.node);
    }
  };

  const open = openFrom(turns);

  turns.forEach((turn, i) => {
    divide(turn.at);
    if (turn.answer !== undefined)
      children.push({
        kind: 'CardLine',
        id: ids.answer(turn.id),
        props: {
          head: turn.answer.head,
          ...(turn.answer.text === '' ? {} : { text: turn.answer.text }),
          ...(turn.answer.n === undefined ? {} : { n: turn.answer.n }),
        },
      });
    const newest = i >= open;
    // a stage divider stays between turns; a card's line can go inside the turn it was asked in
    const inside = placedInTurn(
      turn,
      turns[i + 1],
      left.filter((x) => !x.divider),
      stepsShown(folds, turn, newest),
    );

    drop(left, [...inside.values()].flat());
    if (turn.message !== undefined)
      children.push({
        kind: 'ChatMessage',
        id: ids.message(turn.id),
        props: messageShown(turn.message),
      });
    const parts = turnNode(
      turn,
      newest,
      folds,
      o,
      new Map([...inside].map(([k, xs]) => [k, xs.map((x) => x.node)])),
    );

    if (parts.length > 0)
      children.push({ kind: 'Turn', id: ids.turn(turn.id), props: {}, children: parts });
  });
  divide(undefined);
  children.push(...(o.tail ?? []));
  if ((o.newBelow ?? 0) > 0)
    children.push({
      kind: 'NewBelow',
      id: ids.newBelow,
      props: {
        count: o.newBelow ?? 0,
        ...(folds.cursor === ids.newBelow ? { selected: true } : {}),
      },
    });

  // answered and not told anything since: the agent's answers to it are on their way
  const last = turns.at(-1);
  const hold =
    open < turns.length - 1 ||
    (o.placed ?? []).some(
      (x) =>
        x.question !== undefined &&
        !answeredIn(answers, x) &&
        (last === undefined || Date.parse(x.at) >= Date.parse(last.at)),
    );

  return {
    kind: 'Transcript',
    id: ids.transcript,
    props: {
      ...(hold ? { hold: true } : {}),
      ...(o.reveal === undefined ? {} : { reveal: o.reveal }),
      ...(o.bottom === undefined ? {} : { bottom: o.bottom }),
      ...(o.session === undefined ? {} : { session: o.session }),
      ...(o.find === undefined ? {} : { find: o.find }),
      ...(o.mark === undefined ? {} : { mark: o.mark }),
    },
    children,
  };
};
