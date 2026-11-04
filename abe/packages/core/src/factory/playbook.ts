/**
 * A run's Playbook: the steps its change needs a person to do or run by hand once merged (deploy
 * steps, a migration, a cutover), written by the playbook skill to `.abe/playbooks/<card>.md` in
 * the card's worktree and read in the editor as Markdown. The Factory's optional playbook step
 * (the Decider's `--playbook`) ends with `abe factory stage-done playbook`; serve then reads the
 * file, holds it to this shape and keeps what it says on the run. No file: the change needs none.
 *
 * ```markdown
 * # Saved carts: playbook
 *
 * Done when: a saved cart survives sign-out on prod
 *
 * ## 1. Run the migration on test
 *
 * Who: Abe
 * Where: test
 * Runnable: yes
 *
 * ```sh
 * npm run migrate -- --env test
 * ```
 *
 * Check: `carts.saved_at` exists on test
 * Undo: one-way
 * ```
 *
 * A step against an environment this repo has not enabled for agents (prod, unless the person
 * turned it on) is the person's: `Who: you`, and Abe never runs it. A playbook that hands one to
 * Abe is refused. Which environments are enabled comes in (`enabled`, dev and test by default):
 * the repo's own setting says it. Pure: serve reads the file.
 */
import { z } from 'zod';
import { isProd } from '../board/pipelines';

/** The Factory's plain step that writes a run's Playbook (core's `playbook` skill). */
export const PLAYBOOK_STEP = 'playbook';

/** Where a card's Playbook is, relative to its worktree (and, once merged, its checkout). */
export const playbookPath = (card: number): string => `.abe/playbooks/${card}.md`;

/** Who takes a step: the person (`you`) or Abe. */
export const PLAYBOOK_WHO = ['you', 'abe'] as const;
export type PlaybookWho = (typeof PLAYBOOK_WHO)[number];

/** One step, as its `## <n>. <title>` section says it. */
export const PlaybookStep = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  /** Null: its Who line is missing or says neither. */
  who: z.enum(PLAYBOOK_WHO).nullable(),
  /** `dev`, `test`, `prod` or a system's name; null without a Where line. */
  where: z.string().nullable(),
  /** `Runnable: yes`; null without the line. */
  runnable: z.boolean().nullable(),
  /** Its first fenced block: what a runnable step runs; null without one. */
  command: z.string().nullable(),
  check: z.string().nullable(),
  undo: z.string().nullable(),
});
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export type Playbook = {
  /** The `# …` title, without `: playbook`. */
  title: string;
  doneWhen: string | null;
  steps: PlaybookStep[];
};

/** The environments agents reach when the repo enables no other: dev and test; prod only once the person turns it on. */
export const DEFAULT_AGENT_ENVS: readonly string[] = ['dev', 'test'];

const FIELD = /^(Who|Where|Runnable|Check|Undo):[ \t]*(.*)$/i;
const STEP = /^## (\d+)\.\s+(.+?)\s*$/;

/** The file's lines with whether each is inside a fenced block (its fence lines count as in). */
const fenced = (text: string): { line: string; inFence: boolean }[] => {
  let open = false;

  return text.split('\n').map((line) => {
    const fence = /^\s*(```|~~~)/.test(line);
    const inFence = open || fence;

    if (fence) open = !open;

    return { line, inFence };
  });
};

const firstBlock = (lines: readonly string[]): string | null => {
  const start = lines.findIndex((l) => /^\s*(```|~~~)/.test(l));

  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^\s*(```|~~~)/.test(l));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join('\n');

  return body.trim() === '' ? null : body.trimEnd();
};

const whoOf = (said: string | undefined): PlaybookWho | null => {
  const w = said?.trim().toLowerCase();

  return w === 'you' || w === 'abe' ? w : null;
};

const yesNo = (said: string | undefined): boolean | null => {
  const w = said?.trim().toLowerCase();

  if (w === 'yes') return true;

  return w === 'no' ? false : null;
};

const blankToNull = (s: string | undefined): string | null =>
  s === undefined || s.trim() === '' ? null : s.trim();

/** A Playbook's text read: its title, Done when and steps in the order written. */
export const parsePlaybook = (text: string): Playbook => {
  const lines = fenced(text.replace(/\r\n/g, '\n'));
  const title =
    lines
      .find((l) => !l.inFence && l.line.startsWith('# '))
      ?.line.slice(2)
      .trim() ?? '';
  const doneWhen = lines
    .filter((l) => !l.inFence)
    .map((l) => /^Done when:\s*(.*)$/i.exec(l.line)?.[1])
    .find((d) => d !== undefined);
  const heads = lines.flatMap((l, i) => {
    const m = l.inFence ? null : STEP.exec(l.line);

    return m === null ? [] : [{ i, n: Number(m[1]), title: m[2] ?? '' }];
  });
  const steps = heads.map((h, k): PlaybookStep => {
    const body = lines.slice(h.i + 1, heads[k + 1]?.i ?? lines.length);
    const fields = new Map<string, string>();

    for (const l of body) {
      const m = l.inFence ? null : FIELD.exec(l.line);

      if (m !== null && !fields.has((m[1] ?? '').toLowerCase()))
        fields.set((m[1] ?? '').toLowerCase(), m[2] ?? '');
    }

    return {
      n: h.n,
      title: h.title,
      who: whoOf(fields.get('who')),
      where: blankToNull(fields.get('where')),
      runnable: yesNo(fields.get('runnable')),
      command: firstBlock(body.map((l) => l.line)),
      check: blankToNull(fields.get('check')),
      undo: blankToNull(fields.get('undo')),
    };
  });

  return {
    title: title.replace(/:\s*playbook\s*$/i, '').trim(),
    doneWhen: blankToNull(doneWhen),
    steps,
  };
};

/**
 * The Abe environment a step's Where names: `prod` for any of prod's words (`prod`,
 * `production`, `prd`, `live`), `dev` or `test`; null for a system's name (`the Stripe
 * dashboard`) or none, which goes by its Who.
 */
export const stepEnv = (step: PlaybookStep): string | null => {
  const where = step.where?.trim().toLowerCase() ?? '';

  if (where === '') return null;
  if (isProd(where)) return 'prod';

  return where === 'dev' || where === 'test' ? where : null;
};

/**
 * Why a step is the person's whatever its Who says, or undefined: its Where is an environment
 * not enabled for agents in this repo.
 */
export const notEnabledWhy = (
  step: PlaybookStep,
  enabled: readonly string[] = DEFAULT_AGENT_ENVS,
): string | undefined => {
  const env = stepEnv(step);

  return env === null || enabled.includes(env)
    ? undefined
    : `${env} is not enabled for agents in this repo`;
};

/** Who takes a step: one against an environment not enabled for agents is always the person's. */
export const stepBy = (
  step: PlaybookStep,
  enabled: readonly string[] = DEFAULT_AGENT_ENVS,
): PlaybookWho => (notEnabledWhy(step, enabled) === undefined ? (step.who ?? 'you') : 'you');

/**
 * What is wrong with a Playbook, one line each (empty: it holds): its title, Done when, steps
 * numbered 1, 2, … each with Who, Where, Runnable and Check, a runnable one with its command, and
 * every step against an environment not enabled for agents the person's.
 */
export const playbookProblems = (
  pb: Playbook,
  enabled: readonly string[] = DEFAULT_AGENT_ENVS,
): string[] => {
  const head = [
    ...(pb.title === '' ? ['no title: start with `# <what the change ships>: playbook`'] : []),
    ...(pb.doneWhen === null ? ['no `Done when:` line'] : []),
    ...(pb.steps.length === 0 ? ['no steps: each is a `## <n>. <title>` section'] : []),
  ];
  const steps = pb.steps.flatMap((s, i) => {
    const at = `step ${s.n}`;
    const theirs = notEnabledWhy(s, enabled);

    return [
      ...(s.n === i + 1 ? [] : [`${at} is numbered out of order: expected ${i + 1}`]),
      ...(s.who === null ? [`${at} has no \`Who: you | Abe\``] : []),
      ...(s.where === null ? [`${at} has no \`Where:\``] : []),
      ...(s.runnable === null ? [`${at} has no \`Runnable: yes | no\``] : []),
      ...(s.runnable === true && s.command === null
        ? [`${at} is Runnable: yes with no command block to run`]
        : []),
      ...(s.check === null ? [`${at} has no \`Check:\``] : []),
      ...(theirs !== undefined && s.who === 'abe'
        ? [`${at} is the person's (${theirs}): \`Who: you\`. Abe never runs a step there`]
        : []),
    ];
  });

  return [...head, ...steps];
};

/** A Playbook as a run keeps it: where it is, its steps, which are the person's. */
export const PlaybookKept = z.object({
  /** Relative to the worktree: `.abe/playbooks/<card>.md`. */
  path: z.string(),
  title: z.string(),
  doneWhen: z.string().nullable(),
  steps: z.array(
    z.object({
      n: z.number().int().positive(),
      title: z.string(),
      by: z.enum(PLAYBOOK_WHO),
      where: z.string(),
      runnable: z.boolean(),
      /** Why it is the person's whatever its Who said (its environment not enabled); null: not so. */
      theirs: z.string().nullable(),
      /** What it runs, its Check and its Undo, as the file says them; null without (a run before). */
      command: z.string().nullable().optional(),
      check: z.string().nullable().optional(),
      undo: z.string().nullable().optional(),
    }),
  ),
});
export type PlaybookKept = z.infer<typeof PlaybookKept>;

/** A Playbook that holds, as the run keeps it (`playbookProblems` empty first). */
export const keptPlaybook = (
  card: number,
  pb: Playbook,
  enabled: readonly string[] = DEFAULT_AGENT_ENVS,
): PlaybookKept => ({
  path: playbookPath(card),
  title: pb.title,
  doneWhen: pb.doneWhen,
  steps: pb.steps.map((s) => ({
    n: s.n,
    title: s.title,
    by: stepBy(s, enabled),
    where: s.where ?? '',
    runnable: s.runnable === true,
    theirs: notEnabledWhy(s, enabled) ?? null,
    command: s.command,
    check: s.check,
    undo: s.undo,
  })),
});
